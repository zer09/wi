import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FakeProviderAdapter } from "@wi/provider-fake";
import {
  canonicalJsonHash,
  type SessionEvent,
  type ToolEffectClass,
} from "@wi/protocol";
import { SessionStoreManager, type SessionClient, type ToolExecutionRecord } from "@wi/storage";
import {
  ToolExecutor,
  ToolRegistry,
  createBuiltinToolRegistry,
  createEchoTool,
} from "@wi/tools";
import {
  AgentRunLoop,
  CommittedEventHub,
  RunScheduler,
  SessionActor,
  type AgentRunLoopIds,
  type SessionActorIds,
} from "../../packages/harness-core/src/index.js";

const homes: string[] = [];
const managers: SessionStoreManager[] = [];
const actors: SessionActor[] = [];
let fixtureNumber = 100;

function next(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}${++value}`;
}

function generatedIds(prefix: string): { actor: SessionActorIds; loop: AgentRunLoopIds } {
  return {
    actor: {
      runId: next(`run_${prefix}`),
      eventId: next(`evt_${prefix}Actor`),
      messageId: next(`msg_${prefix}Actor`),
      partId: next(`part_${prefix}Actor`),
      diagnosticId: next(`err_${prefix}Actor`),
    },
    loop: {
      eventId: next(`evt_${prefix}Loop`),
      stepId: next(`step_${prefix}`),
      messageId: next(`msg_${prefix}Loop`),
      partId: next(`part_${prefix}Loop`),
      approvalId: next(`approval_${prefix}`),
      diagnosticId: next(`err_${prefix}Loop`),
    },
  };
}

async function storageFixture(): Promise<{ manager: SessionStoreManager; session: SessionClient }> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-m4-recovery-"));
  homes.push(homeDirectory);
  const number = ++fixtureNumber;
  const manager = new SessionStoreManager({
    homeDirectory,
    ids: {
      sessionId: () => `ses_recovery${number}`,
      eventId: () => `evt_recoverySession${number}`,
    },
    now: () => 1_000,
    sessionWorkers: { size: 2, allowTestOperations: true },
  });
  managers.push(manager);
  const created = await manager.createSession({
    v: 1,
    kind: "command",
    commandId: `cmd_recoveryCreate${number}`,
    method: "session.create",
    params: {},
  });
  return { manager, session: await manager.openSession(created.session.sessionId) };
}

async function seedRecoverableTool(
  session: SessionClient,
  state: "requested" | "started" | "completed",
  effectClass: ToolEffectClass = "pure",
): Promise<ToolExecutionRecord> {
  const runId = `run_recover${state}`;
  const stepId = `step_recover${state}`;
  const callId = `call_recover${state}`;
  const argumentsJson = '{"text":"recover"}';
  const argumentsHash = await canonicalJsonHash({ text: "recover" });
  await session.appendTransaction({
    events: [
      {
        eventId: `evt_recover${state}RunCreated`,
        eventType: "run.created",
        createdAtMs: 2_000,
        data: { eventVersion: 1, runId },
      },
      {
        eventId: `evt_recover${state}RunStarted`,
        eventType: "run.started",
        createdAtMs: 2_001,
        data: { eventVersion: 1, runId },
      },
      {
        eventId: `evt_recover${state}StepCompleted`,
        eventType: "provider.step.completed",
        createdAtMs: 2_002,
        data: { eventVersion: 1, runId, stepId },
      },
      {
        eventId: `evt_recover${state}ToolRequested`,
        eventType: "tool.call.requested",
        createdAtMs: 2_003,
        data: {
          eventVersion: 1,
          runId,
          stepId,
          callId,
          name: "echo",
          argumentsJson,
          argumentsHash,
          effectClass,
        },
      },
      ...(state === "started"
        ? [
            {
              eventId: `evt_recover${state}ToolStarted`,
              eventType: "tool.execution.started" as const,
              createdAtMs: 2_004,
              data: { eventVersion: 1 as const, runId, callId },
            },
          ]
        : []),
      ...(state === "completed"
        ? [
            {
              eventId: `evt_recover${state}ToolCompleted`,
              eventType: "tool.execution.completed" as const,
              createdAtMs: 2_004,
              data: { eventVersion: 1 as const, runId, callId, result: { text: "recover" } },
            },
          ]
        : []),
    ],
    projections: [
      {
        kind: "run.put",
        runId,
        state: "running",
        providerId: "fake",
        providerConfig: { scenario: "echo-tool-round-trip" },
        createdAtMs: 2_000,
        startedAtMs: 2_001,
        completedAtMs: null,
        cancelledAtMs: null,
        failureCategory: null,
        failureMessage: null,
        activeProviderStepId: null,
      },
      {
        kind: "providerStep.put",
        stepId,
        runId,
        stepIndex: 0,
        state: "completed",
        startedAtMs: 2_001,
        completedAtMs: 2_002,
        responseId: `response_recover${state}`,
        errorCategory: null,
        errorMessage: null,
      },
      {
        kind: "toolExecution.put",
        callId,
        runId,
        stepId,
        toolName: "echo",
        argumentsJson,
        argumentsHash,
        effectClass,
        state,
        attemptCount: state === "requested" ? 0 : 1,
        requestedAtMs: 2_003,
        startedAtMs: state === "started" || state === "completed" ? 2_004 : null,
        completedAtMs: state === "completed" ? 2_004 : null,
        result: state === "completed" ? { text: "recover" } : null,
        error: null,
      },
      {
        kind: "toolCallOccurrence.put",
        runId,
        stepId,
        callId,
        occurredAtMs: 2_003,
      },
    ],
  });
  const tool = await session.getToolExecution(callId);
  if (tool === null) throw new Error("Seeded tool disappeared");
  return tool;
}

function echoRegistry(effectClass: ToolEffectClass): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({ ...createEchoTool(), effectClass });
  return registry;
}

async function resumeSeeded(
  session: SessionClient,
  seeded: ToolExecutionRecord,
  options: {
    readonly registry?: ToolRegistry;
    readonly expectedRunState?: "completed" | "failed" | "interrupted";
  } = {},
): Promise<{ actor: SessionActor; executions: string[] }> {
  const ids = generatedIds(seeded.state);
  const executions: string[] = [];
  const loop = new AgentRunLoop({
    storage: session,
    provider: new FakeProviderAdapter(),
    registry: options.registry ?? createBuiltinToolRegistry(),
    executor: new ToolExecutor({ onExecutionStart: ({ callId }) => executions.push(callId) }),
    ids: ids.loop,
  });
  let signalTerminal = (): void => {};
  const terminal = new Promise<void>((resolve) => {
    signalTerminal = resolve;
  });
  const hub = new CommittedEventHub();
  hub.subscribe(session.sessionId, (event: SessionEvent) => {
    if (
      "runId" in event.data &&
      event.data.runId === seeded.runId &&
      (event.eventType === "run.completed" ||
        event.eventType === "run.failed" ||
        event.eventType === "run.cancelled" ||
        event.eventType === "run.interrupted")
    ) {
      signalTerminal();
    }
  });
  let now = 3_000;
  const actor = await SessionActor.create({
    storage: session,
    eventHub: hub,
    scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
    ids: ids.actor,
    now: () => ++now,
    runTask: loop.task,
    currentToolEffectClass: loop.currentToolEffectClass,
    cancelRunTask: loop.cancel,
    forceStopRunTask: () => ({ status: "terminated" }),
    createRunProviderSnapshot: () => ({
      providerId: "fake",
      providerConfig: { scenario: "echo-tool-round-trip" },
    }),
    runTaskOwnsSchedulerPermits: true,
    resumeRestoredRuns: true,
  });
  actors.push(actor);
  await terminal;
  await expect(session.getRun(seeded.runId)).resolves.toMatchObject({
    state: options.expectedRunState ?? "completed",
  });
  return { actor, executions };
}

afterEach(async () => {
  await Promise.allSettled(actors.splice(0).map((actor) => actor.shutdown()));
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("Milestone 4 ledger recovery and atomicity", () => {
  it("reloads a requested pure tool and executes its existing row", async () => {
    const { session } = await storageFixture();
    const seeded = await seedRecoverableTool(session, "requested");
    const resumed = await resumeSeeded(session, seeded);

    expect(resumed.executions).toEqual([seeded.callId]);
    await expect(session.getToolExecution(seeded.callId)).resolves.toMatchObject({
      state: "completed",
      attemptCount: 1,
    });
  });

  it("reconciles a started pure tool to requested and increments the same row on retry", async () => {
    const { session } = await storageFixture();
    const seeded = await seedRecoverableTool(session, "started");
    const resumed = await resumeSeeded(session, seeded);

    expect(resumed.executions).toEqual([seeded.callId]);
    await expect(session.getToolExecution(seeded.callId)).resolves.toMatchObject({
      state: "completed",
      attemptCount: 2,
    });
    const events = await session.getEventsAfter(0);
    expect(events.filter((event) => event.eventType === "tool.execution.recovered")).toHaveLength(1);
  });

  it("reuses a committed tool result without a second execution", async () => {
    const { session } = await storageFixture();
    const seeded = await seedRecoverableTool(session, "completed");
    const resumed = await resumeSeeded(session, seeded);

    expect(resumed.executions).toEqual([]);
    await expect(session.getToolExecution(seeded.callId)).resolves.toMatchObject({
      state: "completed",
      attemptCount: 1,
      result: { text: "recover" },
    });
  });

  it("rejects a requested call when its current effect class changed", async () => {
    const { session } = await storageFixture();
    const seeded = await seedRecoverableTool(session, "requested", "pure");
    const resumed = await resumeSeeded(session, seeded, {
      registry: echoRegistry("non_idempotent"),
      expectedRunState: "failed",
    });

    expect(resumed.executions).toEqual([]);
    await expect(session.getToolExecution(seeded.callId)).resolves.toMatchObject({
      state: "cancelled",
      attemptCount: 0,
      effectClass: "pure",
    });
    await expect(session.getRun(seeded.runId)).resolves.toMatchObject({
      state: "failed",
      failureCategory: "provider.protocol_error",
    });
  });

  it("does not recover a started call when its current effect class changed", async () => {
    const { session } = await storageFixture();
    const seeded = await seedRecoverableTool(session, "started", "pure");
    const resumed = await resumeSeeded(session, seeded, {
      registry: echoRegistry("non_idempotent"),
      expectedRunState: "interrupted",
    });

    expect(resumed.executions).toEqual([]);
    await expect(session.getToolExecution(seeded.callId)).resolves.toMatchObject({
      state: "started",
      attemptCount: 1,
      effectClass: "pure",
    });
    await expect(session.getRun(seeded.runId)).resolves.toMatchObject({
      state: "interrupted",
      failureCategory: "provider.protocol_error",
    });
  });

  it("rejects the inverse started effect-class mismatch without retry", async () => {
    const { session } = await storageFixture();
    const seeded = await seedRecoverableTool(session, "started", "non_idempotent");
    const resumed = await resumeSeeded(session, seeded, {
      registry: echoRegistry("pure"),
      expectedRunState: "interrupted",
    });

    expect(resumed.executions).toEqual([]);
    await expect(session.getToolExecution(seeded.callId)).resolves.toMatchObject({
      state: "started",
      attemptCount: 1,
      effectClass: "non_idempotent",
    });
  });

  it("fails a durable call safely when its current definition is missing", async () => {
    const { session } = await storageFixture();
    const seeded = await seedRecoverableTool(session, "requested", "pure");
    const resumed = await resumeSeeded(session, seeded, {
      registry: new ToolRegistry(),
      expectedRunState: "failed",
    });

    expect(resumed.executions).toEqual([]);
    await expect(session.getToolExecution(seeded.callId)).resolves.toMatchObject({
      state: "cancelled",
      attemptCount: 0,
      effectClass: "pure",
    });
  });

  it("rejects changed canonical arguments even when the original hash is forged", async () => {
    const { session } = await storageFixture();
    const tool = await seedRecoverableTool(session, "completed");
    const head = await session.getHeadSequence();

    await expect(
      session.appendTransaction({
        events: [
          {
            eventId: "evt_forgedEqualHash",
            eventType: "provider.tool_call.reused",
            createdAtMs: 2_050,
            data: {
              eventVersion: 1,
              runId: tool.runId,
              stepId: tool.stepId,
              callId: tool.callId,
              originalStepId: tool.stepId,
            },
          },
        ],
        projections: [
          {
            kind: "toolExecution.put",
            callId: tool.callId,
            expectedState: "completed",
            runId: tool.runId,
            stepId: tool.stepId,
            toolName: tool.toolName,
            argumentsJson: '{"text":"changed but forged"}',
            argumentsHash: tool.argumentsHash,
            effectClass: tool.effectClass,
            state: tool.state,
            attemptCount: tool.attemptCount,
            requestedAtMs: tool.requestedAtMs,
            startedAtMs: tool.startedAtMs,
            completedAtMs: tool.completedAtMs,
            result: tool.result,
            error: tool.error,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "provider.protocol_error" });
    await expect(session.getHeadSequence()).resolves.toBe(head);
    await expect(session.getToolExecution(tool.callId)).resolves.toMatchObject({
      argumentsJson: tool.argumentsJson,
      argumentsHash: tool.argumentsHash,
      state: "completed",
    });
  });

  it("rejects provider-step and tool terminal regression through durable CAS", async () => {
    const { session } = await storageFixture();
    const tool = await seedRecoverableTool(session, "completed");
    const [step] = await session.getProviderStepsForRun(tool.runId);
    if (step === undefined) throw new Error("Seeded provider step disappeared");
    const head = await session.getHeadSequence();

    await expect(
      session.appendTransaction({
        events: [
          {
            eventId: "evt_providerTerminalRegression",
            eventType: "provider.step.failed",
            createdAtMs: 2_100,
            data: {
              eventVersion: 1,
              runId: step.runId,
              stepId: step.stepId,
              code: "provider.protocol_error",
              message: "late failure",
              diagnosticId: "err_providerTerminalRegression",
            },
          },
        ],
        projections: [
          {
            kind: "providerStep.put",
            stepId: step.stepId,
            expectedState: "completed",
            runId: step.runId,
            stepIndex: step.stepIndex,
            state: "failed",
            startedAtMs: step.startedAtMs,
            completedAtMs: 2_100,
            responseId: step.responseId,
            errorCategory: "provider.protocol_error",
            errorMessage: "late failure",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "session.invalid_transition" });

    await expect(
      session.appendTransaction({
        events: [
          {
            eventId: "evt_toolTerminalRegression",
            eventType: "tool.call.requested",
            createdAtMs: 2_101,
            data: {
              eventVersion: 1,
              runId: tool.runId,
              stepId: tool.stepId,
              callId: tool.callId,
              name: tool.toolName,
              argumentsJson: tool.argumentsJson,
              argumentsHash: tool.argumentsHash,
              effectClass: "pure",
            },
          },
        ],
        projections: [
          {
            kind: "toolExecution.put",
            callId: tool.callId,
            expectedState: "completed",
            runId: tool.runId,
            stepId: tool.stepId,
            toolName: tool.toolName,
            argumentsJson: tool.argumentsJson,
            argumentsHash: tool.argumentsHash,
            effectClass: "pure",
            state: "requested",
            attemptCount: tool.attemptCount,
            requestedAtMs: tool.requestedAtMs,
            startedAtMs: tool.startedAtMs,
            completedAtMs: tool.completedAtMs,
            result: tool.result,
            error: tool.error,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "session.invalid_transition" });

    await expect(session.getHeadSequence()).resolves.toBe(head);
    await expect(session.getProviderStep(step.stepId)).resolves.toMatchObject({ state: "completed" });
    await expect(session.getToolExecution(tool.callId)).resolves.toMatchObject({ state: "completed" });
  });

  it("rolls back every promotion when one staged-call CAS fails", async () => {
    const { session } = await storageFixture();
    const runId = "run_atomicPromotion";
    const stepId = "step_atomicPromotion";
    const firstHash = await canonicalJsonHash({ text: "first" });
    const secondHash = await canonicalJsonHash({ text: "second" });
    await session.appendTransaction({
      events: [
        {
          eventId: "evt_atomicRun",
          eventType: "run.started",
          createdAtMs: 2_000,
          data: { eventVersion: 1, runId },
        },
      ],
      projections: [
        {
          kind: "run.put",
          runId,
          state: "running",
          providerId: "fake",
          providerConfig: { scenario: "echo-tool-round-trip" },
          createdAtMs: 2_000,
          startedAtMs: 2_000,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: stepId,
        },
        {
          kind: "providerStep.put",
          stepId,
          runId,
          stepIndex: 0,
          state: "streaming",
          startedAtMs: 2_000,
          completedAtMs: null,
          responseId: null,
          errorCategory: null,
          errorMessage: null,
        },
        ...[
          ["call_atomicFirst", '{"text":"first"}', firstHash],
          ["call_atomicSecond", '{"text":"second"}', secondHash],
        ].map(([callId, argumentsJson, argumentsHash]) => ({
          kind: "toolExecution.put" as const,
          callId: callId ?? "",
          runId,
          stepId,
          toolName: "echo",
          argumentsJson: argumentsJson ?? "",
          argumentsHash: argumentsHash ?? "",
          effectClass: null,
          state: "staged" as const,
          attemptCount: 0,
          requestedAtMs: 2_001,
          startedAtMs: null,
          completedAtMs: null,
          result: null,
          error: null,
        })),
      ],
    });
    const head = await session.getHeadSequence();

    await expect(
      session.appendTransaction({
        events: [
          {
            eventId: "evt_atomicProviderCompleted",
            eventType: "provider.step.completed",
            createdAtMs: 2_010,
            data: { eventVersion: 1, runId, stepId },
          },
        ],
        projections: [
          {
            kind: "providerStep.put",
            stepId,
            expectedState: "streaming",
            runId,
            stepIndex: 0,
            state: "completed",
            startedAtMs: 2_000,
            completedAtMs: 2_010,
            responseId: "response_atomic",
            errorCategory: null,
            errorMessage: null,
          },
          {
            kind: "toolExecution.put",
            callId: "call_atomicFirst",
            expectedState: "staged",
            runId,
            stepId,
            toolName: "echo",
            argumentsJson: '{"text":"first"}',
            argumentsHash: firstHash,
            effectClass: "pure",
            state: "requested",
            attemptCount: 0,
            requestedAtMs: 2_001,
            startedAtMs: null,
            completedAtMs: null,
            result: null,
            error: null,
          },
          {
            kind: "toolExecution.put",
            callId: "call_atomicSecond",
            expectedState: "requested",
            runId,
            stepId,
            toolName: "echo",
            argumentsJson: '{"text":"second"}',
            argumentsHash: secondHash,
            effectClass: "pure",
            state: "requested",
            attemptCount: 0,
            requestedAtMs: 2_001,
            startedAtMs: null,
            completedAtMs: null,
            result: null,
            error: null,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "session.invalid_transition" });

    await expect(session.getHeadSequence()).resolves.toBe(head);
    await expect(session.getProviderStep(stepId)).resolves.toMatchObject({ state: "streaming" });
    await expect(session.getToolExecution("call_atomicFirst")).resolves.toMatchObject({
      state: "staged",
      effectClass: null,
    });
    await expect(session.getToolExecution("call_atomicSecond")).resolves.toMatchObject({
      state: "staged",
      effectClass: null,
    });
  });
});
