import { randomUUID } from "node:crypto";

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
import { StorageError } from "../common/worker-rpc.js";
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
}

export interface SessionStoreManagerOptions {
  readonly homeDirectory: string;
  readonly sessionWorkers?: Omit<SessionWorkerPoolOptions, "onSessionCommit">;
  readonly catalogWorker?: Omit<CatalogClientOptions, "homeDirectory">;
  readonly ids?: StorageIdGenerators;
  readonly now?: () => number;
  readonly catalogProjectionWriter?: (
    catalog: CatalogClient,
    update: UpdateSessionProjectionInput,
  ) => Promise<void>;
}

export interface CreateSessionStorageResult {
  readonly session: SessionSummary;
  readonly command: GlobalCommandRecord;
  readonly events: readonly SessionEvent[];
  readonly duplicate: boolean;
}

export interface ManagedAppendResult extends AppendTransactionResult {
  readonly catalogUpdated: boolean;
}

export interface ManagedAcceptCommandResult extends AcceptedCommandResult {
  readonly catalogUpdated: boolean;
}

function randomIdSource(): string {
  return randomUUID().replaceAll("-", "");
}

function defaultIds(): StorageIdGenerators {
  return {
    sessionId: () => createId("session", randomIdSource),
    eventId: () => createId("event", randomIdSource),
  };
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
  ) => Promise<void>;
  private readonly startupRecovery: Promise<void>;
  private readonly reconciledSessions = new Set<string>();
  private readonly reconciliationInFlight = new Map<string, Promise<boolean>>();
  private readonly sessionFaultVersions = new Map<string, number>();
  private readonly sessionFaultStatuses = new Map<string, "missing" | "unavailable">();
  private readonly activeOperations = new Set<Promise<void>>();
  private acceptingOperations = true;
  private closePromise: Promise<void> | null = null;

  constructor(options: SessionStoreManagerOptions) {
    this.homeDirectory = options.homeDirectory;
    this.ids = options.ids ?? defaultIds();
    this.now = options.now ?? Date.now;
    this.catalog = new CatalogClient({
      homeDirectory: options.homeDirectory,
      ...options.catalogWorker,
    });
    const configuredSessionError = options.sessionWorkers?.onSessionError;
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
      onSessionCommit: (sessionId, events, headSequence) =>
        this.updateCatalogAfterCommit(sessionId, events, headSequence),
    });
    this.catalogProjectionWriter =
      options.catalogProjectionWriter ??
      (async (catalog, update) => {
        await catalog.updateSessionProjection(update);
      });
    this.reconciler = new CatalogReconciler(
      this.homeDirectory,
      this.catalog,
      this.sessions,
    );
    this.startupRecovery = this.recoverIncompleteSessionCreations();
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
        // Quarantine only a known session-local fault; catalog failures remain startup-fatal.
        await this.markSessionUnavailable(command.reservedSessionId, error, false);
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
    if (!(error instanceof StorageError) || error.code !== "storage.worker_failed") return;
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
    const status = unavailableStatus(error);
    if (status === null) return;
    this.sessionFaultVersions.set(
      sessionId,
      (this.sessionFaultVersions.get(sessionId) ?? 0) + 1,
    );
    this.sessionFaultStatuses.set(sessionId, status);
    this.reconciledSessions.delete(sessionId);

    try {
      if ((await this.catalog.getSession(sessionId)) === null) return;
      await this.catalog.markSessionStatus({ sessionId, status });
    } catch (catalogError) {
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
    if (reservation.duplicate && reservation.command.state === "accepted") {
      const session =
        (await this.catalog.getSession(sessionId)) ??
        (await this.reconciler.reconcileSession(sessionId));
      return {
        session,
        command: reservation.command,
        events: [],
        duplicate: true,
      };
    }

    const dbRelativePath = sessionDatabaseRelativePath(sessionId);
    const databasePath = resolveStoragePath(this.homeDirectory, dbRelativePath);
    const title = reservation.command.request.title;
    const projectId = reservation.command.request.projectId;
    const createdAtMs = reservation.command.updatedAtMs;
    const initialized = await this.sessions.initialize(
      {
        sessionId,
        projectId,
        title,
        createdAtMs,
        eventId: reservation.command.reservedEventId,
      },
      databasePath,
    );

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
    );
  }

  async openSession(sessionId: string): Promise<SessionClient> {
    return this.runOperation(() => this.openSessionInternal(sessionId));
  }

  private async updateCatalogAfterCommit(
    sessionId: string,
    events: readonly SessionEvent[],
    headSequence: number,
  ): Promise<boolean> {
    const faultVersion = this.sessionFaultVersions.get(sessionId) ?? 0;
    if (events.length === 0) {
      if (this.reconciledSessions.has(sessionId)) return true;
      try {
        return await this.ensureSessionReconciled(sessionId);
      } catch {
        return false;
      }
    }
    try {
      const current = await this.catalog.getSession(sessionId);
      if (current === null) {
        this.reconciledSessions.delete(sessionId);
        return false;
      }

      const [projection, pendingApprovals, pendingInputCount] = await Promise.all([
        this.sessions.getCatalogProjection(sessionId),
        this.sessions.getPendingApprovals(sessionId),
        this.sessions.getPendingInputCount(sessionId),
      ]);
      const update: UpdateSessionProjectionInput = {
        sessionId,
        updatedAtMs: projection.updatedAtMs,
        lastEventSequence: headSequence,
        lastRunState: projection.lastRunState,
        lastMessagePreview: projection.lastMessagePreview,
        requiresAttention: pendingApprovals.length > 0 || pendingInputCount > 0,
        pendingApprovalCount: pendingApprovals.length,
        pendingInputCount,
      };
      await this.catalogProjectionWriter(this.catalog, update);
      const updated = await this.catalog.getSession(sessionId);
      if (updated === null || updated.lastEventSequence < headSequence) {
        this.reconciledSessions.delete(sessionId);
        return false;
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
    } catch {
      this.reconciledSessions.delete(sessionId);
      return false;
    }
  }

  async acceptCommand(
    sessionId: string,
    input: AcceptCommandInput,
  ): Promise<ManagedAcceptCommandResult> {
    return this.runOperation(async () => {
      const client = await this.openSessionInternal(sessionId);
      return client.acceptCommandWithCommitStatus(input);
    });
  }

  async appendTransaction(
    sessionId: string,
    input: AppendTransactionInput,
  ): Promise<ManagedAppendResult> {
    return this.runOperation(async () => {
      const client = await this.openSessionInternal(sessionId);
      return client.appendTransactionWithCommitStatus(input);
    });
  }

  private async finishClose(): Promise<void> {
    const [startupResult] = await Promise.allSettled([this.startupRecovery]);
    await this.drainOperations();
    // Commit observers need the catalog until every accepted session operation has drained.
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
