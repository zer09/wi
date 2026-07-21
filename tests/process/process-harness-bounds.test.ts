import { fileURLToPath } from "node:url";

import {
  PROCESS_IPC_HISTORY_MAX_MESSAGES,
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
