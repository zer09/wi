import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  SessionEventSchema,
  type SessionEvent,
  type SessionEventType,
} from "../../packages/protocol/src/events.js";
import { createBrowserSessionState } from "../../packages/client-state/src/model.js";
import {
  replaySessionEventChunks,
  replaySessionEvents,
} from "../../packages/client-state/src/replay.js";

const propertyOptions = { numRuns: 250 } as const;
const eventTypes = [
  "session.created",
  "run.created",
  "run.started",
  "run.waiting_for_user",
  "run.completed",
] as const satisfies readonly SessionEventType[];

function dataFor(eventType: (typeof eventTypes)[number], title: string): unknown {
  switch (eventType) {
    case "session.created":
      return { eventVersion: 1, title };
    case "run.created":
    case "run.started":
    case "run.completed":
      return { eventVersion: 1, runId: "run_A" };
    case "run.waiting_for_user":
      return {
        eventVersion: 1,
        runId: "run_A",
        reason: "input",
        inputId: "input_A",
      };
  }
}

const orderedEvents = fc
  .array(fc.record({ eventType: fc.constantFrom(...eventTypes), title: fc.string() }), {
    maxLength: 40,
  })
  .map((items) =>
    items.map((item, index) =>
      SessionEventSchema.parse({
        v: 1,
        kind: "event",
        sessionId: "ses_A",
        sequence: index + 1,
        eventId: `evt_${index + 1}`,
        eventType: item.eventType,
        createdAtMs: index + 1,
        data: dataFor(item.eventType, item.title),
      }),
    ),
  );

function chunkEvents(events: readonly SessionEvent[], sizes: readonly number[]): SessionEvent[][] {
  const chunks: SessionEvent[][] = [];
  let offset = 0;
  let sizeIndex = 0;

  while (offset < events.length) {
    const requested = sizes[sizeIndex] ?? events.length;
    const size = Math.max(1, requested % (events.length - offset + 1));
    chunks.push(events.slice(offset, offset + size));
    offset += size;
    sizeIndex += 1;
  }
  return chunks;
}

describe("client reducer replay properties", () => {
  it("duplicates produce the same state as unique ordered events", () => {
    fc.assert(
      fc.property(
        orderedEvents,
        fc.array(fc.array(fc.nat(), { maxLength: 4 }), { maxLength: 40 }),
        (events, duplicateSlots) => {
          const withDuplicates: SessionEvent[] = [];
          events.forEach((event, eventIndex) => {
            withDuplicates.push(event);
            for (const duplicateIndex of duplicateSlots[eventIndex] ?? []) {
              const duplicate = events[duplicateIndex % (eventIndex + 1)];
              if (duplicate !== undefined) withDuplicates.push(structuredClone(duplicate));
            }
          });
          const deduplicated = [
            ...new Map(withDuplicates.map((event) => [event.sequence, event])).values(),
          ].sort((left, right) => left.sequence - right.sequence);
          const initial = createBrowserSessionState("ses_A");

          expect(replaySessionEvents(initial, withDuplicates)).toEqual(
            replaySessionEvents(initial, deduplicated),
          );
        },
      ),
      propertyOptions,
    );
  });

  it("arbitrary replay chunks equal one complete replay", () => {
    fc.assert(
      fc.property(
        orderedEvents,
        fc.array(fc.integer({ min: 1, max: 50 }), { maxLength: 40 }),
        (events, sizes) => {
          const initial = createBrowserSessionState("ses_A");
          expect(replaySessionEventChunks(initial, chunkEvents(events, sizes))).toEqual(
            replaySessionEvents(initial, events),
          );
        },
      ),
      propertyOptions,
    );
  });
});
