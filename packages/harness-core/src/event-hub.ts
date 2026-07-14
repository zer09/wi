import { canonicalJson, type SessionEvent } from "@wi/protocol";

export type CommittedEventSubscriber = (event: SessionEvent) => void | Promise<void>;
export type SubscriberErrorHandler = (error: unknown) => void | Promise<void>;

export class EventHubIntegrityError extends Error {
  constructor(
    readonly code: "event.sequence_gap" | "event.sequence_conflict" | "event.identity_conflict",
    message: string,
  ) {
    super(message);
    this.name = "EventHubIntegrityError";
  }
}

export class EventHubBackpressureError extends Error {
  readonly code = "event.subscriber_overflow";

  constructor(readonly sessionId: string) {
    super(`Committed-event subscriber for ${sessionId} exceeded its bounded backlog`);
    this.name = "EventHubBackpressureError";
  }
}

export interface CommittedEventHubOptions {
  readonly duplicateWindow?: number;
  readonly maxSubscriberBacklog?: number;
}

export interface EventHubSubscription {
  readonly unsubscribe: () => void;
}

interface Subscriber {
  active: boolean;
  delivering: boolean;
  backlog: number;
  readonly queue: SessionEvent[];
  readonly deliver: CommittedEventSubscriber;
  readonly onError: SubscriberErrorHandler | undefined;
  readonly immediate: boolean;
}

interface SessionPublicationState {
  head: number | undefined;
  dispatching: boolean;
  readonly pendingDeliveries: SessionEvent[];
  readonly eventIdsBySequence: Map<number, string>;
  readonly fingerprintsBySequence: Map<number, string>;
  readonly sequencesByEventId: Map<string, number>;
  readonly subscribers: Set<Subscriber>;
}

export class CommittedEventHub {
  private readonly sessions = new Map<string, SessionPublicationState>();
  private readonly duplicateWindow: number;
  private readonly maxSubscriberBacklog: number;

  constructor(options: CommittedEventHubOptions = {}) {
    this.duplicateWindow = options.duplicateWindow ?? 1_024;
    this.maxSubscriberBacklog = options.maxSubscriberBacklog ?? 1_024;
    if (!Number.isSafeInteger(this.duplicateWindow) || this.duplicateWindow < 1) {
      throw new RangeError("Event hub duplicate window must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxSubscriberBacklog) || this.maxSubscriberBacklog < 1) {
      throw new RangeError("Event hub subscriber backlog must be a positive safe integer");
    }
  }

  private reportSubscriberError(subscriber: Subscriber, error: unknown): void {
    try {
      const reporting = subscriber.onError?.(error);
      if (reporting !== undefined) {
        void Promise.resolve(reporting).catch(() => {
          // Subscriber diagnostics are isolated from publication and other subscribers.
        });
      }
    } catch {
      // Subscriber diagnostics are isolated from publication and other subscribers.
    }
  }

  private deactivateSubscriber(state: SessionPublicationState, subscriber: Subscriber): void {
    if (!subscriber.active) return;
    subscriber.active = false;
    subscriber.queue.length = 0;
    subscriber.backlog = subscriber.delivering ? 1 : 0;
    state.subscribers.delete(subscriber);
  }

  private pumpSubscriber(state: SessionPublicationState, subscriber: Subscriber): void {
    if (!subscriber.active || subscriber.delivering) return;
    const event = subscriber.queue.shift();
    if (event === undefined) return;
    subscriber.delivering = true;
    void Promise.resolve()
      .then(() => (subscriber.active ? subscriber.deliver(event) : undefined))
      .catch((error: unknown) => {
        this.deactivateSubscriber(state, subscriber);
        this.reportSubscriberError(subscriber, error);
      })
      .finally(() => {
        subscriber.backlog -= 1;
        subscriber.delivering = false;
        if (!subscriber.active) {
          subscriber.queue.length = 0;
          subscriber.backlog = 0;
          return;
        }
        this.pumpSubscriber(state, subscriber);
      });
  }

  private pumpCommittedQueue(state: SessionPublicationState, subscriber: Subscriber): void {
    if (!subscriber.active || subscriber.delivering) return;

    // A completed async delivery may expose a large synchronous backlog, so drain without recursion.
    while (subscriber.active) {
      const event = subscriber.queue.shift();
      if (event === undefined) return;
      subscriber.delivering = true;

      let delivery: void | Promise<void>;
      try {
        delivery = subscriber.deliver(event);
      } catch (error) {
        this.deactivateSubscriber(state, subscriber);
        this.reportSubscriberError(subscriber, error);
        subscriber.backlog = 0;
        subscriber.delivering = false;
        return;
      }
      if (delivery === undefined) {
        subscriber.backlog -= 1;
        subscriber.delivering = false;
        continue;
      }

      void Promise.resolve(delivery)
        .catch((error: unknown) => {
          this.deactivateSubscriber(state, subscriber);
          this.reportSubscriberError(subscriber, error);
        })
        .finally(() => {
          subscriber.backlog -= 1;
          subscriber.delivering = false;
          if (!subscriber.active) {
            subscriber.queue.length = 0;
            subscriber.backlog = 0;
            return;
          }
          this.pumpCommittedQueue(state, subscriber);
        });
      return;
    }
  }

  private enqueueSubscriber(
    sessionId: string,
    state: SessionPublicationState,
    subscriber: Subscriber,
    event: SessionEvent,
  ): void {
    if (!subscriber.active) return;
    if (subscriber.backlog >= this.maxSubscriberBacklog) {
      this.deactivateSubscriber(state, subscriber);
      this.reportSubscriberError(subscriber, new EventHubBackpressureError(sessionId));
      return;
    }
    subscriber.backlog += 1;
    subscriber.queue.push(event);
    if (subscriber.immediate) this.pumpCommittedQueue(state, subscriber);
    else this.pumpSubscriber(state, subscriber);
  }

  private session(sessionId: string): SessionPublicationState {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = {
        head: undefined,
        dispatching: false,
        pendingDeliveries: [],
        eventIdsBySequence: new Map(),
        fingerprintsBySequence: new Map(),
        sequencesByEventId: new Map(),
        subscribers: new Set(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  subscribe(
    sessionId: string,
    deliver: CommittedEventSubscriber,
    onError?: SubscriberErrorHandler,
  ): EventHubSubscription {
    const state = this.session(sessionId);
    const subscriber: Subscriber = {
      active: true,
      delivering: false,
      backlog: 0,
      queue: [],
      deliver,
      onError,
      immediate: false,
    };
    state.subscribers.add(subscriber);
    let unsubscribed = false;
    return {
      unsubscribe: () => {
        if (unsubscribed) return;
        unsubscribed = true;
        this.deactivateSubscriber(state, subscriber);
      },
    };
  }

  subscribeCommittedQueue(
    sessionId: string,
    enqueue: CommittedEventSubscriber,
    onError?: SubscriberErrorHandler,
  ): EventHubSubscription {
    const state = this.session(sessionId);
    const subscriber: Subscriber = {
      active: true,
      delivering: false,
      backlog: 0,
      queue: [],
      deliver: enqueue,
      onError,
      immediate: true,
    };
    state.subscribers.add(subscriber);
    let unsubscribed = false;
    return {
      unsubscribe: () => {
        if (unsubscribed) return;
        unsubscribed = true;
        this.deactivateSubscriber(state, subscriber);
      },
    };
  }

  subscriberCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.subscribers.size ?? 0;
  }

  releaseSession(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return true;
    if (state.subscribers.size > 0 || state.dispatching || state.pendingDeliveries.length > 0) {
      return false;
    }
    return this.sessions.delete(sessionId);
  }

  publishCommitted(event: SessionEvent): "published" | "duplicate" {
    const state = this.session(event.sessionId);
    const knownSequence = state.sequencesByEventId.get(event.eventId);
    if (knownSequence !== undefined && knownSequence !== event.sequence) {
      throw new EventHubIntegrityError(
        "event.identity_conflict",
        `Event ${event.eventId} changed sequence from ${knownSequence} to ${event.sequence}`,
      );
    }
    const fingerprint = canonicalJson(event);
    const knownEventId = state.eventIdsBySequence.get(event.sequence);
    if (knownEventId !== undefined) {
      if (
        knownEventId === event.eventId &&
        state.fingerprintsBySequence.get(event.sequence) === fingerprint
      ) {
        return "duplicate";
      }
      throw new EventHubIntegrityError(
        "event.sequence_conflict",
        `Session ${event.sessionId} sequence ${event.sequence} has conflicting event identities`,
      );
    }
    if (state.head !== undefined && event.sequence <= state.head) {
      throw new EventHubIntegrityError(
        "event.sequence_conflict",
        `Session ${event.sessionId} sequence ${event.sequence} is outside the duplicate window`,
      );
    }
    if (state.head !== undefined && event.sequence !== state.head + 1) {
      throw new EventHubIntegrityError(
        "event.sequence_gap",
        `Session ${event.sessionId} publication jumped from ${state.head} to ${event.sequence}`,
      );
    }

    state.head = event.sequence;
    state.eventIdsBySequence.set(event.sequence, event.eventId);
    state.fingerprintsBySequence.set(event.sequence, fingerprint);
    state.sequencesByEventId.set(event.eventId, event.sequence);
    const oldestRemembered = event.sequence - this.duplicateWindow + 1;
    for (const [sequence, rememberedEventId] of state.eventIdsBySequence) {
      if (sequence >= oldestRemembered) break;
      state.eventIdsBySequence.delete(sequence);
      state.fingerprintsBySequence.delete(sequence);
      state.sequencesByEventId.delete(rememberedEventId);
    }
    state.pendingDeliveries.push(event);
    if (state.dispatching) return "published";

    // Nested publication is queued so every subscriber observes N before N+1.
    state.dispatching = true;
    try {
      let pending: SessionEvent | undefined;
      while ((pending = state.pendingDeliveries.shift()) !== undefined) {
        const delivery = pending;
        for (const subscriber of state.subscribers) {
          this.enqueueSubscriber(event.sessionId, state, subscriber, delivery);
        }
      }
    } finally {
      state.dispatching = false;
    }
    return "published";
  }
}
