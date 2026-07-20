import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { SessionStoreManager } from "@wi/storage";

import { FixtureProcessRunner, FixtureProcessTimeoutError } from "./fixture-process.js";

const fixture = fileURLToPath(new URL("./milestone4-run-loop-fixture.mjs", import.meta.url));
const homes: string[] = [];
const fixtureProcesses = new FixtureProcessRunner();

function runFixture(
  options: {
    readonly homeDirectory: string;
    readonly sessionId: string;
    readonly mode: "crash" | "restart1" | "restart2" | "hang";
    readonly window: string;
    readonly executionLog: string;
    readonly providerLog: string;
  },
  timeoutMs?: number,
) {
  return fixtureProcesses.run(
    process.execPath,
    [
      fixture,
      options.homeDirectory,
      options.sessionId,
      options.mode,
      options.window,
      options.executionLog,
      options.providerLog,
    ],
    timeoutMs,
  );
}

afterEach(async () => {
  await fixtureProcesses.terminateAll();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const scenarios = [
  {
    window: "staged",
    crashCode: 100,
    expected: {
      runState: "interrupted",
      toolState: "discarded",
      effectClass: null,
      attemptCount: 0,
      providerRequests: 1,
      executions: 0,
      terminalEvents: 1,
      stagedEvents: 1,
      startedEvents: 0,
      completedToolEvents: 0,
      outcomeUnknownEvents: 0,
      completedAssistantEvents: 0,
    },
  },
  {
    window: "promoted",
    crashCode: 101,
    expected: {
      runState: "completed",
      toolState: "completed",
      effectClass: "pure",
      attemptCount: 1,
      providerRequests: 2,
      executions: 1,
      terminalEvents: 1,
      stagedEvents: 1,
      startedEvents: 1,
      completedToolEvents: 1,
      outcomeUnknownEvents: 0,
      completedAssistantEvents: 1,
    },
  },
  {
    window: "pure-started",
    crashCode: 102,
    expected: {
      runState: "completed",
      toolState: "completed",
      effectClass: "pure",
      attemptCount: 2,
      providerRequests: 2,
      executions: 1,
      terminalEvents: 1,
      stagedEvents: 1,
      startedEvents: 2,
      completedToolEvents: 1,
      outcomeUnknownEvents: 0,
      completedAssistantEvents: 1,
    },
  },
  {
    window: "unsafe-started",
    crashCode: 103,
    expected: {
      runState: "interrupted",
      toolState: "outcome_unknown",
      effectClass: "non_idempotent",
      attemptCount: 1,
      providerRequests: 1,
      executions: 0,
      terminalEvents: 1,
      stagedEvents: 1,
      startedEvents: 1,
      completedToolEvents: 0,
      outcomeUnknownEvents: 1,
      completedAssistantEvents: 0,
    },
  },
  {
    window: "result",
    crashCode: 104,
    expected: {
      runState: "completed",
      toolState: "completed",
      effectClass: "pure",
      attemptCount: 1,
      providerRequests: 2,
      executions: 1,
      terminalEvents: 1,
      stagedEvents: 1,
      startedEvents: 1,
      completedToolEvents: 1,
      outcomeUnknownEvents: 0,
      completedAssistantEvents: 1,
    },
  },
  {
    window: "live-outcome-unknown",
    crashCode: 105,
    expected: {
      runState: "interrupted",
      runFailureCategory: "tool.outcome_unknown",
      toolState: "outcome_unknown",
      effectClass: "non_idempotent",
      attemptCount: 1,
      providerRequests: 1,
      executions: 1,
      terminalEvents: 1,
      stagedEvents: 1,
      startedEvents: 1,
      completedToolEvents: 0,
      outcomeUnknownEvents: 1,
      interruptedRunEvents: 1,
      completedAssistantEvents: 0,
    },
  },
] as const;

describe("Milestone 4 real process run-loop recovery", () => {
  it.each(scenarios)(
    "recovers the $window crash window idempotently",
    async ({ window, crashCode, expected }) => {
      const homeDirectory = await mkdtemp(join(tmpdir(), `wi-m4-process-${window}-`));
      homes.push(homeDirectory);
      const executionLog = join(homeDirectory, "execution.log");
      const providerLog = join(homeDirectory, "provider.log");
      const manager = new SessionStoreManager({
        homeDirectory,
        now: () => 1_000,
        ids: {
          sessionId: () => `ses_process${window.replaceAll("-", "")}`,
          eventId: () => `evt_processSession${window.replaceAll("-", "")}`,
        },
        sessionWorkers: { size: 1 },
      });
      const created = await manager.createSession({
        v: 1,
        kind: "command",
        commandId: `cmd_processCreate${window.replaceAll("-", "")}`,
        method: "session.create",
        params: {},
      });
      await manager.close();
      const common = {
        homeDirectory,
        sessionId: created.session.sessionId,
        window,
        executionLog,
        providerLog,
      };

      const crashed = await runFixture({ ...common, mode: "crash" });
      expect(crashed).toMatchObject({ code: crashCode, signal: null, stdout: "" });
      expect(crashed.stderr).not.toContain("Error");

      const firstRestart = await runFixture({ ...common, mode: "restart1" });
      expect(firstRestart).toMatchObject({ code: 0, signal: null });
      const first = JSON.parse(firstRestart.stdout) as Record<string, unknown>;
      expect(first).toMatchObject({
        ...expected,
        activeProviderStepId: null,
        scheduler: {
          provider: { active: 0, queued: 0, available: 1 },
          tool: { active: 0, queued: 0, available: 1 },
        },
      });

      const secondRestart = await runFixture({ ...common, mode: "restart2" });
      expect(secondRestart).toMatchObject({ code: 0, signal: null });
      const second = JSON.parse(secondRestart.stdout) as Record<string, unknown>;
      expect(second).toEqual(first);
    },
    20_000,
  );

  it("terminates and reaps a fixture that ignores its process deadline", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-m4-process-hang-"));
    homes.push(homeDirectory);
    const common = {
      homeDirectory,
      sessionId: "ses_processHang",
      mode: "hang" as const,
      window: "staged",
      executionLog: join(homeDirectory, "execution.log"),
      providerLog: join(homeDirectory, "provider.log"),
    };

    let timeoutError: FixtureProcessTimeoutError | null = null;
    try {
      await runFixture(common, 2_000);
    } catch (error) {
      if (error instanceof FixtureProcessTimeoutError) timeoutError = error;
      else throw error;
    }

    expect(timeoutError).not.toBeNull();
    expect(timeoutError?.result.stdout).toBe("hang-ready\n");
    if (process.platform === "win32") {
      expect(timeoutError?.result).toMatchObject({ code: 1, signal: null });
    } else {
      expect(timeoutError?.result).toMatchObject({ code: null, signal: "SIGKILL" });
    }
    expect(fixtureProcesses.activeCount).toBe(0);
    const pid = timeoutError?.result.pid;
    if (pid === null || pid === undefined) throw new Error("Hanging fixture did not report its PID");
    expect(() => process.kill(pid, 0)).toThrow();
  }, 5_000);
});
