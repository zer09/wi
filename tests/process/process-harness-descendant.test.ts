import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RealServerProcess } from "@wi/test-support";

import { FixtureProcessRunner, FixtureProcessTimeoutError } from "./fixture-process.js";

const fixturePath = fileURLToPath(
  new URL("./process-harness-descendant-fixture.mjs", import.meta.url),
);
const posixOwnerDeathFixturePath = fileURLToPath(
  new URL("./process-harness-posix-owner-death-fixture.mjs", import.meta.url),
);
const setupSentinelFixturePath = fileURLToPath(
  new URL("./process-harness-setup-sentinel-fixture.mjs", import.meta.url),
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

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

interface PosixReleaseTestState {
  readonly watchdogPid: number;
  readonly fixturePid: number | null;
  readonly releaseAttempts: number;
  readonly event: string;
}

async function readReleaseTestState(path: string): Promise<PosixReleaseTestState> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as PosixReleaseTestState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("POSIX release test state was not recorded");
}

async function withPosixReleaseTest(
  mode: "ignore-first" | "error-first" | "disconnect-first" | "delay-first",
  run: (statePath: string) => Promise<void>,
): Promise<void> {
  const statePath = join(tmpdir(), `wi-posix-release-${randomUUID()}.json`);
  const previousMode = process.env.WI_TEST_SUPPORT_POSIX_RELEASE_TEST_MODE;
  const previousStatePath = process.env.WI_TEST_SUPPORT_POSIX_RELEASE_TEST_STATE_PATH;
  process.env.WI_TEST_SUPPORT_POSIX_RELEASE_TEST_MODE = mode;
  process.env.WI_TEST_SUPPORT_POSIX_RELEASE_TEST_STATE_PATH = statePath;
  try {
    await run(statePath);
  } finally {
    if (previousMode === undefined) {
      delete process.env.WI_TEST_SUPPORT_POSIX_RELEASE_TEST_MODE;
    } else {
      process.env.WI_TEST_SUPPORT_POSIX_RELEASE_TEST_MODE = previousMode;
    }
    if (previousStatePath === undefined) {
      delete process.env.WI_TEST_SUPPORT_POSIX_RELEASE_TEST_STATE_PATH;
    } else {
      process.env.WI_TEST_SUPPORT_POSIX_RELEASE_TEST_STATE_PATH = previousStatePath;
    }
    await rm(statePath, { force: true });
  }
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

  it(
    "retries POSIX watchdog release after the first request times out",
    async () => {
      await withPosixReleaseTest("ignore-first", async (statePath) => {
        const processHandle = await RealServerProcess.start({
          fixturePath,
          arguments: ["leader-live"],
          waitForReady: false,
        });
        const ready = await processHandle.waitForMessage("ready");
        if (typeof ready.descendantPid !== "number") throw new Error("Missing descendant PID");
        try {
          await expect(processHandle.terminate()).rejects.toThrow("cleanup failed");
          const failed = await readReleaseTestState(statePath);
          expect(failed).toMatchObject({ releaseAttempts: 1, event: "ignored-release" });
          expect(processExists(failed.watchdogPid)).toBe(true);
          if (failed.fixturePid === null) throw new Error("Missing fixture PID");
          expect(processGroupExists(failed.fixturePid)).toBe(false);

          await expect(processHandle.terminate()).resolves.toBeUndefined();
          const recovered = await readReleaseTestState(statePath);
          expect(recovered.releaseAttempts).toBe(2);
          await expectProcessGone(recovered.watchdogPid);
          await expectProcessGone(ready.descendantPid);
        } finally {
          await processHandle.terminate().catch(() => undefined);
        }
      });
    },
    10_000,
  );

  it.each(["error-first", "disconnect-first"] as const)(
    "retries POSIX watchdog release after %s failure",
    async (mode) => {
      await withPosixReleaseTest(mode, async (statePath) => {
        const processHandle = await RealServerProcess.start({
          fixturePath,
          arguments: ["leader-live"],
          waitForReady: false,
        });
        await processHandle.waitForMessage("ready");
        try {
          await expect(processHandle.terminate()).rejects.toThrow("cleanup failed");
          const failed = await readReleaseTestState(statePath);
          expect(failed.releaseAttempts).toBe(1);
          expect(processExists(failed.watchdogPid)).toBe(true);

          await expect(processHandle.terminate()).resolves.toBeUndefined();
          await expectProcessGone(failed.watchdogPid);
          if (failed.fixturePid === null) throw new Error("Missing fixture PID");
          expect(processGroupExists(failed.fixturePid)).toBe(false);
        } finally {
          await processHandle.terminate().catch(() => undefined);
        }
      });
    },
    10_000,
  );

  it(
    "shares one active POSIX watchdog release across concurrent cleanup calls",
    async () => {
      await withPosixReleaseTest("delay-first", async (statePath) => {
        const processHandle = await RealServerProcess.start({
          fixturePath,
          arguments: ["leader-live"],
          waitForReady: false,
        });
        await processHandle.waitForMessage("ready");
        try {
          await Promise.all([processHandle.terminate(), processHandle.terminate()]);
          const released = await readReleaseTestState(statePath);
          expect(released.releaseAttempts).toBe(1);
          await expectProcessGone(released.watchdogPid);
          if (released.fixturePid === null) throw new Error("Missing fixture PID");
          expect(processGroupExists(released.fixturePid)).toBe(false);
        } finally {
          await processHandle.terminate().catch(() => undefined);
        }
      });
    },
    10_000,
  );

  it(
    "FixtureProcessRunner terminateAll retries a failed watchdog cleanup",
    async () => {
      await withPosixReleaseTest("ignore-first", async (statePath) => {
        const runner = new FixtureProcessRunner(150, 50);
        try {
          await expect(
            runner.run(process.execPath, [fixturePath, "leader-live"], 150),
          ).rejects.toThrow("cleanup failed");
          expect(runner.activeCount).toBe(1);
          const failed = await readReleaseTestState(statePath);
          expect(failed).toMatchObject({ releaseAttempts: 1, event: "ignored-release" });
          expect(processExists(failed.watchdogPid)).toBe(true);

          await expect(runner.terminateAll()).resolves.toBeUndefined();
          expect(runner.activeCount).toBe(0);
          const recovered = await readReleaseTestState(statePath);
          expect(recovered.releaseAttempts).toBe(2);
          await expectProcessGone(recovered.watchdogPid);
          if (recovered.fixturePid === null) throw new Error("Missing fixture PID");
          expect(processGroupExists(recovered.fixturePid)).toBe(false);
        } finally {
          await runner.terminateAll().catch(() => undefined);
        }
      });
    },
    10_000,
  );

  it(
    "kills nested fixture descendants when the harness owner dies",
    async () => {
      const owner = await RealServerProcess.start({
        fixturePath: posixOwnerDeathFixturePath,
        waitForReady: false,
      });
      let leaderPid: number | null = null;
      let descendantPid: number | null = null;
      try {
        const ready = await owner.waitForMessage("ready");
        if (typeof ready.leaderPid !== "number" || typeof ready.descendantPid !== "number") {
          throw new Error("POSIX owner-death fixture did not report its nested process tree");
        }
        leaderPid = ready.leaderPid;
        descendantPid = ready.descendantPid;
        expect(processExists(leaderPid)).toBe(true);
        expect(processExists(descendantPid)).toBe(true);
        await expect(owner.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });

        // Do not invoke fallback cleanup before these checks. Owner-pipe EOF
        // alone must reclaim the nested fixture group.
        await expectProcessGone(leaderPid);
        await expectProcessGone(descendantPid);
      } finally {
        await owner.terminate().catch(() => undefined);
        if (
          leaderPid !== null &&
          (processExists(leaderPid) || (descendantPid !== null && processExists(descendantPid)))
        ) {
          try {
            process.kill(-leaderPid, "SIGKILL");
          } catch {
            // The assertions below report any process that fallback did not reap.
          }
        }
        if (leaderPid !== null) await expectProcessGone(leaderPid);
        if (descendantPid !== null) await expectProcessGone(descendantPid);
      }
    },
    10_000,
  );

  it(
    "fails closed before fixture code when process ownership setup cannot complete",
    async () => {
      const sentinelPath = join(tmpdir(), `wi-posix-owner-${randomUUID()}`);
      try {
        await expect(
          RealServerProcess.start({
            fixturePath: setupSentinelFixturePath,
            arguments: [sentinelPath],
            environment: {
              NODE_OPTIONS: "--import=/wi-test-support-owner-setup-does-not-exist.mjs",
            },
            waitForReady: false,
          }),
        ).rejects.toThrow(/ownership|Fixture exited/);
        await expect(stat(sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(sentinelPath, { force: true });
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
