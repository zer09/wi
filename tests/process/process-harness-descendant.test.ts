import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RealServerProcess } from "@wi/test-support";

import { FixtureProcessRunner, FixtureProcessTimeoutError } from "./fixture-process.js";

const fixturePath = fileURLToPath(
  new URL("./process-harness-descendant-fixture.mjs", import.meta.url),
);
const ownerDeathFixturePath = fileURLToPath(
  new URL("./process-harness-owner-death-fixture.mjs", import.meta.url),
);

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

describe("real process-tree cleanup", () => {
  it.each(["leader-live", "leader-exits"] as const)(
    "terminates descendants when the %s case is cleaned up",
    async (mode) => {
      const processHandle = await RealServerProcess.start({
        fixturePath,
        arguments: [mode],
        waitForReady: false,
      });
      let descendantPid: number | null = null;
      try {
        const ready = await processHandle.waitForMessage("ready");
        if (typeof ready.descendantPid !== "number") {
          throw new Error("Descendant fixture did not report its child PID");
        }
        descendantPid = ready.descendantPid;
        expect(processExists(descendantPid)).toBe(true);
        if (mode === "leader-exits") {
          await expect(processHandle.waitForExit()).resolves.toMatchObject({ code: 0 });
        }
        await processHandle.terminate();
        await expectProcessGone(descendantPid);
      } finally {
        await processHandle.terminate().catch(() => undefined);
        if (descendantPid !== null) await expectProcessGone(descendantPid);
      }
    },
    10_000,
  );

  it.skipIf(process.platform !== "win32")(
    "kills nested fixture descendants when the harness owner dies",
    async () => {
      const owner = await RealServerProcess.start({
        fixturePath: ownerDeathFixturePath,
        waitForReady: false,
      });
      let leaderPid: number | null = null;
      let descendantPid: number | null = null;
      try {
        const ready = await owner.waitForMessage("ready");
        if (typeof ready.leaderPid !== "number" || typeof ready.descendantPid !== "number") {
          throw new Error("Owner-death fixture did not report its nested process tree");
        }
        leaderPid = ready.leaderPid;
        descendantPid = ready.descendantPid;
        expect(processExists(leaderPid)).toBe(true);
        expect(processExists(descendantPid)).toBe(true);
        await expect(owner.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });

        // Do not call terminate() before these checks: only closing the dead owner's
        // nested Job Object handle is allowed to reclaim this process tree.
        await expectProcessGone(leaderPid);
        await expectProcessGone(descendantPid);
      } finally {
        await owner.terminate().catch(() => undefined);
        if (leaderPid !== null) await expectProcessGone(leaderPid);
        if (descendantPid !== null) await expectProcessGone(descendantPid);
      }
    },
    10_000,
  );

  it.each(["leader-live", "leader-exits"] as const)(
    "FixtureProcessRunner releases descendants after the %s leader settles",
    async (mode) => {
      const runner = new FixtureProcessRunner(mode === "leader-live" ? 200 : 2_000, 50);
      let descendantPid: number | null = null;
      try {
        let stdout: string;
        if (mode === "leader-live") {
          try {
            await runner.run(
              process.execPath,
              [fixturePath, mode],
              200,
              undefined,
              {
                startTimeoutAfterStdout: '"type":"ready"',
                readinessTimeoutMs: 5_000,
              },
            );
            throw new Error("Live descendant fixture unexpectedly exited before its deadline");
          } catch (error) {
            if (!(error instanceof FixtureProcessTimeoutError)) throw error;
            stdout = error.result.stdout;
          }
        } else {
          const result = await runner.run(process.execPath, [fixturePath, mode]);
          expect(result.code).toBe(0);
          stdout = result.stdout;
        }
        const ready = JSON.parse(stdout.trim()) as { readonly descendantPid?: unknown };
        if (typeof ready.descendantPid !== "number") {
          throw new Error("Descendant fixture did not print its child PID");
        }
        descendantPid = ready.descendantPid;
        await expectProcessGone(descendantPid);
        expect(runner.activeCount).toBe(0);
      } finally {
        await runner.terminateAll().catch(() => undefined);
        if (descendantPid !== null && processExists(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
          await expectProcessGone(descendantPid);
        }
      }
    },
    10_000,
  );
});
