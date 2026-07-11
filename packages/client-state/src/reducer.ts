import type { RunState, SessionEvent } from "@wi/protocol";

import type { BrowserRunState, BrowserSessionState } from "./model.js";

const terminalRunStates = new Set<RunState>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key]),
    )
  );
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
): Pick<BrowserSessionState, "activeRun" | "errorCode" | "status"> {
  if (transition === null) {
    return { activeRun: state.activeRun, errorCode: state.errorCode, status: state.status };
  }

  const current = state.activeRun;
  if (current === null || current.runId === transition.runId) {
    if (
      current !== null &&
      terminalRunStates.has(current.state) &&
      transition.state !== current.state
    ) {
      return {
        activeRun: current,
        errorCode: "terminal_run_regression",
        status: "error",
      };
    }
    return { activeRun: transition, errorCode: state.errorCode, status: state.status };
  }

  if (transition.state === "created" && terminalRunStates.has(current.state)) {
    return { activeRun: transition, errorCode: state.errorCode, status: state.status };
  }

  return { activeRun: current, errorCode: state.errorCode, status: state.status };
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

  const run = applyRunTransition(state, runTransition(event));
  return {
    ...state,
    title,
    pendingApprovals,
    pendingInputs,
    ...run,
  };
}

export function reduceSessionEvent(
  state: BrowserSessionState,
  event: SessionEvent,
): BrowserSessionState {
  if (event.sessionId !== state.sessionId) {
    return { ...state, status: "error", errorCode: "session_mismatch" };
  }

  if (event.sequence <= state.lastAppliedSequence) {
    const existing = state.appliedEvents[event.sequence];
    if (existing !== undefined && sameJsonValue(existing, event)) return state;
    return { ...state, status: "error", errorCode: "event_conflict" };
  }

  if (event.sequence !== state.lastAppliedSequence + 1) {
    return { ...state, status: "gap" };
  }

  const next = applyEventData(state, event);
  return {
    ...next,
    lastAppliedSequence: event.sequence,
    timeline: [...state.timeline, event],
    appliedEvents: { ...state.appliedEvents, [event.sequence]: event },
  };
}
