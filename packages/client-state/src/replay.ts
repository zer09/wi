import type { SessionEvent } from "@wi/protocol";

import type { BrowserSessionState } from "./model.js";
import { reduceSessionEvent } from "./reducer.js";

export function beginReplay(state: BrowserSessionState): BrowserSessionState {
  return { ...state, status: "replaying", errorCode: null };
}

export function completeReplay(
  state: BrowserSessionState,
  throughSequence: number,
): BrowserSessionState {
  if (state.lastAppliedSequence !== throughSequence) {
    return { ...state, status: "gap" };
  }
  return { ...state, status: "live" };
}

export function replaySessionEvents(
  state: BrowserSessionState,
  events: Iterable<SessionEvent>,
): BrowserSessionState {
  let next = state;
  for (const event of events) next = reduceSessionEvent(next, event);
  return next;
}

export function replaySessionEventChunks(
  state: BrowserSessionState,
  chunks: Iterable<Iterable<SessionEvent>>,
): BrowserSessionState {
  let next = state;
  for (const chunk of chunks) next = replaySessionEvents(next, chunk);
  return next;
}
