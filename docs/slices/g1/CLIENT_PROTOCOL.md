# G1 client protocol and state rules

Contract **g1.0**, baseline **76bb32fd04fd4737c0efcceaabc7d10387453147**.
**PLAN ONLY.** This document governs browser behavior; the accepted server wire
contract is [V1-B API](../v1b/API.md), with the [current native-platform policy](../../PLATFORM_SUPPORT.md).
Read actual src/http_api/dto/{mod,events,provider,errors}.rs and router code before
writing TypeScript types. Do not replace the existing API with a client-invented one.

## 1. API adapter and runtime validation

Use fixed same-origin `/v1` URLs and authenticated fetch. Read JSON only when the
response has the expected media type. Validate objects as unknown values at runtime;
TypeScript `as` casts alone are not validation. Distinguish authentication failure,
HTTP command failure, network/aborted reply and malformed protocol. No raw JSON,
exception/body/URL/Authorization dump goes to the UI console or ordinary diagnostics.
Errors show static client categories and the validated server code/stage/certainty.

The server uses flat DTOs, not a universal `{data:...}` or `{error:...}` wrapper:

| Response | Actual fields to validate/use |
|---|---|
| SettingsView | api_version,workspaces,provider_id,model,provider_transport,enable_add_numbers |
| CreateView | api_version,session_id,receipt,duplicate,warning_code |
| RenameView | api_version,receipt,duplicate,warning_code,catalog_refresh |
| RefreshView | api_version,session_id,disposition |
| SessionListView | api_version,entries,next_after_id,has_more |
| SessionView | session_id,title,workspace,created_at_ms,updated_at_ms,head_sequence,view; canonical GET adds top-level api_version |
| CatalogEntryView | flattened observed SessionView plus observed_head_sequence,availability,fault_code,last_run_id,last_run_state; head_sequence is the same observed value, not a new canonical read |
| HistoryView | api_version,session_id,through_sequence,next_after,has_more,events |
| TaskAcceptedView | api_version,receipt,duplicate,warning_code,notices |
| RunView | api_version,run_id,state,user_text,accepted_sequence,terminal_sequence,result_sequence,result_recorded,result |
| Operation lookup | api_version,receipt |
| CancelView | api_version,session_id,run_id,disposition |
| ErrorView | api_version,code,stage,certainty,acceptance,notices — these are top-level fields |

Null and omitted are not interchangeable. Reuse the exact source enum strings,
including `cancelled_locally`, `not_tracked`, `native_terminal` and
`validated_output_item_done`; do not invent camelCase serialized names. Check
api_version===1, required fields and supported variant data. Reject unknown event
kinds/unsupported versions rather than silently dropping a durable record. Unknown
private provider extensions already arrive as the known checkpoint view.

Receipt fields are operation_id,session_id,run_id|null,first_sequence,last_sequence.
Treat UUIDs as identities and validate the request/session associations. Sequences,
ordinals, indices, counters and timestamps are canonical decimal strings. Parse with
BigInt for ordering/arithmetic, never Number/parseInt. Syntax is `0|[1-9][0-9]*`.
Session sequences/timestamps remain within nonnegative i64; counters within u64.
Indices retain their source optional/null semantics. Version numbers and booleans
are not decimal strings. Formatting timestamps is optional; a Number conversion is
allowed only after an explicit representable Date-range check, otherwise display
the exact string. Do not convert unknown large integers through floating point.

The state reducer accepts the same validated EventView from pages and SSE, not two
slightly different message schemas. The UI exposes the server's closed views only;
it never parses provider-native or prepared-context payloads.

## 2. Session operations

Connect -> GET settings -> GET sessions. Neither step submits a task. Session list
uses after_id/limit32 and the actual next_after_id/has_more. Show that entries are a
catalog observation; a selected canonical session header comes from GET session.
An explicit refresh-list starts again from the first catalog page. Do not claim a
newest-first order or overwrite a canonical title with a stale catalog observation.

Create captures one immutable `{operation_id,title,workspace}` at explicit Create.
Use crypto.randomUUID; absence of the secure browser API is an unsupported-client
error, not a homegrown random fallback. workspace must be selected from authenticated
settings exactly; no arbitrary path box. Send POST /v1/sessions.201 is new and200 is
duplicate; validate returned original identity/receipt. A lost response leaves the
same captured command available for explicit retry, never allocates another ID on
an automatic action. A current workspace403 remains a refusal even on a duplicate
create. No client bypass of workspace retirement.

Rename captures its own operation_id and exact title, POSTs rename, displays the
actual receipt and independent catalog_refresh result, then reads the canonical
manifest. An accepted rename with a failed refresh is not rolled back in the UI.
Explicit Refresh catalog uses the existing endpoint. No deletion/archive/search,
workspace registration or settings mutation is implemented.

For ambiguous create/rename replies retain the captured command in memory until an
explicit retry/reconciliation or deliberate discard. Changing text means a new
explicit command; do not reuse an old operation ID with silently changed content.
Reload/Disconnect loses unaccepted local drafts and pending-command memory. Warn of
that limitation in usage; do not compensate with browser persistence of secrets or
automatic submissions. The canonical accepted conversation remains on the server.

## 3. Task submission and receipts

At explicit Send capture session_id, new operation_id, new run_id and exact composer
text as one immutable pending command. Do not trim/normalize it. UI may reject blank
input under existing server semantics; it must not add a task-count/time/history
budget. Guard duplicate button/keyboard activation locally for that command.
POST `/v1/sessions/{sid}/runs` with exactly operation_id,run_id,text.

Pending means awaiting acceptance, not already saved. Keep any optimistic draft in a
separate labelled pending area, never append it to the canonical transcript.202 must
validate the real receipt's session/run/operation IDs and sequence range. Show accepted
with any safe warning/notices, not completed. The stored `run.accepted` view supplies
the canonical user message exactly once; clear the pending display when matched.

An HTTP failure, read abort or lost reply may follow dispatch or commit. Follow the
actual ErrorView certainty and acceptance; do not infer not_committed from network
failure, missing reply, EOF, or a404 receipt read. Known matching acceptance evidence
wins over a later observation failure. Read-only reconciliation is exposed explicitly:
GET the operation receipt, then the run view and relevant canonical history as needed.
Validate matching operation/session/run, the two-record B2 acceptance range,
RunView.accepted_sequence and exact original user_text before calling it this task's
accepted command. A receipt for another method/run or mismatching content is a visible
conflict, not permission to submit with a replacement ID.

`Retry same submission` is an explicit owner action using the identical captured
body. Never automatically POST on connect, navigation, stream end, retry timer, reload,
provider error or reconciliation. A user-edited task requires a new explicit command.
No execute-again button masquerades as recovery. If the tab loses the command before
learning acceptance, the owner can inspect canonical history; the client cannot
promise seamless recovery of an uncommitted lost draft.

An active-run409, stale-history409, unsupported/incomplete-history error, account
mismatch or provider failure remains truthful. Do not queue, steer, truncate old
history, change model/account, retry the provider or discard an uncertain tail.
B2's compatible-history decision stays exclusively in the server.

Cancellation is POST /v1/sessions/{sid}/runs/{rid}/cancel with `{}` and an explicit
button action. A requested signal does not establish completed cancellation. Only
canonical RunView/events determine state. Client reads, mutation-reply waiters,
streaming and navigation have separate AbortControllers; none calls run cancellation
as cleanup. Only the server owns execution.

## 4. Observation epochs and fixed-head loading

Maintain a connection epoch and a selected-session observation epoch. Each async
callback verifies both before modifying visible state. Switching sessions invalidates
and aborts the old reader/page/stream; already delivered old callbacks cannot mutate
the new session's reducer or cursor. Completion of an old session's HTTP mutation
may update its pending command record, but not the new conversation view. Disconnect
invalidates both epochs and clears sensitive state; no cancellation is sent.

On selected session load:
1. Reset that session's display reducer and applied cursor to sid:0.
2. Read canonical manifest and GET history after=sid:0&limit=32. Capture the actual
   through_sequence H from this first page.
3. Apply each validated record atomically in sequence. Continue using returned
   next_after and the SAME through=H until has_more=false. Validate stable session/H,
   cursor progress, record order and page metadata. Never silently stop at one page.
4. Attach authenticated fetch SSE after=sid:H. The applied cursor, not an arbitrary
   client timestamp/provider ID, bridges the snapshot and later history.

A metadata-only fresh application session has no prior messages although it has
session-created/private checkpoint records. Do not restore another session's content.
Opening after service restart is reading and may observe existing storage interruption;
it never starts an old task. No task is triggered by hash routing or refresh.

After a stream drops, mark observation disconnected while retaining the valid
applied prefix and actual run state. Expose Reconnect observation. It attaches with
`after=<last_applied_cursor>` (or pages after that cursor before attachment) and does
not clear/reapply already accepted messages or resubmit work. A deliberate full
Reload history resets and replays from0 under a new epoch. No automatic reconnect
backoff/retry framework or silent infinite error loop is required in G1.

## 5. Incremental SSE parser

Use fetch's ReadableStream plus streaming fatal UTF-8 decoding. A network chunk is
not an event or code-point boundary. Support split multibyte UTF-8, a single initial
BOM, LF/CR/CRLF including split CRLF, comments, blank-line dispatch, field value rules
and multi-line data joined with LF. A dispatched record requires its blank delimiter.
EOF with an unfinished frame is not applied, and EOF is never a task terminal event.

The Wi frame is event:wi.event, id:<sid>:<seq>, data:<JSON EventView>. Validate both
the SSE id and JSON identity; they must agree with the selected session. Comments do
not advance the cursor. A wi.error contains a flat ErrorView and no id; show a safe
observation error and end that reader without advancing or cancelling. wi.closed,
when present, has a static reason and no id; it means observation/server closure,
not that every run completed. Unknown/malformed Wi events or bad UTF-8 fail the reader
with a static protocol error, preserving the last applied prefix. Do not execute
SSE retry fields; Wi does not supply an automatic task-retry protocol.

Every connection locally starts its parser empty but receives the explicit applied
cursor. Do not assign a new durable sequence to a heartbeat or no-ID error. An
invalid/mismatched cursor error must not trigger a new-session fallback or a task.
Release/cancel the read stream on navigation/Disconnect and fence late callbacks.

## 6. One application of each canonical record

Track exact validated EventViews for applied sequences, or a deterministic identity
and canonical-content fingerprint with an equivalent comparison oracle. Recursive
object-key sorting may be used for a canonical comparison; preserve array order and
string bytes. JSON object key order alone does not constitute conflicting data.

For a new record require sequence=last_applied+1, matching session, valid event_id and
consistent run identity. Apply the reducer first, then advance the applied cursor.
For a previously applied sequence, identical event identity/content is ignored;
different identity/content is a visible integrity error. A gap is not silently
skipped. Stop the reader at the last valid prefix. This includes checkpoint records.
Do not label network delivery exactly-once across crashes; the client applies known
records idempotently during its in-memory lifetime.

Keep only the selected conversation's materialized display/history and unresolved
command records needed by this page. No all-session transcript cache or server-state
copy. G1 has no lifetime history quota or eviction/truncation policy. Memory/DOM can
grow with a long selected conversation; report finite measurements without constant-
RSS claims. Further virtualization is a later performance requirement, not a hidden
history cap.

## 7. Pure conversation reducer

Use `(run_id,response_id)` for responses and `(run_id,call_id)` for tool results;
provider response/call IDs must not collide across runs or conversations. Render runs
in accepted application-sequence order, response/items in their provider output
order, and content using its defined content/summary indices. Do not order by random
UUID or network completion time.

| EventView kind | Required effect |
|---|---|
| session.created/renamed | Update metadata only, not a chat message. |
| run.accepted | Add original user_text once for this run; expose selected skill IDs as optional metadata, not hidden skill bodies. |
| checkpoint | Advance application cursor without rendering private data or a phantom message. |
| run.started,turn.started/finished | Update lifecycle/turn metadata without adding user or assistant text. |
| response.started/status | Create/update response state, preserving its real identity. |
| response.delta | Update provisional content keyed by item ID/output index and content/summary index/kind. Do not parse partial function JSON as an executable command. |
| response.item.started/finished | Replace that provisional item with the current ItemView at its output index; do not append snapshot text after the same deltas. |
| response.finished | Replace the response with authoritative ResponseView, provenance, output/items, usage and outcome. Never append a second copy of its provisional answer. |
| response.failed/closed | Preserve visible partial content and explicit uncertainty; a closed stream or response is not automatically a completed task. |
| tool.started/finished | Update intent/execution status; finish alone does not invent result bytes. |
| tool.result | Store/display exact output string and actual is_error, including error-shaped successful JSON. |
| tool.reused | Refer to the existing result with reused indication, not a second effect or duplicate result message. A reference lacking its earlier loaded record is a visible protocol issue, not fabricated output. |
| run.finished | Update actual outcome and summary; terminal execution does not imply final result was recorded. |
| run.result | Update recording/result summary only. There is no last_response in this DTO to append as an answer. |
| run.interrupted | Preserve partial output and mark the stored interruption. Never restart or complete it synthetically. |

A response renders supported ItemView.content blocks where available, and uses
normalized response.text only as the response-level fallback when no displayable
message text/refusal exists; do not render both as duplicate answers. Reasoning blocks
are separate collapsible text, not ordinary final-answer text. When normalized text
contains additional information that cannot be represented by available blocks,
show one clearly labelled authoritative text fallback instead of silently losing it
or appending it twice. unsupported_content stays visible as a marker. Finalized-item
recovery is displayed using the actual projected authoritative items and provenance,
without changing the stored native terminal or assuming it was nonempty.

RunView polling is read-only and explicit or triggered by canonical terminal
observations; it must not synthesize an event or advance the history cursor. Use
result_recorded/result_sequence to distinguish terminal state from final recording.
A response outcome completed does not mean the whole tool loop has finished.

## 8. Testable interfaces and limitations

Keep parser, validators and reducer independently importable without document/window
side effects; app.ts alone wires the DOM and fetch lifecycle. Unit tests use compiled
modules and actual-schema fixtures. Browser tests inspect textContent, visible status,
real HTTP requests and persisted evidence; DOM screenshots are useful layout evidence
but not proof of tool execution or receipt durability.

No third-party model HTML, resource download, provider key, native replay, shell/file
execution, UI model switching, persistent local drafts, per-device logout/revocation,
automatic task retry, compaction or browser compatibility claim beyond tested Chromium
is added. Native Windows support remains withdrawn; browser OS is an independent
consumer capability that needs its own observed evidence before being certified.
