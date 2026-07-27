import fc from "fast-check";
import {
  beginReplaySubscription,
  CommittedEventHub,
} from "../../packages/harness-core/src/index.js";
import type { ServerMessage, SessionEvent } from "@wi/protocol";
import { describe, expect, it } from "vitest";
import {
  decodeClientFrame,
  FrameDecodeError,
} from "../../apps/server/src/websocket/frame-decoder.js";
import {
  OutboundQueue,
  SLOW_CONSUMER_CLOSE_CODE,
  type OutboundTransport,
} from "../../apps/server/src/websocket/outbound-queue.js";
import {
  COMPLETE_EVENT_MUTATIONS,
  generatedReplayEvent,
  mutateCompleteEvent,
} from "./support/replay-oracle.js";

const propertySeed = Number.parseInt(process.env.WI_FC_SEED ?? "737373", 10);
const propertyPath = process.env.WI_FC_PATH;
function propertyOptions(numRuns: number): fc.Parameters<unknown> {
  return {
    numRuns,
    seed: propertySeed,
    ...(propertyPath === undefined ? {} : { path: propertyPath }),
  };
}

class BlockingTransport implements OutboundTransport {
  readonly closes: Array<{ code: number; reason: string }> = [];

  send(data: string, callback: (error?: Error | null) => void): void {
    void data;
    void callback;
    // Intentionally never completes so every accepted frame remains accounted as queued/in-flight.
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
}

type DurableEvent = Extract<ServerMessage, { readonly kind: "event" }>;

function heartbeat(): ServerMessage {
  return { v: 1, kind: "heartbeat", serverTimeMs: 1 };
}

function durableEvent(sequence: number, variant = sequence): DurableEvent {
  return generatedReplayEvent("ses_propertyQueue", sequence, variant) as DurableEvent;
}

function expectCompleteReplay(
  delivered: readonly SessionEvent[],
  expected: readonly SessionEvent[],
): void {
  expect(delivered).toEqual(expected);
}

describe("Milestone 5 bounded gateway properties", () => {
  it("classifies arbitrary bounded bytes without allowing decoder failures to escape", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 70_000 }),
        fc.boolean(),
        (bytes, isBinary) => {
          let reachedCommandExecution = false;
          try {
            const decoded = decodeClientFrame(bytes, isBinary, {
              maximumBytes: 64 * 1_024,
              maximumDepth: 32,
            });
            if (decoded.kind === "command") reachedCommandExecution = true;
          } catch (error) {
            expect(error).toBeInstanceOf(FrameDecodeError);
            expect(reachedCommandExecution).toBe(false);
          }
        },
      ),
      propertyOptions(1_000),
    );
  });

  it("preserves replay/live equivalence across generated race boundaries", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 32 }),
        fc.nat(),
        async (eventVariants, splitSeed) => {
          const historicalCount = splitSeed % (eventVariants.length + 1);
          const events = eventVariants.map((variant, index) =>
            durableEvent(index + 1, variant),
          );
          const hub = new CommittedEventHub();
          for (const event of events.slice(0, historicalCount)) {
            hub.publishCommitted(event);
          }
          const delivered: SessionEvent[] = [];
          const boundaries: number[] = [];
          let publishedLive = false;
          const subscription = beginReplaySubscription({
            sessionId: "ses_propertyQueue",
            afterSequence: 0,
            source: {
              getHeadSequence: async () => historicalCount,
              getEventsAfter: async (_afterSequence, throughSequence) => {
                if (!publishedLive) {
                  publishedLive = true;
                  for (const event of events.slice(historicalCount)) {
                    hub.publishCommitted(event);
                  }
                }
                return events.slice(0, throughSequence);
              },
            },
            hub,
            callbacks: {
              deliver: (event) => {
                delivered.push(event);
              },
              replayComplete: (throughSequence) => {
                boundaries.push(throughSequence);
              },
            },
            maxBufferedLiveEvents: eventVariants.length,
          });

          await subscription.ready;
          subscription.unsubscribe();
          await subscription.drain();
          expectCompleteReplay(delivered, events);
          expect(boundaries).toEqual([historicalCount]);
        },
      ),
      propertyOptions(1_000),
    );
  });

  it("rejects same-sequence mutations that the former sequence-only oracle missed", () => {
    const expectedEvent = durableEvent(1, 0);
    const expected = [expectedEvent];
    for (const mutation of COMPLETE_EVENT_MUTATIONS) {
      const transformed = [mutateCompleteEvent(expectedEvent, mutation)];
      expect(transformed.map((event) => event.sequence)).toEqual(
        expected.map((event) => event.sequence),
      );
      expect(() => expectCompleteReplay(transformed, expected)).toThrow();
    }
  });

  it("reconstructs generated reconnect suffixes from the last trusted cursor", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 32 }),
        fc.nat(),
        async (eventVariants, cursorSeed) => {
          const eventCount = eventVariants.length;
          const cursor = cursorSeed % (eventCount + 1);
          const events = eventVariants.map((variant, index) =>
            durableEvent(index + 1, variant),
          );
          const delivered: SessionEvent[] = [];
          const subscription = beginReplaySubscription({
            sessionId: "ses_propertyQueue",
            afterSequence: cursor,
            source: {
              getHeadSequence: async () => eventCount,
              getEventsAfter: async (afterSequence, throughSequence) =>
                events.filter(
                  (event) =>
                    event.sequence > afterSequence && event.sequence <= throughSequence,
                ),
            },
            hub: new CommittedEventHub(),
            callbacks: {
              deliver: (event) => {
                delivered.push(event);
              },
              replayComplete: () => undefined,
            },
            maxBufferedLiveEvents: eventCount,
          });

          await subscription.ready;
          subscription.unsubscribe();
          await subscription.drain();
          expectCompleteReplay(delivered, events.slice(cursor));
        },
      ),
      propertyOptions(1_000),
    );
  });

  it("closes exactly when cumulative outbound bytes cross the configured bound", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 32 }), (acceptedFrames) => {
        const transport = new BlockingTransport();
        const frame = heartbeat();
        const frameBytes = Buffer.byteLength(JSON.stringify(frame));
        const queue = new OutboundQueue(transport, {
          maximumMessages: acceptedFrames + 1,
          maximumBytes: frameBytes * acceptedFrames,
          maximumSingleMessageBytes: frameBytes,
        });

        for (let index = 0; index < acceptedFrames; index += 1) {
          expect(queue.enqueue(frame)).toBe(true);
        }
        expect(queue.state.bytes).toBe(frameBytes * acceptedFrames);
        expect(queue.enqueue(frame)).toBe(false);
        expect(queue.state.closeReason).toBe("slow_consumer");
        expect(transport.closes.at(-1)?.code).toBe(SLOW_CONSUMER_CLOSE_CODE);
      }),
      propertyOptions(1_000),
    );
  });

  it("rejects frames that cross the configured single-message byte bound", () => {
    const frame = heartbeat();
    const frameBytes = Buffer.byteLength(JSON.stringify(frame));
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: frameBytes - 1 }),
        (maximumSingleMessageBytes) => {
          const transport = new BlockingTransport();
          const queue = new OutboundQueue(transport, {
            maximumMessages: 2,
            maximumBytes: frameBytes * 2,
            maximumSingleMessageBytes,
          });

          expect(queue.enqueue(frame)).toBe(false);
          expect(queue.state.closeReason).toBe("slow_consumer");
          expect(transport.closes.at(-1)?.code).toBe(SLOW_CONSUMER_CLOSE_CODE);
        },
      ),
      propertyOptions(1_000),
    );
  });

  it("never exceeds queue bounds and never silently drops a non-droppable event", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 32 }),
        fc.integer({ min: 1, max: 20 }),
        (maximumMessages, attempts) => {
          const transport = new BlockingTransport();
          const queue = new OutboundQueue(transport, {
            maximumMessages,
            maximumBytes: 1_024 * 1_024,
            maximumSingleMessageBytes: 16 * 1_024,
          });
          for (let index = 1; index <= attempts; index += 1) {
            const accepted = queue.enqueue(durableEvent(index));
            const state = queue.state;
            if (accepted) {
              expect(state.closed).toBe(false);
              expect(state.messages).toBeLessThanOrEqual(maximumMessages);
              expect(state.bytes).toBeLessThanOrEqual(1_024 * 1_024);
            } else {
              expect(state.closed).toBe(true);
              expect(state.closeReason).toBe("slow_consumer");
              expect(transport.closes.at(-1)?.code).toBe(SLOW_CONSUMER_CLOSE_CODE);
            }
          }
        },
      ),
      propertyOptions(1_000),
    );
  }, 10_000);
});
