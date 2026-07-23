import { fileURLToPath } from "node:url";

import {
  PROCESS_IPC_DIAGNOSTIC_PREVIEW_MAX_CODE_UNITS,
  PROCESS_IPC_HISTORY_MAX_ESTIMATED_BYTES,
  PROCESS_IPC_HISTORY_MAX_MESSAGES,
  PROCESS_IPC_MESSAGE_MAX_ESTIMATED_BYTES,
  PROCESS_IPC_PENDING_MAX_ESTIMATED_BYTES,
  PROCESS_IPC_PENDING_MAX_MESSAGES,
  PROCESS_OUTPUT_TAIL_MAX_BYTES,
  PROCESS_READINESS_MARKER_MAX_BYTES,
  RealServerProcess,
} from "@wi/test-support";
import { describe, expect, it } from "vitest";

import { FixtureProcessRunner, FixtureProcessTimeoutError } from "./fixture-process.js";

const fixturePath = fileURLToPath(
  new URL("./process-harness-bounds-fixture.mjs", import.meta.url),
);
const outputBytes = PROCESS_OUTPUT_TAIL_MAX_BYTES * 4;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && processExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(processExists(pid)).toBe(false);
}

describe("bounded process-harness diagnostics", () => {
  it("rejects an oversized readiness marker before spawning a child", async () => {
    const runner = new FixtureProcessRunner();
    await expect(
      runner.run(process.execPath, [fixturePath, "fixture-runner", "1"], 100, undefined, {
        startTimeoutAfterStdout: "x".repeat(PROCESS_READINESS_MARKER_MAX_BYTES + 1),
      }),
    ).rejects.toThrow(/readiness marker exceeds/u);
    expect(runner.activeCount).toBe(0);
  });

  it("bounds FixtureProcessRunner streams while matching split readiness and reaping the tree", async () => {
    const runner = new FixtureProcessRunner(100, 50);
    let descendantPid: number | null = null;
    try {
      await runner.run(
        process.execPath,
        [fixturePath, "fixture-runner", String(outputBytes)],
        100,
        undefined,
        {
          startTimeoutAfterStdout: "READY-MARKER",
          readinessTimeoutMs: 5_000,
        },
      );
      throw new Error("Flood fixture unexpectedly exited before its deadline");
    } catch (error) {
      if (!(error instanceof FixtureProcessTimeoutError)) throw error;
      const { result } = error;
      const descendantMatch = /descendant=(\d+)/u.exec(result.stdout);
      if (descendantMatch?.[1] === undefined) {
        throw new Error(`Bounded stdout tail omitted descendant PID: ${result.stdout}`);
      }
      descendantPid = Number.parseInt(descendantMatch[1], 10);
      expect(result.stdoutDiagnostics.tail).toBe(result.stdout);
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(
        PROCESS_OUTPUT_TAIL_MAX_BYTES,
      );
      expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
        PROCESS_OUTPUT_TAIL_MAX_BYTES,
      );
      expect(result.stdoutDiagnostics.totalBytes).toBe(
        outputBytes +
          Buffer.byteLength(
            `READY-MARKER\nstdout-tail descendant=${String(descendantPid)}\n`,
          ),
      );
      expect(result.stderrDiagnostics.totalBytes).toBe(
        outputBytes + Buffer.byteLength("stderr-tail retained diagnostic\n"),
      );
      expect(result.stdoutDiagnostics.truncated).toBe(true);
      expect(result.stderrDiagnostics.truncated).toBe(true);
      expect(result.stdoutDiagnostics.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.stderrDiagnostics.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.stdout).toContain("stdout-tail");
      expect(result.stderr).toContain("stderr-tail retained diagnostic");
      expect(error.message).toContain("stderr-tail retained diagnostic");
      expect(error.message).toContain("truncated after");
    } finally {
      await runner.terminateAll();
    }
    expect(runner.activeCount).toBe(0);
    if (descendantPid === null) throw new Error("Missing descendant PID");
    await expectProcessGone(descendantPid);
  });

  it("bounds oversized, aggregate, deep, and node-heavy IPC while preserving awaited control", async () => {
    const processHandle = await RealServerProcess.start({
      fixturePath,
      arguments: ["ipc-payloads", String(outputBytes), "64"],
      waitForReady: false,
    });
    let descendantPid: number | null = null;
    try {
      const ready = await processHandle.waitForMessage("control-ready", 10_000);
      expect(ready.value).toBe("small");
      if (typeof ready.descendantPid !== "number") {
        throw new Error("IPC bounds fixture omitted its descendant PID");
      }
      descendantPid = ready.descendantPid;

      const diagnostics = processHandle.diagnostics;
      const ipc = diagnostics.ipc;
      expect(ipc.totalMessages).toBe(104);
      expect(ipc.pendingRetainedEstimatedBytes).toBeLessThanOrEqual(
        PROCESS_IPC_PENDING_MAX_ESTIMATED_BYTES,
      );
      expect(ipc.historyRetainedEstimatedBytes).toBeLessThanOrEqual(
        PROCESS_IPC_HISTORY_MAX_ESTIMATED_BYTES,
      );
      expect(ipc.rejectedMessages).toBe(8);
      expect(ipc.oversizedMessages).toBe(6);
      expect(ipc.pendingTruncated).toBe(true);
      expect(ipc.historyTruncated).toBe(true);
      expect(ipc.latestTruncation).toMatchObject({
        originalType: null,
        reason: "protocol",
        hashComplete: true,
      });
      expect(ipc.latestTruncation?.preview.length).toBeLessThanOrEqual(
        PROCESS_IPC_DIAGNOSTIC_PREVIEW_MAX_CODE_UNITS,
      );
      expect(ipc.latestTruncation?.sha256).toMatch(/^[a-f0-9]{64}$/u);

      const retainedMessages = processHandle.receivedMessages;
      const retainedHistory = JSON.stringify(retainedMessages);
      expect(Buffer.byteLength(retainedHistory)).toBeLessThanOrEqual(
        ipc.historyRetainedEstimatedBytes,
      );
      expect(retainedHistory).not.toContain("OVERSIZED-TERMINAL-MARKER");
      const truncationMessages = retainedMessages.filter(
        (message) => message.type === "wi.test-support.ipc-truncated",
      );
      const truncationReasons = truncationMessages.flatMap((message) =>
        typeof message.reason === "string" ? [message.reason] : [],
      );
      expect(truncationReasons).toEqual(
        expect.arrayContaining(["depth", "nodes", "string", "protocol"]),
      );
      expect(truncationMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ originalType: "deep-noise", reason: "depth" }),
          expect.objectContaining({ originalType: "node-heavy-noise", reason: "nodes" }),
          expect.objectContaining({ originalType: "key-heavy-noise", reason: "nodes" }),
          expect.objectContaining({ originalType: "nested-string-noise", reason: "string" }),
          expect.objectContaining({
            originalType: "oversized-noise",
            reason: "string",
            hashComplete: true,
          }),
          expect.objectContaining({
            originalType: "encoded-byte-noise",
            reason: "estimated_bytes",
            hashComplete: true,
          }),
        ]),
      );

      let timeoutError: unknown;
      try {
        await processHandle.waitForMessage("never-sent", 50);
      } catch (error) {
        timeoutError = error;
      }
      expect(timeoutError).toBeInstanceOf(Error);
      const timeoutMessage = timeoutError instanceof Error ? timeoutError.message : "";
      expect(timeoutMessage).toContain("ipc=");
      expect(Buffer.byteLength(timeoutMessage)).toBeLessThanOrEqual(
        PROCESS_OUTPUT_TAIL_MAX_BYTES + 4 * 1024,
      );
    } finally {
      await processHandle.terminate();
    }
    if (descendantPid === null) throw new Error("Missing descendant PID");
    await expectProcessGone(descendantPid);
  });

  it("isolates real-child waiter, history, and diagnostics from retained IPC state", async () => {
    const processHandle = await RealServerProcess.start({
      fixturePath,
      arguments: ["ipc-alias", "0", "0"],
      waitForReady: false,
    });
    let descendantPid: number | null = null;
    try {
      const ready = await processHandle.waitForMessage("alias-ready", 10_000);
      if (typeof ready.descendantPid !== "number") {
        throw new Error("IPC alias fixture omitted its descendant PID");
      }
      descendantPid = ready.descendantPid;
      const diagnosticsDeadline = Date.now() + 10_000;
      while (
        processHandle.diagnostics.ipc.latestTruncation === null &&
        Date.now() < diagnosticsDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const before = processHandle.diagnostics.ipc;
      expect(before.latestTruncation).not.toBeNull();
      const expectedTruncation = { ...before.latestTruncation };

      const readyNested = ready.nested as {
        value: string;
        values: Array<string | { value: string }>;
      };
      readyNested.value = "x".repeat(2 * 1024 * 1024);
      (readyNested.values[1] as { value: string }).value = "changed through waiter";

      const firstHistory = processHandle.receivedMessages;
      expect(firstHistory).toEqual([
        expect.objectContaining({
          type: "alias-ready",
          nested: { value: "small", values: ["first", { value: "second" }] },
        }),
        expect.objectContaining({
          type: "wi.test-support.ipc-truncated",
          originalType: "alias-too-large",
          reason: "string",
        }),
      ]);
      const firstNested = firstHistory[0]?.nested as {
        value: string;
        values: Array<string | { value: string }>;
      };
      firstNested.value = "changed through history";
      firstNested.values[0] = "changed through history array";

      const firstDiagnostics = processHandle.diagnostics;
      const mutableTruncation = firstDiagnostics.ipc
        .latestTruncation as unknown as Record<string, unknown>;
      mutableTruncation.preview = "changed externally";
      mutableTruncation.reason = "protocol";
      mutableTruncation.observedEstimatedBytes = Number.MAX_SAFE_INTEGER;

      const secondHistory = processHandle.receivedMessages;
      const secondDiagnostics = processHandle.diagnostics;
      expect(secondHistory[0]).toMatchObject({
        type: "alias-ready",
        nested: { value: "small", values: ["first", { value: "second" }] },
      });
      expect(secondDiagnostics.ipc.latestTruncation).toEqual(expectedTruncation);
      expect(secondDiagnostics.ipc).toEqual(before);
      expect(Buffer.byteLength(JSON.stringify(secondHistory))).toBeLessThanOrEqual(
        secondDiagnostics.ipc.historyRetainedEstimatedBytes,
      );
    } finally {
      await processHandle.terminate();
    }
    if (descendantPid === null) throw new Error("Missing descendant PID");
    await expectProcessGone(descendantPid);
  });

  it("rejects oversized outbound controls before sending them to the child", async () => {
    const processHandle = await RealServerProcess.start({
      fixturePath,
      arguments: ["ipc-controls", "0", "0"],
      waitForReady: false,
    });
    let descendantPid: number | null = null;
    try {
      const ready = await processHandle.waitForMessage("control-fixture-ready", 10_000);
      if (typeof ready.descendantPid !== "number") {
        throw new Error("IPC control fixture omitted its descendant PID");
      }
      descendantPid = ready.descendantPid;

      processHandle.send("shutdown");
      await processHandle.waitForMessage("string-control-received");
      processHandle.send({ type: "small-control", value: "small" });
      await processHandle.waitForMessage("object-control-received");

      expect(() =>
        processHandle.send({ type: "oversized-control", value: "x".repeat(outputBytes) }),
      ).toThrow(/string limit/u);
      let deep: Record<string, unknown> = { value: "leaf" };
      for (let depth = 0; depth < 80; depth += 1) deep = { child: deep };
      expect(() => processHandle.send({ type: "deep-control", deep })).toThrow(/depth limit/u);
      expect(() =>
        processHandle.send({
          type: "node-heavy-control",
          values: Array.from({ length: 5_000 }, (_, index) => index),
        }),
      ).toThrow(/nodes limit/u);
      const cyclic: Record<string, unknown> = { type: "cyclic-control" };
      cyclic.self = cyclic;
      expect(() => processHandle.send(cyclic as never)).toThrow(/depth limit/u);
      expect(() =>
        processHandle.send({ type: "non-json-control", value: new Date(0) } as never),
      ).toThrow(/protocol limit/u);
      for (const value of [NaN, Infinity, -Infinity]) {
        expect(() => processHandle.send({ type: "non-finite-control", value })).toThrow(
          /protocol limit/u,
        );
      }

      let getterReads = 0;
      const statefulGetter = {
        type: "stateful-getter-control",
        get value() {
          getterReads += 1;
          return getterReads === 1 ? "small" : "x".repeat(outputBytes);
        },
      };
      expect(() => processHandle.send(statefulGetter as never)).toThrow(/protocol limit/u);
      expect(getterReads).toBe(0);

      let proxyReads = 0;
      const statefulProxy = new Proxy(
        { type: "stateful-proxy-control", value: "small" },
        {
          get(target, property, receiver) {
            if (property !== "value") return Reflect.get(target, property, receiver);
            proxyReads += 1;
            return proxyReads === 1 ? "small" : "x".repeat(outputBytes);
          },
        },
      );
      processHandle.send(statefulProxy);
      const dynamicControl = await processHandle.waitForMessage("dynamic-control-received");
      expect(dynamicControl).toMatchObject({ bytes: expect.any(Number), value: "small" });
      if (typeof dynamicControl.bytes !== "number") {
        throw new Error("Dynamic control response omitted its encoded byte count");
      }
      expect(dynamicControl.bytes).toBeLessThanOrEqual(PROCESS_IPC_MESSAGE_MAX_ESTIMATED_BYTES);
      expect(proxyReads).toBe(0);

      const originalArrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
      let arrayLengthReads = 0;
      let arrayIndexReads = 0;
      let arrayIndexDescriptorReads = 0;
      const statefulArray = new Proxy([1, 2], {
        get(target, property, receiver) {
          if (property === "length") arrayLengthReads += 1;
          if (property === "0" || property === "1") arrayIndexReads += 1;
          return Reflect.get(target, property, receiver);
        },
        getOwnPropertyDescriptor(target, property) {
          if (property === "0") {
            arrayIndexDescriptorReads += 1;
            Object.defineProperty(Array.prototype, "toJSON", {
              value: () => "x".repeat(outputBytes),
              configurable: true,
            });
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      });
      try {
        processHandle.send({ type: "stateful-array-control", value: statefulArray });
      } finally {
        if (originalArrayToJson === undefined) {
          Reflect.deleteProperty(Array.prototype, "toJSON");
        } else {
          Object.defineProperty(Array.prototype, "toJSON", originalArrayToJson);
        }
      }
      const arrayControl = await processHandle.waitForMessage("array-control-received");
      expect(arrayControl).toMatchObject({ bytes: expect.any(Number), value: [1, 2] });
      if (typeof arrayControl.bytes !== "number") {
        throw new Error("Array control response omitted its encoded byte count");
      }
      expect(arrayControl.bytes).toBeLessThanOrEqual(PROCESS_IPC_MESSAGE_MAX_ESTIMATED_BYTES);
      expect(arrayLengthReads).toBe(0);
      expect(arrayIndexReads).toBe(0);
      expect(arrayIndexDescriptorReads).toBe(1);

      const throwingProxy = new Proxy(
        { type: "throwing-proxy-control", value: "small" },
        {
          getOwnPropertyDescriptor() {
            throw new Error("descriptor trap failed");
          },
        },
      );
      expect(() => processHandle.send(throwingProxy)).toThrow(/descriptor trap failed/u);

      processHandle.send({ type: "report-control-count" });
      await expect(processHandle.waitForMessage("control-count")).resolves.toMatchObject({
        receivedControls: 4,
      });
    } finally {
      await processHandle.terminate();
    }
    if (descendantPid === null) throw new Error("Missing descendant PID");
    await expectProcessGone(descendantPid);
  });

  it("bounds RealServerProcess streams and both IPC retention paths without killing on output", async () => {
    const messageCount = Math.max(
      PROCESS_IPC_PENDING_MAX_MESSAGES,
      PROCESS_IPC_HISTORY_MAX_MESSAGES,
    ) + 64;
    const processHandle = await RealServerProcess.start({
      fixturePath,
      arguments: ["real-server", String(outputBytes), String(messageCount)],
      waitForReady: false,
    });
    let descendantPid: number | null = null;
    try {
      const ready = await processHandle.waitForMessage("ready", 10_000);
      if (typeof ready.descendantPid !== "number") {
        throw new Error("Flood fixture omitted its descendant PID");
      }
      descendantPid = ready.descendantPid;
      expect(processHandle.child.exitCode).toBeNull();
      await expect(processHandle.waitForExit(100)).rejects.toThrow(
        /stderr-tail retained diagnostic.*truncated after/su,
      );

      const diagnostics = processHandle.diagnostics;
      expect(Buffer.byteLength(diagnostics.stdout.tail)).toBeLessThanOrEqual(
        PROCESS_OUTPUT_TAIL_MAX_BYTES,
      );
      expect(Buffer.byteLength(diagnostics.stderr.tail)).toBeLessThanOrEqual(
        PROCESS_OUTPUT_TAIL_MAX_BYTES,
      );
      expect(diagnostics.stdout.totalBytes).toBe(
        outputBytes + Buffer.byteLength("stdout-tail retained diagnostic\n"),
      );
      expect(diagnostics.stderr.totalBytes).toBe(
        outputBytes + Buffer.byteLength("stderr-tail retained diagnostic\n"),
      );
      expect(diagnostics.stdout.truncated).toBe(true);
      expect(diagnostics.stderr.truncated).toBe(true);
      expect(diagnostics.ipc.totalMessages).toBe(messageCount + 1);
      expect(diagnostics.ipc.pendingRetainedMessages).toBeLessThanOrEqual(
        PROCESS_IPC_PENDING_MAX_MESSAGES,
      );
      expect(diagnostics.ipc.historyRetainedMessages).toBeLessThanOrEqual(
        PROCESS_IPC_HISTORY_MAX_MESSAGES,
      );
      expect(diagnostics.ipc.pendingTruncated).toBe(true);
      expect(diagnostics.ipc.historyTruncated).toBe(true);
      expect(processHandle.receivedMessages).toHaveLength(
        diagnostics.ipc.historyRetainedMessages,
      );
    } finally {
      await processHandle.terminate();
    }
    if (descendantPid === null) throw new Error("Missing descendant PID");
    await expectProcessGone(descendantPid);
  });
});
