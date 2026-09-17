# P1-B2 verification

Contract: **p1b2.0**
Result: **PASS**
Accepted: **Yes under p1b2.0. PR #7 remains open; merge, release and deployment were not authorized.**

**2026-09-17 remediation status:** The result above and sections 1-14 retain
historical evidence, including B2-E01 local acceptance-evidence closure. Section 15
records mixed hosted results at `80290a8636ef27d3b3cd920ac12f601fb2d7b6ca` and the
verification-confirmed test watchdog correction. The uncommitted remediation passes
its required local checks. Its exact-head hosted CI remains **NOT_RUN**; no all-green
exact-head hosted closure is claimed.

## 1. Revision and worktree

- Accepted baseline: `6fe0a538edf6bae39c9f933db8394b7d8483e2be`.
- Planning revision: `58fdb17d2eb621f65fb862d1ad313d57f07e0d18`.
- Exact source revision: `80f387294c92ff0287e614a7f9c658901979352f`.
- Exact hosted evidence revision: `cc9a6a269b737a7d5b093791f9a297e07d585ec8`.
- The baseline and planning revision are ancestors of both revisions.
- The hosted evidence revision differs from the source revision only in current documentation and evidence files.
- Before the original reports were added, the worktree had 34 tracked modified files and 31 untracked files.
- `Cargo.toml` and `Cargo.lock` are unchanged.
- No reset, clean, force checkout, stash, merge, release or deployment occurred.

The authorized branch push occurred. PR #7 remains open and unmerged.

## 2. Implemented boundary

P1-B2 adds:

- `execution::run_in_session` with the contract signature.
- Storage-only `execution::prepare_session_replay`.
- Provider-neutral replay DTOs and additive default-unsupported provider methods.
- Session schema 2 with lazy, atomic schema-1 migration.
- Canonical `run.history.selected` and `run.provider.bound` records.
- Canonical fixed-prefix hashing over raw stored event rows.
- `closed-exchanges-v1` reconstruction from saved prepared prompts, authoritative responses and actual correlated results.
- OpenAI-Codex identity from the account ID already loaded by `Wire::open`.
- Fresh-control replay installation and native WebSocket/SSE restoration.
- A public `conversation_offline` example.

The implementation keeps one `run::run_admitted` engine. `run_persisted`, public `run`, existing `Tool` interfaces and normal CLI behavior remain compatible.

## 3. Storage and migration

New sessions initialize session schema/user version 2. Existing schema-1 sessions migrate lazily in one `BEGIN IMMEDIATE` transaction by creating a replacement event table, copying original columns, replacing the table, recreating indexes and immutability triggers, and updating both version markers.

The independent populated-v1 fixture includes renames, multiple runs, native/effective responses, tool results and receipts. Tests verify:

- Every original event row and payload string remains exact.
- Event IDs, source links, run IDs and receipt ranges remain exact.
- The canonical prefix digest is unchanged by migration.
- Foreign keys, indexes and immutability triggers remain valid.
- Failures during create/copy/drop-rename/precommit/postcommit reopen as a complete v1 or v2 database.
- Unknown, future, foreign and corrupt input is not rewritten as a successful migration.
- Catalog schema remains 1.

Schema migration does not create history selection, provider binding, run activity or account ownership evidence.

## 4. Replay and provenance

`prepare_session_replay` captures one immutable history head and reconstructs only complete closed exchanges. It uses:

- The original stored prepared user prompt for each included run.
- One authoritative `ModelResponse` per exchange.
- Effective output items when terminal recovery was validated.
- Actual committed tool results and actual reuse evidence.
- Original run, request and call identities.

The builder rejects missing provenance, conflicting responses/results, uncertain submission, incomplete result batches, malformed executable output and unsupported executable kinds. A complete nonempty run may omit `RunResult` after process interruption or final-result persistence failure only when canonical exchanges are closed and the committed terminal outcome and summary are exact. A terminal zero-attempt run can be structurally excluded as `DefinitelyUnsubmitted` only with its actual `RunResult`; missing final result alone is not proof of no submission.

Legacy unbound history remains readable and repairable. Migration and replay never assign it to the current account.

## 5. Admission, binding and shared execution

`run_in_session` retains the B1 execution hold and operation-keyed acceptance lock.

1. It checks and rechecks the receipt first.
2. A matching prior B2 receipt uses its original selection and returns `Duplicate` without replay compilation, registry/capability/cancellation checks, credential access or provider opening.
3. An absent receipt builds a fixed-head replay, performs shared admission, validates replay with the exact options/tool definitions/new input that will execute, and atomically accepts the run plus selection.
4. A changed head returns `storage.stale_history`, commits no run activity and is not retried.
5. Only an unwarned, nonduplicate acceptance enters `run::run_admitted`.

After `RunStarted` commits, the shared engine opens one provider session, installs its close guard, obtains the actual replay identity, and awaits the binding record. It records the actual opened identity even when the expected identity differs. Missing or mismatched identity produces a recorded `history_identity` execution failure with zero model attempts. Local installation rejection produces recorded `history_restore`. Binding persistence failure is a sticky `ProviderBinding` storage failure and prevents installation and generation.

No account search, fallback, token hash, alias guess or credential reread exists.

## 6. Native transport behavior

OpenAI-Codex identity uses SHA-256 over UTF-8 `wi.openai-codex.account.v1\0` followed by the exact account ID from the credentials already loaded for opening. Token rotation under the same synthetic account preserves identity; a different account differs. Tests count one opening credential load and verify redacted diagnostics.

For WebSocket:

- The first request on the fresh connection contains full restored native history plus the new prompt.
- It does not contain an imported `previous_response_id`.
- Later continuation uses only the new result delta and the new connection's response ID.

For SSE, every request contains the full ordered effective/native history. Labelled and missing-MIME loopback paths pass. Changed-account SSE submission rejects before sending restored history.

## 7. Matrix results

| Row | Status | Primary executable evidence |
|---|---|---|
| P1B2-00 | PASS | Git ancestry/status/toolchain/dependency checks |
| P1B2-01 | PASS | Provider defaults, DTO validation, public `run_in_session`, shared engine tests |
| P1B2-02 | PASS | Independent populated-v1 migration fixture |
| P1B2-03 | PASS | In-process injection and child-process migration exits |
| P1B2-04 | PASS | Typed selection/binding and repair validation tests |
| P1B2-05 | PASS | Atomic selected acceptance/rollback/conflict tests |
| P1B2-06 | PASS | Barrier-controlled stale-head and duplicate races |
| P1B2-07 | PASS | Independent raw-row digest oracle and paged checkpoint tests |
| P1B2-08 | PASS | Fixed-head storage-only reconstruction tests |
| P1B2-09 | PASS | Empty-session public execution and binding-before-generate test |
| P1B2-10 | PASS | Real A/B producer path and `conversation_offline` |
| P1B2-11 | PASS | Two isolated child processes: terminal A, no-work reopen, explicit B |
| P1B2-12 | PASS | Actual multicall/result/error fidelity tests |
| P1B2-13 | PASS | Reuse evidence, conflict rejection and fresh call scope |
| P1B2-14 | PASS | Native/recovered/refusal/reasoning/opaque fidelity tests |
| P1B2-15 | PASS | Counted credential loads and both loopback transports |
| P1B2-16 | PASS | Actual mismatched binding before zero-attempt failure; 2026-09-17 joined evidence: `b2mr_04_public_session_websocket_records_actual_mismatch_and_later_matching_task` and `b2mr_04_public_session_sse_records_actual_mismatch_and_later_matching_task` (`src/providers/openai_codex/tests/replay/joined_gates.rs:555-561`) |
| P1B2-17 | PASS | Provider/model/format/missing-identity boundaries |
| P1B2-18 | PASS | Install atomicity and install/generate/cancel/drop races |
| P1B2-19 | PASS | Complete interrupted batch and final-response child processes |
| P1B2-20 | PASS | Partial/uncertain/malformed history rejection tests |
| P1B2-21 | PASS | Proved zero-attempt structural exclusion tests |
| P1B2-22 | PASS | Legacy unbound readable-but-not-replayable fixture |
| P1B2-23 | PASS | Receipt-first and two-absent-lookup races |
| P1B2-24 | PASS | Separate new-input and combined-context capacity tests |
| P1B2-25 | PASS | Selection/binding SQL faults, cancellation and certainty tests; 2026-09-17 joined evidence: `b2mr_03_public_session_websocket_awaits_acceptance_binding_and_result_commits` and `b2mr_03_public_session_sse_awaits_acceptance_binding_and_result_commits` (`src/providers/openai_codex/tests/replay/joined_gates.rs:242-249`) |
| P1B2-26 | PASS | Hold/close/drop/process ownership tests |
| P1B2-27 | PASS | Exact WebSocket loopback request bodies; 2026-09-17 joined evidence: `b2mr_01_public_session_websocket_native_and_recovered_history` (`src/providers/openai_codex/tests/replay/joined.rs:761-765`) |
| P1B2-28 | PASS | Exact labelled/missing-MIME SSE request bodies; 2026-09-17 joined evidence: `b2mr_02_public_session_labelled_sse_native_and_recovered_history` and `b2mr_02_public_session_missing_mime_sse_native_and_recovered_history` (`src/providers/openai_codex/tests/replay/joined.rs:768-779`); `b2mr_05_public_session_sse_wrong_explicit_mime_preserves_uncertainty`, `b2mr_05_public_session_labelled_sse_empty_identity_is_protocol_error` and `b2mr_05_public_session_missing_mime_sse_malformed_admission_is_content_type_error` (`src/providers/openai_codex/tests/replay/joined_gates.rs:695-731`) |
| P1B2-29 | PASS | Deleted S1/S2 source and inert canary tests/example |
| P1B2-30 | PASS | Version-aware streamed repair and catalog regression tests |
| P1B2-31 | PASS | Session/cache/reader/rename/lock isolation tests |
| P1B2-32 | PASS | Complete local regression gates and unchanged dependencies |
| P1B2-33 | PASS | Six dev examples and release `conversation_offline` |
| P1B2-34 | PASS | This report and `verification.json`; 2026-09-17 initial B2MR-06 evidence repair is appended in section 14 and `acceptance_repair` |
| P1B2-35 | PASS | Complete local gates, independent reviews, and exact-head push/PR CI on Ubuntu, macOS and Windows (historical); 2026-09-17 repair: local gates and three fresh complete accumulated-diff reviews PASS; local acceptance-evidence closed on the uncommitted owner-review tree (section 14.8); current exact-head hosted CI NOT_RUN |

Detailed row assertions, test names, source paths and blockers are in `verification.json`.

## 8. Commands

All commands ran on exact source revision `80f387294c92ff0287e614a7f9c658901979352f` before this documentation/evidence-only update.

| Command | Result |
|---|---|
| `cargo fmt --all -- --check` | PASS |
| `cargo check --all-targets` | PASS |
| `cargo test --all-targets` | PASS: 692 passed, 5 ignored child helpers, 0 failed |
| `cargo clippy --all-targets -- -D warnings` | PASS |
| `cargo build --all-targets` | PASS |
| `cargo test --doc` | PASS: 0 doctests |
| `uv run scripts/verify.py` | PASS: 228 source files, 682 Rust test definitions, 25 fixture events; internal Cargo gates passed |
| `node scripts/cli_retest.mjs --self-test` | PASS: 152 tests; `live_started=false` |
| `cargo run --example run_offline` | PASS |
| `cargo run --example skills_offline` | PASS |
| `cargo run --example skill_loading_offline` | PASS |
| `cargo run --example storage_offline` | PASS |
| `cargo run --example persisted_run_offline` | PASS |
| `cargo run --example conversation_offline` | PASS |
| `cargo run --release --example conversation_offline` | PASS |
| `git diff --check` | PASS |
| Untracked trailing-whitespace scan | PASS |

The five ignored tests are closed child helpers invoked by parent process tests. They are not skipped acceptance cases.

## 9. Hosted CI

Evidence head `cc9a6a269b737a7d5b093791f9a297e07d585ec8` passed both submitted workflows:

| Event | Workflow run | Ubuntu | macOS | Windows |
|---|---:|---|---|---|
| Push | [35167416739](https://github.com/zer09/wi/actions/runs/35167416739) | PASS | PASS | PASS |
| Pull request | [35167422773](https://github.com/zer09/wi/actions/runs/35167422773) | PASS | PASS | PASS |

Each job passed `cargo fmt --all -- --check`, `cargo check --all-targets`,
`cargo test --all-targets`, `cargo clippy --all-targets -- -D warnings`,
`cargo build --all-targets`, and `cargo test --doc`. The PR was mergeable when observed.
The runner warning that `actions/checkout@v4` targets Node.js 20 was non-blocking and
GitHub forced the action to Node.js 24.

## 10. Public example observations

The final `conversation_offline` runs used synthetic roots, a synthetic identity, local SQLite, an in-process provider, real S2 loading and real `AddNumbers` effects.

| Observation | Dev | Release |
|---|---:|---:|
| A replay install | 0.027 ms | 0.010 ms |
| B replay install | 0.343 ms | 0.163 ms |
| History read after A | 21.833 ms | 11.320 ms |
| Replay prepare after A | 52.205 ms | 21.851 ms |
| History read after B | 26.458 ms | 11.468 ms |
| Replay prepare after B | 51.515 ms | 21.672 ms |
| A end-to-end | 1100.251 ms | 567.685 ms |
| B end-to-end | 757.753 ms | 411.364 ms |
| Example end-to-end | 2779.322 ms | 1462.844 ms |

Both modes recorded 48 history rows, 2 runs, 5 exchanges and 5,399 replay JSON bytes. The closed catalog/session files were 36,864/131,072 bytes with zero-byte WAL files. These are finite local samples, not an SLA or fastest claim.

## 11. First failures and fixes

1. Increment-1 review found selected runs could append activity before binding. Append and streamed repair now require canonical binding before selected-run activity while preserving valid atomic binding batches and zero-activity terminal failures.
2. Increment-1 review found catalog heads ahead of canonical history returned `Unchanged`. Regressed catalog heads now fail `storage.integrity` without catalog mutation.
3. Increment-2 review found all `run.interrupted` histories were rejected. Process-restart history may now omit `RunResult` only when each started turn is a complete closed exchange.
4. The example first failed compilation because three `PathBuf` values were borrowed. Only the example call sites changed.
5. Final coverage tracing found P1B2-11 lacked a separate-process explicit continuation observation. The added parent test uses two isolated child processes and an stdin barrier.
6. The first P1B2-11 implementation delegate exhausted its run budget after writing partial test changes. Inspection, focused execution and three independent reviews confirmed the recovered changes.
7. Final complete-diff review found normally terminal history could omit `ToolExecutionFinished` after a committed result. Reconstruction now permits that omission only when an open turn closes through `ProcessRestart`; normal terminal closure rejects it.
8. Final complete-diff review found two Markdown hard-break lines with trailing spaces after the earlier whitespace scan. The spaces were removed, and the corrected all-untracked scan found zero matches.
9. Post-commit validation found complete ordinary terminal exchanges were rejected when final `RunResult` persistence failed. Reconstruction now accepts nonempty committed `RunFinished` history only after exact terminal outcome and summary validation; empty exclusion still requires `RunResult`.
10. Remediation review found the `ToolsPrepared` terminal check accepted arbitrary non-completed outcomes. It now accepts only producer-valid `CancelledLocally` or `counter_overflow` outcomes, with focused corruption tests.
11. Post-commit validation found stale current milestone/schema documentation, stale report Git state and two stale machine-report test symbols. Current docs and both evidence reports now match the committed source revision.

The post-commit replay finding clarified the existing closed-exchanges-v1 contract; it did not widen the feature boundary.

## 12. Independent reviews

Each implementation increment received three fresh read-only reviews:

- Storage/migration/provenance: PASS after remediation.
- Replay reconstruction: PASS after process-interruption remediation.
- OpenAI identity/install/transports: PASS.
- `run_in_session` and shared-engine integration: PASS.
- `conversation_offline`: PASS.
- Fresh-process P1B2-11 test: PASS.

The first final complete-diff review inspected these reports and every untracked file. It found two blocking issues: the missing-finish policy above and report trailing whitespace. Both findings were independently reproduced and remediated. The repeated complete-diff review inspected the remediated accumulated tree, including all 33 untracked files, and all three reviewers returned PASS with no blocking findings.

After the initial implementation commit, three post-commit reviewers identified the ordinary-terminal replay policy and stale current evidence/docs. Independent verification confirmed each discrepancy. The source/current-doc remediation review found one overbroad `ToolsPrepared` outcome branch; focused remediation narrowed it. The repeated three-review gate returned PASS with no blocking findings on exact source revision `80f387294c92ff0287e614a7f9c658901979352f`.

The first final evidence review found stale current-document revision pointers. Independent verification confirmed the finding. After correction, the repeated three-review gate returned PASS with no blocking findings before evidence head `cc9a6a2` was committed and pushed.

## 13. Limits and authority

- Local verification ran on Linux x86_64. Exact-head hosted Cargo gates passed on Ubuntu, macOS and Windows.
- Process-exit and transaction-fault tests are not a physical power-loss test.
- No real credentials, profile aliases, authentication commands, private skills or live provider requests were used.
- Legacy unbound history, incomplete/uncertain tails, cross-model conversion and arbitrary imported transcripts remain unsupported for replay.
- No normal CLI session persistence, task manager, browser service, server, GUI, hosted skills, billing path, retry/failover, compaction or import/export was added.
- The no-live ledger remains **31/50 used, 19 remaining**.
- Source revision `80f3872` and hosted evidence revision `cc9a6a2` are pushed. PR #7 remains open; merge, release and deployment require separate authorization.

## 14. Acceptance repair, 2026-09-17: PR #7 B2-E01

### 14.1 Scope, revision and attribution

This section retains the initial B2MR-06 evidence repair under unchanged **p1b2.0**.
Section 14.8 records final local acceptance-evidence closure of B2-E01, not hosted CI
acceptance. The prior adapter tests directly constructed and installed
in-memory replay (`src/providers/openai_codex/tests/replay/loopback.rs:230-383`).
The prior public tests used a scripted provider
(`src/execution/tests/in_session/fixture.rs:144-155`). Their combination did not
prove the joined persisted real-adapter path. This was missing acceptance evidence,
not a reproduced product malfunction. All lower component tests and their prior
observations remain valid within that narrower scope and remain in the matrix.

**P** means parent-supplied verified execution/review evidence, not a new run by this
documentation increment. **S** means this increment's source inspection. **D** means
this increment's direct Git or report checks. The full gates, focused tests,
first failures, reviews and measurements below are P; the joined source path is S.

- Accepted baseline: `6fe0a538edf6bae39c9f933db8394b7d8483e2be`.
- Starting/reviewed HEAD: `06dae19bd885c60bd341a092a23fcd850d00fb85`.
- Source revision remains `80f387294c92ff0287e614a7f9c658901979352f`.
- Initial repair worktree was clean at the reviewed HEAD (P). This increment confirmed
  that HEAD still matches and both baseline/reviewed-HEAD ancestry checks pass (D).
- Before report edits: one tracked test file modified, two untracked test files,
  zero staged files (D). The prior reviewed test changes are preserved.
- After report edits: three tracked files modified and the same two untracked files;
  the only files changed by this increment are these two reports.
- The full local gate run covers the uncommitted repair tree based on `06dae19b`,
  before these report edits. It is not a test run on clean HEAD or a new source commit.
- `Cargo.toml` and `Cargo.lock` remain unchanged. No production source changed.
  No stage, commit, push, merge, release, deployment or hosted write is authorized here.

Test paths are `src/providers/openai_codex/tests/replay/joined.rs` and
`src/providers/openai_codex/tests/replay/joined_gates.rs`. Wiring is through
`src/providers/openai_codex/tests/replay/loopback.rs:8-9`, then
`src/providers/openai_codex/tests/replay/joined.rs:18-19`.

### 14.2 Joined executable evidence

| ID | Exact test symbol | Source |
|---|---|---|
| B2MR-01 | `b2mr_01_public_session_websocket_native_and_recovered_history` | `src/providers/openai_codex/tests/replay/joined.rs:761` |
| B2MR-02 | `b2mr_02_public_session_labelled_sse_native_and_recovered_history` | `src/providers/openai_codex/tests/replay/joined.rs:768` |
| B2MR-02 | `b2mr_02_public_session_missing_mime_sse_native_and_recovered_history` | `src/providers/openai_codex/tests/replay/joined.rs:775` |
| B2MR-03 | `b2mr_03_public_session_websocket_awaits_acceptance_binding_and_result_commits` | `src/providers/openai_codex/tests/replay/joined_gates.rs:242` |
| B2MR-03 | `b2mr_03_public_session_sse_awaits_acceptance_binding_and_result_commits` | `src/providers/openai_codex/tests/replay/joined_gates.rs:247` |
| B2MR-04 | `b2mr_04_public_session_websocket_records_actual_mismatch_and_later_matching_task` | `src/providers/openai_codex/tests/replay/joined_gates.rs:555` |
| B2MR-04 | `b2mr_04_public_session_sse_records_actual_mismatch_and_later_matching_task` | `src/providers/openai_codex/tests/replay/joined_gates.rs:560` |
| B2MR-05 | `b2mr_05_public_session_sse_wrong_explicit_mime_preserves_uncertainty` | `src/providers/openai_codex/tests/replay/joined_gates.rs:695` |
| B2MR-05 | `b2mr_05_public_session_labelled_sse_empty_identity_is_protocol_error` | `src/providers/openai_codex/tests/replay/joined_gates.rs:706` |
| B2MR-05 | `b2mr_05_public_session_missing_mime_sse_malformed_admission_is_content_type_error` | `src/providers/openai_codex/tests/replay/joined_gates.rs:726` |

The joined happy paths use public `run_in_session` for A and B, real temporary SQLite
and the real OpenAI-Codex loopback adapter. Counted `add_numbers(17,25)` produces 42;
B adds 8 and produces 50. Native-terminal and validated recovered output both pass.
Only current input enters the public submission; no test-side B replay construction
or manual installation supplies the replay under test
(`src/providers/openai_codex/tests/replay/joined.rs:521-556`). Expected wire arrays
are assertions, not injected history.

The observations include exact native/opaque output, actual selections and bindings,
actual results/finals, close/reopen/read/prepare with zero new work, an empty new
conversation and conversation isolation. WebSocket B opens a fresh connection:
its first request sends full history with no old parent; its continuation sends only
the new result with B's new parent. Labelled and missing-MIME SSE send full history
on every request. A's canonical prefix stays unchanged.

Commit barriers pause real acceptance, provider-binding and tool-result commits on
both transports. They prove no provider open before acceptance, no model payload
before binding, and no continuation before the durable result and awaited commit
completion (`src/providers/openai_codex/tests/replay/joined_gates.rs:136-238`).

Account mismatch on both transports persists the actual Y binding, then records
`history_identity` with zero attempts, admissions and tools. No model request or
fallback occurs. A later explicit X task succeeds and excludes B as
`DefinitelyUnsubmitted`, while retaining B's records
(`src/providers/openai_codex/tests/replay/joined_gates.rs:373-551`).

Failure controls run after stored A. Wrong explicit MIME yields
`unexpected_content_type`; labelled SSE with empty identity yields `protocol_error`;
missing-MIME malformed admission yields `unexpected_content_type`. All retain
`UpstreamOutcome::Unknown`, with no false success, tool effect, continuation, fallback
or mutation of A (`src/providers/openai_codex/tests/replay/joined_gates.rs:564-731`).

### 14.3 Dated dispositions and original matrix linkage

| ID | Disposition | Evidence / remaining boundary |
|---|---|---|
| B2MR-00 | PASS | Reviewed HEAD, initial clean tree, ancestry and scoped uncommitted repair inventory |
| B2MR-01 | PASS | Joined persisted WebSocket native/recovered path; P1B2-27 |
| B2MR-02 | PASS | Joined persisted labelled/missing-MIME SSE native/recovered paths; P1B2-28 |
| B2MR-03 | PASS | Real acceptance/binding/result commit gates on both transports; P1B2-25 |
| B2MR-04 | PASS | Actual mismatch and later matching task on both transports; P1B2-16 |
| B2MR-05 | PASS | Stored-history SSE failure codes and uncertainty controls; P1B2-28 |
| B2MR-06 | PASS | Initial dated repair evidence in both reports; P1B2-34 |
| B2MR-07 | PASS | Local gates and three fresh complete accumulated-diff reviews pass; local acceptance-evidence closure only (section 14.8); current exact-head hosted CI is NOT_RUN; P1B2-35 |

The original 36 IDs and historical PASS observations remain. Dated mappings for
P1B2-16/25/27/28 add joined test symbols without replacing the component symbols.
P1B2-34 gains this evidence repair. P1B2-35 gains dated local closure evidence;
its historical PASS and exact-head hosted CI observations remain unchanged.
The current repair has local review acceptance, not current hosted CI acceptance.

### 14.4 Local execution supplied by the parent

Environment: Linux `6.18.33.2-microsoft-standard-WSL2` x86_64, rustc `1.98.1`, cargo
`1.98.1`, uv `0.12.10`, Node `v24.18.0`, bundled SQLite `3.51.3`.

| Command / check (P) | Result |
|---|---|
| Cargo test filter `b2mr_` | PASS: 10 passed, 0 failed |
| Full replay loopback module | PASS: 18 passed |
| `cargo fmt --all -- --check` | PASS |
| `cargo check --all-targets` | PASS |
| `cargo test --all-targets` | PASS: 702 passed, 5 ignored closed child helpers, 0 failed |
| `cargo clippy --all-targets -- -D warnings` | PASS |
| `cargo build --all-targets` | PASS |
| `cargo test --doc` | PASS: 0 doctests |
| `uv run scripts/verify.py` | PASS: 230 source files, 692 Rust test definitions, 25 fixture events; internal gates passed |
| `node scripts/cli_retest.mjs --self-test` | PASS: 152; `live_started=false` |
| `cargo run --example run_offline` | PASS |
| `cargo run --example skills_offline` | PASS |
| `cargo run --example skill_loading_offline` | PASS |
| `cargo run --example storage_offline` | PASS |
| `cargo run --example persisted_run_offline` | PASS |
| `cargo run --example conversation_offline` | PASS |
| `cargo run --release --example conversation_offline` | PASS |
| `git diff --check` | PASS |
| All-untracked whitespace scan | PASS |

The parent supplied filters/counts, not the exact invocation flags for the two
focused runs. This increment does not invent those flags or rerun the full gates.
Source definitions, filtered reruns, examples and child helpers are not additional
unique tests. Zero doctests contributes no extra coverage.

### 14.5 First failures, reviews and hosted status

1. Repair increment 1's first `cargo fmt --all -- --check` failed only on formatting
   in new test code. `cargo fmt` corrected it; the subsequent check passed (P).
2. Repair increment 2's first compilation failed because test-only request reuse
   moved a value. Cloning the request fixed compilation (P).

No joined test exposed a production defect. No production fix was made. These
observations append to, rather than replace, the first failures in section 11.

Three independent reviewers passed increment 1 (B2MR-01/02) with no blocking findings.
Three passed increment 2 (B2MR-03/04/05) with no blocking findings. Reviewers inspected
untracked files and ran focused/module/fmt/clippy/diff checks; one also ran the full
all-target gates (P). These remain increment reviews. Three fresh reviewers have
since passed the complete accumulated diff, including these updated reports and
both untracked test files, with no blocking findings (P; section 14.8).

Current exact-head hosted CI is **NOT RUN** because the repair is uncommitted and no
commit/push is authorized. Earlier jobs at reviewed HEAD `06dae19b` are pre-repair
evidence only; their job IDs were not supplied in this increment. The exact
`cc9a6a2` push/PR jobs and cross-platform outcomes in section 9 remain historical
and unchanged. No old job is evidence for the uncommitted joined tests or reports.
B2-E01 local acceptance evidence is closed as recorded in section 14.8; current
exact-head hosted acceptance is not claimed.

### 14.6 Finite conversation example samples (P)

| Observation | Dev | Release |
|---|---:|---:|
| A replay install | 0.039 ms | 0.010 ms |
| A end-to-end | 1931.835 ms | 989.066 ms |
| History read after A | 50.145 ms | 16.450 ms |
| Replay prepare after A | 86.864 ms | 39.258 ms |
| B replay install | 1.135 ms | 0.116 ms |
| B end-to-end | 1496.015 ms | 533.670 ms |
| History read after B | 62.612 ms | 28.497 ms |
| Replay prepare after B | 113.810 ms | 45.850 ms |
| Example end-to-end | 5368.014 ms | 2413.889 ms |

Both modes recorded 48 rows, 2 runs, 5 exchanges and 5,399 replay bytes. Closed
catalog/session sizes were 36,864/131,072 bytes, with zero WAL bytes. These are finite
local samples, not an SLA, performance regression verdict or fastest claim.

### 14.7 Report checks, limits and authority

Increment-3 report checks (D): **PASS**.

| Check | Result |
|---|---|
| `uv run python -m json.tool docs/slices/p1b2/verification.json /dev/null` | PASS: parse/format validation |
| Read-only Node JSON round-trip and historical-evidence checks | PASS: all 36 rows, original fields, component tests, first failures, revisions and hosted evidence preserved; all 10 joined test symbols mapped |
| `cargo fmt --all -- --check` | PASS |
| `git diff --check` | PASS |
| Node whitespace scan of all `git ls-files --others --exclude-standard -z` paths | PASS: 2 files; no trailing whitespace, space-before-tab or blank-EOF errors |
| Reviewed test SHA-256, Git index and changed-path checks | PASS: test bytes unchanged, index empty, only the two authorized reports changed by this increment; Cargo files unchanged |

Linux local results do not establish current repair coverage on native macOS or
Windows. Process/reopen evidence is not physical power-loss proof. Live opaque
portability and model adherence remain NOT RUN. Legacy unbound history,
incomplete/uncertain tails and cross-model conversion remain unsupported.

Real credential reads = **0**; live/provider generations = **0**, excluding synthetic
scripted/loopback work. No real profiles/private skills or authentication commands
were used. The ledger remains **31/50 used, 19 remaining**, unchanged. This evidence
repair adds no runtime behavior, dependency, retry/failover or later increment.
Separately authorized commit/push and then exact-head cross-platform CI remain deferred.
All changes remain unstaged and uncommitted for owner review.

### 14.8 Complete-diff review and local closure, 2026-09-17

Three fresh independent reviewers inspected the complete accumulated uncommitted
diff based on `06dae19bd885c60bd341a092a23fcd850d00fb85`, including both untracked
test files and the dated report additions. All returned **PASS** with no blocking
findings (P). This closure increment records their supplied results; it did not
start reviewers or rerun their test suites.

All three confirmed the joined public/SQLite/OpenAI/tool path and canonical
storage-fed replay described in section 14.2. Their review covered WS/SSE native
and recovered output, MIME controls, close/reopen, isolation, real durable gates,
both-transport mismatch binding/no-send/later X exclusion, failure classifications
and uncertainty. They confirmed no production, Cargo, public API or schema change;
all 36 historical rows, prior evidence, first failures and the ledger remain preserved.

| Reviewer (P) | Independent checks | Result |
|---|---|---|
| review-a | `cargo fmt --all -- --check`; JSON validation; `git diff --check`; all-untracked whitespace scan; mechanical report checks | PASS; no blocking findings |
| review-b | `cargo fmt --all -- --check`; JSON validation; `git diff --check`; all-untracked whitespace scan; mechanical report checks | PASS; no blocking findings |
| review-c | `cargo test --lib b2mr_`: 10 passed; `cargo test --lib replay_loopback_tests`: 18 passed; `cargo fmt --all -- --check`; JSON validation; `git diff --check`; all-untracked whitespace scan; SHA linkage and ancestry/index checks | PASS; no blocking findings |

Review-c noted only that the reports had not yet recorded this completed review
and that the historical top-level PASS was explicitly scoped separately from the
repair. This update records completion. The focused command flags above belong
to review-c's independent reruns, not the original parent runs in section 14.4.

**B2MR-07: PASS. B2-E01: accepted and closed locally for acceptance evidence.**
Closure applies only to the uncommitted owner-review tree. It is subject to separately
authorized commit/push and then exact-head push/PR CI on Ubuntu, macOS and Windows.
Current exact-head hosted CI remains **NOT_RUN** because commit/push was not authorized.
No historical hosted result is relabeled. No native macOS/Windows execution is claimed
for this repair. Real credential reads and live provider generations remain **0**;
the ledger remains **31/50 used, 19 remaining**. No production change or V1 work was added.

## 15. Test timeout portability remediation, 2026-09-17

### 15.1 Exact-head hosted observation (P)

The parent supplied verified hosted observations at exact committed SHA
`80290a8636ef27d3b3cd920ac12f601fb2d7b6ca`. These observations follow the local
closure in section 14; its then-current uncommitted/NOT_RUN statements remain
historical. This remediation did not query, rerun or write hosted CI.

| Event | Workflow run | Ubuntu | macOS | Windows |
|---|---:|---|---|---|
| Push | [35217888199](https://github.com/zer09/wi/actions/runs/35217888199) | PASS | PASS | FAIL |
| Pull request | [35217892116](https://github.com/zer09/wi/actions/runs/35217892116) | PASS | PASS | PASS |

Push Windows job [105190612330](https://github.com/zer09/wi/actions/runs/35217888199/job/105190612330)
failed `cargo test --all-targets`: two B2MR-05 cases reached the 20-second test-local
outer watchdog and panicked at `src/providers/openai_codex/tests/replay/joined_gates.rs:286`.
The Windows test summary was **389 passed, 2 failed, 5 ignored**. Later Clippy, build
and doctest gates were skipped. The PR workflow at the same SHA passed all six Cargo
gates on Ubuntu, macOS and Windows; its Windows test summary was
**391 passed, 0 failed, 5 ignored**. These summaries are not additional unique tests.

Verification classified the first exact-head push failure as a **test timeout
portability defect, not a production defect**. The existing failing B2MR-05 cases
supply the regression evidence; no new semantic test or production fix is required.

### 15.2 Minimal correction and revision linkage (D)

The initial worktree was clean at the exact SHA above. The only code change is
`failed_execution` at `src/providers/openai_codex/tests/replay/joined_gates.rs:272`:
its outer `tokio::time::timeout` increases from **20 to 60 seconds**. Every semantic
assertion remains unchanged. Production/session/provider/storage deadlines, error
behavior, workflow concurrency and Cargo files remain unchanged.

SHA-256 for `src/providers/openai_codex/tests/replay/joined_gates.rs`:

- Committed 20-second version: `4c6e06d6097ae07bfb9f8318eeff2878106f5446165a2424744833d9d7607982`.
- Current uncommitted 60-second version: `cbd8bd97c79c060c900c4e8c9c1d761cfbc744fb21900a426e501ecb024f7579`.

The machine report retains the historical `preserved_test_sha256` values and records
current linkage in `timeout_portability_remediation.test_file_sha256`. All 36 prior
matrix rows and the prior local closure evidence remain unchanged. Only this test
file and the two current evidence reports are modified; all three remain unstaged
and uncommitted, with no untracked files.

### 15.3 Required local checks (D)

Checks ran once each on the uncommitted remediation based on the exact SHA above,
in `/home/gc/projects/wi`, on Linux `6.18.33.2-microsoft-standard-WSL2` x86_64 with
rustc/cargo `1.98.1`. Cargo commands used `env -i`, inherited trusted `PATH`,
`CARGO_HOME` and `RUSTUP_HOME`, and `CARGO_NET_OFFLINE=true`. Synthetic `HOME`,
`XDG_CONFIG_HOME`, `CODEX_HOME` and `TMPDIR` were under
`/tmp/wi-b2e01-timeout.iZlelA`; no credential or endpoint variables were inherited.

| Command / check | Result |
|---|---|
| `cargo test --lib providers::openai_codex::tests::replay_loopback_tests::joined::gates::b2mr_05_public_session_sse_wrong_explicit_mime_preserves_uncertainty -- --exact` | PASS: exactly 1 selected, 1 passed, 0 failed, 0 ignored; 2.37 s |
| `cargo test --lib providers::openai_codex::tests::replay_loopback_tests::joined::gates::b2mr_05_public_session_labelled_sse_empty_identity_is_protocol_error -- --exact` | PASS: exactly 1 selected, 1 passed, 0 failed, 0 ignored; 5.53 s |
| `cargo test --lib providers::openai_codex::tests::replay_loopback_tests::joined::gates::b2mr_05_public_session_missing_mime_sse_malformed_admission_is_content_type_error -- --exact` | PASS: exactly 1 selected, 1 passed, 0 failed, 0 ignored; 4.99 s |
| `cargo test --lib replay_loopback_tests` | PASS: 18 passed, 0 failed, 0 ignored; 12.99 s |
| `cargo fmt --all -- --check` | PASS |
| `uv run python -m json.tool docs/slices/p1b2/verification.json /dev/null` | PASS |
| `git diff --check` | PASS |
| Node whitespace scan using `git ls-files -z` and `git ls-files --others --exclude-standard -z` | PASS: tracked text files and all nonignored untracked files; no trailing whitespace, space-before-tab or blank-EOF errors; 0 untracked files |
| Node historical-evidence, exact code-diff, SHA linkage and changed-path checks | PASS: all 36 rows and prior closure preserved; only the authorized three paths changed; index unchanged |

Test-name discovery used `cargo test --lib b2mr_05 -- --list` and listed exactly three
tests. Focused reruns and the module run are overlapping coverage, not new unique tests.
The required checks had no local failures or retries. Full all-target gates were not
rerun for this narrow remediation; their earlier local evidence remains in section 14.

### 15.4 Remaining boundary

New remediation exact-head hosted CI is **NOT_RUN** until separately authorized
commit/push. The passing PR workflow does not erase the failed push workflow or
cover the uncommitted watchdog change. No all-green exact-head hosted closure is
claimed. Native Windows/macOS execution of this remediation remains unverified locally.

No production behavior changed. No stage, commit, push, hosted write, PR transition,
merge, deployment, auth command or live provider traffic occurred. Real credential
reads and live provider generations remain **0**. The ledger remains
**31/50 used, 19 remaining**, unchanged.
