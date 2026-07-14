import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  SessionEventSchema,
  type SessionEvent,
  type SessionEventType,
} from "../../packages/protocol/src/events.js";
import { createBrowserSessionState } from "../../packages/client-state/src/model.js";
import { reduceSessionEvent } from "../../packages/client-state/src/reducer.js";
import {
  beginReplay,
  completeReplay,
  replaySessionEventChunks,
  replaySessionEvents,
} from "../../packages/client-state/src/replay.js";

const propertySeed = Number.parseInt(process.env.WI_FC_SEED ?? "313131", 10);
const propertyPath = process.env.WI_FC_PATH;
const propertyOptions = {
  numRuns: 250,
  seed: propertySeed,
  ...(propertyPath === undefined ? {} : { path: propertyPath }),
} as const;

function event(
  sequence: number,
  eventId: string,
  eventType: SessionEventType,
  data: unknown,
): SessionEvent {
  return SessionEventSchema.parse({
    v: 1,
    kind: "event",
    sessionId: "ses_A",
    sequence,
    eventId,
    eventType,
    createdAtMs: sequence,
    data,
  });
}

const validOrderedEvents = fc
  .array(fc.boolean(), { maxLength: 12 })
  .map((waits) => {
    const events: SessionEvent[] = [];
    let sequence = 1;
    waits.forEach((wait, index) => {
      const runId = `run_${index}`;
      events.push(event(sequence, `evt_${sequence}`, "run.created", { eventVersion: 1, runId }));
      sequence += 1;
      events.push(event(sequence, `evt_${sequence}`, "run.started", { eventVersion: 1, runId }));
      sequence += 1;
      if (wait) {
        events.push(
          event(sequence, `evt_${sequence}`, "run.waiting_for_user", {
            eventVersion: 1,
            runId,
            reason: "input",
            inputId: `input_${index}`,
          }),
        );
        sequence += 1;
        events.push(event(sequence, `evt_${sequence}`, "run.started", { eventVersion: 1, runId }));
        sequence += 1;
      }
      events.push(event(sequence, `evt_${sequence}`, "run.completed", { eventVersion: 1, runId }));
      sequence += 1;
    });
    return events;
  });

const terminalEventTypes = [
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
] as const;

function terminalEvent(
  sequence: number,
  eventType: (typeof terminalEventTypes)[number],
  runId: string,
): SessionEvent {
  switch (eventType) {
    case "run.completed":
    case "run.cancelled":
      return event(sequence, `evt_${sequence}`, eventType, { eventVersion: 1, runId });
    case "run.failed":
    case "run.interrupted":
      return event(sequence, `evt_${sequence}`, eventType, {
        eventVersion: 1,
        runId,
        code: "provider.incomplete",
        message: "Provider stopped.",
        diagnosticId: "err_property",
      });
  }
}

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

async function runProperty(name: string, property: fc.IProperty<unknown>): Promise<void> {
  try {
    await fc.assert(property, propertyOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const minimizedPath = /path: "([^"]*)"/i.exec(message)?.[1];
    const pathArgument = minimizedPath === undefined ? "" : ` WI_FC_PATH=${minimizedPath}`;
    throw new Error(
      `${name}\n${message}\nReproduction command: WI_FC_SEED=${propertySeed}${pathArgument} pnpm test:property`,
      { cause: error },
    );
  }
}

describe("client reducer replay properties", () => {
  it("duplicates produce the same state as unique ordered events", async () => {
    await runProperty(
      "duplicates produce the same state as unique ordered events",
      fc.property(
        validOrderedEvents,
        fc.array(fc.array(fc.nat(), { maxLength: 4 }), { maxLength: 60 }),
        (events, duplicateSlots) => {
          const withDuplicates: SessionEvent[] = [];
          events.forEach((item, eventIndex) => {
            withDuplicates.push(item);
            for (const duplicateIndex of duplicateSlots[eventIndex] ?? []) {
              const duplicate = events[duplicateIndex % (eventIndex + 1)];
              if (duplicate !== undefined) withDuplicates.push(structuredClone(duplicate));
            }
          });
          const initial = createBrowserSessionState("ses_A");
          expect(replaySessionEvents(initial, withDuplicates)).toEqual(
            replaySessionEvents(initial, events),
          );
        },
      ),
    );
  });

  it("replay and reconnect grouping equals one complete replay", async () => {
    await runProperty(
      "replay and reconnect grouping equals one complete replay",
      fc.property(
        validOrderedEvents,
        fc.array(fc.integer({ min: 1, max: 50 }), { maxLength: 60 }),
        (events, sizes) => {
          const initial = beginReplay(createBrowserSessionState("ses_A"));
          const chunked = replaySessionEventChunks(initial, chunkEvents(events, sizes));
          const complete = replaySessionEvents(initial, events);
          expect(chunked).toEqual(complete);
          expect(completeReplay(chunked, events.length)).toEqual(
            completeReplay(complete, events.length),
          );
        },
      ),
    );
  });

  it("leaves no pending interaction belonging to a terminal run", async () => {
    await runProperty(
      "terminal runs own no pending browser interactions",
      fc.property(
        fc.constantFrom(...terminalEventTypes),
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 0, max: 8 }),
        (terminalType, approvalCount, inputCount) => {
          const runId = "run_terminal";
          const events: SessionEvent[] = [];
          let sequence = 1;
          const next = (eventType: SessionEventType, data: unknown): void => {
            events.push(event(sequence, `evt_${sequence}`, eventType, data));
            sequence += 1;
          };

          next("run.created", { eventVersion: 1, runId });
          next("run.started", { eventVersion: 1, runId });
          for (let index = 0; index < approvalCount; index += 1) {
            next("tool.approval.requested", {
              eventVersion: 1,
              runId,
              callId: `call_${index}`,
              approvalId: `approval_${index}`,
              toolName: "guarded_echo",
              actionDigest: "a".repeat(64),
              summary: `approval ${index}`,
            });
          }
          for (let index = 0; index < inputCount; index += 1) {
            next("input.requested", {
              eventVersion: 1,
              runId,
              inputId: `input_${index}`,
              prompt: `input ${index}`,
            });
          }
          if (terminalType === "run.cancelled") {
            next("run.cancel.requested", { eventVersion: 1, runId });
          }
          events.push(terminalEvent(sequence, terminalType, runId));

          const state = replaySessionEvents(createBrowserSessionState("ses_A"), events);
          expect(state.errorCode).toBeNull();
          expect(Object.values(state.pendingApprovals).every((item) => item.runId !== runId)).toBe(
            true,
          );
          expect(Object.values(state.pendingInputs).every((item) => item.runId !== runId)).toBe(true);
        },
      ),
    );
  });

  it("preserves exact FIFO order for generated queued creations and starts", async () => {
    await runProperty(
      "queued creations and starts preserve exact FIFO order",
      fc.property(fc.integer({ min: 1, max: 12 }), (queuedCount) => {
        let sequence = 1;
        const nextEvent = (eventType: SessionEventType, runId: string): SessionEvent => {
          const current = sequence;
          sequence += 1;
          return event(current, `evt_${current}`, eventType, { eventVersion: 1, runId });
        };
        let state = createBrowserSessionState("ses_A");
        state = reduceSessionEvent(state, nextEvent("run.created", "run_0"));
        state = reduceSessionEvent(state, nextEvent("run.started", "run_0"));
        const queuedRunIds = Array.from(
          { length: queuedCount },
          (_, index) => `run_${index + 1}`,
        );
        for (const runId of queuedRunIds) {
          state = reduceSessionEvent(state, nextEvent("run.created", runId));
        }
        expect(state.errorCode).toBeNull();
        expect(state.queuedRuns.map((run) => run.runId)).toEqual(queuedRunIds);

        let activeRunId = "run_0";
        for (const [index, runId] of queuedRunIds.entries()) {
          state = reduceSessionEvent(state, nextEvent("run.completed", activeRunId));
          state = reduceSessionEvent(state, nextEvent("run.started", runId));
          expect(state.errorCode).toBeNull();
          expect(state.activeRun).toEqual({ runId, state: "running" });
          expect(state.queuedRuns.map((run) => run.runId)).toEqual(
            queuedRunIds.slice(index + 1),
          );
          activeRunId = runId;
        }
      }),
    );
  });

  it("gaps are recoverable but generated integrity faults remain fatal", async () => {
    await runProperty(
      "gaps are recoverable but generated integrity faults remain fatal",
      fc.property(
        fc.constantFrom("sequence", "eventId", "eventIdGap", "secondRun", "terminal"),
        (fault) => {
          const created = event(1, "evt_1", "run.created", { eventVersion: 1, runId: "run_A" });
          const started = event(2, "evt_2", "run.started", { eventVersion: 1, runId: "run_A" });
          const running = replaySessionEvents(createBrowserSessionState("ses_A"), [created, started]);
          let fatalState;
          switch (fault) {
            case "sequence":
              fatalState = reduceSessionEvent(running, { ...started, eventId: "evt_changed" });
              break;
            case "eventId":
              fatalState = reduceSessionEvent(
                running,
                event(3, "evt_1", "run.waiting_for_user", {
                  eventVersion: 1,
                  runId: "run_A",
                  reason: "input",
                  inputId: "input_A",
                }),
              );
              break;
            case "eventIdGap":
              fatalState = reduceSessionEvent(
                running,
                event(5, "evt_1", "run.waiting_for_user", {
                  eventVersion: 1,
                  runId: "run_A",
                  reason: "input",
                  inputId: "input_A",
                }),
              );
              break;
            case "secondRun": {
              const queued = reduceSessionEvent(
                running,
                event(3, "evt_3", "run.created", { eventVersion: 1, runId: "run_B" }),
              );
              fatalState = reduceSessionEvent(
                queued,
                event(4, "evt_4", "run.started", { eventVersion: 1, runId: "run_B" }),
              );
              break;
            }
            case "terminal": {
              const completed = reduceSessionEvent(
                running,
                event(3, "evt_3", "run.completed", { eventVersion: 1, runId: "run_A" }),
              );
              fatalState = reduceSessionEvent(
                completed,
                event(4, "evt_4", "run.started", { eventVersion: 1, runId: "run_A" }),
              );
              break;
            }
          }
          expect(fatalState.errorCode).not.toBeNull();
          expect(beginReplay(fatalState)).toBe(fatalState);
          expect(completeReplay(fatalState, fatalState.lastAppliedSequence)).toBe(fatalState);

          const gap = reduceSessionEvent(
            createBrowserSessionState("ses_A"),
            event(2, "evt_gap", "run.started", { eventVersion: 1, runId: "run_A" }),
          );
          expect(gap).toMatchObject({ status: "gap", errorCode: null });
          expect(beginReplay(gap).status).toBe("replaying");
        },
      ),
    );
  });
});
