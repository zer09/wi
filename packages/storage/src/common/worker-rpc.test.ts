import { EventEmitter } from "node:events";
import type { Worker, WorkerOptions } from "node:worker_threads";

import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  StorageError,
  toStorageError,
  WorkerRpcClient,
  type WorkerRequest,
} from "./worker-rpc.js";

class FakeWorker extends EventEmitter {
  readonly posted: WorkerRequest[] = [];
  terminateCalls = 0;
  unrefCalls = 0;

  constructor(
    private readonly onPost?: (request: WorkerRequest, worker: FakeWorker) => void,
    private readonly terminateResult: () => Promise<number> = async () => 0,
  ) {
    super();
  }

  postMessage(message: WorkerRequest): void {
    this.posted.push(message);
    this.onPost?.(message, this);
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    return this.terminateResult();
  }

  unref(): void {
    this.unrefCalls += 1;
  }

  respond(request: WorkerRequest, workerId: string, result: unknown): void {
    this.emit("message", {
      v: 1,
      requestId: request.requestId,
      workerId,
      ok: true,
      result,
    });
  }

  exit(code: number): void {
    this.emit("exit", code);
  }
}

function asWorker(worker: FakeWorker): Worker {
  return worker as unknown as Worker;
}

function responsiveWorker(workerId: string): FakeWorker {
  return new FakeWorker((request, worker) => {
    worker.respond(request, workerId, request.operation === "worker.close" ? null : "recovered");
  });
}

function workerFactorySequence(
  factories: readonly (() => FakeWorker)[],
): (entryUrl: URL, options: WorkerOptions) => Worker {
  let index = 0;
  return () => {
    const factory = factories[index] ?? factories.at(-1);
    index += 1;
    if (factory === undefined) throw new Error("Missing fake worker factory");
    return asWorker(factory());
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkerRpcClient replacement failures", () => {
  it("retries replacement creation on a later request", async () => {
    let spawnAttempts = 0;
    const first = new FakeWorker();
    const rpc = new WorkerRpcClient({
      workerId: "replacement-test",
      entryUrl: new URL("file:///unused-worker-entry.js"),
      workerData: null,
      defaultRequestTimeoutMs: 500,
      workerFactory: () => {
        spawnAttempts += 1;
        if (spawnAttempts === 1) return asWorker(first);
        if (spawnAttempts === 2) throw new Error("injected replacement spawn failure");
        return asWorker(responsiveWorker("replacement-test"));
      },
    });

    const pending = rpc.request("replacement.request", {});
    first.exit(91);
    await expect(pending).rejects.toMatchObject({
      code: "storage.worker_failed",
      retryable: true,
    });
    expect(spawnAttempts).toBe(2);
    await expect(rpc.request("replacement.request", {}, z.string())).resolves.toBe("recovered");
    expect(spawnAttempts).toBe(3);
    await expect(rpc.close()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("WorkerRpcClient bounded liveness", () => {
  it("times out a nonresponsive worker, terminates it, and uses its replacement", async () => {
    const first = new FakeWorker();
    const replacement = responsiveWorker("liveness-test");
    const replacements = vi.fn();
    const rpc = new WorkerRpcClient({
      workerId: "liveness-test",
      entryUrl: new URL("file:///unused-worker-entry.js"),
      workerData: null,
      defaultRequestTimeoutMs: 30,
      closeTimeoutMs: 30,
      onReplacement: replacements,
      workerFactory: workerFactorySequence([() => first, () => replacement]),
    });

    const pending = rpc.request("read.never", {}, z.string());
    const timedOut = expect(pending).rejects.toMatchObject({
      code: "storage.worker_timeout",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(30);
    await timedOut;
    expect(first.terminateCalls).toBe(1);
    expect(first.listenerCount("message")).toBe(0);
    expect(replacements).toHaveBeenCalledTimes(1);
    await expect(rpc.request("read.recovered", {}, z.string())).resolves.toBe("recovered");
    await rpc.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not use a replacement until the timed-out worker terminates", async () => {
    let releaseTermination: (code: number) => void = () => {};
    const termination = new Promise<number>((resolve) => {
      releaseTermination = resolve;
    });
    const first = new FakeWorker(undefined, () => termination);
    let spawnCount = 0;
    const rpc = new WorkerRpcClient({
      workerId: "liveness-test",
      entryUrl: new URL("file:///unused-worker-entry.js"),
      workerData: null,
      defaultRequestTimeoutMs: 30,
      closeTimeoutMs: 100,
      workerFactory: workerFactorySequence([
        () => {
          spawnCount += 1;
          return first;
        },
        () => {
          spawnCount += 1;
          return responsiveWorker("liveness-test");
        },
      ]),
    });

    const timedOut = rpc.request("read.never", {}, z.string());
    const rejection = expect(timedOut).rejects.toMatchObject({
      code: "storage.worker_timeout",
    });
    await vi.advanceTimersByTimeAsync(30);
    await rejection;

    const recovered = rpc.request("read.recovered", {}, z.string());
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnCount).toBe(1);

    releaseTermination(0);
    await expect(recovered).resolves.toBe("recovered");
    expect(spawnCount).toBe(2);
    await rpc.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts promptly while waiting for worker replacement", async () => {
    let releaseTermination: (code: number) => void = () => {};
    const termination = new Promise<number>((resolve) => {
      releaseTermination = resolve;
    });
    const first = new FakeWorker(undefined, () => termination);
    const replacement = responsiveWorker("liveness-test");
    const rpc = new WorkerRpcClient({
      workerId: "liveness-test",
      entryUrl: new URL("file:///unused-worker-entry.js"),
      workerData: null,
      defaultRequestTimeoutMs: 30,
      closeTimeoutMs: 100,
      workerFactory: workerFactorySequence([() => first, () => replacement]),
    });

    const firstRequest = rpc.request("read.never", {}, z.string());
    const firstRejection = expect(firstRequest).rejects.toMatchObject({
      code: "storage.worker_timeout",
    });
    await vi.advanceTimersByTimeAsync(30);
    await firstRejection;

    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = rpc.request("read.waitingForReplacement", {}, z.string(), {
      signal: controller.signal,
      timeoutMs: 500,
    });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "storage.request_aborted" });
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(replacement.posted).toEqual([]);

    releaseTermination(0);
    await vi.advanceTimersByTimeAsync(0);
    await expect(rpc.request("read.recovered", {}, z.string())).resolves.toBe("recovered");
    await rpc.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies the timeout override while waiting for worker replacement", async () => {
    let releaseTermination: (code: number) => void = () => {};
    const termination = new Promise<number>((resolve) => {
      releaseTermination = resolve;
    });
    const first = new FakeWorker(undefined, () => termination);
    const replacement = responsiveWorker("liveness-test");
    const rpc = new WorkerRpcClient({
      workerId: "liveness-test",
      entryUrl: new URL("file:///unused-worker-entry.js"),
      workerData: null,
      defaultRequestTimeoutMs: 30,
      closeTimeoutMs: 100,
      workerFactory: workerFactorySequence([() => first, () => replacement]),
    });

    const firstRequest = rpc.request("read.never", {}, z.string());
    const firstRejection = expect(firstRequest).rejects.toMatchObject({
      code: "storage.worker_timeout",
    });
    await vi.advanceTimersByTimeAsync(30);
    await firstRejection;

    const waiting = rpc.request("read.waitingForReplacement", {}, z.string(), {
      timeoutMs: 10,
    });
    const waitingRejection = expect(waiting).rejects.toMatchObject({
      code: "storage.worker_timeout",
    });
    await vi.advanceTimersByTimeAsync(10);
    await waitingRejection;
    expect(replacement.posted).toEqual([]);

    releaseTermination(0);
    await vi.advanceTimersByTimeAsync(0);
    await rpc.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not replace a worker whose termination cannot be confirmed", async () => {
    const first = new FakeWorker(undefined, () => new Promise<number>(() => {}));
    let spawnCount = 0;
    const rpc = new WorkerRpcClient({
      workerId: "liveness-test",
      entryUrl: new URL("file:///unused-worker-entry.js"),
      workerData: null,
      defaultRequestTimeoutMs: 30,
      closeTimeoutMs: 40,
      workerFactory: workerFactorySequence([
        () => {
          spawnCount += 1;
          return first;
        },
        () => {
          spawnCount += 1;
          return responsiveWorker("liveness-test");
        },
      ]),
    });

    const pending = rpc.request("write.never", {}, z.string(), { outcome: "write" });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "storage.ambiguous_outcome",
    });
    await vi.advanceTimersByTimeAsync(30);
    await rejection;
    await vi.advanceTimersByTimeAsync(40);

    expect(spawnCount).toBe(1);
    expect(first.unrefCalls).toBe(1);
    await expect(rpc.request("read.afterUnconfirmedTermination", {}, z.string())).rejects.toMatchObject({
      code: "storage.worker_failed",
      message: "Storage worker liveness-test termination could not be confirmed",
    });
    await expect(rpc.close()).rejects.toMatchObject({
      code: "storage.worker_failed",
      message: "Storage worker liveness-test termination could not be confirmed during close",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains safe error handling until termination is confirmed", async () => {
    let releaseTermination: (code: number) => void = () => {};
    const termination = new Promise<number>((resolve) => {
      releaseTermination = resolve;
    });
    const first = new FakeWorker(undefined, () => termination);
    const rpc = new WorkerRpcClient({
      workerId: "liveness-test",
      entryUrl: new URL("file:///unused-worker-entry.js"),
      workerData: null,
      defaultRequestTimeoutMs: 30,
      closeTimeoutMs: 100,
      workerFactory: workerFactorySequence([
        () => first,
        () => responsiveWorker("liveness-test"),
      ]),
    });

    const pending = rpc.request("read.never", {}, z.string());
    const rejection = expect(pending).rejects.toMatchObject({
      code: "storage.worker_timeout",
    });
    await vi.advanceTimersByTimeAsync(30);
    await rejection;

    expect(first.listenerCount("message")).toBe(0);
    expect(first.listenerCount("exit")).toBe(0);
    expect(first.listenerCount("error")).toBe(1);
    expect(() => first.emit("error", new Error("late worker failure"))).not.toThrow();

    releaseTermination(0);
    await vi.advanceTimersByTimeAsync(0);
    await expect(rpc.request("read.recovered", {}, z.string())).resolves.toBe("recovered");
    expect(first.listenerCount("error")).toBe(0);
    await rpc.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("classifies timed-out writes as ambiguous and settles every pending request once", async () => {
    const first = new FakeWorker();
    const rpc = new WorkerRpcClient({
      workerId: "liveness-test",
      entryUrl: new URL("file:///unused-worker-entry.js"),
      workerData: null,
      defaultRequestTimeoutMs: 30,
      closeTimeoutMs: 30,
      workerFactory: workerFactorySequence([
        () => first,
        () => responsiveWorker("liveness-test"),
      ]),
    });

    const write = rpc.request("write.never", {}, z.string(), { outcome: "write" });
    const read = rpc.request("read.never", {}, z.string());
    const allSettled = Promise.allSettled([write, read]);
    await vi.advanceTimersByTimeAsync(30);
    const settled = await allSettled;
    expect(settled[0]).toMatchObject({
      status: "rejected",
      reason: { code: "storage.ambiguous_outcome", retryable: false },
    });
    expect(settled[1]).toMatchObject({
      status: "rejected",
      reason: { code: "storage.worker_timeout", retryable: true },
    });
    expect(first.terminateCalls).toBe(1);
    await expect(rpc.request("read.recovered", {}, z.string())).resolves.toBe("recovered");
    await rpc.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts one waiter, removes its listener, and ignores a late response", async () => {
    let lateRequest: WorkerRequest | undefined;
    const worker = new FakeWorker((request, current) => {
      if (request.operation === "read.afterAbort") {
        current.respond(request, "liveness-test", "recovered");
      } else if (request.operation !== "worker.close") {
        lateRequest = request;
      } else {
        current.respond(request, "liveness-test", null);
      }
    });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const rpc = new WorkerRpcClient({
      workerId: "liveness-test",
      entryUrl: new URL("file:///unused-worker-entry.js"),
      workerData: null,
      defaultRequestTimeoutMs: 500,
      closeTimeoutMs: 30,
      workerFactory: () => asWorker(worker),
    });

    const pending = rpc.request("read.never", {}, z.string(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "storage.request_aborted" });
    expect(removeListener).toHaveBeenCalledTimes(1);
    if (lateRequest === undefined) throw new Error("Fake worker did not receive the request");
    worker.respond(lateRequest, "liveness-test", "too late");
    await expect(rpc.request("read.afterAbort", {}, z.string())).resolves.toBe("recovered");
    await rpc.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles pending requests when close starts", async () => {
    const worker = new FakeWorker((request, current) => {
      if (request.operation === "worker.close") current.respond(request, "liveness-test", null);
    });
    const rpc = new WorkerRpcClient({
      workerId: "liveness-test",
      entryUrl: new URL("file:///unused-worker-entry.js"),
      workerData: null,
      defaultRequestTimeoutMs: 500,
      closeTimeoutMs: 30,
      workerFactory: () => asWorker(worker),
    });
    const pending = rpc.request("write.never", {}, z.string(), { outcome: "write" });
    const rejected = pending.catch((error: unknown) => error);

    await expect(rpc.close()).resolves.toBeUndefined();
    await expect(rejected).resolves.toMatchObject({ code: "storage.ambiguous_outcome" });
    expect(worker.terminateCalls).toBe(1);
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds close and reports when worker termination cannot be confirmed", async () => {
    const worker = new FakeWorker(undefined, () => new Promise<number>(() => {}));
    const rpc = new WorkerRpcClient({
      workerId: "liveness-test",
      entryUrl: new URL("file:///unused-worker-entry.js"),
      workerData: null,
      defaultRequestTimeoutMs: 500,
      closeTimeoutMs: 30,
      workerFactory: () => asWorker(worker),
    });

    const closing = rpc.close();
    const closeRejection = expect(closing).rejects.toMatchObject({
      code: "storage.worker_failed",
      message: "Storage worker liveness-test termination could not be confirmed during close",
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(worker.terminateCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(30);
    await closeRejection;
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("exit")).toBe(0);
    expect(worker.listenerCount("error")).toBe(1);
    expect(worker.unrefCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates malformed responders and ignores unknown and duplicate response IDs", async () => {
    const malformed = new FakeWorker((_request, worker) => {
      worker.emit("message", { invalid: true });
    });
    const replacement = new FakeWorker((request, worker) => {
      const result = request.operation === "worker.close" ? null : "ok";
      worker.emit("message", {
        v: 1,
        requestId: "rpc_unknown",
        workerId: "liveness-test",
        ok: true,
        result,
      });
      worker.respond(request, "liveness-test", result);
      worker.respond(request, "liveness-test", result);
    });
    const rpc = new WorkerRpcClient({
      workerId: "liveness-test",
      entryUrl: new URL("file:///unused-worker-entry.js"),
      workerData: null,
      workerFactory: workerFactorySequence([() => malformed, () => replacement]),
    });

    await expect(rpc.request("read.malformed", {}, z.string())).rejects.toMatchObject({
      code: "storage.worker_failed",
    });
    expect(malformed.terminateCalls).toBe(1);
    await expect(rpc.request("read.once", {}, z.string())).resolves.toBe("ok");
    await rpc.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("WorkerRpcClient shutdown", () => {
  it("rejects requests as soon as close begins", async () => {
    const worker = new FakeWorker((request, current) => {
      if (request.operation === "worker.close") current.respond(request, "liveness-test", null);
    });
    const rpc = new WorkerRpcClient({
      workerId: "liveness-test",
      entryUrl: new URL("file:///unused-worker-entry.js"),
      workerData: null,
      workerFactory: () => asWorker(worker),
    });

    const closing = rpc.close();
    await expect(rpc.request("test.afterClose", {})).rejects.toMatchObject({
      code: "storage.worker_failed",
      message: "Storage worker is closing",
    });
    await expect(closing).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("SQLite error classification", () => {
  it.each([
    ["SQLITE_FULL", "storage.disk_full", false],
    ["ENOSPC", "storage.disk_full", false],
    ["SQLITE_BUSY", "storage.busy", true],
    ["SQLITE_LOCKED", "storage.busy", true],
    ["SQLITE_CORRUPT", "storage.corrupt", false],
    ["SQLITE_NOTADB", "storage.corrupt", false],
  ] as const)("classifies %s without losing its fault domain", (code, expectedCode, retryable) => {
    const error = Object.assign(new Error(`injected ${code}`), { code });
    expect(toStorageError(error, "storage.migration_failed")).toMatchObject({
      code: expectedCode,
      retryable,
    });
  });

  it("uses the operation fallback for an unclassified migration error", () => {
    expect(
      toStorageError(new Error("unsupported schema version"), "storage.migration_failed"),
    ).toMatchObject({ code: "storage.migration_failed", retryable: false });
  });

  it("preserves an existing typed storage error", () => {
    const original = new StorageError("storage.disk_full", "already classified");
    expect(toStorageError(original, "storage.migration_failed")).toBe(original);
  });
});
