import { createHash } from "node:crypto";

import { canonicalJson, type SessionEvent } from "@wi/protocol";
import { SESSION_EVENT_PAGE_BOUNDS } from "@wi/storage";

import type { CommittedEventHub, EventHubSubscription } from "./event-hub.js";

export type ReplayErrorCode =
  | "replay.cursor_ahead"
  | "replay.unknown_session"
  | "replay.session_unavailable"
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

export interface ReplayEventPage {
  readonly events: readonly SessionEvent[];
  readonly nextAfterSequence: number;
  readonly done: boolean;
  readonly serializedBytes: number;
}

export interface ReplayPageLimits {
  readonly maximumEvents: number;
  readonly maximumBytes: number;
  readonly maximumSingleEventBytes: number;
}

export interface ReplayPageRequest extends ReplayPageLimits {
  readonly afterSequence: number;
  readonly throughSequence: number;
}

export interface ReplayEventSource {
  getHeadSequence(signal: AbortSignal): Promise<number>;
  getEventPageAfter?(
    input: ReplayPageRequest,
    signal: AbortSignal,
  ): Promise<ReplayEventPage>;
  getEventsAfter?(
    afterSequence: number,
    throughSequence: number,
    signal: AbortSignal,
  ): Promise<readonly SessionEvent[]>;
}

export interface ReplaySubscriptionCallbacks {
  readonly deliver: (event: SessionEvent, signal: AbortSignal) => void | Promise<void>;
  readonly replayComplete: (throughSequence: number, signal: AbortSignal) => void | Promise<void>;
  readonly onLiveError?: (error: unknown, signal: AbortSignal) => void | Promise<void>;
}

export interface ReplaySubscription {
  readonly ready: Promise<{ readonly throughSequence: number }>;
  readonly unsubscribe: () => void;
  readonly drain: () => Promise<void>;
}

export interface ReplayDeliveredIdentity {
  readonly eventId: string;
  readonly fingerprint: string;
}

export interface ReplayConnectionBudget {
  tryReserveLiveEvent(bytes: number): boolean;
  releaseLiveEvent(bytes: number): void;
  acquireHistoricalPage(signal: AbortSignal): Promise<() => void>;
  getDeliveredIdentity(
    sessionId: string,
    sequence: number,
  ): ReplayDeliveredIdentity | undefined;
  rememberDeliveredIdentity(
    sessionId: string,
    sequence: number,
    identity: ReplayDeliveredIdentity,
  ): void;
}

interface QueuedEvent {
  readonly event: SessionEvent;
  readonly fingerprint: string;
  readonly bytes: number;
}

interface DeliveredIdentity extends ReplayDeliveredIdentity {
  readonly bytes: number;
}

const utf8 = new TextEncoder();

export function beginReplaySubscription(options: {
  readonly sessionId: string;
  readonly afterSequence: number;
  readonly source: ReplayEventSource;
  readonly hub: CommittedEventHub;
  readonly callbacks: ReplaySubscriptionCallbacks;
  readonly isUnknownSessionError?: (error: unknown) => boolean;
  readonly maxBufferedLiveEvents?: number;
  readonly maxBufferedLiveBytes?: number;
  readonly maxSingleEventBytes?: number;
  readonly maximumPageEvents?: number;
  readonly maximumPageBytes?: number;
  readonly maximumPageSingleEventBytes?: number;
  readonly duplicateWindow?: number;
  readonly connectionBudget?: ReplayConnectionBudget;
}): ReplaySubscription {
  if (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0) {
    throw new RangeError("Replay cursor must be a nonnegative safe integer");
  }
  const maxBufferedLiveEvents = options.maxBufferedLiveEvents ?? 1_024;
  const maxBufferedLiveBytes = options.maxBufferedLiveBytes ?? 1_024 * 1_024;
  const maxSingleEventBytes = options.maxSingleEventBytes ?? 256 * 1_024;
  const pageLimits: ReplayPageLimits = {
    maximumEvents: options.maximumPageEvents ?? 64,
    maximumBytes:
      options.maximumPageBytes ??
      256 * 1_024 + SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes,
    maximumSingleEventBytes: options.maximumPageSingleEventBytes ?? 256 * 1_024,
  };
  const duplicateWindow = options.duplicateWindow ?? 1_024;
  const connectionBudget = options.connectionBudget;
  const positiveLimits: ReadonlyArray<readonly [string, number]> = [
    ["live-event backlog", maxBufferedLiveEvents],
    ["live-byte backlog", maxBufferedLiveBytes],
    ["single live-event byte", maxSingleEventBytes],
    ["page event", pageLimits.maximumEvents],
    ["page byte", pageLimits.maximumBytes],
    ["single page-event byte", pageLimits.maximumSingleEventBytes],
    ["duplicate window", duplicateWindow],
  ];
  for (const [description, value] of positiveLimits) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`Replay ${description} limit must be a positive safe integer`);
    }
  }
  if (maxSingleEventBytes > maxBufferedLiveBytes) {
    throw new RangeError("Replay single live-event limit must fit within the live byte limit");
  }
  if (
    pageLimits.maximumSingleEventBytes >
    pageLimits.maximumBytes - SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes
  ) {
    throw new RangeError(
      "Replay single page-event and response envelopes must fit within the page byte limit",
    );
  }
  if (maxSingleEventBytes > pageLimits.maximumSingleEventBytes) {
    throw new RangeError("Replay live event limit must not exceed historical replay capacity");
  }
  if (
    options.source.getEventPageAfter === undefined &&
    options.source.getEventsAfter === undefined
  ) {
    throw new TypeError("Replay source must provide paged or legacy event reads");
  }

  let active = true;
  let disconnectError: ReplaySubscriptionError | null = null;
  const disconnectWaiters = new Set<() => void>();
  const abortController = new AbortController();
  let phase: "replaying" | "live" = "replaying";
  let deliveredSequence = options.afterSequence;
  let pendingLiveDeliveries = 0;
  let pendingLiveBytes = 0;
  let queuedBytes = 0;
  let deliveredBytes = 0;
  let liveTail = Promise.resolve();
  const queue = new Map<number, QueuedEvent>();
  const delivered = new Map<number, DeliveredIdentity>();
  let legacyHistorical: readonly SessionEvent[] | null = null;

  const queuedEvent = (event: SessionEvent): QueuedEvent => {
    const serialized = canonicalJson(event);
    return {
      event,
      fingerprint: createHash("sha256").update(serialized).digest("base64url"),
      bytes: utf8.encode(serialized).byteLength,
    };
  };

  const assertEventByteBound = (event: QueuedEvent, maximumBytes: number): void => {
    if (event.bytes <= maximumBytes) return;
    throw new ReplaySubscriptionError(
      "replay.subscriber_overflow",
      `Replay sequence ${event.event.sequence} exceeds its single-event byte limit`,
    );
  };

  const removeQueued = (sequence: number): QueuedEvent | undefined => {
    const existing = queue.get(sequence);
    if (existing === undefined) return undefined;
    queue.delete(sequence);
    queuedBytes -= existing.bytes;
    return existing;
  };

  const reserveConnectionLiveEvent = (event: QueuedEvent): void => {
    if (connectionBudget?.tryReserveLiveEvent(event.bytes) !== false) return;
    throw new ReplaySubscriptionError(
      "replay.subscriber_overflow",
      "The connection exceeded its aggregate replay backlog",
    );
  };

  const releaseConnectionLiveEvent = (event: QueuedEvent | undefined): void => {
    if (event !== undefined) connectionBudget?.releaseLiveEvent(event.bytes);
  };

  const deliveredIdentity = (sequence: number): ReplayDeliveredIdentity | undefined =>
    connectionBudget?.getDeliveredIdentity(options.sessionId, sequence) ?? delivered.get(sequence);

  const rememberDelivered = (event: QueuedEvent): void => {
    const identity = {
      eventId: event.event.eventId,
      fingerprint: event.fingerprint,
    };
    if (connectionBudget !== undefined) {
      connectionBudget.rememberDeliveredIdentity(
        options.sessionId,
        event.event.sequence,
        identity,
      );
      return;
    }
    const existing = delivered.get(event.event.sequence);
    if (existing !== undefined) deliveredBytes -= existing.bytes;
    const remembered = {
      ...identity,
      bytes:
        utf8.encode(identity.eventId).byteLength +
        utf8.encode(identity.fingerprint).byteLength,
    };
    delivered.set(event.event.sequence, remembered);
    deliveredBytes += remembered.bytes;
    const oldestRemembered = event.event.sequence - duplicateWindow + 1;
    for (const [sequence, retained] of delivered) {
      if (sequence >= oldestRemembered && deliveredBytes <= maxBufferedLiveBytes) break;
      delivered.delete(sequence);
      deliveredBytes -= retained.bytes;
    }
  };

  const reportLiveError = (error: unknown): void => {
    try {
      const reporting = options.callbacks.onLiveError?.(error, abortController.signal);
      if (reporting !== undefined) {
        void Promise.resolve(reporting).catch(() => {
          // Subscriber diagnostics must not affect the committed-event publisher.
        });
      }
    } catch {
      // Subscriber diagnostics must not affect the committed-event publisher.
    }
  };

  const deactivate = (failure: unknown | null): boolean => {
    if (!active) return false;
    active = false;
    disconnectError =
      failure instanceof ReplaySubscriptionError
        ? failure
        : new ReplaySubscriptionError(
            "replay.disconnected",
            `Replay subscriber for ${options.sessionId} disconnected`,
            failure === null ? undefined : { cause: failure },
          );
    for (const queued of queue.values()) releaseConnectionLiveEvent(queued);
    queue.clear();
    queuedBytes = 0;
    hubSubscription?.unsubscribe();
    for (const notifyDisconnected of disconnectWaiters) notifyDisconnected();
    disconnectWaiters.clear();
    abortController.abort(disconnectError);
    return true;
  };

  const failLive = (error: unknown): void => {
    if (!deactivate(error)) return;
    reportLiveError(error);
  };

  const assertActive = (): void => {
    if (active) return;
    if (disconnectError !== null) throw disconnectError;
    throw new ReplaySubscriptionError(
      "replay.disconnected",
      `Replay subscriber for ${options.sessionId} disconnected`,
    );
  };

  const awaitCollaborator = <T>(operation: () => T | PromiseLike<T>): Promise<Awaited<T>> => {
    assertActive();
    return new Promise<Awaited<T>>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        disconnectWaiters.delete(notifyDisconnected);
      };
      const resolveOnce = (value: Awaited<T>): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const rejectDisconnected = (): void => {
        try {
          assertActive();
        } catch (error) {
          rejectOnce(error);
        }
      };
      const notifyDisconnected = (): void => {
        queueMicrotask(rejectDisconnected);
      };

      disconnectWaiters.add(notifyDisconnected);
      queueMicrotask(() => {
        if (settled || !active) return;
        let collaborator: T | PromiseLike<T>;
        try {
          collaborator = operation();
        } catch (error) {
          if (active) rejectOnce(error);
          else rejectDisconnected();
          return;
        }
        void Promise.resolve(collaborator).then(
          (value) => {
            if (settled) return;
            try {
              assertActive();
              resolveOnce(value);
            } catch (error) {
              rejectOnce(error);
            }
          },
          (error: unknown) => {
            rejectOnce(error);
          },
        );
      });
    });
  };

  const queueLive = (event: SessionEvent): void => {
    if (!active) return;
    if (event.sessionId !== options.sessionId) {
      throw new ReplaySubscriptionError(
        "replay.sequence_conflict",
        "Replay subscriber received an event for another session",
      );
    }
    const candidate = queuedEvent(event);
    assertEventByteBound(candidate, maxSingleEventBytes);
    if (event.sequence <= deliveredSequence) {
      if (event.sequence <= options.afterSequence) return;
      const known = deliveredIdentity(event.sequence);
      if (known === undefined) {
        throw new ReplaySubscriptionError(
          "replay.sequence_conflict",
          `Sequence ${event.sequence} is outside the replay duplicate window`,
        );
      }
      if (known.eventId !== event.eventId || known.fingerprint !== candidate.fingerprint) {
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
      if (
        pendingLiveDeliveries >= maxBufferedLiveEvents ||
        pendingLiveBytes > maxBufferedLiveBytes - candidate.bytes
      ) {
        throw new ReplaySubscriptionError(
          "replay.subscriber_overflow",
          `Replay subscriber for ${options.sessionId} exceeded its bounded live backlog`,
        );
      }
      reserveConnectionLiveEvent(candidate);
      deliveredSequence = event.sequence;
      rememberDelivered(candidate);
      pendingLiveDeliveries += 1;
      pendingLiveBytes += candidate.bytes;
      liveTail = liveTail
        .then(async () => {
          if (active) {
            await awaitCollaborator(() =>
              options.callbacks.deliver(event, abortController.signal),
            );
          }
        })
        .catch((error: unknown) => {
          failLive(error);
        })
        .finally(() => {
          pendingLiveDeliveries -= 1;
          pendingLiveBytes -= candidate.bytes;
          releaseConnectionLiveEvent(candidate);
        });
      return;
    }

    const existing = queue.get(event.sequence);
    if (existing !== undefined) {
      if (
        existing.event.eventId !== event.eventId ||
        existing.fingerprint !== candidate.fingerprint
      ) {
        throw new ReplaySubscriptionError(
          "replay.sequence_conflict",
          `Queued sequence ${event.sequence} has conflicting identities`,
        );
      }
      return;
    }
    if (
      queue.size >= maxBufferedLiveEvents ||
      queuedBytes > maxBufferedLiveBytes - candidate.bytes
    ) {
      throw new ReplaySubscriptionError(
        "replay.subscriber_overflow",
        `Replay subscriber for ${options.sessionId} exceeded its bounded replay backlog`,
      );
    }
    reserveConnectionLiveEvent(candidate);
    queue.set(event.sequence, candidate);
    queuedBytes += candidate.bytes;
  };

  const hubSubscription: EventHubSubscription = options.hub.subscribeCommittedQueue(
    options.sessionId,
    queueLive,
    failLive,
  );

  const unsubscribe = (): void => {
    deactivate(null);
  };

  const queryFailure = (description: string, error: unknown): ReplaySubscriptionError => {
    if (error instanceof ReplaySubscriptionError) return error;
    if (options.isUnknownSessionError?.(error) === true) {
      return new ReplaySubscriptionError(
        "replay.unknown_session",
        `Session ${options.sessionId} is unknown`,
        { cause: error },
      );
    }
    return new ReplaySubscriptionError("replay.query_failed", description, { cause: error });
  };

  const readPage = async (afterSequence: number, head: number): Promise<ReplayEventPage> => {
    if (options.source.getEventPageAfter !== undefined) {
      return awaitCollaborator(() =>
        options.source.getEventPageAfter?.(
          {
            afterSequence,
            throughSequence: head,
            ...pageLimits,
          },
          abortController.signal,
        ) as Promise<ReplayEventPage>,
      );
    }
    if (legacyHistorical === null) {
      legacyHistorical = await awaitCollaborator(() =>
        options.source.getEventsAfter?.(
          options.afterSequence,
          head,
          abortController.signal,
        ) as Promise<readonly SessionEvent[]>,
      );
    }
    const offset = afterSequence - options.afterSequence;
    const events = legacyHistorical.slice(offset, offset + pageLimits.maximumEvents);
    return {
      events,
      nextAfterSequence: events.at(-1)?.sequence ?? afterSequence,
      done: offset + events.length >= legacyHistorical.length,
      serializedBytes: events.reduce(
        (total, event) => total + utf8.encode(canonicalJson(event)).byteLength,
        0,
      ),
    };
  };

  const ready = (async (): Promise<{ readonly throughSequence: number }> => {
    try {
      let head: number;
      try {
        head = await awaitCollaborator(() =>
          options.source.getHeadSequence(abortController.signal),
        );
      } catch (error) {
        throw queryFailure("Replay head query failed", error);
      }
      assertActive();
      if (options.afterSequence > head) {
        throw new ReplaySubscriptionError(
          "replay.cursor_ahead",
          `Replay cursor ${options.afterSequence} is ahead of committed head ${head}`,
        );
      }

      let expected = options.afterSequence + 1;
      let pageDone = false;
      while (!pageDone) {
        let releaseHistoricalPage: (() => void) | undefined;
        try {
          if (connectionBudget !== undefined) {
            releaseHistoricalPage = await awaitCollaborator(() =>
              connectionBudget.acquireHistoricalPage(abortController.signal),
            );
          }
          let page: ReplayEventPage;
          try {
            page = await readPage(expected - 1, head);
          } catch (error) {
            throw queryFailure("Replay event page query failed", error);
          }
          assertActive();
          if (
            page.events.length > pageLimits.maximumEvents ||
            !Number.isSafeInteger(page.serializedBytes) ||
            page.serializedBytes < 0 ||
            page.serializedBytes > pageLimits.maximumBytes
          ) {
            throw new ReplaySubscriptionError(
              "replay.query_failed",
              "Replay source exceeded its bounded page contract",
            );
          }
          if (page.events.length === 0 && !page.done) {
            throw new ReplaySubscriptionError(
              "replay.query_failed",
              "Replay source returned an empty nonterminal page",
            );
          }

          const validatedPage: QueuedEvent[] = [];
          let actualPageBytes = 0;
          for (const event of page.events) {
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
            const validatedEvent = queuedEvent(event);
            assertEventByteBound(validatedEvent, pageLimits.maximumSingleEventBytes);
            actualPageBytes += validatedEvent.bytes;
            if (actualPageBytes > pageLimits.maximumBytes) {
              throw new ReplaySubscriptionError(
                "replay.query_failed",
                "Replay source exceeded its page byte limit",
              );
            }
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
            validatedPage.push(validatedEvent);
            expected += 1;
          }
          const expectedNext = validatedPage.at(-1)?.event.sequence ?? expected - 1;
          if (page.nextAfterSequence !== expectedNext) {
            throw new ReplaySubscriptionError(
              "replay.sequence_conflict",
              "Replay source returned an invalid page continuation cursor",
            );
          }
          if (page.done && expected <= head) {
            throw new ReplaySubscriptionError(
              "replay.sequence_gap",
              `Historical replay ended at ${expected - 1}, below committed head ${head}`,
            );
          }
          if (!page.done && expected > head) {
            throw new ReplaySubscriptionError(
              "replay.sequence_conflict",
              "Replay source continued beyond the captured head",
            );
          }

          // Hold the connection page permit until the validated page is fully delivered.
          for (const validatedEvent of validatedPage) {
            const queuedHistorical = removeQueued(validatedEvent.event.sequence);
            try {
              await awaitCollaborator(() =>
                options.callbacks.deliver(validatedEvent.event, abortController.signal),
              );
              deliveredSequence = validatedEvent.event.sequence;
              rememberDelivered(validatedEvent);
            } finally {
              releaseConnectionLiveEvent(queuedHistorical);
            }
          }
          pageDone = page.done;
        } finally {
          releaseHistoricalPage?.();
        }
      }
      if (expected !== head + 1) {
        throw new ReplaySubscriptionError(
          "replay.sequence_gap",
          `Historical replay ended at ${expected - 1}, below committed head ${head}`,
        );
      }

      for (const [sequence, queued] of queue) {
        if (sequence > head) continue;
        const known = deliveredIdentity(sequence);
        if (known === undefined) {
          throw new ReplaySubscriptionError(
            "replay.sequence_conflict",
            `Queued sequence ${sequence} is outside the replay duplicate window`,
          );
        }
        if (
          known.eventId !== queued.event.eventId ||
          known.fingerprint !== queued.fingerprint
        ) {
          throw new ReplaySubscriptionError(
            "replay.sequence_conflict",
            `Queued sequence ${sequence} conflicts with historical replay`,
          );
        }
        releaseConnectionLiveEvent(removeQueued(sequence));
      }

      await awaitCollaborator(() =>
        options.callbacks.replayComplete(head, abortController.signal),
      );
      deliveredSequence = head;

      while (queue.size > 0) {
        const nextSequence = deliveredSequence + 1;
        const queued = removeQueued(nextSequence);
        if (queued === undefined) {
          throw new ReplaySubscriptionError(
            "replay.sequence_gap",
            `Buffered live delivery is missing expected sequence ${nextSequence}`,
          );
        }
        try {
          await awaitCollaborator(() =>
            options.callbacks.deliver(queued.event, abortController.signal),
          );
          deliveredSequence = nextSequence;
          rememberDelivered(queued);
        } finally {
          releaseConnectionLiveEvent(queued);
        }
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
