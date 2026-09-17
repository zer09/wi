# P1-B2 verification

Contract: **p1b2.0**
Result: **PASS**
Accepted: **Yes under p1b2.0. PR #7 remains open; merge, release and deployment were not authorized.**

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
| P1B2-16 | PASS | Actual mismatched binding before zero-attempt failure |
| P1B2-17 | PASS | Provider/model/format/missing-identity boundaries |
| P1B2-18 | PASS | Install atomicity and install/generate/cancel/drop races |
| P1B2-19 | PASS | Complete interrupted batch and final-response child processes |
| P1B2-20 | PASS | Partial/uncertain/malformed history rejection tests |
| P1B2-21 | PASS | Proved zero-attempt structural exclusion tests |
| P1B2-22 | PASS | Legacy unbound readable-but-not-replayable fixture |
| P1B2-23 | PASS | Receipt-first and two-absent-lookup races |
| P1B2-24 | PASS | Separate new-input and combined-context capacity tests |
| P1B2-25 | PASS | Selection/binding SQL faults, cancellation and certainty tests |
| P1B2-26 | PASS | Hold/close/drop/process ownership tests |
| P1B2-27 | PASS | Exact WebSocket loopback request bodies |
| P1B2-28 | PASS | Exact labelled/missing-MIME SSE request bodies |
| P1B2-29 | PASS | Deleted S1/S2 source and inert canary tests/example |
| P1B2-30 | PASS | Version-aware streamed repair and catalog regression tests |
| P1B2-31 | PASS | Session/cache/reader/rename/lock isolation tests |
| P1B2-32 | PASS | Complete local regression gates and unchanged dependencies |
| P1B2-33 | PASS | Six dev examples and release `conversation_offline` |
| P1B2-34 | PASS | This report and `verification.json` |
| P1B2-35 | PASS | Complete local gates, independent reviews, and exact-head push/PR CI on Ubuntu, macOS and Windows |

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
