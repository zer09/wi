import { fileURLToPath } from "node:url";

import {
  PROCESS_IPC_DIAGNOSTIC_PREVIEW_MAX_CODE_UNITS,
  PROCESS_IPC_HISTORY_MAX_ESTIMATED_BYTES,
  PROCESS_IPC_HISTORY_MAX_MESSAGES,
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

      processHandle.send({ type: "report-control-count" });
      await expect(processHandle.waitForMessage("control-count")).resolves.toMatchObject({
        receivedControls: 2,
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
