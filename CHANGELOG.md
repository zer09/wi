# Changelog

## Unreleased

### Added
- An in-process `wi::service::RunHost` that owns explicitly submitted persisted runs
  independently of weak clients, passive tickets, and acceptance/completion waiters.
- Separate dispatch, commit-backed acceptance, and final completion boundaries.
- Session-and-run-addressed cancellation and orderly shutdown that drains tracked work
  before closing SQLite storage.
- Worker-loss reporting, storage-quarantine preservation, restart-without-resumption
  coverage, joined WebSocket/SSE loopback tests, and the offline `host_offline` example.

### Verification
- V1-A is complete and accepted under contract `v1a.0` at implementation head
  `fad3855db70ff4151a5c27ec3f64d04fa9097cbb`. Local gates and independent reviews passed.
- Exact-head push run **35320097103** and pull-request run **35320100396** passed all six
  Cargo steps on Ubuntu/macOS/Windows. See `docs/slices/v1a/VERIFICATION.md` for job evidence.
- During acceptance preparation, PR #8 was observed open and draft, not merged.
  The recorded runs prove only the implementation revision above. Current PR-head merge
  checks are external GitHub merge-readiness evidence, separate from this fixed
  implementation evidence.

### Not included
- V1-B network commands, client authentication, browser-safe protocol, subscriptions, GUI,
  ordinary CLI persistence, automatic retry/failover, or automatic task resumption.
- Live/provider verification, release, or deployment.

## 0.2.0 — source milestone, 2026-09-07

### Added
- Persistent WebSocket sessions for the Codex subscription endpoint.
- Explicit SSE selection using the same normalized event decoder.
- Independent command handle and event receiver; one active request per session.
- Connection-scoped WebSocket parent-ID continuation and full native-context SSE replay.
- Response, output-item, text/refusal/reasoning/tool-argument, terminal-outcome,
  and provider-extension event handling with request and session identifiers.
- A bounded, deterministic `add_numbers` tool round trip outside the provider.
- Capability declarations and fail-fast rejection of unimplemented native features.
- Local interruption, bounded event queues, final failure delivery, timeouts,
  no silent retry/fallback, and loopback protocol tests.
- A future-provider example that imports no OpenAI-specific code.

### Changed
- BREAKING: `Provider::stream(GenerationRequest)` is replaced by
  `Provider::open_session(SessionOptions)` and a separate `SessionControl`.
- BREAKING: stream items are `EventEnvelope`; accepted-request failures are
  `RequestFailed` events. Admission/setup failures remain Rust `Result::Err`.
- `Completed` is no longer the sole terminal model event. `ResponseFinished`
  carries completed/incomplete/failed/cancelled outcomes and native final state.
- WebSocket auth is fixed at handshake; SSE reloads credentials per request and
  rejects an account change. Both remain read-only and never refresh tokens.
- Unix credential opens use O_NOFOLLOW for the final path component.

### Not included
Native steering, native async tools, programmatic tool execution, tool search,
skill loading/upload, HTTP server/UI, filesystem/shell tools, a production agent
loop, durable storage, automatic reconnect/retry, keyring access, or OAuth login.

### Verification
See docs/VERIFICATION.md. Rust compilation/tests and live requests were NOT run
in the delivery environment. Do not treat this source milestone as a tested release.
