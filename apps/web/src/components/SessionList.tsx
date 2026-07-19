import { useState, type FormEvent } from "react";
import type { BrowserCommandLimits, BrowserSessionSummary } from "@wi/protocol";

import {
  assertRawInputSize,
  BrowserCommandLimitError,
} from "../socket/command-size.js";

interface SessionListProps {
  readonly sessions: readonly BrowserSessionSummary[];
  readonly sessionsTruncated: boolean;
  readonly selectedSessionId: string | null;
  readonly title: string;
  readonly commandLimits: BrowserCommandLimits;
  readonly createPending: boolean;
  readonly createDisabled: boolean;
  readonly onTitleChange: (title: string) => string | null;
  readonly onCreate: (title: string) => string | null;
  readonly onSelect: (sessionId: string) => void;
}

export function SessionList({
  sessions,
  sessionsTruncated,
  selectedSessionId,
  title,
  commandLimits,
  createPending,
  createDisabled,
  onTitleChange,
  onCreate,
  onSelect,
}: SessionListProps) {
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === "" || createPending || createDisabled) return;
    setError(onCreate(trimmed));
  }

  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar__header">
        <h1>Wi</h1>
        <p>Local coding sessions</p>
      </div>
      <form className="new-session" onSubmit={submit}>
        <label htmlFor="new-session-title">New session title</label>
        <div className="new-session__controls">
          <input
            id="new-session-title"
            value={title}
            onChange={(event) => {
              try {
                assertRawInputSize(event.currentTarget.value, commandLimits, "Session title");
                setError(onTitleChange(event.currentTarget.value));
              } catch (changeError) {
                setError(
                  changeError instanceof BrowserCommandLimitError
                    ? changeError.message
                    : "The session title could not be validated.",
                );
              }
            }}
            disabled={createPending || createDisabled}
            maxLength={200}
          />
          <button
            type="submit"
            disabled={createPending || createDisabled || title.trim() === ""}
          >
            {createPending ? "Creating…" : "Create"}
          </button>
        </div>
        {error === null ? null : <p role="alert">{error}</p>}
      </form>
      <nav aria-label="Session list">
        {sessions.length === 0 ? <p className="empty">No sessions yet.</p> : null}
        {sessionsTruncated ? (
          <p className="empty">Only the most recently updated sessions are shown.</p>
        ) : null}
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.sessionId}>
              <button
                type="button"
                className={session.sessionId === selectedSessionId ? "session session--selected" : "session"}
                aria-current={session.sessionId === selectedSessionId ? "page" : undefined}
                disabled={session.status !== "ready"}
                onClick={() => onSelect(session.sessionId)}
              >
                <span className="session__title">{session.title || "Untitled session"}</span>
                <span className="session__meta">
                  {session.lastRunState ?? "idle"}
                  {session.requiresAttention ? " · needs attention" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
