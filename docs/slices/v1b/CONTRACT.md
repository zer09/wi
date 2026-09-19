# V1-B — authenticated headless HTTP service

Contract **v1b.0**. Prepared2026-09-19. **PLAN ONLY / NOT RUN**.
Accepted baseline `16d623a3317abc7796ec203e4fe15d580791a769` (V1-A merged, PR #8).
Read API.md, SECURITY.md, MATRIX.md, VALIDATION.md and IMPLEMENTOR_PROMPT.md with this contract.

## 1. Concrete outcome

Deliver a runnable Rust service without a GUI. An authorized client creates/lists/opens/renames a persistent application session, submits a text task, receives its actual durable acceptance, reads committed history/outcome, follows events over SSE, disconnects/reconnects and explicitly cancels a run. A later explicit task uses accepted B2 replay. Opening storage/reconnecting/restarting never resumes an old task.

Reuse RunHost, run_in_session, the recorder, per-session SQLite, S1/S2 preparation and existing tools. No second agent loop, generation retry, request-owned execution or transcript-as-one-prompt restoration. These endpoints are Wi application APIs, not OpenAI endpoints.

New choices for this slice: HTTP JSON commands plus SSE; one preprovisioned shared owner bearer secret; literal-loopback HTTP with a separately configured same-host HTTPS proxy for remote devices; an explicit workspace allowlist; allowlisted browser DTOs; canonical-history polling rather than a new event bus/cache. These are explicit first-service design choices, not claims of existing behavior or per-device/native-TLS security. Provider OAuth stays unchanged.

## 2. Modules/dependencies and public boundary

Add wi::http_api modules and a thin private `wi serve` adapter. Old CLI commands and all core APIs keep their semantics. Only one new direct dependency is authorized:

```toml
axum = { version = "=0.8.9", default-features = false, features = ["http1", "json", "query", "tokio"] }
```

Necessary transitive additions/feature unification are allowed and inventoried; no broad cargo update or additional direct TLS/cookie/JWT/framework dependency. Reuse existing Tokio/tokio-util/reqwest/serde/ring/zeroize/async-stream; reqwest::Url validates origins. Minimal version/features must actually compile against the locked dependency set.

Public `http_api::serve` accepts a bound Tokio TcpListener, owned RunHost, validated ApiConfig and shutdown CancellationToken. It is Send. Its structured return preserves the actual Arc<ShutdownOutcome> and any static HTTP serving failure, never hiding host Incomplete behind network success. ApiConfig has immutable settings and a redacted, nonserializable OwnerToken verifier. No framework request type enters the core. A library caller can supply its own trusted Gateway/RunHost for offline tests without CLI or auth manager.

Settings: explicit public_origin; canonical absolute allowed workspaces; explicit absolute global_skills_root; provider_id; current SessionOptions with tools empty; enable_add_numbers. Use a concrete empty/AddNumbers tool template and S2's automatic load_skill registration. HTTP callers cannot provide tools, prepared contexts, endpoints or native history. Model/instructions/transport are operator settings in this first slice. Broader per-task settings, model switching and device administration are separate future work.

Allowed production changes are new http_api code, its library export, new CLI serve module/command wiring and the stated dependency/lock changes. Existing service/execution/storage/provider/context/tool semantics, APIs and schemas are fixed dependencies. Reuse existing cfg(test) barriers/helpers and add joined tests near private adapters as necessary. Report an exact source/consumer conflict before editing those production dependencies or widening scope.

## 3. Runnable configuration

`wi serve --config <absolute-json-file>` reads strict regular-file UTF-8 JSON at most existing MAX_INPUT_BYTES. Unknown/duplicate fields or invalid options fail with static errors, not source paths/parser excerpts. Config:

```json
{
  "schema_version":1,
  "listen":"127.0.0.1:8787",
  "public_origin":"https://wi.example.test",
  "data_root":"/absolute/wi-data",
  "client_token_file":"/absolute/private/wi-owner-token",
  "global_skills_root":"/absolute/wi-skills",
  "workspaces":["/absolute/project"],
  "model":"operator-selected-model",
  "instructions":"You are a helpful assistant.",
  "provider_transport":"websocket",
  "account":null,
  "enable_add_numbers":false
}
```

All fields required; account alone nullable. Transport is websocket or sse, converted to existing Transport. Workspaces must be nonempty, absolute, existing canonical directories with UTF-8 representations, deduplicated without chdir. A missing global skill directory is allowed under S1 rules. No startup skill-body scan. All configured file/data paths absolute. Canonical workspace revalidation before a NEW task rejects alias replacement; no hostile-filesystem sandbox is claimed.

Only literal-loopback listen IPs, including library listeners. Port0 is allowed; report the actual address. Explicit public_origin has no credentials/query/fragment and no path except slash/empty; HTTPS except literal-loopback HTTP local-development origins. Do not resolve a hostname to decide cleartext is safe or derive trust from an HTTP Host header.

Startup: validate config/options/paths/token file; bind listener; construct existing AuthManager::default_location, managed OpenAiCodexProvider and Gateway without calling list/status/select/login/refresh; open SessionStore; construct RunHost; serve. Pure existing profile-name validation is allowed. account=null retains accepted random selection; explicit alias is recommended for B2 continuity, not a new global auth policy. Actual mismatch remains B2 failure before historical transmission, with no account search/fallback.

Emit one content-free listening notice and static shutdown/error categories, never token/config contents or credential paths. SIGINT/applicable SIGTERM initiate owner shutdown; no browser launch. Inject builders for handler tests; isolate HOME/config so no real profile access occurs. Normal provider endpoints/TLS/auth behavior remain unchanged.

## 4. Request ownership/preparation

SECURITY.md's authority/origin/auth checks precede protected body collection, storage open/migration, filesystem/context or provider work. Body max equals existing MAX_INPUT_BYTES including JSON envelope: a maximum-size legacy prompt may have a slightly smaller HTTP allowance. This is a message bound, not a task/session limit. Preserve text bytes; no silent trim/truncation or widened provider limits. Reject unsupported MIME/encoding and map errors without free-form details.

After RunClient::submit returns, only RunHost owns execution. Request/response/ticket/SSE/history-reader drop never signals run cancellation. Only explicit cancel and owner shutdown do. Await accepted for actual receipt, not completion or dispatch admission.

For a NEW task, pure-lookup its workspace in the current allowlist before probing any caller path, then revalidate the configured canonical path. Run synchronous S1 discover/preparation in an owned spawn_blocking job; no blocking filesystem walk on a Tokio worker. If its waiter is dropped before dispatch, the read may finish but cannot dispatch. Use ContextRoots, actual discover, prepare_run_with_skill_loading with empty explicit selections and the server's template, then RecordedRunInput::capture with original raw text and returned registry. No context watcher/cache or historical skill reread. Preserve actual safe discovery notices on success/fatal preparation; no parser/source-content leakage.

## 5. Raw command idempotency

HTTP task body is ONLY operation_id,run_id,text. Same application session/operation/run/exact raw text identifies the same HTTP task despite later files/settings changes. This adapter-level definition does not change existing Rust prepared-snapshot identity.

Before current workspace/context/provider checks, look up its receipt. A reusable acceptance must match session/run IDs and RecordedRun.accepted_sequence, consist of the real two-record B2 run.accepted + run.history.selected range, have history_selection present and RecordedRunInput.user_text equal to text. Read typed history to establish the method; a nonnull run_id is insufficient. A rename/arbitrary append/B1 acceptance/different run/text conflicts. Missing accepted projections are integrity failures, not permission to execute. Return original receipt without preparation, profile reads or host dispatch.

For absent receipt, validate/prepare/capture then submit PersistentRunRequest and paired registry to RunClient; await accepted and return202 only with actual receipt. Caller-selected IDs are never replaced. Existing B2 remains actual execution/idempotency authority.

Racing absent callers may prepare different current snapshots. On failed preparation or pre-acceptance completion, reconcile ONCE by read using the same raw-command rule. Return a matching committed receipt as duplicate, otherwise the observed error/uncertainty. Do not dispatch again, wait for future acceptance, rebuild stale replay or add a transport command table/cache/mutex. A currently absent receipt cannot prove rollback of uncertain SQL or another concurrent caller. Test these exact races and wrong-method receipt rejection.

## 6. Durable presentation and catalog

API.md defines new closed DTOs. Do not directly serialize StoredEvent, RecordedRunInput, RunResult, ModelResponse, OutputItem, ProviderExtension, RunCompletion or provider binding. Keep canonical data unchanged. Native signed/encrypted/opaque objects, account markers, provider headers/credentials, prepared instruction snapshots and internal config/data roots stay private. User/model/tool text can itself contain secrets; authorized conversation data is not public telemetry. Configured/historical workspace strings are deliberate owner-visible metadata.

One canonical record yields one projected event or content-free checkpoint at its real sequence. Fixed-head history pages remain fixed. Authoritative response snapshots replace matching provisional content; final-result records do not append an answer twice. Preserve JSON text Unicode/line endings, not the terminal's presentation filter. Unknown content gets an unsupported marker, never an arbitrary native fallback. No schema migration or database projection redesign.

Catalog listing is an as-of indexed view, not current task truth. GET session reads the canonical manifest. Explicit refresh uses existing Updated/Unchanged only. Rename attempts one best-effort refresh after a healthy known commit and reports it separately; a failed/dropped refresh cannot revoke the receipt. No permanent refresh poller/completion cache. Clients use canonical reads/events and explicit refresh to update views. Reads that explicitly open a session may run accepted lazy migration/interruption, always after auth and without model/tools.

## 7. Committed SSE

Use short real history pages after a session-qualified cursor; no provider receiver or fallible runtime observer. Drain one fixed H, then read later committed records after the last cursor. The same canonical source serves historical/live data, avoiding a separate subscription handoff race.

At most32 records per internal page. Release connections/transactions/locks before yields/network backpressure. Drain available pages immediately; after caught-up/empty read wait250ms before polling again (simple sleep or missed-tick Delay). This is an observation-latency/IO choice, not an execution timer. Test-only controlled clocks/wakes are allowed. Optional15second comment heartbeat has noID. Never expire a task/history/session on idle. A slow client halts its own next poll rather than accumulating a producer queue or blocking the writer.

Initial auth/session/cursor failure occurs before200. Later read failure sends at most one static noID stream error then closes; no cursor advancement, runcancel or false applied-event acknowledgment. Resume from the client's last applied cursor. Deduplicate by application session/sequence, detect conflicting duplicates; no exactly-once browser processing across lost acknowledgments is promised.

## 8. Server lifetime and shutdown

An owner guard initiates RunHost.begin_shutdown once on explicit shutdown, serving failure, unwind or owning-future Drop. Handler Arc references must not postpone initiation. Handler/client drop is not owner drop. Preserve the original V1-A coordinator/outcome and quarantine semantics.

Normal shutdown: close HTTP command admission, wake/end body/SSE/socket waits, initiate host shutdown, and await HTTP serving/drain plus the host ticket. Host cancels/drains runs with storage writable, then closes storage; previously admitted SQL still owns completion. Do not abort core run futures or owned SQL jobs, release a quarantined lease or add a shutdown deadline. HTTP connection IO/handler WAITERS may close exactly as on client disconnection without cancelling those owners.

Wrap accepted sockets in a small private cancellation-aware Axum Listener/AsyncRead/AsyncWrite adapter when required to wake a pending socket read/write on owner shutdown. Register cancellation wakers correctly, no spin/task-per-byte or leaked detached connection. This is transport cleanup, not an executor. Test nonreading responses, stalled bodies and idle SSE, not only friendly clients. Public serve still accepts TcpListener; no new public socket framework.

Normal return reports both real HTTP drain and Arc<ShutdownOutcome>; CLI exit0 only on normal network termination and host Closed. Incomplete remains failure. Dropping an unawaited serving future proves shutdown initiation only, not completed draining. Unexpected process loss is not graceful: reopen applies existing interruption once and performs zero model/tool work; new host has no restored active registry. Only explicit new task invokes B2, which still refuses incomplete/unbound native replay. No synthetic terminal after WorkerLost.

## 9. Implementation order, acceptance and exclusions

Implement configuration/token; explicit DTOs/cursors; authenticated reads; metadata commands; raw receipt/prepare/submit; cancel; committed SSE; transport/host shutdown; CLI; joined verification and current documentation. Follow this design, not a new architecture pass.

All V1B-00..39, old/new gates/examples and fresh independent complete-diff review are required. Actual HTTP->RunHost->B2->SQLite->OpenAI loopback->real tools is mandatory; component tests do not substitute. Exact-head cross-platform push/PR CI follows separately authorized push. Report finite timings and IO overhead, not unmeasured performance promises.

No RunLimits/replacement budget/global call/task deadline/lifetime history cap, deletion/resume/retry/failover, new schema/store/providers/executors, arbitrary file API, hosted skills/billing, GUI, native TLS/cookie login, per-device auth administration, search/import/compaction or deployment. Old library/CLI behavior and historical evidence remain.

Use only synthetic roots/skills/owner and provider credentials plus scripted/loopback providers. No real credential/private-skill reads, auth commands or live generations. Ledger31/50 used,19 remaining. Implementation commits/pushes/merge/release/deployment need separate owner authorization.
