# Wi V1-A verification

Contract: **v1a.0**. Status: **ACCEPTED**. Accepted: **true**. Hosted CI: **PASS**.

V1-A is complete and accepted at implementation head
`fad3855db70ff4151a5c27ec3f64d04fa9097cbb` (`feat: add service-owned execution host`).
Exact-head push **35320097103** and pull-request **35320100396** passed all six Cargo
steps on Ubuntu/macOS/Windows. V1A-29 is PASS with no blockers. Both runs and all six
jobs are recorded below and in [verification.json](verification.json).

Local G01-G17 and independent complete-diff reviews remain attributed to their
historical pre-commit snapshots. Three reviews passed before documentation alignment;
three later reviewers passed the aligned documentation after remediation. The authorized
implementation commit and push followed those snapshots. During acceptance preparation,
PR #8 was observed **open and draft, not merged**.

This docs-only acceptance record documents fixed evidence for the implementation revision
above, not CI for documentation-only descendants. Current PR-head merge checks are external
GitHub merge-readiness evidence, separate from this fixed implementation evidence.
This record asserts no current PR-head CI result. Acceptance-record preparation and
remediation changed no source, tests or configuration and performed no staging, commit,
push, PR transition or live request.

## 1. Revision, environment and preservation

| Item | Actual observation |
|---|---|
| Accepted baseline | `50f4dffe5d912615014edc46cf1bf1e1b68e6857` |
| Tested implementation revision | `fad3855db70ff4151a5c27ec3f64d04fa9097cbb`; both exact-head hosted workflows passed |
| Ancestry | Implementation parent is planning commit `a013e77f4fafa7834b14b98b7a17ab9f89a4eb69`; its parent is the accepted baseline |
| Historical local-verification HEAD | `a013e77f4fafa7834b14b98b7a17ab9f89a4eb69` plus the then-uncommitted implementation |
| Historical initial worktree | 12 modified tracked paths, 15 untracked paths, zero staged paths |
| Historical final pre-commit worktree | 19 modified tracked paths and 17 untracked files, including the two reports; zero staged paths |
| Historical tracked diff | 381 insertions, 171 deletions in 19 files; includes seven documentation-alignment files and excludes then-untracked files |
| Acceptance-record starting tree | Clean at `fad3855db70ff4151a5c27ec3f64d04fa9097cbb`; preparation and remediation edit only the eight allowed docs/reports listed in section 8 |
| Local verification date | 2026-09-18, local clock UTC+08:00 |
| OS | openSUSE 20260902.0.0, WSL2 x86_64 Linux, kernel `6.18.33.2-microsoft-standard-WSL2` |
| Rust | `rustc 1.98.1 (48a229cea 2026-09-01)`, LLVM 22.1.8, `x86_64-unknown-linux-gnu` |
| Cargo | `cargo 1.98.1 (797e8a9bc 2026-08-05)` |
| Other tools | uv 0.12.10; Node v24.18.0; Git 2.55.0 |
| Toolchain selection | Repository `rust-toolchain.toml`: stable, minimal, rustfmt and clippy |
| Build context | Existing `target` caches; no `CARGO_TARGET_DIR`, `CARGO_BUILD_TARGET` or `RUSTFLAGS` override |
| Dependencies and CI | `Cargo.toml`, `Cargo.lock`, toolchain and `.github` unchanged by implementation and acceptance-record edits |
| Storage versions | Session DB 2, catalog 1, stored envelope 1, runtime event 2, provider event 1 remain unchanged |

### Historical pre-commit review identity

The post-documentation-alignment review snapshot protected **342** tracked/untracked
nonignored files, excluding only these two reports:

- SHA-256: `995851188f598a10ed8664a4733836162d5e1a006519f6606aeec057ee737394`
- Index SHA-256: `8bd4c84e86a4c98a02c477f9b8578b8664387a75673c826e8bcc52730a861c85`

The file fingerprint hashes sorted unique UTF-8 paths from
`git ls-files --cached --others --exclude-standard -z`. For each path, it hashes the
path, NUL, exact file bytes, NUL. The index fingerprint hashes the exact output of
`git ls-files --stage -z`. Excluding the reports avoids a self-referential hash.
These fingerprints and the dirty-path lists describe the historical pre-commit snapshot,
not the current committed tree or this docs-only acceptance-record increment. The earlier review hash
`8631ae894d298200632e4c0326ebb61deaf37b2aa1a94b4920294382b041e338` remains in section 6.
The consistency check validates snapshot metadata without requiring the old dirty state
or computing a recursive report hash. Hosted evidence identifies the committed
implementation by `fad3855db70ff4151a5c27ec3f64d04fa9097cbb`.

Historical preserved modified source paths:

- `src/execution/mod.rs`
- `src/execution/replay.rs`
- `src/execution/tests/in_session.rs`
- `src/execution/tests/in_session/fixture.rs`
- `src/execution/tests/mod.rs`
- `src/execution/tests/process.rs`
- `src/execution/tests/process/harness.rs`
- `src/lib.rs`
- `src/providers/openai_codex/tests/replay/joined.rs`
- `src/providers/openai_codex/tests/replay/joined_gates.rs`
- `src/storage/session.rs`
- `src/storage/test_hooks.rs`

Historical preserved untracked source/example paths:

- `examples/host_offline.rs`
- `src/execution/tests/in_session/notifier.rs`
- `src/providers/openai_codex/tests/replay/joined_host.rs`
- `src/service/mod.rs`
- `src/service/tests/admission.rs`
- `src/service/tests/b2.rs`
- `src/service/tests/boundaries.rs`
- `src/service/tests/execution.rs`
- `src/service/tests/fixture.rs`
- `src/service/tests/loss.rs`
- `src/service/tests/mod.rs`
- `src/service/tests/replay.rs`
- `src/service/tests/storage.rs`
- `src/service/tickets.rs`
- `src/service/types.rs`

The manifest Git blob is `0efc2415ffb8dfea4ac622bd0588474119a9b96e`.
The lockfile Git blob is `c45b5f3cd363714cab039a83a3a4bd610690b9ef`.
Locked runtime facilities include Tokio 1.53.1, tokio-util 0.7.19 with existing `rt`,
futures-util 0.3.34 and SQLx 0.9.0. Transport versions remain reqwest 0.13.4,
tokio-tungstenite 0.28.0 and rustls 0.23.44. The JSON records every direct locked dependency.
No dependency or feature upgrade occurred.

The storage example observed bundled SQLite 3.51.3, source ID
`2026-03-13 10:38:09 737ae4a34738ffa0c3ff7f9bb18df914dd1cad163f28fd6b6e114a344fe6d618`.
Probe settings were WAL, synchronous=FULL, foreign_keys=ON, trusted_schema=OFF,
busy_timeout=0 and shared_cache=false.

## 2. Evidence attribution and implemented boundary

- **D**: the original local verification increment's commands and consistency checks
  on the historical pre-commit worktree.
- **S**: source, configuration, ancestry and worktree inspection at the recorded stages.
- **P**: retained parent/delegate completion and review evidence, inspected locally.
  P is not relabeled as a new independent run.
- **H**: frozen historical reports and V1-A VALIDATION, not current V1-A CI.
- **C**: parent-supplied verified exact-head hosted run/job/step evidence and the historical
  PR observation during acceptance preparation. This docs-only increment did not
  independently fetch hosted evidence.
- **A**: local documentation checks in this acceptance-record increment, not new Cargo,
  hosted or live executions.

The accepted foundation remains P1-A/B1/B2, C1/S1/S2 and R1/NB-02. See the unchanged
[P1-A report](../p1a/VERIFICATION.md), [B1 report](../p1b1/VERIFICATION.md),
[B2 report](../p1b2/VERIFICATION.md) and [V1-A validation ledger](VALIDATION.md).
B2-E01 closed the joined execution evidence gap in merged PR #7. It did not implement
a service owner. Earlier report statements remain historical observations.

The current source adds an **in-process** owner, not a network service:

- `src/service/mod.rs:29-109`: non-Clone `RunHost`, weak clients, captured runtime,
  explicit dispatch and owner shutdown. Client/ticket lifetime does not own execution.
- `src/service/mod.rs:137-248`: register under the admission gate, spawn outside it,
  and drain the tracker before closing storage. The shutdown coordinator is outside
  the tracker it waits on.
- `src/execution/mod.rs:164-221`: the private notifier runs only after successful
  `check_commit`, including both duplicate branches, before the fallible duplicate read
  or shared admitted engine. Public `run_in_session` and `run_persisted` remain unchanged.
- `src/service/tickets.rs:49-108`: retained write-once receipt/completion state uses
  `send_modify`; a late acceptance waiter prefers the real receipt over a later failure.
- `src/service/mod.rs:252-314`: worker and coordinator drop guards report loss without
  inventing execution success, rollback or terminal SQL. Existing quarantine remains.

Dispatch, durable acceptance and actual completion are separate observations.
Cancellation means signalling the currently tracked session/run pair, not durable stop
or upstream rollback. No second loop, task queue, result-history cache, schema migration,
provider/auth/tool behavior change, fallback, retry or automatic resumption was added.
The fixture sharing and barriers in storage/execution are test-only.

## 3. Required command outcomes

G01-G17 are retained pre-commit verification evidence, not reruns by this docs-only
increment. Every requested top-level command ran **once** and passed. Before G01-G06, six timing
wrapper launches failed because `/usr/bin/time` is absent. They started no Cargo command.
After that diagnosed wrapper correction, G01-G06 each ran directly once.

The required `uv run scripts/verify.py` itself invokes all six Cargo gates
(`scripts/verify.py:53-66`). Those internal executions are separately reported, not
hidden retries or additional distinct tests. No source correction occurred in this increment.

| ID | Exact command | Result |
|---|---|---|
| G01 | `cargo fmt --all -- --check` | PASS, exit 0 |
| G02 | `cargo check --all-targets` | PASS, exit 0 |
| G03 | `cargo test --all-targets` | PASS, exit 0; 750 passed, 0 failed, 6 ignored child helpers |
| G04 | `cargo clippy --all-targets -- -D warnings` | PASS, exit 0 |
| G05 | `cargo build --all-targets` | PASS, exit 0 |
| G06 | `cargo test --doc` | PASS, exit 0; 0 doctests |
| G07 | `uv run scripts/verify.py` | PASS, exit 0; 245 source files, 740 regex-counted definitions, 25 fixture events; six internal Cargo gates passed |
| G08 | `node scripts/cli_retest.mjs --self-test` | PASS, exit 0; 152 tests, live_started=false |
| G09 | `cargo run --example run_offline` | PASS, exit 0; 1 scripted session, 3 requests, 2 real tool executions |
| G10 | `cargo run --example skills_offline` | PASS, exit 0; 2 catalog entries, 1 active skill, 1 session, 2 requests, 1 tool execution |
| G11 | `cargo run --example skill_loading_offline` | PASS, exit 0; 1 session, 2 requests, 1 load_skill execution |
| G12 | `cargo run --example storage_offline` | PASS, exit 0; 3 finite samples and real registry executions, supplied DTO traces, zero provider work |
| G13 | `cargo run --example persisted_run_offline` | PASS, exit 0; 16 stored records, 1 open, 2 requests, 1 AddNumbers effect, 0 retries; no-work reopen |
| G14 | `cargo run --example conversation_offline` | PASS, exit 0; 2 explicit runs, 2 sessions, 5 requests, 1 load_skill and 2 add_numbers dispatches |
| G15 | `cargo run --example host_offline` | PASS, exit 0; public host A/B, observer loss, cancellation and shutdown |
| G16 | `cargo run --release --example host_offline` | PASS, exit 0; same finite public-host assertions |
| G17 | `git diff --check` | PASS, exit 0; before report creation, with unchanged tracked source afterward |

At that historical snapshot, staged whitespace inspection was clean and the index was
unchanged. The original consistency check inspected all 17 then-untracked files,
including both reports. Current acceptance-record checks are listed in section 8.

### Actual test counts

The direct G03 pass and G07's internal all-target pass each had these counts:

| Target | Passed | Ignored |
|---|---:|---:|
| `src/lib.rs` | 486 | 6 |
| `src/main.rs` | 52 | 0 |
| `tests/context_catalog.rs` | 28 | 0 |
| `tests/context_prepare.rs` | 26 | 0 |
| `tests/managed_absence_cli.rs` | 1 | 0 |
| `tests/provider_contract.rs` | 6 | 0 |
| `tests/run_cli.rs` | 6 | 0 |
| `tests/run_controller.rs` | 39 | 0 |
| `tests/skill_loading.rs` | 20 | 0 |
| `tests/skills_cli.rs` | 11 | 0 |
| `tests/storage.rs` | 74 | 0 |
| `examples/host_offline.rs` | 1 | 0 |
| **Total per pass** | **750** | **6** |

Other example test harnesses ran zero tests. Required `--all-targets` included the
zero-test `two_turns` harness, but did not invoke its main. No `two_turns`, smoke, live
or auth CLI operation ran. Existing synthetic auth/smoke unit tests remain in the suite.
Expected `synthetic failure` fixture stderr appeared without a failing test.

The six ignored entry points are closed child helpers explicitly driven by parent tests:
`replay_interruption_child`, `p1b2_11_child`, `execution_child`, `host_loss_child`,
`migration_child` and `storage_child`. They are not six omitted acceptance cases.
Child executions and repeated suite passes are not added to the distinct parent count.

V1-A subsets were 34 service parent tests, five notifier tests, eight joined host
transport tests and one S2 example test. The S2 test runs six internal combinations.
The 740 source definitions are a regex inventory, not a runtime test count.

Observed target durations, seconds: G03 library 99.76, storage 18.04, S2 example test
31.66; G07 library 104.10, storage 17.29, S2 example test 33.64. No watchdog failed in
these final executions. These durations are not test deadlines or performance guarantees.

## 4. All30 matrix

`PASS_LOCAL` means a completed row with local/source evidence, not a blocker or live
proof. V1A-29 is `PASS`: local reviews/gates and both exact-head hosted workflows passed.
All 30 rows are complete; hosted acceptance applies to the implementation head above.
Commands refer to the exact invocations above. Tests below identify principal evidence;
[verification.json](verification.json) retains the expanded named-test mapping.
Source references use repository-relative paths and current line numbers.

| ID | Status | Assertions | Tests | Commands | Source | Observer | Blockers |
|---|---|---|---|---|---|---|---|
| V1A-00 | PASS_LOCAL | Baseline ancestry, historical dirty lists/fingerprints, toolchain/dependencies, frozen evidence and ledger preserved. | Inventory and fingerprint checks; no separate test | G01-G07, G17 | `AGENTS.md:1`; `Cargo.toml:1`; `VALIDATION.md:7-21` | D/S/H | None |
| V1A-01 | PASS_LOCAL | Additive API, weak clients, passive Send+Sync handles, no-work construction and unavailable-runtime error. | `public_types_and_static_errors`; `construction_outside_runtime_is_unavailable` | G02, G03, G07 | `src/service/mod.rs:29-109`; `src/service/tests/mod.rs:64-123` | D/S | None |
| V1A-02 | PASS_LOCAL | Gate registration precedes spawn; registered gap drains; rejection destroys guards outside gate. | `registered_before_spawn_is_cancelled_and_drained_by_shutdown`; `concurrent_dispatch_and_shutdown_share_one_registration_gate` | G03, G07 | `src/service/mod.rs:137-248`; `src/service/tests/mod.rs:187-227`; `src/service/tests/admission.rs:94` | D/S | None |
| V1A-03 | PASS_LOCAL | Real precommit receipt wait; exact unwarned receipt before completion, first replay empty. | `notifier_waits_for_unwarned_commit_and_precedes_completion`; `v1a_21_host_websocket_awaits_acceptance_binding_and_result_commits` | G03, G07 | `src/execution/mod.rs:164-228`; `src/execution/tests/in_session/notifier.rs:4-58`; `src/providers/openai_codex/tests/replay/joined_host.rs:251-340` | D/S | None |
| V1A-04 | PASS_LOCAL | All acceptance/completion waiters, tickets and clients can disappear; real final output still commits without sink error. | `dispatch_receipt_and_completion_are_distinct_and_observers_can_disappear`; `independent_reader_and_rename_see_partial_text_and_real_tool_output` | G03, G07, G15 | `src/service/tests/execution.rs:24-105`; `src/service/tests/replay.rs:7-102` | D/S | None |
| V1A-05 | PASS_LOCAL | Active/completed/reopened/cancelled duplicate receipt precedence; changed input/method/run conflicts; both notifier branches before read. | `completed_and_reopened_duplicates_ignore_current_checks_but_not_identity`; `notifier_late_duplicate_precedes_fallible_record_read_after_absent_lookups` | G03, G07 | `src/service/tests/storage.rs:168-238`; `src/execution/tests/in_session/notifier.rs:61-193` | D/S | None |
| V1A-06 | PASS_LOCAL | Both absent receipts yield one executor/duplicate; competing real storage acceptance prevents host generation. | `both_absent_host_receipts_yield_one_executor_and_one_duplicate`; `direct_storage_acceptance_wins_host_lookup_and_late_acceptance_races` | G03, G07 | `src/service/tests/storage.rs:64-165`; `src/storage/session.rs:380-405` | D/S | None |
| V1A-07 | PASS_LOCAL | Active-session new request fails existing B2 History checks, never queues; independent session progresses. | `active_session_rejects_new_work_without_queueing_independent_session` | G03, G07 | `src/service/tests/storage.rs:6-61` | D/S | None |
| V1A-08 | PASS_LOCAL | Cancel matches both IDs; unknown/repeated signals do not affect other sessions or rewrite selected completion. | `cancellation_matches_session_and_run_without_stopping_other_work`; `cancellation_during_sql_awaits_same_future_and_keeps_real_results` | G03, G07, G15-G16 | `src/service/mod.rs:113-129`; `src/service/tests/execution.rs:163-229`; `src/service/tests/boundaries.rs:137-259` | D/S | None |
| V1A-09 | PASS_LOCAL | Admission/open/model/tool/SQL cancellation keeps same future, real effects and truthful upstream/result state. | `cancel_before_pure_admission_leaves_no_receipt_or_execution`; `cancellation_during_provider_open_model_wait_and_cooperative_tool_is_truthful`; `cancellation_during_sql_awaits_same_future_and_keeps_real_results` | G03, G07 | `src/service/tests/boundaries.rs:7-259`; `src/execution/mod.rs:224-238` | D/S | None |
| V1A-10 | PASS_LOCAL | Actual failure stages/receipts retained; no notification for warned/unknown acceptance; later failure keeps receipt; final cleanup warning stays Executed. | `opening_and_acceptance_failures_preserve_actual_completion`; `accepted_receipt_survives_later_recording_failure`; `notifier_skips_failed_unknown_and_warned_acceptance` | G03, G07 | `src/service/tests/execution.rs:335-439`; `src/service/tests/boundaries.rs:269-520`; `src/execution/tests/in_session/notifier.rs:196-248` | D/S | None |
| V1A-11 | PASS_LOCAL | Once-only close admission, cancel, drain then close storage; final records commit during drain. | `shutdown_is_once_only_and_drains_final_sql_after_all_waiters_drop` | G03, G07, G15 | `src/service/mod.rs:207-248`; `src/service/tests/execution.rs:290-332` | D/S | None |
| V1A-12 | PASS_LOCAL | Acceptance/result/final SQL with normal, lost-reply and cleanup-warning cases preserves certainty; lease remains held until drain. | `shutdown_during_acceptance_result_and_final_sql_preserves_certainty_and_drain` | G03, G07 | `src/service/tests/boundaries.rs:269-458` | D/S | None |
| V1A-13 | PASS_LOCAL | Concurrent and dropped shutdown waiters share one coordinator/outcome; no self-tracking or close retry. | `shutdown_is_once_only_and_drains_final_sql_after_all_waiters_drop`; `shutdown_during_acceptance_result_and_final_sql_preserves_certainty_and_drain` | G03, G07 | `src/service/mod.rs:217-248`; `src/service/tests/execution.rs:290-332` | D/S | None |
| V1A-14 | PASS_LOCAL | Client/ticket Drop is passive; owner Drop starts shutdown and surviving clients reject submission. | `owner_drop_starts_shutdown_but_clients_and_tickets_are_passive` | G03, G07 | `src/service/mod.rs:92-95`; `src/service/tests/execution.rs:232-287` | D/S | None |
| V1A-15 | PASS_LOCAL | Isolated unwinds/unpolled drops resolve WorkerLost; no fake terminal; sibling keeps real failure; quarantine retains lease. | `provider_tool_and_sql_worker_unwinds_and_unpolled_drop_are_isolated`; `dropped_unpolled_worker_fails_closed_and_cancels_siblings` | G03, G07 | `src/service/mod.rs:252-314`; `src/service/tests/loss.rs:53-189,368-493` | D/S | None |
| V1A-16 | PASS_LOCAL | Runtime/process exits at four phases preserve committed evidence; new host/read/duplicate never auto-resumes. | `runtime_destruction_preserves_accepted_model_tool_and_result_prefixes`; `process_exit_preserves_accepted_model_tool_and_result_prefixes` | G03, G07 | `src/service/tests/loss.rs:191-357,496-523` | D/S | None; no physical power-loss guarantee |
| V1A-17 | PASS_LOCAL | Zero-receiver retained state, write-once receipt/completion, stable late/multiple waiters and Send futures. | `ticket_state_is_retained_write_once_and_waiters_are_send`; `concurrent_receipt_and_completion_waiters_share_stable_terminal_arc` | G03, G07 | `src/service/tickets.rs:49-108`; `src/service/tests/mod.rs:126-184`; `src/service/tests/storage.rs:241-291` | D/S | None |
| V1A-18 | PASS_LOCAL | Twelve finite submissions retire all entries; retained tickets release gateway/store/tool/lease ownership. | `finite_submissions_retire_entries_and_retained_tickets_release_resources` | G03, G07, G15-G16 | `src/service/tests/storage.rs:294-359` | D/S | None |
| V1A-19 | PASS_LOCAL | Independent short history reads see partial text/real tool output before continuation; rename during provider wait succeeds. | `independent_reader_and_rename_see_partial_text_and_real_tool_output` | G03, G07, G15 | `src/service/tests/replay.rs:7-102` | D/S | None |
| V1A-20 | PASS_LOCAL | Explicit B after no-work reopen restores saved A only; incomplete/unbound history stays readable and fails without repair. | `explicit_b_after_host_shutdown_and_reopen_restores_only_saved_a`; `incomplete_and_legacy_unbound_histories_remain_readable_without_repair` | G03, G07, G15-G16 | `src/service/tests/replay.rs:105-332` | D/S | None |
| V1A-21 | PASS_LOCAL | Real host/B2/SQLite/WS/tool A/B, native/recovered data, fresh full context then new delta/parent; commit barriers. | `v1a_21_host_websocket_native_and_recovered_history_after_ticket_drop`; `v1a_21_host_websocket_awaits_acceptance_binding_and_result_commits` | G03, G07 | `src/providers/openai_codex/tests/replay/joined_host.rs:147-340`; `src/providers/openai_codex/tests/replay/joined.rs:228-565` | D/S | None |
| V1A-22 | PASS_LOCAL | Labelled/missing-MIME SSE full history per request; failed identity/admission retains exact codes and Unknown without retry. | `v1a_22_host_labelled_sse_native_and_recovered_history_after_ticket_drop`; `v1a_22_host_missing_mime_sse_native_and_recovered_history_after_ticket_drop`; `v1a_22_host_sse_failed_admission_and_identity_keep_uncertainty_without_retry` | G03, G07 | `src/providers/openai_codex/tests/replay/joined_host.rs:239-344,517-598` | D/S | None |
| V1A-23 | PASS_LOCAL | Synthetic X/Y/X binding before payload; exact requested model and closed-exchange policy; no identity search/fallback. | `v1a_23_host_websocket_account_x_y_x_and_exact_model_boundary`; `v1a_23_host_sse_account_x_y_x_and_exact_model_boundary` | G03, G07 | `src/providers/openai_codex/tests/replay/joined_host.rs:346-514` | D/S | None |
| V1A-24 | PASS_LOCAL | Real S2 saved bytes survive source mutation/deletion; independent current prep; historical resource/script/permission grants no authority. | `v1a_24_host_s2_saved_bytes_survive_mutated_and_deleted_sources` | G03, G07, G15-G16 | `examples/host_offline.rs:355-403,467-810` | D/S | None |
| V1A-25 | PASS_LOCAL | Existing suites/direct APIs pass; no dependency/schema/event/error/provider/tool/auth/CI or excluded feature changes. | Complete all-target regression and Node self-test | G01-G14 | `src/execution/mod.rs:28-127`; `Cargo.toml:1`; `Cargo.lock:1`; `.github/workflows/ci.yml:1` | D/S | None |
| V1A-26 | PASS_LOCAL | Public host example: early receipt, lost A observers, stored outputs, completion, shutdown, no-work reopen, explicit B/cancel; older examples pass. | `v1a_24_host_s2_saved_bytes_survive_mutated_and_deleted_sources`; seven offline mains | G03, G07, G09-G16 | `examples/host_offline.rs:467-810`; older example paths in command table | D/S | None |
| V1A-27 | PASS_LOCAL | Prior/new dev/release finite samples and retirement/connection counts recorded; failures preserved; no SLA. | `finite_submissions_retire_entries_and_retained_tickets_release_resources`; offline measurements | G03, G07, G12-G16 | `examples/host_offline.rs:45-55,453-792`; `src/service/tests/storage.rs:294-359`; `VALIDATION.md:7-21` | D/S/P/H | None; historical Windows cause unresolved |
| V1A-28 | PASS_LOCAL | Both reports, unique rows, source links, failures, reviews, historical fingerprints, tested revision and ledger; redacted Debug/static errors; frozen docs preserved. | `public_types_and_static_errors`; report consistency check | G03, G07, G17 | `src/service/types.rs:14-70`; `src/service/tickets.rs:116-126`; `VERIFICATION.md:1`; `verification.json:1` | D/S/P | None |
| V1A-29 | PASS | Independent complete-diff reviews and local gates passed; push 35320097103 and PR 35320100396 passed all six Cargo steps on Ubuntu/macOS/Windows at fad3855. Exact job evidence is in section 6. | Prior complete-diff reviews; complete local matrix; six hosted jobs | G01-G17; hosted G01-G06 per job | `MATRIX.md`; `.github/workflows/ci.yml:1`; section 6 | D/S/P/C | None |

## 5. Joined paths and ownership/fault observations

### Actual host transport path

`src/providers/openai_codex/tests/replay/joined_host.rs:108-120` dispatches through
`RunClient::submit`. The eight tests use B2, real SQLite, the actual OpenAI-Codex
loopback adapter and counted real AddNumbers calls. They do not substitute an installed
expected replay object or a manually spawned direct run for the host.

`joined_host.rs:147-197` drops A's ticket and client at the binding barrier, before
A's first conversation payload. An independent session reader observes actual normal
completion. The first receipt covers stored sequence 2 through 3.

For each native/recovered A/B roundtrip (`joined_host.rs:199-249`):

- WS observes two connections, four requests, two tool validations and two effects.
  It loads synthetic credentials twice, once per opened control.
- SSE observes four connections, four requests, two validations and two effects.
  It counts six synthetic credential loads: existing opening plus per-request behavior.
  This is not a second opening identity lookup or an account search.
- B's context comes from actual saved A. WS sends full context on the fresh socket with
  no old parent, then new result-only delta/new parent. SSE sends full ordered context
  on every request. Opaque/native and recovered output remains exact.

The joined durability tests (`joined_host.rs:251-344`) pause actual acceptance,
binding and result SQL. Before acceptance commit, acceptance stays pending and no new
provider work occurs. After acceptance, binding still blocks payload transmission.
At result precommit, the real effect exists but no result row is visible. After commit,
the exact output row is visible before continuation; the operation identity is unchanged.

The X/Y/X and exact-model tests (`joined_host.rs:346-514`) record the actual changed
binding, reject before conversation payload, preserve the old prefix and later succeed
with X. The three SSE negative cases (`joined_host.rs:517-598`) retain
`unexpected_content_type` or `protocol_error`, one attempted/admitted request and
`UpstreamOutcome::Unknown`. They reject retry/fallback connections.

### S2 and explicit replay

`examples/host_offline.rs:355-403,467-810` uses real catalog preparation, `load_skill`,
AddNumbers and persisted output. After A, the historical source changes or disappears.
B restores exact saved bytes without requiring the old source. Current preparation uses
separate current input. The single example test crosses two source states with three
historical resource/script/permission proposals. All six use real tool preflight to
reject new authority; no script/resource effect occurs.

### Loss, cancellation and drain

- `src/service/tests/boundaries.rs:137-259` tests cancellation at acceptance, binding,
  intent, result, RunFinished and final-result commit boundaries. Already completed
  outcomes and real tool output remain truthful.
- `src/service/tests/boundaries.rs:269-458` crosses three SQL record points with normal,
  postcommit lost-reply and cleanup-warning behavior. A separate session can rename
  during drain; the root lease remains held. Reopen confirms committed receipts even
  after unknown acknowledgment. Final cleanup warning retains Executed.
- `src/service/tests/loss.rs:53-189,368-493` isolates provider/tool/SQL-ownership unwinds
  and drop-before-poll. WorkerLost closes admission and signals siblings. A sibling
  retains its concrete storage-closed failure. No false terminal is written. Quarantine
  retains the root lease; shutdown reports Incomplete with storage Io when applicable.
- `src/service/tests/loss.rs:191-357,496-523` exits at accepted/model/tool/result phases,
  then reopens in another process. Reads and old duplicates do no work. A complete
  trailing stored exchange can remain replayable under B2; incomplete phases fail.
- `src/service/tests/storage.rs:294-359` runs twelve finite submissions and verifies
  empty registry/tracker, NotTracked, freed gateway/host/tools and healthy root reopen
  with old tickets retained. Twelve is a test size, not a product limit.

## 6. Review and preserved failure history

P records were inspected in the retained local parent session. Summaries are attributed
below without copying private transcripts, synthetic account headers or conversation
markers into these reports. Exact initial commands/diagnostics absent from a summary
are not invented.

| Phase | Failure or finding | Correction and retained result |
|---|---|---|
| Increment 1 implementation | Initial Arc type mismatch and Clippy test lock-scope warning. | Delegate corrected typing/lock scope; focused compilation, tests and Clippy passed. |
| Increment 1 review command | Invalid combined Cargo test filter ran no tests. | Separate valid targeted commands ran; invalid invocation is not acceptance evidence. |
| Increment 1 review | Later duplicate notifier branch lacked focused regression coverage. | Independently verified as an evidence gap, not a production malfunction. Real competing SQL acceptance plus a read failure armed inside notification now proves the branch. Five notifier tests and three complete-diff re-reviews passed. |
| Increment 2 compilation | Missing `sqlx::Connection` import and Arc argument mismatches. | Test compilation corrected without production API changes. |
| Increment 2 barriers | Host replay barrier unreachable; first correction masked caller-scoped hooks and stalled broader regressions. | Final test hook preserves task-local and session-scoped hooks. Focused and broader checks passed. |
| Increment 2 assertions | Pre-cancel expectation disagreed with `InvalidRequest("run pre-cancelled")`; restart expectation rejected a fully stored trailing exchange. | Assertions aligned to existing B2 semantics. No replay policy change; old duplicates still do no execution. |
| Power loss | Three initial review delegates returned no result; zero-length `target` metadata caused E0786 invalid metadata/zero-length libwi. | These are not three passing reviews. One reviewer compiled successfully using `/tmp/wi-review-target`; another removed only 908 zero-length ignored cache artifacts and rebuilt successfully. No tracked source was removed. This increment removed no cache files. |
| Increment 3 partial work | Delegate exhausted its budget after writing partial joined/example files. | Partial files were inspected and completed by the next assigned increment. Parent check passed; initial fmt showed diffs, later corrected. |
| Increment 3 joined filters | Initial incomplete filters matched zero tests in implementation and one review. | Inventory-based `replay_loopback_tests::joined::host` and `v1a_2` filters each ran the intended eight tests. Zero matches never count as that proof. |
| Increment 3 example | Expected no diagnostics, but supported catalog behavior produced `UnsupportedBehavioralMetadata`. | Fixture now checks exact diagnostic kind/scope/count without deleting metadata or changing production behavior. Dev/release examples passed. |
| Historical B2 Windows | Push 35227116004 attempts 1/2 had existing public-session/final-result/child-exit watchdog expirations although joined tests passed. | Final same-SHA push attempt 3 and PR 35227120456 attempt 1 passed all three OS. Root cause/timing sensitivity is **not proven fixed**. Frozen reports remain unchanged. |
| Final increment inventory | Broad parent-directory discovery timed out after 10 seconds. | Scoped repository discovery completed; only root AGENTS.md, no nested CONTEXT.md/CLAUDE.md. No file change. |
| Final increment timing setup | Six `/usr/bin/time` wrapper launches failed, exit 127. No Cargo gate started. | Removed unavailable wrapper and ran G01-G06 directly once each. All passed; no source correction or further retry. |
| Acceptance-record status scan | First literal-phrase assertion failed because `all six Cargo steps` spans a Markdown line break in CHANGELOG.md. | Normalized whitespace in the check; the second attempt passed all five current docs. No content correction was needed. |
| Acceptance-record check extraction | The first launcher stopped at backticks inside a JavaScript regex, truncating the embedded check and causing a SyntaxError. | Matched the closing Markdown fence at line start; the second launcher executed the complete check successfully. No report assertion was weakened. |
| Acceptance-record remediation inventory | Broad parent-directory instruction discovery timed out after 10 seconds. | Repository-scoped discovery completed; only root AGENTS.md and no nested CONTEXT.md/CLAUDE.md. Discovery changed no file. |
| Acceptance-record finding 1 | Review and independent verification confirmed lifecycle-dependent provenance and PR/check assertions. The pre-fix documentation regression detected transient claims and missing eight-path scope metadata. | Replaced lifecycle state with fixed implementation provenance and phase-qualified PR observations. The embedded check requires tested-revision ancestry and checks every intervening commit plus staged/unstaged/untracked paths. Scope fixtures accept allowed descendant paths and reject source changes in either committed or worktree paths. No current PR-head CI result is asserted. |
| Acceptance-record finding 2 | Review and independent verification confirmed ARCHITECTURE still said V1-A was only locally complete. The pre-fix documentation regression detected missing accepted implementation provenance. | Updated ARCHITECTURE to v1a.0 accepted at fad3855 with both exact-head hosted runs; V1-B/browser/GUI/ordinary CLI persistence remain unimplemented. Scope and normalized status checks now cover eight files/six current docs. Post-fix documentation regression and acceptance-record checks passed. |
| Acceptance-record remediation check launcher | The first launcher used a shared VM context and redeclared `fs`, causing a SyntaxError before any embedded assertion ran. | Executed the unchanged embedded check in an isolated function scope; the second attempt passed. No assertion was weakened. |

Review completion records (UTC, P):

- Initial increment 1 reviews: 2026-09-17T20:36:16.533Z. Evidence-gap verification:
  20:39:57.199Z. Remediation: 20:45:42.171Z. Three re-reviews passed at
  20:54:18.419Z/20:54:18.420Z.
- Recovered increment 2 complete-diff reviews: three passing results at
  23:01:09.092Z/23:01:09.093Z. Fresh-target compilation passed; that reviewer also ran
  34 service tests plus one ignored helper and five notifier tests.
- Increment 3/source accumulated diff: three passing local reviews at
  23:45:41.341Z/23:45:41.342Z. They included all 12 modified and 15 then-untracked
  source/example paths, joined WS/SSE, S2, notifier placement, registration/drop/shutdown
  races, failure retention, quarantine and restart. No actionable finding remained.
- Final report increment, **historical pre-documentation-alignment snapshot**:
  three fresh independent complete-diff reviews passed after both reports existed.
  Each review covered all 12 modified and all 17 untracked files, including source,
  tests, examples and reports. Reviewers reproduced the historical 342-file fingerprint
  `8631ae894d298200632e4c0326ebb61deaf37b2aa1a94b4920294382b041e338`.
  This snapshot predates the seven current-documentation edits: `AGENTS.md`,
  `CHANGELOG.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/EVENTS.md`,
  `docs/README.md` and `docs/WI_PRODUCT_DIRECTION.md`. These reviewers did not cover
  those later edits or this documentation remediation. All30 status consistency and
  bounded local gates passed at that snapshot; no blocking or actionable finding
  remained there. This snapshot predates the authorized implementation commit and
  hosted workflows.
- Historical pre-commit documentation alignment and remediation: three fresh reviewers
  covered all then-modified and untracked files. They reproduced that 342-file fingerprint
  `995851188f598a10ed8664a4733836162d5e1a006519f6606aeec057ee737394`,
  the 19-file `+381/-171` tracked diff, all30 report consistency, links and whitespace.
  The initial review found two low-severity documentation gaps; independent verification
  confirmed both. Remediation corrected the product-direction roadmap and distinguished
  the earlier review hash from the then-current fingerprint. The repeated three-review
  gate passed with no actionable findings. Neither snapshot covers this acceptance-record
  update.
- Acceptance-record review, verification, remediation and repeated review: the initial
  three-review gate reported two documentation findings. Independent verification confirmed
  both. Remediation corrected durable provenance/scope checks and the architecture status.
  Three fresh repeated reviewers then passed the complete eight-file diff with no actionable
  findings. They reproduced all30, exact CI records, descendant scope enforcement, links,
  whitespace and the fixed implementation/live-provider boundaries.

Earlier targeted evidence remains P: eight joined host tests, ten existing `b2mr_*`
tests, one S2 test with six cases, and the twelve-submission retirement test passed.
The two exact-model targeted tests were reruns after stronger assertions, not two
additional tests. These results are not added to this increment's 750-test count.

D reproduced all required local gates and checked the reports before the historical
complete-diff review. Section 1 records the later pre-commit snapshot, not the current
Git state. Its documentation review gate passed after both confirmed findings were
remediated. Authorized hosted acceptance followed at the committed implementation head.

### Exact-head hosted acceptance

C evidence establishes both **Rust source validation** workflows at
`fad3855db70ff4151a5c27ec3f64d04fa9097cbb`. Both run conclusions and every listed job
conclusion are **success**. Each job passed all six exact Cargo commands G01-G06 in
section 3; [verification.json](verification.json) records each command and conclusion.

| Event | Run | OS | Job | Cargo steps |
|---|---|---|---|---|
| push | [35320097103](https://github.com/zer09/wi/actions/runs/35320097103) | Ubuntu | [105520455006](https://github.com/zer09/wi/actions/runs/35320097103/job/105520455006) | G01-G06 PASS |
| push | [35320097103](https://github.com/zer09/wi/actions/runs/35320097103) | macOS | [105520455249](https://github.com/zer09/wi/actions/runs/35320097103/job/105520455249) | G01-G06 PASS |
| push | [35320097103](https://github.com/zer09/wi/actions/runs/35320097103) | Windows | [105520455296](https://github.com/zer09/wi/actions/runs/35320097103/job/105520455296) | G01-G06 PASS |
| pull_request | [35320100396](https://github.com/zer09/wi/actions/runs/35320100396) | Ubuntu | [105520471681](https://github.com/zer09/wi/actions/runs/35320100396/job/105520471681) | G01-G06 PASS |
| pull_request | [35320100396](https://github.com/zer09/wi/actions/runs/35320100396) | macOS | [105520471423](https://github.com/zer09/wi/actions/runs/35320100396/job/105520471423) | G01-G06 PASS |
| pull_request | [35320100396](https://github.com/zer09/wi/actions/runs/35320100396) | Windows | [105520471721](https://github.com/zer09/wi/actions/runs/35320100396/job/105520471721) | G01-G06 PASS |

During acceptance preparation, [PR #8](https://github.com/zer09/wi/pull/8) was observed
OPEN and DRAFT, not merged, at `fad3855db70ff4151a5c27ec3f64d04fa9097cbb`, with
mergeable MERGEABLE and mergeStateStatus CLEAN. These are historical observations,
not current PR assertions. The recorded runs prove only that implementation revision.
Current PR-head merge checks are external GitHub merge-readiness evidence, separate from
this fixed implementation evidence; this record asserts no current-head CI result.
Cargo CI does not establish Node self-test, offline example-main or live/provider execution;
their evidence remains separate.
Earlier failures and unresolved historical Windows watchdog observations remain above.

## 7. Finite measurements

All values below are milliseconds on local WSL2 synthetic fixtures. P is the earlier
increment-3 completion report; D is G15/G16. No SLA, fastest claim or network latency
claim applies. Scheduling, SQL/API overhead and deliberate reader/barrier work are
included. A measures observation of the stored completion after losing its ticket;
B uses the ticket. Cancellation includes observed NotTracked retirement.

| Observation | P dev | P release | D dev | D release |
|---|---:|---:|---:|---:|
| A dispatch to receipt | 320.952 | 121.630 | 296.763 | 158.578 |
| A receipt to stored completion observed | 2097.485 | 1090.996 | 2192.832 | 1224.346 |
| B dispatch to receipt | 316.639 | 185.401 | 335.212 | 187.880 |
| B receipt to completion | 1762.559 | 931.824 | 1789.791 | 1040.875 |
| Cancellation to retirement | 201.550 | 125.893 | 238.305 | 132.015 |
| First shutdown | 0.467 | 0.323 | 0.529 | 0.318 |
| Final shutdown | 0.409 | 0.126 | 0.452 | 0.278 |

Each complete host example observed one active A provider connection with two saved
outputs before completion; four scripted provider sessions opened and closed; zero
active after shutdown; cancelled target NotTracked. The registry/tracker observations
come from the separate finite-submission test, not inferred connection counts.

New older-example measurements are retained in full in JSON. The storage example's
separate connection probe measured open 2.196 and close 0.573 ms. Its three API samples:

| Sample | Create | Accept | Append batch | Rename | List | Page | Close/reopen | Close |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 86.314 | 71.164 | 80.596 | 47.125 | 12.519 | 41.650 | 97.366 | 0.026 |
| 2 | 81.069 | 62.508 | 80.722 | 53.918 | 16.281 | 44.114 | 98.912 | 0.040 |
| 3 | 97.932 | 66.758 | 92.177 | 70.779 | 15.921 | 45.746 | 96.428 | 0.041 |

Each sample used 36,864 catalog bytes, 86,016 session bytes, 2,059 input-snapshot bytes,
6,018 append-DTO bytes and 10 tool-output bytes. History JSON sizes were 12,890/12,875/
12,878 bytes. Canonical rows were create 1, accept 1, append 12, rename 1; final head 15.
These supplied DTO traces are storage evidence, not a joined provider execution.

G13 observed partial read 38.562; acceptance-to-partial 542.984; continuation read
43.705; tool projection read 41.971; final release-to-recorded result 269.174; execution
end-to-end 1377.587; final history read 43.587; catalog refresh 80.407; partial acknowledgments
61.564/64.309; tool cycle-to-continuation 565.171; recording window 1697.019; close 0.032;
reopen store/session 26.962/81.974; full example 2295.529 ms. Acceptance-to-partial starts
before receipt lookup. Catalog/session sizes were 36,864/94,208 bytes; both WAL sizes zero.

G14 observed A/B replay installation 0.056/1.277; A/B end-to-end 2159.832/1306.830;
history reads after A/B 45.952/54.762; replay preparation after A/B 96.012/110.380;
full example 5262.597 ms. Catalog/session sizes were 36,864/131,072 bytes, both WAL sizes
zero. It retained 48 history records, two replay runs, five exchanges and 5,399 replay
JSON bytes. None of these finite sizes are retention, history or task limits.

## 8. Report consistency and reproducibility

Acceptance-record consistency status: **PASS**. JSON parse/all30/hosted evidence checks,
local links in all seven allowed Markdown files, stale transient-token scan across eight
files, normalized current-status scan across six docs including ARCHITECTURE,
`git diff --check` and the eight-file committed-plus-worktree scope check passed.
The embedded check passed against the uncommitted remediation state. The pre-fix
documentation regression failed on both confirmed findings; its post-fix run passed.
Section 6 preserves earlier check failures, the findings and their corrections.
Preparation and remediation left source/tests/configuration, frozen plans, historical
reports and the index unchanged and created no untracked files.

The original pre-commit consistency check reproduced the 342-file fingerprint and
inspected all 17 then-untracked files. That result is historical. The read-only check
below validates report structure/status, both exact-head workflows, all six jobs
and 36 successful Cargo steps, source/test references, commands/counts, privacy ledger
and historical snapshot metadata. It requires tested_revision to be an ancestor of HEAD.
It checks all paths in every commit in tested_revision..HEAD and all staged, unstaged
and untracked paths against the eight allowed docs/reports below. Read-only scope fixtures
accept allowed descendant paths and reject source changes in committed or worktree paths;
these fixtures do not create commits. The check permits a documentation-only descendant
without requiring a fixed current PR head, dirty tree or recursive report hash.
Run from the repository root with Node; no provider or hosted request is involved.

```javascript
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const report = 'docs/slices/v1a/verification.json';
const human = 'docs/slices/v1a/VERIFICATION.md';
const j = JSON.parse(fs.readFileSync(report, 'utf8'));
const md = fs.readFileSync(human, 'utf8');
const git = (...args) => cp.execFileSync('git', args);
const split = bytes => bytes.toString().split('\0').filter(Boolean);
const revision = 'fad3855db70ff4151a5c27ec3f64d04fa9097cbb';
assert.equal(j.contract, 'v1a.0');
assert.equal(j.status, 'ACCEPTED');
assert.equal(j.accepted, true);
assert.equal(j.local_complete, true);
assert.equal(j.hosted_ci_status, 'PASS');
assert.equal(j.tested_revision, revision);
assert.equal(j.consistency_checks.status, 'PASS');
assert.equal(j.acceptance_record_update.based_on_revision, revision);
assert.equal(j.acceptance_record_update.kind, 'docs_only_acceptance_record');
assert.equal(j.acceptance_record_update.preparation_git_transitions_performed, false);
assert.equal(j.pull_request.number, 8);
assert.equal(j.pull_request.observation_phase, 'acceptance_preparation');
assert.equal(j.pull_request.observer, 'C');
const allowedPaths = [
  'AGENTS.md',
  'CHANGELOG.md',
  'README.md',
  'docs/ARCHITECTURE.md',
  'docs/README.md',
  'docs/WI_PRODUCT_DIRECTION.md',
  human,
  report,
];
assert.deepEqual(j.acceptance_record_update.allowed_paths, allowedPaths);
const assertScope = (committed, worktree) => {
  for (const p of new Set([...committed, ...worktree])) {
    assert(allowedPaths.includes(p), `out-of-scope path: ${p}`);
  }
};
// Allowed docs stay valid after a commit; source changes in either place must fail.
assert.doesNotThrow(() => assertScope(allowedPaths, []));
assert.doesNotThrow(() => assertScope([], allowedPaths));
assert.doesNotThrow(() => assertScope([allowedPaths[0]], [allowedPaths[1]]));
assert.throws(() => assertScope(['src/lib.rs'], []), /out-of-scope path/);
assert.throws(() => assertScope([], ['src/lib.rs']), /out-of-scope path/);
git('merge-base', '--is-ancestor', revision, 'HEAD');
const commits = git('rev-list', `${revision}..HEAD`).toString().trim().split('\n').filter(Boolean);
// Inspect every commit so a later revert cannot hide an unauthorized source edit.
const committedPaths = commits.flatMap(commit => split(git(
  'diff-tree', '--root', '-m', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', commit,
)));
const worktreePaths = [
  ...split(git('diff', '--name-only', '--no-renames', '-z')),
  ...split(git('diff', '--cached', '--name-only', '--no-renames', '-z')),
  ...split(git('ls-files', '--others', '--exclude-standard', '-z')),
];
assertScope(committedPaths, worktreePaths);
assert(md.includes('Status: **ACCEPTED**'));
assert(md.includes('Accepted: **true**'));
assert(md.includes(revision));
const ids = Array.from({length: 30}, (_, i) => `V1A-${String(i).padStart(2, '0')}`);
assert.deepEqual(j.matrix.map(r => r.id), ids);
assert.equal(new Set(j.matrix.map(r => r.id)).size, 30);
const rows = [...md.matchAll(/^\| (V1A-\d{2}) \| ([^|]+) \|/gm)];
assert.deepEqual(rows.map(m => m[1]), ids);
assert.deepEqual(rows.map(m => m[2].trim()), j.matrix.map(r => r.status));
const contract = fs.readFileSync('docs/slices/v1a/MATRIX.md', 'utf8');
const commands = contract.match(/## Required local commands[\s\S]*?```text\n([\s\S]*?)```/)[1].trim().split('\n');
assert.deepEqual(j.commands.map(c => c.command), commands);
const commandIds = new Set(j.commands.map(c => c.id));
assert.equal(commandIds.size, 17);
for (const c of j.commands) {
  assert.equal(c.status, 'PASS');
  assert.equal(c.exit_code, 0);
  assert.equal(c.top_level_invocations, 1);
  assert(md.includes('`' + c.command + '`'));
}
const hostedCommands = j.commands.slice(0, 6).map(c => c.command);
const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
assert.deepEqual([...workflow.matchAll(/^\s+- run: (.+)$/gm)].map(m => m[1]), hostedCommands);
const expectedRuns = [
  {run: 35320097103, event: 'push', jobs: [105520455006, 105520455249, 105520455296]},
  {run: 35320100396, event: 'pull_request', jobs: [105520471681, 105520471423, 105520471721]},
];
assert.equal(j.submitted_ci.length, 2);
for (let i = 0; i < expectedRuns.length; i++) {
  const expected = expectedRuns[i];
  const run = j.submitted_ci[i];
  assert.equal(run.run, expected.run);
  assert.equal(run.workflow, 'Rust source validation');
  assert.equal(run.event, expected.event);
  assert.equal(run.head_sha, revision);
  assert.equal(run.conclusion, 'success');
  assert.equal(run.observer, 'C');
  assert.equal(run.url, `https://github.com/zer09/wi/actions/runs/${run.run}`);
  assert(md.includes(run.url));
  assert.deepEqual(run.jobs.map(job => job.id), expected.jobs);
  assert.deepEqual(run.jobs.map(job => job.os), ['Ubuntu', 'macOS', 'Windows']);
  assert.deepEqual(run.jobs.map(job => job.runner), ['ubuntu-latest', 'macos-latest', 'windows-latest']);
  for (const job of run.jobs) {
    assert.equal(job.conclusion, 'success');
    assert.equal(job.url, `${run.url}/job/${job.id}`);
    assert(md.includes(job.url));
    assert.deepEqual(job.cargo_steps.map(step => step.command), hostedCommands);
    assert(job.cargo_steps.every(step => step.conclusion === 'success'));
  }
}
const all = [...new Set(split(git('ls-files', '--cached', '--others', '--exclude-standard', '-z')))].sort();
const rust = all.filter(p => p.endsWith('.rs')).map(p => fs.readFileSync(p, 'utf8')).join('\n');
for (let i = 0; i < j.matrix.length; i++) {
  const r = j.matrix[i];
  for (const key of ['assertions', 'tests', 'commands', 'source', 'observer', 'blockers']) {
    assert(Array.isArray(r[key]), `${r.id}.${key}`);
    assert(r[key].every(v => typeof v === 'string'), `${r.id}.${key}`);
  }
  assert(r.assertions.length && r.commands.length && r.source.length && r.observer.length);
  assert(r.commands.every(c => commandIds.has(c)));
  assert(r.observer.every(o => Object.hasOwn(j.observers, o)));
  assert.equal(r.status, i === 29 ? 'PASS' : 'PASS_LOCAL');
  assert.equal(r.blockers.length, 0);
  for (const name of r.tests) assert(rust.includes('fn ' + name + '('), name);
  for (const source of r.source) {
    const m = source.match(/^(.+?):(\d+)(?:-(\d+))?$/);
    assert(m, source);
    const lines = fs.readFileSync(m[1], 'utf8').split('\n').length;
    assert(+m[2] >= 1 && +(m[3] || m[2]) <= lines, source);
  }
}
for (const p of allowedPaths.filter(p => p.endsWith('.md'))) {
  const text = fs.readFileSync(p, 'utf8');
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue;
    assert(fs.existsSync(path.resolve(path.dirname(p), m[1].split('#')[0])), `${p}: ${m[1]}`);
  }
}
for (const p of allowedPaths.filter(p => p !== human && p !== report)) {
  const text = fs.readFileSync(p, 'utf8').replace(/[*`]/g, '').replace(/\s+/g, ' ');
  assert.match(text, /complete and accepted|ACCEPTED; complete; accepted=true; hosted CI PASS/, p);
  for (const value of ['v1a.0', revision, '35320097103', '35320100396',
    'all six Cargo steps', 'Ubuntu/macOS/Windows', 'external GitHub merge-readiness evidence']) {
    assert(text.includes(value), `${p}: ${value}`);
  }
  if (p === 'docs/ARCHITECTURE.md') {
    assert(text.includes('V1-A in-process ownership is complete and accepted under contract v1a.0'), p);
    assert(text.includes('Ordinary CLI persistence, V1-B networking, browser protocol and GUI remain unimplemented.'), p);
  }
}
assert.equal(j.test_counts.per_all_target_pass.reduce((s, t) => s + t.passed, 0), 750);
assert.equal(j.test_counts.per_all_target_pass.reduce((s, t) => s + t.ignored, 0), 6);
assert.equal(j.test_counts.ignored_child_helpers.length, 6);
assert.equal(j.test_counts.total_passed, 750);
assert.equal(j.test_counts.total_failed, 0);
for (const key of ['live_started', 'network_service_implemented', 'normal_cli_persistence_implemented']) assert.equal(j[key], false);
for (const key of ['real_credential_reads', 'private_skill_reads', 'provider_generations']) assert.equal(j[key], 0);
assert.deepEqual(j.ledger, {used: 31, cap: 50, remaining: 19, changed: false});
git('merge-base', '--is-ancestor', j.baseline, revision);
const snapshot = j.worktree;
assert.equal(snapshot.kind, 'historical_pre_commit_review_snapshot');
assert.equal(git('rev-parse', `${revision}^`).toString().trim(), snapshot.head);
assert.equal(git('rev-parse', `${snapshot.head}^`).toString().trim(), j.baseline);
assert.equal(snapshot.protected_file_count, 342);
assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
assert.match(snapshot.index_sha256, /^[a-f0-9]{64}$/);
assert.equal(snapshot.preserved_modified_paths.length, 19);
assert.equal(snapshot.preserved_untracked_paths.length, 15);
assert.equal(snapshot.final_dirty_paths, 36);
assert.equal(snapshot.final_untracked_paths, 17);
assert.deepEqual(snapshot.report_paths_excluded_from_self_hash, [human, report]);
assert.deepEqual(j.reviews.filter(r => r.reviewed_worktree_sha256).map(r => r.reviewed_worktree_sha256), [
  '8631ae894d298200632e4c0326ebb61deaf37b2aa1a94b4920294382b041e338',
  snapshot.sha256,
]);
for (const p of [human, report]) {
  const text = fs.readFileSync(p, 'utf8');
  assert(!/[ \t]+$/m.test(text), `trailing whitespace: ${p}`);
  assert(!/^ +\t/m.test(text), `space before tab: ${p}`);
  assert(text.endsWith('\n') && !text.endsWith('\n\n'), `EOF whitespace: ${p}`);
}
console.log('PASS: JSON/schema, all30, accepted status, exact-head CI (2 runs/6 jobs/36 Cargo steps)');
console.log('PASS: commands/counts/ledger, source/test references, local links, whitespace and historical snapshot metadata');
console.log('PASS: normalized accepted status in all six current docs including ARCHITECTURE');
console.log(`PASS: tested revision ancestry; eight-file scope (${commits.length} descendant commits, ${new Set(worktreePaths).size} worktree paths); scope regression fixtures`);
```

The JSON follows the machine minimum in [MATRIX.md](MATRIX.md), with explicit local
completion and hosted-CI status fields. The repository supplies no separate JSON Schema
file for V1-A; the assertions above check the required structure and consistency.

## 9. Remaining limits and authorization

- Hosted runs 35320097103/35320100396 prove only implementation head
  `fad3855db70ff4151a5c27ec3f64d04fa9097cbb`, not documentation-only descendants.
  PR #8 was observed open and draft, not merged, during acceptance preparation.
  Current PR-head merge checks are external GitHub merge-readiness evidence, separate
  from fixed implementation evidence; this record asserts no current-head CI result.
  The parent supplied verified hosted evidence; this increment did not independently
  fetch it or rerun Cargo gates.
- Local execution evidence is Linux/WSL2; hosted Cargo evidence covers Ubuntu/macOS/Windows.
  Passing V1-A runs do not prove the retained Windows watchdog causes repaired.
- Graceful shutdown requires keeping the runtime alive and awaiting its ticket.
  Runtime/process destruction, panic=abort, physical power loss and noncooperative
  blocking code do not acquire a graceful completion guarantee.
- The library does not replace the process panic hook. An embedding application's
  hook can expose its own panic payload; fixtures use nonsecret synthetic data.
- V1-B network/client protocol, service authentication, browser reconnect, GUI, normal
  CLI persistence, deployment and live verification remain outside this increment.
- No real profiles, private skills, credentials or provider endpoints were accessed.
  Scripted/loopback calls are not live provider generations. No auth, smoke/live or
  `two_turns` main was invoked.

Ledger: **31/50 used, 19 remaining, unchanged**. `provider_generations=0`,
`real_credential_reads=0`, `private_skill_reads=0`, `live_started=false`.
Completing this report increment authorizes no staging, commit, push, merge, release,
deployment, provider probe or later milestone.
