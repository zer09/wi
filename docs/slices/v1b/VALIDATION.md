# V1-B source validation and decision ledger

Contract **v1b.0**. Reviewed 2026-09-19 at accepted merge `16d623a3317abc7796ec203e4fe15d580791a769`.
This records source/design checks, not implementation, Rust compilation, benchmarks, proxy deployment or a security certification. Every new acceptance row remains NOT RUN.

## 1. Verified baseline and review recovery

PR #8 is merged. Source `fad3855db70ff4151a5c27ec3f64d04fa9097cbb`, evidence `c828f8a0e1164aea4731ba8784c3c0e838e962b4`, merge `16d623a3317abc7796ec203e4fe15d580791a769`. The merge tree equals the evidence head. Push35325229157 and PR35325232536, both attempt2, completed all six Cargo gates on Ubuntu/macOS/Windows. The merge completed before a failed chat response; recovery verified it rather than repeating it.

V1-A's reported750 Rust passes/six ignored children/152Node/examples/reviewers are attributed local evidence. Earlier Windows watchdog expiries remain recorded reliability observations; same-SHA passing attempts do not prove their cause or a repaired flake. No new confirmed V1-A blocker was found in the reviewed paths. Historical reports and plan-time statuses are preserved.

## 2. Actual producer/consumer boundaries

All source links use the pinned prefix https://github.com/zer09/wi/blob/16d623a3317abc7796ec203e4fe15d580791a769/ .

| Actual file/interface | Established source | V1-B implication |
|---|---|---|
| src/service/mod.rs | Non-Clone RunHost owns store/gateway/tracker; weak RunClient submits/cancels; registration before spawn; owner closes dispatch/drains then storage. | HTTP uses that owner, not a second loop. Shared handler references cannot postpone owner shutdown initiation. |
| src/service/tickets.rs | Passive watch-backed tickets; accepted prioritizes real receipt over completion, send_modify retains facts without receivers. | Await accepted for202; HTTP/ticket drop does not cancel; no network completion cache. |
| src/execution/mod.rs and types.rs | B2 selected-history acceptance, paired input/registry, actual recording failures/cleanup certainty; one shared engine. | Do not call provider controls directly from handlers or manufacture acceptance. |
| src/storage/session.rs | manifest,rename,history_page,run_record,history_selection,lookup_receipt,refresh_catalog are actual public operations. Run record includes accepted_sequence/input. | Qualified cursors, strict acceptance-range verification and read-only raw-task receipt reconciliation need no new storage API/schema. |
| src/storage/catalog_sync.rs | RefreshResult is exactly Updated or Unchanged; it does not expose its observed head. | RefreshView returns that disposition only; no invented head getter or later read falsely labelled the same snapshot. |
| src/storage/dto.rs | SessionManifest has created_at_ms/updated_at_ms/head_sequence; last_run metadata is on catalog SessionSummary, not canonical manifest. | SessionView has no guessed last_activity or canonical last_run. List explicitly labels observed catalog state. |
| src/storage/records.rs | RecordedRunInput has user_text(), prepared_request(), tool_definitions(), manifest getters and capture(). | Compare the original user_text for the narrow HTTP command identity; capture real S2 preparation, never JSON transcript concatenation. |
| src/storage/history.rs and run_store.rs | Typed canonical events contain prepared input, binding/native runtime content and actual result bodies; fixed-head pages and terminal/final-result distinction. | Direct serde of storage data is NOT the browser API. One allowlisted view/checkpoint per record preserves cursors; actual result flags are never inferred. |
| src/context.rs and context/preparation.rs | ContextRoots is explicit; synchronous discover/preparation; nonempty catalogs add loader; invalid individual entries produce diagnostics. | Blocking preparation runs off runtime worker, reads approved roots only; notices remain visible. Dropped local read does not gain dispatch authority. |
| src/provider.rs | ModelResponse/OutputItem/EventEnvelope include sensitive native data, provenance and unrestricted diagnostic Strings. | Separate response/item views with closed scalar extraction; unknown native extensions never leak via a generic serde fallback. |
| src/run/events.rs and run/mod.rs | Run-local/provider identities differ from application sequence. Outcome code is a String; RunResult contains last_response. | String code allowlist and decimal-string numbers; do not duplicate message text from finalResult or reinterpret sequence fields. |
| src/error.rs | ToolFailed -> gateway_error; AuthExpired -> auth_expired; Protocol -> protocol_error; public codes are fixed. | Network status/projection adds no core error category changes. |
| src/storage/lifecycle.rs | Closing rejects new operations, drains admitted SQL/execution, uncertain retirement quarantines lease. | Server drains via RunHost; no manual unlock, cancelled SQL-waiter rollback inference or new shutdown timer. |
| src/providers/openai_codex/mod.rs and managed_auth.rs | managed(default_location,account) constructor; actual profile selection/renewal occurs on provider open. Nullable alias keeps existing selection behavior. | CLI startup does not list/status/login/refresh or change provider credentials. Synthetic loopback injection remains test-only. |
| Cargo.toml | Existing Tokio/network/signal/sync, tokio-util rt, ring/zeroize/reqwest/serde available; no HTTP server. | Axum exact minimal direct dependency is newly authorized, necessary transitive additions only. |

These observations do not prove that the unwritten network wrapper is correct. Matrix rows exercise actual producer-to-consumer behavior, not data built to match an assertion.

## 3. Explicit new design choices

HTTP commands plus SSE is the first browser protocol; it does not change provider WS/SSE. Wi-service bearer authentication is separate from provider OAuth. A shared high-entropy owner secret, literal-loopback listener and same-host HTTPS proxy are a deliberately narrow deployment model, not per-device login/native TLS/Internet-edge security.

The raw HTTP task body has only operation_id/run_id/text. Stable duplicate handling compares those fields against the original selected B2 acceptance before current context work. Existing internal Rust idempotency still compares prepared snapshots. A failed racing wrapper may reconcile once by READ, never dispatch again. Same-ID/different-text or wrong-method receipts conflict. Known acceptance is not equivalent to successful execution or successful later catalog refresh.

Canonical polling avoids adding a broadcast/cache and replay/live handoff race. Its250ms caught-up observation delay and32-record internal window are explicit IO/latency choices, not task deadlines or retained-history limits. The final implementation must measure costs, including operation-scoped SQLite connection overhead. No unmeasured speed/SLA claim.

Browser projection deliberately excludes private replay data and preserves only supported human-content fields. TextBlockView is exactly `{kind,text}`, with kind text/refusal/reasoning_summary/reasoning_text. Current stored native bytes remain unchanged and replay still uses B2's real records. A checkpoint can disclose that a record exists but not its private contents; this is not a public-telemetry API. User/tool text can itself contain secrets.

## 4. Shutdown implementation constraint

Axum graceful HTTP shutdown is not RunHost shutdown. Stop HTTP admission and idle/body/SSE waits, trigger the existing host coordinator and await its actual result. A private cancellation-aware listener IO wrapper is permitted and required when needed to close pending socket reads/writes on owner shutdown, without a timeout. Closing an HTTP connection/handler WAITER is distinct from aborting host execution or the owned SQL task. Those actual owners continue draining under V1-A/P1. Do not detach indefinitely blocked network connections, add a task timer, expose abort handles, or label an unawaited Drop as completed shutdown.

The public serving API still accepts a TcpListener; an internal Axum Listener/AsyncRead/AsyncWrite adapter may wrap accepted sockets with the server closing token. Its shutdown readiness must register a real waker; no spin loop or task per byte. Test an unread response/stalled read/idle SSE during owner shutdown, not only friendly clients. This is narrow transport cleanup, not a new executor/framework or modification of RunHost semantics.

## 5. External primary references

Checked during planning, not authority to silently adopt later defaults:
- https://docs.rs/axum/0.8.9/axum/ — framework/API.
- https://docs.rs/crate/axum/0.8.9/source/Cargo.toml.orig — actual feature/dependency definitions.
- https://docs.rs/axum/0.8.9/axum/serve/struct.Serve.html — graceful serving.
- https://docs.rs/axum/0.8.9/axum/serve/trait.Listener.html — private accepted-IO composition.
- https://docs.rs/axum/0.8.9/axum/response/sse/ — SSE encoding/keepalive.
- https://docs.rs/ring/0.17.14/ring/hmac/fn.verify.html — constant-time verification.
- https://www.rfc-editor.org/rfc/rfc6750.html — bearer header/confidentiality principles, not Wi token issuance.
- https://html.spec.whatwg.org/multipage/server-sent-events.html — framing/Last-Event-ID and constructor limitations.

No Cargo/rustc was available to the planner. No full dependency-resolution, new race test, browser execution, benchmark, live provider operation or deployment was performed. The local implementor must compile/test actual lock resolution and every specified path. Baseline source pins do not make new DTO/API code existing behavior.

## 6. Preservation and future work

Core provider/auth/tool/runtime APIs remain; session schema2/catalog1/stored1/runtime2/provider1 do not change. New HTTP schema1 is separate. No RunLimits, optional budget, global call/task timer, session/history lifetime cap, auto deletion/resume, retry/failover, new tools/providers, arbitrary file APIs, GUI, native TLS/cookie login, per-device revocation, import/search/compaction or deployment.

After this slice, GUI work can consume the documented service API. Richer operator/task model selection, per-device login, native TLS and production deployment require their own explicit scope. They are not silently included or claimed complete here.
