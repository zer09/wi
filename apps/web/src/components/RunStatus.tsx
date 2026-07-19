import type { BrowserRunState } from "@wi/client-state";

const ACTIVE_STATES = new Set(["created", "queued", "running", "waiting_for_user", "cancelling"]);

interface RunStatusProps {
  readonly run: BrowserRunState | null;
  readonly cancelPending: boolean;
  readonly disabled: boolean;
  readonly onCancel: (runId: string) => void;
}

export function RunStatus({ run, cancelPending, disabled, onCancel }: RunStatusProps) {
  if (run === null) return <p className="run-status">No run yet.</p>;
  const active = ACTIVE_STATES.has(run.state);
  return (
    <div
      className="run-status"
      aria-label="Current run status"
      aria-live="polite"
      data-focus-target="run"
      tabIndex={-1}
    >
      <span>
        Run: <strong>{run.state}</strong>
      </span>
      {active && run.state !== "cancelling" ? (
        <button
          type="button"
          disabled={disabled || cancelPending}
          onClick={() => onCancel(run.runId)}
        >
          {cancelPending ? "Cancelling…" : "Cancel run"}
        </button>
      ) : null}
    </div>
  );
}
