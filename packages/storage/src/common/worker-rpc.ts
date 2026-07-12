import { Worker, type WorkerOptions } from "node:worker_threads";

import { z } from "zod";

const WorkerErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
});

export const WorkerRequestSchema = z.strictObject({
  v: z.literal(1),
  requestId: z.string().min(1).max(128),
  operation: z.string().min(1).max(128),
  payload: z.unknown(),
});
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;

export const WorkerResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    v: z.literal(1),
    requestId: z.string().min(1).max(128),
    workerId: z.string().min(1).max(128),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    v: z.literal(1),
    requestId: z.string().min(1).max(128),
    workerId: z.string().min(1).max(128),
    ok: z.literal(false),
    error: WorkerErrorSchema,
  }),
]);
export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;

const MAX_WORKER_PAYLOAD_DEPTH = 64;
const MAX_WORKER_REQUEST_NODES = 20_000;
const MAX_WORKER_REQUEST_UNITS = 1_000_000;

export interface WorkerPayloadBounds {
  readonly maxNodes?: number;
  readonly maxUnits?: number;
}

export class StorageError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function toStorageError(
  error: unknown,
  fallbackCode = "storage.worker_failed",
  fallbackMessage = "Unknown storage worker error",
  fallbackRetryable = false,
): StorageError {
  if (error instanceof StorageError) return error;
  const message = error instanceof Error ? error.message : fallbackMessage;
  const sqliteCode =
    error !== null && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code).toUpperCase()
      : "";
  const lower = message.toLowerCase();
  if (
    sqliteCode === "SQLITE_FULL" ||
    sqliteCode === "ENOSPC" ||
    lower.includes("database or disk is full") ||
    lower.includes("no space left on device")
  ) {
    return new StorageError("storage.disk_full", message);
  }
  if (
    sqliteCode === "SQLITE_BUSY" ||
    sqliteCode === "SQLITE_LOCKED" ||
    lower.includes("database is locked") ||
    lower.includes("database is busy")
  ) {
    return new StorageError("storage.busy", message, true);
  }
  if (
    sqliteCode === "SQLITE_CORRUPT" ||
    sqliteCode === "SQLITE_NOTADB" ||
    lower.includes("malformed") ||
    lower.includes("corrupt") ||
    lower.includes("not a database")
  ) {
    return new StorageError("storage.corrupt", message);
  }
  return new StorageError(fallbackCode, message, fallbackRetryable);
}

export function assertWorkerPayloadBounds(
  value: unknown,
  bounds: WorkerPayloadBounds = {},
): void {
  const maxNodes = bounds.maxNodes ?? MAX_WORKER_REQUEST_NODES;
  const maxUnits = bounds.maxUnits ?? MAX_WORKER_REQUEST_UNITS;
  const seen = new WeakSet<object>();
  let nodes = 0;
  let units = 0;
  const visit = (current: unknown, depth: number): void => {
    if (depth > MAX_WORKER_PAYLOAD_DEPTH) {
      throw new StorageError("storage.payload_too_large", "Worker payload nesting is too deep");
    }
    nodes += 1;
    if (nodes > maxNodes) {
      throw new StorageError("storage.payload_too_large", "Worker payload has too many values");
    }
    if (typeof current === "string") units += current.length;
    else if (current instanceof SharedArrayBuffer || current instanceof ArrayBuffer) {
      units += current.byteLength;
    } else if (current !== null && typeof current === "object") {
      if (seen.has(current)) return;
      seen.add(current);
      if (Array.isArray(current)) {
        for (const item of current) visit(item, depth + 1);
      } else {
        for (const [key, item] of Object.entries(current)) {
          units += key.length;
          visit(item, depth + 1);
        }
      }
    }
    if (units > maxUnits) {
      throw new StorageError("storage.payload_too_large", "Worker payload exceeds the size limit");
    }
  };
  visit(value, 0);
}

interface PendingRequest {
  readonly parseResult: (value: unknown) => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export interface WorkerRpcClientOptions {
  readonly workerId: string;
  readonly entryUrl: URL;
  readonly workerData: unknown;
  readonly onReplacement?: (replacementCount: number) => void;
  readonly workerFactory?: (entryUrl: URL, options: WorkerOptions) => Worker;
}

export class WorkerRpcClient {
  readonly workerId: string;
  private readonly options: WorkerRpcClientOptions;
  private readonly pending = new Map<string, PendingRequest>();
  private worker: Worker | null;
  private nextRequestNumber = 1;
  private replacementCount = 0;
  private replacementError: StorageError | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: WorkerRpcClientOptions) {
    this.options = options;
    this.workerId = options.workerId;
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const workerOptions: WorkerOptions = {
      workerData: this.options.workerData,
      name: this.options.workerId,
    };
    const worker =
      this.options.workerFactory?.(this.options.entryUrl, workerOptions) ??
      new Worker(this.options.entryUrl, workerOptions);
    worker.on("message", (message: unknown) => this.handleMessage(worker, message));
    worker.on("error", () => {
      // The exit handler owns request failure and replacement so each request fails once.
    });
    worker.on("exit", (code) => this.handleExit(worker, code));
    return worker;
  }

  private handleMessage(worker: Worker, message: unknown): void {
    if (worker !== this.worker) return;
    const parsed = WorkerResponseSchema.safeParse(message);
    if (!parsed.success || parsed.data.workerId !== this.workerId) {
      void worker.terminate();
      return;
    }

    const pending = this.pending.get(parsed.data.requestId);
    if (pending === undefined) return;
    this.pending.delete(parsed.data.requestId);
    if (parsed.data.ok) {
      try {
        pending.resolve(pending.parseResult(parsed.data.result));
      } catch {
        pending.reject(
          new StorageError("storage.worker_failed", "Storage worker returned an invalid result", true),
        );
        void worker.terminate();
      }
    } else {
      pending.reject(
        new StorageError(
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.retryable,
        ),
      );
    }
  }

  private installReplacement(): void {
    try {
      this.worker = this.spawn();
      this.replacementError = null;
      try {
        this.options.onReplacement?.(this.replacementCount);
      } catch {
        // A monitoring callback cannot take down an otherwise healthy replacement worker.
      }
    } catch {
      this.worker = null;
      this.replacementError = new StorageError(
        "storage.worker_failed",
        `Storage worker ${this.workerId} replacement failed`,
        true,
      );
    }
  }

  private handleExit(worker: Worker, code: number): void {
    if (worker !== this.worker) return;
    const error = new StorageError(
      "storage.worker_failed",
      `Storage worker ${this.workerId} exited with code ${code}`,
      true,
    );
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();

    this.worker = null;
    if (!this.closing) {
      this.replacementCount += 1;
      this.installReplacement();
    }
  }

  private sendRequest<T>(
    worker: Worker,
    operation: string,
    payload: unknown,
    resultSchema?: z.ZodType<T>,
  ): Promise<T> {
    assertWorkerPayloadBounds(payload);
    const request = WorkerRequestSchema.parse({
      v: 1,
      requestId: `rpc_${this.workerId}_${this.nextRequestNumber}`,
      operation,
      payload,
    });
    this.nextRequestNumber += 1;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(request.requestId, {
        parseResult: (value) => (resultSchema === undefined ? value : resultSchema.parse(value)),
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        worker.postMessage(request);
      } catch {
        this.pending.delete(request.requestId);
        reject(new StorageError("storage.worker_failed", "Storage worker request failed", true));
      }
    });
  }

  async request<T = unknown>(
    operation: string,
    payload: unknown,
    resultSchema?: z.ZodType<T>,
  ): Promise<T> {
    if (this.closing) throw new StorageError("storage.worker_failed", "Storage worker is closing");
    if (this.replacementError !== null) {
      // A transient OS resource failure should not wedge this worker slot forever.
      this.installReplacement();
      if (this.replacementError !== null) throw this.replacementError;
    }
    const worker = this.worker;
    if (worker === null) {
      throw new StorageError("storage.worker_failed", "Storage worker is unavailable", true);
    }
    return this.sendRequest(worker, operation, payload, resultSchema);
  }

  private async finishClose(): Promise<void> {
    const worker = this.worker;
    if (worker === null) return;
    try {
      await this.sendRequest(worker, "worker.close", {}, z.null());
    } finally {
      if (this.worker === worker) this.worker = null;
      await worker.terminate();
    }
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    // Flip the state synchronously so no request can be queued behind worker.close.
    this.closing = true;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }
}

export function workerError(error: unknown): { code: string; message: string; retryable: boolean } {
  const classified = toStorageError(error);
  return {
    code: classified.code,
    message: classified.message,
    retryable: classified.retryable,
  };
}
