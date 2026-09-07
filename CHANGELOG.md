# Changelog

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
