import type { RunState } from "@wi/protocol";

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

export type RunTaskTerminalState = "completed" | "failed" | "interrupted";

export function terminalStateForTask(
  currentState: RunState,
  reportedState: RunTaskTerminalState,
): RunTaskTerminalState | "cancelled" | null {
  if (isTerminalRunState(currentState)) return null;
  if (currentState === "cancelling") return "cancelled";
  if (currentState !== "running") return null;
  return reportedState;
}
