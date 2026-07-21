import { randomUUID } from "node:crypto";

import {
  canonicalJson,
  createId,
  hashCommandContent,
  type SessionCreateCommand,
  type SessionEvent,
} from "@wi/protocol";

import {
  CatalogClient,
  type CatalogClientOptions,
  type ReconcileSessionInput,
  type RecoveryCandidateCursor,
  type RecoveryCandidatePage,
} from "../catalog/client.js";
import type {
  CatalogRepairReason,
  UpdateSessionProjectionInput,
} from "../catalog/repository.js";
import type { SessionClient } from "../session/client.js";
import { StorageError, toStorageError } from "../common/worker-rpc.js";
import {
  SessionWorkerPool,
  type DiscoveredSession,
  type SessionWorkerPoolOptions,
} from "../session/worker-pool.js";
import {
  SESSION_SCHEMA_VERSION,
  type AcceptCommandInput,
  type AcceptedCommandResult,
  type AppendTransactionInput,
  type AppendTransactionResult,
  type CreationProvenance,
  type GlobalCommandRecord,
  type ProjectRecord,
  type SessionManifest,
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

export interface StorageTestFailpoints {
  readonly hit: (
    name:
      | "after_session_create_before_catalog_ready"
      | "after_catalog_session_repair"
      | "after_catalog_replacement_before_repair",
    fields?: Readonly<Record<string, unknown>>,
  ) => void;
  readonly beforeCatalogSessionIsolation?: (fields: {
    readonly sessionId: string;
    readonly reason: "corrupt" | "oversized" | "unsupported" | "provenance_conflict";
  }) => void | Promise<void>;
  readonly beforeCatalogReplacement?: () => void | Promise<void>;
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
  readonly testFailpoints?: StorageTestFailpoints;
  readonly catalogRepair?: "auto" | "force" | "off";
  readonly sessionDiscoveryLimit?: number;
}

export interface CatalogRepairReport {
  readonly triggered: boolean;
  readonly reason: "none" | CatalogRepairReason;
  readonly discovered: number;
  readonly repaired: number;
  readonly quarantined: number;
  readonly ignored: number;
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
  if (
    options.testFailpoints !== undefined &&
    (process.env.NODE_ENV !== "test" || process.env.WI_ALLOW_TEST_FAILPOINTS !== "1")
  ) {
    throw new Error(
      "Storage test failpoints require NODE_ENV=test and WI_ALLOW_TEST_FAILPOINTS=1",
    );
  }
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
    options.catalogRepair !== undefined &&
    options.catalogRepair !== "auto" &&
    options.catalogRepair !== "force" &&
    options.catalogRepair !== "off"
  ) {
    throw new RangeError("Catalog repair mode must be auto, force, or off");
  }
  if (
    options.sessionDiscoveryLimit !== undefined &&
    (!Number.isSafeInteger(options.sessionDiscoveryLimit) ||
      options.sessionDiscoveryLimit < 1 ||
      options.sessionDiscoveryLimit > 10_000)
  ) {
    throw new RangeError("Session discovery limit must be between 1 and 10000");
  }
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

type NonValidDiscoveredSession = Exclude<DiscoveredSession, { readonly kind: "valid" }>;

type RetainedDiscoveryClassification =
  | { readonly kind: "corrupt" | "transient" | "missing" | "oversized" }
  | { readonly kind: "unsupported"; readonly schemaVersion: number };

export function retainNonValidDiscoveryClassification(
  record: NonValidDiscoveredSession,
): RetainedDiscoveryClassification {
  if (record.kind === "unsupported") {
    return { kind: record.kind, schemaVersion: record.schemaVersion };
  }
  return { kind: record.kind };
}

function catalogCommandConflictsWithProvenance(
  command: GlobalCommandRecord,
  sessionId: string,
  manifest: SessionManifest,
  provenance: CreationProvenance,
): boolean {
  if (
    command.commandMethod !== "session.create" ||
    command.payloadHash !== provenance.payloadHash ||
    command.reservedSessionId !== sessionId ||
    command.reservedEventId !== provenance.eventId ||
    command.request.title !== manifest.title ||
    command.request.projectId !== manifest.projectId ||
    command.updatedAtMs !== provenance.acceptedAtMs ||
    command.state === "failed"
  ) {
    return true;
  }
  return command.state === "accepted" && (
    canonicalJson(command.result) !== canonicalJson(provenance.result) ||
    command.acceptedAtMs !== provenance.acceptedAtMs
  );
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
  private readonly testFailpoints: StorageTestFailpoints | undefined;
  private readonly sessionDiscoveryLimit: number;
  private readonly catalogObservationAbort = new AbortController();
  private readonly catalogObservations = new Map<string, CatalogObservationState>();
  private readonly startupRecovery: Promise<void>;
  private startupRepairReport: CatalogRepairReport = {
    triggered: false,
    reason: "none",
    discovered: 0,
    repaired: 0,
    quarantined: 0,
    ignored: 0,
  };
  private readonly reconciledSessions = new Set<string>();
  private readonly reconciliationInFlight = new Map<string, Promise<boolean>>();
  private readonly sessionFaultVersions = new Map<string, number>();
  private readonly sessionFaultStatuses = new Map<string, "missing" | "unavailable">();
  private readonly activeOperations = new Set<Promise<void>>();
  private sessionCreationTail: Promise<void> = Promise.resolve();
  private acceptingOperations = true;
  private closePromise: Promise<void> | null = null;

  constructor(options: SessionStoreManagerOptions) {
    validateSessionStoreManagerOptions(options);
    this.homeDirectory = options.homeDirectory;
    this.ids = options.ids ?? defaultIds();
    this.now = options.now ?? Date.now;
    const catalogRepair = options.catalogRepair ?? "auto";
    this.catalog = new CatalogClient({
      homeDirectory: options.homeDirectory,
      ...options.catalogWorker,
      allowRepair: catalogRepair !== "off",
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
    this.testFailpoints = options.testFailpoints;
    this.sessionDiscoveryLimit = options.sessionDiscoveryLimit ?? 1_000;
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
    this.startupRecovery = this.runStartupRecovery(catalogRepair);
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
      recoveryCandidate: false,
    };
    const failedCommand = await this.catalog.failGlobalCommand({
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
    // Node has no cross-platform handle-relative directory rename. Preserve the
    // partial database in place rather than risk following a swapped ancestor.
    this.sessionFaultStatuses.set(command.reservedSessionId, "unavailable");
    this.reconciledSessions.delete(command.reservedSessionId);
    return { command: failedCommand, session };
  }

  private async visitDiscoveredSessions(
    sessionIds: readonly string[],
    visitor: (record: DiscoveredSession) => void | Promise<void>,
  ): Promise<void> {
    let startIndex = 0;
    while (startIndex < sessionIds.length) {
      const page = await this.sessions.discoverSessionPage(
        this.homeDirectory,
        sessionIds,
        startIndex,
      );
      if (page.records.length !== page.processedCount) {
        throw new StorageError("storage.corrupt", "Session discovery page count is inconsistent");
      }
      for (const record of page.records) await visitor(record);
      startIndex += page.processedCount;
    }
  }

  private async discoverAndRepairCatalog(
    reason: Exclude<CatalogRepairReport["reason"], "none">,
  ): Promise<void> {
    const discovery = await this.sessions.discoverSessionInventory(
      this.homeDirectory,
      this.sessionDiscoveryLimit,
    );
    const observedSessionIds = new Set(discovery.sessionIds);
    let repaired = 0;
    // Retain the report field for compatibility with earlier catalogs; current
    // session isolation never performs a pathname-based directory quarantine.
    const quarantined = 0;
    let transientFailure = false;
    const provenanceOwners = new Map<string, string>();
    const conflictingProvenanceSessions = new Set<string>();
    const retainedClassifications = new Map<string, RetainedDiscoveryClassification>();
    await this.visitDiscoveredSessions(discovery.sessionIds, async (record) => {
      if (record.kind !== "valid") {
        retainedClassifications.set(
          record.sessionId,
          retainNonValidDiscoveryClassification(record),
        );
        return;
      }
      if (record.creationProvenance === null) return;
      const previous = provenanceOwners.get(record.creationProvenance.commandId);
      if (previous !== undefined && previous !== record.sessionId) {
        // Neither claimant can be trusted. Isolate both sessions while allowing
        // independent discoveries to finish rebuilding the installation index.
        conflictingProvenanceSessions.add(previous);
        conflictingProvenanceSessions.add(record.sessionId);
      } else {
        provenanceOwners.set(record.creationProvenance.commandId, record.sessionId);
      }
      const catalogCommand = await this.catalog.getGlobalCommand(
        record.creationProvenance.commandId,
      );
      if (
        catalogCommand !== null &&
        catalogCommandConflictsWithProvenance(
          catalogCommand,
          record.sessionId,
          record.manifest,
          record.creationProvenance,
        )
      ) {
        conflictingProvenanceSessions.add(record.sessionId);
      }
    });
    await this.visitDiscoveredSessions(discovery.sessionIds, async (record) => {
      // A non-valid first-pass classification cannot become a newly trusted
      // provenance claimant merely because the second read observes different state.
      const retained = retainedClassifications.get(record.sessionId);
      const classification = retained ?? (
        record.kind === "valid" ? null : retainNonValidDiscoveryClassification(record)
      );
      const dbRelativePath = sessionDatabaseRelativePath(record.sessionId);
      if (classification === null && record.kind === "valid" &&
        !conflictingProvenanceSessions.has(record.sessionId)) {
        const observation = record.observation;
        const expectedCatalog = await this.catalog.getSession(record.sessionId);
        const reconciliation = await this.catalog.reconcileSessionWithStatus({
          manifest: record.manifest,
          dbRelativePath,
          expectedCatalogSequence: expectedCatalog?.lastEventSequence ?? null,
          expectedCatalogStatus: expectedCatalog?.status ?? null,
          updatedAtMs: observation.projection.updatedAtMs,
          lastRunState: observation.projection.lastRunState,
          lastMessagePreview: observation.projection.lastMessagePreview,
          pendingApprovalCount: observation.pendingApprovalCount,
          pendingInputCount: observation.pendingInputCount,
          recoveryNeeded: observation.recoveryNeeded,
        });
        if (!reconciliation.applied) {
          transientFailure = true;
          return;
        }
        if (record.creationProvenance !== null) {
          const provenance = record.creationProvenance;
          const reservation = await this.catalog.reserveGlobalCommand({
            commandId: provenance.commandId,
            payloadHash: provenance.payloadHash,
            reservedSessionId: record.sessionId,
            reservedEventId: provenance.eventId,
            request: { title: record.manifest.title, projectId: record.manifest.projectId },
            updatedAtMs: provenance.acceptedAtMs,
          });
          if (
            reservation.command.reservedSessionId !== record.sessionId ||
            reservation.command.reservedEventId !== provenance.eventId
          ) {
            throw new StorageError("storage.corrupt", "Recovered creation command conflicts with canonical provenance");
          }
          await this.catalog.completeGlobalCommand({
            commandId: provenance.commandId,
            payloadHash: provenance.payloadHash,
            result: provenance.result,
            acceptedAtMs: provenance.acceptedAtMs,
          });
        }
        repaired += 1;
        this.testFailpoints?.hit("after_catalog_session_repair", {
          sessionId: record.sessionId,
          repaired,
        });
        return;
      }
      if (classification?.kind === "transient") {
        transientFailure = true;
        return;
      }
      if (classification?.kind === "missing") {
        const existing = await this.catalog.getSession(record.sessionId);
        if (existing === null) {
          const atMs = this.now();
          await this.catalog.createSessionIndex({
            sessionId: record.sessionId,
            projectId: null,
            dbRelativePath,
            title: "Missing recovered session",
            status: "missing",
            createdAtMs: atMs,
            updatedAtMs: atMs,
            lastEventSequence: 0,
            lastRunState: null,
            lastMessagePreview: null,
            requiresAttention: true,
            pendingApprovalCount: 0,
            pendingInputCount: 0,
            sessionSchemaVersion: SESSION_SCHEMA_VERSION,
            recoveryCandidate: false,
          });
        } else {
          await this.catalog.repairSessionClassification({
            sessionId: record.sessionId,
            dbRelativePath,
            status: "missing",
            sessionSchemaVersion: null,
            unavailableReason: null,
          });
        }
        this.sessionFaultStatuses.set(record.sessionId, "missing");
        this.reconciledSessions.delete(record.sessionId);
        return;
      }

      await this.testFailpoints?.beforeCatalogSessionIsolation?.({
        sessionId: record.sessionId,
        reason: classification?.kind ?? "provenance_conflict",
      });
      const atMs = this.now();
      const preserveUnsupported = classification?.kind === "unsupported";
      let recoveredTitle = "Unavailable recovered session";
      if (preserveUnsupported) recoveredTitle = "Unsupported recovered session";
      if (classification?.kind === "oversized") recoveredTitle = "Oversized recovered session";
      const existing = await this.catalog.getSession(record.sessionId);
      if (existing === null) {
        await this.catalog.createSessionIndex({
          sessionId: record.sessionId,
          projectId: null,
          dbRelativePath,
          title: recoveredTitle,
          status: "unavailable",
          createdAtMs: atMs,
          updatedAtMs: atMs,
          lastEventSequence: 0,
          lastRunState: null,
          lastMessagePreview: null,
          requiresAttention: true,
          pendingApprovalCount: 0,
          pendingInputCount: 0,
          sessionSchemaVersion: preserveUnsupported
            ? classification.schemaVersion
            : SESSION_SCHEMA_VERSION,
          recoveryCandidate: false,
          unavailableReason: null,
        });
      } else {
        await this.catalog.repairSessionClassification({
          sessionId: record.sessionId,
          dbRelativePath,
          status: "unavailable",
          sessionSchemaVersion: preserveUnsupported ? classification.schemaVersion : null,
          unavailableReason: null,
        });
      }
      // Pathname-based rename cannot prove which directory it will move if a
      // same-user process swaps an ancestor. Keep every unavailable session in place.
      this.sessionFaultStatuses.set(record.sessionId, "unavailable");
    });

    const catalogSessionCount = await this.catalog.countSessions();
    if (catalogSessionCount > this.sessionDiscoveryLimit) {
      throw new StorageError(
        "storage.resource_limit",
        "Catalog session count exceeds the repair limit",
        true,
      );
    }
    let repairCursor: string | null = null;
    do {
      const page = await this.catalog.listCatalogRepairPage(repairCursor);
      const missing = page.records.flatMap((record) => {
        if (observedSessionIds.has(record.sessionId)) return [];
        if (record.status === "unavailable" && record.unavailableReason === "quarantined") {
          return [];
        }
        return [{
          sessionId: record.sessionId,
          dbRelativePath: sessionDatabaseRelativePath(record.sessionId),
        }];
      });
      const markedSessionIds = await this.catalog.markSessionsMissing(missing);
      for (const sessionId of markedSessionIds) {
        this.sessionFaultStatuses.set(sessionId, "missing");
        this.reconciledSessions.delete(sessionId);
      }
      repairCursor = page.nextCursor;
    } while (repairCursor !== null);

    this.startupRepairReport = {
      triggered: true,
      reason,
      discovered: discovery.sessionIds.length,
      repaired,
      quarantined,
      ignored: discovery.ignoredEntries,
    };
    if (transientFailure) {
      // Retain the marker; an operational failure is not proof that a canonical
      // database is corrupt and must be retried without destructive isolation.
      throw new StorageError("storage.busy", "Catalog repair retained for an operational discovery failure", true);
    }
  }

  private async runStartupRecovery(
    mode: NonNullable<SessionStoreManagerOptions["catalogRepair"]>,
  ): Promise<void> {
    let repairReason: CatalogRepairReason | null = null;
    let repairMarked = false;
    if (mode === "force") {
      // A healthy catalog is reconciled in place so catalog-only projects and
      // global command outcomes are not silently destroyed by maintenance.
      try {
        const state = await this.catalog.getStartupState();
        repairReason = state.repairReason ?? "explicit";
        if (state.repairReason === null) await this.catalog.beginRepair("explicit");
        repairMarked = true;
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "storage.corrupt") throw error;
        await this.testFailpoints?.beforeCatalogReplacement?.();
        await this.catalog.repair();
        repairReason = "catalog_corrupt";
        repairMarked = true;
      }
    } else {
      try {
        const state = await this.catalog.getStartupState();
        if (state.repairReason !== null) {
          if (mode === "off") {
            // A brand-new empty installation has no canonical work to protect;
            // clear its atomic bootstrap marker without enabling repair for a
            // previously populated incomplete catalog.
            if (state.repairReason === "catalog_new" && !state.hasCompletedRepair) {
              repairReason = "catalog_new";
              repairMarked = true;
            } else {
              throw new StorageError(
                "storage.corrupt",
                "Catalog repair is incomplete and automatic repair is disabled",
              );
            }
          } else {
            repairReason = state.repairReason;
            repairMarked = true;
          }
        }
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "storage.corrupt" || mode === "off") {
          throw error;
        }
        await this.testFailpoints?.beforeCatalogReplacement?.();
        await this.catalog.repair();
        repairReason = "catalog_corrupt";
      }
    }
    if (repairReason !== null) {
      if (!repairMarked) await this.catalog.beginRepair(repairReason);
      this.testFailpoints?.hit("after_catalog_replacement_before_repair", { repairReason });
      await this.discoverAndRepairCatalog(repairReason);
      await this.catalog.completeRepair();
    }
    await this.recoverIncompleteSessionCreations();
  }

  catalogRepairStatus(): CatalogRepairReport {
    return { ...this.startupRepairReport };
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
            creation: {
              commandId: command.commandId,
              payloadHash: command.payloadHash,
              commandMethod: "session.create",
              eventId: command.reservedEventId,
              result: { sessionId: command.reservedSessionId },
              acceptedAtMs: command.updatedAtMs,
            },
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
        // A creating reservation's timestamp is immutable provenance. Recovery
        // must not manufacture a restart-time acceptance timestamp.
        acceptedAtMs: command.updatedAtMs,
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
      // A known corrupt session does not become less informative if its file later disappears.
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

  private async drainOperations(deadlineAtMs?: number): Promise<void> {
    while (this.activeOperations.size > 0) {
      const drain = Promise.all(this.activeOperations);
      if (deadlineAtMs === undefined) {
        await drain;
        continue;
      }
      const remaining = deadlineAtMs - Date.now();
      if (remaining <= 0) {
        throw new StorageError("storage.worker_timeout", "Storage operation drain exceeded shutdown deadline", true);
      }
      await Promise.race([
        drain,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new StorageError("storage.worker_timeout", "Storage operation drain exceeded shutdown deadline", true)), remaining);
          timer.unref();
        }),
      ]);
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
    const existingCommand = await this.catalog.getGlobalCommand(command.commandId);
    if (
      existingCommand === null &&
      await this.catalog.countSessions() >= this.sessionDiscoveryLimit
    ) {
      throw new StorageError(
        "storage.resource_limit",
        `Session count reached the configured limit of ${String(this.sessionDiscoveryLimit)}`,
      );
    }
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
          creation: {
            commandId: command.commandId,
            payloadHash,
            commandMethod: "session.create",
            eventId: reservation.command.reservedEventId,
            result: { sessionId },
            acceptedAtMs: now,
          },
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

    this.testFailpoints?.hit("after_session_create_before_catalog_ready", {
      sessionId,
      commandId: command.commandId,
      headSequence: initialized.manifest.lastEventSequence,
    });
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
      recoveryCandidate: false,
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
    return this.runOperation(async () => {
      const previousCreation = this.sessionCreationTail;
      let releaseCreation = (): void => undefined;
      this.sessionCreationTail = new Promise<void>((resolve) => {
        releaseCreation = resolve;
      });
      await previousCreation;
      try {
        return await this.createSessionInternal(command);
      } finally {
        releaseCreation();
      }
    });
  }

  private async openSessionInternal(sessionId: string): Promise<SessionClient> {
    await this.ready();
    const summary = await this.catalog.getSession(sessionId);
    if (summary === null) throw new Error(`Session ${sessionId} was not found in the catalog`);
    const expectedRelativePath = sessionDatabaseRelativePath(sessionId);
    if (summary.dbRelativePath !== expectedRelativePath) {
      throw new StorageError("storage.corrupt", "Catalog session path is not the generated path");
    }
    return this.sessions.registerSession(
      sessionId,
      resolveStoragePath(this.homeDirectory, expectedRelativePath),
      async () => {
        await this.ensureSessionReconciled(sessionId);
      },
      (events, headSequence) => {
        this.scheduleCatalogObservation(sessionId, events, headSequence);
      },
      async (input) => {
        if (this.transactionMayCreateNonterminalRun(input)) {
          // This precedes the canonical write. A failed write can leave an
          // over-inclusive candidate; a crash can never miss a real run.
          await this.catalog.markRecoveryCandidate(sessionId);
        }
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
        recoveryNeeded: observation.recoveryNeeded,
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

  private transactionMayCreateNonterminalRun(
    input: AcceptCommandInput | AppendTransactionInput,
  ): boolean {
    const projections = ("transaction" in input ? input.transaction.projections : input.projections) ?? [];
    return projections.some((projection) => {
      if (projection.kind === "run.put") {
        return !["completed", "cancelled", "failed", "interrupted"].includes(projection.state);
      }
      if (projection.kind === "run.state") {
        return !["completed", "cancelled", "failed", "interrupted"].includes(projection.nextState);
      }
      return false;
    });
  }

  async listRecoveryCandidatePage(
    cursor: RecoveryCandidateCursor | null = null,
  ): Promise<RecoveryCandidatePage> {
    await this.ready();
    return this.catalog.listRecoveryCandidatePage(cursor);
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

  private async finishClose(deadlineAtMs?: number): Promise<void> {
    const errors: unknown[] = [];
    const remaining = (): number => deadlineAtMs === undefined
      ? this.catalogObservationShutdownTimeoutMs
      : Math.max(1, deadlineAtMs - Date.now());
    let startupTimeout: NodeJS.Timeout | null = null;
    const startupDrain = deadlineAtMs === undefined
      ? this.startupRecovery
      : Promise.race([
          this.startupRecovery,
          new Promise<never>((_resolve, reject) => {
            startupTimeout = setTimeout(
              () => reject(new StorageError("storage.worker_timeout", "Startup recovery drain exceeded shutdown deadline", true)),
              remaining(),
            );
            startupTimeout.unref();
          }),
        ]);
    const startupResult = await Promise.allSettled([startupDrain]);
    if (startupTimeout !== null) clearTimeout(startupTimeout);
    if (startupResult[0]?.status === "rejected") errors.push(startupResult[0].reason);
    try {
      await this.drainOperations(deadlineAtMs);
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.drainCatalogObservations({ timeoutMs: Math.min(this.catalogObservationShutdownTimeoutMs, remaining()) });
    } catch (error) {
      errors.push(error);
    }
    this.catalogObservationAbort.abort();
    this.catalogObservations.clear();
    const [sessionsResult] = await Promise.allSettled([this.sessions.close(deadlineAtMs)]);
    const [catalogResult] = await Promise.allSettled([this.catalog.close(deadlineAtMs)]);
    if (sessionsResult?.status === "rejected") errors.push(sessionsResult.reason);
    if (catalogResult?.status === "rejected") errors.push(catalogResult.reason);
    if (errors.length > 0) throw new AggregateError(errors, "Storage shutdown failed");
  }

  close(deadlineAtMs?: number): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.acceptingOperations = false;
    this.sessions.stopAcceptingCommits();
    this.closePromise = this.finishClose(deadlineAtMs);
    return this.closePromise;
  }
}
