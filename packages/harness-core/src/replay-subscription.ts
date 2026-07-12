import { canonicalJson, type SessionEvent } from "@wi/protocol";

import type { CommittedEventHub, EventHubSubscription } from "./event-hub.js";

export type ReplayErrorCode =
  | "replay.cursor_ahead"
  | "replay.unknown_session"
  | "replay.disconnected"
  | "replay.query_failed"
  | "replay.sequence_gap"
  | "replay.sequence_conflict"
  | "replay.subscriber_overflow";

export class ReplaySubscriptionError extends Error {
  constructor(readonly code: ReplayErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReplaySubscriptionError";
  }
}

export interface ReplayEventSource {
  getHeadSequence(): Promise<number>;
  getEventsAfter(afterSequence: number, throughSequence: number): Promise<readonly SessionEvent[]>;
}

export interface ReplaySubscriptionCallbacks {
  readonly deliver: (event: SessionEvent) => void | Promise<void>;
  readonly replayComplete: (throughSequence: number) => void | Promise<void>;
  readonly onLiveError?: (error: unknown) => void | Promise<void>;
}

export interface ReplaySubscription {
  readonly ready: Promise<{ readonly throughSequence: number }>;
  readonly unsubscribe: () => void;
  readonly drain: () => Promise<void>;
}

interface QueuedEvent {
  readonly event: SessionEvent;
  readonly fingerprint: string;
}

export function beginReplaySubscription(options: {
  readonly sessionId: string;
  readonly afterSequence: number;
  readonly source: ReplayEventSource;
  readonly hub: CommittedEventHub;
  readonly callbacks: ReplaySubscriptionCallbacks;
  readonly isUnknownSessionError?: (error: unknown) => boolean;
  readonly maxBufferedLiveEvents?: number;
  readonly duplicateWindow?: number;
}): ReplaySubscription {
  if (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0) {
    throw new RangeError("Replay cursor must be a nonnegative safe integer");
  }
  const maxBufferedLiveEvents = options.maxBufferedLiveEvents ?? 1_024;
  const duplicateWindow = options.duplicateWindow ?? 1_024;
  if (!Number.isSafeInteger(maxBufferedLiveEvents) || maxBufferedLiveEvents < 1) {
    throw new RangeError("Replay live-event backlog must be a positive safe integer");
  }
  if (!Number.isSafeInteger(duplicateWindow) || duplicateWindow < 1) {
    throw new RangeError("Replay duplicate window must be a positive safe integer");
  }

  let active = true;
  let activeFailure: unknown | null = null;
  let phase: "replaying" | "live" = "replaying";
  let deliveredSequence = options.afterSequence;
  let pendingLiveDeliveries = 0;
  let liveTail = Promise.resolve();
  const queue = new Map<number, QueuedEvent>();
  const delivered = new Map<number, QueuedEvent>();

  const rememberDelivered = (queuedEvent: QueuedEvent): void => {
    delivered.set(queuedEvent.event.sequence, queuedEvent);
    const oldestRemembered = queuedEvent.event.sequence - duplicateWindow + 1;
    for (const sequence of delivered.keys()) {
      if (sequence >= oldestRemembered) break;
      delivered.delete(sequence);
    }
  };

  const reportLiveError = (error: unknown): void => {
    try {
      const reporting = options.callbacks.onLiveError?.(error);
      if (reporting !== undefined) {
        void Promise.resolve(reporting).catch(() => {
          // Subscriber diagnostics must not affect the committed-event publisher.
        });
      }
    } catch {
      // Subscriber diagnostics must not affect the committed-event publisher.
    }
  };

  const failLive = (error: unknown): void => {
    if (!active) return;
    active = false;
    activeFailure = error;
    queue.clear();
    hubSubscription?.unsubscribe();
    reportLiveError(error);
  };

  const assertActive = (): void => {
    if (active) return;
    if (activeFailure instanceof ReplaySubscriptionError) throw activeFailure;
    throw new ReplaySubscriptionError(
      "replay.disconnected",
      `Replay subscriber for ${options.sessionId} disconnected`,
      activeFailure === null ? undefined : { cause: activeFailure },
    );
  };

  const queueLive = (event: SessionEvent): void => {
    if (!active) return;
    if (event.sessionId !== options.sessionId) {
      throw new ReplaySubscriptionError(
        "replay.sequence_conflict",
        "Replay subscriber received an event for another session",
      );
    }
    const queuedEvent = { event, fingerprint: canonicalJson(event) };
    if (event.sequence <= deliveredSequence) {
      // The subscriber already acknowledged its starting cursor, so earlier publications are
      // irrelevant to this replay and need no retained identity history.
      if (event.sequence <= options.afterSequence) return;
      const known = delivered.get(event.sequence);
      if (known === undefined) {
        throw new ReplaySubscriptionError(
          "replay.sequence_conflict",
          `Sequence ${event.sequence} is outside the replay duplicate window`,
        );
      }
      if (known.event.eventId !== event.eventId || known.fingerprint !== queuedEvent.fingerprint) {
        throw new ReplaySubscriptionError(
          "replay.sequence_conflict",
          `Sequence ${event.sequence} conflicts with the replayed event`,
        );
      }
      return;
    }
    if (phase === "live") {
      if (event.sequence !== deliveredSequence + 1) {
        throw new ReplaySubscriptionError(
          "replay.sequence_gap",
          `Live delivery expected ${deliveredSequence + 1}, received ${event.sequence}`,
        );
      }
      if (pendingLiveDeliveries >= maxBufferedLiveEvents) {
        throw new ReplaySubscriptionError(
          "replay.subscriber_overflow",
          `Replay subscriber for ${options.sessionId} exceeded its bounded live backlog`,
        );
      }
      deliveredSequence = event.sequence;
      rememberDelivered(queuedEvent);
      pendingLiveDeliveries += 1;
      liveTail = liveTail
        .then(async () => {
          if (active) await options.callbacks.deliver(event);
        })
        .catch((error: unknown) => {
          // A failed send makes the subscriber's cursor uncertain. Stop before a later
          // sequence can be observed without the failed event; replay will repair it.
          failLive(error);
        })
        .finally(() => {
          pendingLiveDeliveries -= 1;
        });
      return;
    }

    const existing = queue.get(event.sequence);
    if (existing !== undefined) {
      if (
        existing.event.eventId !== event.eventId ||
        existing.fingerprint !== queuedEvent.fingerprint
      ) {
        throw new ReplaySubscriptionError(
          "replay.sequence_conflict",
          `Queued sequence ${event.sequence} has conflicting identities`,
        );
      }
      return;
    }
    if (queue.size >= maxBufferedLiveEvents) {
      throw new ReplaySubscriptionError(
        "replay.subscriber_overflow",
        `Replay subscriber for ${options.sessionId} exceeded its bounded replay backlog`,
      );
    }
    queue.set(event.sequence, queuedEvent);
  };

  const hubSubscription: EventHubSubscription = options.hub.subscribeCommittedQueue(
    options.sessionId,
    queueLive,
    failLive,
  );

  const unsubscribe = (): void => {
    if (!active) return;
    active = false;
    queue.clear();
    hubSubscription?.unsubscribe();
  };

  const ready = (async (): Promise<{ readonly throughSequence: number }> => {
    try {
      let head: number;
      try {
        head = await options.source.getHeadSequence();
      } catch (error) {
        if (options.isUnknownSessionError?.(error) === true) {
          throw new ReplaySubscriptionError(
            "replay.unknown_session",
            `Session ${options.sessionId} is unknown`,
            { cause: error },
          );
        }
        throw new ReplaySubscriptionError("replay.query_failed", "Replay head query failed", {
          cause: error,
        });
      }
      assertActive();
      if (options.afterSequence > head) {
        throw new ReplaySubscriptionError(
          "replay.cursor_ahead",
          `Replay cursor ${options.afterSequence} is ahead of committed head ${head}`,
        );
      }

      let historical: readonly SessionEvent[];
      try {
        historical = await options.source.getEventsAfter(options.afterSequence, head);
      } catch (error) {
        if (options.isUnknownSessionError?.(error) === true) {
          throw new ReplaySubscriptionError(
            "replay.unknown_session",
            `Session ${options.sessionId} is unknown`,
            { cause: error },
          );
        }
        throw new ReplaySubscriptionError("replay.query_failed", "Replay event query failed", {
          cause: error,
        });
      }
      assertActive();

      let expected = options.afterSequence + 1;
      const validatedHistorical: QueuedEvent[] = [];
      for (const event of historical) {
        if (event.sessionId !== options.sessionId) {
          throw new ReplaySubscriptionError(
            "replay.sequence_conflict",
            `Historical sequence ${event.sequence} belongs to another session`,
          );
        }
        if (event.sequence > head) {
          throw new ReplaySubscriptionError(
            "replay.sequence_conflict",
            `Historical replay returned sequence ${event.sequence} above captured head ${head}`,
          );
        }
        if (event.sequence !== expected) {
          throw new ReplaySubscriptionError(
            "replay.sequence_gap",
            `Historical replay expected sequence ${expected}, received ${event.sequence}`,
          );
        }
        const validatedEvent = { event, fingerprint: canonicalJson(event) };
        const queuedHistorical = queue.get(event.sequence);
        if (
          queuedHistorical !== undefined &&
          (queuedHistorical.event.eventId !== event.eventId ||
            queuedHistorical.fingerprint !== validatedEvent.fingerprint)
        ) {
          throw new ReplaySubscriptionError(
            "replay.sequence_conflict",
            `Queued sequence ${event.sequence} conflicts with historical replay`,
          );
        }
        validatedHistorical.push(validatedEvent);
        expected += 1;
      }
      if (expected !== head + 1) {
        throw new ReplaySubscriptionError(
          "replay.sequence_gap",
          `Historical replay ended at ${expected - 1}, below committed head ${head}`,
        );
      }

      // Validate the complete `(cursor, H]` batch before exposing any of it to the subscriber.
      for (const validatedEvent of validatedHistorical) {
        queue.delete(validatedEvent.event.sequence);
        await options.callbacks.deliver(validatedEvent.event);
        assertActive();
        deliveredSequence = validatedEvent.event.sequence;
        rememberDelivered(validatedEvent);
      }
      for (const [sequence, queued] of queue) {
        if (sequence > head) continue;
        const known = delivered.get(sequence);
        if (known === undefined) {
          throw new ReplaySubscriptionError(
            "replay.sequence_conflict",
            `Queued sequence ${sequence} is outside the replay duplicate window`,
          );
        }
        if (
          known.event.eventId !== queued.event.eventId ||
          known.fingerprint !== queued.fingerprint
        ) {
          throw new ReplaySubscriptionError(
            "replay.sequence_conflict",
            `Queued sequence ${sequence} conflicts with historical replay`,
          );
        }
        queue.delete(sequence);
      }

      await options.callbacks.replayComplete(head);
      assertActive();
      deliveredSequence = head;

      while (queue.size > 0) {
        const nextSequence = deliveredSequence + 1;
        const queued = queue.get(nextSequence);
        if (queued === undefined) {
          throw new ReplaySubscriptionError(
            "replay.sequence_gap",
            `Buffered live delivery is missing expected sequence ${nextSequence}`,
          );
        }
        queue.delete(nextSequence);
        await options.callbacks.deliver(queued.event);
        assertActive();
        deliveredSequence = nextSequence;
        rememberDelivered(queued);
      }
      phase = "live";
      return { throughSequence: head };
    } catch (error) {
      unsubscribe();
      throw error;
    }
  })();

  const drain = async (): Promise<void> => {
    await ready.catch(() => undefined);
    await liveTail;
  };

  return { ready, unsubscribe, drain };
}
