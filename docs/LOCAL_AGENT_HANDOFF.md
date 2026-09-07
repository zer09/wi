# Full context and local implementation-verification plan

Prepared September 8, 2026. Audience: the user's local OpenAI-Codex/Astra agent
running in Pi. This document is self-contained; you do not need the old chat.

## 1. Why you are receiving this

The user brainstormed a Rust agent backend and expected a detailed plan to be
implemented locally. ChatGPT instead generated v0.1.0 and then v0.2.0 source ZIPs.
The user accepted keeping that work but found the documentation delivery unclear.
This handoff consolidates the latest complete source and all documents, and gives
you authority to inspect, repair, and test it within the limits below.

You are the developer/reviewer. The previous assistant is not a source of runtime
truth. Start from the code, verified local tools, current primary documentation,
and observed test results. Do not assume the code compiles or the advertised
subscription endpoint accepts its requests.

## 2. Product direction versus today's task

Long-term direction:

```text
Future web UI (Rust/Wasm or TypeScript; undecided)
    -> thin Rust web/API adapter
    -> Rust agent runtime / harness
         -> provider-neutral model gateway
              -> OpenAI-Codex first; other plugins later
         -> permission-controlled tool execution
         -> sessions, context, and durable run state
```

The backend is more than a reverse proxy. Eventually it owns model/tool loops,
steering, context, approvals, and persistence. None of those future components is
required to validate today's gateway.

Current acceptance target:

```text
CLI or library caller -> Gateway -> Provider -> ProviderSession
    commands in / events out -> OpenAI-Codex WebSocket or explicit SSE
```

Prove one text response, two linked responses, and one ordinary function-tool
round trip. Native Rust owns provider communication. A browser, web server, and
another provider are intentionally absent. Traits are the plugin interface;
plugins are compiled in, not dynamically loaded binaries.

Pi is the tool you use to work on this repository. Its installation, model
selection, and authentication are not the gateway implementation. Do not replace
our adapter with `pi -p`, `codex exec`, app-server, or an SDK worker to obtain a
passing smoke test. A transport problem should be diagnosed and reported as such.

## 3. What is already in the source

| Path | Intended ownership |
|---|---|
| `src/provider.rs` | Provider and SessionControl traits, requests, events, item types, capabilities. |
| `src/gateway.rs` | Provider registration/routing without OpenAI imports. |
| `src/providers/openai_codex/auth.rs` | Read-only Pi/Codex OAuth file sources and secret-safe error handling. |
| `src/providers/openai_codex/wire.rs` | HTTP/WebSocket, TLS, headers, bounds, timeouts. |
| `src/providers/openai_codex/codec.rs` | Native response-event decoding and output-item normalization. |
| `src/providers/openai_codex/state.rs` | In-memory history, parent response ID, pending tool-result identities. |
| `src/providers/openai_codex/session.rs` | Worker, independent commands/events, single active request, cancellation. |
| `src/tools.rs` | Separate tool registry and pure integer-addition executor. |
| `src/main.rs` | Temporary CLI and bounded demonstration driver. |
| `tests/`, provider tests, fixtures | Synthetic tests and loopback protocol scenarios. |
| `examples/two_turns.rs` | Library usage independent of the CLI. |

The crate is named `harness-gateway` and its binary is `gateway`. It uses Rust
edition 2024 and a stable rust-toolchain file. Cargo.lock was not generated.

The provider session has a control handle and an independent event stream. One
response is active at a time. Local admission is not a provider acknowledgement
and not a durable operation. Native steering currently fails with an explicit
unsupported-feature error.

WebSocket is preferred; SSE must be selected explicitly. The intended WebSocket
continuation uses the same connection, `previous_response_id`, and new input only.
SSE is intended to replay retained native context with `store: false`. There is
no automatic reconnect, retry, transport fallback, or API-key fallback.

The original delivery counted 17 Rust files (including tests/examples), 56 test
definitions, and 25 JSONL fixture events. Those are inventory counts only; some
tests are platform-specific. Report the actual compiled/executed/skipped counts.

## 4. Evidence status before local work

Every original v0.2.0 file is present and byte-identical in this handoff.
`docs/PACKAGING_AUDIT.md` records the archive check. The Python static-only gate
passed its inventory/TOML/fixture checks during repackaging. That gate does not
parse Rust types, compile anything, prove security, or contact a provider.

The earlier source-delivery report says compilation, rustfmt, Clippy, dependency
resolution, Rust tests, CI execution, and live requests were not performed.
Do not convert those into PASS retroactively. Maintain new local evidence in
`docs/LOCAL_VERIFICATION.md` and `docs/local-verification.json`.

## 5. Decisions to preserve

### Authentication

This is personal/local subscription-backed development. Prefer the user's existing
Pi `openai-codex` OAuth entry. The current CLI defaults to Codex, so explicitly
pass `--auth-source pi` in this handoff. A custom path is allowed only when the
user selects it or identifies their known Pi configuration path. Do not crawl
home directories or enumerate other credentials.

Codex can use `$CODEX_HOME/auth.json` or the OS credential store. Pi's original
file reader defaults to `~/.pi/agent/auth.json`. Different/new local configurations
may differ; verify through safe metadata. The app may read the selected file in
memory after audit. You must not load the real contents into the model context.

The gateway does not own refresh. Concurrent use by Pi is expected. Never rewrite
or rotate its tokens. Never copy a refresh token into this repository. If fresh
credentials cannot be safely read, record a live blocker and leave local offline
work intact. Do not silently force file storage, switch accounts, or use API keys.

### Event ownership

OpenAI-native events -> adapter-normalized ProviderEvents -> future HarnessEvents.
A provider response completing is not a whole agent run completing. Tool argument
fragments are generated content, not execution progress. Output item IDs, tool
call IDs, response IDs, local request IDs, and local event sequence are distinct.

The implemented event contract is in `docs/EVENTS.md`. Preserve it where sensible;
if a correctness repair requires an API change, explain it and update source,
tests, examples, and docs consistently. Do not add fake `agent_start`/`turn_start`
events when no corresponding runtime exists.

Keep readable text separate from provider continuation material. Encrypted
reasoning, signatures, program fingerprints, caller links, and unknown native
fields are potentially sensitive state, not ordinary logs or executable content.

### Execution and capabilities

The provider must not execute tools. The only initial tool is `add_numbers`,
which must have no file/process/network side effects. Execute only a complete,
authorized, ordinary direct function call after the response outcome allows it.
Validate locally even if a strict schema was requested.

Treat generated arguments and results as untrusted data. Unsupported/unknown
executable output must not be run. Result caching is session-scoped/in-memory;
it is not durable exactly-once execution. Do not add transparent resubmission
when a network failure leaves the upstream outcome uncertain.

### Future features — preserve room, not implementation scope

We discussed local/OpenAI skills, tool search, programmatic tool calling, async
tools, and native steering. The current code intentionally disables them. Leave
them disabled. Recognition of their item shapes is not execution support or
proof of subscription entitlement. Full harness run/turn events, approvals,
sandboxed shell tools, persistence, and the web UI are also later milestones.

Earlier conversation claims about model names, beta features, SDK deprecations,
and endpoint support are background hypotheses, not acceptance criteria. Verify
only the current facts needed by this milestone from primary sources.

## 6. Phase A — orient, preserve, and review before execution

1. Confirm the project root. Inspect git status if applicable; preserve all user
   work. Do not reset/clean, auto-commit, push, or publish.
2. Read this handoff, AGENTS.md, existing docs, Cargo.toml, toolchain config,
   CI workflow, scripts, source, fixtures, tests, and example.
3. Inspect build scripts/dependencies before building. Do not run unreviewed
   installer scripts or commands requesting real credentials.
4. Record a short plan and initial findings. Then proceed with repairs; do not
   stop merely after producing a plan.
5. Record OS/architecture and actual versions of rustc/cargo/Pi where available.
   Safe version commands are sufficient; do not dump configuration or environment.
6. Confirm each README capability against actual code. Use
   `docs/REVIEW_CHECKLIST.md` for targeted checks. Distinguish confirmed defects
   from review questions.

You may repair code/tests/docs and add a narrowly scoped offline or live test
helper if needed for acceptance. Do not rewrite the entire crate or expand its
feature set to solve a bounded bug.

## 7. Phase B — build, offline tests, and regressions

Use the user's installed toolchain. If missing, explain the precise requirement
and follow local installation permissions. A missing toolchain is not permission
to claim a successful build or install unrelated tooling.

Record the first failure before fixing it. Run the following, adjusting only for
actual local commands and reporting any change:

```bash
cargo fmt --all -- --check
cargo check --all-targets
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo build --all-targets
cargo test --doc
```

If formatting fails, format with `cargo fmt --all`, inspect the diff, and rerun the
check. Resolve compilation and test failures with minimal patches and regressions.
Do not disable validation, delete tests, or blanket-allow warnings to get green.
If a lint allow is genuinely necessary, make it specific and document the reason.

Dependency resolution may generate Cargo.lock; retain it. Pin reproducible
choices and report dependency changes rather than silently upgrading everything.
After the formatted baseline is valid, make CI check formatting rather than
mutate it. Verify that `scripts/verify.py` reports the checks it really performs.

Offline tests must use synthetic credentials and loopback servers. Check that
normal cargo tests do not contact OpenAI or read ambient credentials. Do not run
provider live tests in CI or include secrets in workflow configuration.

Rerun the suite after fixes and after any changes motivated by live failures.
Record actual totals, ignored/filtered/platform-skipped cases, and commands.
Testing one local OS does not validate the other operating systems in the matrix.

## 8. Phase C — safe live-test preparation

Proceed only after build and offline/security gates pass.

- Use the existing Pi OAuth source read-only. Codex OAuth is an alternative only
  on explicit user selection, not an automatic fallback.
- Resolve the exact model ID from the agent's safe runtime metadata, the user's
  existing model selection, or a narrow non-secret setting. Never assume the
  display label “Astra” is an endpoint model ID. If unresolved, ask only for the
  model ID; keep working offline while blocked.
- Inspect CLI `--help` so commands reflect the actual repaired code.
- Check credential shape/expiry using the reviewed `auth-check` command. It must
  emit metadata only. This is not an entitlement test.
- Keep real logs out of the conversation. Do not use shell tracing, curl verbose
  dumps, debug HTTP headers, or credential file readers. Do not turn on HTTP
  trace logging. No real auth material may enter fixtures/reports.
- Use only synthetic prompts and `add_numbers`. No repository source, personal
  files, shell tool, web search, hosted tools, or sensitive content in smoke tests.

Local `auth-check` example:

```bash
cargo run -- auth-check --auth-source pi
```

If a credential is missing/expired/unsupported, the user may refresh through the
originating client. Do not interrupt the user's running Pi login, modify file
permissions, change storage settings, or rotate tokens yourself. A keyring-only
credential store is a legitimate limitation of this milestone, not a reason to
extract secrets into a file.

## 9. Phase D — bounded live acceptance matrix

Authorization: the user requested local live verification. Maximum **10 total
provider-generation submissions** from the gateway under test, including failed
or outcome-uncertain attempts. The nominal matrix below uses 10 (5 per transport)
only if each first attempt works. The cap does not include this Pi authoring
conversation, auth metadata checks, or Cargo downloads.

No automatic retries or hidden fallback. Track attempted submissions. If the
exact count is uncertain, count conservatively. A failed prerequisite stops that
sequence; investigate/fix offline before any further request. When remaining
budget is insufficient, mark remaining cases NOT RUN / budget exhausted. Request
additional user authorization before exceeding the cap. No polling/stress runs.

Use short prompts and bounded output. Run each CLI smoke invocation under a
reviewed 180-second local subprocess deadline (or a stricter user limit); the
current CLI has no timeout flag, so do not invent one. On timeout, stop the local
process and record upstream outcome as unknown, not cancelled. Do not use an
unsupported provider parameter just to add a token limit.

These POSIX-shell examples use `GATEWAY_TEST_MODEL` as a **non-secret** exact model
ID selected locally. On PowerShell, adapt environment syntax accordingly. Do not
literally send the placeholder. Each `--follow-up` or tool-demo invocation can
make two provider requests.

```bash
export GATEWAY_TEST_MODEL='EXACT_LOCAL_MODEL_ID'

# W1: one response — 1 submission
cargo run -- generate --auth-source pi --transport websocket \
  --model "$GATEWAY_TEST_MODEL" \
  --prompt 'Reply with exactly: gateway connected'

# W2: same-session continuation — 2 submissions
cargo run -- generate --auth-source pi --transport websocket \
  --model "$GATEWAY_TEST_MODEL" \
  --prompt 'Remember the word lantern. Reply only: remembered' \
  --follow-up 'What word did I ask you to remember? Reply only with that word.'

# W3: function generation -> local execution -> result -> model — 2 submissions
cargo run -- tool-demo --auth-source pi --transport websocket \
  --model "$GATEWAY_TEST_MODEL"
```

Run equivalent S1/S2/S3 invocations with `--transport sse` only after their
prerequisites pass and within the remaining budget. Do not silently call SSE
instead when WebSocket fails. Report each transport independently. If WebSocket
is blocked, source review may still justify independent explicit SSE testing,
but its success must not be reported as WebSocket success.

### Required assertions, not merely a plausible answer

| Case | Evidence required |
|---|---|
| W1/S1 | Actual accepted response lifecycle, observed text, correct authoritative terminal status, expected synthetic reply. Record whether streaming deltas were observed; terminal-only text is not proof of streaming. |
| W2 | Second request actually used the same socket and prior response ID with only new input; response retained the synthetic word. Prove transport behavior with a redacted local observer/test helper, not the model's claim. |
| S2 | Second HTTP request replayed appropriate native prior output/context, including opaque fields when actually present, and retained the synthetic word. Do not claim opaque reasoning was tested live if none was returned. |
| W3/S3 | Actual function call named add_numbers, arguments a=17 and b=25 (or an explicitly explained equivalent), local executor result sum=42, result submitted with that exact call_id, model continuation after delivery, no extra tool cycle. A final answer of 42 without a tool call is a FAIL for this case. |

If the CLI does not provide these assertions, add a focused opt-in test helper or
local observer. It must use the gateway's real provider path, not reimplement the
protocol or mock the live call. Capture only allowlisted structural evidence and
the known synthetic input/result. Raw `--json` output must not be pasted into Pi
because it includes native continuation material. Prefer streaming it directly
into a reviewed local sanitizer that emits a small evidence summary; any
unavoidable raw capture must be local, ignored, permission-restricted, and not
included in deliverables. Never capture request headers or credentials.

On 401/403/429, account/model denial, policy restrictions, proxy/TLS failure, or
protocol mismatch, report the sanitized status, stage, and known error category.
Do not bypass restrictions, downgrade TLS, spoof another client, switch billing,
try other accounts/models at random, or mask a rejection as success.

## 10. Phase E — repair, document, and report

For every defect repaired: record severity, path/symbol, observed symptom, root
cause, minimal fix, regression evidence, and remaining uncertainty. Document
justified behavior/API changes. Reconcile README, EVENTS, ARCHITECTURE, examples,
CLI help, CI, and capability-report wording with the actual implementation.

Keep `docs/VERIFICATION.md`, `docs/build-attempt.txt`, and the original
`docs/verification-status.json` as dated historical records. Add a pointer to new
results if useful without rewriting the old execution history.

Create:

- `docs/LOCAL_VERIFICATION.md` from its template: human-readable evidence.
- `docs/local-verification.json` from its template: machine-readable status.
- Focused code/test/doc changes and the generated Cargo.lock.

Do not regenerate the original baseline manifest to disguise changed source.
Describe the local diff; handoff hashes are expected to differ after repairs.
Do not publish, push, commit, or create a release unless separately requested.

Final user response: explain what actually worked, what was fixed, exact local
commands to repeat, actual test counts, per-transport live status, remaining
blockers, and whether the milestone is ready. Do not call an offline-only result
“live verified.” Share sanitized report content only.

## 11. Done criteria

The milestone is accepted only when the local build and relevant offline tests
pass; provider/gateway/tool ownership remains intact; selected auth is read-only
and secret-safe; and each claimed live behavior has observed evidence. A blocked
live path can produce a valuable partial result, explicitly labelled partial.

Completion does not authorize the next feature milestone. Native steering,
skills, tool search, PTC, async calls, durability, and the web UI remain future
work for a separate design/implementation decision.

## 12. Reference checks

Use current primary documentation and source only for provider/protocol facts.
Compare with the pinned baseline before adopting a change; note the version/date.
These are references, not a requirement to implement every documented feature.

- OpenAI Codex authentication: https://developers.openai.com/codex/auth
- Responses WebSocket framing/continuation: https://developers.openai.com/api/docs/guides/websocket-mode
- Function-call/result linking: https://developers.openai.com/api/docs/guides/function-calling
- Original Pi compatibility reference: https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/api/openai-codex-responses.ts
- Further pinned crate references: `docs/SOURCES.md` and Cargo.toml.

The first three official guides were re-opened during handoff preparation. They
support the auth-cache distinction, connection-scoped continuation, and call_id
result linkage; they do not prove our source or the Codex subscription endpoint
implements every public API feature. Check the exact local endpoint/model rather
than generalizing from the public `/v1/responses` guide.
