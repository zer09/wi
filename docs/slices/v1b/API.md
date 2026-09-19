# V1-B API and committed-history protocol

Contract **v1b.0**, baseline `16d623a3317abc7796ec203e4fe15d580791a769`.
Implemented and tested at `6e28cc339f25a95b78170e7c4171de48f122d07a`.
Status: **LOCAL_VERIFIED, accepted=false**. [Verification](VERIFICATION.md) records
38 PASS/2 PARTIAL, final review and exact-head hosted CI. Windows reparse-point and
Ctrl+C proof remains intentionally deferred. CONTRACT.md and SECURITY.md also govern. Frozen planning documents
retain their original 2026-09-19 statuses.

## 0. Starting the service

`wi serve --config <absolute-json-file>` starts the headless service. The config is
a regular UTF-8 JSON file, at most 1 MiB (`MAX_INPUT_BYTES`). Final symlinks/reparse
points and special files are rejected. Unknown fields, duplicate fields, missing
fields, invalid options and non-UTF-8 input fail with static errors. All 12 fields
are required; only `account` accepts null. There are no implicit config defaults.

```json
{
  "schema_version": 1,
  "listen": "127.0.0.1:8787",
  "public_origin": "https://wi.example.test",
  "data_root": "/absolute/wi-data",
  "client_token_file": "/absolute/private/wi-owner-token",
  "global_skills_root": "/absolute/wi-skills",
  "workspaces": ["/absolute/project"],
  "model": "operator-selected-model",
  "instructions": "You are a helpful assistant.",
  "provider_transport": "websocket",
  "account": null,
  "enable_add_numbers": false
}
```

These are placeholders, not an installed configuration or permission to contact a
provider. Provision a separate owner token using [SECURITY.md](SECURITY.md#2-secret-provisioning-and-verification).
Do not put the secret itself in this JSON, command arguments, environment variables,
URLs, shell history or documentation.

- `schema_version` is the integer 1. `enable_add_numbers` is a boolean.
- `listen` is a literal-loopback socket address, such as `127.0.0.1:8787` or
  `[::1]:8787`. Port 0 is allowed; use the actual address from the startup notice.
- `public_origin` is an explicit HTTPS origin with no credentials, query, fragment
  or path other than an optional trailing slash. Local development may use HTTP
  with a literal loopback IP, not a hostname resolved to loopback. The origin is
  not inferred from Host or forwarded headers. Port 0 does not update this setting.
- All configured file/data/skill paths are absolute. `workspaces` is nonempty;
  each entry must be an existing directory with a UTF-8 canonical path. Startup
  canonicalizes and deduplicates entries without changing cwd. HTTP workspace
  selectors must equal the returned canonical strings. New tasks revalidate them.
- A missing `global_skills_root` is allowed. Startup does not scan skill bodies.
  New tasks use shared S1/S2 discovery and preparation off the Tokio worker, with
  no explicit body selections. A nonempty catalog automatically adds `load_skill`.
- `model` and `instructions` are operator-selected strings subject to existing
  `SessionOptions` validation. `provider_transport` is exactly `websocket` or `sse`.
  The CLI fixes the provider to `openai-codex`; callers cannot supply endpoints/tools.
- `account` is null or an existing valid managed-profile alias. Null retains the
  existing random selection policy. An explicit alias is recommended for B2
  continuity. An account mismatch fails before historical transmission, without
  profile search, fallback or adoption.

Startup validates config/options/paths/token, binds the listener, constructs the
managed provider without listing/selecting/reading/refreshing profiles, then opens
storage and constructs RunHost. An explicit task can subsequently open managed
provider credentials under the existing auth policy. The service bearer token is
not a provider credential.

The process writes `api.listening <actual-address>` and static shutdown/error
categories to stderr, not config contents, token values or credential paths.
Unix SIGINT/SIGTERM and Windows Ctrl+C initiate owner shutdown. The service closes
network waiters, cancels/drains host-owned work with storage writable, and awaits
HTTP drain plus the original host outcome. No shutdown deadline is added.

Exit 0 requires normal HTTP termination and `ShutdownOutcome::Closed`, including
normal signal shutdown. Exit 1 reports startup/output/signal failures, HTTP failure
or `Incomplete`; it does not hide quarantine. Help exits 0. Malformed `serve`
arguments retain Clap exit 2 with static `api.invalid_arguments`, not quoted inputs.
These service exits differ from `wi run`'s cancellation exit 130. Dropping an
unawaited library serving future proves shutdown initiation only. Process loss is
not graceful shutdown. Restart or reconnect never resumes an old task.

Remote devices require a separately configured same-host HTTPS proxy as described
in [SECURITY.md](SECURITY.md#1-principal-and-deployment). No GUI, native TLS, device
login, deployment, task queue or automatic resumption is included. Ordinary
`wi run` remains nonpersistent.

Implementation references: `src/http_api/config.rs:164-237`,
`src/cli/serve_cli.rs:65-188`, `src/cli/mod.rs:385-417`.

## 1. Wire rules

Base prefix `/v1`. Every JSON success/error has `api_version:1`. Storage sequences, runtime ordinals, indices, usage/counter values and timestamps are decimal STRINGS, not JavaScript numbers. Decimal syntax is 0 or a nonzero digit followed by digits: no sign, whitespace, leading zeros, fraction or exponent. Apply existing i64/u64 representability. Booleans/api_version retain their actual types; IDs use existing validated UUID types.

Reject unknown/duplicate body fields and duplicate/unknown query keys. Body-bearing routes require application/json (optional UTF-8 charset), no Content-Encoding except identity, and at most existing MAX_INPUT_BYTES bytes. Missing/null fields reject unless nullable. Empty objects are required where shown. No raw SQL, credentials, prepared context, tool definitions, provider endpoint or native items can be supplied. All routes/methods remain under SECURITY.md's common boundary.

JSON content type is application/json. All responses use Cache-Control:no-store and X-Content-Type-Options:nosniff. No redirects or token cookies/URLs. Browser consumers use fetch with Authorization and an SSE parser/reconnect cursor, not a native EventSource token-query workaround.

## 2. Routes

| Method/path | Input | Success |
|---|---|---|
| GET /v1/settings | no query/body | Allowed canonical workspaces, provider_id, model, provider_transport, enable_add_numbers; never instructions/account/token/auth/data/skill paths. |
| POST /v1/sessions | `{operation_id,title,workspace}` | 201 new actual CreateResult, 200 matching duplicate. workspace is an absolute canonical allowlisted string, not nullable. |
| GET /v1/sessions | optional after_id, limit | Catalog-only ID-keyset page, explicitly as-of catalog. |
| GET /v1/sessions/{sid} | no query/body | Canonical current manifest. |
| POST /v1/sessions/{sid}/rename | `{operation_id,title}` | 200 actual rename receipt plus independent refresh disposition. |
| POST /v1/sessions/{sid}/refresh | `{}` | 200 `{session_id,disposition:"updated"|"unchanged"}` from actual RefreshResult. |
| GET /v1/sessions/{sid}/history | optional after, through, limit | Captured-head page of EventViews. |
| GET /v1/sessions/{sid}/events | optional after; optional Last-Event-ID | Committed-history SSE and later committed records. |
| POST /v1/sessions/{sid}/runs | `{operation_id,run_id,text}` | 202 only with actual B2 acceptance, including observed matching duplicate; never task-success acknowledgment. |
| GET /v1/sessions/{sid}/runs/{rid} | no query/body | RecordedRun view or404; no provider query. |
| POST /v1/sessions/{sid}/runs/{rid}/cancel | `{}` | 202 requested, 200 not_tracked, 503 closed; signal disposition only. |
| GET /v1/sessions/{sid}/operations/{oid} | no query/body | Stored receipt or404; absence is not proof of rollback. |

Unsupported methods405; unknown paths404 after common checks. limit defaults32, accepts1..128 and bounds ONE response/query. SSE internal window32. No task/session/history lifetime ceiling. Invalid sizes reject, never clamp/truncate. Titles retain storage's supported empty/multiline values without normalization. New creation, including a retry, requires a currently authorized workspace; retirement does not delete its old session. Existing reads/rename/cancel/receipts remain available independent of workspace eligibility. Accepted task retries follow CONTRACT.md's stronger receipt-first rule before context/workspace checks.

## 3. Response DTOs

ReceiptView: operation_id, session_id, run_id|null, first_sequence,last_sequence. Use actual stored fields, not allocated acknowledgment IDs. Mutating success has receipt,duplicate,warning_code|null. Create also returns session_id. Rename additionally has catalog_refresh equal to updated,unchanged,not_attempted or failed. After a cleanup warning do not attempt refresh; return the known receipt with not_attempted. A failed/dropped later refresh cannot revoke the rename. RefreshResult has only Updated/Unchanged: do not invent a refresh-head getter or receipt, and do not label a later read as its transaction snapshot.

SessionView: session_id,title,workspace|null,created_at_ms,updated_at_ms,head_sequence,view:"canonical" from SessionManifest getters. No guessed last_run/last_activity field. CatalogEntryView uses observed_manifest for identity/title/workspace/times, observed_head_sequence,view:"catalog",availability,fault_code|null,last_run_id|null,last_run_state|null from SessionSummary. List response: entries,next_after_id|null,has_more. It is not promised newest-first/current-task truth. Do not serialize creation provenance or database relative paths.

RunView: run_id,state,user_text,accepted_sequence,terminal_sequence|null,result_sequence|null,result_recorded,result|null. State is accepted/running/completed/failed/cancelled_locally/interrupted. ResultView: outcome,summary,events_complete,sink_error|null, with NO last_response/provider-session ID. A terminal record without RunResult stays distinguishable. Read errors are not fabricated outcomes.

SummaryView has the seven RunSummary counters as strings (turns_started,turns_finished,model_requests_attempted,model_requests_admitted,new_tool_dispatches,tool_results_prepared,reused_results), last_request_id|null and last_upstream_outcome|null. UpstreamOutcome is not_submitted/unknown/terminal_received. Sink errors retain full/closed/failed. Outcome retains completed/cancelled_locally/failed-with-safe-code. TurnOutcome uses that safe nested outcome. Counters never drive a new budget.

Task accepted response includes notices[] from CURRENT preparation, empty on receipt-only reuse. NoticeView has scope,source_label,kind: excluded.<ContextErrorKind.category>, skipped_symlink,directory_name_mismatch,unsupported_behavioral_metadata. Preserve only existing safe relative labels/static categories, not absolute roots/parser excerpts. Fatal preparation preserves already collected notices too. Reuse does not recreate historical diagnostics or reread instructions.

## 4. Cursors and fixed heads

Cursor is `<application-session-uuid>:<sequence>`; sid:0 is before the first record. Wrong-session cursor, malformed UUID/decimal, extra segments or above-range value rejects. Cursor is not authorization. GET history after defaults sid:0; through is an optional decimal head. Use actual history_page(after,through,page_size). Response: session_id,through_sequence,next_after (qualified cursor),has_more,events. First read captures H; later pages through H stay fixed. Then attach SSE after sid:H. Reject a cursor/through beyond the captured current head rather than waiting for the future. A failed read does not advance cursor.

Release storage connections/transactions/guards before network encoding/yields. An explicit session open may run existing lazy migration/interruption; authenticate first, do no provider/tool work. No transaction spans a subscription.

## 5. One canonical record, one EventView

Common fields: api_version,session_id,sequence,event_id,created_at_ms,run_id|null,kind,data. Preserve application sequence/event identity, not provider or run-local sequence. Each stored record yields one projection; private-only records yield checkpoint with empty data at that same sequence, without the private record's type.

| Stored source | View |
|---|---|
| SessionCreated/Renamed | session.created/renamed: title and recorded workspace on creation only. |
| RunAccepted | run.accepted: original user_text,provider_id,requested model,qualified available/active skill IDs; no prepared input/config/owner instance. |
| HistorySelected/ProviderBound | checkpoint; no digest/principal/account/selection internals. |
| Runtime RunStarted | run.started, empty data. |
| Runtime TurnStarted/Finished | turn.started/finished: turn ID,number,response ID where present,typed outcome,actual upstream uncertainty. |
| Runtime RunFinished | run.finished: safe outcome and summary. |
| Runtime tool event | tool.started/finished/reused: actual name/call/request identities and ONLY the actual event's optional error flag. |
| Runtime ResponseStarted/Status | response.started/status: response ID and mapped known status. |
| Runtime OutputItemStarted/Finished | response.item.started/finished: response ID,index,ItemView; provisional until response completion. |
| Runtime OutputItemUpdated | response.delta: response/item ID,indices,enumerated delta kind and exact delta string. Unsupported custom input stays display-only. |
| Runtime ResponseFinished | response.finished: ResponseView. |
| Runtime RequestFailed | response.failed: safe code and actual upstream outcome; omit provider message. |
| Runtime SessionClosed | response.closed, empty data; no free-form reason. |
| Runtime ProviderExtension | checkpoint, no arbitrary event_type/payload. |
| ToolResultRecorded | tool.result: original call/request ID,exact output STRING,actual is_error. |
| RunResultRecorded | run.result: ResultView; do not repeat last_response. |
| RunInterrupted | run.interrupted: actual typed reason, not a result or rollback. |

ItemView: item_id|null,known ItemKind,function_call|null,content:[TextBlockView],unsupported_content:boolean. FunctionCallView: call_id,name,arguments (original encoded JSON STRING),origin,namespace|null,complete. These are untrusted display values, not an execution API.

Closed native scalar extraction for display ONLY: Message native.content array parts of type output_text with text:string or refusal with refusal:string; Reasoning native.summary/native.content parts of type summary_text or reasoning_text with text:string. Copy only those strings into typed text/refusal/reasoning_summary/reasoning_text blocks, preserving order/bytes. Never copy part objects, annotations, URLs, signatures, encrypted_content or unknown keys. Unrecognized/unrepresentable parts set unsupported_content. Normalized FunctionCall supplies call data. This converter is not used by B2 replay and changes no stored native bytes.

ResponseView: response_id,model|null,typed outcome,output_provenance,normalized text,items,usage|null. Usage has existing input_tokens/output_tokens/total_tokens and nullable cached_input_tokens/reasoning_tokens as strings. Incomplete reasons allow max_output_tokens/content_filter; unknown supplied reason becomes unknown, absence remains null. Retain normalized text when richer content cannot be projected; no claim of arbitrary native rendering parity. No native Value field.

Reference reducer: run.accepted adds raw user text once by run ID; deltas update provisional response/items by real identities; item snapshots replace provisional items; response.finished replaces the provisional response with authoritative text/items. Use supported blocks OR normalized text fallback, not both appended. Run completion changes status only. tool.result belongs to(run_id,call_id), reuse references it without reexecution/readding. EOF is not completion. A pure test reducer is allowed; GUI implementation is not.

## 6. SSE

Use after and/or Last-Event-ID, requiring equality when both supplied; default sid:0. Authenticate/open/validate and obtain initial page before200 text/event-stream. Known initial failures are HTTP errors.

```
id: <sid>:<sequence>
event: wi.event
data: <JSON EventView>

```

Axum encodes framing; user text never enters header/id/event lines. JSON preserves Unicode and escapes embedded newlines. No retry field/token/native payload. Optional heartbeat comments have no ID. Drain fixed H, then query after last emitted record with through=None. When caught up wait250ms as specified. Page32, no transient bus, per-client producer queue or held writer lock under backpressure.

Post-header read error emits at most one wi.error ErrorView without id then closes. Owner shutdown may emit wi.closed with static reason/noid. Neither advances cursor nor cancels work. Clients reconnect after the last APPLIED record, deduplicate session/sequence and detect conflicting duplicates. No exactly-once browser-processing promise across lost acknowledgments. Test commits during every snapshot/page/attach/caught-up boundary.

## 7. Errors and HTTP mapping

ErrorView: code,stage|null,certainty(not_applicable/not_committed/unknown),acceptance|null,notices[]. No generic err.to_string,source chain,request/debug dump,raw PersistentRunFailure or panic payload. Known acceptance returns task202 with actual receipt and static warning, not an error implying no commit. Receipt absence is not rollback evidence.

401 api.unauthorized with WWW-Authenticate:Bearer;403 api.origin_forbidden/api.workspace_forbidden;421 api.authority_invalid;400 api.invalid_request/api.cursor_invalid;413 api.body_too_large;415 api.unsupported_media;404 api.not_found or storage.not_found;405 api.method_not_allowed. Storage mapping: invalid_input400;command_conflict/active_run_exists/stale_history/invalid_transition409;not_found404;busy/closed/unavailable/catalog_repair_required/creation_incomplete/io/commit_unknown503;integrity/unsupported_version500. Preserve actual certainty. Context errors use context.<category> with422, except input_too_large413. Gateway errors before acceptance use actual static GatewayError.code and422. Worker loss/closed owner use api.worker_lost/api.closed503. Shutdown-abandoned acceptance wait has unknown certainty unless stronger evidence was observed.

For free-form provider/run code Strings, pass through ONLY: unauthorized,forbidden,rate_limited,auth_expired,auth_account_changed,timeout,transport_error,unexpected_content_type,locally_cancelled,slow_consumer,unexpected_end,protocol_error,provider_error,invalid_request,output_limit,unsupported_output,unsupported_feature,http_error,gateway_error,event_sink,counter_overflow,tool_execution,provider_open,provider_request_failed,provider_correlation,history_identity,history_restore. Other codes become upstream_error. This changes presentation, not core mapping. Known response statuses: queued,in_progress,completed,incomplete,failed,cancelled; other strings unknown. Typed ResponseOutcome remains authoritative.

No error path automatically retries dispatch/generation, changes IDs, rebuilds stale selection, repairs uncertain history or switches accounts. Accepted tasks can fail immediately;202 is acceptance only.
