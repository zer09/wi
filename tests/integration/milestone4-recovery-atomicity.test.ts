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
import {
  SessionStoreManager,
  type AppendTransactionInput,
  type ProjectionMutation,
  type SessionClient,
  type ToolExecutionRecord,
} from "@wi/storage";
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
  recoverSession,
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

interface StartedToolSpec {
  readonly name: string;
  readonly effectClass: ToolEffectClass;
}

async function seedStartedToolSet(
  session: SessionClient,
  specs: readonly StartedToolSpec[],
): Promise<{ readonly runId: string; readonly callIds: readonly string[] }> {
  const runId = `run_recoverSet${fixtureNumber}`;
  const stepId = `step_recoverSet${fixtureNumber}`;
  const callIds = specs.map((_spec, index) => `call_recoverSet${fixtureNumber}_${index}`);
  const argumentsJson = '{"text":"recover set"}';
  const argumentsHash = await canonicalJsonHash({ text: "recover set" });
  await session.appendTransaction({
    events: [
      {
        eventId: `evt_recoverSet${fixtureNumber}Run`,
        eventType: "run.started",
        createdAtMs: 2_000,
        data: { eventVersion: 1, runId },
      },
      {
        eventId: `evt_recoverSet${fixtureNumber}Step`,
        eventType: "provider.step.completed",
        createdAtMs: 2_001,
        data: { eventVersion: 1, runId, stepId },
      },
      ...specs.flatMap((spec, index) => {
        const callId = callIds[index];
        if (callId === undefined) throw new Error("Missing generated call ID");
        return [
          {
            eventId: `evt_recoverSet${fixtureNumber}Requested${index}`,
            eventType: "tool.call.requested" as const,
            createdAtMs: 2_002 + index * 2,
            data: {
              eventVersion: 1 as const,
              runId,
              stepId,
              callId,
              name: spec.name,
              argumentsJson,
              argumentsHash,
              effectClass: spec.effectClass,
            },
          },
          {
            eventId: `evt_recoverSet${fixtureNumber}Started${index}`,
            eventType: "tool.execution.started" as const,
            createdAtMs: 2_003 + index * 2,
            data: { eventVersion: 1 as const, runId, callId },
          },
        ];
      }),
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
        activeProviderStepId: null,
      },
      {
        kind: "providerStep.put",
        stepId,
        runId,
        stepIndex: 0,
        state: "completed",
        startedAtMs: 2_000,
        completedAtMs: 2_001,
        responseId: `response_recoverSet${fixtureNumber}`,
        errorCategory: null,
        errorMessage: null,
      },
      ...specs.flatMap((spec, index) => {
        const callId = callIds[index];
        if (callId === undefined) throw new Error("Missing generated call ID");
        return [
          {
            kind: "toolExecution.put" as const,
            callId,
            runId,
            stepId,
            toolName: spec.name,
            argumentsJson,
            argumentsHash,
            effectClass: spec.effectClass,
            state: "started" as const,
            attemptCount: 1,
            requestedAtMs: 2_002 + index * 2,
            startedAtMs: 2_003 + index * 2,
            completedAtMs: null,
            result: null,
            error: null,
          },
          {
            kind: "toolCallOccurrence.put" as const,
            runId,
            stepId,
            callId,
            occurredAtMs: 2_002 + index * 2,
          },
        ];
      }),
    ],
  });
  return { runId, callIds };
}

type ExistingToolOutcome = "completed" | "failed" | "denied" | "cancelled" | "outcome_unknown";

function terminalToolErrorCode(
  outcome: ExistingToolOutcome,
): "provider.cancelled" | "tool.approval_denied" | "tool.execution_failed" | "tool.outcome_unknown" {
  if (outcome === "outcome_unknown") return "tool.outcome_unknown";
  if (outcome === "denied") return "tool.approval_denied";
  if (outcome === "cancelled") return "provider.cancelled";
  return "tool.execution_failed";
}

async function seedTerminalToolSet(
  session: SessionClient,
  outcomes: readonly ExistingToolOutcome[],
  runState: "running" | "interrupted" = "running",
): Promise<{ readonly runId: string; readonly callIds: readonly string[] }> {
  const suffix = `${fixtureNumber}_${outcomes.join("_")}_${runState}`;
  const runId = `run_terminalSet${suffix}`;
  const stepId = `step_terminalSet${suffix}`;
  const callIds = outcomes.map((_outcome, index) => `call_terminalSet${suffix}_${index}`);
  const argumentsJson = '{"text":"existing terminal"}';
  const argumentsHash = await canonicalJsonHash({ text: "existing terminal" });
  const toolEvents: AppendTransactionInput["events"] = [];
  for (const [index, outcome] of outcomes.entries()) {
    const callId = callIds[index];
    if (callId === undefined) throw new Error("Missing terminal tool call ID");
    const effectClass = outcome === "outcome_unknown" ? "non_idempotent" : "pure";
    const requestedAtMs = 2_010 + index * 3;
    const terminalAtMs = requestedAtMs + 2;
    toolEvents.push({
      eventId: `evt_terminalSet${suffix}Requested${index}`,
      eventType: "tool.call.requested",
      createdAtMs: requestedAtMs,
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
    });
    if (outcome !== "denied") {
      toolEvents.push({
        eventId: `evt_terminalSet${suffix}Started${index}`,
        eventType: "tool.execution.started",
        createdAtMs: requestedAtMs + 1,
        data: { eventVersion: 1, runId, callId },
      });
    }
    if (outcome === "completed") {
      toolEvents.push({
        eventId: `evt_terminalSet${suffix}Completed${index}`,
        eventType: "tool.execution.completed",
        createdAtMs: terminalAtMs,
        data: { eventVersion: 1, runId, callId, result: { text: "existing terminal" } },
      });
    } else if (outcome === "outcome_unknown") {
      toolEvents.push({
        eventId: `evt_terminalSet${suffix}Unknown${index}`,
        eventType: "tool.execution.outcome_unknown",
        createdAtMs: terminalAtMs,
        data: {
          eventVersion: 1,
          runId,
          callId,
          code: "tool.outcome_unknown",
          message: "The existing non-idempotent outcome is unknown.",
          diagnosticId: `err_terminalSet${suffix}Unknown${index}`,
        },
      });
    } else {
      const code = terminalToolErrorCode(outcome);
      toolEvents.push({
        eventId: `evt_terminalSet${suffix}Failed${index}`,
        eventType: "tool.execution.failed",
        createdAtMs: terminalAtMs,
        data: {
          eventVersion: 1,
          runId,
          callId,
          code,
          message: `Existing tool ended ${outcome}.`,
          diagnosticId: `err_terminalSet${suffix}Failed${index}`,
        },
      });
    }
  }
  const runEvent =
    runState === "running"
      ? {
          eventId: `evt_terminalSet${suffix}RunStarted`,
          eventType: "run.started" as const,
          createdAtMs: 2_000,
          data: { eventVersion: 1 as const, runId },
        }
      : {
          eventId: `evt_terminalSet${suffix}RunInterrupted`,
          eventType: "run.interrupted" as const,
          createdAtMs: 2_000,
          data: {
            eventVersion: 1 as const,
            runId,
            code: "tool.outcome_unknown" as const,
            message: "Run was already interrupted.",
            diagnosticId: `err_terminalSet${suffix}RunInterrupted`,
          },
        };
  const toolProjections: ProjectionMutation[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    const callId = callIds[index];
    if (callId === undefined) throw new Error("Missing terminal tool call ID");
    const effectClass: ToolEffectClass =
      outcome === "outcome_unknown" ? "non_idempotent" : "pure";
    const requestedAtMs = 2_010 + index * 3;
    const code = terminalToolErrorCode(outcome);
    toolProjections.push(
      {
        kind: "toolExecution.put",
        callId,
        runId,
        stepId,
        toolName: "echo",
        argumentsJson,
        argumentsHash,
        effectClass,
        state: outcome,
        attemptCount: outcome === "denied" ? 0 : 1,
        requestedAtMs,
        startedAtMs: outcome === "denied" ? null : requestedAtMs + 1,
        completedAtMs: requestedAtMs + 2,
        result: outcome === "completed" ? { text: "existing terminal" } : null,
        error:
          outcome === "completed" ? null : { code, message: `Existing tool ended ${outcome}.` },
      },
      {
        kind: "toolCallOccurrence.put",
        runId,
        stepId,
        callId,
        occurredAtMs: requestedAtMs,
      },
    );
  }
  await session.appendTransaction({
    events: [
      runEvent,
      {
        eventId: `evt_terminalSet${suffix}StepCompleted`,
        eventType: "provider.step.completed",
        createdAtMs: 2_001,
        data: { eventVersion: 1, runId, stepId },
      },
      ...toolEvents,
    ],
    projections: [
      {
        kind: "run.put",
        runId,
        state: runState,
        providerId: "fake",
        providerConfig: { scenario: "echo-tool-round-trip" },
        createdAtMs: 2_000,
        startedAtMs: 2_000,
        completedAtMs: runState === "interrupted" ? 2_000 : null,
        cancelledAtMs: null,
        failureCategory: runState === "interrupted" ? "tool.outcome_unknown" : null,
        failureMessage: runState === "interrupted" ? "Run was already interrupted." : null,
        activeProviderStepId: null,
      },
      {
        kind: "providerStep.put",
        stepId,
        runId,
        stepIndex: 0,
        state: "completed",
        startedAtMs: 2_000,
        completedAtMs: 2_001,
        responseId: `response_terminalSet${suffix}`,
        errorCategory: null,
        errorMessage: null,
      },
      ...toolProjections,
    ],
  });
  return { runId, callIds };
}

function registryFor(specs: readonly StartedToolSpec[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const spec of specs) {
    registry.register({ ...createEchoTool(), name: spec.name, effectClass: spec.effectClass });
  }
  return registry;
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

async function recoverStartedSet(
  session: SessionClient,
  seeded: { readonly runId: string; readonly callIds: readonly string[] },
  specs: readonly StartedToolSpec[],
  decorateStorage?: (storage: SessionClient) => SessionClient,
): Promise<{
  readonly actor: SessionActor;
  readonly provider: FakeProviderAdapter;
  readonly executions: readonly string[];
  readonly registry: ToolRegistry;
  readonly storage: SessionClient;
}> {
  const storage = decorateStorage?.(session) ?? session;
  const registry = registryFor(specs);
  const provider = new FakeProviderAdapter();
  const executions: string[] = [];
  const ids = generatedIds(`set${fixtureNumber}`);
  const loop = new AgentRunLoop({
    storage,
    provider,
    registry,
    executor: new ToolExecutor({ onExecutionStart: ({ callId }) => executions.push(callId) }),
    ids: ids.loop,
  });
  let signalTerminal = (): void => {};
  const terminal = new Promise<void>((resolve) => {
    signalTerminal = resolve;
  });
  const hub = new CommittedEventHub();
  hub.subscribe(session.sessionId, (event) => {
    if (
      event.eventType === "run.interrupted" &&
      event.data.runId === seeded.runId
    ) {
      signalTerminal();
    }
  });
  let now = 4_000;
  const actor = await SessionActor.create({
    storage,
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
  return { actor, provider, executions, registry, storage };
}

async function createRecoveryOnlyActor(
  session: SessionClient,
  registry: ToolRegistry,
  suffix: string,
): Promise<{ readonly actor: SessionActor; readonly runTaskCalls: () => number }> {
  const ids = generatedIds(suffix);
  let taskCalls = 0;
  const actor = await SessionActor.create({
    storage: session,
    eventHub: new CommittedEventHub(),
    scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
    ids: ids.actor,
    now: () => 5_000,
    runTask: async () => {
      taskCalls += 1;
    },
    currentToolEffectClass: (name) => registry.get(name)?.effectClass ?? null,
    cancelRunTask: async () => undefined,
    forceStopRunTask: () => ({ status: "terminated" }),
    resumeRestoredRuns: false,
  });
  actors.push(actor);
  return { actor, runTaskCalls: () => taskCalls };
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

  it("quarantines an exact stale start event behind pure-tool recovery before execution", async () => {
    const { session } = await storageFixture();
    const seeded = await seedRecoverableTool(session, "started");
    const generated = generatedIds("staleExactStart");
    const executions: string[] = [];
    const published: SessionEvent[] = [];
    const loop = new AgentRunLoop({
      storage: session,
      provider: new FakeProviderAdapter(),
      registry: createBuiltinToolRegistry(),
      executor: new ToolExecutor({ onExecutionStart: ({ callId }) => executions.push(callId) }),
      ids: {
        ...generated.loop,
        eventId: () => "evt_recoverstartedToolStarted",
      },
    });
    let signalFault: (error: unknown) => void = () => undefined;
    const faulted = new Promise<unknown>((resolve) => {
      signalFault = resolve;
    });
    const hub = new CommittedEventHub();
    hub.subscribe(session.sessionId, (event) => {
      published.push(event);
    });
    const actor = await SessionActor.create({
      storage: session,
      eventHub: hub,
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: generated.actor,
      now: () => 2_004,
      runTask: loop.task,
      currentToolEffectClass: loop.currentToolEffectClass,
      cancelRunTask: loop.cancel,
      forceStopRunTask: () => ({ status: "terminated" }),
      runTaskOwnsSchedulerPermits: true,
      resumeRestoredRuns: true,
      onFault: signalFault,
    });
    actors.push(actor);

    await expect(faulted).resolves.toMatchObject({
      code: "storage.corrupt",
      name: "EventReconciliationIntegrityError",
    });
    expect(executions).toEqual([]);
    expect(actor.snapshot.faulted).toBe(true);
    await expect(session.getToolExecution(seeded.callId)).resolves.toMatchObject({
      state: "requested",
      attemptCount: 1,
    });
    const events = await session.getEventsAfter(0);
    expect(
      events.filter(
        (event) =>
          event.eventType === "tool.execution.started" && event.data.callId === seeded.callId,
      ),
    ).toHaveLength(1);
    expect(
      published.filter(
        (event) =>
          event.eventType === "tool.execution.started" && event.data.callId === seeded.callId,
      ),
    ).toEqual([]);
    await expect(
      actor.submitMessage({
        v: 1,
        kind: "command",
        commandId: "cmd_afterStaleExactStart",
        sessionId: session.sessionId,
        method: "message.submit",
        params: { text: "must remain quarantined" },
      }),
    ).rejects.toMatchObject({ code: "session.unavailable" });
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

  it("interrupts a running run with existing unknown outcomes exactly once", async () => {
    const { session } = await storageFixture();
    const seeded = await seedTerminalToolSet(session, ["outcome_unknown", "outcome_unknown"]);
    await expect(session.recover()).resolves.toMatchObject({
      interruptedRunIds: [seeded.runId],
      outcomeUnknownRunIds: [seeded.runId],
    });

    const ids = generatedIds("existingUnknownRecovery");
    const provider = new FakeProviderAdapter();
    const executions: string[] = [];
    const registry = new ToolRegistry();
    const loop = new AgentRunLoop({
      storage: session,
      provider,
      registry,
      executor: new ToolExecutor({ onExecutionStart: ({ callId }) => executions.push(callId) }),
      ids: ids.loop,
    });
    let signalTerminal = (): void => {};
    const terminal = new Promise<void>((resolve) => {
      signalTerminal = resolve;
    });
    const hub = new CommittedEventHub();
    hub.subscribe(session.sessionId, (event) => {
      if (event.eventType === "run.interrupted" && event.data.runId === seeded.runId) {
        signalTerminal();
      }
    });
    let now = 6_000;
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const actor = await SessionActor.create({
      storage: session,
      eventHub: hub,
      scheduler,
      ids: ids.actor,
      now: () => ++now,
      runTask: loop.task,
      currentToolEffectClass: loop.currentToolEffectClass,
      cancelRunTask: loop.cancel,
      forceStopRunTask: () => ({ status: "terminated" }),
      runTaskOwnsSchedulerPermits: true,
      resumeRestoredRuns: true,
    });
    actors.push(actor);
    await terminal;

    expect(provider.requests).toEqual([]);
    expect(executions).toEqual([]);
    expect(actor.snapshot.activeRunId).toBeNull();
    expect(scheduler.state).toMatchObject({
      provider: { active: 0, queued: 0, available: 1 },
      tool: { active: 0, queued: 0, available: 1 },
    });
    await expect(session.getRun(seeded.runId)).resolves.toMatchObject({
      state: "interrupted",
      failureCategory: "tool.outcome_unknown",
      activeProviderStepId: null,
    });
    const tools = await Promise.all(
      seeded.callIds.map((callId) => session.getToolExecution(callId)),
    );
    expect(tools).toEqual([
      expect.objectContaining({ state: "outcome_unknown", attemptCount: 1 }),
      expect.objectContaining({ state: "outcome_unknown", attemptCount: 1 }),
    ]);
    const events = await session.getEventsAfter(0);
    expect(
      events.filter(
        (event) =>
          event.eventType === "tool.execution.outcome_unknown" &&
          event.data.runId === seeded.runId,
      ),
    ).toHaveLength(2);
    expect(
      events.filter(
        (event) => event.eventType === "run.interrupted" && event.data.runId === seeded.runId,
      ),
    ).toHaveLength(1);
    const head = await session.getHeadSequence();
    let repeatedEvent = 0;
    await expect(
      recoverSession({
        sessionId: session.sessionId,
        storage: session,
        now: () => ++now,
        eventId: () => `evt_existingUnknownRepeated${++repeatedEvent}`,
        diagnosticId: () => `err_existingUnknownRepeated${repeatedEvent}`,
        publishCommitted: () => undefined,
        resumeToolLoop: true,
        currentToolEffectClass: () => null,
      }),
    ).resolves.toMatchObject({
      interruptedRunIds: [],
      outcomeUnknownRunIds: [],
    });
    await expect(session.getHeadSequence()).resolves.toBe(head);
  });

  it("reconciles an existing unknown-outcome interruption after its response is lost", async () => {
    const { session } = await storageFixture();
    const seeded = await seedTerminalToolSet(session, ["outcome_unknown"]);
    let lostResponse = false;
    const storage = new Proxy(session, {
      get(target, property) {
        if (property === "appendTransaction") {
          return async (input: Parameters<SessionClient["appendTransaction"]>[0]) => {
            const result = await target.appendTransaction(input);
            if (
              !lostResponse &&
              input.events.some((event) => event.eventType === "run.interrupted") &&
              !input.events.some(
                (event) => event.eventType === "tool.execution.outcome_unknown",
              )
            ) {
              lostResponse = true;
              throw Object.assign(new Error("existing unknown recovery response lost"), {
                code: "storage.ambiguous_outcome",
              });
            }
            return result;
          };
        }
        const member = Reflect.get(target, property) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      },
    }) as SessionClient;
    let event = 0;
    const options = {
      sessionId: session.sessionId,
      storage,
      now: () => 6_500,
      eventId: () => `evt_existingUnknownLost${++event}`,
      diagnosticId: () => `err_existingUnknownLost${event}`,
      publishCommitted: () => undefined,
      resumeToolLoop: true,
      currentToolEffectClass: () => null,
    };

    await expect(recoverSession(options)).resolves.toMatchObject({
      interruptedRunIds: [seeded.runId],
      outcomeUnknownRunIds: [seeded.runId],
    });
    expect(lostResponse).toBe(true);
    await expect(session.getRun(seeded.runId)).resolves.toMatchObject({
      state: "interrupted",
      failureCategory: "tool.outcome_unknown",
    });
    const head = await session.getHeadSequence();
    await expect(recoverSession(options)).resolves.toMatchObject({
      interruptedRunIds: [],
      outcomeUnknownRunIds: [],
    });
    await expect(session.getHeadSequence()).resolves.toBe(head);
    const events = await session.getEventsAfter(0);
    expect(
      events.filter(
        (candidate) =>
          candidate.eventType === "tool.execution.outcome_unknown" &&
          candidate.data.runId === seeded.runId,
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (candidate) =>
          candidate.eventType === "run.interrupted" && candidate.data.runId === seeded.runId,
      ),
    ).toHaveLength(1);
  });

  it("refuses provider continuation when the run loop reads an unknown outcome", async () => {
    const { session } = await storageFixture();
    const seeded = await seedTerminalToolSet(session, ["outcome_unknown"]);
    const ids = generatedIds("unknownRunLoopDefense");
    const provider = new FakeProviderAdapter();
    const executions: string[] = [];
    const abort = new AbortController();
    const storage = new Proxy(session, {
      get(target, property) {
        if (property === "getToolExecution") {
          return async (callId: string) => {
            const tool = await target.getToolExecution(callId);
            abort.abort(new Error("Cancellation raced with unknown-outcome adoption"));
            return tool;
          };
        }
        const member = Reflect.get(target, property) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      },
    }) as SessionClient;
    const loop = new AgentRunLoop({
      storage,
      provider,
      registry: new ToolRegistry(),
      executor: new ToolExecutor({ onExecutionStart: ({ callId }) => executions.push(callId) }),
      ids: ids.loop,
    });
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const head = await session.getHeadSequence();
    const result = await loop.task({
      sessionId: session.sessionId,
      runId: seeded.runId,
      generation: 1,
      signal: abort.signal,
      scheduler,
      now: () => 7_000,
      commitTransaction: (input) => session.appendTransaction(input),
      waitForApproval: async () => undefined,
    });

    expect(result).toMatchObject({
      state: "interrupted",
      code: "tool.outcome_unknown",
    });
    expect(provider.requests).toEqual([]);
    expect(executions).toEqual([]);
    await expect(session.getHeadSequence()).resolves.toBe(head);
    await expect(session.getToolExecution(seeded.callIds[0] ?? "")).resolves.toMatchObject({
      state: "outcome_unknown",
      attemptCount: 1,
    });
    expect(scheduler.state).toMatchObject({
      provider: { active: 0, queued: 0, available: 1 },
      tool: { active: 0, queued: 0, available: 1 },
    });
    await scheduler.shutdown();
  });

  it("does not change an already terminal run with an unknown tool outcome", async () => {
    const { session } = await storageFixture();
    const seeded = await seedTerminalToolSet(session, ["outcome_unknown"], "interrupted");
    const head = await session.getHeadSequence();
    let event = 0;

    await expect(
      recoverSession({
        sessionId: session.sessionId,
        storage: session,
        now: () => 8_000,
        eventId: () => `evt_terminalUnknownNoop${++event}`,
        diagnosticId: () => `err_terminalUnknownNoop${event}`,
        publishCommitted: () => undefined,
        resumeToolLoop: true,
        currentToolEffectClass: () => null,
      }),
    ).resolves.toMatchObject({
      interruptedRunIds: [],
      outcomeUnknownRunIds: [],
    });
    await expect(session.getHeadSequence()).resolves.toBe(head);
    await expect(session.getRun(seeded.runId)).resolves.toMatchObject({
      state: "interrupted",
      failureCategory: "tool.outcome_unknown",
    });
    const events = await session.getEventsAfter(0);
    expect(
      events.filter(
        (candidate) =>
          candidate.eventType === "run.interrupted" && candidate.data.runId === seeded.runId,
      ),
    ).toHaveLength(1);
  });

  it("preserves provider continuation for ordinary terminal tool outcomes", async () => {
    const { session } = await storageFixture();
    const outcomes = ["completed", "failed", "denied", "cancelled"] as const;
    const seeded = await seedTerminalToolSet(session, outcomes);
    const ids = generatedIds("ordinaryTerminalOutcomes");
    const provider = new FakeProviderAdapter();
    const executions: string[] = [];
    const loop = new AgentRunLoop({
      storage: session,
      provider,
      registry: createBuiltinToolRegistry(),
      executor: new ToolExecutor({ onExecutionStart: ({ callId }) => executions.push(callId) }),
      ids: ids.loop,
    });
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const result = await loop.task({
      sessionId: session.sessionId,
      runId: seeded.runId,
      generation: 1,
      signal: new AbortController().signal,
      scheduler,
      now: () => 9_000,
      commitTransaction: (input) => session.appendTransaction(input),
      waitForApproval: async () => undefined,
    });

    expect(result).toEqual({ state: "completed" });
    expect(provider.requests).toHaveLength(1);
    expect(executions).toEqual([]);
    const tools = await Promise.all(
      seeded.callIds.map((callId) => session.getToolExecution(callId)),
    );
    expect(tools.map((tool) => tool?.state)).toEqual(outcomes);
    expect(scheduler.state).toMatchObject({
      provider: { active: 0, queued: 0, available: 1 },
      tool: { active: 0, queued: 0, available: 1 },
    });
    await scheduler.shutdown();
  });

  it("atomically marks one non-idempotent started call unknown and interrupts its run", async () => {
    const { session } = await storageFixture();
    const specs = [{ name: "unsafe_once", effectClass: "non_idempotent" }] as const;
    const seeded = await seedStartedToolSet(session, specs);
    const recovered = await recoverStartedSet(session, seeded, specs);

    expect(recovered.executions).toEqual([]);
    expect(recovered.provider.requests).toEqual([]);
    await expect(session.getRun(seeded.runId)).resolves.toMatchObject({
      state: "interrupted",
      failureCategory: "tool.outcome_unknown",
    });
    await expect(session.getToolExecution(seeded.callIds[0] ?? "")).resolves.toMatchObject({
      state: "outcome_unknown",
      effectClass: "non_idempotent",
      attemptCount: 1,
    });
    const events = await session.getEventsAfter(0);
    const unknown = events.find(
      (event) =>
        event.eventType === "tool.execution.outcome_unknown" &&
        event.data.callId === seeded.callIds[0],
    );
    const interrupted = events.find(
      (event) => event.eventType === "run.interrupted" && event.data.runId === seeded.runId,
    );
    expect(unknown?.sequence).toBeDefined();
    expect(interrupted?.sequence).toBe((unknown?.sequence ?? 0) + 1);
  });

  it("reconciles unsafe started calls across two restarts when resumption is disabled", async () => {
    const { manager, session } = await storageFixture();
    const seeded = await seedRecoverableTool(session, "started", "non_idempotent");
    const registry = echoRegistry("non_idempotent");

    const first = await createRecoveryOnlyActor(session, registry, "disabledResumeFirst");
    expect(first.runTaskCalls()).toBe(0);
    await expect(session.getRun(seeded.runId)).resolves.toMatchObject({
      state: "interrupted",
      failureCategory: "tool.outcome_unknown",
    });
    await expect(session.getToolExecution(seeded.callId)).resolves.toMatchObject({
      state: "outcome_unknown",
      effectClass: "non_idempotent",
      attemptCount: 1,
    });
    const head = await session.getHeadSequence();
    await first.actor.handoff();
    const firstIndex = actors.indexOf(first.actor);
    if (firstIndex >= 0) actors.splice(firstIndex, 1);

    const reopened = await manager.openSession(session.sessionId);
    const second = await createRecoveryOnlyActor(reopened, registry, "disabledResumeSecond");
    expect(second.runTaskCalls()).toBe(0);
    await expect(reopened.getHeadSequence()).resolves.toBe(head);
    await expect(reopened.getToolExecution(seeded.callId)).resolves.toMatchObject({
      state: "outcome_unknown",
      effectClass: "non_idempotent",
      attemptCount: 1,
    });
    const events = await reopened.getEventsAfter(0);
    expect(
      events.filter(
        (event) =>
          event.eventType === "tool.execution.outcome_unknown" &&
          event.data.callId === seeded.callId,
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.eventType === "run.interrupted" && event.data.runId === seeded.runId,
      ),
    ).toHaveLength(1);
  });

  it("terminalizes multiple unsafe started calls in one recovery transaction", async () => {
    const { session } = await storageFixture();
    const specs = [
      { name: "unsafe_first", effectClass: "non_idempotent" },
      { name: "unsafe_second", effectClass: "idempotent_external" },
    ] as const;
    const seeded = await seedStartedToolSet(session, specs);
    const recovered = await recoverStartedSet(session, seeded, specs);

    expect(recovered.executions).toEqual([]);
    expect(recovered.provider.requests).toEqual([]);
    const tools = await Promise.all(
      seeded.callIds.map((callId) => session.getToolExecution(callId)),
    );
    expect(tools).toEqual([
      expect.objectContaining({ state: "outcome_unknown", attemptCount: 1 }),
      expect.objectContaining({ state: "outcome_unknown", attemptCount: 1 }),
    ]);
    const events = await session.getEventsAfter(0);
    expect(
      events.filter(
        (event) =>
          event.eventType === "tool.execution.outcome_unknown" &&
          event.data.runId === seeded.runId,
      ),
    ).toHaveLength(2);
    expect(
      events.filter(
        (event) => event.eventType === "run.interrupted" && event.data.runId === seeded.runId,
      ),
    ).toHaveLength(1);
  });

  it("interrupts a mixed pure and unsafe started set without retrying either call", async () => {
    const { session } = await storageFixture();
    const specs = [
      { name: "pure_mixed", effectClass: "pure" },
      { name: "unsafe_mixed", effectClass: "non_idempotent" },
    ] as const;
    const seeded = await seedStartedToolSet(session, specs);
    const recovered = await recoverStartedSet(session, seeded, specs);

    expect(recovered.executions).toEqual([]);
    expect(recovered.provider.requests).toEqual([]);
    await expect(session.getToolExecution(seeded.callIds[0] ?? "")).resolves.toMatchObject({
      state: "failed",
      effectClass: "pure",
      attemptCount: 1,
    });
    await expect(session.getToolExecution(seeded.callIds[1] ?? "")).resolves.toMatchObject({
      state: "outcome_unknown",
      effectClass: "non_idempotent",
      attemptCount: 1,
    });
  });

  it("reconciles unsafe recovery committed before response loss and repeats as a no-op", async () => {
    const { session } = await storageFixture();
    const specs = [{ name: "unsafe_ambiguous", effectClass: "non_idempotent" }] as const;
    const seeded = await seedStartedToolSet(session, specs);
    let lostResponse = false;
    const recovered = await recoverStartedSet(session, seeded, specs, (raw) =>
      new Proxy(raw, {
        get(target, property) {
          if (property === "appendTransaction") {
            return async (input: Parameters<SessionClient["appendTransaction"]>[0]) => {
              const result = await target.appendTransaction(input);
              if (
                !lostResponse &&
                input.events.some((event) => event.eventType === "tool.execution.outcome_unknown") &&
                input.events.some((event) => event.eventType === "run.interrupted")
              ) {
                lostResponse = true;
                throw Object.assign(new Error("unsafe recovery response lost"), {
                  code: "storage.ambiguous_outcome",
                });
              }
              return result;
            };
          }
          const member = Reflect.get(target, property) as unknown;
          return typeof member === "function" ? member.bind(target) : member;
        },
      }) as SessionClient,
    );

    expect(lostResponse).toBe(true);
    expect(recovered.executions).toEqual([]);
    expect(recovered.provider.requests).toEqual([]);
    const head = await session.getHeadSequence();
    let repeatedEvent = 0;
    await expect(
      recoverSession({
        sessionId: session.sessionId,
        storage: recovered.storage,
        now: () => 5_000,
        eventId: () => `evt_repeatedUnsafe${++repeatedEvent}`,
        diagnosticId: () => `err_repeatedUnsafe${repeatedEvent}`,
        publishCommitted: () => undefined,
        resumeToolLoop: true,
        currentToolEffectClass: (name) => recovered.registry.get(name)?.effectClass ?? null,
      }),
    ).resolves.toMatchObject({ interruptedRunIds: [], startedToolCalls: [] });
    await expect(session.getHeadSequence()).resolves.toBe(head);
    const events = await session.getEventsAfter(0);
    expect(
      events.filter(
        (event) =>
          event.eventType === "tool.execution.outcome_unknown" &&
          event.data.runId === seeded.runId,
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.eventType === "run.interrupted" && event.data.runId === seeded.runId,
      ),
    ).toHaveLength(1);
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
      state: "failed",
      attemptCount: 1,
      effectClass: "pure",
    });
    await expect(session.getRun(seeded.runId)).resolves.toMatchObject({
      state: "interrupted",
      failureCategory: "provider.protocol_error",
    });
  });

  it("preserves outcome ambiguity across an inverse started effect-class mismatch", async () => {
    const { session } = await storageFixture();
    const seeded = await seedRecoverableTool(session, "started", "non_idempotent");
    const resumed = await resumeSeeded(session, seeded, {
      registry: echoRegistry("pure"),
      expectedRunState: "interrupted",
    });

    expect(resumed.executions).toEqual([]);
    await expect(session.getToolExecution(seeded.callId)).resolves.toMatchObject({
      state: "outcome_unknown",
      attemptCount: 1,
      effectClass: "non_idempotent",
      error: { code: "tool.outcome_unknown" },
    });
    await expect(session.getRun(seeded.runId)).resolves.toMatchObject({
      state: "interrupted",
      failureCategory: "tool.outcome_unknown",
    });
  });

  it("preserves outcome ambiguity when a started non-idempotent definition is missing", async () => {
    const { session } = await storageFixture();
    const seeded = await seedRecoverableTool(session, "started", "non_idempotent");
    const resumed = await resumeSeeded(session, seeded, {
      registry: new ToolRegistry(),
      expectedRunState: "interrupted",
    });

    expect(resumed.executions).toEqual([]);
    await expect(session.getToolExecution(seeded.callId)).resolves.toMatchObject({
      state: "outcome_unknown",
      attemptCount: 1,
      effectClass: "non_idempotent",
      error: { code: "tool.outcome_unknown" },
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
