# Wi 0.2.0

A small, headless Rust gateway with compiled-in provider plugins. This milestone
adds persistent OpenAI/Codex WebSocket sessions, explicit SSE mode, typed output
items, and one ordinary function-tool round trip.

**Status: Wi managed-auth login, explicit renewal and all six generation cases passed on local Linux.**
Wi persisted its own eligible profile and confirmed it through fresh metadata status
both after login and after renewal. Automatic expiry-triggered renewal has offline evidence.
W1-W3 WebSocket text, continuation and add_numbers passed with managed auth and
gpt-6-astra. S1-S3 SSE text, continuation and add_numbers also passed.
Live opaque replay remains untested; stable provider support is unconfirmed.
See the [combined implementation report](docs/COMBINED_DESIGN_REPORT.md) for
commit boundaries and verification evidence. See [managed authentication](docs/WI_AUTH.md)
for implemented mechanics and limits.
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
resolution. Managed auth directly uses the already locked `ring` and `rustix`
crates for secure randomness and safe Linux filesystem operations.

## Experimental Wi browser login

On Linux or WSL's private Linux filesystem, explicitly opt in:

```bash
./target/debug/wi auth login --provider openai-codex --account personal --experimental
```

This writes only Wi's separate secure store. An existing alias requires `--replace`.
Without `--experimental`, login fails before path access or network activity.
Linux `/usr/bin/xdg-open` must open a browser and exit successfully within 10 seconds.
On WSL, configure that launcher beforehand; Wi does not use `cmd.exe` or another fallback.
Port 1455 must be free. Wi never cancels an existing listener.
The command prints static progress and local alias/expiry/persistence metadata, not
an authorization URL or tokens. Do not enable HTTP tracing or process-argument logging.
The browser and local launcher necessarily receive the authorization URL.

The shared public-client configuration follows Pi's browser flow, with honest `wi`
identification. This does not establish OpenAI approval, stable support, or entitlement.
No retries, device flow, manual-code fallback, or API-key exchange are implemented.
`wi auth refresh --provider openai-codex --account personal` renews the selected
Wi-owned profile and prints safe current metadata. `--auth-source gateway` enables
automatic preparation near expiry before a new session or same-profile SSE request.
Established WebSockets never renew mid-session. The token exchange uses fixed TLS,
no proxy/redirect/retry, 10-second connect/read limits, a 30-second exchange limit,
and a 65536-byte response limit. Renewal evidence is OFFLINE-only; live renewal is
NOT RUN. TODO: separately authorize L1 renewal and the later managed-auth matrix.
See [Wi auth](docs/WI_AUTH.md) for bounds, trust assumptions, and persistence behavior.

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

The external-source reader never logs, writes, copies, or refreshes credentials.
Wi-owned profiles use a separate protected file store; see [Wi auth](docs/WI_AUTH.md).
JWT decoding provides hints only; OpenAI authenticates the token cryptographically.

**WebSocket:** credentials and account are fixed at the handshake. Expired auth
requires refresh in Codex/Pi followed by an explicitly new gateway session.

**SSE:** the selected file is reread before each request; a changed account is
rejected to avoid sending the previous account's conversation to a new account.

## Sanitized live smoke helper

Only an authorized operator may run these commands after offline and security
review. Each invocation uses the real gateway/provider path. It has no retry,
fallback, alternate model, raw-event output, or automatic auth check.
`--auth-source pi|codex|gateway`, `--transport`, `--case`, and `--model` are required.
There is no default auth source or fallback. The smoke helper rejects models other
than exact `gpt-6-astra` before credential access.

```bash
# One generation. The deadline is external; timeout leaves upstream outcome unknown.
timeout 180s target/debug/wi smoke --auth-source pi --transport websocket \
  --model gpt-6-astra --case text
# Each of these can submit two generations on one session.
timeout 180s target/debug/wi smoke --auth-source pi --transport websocket \
  --model gpt-6-astra --case continuation
timeout 180s target/debug/wi smoke --auth-source pi --transport websocket \
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

Effective output may come from a validated complete done batch when the successful
native terminal array is explicitly empty. See [EVENTS.md](docs/EVENTS.md) for the
bounded recovery policy. Native JSON remains unchanged.

The additive observer fields do not change smoke schema version 1 or acceptance:
- `native_terminal_items` counts native terminal items; `effective_items` separately
  counts effective items. `output_provenance` identifies their source.
- `effective_text_state`, `effective_expected_text_equal`,
  `normalized_effective_text_equal`, and `streamed_effective_text_equal` compare
  effective output separately, using the same private 1 MiB text bound.
  Recovery leaves native counts at zero and native text comparisons unavailable.
- `native_expected_text_equal` compares terminal native ordinary text, trimmed,
  with the fixed answer for that case/request. The first tool response has no
  expected answer (`null`).
- `normalized_native_text_equal` compares both normalized ordinary output and
  `response.text` with `response.native.output`, without trimming.
- `streamed_native_text_equal` compares text deltas assembled in observed order
  with terminal ordinary text, without trimming. Its private aggregate is capped
  at 1 MiB and resets at each request.

Only message `output_text` parts count as ordinary text. Refusals, unsupported or
malformed parts, diagnostic overflow, and missing terminal text yield `null`, not
success. No deltas also yields `null` for streamed equality. Diagnostics are
captured before acceptance can fail. Exact trimmed answer acceptance, required
lifecycle proof, and tool assertions remain unchanged.

`terminal_text_state` distinguishes `available`, `no_ordinary_parts`,
`missing_or_invalid_output`, `malformed_content`, `unsupported_kind_or_part`,
`over_limit`, and `no_terminal`. `streamed_text_state` distinguishes `available`,
`no_deltas`, `malformed_content`, and `over_limit`. Each equality has a corresponding
`*_unavailable` reason: null when compared, otherwise one of these static states,
`not_validated`, or `not_applicable`. First-turn tool expected text is not applicable.
Terminal shape is captured before decoding; validation is recorded only after parsing.
`finalized_items` counts total, message, function_call, reasoning, other, and malformed
done events, including duplicates. Counters saturate at 4096 per request;
`finalized_items.overflow` indicates additional done events. No native item is retained
for counting. Existing lifecycle/delta counters also saturate at 4096.

`submissions[].http.status` is the authoritative exact numeric HTTP status when
an SSE response arrives, including rejected success statuses and generic errors.
The legacy failure status remains limited to inferred 401/403/429 categories.
`http.media` is `missing`, `invalid`, `event_stream`, `json`, `html`, `plain_text`,
or `other`. No header value or parameter is exposed.

Ordinary HTTP/MIME rejections with an enabled observer receive a body-prefix sample:
at most 4096 bytes, with a one-second timeout within existing cancellation and
total limits. `sample_state` is `not_sampled`, `unavailable`, `complete`,
`read_error`, `timeout`, or `truncated`. `unavailable` preserves the initial HTTP
receipt if sampling does not finish, for example after cancellation.
Reaching the cap reports `truncated` conservatively, even if the body is exactly
4096 bytes. `body_class` is `empty`,
`json_like`, `html_like`, `text_or_other`, `binary_or_non_utf8`, or `null` when
unavailable. A nonempty prefix remains classifiable after timeout or read error.
A zero-byte timeout/read error stays null; only zero-byte EOF can classify empty.
Classes are prefix heuristics, not failure causes. Labeled accepted SSE is
`not_sampled`; a disabled observer collects no diagnostics. Sampling never replaces
the original rejection category. There are no redirects, retries, or fallback.

Within this fixed subscription adapter only, a successful 2xx response with an
entirely absent Content-Type can enter strict SSE prolog admission. Present wrong,
empty, or invalid MIME values and non-2xx statuses retain their rejection behavior.
Admission requires the first blank-line-dispatched data frame to qualify within
65536 raw bytes from byte zero and one absolute 10-second deadline. Comments and
blank frames without data may precede it. EOF without that delimiter rejects.
The first data frame is decisive: empty/whitespace data, `[DONE]`, invalid JSON,
and unknown event types reject without searching for a later valid frame.

The prolog accepts an initial BOM, incremental UTF-8, LF/CR/CRLF, comments, and
standard data/event/id/retry fields. Unknown lines, invalid UTF-8, and control
characters other than tab reject. The last event label wins, including an empty
reset; a nonempty label must equal the JSON type exactly. IDs do not enable
resumption; retry fields must each contain nonempty ASCII digits and never enable
retries. The JSON response ID must be a nonempty string of at most 512 UTF-8 bytes.
Only `response.created` or terminal `response.completed`, `response.done`,
`response.incomplete`, `response.failed`, and `response.cancelled` may qualify.
A fresh trial response decoder must produce the corresponding recognized lifecycle
event. Trial events never reach observation, settlement, or caller state.

All fetched chunks, including the uninspected suffix of the proof chunk, replay
once in order into a fresh ordinary SSE decoder. Admission stops at proof, not EOF.
The existing 32 MiB response and 8 MiB later-frame limits still apply. Fetched bytes
are checked against 32 MiB before retention or conversion to the existing byte-stream
Vec; replay contributes once to normal receive accounting. Cancellation and total
request limits still enclose admission. Admission failure is `unexpected_content_type`
with unknown upstream outcome, except for existing outer cancellation/size/timeout
categories. There is no second rejection sample after consuming a candidate.

The original `http.media` remains `missing`. Admission adds `sample_state` values
`sse_prolog_pending`, `sse_prolog_admitted`, `sse_prolog_rejected`,
`sse_prolog_timeout`, `sse_prolog_read_error`, and `sse_prolog_truncated`.
These describe **64 KiB / 10-second admission**, not 4 KiB / one-second rejection
sampling. The pending HTTP receipt survives cancellation. Only the first at most
4096 privately inspected bytes contribute to `body_class`; no raw data or IDs leave
this diagnostic. Observer enablement does not change admission behavior.

Compatibility corroboration: the pinned [Pi v0.85.1 adapter source](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/api/openai-codex-responses.ts)
parses the response body without a MIME gate. That reference is not live proof for
this gateway; this adapter deliberately requires the stricter bounded proof above.

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

## Fixed CLI retest runner

`scripts/cli_retest.mjs` runs the built `target/debug/wi` directly. It never
runs Cargo, Pi, or the Codex executable. Help and synthetic self-tests do not
start the gateway or read credentials:

```bash
node scripts/cli_retest.mjs --help
node scripts/cli_retest.mjs --self-test
```

After separate source review and live authorization, the parent may run each
fixed case once. Each invocation reserves at most two submissions:

```bash
node scripts/cli_retest.mjs --run-live --case continuation
node scripts/cli_retest.mjs --run-live --case tool
```

Both commands explicitly select Codex auth, `gpt-6-astra`, WebSocket, and CLI JSON.
Continuation uses exactly `Remember the word lantern and acknowledge.` followed
by `What word did I ask you to remember?`. The tool case runs `tool-demo` with its
existing validators. There are no arbitrary arguments, prompts, models, auth
paths, retries, or default live action. The subprocess has ignored stdin and piped
stdout/stderr. At 180 seconds, the runner sends SIGTERM, then SIGKILL after one
second, and bounds pipe cleanup by another second. Interruption does not prove
upstream cancellation. Do not pipe raw CLI output into reports.

The runner emits one sanitized JSON object. `requests` contains per-request
normalized lifecycle/delta counts, separate `done_items`, `effective_items`, and
`native_terminal_items` counts, static `output_provenance`, allowlisted terminal
status and `effective_text_state`, lantern-presence and final-42 booleans, and effective function-call
semantics. Old payloads default to `native_terminal`. The runner does not implement
recovery; it validates effective output and requires a clean CLI exit. `executor.correlated` requires actual
linked start/finish events for the complete direct namespaceless add_numbers call
with a=17 and b=25. Text `42` alone cannot pass the tool case.

The CLI does not serialize tool-result input or transport dispatch evidence.
Thus `executor.result42_observed` and `accounting.observed_transport_submissions`
are always null. `result42_validated_by_cli_inferred` records that correlated
executor events and a second request crossed the reviewed CLI result validator;
it is not observed wire linkage. Distinct private request IDs establish only
`observed_request_ids`. `conservative_upper_bound` is two unless a complete
first-response guard/no-tool failure supports the explicitly labelled
`inferred_first_response_stop` bound of one. Missing, invalid, truncated, killed,
or otherwise incomplete evidence always reserves two. No events never means
no send. These fields cannot prove socket reuse or the encoded continuation body.

`assertions_passed` requires exit zero, two completed lifecycles, and the case's
text/tool assertions. The runner exits nonzero otherwise. `reason` contains only
static parser/process categories. `public_error` matches exact known CLI errors;
all other stderr becomes `unclassified`. Raw lines are bounded to 8 MiB, total
stdout to 64 MiB, stderr to 64 KiB, ordinary text comparisons to 1 MiB, and retained
request summaries to two. Limits fail closed and terminate the child. Native
items, IDs, arguments, text, headers, stderr, and exception details are never
written or echoed. All fixtures and subprocesses in self-tests are synthetic.
These instructions are not live verification or permission to exceed the budget.

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
is authoritative. Both modes treat streamed output as provisional. If a completed
effective output omits or conflicts with streamed nonempty text/refusal or finalized
message/function-call output, the CLI exits nonzero with a static error before tool
execution or follow-up. Recovery belongs to the provider decoder, not the CLI.
Terminal-only responses and matching text prefixes with terminal suffixes remain valid.
The guard compares streamed parts by item identity and content index, not their
combined arrival order. Valid interleaving remains valid; text mode prints a labelled
terminal response when arrival order is not a prefix of terminal text.
The per-request guard charges every item event's serialized bytes, including duplicates,
and the separate rendered-text copy against a cumulative 1 MiB. It permits at most 4096 events, 512 finalized occurrences, and item/content
indexes below 512. Private retained text copies are each bounded by 1 MiB; finalized
native items share the cumulative byte budget. All tracking resets at each collect.
Conflicting identities or finalized native content fail closed, even if only metadata differs.

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
