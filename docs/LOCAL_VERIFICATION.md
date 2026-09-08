# Local verification report — 2026-09-07 UTC

**Current status: L0, L1, W1-W3 and S1-S3 PASS. The bounded live matrix is complete.**

S3 managed-auth SSE tool round trip passed once at `2026-09-08T22:05:23Z`.
Random selection chose wi-experiment. The gpt-6-astra add_numbers(17,25) call,
one correlated execution/result, native replay and final42 passed. Both HTTP 200
responses with missing Content-Type passed existing strict SSE prolog admission.
Two submissions, no retry or fallback. Opaque items were not emitted; live opaque
replay remains untested. No further live tests are planned.
The runtime is unchanged from local commit `17ba3c3`, which contains renewal and
L0/L1 evidence. The [combined report](COMBINED_DESIGN_REPORT.md) is complete.
The user authorized committing and pushing the report/evidence and local Wi commits;
this record is prepared before publication, with final Git confirmation reported separately.
Prior evidence remains valid. The separately authorized L1 refresh completed once
at `2026-09-08T21:23:21Z`, with exit 0 and fresh-process confirmation of persistence.

One parent-run login completed at `2026-09-08T20:09:22Z`, returned exit 0 and
persisted an eligible Wi-owned profile. A fresh metadata-only process confirmed
logged_in=true and requires_reauthentication=false. No retry occurred.

The unchanged runtime passed all six Cargo gates, **187 Rust tests and 152
runner tests**. All three reviews found no blockers. Real renewal transport now
connects to explicit refresh and automatic preparation. One explicit live renewal
passed; automatic expiry-triggered renewal retains offline evidence. Second-account
login also passed at `2026-09-08T21:36:47Z`. Fresh Wi status and a reviewed metadata
comparison confirmed two logged-in profiles with distinct provider accounts.
W1-W3 prove managed-auth WebSocket text, same-session continuation and the ordinary
add_numbers round trip. S1-S3 prove SSE text, native-history continuation and the
ordinary tool round trip. This is bounded experimental compatibility on local Linux,
not stable provider support or an unrestricted entitlement claim.

The previous six-case WebSocket/SSE live matrix passed and was committed/pushed as
`718c43afd2a0d826dccc85e7d1c50034139816e4`. It does not establish live acceptance
of the new auth source or the renamed client's identification.

**27/40 assistant generation submissions used, 13 remaining.** This new generation
matrix used exactly 10 submissions. Cumulative auth
accounting is two browser logins, two code exchanges and one refresh exchange.
Real credentials were handled by reviewed Wi processes and one reviewed read-only
metadata checker. No values were displayed, no Pi/Codex auth files were accessed,
and no generation request ran during L0/L1. Runtime source remains unchanged from
the final offline gate. Pre-commit Git states in earlier sections are historical.

See [S3 and matrix completion](#2026-09-08-s3-managed-auth-sse-tool-pass-and-matrix-completion),
[S2 live result](#2026-09-08-s2-managed-auth-sse-continuation-pass),
[S1 live result](#2026-09-08-s1-managed-auth-sse-text-pass),
[W3 live result](#2026-09-08-w3-managed-auth-websocket-tool-pass),
[W2 live result](#2026-09-08-w2-managed-auth-websocket-continuation-pass),
[W1 live result](#2026-09-08-w1-managed-auth-websocket-text-pass),
[L0 live result](#2026-09-08-l0-two-account-login-pass),
[L1 live result](#2026-09-08-l1-explicit-live-renewal-pass),
[offline renewal result](#2026-09-08-real-renewal-offline-pass),
[experimental login result](#2026-09-08-experimental-wi-login-pass),
[Wi offline baseline](#2026-09-08-wi-naming-and-managed-auth-offline-results)
and `docs/WI_AUTH_MATRIX.md`. The pending design-conversation report must combine
this partial follow-up with the previous completed commit. Earlier results,
counts and Git states below remain historical.

See [offline repair and diagnostics](#2026-09-08-offline-repair-and-diagnostics-follow-up)
for the 94-test result and later GitHub Actions evidence. Earlier sections remain
historical snapshots, including their Git state, W1/S1 failures and 2/10 ledger.

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

## 2026-09-08 offline repair and diagnostics follow-up

### Scope and current checkout

At the start of this pass, actual HEAD was
`f30a020679a1eeb61978209e40e78a640db334af` on `master`, and the working tree was
clean. It matched the commit examined by the remote review. The initial commit
and push mentioned in the conversation occurred after the original report above.
This pass made no stage, commit, push, auth-check, credential read or provider
request. All current repairs and documentation edits remain unstaged.

**Result: offline repair and diagnostics preparation PASS; live acceptance remains
incomplete.** All three independent reviews completed with no blocking findings.
The status-parsing defect below is confirmed. Neither historical live failure has
been attributed to that defect or to any other cause without evidence.

### Repairs and regression evidence

| Area | Change | Observed regression evidence |
|---|---|---|
| Function-call status, src/providers/openai_codex/codec.rs:192-197 | Only an absent field or the exact string completed yields complete=true. Present null, boolean, numeric, array, object, empty, unknown and in-progress statuses yield false. Native fields remain preserved. | Before the fix, three status regressions failed. Real codec-to-registry mixed batches now reject before any event/execution/cache. Corrected batches execute fresh, not reused. |
| Continuation boundary, state.rs:227-310 and tests.rs:289-382 | Existing incomplete-call policy now receives the correct normalized status. Both matching tool-result and ordinary user continuation are blocked. | State tests cover both transports and mixed batches. Loopback public-session tests prove no second request for malformed statuses. Omitted/completed controls still succeed. |
| Text evidence, observation.rs:98-121,235-363 | Add independent native/expected, normalized/native and streamed/native comparisons. Text remains private and bounded. | Match/mismatch, altered normalized data, no deltas, terminal-only, refusal/malformed parts, multipart Unicode, 1 MiB bounds and request reset tested. |
| SSE evidence, wire.rs:27-96,272-324 | Record exact HTTP status and allowlisted media/body classifications before returning the existing strict HTTP/MIME error. | Actual loopback responses exercise success, generic rejection, missing/invalid/wrong MIME, JSON/HTML/plain/binary/empty bodies, 302/401/403/429/503, no redirect/retry, timeout, truncation, read error and cancellation. |
| Evidence safety, diagnostic_tests.rs | No raw text, content-type parameters, headers, body bytes, IDs or fingerprints enter snapshots. Accepted SSE and disabled observers do not sample bodies. | Serialization/Debug sentinel and static-value allowlist checks pass. Accepted SSE is not delayed for diagnostic sampling. |

The implementation recorded a pre-fix `cargo test --lib` run with **74 passed,
3 failed**. Its numeric exit code was not surfaced. A reviewer also reproduced
the same three failures in an isolated scratch copy with baseline status parsing;
that later copy included seven diagnostic tests, so it reported 81 passed and
3 failed. No baseline code was restored into the working tree.

Eight test definitions were added: one status boundary test and seven diagnostics
tests. Existing state and public-session tests were extended with malformed-status
matrices. Test definitions are not the basis for PASS; actual executed summaries
are recorded below.

### Diagnostic meanings and limits

The fields are additive to smoke schema version 1. `src/demo.rs`, `src/smoke.rs`
and the existing `required_proof` acceptance conditions were not loosened.

| Field in submissions[] | Meaning |
|---|---|
| native_expected_text_equal | Terminal native ordinary text, trimmed, equals this fixed case/request's expected answer. No expected answer applies to the first tool response. |
| normalized_native_text_equal | Both normalized ordinary item text and response.text equal response.native.output ordinary text, without trimming. |
| streamed_native_text_equal | Output-text deltas concatenated in observed arrival order equal native terminal ordinary text, without trimming. No deltas is unavailable, not true. |
| http.status | Exact numeric status observed when an SSE HTTP response arrives, including generic errors and rejected 2xx responses. |
| http.media | One of missing, invalid, event_stream, json, html, plain_text, other. No arbitrary header value is retained. |
| http.body_class | A bounded-prefix heuristic: empty, json_like, html_like, text_or_other, binary_or_non_utf8, or null. It is not a failure cause or complete content analysis. |
| http.sample_state | not_sampled, unavailable, complete, read_error, timeout or truncated. The initial receipt remains unavailable if sampling is interrupted. |

Text comparisons are null if required evidence is absent, malformed, unsupported,
not applicable or over the **1 MiB** diagnostic bound. Native text is extracted
independently before parsing/acceptance failure; normalized comparison is available
only after a validated terminal. Arrival-order comparison is not a per-item lifecycle
validator and can flag interleaved ordering. It does not change authoritative
terminal handling or the existing strict answer check.

Only rejected SSE responses with an enabled observer are sampled. The retained
prefix is at most **4096 bytes**, under a **one-second** timeout within existing
cancellation/request limits. A cap hit is conservatively truncated, including an
exactly 4096-byte body. Sampling failure does not replace the original rejection
category. No sample is taken for accepted SSE or an observer-disabled session.
Only HTTP success plus text/event-stream can start SSE parsing.

Exact status is authoritative in `submissions[].http.status`; the older
`acceptance.request_failure.http_status` remains limited to inferred 401/403/429.
The older W1/S1 summaries lack these new fields. Their values cannot be recovered
retroactively from the retained evidence. The original failed W1 result remains
intact, as do the unknown exact S1 status/media/body and upstream outcome.

### Local execution results, 2026-09-08

The implementation, three reviewers and final parent rerun executed offline gates
on Linux. The parent ran `uv run scripts/verify.py` and observed exit **0**, all
six commands below, 25 Rust files, 94 test definitions and 25 fixture events.
Repeated executions are not counted as additional distinct tests.

| Command | Exit | Result |
|---|---:|---|
| cargo fmt --all -- --check | 0 | PASS |
| cargo check --all-targets | 0 | PASS |
| cargo test --all-targets | 0 | 94 passed: 84 library, 6 binary, 4 integration |
| cargo clippy --all-targets -- -D warnings | 0 | PASS |
| cargo build --all-targets | 0 | PASS |
| cargo test --doc | 0 | PASS, 0 doctests |
| uv run scripts/verify.py | 0 | All six gates completed |
| git diff --check | 0 | PASS |

All test groups reported **0 failed, 0 ignored, 0 measured and 0 filtered**.
The example target contains zero tests. No live test or real credential check ran.
Cargo.toml, Cargo.lock, auth code, provider endpoints, crate name and client identity
remain unchanged. New `diagnostic_tests.rs` is untracked until the user authorizes
staging; existing code/docs are unstaged modifications.

### Later GitHub Actions evidence, observed 2026-09-08

Authenticated `gh` reads confirmed two successful Rust source validation runs:

- [Run 34154153299](https://github.com/zer09/wi/actions/runs/34154153299), initial commit
  `5174b2a9374b11b0c62c15a9a5b020fa7422e2fa`, started 2026-09-07 19:04:22 UTC,
  updated 19:06:55 UTC. All three platform jobs report success.
- [Run 34154340956](https://github.com/zer09/wi/actions/runs/34154340956), reviewed HEAD
  `f30a020679a1eeb61978209e40e78a640db334af`, started 2026-09-07 19:07:10 UTC,
  completed by 19:09:25 UTC. Exact job summaries and test logs were retrieved:

| Job | Completed UTC, 2026-09-07 | Tests passed | Result |
|---|---|---:|---|
| [ubuntu-latest / 101842920175](https://github.com/zer09/wi/actions/runs/34154340956/job/101842920175) | 19:08:15 | 76 library + 6 binary + 4 integration = 86 | All six Cargo steps success |
| [macos-latest / 101842920329](https://github.com/zer09/wi/actions/runs/34154340956/job/101842920329) | 19:08:36 | 76 + 6 + 4 = 86 | All six Cargo steps success |
| [windows-latest / 101842920387](https://github.com/zer09/wi/actions/runs/34154340956/job/101842920387) | 19:09:25 | 74 + 6 + 4 = 84 | All six Cargo steps success |

All logged groups reported zero failed/ignored/filtered tests; example/doctest
counts were zero. Windows excludes two Unix-only tests at compilation, not as
ignored tests. This establishes hosted cross-platform offline evidence for the
committed baseline. **It does not test this pass's uncommitted 94-test tree or
any live provider behavior.** The original report's earlier NOT RUN statements
remain valid for their original time.

Read commands included `gh run list --repo zer09/wi --branch master --limit 6`,
`gh run view 34154340956 --repo zer09/wi --json headSha,conclusion,jobs,url`, and
`gh run view 34154340956 --repo zer09/wi --job JOB_ID --log` with only test-summary
lines retained. No workflow was dispatched or changed.

### Proposed bounded live-retest plan, NOT RUN

**Current ledger: 2/10 used; 8 remain. This is a proposal, not authorization or an
automatic action.** Keep original IDs W1/S1 immutable; use W1-R1/S1-R1 for later
attempts and append evidence instead of overwriting failures.

1. After explicit user approval, confirm the approved source/binary and rerun offline checks if it changed.
2. Confirm the exact selected model through safe metadata. Use only the selected Pi OAuth source; do not switch identities or billing.
3. Under separate approval for live preparation, the reviewed gateway may perform metadata-only auth-check. It was not performed in this pass.
4. Run W1-R1 once with the fixed text case and a 180-second subprocess deadline. Reserve one submission before invoking it.
5. Inspect sanitized equality fields, lifecycle, outcome and delta counts. Stop the WebSocket sequence on failure; do not retry automatically.
6. If independently approved, run S1-R1 once with explicit SSE and the same deadline. Reserve one submission; inspect exact status/media/sample state and lifecycle.
7. Stop after these two text probes to review results. Maximum additional usage is **2**, making the cumulative ledger at most **4/10**, leaving at least **6**.

Proposed commands, not executed in this pass:

- `timeout 180s target/debug/gateway smoke --auth-source pi --transport websocket --model gpt-6-astra --case text`
- `timeout 180s target/debug/gateway smoke --auth-source pi --transport sse --model gpt-6-astra --case text`

The model literal is the previously selected value and must still match the user's
approved metadata. An interrupted invocation without a complete summary counts
conservatively; local timeout does not prove upstream cancellation. Record all
failed or uncertain sends. Do not lower TLS checks, follow redirects, accept
non-SSE content, loosen exact answers or enable advanced features.

If both text probes later pass, propose continuation plus add_numbers on one
selected priority transport (WebSocket preferred): at most four more submissions,
bringing cumulative usage to at most 8/10. Do not run that phase automatically.
A complete fresh six-case matrix costs ten additional submissions, which cannot
fit the eight remaining. The final two slots must be allocated deliberately;
full two-transport acceptance may require additional user authorization.

### Remaining uncertainty

The new diagnostics can distinguish future observations; they cannot establish
what caused the earlier W1 answer mismatch or S1 content-type failure. There is
no new live evidence or new entitlement claim. Existing low-risk cache-capacity,
intermediate lifecycle and idle-closure diagnostic limitations remain outside
this focused pass. The uncommitted changes have local Linux evidence but have not
run on hosted CI. No credentials, authentication settings, advanced features,
crate/client identity or Git history were changed in this pass.

## 2026-09-08 approved text retest results

The user approved the two-text-probe proposal after the offline repair report.
Only W1-R1 and the independently selected S1-R1 ran. Neither continuation nor tool
cases ran. Source and acceptance rules were not changed for this retest.

### Preparation

- HEAD remained `f30a020679a1eeb61978209e40e78a640db334af` on `master` with the
  previously reviewed, unstaged repair tree and untracked diagnostic tests.
- Safe runtime metadata still selected `openai-codex` / `gpt-6-astra`.
- `uv run scripts/verify.py` exited 0. All six Cargo gates passed again, with
  **94 tests passed** (84 library, 6 binary, 4 integration), zero failures,
  ignored or filtered tests, and zero doctests.
- Smoke/auth-check CLI help and `git diff --check` passed.
- `target/debug/gateway auth-check --auth-source pi` exited 0. It reported
  accepted credential shape and `live_request_made: false`. The reviewed gateway
  loaded only the selected credentials in process; no credential values were
  displayed, copied, changed or fingerprinted. This check is not entitlement proof.

### Observed results

Both commands used the fixed text prompt, explicit Pi OAuth, the selected model
and a 180-second subprocess deadline. Each made exactly one observed submission.
Neither command reached its subprocess deadline or retried.

| Evidence | W1-R1 / WebSocket | S1-R1 / explicit SSE |
|---|---|---|
| Started UTC | 2026-09-08 04:14:16 | 2026-09-08 04:14:35 |
| Finished UTC | 2026-09-08 04:14:19 | 2026-09-08 04:14:38 |
| Exit code | 1 | 1 |
| Result | FAIL, exact-answer acceptance | BLOCKED, strict SSE content-type check |
| Stage | first_acceptance | first_generation |
| Top-level error code | protocol_error | provider_error |
| Request failure | null | unexpected_content_type; upstream_outcome unknown |
| Native created / normalized started | 1 / 1 | 0 / 0 |
| Text deltas | 2 | 0 |
| Refusal / reasoning / argument deltas | 0 / 0 / 0 | 0 / 0 / 0 |
| Terminal type / status | response.completed / completed | null / null |
| Validated terminal | true | false |
| Existing answers_equal | [false] | [] |
| native_expected_text_equal | null | null |
| normalized_native_text_equal | null | null |
| streamed_native_text_equal | null | null |
| HTTP status / media | Not applicable | 200 / missing |
| Body sample state / classification | Not applicable | timeout / null |

Commands executed exactly once each:

- `timeout 180s target/debug/gateway smoke --auth-source pi --transport websocket --model gpt-6-astra --case text`
- `timeout 180s target/debug/gateway smoke --auth-source pi --transport sse --model gpt-6-astra --case text`

W1-R1 passed the required native lifecycle proof but failed the unchanged strict
answer validator. All three independent text comparisons were unavailable, not
false or true. They do not establish native wording, a normalization defect, a
stream mismatch or a particular response shape. Two deltas and a completed
terminal are not enough to claim exact-answer acceptance. No raw native text was
retained to infer a cause.

S1-R1 observed an HTTP 200 response with no Content-Type header. The gateway
rejected it before SSE parsing. The one-second diagnostic sample timed out, so
there is no usable body classification; null does not mean empty. The legacy
request-failure status remained null, but `submissions[].http.status` preserved
200. No native lifecycle was observed. The upstream generation outcome is
unknown. This does not establish why the header was absent, what the body
contained, or whether an account/model/policy issue existed.

These new results do not establish the causes of the original W1/S1 failures.
Their original evidence remains intact. Machine-readable summaries are appended
under the latest `follow_ups` entry; `current_live_ledger` is the authoritative
current count, while the original `live` object remains a historical snapshot.

### Ledger and stop condition

| Attempt | Submissions | Cumulative used |
|---|---:|---:|
| Original W1 and S1 | 2 | 2 |
| W1-R1 | 1 | 3 |
| S1-R1 | 1 | 4 |

**4/10 used, 6 remain. No more live requests are scheduled or authorized by this
completed two-probe approval.** Both affected sequences stopped. Continuation,
add_numbers and broader account capability checks remain untested live.

The milestone remains unaccepted. The next useful work is offline investigation
of the unavailable text comparisons and the observed SSE rejection, without
attributing either to an unproved cause. Further live use needs a new decision
after that investigation. No code, auth setting, crate/client identity, advanced
feature, Git index or history changed during these probes. Only the two local
verification reports were updated afterward; all work remains unstaged.

## 2026-09-08 ledger reconciliation and partial offline implementation

The user confirmed exactly one successful Codex `generate --follow-up` invocation
and one Codex `tool-demo` invocation that did not call the tool. The reported
continuation used two submissions; the no-call demo used one. Combined with the
four previously recorded submissions, the ledger is **7/10 used, 3 remaining**.
The manual command outputs and exact errors were not collected. User-reported
success is not retroactive strict smoke acceptance.

The user approved the offline recommendation. This pass targets bounded lifecycle
diagnostics, a CLI guard against discarded output, regression coverage, and safe
SSE partial-prefix classifications. Finalized-item recovery, forced tool choice,
changed terminal authority and relaxed MIME acceptance remain outside this pass.

The implementation delegate stopped with terminal reason **budget_exhausted**.
The parent inspected the resulting tree. Partial work includes
`src/collect_lifecycle.rs`, `src/collect_tests.rs`,
`src/providers/openai_codex/lifecycle_tests.rs`, and edits to CLI collection,
observer diagnostics, SSE sampling and accompanying docs. Existing changes remain
preserved. No files were staged or committed.

Recovered pre-fix evidence: the focused CLI run exited **101** with one passing
and one failing test. The failure was
`collect_rejects_discarded_or_changed_stream_before_second_send_or_execution`,
with the assertion `discarded evidence must fail collect`. This proves the
regression detected the earlier behavior, not that the new implementation passes.

**Complete final verification has not been established. Independent review has
not run for these new changes.** The earlier 94-test results apply to the earlier
reviewed tree, not this partial implementation. No provider request, credential
read or auth-check occurred in this offline implementation pass. Continuation
requires inspecting and completing the partial implementation before review.

## 2026-09-08 completed offline repair and independent Codex validation

### Completed implementation and verification

The user authorized completion of the partial implementation and independent
validation of the two CLI commands. The implementation retry completed. Subsequent
reviews found evidence-parser ordering/identity defects. Verification reproduced
the defects using synthetic events; focused remediations corrected them. The final
review-a, review-b and review-c all completed with **no blocking findings**.

The completed scope includes:

- `src/collect_lifecycle.rs` and `src/main.rs`: per-request CLI tracking bounded
  by 1 MiB cumulative serialized/retained data, 4096 events and 512 items. The
  guard checks text/refusal parts and finalized messages/function calls against
  terminal output before returning success, submitting a follow-up or executing
  a tool. It supports terminal-only, matching-prefix/suffix and interleaved parts.
- `src/providers/openai_codex/observation.rs`: additive static unavailable-reason
  states and bounded finalized-item counts. Existing equality meanings stay intact.
- `src/providers/openai_codex/wire.rs`: opt-in rejected-response sampling retains
  a safe partial-prefix class after timeout/read error. Limits remain 4096 bytes
  and one second. Zero-byte timeout stays unavailable, not empty. Strict SSE
  status/MIME checks and the original rejection category remain unchanged.
- `scripts/cli_retest.mjs` and its tests: fixed, explicit-opt-in runner for the
  actual gateway CLI. It captures raw stdout/stderr only in bounded memory and
  emits static categories, counts and booleans. It validates envelope identities,
  local sequence order, normalized response lifecycle and executor order.

The Node runner trusts the reviewed Rust CLI's clean exit 0 for stream/terminal
content consistency. It does not independently duplicate Rust content tracking.
It reports this distinction through CLI outcome and separate observed/inferred
fields. It does not prove outbound bytes, same-socket reuse or transmitted tool
result contents. A reconstructed exit-zero synthetic trace that the current CLI
cannot produce is not treated as independent proof of a live gateway defect.

No finalized-item recovery, forced tool choice, public ModelResponse change,
authentication setting change, identity rename, dependency change, retry or MIME
relaxation was implemented. Exact finalized-native equality remains deliberately
conservative and can reject metadata enrichment.

Parent-observed checks before credential access, 2026-09-08:

| Check | Result |
|---|---|
| `uv run scripts/verify.py` | Exit 0; all six Cargo gates passed |
| `cargo test --all-targets` within verifier | 102 passed: 86 library, 12 binary, 4 integration |
| `cargo test --doc` within verifier | 0 doctests, PASS |
| `node scripts/cli_retest.mjs --self-test` | Exit 0; 151 synthetic tests, live_started=false |
| `git diff --check` | PASS |
| Cargo.toml, Cargo.lock, auth.rs and provider.rs diff check | Unchanged from HEAD |

All Rust test groups reported zero failures, ignored or filtered tests. Inventory
was 28 Rust files and 25 fixture events. Tests that exercise CLI output emit
synthetic fixtures; those are not live streams. This working tree has local Linux
evidence only, not a new hosted CI result.

### Independent live execution

The user explicitly selected Codex auth for these commands. The reviewed
`target/debug/gateway auth-check --auth-source codex` exited 0 with accepted
credential shape and `live_request_made:false`. Only the gateway loaded the
selected credential file. No token values, fingerprints or auth-file contents
were displayed or recorded, and no credential storage was changed.

The parent invoked these once each, not the user's earlier invocations:

- `node scripts/cli_retest.mjs --run-live --case continuation`
- `node scripts/cli_retest.mjs --run-live --case tool`

The runner directly starts `target/debug/gateway` with explicit
`--auth-source codex --model gpt-6-astra --transport websocket --json`.
For `generate`, it uses the user's prompt `Remember the word lantern and acknowledge.`
and follow-up `What word did I ask you to remember?`. For `tool-demo`, it uses
the existing fixed demo instructions. JSON mode permits private parsing; raw
native output never enters the saved report or conversation.

Each invocation has a 180-second deadline and a maximum of two submissions.
Both stopped on the first response without retry or timeout:

| Evidence | C-CODEX-1: generate --follow-up | T-CODEX-1: tool-demo |
|---|---|---|
| Started/finished UTC | 07:06:29 / 07:06:34 | 07:06:49 / 07:06:53 |
| Runner / gateway exit | 1 / 1 | 1 / 1 |
| Sanitizer error | null | null |
| CLI error category | lifecycle_guard | lifecycle_guard |
| Observed request IDs | 1 | 1 |
| Normalized starts / terminals | 1 / 1 | 1 / 1 |
| Terminal status | completed | completed |
| Text deltas | 11 | 0 |
| Function-argument deltas | 0 | 9 |
| Finalized streamed items | 1 message | 1 function_call |
| Terminal output items | 0 | 0 |
| Terminal text state | no_ordinary_parts | no_ordinary_parts |
| Local executor starts / finishes | 0 / 0 | 0 / 0 |
| Follow-up / result-delivery submission | Not sent | Not sent |
| Assertions passed | false | false |
| Accounted submissions | 1 | 1 |

Accounting is based on one observed request plus the reviewed first-response-stop
control flow, not an outbound wire observer. A lifecycle-guard error occurs
before the next CLI generate or executor call. Uncertain/truncated runner output
would instead reserve the full two-submission command maximum. Neither invocation
had uncertain/truncated output, signal, timeout or parser error.

### What the new evidence establishes

**Both new Codex runs contained finalized streamed items that were absent from
the completed terminal output.** `ResponseDecoder` currently emits those items
as events but constructs `ModelResponse` from terminal output only. The CLI now
detects that inconsistency and stops instead of treating it as success.

For the new tool run, saying the model did not call a tool would be incorrect:
a finalized function-call event and nine argument deltas were observed. However,
the retained counters do not assert the finalized call's name, exact arguments,
status or authority. The empty terminal had no executable call, so neither
`add_numbers` execution nor result 42 was observed. `tool_choice:auto` did not
prevent a function-call event in this run; forcing tool choice is not established
as the repair for this observed failure.

The same decoder behavior could explain earlier symptoms, but these Codex runs
do not retroactively prove the original Pi W1/S1 or manual command causes. SSE
was not retried, and its missing-header/body cause remains unresolved. Why the
provider omitted the streamed items from terminal output is also unresolved.

### Current assistant-only ledger and next boundary

| Assistant activity | Submissions |
|---|---:|
| Original Pi W1/S1 | 2 |
| Pi W1-R1/S1-R1 | 2 |
| Codex C-CODEX-1 | 1 |
| Codex T-CODEX-1 | 1 |
| Total | 6 |

**6/10 used, 4 remaining.** The user's three manual submissions are separately
recorded and excluded by explicit user direction. The earlier combined 7/10
calculation is historical, not the current assistant budget. Both newly authorized
commands have been run; no further live execution is scheduled.

The next compatibility decision is whether to reconcile validated finalized
items with an explicitly empty completed terminal. Any such repair must keep
native terminal provenance, reject incomplete/conflicting/malformed batches,
never execute deltas or added-only calls, and test real executor/continuation
boundaries before live validation. It is not included in this completed
terminal-authority-preserving repair. All changes remain unstaged; no commit or
push was performed. Live continuation and the ordinary tool round trip remain
unaccepted.

## 2026-09-08 finalized-item recovery and matrix results

### Scope and offline completion

The user approved completion of the existing six-case matrix and increased the
assistant submission cap to 16. The user then authorized continuation from the
five completed solution reports after two routes failed. Those failures remain
historical. The oracle requested precise recovery invariants; the parent applied
them before implementation. The implementation completed, verified review findings
were repaired, and final review-a/review-b/review-c all found no blockers.

The repair is limited to:

- Provider-level recovery from validated finalized items when a successful
  completed/done terminal explicitly contains `output:[]`. No delta or added-only
  item becomes effective output. The whole batch must pass identity, schema,
  index, completeness, authority and content-consistency checks.
- Tracking bounds of 1 MiB serialized associated evidence, 4096 events and 512
  items. Recovery-only errors are latched and do not replace nonempty native
  terminal output. Failed recovery reports `TerminalReceived` without settlement,
  execution, a finished response or another send.
- Public `ModelResponse.output_provenance`, defaulting to `NativeTerminal` for
  older serialized responses and set to `ValidatedOutputItemDone` for recovery.
  `output` and `text` are effective data. `native` retains the original terminal.
  Existing Rust struct literals need the added field; project literals were updated.
- Explicit Codex support in the existing smoke helper. Private `PiOnly` became
  `SmokeAuthSource` because it now supports both explicit sources. The helper has
  no default source/fallback and requires the fixed model `gpt-6-astra`.
- Separate effective/native diagnostics. Node runner `effective_text_state`
  replaces its ambiguous `terminal_text_state`; the Rust observer retains native
  `terminal_text_state` and adds separate effective fields.

Review regressions exposed and corrected associated-field/part-family gaps and
non-prefix provisional arguments/content. Rejected mixed batches produce zero
execution and no second send in both loopback transports. Tests also cover valid
recovery, native preservation, old/new provenance serialization, terminal outcomes,
exact bounds, opaque replay and tool-result linkage. Existing strict tool checks,
`tool_choice:auto`, auth handling, dependencies, endpoints, client identity and SSE
MIME validation remain unchanged. No new runner or advanced feature was added.

Parent-observed final gates before live execution:

| Check | Result |
|---|---|
| `uv run scripts/verify.py` | Exit 0; all six Cargo gates PASS |
| Rust tests | 119 passed: 101 library, 14 binary, 4 integration |
| Failures / ignored / filtered | 0 / 0 / 0 |
| Doctests | 0 tests, PASS |
| `node scripts/cli_retest.mjs --self-test` | 152 passed; live_started=false |
| `git diff --check` | PASS |
| Cargo.toml, Cargo.lock and auth.rs | Unchanged from HEAD |

Inventory: 31 Rust source/test/example files and 25 fixture events. Evidence is
local Linux; no new hosted or cross-platform CI run was performed.

### Live matrix, parent-observed

The reviewed metadata-only Codex auth check passed. The gateway alone loaded the
selected credentials in process. No credential values, fingerprints, headers,
identifiers or raw native streams were disclosed or saved.

Each case used this reviewed command prefix with the table's transport and case:
`timeout --signal=TERM --kill-after=5s 180s target/debug/gateway smoke --auth-source codex --model gpt-6-astra`.
The helper uses the actual gateway transport and its internal structural observer,
not the earlier Node CLI runner. Every listed case ran at most once.

| Case | Transport / case | UTC start / finish | Exit | Submissions | Result |
|---|---|---|---:|---:|---|
| W1 | websocket / text | 09:31:48 / 09:31:53 | 0 | 1 | PASS |
| W2 | websocket / continuation | 09:31:59 / 09:32:08 | 0 | 2 | PASS |
| W3 | websocket / tool | 09:32:19 / 09:32:26 | 0 | 2 | PASS |
| S1 | sse / text | 09:32:36 / 09:32:38 | 1 | 1 | BLOCKED |
| S2 | sse / continuation | Not run | N/A | 0 | Failed prerequisite S1 |
| S3 | sse / tool | Not run | N/A | 0 | Failed prerequisite S1 |

**W1:** one actual native start, two text deltas, validated completed terminal,
exact `gateway connected` answer. Effective, normalized and streamed text agreed.

**W2:** exact `remembered` and `lantern` answers. Both responses had one native
start, two text deltas and validated completed status. On request two,
`socket_reused`, `prior_response_equal` and `new_input_only_equal` were all true.
This proves same-connection parent/new-input continuation, not just word recall.

**W3:** one completed direct `add_numbers` call with arguments `a=17,b=25` passed
strict validation. Nine argument deltas were observed. Exactly one correlated
local execution and one validated `sum=42` result occurred. The second request
reused the socket, matched the prior response and transmitted the tool result
with matching call ID (`result_linkage_equal:true`). The final ordinary answer was
exactly `42`, with one text delta and no further call. Tool-call, executor and
result acceptance booleans were all true.

All five accepted WebSocket responses had **zero native terminal items and one
effective recovered item**, with `output_provenance:validated_output_item_done`.
Native text comparisons remained unavailable; effective text comparisons passed
where applicable. This is observed live validation of the recovery repair, not
rewriting the native terminal evidence. No reasoning/opaque output was emitted;
opaque replay remains covered synthetically, not proved by these live cases.

**S1:** the request failed at `first_generation`. The request failure category was
`unexpected_content_type`, with upstream outcome `unknown`; the wrapper reported
`provider_error`. HTTP diagnostics recorded exact status **200**, media **missing**,
sample state **timeout**, and body class **text_or_other**. A nonempty bounded
prefix arrived, but it did not establish a valid SSE stream. The one-second sample
timeout does not mean zero bytes arrived. There was no native start, delta or
validated terminal. S2 and S3 stopped without submissions.

The earlier Pi SSE observations also lacked Content-Type, but this new observation
uses Codex auth. No evidence establishes the header omission's cause or a safe
request-side fix. Do not infer HTML, JSON, policy rejection or valid SSE from the
partial `text_or_other` classification. Strict parsing was not relaxed.

### Current disposition

- **WebSocket text, continuation and ordinary tool round trip: PASS.**
- **SSE text: BLOCKED. SSE continuation/tool: NOT RUN.**
- **Full six-case milestone: incomplete.** Remaining work is the SSE blocker,
  followed by S1/S2/S3 validation after an evidence-backed repair decision.
- Assistant ledger: prior 6 + matrix 6 = **12/16 used, 4 remaining**. Manual user
  runs remain excluded. A fresh S1/S2/S3 sequence needs five submissions, so four
  remaining cannot cover that complete sequence without another budget decision.
- No retries or additional live runs are scheduled. All source/report changes
  remain unstaged; no commit, push or publication occurred.

## 2026-09-08 SSE compatibility and completed matrix

### Minimal repair and offline evidence

The user raised the assistant cap to 20 and authorized only the remaining SSE
matrix work. All six solution reports completed. The parent incorporated the
oracle's refined first-frame, identity, label and byte-limit invariants. The
implementation completed and all three final reviews passed with no blockers.

The new path applies only to **2xx responses with an entirely absent Content-Type**
on the existing subscription SSE path. The first data-containing frame must prove
strict SSE framing and a valid Responses created/terminal event. Empty data,
`[DONE]`, arbitrary JSON types, malformed payloads or a wrong event label reject
immediately, even if valid-looking data follows. HTML/plain/JSON prefixes and
unknown fields cannot be ignored to find a later valid frame.

The prolog allows standard comments/metadata, BOM, fragmented UTF-8 and line
endings. Its limits are **65,536 raw bytes and an absolute 10 seconds**. Every
fetched byte, including the proof chunk's suffix, replays exactly once through the
ordinary decoder. Existing 8 MiB frame and 32 MiB response limits remain active.
The diagnostic preserves `media:missing`; `sse_prolog_admitted` records body-based
protocol proof, not a synthesized header. Other `sse_prolog_*` states distinguish
this probe from the unchanged 4 KiB/one-second rejection sampler.

Present wrong/invalid MIME, non-2xx handling, labeled-SSE decoding, credentials,
headers, endpoints, identity, WebSocket behavior, recovery, tools and acceptance
criteria remain unchanged. No retry, fallback or extra runner was added.

Reference evidence, fetched read-only through `gh`:

- [Pi v0.85.1 source](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/api/openai-codex-responses.ts)
  checks response success/body and parses SSE without a MIME gate.
- [OpenClaw #90205](https://github.com/openclaw/openclaw/pull/90205) reports live
  Codex SSE with missing Content-Type; [#90487](https://github.com/openclaw/openclaw/pull/90487)
  scopes compatibility to the native backend and body proof.

These references corroborate the compatibility issue, not our previous body or
account behavior. No reference retry, identity change or TLS bypass was adopted.
The live evidence below independently proves this gateway path.

Parent checks before live execution:

| Check | Result |
|---|---|
| `uv run scripts/verify.py` | Exit 0; all six Cargo gates PASS |
| Rust tests | 134 passed: 116 library, 14 binary, 4 integration |
| Failed / ignored / filtered | 0 / 0 / 0 |
| Doctests | 0 tests, PASS |
| `node scripts/cli_retest.mjs --self-test` | 152 passed; live_started=false |
| `git diff --check` | PASS |
| Cargo.toml / Cargo.lock / auth.rs | Unchanged from HEAD |

The 15 new tests cover strict admission, decisive bad first frames, fragmentation,
exact/+1 limits, absolute timeout, cancellation, observer parity, replay fidelity
and missing-MIME S1/S2/S3 loopbacks, including synthetic opaque replay and tool
execution. Inventory: 33 Rust files and 25 fixture events.

### Live SSE results

The reviewed metadata-only Codex auth check passed with `live_request_made:false`.
Only the gateway read selected credentials in process. No credential values,
fingerprints, identifiers, headers or raw native streams were saved or disclosed.

Each command used the same prefix, followed by its case:
`timeout --signal=TERM --kill-after=5s 180s target/debug/gateway smoke --auth-source codex --model gpt-6-astra --transport sse`.

| Case | Flag | UTC start / finish | Exit | Submissions | Result |
|---|---|---|---:|---:|---|
| S1 text | `--case text` | 10:28:55 / 10:28:59 | 0 | 1 | PASS |
| S2 continuation | `--case continuation` | 10:29:06 / 10:29:10 | 0 | 2 | PASS |
| S3 tool round trip | `--case tool` | 10:29:20 / 10:29:26 | 0 | 2 | PASS |

All five requests observed HTTP 200, missing MIME and `sse_prolog_admitted`.
Each had one actual native start and a validated completed terminal. Every
terminal had zero native output items and one validated finalized effective item,
so finalized-item recovery was also exercised on SSE. Native text comparisons
remain unavailable; effective comparisons passed where applicable.

- **S1:** exact `gateway connected`, two text deltas, effective/normalized/streamed
  text agreement and correct actual input.
- **S2:** exact `remembered` then `lantern`, two text deltas per response and
  `native_sse_replay_equal:true` for both requests. The second request replayed the
  expected native conversation history. `opaque_replay:not_emitted` correctly
  records that no opaque reasoning was returned; it is not a live opaque proof.
- **S3:** one validated ordinary direct `add_numbers` call with `a=17,b=25`, nine
  argument deltas, one correlated local execution, validated `sum=42`, and actual
  result delivery with matching call ID. The second request had correct native
  replay and `result_linkage_equal:true`. Its ordinary final answer was exactly
  `42`, with one text delta and no additional call. All tool acceptance booleans
  passed. Opaque reasoning again was not emitted.

### Accepted matrix and stopping point

| Matrix case | Status | Live evidence |
|---|---|---|
| W1 WebSocket text | PASS | Previous recovery-matrix run |
| W2 WebSocket same-socket continuation | PASS | Previous recovery-matrix run |
| W3 WebSocket tool round trip | PASS | Previous recovery-matrix run |
| S1 SSE text | PASS | This run |
| S2 SSE native-history continuation | PASS | This run |
| S3 SSE tool round trip | PASS | This run |

**The six-case matrix is complete for selected Codex OAuth and `gpt-6-astra` on
this Linux host.** WebSocket was not rerun because its path was unchanged; the
full offline suite retained its regression coverage. Historical failures were
not retroactively converted into passing runs.

The assistant ledger is **17/20 used, 3 remaining**: prior 12 plus this SSE
sequence's five submissions. Manual user runs remain excluded. No extra probes
or automatic retries occurred. No further live requests are planned.

Why the server omitted headers/output remains unknown, but successful protocol
admission and effective output are now directly validated. Live opaque replay,
broader account/model capabilities and new hosted/non-Linux CI are not claimed.
All work remains unstaged; no commit, push or publication occurred.

## 2026-09-08 Wi naming and managed-auth offline results

Checked at `2026-09-08T15:25:22Z`, against the unstaged tree based on `718c43a`.
The user approved offline implementation of `docs/WI_AUTH_MATRIX.md` only.
The previous completed matrix was already committed and pushed, but its report
had not yet been sent to the design conversation.

### Implemented and observed offline

- Cargo package/library/binary are `wi`, product Wi, version 0.2.0. Active imports,
  CLI examples and runner paths changed deliberately; provider ID `openai-codex`,
  Gateway types and historical records did not. Client identification is now `wi`.
- Provider-local versioned JSON supports multiple named profiles, not a singleton.
  Linux storage uses private owner permissions, descriptor-relative no-symlink
  traversal, bounded parsing, stable cross-process locks and synced atomic writes.
- Explicit profile selection overrides uniform random selection. Selection occurs
  once per session open. The source pins profile alias, account and login
  incarnation through SSE reloads/tool results; WS retains its handshake snapshot.
- `CredentialSource::prepare_submission()` separates renewal preparation from
  read-only `load`. External Pi/Codex sources retain a no-op preparation default.
- Synthetic renewal tests prove identity preservation, single refresh under
  concurrent preparation, persistence after waiter cancellation and fail-closed
  handling of failed/ambiguous exchanges and write phases.
- Persistent non-secret rotation guards prevent selection/load after uncertain
  rotated-document persistence, including post-rename directory sync failure.
- Local list/status/logout handle absent stores without creating anything.
  Existing unsafe/unlocked documents still fail closed; logout preserves other
  profiles and the stable lock.
- Test-only OAuth mechanics cover loopback callback handling, PKCE/state,
  deadlines and token validation. Two actual valid callbacks cause one exchange
  and one profile persistence. This is not production identity verification.

New components are under `src/providers/openai_codex/`: `managed_auth.rs`,
`managed_store.rs`, `profile_selection.rs`, `oauth_offline.rs`, and focused tests.
CLI dispatch is in `src/auth_cli.rs`; CLI absence tests are in
`tests/managed_absence_cli.rs`. `docs/WI_AUTH.md` describes the implemented boundary.
Direct uses of already-locked `ring` and Linux `rustix` were added; dependency
versions were not upgraded. Cargo.lock is retained.

### Review findings and repairs

| Finding | Observed evidence | Repair |
|---|---|---|
| Rotation persistence failure could leave profile eligible | Synthetic post-rename directory-fsync EIO returned failure while visible JSON cleared reauth | Separate durable incarnation-scoped guard remains authoritative until JSON commit; fault-phase/restart regressions |
| Duplicate callback assertion lacked a second callback | Existing test duplicated state parameters in one request | Two valid callbacks, counted token exchange and persistence |
| Missing store incorrectly reported unsafe | Isolated missing XDG/HOME and empty-directory CLI cases | Read-only absence-aware descriptor traversal and actionable empty/missing selection |
| Missing-profile logout still reported unsafe | Same absent-store cases through logout | Optional stable locked read; no creation; missing alias and unrelated profile preservation tests |

All findings above were independently confirmed before remediation. A separate
suspected runtime deadlock was not confirmed: session selection and auth reads
already run on blocking workers. Each remediation was followed by the full review
gate. The final review-a, review-b and review-c all passed without blockers.

### Parent final verification

| Check | Observed result |
|---|---|
| `uv run scripts/verify.py` | Exit 0; fmt/check/test/Clippy with warnings denied/build/doctests all PASS |
| Rust tests | 163 passed: 142 library, 16 binary, 1 absence integration, 4 provider-contract |
| Failed / ignored / measured / filtered | 0 / 0 / 0 / 0 |
| Doctests | 0 tests; PASS |
| `node scripts/cli_retest.mjs --self-test` | Exit 0; 152 passed; live_started=false |
| `git diff --check` | PASS |
| `target/debug/wi --version` | `wi 0.2.0` |
| Git state | HEAD remains `718c43a`; index empty; changes unstaged |

Static inventory: 41 Rust files, 160 regex-counted test definitions and 25 fixture
events. The regex omits three parameterized Tokio attributes; executed test
counts above are authoritative. Test runs are not summed into a larger count.

### Remaining blockers and evidence limits

**The new authentication milestone is not complete.** `wi auth login` and
`wi auth refresh` return the static OAuth configuration blocker before path
resolution, secret reads, listener creation or network requests. The browser
launcher, permitted OAuth client configuration and trusted production account
validation are not implemented. No production command creates a profile yet.
The production token-renewal exchange remains unavailable. Synthetic success
must not be reported as a usable OpenAI login.

The new L0/L1 and W1-W3/S1-S3 live rows are all **NOT RUN**. Real auth/credential
mutation and live execution require explicit authorization after the remaining
production work and its review. The cumulative cap is 40: **17 used, 23 remaining**.
No submissions or real auth exchanges were consumed by this pass.

Managed persistence is Linux-only and fails closed elsewhere. No new non-Linux
or hosted-CI run occurred. Fault injection is not physical power-loss testing.
Guard cleanup failure can conservatively require login after a durable rotation.
An external process can prolong advisory lock waits; no bounded lock-wait claim
is made. New client identification has not been live-tested, and no quota,
account failover, mid-session switching or generation replay was added.

### Pending combined report

Report the earlier completed live milestone under commit `718c43a` separately
from this **uncommitted, offline-verified partial follow-up**. The user has not
sent the earlier report and wants both in the eventual design-conversation report.
Use `docs/WI_AUTH_MATRIX.md` sections 7-8 for the combined outline and current
TODOs. Do not invent a new commit ID, mark blocked rows PASS, or claim this report
has already been delivered externally.

## 2026-09-08 experimental Wi login PASS

The user chose a bounded empirical login experiment. This superseded the previous
provider-confirmed-configuration prerequisite for this increment only. Wi uses
the published Pi-compatible configuration with its own originator/user-agent;
no provider approval or stable contract is asserted.

Implemented `wi auth login --experimental`: fixed browser/code-exchange flow,
strict bounded single-use PKCE callback, TLS-authenticated token response,
account/expiry parsing, and guarded durable Wi-profile persistence. No real
renewal, generation, fallback, listener cancellation or credential copying was
added. Details and limits are in `docs/WI_AUTH.md`.

Review confirmed and remediation corrected three compatibility defects: rejecting
unrecognized callback parameters, case-sensitive Bearer token type, and an
unsupported one-day expiry cap. Security-related duplicate/state/issuer checks,
malformed input rejection, response bounds, expiry overflow/minimum and private
storage controls remain intact. All three repeated final reviews passed.

### Observed offline evidence

At `2026-09-08T20:08:41Z`, parent `uv run scripts/verify.py` passed all six Cargo
gates. Cargo reported 177 tests: 156 library + 16 binary + 1 absence integration +
4 provider-contract. Zero failures, ignored, measured or filtered tests; zero
doctests. The Node runner self-test passed 152 tests with live_started=false.
`git diff --check` passed. Static inventory counted 43 Rust files, 170 regex test
definitions and 25 fixture events; executable test counts are authoritative.

### Observed live evidence

One invocation, no replacement:
`./target/debug/wi auth login --provider openai-codex --account wi-experiment --experimental`.
Wi reported browser authorization waiting, then login complete. It exited 0 at
`2026-09-08T20:09:22Z`. Safe metadata reported persisted=true, eligible=true, and
an expiry. The reviewed one-callback/no-retry control flow establishes one token
exchange for this successful invocation; no raw traffic was captured.

A fresh invocation of `wi auth status` for that alias reported enabled=true,
logged_in=true, requires_reauthentication=false, and the same expiry. This proves
that a new process could read the persisted eligible profile. Token values,
provider account identity and authorization URLs are omitted from this report.
Real credentials were read/written only by the reviewed Wi process and private
Wi store. Existing Pi/Codex credential files were not read or modified.

### Acceptance and remaining scope

The **single-login increment is accepted locally**. L0's broader two-account
requirement has only one-profile coverage. L1 real renewal and new W1-W3/S1-S3
remain NOT RUN. Login does not prove generation entitlement or model transport
compatibility. The historical six-case matrix still belongs to commit `718c43a`.

Auth accounting: one browser login, one code exchange, zero refreshes/retries.
Generation accounting: zero new, 17/40 used, 23 remaining. No further live request
is planned in this increment. The changes are unstaged and uncommitted. Include
this result with the prior completed commit in the pending combined report.

## 2026-09-08 real renewal offline PASS

Baseline: local commit `27539bd39a19ea5fcf55e8d9159ccc89ce2dcbbf`, containing the
previous Wi naming/profile/login work. This increment connects the real refresh
adapter; it does not perform live renewal, login or generation.

`src/providers/openai_codex/refresh.rs` implements the fixed Pi-compatible form
exchange with Wi identification, TLS validation, no proxy/redirect/retry/fallback,
10-second I/O and 30-second exchange bounds, and a 65536-byte response cap. Shared
login parsing validates complete token pairs, account claims and checked/fresh
expiry. The existing manager preserves identity/incarnation, durable rotation
guards and cancellation-surviving persistence. CLI refresh emits metadata only.
Read-only load/list/status and established WS behavior remain unchanged. SSE
preparation may renew only the same bound profile. No dependencies changed.

Parent final `uv run scripts/verify.py` completed at `2026-09-08T21:17:01Z`:
all six Cargo gates PASS, 187 Rust tests (166 library + 16 CLI + 1 absence integration
+ 4 provider-contract), zero failed/ignored/measured/filtered tests, zero doctests.
`node scripts/cli_retest.mjs --self-test`: 152 PASS, live_started=false.
`git diff --check` and `wi auth --help` passed. Inventory: 45 Rust files,
178 regex-counted test definitions, 25 fixture events; executed counts prevail.

Ten new loopback tests exercise the actual adapter, including exact form encoding,
explicit and automatic rotation, no-network reads/fresh preparation, concurrency,
cancelled waiters, account mismatch/restart guards, bounded malformed responses,
timeouts, no retries/redirects, sanitized errors, and strict token validation.
Existing synthetic fault and WS/SSE binding regressions remain passing.

All three reviews completed without blockers. Two stale descriptions of renewal
were corrected mechanically before the final gate. Proxy refusal is established
by `.no_proxy()` source review, not a dedicated environment-proxy test. Exchange
time bounds do not bound existing lock waits or blocking filesystem operations.
Former public configuration-blocker helpers are now test-only, because production
renewal no longer uses that placeholder; no runtime API was renamed.

**R2 PASS offline; L1 NOT RUN.** Linux offline evidence does not prove real refresh
acceptance. One separately authorized explicit refresh of the existing profile
is the next live check. A rejected or ambiguous refresh can require login again;
no automatic retry is permitted. Second-account and generation cases remain deferred.
Zero real credential reads/writes, browser logins, code exchanges, refreshes or
generation requests occurred in this increment. Ledger unchanged: 17/40 generation
submissions used, 23 remaining. Changes are unstaged; no new commit or push.

## 2026-09-08 L1 explicit live renewal PASS

Following explicit user approval and the completed 187-Rust/152-runner offline
and review gates, parent ran one `wi auth refresh --provider openai-codex
--account wi-experiment` invocation under a 90-second local deadline. It exited 0
at `2026-09-08T21:23:21Z`. Safe metadata reported enabled=true, logged_in=true,
requires_reauthentication=false and an updated expiry.

A fresh `wi auth status` process confirmed the same profile metadata and expiry.
Expiry advanced from the previous login observation. The reviewed manager validates
unchanged provider account before persistence and preserves the login incarnation.
This is live success through that validation path, not a separately captured account
identifier comparison. Other-profile preservation remains synthetic evidence because
only one profile has been live-tested. No tokens, fingerprints, provider IDs, raw
URLs, headers or native token responses were captured in reports.

One successful forced-refresh invocation through the reviewed no-retry path establishes
one refresh exchange. Credentials were handled only by Wi and its private store;
existing Pi/Codex auth files were not accessed. No retry, fallback or generation ran.
L1 is PASS on local Linux. Automatic expiry/concurrency/failure cases retain offline
evidence. Second-account login and managed-auth W1-W3/S1-S3 remain deferred.

Cumulative auth: one browser login, one code exchange, one refresh exchange.
Generation ledger unchanged: 17/40 used, 23 remaining. No further live request is
planned in this L1 scope. Only documentation changed after the observed run;
renewal code remains unchanged from the final offline gate. Changes remain
unstaged; no new commit or push.

## 2026-09-08 L0 two-account login PASS

The user approved L0 and committing on success. One browser login with a new alias,
wi-secondary, completed at `2026-09-08T21:36:47Z`. The reviewed command was
`wi auth login --provider openai-codex --account wi-secondary --experimental`,
with a 200-second local deadline and no replacement. Exit 0; persisted=true;
eligible=true. No retry, fallback, refresh or generation occurred in this step.

Fresh Wi status processes confirmed wi-experiment and wi-secondary enabled,
logged_in=true, requires_reauthentication=false. The first profile's expiry was
unchanged from L1; the second matched the new login metadata. A reviewed read-only
local checker compared the two account and incarnation fields inside the selected
private Wi store and emitted only booleans: distinct_provider_accounts=true and
distinct_login_incarnations=true. It validated file/path safety and read size,
withheld all failure details, made no network request, and wrote no credential data.
No provider IDs, tokens or fingerprints were displayed or saved in reports.
Existing Pi/Codex auth files were not accessed.

L0 is PASS: two distinct provider accounts have persisted Wi profiles. L1 remains
PASS from its separate explicit refresh. New W1-W3/S1-S3 remain NOT RUN; account
login does not establish model entitlement. Runtime code remains unchanged from
the 187-Rust/152-runner, six-Cargo-gate verification and three completed reviews.

Cumulative auth: two browser logins, two code exchanges, one refresh exchange.
Generation ledger unchanged: 17/40 used, 23 remaining. This report records the
pre-commit evidence for the authorized commit of renewal and L0/L1 results on
baseline `27539bd`. Git history identifies the resulting commit. No push or
additional generation test was authorized by this request.

## 2026-09-08 W1 managed-auth WebSocket text PASS

After the user authorized W1, parent ran one fixed smoke case on clean commit
`17ba3c332519e5cb6337a1dae4c19ed4cc28a154`, using the unchanged reviewed runtime:
`wi smoke --auth-source gateway --account wi-experiment --model gpt-6-astra
--transport websocket --case text`, under a 180-second local deadline.
It exited 0 at `2026-09-08T21:45:23Z`; selected profile wi-experiment, passed=true,
stage=first_acceptance, error_code=null, one submission.

Sanitized evidence: one native response.created, one normalized response start,
two text deltas, and a validated response.completed with status completed.
One finalized message supplied one effective item through the existing
validated_output_item_done recovery. Native terminal output had zero items and
no ordinary text; native text comparisons were unavailable, not PASS. Effective
expected/normalized/streamed text comparisons all passed, as did answers_equal
for the synthetic expected answer gateway connected. Tool flags were false because
W1 does not execute a tool. Socket reuse and continuation were not tested.

No retry, transport fallback, account switch or dependent W2 request occurred.
Credentials were handled only by the reviewed Wi process; no raw streams, headers,
tokens or provider identifiers were captured in reports. W1 is PASS on local Linux.
The 187-Rust/152-runner offline evidence still covers unchanged runtime source.

One generation submission added: cumulative18/40 used,22remaining. Auth accounting
remains two browser logins, two code exchanges, one explicit refresh. W2 is next;
W2-W3 and S1-S3 remain NOT RUN. Only docs/evidence changed after the run. No new
commit or push occurred, and no further live case is authorized by W1 completion.

## 2026-09-08 W2 managed-auth WebSocket continuation PASS

The user approved W2 after W1. Parent ran one `wi smoke --auth-source gateway
--model gpt-6-astra --transport websocket --case continuation` command under a
180-second deadline on unchanged runtime17ba3c3. Omission of --account selected
the existing random policy; Wi reported wi-experiment once. Exit0 at
`2026-09-08T21:50:25Z`, passed=true, stage=final_acceptance, error_code=null.

Two submissions each produced one native response.created, one normalized start,
two text deltas and a validated response.completed/status completed. Expected
answers remembered and lantern both passed, along with effective expected,
normalized and streamed text comparisons. Each explicit empty native terminal
was reconciled with one validated finalized message, provenance
validated_output_item_done. Native text comparisons were unavailable, not PASS.

Request two proved socket_reused=true, prior_response_equal=true and
new_input_only_equal=true. Together with the reviewed pinned handshake this proves
same-account session continuation, not just model recall. No tools, retries,
fallbacks, account switching or repeated random-selection probes occurred.

W2 is PASS. Two submissions added:20/40 used,20remaining. W3 is next; S1-S3 also
remain NOT RUN. Existing187-Rust/152-runner gates and three reviews cover unchanged
runtime source. Only sanitized evidence/docs changed, left unstaged. No credentials,
headers, native streams or provider identifiers were dumped; no commit or push.

## 2026-09-08 W3 managed-auth WebSocket tool PASS

The user approved W3. Parent ran one `wi smoke --auth-source gateway --model
gpt-6-astra --transport websocket --case tool` command under a 180-second deadline
on unchanged runtime17ba3c3. No --account argument was supplied; Wi randomly chose
wi-secondary once. Exit0 at `2026-09-08T21:54:09Z`, passed=true,
stage=final_acceptance, error_code=null, two observed submissions.

Each response had one native response.created, one normalized start and a validated
response.completed/status completed. First response: nine argument deltas and one
finalized function call. Strict tool_call_valid, executor_correlated and
tool_result_valid all passed, proving one direct add_numbers(17,25), exactly one
correlated local execution and result42. No raw arguments or call IDs were dumped.

Request two had socket_reused=true, prior_response_equal=true,
new_input_only_equal=true and result_linkage_equal=true. Final response: one text
delta and one finalized message, with final answer42 and effective expected,
normalized and streamed text comparisons all true. Both native terminals had zero
items; each effective item used validated_output_item_done provenance. Native text
comparisons were unavailable, not PASS; first-response text equality was not applicable.

No retries, fallback, account switch or SSE request occurred. W3 is PASS; all
managed-auth WebSocket cases are complete. Two submissions added:22/40 used,
18remaining. S1 is next. The187-Rust/152-runner gates and three reviews cover
unchanged runtime code. Only sanitized evidence/docs changed, left unstaged;
no additional commit or push was authorized or performed.

## 2026-09-08 S1 managed-auth SSE text PASS

The user approved S1. Parent ran one `wi smoke --auth-source gateway --account
wi-secondary --model gpt-6-astra --transport sse --case text` command under a
180-second deadline on unchanged runtime 17ba3c3. Wi confirmed wi-secondary.
Exit 0 at `2026-09-08T21:57:38Z`, passed=true, stage=first_acceptance,
error_code=null, one observed submission.

Sanitized HTTP evidence: status 200, media missing, body_class text_or_other,
sample_state sse_prolog_admitted. The existing bounded strict SSE prolog admission
path accepted the response without a code or policy change. One native
response.created, one normalized start, two text deltas, one finalized message
and a validated response.completed/status completed were observed.

Answer gateway connected and effective expected/normalized/streamed comparisons
passed. Native terminal output had zero items; the effective message had
validated_output_item_done provenance. Native text comparisons were unavailable,
not PASS. native_sse_replay_equal=true covers the initial request only; no follow-up
or opaque replay was tested. Tool flags were false because S1 is text-only.

No retries, fallback, account switch or S2 request occurred. S1 is PASS on local
Linux. One submission added: 23/40 used, 17 remaining. S2 is next; S2-S3 remain
NOT RUN. Existing 187-Rust/152-runner gates and three reviews cover unchanged
runtime code. Only sanitized evidence/docs changed, left unstaged. No credentials,
headers, native streams or provider identifiers were dumped; no commit or push.

## 2026-09-08 S2 managed-auth SSE continuation PASS

The user approved S2. Parent ran one `wi smoke --auth-source gateway --model
gpt-6-astra --transport sse --case continuation` command under a 180-second deadline
on unchanged runtime 17ba3c3. No account argument was supplied; Wi randomly selected
wi-experiment once. Exit 0 at `2026-09-08T22:01:09Z`, passed=true,
stage=final_acceptance, error_code=null, two observed submissions.

Each HTTP response had status 200, media missing, body_class text_or_other and
sample_state sse_prolog_admitted. Each had one native response.created, one
normalized start, two text deltas and a validated response.completed/status completed.
Answers remembered and lantern both passed, as did effective expected/normalized/
streamed comparisons. Each explicit empty native terminal was reconciled with one
validated finalized message using validated_output_item_done provenance. Native
text comparisons were unavailable, not PASS.

Both requests reported native_sse_replay_equal=true, including the follow-up.
Second-request opaque_replay=not_emitted means no live opaque-replay proof was
available. Existing SSE preparation enforces the selected account binding across
reloads; this does not claim a live renewal occurred. WebSocket-specific prior-ID,
new-input-only and socket-reuse checks are not applicable to SSE history replay.

No retry, fallback, account switch, tool execution or S3 request occurred.
S2 is PASS on local Linux. Two submissions added: 25/40 used, 15 remaining.
S3 is next and remains NOT RUN. Existing 187-Rust/152-runner gates and three reviews
cover unchanged runtime. Only sanitized evidence/docs changed, left unstaged;
no credentials, headers, native streams or provider identifiers were dumped.
No commit or push was authorized or performed.

## 2026-09-08 S3 managed-auth SSE tool PASS and matrix completion

The user approved S3. Parent ran one `wi smoke --auth-source gateway --model
gpt-6-astra --transport sse --case tool` command under a 180-second deadline on
unchanged runtime 17ba3c3. No account argument was supplied; Wi randomly selected
wi-experiment once. Exit 0 at `2026-09-08T22:05:23Z`, passed=true,
stage=final_acceptance, error_code=null, two observed submissions.

Each HTTP response had status 200, media missing, body_class text_or_other and
sample_state sse_prolog_admitted. Each had one native response.created, one
normalized start and a validated response.completed/status completed. The first
response had nine argument deltas and one finalized function call. Strict
call/result/executor validation proved one direct add_numbers(17,25), exactly one
correlated local execution and result42. The second request had native replay and
result linkage both true. Its final response had one text delta, one finalized
message, expected answer42 and effective expected/normalized/streamed comparisons
all true. No raw call IDs, provider streams or credentials were reported.

Both native terminals had zero output items; each effective item used
validated_output_item_done provenance. Native text comparisons were unavailable,
not PASS. First-response text equality was not applicable. Second-request opaque
replay was not_emitted, so live opaque replay remains untested. Existing SSE
preparation enforces fixed account binding across reloads; no live renewal claim.
No retry, fallback, account switching or further request occurred.

All L0/L1 and W1-W3/S1-S3 cases now PASS on local Linux. The new generation matrix
used its planned 10 submissions. Two added here: 27/40 used, 13 remaining.
No additional live tests are planned. Existing 187-Rust/152-runner gates and three
reviews cover unchanged runtime. Only sanitized evidence/docs changed, left unstaged;
no commit or push. Broader provider support, non-Linux live behavior, automatic
expiry-triggered live renewal and live opaque replay remain unverified.

At S3 completion, the next task was the combined design-conversation report.
The subsequent report and publication authorization are recorded below.

## 2026-09-08 Combined report and pre-push verification

Created `docs/COMBINED_DESIGN_REPORT.md`, separating already-pushed repairs at
718c43a, naming/profiles/login at27539bd, renewal at17ba3c3 and the later managed-auth
live matrix. The report covers all L0/L1/W1-W3/S1-S3 PASS evidence without claiming
stable provider support, live automatic-expiry renewal, non-Linux live acceptance
or live opaque replay. The combined-report checklist item is complete.

Parent reran `uv run scripts/verify.py` and the Node runner self-test before
publication, completing at `2026-09-08T22:13:23Z`. All six Cargo gates passed:
format check, all-target check/test, warning-denied clippy, all-target build and
doctests. Rust totals:166 library +16 CLI +1 absence integration +4 provider-contract
=187 passed, zero failed/ignored/measured/filtered; zero example tests and doctests.
Node runner:152 passed, live_started=false. Runtime source and Cargo files remain
unchanged. No live credentials or provider requests were used for this rerun.
The generation ledger remains27/40 used,13remaining; no more live tests are planned.

The user authorized committing this report and accumulated evidence, then pushing
to origin/master, including27539bd and17ba3c3. This record precedes publication;
Git history and the final delivery confirmation identify the documentation commit
and confirm actual push success. No broader implementation change is included.
