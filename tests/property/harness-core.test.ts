import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { RunState, SessionEvent } from "@wi/protocol";
import type {
  AcceptCommandInput,
  AcceptedCommandResult,
  AppendTransactionInput,
  AppendTransactionInspection,
  AppendTransactionResult,
  PendingApprovalRecord,
  PendingInputRecord,
  RunRecord,
  SessionRecoveryResult,
} from "@wi/storage";
import {
  ActorMailbox,
  beginReplaySubscription,
  CommittedEventHub,
  FifoSemaphore,
  recoverSession,
  RunScheduler,
  SessionActor,
  SessionActorRegistry,
  type RunTaskContext,
  type RunTaskResult,
  type SessionActorIds,
  type SessionActorStorage,
} from "../../packages/harness-core/src/index.js";

const seed = Number.parseInt(process.env.WI_FC_SEED ?? "737373", 10);
const path = process.env.WI_FC_PATH;
const options = { numRuns: 1_000, seed, ...(path === undefined ? {} : { path }) } as const;

async function runProperty(
  name: string,
  property: Parameters<typeof fc.assert>[0],
): Promise<void> {
  try {
    await fc.assert(property, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const minimizedPath = /path: "([^"]*)"/i.exec(message)?.[1];
    const pathArgument = minimizedPath === undefined ? "" : ` WI_FC_PATH=${minimizedPath}`;
    throw new Error(
      `${name}\n${message}\nReproduction command: WI_FC_SEED=${seed}${pathArgument} pnpm test:property`,
      { cause: error },
    );
  }
}

function propertyDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class PropertyStorage implements SessionActorStorage {
  readonly runs = new Map<string, RunRecord>();
  readonly commands = new Map<string, AcceptedCommandResult>();
  readonly events: SessionEvent[] = [];
  readonly approvals = new Map<string, PendingApprovalRecord>();
  readonly inputs = new Map<string, PendingInputRecord>();
  recoverActiveRuns = false;
  private sequence = 0;

  constructor(readonly sessionId: string) {}

  private apply(input: AppendTransactionInput): AppendTransactionResult {
    for (const projection of input.projections ?? []) {
      if (projection.kind === "run.put") {
        this.runs.set(projection.runId, {
          runId: projection.runId,
          state: projection.state,
          providerId: projection.providerId,
          providerConfig: projection.providerConfig as RunRecord["providerConfig"],
          createdAtMs: projection.createdAtMs,
          startedAtMs: projection.startedAtMs,
          completedAtMs: projection.completedAtMs,
          cancelledAtMs: projection.cancelledAtMs,
          failureCategory: projection.failureCategory,
          failureMessage: projection.failureMessage,
          activeProviderStepId: projection.activeProviderStepId,
        });
      } else if (projection.kind === "run.state") {
        const current = this.runs.get(projection.runId);
        if (current === undefined || current.state !== projection.expectedState) {
          throw Object.assign(new Error("stale run"), { code: "session.invalid_transition" });
        }
        this.runs.set(projection.runId, {
          ...current,
          state: projection.nextState,
          startedAtMs: projection.startedAtMs,
          completedAtMs: projection.completedAtMs,
          cancelledAtMs: projection.cancelledAtMs,
          failureCategory: projection.failureCategory,
          failureMessage: projection.failureMessage,
          activeProviderStepId: projection.activeProviderStepId,
        });
      } else if (projection.kind === "approval.resolve") {
        if (!this.approvals.delete(projection.approvalId)) {
          throw Object.assign(new Error("approval resolved"), {
            code: "session.invalid_transition",
          });
        }
      } else if (projection.kind === "input.resolve") {
        if (!this.inputs.delete(projection.inputId)) {
          throw Object.assign(new Error("input resolved"), {
            code: "session.invalid_transition",
          });
        }
      } else if (projection.kind === "run.pendingInteractions.cancel") {
        for (const [approvalId, approval] of this.approvals) {
          if (approval.runId === projection.runId) this.approvals.delete(approvalId);
        }
        for (const [inputId, input] of this.inputs) {
          if (input.runId === projection.runId) this.inputs.delete(inputId);
        }
      }
    }
    const committed = input.events.map((value): SessionEvent => ({
      v: 1,
      kind: "event",
      sessionId: this.sessionId,
      sequence: ++this.sequence,
      eventId: value.eventId,
      eventType: value.eventType,
      createdAtMs: value.createdAtMs,
      data: value.data,
    }) as SessionEvent);
    this.events.push(...committed);
    return { events: committed, headSequence: this.sequence };
  }

  async acceptCommand(input: AcceptCommandInput): Promise<AcceptedCommandResult> {
    const existing = this.commands.get(input.commandId);
    if (existing !== undefined) return { ...existing, duplicate: true, events: [] };
    const committed = this.apply(input.transaction);
    const accepted: AcceptedCommandResult = {
      commandId: input.commandId,
      commandMethod: input.commandMethod,
      payloadHash: input.payloadHash,
      acceptedSequence: committed.headSequence,
      runId: input.runId,
      result: input.result as AcceptedCommandResult["result"],
      acceptedAtMs: input.acceptedAtMs,
      duplicate: false,
      events: committed.events,
    };
    this.commands.set(input.commandId, accepted);
    return accepted;
  }

  async appendTransaction(input: AppendTransactionInput): Promise<AppendTransactionResult> {
    return this.apply(input);
  }

  async inspectAppendTransaction(
    input: AppendTransactionInput,
  ): Promise<AppendTransactionInspection> {
    const storedEvents = input.events.map(
      (event) => this.events.find((stored) => stored.eventId === event.eventId) ?? null,
    );
    return {
      storedEvents,
      headSequence: this.sequence,
      projectionsApplied: storedEvents.every((event) => event !== null),
    };
  }

  async getEventsAfter(
    afterSequence: number,
    throughSequence = Number.MAX_SAFE_INTEGER,
  ): Promise<readonly SessionEvent[]> {
    return this.events.filter(
      (event) => event.sequence > afterSequence && event.sequence <= throughSequence,
    );
  }

  async getEventById(eventId: string): Promise<SessionEvent | null> {
    return this.events.find((event) => event.eventId === eventId) ?? null;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async getProviderStep(): Promise<null> {
    return null;
  }

  async getAcceptedCommand(commandId: string): Promise<AcceptedCommandResult | null> {
    const existing = this.commands.get(commandId);
    return existing === undefined ? null : { ...existing, duplicate: true, events: [] };
  }

  async getNonterminalRuns(): Promise<readonly RunRecord[]> {
    return [...this.runs.values()].filter(
      (run) => !["completed", "failed", "cancelled", "interrupted"].includes(run.state),
    );
  }

  async getPendingApprovals(): Promise<readonly PendingApprovalRecord[]> {
    return [...this.approvals.values()];
  }
  async getPendingInputs(): Promise<readonly PendingInputRecord[]> {
    return [...this.inputs.values()];
  }
  async recover(): Promise<SessionRecoveryResult> {
    return {
      interruptedRunIds: this.recoverActiveRuns
        ? [...this.runs.values()]
            .filter((run) => run.state === "running" || run.state === "cancelling")
            .map((run) => run.runId)
        : [],
      interruptedStepIds: [],
      startedToolCalls: [],
    };
  }
}

class PropertyTasks {
  readonly pending = new Map<
    string,
    { readonly context: RunTaskContext; readonly resolve: (result: RunTaskResult) => void }
  >();
  private readonly waiters = new Map<string, () => void>();
  private readonly stopped = new Map<string, Promise<void>>();

  readonly task = (context: RunTaskContext): Promise<RunTaskResult> =>
    new Promise((resolve) => {
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

function propertyIds(): SessionActorIds {
  let value = 0;
  const next = () => ++value;
  return {
    runId: () => `run_propertyActor${next()}`,
    eventId: () => `evt_propertyActor${next()}`,
    messageId: () => `msg_propertyActor${next()}`,
    partId: () => `part_propertyActor${next()}`,
    diagnosticId: () => `err_propertyActor${next()}`,
  };
}

async function settleActorTask(
  actor: SessionActor,
  tasks: PropertyTasks,
  monitor: ActivityMonitor,
  result: RunTaskResult,
): Promise<void> {
  const runId = actor.snapshot.activeRunId;
  if (runId === null) {
    await actor.notifyTaskOutcome("run_propertyMissing", 0, result);
    return;
  }
  await tasks.waitFor(runId);
  tasks.pending.get(runId)?.resolve(result);
  await monitor.waitFor(() => actor.snapshot.activeRunId !== runId);
}

function propertySubmit(sessionId: string, commandId: string, text: string) {
  return {
    v: 1 as const,
    kind: "command" as const,
    commandId,
    sessionId,
    method: "message.submit" as const,
    params: { text },
  };
}

function event(sequence: number): SessionEvent {
  return {
    v: 1,
    kind: "event",
    sessionId: "ses_propertyReplay",
    sequence,
    eventId: `evt_propertyReplay${sequence}`,
    eventType: "run.started",
    createdAtMs: 1_000 + sequence,
    data: { eventVersion: 1, runId: "run_propertyReplay" },
  };
}

type ModelOperation =
  | "submit"
  | "cancel"
  | "taskCompleted"
  | "taskFailed"
  | "staleTaskOutcome"
  | "wrongGenerationOutcome"
  | "cancelMissing"
  | "cancelTerminal"
  | "approvalMissing"
  | "inputMissing"
  | "duplicateSubmit"
  | "publishCommittedEvent"
  | "beginReplay"
  | "recover"
  | "advanceClock"
  | "connectSubscriber"
  | "disconnectSubscriber";

interface ModelSession {
  active: { id: number; state: RunState } | null;
  readonly queued: number[];
  nextRunId: number;
  readonly subscribers: Set<string>;
  readonly terminalByRun: Map<number, RunState>;
}

function modelSession(): ModelSession {
  return {
    active: null,
    queued: [],
    nextRunId: 1,
    subscribers: new Set(),
    terminalByRun: new Map(),
  };
}

function startNext(session: ModelSession): void {
  const id = session.queued.shift();
  session.active = id === undefined ? null : { id, state: "running" };
}

function modelTerminalState(
  currentState: RunState,
  reportedState: "completed" | "failed",
): "completed" | "failed" | "cancelled" | null {
  if (["completed", "failed", "cancelled", "interrupted"].includes(currentState)) return null;
  if (currentState === "cancelling") return "cancelled";
  if (currentState !== "running") return null;
  return reportedState;
}

function applyModel(session: ModelSession, operation: ModelOperation): void {
  switch (operation) {
    case "submit": {
      const id = session.nextRunId++;
      if (session.active === null) session.active = { id, state: "running" };
      else session.queued.push(id);
      return;
    }
    case "cancel":
      if (session.active?.state === "running") session.active.state = "cancelling";
      return;
    case "taskCompleted":
    case "taskFailed": {
      if (session.active === null) return;
      const terminal = modelTerminalState(
        session.active.state,
        operation === "taskCompleted" ? "completed" : "failed",
      );
      if (terminal === null) return;
      const previous = session.terminalByRun.get(session.active.id);
      if (previous !== undefined && previous !== terminal) throw new Error("terminal state changed");
      session.terminalByRun.set(session.active.id, terminal);
      startNext(session);
      return;
    }
    case "staleTaskOutcome":
    case "wrongGenerationOutcome":
    case "cancelMissing":
    case "cancelTerminal":
    case "approvalMissing":
    case "inputMissing":
    case "duplicateSubmit":
    case "publishCommittedEvent":
    case "beginReplay":
    case "recover":
    case "advanceClock":
      return;
    case "connectSubscriber":
      session.subscribers.add("subscriber_property");
      return;
    case "disconnectSubscriber":
      session.subscribers.delete("subscriber_property");
      return;
  }
}

describe("Milestone 3 property models", () => {
  it("preserves mailbox acceptance order for generated command batches", async () => {
    await runProperty(
      "mailbox order matches accepted order",
      fc.asyncProperty(fc.array(fc.integer(), { maxLength: 30 }), async (values) => {
        const mailbox = new ActorMailbox();
        const observed: number[] = [];
        await Promise.all(
          values.map((value) =>
            mailbox.enqueue(async () => {
              await Promise.resolve();
              observed.push(value);
            }),
          ),
        );
        expect(observed).toEqual(values);
        expect(mailbox.state.idle).toBe(true);
      }),
    );
  });

  it("never exceeds semaphore capacity and always restores it", async () => {
    await runProperty(
      "semaphore capacity never exceeded and always restored",
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 16 }),
        async (capacity, taskCount) => {
          const semaphore = new FifoSemaphore(capacity);
          const releases: (() => void)[] = [];
          const gates = Array.from({ length: taskCount }, () => {
            let release = (): void => {};
            const promise = new Promise<void>((resolve) => {
              release = resolve;
            });
            releases.push(release);
            return promise;
          });
          let active = 0;
          let maximum = 0;
          const tasks = gates.map((gate) =>
            semaphore.withPermit(undefined, async () => {
              active += 1;
              maximum = Math.max(maximum, active);
              await gate;
              active -= 1;
            }),
          );
          for (const release of releases) release();
          await Promise.all(tasks);
          expect(maximum).toBeLessThanOrEqual(capacity);
          expect(semaphore.state).toEqual({
            capacity,
            active: 0,
            available: capacity,
            queued: 0,
            accepting: true,
          });
        },
      ),
    );
  });

  it("restores semaphore capacity across generated active and queued cancellations", async () => {
    await runProperty(
      "semaphore cancellation restores every permit",
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 16 }),
        async (capacity, cancellations) => {
          const semaphore = new FifoSemaphore(capacity);
          const controllers = cancellations.map(() => new AbortController());
          let releaseAll = (): void => {};
          const allDone = new Promise<void>((resolve) => {
            releaseAll = resolve;
          });
          const tasks = controllers.map((controller) =>
            semaphore.withPermit(controller.signal, async () => {
              await Promise.race([
                allDone,
                new Promise<void>((resolve) => {
                  controller.signal.addEventListener("abort", () => resolve(), { once: true });
                }),
              ]);
            }),
          );
          cancellations.forEach((cancel, index) => {
            if (cancel) controllers[index]?.abort();
          });
          releaseAll();
          await Promise.allSettled(tasks);
          expect(semaphore.state).toMatchObject({
            active: 0,
            available: capacity,
            queued: 0,
          });
        },
      ),
    );
  });

  it("releases forced-isolation permits before generated cleanup settlements", async () => {
    await runProperty(
      "forced isolation followed by queued acquisition restores capacity exactly once",
      fc.asyncProperty(
        fc.constantFrom("terminated" as const, "detached" as const, "quarantined" as const),
        fc.boolean(),
        async (status, rejectCleanup) => {
          const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
          const firstStorage = new PropertyStorage("ses_propertyIsolationA");
          const secondStorage = new PropertyStorage("ses_propertyIsolationB");
          const firstMonitor = new ActivityMonitor();
          const secondMonitor = new ActivityMonitor();
          const cleanup = propertyDeferred<void>();
          const secondStarted = propertyDeferred<void>();
          const secondResult = propertyDeferred<RunTaskResult>();
          const first = await SessionActor.create({
            storage: firstStorage,
            eventHub: new CommittedEventHub(),
            scheduler,
            ids: propertyIds(),
            now: () => 10,
            runTask: async () => new Promise<RunTaskResult>(() => {}),
            cancelRunTask: async () => new Promise<void>(() => {}),
            cancellationWait: async () => false,
            forceStopRunTask: () => ({ status, cleanup: cleanup.promise }),
            onActivity: () => firstMonitor.signal(),
          });
          const second = await SessionActor.create({
            storage: secondStorage,
            eventHub: new CommittedEventHub(),
            scheduler,
            ids: propertyIds(),
            now: () => 10,
            runTask: async () => {
              secondStarted.resolve();
              return secondResult.promise;
            },
            cancelRunTask: async () => undefined,
            forceStopRunTask: () => ({ status: "terminated" }),
            onActivity: () => secondMonitor.signal(),
          });

          const firstRun = await first.submitMessage(
            propertySubmit(first.sessionId, "cmd_propertyIsolationA", "first"),
          );
          await second.submitMessage(
            propertySubmit(second.sessionId, "cmd_propertyIsolationB", "second"),
          );
          expect(scheduler.state.provider).toMatchObject({ active: 1, queued: 1 });

          await first.cancelRun({
            v: 1,
            kind: "command",
            commandId: "cmd_propertyIsolationCancelA",
            sessionId: first.sessionId,
            method: "run.cancel",
            params: { runId: firstRun.runId },
          });
          await secondStarted.promise;
          await firstMonitor.waitFor(() => first.snapshot.activeRunId === null);

          expect(firstStorage.runs.get(firstRun.runId)?.state).toBe("interrupted");
          expect(
            firstStorage.events.filter((event) => event.eventType === "run.interrupted"),
          ).toHaveLength(1);
          expect(scheduler.state.provider).toMatchObject({
            capacity: 1,
            active: 1,
            available: 0,
            queued: 0,
          });

          if (rejectCleanup) cleanup.reject(new Error("late cleanup failure"));
          else cleanup.resolve();
          await Promise.resolve();
          await Promise.resolve();
          expect(first.snapshot.faulted).toBe(false);
          expect(scheduler.state.provider).toMatchObject({ active: 1, queued: 0 });

          secondResult.resolve({ state: "completed" });
          await secondMonitor.waitFor(() => second.snapshot.activeRunId === null);
          expect(scheduler.state.provider).toMatchObject({ active: 0, available: 1, queued: 0 });
          await Promise.all([first.shutdown(), second.shutdown()]);
        },
      ),
    );
  }, 20_000);

  it("merges replay and concurrently published live events into exact database order", async () => {
    await runProperty(
      "replay + live equals complete ordered database replay",
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }),
        fc.nat(),
        fc.nat(),
        fc.constantFrom("beforeHead" as const, "duringHistory" as const, "afterReplay" as const),
        fc.boolean(),
        async (total, headSelector, cursorSelector, publicationTiming, publishDuplicate) => {
          const initialHead = headSelector % (total + 1);
          const capturedHead = publicationTiming === "beforeHead" ? total : initialHead;
          const cursor = cursorSelector % (capturedHead + 1);
          const hub = new CommittedEventHub();
          const observed: number[] = [];
          let completedThrough = -1;
          const publishLiveSuffix = (): void => {
            for (let sequence = initialHead + 1; sequence <= total; sequence += 1) {
              hub.publishCommitted(event(sequence));
            }
          };
          const subscription = beginReplaySubscription({
            sessionId: "ses_propertyReplay",
            afterSequence: cursor,
            hub,
            source: {
              getHeadSequence: async () => {
                if (publicationTiming === "beforeHead") publishLiveSuffix();
                return capturedHead;
              },
              getEventsAfter: async (after, through) => {
                if (publicationTiming === "duringHistory") publishLiveSuffix();
                return Array.from(
                  { length: Math.max(0, through - after) },
                  (_, index) => event(after + index + 1),
                );
              },
            },
            callbacks: {
              deliver: (value) => {
                observed.push(value.sequence);
              },
              replayComplete: (through) => {
                completedThrough = through;
              },
            },
          });
          await subscription.ready;
          if (publicationTiming === "afterReplay") publishLiveSuffix();
          if (publishDuplicate && total > initialHead) hub.publishCommitted(event(total));
          await subscription.drain();

          expect(completedThrough).toBe(capturedHead);
          expect(observed).toEqual(
            Array.from({ length: total - cursor }, (_, index) => cursor + index + 1),
          );
        },
      ),
    );
  });

  it("composes replay publication with generated subscriber disconnects", async () => {
    await runProperty(
      "disconnect during replay drops buffered live events without blocking publication",
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        fc.nat(),
        fc.nat(),
        fc.boolean(),
        async (total, headSelector, cursorSelector, disconnectDuringQuery) => {
          const head = headSelector % (total + 1);
          const cursor = cursorSelector % (head + 1);
          const hub = new CommittedEventHub();
          const observed: string[] = [];
          let markQueryStarted = (): void => {};
          const queryStarted = new Promise<void>((resolve) => {
            markQueryStarted = resolve;
          });
          let releaseQuery = (): void => {};
          const queryGate = new Promise<void>((resolve) => {
            releaseQuery = resolve;
          });
          const replay = beginReplaySubscription({
            sessionId: "ses_propertyReplay",
            afterSequence: cursor,
            hub,
            source: {
              getHeadSequence: async () => head,
              getEventsAfter: async (after, through) => {
                markQueryStarted();
                await queryGate;
                return Array.from(
                  { length: through - after },
                  (_, index) => event(after + index + 1),
                );
              },
            },
            callbacks: {
              deliver: (value) => {
                observed.push(`event:${value.sequence}`);
              },
              replayComplete: (through) => {
                observed.push(`complete:${through}`);
              },
            },
          });
          await queryStarted;
          for (let sequence = head + 1; sequence <= total; sequence += 1) {
            hub.publishCommitted(event(sequence));
          }
          if (disconnectDuringQuery) replay.unsubscribe();
          releaseQuery();

          if (disconnectDuringQuery) {
            await expect(replay.ready).rejects.toMatchObject({ code: "replay.disconnected" });
            await replay.drain();
            expect(observed).toEqual([]);
            expect(hub.subscriberCount("ses_propertyReplay")).toBe(0);
            return;
          }

          await replay.ready;
          await replay.drain();
          expect(observed).toEqual([
            ...Array.from(
              { length: head - cursor },
              (_, index) => `event:${cursor + index + 1}`,
            ),
            `complete:${head}`,
            ...Array.from(
              { length: total - head },
              (_, index) => `event:${head + index + 1}`,
            ),
          ]);
          replay.unsubscribe();
        },
      ),
    );
  });

  // This core property creates 1,000 actors, so the full parallel workspace needs extra headroom.
  it("composes pending interactions with cancellation, recovery, subscribers, and stale outcomes", async () => {
    const interactionOperation = fc.oneof(
      fc.record({
        type: fc.constant("approval" as const),
        resolution: fc.constantFrom("approved" as const, "denied" as const),
      }),
      fc.record({
        type: fc.constant("input" as const),
        value: fc.constantFrom("yes", "no", null),
      }),
      fc.record({
        type: fc.constantFrom(
          "cancel" as const,
          "connectSubscriber" as const,
          "disconnectSubscriber" as const,
          "recover" as const,
          "staleOutcome" as const,
        ),
      }),
    );
    await runProperty(
      "pending interactions remain single-winner across cancellation and recovery histories",
      fc.asyncProperty(
        fc.array(interactionOperation, { minLength: 1, maxLength: 20 }),
        async (operations) => {
          const storage = new PropertyStorage("ses_propertyApproval");
          storage.runs.set("run_propertyApproval", {
            runId: "run_propertyApproval",
            state: "waiting_for_user",
            providerId: "fake",
            providerConfig: {},
            createdAtMs: 1,
            startedAtMs: 2,
            completedAtMs: null,
            cancelledAtMs: null,
            failureCategory: null,
            failureMessage: null,
            activeProviderStepId: null,
          });
          storage.approvals.set("approval_property", {
            approvalId: "approval_property",
            runId: "run_propertyApproval",
            callId: "call_propertyApproval",
            state: "pending",
            actionDigest: "a".repeat(64),
            requestedAtMs: 3,
          });
          storage.inputs.set("input_property", {
            inputId: "input_property",
            runId: "run_propertyApproval",
            state: "pending",
            prompt: "Continue?",
            requestedAtMs: 3,
          });
          const hub = new CommittedEventHub();
          const actor = await SessionActor.create({
            storage,
            eventHub: hub,
            scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
            ids: propertyIds(),
            now: () => 4,
            runTask: async () => undefined,
            cancelRunTask: async () => undefined,
            forceStopRunTask: () => ({ status: "terminated" }),
          });
          let approvalResolved = false;
          let inputResolved = false;
          let approvalCommitted = false;
          let inputCommitted = false;
          let cancelled = false;
          let subscriberConnected = false;

          for (const [index, operation] of operations.entries()) {
            if (operation.type === "approval") {
              const resolving = actor.resolveApproval(
                {
                  v: 1,
                  kind: "command",
                  commandId: `cmd_propertyApproval${index}`,
                  sessionId: actor.sessionId,
                  method: "approval.resolve",
                  params: {
                    approvalId: "approval_property",
                    resolution: operation.resolution,
                  },
                },
                "client_property",
              );
              if (!approvalResolved && !cancelled) {
                await expect(resolving).resolves.toMatchObject({ duplicate: false });
                approvalResolved = true;
                approvalCommitted = true;
              } else {
                await expect(resolving).rejects.toMatchObject({ code: "approval.already_resolved" });
              }
            } else if (operation.type === "input") {
              const responding = actor.respondToInput({
                v: 1,
                kind: "command",
                commandId: `cmd_propertyInput${index}`,
                sessionId: actor.sessionId,
                method: "input.respond",
                params: { inputId: "input_property", value: operation.value },
              });
              if (!inputResolved && !cancelled) {
                await expect(responding).resolves.toMatchObject({ duplicate: false });
                inputResolved = true;
                inputCommitted = true;
              } else {
                await expect(responding).rejects.toMatchObject({ code: "input.already_resolved" });
              }
            } else if (operation.type === "cancel") {
              await actor.cancelRun({
                v: 1,
                kind: "command",
                commandId: `cmd_propertyInteractionCancel${index}`,
                sessionId: actor.sessionId,
                method: "run.cancel",
                params: { runId: "run_propertyApproval" },
              });
              await actor.flush();
              cancelled = true;
            } else if (operation.type === "connectSubscriber") {
              await actor.subscriberConnected("subscriber_propertyInteraction");
              subscriberConnected = true;
            } else if (operation.type === "disconnectSubscriber") {
              await actor.subscriberDisconnected("subscriber_propertyInteraction");
              subscriberConnected = false;
            } else if (operation.type === "recover") {
              await recoverSession({
                sessionId: storage.sessionId,
                storage,
                now: () => 5,
                eventId: () => `evt_propertyInteractionRecovery${index}`,
                diagnosticId: () => `err_propertyInteractionRecovery${index}`,
                publishCommitted: (event) => hub.publishCommitted(event),
              });
            } else {
              await actor.notifyTaskOutcome("run_propertyApproval", 0, { state: "completed" });
            }

            if (cancelled) {
              approvalResolved = true;
              inputResolved = true;
            }
            expect(actor.snapshot).toMatchObject({
              subscriberCount: subscriberConnected ? 1 : 0,
              pendingApprovalCount: approvalResolved ? 0 : 1,
              pendingInputCount: inputResolved ? 0 : 1,
            });
          }

          expect(
            storage.events.filter((event) => event.eventType === "tool.approval.resolved"),
          ).toHaveLength(approvalCommitted ? 1 : 0);
          expect(storage.events.filter((event) => event.eventType === "input.resolved")).toHaveLength(
            inputCommitted ? 1 : 0,
          );
          expect(
            storage.events.filter((event) =>
              ["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(
                event.eventType,
              ),
            ).length,
          ).toBeLessThanOrEqual(1);
          await actor.shutdown();
        },
      ),
    );
  }, 20_000);

  it("composes recovery with cancellation, late task outcomes, subscribers, and replay", async () => {
    await runProperty(
      "recovery dominates late task outcomes in composed actor histories",
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom("completed" as const, "failed" as const),
        fc.integer({ min: 1, max: 3 }),
        fc.nat(),
        async (
          cancelBeforeRecovery,
          connectBeforeRecovery,
          disconnectAfterRecovery,
          taskOutcome,
          recoveryCount,
          cursorSelector,
        ) => {
          const storage = new PropertyStorage("ses_propertyRecoveryActor");
          const tasks = new PropertyTasks();
          const monitor = new ActivityMonitor();
          const hub = new CommittedEventHub();
          const actor = await SessionActor.create({
            storage,
            eventHub: hub,
            scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
            ids: propertyIds(),
            now: () => 10,
            runTask: tasks.task,
            cancelRunTask: tasks.cancel,
            forceStopRunTask: () => ({ status: "terminated" }),
            onActivity: () => monitor.signal(),
          });
          const submitted = await actor.submitMessage(
            propertySubmit(actor.sessionId, "cmd_propertyRecoveryActor", "recover me"),
          );
          await tasks.waitFor(submitted.runId);

          if (connectBeforeRecovery) {
            await actor.subscriberConnected("subscriber_propertyRecoveryActor");
          }
          if (cancelBeforeRecovery) {
            await actor.cancelRun({
              v: 1,
              kind: "command",
              commandId: "cmd_propertyRecoveryActorCancel",
              sessionId: actor.sessionId,
              method: "run.cancel",
              params: { runId: submitted.runId },
            });
          }

          storage.recoverActiveRuns = true;
          for (let index = 0; index < recoveryCount; index += 1) {
            await recoverSession({
              sessionId: storage.sessionId,
              storage,
              now: () => 20 + index,
              eventId: () => `evt_propertyRecoveryActor${index}`,
              diagnosticId: () => `err_propertyRecoveryActor${index}`,
              publishCommitted: (event) => hub.publishCommitted(event),
            });
          }
          if (disconnectAfterRecovery) {
            await actor.subscriberDisconnected("subscriber_propertyRecoveryActor");
          }

          tasks.pending.get(submitted.runId)?.resolve({ state: taskOutcome });
          await monitor.waitFor(() => actor.snapshot.activeRunId === null);
          await actor.flush();

          expect(storage.runs.get(submitted.runId)?.state).toBe("interrupted");
          expect(
            storage.events.filter((event) =>
              ["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(
                event.eventType,
              ),
            ),
          ).toHaveLength(1);
          expect(actor.snapshot.subscriberCount).toBe(
            connectBeforeRecovery && !disconnectAfterRecovery ? 1 : 0,
          );

          const cursor = cursorSelector % (storage.events.length + 1);
          const observed: number[] = [];
          const replay = beginReplaySubscription({
            sessionId: actor.sessionId,
            afterSequence: cursor,
            hub: new CommittedEventHub(),
            source: {
              getHeadSequence: async () => storage.events.length,
              getEventsAfter: async (after, through) =>
                storage.events.filter(
                  (event) => event.sequence > after && event.sequence <= through,
                ),
            },
            callbacks: {
              deliver: (event) => {
                observed.push(event.sequence);
              },
              replayComplete: () => undefined,
            },
          });
          await replay.ready;
          expect(observed).toEqual(
            storage.events.filter((event) => event.sequence > cursor).map((event) => event.sequence),
          );
          replay.unsubscribe();
          await actor.shutdown();
        },
      ),
    );
  }, 20_000);

  it("keeps generated recovery histories idempotent and terminal-safe", async () => {
    await runProperty(
      "recovery is idempotent for every run state",
      fc.asyncProperty(
        fc.constantFrom<RunState>(
          "created",
          "queued",
          "running",
          "waiting_for_user",
          "cancelling",
          "completed",
          "failed",
          "cancelled",
          "interrupted",
        ),
        async (initialState) => {
          let run: RunRecord = {
            runId: "run_propertyRecovery",
            state: initialState,
            providerId: "fake",
            providerConfig: {},
            createdAtMs: 1,
            startedAtMs: ["running", "waiting_for_user", "cancelling"].includes(initialState)
              ? 2
              : null,
            completedAtMs: ["completed", "failed", "interrupted"].includes(initialState)
              ? 3
              : null,
            cancelledAtMs: initialState === "cancelled" ? 3 : null,
            failureCategory: null,
            failureMessage: null,
            activeProviderStepId: null,
          };
          const events: SessionEvent[] = [];
          const storage = {
            recover: async (): Promise<SessionRecoveryResult> => ({
              interruptedRunIds: ["running", "cancelling"].includes(run.state)
                ? [run.runId]
                : [],
              interruptedStepIds: [],
              startedToolCalls: [],
            }),
            getRun: async () => run,
            getEventById: async () => null,
            inspectAppendTransaction: async (input: AppendTransactionInput) => ({
              storedEvents: input.events.map(() => null),
              headSequence: events.length,
              projectionsApplied: false,
            }),
            getProviderStep: async () => null,
            appendTransaction: async (input: AppendTransactionInput) => {
              const projection = input.projections?.find(
                (candidate) => candidate.kind === "run.state",
              );
              if (projection?.kind !== "run.state" || run.state !== projection.expectedState) {
                throw Object.assign(new Error("run CAS failed"), {
                  code: "session.invalid_transition",
                });
              }
              run = {
                ...run,
                state: projection.nextState,
                completedAtMs: projection.completedAtMs,
                cancelledAtMs: projection.cancelledAtMs,
                failureCategory: projection.failureCategory,
                failureMessage: projection.failureMessage,
              };
              const committed = input.events.map(
                (value): SessionEvent =>
                  ({
                    v: 1,
                    kind: "event",
                    sessionId: "ses_propertyRecovery",
                    sequence: events.length + 1,
                    eventId: value.eventId,
                    eventType: value.eventType,
                    createdAtMs: value.createdAtMs,
                    data: value.data,
                  }) as SessionEvent,
              );
              events.push(...committed);
              return { events: committed, headSequence: events.length };
            },
          };
          let eventId = 0;
          const recover = () =>
            recoverSession({
              sessionId: "ses_propertyRecovery",
              storage,
              now: () => 10,
              eventId: () => `evt_propertyRecovery${++eventId}`,
              diagnosticId: () => `err_propertyRecovery${eventId}`,
              publishCommitted: () => undefined,
            });

          await recover();
          await recover();
          const shouldInterrupt = initialState === "running" || initialState === "cancelling";
          expect(run.state).toBe(shouldInterrupt ? "interrupted" : initialState);
          expect(events.filter((event) => event.eventType === "run.interrupted")).toHaveLength(
            shouldInterrupt ? 1 : 0,
          );
        },
      ),
    );
  });

  it("evicts only generated actors with no blocker across random lifecycle histories", async () => {
    const operation = fc.record({
      type: fc.constantFrom(
        "acquire" as const,
        "release" as const,
        "block" as const,
        "becomeIdle" as const,
        "activity" as const,
        "advanceClock" as const,
        "evict" as const,
      ),
      elapsedMs: fc.nat({ max: 20 }),
    });
    await runProperty(
      "eviction requires every blocker to be absent across lifecycle histories",
      fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 30 }), async (operations) => {
        let clock = 0;
        let actorIdle = true;
        let signalActivity = (): void => {};
        const leases: { readonly release: () => void }[] = [];
        const registry = new SessionActorRegistry({
          createActor: async (_sessionId, onActivity) => {
            actorIdle = true;
            signalActivity = onActivity;
            return {
              isIdle: () => actorIdle,
              shutdown: async () => undefined,
            } as unknown as SessionActor;
          },
          now: () => clock,
          idleTimeoutMs: 10,
        });

        for (const item of operations) {
          switch (item.type) {
            case "acquire":
              leases.push(await registry.acquire("ses_propertyEviction"));
              break;
            case "release":
              leases.pop()?.release();
              break;
            case "block":
              if (registry.states().length > 0) {
                actorIdle = false;
                signalActivity();
              }
              break;
            case "becomeIdle":
              if (registry.states().length > 0) {
                actorIdle = true;
                signalActivity();
              }
              break;
            case "activity":
              if (registry.states().length > 0) signalActivity();
              break;
            case "advanceClock":
              clock += item.elapsedMs;
              break;
            case "evict": {
              const before = registry.states()[0];
              const shouldEvict =
                before !== undefined &&
                before.references === 0 &&
                actorIdle &&
                clock - before.lastActivityMs >= 10;
              expect(await registry.evictIdle()).toEqual(
                shouldEvict ? ["ses_propertyEviction"] : [],
              );
              break;
            }
          }

          const state = registry.states()[0];
          if (state !== undefined) expect(state.references).toBe(leases.length);
          else expect(leases).toHaveLength(0);
        }

        for (const lease of leases.splice(0)) lease.release();
        await registry.close();
      }),
    );
  });

  it("maintains actor invariants across random operations in isolated sessions", async () => {
    const operation = fc.record({
      session: fc.constantFrom("left" as const, "right" as const),
      operation: fc.constantFrom<ModelOperation>(
        "submit",
        "cancel",
        "taskCompleted",
        "taskFailed",
        "staleTaskOutcome",
        "wrongGenerationOutcome",
        "cancelMissing",
        "cancelTerminal",
        "approvalMissing",
        "inputMissing",
        "duplicateSubmit",
        "publishCommittedEvent",
        "beginReplay",
        "recover",
        "advanceClock",
        "connectSubscriber",
        "disconnectSubscriber",
      ),
    });
    await runProperty(
      "real actors preserve one active run, terminal uniqueness, subscriber independence, and session isolation",
      fc.asyncProperty(fc.array(operation, { maxLength: 20 }), async (operations) => {
        const models = { left: modelSession(), right: modelSession() };
        const actualRunIds = {
          left: new Map<number, string>(),
          right: new Map<number, string>(),
        };
        const storages = {
          left: new PropertyStorage("ses_propertyLeft"),
          right: new PropertyStorage("ses_propertyRight"),
        };
        const tasks = { left: new PropertyTasks(), right: new PropertyTasks() };
        const monitors = { left: new ActivityMonitor(), right: new ActivityMonitor() };
        const hubs = { left: new CommittedEventHub(), right: new CommittedEventHub() };
        const submittedCommands = {
          left: [] as { readonly command: ReturnType<typeof propertySubmit>; readonly runId: string }[],
          right: [] as { readonly command: ReturnType<typeof propertySubmit>; readonly runId: string }[],
        };
        let now = 1_000;
        const scheduler = new RunScheduler({ providerCapacity: 2, toolCapacity: 2 });
        const actors = {
          left: await SessionActor.create({
            storage: storages.left,
            eventHub: hubs.left,
            scheduler,
            ids: propertyIds(),
            now: () => ++now,
            runTask: tasks.left.task,
            cancelRunTask: tasks.left.cancel,
            forceStopRunTask: () => ({ status: "terminated" }),
            onActivity: () => monitors.left.signal(),
          }),
          right: await SessionActor.create({
            storage: storages.right,
            eventHub: hubs.right,
            scheduler,
            ids: propertyIds(),
            now: () => ++now,
            runTask: tasks.right.task,
            cancelRunTask: tasks.right.cancel,
            forceStopRunTask: () => ({ status: "terminated" }),
            onActivity: () => monitors.right.signal(),
          }),
        };

        for (const [index, item] of operations.entries()) {
          const model = models[item.session];
          const actor = actors[item.session];
          const actorTasks = tasks[item.session];
          const actorMonitor = monitors[item.session];
          const otherActor = item.session === "left" ? actors.right : actors.left;
          const otherBefore = {
            activeRunId: otherActor.snapshot.activeRunId,
            activeRunState: otherActor.snapshot.activeRunState,
            queuedRunIds: otherActor.snapshot.queuedRunIds,
            subscriberCount: otherActor.snapshot.subscriberCount,
            pendingApprovalCount: otherActor.snapshot.pendingApprovalCount,
            pendingInputCount: otherActor.snapshot.pendingInputCount,
          };
          const stateBeforeSubscriber = actor.snapshot.activeRunState;
          applyModel(model, item.operation);

          switch (item.operation) {
            case "submit": {
              const modelRunId = model.nextRunId - 1;
              const command = propertySubmit(
                actor.sessionId,
                `cmd_property${item.session}${index}`,
                `message ${index}`,
              );
              const submitted = await actor.submitMessage(command);
              submittedCommands[item.session].push({ command, runId: submitted.runId });
              actualRunIds[item.session].set(modelRunId, submitted.runId);
              break;
            }
            case "cancel": {
              const runId = actor.snapshot.activeRunId;
              const cancelling = actor.cancelRun({
                v: 1,
                kind: "command",
                commandId: `cmd_propertyCancel${item.session}${index}`,
                sessionId: actor.sessionId,
                method: "run.cancel",
                params: { runId: runId ?? `run_missingCancel${item.session}${index}` },
              });
              if (runId === null) {
                await expect(cancelling).rejects.toMatchObject({ code: "session.not_found" });
              } else {
                await expect(cancelling).resolves.toBeDefined();
              }
              break;
            }
            case "taskCompleted":
              await settleActorTask(actor, actorTasks, actorMonitor, { state: "completed" });
              break;
            case "taskFailed":
              await settleActorTask(actor, actorTasks, actorMonitor, { state: "failed" });
              break;
            case "staleTaskOutcome": {
              const stale = [...actorTasks.pending.values()].find(
                (task) => task.context.runId !== actor.snapshot.activeRunId,
              );
              if (stale !== undefined) {
                await actor.notifyTaskOutcome(stale.context.runId, stale.context.generation, {
                  state: "failed",
                });
              } else {
                await actor.notifyTaskOutcome("run_propertyStale", 0, { state: "failed" });
              }
              break;
            }
            case "wrongGenerationOutcome": {
              const activeTask = [...actorTasks.pending.values()].find(
                (task) => task.context.runId === actor.snapshot.activeRunId,
              );
              if (activeTask !== undefined) {
                await actor.notifyTaskOutcome(
                  activeTask.context.runId,
                  activeTask.context.generation + 1,
                  { state: "failed" },
                );
              } else {
                await actor.notifyTaskOutcome("run_propertyWrongGeneration", 1, {
                  state: "failed",
                });
              }
              break;
            }
            case "cancelMissing":
              await expect(
                actor.cancelRun({
                  v: 1,
                  kind: "command",
                  commandId: `cmd_propertyMissing${item.session}${index}`,
                  sessionId: actor.sessionId,
                  method: "run.cancel",
                  params: { runId: `run_missing${item.session}${index}` },
                }),
              ).rejects.toMatchObject({ code: "session.not_found" });
              break;
            case "cancelTerminal": {
              const terminalModelId = model.terminalByRun.keys().next().value as number | undefined;
              const terminalRunId =
                terminalModelId === undefined
                  ? undefined
                  : actualRunIds[item.session].get(terminalModelId);
              const cancelling = actor.cancelRun({
                v: 1,
                kind: "command",
                commandId: `cmd_propertyTerminal${item.session}${index}`,
                sessionId: actor.sessionId,
                method: "run.cancel",
                params: {
                  runId: terminalRunId ?? `run_missingTerminal${item.session}${index}`,
                },
              });
              if (terminalRunId === undefined) {
                await expect(cancelling).rejects.toMatchObject({ code: "session.not_found" });
              } else {
                await expect(cancelling).resolves.toMatchObject({
                  state: model.terminalByRun.get(terminalModelId as number),
                });
              }
              break;
            }
            case "approvalMissing":
              await expect(
                actor.resolveApproval(
                  {
                    v: 1,
                    kind: "command",
                    commandId: `cmd_propertyMissingApproval${item.session}${index}`,
                    sessionId: actor.sessionId,
                    method: "approval.resolve",
                    params: {
                      approvalId: `approval_missing${item.session}${index}`,
                      resolution: "approved",
                    },
                  },
                  "client_property",
                ),
              ).rejects.toMatchObject({ code: "approval.already_resolved" });
              break;
            case "inputMissing":
              await expect(
                actor.respondToInput({
                  v: 1,
                  kind: "command",
                  commandId: `cmd_propertyMissingInput${item.session}${index}`,
                  sessionId: actor.sessionId,
                  method: "input.respond",
                  params: {
                    inputId: `input_missing${item.session}${index}`,
                    value: "ignored",
                  },
                }),
              ).rejects.toMatchObject({ code: "input.already_resolved" });
              break;
            case "duplicateSubmit": {
              const original = submittedCommands[item.session][0];
              if (original !== undefined) {
                await expect(actor.submitMessage(original.command)).resolves.toMatchObject({
                  runId: original.runId,
                  acceptance: { duplicate: true },
                });
              }
              break;
            }
            case "publishCommittedEvent": {
              const committed = storages[item.session].events.at(-1);
              if (committed !== undefined) {
                expect(hubs[item.session].publishCommitted(committed)).toBe("duplicate");
              }
              break;
            }
            case "beginReplay": {
              const committed = storages[item.session].events;
              const cursor = committed.length === 0 ? 0 : index % (committed.length + 1);
              const observed: number[] = [];
              const replay = beginReplaySubscription({
                sessionId: actor.sessionId,
                afterSequence: cursor,
                hub: new CommittedEventHub(),
                source: {
                  getHeadSequence: async () => committed.length,
                  getEventsAfter: async (after, through) =>
                    committed.filter(
                      (event) => event.sequence > after && event.sequence <= through,
                    ),
                },
                callbacks: {
                  deliver: (event) => {
                    observed.push(event.sequence);
                  },
                  replayComplete: () => undefined,
                },
              });
              await replay.ready;
              expect(observed).toEqual(
                committed.filter((event) => event.sequence > cursor).map((event) => event.sequence),
              );
              replay.unsubscribe();
              break;
            }
            case "recover": {
              const eventCount = storages[item.session].events.length;
              await recoverSession({
                sessionId: storages[item.session].sessionId,
                storage: storages[item.session],
                now: () => ++now,
                eventId: () => `evt_propertyNoopRecovery${item.session}${index}`,
                diagnosticId: () => `err_propertyNoopRecovery${item.session}${index}`,
                publishCommitted: (event) => hubs[item.session].publishCommitted(event),
              });
              expect(storages[item.session].events).toHaveLength(eventCount);
              break;
            }
            case "advanceClock":
              now += index + 1;
              break;
            case "connectSubscriber":
              await actor.subscriberConnected("subscriber_property");
              break;
            case "disconnectSubscriber":
              await actor.subscriberDisconnected("subscriber_property");
              break;
          }

          if (item.operation === "connectSubscriber" || item.operation === "disconnectSubscriber") {
            expect(actor.snapshot.activeRunState).toBe(stateBeforeSubscriber);
          }
          const expectedActiveRunId =
            model.active === null ? null : (actualRunIds[item.session].get(model.active.id) ?? null);
          expect(actor.snapshot).toMatchObject({
            activeRunId: expectedActiveRunId,
            activeRunState: model.active?.state ?? null,
            queuedRunIds: model.queued.map((id) => actualRunIds[item.session].get(id)),
            subscriberCount: model.subscribers.size,
          });
          const terminalCounts = new Map<string, number>();
          for (const value of storages[item.session].events) {
            if (["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(value.eventType)) {
              const runId = (value.data as { runId: string }).runId;
              terminalCounts.set(runId, (terminalCounts.get(runId) ?? 0) + 1);
            }
          }
          expect([...terminalCounts.values()].every((count) => count === 1)).toBe(true);
          expect(terminalCounts.size).toBe(model.terminalByRun.size);
          expect(storages[item.session].events.map((value) => value.sequence)).toEqual(
            storages[item.session].events.map((_value, sequence) => sequence + 1),
          );
          expect(otherActor.snapshot).toMatchObject(otherBefore);
        }

        for (const side of ["left", "right"] as const) {
          for (let remaining = operations.length + 1; remaining > 0; remaining -= 1) {
            if (actors[side].snapshot.activeRunId === null) break;
            await settleActorTask(
              actors[side],
              tasks[side],
              monitors[side],
              { state: "completed" },
            );
          }
          await actors[side].shutdown();
        }
      }),
    );
  });
});
