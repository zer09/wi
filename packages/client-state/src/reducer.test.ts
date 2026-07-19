import { describe, expect, it } from "vitest";

import { SessionEventSchema, type SessionEventType } from "@wi/protocol";
import {
  MAXIMUM_BROWSER_SESSION_EVENT_CODE_UNITS,
  MAXIMUM_BROWSER_SESSION_EVENTS,
  createBrowserSessionState,
} from "./model.js";
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

const terminalEventTypes = [
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
] as const;

function terminalRunEvents(eventType: (typeof terminalEventTypes)[number]) {
  const events = [
    event(1, "run.created", { eventVersion: 1, runId: "run_A" }),
    event(2, "run.started", { eventVersion: 1, runId: "run_A" }),
    event(3, "tool.approval.requested", {
      eventVersion: 1,
      runId: "run_A",
      callId: "call_A",
      approvalId: "approval_A",
      toolName: "guarded_echo",
      actionDigest: "a".repeat(64),
      summary: "Echo hello",
    }),
    event(4, "input.requested", {
      eventVersion: 1,
      runId: "run_A",
      inputId: "input_A",
      prompt: "Continue?",
    }),
    event(5, "run.waiting_for_user", {
      eventVersion: 1,
      runId: "run_A",
      reason: "input",
      inputId: "input_A",
    }),
  ];

  switch (eventType) {
    case "run.completed":
      return [
        ...events,
        event(6, "run.started", { eventVersion: 1, runId: "run_A" }),
        event(7, eventType, { eventVersion: 1, runId: "run_A" }),
      ];
    case "run.failed":
    case "run.interrupted":
      return [
        ...events,
        event(6, eventType, {
          eventVersion: 1,
          runId: "run_A",
          code: "provider.incomplete",
          message: "Provider stopped.",
          diagnosticId: "err_A",
        }),
      ];
    case "run.cancelled":
      return [
        ...events,
        event(6, "run.cancel.requested", { eventVersion: 1, runId: "run_A" }),
        event(7, eventType, { eventVersion: 1, runId: "run_A" }),
      ];
  }
}

describe("browser session reducer", () => {
  it("applies contiguous events", () => {
    const state = replaySessionEvents(createBrowserSessionState("ses_A"), [created, started]);

    expect(state.lastAppliedSequence).toBe(2);
    expect(state.timeline).toEqual([created, started]);
    expect(state.activeRun).toEqual({ runId: "run_A", state: "running" });
  });

  it("tracks the latest user-message preview without rescanning history", () => {
    const message = event(1, "user.message.appended", {
      eventVersion: 1,
      messageId: "msg_preview",
      runId: "run_preview",
      text: "preview text",
    });
    const state = reduceSessionEvent(createBrowserSessionState("ses_A"), message);

    expect(state.lastMessagePreview).toBe("preview text");
    expect(state.retainedEventCodeUnits).toBeGreaterThan(0);
  });

  it("fails visibly at the bounded browser history limits", () => {
    const initial = createBrowserSessionState("ses_A");
    const atEventLimit = {
      ...initial,
      lastAppliedSequence: MAXIMUM_BROWSER_SESSION_EVENTS,
      timeline: Array.from({ length: MAXIMUM_BROWSER_SESSION_EVENTS }, () => created),
    };
    const nextEvent = event(MAXIMUM_BROWSER_SESSION_EVENTS + 1, "user.message.appended", {
      eventVersion: 1,
      messageId: "msg_limit",
      runId: "run_limit",
      text: "bounded",
    });
    expect(reduceSessionEvent(atEventLimit, nextEvent)).toMatchObject({
      status: "error",
      errorCode: "history_limit_exceeded",
      lastAppliedSequence: MAXIMUM_BROWSER_SESSION_EVENTS,
    });

    const atCharacterLimit = {
      ...initial,
      retainedEventCodeUnits: MAXIMUM_BROWSER_SESSION_EVENT_CODE_UNITS,
    };
    expect(reduceSessionEvent(atCharacterLimit, event(1, "user.message.appended", {
      eventVersion: 1,
      messageId: "msg_characterLimit",
      runId: "run_characterLimit",
      text: "bounded",
    }))).toMatchObject({
      status: "error",
      errorCode: "history_limit_exceeded",
      lastAppliedSequence: 0,
    });
  });

  it("ignores separately decoded exact duplicate content", () => {
    const once = reduceSessionEvent(createBrowserSessionState("ses_A"), created);
    const duplicate = reverseObjectKeys(created);

    expect(duplicate).not.toBe(created);
    expect(duplicate.data).not.toBe(created.data);
    expect(reduceSessionEvent(once, duplicate)).toBe(once);
  });

  it("treats negative zero and zero as the same canonical duplicate", () => {
    const live = event(1, "input.resolved", {
      eventVersion: 1,
      runId: "run_A",
      inputId: "input_A",
      value: -0,
    });
    const replayed = event(1, "input.resolved", {
      eventVersion: 1,
      runId: "run_A",
      inputId: "input_A",
      value: 0,
    });
    const once = reduceSessionEvent(createBrowserSessionState("ses_A"), live);

    expect(reduceSessionEvent(once, replayed)).toBe(once);
  });

  it("rejects conflicting duplicate content", () => {
    const once = reduceSessionEvent(createBrowserSessionState("ses_A"), created);
    const conflict = { ...created, eventId: "evt_conflict" };
    const state = reduceSessionEvent(once, conflict);

    expect(state.status).toBe("error");
    expect(state.errorCode).toBe("event_conflict");
    expect(state.lastAppliedSequence).toBe(1);
  });

  it("treats a session mismatch as fatal", () => {
    const mismatched = { ...created, sessionId: "ses_B" };
    const state = reduceSessionEvent(createBrowserSessionState("ses_A"), mismatched);

    expect(state).toMatchObject({
      status: "error",
      errorCode: "session_mismatch",
      lastAppliedSequence: 0,
    });
    expect(beginReplay(state)).toBe(state);
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
    expect(state.errorCode).toBe("impossible_run_transition");
  });

  it("keeps fatal conflicts sticky through replay until trusted state is rebuilt", () => {
    const once = reduceSessionEvent(createBrowserSessionState("ses_A"), created);
    const fatal = reduceSessionEvent(once, { ...created, eventId: "evt_other" });

    expect(beginReplay(fatal)).toBe(fatal);
    expect(completeReplay(fatal, 1)).toBe(fatal);
    expect(createBrowserSessionState("ses_A").errorCode).toBeNull();
  });

  it("rejects event ID reuse at another sequence", () => {
    const once = reduceSessionEvent(createBrowserSessionState("ses_A"), created);
    const reusedId = { ...started, eventId: created.eventId };
    const state = reduceSessionEvent(once, reusedId);

    expect(state.status).toBe("error");
    expect(state.errorCode).toBe("event_id_conflict");
    expect(state.lastAppliedSequence).toBe(1);
  });

  it("treats event ID reuse beyond a sequence gap as fatal immediately", () => {
    const once = reduceSessionEvent(createBrowserSessionState("ses_A"), created);
    const reusedIdAfterGap = {
      ...event(3, "run.started", { eventVersion: 1, runId: "run_A" }),
      eventId: created.eventId,
    };
    const state = reduceSessionEvent(once, reusedIdAfterGap);

    expect(state.status).toBe("error");
    expect(state.errorCode).toBe("event_id_conflict");
    expect(beginReplay(state)).toBe(state);
  });

  it("queues a run created while another run is active", () => {
    const running = replaySessionEvents(createBrowserSessionState("ses_A"), [created, started]);
    const queued = reduceSessionEvent(
      running,
      event(3, "run.created", { eventVersion: 1, runId: "run_B" }),
    );

    expect(queued).toMatchObject({
      errorCode: null,
      activeRun: { runId: "run_A", state: "running" },
      queuedRuns: [{ runId: "run_B", state: "queued" }],
      lastAppliedSequence: 3,
    });
  });

  it("preserves creation order for multiple queued runs", () => {
    const state = replaySessionEvents(createBrowserSessionState("ses_A"), [
      created,
      started,
      event(3, "run.created", { eventVersion: 1, runId: "run_B" }),
      event(4, "run.created", { eventVersion: 1, runId: "run_C" }),
    ]);

    expect(state.errorCode).toBeNull();
    expect(state.activeRun).toEqual({ runId: "run_A", state: "running" });
    expect(state.queuedRuns).toEqual([
      { runId: "run_B", state: "queued" },
      { runId: "run_C", state: "queued" },
    ]);
  });

  it("rejects a duplicate queued run identity", () => {
    const state = replaySessionEvents(createBrowserSessionState("ses_A"), [
      created,
      started,
      event(3, "run.created", { eventVersion: 1, runId: "run_B" }),
      event(4, "run.created", { eventVersion: 1, runId: "run_B" }),
    ]);

    expect(state).toMatchObject({
      status: "error",
      errorCode: "impossible_run_transition",
      activeRun: { runId: "run_A", state: "running" },
      lastAppliedSequence: 3,
    });
    expect(state.queuedRuns).toEqual([{ runId: "run_B", state: "queued" }]);
  });

  it("rejects a queued run starting before the active run terminalizes", () => {
    const running = replaySessionEvents(createBrowserSessionState("ses_A"), [
      created,
      started,
      event(3, "run.created", { eventVersion: 1, runId: "run_B" }),
    ]);
    const prematureStart = reduceSessionEvent(
      running,
      event(4, "run.started", { eventVersion: 1, runId: "run_B" }),
    );

    expect(prematureStart).toMatchObject({
      status: "error",
      errorCode: "second_active_run",
      activeRun: { runId: "run_A", state: "running" },
      lastAppliedSequence: 3,
    });
  });

  it("promotes and removes only the queue head after the active run terminalizes", () => {
    const state = replaySessionEvents(createBrowserSessionState("ses_A"), [
      created,
      started,
      event(3, "run.created", { eventVersion: 1, runId: "run_B" }),
      event(4, "run.completed", { eventVersion: 1, runId: "run_A" }),
      event(5, "run.started", { eventVersion: 1, runId: "run_B" }),
    ]);

    expect(state.errorCode).toBeNull();
    expect(state.activeRun).toEqual({ runId: "run_B", state: "running" });
    expect(state.queuedRuns).toEqual([]);
  });

  it("rejects a non-head queued run starting", () => {
    const state = replaySessionEvents(createBrowserSessionState("ses_A"), [
      created,
      started,
      event(3, "run.created", { eventVersion: 1, runId: "run_B" }),
      event(4, "run.created", { eventVersion: 1, runId: "run_C" }),
      event(5, "run.completed", { eventVersion: 1, runId: "run_A" }),
      event(6, "run.started", { eventVersion: 1, runId: "run_C" }),
    ]);

    expect(state).toMatchObject({
      status: "error",
      errorCode: "impossible_run_transition",
      activeRun: { runId: "run_A", state: "completed" },
      lastAppliedSequence: 5,
    });
    expect(state.queuedRuns).toEqual([
      { runId: "run_B", state: "queued" },
      { runId: "run_C", state: "queued" },
    ]);
  });

  it("rejects impossible run transitions", () => {
    const startedWithoutCreation = reduceSessionEvent(
      createBrowserSessionState("ses_A"),
      event(1, "run.started", { eventVersion: 1, runId: "run_A" }),
    );
    expect(startedWithoutCreation).toMatchObject({
      status: "error",
      errorCode: "impossible_run_transition",
      lastAppliedSequence: 0,
    });
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

  it.each(terminalEventTypes)("clears pending interactions when %s terminalizes their run", (eventType) => {
    const state = replaySessionEvents(
      createBrowserSessionState("ses_A"),
      terminalRunEvents(eventType),
    );

    expect(state.errorCode).toBeNull();
    expect(state.activeRun).toEqual({ runId: "run_A", state: eventType.slice(4) });
    expect(state.pendingApprovals).toEqual({});
    expect(state.pendingInputs).toEqual({});
  });

  it.each(["approval", "input"] as const)(
    "clears a pending %s without requiring another interaction kind",
    (kind) => {
      const interaction = kind === "approval"
        ? event(3, "tool.approval.requested", {
            eventVersion: 1,
            runId: "run_A",
            callId: "call_A",
            approvalId: "approval_A",
            toolName: "guarded_echo",
            actionDigest: "a".repeat(64),
            summary: "Echo hello",
          })
        : event(3, "input.requested", {
            eventVersion: 1,
            runId: "run_A",
            inputId: "input_A",
            prompt: "Continue?",
          });
      const state = replaySessionEvents(createBrowserSessionState("ses_A"), [
        event(1, "run.created", { eventVersion: 1, runId: "run_A" }),
        event(2, "run.started", { eventVersion: 1, runId: "run_A" }),
        interaction,
        event(4, "run.completed", { eventVersion: 1, runId: "run_A" }),
      ]);

      expect(state.errorCode).toBeNull();
      expect(state.pendingApprovals).toEqual({});
      expect(state.pendingInputs).toEqual({});
    },
  );

  it("preserves pending interactions that belong to another run", () => {
    const state = replaySessionEvents(createBrowserSessionState("ses_A"), [
      event(1, "run.created", { eventVersion: 1, runId: "run_A" }),
      event(2, "run.started", { eventVersion: 1, runId: "run_A" }),
      event(3, "tool.approval.requested", {
        eventVersion: 1,
        runId: "run_B",
        callId: "call_B",
        approvalId: "approval_B",
        toolName: "guarded_echo",
        actionDigest: "b".repeat(64),
        summary: "Echo goodbye",
      }),
      event(4, "input.requested", {
        eventVersion: 1,
        runId: "run_B",
        inputId: "input_B",
        prompt: "Wait?",
      }),
      event(5, "run.completed", { eventVersion: 1, runId: "run_A" }),
    ]);

    expect(state.errorCode).toBeNull();
    expect(Object.keys(state.pendingApprovals)).toEqual(["approval_B"]);
    expect(Object.keys(state.pendingInputs)).toEqual(["input_B"]);
  });

  it("keeps explicit interaction resolution before terminal cleanup idempotent", () => {
    const events = terminalRunEvents("run.completed");
    const state = replaySessionEvents(createBrowserSessionState("ses_A"), [
      ...events.slice(0, 4),
      event(5, "tool.approval.resolved", {
        eventVersion: 1,
        runId: "run_A",
        callId: "call_A",
        approvalId: "approval_A",
        resolution: "denied",
      }),
      event(6, "input.resolved", {
        eventVersion: 1,
        runId: "run_A",
        inputId: "input_A",
        value: null,
      }),
      event(7, "run.completed", { eventVersion: 1, runId: "run_A" }),
    ]);

    expect(state.errorCode).toBeNull();
    expect(state.pendingApprovals).toEqual({});
    expect(state.pendingInputs).toEqual({});
  });

  it("keeps exact duplicate terminal cleanup idempotent", () => {
    const events = terminalRunEvents("run.cancelled");
    const once = replaySessionEvents(createBrowserSessionState("ses_A"), events);
    const terminal = events.at(-1);
    if (terminal === undefined) throw new Error("Terminal event is missing");

    expect(reduceSessionEvent(once, structuredClone(terminal))).toBe(once);
    expect(once.pendingApprovals).toEqual({});
    expect(once.pendingInputs).toEqual({});
  });
});

describe("replay helpers", () => {
  it("can restart replay after a replay-complete head mismatch", () => {
    const atOne = reduceSessionEvent(createBrowserSessionState("ses_A"), created);
    const mismatch = completeReplay(beginReplay(atOne), 2);
    const replaying = beginReplay(mismatch);
    const recovered = reduceSessionEvent(replaying, started);

    expect(mismatch.status).toBe("gap");
    expect(replaying.status).toBe("replaying");
    expect(recovered).toMatchObject({ status: "replaying", lastAppliedSequence: 2 });
    expect(completeReplay(recovered, 2).status).toBe("live");
  });

  it("produces the same state for chunks and one complete replay", () => {
    const initial = beginReplay(createBrowserSessionState("ses_A"));
    const complete = replaySessionEvents(initial, [created, started, completed]);
    const chunked = replaySessionEventChunks(initial, [[created], [started, completed]]);

    expect(chunked).toEqual(complete);
    expect(completeReplay(chunked, 3).status).toBe("live");
    expect(completeReplay(chunked, 4).status).toBe("gap");
  });
});
