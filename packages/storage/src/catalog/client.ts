import { resolve } from "node:path";

import { z } from "zod";

import {
  BrowserSessionSummarySchema,
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
  MAXIMUM_BOUNDED_SESSION_LIST_LIMIT,
  ReconcileSessionResultSchema,
  type CatalogProjectionUpdateResult,
  type FailGlobalCommandInput,
  type MarkSessionStatusInput,
  type ReconcileSessionResult,
  type SetGlobalCommandQuarantineInput,
  type UpdateSessionProjectionInput,
} from "./repository.js";

export interface CatalogClientOptions {
  readonly homeDirectory: string;
  readonly defaultRequestTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly onWorkerReplacement?: (replacementCount: number) => void;
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

  async createSessionIndex(input: SessionSummary): Promise<SessionSummary> {
    return this.rpc.request("catalog.createSessionIndex", input, SessionSummarySchema, {
      outcome: "write",
    });
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    return this.rpc.request("catalog.listSessions", {}, z.array(SessionSummarySchema));
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

  async markSessionStatus(input: MarkSessionStatusInput): Promise<SessionSummary> {
    return this.rpc.request("catalog.markSessionStatus", input, SessionSummarySchema, {
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

  async close(): Promise<void> {
    await this.rpc.close();
  }
}
