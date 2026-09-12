# Event contracts (Wi 0.2.0)

Provider events use schema 1; outer run events use schema 2 under C1.1.
R1 changes no public event schema. Its repairs are offline accepted in commit
`88b76c5`. The [verification report](slices/r1/VERIFICATION.md) records local PASS
evidence and repeated complete-diff review; `accepted=true`. The NB-02 follow-up
filters only stderr presentation and leaves event data unchanged.
Exact-head cross-platform CI is NOT RUN.

Managed authentication does not change the event JSON schema. The CLI reports
only the validated selected profile alias on stderr. Provider account IDs and
tokens never become selection evidence. Preparation failures before generation
dispatch remain `not_submitted`; OAuth exchange uncertainty is separate from
generation submission uncertainty. Experimental login and real renewal are implemented;
explicit renewal has live L1 evidence; automatic expiry and failure paths have
offline evidence. Explicit auth refresh
returns safe profile metadata, not generation events. SSE prepares the same bound
profile before submission; established WebSockets never renew mid-session.
`AuthExpired` retains `auth_expired` with owner-specific renewal guidance through
Wi for managed credentials or Codex/Pi for external credentials, followed by a new
provider session. The [exact message](WI_AUTH.md#expiry-guidance-r1) changes no
freshness, renewal or upstream-outcome behavior.

## Plain presentation and legacy preflight (R1)

Plain answer bodies from legacy `generate`/`tool-demo` and `wi run` preserve LF,
HT and all non-control Unicode scalars, dropping other controls. CRLF becomes LF;
spaces, indentation and fences remain without trimming. Filtering is stateless
across deltas and applies to terminal-only, suffix and labelled fallback bodies.
One-line diagnostics, source labels and catalog descriptions still remove all
controls. Labels, flushes and sink failure/exit behavior remain unchanged.
The filter is not an ANSI parser or a general Unicode/terminal security guarantee.

Presentation does not mutate raw prefix comparisons, `ModelResponse`, native
objects or tool data. After JSON/NDJSON parsing, text still equals the original
control-containing data. These records remain sensitive application data.

After parsing, legacy `generate` validates the initial one-item input, a supplied
follow-up separately, and actual options before provider/auth construction.
Source-read errors precede validation. Invalid input/follow-up/options emit no
response bytes or JSON events and exit 1; malformed legacy Clap syntax retains
exit 2. Valid inputs retain their bytes and one-session flow, without S1/S2
preparation or a new combined quota.

## Context preparation and skill-loading events

Workspace and skill preparation adds no event kinds or envelope fields. Shared
`discover` returns catalog frontmatter and diagnostics. `prepare_run` returns a
validated request and an initial `ContextManifest`, not lifecycle events.
`prepare_run_with_skill_loading` also returns the matching fresh registry; a
nonempty catalog automatically adds `load_skill` on normal `wi run`, without an
enable flag. Direct `prepare_run` retains its no-loader semantics. The CLI resolves
roots and completes discovery, explicit activation and final validation before
constructing provider/auth objects or entering the same public run controller.
Preparation failures produce no run NDJSON. Diagnostics use static categories and scope-relative source labels
on stderr; plain output filters terminal controls and omits file contents.

`wi skills list --json` emits one metadata object, not NDJSON events. Its `entries`
contain qualified `id`, parsed `frontmatter` and relative `source`; `diagnostics`
contain `scope`, `source`, `category` and `message`. No bodies or resolved host paths
are added. Metadata remains sensitive user data, including any text or paths the
owner put into frontmatter. Listing does not read `AGENTS.md`, activate skills,
construct auth/providers, execute tools or contact a model.

Prepared initial user content has deterministic JSON keys `task`,
`project_instructions`, `available_skills`, and `active_skills`. The task remains
unchanged inside the payload. All valid global/project frontmatter is included;
only explicitly selected bodies are included. Sources use scoped relative labels,
not canonical paths. File content stays out of higher-priority instructions.
Without context or selections, the original prompt/instructions remain unchanged.
`ContextManifest` records only this initial preparation, including explicitly
selected `--use-skill` bodies. Later model-selected loads do not update its active
IDs. The manifest is not proof of result delivery. Treat context and tool data as sensitive.

A model-selected body's first appearance is its normal correlated tool result.
`load_skill` returns exactly `id`, validated `frontmatter` and the complete Markdown
`body` from the main `SKILL.md` only. Supporting files/scripts are not read or
executed; loading is not workflow execution or permission. The same controller and
[transport continuation](ARCHITECTURE.md#continuation-strategies) consume the result,
without a separate selector/classifier request.

S1 removes `Feature::HostedSkills` and the serialized `hosted_skills` required
feature. Old input now fails unknown-variant deserialization before provider/auth
work. This focused API/config change does not change provider schema 1, run schema
2, other feature variants or generic unknown provider-native item preservation.
Local skills are not a provider capability or an alias for hosted execution.

## Provider envelope v1

Every provider event has `schema_version: 1`, local `sequence`, `event_id`,
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
or `cancelled`. A completed model response does not by itself complete a run
when ordinary tool calls remain. Raw function-argument deltas are NEVER tool-execution events.

Request errors before admission or during session setup are returned as Rust
`Result::Err`. An admitted request normally produces one `response_finished` or
`request_failed`. Fatal process loss and caller dropping the receiver obviously
cannot guarantee live delivery; no durable-delivery claim is made.

`request_failed.upstream_outcome` is:
- `not_submitted`: the worker stopped before polling the network-capable send,
  including local serialization, freshness, reload, account, and request checks;
- `unknown`: a send/stream may have reached OpenAI; no automatic retry;
- `terminal_received`: the codec validated a terminal response but later local
  recovery, delivery, or settlement failed. A terminal type name alone is insufficient.

Local closure during active generation does not emit a fabricated upstream
`cancelled` response. It reports local cancellation with upstream uncertainty.

## Native mapping

`response.created` → `response_started`. A validated terminal-only stream also
emits `response_started` to expose its identity. This synthetic normalized start
does not prove that native `response.created` was received. The opt-in smoke
observer counts native-created events separately, without changing this contract.

The shared decoder rejects empty required response IDs in `response.created` and
terminal parsing with static `Protocol("empty response identity")`, exported as
`protocol_error`. Rejection precedes assignment of the empty ID, synthesized start,
successful finish, `terminal_received`, recovery and settlement. A valid earlier
start remains visible if a later terminal fails. Missing/null/non-string IDs retain
the existing required-string failure. Nonempty IDs remain opaque, without trimming
or new length/character rules; empty text/refusal/delta strings remain compatible.

A post-send WS or labelled-SSE identity failure emits `request_failed` with
`protocol_error` and `unknown`, closes the session and admits no continuation.
A terminal type string alone cannot establish `terminal_received`. Missing-MIME
SSE rejects an invalid first identity in its earlier prolog as
`unexpected_content_type`/`unknown`; that is preserved admission behavior, not a
new decoder category. Valid parsed/correlated terminals followed by later local
recovery, consistency or delivery failure can still retain `terminal_received`.

Through the public run controller, an actual adapter failure keeps outer
`provider_request_failed` and the nested provider error/outcome, with no tool
execution or follow-up. A fake provider bypassing the decoder still exercises the
existing `provider_correlation` guard. No new run outcome is added.

`response.output_item.added` / `.done` → item started / finished.

`response.output_text.delta`, refusal/reasoning delta families, function-argument
and custom-tool input deltas → typed `output_item_updated`.

Part events, annotations, `.done` text/argument fields, hosted-tool progress, and
future events → `provider_extension`. These events remain visible, including when
item-associated evidence prevents recovery.

`ModelResponse.output` and `text` contain effective output. `output_provenance` is
`native_terminal` by default, including when old serialized responses omit the field.
A nonempty native terminal array remains authoritative. Only a parsed, correlated
`response.completed` or `response.done` with completed status and explicit `output: []`
can recover a complete batch from `response.output_item.done` objects. Recovery sets
`output_provenance` to `validated_output_item_done`. `native`, ID, status, and usage
remain unchanged. Missing/null/malformed output and noncompleted responses never recover.

Recovery requires unique dense indexes starting at zero, unique nonempty item IDs,
and only complete messages, reasoning, or ordinary direct function calls. Messages
permit output_text/refusal parts; reasoning retains opaque continuation metadata.
Calls require string-encoded JSON objects, unique call IDs, and no nonnull namespace
or unsupported caller. The registry still authorizes names and schemas. Added items,
deltas, part boundaries, and final fields must agree with the complete done batch.
Orphan, duplicate, contradictory, or unknown item evidence rejects the entire batch.
Deltas are checked as prefixes, never used to reconstruct output.

Recovery tracking permits 4096 observed events, 512 items with indexes below 512,
and 1 MiB cumulative serialized item-event occurrences, including duplicates.
IDs and function names permit 512 bytes. Overflow drops retained data and latches
failure without changing valid nonempty-terminal behavior. A successful empty terminal
without item evidence stays empty. Invalid recovery emits no response_finished and
cannot settle, continue, or execute. Its failure reports `terminal_received` because
terminal parsing and correlation succeeded before local recovery failed.

The adapter consistency validator checks provisional evidence against effective
output before settlement or successful terminal publication. Public library sessions,
legacy CLI callers and the run controller receive the same guarantee. Both display
modes remain provisional until validation passes.

`response.completed`, `response.incomplete`, `response.failed`,
`response.cancelled`, and the Codex `response.done` compatibility alias →
`response_finished` preserving the actual response status. Top-level `error`
becomes a safe `request_failed`; raw HTTP/protocol error messages are withheld.
Transport failures use `transport_error`; an invalid SSE content type uses
`unexpected_content_type`. HTTP 401/403/429 retain `unauthorized`, `forbidden`,
and `rate_limited`. The smoke summary allowlists these codes independently and
preserves `upstream_outcome` without copying arbitrary event strings. The opt-in
smoke observer separately records authoritative exact HTTP status at SSE response
receipt, static media/body classes, and bounded sampling state. These additive
smoke fields and text-consistency booleans do not change `ProviderEvent` or relax
acceptance.

For successful responses with entirely absent Content-Type, the fixed subscription
SSE adapter requires a strict first-data-frame prolog before ordinary decoding.
A trial decoder must validate `response.created` or a recognized terminal event;
its temporary events are discarded. The original bytes then pass once through the
ordinary decoder and observer. Admission neither fabricates a native-created event
nor relaxes the smoke helper's required proof. A terminal-only qualifier therefore
still cannot prove native-created reception.

Admission is bounded to 65536 raw bytes through the first data-frame delimiter and
one absolute 10-second deadline. EOF without a blank-line dispatch rejects. Invalid
first data rejects without considering later frames. The response ID must contain
1–512 UTF-8 bytes; a nonempty final event label must equal the JSON type exactly.
Failure is `unexpected_content_type` with unknown upstream outcome unless an existing
outer cancellation, timeout, or size limit applies. No trial terminal changes the
upstream outcome. Present wrong MIME and non-2xx behavior remain unchanged.

`http.media` remains `missing`. Additive `SampleState` values serialize as
`sse_prolog_pending`, `sse_prolog_admitted`, `sse_prolog_rejected`,
`sse_prolog_timeout`, `sse_prolog_read_error`, and `sse_prolog_truncated`.
These are **64 KiB / 10-second admission states**, not the existing 4 KiB / one-second
rejection-sample states. The initial pending receipt precedes the body await and
survives cancellation. `body_class` uses only the first at most 4096 privately
inspected bytes. No native data, IDs, or headers are added to the public evidence.

## Output items

Classifications: message, reasoning, function call, custom tool call, tool-search
call/output, program, program output, unknown. Each keeps its native object.
Ordinary function calls also expose a normalized `FunctionCall` with call identity,
name, encoded arguments, origin, namespace, and completeness hint. Omitted native
function-call status intentionally means complete. A present status means complete
only when it is the exact string `completed`; all other values fail closed. The
native status remains available for inspection.

The generic tool executor uses normalized fields; it does not parse OpenAI wire
JSON. Native caller/fingerprint/phase/encrypted fields remain in the item for later
provider-aware continuation. Advanced/unknown executable output cannot be driven
by the ordinary continuation/executor path.

## Local tool executor events

`tool_execution_started`, `tool_execution_finished`, and `tool_result_reused` are
emitted by the separate tool registry, not by the provider. Legacy `tool-demo`
writes raw NDJSON objects distinguished by `type`. `wi run` nests these same objects
inside `tool_event` with run/turn/session/request correlation. Neither form is durable.
`load_skill` uses these existing events, not a new skill lifecycle or provider event.

| Loader condition | Existing observation |
|---|---|
| Invalid arguments or unknown catalog ID | Pure full-batch preflight returns `InvalidToolArguments` without file I/O; no new execution, correlated result or finish event from that batch. |
| Successful load | Correlated `InputItem::ToolResult`; `ToolExecutionFinished` carries `call_id`, `tool_name: load_skill`, `is_error: false`. |
| Known entry fails during loading | `ToolFailed` retains `gateway_error`; the correlated output is exactly `{"error":{"code":"gateway_error"}}`. The finish event has `is_error: true`, not the result JSON. The model can consume this error in an ordinary continuation. |
| Loaded value serializes above 64 KiB | Correlated `{"error":{"code":"tool_output_limit"}}` and finish `is_error: true`; no truncated success. Exactly 64 KiB is allowed, including metadata and JSON escaping. |
| Whole main file exceeds 1 MiB | Loading fails first with `InputTooLarge`, then adapter `ToolFailed` and registry `gateway_error`; this is not the serialized-result stage. |
| Same call ID and arguments recur | Exact saved result, including an error, plus `ToolResultReused`; no file reread or new start/finish. Reuse has no `is_error` field. Conflicting reuse rejects. |

A distinct call ID performs a new read against the captured catalog; see
[architecture](ARCHITECTURE.md#workspace-context-and-skill-loading-s1--s2) for snapshot
and read timing. Complete next-input validation still applies after result preparation.
Raw paths, OS/parser errors and body text do not enter static error results or
ordinary diagnostics; successful tool/provider data remains sensitive application content.

Cancellation during a pending load fabricates no successful result or finish.
The blocking read may finish after its waiter is dropped, but cannot publish/cache
or continue the run. After execution and serialization complete, the registry
caches the result before calling the finish observer. Observer failure stops later
work without rolling back that completed cache entry.

The [offline loading example](../examples/skill_loading_offline.rs) exercises these
events with synthetic roots and a scripted provider. Offline examples and loopbacks
do not prove live model selection or adherence; those remain NOT RUN.

## Outer run envelope v2

`wi::run::run` and `wi run --json` use `RunEventEnvelope`: `schema_version: 2`,
`sequence`, `event_id`, `run_id`, nullable `turn_id`, `session_id`, `request_id`,
and a flattened event with snake_case `type`. Opaque run/turn/event IDs are fresh.
Sequence starts at 1 and counts attempted emissions independently of inner provider
sequence. It is not a replay cursor. Inner `EventEnvelope` remains schema 1;
its JSON and native payloads are unchanged. These events are sensitive application
data, not safe telemetry.

C1.1 is a breaking Rust/run-event API change, not a Wi version or client-identity
change. `RunRequest` contains exactly `provider_id`, `options` and `prompt`.
Strict deserialization rejects unknown fields, including obsolete `limits` values,
even `null`. Historical schema-1 run recordings remain historical. There is no
schema-1 compatibility emitter; removed outcome variants are neither generated
nor accepted.

| Serialized type | Payload and correlation |
|---|---|
| `run_started` | No event-specific payload; before open, with null turn/session/request IDs |
| `turn_started` | 1-based `number`; session and new turn ID, request null before receipt |
| `provider_event` | Unchanged nested provider `event`; outer IDs identify the current run and turn |
| `tool_event` | Nested registry `event`; request ID identifies the response that produced the call |
| `turn_finished` | `number`, nullable `response_id`, `outcome`, nullable `upstream_outcome` |
| `run_finished` | `outcome`, `summary`; turn ID null |

These are four lifecycle kinds and two wrappers. `TurnOutcome` uses a `type` tag:
`model_completed`, `tools_prepared`, or `stopped` with a `reason: RunOutcome`.
Prepared tools do not prove the next request was submitted; no result-delivery ACK
is invented. `RunOutcome` also uses `type`: only `completed`, `failed` with static
`code`, or `cancelled_locally`.

`RunSummary` contains `turns_started`, `turns_finished`, `model_requests_attempted`,
`model_requests_admitted`, `new_tool_dispatches`, `tool_results_prepared`,
`reused_results`, nullable `last_request_id` and nullable `last_upstream_outcome`.
Attempts count generate calls and admissions count receipts. New dispatches count
accepted dispatch boundaries after start-event delivery; cancellation at that boundary
can prevent the tool body from running. Prepared/reused results
are not upstream acknowledgements. Outer sequence, turn numbers and summary counters
use checked `u64` arithmetic; unrepresentable values fail with static `counter_overflow`
rather than wrapping. Counters are observations, not execution quotas, billing or
live-ledger evidence.
`RunResult` adds run/session identity, outcome, summary, the last full response,
`events_complete` and nullable `sink_error`.

Pre-admission validation returns `Err` with no events or session open. An admitted
controlled run starts with `run_started` and ends with `run_finished` if the sink
remains healthy. Each started turn gets one finish. Open failure has no turn.
Incomplete/failed/provider-cancelled responses never execute tools or continue;
the last response and provenance remain inspectable. Completed refusal is a completed
run, not proof that the requested task succeeded.

The synchronous observer returns `RunSinkError::{Full, Closed, Failed}`. Callers
must not block it; channel forwarding must be bounded and nonblocking. A sink error
stops later emission and work without retry and marks `events_complete=false`.
Failure delivering the final event preserves the selected execution outcome and
records `sink_error`; it does not emit another terminal event. CLI delivery failure
exits 1 even after execution completed. The returned result is authoritative because
a callback can partially consume an event before returning an error.

Cancellation normally produces controlled terminal events. No whole-run timer or
count policy produces a terminal event. A validated completed no-call response
keeps its selected disposition if an observer cancels later; call-bearing work
still checks cancellation before dispatch. Tools and observers must cooperate.
Cancellation does not roll back external side effects, guarantee kernel-blocking
interruption or confirm upstream termination. Tool-specific timeout expiry is the
tool's ordinary error/result, not a run-deadline outcome; the controller installs
no tool timers or generic timeout API.
Dropping the run future requests session closure when a handle exists, but cannot
return a result or promise terminal delivery. Process loss has the same delivery
limit. There is no durable replay, event store, internal unbounded queue or detached
tool task.

The future one-owner, multiple-device service must keep work independent of browser
disconnection and persist application sessions. A client subscription must not
own this fallible run observer directly. Restart stops active tasks without
automatically resuming or restarting them. Storage and service design remain
deferred; S1/S2 implement neither persistence nor a server/UI. Current sequences
and provider-session IDs are not a durable-session design.

## Not emitted yet

No `agent_start`, `agent_end`, `turn_start`, `turn_end`, message transcript,
approval, compaction, queue, or retry lifecycle is claimed. The implemented run
lifecycle uses the exact names above, not aliases from another harness. Native steering acknowledgements are not
implemented; `steer()` returns UnsupportedFeature. SSE and WebSocket share the
implemented provider-event contract but not imaginary feature parity.
