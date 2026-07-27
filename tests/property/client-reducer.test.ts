import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../packages/protocol/src/canonical-json.js";
import {
  SessionEventSchema,
  type SessionEvent,
  type SessionEventType,
} from "../../packages/protocol/src/events.js";
import {
  createBrowserSessionState,
  type BrowserApproval,
  type BrowserPendingInput,
  type BrowserSessionState,
} from "../../packages/client-state/src/model.js";
import { reduceSessionEvent } from "../../packages/client-state/src/reducer.js";
import {
  beginReplay,
  completeReplay,
  replaySessionEventChunks,
  replaySessionEvents,
} from "../../packages/client-state/src/replay.js";
import {
  COMPLETE_EVENT_MUTATIONS,
  mutateCompleteEvent,
} from "./support/replay-oracle.js";

const propertySeed = Number.parseInt(process.env.WI_FC_SEED ?? "737373", 10);
const propertyPath = process.env.WI_FC_PATH;
const propertyOptions = {
  numRuns: 1_000,
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

type ReplayInteraction = "none" | "approval" | "input";
type ReplayPayload = "providerText" | "toolResult";

interface ReplayRunInput {
  readonly interaction: ReplayInteraction;
  readonly leavePending: boolean;
  readonly messageText: string;
  readonly payload: ReplayPayload;
}

interface ReplayScenario {
  readonly events: readonly SessionEvent[];
  readonly expectedState: BrowserSessionState;
}

const replayRunInput = fc.record({
  interaction: fc.constantFrom<ReplayInteraction>("none", "approval", "input"),
  leavePending: fc.boolean(),
  messageText: fc.string({ maxLength: 64 }),
  payload: fc.constantFrom<ReplayPayload>("providerText", "toolResult"),
});

function buildReplayScenario(input: {
  readonly title: string;
  readonly runs: readonly ReplayRunInput[];
}): ReplayScenario {
  const events: SessionEvent[] = [];
  let sequence = 1;
  let lastMessagePreview: string | null = null;
  let activeRun: BrowserSessionState["activeRun"] = null;
  const pendingApprovals: Record<string, BrowserApproval> = {};
  const pendingInputs: Record<string, BrowserPendingInput> = {};
  const append = (eventType: SessionEventType, data: unknown): void => {
    events.push(event(sequence, `evt_replay${sequence}`, eventType, data));
    sequence += 1;
  };

  append("session.created", { eventVersion: 1, title: input.title });
  input.runs.forEach((run, index) => {
    const runId = `run_replay${index}`;
    const messageId = `msg_replay${index}`;
    const unresolved =
      index === input.runs.length - 1 && run.leavePending && run.interaction !== "none";

    append("user.message.appended", {
      eventVersion: 1,
      messageId,
      runId,
      text: run.messageText,
    });
    lastMessagePreview = run.messageText;
    append("run.created", { eventVersion: 1, runId });
    append("run.started", { eventVersion: 1, runId });
    activeRun = { runId, state: "running" };

    if (run.payload === "providerText") {
      append("provider.text.delta", {
        eventVersion: 1,
        runId,
        stepId: `step_replay${index}`,
        messageId,
        partId: `part_replay${index}`,
        text: `Assistant ${run.messageText}`,
      });
    } else {
      append("tool.execution.completed", {
        eventVersion: 1,
        runId,
        callId: `call_replay${index}`,
        result: { message: run.messageText, runIndex: index },
      });
    }

    if (run.interaction === "approval") {
      const approvalId = `approval_replay${index}`;
      const callId = `call_replay${index}`;
      const summary = `Approve run ${index}`;
      append("tool.approval.requested", {
        eventVersion: 1,
        runId,
        callId,
        approvalId,
        toolName: "guarded_echo",
        actionDigest: "a".repeat(64),
        summary,
      });
      append("run.waiting_for_user", {
        eventVersion: 1,
        runId,
        reason: "approval",
        approvalId,
      });
      activeRun = { runId, state: "waiting_for_user" };
      if (unresolved) {
        pendingApprovals[approvalId] = {
          approvalId,
          runId,
          callId,
          toolName: "guarded_echo",
          summary,
        };
      } else {
        append("tool.approval.resolved", {
          eventVersion: 1,
          runId,
          callId,
          approvalId,
          resolution: "approved",
        });
        append("run.started", { eventVersion: 1, runId });
        activeRun = { runId, state: "running" };
      }
    } else if (run.interaction === "input") {
      const inputId = `input_replay${index}`;
      const prompt = `Input for run ${index}?`;
      append("input.requested", { eventVersion: 1, runId, inputId, prompt });
      append("run.waiting_for_user", {
        eventVersion: 1,
        runId,
        reason: "input",
        inputId,
      });
      activeRun = { runId, state: "waiting_for_user" };
      if (unresolved) {
        pendingInputs[inputId] = { inputId, runId, prompt };
      } else {
        append("input.resolved", {
          eventVersion: 1,
          runId,
          inputId,
          value: { answer: run.messageText },
        });
        append("run.started", { eventVersion: 1, runId });
        activeRun = { runId, state: "running" };
      }
    }

    if (!unresolved) {
      append("run.completed", { eventVersion: 1, runId });
      activeRun = { runId, state: "completed" };
    }
  });

  const appliedEvents: Record<number, SessionEvent> = {};
  const appliedEventSequencesById: Record<string, number> = {};
  let retainedEventCodeUnits = 0;
  for (const replayEvent of events) {
    appliedEvents[replayEvent.sequence] = replayEvent;
    appliedEventSequencesById[replayEvent.eventId] = replayEvent.sequence;
    retainedEventCodeUnits += canonicalJson(replayEvent).length;
  }

  return {
    events,
    expectedState: {
      sessionId: "ses_A",
      title: input.title,
      lastMessagePreview,
      lastAppliedSequence: events.length,
      status: "live",
      timeline: events,
      activeRun,
      queuedRuns: [],
      pendingApprovals,
      pendingInputs,
      appliedEvents,
      appliedEventSequencesById,
      retainedEventCodeUnits,
      errorCode: null,
    },
  };
}

const validReplayScenario = fc
  .record({
    title: fc.string({ maxLength: 40 }),
    runs: fc.array(replayRunInput, { maxLength: 6 }),
  })
  .map(buildReplayScenario);

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
  it("duplicates produce the independently modeled browser state", async () => {
    await runProperty(
      "duplicates produce the independently modeled browser state",
      fc.property(
        validReplayScenario,
        fc.array(fc.array(fc.nat(), { maxLength: 4 }), { maxLength: 60 }),
        ({ events, expectedState }, duplicateSlots) => {
          const withDuplicates: SessionEvent[] = [];
          events.forEach((item, eventIndex) => {
            withDuplicates.push(item);
            for (const duplicateIndex of duplicateSlots[eventIndex] ?? []) {
              const duplicate = events[duplicateIndex % (eventIndex + 1)];
              if (duplicate !== undefined) withDuplicates.push(structuredClone(duplicate));
            }
          });
          const replayed = replaySessionEvents(
            beginReplay(createBrowserSessionState("ses_A")),
            withDuplicates,
          );
          expect(completeReplay(replayed, events.length)).toEqual(expectedState);
        },
      ),
    );
  }, 30_000);

  it("replay and reconnect grouping produces the independently modeled browser state", async () => {
    await runProperty(
      "replay and reconnect grouping produces the independently modeled browser state",
      fc.property(
        validReplayScenario,
        fc.array(fc.integer({ min: 1, max: 50 }), { maxLength: 60 }),
        ({ events, expectedState }, sizes) => {
          const initial = beginReplay(createBrowserSessionState("ses_A"));
          const chunked = replaySessionEventChunks(initial, chunkEvents(events, sizes));
          expect(completeReplay(chunked, events.length)).toEqual(expectedState);
        },
      ),
    );
  }, 30_000);

  it("rejects same-sequence mutations to every complete event field", async () => {
    await runProperty(
      "same-sequence complete event mutations are fatal",
      fc.property(
        validReplayScenario,
        fc.nat(),
        fc.constantFrom(...COMPLETE_EVENT_MUTATIONS),
        ({ events }, eventSelector, mutation) => {
          const trusted = replaySessionEvents(
            beginReplay(createBrowserSessionState("ses_A")),
            events,
          );
          const original = events[eventSelector % events.length];
          expect(original).toBeDefined();
          if (original === undefined) return;
          const mutated = mutateCompleteEvent(original, mutation);
          expect(mutated.sequence).toBe(original.sequence);
          expect(mutated).not.toEqual(original);
          expect(reduceSessionEvent(trusted, mutated)).toMatchObject({
            status: "error",
            errorCode: "event_conflict",
          });
        },
      ),
    );
  }, 30_000);

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
