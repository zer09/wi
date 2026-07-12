import type { RunState } from "@wi/protocol";

import { StorageError } from "../common/worker-rpc.js";

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const allowedTransitions: Readonly<Record<RunState, ReadonlySet<RunState>>> = {
  created: new Set(["queued", "running"]),
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

export function isAllowedRunTransition(expectedState: RunState, nextState: RunState): boolean {
  return allowedTransitions[expectedState].has(nextState);
}

export function assertAllowedRunTransition(expectedState: RunState, nextState: RunState): void {
  if (!isAllowedRunTransition(expectedState, nextState)) {
    throw new StorageError(
      "session.invalid_transition",
      `Run cannot transition from ${expectedState} to ${nextState}`,
    );
  }
}
