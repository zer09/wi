import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";

import {
  createId,
  hashCommandContent,
  type SessionCreateCommand,
  type SessionEvent,
} from "@wi/protocol";

import {
  CatalogClient,
  type CatalogClientOptions,
  type ReconcileSessionInput,
} from "../catalog/client.js";
import type { UpdateSessionProjectionInput } from "../catalog/repository.js";
import type { SessionClient } from "../session/client.js";
import { StorageError, toStorageError } from "../common/worker-rpc.js";
import {
  SessionWorkerPool,
  type SessionWorkerPoolOptions,
} from "../session/worker-pool.js";
import {
  SESSION_SCHEMA_VERSION,
  type AcceptCommandInput,
  type AcceptedCommandResult,
  type AppendTransactionInput,
  type AppendTransactionResult,
  type GlobalCommandRecord,
  type ProjectRecord,
  type SessionSummary,
} from "../types.js";
import { CatalogReconciler } from "./catalog-reconciler.js";
import { resolveStoragePath, sessionDatabaseRelativePath } from "./paths.js";

export interface StorageIdGenerators {
  readonly sessionId: () => string;
  readonly eventId: () => string;
  readonly diagnosticId?: () => string;
}

export interface CatalogObservationFailure {
  readonly diagnosticId: string;
  readonly sessionId: string;
  readonly headSequence: number;
  readonly code: string;
  readonly error: StorageError;
}

export interface SessionStoreManagerOptions {
  readonly homeDirectory: string;
  readonly sessionWorkers?: SessionWorkerPoolOptions;
  readonly catalogWorker?: Omit<CatalogClientOptions, "homeDirectory">;
  readonly ids?: StorageIdGenerators;
  readonly now?: () => number;
  readonly catalogProjectionWriter?: (
    catalog: CatalogClient,
    update: UpdateSessionProjectionInput,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly onCatalogObservationError?: (
    failure: CatalogObservationFailure,
  ) => void | Promise<void>;
  readonly catalogObservationShutdownTimeoutMs?: number;
}

export interface CreateSessionStorageResult {
  readonly session: SessionSummary;
  readonly command: GlobalCommandRecord;
  readonly events: readonly SessionEvent[];
  readonly duplicate: boolean;
  readonly outcome: "created" | "failed";
}

export interface ManagedAppendResult extends AppendTransactionResult {
  readonly catalogObservationScheduled: true;
}

export interface ManagedAcceptCommandResult extends AcceptedCommandResult {
  readonly catalogObservationScheduled: true;
}

export interface DrainCatalogObservationsOptions {
  readonly timeoutMs?: number;
}

function randomIdSource(): string {
  return randomUUID().replaceAll("-", "");
}

function defaultIds(): StorageIdGenerators {
  return {
    sessionId: () => createId("session", randomIdSource),
    eventId: () => createId("event", randomIdSource),
    diagnosticId: () => createId("diagnostic", randomIdSource),
  };
}

function assertPositiveWorkerTimeout(value: number | undefined, description: string): void {
  if (
    value !== undefined &&
    (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(value))
  ) {
    throw new RangeError(`${description} must be a positive finite safe integer`);
  }
}

export function validateSessionStoreManagerOptions(
  options: SessionStoreManagerOptions,
): void {
  const sessionWorkers = options.sessionWorkers;
  if (
    sessionWorkers?.size !== undefined &&
    (!Number.isSafeInteger(sessionWorkers.size) || sessionWorkers.size < 1)
  ) {
    throw new RangeError("Session worker pool size must be a positive safe integer");
  }
  if (
    sessionWorkers?.maxOpenHandlesPerWorker !== undefined &&
    (!Number.isSafeInteger(sessionWorkers.maxOpenHandlesPerWorker) ||
      sessionWorkers.maxOpenHandlesPerWorker < 1)
  ) {
    throw new RangeError("Session worker handle limit must be a positive safe integer");
  }
  assertPositiveWorkerTimeout(
    sessionWorkers?.defaultRequestTimeoutMs,
    "Worker request timeout",
  );
  assertPositiveWorkerTimeout(sessionWorkers?.closeTimeoutMs, "Worker close timeout");
  assertPositiveWorkerTimeout(
    options.catalogWorker?.defaultRequestTimeoutMs,
    "Worker request timeout",
  );
  assertPositiveWorkerTimeout(options.catalogWorker?.closeTimeoutMs, "Worker close timeout");
  if (
    options.catalogObservationShutdownTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.catalogObservationShutdownTimeoutMs) ||
      options.catalogObservationShutdownTimeoutMs <= 0)
  ) {
    throw new RangeError("Catalog observation shutdown timeout must be a positive safe integer");
  }
}

function unavailableStatus(error: unknown): "missing" | "unavailable" | null {
  if (!(error instanceof StorageError)) return null;
  if (error.code === "storage.session_missing") return "missing";
  if (
    error.code === "storage.corrupt" ||
    error.code === "storage.migration_failed" ||
    error.code === "storage.session_uninitialized"
  ) {
    return "unavailable";
  }
  return null;
}

interface CatalogObservationRequest {
  readonly hasEvents: boolean;
  readonly headSequence: number;
}

interface CatalogObservationState {
  pending: CatalogObservationRequest | null;
  completion: Promise<void>;
}

export class SessionStoreManager {
  readonly catalog: CatalogClient;
  readonly sessions: SessionWorkerPool;
  readonly reconciler: CatalogReconciler;
  private readonly homeDirectory: string;
  private readonly ids: StorageIdGenerators;
  private readonly now: () => number;
  private readonly catalogProjectionWriter: (
    catalog: CatalogClient,
    update: UpdateSessionProjectionInput,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly onCatalogObservationError:
    | ((failure: CatalogObservationFailure) => void | Promise<void>)
    | undefined;
  private readonly catalogObservationShutdownTimeoutMs: number;
  private readonly catalogObservationAbort = new AbortController();
  private readonly catalogObservations = new Map<string, CatalogObservationState>();
  private readonly startupRecovery: Promise<void>;
  private readonly reconciledSessions = new Set<string>();
  private readonly reconciliationInFlight = new Map<string, Promise<boolean>>();
  private readonly sessionFaultVersions = new Map<string, number>();
  private readonly sessionFaultStatuses = new Map<string, "missing" | "unavailable">();
  private readonly activeOperations = new Set<Promise<void>>();
  private acceptingOperations = true;
  private closePromise: Promise<void> | null = null;

  constructor(options: SessionStoreManagerOptions) {
    validateSessionStoreManagerOptions(options);
    this.homeDirectory = options.homeDirectory;
    this.ids = options.ids ?? defaultIds();
    this.now = options.now ?? Date.now;
    this.catalog = new CatalogClient({
      homeDirectory: options.homeDirectory,
      ...options.catalogWorker,
    });
    const configuredSessionError = options.sessionWorkers?.onSessionError;
    try {
      this.sessions = new SessionWorkerPool({
        ...options.sessionWorkers,
        onSessionError: async (sessionId, error) => {
          this.invalidateSessionAfterUncertainWorkerFailure(sessionId, error);
          try {
            await configuredSessionError?.(sessionId, error);
          } catch {
            // A diagnostic callback cannot replace the storage operation error.
          }
          await this.markSessionUnavailable(sessionId, error);
        },
      });
    } catch (error) {
      void this.catalog.close().catch(() => undefined);
      throw error;
    }
    this.catalogProjectionWriter =
      options.catalogProjectionWriter ??
      (async (catalog, update) => {
        await catalog.updateSessionProjection(update);
      });
    this.onCatalogObservationError = options.onCatalogObservationError;
    this.catalogObservationShutdownTimeoutMs =
      options.catalogObservationShutdownTimeoutMs ?? 2_000;
    if (
      !Number.isSafeInteger(this.catalogObservationShutdownTimeoutMs) ||
      this.catalogObservationShutdownTimeoutMs <= 0
    ) {
      throw new RangeError("Catalog observation shutdown timeout must be a positive safe integer");
    }
    this.reconciler = new CatalogReconciler(
      this.homeDirectory,
      this.catalog,
      this.sessions,
    );
    this.startupRecovery = this.recoverIncompleteSessionCreations();
  }

  private diagnosticId(): string {
    return this.ids.diagnosticId?.() ?? createId("diagnostic", randomIdSource);
  }

  private async failIncompleteSessionCreation(
    command: GlobalCommandRecord,
    error: unknown,
  ): Promise<{ command: GlobalCommandRecord; session: SessionSummary }> {
    const diagnosticId = this.diagnosticId();
    const failureCode = error instanceof StorageError ? error.code : "storage.corrupt";
    const failureMessage =
      "The partial session database is unavailable and was retained for recovery.";
    const dbRelativePath = sessionDatabaseRelativePath(command.reservedSessionId);
    const sessionDirectoryRelativePath = dbRelativePath.slice(
      0,
      -"/session.sqlite3".length,
    );
    const quarantinedRelativePath = `${sessionDirectoryRelativePath}.quarantine-${diagnosticId}`;
    const failedAtMs = this.now();
    const session: SessionSummary = {
      sessionId: command.reservedSessionId,
      projectId: command.request.projectId,
      dbRelativePath,
      title: command.request.title,
      status: "unavailable",
      createdAtMs: command.updatedAtMs,
      updatedAtMs: failedAtMs,
      lastEventSequence: 0,
      lastRunState: null,
      lastMessagePreview: null,
      requiresAttention: false,
      pendingApprovalCount: 0,
      pendingInputCount: 0,
      sessionSchemaVersion: SESSION_SCHEMA_VERSION,
    };
    let failedCommand = await this.catalog.failGlobalCommand({
      commandId: command.commandId,
      payloadHash: command.payloadHash,
      session,
      failureCode,
      failureMessage,
      diagnosticId,
      quarantinedRelativePath: null,
      failedAtMs,
    });

    await this.sessions.closeSession(command.reservedSessionId).catch(() => undefined);
    const source = resolveStoragePath(this.homeDirectory, sessionDirectoryRelativePath);
    const destination = resolveStoragePath(this.homeDirectory, quarantinedRelativePath);
    try {
      await rename(source, destination);
      failedCommand = await this.catalog.setGlobalCommandQuarantine({
        commandId: command.commandId,
        diagnosticId,
        quarantinedRelativePath,
      });
    } catch {
      // The terminal failure stays truthful: an unrecorded quarantine path is never claimed.
    }
    this.sessionFaultStatuses.set(command.reservedSessionId, "unavailable");
    this.reconciledSessions.delete(command.reservedSessionId);
    return { command: failedCommand, session };
  }

  private async recoverIncompleteSessionCreations(): Promise<void> {
    const commands = await this.catalog.listCreatingGlobalCommands();
    for (const command of commands) {
      let inspection: ReconcileSessionInput;
      try {
        const relativePath = sessionDatabaseRelativePath(command.reservedSessionId);
        const databasePath = resolveStoragePath(this.homeDirectory, relativePath);
        await this.sessions.initialize(
          {
            sessionId: command.reservedSessionId,
            projectId: command.request.projectId,
            title: command.request.title,
            createdAtMs: command.updatedAtMs,
            eventId: command.reservedEventId,
          },
          databasePath,
        );
        inspection = await this.reconciler.inspectSession(command.reservedSessionId);
      } catch (error) {
        if (unavailableStatus(error) === null) throw error;
        // Persist a terminal command result before attempting the best-effort atomic rename.
        await this.failIncompleteSessionCreation(command, error);
        continue;
      }

      // Catalog failures are installation-wide and must prevent normal startup.
      await this.reconciler.reconcileInspection(inspection);
      await this.catalog.completeGlobalCommand({
        commandId: command.commandId,
        payloadHash: command.payloadHash,
        result: { sessionId: command.reservedSessionId },
        acceptedAtMs: this.now(),
      });
      this.sessionFaultStatuses.delete(command.reservedSessionId);
      this.reconciledSessions.add(command.reservedSessionId);
    }
  }

  private invalidateSessionAfterUncertainWorkerFailure(
    sessionId: string,
    error: unknown,
  ): void {
    if (
      !(error instanceof StorageError) ||
      (error.code !== "storage.worker_failed" && error.code !== "storage.ambiguous_outcome")
    ) {
      return;
    }
    this.sessionFaultVersions.set(
      sessionId,
      (this.sessionFaultVersions.get(sessionId) ?? 0) + 1,
    );
    this.reconciledSessions.delete(sessionId);
  }

  private async markSessionUnavailable(
    sessionId: string,
    error: unknown,
    suppressCatalogError = true,
  ): Promise<void> {
    const observedStatus = unavailableStatus(error);
    if (observedStatus === null) return;
    this.sessionFaultVersions.set(
      sessionId,
      (this.sessionFaultVersions.get(sessionId) ?? 0) + 1,
    );
    this.reconciledSessions.delete(sessionId);

    let status =
      this.sessionFaultStatuses.get(sessionId) === "unavailable"
        ? "unavailable"
        : observedStatus;
    try {
      const existing = await this.catalog.getSession(sessionId);
      if (existing === null) {
        this.sessionFaultStatuses.set(sessionId, status);
        return;
      }
      // A known corrupt session does not become less informative merely because quarantine moved it.
      if (existing.status === "unavailable") status = "unavailable";
      this.sessionFaultStatuses.set(sessionId, status);
      if (existing.status !== status) {
        await this.catalog.markSessionStatus({ sessionId, status });
      }
    } catch (catalogError) {
      this.sessionFaultStatuses.set(sessionId, status);
      if (!suppressCatalogError) throw catalogError;
      // The original session-scoped failure remains the useful diagnostic.
    }
  }

  private async ensureSessionReconciled(sessionId: string): Promise<boolean> {
    if (this.reconciledSessions.has(sessionId)) return true;
    const existing = this.reconciliationInFlight.get(sessionId);
    if (existing !== undefined) return existing;

    const faultVersion = this.sessionFaultVersions.get(sessionId) ?? 0;
    const reconciliation = this.reconciler
      .reconcileSession(sessionId)
      .then(async (summary) => {
        if ((this.sessionFaultVersions.get(sessionId) ?? 0) !== faultVersion) {
          const latestStatus = this.sessionFaultStatuses.get(sessionId);
          if (latestStatus !== undefined) {
            await this.catalog.markSessionStatus({ sessionId, status: latestStatus });
          }
          this.reconciledSessions.delete(sessionId);
          return false;
        }
        if (summary.status === "ready") {
          this.sessionFaultStatuses.delete(sessionId);
          this.reconciledSessions.add(sessionId);
          return true;
        }
        this.reconciledSessions.delete(sessionId);
        return false;
      })
      .catch(async (error: unknown) => {
        await this.markSessionUnavailable(sessionId, error);
        throw error;
      })
      .finally(() => {
        this.reconciliationInFlight.delete(sessionId);
      });
    this.reconciliationInFlight.set(sessionId, reconciliation);
    return reconciliation;
  }

  private async runOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.acceptingOperations) {
      throw new StorageError("storage.worker_failed", "Session store manager is closing");
    }
    const running = operation();
    const completion = running.then(
      () => undefined,
      () => undefined,
    );
    this.activeOperations.add(completion);
    try {
      return await running;
    } finally {
      this.activeOperations.delete(completion);
    }
  }

  private async drainOperations(): Promise<void> {
    while (this.activeOperations.size > 0) {
      await Promise.all(this.activeOperations);
    }
  }

  async ready(): Promise<void> {
    await this.startupRecovery;
  }

  async createProject(project: ProjectRecord): Promise<ProjectRecord> {
    return this.runOperation(async () => {
      await this.ready();
      return this.catalog.createProject(project);
    });
  }

  private async createSessionInternal(
    command: SessionCreateCommand,
  ): Promise<CreateSessionStorageResult> {
    await this.ready();
    const payloadHash = await hashCommandContent(command);
    const now = this.now();
    const reservation = await this.catalog.reserveGlobalCommand({
      commandId: command.commandId,
      payloadHash,
      reservedSessionId: this.ids.sessionId(),
      reservedEventId: this.ids.eventId(),
      request: {
        title: command.params.title ?? "",
        projectId: command.params.projectId ?? null,
      },
      updatedAtMs: now,
    });
    const sessionId = reservation.command.reservedSessionId;
    if (reservation.duplicate && reservation.command.state === "failed") {
      const session = await this.catalog.getSession(sessionId);
      if (session === null) {
        throw new StorageError("storage.corrupt", "Failed session creation lost its catalog entry");
      }
      return {
        session,
        command: reservation.command,
        events: [],
        duplicate: true,
        outcome: "failed",
      };
    }
    if (reservation.duplicate && reservation.command.state === "accepted") {
      const session =
        (await this.catalog.getSession(sessionId)) ??
        (await this.reconciler.reconcileSession(sessionId));
      return {
        session,
        command: reservation.command,
        events: [],
        duplicate: true,
        outcome: "created",
      };
    }

    const dbRelativePath = sessionDatabaseRelativePath(sessionId);
    const databasePath = resolveStoragePath(this.homeDirectory, dbRelativePath);
    const title = reservation.command.request.title;
    const projectId = reservation.command.request.projectId;
    const createdAtMs = reservation.command.updatedAtMs;
    let initialized: Awaited<ReturnType<SessionWorkerPool["initialize"]>>;
    try {
      initialized = await this.sessions.initialize(
        {
          sessionId,
          projectId,
          title,
          createdAtMs,
          eventId: reservation.command.reservedEventId,
        },
        databasePath,
      );
    } catch (error) {
      if (unavailableStatus(error) === null) throw error;
      const failed = await this.failIncompleteSessionCreation(reservation.command, error);
      return {
        session: failed.session,
        command: failed.command,
        events: [],
        duplicate: reservation.duplicate,
        outcome: "failed",
      };
    }

    const session = await this.catalog.createSessionIndex({
      sessionId,
      projectId,
      dbRelativePath,
      title,
      status: "ready",
      createdAtMs: initialized.manifest.createdAtMs,
      updatedAtMs: createdAtMs,
      lastEventSequence: initialized.manifest.lastEventSequence,
      lastRunState: null,
      lastMessagePreview: null,
      requiresAttention: false,
      pendingApprovalCount: 0,
      pendingInputCount: 0,
      sessionSchemaVersion: SESSION_SCHEMA_VERSION,
    });
    const commandRecord = await this.catalog.completeGlobalCommand({
      commandId: command.commandId,
      payloadHash,
      result: { sessionId },
      acceptedAtMs: now,
    });
    this.sessionFaultStatuses.delete(sessionId);
    this.reconciledSessions.add(sessionId);
    return {
      session,
      command: commandRecord,
      events: initialized.events,
      duplicate: reservation.duplicate,
      outcome: "created",
    };
  }

  async createSession(command: SessionCreateCommand): Promise<CreateSessionStorageResult> {
    return this.runOperation(() => this.createSessionInternal(command));
  }

  private async openSessionInternal(sessionId: string): Promise<SessionClient> {
    await this.ready();
    const summary = await this.catalog.getSession(sessionId);
    if (summary === null) throw new Error(`Session ${sessionId} was not found in the catalog`);
    return this.sessions.registerSession(
      sessionId,
      resolveStoragePath(this.homeDirectory, summary.dbRelativePath),
      async () => {
        await this.ensureSessionReconciled(sessionId);
      },
      (events, headSequence) => {
        this.scheduleCatalogObservation(sessionId, events, headSequence);
      },
    );
  }

  async openSession(sessionId: string): Promise<SessionClient> {
    return this.runOperation(() => this.openSessionInternal(sessionId));
  }

  private scheduleCatalogObservation(
    sessionId: string,
    events: readonly SessionEvent[],
    headSequence: number,
  ): void {
    const request = { hasEvents: events.length > 0, headSequence };
    const existing = this.catalogObservations.get(sessionId);
    if (existing !== undefined) {
      const pending = existing.pending;
      existing.pending =
        pending === null
          ? request
          : {
              hasEvents: pending.hasEvents || request.hasEvents,
              headSequence: Math.max(pending.headSequence, request.headSequence),
            };
      return;
    }

    const state: CatalogObservationState = {
      pending: null,
      completion: Promise.resolve(),
    };
    this.catalogObservations.set(sessionId, state);
    state.completion = this.runCatalogObservations(sessionId, state, request);
  }

  private async reportCatalogObservationFailure(
    sessionId: string,
    headSequence: number,
    error: unknown,
  ): Promise<void> {
    try {
      const classified = toStorageError(
        error,
        "storage.worker_failed",
        "Catalog observation failed",
      );
      await this.onCatalogObservationError?.({
        diagnosticId: this.diagnosticId(),
        sessionId,
        headSequence,
        code: classified.code,
        error: classified,
      });
    } catch {
      // A diagnostic callback cannot affect the already committed session result.
    }
  }

  private async runCatalogObservations(
    sessionId: string,
    state: CatalogObservationState,
    initial: CatalogObservationRequest,
  ): Promise<void> {
    let request = initial;
    try {
      while (!this.catalogObservationAbort.signal.aborted) {
        await this.updateCatalogAfterCommit(
          sessionId,
          request.hasEvents,
          request.headSequence,
          this.catalogObservationAbort.signal,
        );
        const pending = state.pending;
        if (pending === null) return;
        state.pending = null;
        request = pending;
      }
    } catch (error) {
      if (!this.catalogObservationAbort.signal.aborted) {
        await this.reportCatalogObservationFailure(sessionId, request.headSequence, error);
      }
    } finally {
      if (this.catalogObservations.get(sessionId) === state) {
        this.catalogObservations.delete(sessionId);
      }
    }
  }

  async drainCatalogObservations(
    options: DrainCatalogObservationsOptions = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Catalog observation drain timeout must be a positive safe integer");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new StorageError(
            "storage.worker_timeout",
            `Catalog observations did not drain within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      timer.unref();
    });
    const drain = async (): Promise<void> => {
      while (this.catalogObservations.size > 0) {
        await Promise.all(
          [...this.catalogObservations.values()].map((state) => state.completion),
        );
      }
    };
    try {
      await Promise.race([drain(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async updateCatalogAfterCommit(
    sessionId: string,
    hasEvents: boolean,
    headSequence: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return false;
    const faultVersion = this.sessionFaultVersions.get(sessionId) ?? 0;
    if (!hasEvents) {
      if (this.reconciledSessions.has(sessionId)) return true;
      try {
        return await this.ensureSessionReconciled(sessionId);
      } catch (error) {
        if (!signal.aborted) {
          await this.reportCatalogObservationFailure(sessionId, headSequence, error);
        }
        return false;
      }
    }
    try {
      const current = await this.catalog.getSession(sessionId);
      if (current === null) {
        throw new StorageError(
          "storage.corrupt",
          `Catalog entry for ${sessionId} disappeared after a committed session write`,
        );
      }

      const observation = await this.sessions.getCatalogObservation(sessionId);
      if (observation.headSequence < headSequence) {
        throw new StorageError(
          "storage.corrupt",
          `Catalog observation for ${sessionId} is behind its committed head`,
        );
      }
      const update: UpdateSessionProjectionInput = {
        sessionId,
        updatedAtMs: observation.projection.updatedAtMs,
        lastEventSequence: observation.headSequence,
        lastRunState: observation.projection.lastRunState,
        lastMessagePreview: observation.projection.lastMessagePreview,
        requiresAttention:
          observation.pendingApprovalCount > 0 || observation.pendingInputCount > 0,
        pendingApprovalCount: observation.pendingApprovalCount,
        pendingInputCount: observation.pendingInputCount,
      };
      await this.catalogProjectionWriter(this.catalog, update, signal);
      if (signal.aborted) return false;
      const updated = await this.catalog.getSession(sessionId);
      if (updated === null || updated.lastEventSequence < observation.headSequence) {
        throw new StorageError(
          "storage.corrupt",
          `Catalog projection for ${sessionId} did not reach its observed session head`,
        );
      }
      if (
        updated.status === "ready" &&
        (this.sessionFaultVersions.get(sessionId) ?? 0) === faultVersion
      ) {
        this.sessionFaultStatuses.delete(sessionId);
        this.reconciledSessions.add(sessionId);
      } else {
        this.reconciledSessions.delete(sessionId);
      }
      return true;
    } catch (error) {
      this.reconciledSessions.delete(sessionId);
      if (!signal.aborted) {
        await this.reportCatalogObservationFailure(sessionId, headSequence, error);
      }
      return false;
    }
  }

  async acceptCommand(
    sessionId: string,
    input: AcceptCommandInput,
  ): Promise<ManagedAcceptCommandResult> {
    return this.runOperation(async () => {
      const client = await this.openSessionInternal(sessionId);
      const result = await client.acceptCommand(input);
      return { ...result, catalogObservationScheduled: true };
    });
  }

  async appendTransaction(
    sessionId: string,
    input: AppendTransactionInput,
  ): Promise<ManagedAppendResult> {
    return this.runOperation(async () => {
      const client = await this.openSessionInternal(sessionId);
      const result = await client.appendTransaction(input);
      return { ...result, catalogObservationScheduled: true };
    });
  }

  private async finishClose(): Promise<void> {
    const [startupResult] = await Promise.allSettled([this.startupRecovery]);
    await this.drainOperations();
    await this.drainCatalogObservations({
      timeoutMs: this.catalogObservationShutdownTimeoutMs,
    }).catch(() => undefined);
    this.catalogObservationAbort.abort();
    this.catalogObservations.clear();
    const [sessionsResult] = await Promise.allSettled([this.sessions.close()]);
    const [catalogResult] = await Promise.allSettled([this.catalog.close()]);
    if (startupResult?.status === "rejected") throw startupResult.reason;
    if (sessionsResult?.status === "rejected") throw sessionsResult.reason;
    if (catalogResult?.status === "rejected") throw catalogResult.reason;
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.acceptingOperations = false;
    this.sessions.stopAcceptingCommits();
    this.closePromise = this.finishClose();
    return this.closePromise;
  }
}
