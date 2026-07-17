import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@wi/protocol";
import { SessionStoreManager, type SessionClient } from "@wi/storage";
import { createBrowserSessionState } from "../../packages/client-state/src/model.js";
import { reduceSessionEvent } from "../../packages/client-state/src/reducer.js";
import {
  beginReplaySubscription,
  CommittedEventHub,
  RunScheduler,
  SessionActor,
  SessionActorRegistry,
  type RunTask,
  type RunTaskContext,
  type RunTaskResult,
  type SessionActorIds,
} from "../../packages/harness-core/src/index.js";

const homes: string[] = [];
const stores: SessionStoreManager[] = [];

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("ID sequence exhausted");
    index += 1;
    return value;
  };
}

async function store(options: {
  catalogProjectionWriter?: ConstructorParameters<typeof SessionStoreManager>[0]["catalogProjectionWriter"];
  catalogObservationShutdownTimeoutMs?: number;
  sessionIds?: readonly string[];
} = {}): Promise<SessionStoreManager> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-harness-integration-"));
  homes.push(homeDirectory);
  let eventNumber = 0;
  const manager = new SessionStoreManager({
    homeDirectory,
    ids: {
      sessionId: sequence(options.sessionIds ?? ["ses_harness"]),
      eventId: () => `evt_sessionCreated${++eventNumber}`,
    },
    now: () => 1_000,
    sessionWorkers: { size: 2, allowTestOperations: true },
    ...(options.catalogProjectionWriter === undefined
      ? {}
      : { catalogProjectionWriter: options.catalogProjectionWriter }),
    ...(options.catalogObservationShutdownTimeoutMs === undefined
      ? {}
      : { catalogObservationShutdownTimeoutMs: options.catalogObservationShutdownTimeoutMs }),
  });
  stores.push(manager);
  return manager;
}

function actorIds(name: string): SessionActorIds {
  let count = 0;
  return {
    runId: () => `run_${name}${++count}`,
    eventId: () => `evt_${name}${++count}`,
    messageId: () => `msg_${name}${++count}`,
    partId: () => `part_${name}${++count}`,
    diagnosticId: () => `err_${name}${++count}`,
  };
}

function submit(sessionId: string, commandId: string) {
  return {
    v: 1 as const,
    kind: "command" as const,
    commandId,
    sessionId,
    method: "message.submit" as const,
    params: { text: commandId },
  };
}

async function seedRunWithPendingInteractions(
  session: SessionClient,
  prefix: string,
  state: "running" | "waiting_for_user",
): Promise<{ readonly runId: string }> {
  const runId = `run_${prefix}`;
  const stepId = `step_${prefix}`;
  const callId = `call_${prefix}`;
  const approvalId = `approval_${prefix}`;
  const inputId = `input_${prefix}`;
  const waiting = state === "waiting_for_user";

  await session.appendTransaction({
    events: [
      {
        eventId: `evt_${prefix}RunCreated`,
        eventType: "run.created",
        createdAtMs: 2_000,
        data: { eventVersion: 1, runId },
      },
      {
        eventId: `evt_${prefix}RunStarted`,
        eventType: "run.started",
        createdAtMs: 2_001,
        data: { eventVersion: 1, runId },
      },
      {
        eventId: `evt_${prefix}StepStarted`,
        eventType: "provider.step.started",
        createdAtMs: 2_002,
        data: { eventVersion: 1, runId, stepId, stepIndex: 0 },
      },
      ...(waiting
        ? [
            {
              eventId: `evt_${prefix}StepCompleted`,
              eventType: "provider.step.completed" as const,
              createdAtMs: 2_003,
              data: { eventVersion: 1 as const, runId, stepId },
            },
          ]
        : []),
      {
        eventId: `evt_${prefix}Approval`,
        eventType: "tool.approval.requested",
        createdAtMs: 2_004,
        data: {
          eventVersion: 1,
          runId,
          callId,
          approvalId,
          toolName: "guarded_echo",
          actionDigest: "a".repeat(64),
          summary: "pending",
        },
      },
      {
        eventId: `evt_${prefix}Input`,
        eventType: "input.requested",
        createdAtMs: 2_005,
        data: { eventVersion: 1, runId, inputId, prompt: "answer" },
      },
      ...(waiting
        ? [
            {
              eventId: `evt_${prefix}Waiting`,
              eventType: "run.waiting_for_user" as const,
              createdAtMs: 2_006,
              data: {
                eventVersion: 1 as const,
                runId,
                reason: "input" as const,
                inputId,
              },
            },
          ]
        : []),
    ],
    projections: [
      {
        kind: "run.put",
        runId,
        state,
        providerId: "fake",
        providerConfig: {},
        createdAtMs: 2_000,
        startedAtMs: 2_001,
        completedAtMs: null,
        cancelledAtMs: null,
        failureCategory: null,
        failureMessage: null,
        activeProviderStepId: waiting ? null : stepId,
      },
      {
        kind: "providerStep.put",
        stepId,
        runId,
        stepIndex: 0,
        state: waiting ? "completed" : "streaming",
        startedAtMs: 2_002,
        completedAtMs: waiting ? 2_003 : null,
        responseId: waiting ? `response_${prefix}` : null,
        errorCategory: null,
        errorMessage: null,
      },
      {
        kind: "toolExecution.put",
        callId,
        runId,
        stepId,
        toolName: "guarded_echo",
        argumentsJson: "{}",
        argumentsHash: "b".repeat(64),
        effectClass: "pure",
        state: "awaiting_approval",
        attemptCount: 0,
        requestedAtMs: 2_004,
        startedAtMs: null,
        completedAtMs: null,
        result: null,
        error: null,
      },
      {
        kind: "toolCallOccurrence.put",
        runId,
        stepId,
        callId,
        occurredAtMs: 2_004,
      },
      {
        kind: "approval.put",
        approvalId,
        runId,
        callId,
        state: "pending",
        actionDigest: "a".repeat(64),
        requestedAtMs: 2_004,
      },
      {
        kind: "input.put",
        inputId,
        runId,
        state: "pending",
        prompt: "answer",
        requestedAtMs: 2_005,
      },
    ],
  });

  return { runId };
}

class ControlledTasks {
  readonly pending = new Map<
    string,
    { context: RunTaskContext; resolve: (result?: RunTaskResult) => void }
  >();
  private readonly waiters = new Map<string, () => void>();
  private readonly stopped = new Map<string, Promise<void>>();
  readonly task: RunTask = (context) =>
    new Promise<RunTaskResult | void>((resolve) => {
      let confirmStopped = (): void => {};
      const stopped = new Promise<void>((settle) => {
        confirmStopped = settle;
      });
      this.stopped.set(context.runId, stopped);
      this.pending.set(context.runId, {
        context,
        resolve: (result) => {
          confirmStopped();
          resolve(result);
        },
      });
      this.waiters.get(context.runId)?.();
      this.waiters.delete(context.runId);
    });

  readonly cancel = async (context: RunTaskContext): Promise<void> => {
    await this.stopped.get(context.runId);
  };

  async waitFor(runId: string): Promise<void> {
    if (this.pending.has(runId)) return;
    await new Promise<void>((resolve) => this.waiters.set(runId, resolve));
  }
}

class ActivityMonitor {
  private readonly waiters = new Set<() => void>();

  signal(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async waitFor(predicate: () => boolean): Promise<void> {
    while (!predicate()) {
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }
}

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((manager) => manager.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("harness-core with real storage workers", () => {
  it("publishes committed actor events without waiting for blocked catalog observation", async () => {
    let releaseCatalog = (): void => {};
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    const manager = await store({
      catalogProjectionWriter: async (catalog, update) => {
        await catalogGate;
        await catalog.updateSessionProjection(update);
      },
    });
    const created = await manager.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_createHarness",
      method: "session.create",
      params: {},
    });
    const session = await manager.openSession(created.session.sessionId);
    const hub = new CommittedEventHub();
    const observed: SessionEvent[] = [];
    let resolvePublished = (): void => {};
    const published = new Promise<void>((resolve) => {
      resolvePublished = resolve;
    });
    hub.subscribe(session.sessionId, (event) => {
      observed.push(event);
      if (observed.length === 3) resolvePublished();
    });
    const actor = await SessionActor.create({
      storage: session,
      eventHub: hub,
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: actorIds("commit"),
      now: () => 2_000,
      runTask: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ state: "interrupted" }), { once: true });
        }),
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
    });

    const accepted = await actor.submitMessage(submit(session.sessionId, "cmd_submitHarness"));
    await published;
    expect(accepted.acceptance.duplicate).toBe(false);
    expect(observed.map((event) => event.eventType)).toEqual([
      "user.message.appended",
      "run.created",
      "run.started",
    ]);
    await expect(session.getHeadSequence()).resolves.toBe(4);
    await expect(manager.catalog.getSession(session.sessionId)).resolves.toMatchObject({
      lastEventSequence: 1,
    });

    const replayed: number[] = [];
    const replay = beginReplaySubscription({
      sessionId: session.sessionId,
      afterSequence: 1,
      source: session,
      hub: new CommittedEventHub(),
      callbacks: {
        deliver: (event) => {
          replayed.push(event.sequence);
        },
        replayComplete: () => undefined,
      },
    });
    await expect(replay.ready).resolves.toEqual({ throughSequence: 4 });
    expect(replayed).toEqual([2, 3, 4]);
    releaseCatalog();
    await manager.drainCatalogObservations();
    await actor.shutdown();
  });

  it("does not publish when durable command acceptance fails", async () => {
    const manager = await store();
    const created = await manager.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_createFailure",
      method: "session.create",
      params: {},
    });
    const session = await manager.openSession(created.session.sessionId);
    vi.spyOn(session, "acceptCommand").mockRejectedValue(new Error("injected storage failure"));
    const hub = new CommittedEventHub();
    const observed = vi.fn();
    hub.subscribe(session.sessionId, observed);
    const actor = await SessionActor.create({
      storage: session,
      eventHub: hub,
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: actorIds("failure"),
      now: () => 2_000,
      runTask: async () => undefined,
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
    });
    await expect(actor.submitMessage(submit(session.sessionId, "cmd_submitFailure"))).rejects.toThrow(
      "injected storage failure",
    );
    expect(observed).not.toHaveBeenCalled();
    await expect(session.getHeadSequence()).resolves.toBe(1);
  });

  it("adopts a durably accepted run after its command response is lost", async () => {
    const manager = await store();
    const created = await manager.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_createAmbiguousActor",
      method: "session.create",
      params: {},
    });
    const session = await manager.openSession(created.session.sessionId);
    const originalAccept = session.acceptCommand.bind(session);
    let injected = false;
    vi.spyOn(session, "acceptCommand").mockImplementation(async (input) => {
      const result = await originalAccept(input);
      if (!injected && input.commandMethod === "message.submit") {
        injected = true;
        throw new Error("ambiguous command response");
      }
      return result;
    });
    const tasks = new ControlledTasks();
    const monitor = new ActivityMonitor();
    const actor = await SessionActor.create({
      storage: session,
      eventHub: new CommittedEventHub(),
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: actorIds("ambiguousActor"),
      now: () => 2_000,
      runTask: tasks.task,
      cancelRunTask: tasks.cancel,
      forceStopRunTask: () => ({ status: "terminated" }),
      onActivity: () => monitor.signal(),
    });

    const submitted = await actor.submitMessage(
      submit(session.sessionId, "cmd_submitAmbiguousActor"),
    );
    expect(submitted.acceptance.duplicate).toBe(true);
    await tasks.waitFor(submitted.runId);
    expect(actor.snapshot.activeRunId).toBe(submitted.runId);
    tasks.pending.get(submitted.runId)?.resolve({ state: "completed" });
    await monitor.waitFor(() => actor.snapshot.activeRunId === null);
    await actor.shutdown();
    await expect(session.getRun(submitted.runId)).resolves.toMatchObject({ state: "completed" });
  });

  it("recovers running provider work exactly once when the commit response is lost", async () => {
    const manager = await store();
    const created = await manager.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_createRecovery",
      method: "session.create",
      params: {},
    });
    const session = await manager.openSession(created.session.sessionId);
    await session.appendTransaction({
      events: [
        {
          eventId: "evt_recoveryRunCreated",
          eventType: "run.created",
          createdAtMs: 2_000,
          data: { eventVersion: 1, runId: "run_recovery" },
        },
        {
          eventId: "evt_recoveryRunStarted",
          eventType: "run.started",
          createdAtMs: 2_001,
          data: { eventVersion: 1, runId: "run_recovery" },
        },
        {
          eventId: "evt_recoveryStepStarted",
          eventType: "provider.step.started",
          createdAtMs: 2_002,
          data: { eventVersion: 1, runId: "run_recovery", stepId: "step_recovery", stepIndex: 0 },
        },
        {
          eventId: "evt_recoveryTextDelta",
          eventType: "provider.text.delta",
          createdAtMs: 2_003,
          data: {
            eventVersion: 1,
            runId: "run_recovery",
            stepId: "step_recovery",
            messageId: "msg_recoveryPartial",
            partId: "part_recoveryPartial",
            text: "visible",
          },
        },
      ],
      projections: [
        {
          kind: "run.put",
          runId: "run_recovery",
          state: "running",
          providerId: "fake",
          providerConfig: {},
          createdAtMs: 2_000,
          startedAtMs: 2_001,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: "step_recovery",
        },
        {
          kind: "providerStep.put",
          stepId: "step_recovery",
          runId: "run_recovery",
          stepIndex: 0,
          state: "streaming",
          startedAtMs: 2_002,
          completedAtMs: null,
          responseId: null,
          errorCategory: null,
          errorMessage: null,
        },
        {
          kind: "message.put",
          messageId: "msg_recoveryPartial",
          runId: "run_recovery",
          role: "assistant",
          state: "streaming",
          createdAtMs: 2_002,
          completedAtMs: null,
        },
        {
          kind: "messagePart.put",
          partId: "part_recoveryPartial",
          messageId: "msg_recoveryPartial",
          partIndex: 0,
          partType: "text",
          textContent: "visible",
          data: null,
        },
      ],
    });
    const originalAppend = session.appendTransaction.bind(session);
    let loseRecoveryResponse = true;
    vi.spyOn(session, "appendTransaction").mockImplementation(async (input) => {
      const result = await originalAppend(input);
      if (
        loseRecoveryResponse &&
        input.events.some((event) => event.eventType === "run.interrupted")
      ) {
        loseRecoveryResponse = false;
        throw new Error("recovery response lost after commit");
      }
      return result;
    });
    const actor = await SessionActor.create({
      storage: session,
      eventHub: new CommittedEventHub(),
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: actorIds("recovery"),
      now: () => 3_000,
      runTask: async () => undefined,
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
    });
    expect(actor.snapshot.activeRunId).toBeNull();
    await expect(session.getRun("run_recovery")).resolves.toMatchObject({
      state: "interrupted",
      activeProviderStepId: null,
    });
    await expect(session.getProviderStep("step_recovery")).resolves.toMatchObject({
      state: "interrupted",
    });
    const [partialMessage] = await session.getRunMessages("run_recovery");
    expect(partialMessage).toMatchObject({
      messageId: "msg_recoveryPartial",
      state: "interrupted",
      text: "visible",
    });
    const recoveryEvents = await session.getEventsAfter(0);
    const replayedText = recoveryEvents
      .filter((event) => event.eventType === "provider.text.delta")
      .map((event) => event.data.text)
      .join("");
    expect(partialMessage?.text).toBe(replayedText);
    await expect(session.recover()).resolves.toMatchObject({
      interruptedRunIds: [],
      interruptedStepIds: [],
    });
    const head = await session.getHeadSequence();
    await actor.shutdown();
    const reopened = await manager.openSession(session.sessionId);
    const recreated = await SessionActor.create({
      storage: reopened,
      eventHub: new CommittedEventHub(),
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: actorIds("recoveryAgain"),
      now: () => 4_000,
      runTask: async () => undefined,
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
    });
    await expect(reopened.getHeadSequence()).resolves.toBe(head);
    await recreated.shutdown();
  });

  it("restores pending approval and input after actor destruction and resolves each once", async () => {
    const manager = await store();
    const created = await manager.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_createPending",
      method: "session.create",
      params: {},
    });
    const session = await manager.openSession(created.session.sessionId);
    await session.appendTransaction({
      events: [
        {
          eventId: "evt_pendingRun",
          eventType: "run.created",
          createdAtMs: 2_000,
          data: { eventVersion: 1, runId: "run_pending" },
        },
        {
          eventId: "evt_pendingApproval",
          eventType: "tool.approval.requested",
          createdAtMs: 2_001,
          data: {
            eventVersion: 1,
            runId: "run_pending",
            callId: "call_pending",
            approvalId: "approval_pending",
            toolName: "guarded_echo",
            actionDigest: "a".repeat(64),
            summary: "pending",
          },
        },
        {
          eventId: "evt_pendingInput",
          eventType: "input.requested",
          createdAtMs: 2_002,
          data: {
            eventVersion: 1,
            runId: "run_pending",
            inputId: "input_pending",
            prompt: "answer",
          },
        },
      ],
      projections: [
        {
          kind: "run.put",
          runId: "run_pending",
          state: "waiting_for_user",
          providerId: "fake",
          providerConfig: {},
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
          stepId: "step_pending",
          runId: "run_pending",
          stepIndex: 0,
          state: "completed",
          startedAtMs: 2_000,
          completedAtMs: 2_001,
          responseId: "response_pending",
          errorCategory: null,
          errorMessage: null,
        },
        {
          kind: "toolExecution.put",
          callId: "call_pending",
          runId: "run_pending",
          stepId: "step_pending",
          toolName: "guarded_echo",
          argumentsJson: "{}",
          argumentsHash: "b".repeat(64),
          effectClass: "pure",
          state: "awaiting_approval",
          attemptCount: 0,
          requestedAtMs: 2_001,
          startedAtMs: null,
          completedAtMs: null,
          result: null,
          error: null,
        },
        {
          kind: "toolCallOccurrence.put",
          runId: "run_pending",
          stepId: "step_pending",
          callId: "call_pending",
          occurredAtMs: 2_001,
        },
        {
          kind: "approval.put",
          approvalId: "approval_pending",
          runId: "run_pending",
          callId: "call_pending",
          state: "pending",
          actionDigest: "a".repeat(64),
          requestedAtMs: 2_001,
        },
        {
          kind: "input.put",
          inputId: "input_pending",
          runId: "run_pending",
          state: "pending",
          prompt: "answer",
          requestedAtMs: 2_002,
        },
      ],
    });
    const first = await SessionActor.create({
      storage: session,
      eventHub: new CommittedEventHub(),
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: actorIds("pendingFirst"),
      now: () => 3_000,
      runTask: async () => undefined,
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
    });
    expect(first.snapshot).toMatchObject({ pendingApprovalCount: 1, pendingInputCount: 1 });
    await first.shutdown();

    const reopened = await manager.openSession(session.sessionId);
    let resumedInput: unknown;
    let taskStarted = false;
    let signalTaskCompleted = (): void => {};
    const taskCompleted = new Promise<void>((resolve) => {
      signalTaskCompleted = resolve;
    });
    const second = await SessionActor.create({
      storage: reopened,
      eventHub: new CommittedEventHub(),
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: actorIds("pendingSecond"),
      now: () => 4_000,
      runTaskOwnsSchedulerPermits: true,
      resumeRestoredRuns: true,
      currentToolEffectClass: () => "pure",
      runTask: async (context) => {
        taskStarted = true;
        await context.waitForApproval("approval_pending");
        resumedInput = await context.waitForInput("input_pending");
        signalTaskCompleted();
        return { state: "completed" };
      },
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
    });
    expect(second.snapshot).toMatchObject({ pendingApprovalCount: 1, pendingInputCount: 1 });
    expect(taskStarted).toBe(false);
    const approvalCommand = {
      v: 1 as const,
      kind: "command" as const,
      commandId: "cmd_resolvePending",
      sessionId: session.sessionId,
      method: "approval.resolve" as const,
      params: { approvalId: "approval_pending", resolution: "approved" as const },
    };
    const approvalAcceptance = await second.resolveApproval(
      approvalCommand,
      "client_pending",
    );
    expect(approvalAcceptance.events.map((event) => event.eventType)).toEqual([
      "tool.approval.resolved",
    ]);
    await expect(reopened.getRun("run_pending")).resolves.toMatchObject({
      state: "waiting_for_user",
    });
    expect(taskStarted).toBe(false);
    await expect(second.resolveApproval(approvalCommand, "client_pending")).resolves.toMatchObject({
      duplicate: true,
    });
    const inputCommand = {
      v: 1 as const,
      kind: "command" as const,
      commandId: "cmd_respondPending",
      sessionId: session.sessionId,
      method: "input.respond" as const,
      params: { inputId: "input_pending", value: "done" },
    };
    const inputAcceptance = await second.respondToInput(inputCommand);
    expect(inputAcceptance.events.map((event) => event.eventType)).toEqual([
      "input.resolved",
      "run.started",
    ]);
    await within(taskCompleted, "multi-interaction continuation");
    expect(taskStarted).toBe(true);
    expect(resumedInput).toBe("done");
    await expect(second.respondToInput(inputCommand)).resolves.toMatchObject({ duplicate: true });
    await expect(reopened.getRun("run_pending")).resolves.toMatchObject({ state: "completed" });
    await expect(reopened.getPendingApprovals()).resolves.toEqual([]);
    await expect(reopened.getPendingInputs()).resolves.toEqual([]);
    expect(second.snapshot).toMatchObject({ pendingApprovalCount: 0, pendingInputCount: 0 });
    await second.shutdown();
  });

  it("commits an input response and running transition before waking the matching task", async () => {
    const manager = await store();
    const created = await manager.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_createInputContinuation",
      method: "session.create",
      params: {},
    });
    const session = await manager.openSession(created.session.sessionId);
    const monitor = new ActivityMonitor();
    let requested = (): void => {};
    const inputRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    let resumed = (): void => {};
    const inputResumed = new Promise<void>((resolve) => {
      resumed = resolve;
    });
    let resumedValue: unknown;
    let runStateAtResume: string | null = null;
    const actor = await SessionActor.create({
      storage: session,
      eventHub: new CommittedEventHub(),
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: actorIds("inputContinuation"),
      now: () => 3_000,
      runTaskOwnsSchedulerPermits: true,
      runTask: async (context) => {
        // The task is launched from the start-run mailbox turn; wait until that turn exits
        // before posting the input request back through the same mailbox.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await context.commitTransaction({
          events: [
            {
              eventId: "evt_inputContinuationRequested",
              eventType: "input.requested",
              createdAtMs: 3_001,
              data: {
                eventVersion: 1,
                runId: context.runId,
                inputId: "input_continuation",
                prompt: "Continue?",
              },
            },
            {
              eventId: "evt_inputContinuationWaiting",
              eventType: "run.waiting_for_user",
              createdAtMs: 3_001,
              data: {
                eventVersion: 1,
                runId: context.runId,
                reason: "input",
                inputId: "input_continuation",
              },
            },
          ],
          projections: [
            {
              kind: "input.put",
              inputId: "input_continuation",
              runId: context.runId,
              state: "pending",
              prompt: "Continue?",
              requestedAtMs: 3_001,
            },
            {
              kind: "run.state",
              runId: context.runId,
              expectedState: "running",
              nextState: "waiting_for_user",
              startedAtMs: 3_000,
              completedAtMs: null,
              cancelledAtMs: null,
              failureCategory: null,
              failureMessage: null,
              activeProviderStepId: null,
            },
          ],
        });
        requested();
        resumedValue = await context.waitForInput("input_continuation");
        runStateAtResume = (await session.getRun(context.runId))?.state ?? null;
        resumed();
        return { state: "completed" };
      },
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
      onActivity: () => monitor.signal(),
    });

    const submitted = await actor.submitMessage(
      submit(session.sessionId, "cmd_submitInputContinuation"),
    );
    try {
      await within(inputRequested, "input request commit");
    } catch (error) {
      throw new Error(
        `Input task did not request input: ${JSON.stringify({
          snapshot: actor.snapshot,
          run: await session.getRun(submitted.runId),
          events: (await session.getEventsAfter(0)).map((event) => event.eventType),
        })}`,
        { cause: error },
      );
    }
    await expect(session.getRun(submitted.runId)).resolves.toMatchObject({
      state: "waiting_for_user",
    });
    const command = {
      v: 1 as const,
      kind: "command" as const,
      commandId: "cmd_respondInputContinuation",
      sessionId: session.sessionId,
      method: "input.respond" as const,
      params: { inputId: "input_continuation", value: { answer: "yes" } },
    };
    const acceptance = await actor.respondToInput(command);
    expect(acceptance.events.map((event) => event.eventType)).toEqual([
      "input.resolved",
      "run.started",
    ]);
    await within(inputResumed, "live input waiter");
    expect(resumedValue).toEqual({ answer: "yes" });
    expect(runStateAtResume).toBe("running");
    await expect(actor.respondToInput(command)).resolves.toMatchObject({ duplicate: true });
    await within(
      monitor.waitFor(() => actor.snapshot.activeRunId === null),
      "input continuation completion",
    );
    await actor.shutdown();
  });

  it.each([
    ["A then B", ["input_multiA", "input_multiB"]],
    ["B then A", ["input_multiB", "input_multiA"]],
  ] as const)(
    "keeps a live two-input task gated until the final response: %s",
    async (label, resolutionOrder) => {
      const suffix = label.replaceAll(" ", "");
      const manager = await store();
      const created = await manager.createSession({
        v: 1,
        kind: "command",
        commandId: `cmd_createMultiInput${suffix}`,
        method: "session.create",
        params: {},
      });
      const session = await manager.openSession(created.session.sessionId);
      let signalRequested = (): void => {};
      const requested = new Promise<void>((resolve) => {
        signalRequested = resolve;
      });
      let signalCompleted = (): void => {};
      const completed = new Promise<void>((resolve) => {
        signalCompleted = resolve;
      });
      let firstWaitReleased = false;
      const resumedValues: unknown[] = [];
      const actor = await SessionActor.create({
        storage: session,
        eventHub: new CommittedEventHub(),
        scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
        ids: actorIds(`multiInput${suffix}`),
        now: () => 3_000,
        runTaskOwnsSchedulerPermits: true,
        runTask: async (context) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          await context.commitTransaction({
            events: [
              {
                eventId: `evt_multiInputARequested${suffix}`,
                eventType: "input.requested",
                createdAtMs: 3_001,
                data: {
                  eventVersion: 1,
                  runId: context.runId,
                  inputId: "input_multiA",
                  prompt: "A?",
                },
              },
              {
                eventId: `evt_multiInputBRequested${suffix}`,
                eventType: "input.requested",
                createdAtMs: 3_002,
                data: {
                  eventVersion: 1,
                  runId: context.runId,
                  inputId: "input_multiB",
                  prompt: "B?",
                },
              },
              {
                eventId: `evt_multiInputWaiting${suffix}`,
                eventType: "run.waiting_for_user",
                createdAtMs: 3_002,
                data: {
                  eventVersion: 1,
                  runId: context.runId,
                  reason: "input",
                  inputId: "input_multiA",
                },
              },
            ],
            projections: [
              {
                kind: "input.put",
                inputId: "input_multiA",
                runId: context.runId,
                state: "pending",
                prompt: "A?",
                requestedAtMs: 3_001,
              },
              {
                kind: "input.put",
                inputId: "input_multiB",
                runId: context.runId,
                state: "pending",
                prompt: "B?",
                requestedAtMs: 3_002,
              },
              {
                kind: "run.state",
                runId: context.runId,
                expectedState: "running",
                nextState: "waiting_for_user",
                startedAtMs: 3_000,
                completedAtMs: null,
                cancelledAtMs: null,
                failureCategory: null,
                failureMessage: null,
                activeProviderStepId: null,
              },
            ],
          });
          signalRequested();
          resumedValues.push(await context.waitForInput("input_multiA"));
          firstWaitReleased = true;
          resumedValues.push(await context.waitForInput("input_multiB"));
          signalCompleted();
          return { state: "completed" };
        },
        cancelRunTask: async () => undefined,
        forceStopRunTask: () => ({ status: "terminated" }),
      });
      const submitted = await actor.submitMessage(
        submit(session.sessionId, `cmd_submitMultiInput${suffix}`),
      );
      await within(requested, `multi-input request ${label}`);

      const [firstInputId, finalInputId] = resolutionOrder;
      const first = await actor.respondToInput({
        v: 1,
        kind: "command",
        commandId: `cmd_respond${firstInputId}${suffix}`,
        sessionId: session.sessionId,
        method: "input.respond",
        params: { inputId: firstInputId, value: `value:${firstInputId}` },
      });
      expect(first.events.map((event) => event.eventType)).toEqual(["input.resolved"]);
      const headAfterFirst = await session.getHeadSequence();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(firstWaitReleased).toBe(false);
      await expect(session.getHeadSequence()).resolves.toBe(headAfterFirst);
      await expect(session.getRun(submitted.runId)).resolves.toMatchObject({
        state: "waiting_for_user",
      });
      await expect(session.getPendingInputs()).resolves.toEqual([
        expect.objectContaining({ inputId: finalInputId }),
      ]);

      const final = await actor.respondToInput({
        v: 1,
        kind: "command",
        commandId: `cmd_respond${finalInputId}${suffix}`,
        sessionId: session.sessionId,
        method: "input.respond",
        params: { inputId: finalInputId, value: `value:${finalInputId}` },
      });
      expect(final.events.map((event) => event.eventType)).toEqual([
        "input.resolved",
        "run.started",
      ]);
      await within(completed, `multi-input completion ${label}`);
      expect(resumedValues).toEqual(["value:input_multiA", "value:input_multiB"]);
      await within(
        (async () => {
          while (actor.snapshot.activeRunId !== null) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        })(),
        `multi-input terminal ${label}`,
      );
      await expect(session.getRun(submitted.runId)).resolves.toMatchObject({ state: "completed" });
      await actor.shutdown();
    },
  );

  it.each([
    ["approval then input", "approval", "approved"],
    ["input then approval", "input", "approved"],
    ["denial then input", "approval", "denied"],
  ] as const)(
    "keeps a live approval/input task gated until the final response: %s",
    async (label, firstInteraction, resolution) => {
      const suffix = label.replaceAll(" ", "");
      const manager = await store();
      const created = await manager.createSession({
        v: 1,
        kind: "command",
        commandId: `cmd_createMixedInteraction${suffix}`,
        method: "session.create",
        params: {},
      });
      const session = await manager.openSession(created.session.sessionId);
      let signalRequested = (): void => {};
      const requested = new Promise<void>((resolve) => {
        signalRequested = resolve;
      });
      let signalCompleted = (): void => {};
      const completed = new Promise<void>((resolve) => {
        signalCompleted = resolve;
      });
      let firstWaitReleased = false;
      let resumedInput: unknown;
      const actor = await SessionActor.create({
        storage: session,
        eventHub: new CommittedEventHub(),
        scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
        ids: actorIds(`mixedInteraction${suffix}`),
        now: () => 3_000,
        runTaskOwnsSchedulerPermits: true,
        currentToolEffectClass: () => "pure",
        runTask: async (context) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          const stepId = `step_mixedInteraction${suffix}`;
          const callId = `call_mixedInteraction${suffix}`;
          const approvalId = `approval_mixedInteraction${suffix}`;
          const inputId = `input_mixedInteraction${suffix}`;
          await context.commitTransaction({
            events: [
              {
                eventId: `evt_mixedStepStarted${suffix}`,
                eventType: "provider.step.started",
                createdAtMs: 3_001,
                data: { eventVersion: 1, runId: context.runId, stepId, stepIndex: 0 },
              },
              {
                eventId: `evt_mixedStepCompleted${suffix}`,
                eventType: "provider.step.completed",
                createdAtMs: 3_002,
                data: { eventVersion: 1, runId: context.runId, stepId },
              },
              {
                eventId: `evt_mixedApprovalRequested${suffix}`,
                eventType: "tool.approval.requested",
                createdAtMs: 3_003,
                data: {
                  eventVersion: 1,
                  runId: context.runId,
                  callId,
                  approvalId,
                  toolName: "guarded_echo",
                  actionDigest: "a".repeat(64),
                  summary: "Approve?",
                },
              },
              {
                eventId: `evt_mixedInputRequested${suffix}`,
                eventType: "input.requested",
                createdAtMs: 3_004,
                data: {
                  eventVersion: 1,
                  runId: context.runId,
                  inputId,
                  prompt: "Input?",
                },
              },
              {
                eventId: `evt_mixedWaiting${suffix}`,
                eventType: "run.waiting_for_user",
                createdAtMs: 3_004,
                data: {
                  eventVersion: 1,
                  runId: context.runId,
                  reason: "approval",
                  approvalId,
                },
              },
            ],
            projections: [
              {
                kind: "providerStep.put",
                stepId,
                runId: context.runId,
                stepIndex: 0,
                state: "completed",
                startedAtMs: 3_001,
                completedAtMs: 3_002,
                responseId: "response_mixedInteraction",
                errorCategory: null,
                errorMessage: null,
              },
              {
                kind: "toolExecution.put",
                callId,
                runId: context.runId,
                stepId,
                toolName: "guarded_echo",
                argumentsJson: "{}",
                argumentsHash: "b".repeat(64),
                effectClass: "pure",
                state: "awaiting_approval",
                attemptCount: 0,
                requestedAtMs: 3_003,
                startedAtMs: null,
                completedAtMs: null,
                result: null,
                error: null,
              },
              {
                kind: "toolCallOccurrence.put",
                runId: context.runId,
                stepId,
                callId,
                occurredAtMs: 3_003,
              },
              {
                kind: "approval.put",
                approvalId,
                runId: context.runId,
                callId,
                state: "pending",
                actionDigest: "a".repeat(64),
                requestedAtMs: 3_003,
              },
              {
                kind: "input.put",
                inputId,
                runId: context.runId,
                state: "pending",
                prompt: "Input?",
                requestedAtMs: 3_004,
              },
              {
                kind: "run.state",
                runId: context.runId,
                expectedState: "running",
                nextState: "waiting_for_user",
                startedAtMs: 3_000,
                completedAtMs: null,
                cancelledAtMs: null,
                failureCategory: null,
                failureMessage: null,
                activeProviderStepId: null,
              },
            ],
          });
          signalRequested();
          if (firstInteraction === "approval") {
            await context.waitForApproval(approvalId);
            firstWaitReleased = true;
            resumedInput = await context.waitForInput(inputId);
          } else {
            resumedInput = await context.waitForInput(inputId);
            firstWaitReleased = true;
            await context.waitForApproval(approvalId);
          }
          signalCompleted();
          return { state: "completed" };
        },
        cancelRunTask: async () => undefined,
        forceStopRunTask: () => ({ status: "terminated" }),
      });
      const submitted = await actor.submitMessage(
        submit(session.sessionId, `cmd_submitMixedInteraction${suffix}`),
      );
      await within(requested, `mixed interaction request ${label}`);
      const approvalId = `approval_mixedInteraction${suffix}`;
      const inputId = `input_mixedInteraction${suffix}`;

      const firstAcceptance =
        firstInteraction === "approval"
          ? await actor.resolveApproval(
              {
                v: 1,
                kind: "command",
                commandId: `cmd_resolveMixedApproval${suffix}`,
                sessionId: session.sessionId,
                method: "approval.resolve",
                params: { approvalId, resolution },
              },
              "client_mixedInteraction",
            )
          : await actor.respondToInput({
              v: 1,
              kind: "command",
              commandId: `cmd_respondMixedInput${suffix}`,
              sessionId: session.sessionId,
              method: "input.respond",
              params: { inputId, value: `value:${inputId}` },
            });
      expect(firstAcceptance.events.some((event) => event.eventType === "run.started")).toBe(false);
      const headAfterFirst = await session.getHeadSequence();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(firstWaitReleased).toBe(false);
      await expect(session.getHeadSequence()).resolves.toBe(headAfterFirst);
      await expect(session.getRun(submitted.runId)).resolves.toMatchObject({
        state: "waiting_for_user",
      });

      const finalAcceptance =
        firstInteraction === "approval"
          ? await actor.respondToInput({
              v: 1,
              kind: "command",
              commandId: `cmd_respondMixedInput${suffix}`,
              sessionId: session.sessionId,
              method: "input.respond",
              params: { inputId, value: `value:${inputId}` },
            })
          : await actor.resolveApproval(
              {
                v: 1,
                kind: "command",
                commandId: `cmd_resolveMixedApproval${suffix}`,
                sessionId: session.sessionId,
                method: "approval.resolve",
                params: { approvalId, resolution },
              },
              "client_mixedInteraction",
            );
      expect(finalAcceptance.events.some((event) => event.eventType === "run.started")).toBe(true);
      await within(completed, `mixed interaction completion ${label}`);
      expect(resumedInput).toBe(`value:${inputId}`);
      await within(
        (async () => {
          while (actor.snapshot.activeRunId !== null) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        })(),
        `mixed interaction terminal ${label}`,
      );
      await expect(session.getRun(submitted.runId)).resolves.toMatchObject({ state: "completed" });
      await expect(
        session.getToolExecution(`call_mixedInteraction${suffix}`),
      ).resolves.toMatchObject({ state: resolution === "denied" ? "denied" : "cancelled" });
      await actor.shutdown();
    },
  );

  it("restores a pending input without launching work and resumes after its durable response", async () => {
    const manager = await store();
    const created = await manager.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_createRestoredInput",
      method: "session.create",
      params: {},
    });
    const session = await manager.openSession(created.session.sessionId);
    await session.appendTransaction({
      events: [
        {
          eventId: "evt_restoredInputRun",
          eventType: "run.created",
          createdAtMs: 2_000,
          data: { eventVersion: 1, runId: "run_restoredInput" },
        },
        {
          eventId: "evt_restoredInputRequested",
          eventType: "input.requested",
          createdAtMs: 2_001,
          data: {
            eventVersion: 1,
            runId: "run_restoredInput",
            inputId: "input_restoredInput",
            prompt: "Restore?",
          },
        },
      ],
      projections: [
        {
          kind: "run.put",
          runId: "run_restoredInput",
          state: "waiting_for_user",
          providerId: "fake",
          providerConfig: {},
          createdAtMs: 2_000,
          startedAtMs: 2_000,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: null,
        },
        {
          kind: "input.put",
          inputId: "input_restoredInput",
          runId: "run_restoredInput",
          state: "pending",
          prompt: "Restore?",
          requestedAtMs: 2_001,
        },
      ],
    });
    let taskStarted = false;
    let resumedValue: unknown;
    let resumed = (): void => {};
    const inputResumed = new Promise<void>((resolve) => {
      resumed = resolve;
    });
    const monitor = new ActivityMonitor();
    const actor = await SessionActor.create({
      storage: session,
      eventHub: new CommittedEventHub(),
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: actorIds("restoredInput"),
      now: () => 4_000,
      runTaskOwnsSchedulerPermits: true,
      resumeRestoredRuns: true,
      runTask: async (context) => {
        taskStarted = true;
        resumedValue = await context.waitForInput("input_restoredInput");
        resumed();
        return { state: "completed" };
      },
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
      onActivity: () => monitor.signal(),
    });
    expect(taskStarted).toBe(false);

    await actor.respondToInput({
      v: 1,
      kind: "command",
      commandId: "cmd_respondRestoredInput",
      sessionId: session.sessionId,
      method: "input.respond",
      params: { inputId: "input_restoredInput", value: "restored-value" },
    });
    await inputResumed;
    expect(taskStarted).toBe(true);
    expect(resumedValue).toBe("restored-value");
    await monitor.waitFor(() => actor.snapshot.activeRunId === null);
    await actor.shutdown();
  });

  it("replays actor cancellation without storage/client pending-interaction divergence", async () => {
    const manager = await store();
    const created = await manager.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_createPendingCancellation",
      method: "session.create",
      params: {},
    });
    const session = await manager.openSession(created.session.sessionId);
    const seeded = await seedRunWithPendingInteractions(session, "pendingCancellation", "waiting_for_user");
    const monitor = new ActivityMonitor();
    const actor = await SessionActor.create({
      storage: session,
      eventHub: new CommittedEventHub(),
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: actorIds("pendingCancellation"),
      now: () => 3_000,
      runTask: async () => undefined,
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
      onActivity: () => monitor.signal(),
    });

    try {
      expect(actor.snapshot).toMatchObject({ pendingApprovalCount: 1, pendingInputCount: 1 });
      await actor.cancelRun({
        v: 1,
        kind: "command",
        commandId: "cmd_cancelPendingCancellation",
        sessionId: session.sessionId,
        method: "run.cancel",
        params: { runId: seeded.runId },
      });
      await monitor.waitFor(() => actor.snapshot.activeRunId === null);

      const [storageApprovals, storageInputs, events] = await Promise.all([
        session.getPendingApprovals(),
        session.getPendingInputs(),
        session.getEventsAfter(0),
      ]);
      let browserState = createBrowserSessionState(session.sessionId);
      for (const event of events) browserState = reduceSessionEvent(browserState, event);

      expect(storageApprovals).toEqual([]);
      expect(storageInputs).toEqual([]);
      expect(browserState).toMatchObject({
        errorCode: null,
        activeRun: { runId: seeded.runId, state: "cancelled" },
      });
      expect(Object.keys(browserState.pendingApprovals)).toEqual(
        storageApprovals.map((approval) => approval.approvalId),
      );
      expect(Object.keys(browserState.pendingInputs)).toEqual(
        storageInputs.map((input) => input.inputId),
      );
      expect(events.map((event) => event.eventType)).not.toContain("tool.approval.resolved");
      expect(events.map((event) => event.eventType)).not.toContain("input.resolved");
    } finally {
      await actor.shutdown();
    }
  });

  it("replays recovery interruption without storage/client pending-interaction divergence", async () => {
    const manager = await store();
    const created = await manager.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_createPendingRecovery",
      method: "session.create",
      params: {},
    });
    const session = await manager.openSession(created.session.sessionId);
    const seeded = await seedRunWithPendingInteractions(session, "pendingRecovery", "running");
    const actor = await SessionActor.create({
      storage: session,
      eventHub: new CommittedEventHub(),
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: actorIds("pendingRecovery"),
      now: () => 3_000,
      runTask: async () => undefined,
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
    });

    try {
      const [storageApprovals, storageInputs, events] = await Promise.all([
        session.getPendingApprovals(),
        session.getPendingInputs(),
        session.getEventsAfter(0),
      ]);
      let browserState = createBrowserSessionState(session.sessionId);
      for (const event of events) browserState = reduceSessionEvent(browserState, event);

      expect(storageApprovals).toEqual([]);
      expect(storageInputs).toEqual([]);
      expect(browserState).toMatchObject({
        errorCode: null,
        activeRun: { runId: seeded.runId, state: "interrupted" },
      });
      expect(Object.keys(browserState.pendingApprovals)).toEqual(
        storageApprovals.map((approval) => approval.approvalId),
      );
      expect(Object.keys(browserState.pendingInputs)).toEqual(
        storageInputs.map((input) => input.inputId),
      );
      expect(events.map((event) => event.eventType)).not.toContain("tool.approval.resolved");
      expect(events.map((event) => event.eventType)).not.toContain("input.resolved");
    } finally {
      await actor.shutdown();
    }
  });

  it("replays actor-produced queued runs through the client reducer in FIFO order", async () => {
    const manager = await store();
    const created = await manager.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_createClientQueue",
      method: "session.create",
      params: {},
    });
    const session = await manager.openSession(created.session.sessionId);
    const tasks = new ControlledTasks();
    const monitor = new ActivityMonitor();
    const actor = await SessionActor.create({
      storage: session,
      eventHub: new CommittedEventHub(),
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: actorIds("clientQueue"),
      now: () => 2_000,
      runTask: tasks.task,
      cancelRunTask: tasks.cancel,
      forceStopRunTask: () => ({ status: "terminated" }),
      onActivity: () => monitor.signal(),
    });

    try {
      const first = await actor.submitMessage(submit(session.sessionId, "cmd_submitClientQueueA"));
      await tasks.waitFor(first.runId);
      const second = await actor.submitMessage(submit(session.sessionId, "cmd_submitClientQueueB"));
      const throughQueuedCreation = await session.getEventsAfter(0);
      const secondCreated = throughQueuedCreation.find(
        (item) => item.eventType === "run.created" && item.data.runId === second.runId,
      );
      expect(secondCreated).toBeDefined();

      let clientState = createBrowserSessionState(session.sessionId);
      for (const item of throughQueuedCreation) clientState = reduceSessionEvent(clientState, item);
      expect(clientState).toMatchObject({
        errorCode: null,
        activeRun: { runId: first.runId, state: "running" },
        queuedRuns: [{ runId: second.runId, state: "queued" }],
        lastAppliedSequence: secondCreated?.sequence,
      });

      tasks.pending.get(first.runId)?.resolve({ state: "completed" });
      await monitor.waitFor(() => actor.snapshot.activeRunId === second.runId);
      await tasks.waitFor(second.runId);
      const promotedEvents = await session.getEventsAfter(clientState.lastAppliedSequence);
      for (const item of promotedEvents) clientState = reduceSessionEvent(clientState, item);
      expect(clientState).toMatchObject({
        errorCode: null,
        activeRun: { runId: second.runId, state: "running" },
        queuedRuns: [],
      });

      tasks.pending.get(second.runId)?.resolve({ state: "completed" });
      await monitor.waitFor(() => actor.snapshot.activeRunId === null);
    } finally {
      for (const pending of tasks.pending.values()) pending.resolve({ state: "interrupted" });
      await actor.shutdown();
    }
  });

  it("reconstructs equal-timestamp queued runs in durable acceptance order", async () => {
    const manager = await store();
    const created = await manager.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_createQueueOrder",
      method: "session.create",
      params: {},
    });
    const session = await manager.openSession(created.session.sessionId);
    const acceptRun = async (commandId: string, runId: string, eventId: string) =>
      session.acceptCommand({
        commandId,
        commandMethod: "message.submit",
        payloadHash: commandId === "cmd_queueOrderZ" ? "a".repeat(64) : "b".repeat(64),
        result: { runId, queued: true },
        acceptedAtMs: 2_000,
        runId,
        transaction: {
          events: [
            {
              eventId,
              eventType: "run.created",
              createdAtMs: 2_000,
              data: { eventVersion: 1, runId },
            },
          ],
          projections: [
            {
              kind: "run.put",
              runId,
              state: "queued",
              providerId: "milestone-3-task",
              providerConfig: { milestone: 3 },
              createdAtMs: 2_000,
              startedAtMs: null,
              completedAtMs: null,
              cancelledAtMs: null,
              failureCategory: null,
              failureMessage: null,
              activeProviderStepId: null,
            },
          ],
        },
      });
    await acceptRun("cmd_queueOrderZ", "run_zQueueOrder", "evt_queueOrderZ");
    await acceptRun("cmd_queueOrderA", "run_aQueueOrder", "evt_queueOrderA");
    await expect(session.getNonterminalRuns()).resolves.toMatchObject([
      { runId: "run_zQueueOrder" },
      { runId: "run_aQueueOrder" },
    ]);
  });

  it("runs two sessions concurrently and reconstructs an evicted idle actor", async () => {
    const manager = await store({ sessionIds: ["ses_concurrentA", "ses_concurrentB"] });
    const created = await Promise.all([
      manager.createSession({
        v: 1,
        kind: "command",
        commandId: "cmd_createConcurrentA",
        method: "session.create",
        params: {},
      }),
      manager.createSession({
        v: 1,
        kind: "command",
        commandId: "cmd_createConcurrentB",
        method: "session.create",
        params: {},
      }),
    ]);
    const scheduler = new RunScheduler({ providerCapacity: 2, toolCapacity: 1 });
    const tasks = new ControlledTasks();
    const monitors = created.map(() => new ActivityMonitor());
    const actors = await Promise.all(
      created.map(async (value, index) =>
        SessionActor.create({
          storage: await manager.openSession(value.session.sessionId),
          eventHub: new CommittedEventHub(),
          scheduler,
          ids: actorIds(`concurrent${index}`),
          now: () => 2_000 + index,
          runTask: tasks.task,
          cancelRunTask: tasks.cancel,
          forceStopRunTask: () => ({ status: "terminated" }),
          onActivity: () => monitors[index]?.signal(),
        }),
      ),
    );
    const submitted = await Promise.all([
      actors[0]?.submitMessage(submit(actors[0].sessionId, "cmd_submitConcurrentA")),
      actors[1]?.submitMessage(submit(actors[1].sessionId, "cmd_submitConcurrentB")),
    ]);
    const runIds = submitted.map((value) => value?.runId);
    await Promise.all(
      runIds.map(async (runId) => {
        if (runId !== undefined) await tasks.waitFor(runId);
      }),
    );
    expect(scheduler.state.provider.active).toBe(2);
    for (const runId of runIds) {
      if (runId !== undefined) tasks.pending.get(runId)?.resolve({ state: "completed" });
    }
    await Promise.all(
      actors.map((actor, index) =>
        monitors[index]?.waitFor(() => actor.snapshot.activeRunId === null),
      ),
    );

    let now = 0;
    let constructions = 0;
    const registry = new SessionActorRegistry({
      now: () => now,
      idleTimeoutMs: 5,
      createActor: async (sessionId, onActivity, onFault) => {
        constructions += 1;
        return SessionActor.create({
          storage: await manager.openSession(sessionId),
          eventHub: new CommittedEventHub(),
          scheduler,
          ids: actorIds(`registry${constructions}`),
          now: () => 5_000,
          runTask: async () => undefined,
          cancelRunTask: async () => undefined,
          forceStopRunTask: () => ({ status: "terminated" }),
          onActivity,
          onFault,
        });
      },
    });
    const lease = await registry.acquire(created[0].session.sessionId);
    lease.release();
    now = 10;
    await expect(registry.evictIdle()).resolves.toEqual([created[0].session.sessionId]);
    const reacquired = await registry.acquire(created[0].session.sessionId);
    expect(constructions).toBe(2);
    expect(reacquired.actor.snapshot.activeRunId).toBeNull();
    reacquired.release();
    await registry.close();
  });
});
