import { availableParallelism } from "node:os";

import { z } from "zod";

import { SessionEventSchema } from "@wi/protocol";

import { StorageError, WorkerRpcClient } from "../common/worker-rpc.js";
import { stableSessionWorkerIndex } from "../manager/paths.js";
import {
  AcceptedCommandResultSchema,
  AppendTransactionResultSchema,
  PendingApprovalRecordSchema,
  RunRecordSchema,
  SessionCatalogProjectionSchema,
  SessionManifestSchema,
  SessionRecoveryResultSchema,
  type AcceptCommandInput,
  type AcceptedCommandResult,
  type AppendTransactionInput,
  type AppendTransactionResult,
  type PendingApprovalRecord,
  type RunRecord,
  type SessionCatalogProjection,
  type SessionManifest,
  type SessionRecoveryResult,
} from "../types.js";
import { SessionClient } from "./client.js";

export interface SessionWorkerPoolOptions {
  readonly size?: number;
  readonly maxOpenHandlesPerWorker?: number;
  readonly allowTestOperations?: boolean;
  readonly onWorkerReplacement?: (workerIndex: number, replacementCount: number) => void;
  readonly onSessionError?: (sessionId: string, error: unknown) => void | Promise<void>;
  readonly onSessionCommit?: (
    sessionId: string,
    events: readonly z.infer<typeof SessionEventSchema>[],
    headSequence: number,
  ) => Promise<boolean>;
}

export interface ObservedSessionCommit<T> {
  readonly result: T;
  readonly catalogUpdated: boolean;
}

export interface InitializeSessionInput {
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly createdAtMs: number;
  readonly eventId: string;
}

export interface SessionWorkerStats {
  readonly workerIndex: number;
  readonly openSessionIds: readonly string[];
}

export interface SessionSqlitePragmas {
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: number;
  readonly busyTimeout: number;
  readonly trustedSchema: number;
  readonly sqliteVersion: string;
}

function defaultPoolSize(): number {
  return Math.min(4, Math.max(2, availableParallelism() - 1));
}

export class SessionWorkerPool {
  readonly size: number;
  private readonly workers: readonly WorkerRpcClient[];
  private readonly paths = new Map<string, string>();
  private readonly commitObservationTails = new Map<string, Promise<void>>();
  private readonly activeCommitOperations = new Set<Promise<void>>();
  private readonly allowTestOperations: boolean;
  private acceptingCommits = true;
  private closePromise: Promise<void> | null = null;
  private readonly onSessionError:
    | ((sessionId: string, error: unknown) => void | Promise<void>)
    | undefined;
  private readonly onSessionCommit:
    | ((
        sessionId: string,
        events: readonly z.infer<typeof SessionEventSchema>[],
        headSequence: number,
      ) => Promise<boolean>)
    | undefined;

  constructor(options: SessionWorkerPoolOptions = {}) {
    this.size = options.size ?? defaultPoolSize();
    if (!Number.isSafeInteger(this.size) || this.size < 1) {
      throw new RangeError("Session worker pool size must be a positive safe integer");
    }
    const maxOpenHandles = options.maxOpenHandlesPerWorker ?? 32;
    if (!Number.isSafeInteger(maxOpenHandles) || maxOpenHandles < 1) {
      throw new RangeError("Session worker handle limit must be a positive safe integer");
    }
    this.allowTestOperations =
      options.allowTestOperations === true && process.env.NODE_ENV === "test";
    this.onSessionError = options.onSessionError;
    this.onSessionCommit = options.onSessionCommit;
    this.workers = Array.from({ length: this.size }, (_, workerIndex) =>
      new WorkerRpcClient({
        workerId: `session-${workerIndex}`,
        entryUrl: new URL("./worker-entry.js", import.meta.url),
        workerData: {
          workerId: `session-${workerIndex}`,
          maxOpenHandles,
          allowTestOperations: this.allowTestOperations,
        },
        ...(options.onWorkerReplacement === undefined
          ? {}
          : {
              onReplacement: (replacementCount) =>
                options.onWorkerReplacement?.(workerIndex, replacementCount),
            }),
      }),
    );
  }

  workerIndexFor(sessionId: string): number {
    return stableSessionWorkerIndex(sessionId, this.size);
  }

  registerSession(
    sessionId: string,
    databasePath: string,
    beforeUse?: () => Promise<void>,
  ): SessionClient {
    const existing = this.paths.get(sessionId);
    if (existing !== undefined && existing !== databasePath) {
      throw new Error("Session database path cannot change within a pool");
    }
    this.paths.set(sessionId, databasePath);
    return new SessionClient(this, sessionId, beforeUse);
  }

  session(sessionId: string): SessionClient {
    if (!this.paths.has(sessionId)) throw new Error(`Session ${sessionId} is not registered`);
    return new SessionClient(this, sessionId);
  }

  private location(sessionId: string): { sessionId: string; databasePath: string } {
    const databasePath = this.paths.get(sessionId);
    if (databasePath === undefined) throw new Error(`Session ${sessionId} is not registered`);
    return { sessionId, databasePath };
  }

  private worker(sessionId: string): WorkerRpcClient {
    const worker = this.workers[this.workerIndexFor(sessionId)];
    if (worker === undefined) throw new Error("Stable routing selected a missing worker");
    return worker;
  }

  private async request<T>(
    sessionId: string,
    operation: string,
    payload: object,
    resultSchema: z.ZodType<T>,
  ): Promise<T> {
    try {
      return await this.worker(sessionId).request(
        operation,
        { ...this.location(sessionId), ...payload },
        resultSchema,
      );
    } catch (error) {
      try {
        await this.onSessionError?.(sessionId, error);
      } catch {
        // Preserve the operation error even if diagnostic catalog handling fails.
      }
      throw error;
    }
  }

  async initialize(input: InitializeSessionInput, databasePath: string): Promise<{
    manifest: SessionManifest;
    events: readonly z.infer<typeof SessionEventSchema>[];
  }> {
    this.registerSession(input.sessionId, databasePath);
    return this.request(
      input.sessionId,
      "session.initialize",
      input,
      z.strictObject({ manifest: SessionManifestSchema, events: z.array(SessionEventSchema) }),
    );
  }

  async getManifest(sessionId: string): Promise<SessionManifest> {
    return this.request(sessionId, "session.getManifest", {}, SessionManifestSchema);
  }

  stopAcceptingCommits(): void {
    this.acceptingCommits = false;
  }

  private async runCommitOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.acceptingCommits) {
      throw new StorageError("storage.worker_failed", "Session worker pool is closing");
    }
    const running = operation();
    const completion = running.then(
      () => undefined,
      () => undefined,
    );
    this.activeCommitOperations.add(completion);
    try {
      return await running;
    } finally {
      this.activeCommitOperations.delete(completion);
    }
  }

  private async drainCommitOperations(): Promise<void> {
    while (this.activeCommitOperations.size > 0) {
      await Promise.all(this.activeCommitOperations);
    }
  }

  private async runCommitObserver(
    sessionId: string,
    events: readonly z.infer<typeof SessionEventSchema>[],
    headSequence: number,
  ): Promise<boolean> {
    if (this.onSessionCommit === undefined) return false;
    try {
      return await this.onSessionCommit(sessionId, events, headSequence);
    } catch {
      // A catalog/index observer cannot undo or replace a committed session result.
      return false;
    }
  }

  private observeCommit(
    sessionId: string,
    events: readonly z.infer<typeof SessionEventSchema>[],
    headSequence: number,
  ): Promise<boolean> {
    const previous = this.commitObservationTails.get(sessionId) ?? Promise.resolve();
    const observation = previous.then(() =>
      this.runCommitObserver(sessionId, events, headSequence),
    );
    const tail = observation.then(() => undefined);
    this.commitObservationTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.commitObservationTails.get(sessionId) === tail) {
        this.commitObservationTails.delete(sessionId);
      }
    });
    return observation;
  }

  async drainCommitObservations(): Promise<void> {
    while (this.commitObservationTails.size > 0) {
      await Promise.all(this.commitObservationTails.values());
    }
  }

  async acceptCommandWithCommitStatus(
    sessionId: string,
    input: AcceptCommandInput,
  ): Promise<ObservedSessionCommit<AcceptedCommandResult>> {
    return this.runCommitOperation(async () => {
      const result = await this.request(
        sessionId,
        "session.acceptCommand",
        { input },
        AcceptedCommandResultSchema,
      );
      const headSequence = result.acceptedSequence ?? (await this.getHeadSequence(sessionId));
      const catalogUpdated = await this.observeCommit(
        sessionId,
        result.events,
        headSequence,
      );
      return { result, catalogUpdated };
    });
  }

  async acceptCommand(
    sessionId: string,
    input: AcceptCommandInput,
  ): Promise<AcceptedCommandResult> {
    return (await this.acceptCommandWithCommitStatus(sessionId, input)).result;
  }

  async appendTransactionWithCommitStatus(
    sessionId: string,
    input: AppendTransactionInput,
  ): Promise<ObservedSessionCommit<AppendTransactionResult>> {
    return this.runCommitOperation(async () => {
      const result = await this.request(
        sessionId,
        "session.appendTransaction",
        { input },
        AppendTransactionResultSchema,
      );
      const catalogUpdated = await this.observeCommit(
        sessionId,
        result.events,
        result.headSequence,
      );
      return { result, catalogUpdated };
    });
  }

  async appendTransaction(
    sessionId: string,
    input: AppendTransactionInput,
  ): Promise<AppendTransactionResult> {
    return (await this.appendTransactionWithCommitStatus(sessionId, input)).result;
  }

  async getEventsAfter(
    sessionId: string,
    afterSequence: number,
    throughSequence?: number,
  ): Promise<readonly z.infer<typeof SessionEventSchema>[]> {
    const payload =
      throughSequence === undefined ? { afterSequence } : { afterSequence, throughSequence };
    return this.request(
      sessionId,
      "session.getEventsAfter",
      payload,
      z.array(SessionEventSchema),
    );
  }

  async getHeadSequence(sessionId: string): Promise<number> {
    return this.request(
      sessionId,
      "session.getHeadSequence",
      {},
      z.number().int().nonnegative().safe(),
    );
  }

  async getRun(sessionId: string, runId: string): Promise<RunRecord | null> {
    return this.request(
      sessionId,
      "session.getRun",
      { runId },
      z.union([RunRecordSchema, z.null()]),
    );
  }

  async getCatalogProjection(sessionId: string): Promise<SessionCatalogProjection> {
    return this.request(
      sessionId,
      "session.getCatalogProjection",
      {},
      SessionCatalogProjectionSchema,
    );
  }

  async getPendingApprovals(sessionId: string): Promise<readonly PendingApprovalRecord[]> {
    return this.request(
      sessionId,
      "session.getPendingApprovals",
      {},
      z.array(PendingApprovalRecordSchema),
    );
  }

  async getPendingInputCount(sessionId: string): Promise<number> {
    return this.request(
      sessionId,
      "session.getPendingInputCount",
      {},
      z.number().int().nonnegative().safe(),
    );
  }

  async recover(sessionId: string): Promise<SessionRecoveryResult> {
    return this.request(sessionId, "session.recover", {}, SessionRecoveryResultSchema);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request(sessionId, "session.close", {}, z.null());
  }

  async getStats(): Promise<readonly SessionWorkerStats[]> {
    return Promise.all(
      this.workers.map(async (worker, workerIndex) => {
        const result = await worker.request(
          "session.getStats",
          {},
          z.strictObject({ openSessionIds: z.array(z.string()) }),
        );
        return { workerIndex, openSessionIds: result.openSessionIds };
      }),
    );
  }

  async initializeSchemaOnlyForTest(sessionId: string, databasePath: string): Promise<void> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    this.registerSession(sessionId, databasePath);
    await this.request(sessionId, "session.testInitializeSchemaOnly", {}, z.null());
  }

  async getPragmasForTest(sessionId: string): Promise<SessionSqlitePragmas> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    return this.request(
      sessionId,
      "session.testGetPragmas",
      {},
      z.strictObject({
        journalMode: z.string(),
        synchronous: z.number().int(),
        foreignKeys: z.number().int(),
        busyTimeout: z.number().int(),
        trustedSchema: z.number().int(),
        sqliteVersion: z.string(),
      }),
    );
  }

  async malformedResponseForTest(sessionId: string): Promise<void> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    await this.request(sessionId, "session.testMalformedResponse", {}, z.null());
  }

  async malformedResultForTest(sessionId: string): Promise<void> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    await this.request(sessionId, "session.testMalformedResult", {}, z.null());
  }

  async proveConcurrentWorkersForTest(sessionIds: readonly string[]): Promise<void> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    const workerIndices = new Set(sessionIds.map((sessionId) => this.workerIndexFor(sessionId)));
    if (workerIndices.size !== sessionIds.length) {
      throw new Error("Barrier sessions must route to different workers");
    }

    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const view = new Int32Array(barrier);
    const requests = sessionIds.map((sessionId) =>
      this.request(sessionId, "session.testBarrier", { barrier }, z.null()),
    );
    const deadline = Date.now() + 5_000;
    while (Atomics.load(view, 0) < sessionIds.length) {
      if (Date.now() >= deadline) {
        Atomics.store(view, 1, 1);
        Atomics.notify(view, 1, sessionIds.length);
        await Promise.allSettled(requests);
        throw new Error("Session workers did not reach the barrier");
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    Atomics.store(view, 1, 1);
    Atomics.notify(view, 1, sessionIds.length);
    await Promise.all(requests);
  }

  async corruptManifestForTest(sessionId: string): Promise<void> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    await this.request(sessionId, "session.testCorruptManifest", {}, z.null());
  }

  async testMutateEvent(
    sessionId: string,
    action: "update" | "delete",
    sequence: number,
  ): Promise<void> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    await this.request(sessionId, "session.testMutateEvent", { action, sequence }, z.null());
  }

  async crashWorkerForTest(sessionId: string): Promise<void> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    await this.request(sessionId, "session.testCrashWorker", {}, z.null());
  }

  private async finishClose(): Promise<void> {
    await this.drainCommitOperations();
    await this.drainCommitObservations();
    await Promise.all(this.workers.map((worker) => worker.close()));
  }

  close(): Promise<void> {
    this.stopAcceptingCommits();
    this.closePromise ??= this.finishClose();
    return this.closePromise;
  }
}
