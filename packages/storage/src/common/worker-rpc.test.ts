import { Worker } from "node:worker_threads";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import { StorageError, toStorageError, WorkerRpcClient } from "./worker-rpc.js";

const responsiveWorkerSource = `
  const { parentPort } = require("node:worker_threads");
  parentPort.on("message", (request) => {
    parentPort.postMessage({
      v: 1,
      requestId: request.requestId,
      workerId: "replacement-test",
      ok: true,
      result: request.operation === "worker.close" ? null : "recovered",
    });
  });
`;

const shutdownWorkerSource = `
  const { parentPort, workerData } = require("node:worker_threads");
  const counter = new Int32Array(workerData.counter);
  parentPort.on("message", (request) => {
    if (request.operation !== "worker.close") Atomics.add(counter, 0, 1);
    const respond = () => parentPort.postMessage({
      v: 1,
      requestId: request.requestId,
      workerId: "shutdown-test",
      ok: true,
      result: request.operation === "worker.close" ? null : "unexpected",
    });
    if (request.operation === "worker.close") setTimeout(respond, 20);
    else respond();
  });
`;

describe("WorkerRpcClient replacement failures", () => {
  it("retries replacement creation on a later request", async () => {
    let spawnAttempts = 0;
    const rpc = new WorkerRpcClient({
      workerId: "replacement-test",
      entryUrl: new URL("file:///unused-worker-entry.js"),
      workerData: null,
      workerFactory: () => {
        spawnAttempts += 1;
        if (spawnAttempts === 1) return new Worker("process.exit(91)", { eval: true });
        if (spawnAttempts === 2) throw new Error("injected replacement spawn failure");
        return new Worker(responsiveWorkerSource, { eval: true });
      },
    });

    await expect(rpc.request("test.request", {})).rejects.toMatchObject({
      code: "storage.worker_failed",
      retryable: true,
    });
    expect(spawnAttempts).toBe(2);
    await expect(rpc.request("test.request", {}, z.string())).resolves.toBe("recovered");
    expect(spawnAttempts).toBe(3);
    await expect(rpc.close()).resolves.toBeUndefined();
  });
});

describe("WorkerRpcClient shutdown", () => {
  it("rejects requests as soon as close begins", async () => {
    const counterBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const counter = new Int32Array(counterBuffer);
    const rpc = new WorkerRpcClient({
      workerId: "shutdown-test",
      entryUrl: new URL("file:///unused-worker-entry.js"),
      workerData: { counter: counterBuffer },
      workerFactory: (_entryUrl, options) =>
        new Worker(shutdownWorkerSource, { ...options, eval: true }),
    });

    const closing = rpc.close();
    await expect(rpc.request("test.afterClose", {})).rejects.toMatchObject({
      code: "storage.worker_failed",
      message: "Storage worker is closing",
    });
    await expect(closing).resolves.toBeUndefined();
    expect(Atomics.load(counter, 0)).toBe(0);
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
