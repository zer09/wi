# ADR-0007: Treat provider output as provisional until valid terminal completion

Status: Accepted  
Date: 2026-07-11

## Context

A streaming provider can fail after emitting text or partial function arguments. Retrying blindly can duplicate or contradict visible output. Executing a tool from truncated arguments can cause unsafe effects.

## Decision

Provider text may be persisted and shown while streaming, but it remains provisional until a valid accepted terminal event.

Complete-looking tool calls are staged during streaming and remain non-executable.

Only after provider-step completion is durably committed may staged calls be validated, promoted to requested, and executed.

## Failure behavior

For failed, cancelled, incomplete, or unterminated streams:

- preserve committed partial text
- mark the assistant item and provider step interrupted/failed
- discard or permanently mark staged calls non-executable
- execute zero new tool effects

## Automatic retry

Retry from the beginning is allowed only when:

- the error is transient
- no semantic output has been committed
- no complete tool call has been accepted
- no tool has started
- the operation is not cancelled
- retry budget remains

After semantic output begins, Wi may continue only through a verified provider continuation mechanism that proves exact compatibility. Otherwise the run ends interrupted/failed and a later user action starts new work.

## Bounded streaming text

One provider step may commit at most 16 KiB of assistant text, measured in UTF-8 bytes. Wi rejects the delta that would cross that cumulative limit before coalescing, concatenating, or persisting it. Text already committed within the limit remains visible and is marked interrupted when the step fails.

## Terminal event validation

A provider adapter must validate:

- recognized terminal event type
- matching response/step identity
- no conflicting terminal state
- complete and valid event sequence
- final tool-call identity and arguments

After one terminal marker is accepted, Wi accepts only an identical duplicate of that same terminal marker. Any other post-terminal event—including text, tool calls, response starts, or a different terminal marker—is a provider protocol error.

## Amendment history

- 2026-07-15: clarified the identical-terminal-duplicate rule and rejection of every other post-terminal event.
- 2026-07-15: bounded cumulative assistant text per provider step at 16 KiB before concatenation or persistence.

## Consequences

Positive:

- truncated tool calls never execute
- visible partial text is honest and preserved
- duplicate/contradictory retry output is avoided
- provider transport bugs remain diagnosable

Negative:

- some transient failures after output require user continuation
- provider adapters need explicit staging state
- UI must represent interrupted assistant content

## Alternatives considered

### Execute when function JSON parses

Rejected because syntactically valid partial output is not proof of provider completion.

### Delete partial text on failure

Rejected because the user may already have seen it and the durable timeline should reflect what occurred.

### Always retry

Rejected because it can duplicate tool calls and visible content.

## Validation

- fake provider emits partial text then fails
- fake provider emits complete-looking tool arguments without terminal completion
- fake provider closes without a terminal event
- tests prove tool execution count remains zero in all nonterminal cases
- exact-limit and one-byte-over tests enforce bounded cumulative assistant text
- property tests prove no tool state reaches `started` before provider completion
