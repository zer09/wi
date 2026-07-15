import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonHash } from "@wi/protocol";
import { SessionStoreManager, type SessionClient } from "@wi/storage";

const fixture = fileURLToPath(
  new URL("./milestone4-unsafe-recovery-fixture.mjs", import.meta.url),
);
const homes: string[] = [];
const managers: SessionStoreManager[] = [];

interface ChildResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runFixture(
  homeDirectory: string,
  sessionId: string,
  mode: "recover-crash" | "inspect",
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, homeDirectory, sessionId, mode], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function seedUnsafeStarted(session: SessionClient): Promise<void> {
  const argumentsJson = '{"text":"process unsafe"}';
  const argumentsHash = await canonicalJsonHash({ text: "process unsafe" });
  await session.appendTransaction({
    events: [
      {
        eventId: "evt_processUnsafeRun",
        eventType: "run.started",
        createdAtMs: 2_000,
        data: { eventVersion: 1, runId: "run_processUnsafe" },
      },
      {
        eventId: "evt_processUnsafeStep",
        eventType: "provider.step.completed",
        createdAtMs: 2_001,
        data: {
          eventVersion: 1,
          runId: "run_processUnsafe",
          stepId: "step_processUnsafe",
        },
      },
      {
        eventId: "evt_processUnsafeRequested",
        eventType: "tool.call.requested",
        createdAtMs: 2_002,
        data: {
          eventVersion: 1,
          runId: "run_processUnsafe",
          stepId: "step_processUnsafe",
          callId: "call_processUnsafe",
          name: "unsafe_process",
          argumentsJson,
          argumentsHash,
          effectClass: "non_idempotent",
        },
      },
      {
        eventId: "evt_processUnsafeStarted",
        eventType: "tool.execution.started",
        createdAtMs: 2_003,
        data: {
          eventVersion: 1,
          runId: "run_processUnsafe",
          callId: "call_processUnsafe",
        },
      },
    ],
    projections: [
      {
        kind: "run.put",
        runId: "run_processUnsafe",
        state: "running",
        providerId: "fake",
        providerConfig: { scenario: "echo-tool-round-trip" },
        createdAtMs: 2_000,
        startedAtMs: 2_000,
        completedAtMs: null,
        cancelledAtMs: null,
        failureCategory: null,
        failureMessage: null,
        activeProviderStepId: null,
      },
      {
        kind: "providerStep.put",
        stepId: "step_processUnsafe",
        runId: "run_processUnsafe",
        stepIndex: 0,
        state: "completed",
        startedAtMs: 2_000,
        completedAtMs: 2_001,
        responseId: "response_processUnsafe",
        errorCategory: null,
        errorMessage: null,
      },
      {
        kind: "toolExecution.put",
        callId: "call_processUnsafe",
        runId: "run_processUnsafe",
        stepId: "step_processUnsafe",
        toolName: "unsafe_process",
        argumentsJson,
        argumentsHash,
        effectClass: "non_idempotent",
        state: "started",
        attemptCount: 1,
        requestedAtMs: 2_002,
        startedAtMs: 2_003,
        completedAtMs: null,
        result: null,
        error: null,
      },
      {
        kind: "toolCallOccurrence.put",
        runId: "run_processUnsafe",
        stepId: "step_processUnsafe",
        callId: "call_processUnsafe",
        occurredAtMs: 2_002,
      },
    ],
  });
}

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("Milestone 4 unsafe recovery process window", () => {
  it("survives process death after the atomic unsafe recovery decision", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-m4-unsafe-process-"));
    homes.push(homeDirectory);
    const manager = new SessionStoreManager({
      homeDirectory,
      now: () => 1_000,
      ids: {
        sessionId: () => "ses_processUnsafe",
        eventId: () => "evt_processUnsafeSession",
      },
      sessionWorkers: { size: 1 },
    });
    managers.push(manager);
    const created = await manager.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_processUnsafeCreate",
      method: "session.create",
      params: {},
    });
    const session = await manager.openSession(created.session.sessionId);
    await seedUnsafeStarted(session);
    await manager.close();
    managers.splice(managers.indexOf(manager), 1);

    const crashed = await runFixture(homeDirectory, session.sessionId, "recover-crash");
    expect(crashed).toMatchObject({ code: 91, stdout: "" });
    expect(crashed.stderr).not.toContain("Error");

    const firstRestart = await runFixture(homeDirectory, session.sessionId, "inspect");
    expect(firstRestart.code, firstRestart.stderr).toBe(0);
    const first = JSON.parse(firstRestart.stdout) as Record<string, unknown>;
    expect(first).toMatchObject({
      runState: "interrupted",
      toolState: "outcome_unknown",
      effectClass: "non_idempotent",
      attemptCount: 1,
      providerRequests: 0,
      executions: 0,
      outcomeUnknownEvents: 1,
      interruptedEvents: 1,
    });

    const secondRestart = await runFixture(homeDirectory, session.sessionId, "inspect");
    expect(secondRestart.code, secondRestart.stderr).toBe(0);
    const second = JSON.parse(secondRestart.stdout) as Record<string, unknown>;
    expect(second).toEqual(first);
  });
});
