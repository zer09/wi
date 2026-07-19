import { useState, type FormEvent } from "react";
import type { BrowserPendingInput } from "@wi/client-state";
import { CanonicalJsonValueSchema, type CanonicalJsonValue } from "@wi/protocol";

interface PendingInputPanelProps {
  readonly inputs: readonly BrowserPendingInput[];
  readonly pendingInputIds: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onRespond: (inputId: string, value: CanonicalJsonValue) => string | null;
}

function InputResponse({
  input,
  pending,
  disabled,
  onRespond,
}: {
  readonly input: BrowserPendingInput;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onRespond: PendingInputPanelProps["onRespond"];
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (disabled) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      setError("Enter a valid JSON value, such as a string, number, object, or array.");
      return;
    }
    const canonical = CanonicalJsonValueSchema.safeParse(parsed);
    if (!canonical.success) {
      setError("The response must be a finite JSON value.");
      return;
    }
    setError(onRespond(input.inputId, canonical.data));
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
        onChange={(event) => setValue(event.currentTarget.value)}
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
  pendingInputIds,
  disabled,
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
          pending={pendingInputIds.has(input.inputId)}
          disabled={disabled}
          onRespond={onRespond}
        />
      ))}
    </section>
  );
}
