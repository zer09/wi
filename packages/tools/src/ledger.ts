import type { ToolExecutionState } from "@wi/protocol";

export const TERMINAL_TOOL_STATES: ReadonlySet<ToolExecutionState> = new Set([
  "completed",
  "failed",
  "denied",
  "cancelled",
  "outcome_unknown",
  "discarded",
]);

const allowedTransitions: Readonly<
  Record<ToolExecutionState, ReadonlySet<ToolExecutionState>>
> = {
  staged: new Set(["requested", "failed", "discarded"]),
  requested: new Set(["awaiting_approval", "started", "failed", "cancelled"]),
  awaiting_approval: new Set(["approved", "denied", "cancelled"]),
  approved: new Set(["started", "cancelled"]),
  started: new Set(["requested", "completed", "failed", "cancelled", "outcome_unknown"]),
  completed: new Set(),
  failed: new Set(),
  denied: new Set(),
  cancelled: new Set(),
  outcome_unknown: new Set(),
  discarded: new Set(),
};

export function isTerminalToolState(state: ToolExecutionState): boolean {
  return TERMINAL_TOOL_STATES.has(state);
}

export function isAllowedToolTransition(
  current: ToolExecutionState,
  next: ToolExecutionState,
): boolean {
  return allowedTransitions[current].has(next);
}

export class ToolLedgerTransitionError extends Error {
  readonly code = "session.invalid_transition";

  constructor(current: ToolExecutionState, next: ToolExecutionState) {
    super(`Tool execution cannot transition from ${current} to ${next}`);
    this.name = "ToolLedgerTransitionError";
  }
}

export function assertAllowedToolTransition(
  current: ToolExecutionState,
  next: ToolExecutionState,
): void {
  if (!isAllowedToolTransition(current, next)) {
    throw new ToolLedgerTransitionError(current, next);
  }
}
