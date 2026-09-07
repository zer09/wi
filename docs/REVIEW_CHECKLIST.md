# Focused review and regression checklist

This is a review agenda, not a list of confirmed defects or passing tests.
File/symbol references come from the delivered v0.2.0 source. Reproduce failures,
apply focused fixes, and record actual evidence in the local verification report.

## Build and packaging

- Verify the original baseline and included docs before edits. Avoid mixing v0.1.0
  and v0.2.0. New handoff docs are not runtime modules.
- Validate Rust edition/toolchain and exact dependency features. In particular,
  inspect reqwest/rustls/tokio-tungstenite version compatibility and shared HTTP
  header types. Do not infer compatibility from similar-looking APIs.
- Compile library, binary, examples, tests, and doctests; run Clippy with warnings
  denied unless a specific justified exception is documented.
- Generate Cargo.lock and keep it. Check target-specific Unix/Windows compilation
  where available; record platforms not tested.
- Existing CI formats before checks. Once the baseline is formatted, make CI use
  a format-check gate so it cannot hide formatting drift.
- `scripts/verify.py` performs inventory and fixture parsing, not Rust analysis.
  Its version/name assertions must not be mistaken for behavioral validation.

## Credential handling — review before real file access

- `auth.rs`: explicitly selected file only; no ambient API-key or account fallback.
- Confirm current Pi OAuth JSON shape and milliseconds-versus-seconds conversion
  using synthetic files. Account-ID and expiry decoding are hints, not JWT trust.
- Test missing/malformed/expired credentials; API-key records; unknown modes;
  invalid header bytes; BOM; size bounds; non-file/symlink paths and Unix modes.
- Check read-only behavior with synthetic credentials updated by a simulated owner.
  Do not use or hash real credentials merely to prove no write occurred.
- Inspect Debug/Display, serde, HTTP/WS errors, panic paths, CLI output, and helper
  logs for secret disclosure. Raw native output is sensitive even without tokens.
- `wire.rs`: confirm fixed trusted production destinations, TLS verification,
  redirect refusal, and test-only loopback overrides cannot leak into production.
- Do not silently change keyring/file storage or filesystem permissions to pass a
  real-auth check. Document Windows ACL and parent-directory limitations.
- Account/session affinity: SSE must not replay one account's history through a
  newly selected account; WebSocket expiry requires a deliberate new session.

## Provider/session contract

- `gateway.rs` stays provider-neutral. External fake provider compiles without
  OpenAI types; adding a provider does not require replacing gateway internals.
- `session.rs`: race concurrent submissions and close; exactly one response is
  active, and cancellation/control is not blocked by output consumption.
- Examine cancellation safety of repeatedly polled receive futures, idle
  Ping/Pong handling, dropped/never-polled receivers, and worker cleanup.
- Exercise bounded queues, slow consumers, terminal-delivery reservation, timeout,
  fatal close, and sequence ordering. No request may hang forever on a lost worker.
- Pre-admission errors, locally accepted requests, provider-created responses,
  terminal outcomes, and uncertain transport failures must remain distinct.
- A disconnect after sending does not prove non-submission. No blind retry,
  fallback, reconnect replay, or fabricated upstream cancellation.

## Event codec and continuation

- `codec.rs`: use real current event schemas as reference and synthetic fixtures
  for adversarial input. Preserve unknown fields without treating them as actions.
- Never mix response ID, output-item ID, function call_id, request ID, or sequence.
- Validate start/status/item/content/terminal ordering and cross-response IDs.
  A terminal response may contain authoritative output absent from partial events.
- Test refusal content, reasoning-summary text versus opaque state, missing usage,
  usage subsets, incomplete/failed/cancelled outcomes, and terminal aliases.
- SSE: fragmented UTF-8, CRLF/LF/CR, multiple data lines, keepalive comments,
  residual frame at EOF, empty frames, malformed JSON, and oversized input.
- WebSocket: response.create shape; same-connection continuation; unexpected binary
  messages; terminal and nonterminal closure; no stream/background confusion.
- `state.rs`: confirm parent/delta behavior for WebSocket and full native replay
  for SSE. Test context bounds and terminal-received/local-settlement failures.
- Check incomplete-result policy; no partial history should be treated as an
  accepted continuation or an executable tool request.
- Unknown program/search/custom/hosted executable items may be preserved but must
  not enter the ordinary execution/continuation path as supported features.

## Tools and evidence quality

- `tools.rs`: preflight the entire call batch before new execution. Validate tool
  name, complete outcome, origin, namespace, arguments, and unique call IDs.
- Test duplicate IDs with equal/different arguments, unrequested results, omitted
  results, partial JSON, overflow, unknown fields, and tool-output limits.
- Ensure cached results are scoped to the owning session/demo and never described
  as crash-safe exactly-once execution.
- Check failure semantics if a tool returns an error and delivery later fails.
- **Concrete assertion gap to investigate:** `main.rs::tool_demo` requests 17+25
  and checks for a call/final response, but does not itself assert the intended
  argument pair, result 42, or semantic final answer. A CLI exit code or the model
  saying 42 alone cannot prove the required tool round trip. Add focused evidence
  assertions in a helper/test rather than declare PASS from plausibility.
- Live same-socket and SSE-replay claims require structural evidence, not a model
  remembering a word alone. Record whether fields under test were actually emitted.

## Scope and report

- Advanced capabilities remain unsupported before auth/network when required.
  Do not let preserved shapes become an implicit permission to execute them.
- Code, README, EVENTS, ARCHITECTURE, example, CLI help, and capability status agree.
- Report compiler/tests/live checks separately, with dates and exact commands.
- If blocked, identify auth/entitlement/network/protocol/code/budget separately.
  Preserve historical reports and create new sanitized local reports.
