import { resolve } from "node:path";

import { z } from "zod";

import {
  BrowserSessionSummarySchema,
  SessionIdSchema,
  type BrowserSessionSummary,
} from "@wi/protocol";

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

export class CatalogClient {
  private readonly rpc: WorkerRpcClient;

  constructor(options: CatalogClientOptions) {
    this.rpc = new WorkerRpcClient({
      workerId: "catalog",
      entryUrl: new URL("./worker-entry.js", import.meta.url),
      workerData: {
        workerId: "catalog",
        databasePath: resolve(options.homeDirectory, "catalog.sqlite3"),
        allowRepair: options.allowRepair === true,
      },
      ...(options.defaultRequestTimeoutMs === undefined
        ? {}
        : { defaultRequestTimeoutMs: options.defaultRequestTimeoutMs }),
      ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
      ...(options.onWorkerReplacement === undefined
        ? {}
        : { onReplacement: options.onWorkerReplacement }),
    });
  }

  async prepareOpen(): Promise<void> {
    await this.rpc.request("catalog.prepareOpen", {}, z.null());
  }

  async openPrepared(): Promise<void> {
    await this.rpc.request("catalog.openPrepared", {}, z.null());
  }

  async getStartupState(): Promise<CatalogStartupState> {
    return this.rpc.request(
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
    return this.rpc.request("catalog.beginRepair", { reason }, CatalogRepairReasonSchema, {
      outcome: "write",
    });
  }

  async completeRepair(): Promise<void> {
    await this.rpc.request("catalog.completeRepair", {}, z.null(), { outcome: "write" });
  }

  async repair(): Promise<never> {
    return this.rpc.request("catalog.repair", {}, z.never(), { outcome: "write" });
  }

  async createProject(input: ProjectRecord): Promise<ProjectRecord> {
    return this.rpc.request("catalog.createProject", input, ProjectRecordSchema, {
      outcome: "write",
    });
  }

  async reserveGlobalCommand(
    input: ReserveGlobalCommandInput,
  ): Promise<GlobalCommandReservation> {
    return this.rpc.request(
      "catalog.reserveGlobalCommand",
      input,
      GlobalCommandReservationSchema,
      { outcome: "write" },
    );
  }

  async completeGlobalCommand(input: CompleteGlobalCommandInput): Promise<GlobalCommandRecord> {
    return this.rpc.request(
      "catalog.completeGlobalCommand",
      input,
      GlobalCommandRecordSchema,
      { outcome: "write" },
    );
  }

  async failGlobalCommand(input: FailGlobalCommandInput): Promise<GlobalCommandRecord> {
    return this.rpc.request(
      "catalog.failGlobalCommand",
      input,
      GlobalCommandRecordSchema,
      { outcome: "write" },
    );
  }

  async setGlobalCommandQuarantine(
    input: SetGlobalCommandQuarantineInput,
  ): Promise<GlobalCommandRecord> {
    return this.rpc.request(
      "catalog.setGlobalCommandQuarantine",
      input,
      GlobalCommandRecordSchema,
      { outcome: "write" },
    );
  }

  async getGlobalCommand(commandId: string): Promise<GlobalCommandRecord | null> {
    return this.rpc.request(
      "catalog.getGlobalCommand",
      { commandId },
      z.union([GlobalCommandRecordSchema, z.null()]),
    );
  }

  async listCreatingGlobalCommands(): Promise<readonly GlobalCommandRecord[]> {
    return this.rpc.request(
      "catalog.listCreatingGlobalCommands",
      {},
      z.array(GlobalCommandRecordSchema),
    );
  }

  async createSessionIndex(input: CreateSessionIndexInput): Promise<SessionSummary> {
    return this.rpc.request("catalog.createSessionIndex", input, SessionSummarySchema, {
      outcome: "write",
    });
  }

  async countSessions(): Promise<number> {
    return this.rpc.request(
      "catalog.countSessions",
      {},
      z.number().int().nonnegative().safe(),
    );
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    return this.rpc.request("catalog.listSessions", {}, z.array(SessionSummarySchema));
  }

  async listCatalogRepairPage(afterSessionId: string | null): Promise<CatalogRepairPage> {
    const input = CatalogRepairPageInputSchema.parse({
      afterSessionId,
      limit: MAXIMUM_CATALOG_REPAIR_PAGE_SIZE,
    });
    return this.rpc.request(
      "catalog.listCatalogRepairPage",
      input,
      CatalogRepairPageSchema,
    );
  }

  async markSessionsMissing(
    sessions: readonly { readonly sessionId: string; readonly dbRelativePath: string }[],
  ): Promise<readonly string[]> {
    const input = MarkSessionsMissingInputSchema.parse({ sessions });
    return this.rpc.request(
      "catalog.markSessionsMissing",
      input,
      z.array(SessionIdSchema).max(MAXIMUM_CATALOG_REPAIR_PAGE_SIZE),
      { outcome: "write" },
    );
  }

  async listBrowserSessionsBounded(
    limit: number,
  ): Promise<readonly BrowserSessionSummary[]> {
    const input = BoundedSessionListInputSchema.parse({ limit });
    return this.rpc.request(
      "catalog.listBrowserSessionsBounded",
      input,
      z.array(BrowserSessionSummarySchema).max(MAXIMUM_BOUNDED_SESSION_LIST_LIMIT),
    );
  }

  async getSession(sessionId: string): Promise<SessionSummary | null> {
    return this.rpc.request(
      "catalog.getSession",
      { sessionId },
      z.union([SessionSummarySchema, z.null()]),
    );
  }

  async updateSessionProjection(
    input: UpdateSessionProjectionInput,
  ): Promise<CatalogProjectionUpdateResult> {
    return this.rpc.request(
      "catalog.updateSessionProjection",
      input,
      CatalogProjectionUpdateResultSchema,
      { outcome: "write" },
    );
  }

  async listRecoveryCandidatePage(
    cursor: RecoveryCandidateCursor | null = null,
  ): Promise<RecoveryCandidatePage> {
    return this.rpc.request(
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
    await this.rpc.request("catalog.markRecoveryCandidate", { sessionId }, z.null(), {
      outcome: "write",
    });
  }

  async markSessionStatus(input: MarkSessionStatusInput): Promise<SessionSummary> {
    return this.rpc.request("catalog.markSessionStatus", input, SessionSummarySchema, {
      outcome: "write",
    });
  }

  async repairSessionClassification(
    inputValue: RepairSessionClassificationInput,
  ): Promise<SessionSummary> {
    const input = RepairSessionClassificationInputSchema.parse(inputValue);
    return this.rpc.request("catalog.repairSessionClassification", input, SessionSummarySchema, {
      outcome: "write",
    });
  }

  async reconcileSessionWithStatus(
    input: ReconcileSessionInput,
  ): Promise<ReconcileSessionResult> {
    return this.rpc.request(
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
    await this.rpc.close(deadlineAtMs);
  }
}
