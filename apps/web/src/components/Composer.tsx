import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BrowserCommandLimits } from "@wi/protocol";

import {
  assertRawInputSize,
  BrowserCommandLimitError,
} from "../socket/command-size.js";

interface ComposerProps {
  readonly sessionId: string;
  readonly text: string;
  readonly commandLimits: BrowserCommandLimits;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onTextChange: (text: string) => string | null;
  readonly onSubmit: (text: string) => string | null;
}

export function Composer({
  sessionId,
  text,
  commandLimits,
  disabled,
  pending,
  onTextChange,
  onSubmit,
}: ComposerProps) {
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setError(null);
    input.current?.focus();
  }, [sessionId]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed === "" || disabled || pending) return;
    setError(onSubmit(trimmed));
    requestAnimationFrame(() => input.current?.focus());
  }

  return (
    <form className="composer" onSubmit={submit}>
      <label htmlFor="message-composer">Message</label>
      <textarea
        ref={input}
        id="message-composer"
        data-focus-target="composer"
        value={text}
        onChange={(event) => {
          try {
            assertRawInputSize(event.currentTarget.value, commandLimits, "Message");
            setError(onTextChange(event.currentTarget.value));
          } catch (changeError) {
            setError(
              changeError instanceof BrowserCommandLimitError
                ? changeError.message
                : "The message could not be validated.",
            );
          }
        }}
        disabled={disabled || pending}
        rows={3}
      />
      {error === null ? null : <p role="alert">{error}</p>}
      <div className="composer__footer">
        {pending ? <span role="status">Message command pending durable acceptance.</span> : <span />}
        <button type="submit" disabled={disabled || pending || text.trim() === ""}>
          Send
        </button>
      </div>
    </form>
  );
}
