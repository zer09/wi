import { useState, type FormEvent } from "react";
import type { BrowserPendingInput } from "@wi/client-state";
import type { BrowserCommandLimits, CanonicalJsonValue } from "@wi/protocol";

import {
  assertRawInputSize,
  BrowserCommandLimitError,
  parseCanonicalJsonInput,
} from "../socket/command-size.js";

interface PendingInputPanelProps {
  readonly inputs: readonly BrowserPendingInput[];
  readonly commandLimits: BrowserCommandLimits;
  readonly pendingInputIds: ReadonlySet<string>;
  readonly drafts: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly onDraftChange: (inputId: string, value: string) => string | null;
  readonly onRespond: (inputId: string, value: CanonicalJsonValue) => string | null;
}

function InputResponse({
  input,
  commandLimits,
  value,
  pending,
  disabled,
  onDraftChange,
  onRespond,
}: {
  readonly input: BrowserPendingInput;
  readonly commandLimits: BrowserCommandLimits;
  readonly value: string;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onDraftChange: PendingInputPanelProps["onDraftChange"];
  readonly onRespond: PendingInputPanelProps["onRespond"];
}) {
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (disabled || pending) return;
    try {
      const canonical = parseCanonicalJsonInput(value, commandLimits);
      setError(onRespond(input.inputId, canonical));
    } catch (parseError) {
      setError(
        parseError instanceof BrowserCommandLimitError
          ? parseError.message
          : "Enter a valid finite JSON value, such as a string, number, object, or array.",
      );
    }
  }

  return (
    <form onSubmit={submit} data-testid="pending-input-panel">
      <p>{input.prompt}</p>
      <label htmlFor={`input-${input.inputId}`}>Response as JSON</label>
      <textarea
        id={`input-${input.inputId}`}
        data-focus-target="input"
        rows={3}
        value={value}
        disabled={disabled || pending}
        onChange={(event) => {
          try {
            assertRawInputSize(event.currentTarget.value, commandLimits, "JSON response");
            setError(onDraftChange(input.inputId, event.currentTarget.value));
          } catch (changeError) {
            setError(
              changeError instanceof BrowserCommandLimitError
                ? changeError.message
                : "The JSON response could not be validated.",
            );
          }
        }}
      />
      {error === null ? null : <p role="alert">{error}</p>}
      <button type="submit" disabled={disabled || pending || value.trim() === ""}>
        {pending ? "Responding…" : "Respond"}
      </button>
    </form>
  );
}

export function PendingInputPanel({
  inputs,
  commandLimits,
  pendingInputIds,
  drafts,
  disabled,
  onDraftChange,
  onRespond,
}: PendingInputPanelProps) {
  if (inputs.length === 0) return null;
  return (
    <section className="interaction-panel" aria-labelledby="input-heading" role="alert">
      <h2 id="input-heading">Input required</h2>
      {inputs.map((input) => (
        <InputResponse
          key={input.inputId}
          input={input}
          commandLimits={commandLimits}
          value={drafts[input.inputId] ?? ""}
          pending={pendingInputIds.has(input.inputId)}
          disabled={disabled}
          onDraftChange={onDraftChange}
          onRespond={onRespond}
        />
      ))}
    </section>
  );
}
