import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@wi/protocol";

import {
  CommittedEventHub,
  EventHubBackpressureError,
  EventHubIntegrityError,
} from "./event-hub.js";
import { beginReplaySubscription, ReplaySubscriptionError } from "./replay-subscription.js";

function event(sequence: number, eventId = `evt_replay${sequence}`): SessionEvent {
  return {
    v: 1,
    kind: "event",
    sessionId: "ses_replay",
    sequence,
    eventId,
    eventType: "run.started",
    createdAtMs: 1_000 + sequence,
    data: { eventVersion: 1, runId: "run_replay" },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type ObservedPromise =
  | { readonly status: "fulfilled"; readonly value: unknown }
  | { readonly status: "rejected"; readonly reason: unknown }
  | { readonly status: "pending" };

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function rejectableDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (reason: unknown) => void;
} {
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

async function observePromise(promise: Promise<unknown>): Promise<ObservedPromise> {
  const settled: Promise<ObservedPromise> = promise.then(
    (value): ObservedPromise => ({ status: "fulfilled", value }),
    (reason: unknown): ObservedPromise => ({ status: "rejected", reason }),
  );
  const timedOut = new Promise<ObservedPromise>((resolve) => {
    setTimeout(() => resolve({ status: "pending" }), 1);
  });
  const outcome = Promise.race([settled, timedOut]);
  await vi.advanceTimersByTimeAsync(1);
  return outcome;
}

describe("CommittedEventHub", () => {
  it("isolates subscriber failures and never waits for a slow subscriber", async () => {
    const hub = new CommittedEventHub();
    const slow = deferred();
    const healthy: number[] = [];
    const errors: unknown[] = [];
    let resolveHealthy = (): void => {};
    let resolveErrors = (): void => {};
    const healthyDelivered = new Promise<void>((resolve) => {
      resolveHealthy = resolve;
    });
    const errorsDelivered = new Promise<void>((resolve) => {
      resolveErrors = resolve;
    });
    hub.subscribe("ses_replay", async () => slow.promise);
    hub.subscribe(
      "ses_replay",
      () => {
        throw new Error("subscriber failed");
      },
      (error) => {
        errors.push(error);
        resolveErrors();
      },
    );
    hub.subscribe("ses_replay", (value) => {
      healthy.push(value.sequence);
      if (healthy.length === 2) resolveHealthy();
    });

    expect(hub.publishCommitted(event(1))).toBe("published");
    expect(hub.publishCommitted(event(2))).toBe("published");
    await Promise.all([healthyDelivered, errorsDelivered]);
    expect(healthy).toEqual([1, 2]);
    expect(errors).toHaveLength(1);
    expect(hub.subscriberCount("ses_replay")).toBe(2);
    slow.resolve();
  });

  it("disconnects a subscriber whose bounded backlog fills", async () => {
    const hub = new CommittedEventHub({ maxSubscriberBacklog: 2 });
    const slow = deferred();
    const errorReported = deferred();
    const errors: unknown[] = [];
    hub.subscribe(
      "ses_replay",
      async () => slow.promise,
      (error) => {
        errors.push(error);
        errorReported.resolve();
      },
    );

    hub.publishCommitted(event(1));
    hub.publishCommitted(event(2));
    hub.publishCommitted(event(3));
    await errorReported.promise;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(EventHubBackpressureError);
    expect(hub.subscriberCount("ses_replay")).toBe(0);
    expect(hub.releaseSession("ses_replay")).toBe(true);
    slow.resolve();
  });

  it("reports an asynchronously rejected immediate subscriber without blocking publication", async () => {
    const hub = new CommittedEventHub();
    let reportError = (): void => {};
    const errorReported = new Promise<void>((resolve) => {
      reportError = resolve;
    });
    const errors: unknown[] = [];
    hub.subscribeCommittedQueue(
      "ses_replay",
      async () => {
        throw new Error("immediate subscriber failed");
      },
      (error) => {
        errors.push(error);
        reportError();
      },
    );

    expect(hub.publishCommitted(event(1))).toBe("published");
    await errorReported;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "immediate subscriber failed" });
  });

  it("serializes asynchronous committed-queue delivery in session order", async () => {
    const hub = new CommittedEventHub();
    const releaseFirst = deferred();
    const delivered = deferred();
    const observed: number[] = [];
    hub.subscribeCommittedQueue("ses_replay", async (value) => {
      if (value.sequence === 1) await releaseFirst.promise;
      observed.push(value.sequence);
      if (observed.length === 2) delivered.resolve();
    });

    hub.publishCommitted(event(1));
    hub.publishCommitted(event(2));
    expect(observed).toEqual([]);

    releaseFirst.resolve();
    await delivered.promise;
    expect(observed).toEqual([1, 2]);
  });

  it("iteratively drains a large synchronous backlog after an asynchronous delivery", async () => {
    const eventCount = 20_000;
    const hub = new CommittedEventHub({ maxSubscriberBacklog: eventCount + 1 });
    const releaseFirst = deferred();
    const allDelivered = deferred();
    let deliveredCount = 0;
    let ordered = true;
    const recordDelivery = (sequence: number): void => {
      deliveredCount += 1;
      if (sequence !== deliveredCount) ordered = false;
      if (deliveredCount === eventCount) allDelivered.resolve();
    };
    hub.subscribeCommittedQueue("ses_replay", (value) => {
      if (value.sequence === 1) {
        return releaseFirst.promise.then(() => recordDelivery(value.sequence));
      }
      recordDelivery(value.sequence);
    });

    for (let sequence = 1; sequence <= eventCount; sequence += 1) {
      hub.publishCommitted(event(sequence));
    }
    expect(deliveredCount).toBe(0);

    releaseFirst.resolve();
    await allDelivered.promise;
    expect(ordered).toBe(true);
    expect(deliveredCount).toBe(eventCount);
    expect(hub.subscriberCount("ses_replay")).toBe(1);
  });

  it("contains a rejected asynchronous subscriber error handler", async () => {
    const hub = new CommittedEventHub();
    const errorHandlerCalled = deferred();
    const healthyDelivered = deferred();
    hub.subscribe(
      "ses_replay",
      () => {
        throw new Error("subscriber failed");
      },
      async () => {
        errorHandlerCalled.resolve();
        throw new Error("subscriber error handler failed");
      },
    );
    hub.subscribe("ses_replay", () => healthyDelivered.resolve());

    expect(hub.publishCommitted(event(1))).toBe("published");
    await Promise.all([errorHandlerCalled.promise, healthyDelivered.promise]);
    await Promise.resolve();
  });

  it("preserves subscriber order when an immediate subscriber publishes reentrantly", async () => {
    const hub = new CommittedEventHub();
    const observed: number[] = [];
    const delivered = deferred();
    hub.subscribeCommittedQueue("ses_replay", (value) => {
      if (value.sequence === 1) hub.publishCommitted(event(2));
    });
    hub.subscribe("ses_replay", (value) => {
      observed.push(value.sequence);
      if (observed.length === 2) delivered.resolve();
    });

    hub.publishCommitted(event(1));
    await delivered.promise;
    expect(observed).toEqual([1, 2]);
  });

  it("handles exact duplicates and rejects gaps or conflicting sequence identity", () => {
    const hub = new CommittedEventHub();
    expect(hub.publishCommitted(event(4))).toBe("published");
    expect(hub.publishCommitted(event(4))).toBe("duplicate");
    expect(() => hub.publishCommitted(event(4, "evt_conflict"))).toThrow(EventHubIntegrityError);
    expect(() => hub.publishCommitted(event(6))).toThrow(
      expect.objectContaining({ code: "event.sequence_gap" }),
    );
  });

  it("bounds remembered duplicate identities", () => {
    const hub = new CommittedEventHub({ duplicateWindow: 2 });
    hub.publishCommitted(event(1));
    hub.publishCommitted(event(2));
    hub.publishCommitted(event(3));

    expect(hub.publishCommitted(event(3))).toBe("duplicate");
    expect(() => hub.publishCommitted(event(1))).toThrow(
      expect.objectContaining({ code: "event.sequence_conflict" }),
    );
  });

  it("makes unsubscribe idempotent and releases inactive session history", () => {
    const hub = new CommittedEventHub();
    const subscription = hub.subscribe("ses_replay", vi.fn());
    expect(hub.subscriberCount("ses_replay")).toBe(1);
    expect(hub.releaseSession("ses_replay")).toBe(false);
    subscription.unsubscribe();
    subscription.unsubscribe();
    expect(hub.subscriberCount("ses_replay")).toBe(0);
    expect(hub.releaseSession("ses_replay")).toBe(true);
  });
});

describe("race-free replay subscription", () => {
  it("replays a committed suffix and signals completion before live delivery", async () => {
    const hub = new CommittedEventHub();
    const observed: string[] = [];
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 1,
      hub,
      source: {
        getHeadSequence: async () => 3,
        getEventsAfter: async () => [event(2), event(3)],
      },
      callbacks: {
        deliver: (value) => {
          observed.push(`event:${value.sequence}`);
        },
        replayComplete: (head) => {
          observed.push(`complete:${head}`);
        },
      },
    });
    await expect(subscription.ready).resolves.toEqual({ throughSequence: 3 });
    hub.publishCommitted(event(4));
    await subscription.drain();
    expect(observed).toEqual(["event:2", "event:3", "complete:3", "event:4"]);
  });

  it("ignores an exact historical publication while replay completion is pending", async () => {
    const hub = new CommittedEventHub();
    const replayCompleteStarted = deferred();
    const releaseReplayComplete = deferred();
    const observed: number[] = [];
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      source: { getHeadSequence: async () => 1, getEventsAfter: async () => [event(1)] },
      callbacks: {
        deliver: (value) => {
          observed.push(value.sequence);
        },
        replayComplete: async () => {
          replayCompleteStarted.resolve();
          await releaseReplayComplete.promise;
        },
      },
    });
    await replayCompleteStarted.promise;
    expect(hub.publishCommitted(event(1))).toBe("published");
    releaseReplayComplete.resolve();
    await expect(subscription.ready).resolves.toEqual({ throughSequence: 1 });

    hub.publishCommitted(event(2));
    await subscription.drain();
    expect(observed).toEqual([1, 2]);
  });

  it("buffers an event committed during replay without loss or reordering", async () => {
    const hub = new CommittedEventHub();
    const observed: string[] = [];
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      source: {
        getHeadSequence: async () => 3,
        getEventsAfter: async () => {
          hub.publishCommitted(event(4));
          return [event(1), event(2), event(3)];
        },
      },
      callbacks: {
        deliver: (value) => {
          observed.push(`event:${value.sequence}`);
        },
        replayComplete: (head) => {
          observed.push(`complete:${head}`);
        },
      },
    });
    await subscription.ready;
    expect(observed).toEqual(["event:1", "event:2", "event:3", "complete:3", "event:4"]);
  });

  it("rejects a delayed publication that conflicts with replayed history", async () => {
    const hub = new CommittedEventHub();
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      source: {
        getHeadSequence: async () => 1,
        getEventsAfter: async () => {
          hub.publishCommitted(event(1, "evt_conflictingReplay"));
          return [event(1)];
        },
      },
      callbacks: { deliver: vi.fn(), replayComplete: vi.fn() },
    });

    await expect(subscription.ready).rejects.toMatchObject({ code: "replay.sequence_conflict" });
  });

  it("terminates a subscription after a conflicting duplicate is published", async () => {
    const hub = new CommittedEventHub();
    let reportConflict = (): void => {};
    const conflictReported = new Promise<void>((resolve) => {
      reportConflict = resolve;
    });
    const deliver = vi.fn();
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      source: { getHeadSequence: async () => 1, getEventsAfter: async () => [event(1)] },
      callbacks: {
        deliver,
        replayComplete: vi.fn(),
        onLiveError: (error) => {
          expect(error).toMatchObject({ code: "replay.sequence_conflict" });
          reportConflict();
        },
      },
    });
    await subscription.ready;

    hub.publishCommitted(event(1, "evt_conflictingLive"));
    await conflictReported;
    expect(hub.subscriberCount("ses_replay")).toBe(0);

    hub.publishCommitted(event(2));
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("terminates live delivery after a send fails", async () => {
    const hub = new CommittedEventHub();
    const errorReported = deferred();
    const observed: number[] = [];
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 3,
      hub,
      source: { getHeadSequence: async () => 3, getEventsAfter: async () => [] },
      callbacks: {
        deliver: async (value) => {
          observed.push(value.sequence);
          if (value.sequence === 4) throw new Error("send failed");
        },
        replayComplete: () => undefined,
        onLiveError: async () => {
          errorReported.resolve();
          throw new Error("live error handler failed");
        },
      },
    });
    await subscription.ready;

    hub.publishCommitted(event(4));
    hub.publishCommitted(event(5));
    await errorReported.promise;
    await subscription.drain();

    expect(observed).toEqual([4]);
    expect(hub.subscriberCount("ses_replay")).toBe(0);
  });

  it("drops queued live delivery after unsubscribe", async () => {
    const hub = new CommittedEventHub();
    const blocked = deferred();
    const started = deferred();
    const observed: number[] = [];
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 3,
      hub,
      source: { getHeadSequence: async () => 3, getEventsAfter: async () => [] },
      callbacks: {
        deliver: async (value) => {
          observed.push(value.sequence);
          if (value.sequence === 4) {
            started.resolve();
            await blocked.promise;
          }
        },
        replayComplete: () => undefined,
      },
    });
    await subscription.ready;
    hub.publishCommitted(event(4));
    await started.promise;
    hub.publishCommitted(event(5));
    subscription.unsubscribe();
    blocked.resolve();
    await subscription.drain();
    expect(observed).toEqual([4]);
  });

  it("stops delivery and drains the in-flight query after disconnect during replay", async () => {
    const hub = new CommittedEventHub();
    const queryStarted = deferred();
    const gate = deferred();
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      source: {
        getHeadSequence: async () => 1,
        getEventsAfter: async () => {
          queryStarted.resolve();
          await gate.promise;
          return [event(1)];
        },
      },
      callbacks: { deliver: vi.fn(), replayComplete: vi.fn() },
    });
    await queryStarted.promise;
    subscription.unsubscribe();
    let drained = false;
    const drain = subscription.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    gate.resolve();
    await expect(subscription.ready).rejects.toMatchObject({ code: "replay.disconnected" });
    await drain;
    expect(drained).toBe(true);
  });

  it("never starts a collaborator with an already-aborted signal", async () => {
    const hub = new CommittedEventHub();
    const signalStates: boolean[] = [];
    const deliver = vi.fn();
    const replayComplete = vi.fn();
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      source: {
        getHeadSequence: (signal) => {
          signalStates.push(signal.aborted);
          return never<number>();
        },
        getEventsAfter: async () => [],
      },
      callbacks: { deliver, replayComplete },
    });

    subscription.unsubscribe();

    await expect(subscription.ready).rejects.toMatchObject({ code: "replay.disconnected" });
    await expect(subscription.drain()).resolves.toBeUndefined();
    expect(signalStates).not.toContain(true);
    expect(hub.subscriberCount("ses_replay")).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(replayComplete).not.toHaveBeenCalled();
  });

  it("bounds disconnect while the head query never settles", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let readyOutcome: ObservedPromise;
    let drainOutcome: ObservedPromise;
    const hub = new CommittedEventHub();
    const started = deferred();
    const deliver = vi.fn();
    const replayComplete = vi.fn();
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      source: {
        getHeadSequence: async (...signals: AbortSignal[]) => {
          [signal] = signals;
          started.resolve();
          return never<number>();
        },
        getEventsAfter: async () => [],
      },
      callbacks: { deliver, replayComplete },
    });

    try {
      await started.promise;
      subscription.unsubscribe();
      readyOutcome = await observePromise(subscription.ready);
      drainOutcome = await observePromise(subscription.drain());
    } finally {
      vi.useRealTimers();
    }

    expect(readyOutcome).toMatchObject({
      status: "rejected",
      reason: { code: "replay.disconnected" },
    });
    expect(drainOutcome).toEqual({ status: "fulfilled", value: undefined });
    expect(signal?.aborted).toBe(true);
    expect(hub.subscriberCount("ses_replay")).toBe(0);
    hub.publishCommitted(event(1));
    await Promise.resolve();
    expect(deliver).not.toHaveBeenCalled();
    expect(replayComplete).not.toHaveBeenCalled();
  });

  it("bounds disconnect while the history query never settles", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let readyOutcome: ObservedPromise;
    let drainOutcome: ObservedPromise;
    const hub = new CommittedEventHub();
    const started = deferred();
    const deliver = vi.fn();
    const replayComplete = vi.fn();
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      source: {
        getHeadSequence: async () => 1,
        getEventsAfter: async (_afterSequence, _throughSequence, ...signals: AbortSignal[]) => {
          [signal] = signals;
          started.resolve();
          return never<readonly SessionEvent[]>();
        },
      },
      callbacks: { deliver, replayComplete },
    });

    try {
      await started.promise;
      subscription.unsubscribe();
      readyOutcome = await observePromise(subscription.ready);
      drainOutcome = await observePromise(subscription.drain());
    } finally {
      vi.useRealTimers();
    }

    expect(readyOutcome).toMatchObject({
      status: "rejected",
      reason: { code: "replay.disconnected" },
    });
    expect(drainOutcome).toEqual({ status: "fulfilled", value: undefined });
    expect(signal?.aborted).toBe(true);
    expect(hub.subscriberCount("ses_replay")).toBe(0);
    hub.publishCommitted(event(1));
    await Promise.resolve();
    expect(deliver).not.toHaveBeenCalled();
    expect(replayComplete).not.toHaveBeenCalled();
  });

  it("bounds disconnect while historical delivery never settles", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let readyOutcome: ObservedPromise;
    let drainOutcome: ObservedPromise;
    const hub = new CommittedEventHub();
    const started = deferred();
    const observed: number[] = [];
    const replayComplete = vi.fn();
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      source: { getHeadSequence: async () => 1, getEventsAfter: async () => [event(1)] },
      callbacks: {
        deliver: async (value, ...signals: AbortSignal[]) => {
          observed.push(value.sequence);
          [signal] = signals;
          started.resolve();
          return never<void>();
        },
        replayComplete,
      },
    });

    try {
      await started.promise;
      subscription.unsubscribe();
      readyOutcome = await observePromise(subscription.ready);
      drainOutcome = await observePromise(subscription.drain());
    } finally {
      vi.useRealTimers();
    }

    expect(readyOutcome).toMatchObject({
      status: "rejected",
      reason: { code: "replay.disconnected" },
    });
    expect(drainOutcome).toEqual({ status: "fulfilled", value: undefined });
    expect(signal?.aborted).toBe(true);
    expect(hub.subscriberCount("ses_replay")).toBe(0);
    expect(replayComplete).not.toHaveBeenCalled();
    hub.publishCommitted(event(1));
    await Promise.resolve();
    expect(observed).toEqual([1]);
  });

  it("bounds disconnect while replay completion never settles", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let readyOutcome: ObservedPromise;
    let drainOutcome: ObservedPromise;
    const hub = new CommittedEventHub();
    const started = deferred();
    const deliver = vi.fn();
    const replayComplete = vi.fn(async (_throughSequence, ...signals: AbortSignal[]) => {
      [signal] = signals;
      started.resolve();
      return never<void>();
    });
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      source: { getHeadSequence: async () => 0, getEventsAfter: async () => [] },
      callbacks: { deliver, replayComplete },
    });

    try {
      await started.promise;
      subscription.unsubscribe();
      readyOutcome = await observePromise(subscription.ready);
      drainOutcome = await observePromise(subscription.drain());
    } finally {
      vi.useRealTimers();
    }

    expect(readyOutcome).toMatchObject({
      status: "rejected",
      reason: { code: "replay.disconnected" },
    });
    expect(drainOutcome).toEqual({ status: "fulfilled", value: undefined });
    expect(signal?.aborted).toBe(true);
    expect(hub.subscriberCount("ses_replay")).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(replayComplete).toHaveBeenCalledOnce();
    hub.publishCommitted(event(1));
    await Promise.resolve();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("bounds drain while live delivery never settles", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let drainOutcome: ObservedPromise;
    const hub = new CommittedEventHub();
    const started = deferred();
    const observed: number[] = [];
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      source: { getHeadSequence: async () => 0, getEventsAfter: async () => [] },
      callbacks: {
        deliver: async (value, ...signals: AbortSignal[]) => {
          observed.push(value.sequence);
          [signal] = signals;
          started.resolve();
          return never<void>();
        },
        replayComplete: vi.fn(),
      },
    });

    try {
      await expect(subscription.ready).resolves.toEqual({ throughSequence: 0 });
      hub.publishCommitted(event(1));
      await started.promise;
      subscription.unsubscribe();
      drainOutcome = await observePromise(subscription.drain());
    } finally {
      vi.useRealTimers();
    }

    expect(drainOutcome).toEqual({ status: "fulfilled", value: undefined });
    expect(signal?.aborted).toBe(true);
    expect(hub.subscriberCount("ses_replay")).toBe(0);
    hub.publishCommitted(event(2));
    await Promise.resolve();
    expect(observed).toEqual([1]);
  });

  it("contains a late collaborator rejection after disconnect", async () => {
    const hub = new CommittedEventHub();
    const started = deferred();
    const lateHead = rejectableDeferred<number>();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      source: {
        getHeadSequence: async () => {
          started.resolve();
          return lateHead.promise;
        },
        getEventsAfter: async () => [],
      },
      callbacks: { deliver: vi.fn(), replayComplete: vi.fn() },
    });

    try {
      await started.promise;
      subscription.unsubscribe();
      await expect(subscription.ready).rejects.toMatchObject({ code: "replay.disconnected" });
      await expect(subscription.drain()).resolves.toBeUndefined();
      lateHead.reject(new Error("late head failure"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("preserves a sequence conflict that wins the disconnect race", async () => {
    const hub = new CommittedEventHub();
    const started = deferred();
    const history = rejectableDeferred<readonly SessionEvent[]>();
    const conflict = new ReplaySubscriptionError(
      "replay.sequence_conflict",
      "history conflicted",
    );
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      source: {
        getHeadSequence: () => Promise.resolve(1),
        getEventsAfter: () => {
          started.resolve();
          return history.promise;
        },
      },
      callbacks: { deliver: vi.fn(), replayComplete: vi.fn() },
    });

    await started.promise;
    const readyError = subscription.ready.catch((error: unknown) => error);
    history.reject(conflict);
    subscription.unsubscribe();

    await expect(readyError).resolves.toBe(conflict);
    await expect(subscription.drain()).resolves.toBeUndefined();
    expect(hub.subscriberCount("ses_replay")).toBe(0);
  });

  it("disconnects when committed live events overflow the replay buffer", async () => {
    const hub = new CommittedEventHub();
    const queryStarted = deferred();
    const releaseQuery = deferred();
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      maxBufferedLiveEvents: 2,
      source: {
        getHeadSequence: async () => 0,
        getEventsAfter: async () => {
          queryStarted.resolve();
          await releaseQuery.promise;
          return [];
        },
      },
      callbacks: { deliver: vi.fn(), replayComplete: vi.fn() },
    });
    await queryStarted.promise;

    hub.publishCommitted(event(1));
    hub.publishCommitted(event(2));
    hub.publishCommitted(event(3));
    releaseQuery.resolve();

    await expect(subscription.ready).rejects.toMatchObject({
      code: "replay.subscriber_overflow",
    });
    expect(hub.subscriberCount("ses_replay")).toBe(0);
  });

  it("disconnects when replay live bytes overflow below the event-count limit", async () => {
    const hub = new CommittedEventHub();
    const queryStarted = deferred();
    const releaseQuery = deferred();
    const first = event(1);
    const eventBytes = Buffer.byteLength(JSON.stringify(first));
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      maxBufferedLiveEvents: 10,
      maxBufferedLiveBytes: eventBytes * 2 - 1,
      maxSingleEventBytes: eventBytes,
      source: {
        getHeadSequence: async () => 0,
        getEventsAfter: async () => {
          queryStarted.resolve();
          await releaseQuery.promise;
          return [];
        },
      },
      callbacks: { deliver: vi.fn(), replayComplete: vi.fn() },
    });
    await queryStarted.promise;

    hub.publishCommitted(first);
    hub.publishCommitted(event(2));
    releaseQuery.resolve();

    await expect(subscription.ready).rejects.toMatchObject({
      code: "replay.subscriber_overflow",
    });
    expect(hub.subscriberCount("ses_replay")).toBe(0);
  });

  it("disconnects when a slow live callback exceeds its bounded backlog", async () => {
    const hub = new CommittedEventHub();
    const deliveryStarted = deferred();
    const releaseDelivery = deferred();
    const errorReported = deferred();
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub,
      maxBufferedLiveEvents: 2,
      source: { getHeadSequence: async () => 0, getEventsAfter: async () => [] },
      callbacks: {
        deliver: async () => {
          deliveryStarted.resolve();
          await releaseDelivery.promise;
        },
        replayComplete: vi.fn(),
        onLiveError: (error) => {
          expect(error).toMatchObject({ code: "replay.subscriber_overflow" });
          errorReported.resolve();
        },
      },
    });
    await subscription.ready;

    hub.publishCommitted(event(1));
    await deliveryStarted.promise;
    hub.publishCommitted(event(2));
    hub.publishCommitted(event(3));
    await errorReported.promise;

    expect(hub.subscriberCount("ses_replay")).toBe(0);
    releaseDelivery.resolve();
    await subscription.drain();
  });

  it.each([
    {
      name: "extends beyond the captured head",
      head: 1,
      historical: [event(1), event(2)],
      code: "replay.sequence_conflict",
    },
    {
      name: "ends below the captured head",
      head: 2,
      historical: [event(1)],
      code: "replay.sequence_gap",
    },
  ] as const)("validates the complete historical batch before delivery when it $name", async (testCase) => {
    const deliver = vi.fn();
    const replayComplete = vi.fn();
    const subscription = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub: new CommittedEventHub(),
      source: {
        getHeadSequence: async () => testCase.head,
        getEventsAfter: async () => testCase.historical,
      },
      callbacks: { deliver, replayComplete },
    });

    await expect(subscription.ready).rejects.toMatchObject({ code: testCase.code });
    expect(deliver).not.toHaveBeenCalled();
    expect(replayComplete).not.toHaveBeenCalled();
  });

  it("defines cursor-ahead, unknown-session, and gap failures", async () => {
    const hub = new CommittedEventHub();
    const cursorAhead = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 2,
      hub,
      source: { getHeadSequence: async () => 1, getEventsAfter: async () => [] },
      callbacks: { deliver: vi.fn(), replayComplete: vi.fn() },
    });
    await expect(cursorAhead.ready).rejects.toMatchObject({ code: "replay.cursor_ahead" });

    const unknown = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub: new CommittedEventHub(),
      source: {
        getHeadSequence: async () => {
          throw new Error("missing");
        },
        getEventsAfter: async () => [],
      },
      isUnknownSessionError: () => true,
      callbacks: { deliver: vi.fn(), replayComplete: vi.fn() },
    });
    await expect(unknown.ready).rejects.toBeInstanceOf(ReplaySubscriptionError);
    await expect(unknown.ready).rejects.toMatchObject({ code: "replay.unknown_session" });

    const gap = beginReplaySubscription({
      sessionId: "ses_replay",
      afterSequence: 0,
      hub: new CommittedEventHub(),
      source: { getHeadSequence: async () => 2, getEventsAfter: async () => [event(2)] },
      callbacks: { deliver: vi.fn(), replayComplete: vi.fn() },
    });
    await expect(gap.ready).rejects.toMatchObject({ code: "replay.sequence_gap" });
  });
});
