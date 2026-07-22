import { resolve } from "node:path";

import { z } from "zod";

import {
  BrowserSessionSummarySchema,
  SessionIdSchema,
  type BrowserSessionSummary,
} from "@wi/protocol";

import { SessionStatusCoordinator } from "../common/session-status-coordinator.js";
import { WorkerRpcClient } from "../common/worker-rpc.js";
import {
  GlobalCommandRecordSchema,
  GlobalCommandReservationSchema,
  ProjectRecordSchema,
  SessionSummarySchema,
  type GlobalCommandRecord,
  type GlobalCommandReservation,
  type ProjectRecord,
  type SessionCreationRequest,
  type SessionManifest,
  type SessionSummary,
} from "../types.js";
import {
  BoundedSessionListInputSchema,
  CatalogProjectionUpdateResultSchema,
  CatalogRepairPageInputSchema,
  CatalogRepairPageSchema,
  CatalogRepairReasonSchema,
  MarkSessionsMissingInputSchema,
  MAXIMUM_BOUNDED_SESSION_LIST_LIMIT,
  MAXIMUM_CATALOG_REPAIR_PAGE_SIZE,
  ReconcileSessionResultSchema,
  RepairSessionClassificationInputSchema,
  type CatalogProjectionUpdateResult,
  type CatalogRepairPage,
  type CatalogRepairReason,
  type CreateSessionIndexInput,
  type FailGlobalCommandInput,
  type MarkSessionStatusInput,
  type ReconcileSessionResult,
  type RepairSessionClassificationInput,
  type SetGlobalCommandQuarantineInput,
  type UpdateSessionProjectionInput,
} from "./repository.js";

export interface CatalogClientOptions {
  readonly homeDirectory: string;
  readonly defaultRequestTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly onWorkerReplacement?: (replacementCount: number) => void;
  readonly allowRepair?: boolean;
}

export interface CatalogStartupState {
  // Retained only for RPC compatibility; durable repair state is authoritative.
  readonly created: boolean;
  readonly repairReason: CatalogRepairReason | null;
  readonly hasCompletedRepair: boolean;
}

export interface RecoveryCandidateCursor {
  readonly updatedAtMs: number;
  readonly sessionId: string;
}

export interface RecoveryCandidatePage {
  readonly sessionIds: readonly string[];
  readonly nextCursor: RecoveryCandidateCursor | null;
}

export interface ReserveGlobalCommandInput {
  readonly commandId: string;
  readonly payloadHash: string;
  readonly reservedSessionId: string;
  readonly reservedEventId: string;
  readonly request: SessionCreationRequest;
  readonly updatedAtMs: number;
}

export interface CompleteGlobalCommandInput {
  readonly commandId: string;
  readonly payloadHash: string;
  readonly result: unknown;
  readonly acceptedAtMs: number;
}

export interface ReconcileSessionInput {
  readonly manifest: SessionManifest;
  readonly dbRelativePath: string;
  readonly expectedCatalogSequence: number | null;
  readonly expectedCatalogStatus: SessionSummary["status"] | null;
  readonly updatedAtMs: number;
  readonly lastRunState: SessionSummary["lastRunState"];
  readonly lastMessagePreview: SessionSummary["lastMessagePreview"];
  readonly pendingApprovalCount: number;
  readonly pendingInputCount: number;
  readonly recoveryNeeded: boolean;
}

interface SharedCatalogSessionStatusCoordinator {
  readonly coordinator: SessionStatusCoordinator;
  references: number;
}

interface CatalogClientState {
  readonly rpc: WorkerRpcClient;
  readonly homeDirectory: string;
  readonly sharedCoordinator: SharedCatalogSessionStatusCoordinator;
  coordinatorReleased: boolean;
}

const sharedCatalogSessionStatusCoordinators = new Map<
  string,
  SharedCatalogSessionStatusCoordinator
>();
const catalogClients = new WeakMap<CatalogClient, CatalogClientState>();

function acquireCatalogSessionStatusCoordinator(
  homeDirectory: string,
): SharedCatalogSessionStatusCoordinator {
  let shared = sharedCatalogSessionStatusCoordinators.get(homeDirectory);
  if (shared === undefined) {
    shared = { coordinator: new SessionStatusCoordinator(), references: 0 };
    sharedCatalogSessionStatusCoordinators.set(homeDirectory, shared);
  }
  shared.references += 1;
  return shared;
}

function releaseCatalogSessionStatusCoordinator(state: CatalogClientState): void {
  if (state.coordinatorReleased) return;
  state.coordinatorReleased = true;
  state.sharedCoordinator.references -= 1;
  if (
    state.sharedCoordinator.references === 0 &&
    sharedCatalogSessionStatusCoordinators.get(state.homeDirectory) === state.sharedCoordinator
  ) {
    sharedCatalogSessionStatusCoordinators.delete(state.homeDirectory);
  }
}

function catalogState(client: CatalogClient): CatalogClientState {
  const state = catalogClients.get(client);
  if (state === undefined) throw new Error("Catalog client is not initialized");
  return state;
}

export function catalogSessionStatusCoordinator(
  client: CatalogClient,
): SessionStatusCoordinator {
  return catalogState(client).sharedCoordinator.coordinator;
}

function withCatalogSessionStatusTransition<T>(
  client: CatalogClient,
  sessionIds: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  return catalogSessionStatusCoordinator(client).run(sessionIds, operation);
}

function catalogRpc(client: CatalogClient): WorkerRpcClient {
  return catalogState(client).rpc;
}

export class CatalogClient {
  constructor(options: CatalogClientOptions) {
    const homeDirectory = resolve(options.homeDirectory);
    const sharedCoordinator = acquireCatalogSessionStatusCoordinator(homeDirectory);
    try {
      catalogClients.set(this, {
        rpc: new WorkerRpcClient({
          workerId: "catalog",
          entryUrl: new URL("./worker-entry.js", import.meta.url),
          workerData: {
            workerId: "catalog",
            databasePath: resolve(homeDirectory, "catalog.sqlite3"),
            allowRepair: options.allowRepair === true,
          },
          ...(options.defaultRequestTimeoutMs === undefined
            ? {}
            : { defaultRequestTimeoutMs: options.defaultRequestTimeoutMs }),
          ...(options.closeTimeoutMs === undefined
            ? {}
            : { closeTimeoutMs: options.closeTimeoutMs }),
          ...(options.onWorkerReplacement === undefined
            ? {}
            : { onReplacement: options.onWorkerReplacement }),
        }),
        homeDirectory,
        sharedCoordinator,
        coordinatorReleased: false,
      });
    } catch (error) {
      sharedCoordinator.references -= 1;
      if (sharedCoordinator.references === 0) {
        sharedCatalogSessionStatusCoordinators.delete(homeDirectory);
      }
      throw error;
    }
  }

  async prepareOpen(): Promise<void> {
    await catalogRpc(this).request("catalog.prepareOpen", {}, z.null());
  }

  async openPrepared(): Promise<void> {
    await catalogRpc(this).request("catalog.openPrepared", {}, z.null());
  }

  async getStartupState(): Promise<CatalogStartupState> {
    return catalogRpc(this).request(
      "catalog.getStartupState",
      {},
      z.strictObject({
        created: z.boolean(),
        repairReason: z.union([CatalogRepairReasonSchema, z.null()]),
        hasCompletedRepair: z.boolean(),
      }),
    );
  }

  async beginRepair(reason: CatalogRepairReason): Promise<CatalogRepairReason> {
    return catalogRpc(this).request("catalog.beginRepair", { reason }, CatalogRepairReasonSchema, {
      outcome: "write",
    });
  }

  async completeRepair(): Promise<void> {
    await catalogRpc(this).request("catalog.completeRepair", {}, z.null(), { outcome: "write" });
  }

  async repair(): Promise<never> {
    return catalogRpc(this).request("catalog.repair", {}, z.never(), { outcome: "write" });
  }

  async createProject(input: ProjectRecord): Promise<ProjectRecord> {
    return catalogRpc(this).request("catalog.createProject", input, ProjectRecordSchema, {
      outcome: "write",
    });
  }

  async reserveGlobalCommand(
    input: ReserveGlobalCommandInput,
  ): Promise<GlobalCommandReservation> {
    return catalogRpc(this).request(
      "catalog.reserveGlobalCommand",
      input,
      GlobalCommandReservationSchema,
      { outcome: "write" },
    );
  }

  async completeGlobalCommand(input: CompleteGlobalCommandInput): Promise<GlobalCommandRecord> {
    return catalogRpc(this).request(
      "catalog.completeGlobalCommand",
      input,
      GlobalCommandRecordSchema,
      { outcome: "write" },
    );
  }

  async failGlobalCommand(input: FailGlobalCommandInput): Promise<GlobalCommandRecord> {
    return withCatalogSessionStatusTransition(this, [input.session.sessionId], () =>
      catalogRpc(this).request(
        "catalog.failGlobalCommand",
        input,
        GlobalCommandRecordSchema,
        { outcome: "write" },
      ),
    );
  }

  async setGlobalCommandQuarantine(
    input: SetGlobalCommandQuarantineInput,
  ): Promise<GlobalCommandRecord> {
    return catalogRpc(this).request(
      "catalog.setGlobalCommandQuarantine",
      input,
      GlobalCommandRecordSchema,
      { outcome: "write" },
    );
  }

  async getGlobalCommand(commandId: string): Promise<GlobalCommandRecord | null> {
    return catalogRpc(this).request(
      "catalog.getGlobalCommand",
      { commandId },
      z.union([GlobalCommandRecordSchema, z.null()]),
    );
  }

  async listCreatingGlobalCommands(): Promise<readonly GlobalCommandRecord[]> {
    return catalogRpc(this).request(
      "catalog.listCreatingGlobalCommands",
      {},
      z.array(GlobalCommandRecordSchema),
    );
  }

  async createSessionIndex(input: CreateSessionIndexInput): Promise<SessionSummary> {
    return withCatalogSessionStatusTransition(this, [input.sessionId], () =>
      catalogRpc(this).request("catalog.createSessionIndex", input, SessionSummarySchema, {
        outcome: "write",
      }),
    );
  }

  async countSessions(): Promise<number> {
    return catalogRpc(this).request(
      "catalog.countSessions",
      {},
      z.number().int().nonnegative().safe(),
    );
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    return catalogRpc(this).request("catalog.listSessions", {}, z.array(SessionSummarySchema));
  }

  async listCatalogRepairPage(afterSessionId: string | null): Promise<CatalogRepairPage> {
    const input = CatalogRepairPageInputSchema.parse({
      afterSessionId,
      limit: MAXIMUM_CATALOG_REPAIR_PAGE_SIZE,
    });
    return catalogRpc(this).request(
      "catalog.listCatalogRepairPage",
      input,
      CatalogRepairPageSchema,
    );
  }

  async markSessionsMissing(
    sessions: readonly { readonly sessionId: string; readonly dbRelativePath: string }[],
  ): Promise<readonly string[]> {
    const input = MarkSessionsMissingInputSchema.parse({ sessions });
    return withCatalogSessionStatusTransition(
      this,
      input.sessions.map((session) => session.sessionId),
      () => catalogRpc(this).request(
        "catalog.markSessionsMissing",
        input,
        z.array(SessionIdSchema).max(MAXIMUM_CATALOG_REPAIR_PAGE_SIZE),
        { outcome: "write" },
      ),
    );
  }

  async listBrowserSessionsBounded(
    limit: number,
  ): Promise<readonly BrowserSessionSummary[]> {
    const input = BoundedSessionListInputSchema.parse({ limit });
    return catalogRpc(this).request(
      "catalog.listBrowserSessionsBounded",
      input,
      z.array(BrowserSessionSummarySchema).max(MAXIMUM_BOUNDED_SESSION_LIST_LIMIT),
    );
  }

  async getSession(sessionId: string): Promise<SessionSummary | null> {
    return catalogRpc(this).request(
      "catalog.getSession",
      { sessionId },
      z.union([SessionSummarySchema, z.null()]),
    );
  }

  async updateSessionProjection(
    input: UpdateSessionProjectionInput,
  ): Promise<CatalogProjectionUpdateResult> {
    return catalogRpc(this).request(
      "catalog.updateSessionProjection",
      input,
      CatalogProjectionUpdateResultSchema,
      { outcome: "write" },
    );
  }

  async listRecoveryCandidatePage(
    cursor: RecoveryCandidateCursor | null = null,
  ): Promise<RecoveryCandidatePage> {
    return catalogRpc(this).request(
      "catalog.listRecoveryCandidates",
      {
        afterUpdatedAtMs: cursor?.updatedAtMs ?? null,
        afterSessionId: cursor?.sessionId ?? null,
        limit: 1_000,
      },
      z.strictObject({
        sessionIds: z.array(SessionIdSchema).max(1_000),
        nextCursor: z
          .strictObject({
            updatedAtMs: z.number().int().nonnegative().safe(),
            sessionId: SessionIdSchema,
          })
          .nullable(),
      }),
    );
  }

  async markRecoveryCandidate(sessionId: string): Promise<void> {
    await catalogRpc(this).request("catalog.markRecoveryCandidate", { sessionId }, z.null(), {
      outcome: "write",
    });
  }

  async markSessionStatus(input: MarkSessionStatusInput): Promise<SessionSummary> {
    return withCatalogSessionStatusTransition(this, [input.sessionId], () =>
      catalogRpc(this).request("catalog.markSessionStatus", input, SessionSummarySchema, {
        outcome: "write",
      }),
    );
  }

  async repairSessionClassification(
    inputValue: RepairSessionClassificationInput,
  ): Promise<SessionSummary> {
    const input = RepairSessionClassificationInputSchema.parse(inputValue);
    return withCatalogSessionStatusTransition(this, [input.sessionId], () =>
      catalogRpc(this).request(
        "catalog.repairSessionClassification",
        input,
        SessionSummarySchema,
        { outcome: "write" },
      ),
    );
  }

  async reconcileSessionWithStatus(
    input: ReconcileSessionInput,
  ): Promise<ReconcileSessionResult> {
    return catalogRpc(this).request(
      "catalog.reconcileSession",
      input,
      ReconcileSessionResultSchema,
      { outcome: "write" },
    );
  }

  async reconcileSession(input: ReconcileSessionInput): Promise<SessionSummary> {
    return (await this.reconcileSessionWithStatus(input)).summary;
  }

  async close(deadlineAtMs?: number): Promise<void> {
    const state = catalogState(this);
    try {
      await state.rpc.close(deadlineAtMs);
    } finally {
      releaseCatalogSessionStatusCoordinator(state);
    }
  }
}

export function reconcileValidatedRepairSession(
  catalog: CatalogClient,
  input: ReconcileSessionInput,
): Promise<ReconcileSessionResult> {
  return withCatalogSessionStatusTransition(catalog, [input.manifest.sessionId], () =>
    catalogRpc(catalog).request(
      "catalog.reconcileValidatedRepairSession",
      input,
      ReconcileSessionResultSchema,
      { outcome: "write" },
    ),
  );
}
