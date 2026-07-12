import { canonicalJson, type RunState, type SessionEvent } from "@wi/protocol";

import type {
  BrowserRunState,
  BrowserSessionIntegrityError,
  BrowserSessionState,
} from "./model.js";

const terminalRunStates = new Set<RunState>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const allowedRunTransitions: Readonly<Record<RunState, ReadonlySet<RunState>>> = {
  created: new Set(["running"]),
  queued: new Set(["running"]),
  running: new Set([
    "waiting_for_user",
    "cancelling",
    "completed",
    "failed",
    "interrupted",
  ]),
  waiting_for_user: new Set(["running", "cancelling", "failed", "interrupted"]),
  cancelling: new Set(["cancelled", "interrupted"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
};

function sameJsonValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function fatal(
  state: BrowserSessionState,
  errorCode: BrowserSessionIntegrityError,
): BrowserSessionState {
  return { ...state, status: "error", errorCode };
}

function runTransition(event: SessionEvent): BrowserRunState | null {
  switch (event.eventType) {
    case "run.created":
      return { runId: event.data.runId, state: "created" };
    case "run.started":
      return { runId: event.data.runId, state: "running" };
    case "run.waiting_for_user":
      return { runId: event.data.runId, state: "waiting_for_user" };
    case "run.cancel.requested":
      return { runId: event.data.runId, state: "cancelling" };
    case "run.cancelled":
      return { runId: event.data.runId, state: "cancelled" };
    case "run.completed":
      return { runId: event.data.runId, state: "completed" };
    case "run.failed":
      return { runId: event.data.runId, state: "failed" };
    case "run.interrupted":
      return { runId: event.data.runId, state: "interrupted" };
    default:
      return null;
  }
}

function applyRunTransition(
  state: BrowserSessionState,
  transition: BrowserRunState | null,
): BrowserSessionState {
  if (transition === null) return state;
  const current = state.activeRun;
  if (current === null) {
    return transition.state === "created"
      ? { ...state, activeRun: transition }
      : fatal(state, "impossible_run_transition");
  }
  if (current.runId !== transition.runId) {
    if (!terminalRunStates.has(current.state)) return fatal(state, "second_active_run");
    return transition.state === "created"
      ? { ...state, activeRun: transition }
      : fatal(state, "impossible_run_transition");
  }
  if (!allowedRunTransitions[current.state].has(transition.state)) {
    return fatal(state, "impossible_run_transition");
  }
  return { ...state, activeRun: transition };
}

function applyEventData(state: BrowserSessionState, event: SessionEvent): BrowserSessionState {
  let title = state.title;
  let pendingApprovals = state.pendingApprovals;
  let pendingInputs = state.pendingInputs;

  switch (event.eventType) {
    case "session.created":
      title = event.data.title;
      break;
    case "tool.approval.requested":
      pendingApprovals = {
        ...pendingApprovals,
        [event.data.approvalId]: {
          approvalId: event.data.approvalId,
          runId: event.data.runId,
          callId: event.data.callId,
          toolName: event.data.toolName,
          summary: event.data.summary,
        },
      };
      break;
    case "tool.approval.resolved": {
      const remaining = { ...pendingApprovals };
      delete remaining[event.data.approvalId];
      pendingApprovals = remaining;
      break;
    }
    case "input.requested":
      pendingInputs = {
        ...pendingInputs,
        [event.data.inputId]: {
          inputId: event.data.inputId,
          runId: event.data.runId,
          prompt: event.data.prompt,
        },
      };
      break;
    case "input.resolved": {
      const remaining = { ...pendingInputs };
      delete remaining[event.data.inputId];
      pendingInputs = remaining;
      break;
    }
  }

  return applyRunTransition(
    { ...state, title, pendingApprovals, pendingInputs },
    runTransition(event),
  );
}

export function reduceSessionEvent(
  state: BrowserSessionState,
  event: SessionEvent,
): BrowserSessionState {
  if (state.errorCode !== null) return state;
  if (event.sessionId !== state.sessionId) return fatal(state, "session_mismatch");

  const existingSequence = state.appliedEventSequencesById[event.eventId];
  if (existingSequence !== undefined && existingSequence !== event.sequence) {
    return fatal(state, "event_id_conflict");
  }
  if (event.sequence <= state.lastAppliedSequence) {
    const existing = state.appliedEvents[event.sequence];
    if (existing !== undefined && sameJsonValue(existing, event)) return state;
    return fatal(state, "event_conflict");
  }
  if (event.sequence !== state.lastAppliedSequence + 1) {
    return { ...state, status: "gap" };
  }

  const next = applyEventData(state, event);
  if (next.errorCode !== null) return next;
  return {
    ...next,
    lastAppliedSequence: event.sequence,
    timeline: [...state.timeline, event],
    appliedEvents: { ...state.appliedEvents, [event.sequence]: event },
    appliedEventSequencesById: {
      ...state.appliedEventSequencesById,
      [event.eventId]: event.sequence,
    },
  };
}
