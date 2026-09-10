# Wi C1 verification: observed offline acceptance

Contract **c1.1**. C1 implementation is **complete but uncommitted**.
**Offline gates PASS; independent review PASS; offline acceptance PASS/accepted.**
**Blockers: none. Real auth/live provider work: NOT RUN and unauthorized.**

| Revision or status | Record |
|---|---|
| Runtime baseline | `640b221b70dbb4d68704e6fa70d12f9533654cf5` |
| Documentation-branch HEAD throughout implementation | `870f3c4c4446d787114b7fd0c4e558d4838f851d` |
| Implementation revision | `uncommitted_worktree`; implementation commit is null, not HEAD |
| Ledger | **31/50 used, 19 remaining**; unchanged; remaining balance is not authorization |
| Platform coverage | Local Linux only |
| Companion report | `docs/wi-execution-policy-c1-verification.json` |

## Evidence boundary

- The parent observed the baseline and final Cargo, verifier, Node and example results supplied in this assignment. The report author did not rerun those runtime gates.
- The parent supplied the increment reviews, remediation results and independent complete-diff reviews. No reviewer or other agent process was started in increment 4.
- The report author directly inspected HEAD/status/diff, current control flow, assertions, active documentation, source searches and old/new test names. Report checks are recorded below.
- Source review and authored assertions are not additional runtime executions. This is not a whole-repository audit, benchmark, security certification or proof that every retained setting is necessary.
- Governing C1 documents retain their historical PLAN ONLY/NOT RUN text unchanged. These two new reports record observed acceptance. Historical M3/auth/live results do not become C1 live evidence.
- JSON report `schema_version: 1` describes the report document only. Runtime outer run events use schema 2; nested provider events remain schema 1.

## Environment and baseline

Parent-observed environment: Linux 6.18.33.2-microsoft-standard-WSL2 x86_64;
rustc 1.98.1; cargo 1.98.1; Node v24.18.0; uv 0.12.10. No hosted or non-Linux execution is claimed.

Final isolation used `HOME=/tmp/wi-c1-final.SWGC69`, with `XDG_CONFIG_HOME` and
`CODEX_HOME` beneath that directory. Exact child paths were not supplied.
`CARGO_HOME=/home/gc/.cargo`, `RUSTUP_HOME=/home/gc/.rustup` and
`CARGO_NET_OFFLINE=true` selected trusted existing development caches.
The temporary HOME is an observed location, not a portable or guaranteed-existing reproduction path.
Credential locations were isolated; these development-cache paths do not imply credential reads.

The parent initially observed a clean worktree at the documentation-branch HEAD.
The first attempt isolated HOME but omitted explicit CARGO_HOME/RUSTUP_HOME.
Offline Cargo could not find cached `async-stream`. This failure occurred before tests;
it was an environment setup failure, not a product failure.

| Baseline attempt | Command | Parent-observed result |
|---|---|---|
| Initial | `uv run scripts/verify.py` | ENVIRONMENT_SETUP_FAILURE before tests: missing offline cached async-stream |
| Initial | `cargo run --example run_offline` | ENVIRONMENT_SETUP_FAILURE before execution for the same cache error |
| Initial | `node scripts/cli_retest.mjs --self-test` | PASS: 152; live_started:false |
| Corrected | `uv run scripts/verify.py` | PASS: all six Cargo gates; cargo test --all-targets totaled 244 passed |
| Corrected | `node scripts/cli_retest.mjs --self-test` | PASS: 152; live_started:false |
| Corrected | `cargo run --example run_offline` | PASS: completed at 50; one session, 3 requests, 2 executions |

Numeric baseline exit codes were not supplied and are null in JSON, not invented.
Corrected isolation used isolated HOME/XDG_CONFIG_HOME/CODEX_HOME with explicit
`/home/gc/.cargo`, `/home/gc/.rustup` and offline Cargo. Baseline verifier inventory:
61 source files, 231 Rust test definitions, 25 fixture events.
The six baseline Cargo gates are the same F1-F6 commands listed below, run by
`scripts/verify.py:53-65`.

## Final parent-observed command results

These commands ran after runtime/tests/active documentation changes, before report creation.
All exit codes below are observed 0.

| ID | Exact command | Exit | Result |
|---|---|---:|---|
| F1 | `cargo fmt --all -- --check` | 0 | Formatting check passed. |
| F2 | `cargo check --all-targets` | 0 | All targets checked. |
| F3 | `cargo test --all-targets` | 0 | 260 passed; 0 failed; 0 ignored. |
| F4 | `cargo clippy --all-targets -- -D warnings` | 0 | Strict Clippy passed. |
| F5 | `cargo build --all-targets` | 0 | All targets built. |
| F6 | `cargo test --doc` | 0 | 0 doctests. |
| F7 | `uv run scripts/verify.py` | 0 | All six Cargo gates passed; no live provider requests. |
| F8 | `node scripts/cli_retest.mjs --self-test` | 0 | 152 passed; live_started:false. |
| F9 | `cargo run --example run_offline` | 0 | Completed: 50 (1 session, 3 model requests, 2 tool executions; offline) |
| F10 | `git diff --check` | 0 | No tracked whitespace errors. |

F3 totals: **202 library + 17 binary + 1 managed_absence_cli + 4 provider_contract +
4 run_cli + 32 run_controller = 260**. No failed or ignored tests.
F7 inventory: **62 source files, 247 Rust test definitions, 25 fixture events**.
Rust executions increased **244 -> 260 (+16)**. Verifier definition inventory increased
**231 -> 247 (+16)**. Node self-tests remained **152 -> 152**; fixture events remained **25 -> 25**.
The definition count is the verifier's regex inventory (`scripts/verify.py:20-26`),
not a separate executed-test total. There is **no target-count requirement**.

## Removed feature and retained controller contract

Current source and the diff show deletion of:

- `RunLimits`, its Default, validation, serde, export, helper and constructor uses;
  `RunRequest.limits` and every supplied configuration/serialization path.
- `LimitKind`, `RunOutcome::LimitReached`, the `limit` helper and run-budget errors/branches.
- Controller count preflight, whole-run deadline creation, timer races and deadline-only Instant/Duration plumbing.
- `--max-model-requests`, `--max-tool-executions`, `--deadline-seconds`, their defaults,
  ranges/help, and CLI limit display/payload branches.
- The `RunStarted` limits payload and example limit construction.
- The eight-call batch gate, 128-entry lifetime result-cache gate and `PreparedBatch.new_executions`.

There is no Option/no-op/renamed/feature-gated run or cache budget, preset,
environment/config fallback, sentinel, reservation/eviction subsystem, compatibility wrapper,
universal tool timeout or progress API. The pre-existing private consistency byte `Budget`
is a different mechanism, explained under source searches.

`src/run/mod.rs:18-91,142-400` retains the unchanged
`wi::run::run(gateway, request, tools, cancel, emit)` operation. Strict `RunRequest`
contains exactly `provider_id`, `options` and `prompt`. `RunOutcome` contains only
`Completed`, `Failed { code }` and `CancelledLocally`.
A run owns one provider session and a fresh tool-result scope.
Cancellation, full-batch authority/identity/schema validation, ordered execution/reuse,
correlation, recovery/provenance, uncertainty and execution-versus-delivery semantics remain.

`src/run/events.rs:35-59` retains four lifecycle kinds and two wrappers.
Outer schema 2 emits payload-free `run_started`; nested provider envelopes remain schema 1.
Checked u64 counters and sequence observe work. `counter_overflow` is a static representation error,
not a quota or an unlimited sentinel (`src/run/mod.rs:64-69,407-447`).

`MAX_INPUT_ITEMS=128` names existing per-request compatibility. A 129-result batch
fails before dispatch (`src/tools.rs:159-168`). After execution, `validate_input`
checks the complete actual result vector before submission (`src/run/mod.rs:397-400`).
No subset is sent and no completed effect is represented as rolled back.
Cached results can grow until the scope is released. There is no eviction, replacement
capacity, durable exactly-once guarantee or universal cache/RSS bound for arbitrary providers.

## Acceptance matrix

Every row is **PASS for offline acceptance**. E01-E14 identify inspected assertions below;
their runtime basis is the parent's successful F3/F7 results, not another execution by this author.

| ID | Status | Assertion | Evidence |
|---|---|---|---|
| C1-00 | PASS | Baseline HEAD/worktree and Cargo/Node evidence recorded; user work, historical auth/M3 evidence and ledger preserved; no real credentials or provider traffic. | baseline; worktree_state; live_status; ledger |
| C1-01 | PASS | RunLimits, request limits, limit outcomes, quota bookkeeping and whole-run timers are deleted without an optional, no-op or renamed substitute. | E01; implementation_changes; source_search |
| C1-02 | PASS | Task-only public request and unchanged run entry point support T/A/B completion with one session and independent provider-native shapes. | E01; E02 |
| C1-03 | PASS | L completes 161 requests and 160 executions/results in one session with exact correlation/order and no hidden count stop, eviction/reexecution or detached work. | E03; E08 |
| C1-04 | PASS | Pending synthetic work survives logical 121/601/3601 seconds, then completes on release with a consumed result; no real long sleep or controller timer. | E04 |
| C1-05 | PASS | Omitted test-tool timeout waits for release/cancel; supplied tool-owned timeout gives an ordinary correlated result, with no production Tool/add_numbers timeout API. | E04 |
| C1-06 | PASS | Cancellation checkpoints and cancellation-aware awaits retain cleanup/uncertainty and prevent later work, partial result submission and fabricated successful finishes. | E05 |
| C1-07 | PASS | Completed-no-call selection survives late observer cancellation; pending calls still stop; sink and final-delivery failures preserve execution-versus-delivery semantics. | E06 |
| C1-08 | PASS | Nine-call C executes in order; 129 result items reject before dispatch; complete actual result-vector byte/shape validation precedes submission without subsets or rollback. | E07 |
| C1-09 | PASS | More than 128 results remain reusable without reexecution; conflicts and scope isolation remain; quota-only bookkeeping is removed and cache growth is disclosed. | E08; implementation_changes |
| C1-10 | PASS | Whole-batch authority, identity, arguments/schema and executable-item checks remain fail-closed before new execution, including when cached calls are present. | E09 |
| C1-11 | PASS | Recovery/provenance, consistency before settlement, correlation, incomplete/error outcomes and exact uncertainty remain covered; independent failure/sink/drop assertions survive migration. | E10; test_migration |
| C1-12 | PASS | WS/SSE loopback traces cross old small defaults with 10 requests/9 executions, same-socket WS linkage and effective-native SSE replay; transport/auth settings are unchanged. | E11 |
| C1-13 | PASS | CLI help removes all three flags; each fails as unknown before auth/provider construction; no fallback setting replaces them and existing CLI behavior remains. | E12; source_search |
| C1-14 | PASS | Outer schema 2 has payload-free run_started; strict requests reject obsolete limits, including null; removed outcomes are rejected and nested provider schema 1 remains unchanged. | E01; E14 |
| C1-15 | PASS | Checked u64 counters are observations, not quotas or sentinels; retained payload/history/network/auth settings are scoped and disclosed as Wi choices. | E13; retained_constraints |
| C1-16 | PASS | Policy-only assertions are deleted/replaced, independent safety assertions retained or moved; example ends at 50 and watchdogs/oracles remain outside runtime policy and live CI. | E14; test_migration; test_supervision |
| C1-17 | PASS | Six Cargo gates, verifier, Node self-tests, offline example and diff checks pass; independent complete-diff review passes; all rows, counts, constraints and NOT RUN live status are recorded. | final_command_results; reviews; test_counts; report_checks; live_status |

### Evidence catalogue: paths, named tests and assertions

- **E01**: `src/run/mod.rs:18-91,142-400`; `src/run/events.rs:35-59`;
  `src/run_cli.rs:181-208`; tests at `tests/run_controller.rs:117-187`:
  `run_request_contains_only_task_fields_and_rejects_obsolete_configuration`,
  `run_outcome_accepts_only_execution_outcomes`, `run_started_is_payload_free_in_schema_two`.
  Strict task-only request, three outcomes, payload-free outer schema 2 and unchanged nested schema 1; no run-policy argument or stop branch.
- **E02**: `tests/run_controller.rs:190-305`; `tests/run_support/mod.rs:1`;
  `tests/provider_contract.rs:1`: `run_t_empty_reasoning_refusal_and_provenance_are_terminal`,
  `run_a_b_c_exact_inputs_order_and_lifecycle`.
  T/A/B and ordinary batches use the public controller with independent non-OpenAI native shapes, exact input/order and one session.
- **E03**: `tests/run_support/workloads.rs:8-83`:
  `run_l_160_distinct_calls_then_final_uses_161_requests`.
  L completes with one session, 161 attempts/admissions/turns, 160 executions/results, exact identities/order, correlated events and no retained session/tool work after yields.
  This crosses old 4/8/32/128 thresholds under a finite tiny workload, not a memory benchmark or proof of infinite execution.
- **E04**: `tests/run_support/stop.rs:80-302`; `src/tools.rs:16-22,251-282`:
  `run_pending_tool_survives_120_600_3600_seconds_then_release_or_cancel`,
  `run_tool_owned_optional_timeout_is_an_ordinary_correlated_result`.
  Paused time reaches 121/601/3601 seconds with pending work; release consumes the result or cancellation drops it. Test-only timeout_seconds=7 returns a correlated ordinary error, or succeeds when released at 6 seconds.
  Omission waits for release/cancel. The production Tool trait and add_numbers receive no timeout setting.
- **E05**: `tests/run_controller.rs:308-400`; `tests/run_support/stop.rs:15-77,389-582`;
  `src/tools_batch_tests.rs:583-797`; `src/run/mod.rs:450-456`:
  `run_preadmission_rejects_without_observation_or_work`,
  `run_cancel_open_generate_receipt_and_drop_cleanup`,
  `run_pending_tool_cancel_and_future_drop_no_fabricated_finish`,
  `run_cancel_after_completed_turn_preserves_results_and_drops_later_tool`,
  `run_cancel_boundaries_never_submit_partial_batch_or_rewrite_terminal`,
  `ready_cancellation_does_not_poll_ready_work`.
  Pre-admission, open, generate, receipt/events, tool and between-call cancellation retain cleanup and exact uncertainty; no later work, partial submission or fabricated finish.
- **E06**: `tests/run_support/stop.rs:585-660,700-759`;
  `tests/run_controller.rs:722-797`; `tests/run_support/boundaries.rs:4-44`;
  `src/run_cli_tests.rs:252-315`:
  `run_cancel_on_completed_no_call_provider_terminal_preserves_completion`,
  `run_sink_variants_stop_once_and_final_failure_preserves_outcome`,
  `run_nonblocking_channel_observer_full_and_closed_stop_work`,
  `run_sink_finish_and_reuse_failures_stop_without_prepared_results`,
  `run_cli_broken_output_stops_work_and_final_sink_error_overrides_completed`.
  Selected completed no-call disposition wins over later cancellation; Full/Closed/Failed sinks stop later work; final delivery failure does not rewrite execution success.
- **E07**: `tests/run_support/workloads.rs:86-243`; `src/tools_batch_tests.rs:226-286`;
  `src/tools.rs:159-168`; `src/run/mod.rs:397-400`:
  `run_c_nine_calls_execute_and_submit_in_order`,
  `run_result_item_capacity_fails_before_new_execution`,
  `run_validates_complete_actual_result_bytes_before_submission`,
  `nine_calls_and_input_capacity_batch_execute_in_order`,
  `result_item_capacity_rejects_whole_batch_before_dispatch_or_reuse`.
  Nine and 128 small calls fit; 129 fail before execution. Fifteen 64 KiB outputs fit the actual input vector; sixteen exceed 1 MiB after execution and submit no subset or next request.
  The failed submission does not undo the sixteen completed tool effects.
- **E08**: `src/tools_batch_tests.rs:289-461`; `tests/run_controller.rs:613-719`;
  `src/tools.rs:46-61,150-175`:
  `all_160_cached_results_survive_reuse_conflicts_and_fresh_scope`,
  `dropping_prepared_batch_does_not_execute_or_cache`,
  `fresh_scopes_share_tools_but_never_consume_or_mutate_template_cache`,
  `run_cached_batches_reuse_results_without_new_dispatch`,
  `run_scope_isolation_conflicts_mixed_cache_and_capacity`.
  All 160 cached identities remain reusable without reexecution; changed name/arguments conflict; fresh scopes isolate results; dropped prepared batches do no work.
- **E09**: `src/tools_batch_tests.rs:83-223`; `tests/run_controller.rs:425-466`;
  `src/tools.rs:105-168`:
  `whole_batch_authority_rejects_before_dispatch_or_reuse`,
  `call_id_at_512_byte_boundary_produces_valid_input`,
  `cached_calls_still_require_authority_and_schema`,
  `run_whole_batch_invalid_authority_has_no_dispatch`.
  Malformed/incomplete calls, invalid arguments/schema, wrong/oversized/duplicate identities, unsupported namespace/caller/tool and unknown executable output reject the whole batch, including cached calls.
- **E10**: `tests/run_controller.rs:469-610`; `tests/run_support/boundaries.rs:47-146`;
  `tests/run_support/stop.rs:663-697`; `src/providers/openai_codex/recovery_tests.rs:1`,
  `consistency_tests.rs:1`, `consistency_settlement_tests.rs:1` in the same directory;
  `src/providers/openai_codex/session.rs:342-372`:
  `run_outcomes_unsupported_output_and_exact_upstream_assessment`,
  `run_collector_rejects_identity_order_idle_close_eof_and_accepts_gaps`,
  `run_cross_turn_sequence_failure_keeps_prior_validated_response`,
  `run_extension_envelope_is_opaque_and_turn_sink_failures_stop`,
  `run_ordinary_tool_errors_and_output_bounds_are_correlated_results`.
  Effective recovery/provenance, consistency before settlement, stream correlation, incomplete/error handling and not_submitted/unknown/terminal_received categories remain covered.
- **E11**: `src/providers/openai_codex/run_loopback_tests.rs:354-499`;
  `src/providers/openai_codex/mod.rs:116-139`:
  `run_websocket_nine_cycles_keep_one_socket_and_exact_linkage`,
  `run_sse_nine_cycles_replay_all_effective_native_history`.
  Both loopback traces complete 10 requests and 9 executions. WS keeps one socket and exact previous_response_id linkage. SSE replays full effective native history, including recovered opaque items; synthetic auth and existing test transport settings remain unchanged.
- **E12**: `tests/run_cli.rs:24-134,169-253`; `src/run_cli_tests.rs:127-224,318-396`:
  `run_binary_help_and_clap_conflicts_do_not_need_auth_locations`,
  `removed_run_flags_are_unknown_before_auth_setup`,
  `run_binary_prevalidation_precedes_external_and_managed_auth_location`,
  `run_cli_real_handler_json_outer_only_defaults_and_opt_in_tools`,
  `run_cli_refusal_completed_exit_code`,
  `run_cli_handler_prevalidates_before_factory_and_reads_bounded_utf8`.
  Help omits deleted flags; each is an unknown argument before auth/provider setup. Existing auth-source, tool opt-in, input/model/transport, rendering and exit behavior remain.
- **E13**: `src/run/mod.rs:64-69,238-400,407-456`; `src/provider.rs:12-15`:
  `counters_cross_u32_and_fail_without_wrapping_at_u64`,
  `event_sequence_overflow_fails_delivery_without_wrapping`.
  Counters cross u32 and fail at unrepresentable u64 increments without wrapping; counters observe work, not permission. Retained numeric guards are separate Wi choices.
- **E14**: `examples/run_offline.rs:140-184`; `scripts/verify.py:16-66`;
  `scripts/cli_retest.mjs:272-337`; `README.md:132`; `docs/ARCHITECTURE.md:139`;
  `docs/EVENTS.md:170`. F8/F9 and source review:
  Offline example ends at 50 with 1 session/3 requests/2 executions; fixed smoke/demo oracles and external watchdogs remain outside generic run policy; no new live CI commands.

## Policy-test migration

Quota/deadline-only assertions were deleted. Independent cache, cancellation, sink,
drop, authority and ordinary tool-error assertions were retained or moved.

| Path | Old name | Retained-coverage name | Disposition |
|---|---|---|---|
| `tests/run_controller.rs:613-628` | `run_model_tool_limits_and_cached_batches_are_atomic` | `run_cached_batches_reuse_results_without_new_dispatch` | Cache reuse retained; count-stop cases deleted |
| `tests/run_support/stop.rs:389-431` | `run_pending_tool_cancel_deadline_and_future_drop_no_fabricated_finish` | `run_pending_tool_cancel_and_future_drop_no_fabricated_finish` | Cancellation/future-drop cleanup and no fabricated finish retained; deadline modes deleted |
| `tests/run_support/stop.rs:434-479` | `run_absolute_deadline_includes_completed_turn_and_later_tool` | `run_cancel_after_completed_turn_preserves_results_and_drops_later_tool` | Prior completed results and later pending-tool drop retained; cancellation replaces deadline trigger |
| `src/run_cli_tests.rs:207-224` | `run_cli_refusal_completed_and_tool_limit_exit_codes` | `run_cli_refusal_completed_exit_code` | Completed refusal exit retained; quota outcome/exit cases deleted |
| `src/tools_batch_tests.rs:363-372` | `prepared_batch_exposes_whole_new_dispatch_budget_without_work` | `dropping_prepared_batch_does_not_execute_or_cache` | Preflight/drop no-work assertion retained; advance quota accounting deleted |
| `src/tools_batch_tests.rs:706-775` | `cooperative_pending_tool_is_dropped_on_cancel_deadline_or_future_drop` | `cooperative_pending_tool_is_dropped_on_cancel_or_future_drop` | Cancellation/drop, empty cache and no successful finish retained; deadline case deleted |

- Deleted `run_deadline_open_generate_receipt_and_cancel_priority`. Independent
  cancellation/open/generate/receipt/drop coverage remains in
  `run_cancel_open_generate_receipt_and_drop_cleanup` (`tests/run_support/stop.rs:15-77`)
  and `ready_cancellation_does_not_poll_ready_work` (`src/run/mod.rs:450-456`).
- Replaced `capacity_counts_only_new_distinct_ids_and_preserves_eight_call_cap`
  with `nine_calls_and_input_capacity_batch_execute_in_order`,
  `result_item_capacity_rejects_whole_batch_before_dispatch_or_reuse` and
  `all_160_cached_results_survive_reuse_conflicts_and_fresh_scope`
  (`src/tools_batch_tests.rs:226-360`).
- In-place changes remove RunLimits constructors and invalid quota/range cases
  from pre-admission/CLI tests without removing capability/input/auth ordering.
  Cache/scope tests lose budget mutation. Schema and negative obsolete request/outcome/flag assertions replace policy enforcement.
- New coverage includes the four named tests in `tests/run_support/workloads.rs`,
  logical-time/tool-owned-timeout tests in `stop.rs`, >128 cache tests,
  strict API/schema/CLI absence tests, checked-counter/cancellation tests and WS/SSE threshold traces.
  E01-E14 record exact names and assertions.
- No unprovided test-first failure transcript is claimed. The supplied observed failures
  are the initial cache environment failure and the confirmed Clippy finding below.

## Source-search results and interpretation

The report author ran these exact read-only searches:

1. `rg -n 'RunLimits|LimitKind|LimitReached|new_executions|max_model_requests|max_tool_executions|deadline_seconds|--max-model-requests|--max-tool-executions|--deadline-seconds|limit_reached' src tests examples scripts README.md docs/ARCHITECTURE.md docs/EVENTS.md Cargo.toml Cargo.lock`
2. `rg -n -i 'budget|quota|deadline|run.?limit|cache.{0,25}(limit|cap|evict)|max_(model_requests|tool_executions)' src/run src/run_cli.rs src/tools.rs src/provider.rs src/providers/openai_codex/consistency.rs Cargo.toml`
3. `rg -n -i 'RunLimits|LimitKind|LimitReached|new_executions|max_model_requests|max_tool_executions|deadline_seconds|--max-model-requests|--max-tool-executions|--deadline-seconds|limit_reached|budget|quota|deadline|evict|reserve|reservation' src tests examples scripts Cargo.toml .github`

Search 1 returned eight matching lines, all intentional negative tests:
`tests/run_cli.rs:47-49,103-105` and `tests/run_controller.rs:130,161`.
Search 2 returned four `Budget` lines in `src/providers/openai_codex/consistency.rs:28,29,82,137` only.
Search 3 also found retained auth/prolog timers, test/helper watchdogs and incidental
`preserve` words. Those matches are not a replacement run/cache quota.
Historical documents and negative tests may name deleted policy.

The private pre-existing `consistency::Budget` implements `Write` to count serialized
per-request evidence bytes without another JSON buffer. `Lifecycle::observe` uses it
before retaining item/text evidence (`consistency.rs:28-39,70-163`). It is unchanged
from HEAD, has no RunRequest/CLI integration and is not the deleted feature or a new
cache reservation system. Searches are static evidence, not runtime proof.
Control-flow and assertion review supplied the causal interpretation.

## Retained constraints

Exact numeric settings are **Wi choices**, not automatically provider requirements or
proven optimal values. C1 preserves these scoped safeguards. No claim of exhaustive
usefulness or credential/security verification follows from this source review.

| ID | Current source | Setting | Concrete purpose/effect |
|---|---|---|---|
| R01 | `src/provider.rs:12-15,127-194`; `src/run_cli.rs:1` | 1 MiB serialized input and session configuration; 1..128 input items per request; nonempty user text/instructions; model name at most 256 bytes. | Bounds individual configuration/input payloads and rejects invalid shape before admission. MAX_INPUT_ITEMS=128 is existing request compatibility, not a lifetime execution allowance. |
| R02 | `src/provider.rs:87-144`; `src/tools.rs:105-168,212-281` | 32 declared tools; tool name 1..64 ASCII alphanumeric/underscore/hyphen bytes; description at most 8192 bytes; object parameter schema; call IDs 1..512 UTF-8 bytes; tool arguments and serialized output at most 64 KiB. | Bounds declaration/execution payloads and enforces identity/schema/authority. Oversized tool output becomes a correlated tool_output_limit error result; i64 addition uses checked arithmetic. No eight-call or lifetime cache-count gate remains. |
| R03 | `src/provider.rs:14`; `src/providers/openai_codex/state.rs:20-161` | 2048 retained history items and 8 MiB serialized history; exactly the outstanding tool-result IDs before continuation. | Bounds retained/replayed provider context without automatic compaction and rejects missing/unknown/duplicate results. Can still stop long tasks; not a universal cache/RSS bound. |
| R04 | `src/providers/openai_codex/codec.rs:13,239-273` | At most 512 terminal output items. | Bounds decoded output shape; unknown/nonterminal status and malformed output reject. Preserved native items do not grant execution authority. |
| R05 | `src/providers/openai_codex/consistency.rs:8-163`; `src/providers/openai_codex/session.rs:342-372` | Consistency tracking: 4096 events, 512 finalized occurrences, item/content indexes below 512, 1 MiB cumulative serialized item-event/text accounting. | Counts duplicate evidence before retaining copies and rejects conflicting provisional/effective output before settlement. Text copies remain bounded; validated terminal uncertainty is not rewritten. The private byte Budget is pre-existing. |
| R06 | `src/providers/openai_codex/finalized.rs:7-179`; `docs/EVENTS.md:88-103` | Recovery: 4096 observed events, 512 items/indexes below 512, 1 MiB cumulative serialized item-event occurrences; IDs/function names at most 512 bytes; recovered argument JSON object at most 1 MiB. | Bounds complete finalized evidence and fails closed on overflow/identity/lifecycle conflicts. Only eligible explicit-empty successful terminals recover; the executor still applies its stricter 64 KiB argument guard. |
| R07 | `src/providers/openai_codex/wire.rs:26-27,306-308`; `src/providers/openai_codex/sse.rs:6-43` | 8 MiB WebSocket message/frame and SSE frame limits; 32 MiB cumulative response bytes. | Bounds incoming frame/response parsing. SSE fetched bytes are checked before conversion/retention and prolog replay is not charged twice. |
| R08 | `src/providers/openai_codex/wire.rs:56-246`; `docs/ARCHITECTURE.md:88-131` | Missing-MIME SSE prolog: 65536 raw bytes, absolute 10 seconds, response ID 1..512 UTF-8 bytes; diagnostic body classifier at most 4096 bytes. Ordinary rejection sampling: 4096 bytes and 1 second. | First data frame must prove a recognized response before ordinary decoding on the same POST. Bad present MIME/non-2xx reject; diagnostics are opt-in and do not relax admission or retry. |
| R09 | `src/providers/openai_codex/session.rs:18-32,121,150-198,252-263`; `src/providers/openai_codex/wire.rs:325-334` | Provider connect 15 seconds, receive idle 90 seconds, request total 600 seconds, consumer stall 30 seconds; SSE HTTP read 90 seconds/total 600 seconds; admission queue 1, event queue 64 plus one terminal slot. | Bounds a provider operation or blocked consumer, not elapsed controller lifetime or a tool wait between requests. One active generation per session; terminal fallback closes the session. No controller retry/reconnect/fallback. |
| R10 | `src/providers/openai_codex/observation.rs:134-201`; `docs/ARCHITECTURE.md:189-212` | Opt-in smoke observation: diagnostic counts saturate at 4096 per request; diagnostic text at most 1 MiB. | Bounds private comparison evidence and reports safe static categories/counts, not raw secrets. Normal sessions do not allocate this optional observation state; these are not generic run quotas. |
| R11 | `src/providers/openai_codex/auth.rs:22,95-121,174-221` | External auth file at most 1 MiB; regular file, no-follow open, Unix group/other permission bits forbidden; expiry rejected within 30 seconds. | Bounds local parsing and protects credentials. Tokens/headers use redaction, sensitive flags and zeroizing storage; explicit source selection and account affinity remain. Source reviewed only; no real credential file read. |
| R12 | `src/providers/openai_codex/managed_store.rs:10-78,151-163,269-389`; `src/providers/openai_codex/profile_selection.rs:13-59` | Managed store at most 1 MiB; owner-only 0700 directory/0600 files; regular single-link files and no-follow access; profile aliases 1..64 permitted ASCII bytes; nonblocking lock retry window 1 second, with 10 ms waits. | Protects strict versioned auth data and atomic persistence. Stable locking, incarnation/account binding, reauth guards and owned renewal persistence remain; other locking paths may block. No auth policy redesign. |
| R13 | `src/providers/openai_codex/browser_login.rs:31-32,178-267,410-515`; `src/providers/openai_codex/refresh.rs:12-14,53-64` | Browser login total 180 seconds; launcher 10 seconds with 20 ms polling; callback at most 8192 bytes; token/refresh connect/read 10 seconds, exchange 30 seconds, response at most 65536 bytes; state and PKCE verifier each use 32 random bytes. | Bounds separately authorized auth flows and validates loopback callback/state, fixed-TLS token source and expiry. No proxy/redirect/retry; rejected OAuth bodies are not exposed. These commands were NOT RUN for C1. |
| R14 | `src/providers/openai_codex/mod.rs:35-37`; `src/providers/openai_codex/wire.rs:271-438`; `docs/ARCHITECTURE.md:35-50` | Fixed subscription WS/SSE destinations; TLS; no automatic proxy, redirect, retry, reconnect, fallback or mid-session account switch. | Protects credential destination and prevents ambiguous resubmission or connection identity changes. WS retains handshake credentials; SSE prepares/reloads the same bound account for each submission. No new provider/connection lifecycle feature. |

### Test supervision is not product policy

`tests/run_support/workloads.rs:21-26`, `tests/run_support/stop.rs:170-173`,
`src/providers/openai_codex/mod.rs:133-138`, `scripts/cli_retest.mjs:8-15,272-307`:

L uses an external 5-second test watchdog; paused-time tests use a 1-second post-release/cancel watchdog. Loopback-only connect/idle are 3 seconds, total 10 seconds, consumer 100 ms. CLI retest helper uses 180000 ms with 1000 ms termination grace; line 8 MiB, total 64 MiB, stderr 64 KiB, text 1 MiB and IDs 512 bytes.

Supervises finite tests/fixed subprocess cases outside the product controller. Only the Node self-test was run; the live runner was NOT RUN and unauthorized. No detached production tool worker or timer API was added.

## Additional questionable retained surface

These are focused observations, not authorization for C1 deletion or a claim that everything else is necessary.

| Path/symbol | Known/unknown origin | Actual use | Effect/cost | Recommendation |
|---|---|---|---|---|
| `src/providers/openai_codex/consistency.rs:28-39 Budget; Lifecycle::observe at 70-163` | Pre-existing stream-consistency safeguard; exact numeric threshold requester/derivation unknown in this focused review. | Write implementation counts serialized item events/text before retaining consistency evidence. | Avoids a second serialized buffer and rejects oversized per-request evidence; can reject otherwise useful output. Not a run/cache budget replacement. | Retain for C1. Evaluate evidence-cap requirements separately; do not delete or rename merely because Budget matches a search. |
| `src/provider.rs:12-194 input/tool shape caps; src/providers/openai_codex/state.rs:150-161 check_history` | Scope audit identifies Wi-local prototype choices; exact values lack demonstrated provider requirements or measured workflow need. | Session/input validation and provider prepare/settle check payload shape/history; tool preflight reuses MAX_INPUT_ITEMS. | Can reject valid future workloads or end long tasks; full history replay has copying/retention cost and no compaction. Does not bound arbitrary-provider result-cache memory. | Disclose and preserve. Seek separate authority and workload evidence before changing capacities, result chunking, history policy or compaction. |
| `src/demo.rs:11 validate_call; src/demo.rs:63 validate_answer; src/main.rs Command::ToolDemo` | Inherited fixed gateway acceptance/demo case; exact initial requester unknown here, identified as verification instrumentation by the scope audit. | Legacy tool-demo requires one add_numbers call with a=17,b=25, correlated sum=42, and final ordinary text exactly 42. | Intentionally rejects other valid tasks in that demo; maintenance cost is separate from generic wi run, whose offline B example ends at 50. | Keep visibly separate as a regression oracle. Reassess demo lifecycle separately; do not move its expectations into the controller. |
| `src/providers/openai_codex/session.rs:18-32 Timeouts; src/providers/openai_codex/wire.rs:112-113 SSE_PROLOG_TIMEOUT and Wire::open` | Pre-existing accepted transport/admission protections; exact numeric derivation unknown, not established provider law. | Provider worker, receive, consumer delivery, HTTP and missing-MIME admission paths use these timers. | Can stop a slow provider operation even though the controller has no whole-task deadline; timers do not supervise tool waits between requests. | Preserve for C1 and document the distinction. Any tuning/removal requires separate authority and targeted compatibility evidence. |
| `scripts/cli_retest.mjs:272 run(which, launch, deadline, grace)` | Pre-existing fixed CLI verification runner; exact 180000/1000 ms rationale unknown. | Fixed generate/tool-demo subprocess watchdog; self-tests inject fake children. Live mode requires explicit authorization. | Terminates stuck test processes and bounds captured output; can end a fixed live verification case, but is not a production wi run policy option. | Keep outside product policy and retain explicit live authorization. Review watchdog values separately if test workloads change. |
| `src/provider.rs:17 Feature and ItemKind; src/providers/openai_codex/mod.rs:87-114 capability_report` | Scope audit records requested future extensibility but no authorization to implement advanced engines in C1. | Capability checks reject unsupported features; item classification preserves native output without permitting execution. | Adds visible static surface, not implemented steering/search/PTC/async/skills behavior. | Retain the fail-closed boundary for C1. A separate caller/requirements review can decide whether any entries are unnecessary; do not add speculative engines. |

## Review and remediation evidence

Parent-supplied review record:

| Gate | Result |
|---|---|
| Increment 1 A/B/C | PASS; no findings |
| Increment 2 initial review-a | One medium acceptance blocker: clippy::await_holding_lock in tests/run_support/workloads.rs |
| Verification of finding | Confirmed: a MutexGuard lexical scope crossed a later await |
| Remediation | Guard use enclosed in a block at tests/run_support/workloads.rs:36-70, before later yields/awaits |
| Focused remediation checks | Named workload test, fmt, strict Clippy and diff check PASS |
| Repeated increment 2 A/B/C | PASS; no findings |
| Increment 3 A/B/C | PASS; no findings |
| Final independent complete-diff A | COMPLETE-DIFF PASS; no actionable findings |
| Final independent complete-diff B | COMPLETE-DIFF PASS; no actionable findings |
| Final independent complete-diff C | COMPLETE-DIFF PASS; no actionable findings |

The focused test was `run_l_160_distinct_calls_then_final_uses_161_requests`.
The supplied successful checks also name `cargo fmt --all -- --check`,
`cargo clippy --all-targets -- -D warnings` and `git diff --check`.
The exact focused test invocation was not supplied; no command transcript is invented.
The current lexical block is directly visible in source.

The final independent reviewers inspected the complete implementation diff, control flow
and assertions, not only spelling. They found no optional-budget remnant or actionable
scope expansion. Reports were intentionally created after those reviews to record their
results. This is not a claim that these new report texts received those independent reviews.

## Changed paths and worktree preservation

Direct inspection confirmed **17 modified tracked files**, **1020 insertions/564 deletions**
in the tracked diff, plus untracked `tests/run_support/workloads.rs` at **243 lines**.
The workload file is excluded from that tracked diff stat. No changes were staged.

Existing implementation changes, preserved without editing in increment 4:

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/EVENTS.md`
- `examples/run_offline.rs`
- `src/main.rs`
- `src/provider.rs`
- `src/providers/openai_codex/run_loopback_tests.rs`
- `src/run/events.rs`
- `src/run/mod.rs`
- `src/run_cli.rs`
- `src/run_cli_tests.rs`
- `src/tools.rs`
- `src/tools_batch_tests.rs`
- `tests/run_cli.rs`
- `tests/run_controller.rs`
- `tests/run_support/mod.rs`
- `tests/run_support/stop.rs`
- `tests/run_support/workloads.rs` (pre-existing untracked file)

Only increment-4 additions:

- `docs/WI_EXECUTION_POLICY_C1_VERIFICATION.md`
- `docs/wi-execution-policy-c1-verification.json`

The resumed route found both report drafts already untracked with report checks PENDING.
It completed only these drafts. The implementation preservation hashes matched.

After report creation: **17 modified tracked files, 3 untracked files, 0 staged changes**.
No implementation commit exists. No stage, unstage, stash, reset, clean, revert,
commit, push, hosted transition or publication occurred.

Unchanged protected files include `Cargo.toml`, `Cargo.lock`, `AGENTS.md`,
`docs/WI_EXECUTION_POLICY_C1.md`, `docs/WI_EXECUTION_POLICY_C1_MATRIX.md`,
`docs/WI_EXECUTION_POLICY_C1_PROMPT.md`, `docs/WI_DESIGN_SCOPE_AUDIT.md`,
`docs/WI_RUN_VERIFICATION.md`, `docs/wi-run-verification.json`,
`docs/LOCAL_VERIFICATION.md`, `docs/local-verification.json` and
`docs/COMBINED_DESIGN_REPORT.md`. Historical auth/M3/older reports, manifests,
governing plans and the ledger remain unchanged. No script, CI, auth, dependency
or product-version change is part of the implementation diff.

Before/after preservation check uses SHA-256 of `git diff --binary` and the pre-existing
untracked workload file, not hashes of real credential data:

| Snapshot | SHA-256 |
|---|---|
| Tracked implementation diff | `a7e0014e811c6a573fda31c3cf8abd0bd2bf506b4468223c9e33216e7757e000` |
| `tests/run_support/workloads.rs` | `3ba49a156a2be48ab980dcc1d5599c6f55b4f152502e89be1e303fcdc87a01bd` |

### Report-only checks

Report-check status: **PASS**.

Q1 uses the exact inline Node program stored in the companion JSON at
`report_checks.inline_program`. It parses strict JSON and checks exactly 18 unique,
ordered C1-00..C1-17 IDs, all PASS. It checks Markdown/JSON matrix assertions,
14 evidence records, 14 retained constraints, six migrations, ten parent command records,
counts, schema distinction, review/live/ledger status, HEAD, staged state, changed paths
and both preservation hashes. It also rechecks Q2-Q6 against the final report contents.
No additional verification file is created.

Exact Q1 command:

```sh
node --input-type=module -e "$(node -p 'JSON.parse(require("node:fs").readFileSync("docs/wi-execution-policy-c1-verification.json", "utf8")).report_checks.inline_program')"
```

| ID | Exact command or reference | Exit | Status/result |
|---|---|---:|---|
| Q1 | Node command above | 0 | PASS: JSON, agreement and preservation assertions; Q2-Q6 rechecked |
| Q2 | Consistency search below | 0 | PASS: status/count/schema/worktree/live statements agree |
| Q3 | `git diff --check` | 0 | PASS: no tracked whitespace diagnostics |
| Q4 | `git diff --no-index --check /dev/null docs/WI_EXECUTION_POLICY_C1_VERIFICATION.md` | 1 | PASS: no untracked Markdown whitespace diagnostics |
| Q5 | `git diff --no-index --check /dev/null docs/wi-execution-policy-c1-verification.json` | 1 | PASS: no untracked JSON whitespace diagnostics |
| Q6 | `git diff --no-index --check /dev/null tests/run_support/workloads.rs` | 1 | PASS: no pre-existing untracked workload whitespace diagnostics; file unchanged |

Exact Q2 command:

```sh
rg -n 'C1-[0-9]{2}|PENDING|NOT RUN|uncommitted|244|260|231|247|31/50|blockers|Blockers|schema_version' docs/WI_EXECUTION_POLICY_C1_VERIFICATION.md docs/wi-execution-policy-c1-verification.json
```

Q4-Q6 returned empty stdout/stderr. Their no-index exit 1 records the difference
from `/dev/null`, not a whitespace error. Q1 explicitly checks both the exit code
and absence of diagnostics. Historical or search references to PENDING are not an
unresolved gate. These are report/static checks, not reruns of F1-F9.

## Live status, deferred scope and remaining risks

**Real credential access, auth/profile/login/refresh commands and live provider work:
NOT RUN, unauthorized.** C1 live provider generations: **0**. `live_started:false`.
Only synthetic credentials, finite scripted providers, pure tools, controlled clocks
and loopback transports supplied runtime evidence. Pi authoring traffic is separate.
Ledger remains **31/50 used, 19 remaining**. Blockers: **none**.

Deferred: staging/implementation commit/push/publication; real auth/live work;
unrelated input/history/auth/network redesign; cache framework/eviction/persistence;
result chunking; new dependencies/providers; M4/progress and advanced features;
whole-repository usefulness/security audit, non-Linux execution and resource benchmarks.
No next milestone or live request follows automatically.

Remaining risks:

- This is a breaking Rust/run-event API and CLI flag removal. Active callers must migrate; no legacy compatibility shim exists.
- Cache memory can grow until scope release. There is no universal bounded RSS or durable exactly-once guarantee.
- Retained input/history/payload/transport/auth guards and OS/provider resources can still end work. Exact Wi numeric choices are not proven optimal or provider-mandated.
- Cancellation is cooperative. Blocking tools/observers cannot be forcibly preempted; completed effects are not undone and upstream termination is not guaranteed.
- Future drop, panic or process loss cannot guarantee a terminal event. Execution completion and final delivery remain distinct.
- Evidence is local Linux/offline. Implementation remains uncommitted. These reports record parent observations, not invented fresh runtime or live executions.
