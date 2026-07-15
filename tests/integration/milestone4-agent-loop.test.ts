import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FakeProviderAdapter,
  FakeProviderController,
  fakeProviderGateLabel,
  type FakeProviderConfiguration,
} from "@wi/provider-fake";
import type { SessionEvent } from "@wi/protocol";
import { SessionStoreManager, type SessionClient } from "@wi/storage";
import {
  ToolExecutor,
  ToolRegistry,
  createBuiltinToolRegistry,
  type DelayInput,
  type DelayWaiter,
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
let fixtureNumber = 0;

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}${++value}`;
}

function ids(prefix: string): { actor: SessionActorIds; loop: AgentRunLoopIds } {
  const actorEvent = sequence(`evt_${prefix}Actor`);
  const loopEvent = sequence(`evt_${prefix}Loop`);
  return {
    actor: {
      runId: sequence(`run_${prefix}`),
      eventId: actorEvent,
      messageId: sequence(`msg_${prefix}Actor`),
      partId: sequence(`part_${prefix}Actor`),
      diagnosticId: sequence(`err_${prefix}Actor`),
    },
    loop: {
      eventId: loopEvent,
      stepId: sequence(`step_${prefix}`),
      messageId: sequence(`msg_${prefix}Loop`),
      partId: sequence(`part_${prefix}Loop`),
      approvalId: sequence(`approval_${prefix}`),
      diagnosticId: sequence(`err_${prefix}Loop`),
    },
  };
}

class SessionEventMonitor {
  readonly events: SessionEvent[] = [];
  private readonly waiters = new Set<{
    readonly predicate: (event: SessionEvent) => boolean;
    readonly resolve: (event: SessionEvent) => void;
  }>();

  readonly record = (event: SessionEvent): void => {
    this.events.push(event);
    for (const waiter of this.waiters) {
      if (!waiter.predicate(event)) continue;
      this.waiters.delete(waiter);
      waiter.resolve(event);
    }
  };

  waitFor(predicate: (event: SessionEvent) => boolean): Promise<SessionEvent> {
    const existing = this.events.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<SessionEvent>((resolve) => {
      this.waiters.add({ predicate, resolve });
    });
  }
}

function isRunTerminalEvent(event: SessionEvent, runId: string): boolean {
  return "runId" in event.data && event.data.runId === runId &&
    (event.eventType === "run.completed" ||
      event.eventType === "run.failed" ||
      event.eventType === "run.cancelled" ||
      event.eventType === "run.interrupted");
}

async function manager(): Promise<SessionStoreManager> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-milestone4-"));
  homes.push(homeDirectory);
  const number = ++fixtureNumber;
  const storage = new SessionStoreManager({
    homeDirectory,
    ids: {
      sessionId: () => `ses_milestone${number}`,
      eventId: () => `evt_sessionCreated${number}`,
    },
    now: () => 1_000,
    sessionWorkers: { size: 2, allowTestOperations: true },
  });
  managers.push(storage);
  return storage;
}

interface Fixture {
  readonly actor: SessionActor;
  readonly session: SessionClient;
  readonly provider: FakeProviderAdapter;
  readonly controller: FakeProviderController;
  readonly executions: string[];
  readonly events: SessionEvent[];
  readonly monitor: SessionEventMonitor;
  readonly runId: string;
}

async function fixture(
  configuration: FakeProviderConfiguration,
  options: {
    readonly delayWaiter?: DelayWaiter;
    readonly registry?: ToolRegistry;
    readonly storageDecorator?: (session: SessionClient) => SessionClient;
    readonly scheduler?: RunScheduler;
    readonly textMaxChars?: number;
    readonly loopEventId?: () => string;
    readonly onFault?: (error: unknown) => void;
  } = {},
): Promise<Fixture> {
  const storage = await manager();
  const created = await storage.createSession({
    v: 1,
    kind: "command",
    commandId: `cmd_create${fixtureNumber}`,
    method: "session.create",
    params: {},
  });
  const rawSession = await storage.openSession(created.session.sessionId);
  const session = options.storageDecorator?.(rawSession) ?? rawSession;
  const controller = new FakeProviderController();
  const provider = new FakeProviderAdapter({ controller });
  const executions: string[] = [];
  const generated = ids(`m${fixtureNumber}`);
  let now = 2_000;
  const runLoop = new AgentRunLoop({
    storage: session,
    provider,
    registry:
      options.registry ??
      createBuiltinToolRegistry(
        options.delayWaiter === undefined ? {} : { delayWaiter: options.delayWaiter },
      ),
    executor: new ToolExecutor({
      onExecutionStart: ({ callId }) => executions.push(callId),
    }),
    ids:
      options.loopEventId === undefined
        ? generated.loop
        : { ...generated.loop, eventId: options.loopEventId },
    textMaxChars: options.textMaxChars ?? 8,
    textMaxDelayMs: 1_000,
  });
  const hub = new CommittedEventHub();
  const monitor = new SessionEventMonitor();
  hub.subscribe(session.sessionId, monitor.record);
  const actor = await SessionActor.create({
    storage: session,
    eventHub: hub,
    scheduler: options.scheduler ?? new RunScheduler({ providerCapacity: 2, toolCapacity: 2 }),
    ids: generated.actor,
    now: () => ++now,
    runTask: runLoop.task,
    currentToolEffectClass: runLoop.currentToolEffectClass,
    cancelRunTask: runLoop.cancel,
    forceStopRunTask: () => ({ status: "terminated" }),
    createRunProviderSnapshot: () => ({
      providerId: "fake",
      providerConfig: {
        scenario: configuration.scenario,
        ...(configuration.roundTripTool === undefined
          ? {}
          : { roundTripTool: configuration.roundTripTool }),
      },
    }),
    runTaskOwnsSchedulerPermits: true,
    resumeRestoredRuns: true,
    ...(options.onFault === undefined ? {} : { onFault: options.onFault }),
  });
  actors.push(actor);
  const submitted = await actor.submitMessage({
    v: 1,
    kind: "command",
    commandId: `cmd_submit${fixtureNumber}`,
    sessionId: session.sessionId,
    method: "message.submit",
    params: { text: "Explicit fake scenario input." },
  });
  return {
    actor,
    session,
    provider,
    controller,
    executions,
    events: monitor.events,
    monitor,
    runId: submitted.runId,
  };
}

async function waitForTerminal(value: Fixture): Promise<NonNullable<Awaited<ReturnType<SessionClient["getRun"]>>>> {
  await value.monitor.waitFor((event) => isRunTerminalEvent(event, value.runId));
  const run = await value.session.getRun(value.runId);
  if (run === null) throw new Error("Run disappeared");
  return run;
}

function cancelCommand(value: Fixture, suffix: string) {
  return {
    v: 1 as const,
    kind: "command" as const,
    commandId: `cmd_cancel${suffix}`,
    sessionId: value.session.sessionId,
    method: "run.cancel" as const,
    params: { runId: value.runId },
  };
}

class ControlledDelay implements DelayWaiter {
  private blockedResolve = (): void => {};
  readonly blocked = new Promise<void>((resolve) => {
    this.blockedResolve = resolve;
  });
  aborted = false;

  wait(_input: DelayInput, signal: AbortSignal): Promise<void> {
    this.blockedResolve();
    return new Promise<void>((_resolve, reject) => {
      const onAbort = (): void => {
        this.aborted = true;
        reject(signal.reason ?? new DOMException("Delay aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

afterEach(async () => {
  await Promise.allSettled(actors.splice(0).map((actor) => actor.shutdown()));
  await Promise.allSettled(managers.splice(0).map((storage) => storage.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("Milestone 4 agent loop with real session databases", () => {
  it("retains the tool permit until asynchronous cancellation cleanup settles", async () => {
    let signalStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseCleanup = (): void => {};
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const registry = new ToolRegistry();
    const echo = createBuiltinToolRegistry().get("echo");
    if (echo === null) throw new Error("Echo definition missing");
    registry.register({
      ...echo,
      name: "controlled_cleanup",
      description: "Controlled asynchronous abort cleanup",
      effectClass: "pure",
      approval: "never",
      timeoutMs: 60_000,
      execute: async (_input, _context, signal) => {
        signalStarted();
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        await cleanup;
        throw signal.reason;
      },
    });
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const parent = new AbortController();
    const executor = new ToolExecutor();
    const first = scheduler.withToolPermit(parent.signal, () =>
      executor.execute(
        registry.validate("controlled_cleanup", '{"text":"cleanup"}'),
        {
          sessionId: "ses_permitCleanup",
          runId: "run_permitCleanup",
          stepId: "step_permitCleanup",
          callId: "call_permitCleanup",
          now: () => 1,
        },
        parent.signal,
      ),
    );
    await started;
    parent.abort(new Error("cancel controlled cleanup"));

    let signalSecondEntered = (): void => {};
    const secondEntered = new Promise<void>((resolve) => {
      signalSecondEntered = resolve;
    });
    const second = scheduler.withToolPermit(undefined, async () => {
      signalSecondEntered();
    });
    await Promise.resolve();
    expect(scheduler.state.tool).toMatchObject({ active: 1, queued: 1 });

    releaseCleanup();
    await expect(first).rejects.toThrow("cancel controlled cleanup");
    await secondEntered;
    await second;
    expect(scheduler.state.tool).toMatchObject({ active: 0, queued: 0, available: 1 });
  });

  it("completes plain text and coalesces durable assistant output", async () => {
    const value = await fixture({ scenario: "plain-text" });
    const run = await waitForTerminal(value);

    expect(run.state).toBe("completed");
    expect(value.executions).toEqual([]);
    await expect(value.session.getRunMessages(value.runId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", state: "completed", text: "Plain fake response." }),
      ]),
    );
  });

  it.each([1, 2] as const)(
    "never projects provider text when delta transaction %s fails before commit",
    async (failedAttempt) => {
      let textCommitAttempt = 0;
      const value = await fixture(
        { scenario: "slow-stream" },
        {
          textMaxChars: 1,
          storageDecorator: (session) =>
            new Proxy(session, {
              get(target, property) {
                if (property === "appendTransaction") {
                  return async (input: Parameters<SessionClient["appendTransaction"]>[0]) => {
                    if (input.events.some((event) => event.eventType === "provider.text.delta")) {
                      textCommitAttempt += 1;
                      if (textCommitAttempt === failedAttempt) {
                        throw new Error("Injected pre-commit text persistence failure");
                      }
                    }
                    return target.appendTransaction(input);
                  };
                }
                const member = Reflect.get(target, property) as unknown;
                return typeof member === "function" ? member.bind(target) : member;
              },
            }) as SessionClient,
        },
      );
      if (failedAttempt === 2) {
        const label = fakeProviderGateLabel(value.runId, "slow");
        await value.controller.waitUntilBlocked(label);
        await value.monitor.waitFor((event) => event.eventType === "provider.text.delta");
        value.controller.release(label);
      }

      await expect(waitForTerminal(value)).resolves.toMatchObject({
        state: "interrupted",
        failureCategory: "storage.worker_failed",
      });
      const events = await value.session.getEventsAfter(0);
      const committedText = events
        .filter((event) => event.eventType === "provider.text.delta")
        .map((event) => event.data.text)
        .join("");
      const messages = await value.session.getRunMessages(value.runId);
      const assistant = messages.find((message) => message.role === "assistant");
      const projectedText = assistant?.text ?? "";
      expect(textCommitAttempt).toBe(failedAttempt);
      expect(projectedText).toBe(committedText);
      if (assistant !== undefined) expect(assistant.state).toBe("interrupted");
      expect(
        events.find((event) => event.eventType === "provider.step.interrupted")?.data.code,
      ).toBe("storage.worker_failed");
    },
  );

  it("commits promotion before echo execution and result before provider continuation", async () => {
    let promotionCommitted = false;
    let resultCommitted = false;
    const value = await fixture(
      { scenario: "echo-tool-round-trip" },
      {
        storageDecorator: (session) =>
          new Proxy(session, {
            get(target, property) {
              if (property === "appendTransaction") {
                return async (input: Parameters<SessionClient["appendTransaction"]>[0]) => {
                  const result = await target.appendTransaction(input);
                  if (input.events.some((event) => event.eventType === "tool.call.requested")) {
                    promotionCommitted = true;
                  }
                  if (input.events.some((event) => event.eventType === "tool.execution.completed")) {
                    resultCommitted = true;
                  }
                  return result;
                };
              }
              const member = Reflect.get(target, property) as unknown;
              return typeof member === "function" ? member.bind(target) : member;
            },
          }) as SessionClient,
      },
    );

    await value.monitor.waitFor(
      (event) => event.eventType === "tool.execution.started" && event.data.callId === "call_echoRoundTrip",
    );
    expect(promotionCommitted).toBe(true);
    const run = await waitForTerminal(value);
    expect(resultCommitted).toBe(true);
    expect(value.provider.requests).toHaveLength(2);
    expect(run.state).toBe("completed");
    expect(value.executions).toEqual(["call_echoRoundTrip"]);

    const events = await value.session.getEventsAfter(0);
    const sequenceOf = (eventType: SessionEvent["eventType"]): number => {
      const event = events.find((candidate) => candidate.eventType === eventType);
      if (event === undefined) throw new Error(`Missing ${eventType}`);
      return event.sequence;
    };
    expect(sequenceOf("provider.step.completed")).toBeLessThan(sequenceOf("tool.call.requested"));
    expect(sequenceOf("tool.call.requested")).toBeLessThan(sequenceOf("tool.execution.started"));
    expect(sequenceOf("tool.execution.completed")).toBeLessThan(
      events.filter((event) => event.eventType === "provider.step.started")[1]?.sequence ?? 0,
    );
  });

  it("reconciles an exact tool-start commit whose worker response is lost", async () => {
    let injected = false;
    const value = await fixture(
      { scenario: "echo-tool-round-trip" },
      {
        storageDecorator: (session) =>
          new Proxy(session, {
            get(target, property) {
              if (property === "appendTransaction") {
                return async (input: Parameters<SessionClient["appendTransaction"]>[0]) => {
                  const result = await target.appendTransaction(input);
                  if (
                    !injected &&
                    input.events.some((event) => event.eventType === "tool.execution.started")
                  ) {
                    injected = true;
                    throw Object.assign(new Error("tool start response lost after commit"), {
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
      },
    );

    await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "completed" });
    expect(injected).toBe(true);
    expect(value.executions).toEqual(["call_echoRoundTrip"]);
    await expect(value.session.getToolExecution("call_echoRoundTrip")).resolves.toMatchObject({
      state: "completed",
      attemptCount: 1,
    });
    const events = await value.session.getEventsAfter(0);
    expect(
      events.filter(
        (event) =>
          event.eventType === "tool.execution.started" &&
          event.data.callId === "call_echoRoundTrip",
      ),
    ).toHaveLength(1);
  });

  it("quarantines an event-ID collision before a tool effect starts", async () => {
    const collisionId = `evt_sessionCreated${fixtureNumber + 1}`;
    let loopEventNumber = 0;
    let signalFault: (error: unknown) => void = () => undefined;
    const faulted = new Promise<unknown>((resolve) => {
      signalFault = resolve;
    });
    const value = await fixture(
      { scenario: "echo-tool-round-trip" },
      {
        loopEventId: () => {
          loopEventNumber += 1;
          return loopEventNumber === 5
            ? collisionId
            : `evt_collisionLoop${loopEventNumber}`;
        },
        onFault: signalFault,
      },
    );
    const existingBefore = await value.session.getEventById(collisionId);
    expect(existingBefore?.eventType).toBe("session.created");

    await expect(faulted).resolves.toMatchObject({
      code: "storage.corrupt",
      name: "EventReconciliationIntegrityError",
    });

    expect(value.executions).toEqual([]);
    expect(value.actor.snapshot.faulted).toBe(true);
    await expect(value.session.getToolExecution("call_echoRoundTrip")).resolves.toMatchObject({
      state: "requested",
      attemptCount: 0,
      effectClass: "pure",
    });
    const events = await value.session.getEventsAfter(0);
    expect(
      events.filter(
        (event) =>
          event.eventType === "tool.execution.started" &&
          event.data.callId === "call_echoRoundTrip",
      ),
    ).toEqual([]);
    expect(
      value.events.filter(
        (event) =>
          event.eventType === "tool.execution.started" &&
          event.data.callId === "call_echoRoundTrip",
      ),
    ).toEqual([]);
    await expect(value.session.getEventById(collisionId)).resolves.toEqual(existingBefore);
    await expect(
      value.actor.submitMessage({
        v: 1,
        kind: "command",
        commandId: `cmd_afterCollision${fixtureNumber}`,
        sessionId: value.session.sessionId,
        method: "message.submit",
        params: { text: "must remain unavailable" },
      }),
    ).rejects.toMatchObject({ code: "session.unavailable" });
  });

  it("serializes terminal completion with simultaneous cancellation without executing", async () => {
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const releaseToolPermit = await scheduler.tool.acquire();
    let signalPromotionEntered = (): void => {};
    const promotionEntered = new Promise<void>((resolve) => {
      signalPromotionEntered = resolve;
    });
    let releasePromotion = (): void => {};
    const promotionGate = new Promise<void>((resolve) => {
      releasePromotion = resolve;
    });
    try {
      const value = await fixture(
        { scenario: "echo-tool-round-trip" },
        {
          scheduler,
          storageDecorator: (session) =>
            new Proxy(session, {
              get(target, property) {
                if (property === "appendTransaction") {
                  return async (input: Parameters<SessionClient["appendTransaction"]>[0]) => {
                    if (input.events.some((event) => event.eventType === "provider.step.completed")) {
                      signalPromotionEntered();
                      await promotionGate;
                    }
                    return target.appendTransaction(input);
                  };
                }
                const member = Reflect.get(target, property) as unknown;
                return typeof member === "function" ? member.bind(target) : member;
              },
            }) as SessionClient,
        },
      );
      await promotionEntered;
      const cancellation = value.actor.cancelRun(cancelCommand(value, "TerminalRace"));
      releasePromotion();
      await cancellation;

      await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "cancelled" });
      expect(value.executions).toEqual([]);
      expect(value.events.filter((event) => event.eventType === "run.cancelled")).toHaveLength(1);
      await expect(value.session.getToolExecution("call_echoRoundTrip")).resolves.toMatchObject({
        state: "cancelled",
        attemptCount: 0,
      });
    } finally {
      releasePromotion();
      releaseToolPermit();
    }
  });

  it("fails the run and discards staged calls when terminal promotion cannot commit", async () => {
    let rejectedPromotion = false;
    const value = await fixture(
      { scenario: "echo-tool-round-trip" },
      {
        storageDecorator: (session) =>
          new Proxy(session, {
            get(target, property) {
              if (property === "appendTransaction") {
                return async (input: Parameters<SessionClient["appendTransaction"]>[0]) => {
                  if (
                    !rejectedPromotion &&
                    input.events.some((event) => event.eventType === "provider.step.completed")
                  ) {
                    rejectedPromotion = true;
                    throw new Error("Injected terminal promotion rejection");
                  }
                  return target.appendTransaction(input);
                };
              }
              const member = Reflect.get(target, property) as unknown;
              return typeof member === "function" ? member.bind(target) : member;
            },
          }) as SessionClient,
      },
    );

    await expect(waitForTerminal(value)).resolves.toMatchObject({
      state: "failed",
      failureCategory: "provider.protocol_error",
    });
    expect(rejectedPromotion).toBe(true);
    expect(value.executions).toEqual([]);
    await expect(value.session.getToolExecution("call_echoRoundTrip")).resolves.toMatchObject({
      state: "discarded",
      attemptCount: 0,
    });
  });

  it.each([
    ["unknown", "call_unknownRoundTrip", "tool.unknown"],
    ["invalid_echo", "call_invalidEchoRoundTrip", "tool.invalid_arguments"],
  ] as const)(
    "persists a structured %s tool validation result and continues",
    async (roundTripTool, callId, code) => {
      const value = await fixture({ scenario: "echo-tool-round-trip", roundTripTool });
      const run = await waitForTerminal(value);
      expect(run.state, run.failureMessage ?? undefined).toBe("completed");
      expect(value.executions).toEqual([]);
      await expect(value.session.getToolExecution(callId)).resolves.toMatchObject({
        state: "failed",
        attemptCount: 0,
        error: { code },
      });
      expect(value.provider.requests).toHaveLength(2);
    },
  );

  it.each([
    ["oversized-tool-arguments", "call_oversizedArguments"],
    ["deeply-nested-tool-arguments", "call_deepArguments"],
  ] as const)("bounds untrusted provider %s before parsing", async (scenario, callId) => {
    const value = await fixture({ scenario });
    await expect(waitForTerminal(value)).resolves.toMatchObject({
      state: "failed",
      failureCategory: "provider.protocol_error",
    });
    expect(value.executions).toEqual([]);
    await expect(value.session.getToolExecution(callId)).resolves.toBeNull();
    const [step] = await value.session.getProviderStepsForRun(value.runId);
    expect(step).toMatchObject({ state: "failed", errorCategory: "provider.protocol_error" });
  });

  it("survives actor recreation while awaiting approval and resumes with zero subscribers", async () => {
    const value = await fixture({ scenario: "approval-round-trip" });
    await value.monitor.waitFor(
      (event) => event.eventType === "run.waiting_for_user" && event.data.reason === "approval",
    );
    expect(value.actor.snapshot.subscriberCount).toBe(0);
    const [approval] = await value.session.getPendingApprovals();
    if (approval === undefined) throw new Error("Approval was not persisted");

    await value.actor.shutdown();
    actors.splice(actors.indexOf(value.actor), 1);
    const storage = managers[0];
    if (storage === undefined) throw new Error("Manager disappeared");
    const session = await storage.openSession(value.session.sessionId);
    const generated = ids("approvalRecreated");
    let now = 5_000;
    const loop = new AgentRunLoop({
      storage: session,
      provider: value.provider,
      registry: createBuiltinToolRegistry(),
      executor: new ToolExecutor({ onExecutionStart: ({ callId }) => value.executions.push(callId) }),
      ids: generated.loop,
    });
    const replacementMonitor = new SessionEventMonitor();
    const replacementHub = new CommittedEventHub();
    replacementHub.subscribe(session.sessionId, replacementMonitor.record);
    const actor = await SessionActor.create({
      storage: session,
      eventHub: replacementHub,
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: generated.actor,
      now: () => ++now,
      runTask: loop.task,
      currentToolEffectClass: loop.currentToolEffectClass,
      cancelRunTask: loop.cancel,
      forceStopRunTask: () => ({ status: "terminated" }),
      createRunProviderSnapshot: () => ({
        providerId: "fake",
        providerConfig: { scenario: "approval-round-trip" },
      }),
      runTaskOwnsSchedulerPermits: true,
      resumeRestoredRuns: true,
    });
    actors.push(actor);

    await actor.resolveApproval(
      {
        v: 1,
        kind: "command",
        commandId: "cmd_approveRecreated",
        sessionId: session.sessionId,
        method: "approval.resolve",
        params: { approvalId: approval.approvalId, resolution: "approved" },
      },
      "client_recreated",
    );
    await replacementMonitor.waitFor((event) => isRunTerminalEvent(event, value.runId));
    await expect(session.getRun(value.runId)).resolves.toMatchObject({ state: "completed" });
    expect(value.executions).toEqual(["call_guardedEchoRoundTrip"]);
  });

  it("rejects approval resolution when the durable effect class changed", async () => {
    const value = await fixture({ scenario: "approval-round-trip" });
    await value.monitor.waitFor(
      (event) => event.eventType === "run.waiting_for_user" && event.data.reason === "approval",
    );
    const [approval] = await value.session.getPendingApprovals();
    if (approval === undefined) throw new Error("Approval was not persisted");
    await value.actor.handoff();
    actors.splice(actors.indexOf(value.actor), 1);

    const storage = managers[0];
    if (storage === undefined) throw new Error("Manager disappeared");
    const session = await storage.openSession(value.session.sessionId);
    const generated = ids("approvalEffectMismatch");
    const replacement = await SessionActor.create({
      storage: session,
      eventHub: new CommittedEventHub(),
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: generated.actor,
      now: () => 7_000,
      runTask: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ state: "interrupted", code: "provider.cancelled" }),
            { once: true },
          );
        }),
      currentToolEffectClass: () => "non_idempotent",
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
      runTaskOwnsSchedulerPermits: true,
      resumeRestoredRuns: true,
    });
    actors.push(replacement);

    await expect(
      replacement.resolveApproval(
        {
          v: 1,
          kind: "command",
          commandId: "cmd_approvalEffectMismatch",
          sessionId: session.sessionId,
          method: "approval.resolve",
          params: { approvalId: approval.approvalId, resolution: "approved" },
        },
        "client_effectMismatch",
      ),
    ).rejects.toMatchObject({ code: "provider.protocol_error", name: "ToolIdentityError" });
    expect(value.executions).toEqual([]);
    await expect(session.getPendingApprovals()).resolves.toHaveLength(1);
    await expect(session.getToolExecution(approval.callId)).resolves.toMatchObject({
      state: "awaiting_approval",
      effectClass: "pure",
      attemptCount: 0,
    });
  });

  it("hands off immediately after approval commit and resumes the approved ledger row", async () => {
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    let signalBlockerEntered = (): void => {};
    const blockerEntered = new Promise<void>((resolve) => {
      signalBlockerEntered = resolve;
    });
    let releaseBlocker = (): void => {};
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = scheduler.withToolPermit(undefined, async () => {
      signalBlockerEntered();
      await blockerGate;
    });
    await blockerEntered;

    const value = await fixture({ scenario: "approval-round-trip" }, { scheduler });
    await value.monitor.waitFor(
      (event) => event.eventType === "run.waiting_for_user" && event.data.reason === "approval",
    );
    const [approval] = await value.session.getPendingApprovals();
    if (approval === undefined) throw new Error("Approval was not persisted");
    await value.actor.resolveApproval(
      {
        v: 1,
        kind: "command",
        commandId: "cmd_approveBeforeHandoff",
        sessionId: value.session.sessionId,
        method: "approval.resolve",
        params: { approvalId: approval.approvalId, resolution: "approved" },
      },
      "client_handoff",
    );
    await value.actor.handoff();
    actors.splice(actors.indexOf(value.actor), 1);

    const storage = managers[0];
    if (storage === undefined) throw new Error("Manager disappeared");
    const session = await storage.openSession(value.session.sessionId);
    await expect(session.getRun(value.runId)).resolves.toMatchObject({ state: "running" });
    await expect(session.getToolExecution(approval.callId)).resolves.toMatchObject({
      state: "approved",
      attemptCount: 0,
    });

    const generated = ids("approvalHandoff");
    let now = 6_000;
    const loop = new AgentRunLoop({
      storage: session,
      provider: value.provider,
      registry: createBuiltinToolRegistry(),
      executor: new ToolExecutor({ onExecutionStart: ({ callId }) => value.executions.push(callId) }),
      ids: generated.loop,
    });
    const replacementMonitor = new SessionEventMonitor();
    const replacementHub = new CommittedEventHub();
    replacementHub.subscribe(session.sessionId, replacementMonitor.record);
    const replacement = await SessionActor.create({
      storage: session,
      eventHub: replacementHub,
      scheduler,
      ids: generated.actor,
      now: () => ++now,
      runTask: loop.task,
      currentToolEffectClass: loop.currentToolEffectClass,
      cancelRunTask: loop.cancel,
      forceStopRunTask: () => ({ status: "terminated" }),
      createRunProviderSnapshot: () => ({
        providerId: "fake",
        providerConfig: { scenario: "approval-round-trip" },
      }),
      runTaskOwnsSchedulerPermits: true,
      resumeRestoredRuns: true,
    });
    actors.push(replacement);
    releaseBlocker();
    await blocker;

    await replacementMonitor.waitFor((event) => isRunTerminalEvent(event, value.runId));
    await expect(session.getRun(value.runId)).resolves.toMatchObject({ state: "completed" });
    await expect(session.getToolExecution(approval.callId)).resolves.toMatchObject({
      state: "completed",
      attemptCount: 1,
    });
    expect(value.executions).toEqual(["call_guardedEchoRoundTrip"]);
  });

  it("resolves approval while cancellation races and records one terminal outcome", async () => {
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const releaseToolPermit = await scheduler.tool.acquire();
    try {
      const value = await fixture({ scenario: "approval-round-trip" }, { scheduler });
      await value.monitor.waitFor(
        (event) => event.eventType === "run.waiting_for_user" && event.data.reason === "approval",
      );
      const [approval] = await value.session.getPendingApprovals();
      if (approval === undefined) throw new Error("Approval was not persisted");
      const resolution = value.actor.resolveApproval(
        {
          v: 1,
          kind: "command",
          commandId: "cmd_approvalRaceResolve",
          sessionId: value.session.sessionId,
          method: "approval.resolve",
          params: { approvalId: approval.approvalId, resolution: "approved" },
        },
        "client_approvalRace",
      );
      const cancellation = value.actor.cancelRun(cancelCommand(value, "ApprovalRace"));
      await Promise.all([resolution, cancellation]);

      await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "cancelled" });
      expect(value.executions).toEqual([]);
      expect(value.events.filter((event) => event.eventType === "tool.approval.resolved"))
        .toHaveLength(1);
      expect(value.events.filter((event) => event.eventType === "run.cancelled")).toHaveLength(1);
      await expect(value.session.getToolExecution(approval.callId)).resolves.toMatchObject({
        state: "cancelled",
        attemptCount: 0,
      });
    } finally {
      releaseToolPermit();
    }
  });

  it("records denial once, executes nothing, and continues with a structured tool result", async () => {
    const value = await fixture({ scenario: "approval-round-trip" });
    await value.monitor.waitFor(
      (event) => event.eventType === "run.waiting_for_user" && event.data.reason === "approval",
    );
    const [approval] = await value.session.getPendingApprovals();
    if (approval === undefined) throw new Error("Approval was not persisted");
    const command = {
      v: 1 as const,
      kind: "command" as const,
      commandId: "cmd_denyGuarded",
      sessionId: value.session.sessionId,
      method: "approval.resolve" as const,
      params: { approvalId: approval.approvalId, resolution: "denied" as const },
    };
    await value.actor.resolveApproval(command, "client_denial");
    await expect(value.actor.resolveApproval(command, "client_denial")).resolves.toMatchObject({
      duplicate: true,
    });
    await expect(
      value.actor.resolveApproval(
        { ...command, commandId: "cmd_denyGuardedSecondTab" },
        "client_secondTab",
      ),
    ).rejects.toMatchObject({ code: "approval.already_resolved" });
    const run = await waitForTerminal(value);
    expect(run.state).toBe("completed");
    expect(value.executions).toEqual([]);
    await expect(value.session.getToolExecution(approval.callId)).resolves.toMatchObject({
      state: "denied",
      error: { code: "tool.approval_denied" },
    });
  });

  it("uses a controlled gate for slow-stream", async () => {
    const value = await fixture({ scenario: "slow-stream" });
    const label = fakeProviderGateLabel(value.runId, "slow");
    await value.controller.waitUntilBlocked(label);
    expect(value.actor.snapshot.activeRunState).toBe("running");
    value.controller.release(label);
    await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "completed" });
  });

  it("flushes and preserves buffered text when cancelled during streaming", async () => {
    const value = await fixture({ scenario: "slow-stream" });
    const label = fakeProviderGateLabel(value.runId, "slow");
    await value.controller.waitUntilBlocked(label);
    await value.actor.cancelRun(cancelCommand(value, "DuringText"));
    await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "cancelled" });
    await expect(value.session.getRunMessages(value.runId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", state: "interrupted", text: "Slow " }),
      ]),
    );
  });

  it("records a started non-idempotent effect as outcome unknown when cancellation wins", async () => {
    const echo = createBuiltinToolRegistry().get("echo");
    if (echo === null) throw new Error("Echo definition missing");
    let effectCount = 0;
    let signalEffectPerformed = (): void => {};
    const effectPerformed = new Promise<void>((resolve) => {
      signalEffectPerformed = resolve;
    });
    const registry = new ToolRegistry();
    registry.register({
      ...echo,
      effectClass: "non_idempotent",
      timeoutMs: 60_000,
      execute: async (_input, _context, signal) => {
        effectCount += 1;
        signalEffectPerformed();
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        throw signal.reason;
      },
    });
    const value = await fixture({ scenario: "echo-tool-round-trip" }, { registry });
    await effectPerformed;

    await value.actor.cancelRun(cancelCommand(value, "NonIdempotentEffect"));
    await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "cancelled" });
    expect(effectCount).toBe(1);
    await expect(value.session.getToolExecution("call_echoRoundTrip")).resolves.toMatchObject({
      state: "outcome_unknown",
      attemptCount: 1,
      error: { code: "tool.outcome_unknown" },
    });
    expect(
      value.events.filter((event) => event.eventType === "tool.execution.outcome_unknown"),
    ).toHaveLength(1);
  });

  it("cancels before semantic provider output", async () => {
    const value = await fixture({ scenario: "cancel-before-output" });
    const label = fakeProviderGateLabel(value.runId, "before-output");
    await value.controller.waitUntilBlocked(label);
    await value.actor.cancelRun(cancelCommand(value, "BeforeOutput"));
    await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "cancelled" });
    expect(value.controller.abortedLabels.has(label)).toBe(true);
    expect(value.executions).toEqual([]);
  });

  it("cancels while waiting for a provider permit", async () => {
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const release = await scheduler.provider.acquire();
    try {
      const value = await fixture({ scenario: "plain-text" }, { scheduler });
      await value.monitor.waitFor((event) => event.eventType === "provider.step.started");
      await value.actor.cancelRun(cancelCommand(value, "ProviderPermit"));
      await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "cancelled" });
      expect(value.provider.requests).toHaveLength(0);
    } finally {
      release();
    }
  });

  it("cancels while waiting for a tool permit before execution starts", async () => {
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const release = await scheduler.tool.acquire();
    try {
      const value = await fixture({ scenario: "echo-tool-round-trip" }, { scheduler });
      await value.monitor.waitFor(
        (event) => event.eventType === "tool.call.requested" && event.data.callId === "call_echoRoundTrip",
      );
      await value.actor.cancelRun(cancelCommand(value, "ToolPermit"));
      await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "cancelled" });
      expect(value.executions).toEqual([]);
      await expect(value.session.getToolExecution("call_echoRoundTrip")).resolves.toMatchObject({
        state: "cancelled",
        attemptCount: 0,
      });
    } finally {
      release();
    }
  });

  it("retries a transient failure only before output", async () => {
    const value = await fixture({ scenario: "transient-failure-before-output" });
    const run = await waitForTerminal(value);
    expect(run.state).toBe("completed");
    expect(value.provider.requests).toHaveLength(2);
    await expect(value.session.getProviderStepsForRun(value.runId)).resolves.toMatchObject([
      { state: "failed", errorCategory: "provider.transient_before_output" },
      { state: "completed" },
    ]);
  });

  it("reconstructs retry budget from only the current provider operation", async () => {
    let transientCommits = 0;
    let signalContinuationFailure = (): void => {};
    const continuationFailure = new Promise<void>((resolve) => {
      signalContinuationFailure = resolve;
    });
    let releaseCommit = (): void => {};
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const value = await fixture(
      { scenario: "multi-operation-transient-recovery" },
      {
        storageDecorator: (session) =>
          new Proxy(session, {
            get(target, property) {
              if (property === "appendTransaction") {
                return async (input: Parameters<SessionClient["appendTransaction"]>[0]) => {
                  const result = await target.appendTransaction(input);
                  if (input.events.some((event) => event.eventType === "provider.step.failed")) {
                    transientCommits += 1;
                    if (transientCommits === 2) {
                      signalContinuationFailure();
                      await commitGate;
                    }
                  }
                  return result;
                };
              }
              const member = Reflect.get(target, property) as unknown;
              return typeof member === "function" ? member.bind(target) : member;
            },
          }) as SessionClient,
      },
    );
    await continuationFailure;
    expect(value.provider.requests).toHaveLength(3);
    const handoff = value.actor.handoff();
    releaseCommit();
    await handoff;
    actors.splice(actors.indexOf(value.actor), 1);

    const storage = managers[0];
    if (storage === undefined) throw new Error("Manager disappeared");
    const session = await storage.openSession(value.session.sessionId);
    const generated = ids("retryRecreated");
    let now = 7_000;
    const loop = new AgentRunLoop({
      storage: session,
      provider: value.provider,
      registry: createBuiltinToolRegistry(),
      executor: new ToolExecutor({ onExecutionStart: ({ callId }) => value.executions.push(callId) }),
      ids: generated.loop,
    });
    const replacementMonitor = new SessionEventMonitor();
    const replacementHub = new CommittedEventHub();
    replacementHub.subscribe(session.sessionId, replacementMonitor.record);
    const replacement = await SessionActor.create({
      storage: session,
      eventHub: replacementHub,
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: generated.actor,
      now: () => ++now,
      runTask: loop.task,
      currentToolEffectClass: loop.currentToolEffectClass,
      cancelRunTask: loop.cancel,
      forceStopRunTask: () => ({ status: "terminated" }),
      createRunProviderSnapshot: () => ({
        providerId: "fake",
        providerConfig: { scenario: "multi-operation-transient-recovery" },
      }),
      runTaskOwnsSchedulerPermits: true,
      resumeRestoredRuns: true,
    });
    actors.push(replacement);

    await replacementMonitor.waitFor((event) => isRunTerminalEvent(event, value.runId));
    await expect(session.getRun(value.runId)).resolves.toMatchObject({ state: "completed" });
    expect(value.provider.requests).toHaveLength(4);
    expect(value.executions).toEqual(["call_multiOperation"]);
    await expect(session.getProviderStepsForRun(value.runId)).resolves.toMatchObject([
      { state: "failed", errorCategory: "provider.transient_before_output" },
      { state: "completed" },
      { state: "failed", errorCategory: "provider.transient_before_output" },
      { state: "completed" },
    ]);
  });

  it("keeps a committed tool result when provider continuation later fails", async () => {
    const value = await fixture({ scenario: "tool-result-then-continuation-failure" });
    await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "interrupted" });
    expect(value.executions).toEqual(["call_committedBeforeContinuationFailure"]);
    expect(value.provider.requests).toHaveLength(2);
    await expect(
      value.session.getToolExecution("call_committedBeforeContinuationFailure"),
    ).resolves.toMatchObject({
      state: "completed",
      attemptCount: 1,
      result: { text: "committed" },
    });
  });

  it("retains visible partial output and interrupts without retry", async () => {
    const value = await fixture({ scenario: "failure-after-visible-output" });
    const run = await waitForTerminal(value);
    expect(run.state).toBe("interrupted");
    expect(value.provider.requests).toHaveLength(1);
    await expect(value.session.getRunMessages(value.runId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          state: "interrupted",
          text: "Visible partial output.",
        }),
      ]),
    );
  });

  it("discards a complete-looking call when the provider has no terminal event", async () => {
    const value = await fixture({ scenario: "partial-tool-call-without-terminal" });
    const label = fakeProviderGateLabel(value.runId, "partial");
    await value.controller.waitUntilBlocked(label);
    value.controller.release(label);
    const run = await waitForTerminal(value);
    expect(run.state).toBe("interrupted");
    expect(value.executions).toEqual([]);
    await expect(value.session.getToolExecution("call_partialWithoutTerminal")).resolves.toMatchObject({
      state: "discarded",
      attemptCount: 0,
    });
  });

  it("cancels after staging but before terminal completion without executing", async () => {
    const value = await fixture({ scenario: "partial-tool-call-without-terminal" });
    const label = fakeProviderGateLabel(value.runId, "partial");
    await value.controller.waitUntilBlocked(label);
    await expect(value.session.getToolExecution("call_partialWithoutTerminal")).resolves.toMatchObject({
      state: "staged",
    });
    await value.actor.cancelRun(cancelCommand(value, "AfterStaging"));
    await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "cancelled" });
    expect(value.executions).toEqual([]);
    await expect(value.session.getToolExecution("call_partialWithoutTerminal")).resolves.toMatchObject({
      state: "discarded",
      attemptCount: 0,
    });
  });

  it("cancels a durable approval wait without executing", async () => {
    const value = await fixture({ scenario: "approval-round-trip" });
    await value.monitor.waitFor(
      (event) => event.eventType === "run.waiting_for_user" && event.data.reason === "approval",
    );
    const [approval] = await value.session.getPendingApprovals();
    if (approval === undefined) throw new Error("Approval was not persisted");
    await value.actor.cancelRun(cancelCommand(value, "ApprovalWait"));
    await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "cancelled" });
    expect(value.executions).toEqual([]);
    await expect(value.session.getPendingApprovals()).resolves.toEqual([]);
    await expect(value.session.getToolExecution(approval.callId)).resolves.toMatchObject({
      state: "cancelled",
    });
  });

  it("deduplicates an identical call ID and executes one ledger row once", async () => {
    const value = await fixture({ scenario: "duplicate-call-id-same-arguments" });
    await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "completed" });
    expect(value.executions).toEqual(["call_duplicateSame"]);
    await expect(value.session.getToolExecutionsForRun(value.runId)).resolves.toHaveLength(1);
  });

  it("reuses an identical call ID emitted by a later provider step", async () => {
    const value = await fixture({ scenario: "duplicate-call-id-later-step" });
    const run = await waitForTerminal(value);
    expect(run.state, run.failureMessage ?? undefined).toBe("completed");
    expect(value.executions).toEqual(["call_laterStepDuplicate"]);
    expect(value.provider.requests).toHaveLength(3);
    await expect(value.session.getToolExecution("call_laterStepDuplicate")).resolves.toMatchObject({
      state: "completed",
      attemptCount: 1,
      stepId: expect.any(String),
    });
    expect(value.events.filter((event) => event.eventType === "provider.tool_call.reused"))
      .toHaveLength(1);
  });

  it("fails a conflicting duplicate call ID without executing it", async () => {
    const value = await fixture({ scenario: "duplicate-call-id-different-arguments" });
    await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "failed" });
    expect(value.executions).toEqual([]);
    await expect(value.session.getToolExecution("call_duplicateDifferent")).resolves.toMatchObject({
      state: "discarded",
      attemptCount: 0,
    });
  });

  it("interrupts a stream that closes without any terminal event", async () => {
    const value = await fixture({ scenario: "stream-closes-without-terminal" });
    await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "interrupted" });
    expect(value.executions).toEqual([]);
  });

  it("aborts a provider that never completes and reaches one cancelled terminal state", async () => {
    const value = await fixture({ scenario: "provider-never-completes-until-aborted" });
    const label = fakeProviderGateLabel(value.runId, "never");
    await value.controller.waitUntilBlocked(label);
    await value.actor.cancelRun(cancelCommand(value, "NeverCompletes"));
    await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "cancelled" });
    expect(value.controller.abortedLabels.has(label)).toBe(true);
    const events = await value.session.getEventsAfter(0);
    expect(events.filter((event) => event.eventType === "run.cancelled")).toHaveLength(1);
  });

  it("propagates cancellation into the controlled delay tool", async () => {
    const delay = new ControlledDelay();
    const value = await fixture(
      { scenario: "echo-tool-round-trip", roundTripTool: "delay" },
      { delayWaiter: delay },
    );
    await delay.blocked;
    await value.actor.cancelRun(cancelCommand(value, "Delay"));
    await expect(waitForTerminal(value)).resolves.toMatchObject({ state: "cancelled" });
    expect(delay.aborted).toBe(true);
    expect(value.executions).toEqual(["call_delayRoundTrip"]);
    await expect(value.session.getToolExecution("call_delayRoundTrip")).resolves.toMatchObject({
      state: "cancelled",
      attemptCount: 1,
    });
  });
});
