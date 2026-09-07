# Event contract v1 (gateway 0.2.0)

## Envelope

Every provider event has `schema_version`, local `sequence`, `event_id`,
`session_id`, `request_id`, `provider`, optional `provider_sequence`, and a
snake_case `type` discriminator. `request_id` is null for a session-level idle
closure. The local sequence is independent of provider sequence numbers and is
monotonically increasing, not a durable replay cursor.

A failed delivery can leave a sequence gap followed by an explicit failure;
consumers must not interpret a gap as successful completion. There is no replay
API or durable event log in this milestone.

## Implemented provider events

| Type | Meaning |
|---|---|
| `response_started` | A provider response identity is observed |
| `response_status` | Provider-reported queued/in-progress state |
| `output_item_started` | An output item is introduced |
| `output_item_updated` | A typed text/refusal/reasoning/tool-input fragment |
| `output_item_finished` | A finalized output item is available |
| `response_finished` | Authoritative final response and explicit terminal outcome |
| `request_failed` | Local/protocol/request error with an upstream-outcome assessment |
| `provider_extension` | Preserved native metadata/progress/part/annotation or unknown event |
| `session_closed` | Idle peer closure or unexpected idle provider activity |

Delta kinds are `text`, `refusal`, `reasoning_summary`, `reasoning_text`,
`function_arguments`, and `custom_tool_input`. These are provider-exposed content,
not access to hidden model reasoning. Keep encrypted continuation state private.

The response's `outcome` carries `completed`, `incomplete` with reason, `failed`,
or `cancelled`. The model response being completed does not complete a future
agent run. Raw function-argument deltas are NEVER tool-execution events.

Request errors before admission or during session setup are returned as Rust
`Result::Err`. An admitted request normally produces one `response_finished` or
`request_failed`. Fatal process loss and caller dropping the receiver obviously
cannot guarantee live delivery; no durable-delivery claim is made.

`request_failed.upstream_outcome` is:
- `not_submitted`: the worker stopped before polling the network-capable send,
  including local serialization, freshness, reload, account, and request checks;
- `unknown`: a send/stream may have reached OpenAI; no automatic retry;
- `terminal_received`: the codec validated a terminal response but later local
  delivery or settlement failed. A terminal type name alone is insufficient.

Local closure during active generation does not emit a fabricated upstream
`cancelled` response. It reports local cancellation with upstream uncertainty.

## Native mapping

`response.created` → `response_started`. A validated terminal-only stream also
emits `response_started` to expose its identity. This synthetic normalized start
does not prove that native `response.created` was received. The opt-in smoke
observer counts native-created events separately, without changing this contract.

`response.output_item.added` / `.done` → item started / finished.

`response.output_text.delta`, refusal/reasoning delta families, function-argument
and custom-tool input deltas → typed `output_item_updated`.

Part events, annotations, `.done` text/argument fields, hosted-tool progress, and
future events → `provider_extension`. Final items and the terminal response remain
authoritative even when a provider omits an item/delta event.

`response.completed`, `response.incomplete`, `response.failed`,
`response.cancelled`, and the Codex `response.done` compatibility alias →
`response_finished` preserving the actual response status. Top-level `error`
becomes a safe `request_failed`; raw HTTP/protocol error messages are withheld.
Transport failures use `transport_error`; an invalid SSE content type uses
`unexpected_content_type`. HTTP 401/403/429 retain `unauthorized`, `forbidden`,
and `rate_limited`. The smoke summary allowlists these codes independently and
preserves `upstream_outcome` without copying arbitrary event strings.

## Output items

Classifications: message, reasoning, function call, custom tool call, tool-search
call/output, program, program output, unknown. Each keeps its native object.
Ordinary function calls also expose a normalized `FunctionCall` with call identity,
name, encoded arguments, origin, namespace, and completeness hint.

The generic tool executor uses normalized fields; it does not parse OpenAI wire
JSON. Native caller/fingerprint/phase/encrypted fields remain in the item for later
provider-aware continuation. Advanced/unknown executable output cannot be driven
by the ordinary continuation/executor path.

## Demonstration executor events

`tool_execution_started`, `tool_execution_finished`, and `tool_result_reused` are
emitted by the separate tool registry, not by the provider. The CLI writes them as
plain NDJSON objects in tool-demo mode; they are not yet wrapped in a durable
run/session event envelope. Consumers can distinguish them by their `type`.

## Not emitted yet

No `agent_start`, `agent_end`, `turn_start`, `turn_end`, message transcript,
approval, compaction, queue, or retry lifecycle is claimed. Those require the
corresponding harness components. Native steering acknowledgements are not
implemented; `steer()` returns UnsupportedFeature. SSE and WebSocket share the
implemented provider-event contract but not imaginary feature parity.
