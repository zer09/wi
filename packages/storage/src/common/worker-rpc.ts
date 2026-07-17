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

export const WORKER_RPC_PAYLOAD_BOUNDS = {
  maximumDepth: 64,
  maximumNodes: 20_000,
  maximumUnits: 1_000_000,
} as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

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
  const maxNodes = bounds.maxNodes ?? WORKER_RPC_PAYLOAD_BOUNDS.maximumNodes;
  const maxUnits = bounds.maxUnits ?? WORKER_RPC_PAYLOAD_BOUNDS.maximumUnits;
  const seen = new WeakSet<object>();
  let nodes = 0;
  let units = 0;
  const visit = (current: unknown, depth: number): void => {
    if (depth > WORKER_RPC_PAYLOAD_BOUNDS.maximumDepth) {
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

export type WorkerRequestOutcome = "read" | "write";

export interface WorkerRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly outcome?: WorkerRequestOutcome;
}

interface PendingRequest {
  readonly parseResult: (value: unknown) => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly outcome: WorkerRequestOutcome;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal | undefined;
  readonly abortListener: (() => void) | undefined;
}

export interface WorkerRpcClientOptions {
  readonly workerId: string;
  readonly entryUrl: URL;
  readonly workerData: unknown;
  readonly defaultRequestTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly onReplacement?: (replacementCount: number) => void;
  readonly workerFactory?: (entryUrl: URL, options: WorkerOptions) => Worker;
}

function finiteTimeout(value: number, description: string): number {
  if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(value)) {
    throw new RangeError(`${description} must be a positive finite safe integer`);
  }
  return value;
}

export class WorkerRpcClient {
  readonly workerId: string;
  private readonly options: WorkerRpcClientOptions;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly terminatingWorkers = new Set<Promise<boolean>>();
  private readonly workerTerminations = new WeakMap<Worker, Promise<boolean>>();
  private readonly defaultRequestTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private worker: Worker | null;
  private nextRequestNumber = 1;
  private replacementCount = 0;
  private replacementBlocked = false;
  private replacementError: StorageError | null = null;
  private replacementPromise: Promise<void> | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: WorkerRpcClientOptions) {
    this.options = options;
    this.workerId = options.workerId;
    this.defaultRequestTimeoutMs = finiteTimeout(
      options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "Worker request timeout",
    );
    this.closeTimeoutMs = finiteTimeout(
      options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
      "Worker close timeout",
    );
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

  private cleanupPending(request: PendingRequest): void {
    clearTimeout(request.timer);
    if (request.signal !== undefined && request.abortListener !== undefined) {
      request.signal.removeEventListener("abort", request.abortListener);
    }
  }

  private takePending(requestId: string): PendingRequest | undefined {
    const request = this.pending.get(requestId);
    if (request === undefined) return undefined;
    this.pending.delete(requestId);
    this.cleanupPending(request);
    return request;
  }

  private failureFor(
    request: PendingRequest,
    code: string,
    message: string,
    retryable = true,
  ): StorageError {
    if (request.outcome === "write") {
      return new StorageError(
        "storage.ambiguous_outcome",
        `${message}; reconcile by commandId or eventId before retrying`,
        false,
      );
    }
    return new StorageError(code, message, retryable);
  }

  private rejectAll(code: string, message: string, retryable = true): void {
    for (const requestId of [...this.pending.keys()]) {
      const request = this.takePending(requestId);
      if (request !== undefined) {
        request.reject(this.failureFor(request, code, message, retryable));
      }
    }
  }

  private installReplacement(): void {
    try {
      this.worker = this.spawn();
      this.replacementBlocked = false;
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

  private terminateWorker(worker: Worker): Promise<boolean> {
    const existing = this.workerTerminations.get(worker);
    if (existing !== undefined) return existing;

    // Ignore late messages/exits, but retain an error listener until termination is confirmed.
    worker.removeAllListeners("message");
    worker.removeAllListeners("exit");
    worker.removeAllListeners("error");
    worker.on("error", () => {
      // The affected requests already failed; this prevents a detached worker from crashing Wi.
    });
    let rawTermination: Promise<unknown>;
    try {
      rawTermination = Promise.resolve(worker.terminate());
    } catch {
      rawTermination = Promise.reject(new Error("Worker termination failed"));
    }

    const termination = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (confirmed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (confirmed) {
          worker.removeAllListeners();
        } else {
          worker.unref();
        }
        resolve(confirmed);
      };
      const timer = setTimeout(() => finish(false), this.closeTimeoutMs);
      timer.unref();
      void rawTermination.then(
        () => finish(true),
        () => finish(false),
      );
    });
    this.workerTerminations.set(worker, termination);
    this.terminatingWorkers.add(termination);
    void termination.then(() => {
      this.terminatingWorkers.delete(termination);
    });
    return termination;
  }

  private terminateAndReplace(worker: Worker, code: string, message: string): void {
    if (worker !== this.worker) return;
    this.worker = null;
    this.rejectAll(code, message);
    const termination = this.terminateWorker(worker);
    const replacement = termination
      .then((terminationConfirmed) => {
        if (!this.closing && this.replacementPromise === replacement) {
          if (terminationConfirmed) {
            this.replacementCount += 1;
            this.installReplacement();
          } else {
            this.replacementBlocked = true;
            this.replacementError = new StorageError(
              "storage.worker_failed",
              `Storage worker ${this.workerId} termination could not be confirmed`,
            );
          }
        }
      })
      .finally(() => {
        if (this.replacementPromise === replacement) this.replacementPromise = null;
      });
    this.replacementPromise = replacement;
  }

  private handleMessage(worker: Worker, message: unknown): void {
    if (worker !== this.worker) return;
    const parsed = WorkerResponseSchema.safeParse(message);
    if (!parsed.success || parsed.data.workerId !== this.workerId) {
      this.terminateAndReplace(
        worker,
        "storage.worker_failed",
        `Storage worker ${this.workerId} returned a malformed response`,
      );
      return;
    }

    const pending = this.takePending(parsed.data.requestId);
    if (pending === undefined) return;
    if (parsed.data.ok) {
      try {
        pending.resolve(pending.parseResult(parsed.data.result));
      } catch {
        pending.reject(
          this.failureFor(
            pending,
            "storage.worker_failed",
            "Storage worker returned an invalid result",
          ),
        );
        this.terminateAndReplace(
          worker,
          "storage.worker_failed",
          `Storage worker ${this.workerId} returned an invalid result`,
        );
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

  private handleExit(worker: Worker, code: number): void {
    if (worker !== this.worker) return;
    this.worker = null;
    worker.removeAllListeners();
    this.rejectAll(
      "storage.worker_failed",
      `Storage worker ${this.workerId} exited with code ${code}`,
    );
    if (!this.closing) {
      this.replacementCount += 1;
      this.installReplacement();
    }
  }

  private waitForReplacement(
    replacement: Promise<void>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.reject(
        new StorageError("storage.request_aborted", "Storage worker request was aborted"),
      );
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (result: "resolved" | "aborted" | "timeout"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortListener);
        if (result === "resolved") resolve();
        else if (result === "aborted") {
          reject(new StorageError("storage.request_aborted", "Storage worker request was aborted"));
        } else {
          reject(
            new StorageError(
              "storage.worker_timeout",
              `Storage worker ${this.workerId} replacement was not ready within ${timeoutMs}ms`,
              true,
            ),
          );
        }
      };
      const abortListener = (): void => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", abortListener, { once: true });
      void replacement.then(
        () => finish("resolved"),
        () => finish("timeout"),
      );
    });
  }

  private sendRequest<T>(
    worker: Worker,
    operation: string,
    payload: unknown,
    resultSchema: z.ZodType<T> | undefined,
    options: WorkerRequestOptions,
  ): Promise<T> {
    assertWorkerPayloadBounds(payload);
    const timeoutMs = finiteTimeout(
      options.timeoutMs ?? this.defaultRequestTimeoutMs,
      "Worker request timeout",
    );
    const request = WorkerRequestSchema.parse({
      v: 1,
      requestId: `rpc_${this.workerId}_${this.nextRequestNumber}`,
      operation,
      payload,
    });
    this.nextRequestNumber += 1;

    if (options.signal?.aborted === true) {
      return Promise.reject(
        new StorageError("storage.request_aborted", "Storage worker request was aborted before send"),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const abortListener =
        options.signal === undefined
          ? undefined
          : (): void => {
              const pending = this.takePending(request.requestId);
              if (pending === undefined) return;
              pending.reject(
                this.failureFor(
                  pending,
                  "storage.request_aborted",
                  "Storage worker request was aborted",
                  false,
                ),
              );
            };
      const timer = setTimeout(() => {
        if (!this.pending.has(request.requestId)) return;
        this.terminateAndReplace(
          worker,
          "storage.worker_timeout",
          `Storage worker ${this.workerId} did not respond within ${timeoutMs}ms`,
        );
      }, timeoutMs);
      timer.unref();
      this.pending.set(request.requestId, {
        parseResult: (value) => (resultSchema === undefined ? value : resultSchema.parse(value)),
        resolve: (value) => resolve(value as T),
        reject,
        outcome: options.outcome ?? "read",
        timer,
        signal: options.signal,
        abortListener,
      });
      options.signal?.addEventListener("abort", abortListener as () => void, { once: true });
      try {
        worker.postMessage(request);
      } catch {
        const pending = this.takePending(request.requestId);
        pending?.reject(
          pending === undefined
            ? new StorageError("storage.worker_failed", "Storage worker request failed", true)
            : this.failureFor(
                pending,
                "storage.worker_failed",
                "Storage worker request failed",
              ),
        );
      }
    });
  }

  async request<T = unknown>(
    operation: string,
    payload: unknown,
    resultSchema?: z.ZodType<T>,
    options: WorkerRequestOptions = {},
  ): Promise<T> {
    if (this.closing) throw new StorageError("storage.worker_failed", "Storage worker is closing");
    const timeoutMs = finiteTimeout(
      options.timeoutMs ?? this.defaultRequestTimeoutMs,
      "Worker request timeout",
    );
    const deadline = Date.now() + timeoutMs;
    const replacement = this.replacementPromise;
    if (replacement !== null) {
      await this.waitForReplacement(replacement, timeoutMs, options.signal);
    }
    if (this.closing) throw new StorageError("storage.worker_failed", "Storage worker is closing");
    if (options.signal?.aborted === true) {
      throw new StorageError("storage.request_aborted", "Storage worker request was aborted");
    }
    if (this.replacementError !== null) {
      // Retry a failed spawn, but never overlap a replacement with an unconfirmed old worker.
      if (!this.replacementBlocked) this.installReplacement();
      if (this.replacementError !== null) throw this.replacementError;
    }
    const worker = this.worker;
    if (worker === null) {
      throw new StorageError("storage.worker_failed", "Storage worker is unavailable", true);
    }
    const remainingTimeoutMs = deadline - Date.now();
    if (remainingTimeoutMs <= 0) {
      throw new StorageError(
        "storage.worker_timeout",
        `Storage worker ${this.workerId} request deadline elapsed before send`,
        true,
      );
    }
    return this.sendRequest(worker, operation, payload, resultSchema, {
      ...options,
      timeoutMs: remainingTimeoutMs,
    });
  }

  private unconfirmedTerminationError(): StorageError {
    return new StorageError(
      "storage.worker_failed",
      `Storage worker ${this.workerId} termination could not be confirmed during close`,
    );
  }

  private async finishClose(): Promise<void> {
    const worker = this.worker;
    this.rejectAll("storage.worker_closed", `Storage worker ${this.workerId} is closing`, false);
    if (worker === null) {
      const terminationResults = await Promise.all([...this.terminatingWorkers]);
      this.terminatingWorkers.clear();
      if (this.replacementBlocked || terminationResults.some((confirmed) => !confirmed)) {
        throw this.unconfirmedTerminationError();
      }
      return;
    }
    let terminationConfirmed = true;
    try {
      await this.sendRequest(worker, "worker.close", {}, z.null(), {
        timeoutMs: this.closeTimeoutMs,
        outcome: "read",
      });
    } catch {
      // Shutdown remains best-effort and bounded; termination below owns cleanup.
    } finally {
      if (this.worker === worker) this.worker = null;
      this.rejectAll("storage.worker_closed", `Storage worker ${this.workerId} closed`, false);
      terminationConfirmed = await this.terminateWorker(worker);
      const terminationResults = await Promise.all([...this.terminatingWorkers]);
      this.terminatingWorkers.clear();
      terminationConfirmed =
        terminationConfirmed && terminationResults.every((confirmed) => confirmed);
    }
    if (!terminationConfirmed) throw this.unconfirmedTerminationError();
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
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
