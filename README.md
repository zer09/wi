# Harness Gateway 0.2.0

A small, headless Rust gateway with compiled-in provider plugins. This milestone
adds persistent OpenAI/Codex WebSocket sessions, explicit SSE mode, typed output
items, and one ordinary function-tool round trip.

**Status: local offline repair; live compatibility remains unverified.**
The original delivery was uncompiled. Its [verification](docs/VERIFICATION.md)
is historical evidence, not the record of local repair. Normal tests use synthetic
credentials and loopback servers. Offline success does not prove account access.

## Scope

```
CLI / library caller
        |
     Gateway
        |
 Provider trait
        |
 OpenAiCodexProvider
        |
 ProviderSession = command handle + event stream
        |                          |
 WebSocket or SSE          normalized output items/events
        |
 Codex subscription backend
```

The deterministic `add_numbers` executor is a separate module. The provider
never executes files, commands, model-generated JavaScript, or unknown tools.
There is no web server, GUI, database, production agent loop, or sandbox here.

## What is implemented in source

- `Provider` and `SessionControl` Rust traits with an independent example provider.
- Read-only use of the user's existing Codex/Pi OAuth credential file.
- WebSocket as the default, with `--transport sse` as an explicit alternative.
- A single outstanding response per session; concurrent generation returns `Busy`.
- WebSocket continuation with `previous_response_id` and only new input items.
- Full native output replay on SSE, including opaque reasoning state.
- Typed response/item events; IDs for local session, request, event, response,
  output item, and tool call remain distinct.
- Completed, incomplete, failed, cancelled, and uncertain transport outcomes.
- A bounded local function executor, local argument validation, and in-memory
  result reuse. The included tool adds integers and has no external side effects.
- No automatic retry, reconnect, transport fallback, or API-key billing fallback.

**Native steering, async tool calling, programmatic tool execution, tool search,
and hosted skills are NOT implemented or verified.** Their required capability
flags fail before authentication or network access. Their output-item shapes can
be preserved without executing them. There is no local skill loader yet either.

## Build and test first

Use a current stable Rust installation with `cargo`, Rustfmt, and Clippy.

```bash
cargo fmt --all -- --check
cargo check --all-targets
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo build --all-targets
cargo test --doc
```

Or run the supplied local gate (Python 3.11+):

```bash
uv run scripts/verify.py
```

The tests use synthetic credentials and local loopback HTTP/WebSocket servers.
They do not read your auth files or consume your subscription. Cargo dependency
downloads still need network access. GitHub Actions runs the same Rust checks on
Linux, macOS, and Windows after this project is put in a repository; that workflow
has not been executed as part of this delivery.

`Cargo.lock` is retained after local dependency resolution. The direct HTTP and
WebSocket crate versions remain pinned. Use the lockfile for reproducible
resolution; no dependency versions or features were changed for this repair.

## Reuse your own subscription login

Keep credentials on your computer. **Never upload `auth.json`, a token, or raw
provider-output logs to a chat, issue, or repository.**

```bash
# Local structure/expiry check only; not a live account check:
cargo run -- auth-check --auth-source codex
cargo run -- auth-check --auth-source pi

# Nonstandard path:
cargo run -- auth-check --auth-source codex --auth-file /absolute/path/to/auth.json
```

Default files:

- Codex: `$CODEX_HOME/auth.json`, otherwise `~/.codex/auth.json`.
- Pi: `~/.pi/agent/auth.json`, selecting only the `openai-codex` OAuth entry.

Codex may store credentials in the OS keyring rather than a readable file. This
reader does not access the keyring or modify your credential-storage settings.
Use file-backed credentials only deliberately, or retain the existing client as
your auth/runtime owner. API-key auth files are rejected, not silently reused.

The file must be a regular file. On Unix it must exclude group/other permissions;
the final path component is opened with `O_NOFOLLOW`. Protect its parent directory
as well. Windows ACLs are not validated by this milestone. Paths are supplied by
a trusted local caller; do not accept credential paths from remote HTTP users.

The gateway never logs, writes, copies to project storage, or refreshes credentials.
JWT decoding provides hints only; OpenAI authenticates the token cryptographically.

**WebSocket:** credentials and account are fixed at the handshake. Expired auth
requires refresh in Codex/Pi followed by an explicitly new gateway session.

**SSE:** the selected file is reread before each request; a changed account is
rejected to avoid sending the previous account's conversation to a new account.

## Sanitized live smoke helper

Only an authorized operator may run these commands after offline and security
review. Each invocation uses the real gateway/provider path. It has no retry,
fallback, alternate model, raw-event output, or automatic auth check.
`--auth-source pi`, `--transport`, `--case`, and `--model` are required.

```bash
# One generation. The deadline is external; timeout leaves upstream outcome unknown.
timeout 180s target/debug/gateway smoke --auth-source pi --transport websocket \
  --model gpt-6-astra --case text
# Each of these can submit two generations on one session.
timeout 180s target/debug/gateway smoke --auth-source pi --transport websocket \
  --model gpt-6-astra --case continuation
timeout 180s target/debug/gateway smoke --auth-source pi --transport websocket \
  --model gpt-6-astra --case tool
```

Select `--transport sse` explicitly for equivalent SSE cases. Count every attempt,
including ambiguous writes, against the handoff's 10-submission total budget (five
per transport for the complete matrix). Stop a failed sequence. These examples are not evidence that this model or account is supported.
No real credentials or live calls were used to implement the helper.

The single JSON summary contains only static categories, counts, and booleans.
`submissions` records dispatch attempts, transport, socket reuse, request-body
comparisons, actual native-created counts, allowlisted terminal type/status, and
delta counts. `acceptance` records normalized-start counts, answer equality, and
strict tool/executor/result checks. `acceptance.request_failure` preserves an
allowlisted failure code, HTTP status for 401/403/429 only, and the original
`upstream_outcome`. Unknown codes become `unclassified`; messages and native
bodies are discarded. Read this field with the top-level `stage`. The top-level
`error_code` remains the local helper error and can be `provider_error` even when
the structured evidence identifies a more specific failure. Setup failures have
no request-failure record and use the safe top-level error code.

Zero text deltas means streaming text was not
observed; terminal-only output is not streaming evidence. Missing native-created
or required continuation proof makes the helper exit nonzero.

SSE `opaque_replay` is `matched`, `mismatched`, or `not_emitted`. The last value is
not a failure and does not prove opaque replay live. `null` means not applicable.
The disabled observer does not retain native observation state. The enabled
observer retains comparison material only in memory and never serializes it.
The summary contains no headers, credential/account/response/call IDs, native
payloads, model text, or raw error bodies. An external kill can prevent summary
output; conservatively count the case's maximum submissions in that situation.

## General CLI examples (not sanitized evidence)

Replace the placeholder with the exact model ID already enabled in your own
Codex/Pi installation. A catalog entry alone is not evidence of account access.
Running these commands consumes subscription allowance.

```bash
cargo run -- generate \
  --auth-source pi \
  --model "YOUR_ENABLED_CODEX_MODEL_ID" \
  --prompt "Reply with exactly: gateway connected"
```

Test one continuation on the same connection:

```bash
cargo run -- generate \
  --auth-source pi \
  --model "YOUR_ENABLED_CODEX_MODEL_ID" \
  --prompt "Remember the word lantern and acknowledge." \
  --follow-up "What word did I ask you to remember?"
```

Test the ordinary function round trip:

```bash
cargo run -- tool-demo \
  --auth-source pi \
  --model "YOUR_ENABLED_CODEX_MODEL_ID"
```

The model is asked to call `add_numbers(17, 25)`. The client validates the finalized
call, computes `42`, and returns a `function_call_output` under its original
`call_id`. The demo requires exactly one completed direct call, no namespace, and arguments
exactly equal to JSON `{"a":17,"b":25}`. It checks one result with the original
call ID and JSON `{"sum":42}`. It requires completed ordinary message output text
that trims to `42`, without refusal or extra answer text. There is no forced tool
choice, and a missing tool or additional tool cycle fails acceptance.

These examples explicitly select Pi. The general CLI default remains Codex;
select `--auth-source codex` only when the operator chooses that source.
Use SSE explicitly by adding `--transport sse`. A WebSocket failure never silently
switches to SSE, as that can change continuation and execution semantics.

Read private prompts from stdin rather than shell arguments:

```bash
cargo run -- generate --auth-source pi \
  --model "YOUR_ENABLED_CODEX_MODEL_ID" --stdin < prompt.txt
```

`--json` emits NDJSON. **This includes native provider items and opaque continuation
material and must be treated as sensitive application data.** Normal text mode
prints exposed text/refusal content, not reasoning summaries. Final response text
is authoritative and reconciled with streamed text.

```bash
cargo run -- capabilities
cargo run -- generate --help
```

The separate [two-turn library example](examples/two_turns.rs) shows direct use
without coupling the library to Clap or a web framework. That example explicitly
uses Codex credentials, not the handoff's selected Pi source. It prints response
text and IDs and is not a sanitized acceptance helper.

## Cancellation, failures, and limits

`SessionControl::close()` and Ctrl+C interrupt local transport and close the whole
session. They do **not** guarantee that provider computation stopped. There is no
in-place reconnect or response replay after an uncertain failure.

Dropping the event receiver also closes its session, even if it was never polled.
This provider receiver is a runtime-owned stream; a future browser connection
should observe the runtime's own event store, not own this receiver directly.

Terminal response output is not equivalent to the whole agent task completing.
Function calls are selected only from a finalized completed response. Truncated,
unknown, namespaced, or programmatically owned calls cannot execute in this demo.
Argument fragments are never parsed into executable commands during streaming.

Defaults are deliberately bounded: 15-second connection timeout, 90-second
provider-event idle timeout, 10-minute request lifetime, 30-second event-consumer
stall limit, 64 queued events, 8 MiB per incoming frame, 32 MiB per response,
8 MiB retained context, and at most eight registry tool calls per response.
The fixed CLI demo accepts exactly one call. Context
limits fail explicitly; there is no implicit compaction.

Both transports connect directly; HTTP/SOCKS proxy support is not included.
Redirects and automatic retries are disabled. Production endpoints are fixed
inside the subscription adapter; only unit-test builds can target loopback servers.

## Compatibility and boundaries

This is a compatibility integration with the Codex subscription backend, **not**
an API-key request to the public `/v1/responses` endpoint. OpenAI's public feature
schema is not a promise that every feature is available on this endpoint, for this
account, with a particular model. See [sources](docs/SOURCES.md).

In-memory transcripts and cached tool results are not a durable operation log and
do not guarantee exactly-once external effects after a crash. No billing estimate
is computed from API prices for subscription traffic.

See [architecture](docs/ARCHITECTURE.md), [events](docs/EVENTS.md), and
[migration notes](CHANGELOG.md) for the deliberate 0.1 → 0.2 contract change.
