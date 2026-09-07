# Local verification report — 2026-09-07 UTC

## Verdict

**Partially verified. Offline gates pass; live acceptance does not pass.**

- Rust build, formatting, Clippy and offline tests: PASS.
- Final offline suite: **86 passed, 0 failed, 0 ignored, 0 filtered**.
- Security/source review: PASS for the bounded local test scope; all three final reviewers found no blocking issues.
- Pi auth metadata check: PASS. This is not an entitlement check.
- WebSocket W1: FAIL exact-reply acceptance, although native start, streaming deltas and a completed terminal response were observed.
- SSE S1: BLOCKED by missing or non-SSE response content type after an HTTP success status.
- W2/W3/S2/S3: NOT RUN because their transport prerequisites failed.
- Provider submissions: **2 / 10**, including the uncertain SSE attempt. **8 remain unused.**
- No advanced features or complete live tool round trip are claimed.

## Environment and baseline

Observed on Linux x86_64 under WSL2:

| Item | Value |
|---|---|
| rustc | 1.98.1 (48a229cea 2026-09-01) |
| cargo | 1.98.1 (797e8a9bc 2026-08-05) |
| Installed Pi package | 0.85.1, from package metadata |
| Timeout runner | GNU coreutils timeout 9.11 |
| Requested provider/model | openai-codex / gpt-6-astra |
| Model source | Safe Pi runtime provider/model metadata, not inferred from the display label |
| Selected credentials | Pi OAuth, explicitly `--auth-source pi` |
| Baseline | Supplied 0.2.0 handoff; initial Git branch had no commits and all project files were untracked |

The model identifier is the requested identifier. The observer does not expose a
returned model name. No broad account entitlement or alternate-model capability
check was performed.

The user later authorized staging the existing files as a comparison checkpoint.
**56 project files were staged once**, excluding `.codegraph/` and build artifacts.
That checkpoint includes the first partial implementation, not the original
unmodified source. All subsequent implementation, remediation and report edits
remain unstaged; `src/smoke_tests.rs` remains untracked. No commit or push occurred.
Use `git diff` to compare later work against the staged checkpoint.

A final `sha256sum --check MANIFEST.sha256` found 20 expected changed baseline
files. The original manifest was not rewritten. Cargo.toml, fixtures and historical
`docs/VERIFICATION.md`, `docs/build-attempt.txt`, and
`docs/verification-status.json` still match their original hashes.

## Findings and repairs

| ID | Severity | File / symbol | Observed symptom and cause | Focused repair | Regression evidence |
|---|---|---|---|---|---|
| F1 | Medium | src/main.rs:226; src/demo.rs:11-95 | Baseline tool-demo accepted any nonempty result batch and plausible final response | Require one completed direct namespace-free add_numbers call with a=17, b=25; one sum=42 result with the original call_id; final ordinary text exactly 42 | Four demo tests reject wrong arguments, authority, result, linkage, refusal and extra output |
| F2 | Medium | src/providers/openai_codex/wire.rs:132-200; session.rs:317-365 | Unknown was set before local auth/request preparation, misclassifying known no-send failures | Keep NotSubmitted through preflight; set Unknown immediately before network-capable polling; only validated terminal output becomes TerminalReceived | WS expiry, SSE reload/account change, pre/post-dispatch cancellation, HTTP rejection, disconnect and terminal validation tests |
| F3 | Acceptance gap | src/smoke.rs:124-243; observation.rs:84-247 | Baseline CLI could not prove live socket/request structure and native lifecycle | Add opt-in fixed-case smoke path with allowlisted body/socket/lifecycle evidence, conditional opaque replay and strict acceptance | Loopback observer tests check actual encoded bodies, same socket, replay/linkage, native versus synthesized start, schema and redaction |
| F4 | Medium diagnostics | src/smoke.rs:53-115; src/error.rs:110 | First helper discarded admitted error category and upstream outcome | Preserve allowlisted categories, known 401/403/429 status and outcome; unknown strings become unclassified | Two smoke failure-summary tests and admitted HTTP/cancellation regressions |
| F5 | High execution boundary | src/tools.rs:92-98 | Codec dropped non-string namespace from normalized fields; generic executor could execute that call | Reject every non-null native namespace during full-batch preflight, before events/execution/cache | Real codec-to-registry object/numeric cases and manually assembled batch tests; zero execution/cache on rejection |
| F6 | Medium continuation boundary | src/providers/openai_codex/state.rs:94-147 | A completed response could contain an incomplete function call whose ID became pending | Preserve terminal output but block ordinary continuation; do not admit incomplete call IDs | State tests for both transports/mixed batches; loopback proves no second send; complete/omitted-status controls pass |
| F7 | Low tooling | .github/workflows/ci.yml:17-23; scripts/verify.py:53-64 | Baseline CI/script modified formatting and omitted strict checks | Check formatting without mutation; add check-all, warning-denied Clippy and doctests; format inherited source | All six gates pass, including the final parent rerun |

F5/F6 were found during review, independently verified, and repaired by focused
remediation. Four newly added regressions failed before the fixes: malformed
namespace execution, assembled namespace execution, incomplete state continuation,
and incomplete loopback continuation. They all pass after repair.

No public provider-event schema, auth default, endpoint, dependency declaration,
or generic tool arithmetic changed. The generic registry now checks contradictory
native namespace presence in addition to normalized authority. Omitted call status
still means complete, with explicit regression coverage. No speculative usage
schema relaxation was applied.

## Local checks

### Initial and intermediate evidence

- Baseline `cargo test --all-targets` produced 56 passing test summaries: 52 library and four integration tests.
- Baseline warning-denied Clippy failed on `collapsible_if` and other diagnostics. Source was formatted and lint findings were corrected without blanket warning suppression.
- The initial formatting/check commands were issued, but their exact initial exit codes were not recovered. Later success is not substituted for those missing records.
- First partial implementation: 74 tests passed; compilation and Clippy passed.
- Completed implementation retry: 81 tests passed; all six gates passed.
- Remediation red run, `cargo test --lib`: 72 passed and four failed. The added positive control already passed.
- Final suite: 86 unique tests. Repeated gate runs are not added together as separate test coverage.

### Final observed gates

Implementation and final reviewers ran the commands independently. The parent
also ran the reviewed `uv run scripts/verify.py` after the live failures; it ran
all six Cargo commands below and finished successfully without provider requests.

| Command | Exit | Result | Executed / ignored / filtered |
|---|---:|---|---|
| cargo fmt --all -- --check | 0 | PASS | N/A |
| cargo check --all-targets | 0 | PASS | N/A |
| cargo test --all-targets | 0 | PASS | 86 passed / 0 ignored / 0 filtered; 0 failed |
| cargo clippy --all-targets -- -D warnings | 0 | PASS | N/A |
| cargo build --all-targets | 0 | PASS | Library, CLI, tests and example built |
| cargo test --doc | 0 | PASS | 0 doctests, not substantive doctest coverage |
| uv run scripts/verify.py | 0 | PASS | All six gates; inventory 24 Rust files, 86 definitions, 25 fixture events |
| target/debug/gateway --help | 0 | PASS | CLI inspection only |
| target/debug/gateway smoke --help | 0 | PASS | Required Pi source/model/transport/case confirmed |
| target/debug/gateway auth-check --help | 0 | PASS | General default remains Codex; Pi was passed explicitly |
| target/debug/gateway capabilities | 0 | PASS command execution | Static implementation claims, not account capability evidence |
| git diff --check | 0 | PASS | No whitespace errors |
| sha256sum --check MANIFEST.sha256 | 1 | Expected baseline differences | 20 changed baseline files; historical evidence unchanged |

Final breakdown: **76 library + 6 binary + 4 integration tests**. Example target
and doctests each ran zero tests. All 86 inventoried test definitions ran on Linux;
no platform-excluded definition was observed on this host. Windows/macOS runtime
behavior and hosted CI are NOT RUN.

Cargo.lock was generated and retained. Cargo.toml is unchanged, including the
reqwest 0.13.4 and tokio-tungstenite 0.28.0 pins. No dependency upgrade was used to
bypass a test failure. Dependency resolution/build traffic is not provider usage.

## Security review before live requests

Source and synthetic tests established these local gate properties:

- Only the explicitly selected credential file is read. No API key, account fallback, refresh, token rotation or auth-setting change exists in the exercised path.
- Auth reads are bounded, use regular-file and Unix permission checks, and open the final component with O_NOFOLLOW. Credential Debug output is redacted; auth errors are static.
- Production HTTPS/WSS endpoints are fixed. TLS validation remains enabled. Redirects, proxies, retries and reconnect replay are disabled. Loopback overrides are test-only.
- Ordinary tools execute outside the provider. Generated fragments, advanced calls, malformed namespaces and incomplete calls cannot authorize execution or ordinary continuation.
- Queues, frames, responses and retained context are bounded. Local interruption does not prove upstream cancellation.
- Smoke output contains only allowlisted structural evidence and static categories. Native content, headers, account IDs, call IDs and credentials were not captured in reports or logs.

Residual limits: parent-directory permissions and Windows ACLs are not fully
validated; keyring-only auth, credential refresh and proxies remain unsupported.
This is a bounded local security review, not a comprehensive security certification.

After all offline/security reviews passed, the reviewed gateway ran:

`target/debug/gateway auth-check --auth-source pi`

Exit 0: credential shape accepted, freshness metadata accepted,
`live_request_made:false`. Only the gateway process loaded the selected real auth
file. No credential bytes, fingerprints or account identifiers were disclosed.

## Live evidence — no raw logs

Both invocations used the real Rust gateway with `gpt-6-astra`, explicit transport
and Pi auth, under GNU `timeout 180s`. Neither timed out. No automatic retry,
alternate model/account, fallback, TLS bypass or client impersonation was used.

| Case | Transport | Submissions | Result | Observed assertions / blocker |
|---|---|---:|---|---|
| W1 text | WebSocket | 1 | FAIL | Native response.created count 1; two text deltas; validated response.completed with completed status; actual input equality true; exact synthetic answer validator failed |
| W2 continuation | WebSocket | 0 | NOT RUN | W1 failed; no retry or dependent sequence |
| W3 tool round trip | WebSocket | 0 | NOT RUN | W1 failed; no local tool execution or result delivery tested live |
| S1 text | SSE | 1 | BLOCKED | Actual encoded initial input/replay equality true; unexpected_content_type before any native lifecycle; upstream outcome unknown |
| S2 continuation | SSE | 0 | NOT RUN | S1 failed |
| S3 tool round trip | SSE | 0 | NOT RUN | S1 failed |

Total: **2 cases executed, 4 not run; 2 submissions used, 8 unused.** The cap is
not a quota. Both affected transport sequences stopped at their first failure.
SSE was independently selected, not a fallback masquerading as WebSocket success.

### W1 command and evidence

`timeout 180s target/debug/gateway smoke --auth-source pi --transport websocket --model gpt-6-astra --case text`

Exit 1. Stage `first_acceptance`; code `protocol_error`; static diagnostic
`synthetic answer did not match`. The validator rejected the required ordinary
text equality for `gateway connected`. The summary reported:

- `native_created_count: 1`, `normalized_started_counts: [1]`
- `text_deltas: 2`, refusal/reasoning/argument delta counts all 0
- `terminal_type: response.completed`, `terminal_status: completed`, `validated_terminal: true`
- `new_input_only_equal: true`, `answers_equal: [false]`

This proves that this WebSocket invocation received a streamed native response
and a valid completed terminal. It does not pass W1 acceptance. Returned text was
not retained by the sanitizer, so provider wording versus local text normalization
has not been distinguished. No plausible answer, continuation or tool success is
inferred. There was no second socket submission or live parent-ID test.

### S1 command and evidence

`timeout 180s target/debug/gateway smoke --auth-source pi --transport sse --model gpt-6-astra --case text`

Exit 1. Stage `first_generation`; outer code `provider_error`; specific allowlisted
request failure `unexpected_content_type`; upstream outcome `unknown`. The observer
recorded one actual send and `native_sse_replay_equal:true` for the initial body.
Native start, terminal and all delta counts were absent/zero.

The source checks content type only after a successful HTTP status, so a success
status was received but the MIME check failed. The exact HTTP status, content-type
value and response body were not captured. A missing header and a different MIME
value remain indistinguishable. The failure does not prove model rejection or
upstream non-execution. It counts as one submission. No live SSE replay or opaque
reasoning preservation is claimed.

## Changes and repeatable commands

Baseline files changed: `.github/workflows/ci.yml`, `README.md`,
`docs/ARCHITECTURE.md`, `docs/EVENTS.md`, `examples/two_turns.rs`,
`scripts/verify.py`, `src/error.rs`, `src/gateway.rs`, `src/main.rs`,
`src/provider.rs`, `src/tools.rs`, `tests/provider_contract.rs`, and provider
`auth.rs`, `codec.rs`, `mod.rs`, `session.rs`, `sse.rs`, `state.rs`, `tests.rs`,
`wire.rs`. Many source changes are baseline formatting rather than behavior.

Added: Cargo.lock; src/demo.rs; src/smoke.rs; src/smoke_tests.rs; provider
observation.rs, observation_tests.rs, boundary_tests.rs, auth_edge_tests.rs; and
these two local verification reports. Historical evidence and fixtures are intact.

To repeat offline verification, run `uv run scripts/verify.py`, or the six Cargo
commands in the table. To compare later changes, run `git diff --stat` and
`git diff`; these compare against the authorized partial-implementation checkpoint.
The latest report edits are deliberately unstaged. Do not use `git diff --cached`
as a reconstruction of the original baseline: the repository has no initial commit.

The two live commands above are an execution record, not an automatic retry plan.
Do not resume either failed sequence without diagnosis and an explicit decision.
Any future gateway submissions still count against the remaining budget.

## Remaining risks and next decision

1. **Live acceptance is incomplete.** Diagnose the WebSocket exact-text mismatch and SSE response content type without credential/native-data disclosure. No cause has been assigned without evidence.
2. **Low: cached result reuse at capacity.** `src/tools.rs:125-128` counts cached calls as new capacity. At 128 entries, reuse can be rejected. This is a false rejection, not duplicate execution, and does not affect the fixed one-call demo.
3. **Low: intermediate item lifecycle validation.** `src/providers/openai_codex/codec.rs:48-93` does not enforce a full item-ID/index lifecycle. Terminal output remains authoritative and fragments cannot execute tools.
4. **Low: diagnostics.** Smoke can classify a session-level idle closure as a request-identity protocol error. Generic HTTP errors do not expose an exact status through the current event contract.
5. **Unverified platforms and capabilities.** Windows/macOS, hosted CI and advanced features remain outside observed evidence. The README model literal is this session's metadata-selected candidate, not a universal entitlement claim.

Investigation initially had two failed roles; the user authorized continuation
from completed evidence. One implementation attempt then stopped because diagnostic
evidence was inaccessible. The user authorized retry and direct diagnostic fallback.
The retry completed; two confirmed review findings were repaired; the full repeat
review gate completed with no blocking findings. Those workflow failures do not
invalidate later observed tests, and they are not labeled completed retroactively.

The native gateway is built and substantially verified offline. The small milestone
is **not accepted as live verified**. No GUI/server/full-agent work or advanced
feature milestone was started. No commit, push or publication occurred.
