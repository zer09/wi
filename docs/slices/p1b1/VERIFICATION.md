# Wi P1-B1 verification report

Contract **p1b1.0**. Status: **LOCAL PASS, SUBMITTED CI PENDING**.
Final acceptance remains **accepted=false** until a separately authorized commit and
exact-head push/PR CI pass on Ubuntu, macOS and Windows.

**P1B1-00 through P1B1-28 pass local verification. P1B1-29 is partial:** its local
command set and fresh complete-diff review pass, but the later submitted-head CI gate
is not run. The planning statuses in [MATRIX.md](MATRIX.md) remain unchanged as
required.

P1-B1 now records actual execution for an explicitly supplied prepared input through
`wi::execution::run_persisted`. It does not restore prior conversation context.
Ordinary `wi run` persistence, B2 provider/account history restoration, service-owned
active-run management, browser transport and GUI/V1 remain unimplemented.

## Revision, worktree and attribution

| Item | Observation |
|---|---|
| Accepted baseline | `34b4cfd0d3ecf286869a239997267dbd75c28c0b`, P1-A merge |
| Planning HEAD | `7087f50f79b5e655fa6b0acbb4e2d4ce077f642d`; baseline is an ancestor |
| Tested revision | None. The implementation is intentionally uncommitted. |
| Pre-report worktree | 20 modified tracked files, 27 untracked files, 0 staged files, 47 changed files |
| Cargo dependency state | `Cargo.toml` and `Cargo.lock` unchanged |
| Report additions | `docs/slices/p1b1/VERIFICATION.md` and `docs/slices/p1b1/verification.json` |
| Authorization | No stage, commit, push, merge, release or deployment authorization |

**D** means an executed local command. **S** means current source, diff, inventory or
configuration inspection. **P** means retained parent/delegate evidence from completed
implementation and review increments. P evidence is not relabeled as a new D run.

All work used synthetic temporary roots, synthetic skills/credentials, scripted
providers and 127.0.0.1 loopbacks. Provider key variables were unset. No real profile,
credential or private-skill read occurred. No live provider request occurred.

### Changed implementation and test paths

Public composition and shared runtime:

- `src/lib.rs`
- `src/execution/mod.rs`
- `src/execution/observer.rs`
- `src/execution/types.rs`
- `src/run/mod.rs`
- `src/run/observer.rs`
- `src/tools.rs`

Execution, run and tool tests:

- `src/execution/tests/mod.rs`
- `src/execution/tests/admission.rs`
- `src/execution/tests/recording.rs`
- `src/execution/tests/lifecycle.rs`
- `src/execution/tests/commit_boundaries.rs`
- `src/execution/tests/faults.rs`
- `src/execution/tests/sql_failures.rs`
- `src/execution/tests/independent.rs`
- `src/execution/tests/remediation.rs`
- `src/execution/tests/process.rs`
- `src/execution/tests/process/child.rs`
- `src/execution/tests/process/harness.rs`
- `src/execution/tests/process/prefixes.rs`
- `src/execution/tests/process/reopen.rs`
- `src/execution/tests/process/snapshots.rs`
- `src/run/observation_tests.rs`
- `src/tools/tests/mod.rs`
- `src/tools/tests/observation.rs`

Storage lifecycle, closed test hooks and measurements:

- `src/storage/lifecycle.rs`
- `src/storage/session.rs`
- `src/storage/mod.rs`
- `src/storage/catalog_sync.rs`
- `src/storage/history.rs`
- `src/storage/test_hooks.rs`
- `src/storage/execution_tests.rs`
- `src/storage/process_tests.rs`
- `src/storage/measurement_tests.rs`

OpenAI loopback tests and harness:

- `src/providers/openai_codex/tests/harness/context.rs`
- `src/providers/openai_codex/tests/harness/run.rs`
- `src/providers/openai_codex/tests/wire_format/response_identity_loopback_tests.rs`
- `src/providers/openai_codex/tests/consistency/consistency_loopback_tests.rs`
- `src/providers/openai_codex/tests/run_continuation/persisted_loopback_tests.rs`
- `src/providers/openai_codex/tests/run_continuation/persisted_backpressure_tests.rs`
- `src/providers/openai_codex/tests/context_integration/context_loopback_tests.rs`
- `src/providers/openai_codex/tests/context_integration/persisted_skill_loading_tests.rs`

Example and current documentation:

- `examples/persisted_run_offline.rs`
- `README.md`
- `docs/README.md`
- `docs/ARCHITECTURE.md`
- `docs/EVENTS.md`

The two report paths are additional untracked documentation. All 27 pre-report untracked
files passed individual `git diff --no-index --check` inspection. `git diff --check`
passed for tracked changes.

## Environment

| Tool/platform | D observation |
|---|---|
| Platform | Linux 6.18.33.2-microsoft-standard-WSL2 x86_64 GNU/Linux |
| Effective UID | 1000 |
| Rust | rustc 1.98.1, host x86_64-unknown-linux-gnu, LLVM 22.1.8 |
| Cargo | 1.98.1 |
| Rustfmt / Clippy | 1.9.0-stable / 0.1.98 |
| uv / Python through uv | 0.12.10 / 3.14.6 |
| Node / Git | v24.18.0 / 2.55.0 |
| Final synthetic root | `/tmp/wi-p1b1-final.u8qmhQ` |

The final gate environment redirected `HOME`, `XDG_CONFIG_HOME`, `CODEX_HOME` and
`TMPDIR`. It retained trusted `CARGO_HOME` and `RUSTUP_HOME`, set
`CARGO_NET_OFFLINE=true`, and unset OpenAI/Codex credential and endpoint variables.
The verifier also used `UV_OFFLINE=true` and `UV_PYTHON_DOWNLOADS=never`.

## Implemented behavior

### One shared orchestration loop

`run_persisted` acquires a storage execution hold, completes receipt-first duplicate
handling and local preflight, commits acceptance, then calls `run::run_admitted` with
the caller's UUID (`src/execution/mod.rs:23-169`, `src/run/mod.rs:173-297`). Public
`run` uses the same admission and loop. No second drive loop, scheduler, background
writer or browser callback was added.

The private `RunObserver` returns Send futures. Its synchronous adapter evaluates the
existing callback before constructing `ready`, so legacy callbacks can still capture
`Rc<RefCell<_>>` and need not be Send (`src/run/observer.rs:4-38`). The persistent
instantiation is Send and runs in an explicitly owned Tokio task.

### Receipt-first acceptance and identity

The composition first checks an existing receipt. A matching old operation calls the
existing `accept_run` validation and returns `Duplicate` with the original acceptance
and current run. It does not require the current provider, registry or cancellation
state and cannot start old work.

For absent receipts, a weak-keyed acceptance guard covers recheck, one registry
definition snapshot, run admission and acceptance. Concurrent identical callers produce
one executor and one duplicate. Different content remains a storage conflict. The
caller-supplied `RunId` is the actual runtime UUID. Application-session sequence,
runtime source sequence and provider identities stay distinct.

### Awaited persistence and tool-result provenance

`PersistentObserver` appends one exact runtime envelope or one exact tool result per
fresh operation ID and awaits the commit (`src/execution/observer.rs:7-69`). It keeps
the first concrete failure and returns a sticky sink failure to stop later core work.
No public observer runs before commit.

The registry now shares this exact sequence (`src/tools.rs:172-290`):

1. validate the complete batch;
2. commit `ToolExecutionStarted`;
3. check cancellation;
4. execute the real tool;
5. use the existing serialization/error/output-limit mapping;
6. insert the run-scoped cache entry;
7. commit exact output and actual `is_error`;
8. commit `ToolExecutionFinished`;
9. return the correlated result for the next request.

`ToolFailed` remains `gateway_error`. Oversized output remains `tool_output_limit`.
An error-shaped successful JSON value stays `is_error=false`. Reuse retains the
original request/result, emits a current correlated reuse event and appends no second
result. A persistence failure does not roll back an actual effect or its in-memory
cache, fabricate output, send a partial batch or submit another request.

### Completion, failure and lifecycle ownership

The returned core `RunResult` is appended only after core execution returns. Provider
or tool failure with successful storage is still `Executed`; callers inspect the actual
`RunOutcome`. Runtime completion and final persistence remain separate. A failed
RunFinished write or failed final-result append retains its operation ID, committed
acceptance and observed result. A committed final result with a cleanup warning returns
known `Executed` completion.

`ExecutionHold` reuses lifecycle admission/drain accounting without retaining a SQLite
connection, transaction, session mutex or maintenance lock
(`src/storage/lifecycle.rs:22-168`). Store close signals a child cancellation token,
rejects new admission, waits for execution and admitted SQL, then explicitly releases a
healthy lease. An unfinished drop, abort or panic quarantines ownership and retains the
lease until process exit. This is ownership safety, not browser-disconnect behavior or
a persisted task manager.

## Required local commands and totals

The final direct full suite and verifier repeat each report **601 passed, 0 failed,
2 ignored**. The ignored tests are closed stdin-driven process helpers:

- `storage::process_tests::storage_child`
- `execution::tests::process::execution_child`

They are invoked by parent process tests. They are not missing standalone coverage.
The current static inventory is **198 source files, 591 Rust test definitions and 25
fixture events**. Inventory counts are not test executions. Zero doctests is not
substantive coverage. Focused reruns, verifier repetitions, subprocess children and
example mains do not increase the 601 unique parent-harness passes.

| ID | Exact command | Result |
|---|---|---|
| F01 | `cargo fmt --all -- --check` | PASS after final fixture edit |
| F02 | `cargo check --all-targets` | PASS directly; repeated after final edit by F07 |
| F03 | `cargo test --all-targets` | PASS; 601 passed, 2 ignored |
| F04 | `cargo clippy --all-targets -- -D warnings` | PASS directly; repeated after final edit by F07 |
| F05 | `cargo build --all-targets` | PASS directly; repeated after final edit by F07 |
| F06 | `cargo test --doc` | PASS; 0 doctests |
| F07 | `uv run scripts/verify.py` | PASS; all six Cargo gates repeated, 601 passed, 2 ignored, 0 doctests, no live request |
| F08 | `node scripts/cli_retest.mjs --self-test` | PASS; 152 tests, `live_started=false` |
| F09 | `cargo run --example run_offline` | PASS; Completed 50, 3 requests, 2 tool executions |
| F10 | `cargo run --example skills_offline` | PASS; Completed 42, 2 requests, 1 tool execution |
| F11 | `cargo run --example skill_loading_offline` | PASS; Completed Reviewed offline., 2 requests, 1 tool execution |
| F12 | `cargo run --example storage_offline` | PASS; 3 finite samples, 3 registry executions, 0 provider requests |
| F13 | `cargo run --example persisted_run_offline` | PASS; Completed 42, 16 records, 1 open, 2 requests, 1 execution, 0 retries |
| F14 | `cargo test --lib storage::measurement_tests::p1b1_28_exact_example_recording_window_counts -- --exact --nocapture` | PASS; 1 passed, 340 filtered |
| F15 | `cargo run --release --example persisted_run_offline` | PASS; release-profile finite sample |
| F16 | `git diff --check` | PASS |
| F17 | `git diff --no-index --check -- /dev/null <each untracked file>` | PASS for all 27 pre-report files |
| F18 | focused consistency loopback stress test | PASS; 1 passed, 340 filtered |

## Matrix dispositions

Every ID appears exactly once below and in the machine report. Local PASS is bounded by
the limits section. P1B1-29 remains partial because submitted-head CI requires separate
owner authorization.

| ID | Status | Executed evidence and concrete oracle |
|---|---|---|
| P1B1-00 | PASS | D/S HEAD, ancestor, 20 modified plus 27 untracked pre-report files, zero staged, toolchain and F01-F18 recorded. P1-A evidence remains historical, not substituted totals. |
| P1B1-01 | PASS | `non_send_legacy_callback_and_admitted_engine_share_event_trace`, `supplied_id_send_engine_preserves_exact_provider_events_and_result_correlation`, `owned_send_task_records_real_text_and_arithmetic_loops`: one shared loop, legacy non-Send callback and Send persistent task. |
| P1B1-02 | PASS | `registry_mismatch_checks_all_fields_and_array_order_before_acceptance`, `saved_snapshot_does_not_reread_preparation_files`, persisted S2 success: exact S1/S2 snapshots and one ordered definition read before acceptance. |
| P1B1-03 | PASS | `shared_admission_and_snapshot_validation_leave_no_acceptance_or_work`, pure-admission tests: all invalid input/options/provider/features/transport/tools/registry/cancel cases perform no acceptance/open/effect. |
| P1B1-04 | PASS | Receipt-first unstarted, active, terminal and restart duplicate tests plus loser-remediation test: original acceptance/current run, conflicts preserved, no old work. |
| P1B1-05 | PASS | `identical_callers_with_both_lookups_absent_execute_exactly_once`, direct-acceptance race and storage acceptance-lock tests: one execution/one duplicate; active-run and session isolation retained. |
| P1B1-06 | PASS | Owned recording, supplied-ID and rename-during-execution tests: acceptance precedes open; caller UUID is runtime UUID; session/source/provider identities remain distinct. |
| P1B1-07 | PASS | `owned_send_task_records_real_text_and_arithmetic_loops`: real T/A/B controller and registry paths store actual input/events/results/RunResult with exact request and execution counts. |
| P1B1-08 | PASS | `incremental_commit_visibility_and_dropped_reader_do_not_own_execution` and F13: precommit invisibility and committed partial history while provider remains pending. |
| P1B1-09 | PASS | Scripted and WS/SSE persisted tests compare exact native/effective/provenance/usage/index/string/opaque values without reconstruction or diagnostic leakage. |
| P1B1-10 | PASS | Invalid-batch, intent-commit cancellation and awaitable-preflight tests: full validation before intent/effect, committed terminal before intent and intent before execute. |
| P1B1-11 | PASS | Tool observer and persisted recording tests: exact success, gateway_error, tool_output_limit and error-shaped Ok output/flag after cache and before finish/continuation. |
| P1B1-12 | PASS | Reuse and S2 deletion tests: one effect/result, original result request retained, current reuse correlation, no reread or second result; cache remains run-scoped. |
| P1B1-13 | PASS | Acceptance, intent, pending-tool, result-commit, provider-wait and terminal cancellation tests: admitted SQL drains, completed result survives, pending result is not fabricated and later work stops. |
| P1B1-14 | PASS | First RunFinished and final-record fault tests preserve actual Completed result, sink distinction, attempted operation and committed terminal state without synthetic replacement. |
| P1B1-15 | PASS | Provider outcome and malformed/failed-admission SSE tests preserve actual outcome and not_submitted/unknown/terminal_received with no fallback or invalid-output effects. |
| P1B1-16 | PASS | Stage fault, unknown commit, dropped waiter and real SQLite busy/constraint tests preserve first stage/operation/receipt/outcome/certainty and proven prefix without retry or fake rollback. |
| P1B1-17 | PASS | Cleanup-warning and remediation tests stop after acceptance/intermediate warnings and return actual Executed completion for a committed final record warning. |
| P1B1-18 | PASS | Storage execution-hold and core close tests prove child close notification, drain of hold plus SQL, no long DB/session/maintenance lock, healthy unlock and no deadlock. |
| P1B1-19 | PASS | Never-polled and isolated child drop/abort/panic tests prove zero unpolled effects, provider close, quarantine and lease retention until exit without fabricated terminal state. |
| P1B1-20 | PASS | `p1b1_20_process_postcommit_prefixes_reopen_once_and_old_submissions_never_resume`: all required prefixes survive, interruption occurs once, terminals remain, and reopen starts no work. |
| P1B1-21 | PASS | Two real persisted WS/SQLite pressure tests saturate the existing 64-slot queue: exact ordered successful history and truthful slow_consumer/Unknown delivered prefix, no retry or false continuation. |
| P1B1-22 | PASS | Persisted WS native/recovered test: one socket/two frames, previous response ID, result-only continuation, exact accepted input/tool bytes and recovery. |
| P1B1-23 | PASS | Persisted SSE labelled/missing-MIME and failure tests: two requests, exact effective history, established malformed identity/admission uncertainty and no fallback. |
| P1B1-24 | PASS | Three persisted S2 tests: metadata without bodies, exact selected CRLF/Unicode bytes before continuation, deletion reuse, committed error and full-batch invalid-authority rejection; resources/scripts inert. |
| P1B1-25 | PASS | Two independent-observation tests: dropped admitted history reader does not cancel retained execution, second reader recovers Running history, rename works and two sessions isolate data. |
| P1B1-26 | PASS | Diagnostic/privacy and receipt-bound tests: static stage/category output, no sensitive canaries, unchanged error maps and bounded retained receipt/operation state with explicit stored access. |
| P1B1-27 | PASS | F01-F12 and source inspection preserve legacy run/CLI/context/auth/provider/storage behavior, RunRequest, schema 1/2/1, input limits, dependencies and ordinary CLI nonpersistence. Native submitted-head macOS/Windows execution remains pending. |
| P1B1-28 | PASS | F09-F15 and docs: public offline example proves partial and pre-continuation reads, terminal storage and no-work reopen; existing examples pass; dev/release timings, exact counts and sizes recorded. |
| P1B1-29 | PARTIAL | F01-F18 pass, each prior increment completed independent review, and three fresh reviewers passed the complete tracked/untracked diff and reports with no blocking findings. Exact submitted-head Ubuntu/macOS/Windows CI is NOT RUN without commit/push authorization. |

## Process, fault and pressure evidence

The execution process fixture drives real child processes through provider and tool
waits. Direct future drop, task abort and panic all close the core provider. An
unfinished execution hold marks the store unhealthy and keeps the root lease until
process death. Parent tests then reopen and inspect the same root. These tests do not
equate browser disconnect with task cancellation.

Fresh-process prefix cases cover committed acceptance, partial Unicode/control text,
tool intent, exact success result and exact error-shaped result. Reopen uses existing
P1-A interruption once, preserves terminal controls and records zero provider
construction/open/request, tool execution or continuation. Duplicate old operation
identity remains duplicate.

Storage failure tests combine labelled commit/cleanup outcomes with real SQLite busy
and constraint failures. The first failed stage, operation ID, commit certainty,
committed acceptance and observed RunResult are retained where applicable. No retry,
replacement operation ID, fabricated result or best-effort synthetic terminal is used.
These fixtures do not prove physical device failure or power-loss durability.

The pressure success test pauses the first text-delta commit and fills the existing
64-slot provider queue with a 65-event burst. It proves all 69 provider observations
and 76 history records are stored exactly once in source order, including terminal
completion. The deterministic slow-consumer case records the 68 delivered observations
and 75 history rows, permits the unsent source sequence to remain absent, and records
no ResponseFinished, retry, tool or continuation. Production capacity and timeouts are
unchanged.

## Loopback and S2 evidence

P1B1-22 uses the public persisted path, actual OpenAI WebSocket adapter, real registry
and SQLite. It asserts one socket, two frames, `previous_response_id`, result-only
continuation, exact stored input/result and native/recovered terminal behavior.

P1B1-23 exercises labelled and missing-MIME SSE admission. The second HTTP request
contains exact effective native history and committed correlated result. Malformed
identity and failed admission retain existing error and uncertainty behavior without
transport fallback.

P1B1-24 prepares nonempty global/project S2 catalogs. Initial stored input advertises
metadata but no body. Real `load_skill` commits exact selected project instructions
before continuation. Deleting the source then reusing the call returns cached bytes
without reread or second result row. Changed frontmatter commits exact gateway_error.
An unqualified same-name authority fails full-batch preflight before both calls.
Resource and script canaries remain inert.

## Performance observations

These values are finite local observations, not benchmarks, percentiles, fastest
claims or SLAs. They include scheduling, barrier reads and operation-scoped connection
open/validation/commit/close. They do not isolate SQL-only latency.

| Profile/run | Execution end-to-end ms | Recording window ms | Example end-to-end ms | Tool cycle to continuation ms |
|---|---:|---:|---:|---:|
| Final dev example F13 | 576.044 | 715.869 | 958.008 | 236.068 |
| Final dev counter test F14 | 956.895 | 1108.145 | not printed | 414.918 |
| Final release example F15 | 499.682 | 585.061 | 837.474 | 202.390 |

F14 reports exact recording-window counters:

- recording write transactions: **15**
- catalog-refresh write transactions: **1**
- explicit read transactions: **6**
- connection opens/closes: **76/76**
- active connections after the window: **0**

After close, each final persisted example observed a **36,864-byte catalog** and a
**94,208-byte session database**. Catalog/session WAL files were zero bytes after close.
This does not measure transient WAL volume.

F13's two text acknowledgment samples were 28.094/26.274 ms. F15's were
28.249/25.857 ms. F14 was intentionally noisier at 38.337/52.919 ms. The example also
measures partial/final reads, refresh and reopen. No performance policy or hidden
connection pool follows from these samples.

## First failures and fixes

| Stage | Preserved failure | Fix and result |
|---|---|---|
| Core composition review | Review confirmed definitions were read twice, a concurrent absent-lookup loser could fail current preflight instead of returning Duplicate, and final committed cleanup warning returned failure. | Snapshot definitions once, coordinate recheck/preflight/acceptance through weak keyed ownership, and return Executed for final committed cleanup. Full suites and repeat reviews passed. |
| Commit/fault tests | Initial new test/fixture compilation and formatting issues occurred while adding closed selectors and process fixtures. | Corrected fixture types and selectors; focused execution/storage/process suites and reviews passed. No production failpoint API was added. |
| P1B1-22/23 and P1B1-24 | Initial new-file formatting checks failed. | Formatted files; focused loopback, context, execution and storage suites passed. |
| P1B1-21 | An unnecessary post-Close socket flush received ConnectionReset. | Removed the flush. Both pressure tests and three reviews passed. |
| P1B1-25 review | One reviewer questioned detached-reader drain proof and per-session tool/title evidence. | Two independent verifications rejected both as non-reproducible P1B1-25 blockers against the actual paused backend ownership and row allocation. No speculative change was made. |
| P1B1-28 | A helper produced E0277 from an implicit Sized bound; format checks failed. Review then confirmed result readability was shown after, not before, continuation admission. | Accept unsized serialized values, format, and move the second-turn barrier into `generate` before request admission. Focused tests/examples and repeated review passed. |
| Final F03 | Two exact full-suite attempts reported 338 passed, 1 failed, 2 ignored. The pre-existing 4,097-event consistency case received `timeout` instead of `protocol_error` under parallel load. Its exact focused run passed in 14.96 seconds. | Extend only the `event bound` loopback test's total deadline from 10 to 30 seconds. Production deadlines, queue capacity, consumer timeout and event bounds did not change. Focused F18, exact F03 and F07 all passed. |

## Independent reviews

Each implementation increment received three independent reviewers with identical
scope. Shared observation, lifecycle hold, commit/fault boundaries, process recovery,
WS/SSE loopbacks, S2, pressure and the example/docs increment passed their review gates.

Core composition required one remediation round for one-read definitions, concurrent
acceptance coordination and final cleanup semantics. Its repeated three-review gate
passed. The example/docs increment required the pre-continuation ordering fix and then
passed repeated review. P1B1-25 had one review with two evidence concerns; independent
verification rejected both against executed behavior and exact row scope.

Three fresh reviewers inspected the complete tracked/untracked diff and both reports.
All returned PASS with no blocking findings. Review-a and review-b checked inventory,
contract mapping, API/schema/dependency preservation and report evidence. Review-c also
reran `cargo fmt --all -- --check`, `cargo test --all-targets` and `git diff --check`;
its full suite reported 601 passed and two ignored. Informational notes covered the
case-local stress timeout, validated UUID parse invariant, unreachable duplicate cleanup
edge and equivalent example command flags. No implementation change was required.

## Limits and deferred work

- Exact submitted-head push and PR CI on Ubuntu, macOS and Windows is **NOT RUN**.
  Commit and push require separate owner authorization.
- Local platform execution is Linux/WSL. Whole-repository platform-excluded counts were
  not inferred.
- B1 executes only the explicitly supplied `PreparedRun`. It does not read retained
  conversation history into the provider request. B2 remains required.
- Ordinary `wi run` remains nonpersistent. The application session interface, service
  owner, browser protocol, service authentication and GUI/V1 remain later work.
- No resumption, retry/failover, background write queue, scheduler, alternate database,
  new provider, permission system, new dependency or production timeout was added.
- Tests do not establish actual model adherence, physical power-loss behavior,
  arbitrarily slow disk support or exactly-once external effects across separate runs.
- The ledger remains **31/50 used, 19 remaining**. Balance is not authorization.

No local verification result authorizes staging, commit, push, merge, release,
deployment or B2/V1 work.
