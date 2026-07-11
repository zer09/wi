import { describe, expect, it } from "vitest";

import { SessionEventSchema, type SessionEventType } from "@wi/protocol";
import { createBrowserSessionState } from "./model.js";
import { reduceSessionEvent } from "./reducer.js";
import {
  beginReplay,
  completeReplay,
  replaySessionEventChunks,
  replaySessionEvents,
} from "./replay.js";

function reverseObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseObjectKeys) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)]),
  ) as T;
}

function event(sequence: number, eventType: SessionEventType, data: unknown) {
  return SessionEventSchema.parse({
    v: 1,
    kind: "event",
    sessionId: "ses_A",
    sequence,
    eventId: `evt_${sequence}`,
    eventType,
    createdAtMs: sequence,
    data,
  });
}

const created = event(1, "run.created", { eventVersion: 1, runId: "run_A" });
const started = event(2, "run.started", { eventVersion: 1, runId: "run_A" });
const completed = event(3, "run.completed", { eventVersion: 1, runId: "run_A" });

describe("browser session reducer", () => {
  it("applies contiguous events", () => {
    const state = replaySessionEvents(createBrowserSessionState("ses_A"), [created, started]);

    expect(state.lastAppliedSequence).toBe(2);
    expect(state.timeline).toEqual([created, started]);
    expect(state.activeRun).toEqual({ runId: "run_A", state: "running" });
  });

  it("ignores separately decoded exact duplicate content", () => {
    const once = reduceSessionEvent(createBrowserSessionState("ses_A"), created);
    const duplicate = reverseObjectKeys(created);

    expect(duplicate).not.toBe(created);
    expect(duplicate.data).not.toBe(created.data);
    expect(reduceSessionEvent(once, duplicate)).toBe(once);
  });

  it("rejects conflicting duplicate content", () => {
    const once = reduceSessionEvent(createBrowserSessionState("ses_A"), created);
    const conflict = { ...created, eventId: "evt_conflict" };
    const state = reduceSessionEvent(once, conflict);

    expect(state.status).toBe("error");
    expect(state.errorCode).toBe("event_conflict");
    expect(state.lastAppliedSequence).toBe(1);
  });

  it("detects a sequence gap without applying the event", () => {
    const state = reduceSessionEvent(createBrowserSessionState("ses_A"), started);

    expect(state.status).toBe("gap");
    expect(state.lastAppliedSequence).toBe(0);
    expect(state.timeline).toEqual([]);
  });

  it("never regresses a terminal run", () => {
    const terminal = replaySessionEvents(createBrowserSessionState("ses_A"), [
      created,
      started,
      completed,
    ]);
    const lateStarted = event(4, "run.started", { eventVersion: 1, runId: "run_A" });
    const state = reduceSessionEvent(terminal, lateStarted);

    expect(state.activeRun).toEqual({ runId: "run_A", state: "completed" });
    expect(state.status).toBe("error");
    expect(state.errorCode).toBe("terminal_run_regression");
  });

  it("tracks and resolves pending approvals and input", () => {
    const events = [
      event(1, "tool.approval.requested", {
        eventVersion: 1,
        runId: "run_A",
        callId: "call_A",
        approvalId: "approval_A",
        toolName: "guarded_echo",
        actionDigest: "a".repeat(64),
        summary: "Echo hello",
      }),
      event(2, "input.requested", {
        eventVersion: 1,
        runId: "run_A",
        inputId: "input_A",
        prompt: "Continue?",
      }),
      event(3, "tool.approval.resolved", {
        eventVersion: 1,
        runId: "run_A",
        callId: "call_A",
        approvalId: "approval_A",
        resolution: "approved",
      }),
      event(4, "input.resolved", {
        eventVersion: 1,
        runId: "run_A",
        inputId: "input_A",
        value: "yes",
      }),
    ];

    const waiting = replaySessionEvents(createBrowserSessionState("ses_A"), events.slice(0, 2));
    expect(Object.keys(waiting.pendingApprovals)).toEqual(["approval_A"]);
    expect(Object.keys(waiting.pendingInputs)).toEqual(["input_A"]);

    const resolved = replaySessionEvents(waiting, events.slice(2));
    expect(resolved.pendingApprovals).toEqual({});
    expect(resolved.pendingInputs).toEqual({});
  });
});

describe("replay helpers", () => {
  it("produces the same state for chunks and one complete replay", () => {
    const initial = beginReplay(createBrowserSessionState("ses_A"));
    const complete = replaySessionEvents(initial, [created, started, completed]);
    const chunked = replaySessionEventChunks(initial, [[created], [started, completed]]);

    expect(chunked).toEqual(complete);
    expect(completeReplay(chunked, 3).status).toBe("live");
    expect(completeReplay(chunked, 4).status).toBe("gap");
  });
});
