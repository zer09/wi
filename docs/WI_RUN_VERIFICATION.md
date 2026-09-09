# Wi M3 verification — observed offline evidence

Contract `m3.1`; checked 2026-09-09. Baseline and current HEAD:
`2d9008b125c8a67dbc6977fe07fd65442cac7f9a`.

## Current verdict

- Implementation complete as uncommitted work over the baseline; offline gates PASS.
- **OFFLINE ACCEPTED** after the repeated accumulated independent review.
- **M3-26 PASS**. `milestone_accepted` is true.
- **M3-09 PASS** after the adapter decoder regression now sends and rejects an
  exact second terminal while retaining created-after-terminal coverage.
- RL1/RL2: **NOT AUTHORIZED / NOT RUN**. No automatic live phase.
- New real credential reads, auth operations and Wi provider generations: **0**.
- Historical ledger unchanged: **27/40 used, 13 remaining; M3 allocation 0**.

This is observed M3 verification, not a scaffold. The assignment supplies the
isolated baseline and prior increment evidence. The parent orchestration observed
the current post-remediation offline gates directly. The documentation implementor
checked HEAD/status, source assertions and active-doc alignment without inventing
original execution transcripts. The repeated independent review-a, review-b and
review-c gate provides final offline approval. The governing
[controller](WI_RUN_CONTROLLER.md) and [matrix](WI_RUN_MATRIX.md) remain unchanged,
including their historical planning status. Results live here and in
[wi-run-verification.json](wi-run-verification.json).

## Environment and work preservation

| Field | Observed record |
|---|---|
| OS / architecture | Linux 6.18.33.2-microsoft-standard-WSL2 / x86_64 |
| Rust / Cargo | rustc 1.98.1 / cargo 1.98.1 |
| Node / uv / Pi | v24.18.0 / 0.12.10 / 0.85.1 |
| Planning revision | Uncommitted planning worktree files over baseline, not a planning commit |
| Implementation revision | HEAD remains the baseline above; runtime/test changes are dirty work |
| Platform coverage | Local Linux only; no current hosted or non-Linux execution |

The supplied initial preimplementation dirty state was exactly modified `AGENTS.md`
and added `docs/WI_RUN_CONTROLLER.md`, `docs/WI_RUN_IMPLEMENTOR_PROMPT.md`,
`docs/WI_RUN_MATRIX.md`, `docs/WI_RUN_VERIFICATION.md`, and
`docs/wi-run-verification.json`. At this role's entry, those six files were already
staged; implementation changes were unstaged or untracked. No index transition was
performed. New report edits remain unstaged over the staged scaffolds. This report
does not imply the entire index is empty or that planning files were committed.

`git rev-parse HEAD` and `git status --short` confirmed that state directly.
`git diff HEAD -- Cargo.lock` was empty. `Cargo.lock` is unchanged;
`Cargo.toml` adds only development Tokio `test-util` from the prior implementation.
No auth implementation module changed. Historical `docs/LOCAL_VERIFICATION.md`,
`docs/local-verification.json`, `COMBINED_DESIGN_REPORT`, manifests and ledger remain
unchanged. `AGENTS.md` and governing specification documents are preserved as received.
No reset, clean, stash, revert, stage, unstage, commit, push or publication occurred.

## Actual gate results

Baseline and current final commands ran with isolated temporary
`HOME`/`XDG_CONFIG_HOME`/`CODEX_HOME`; live credential locations were absent.
The current final used the trusted existing Cargo/Rustup caches with Cargo offline.
These are local synthetic/loopback executions, not provider or account checks.

| Exact command | Initial result | Current final result |
|---|---|---|
| `cargo fmt --all -- --check` | exit 0, PASS | exit 0, PASS |
| `cargo check --all-targets` | exit 0, PASS | exit 0, PASS |
| `cargo test --all-targets` | exit 0, 187 passed | exit 0, 244 passed |
| `cargo clippy --all-targets -- -D warnings` | exit 0, PASS | exit 0, PASS |
| `cargo build --all-targets` | exit 0, PASS | exit 0, PASS |
| `cargo test --doc` | exit 0, 0 doctests | exit 0, 0 doctests |
| `uv run scripts/verify.py` | exit 0, all six Cargo gates PASS | exit 0, all six Cargo gates PASS |
| `node scripts/cli_retest.mjs --self-test` | exit 0, 152 passed; `live_started=false` | exit 0, 152 passed; `live_started=false` |
| `cargo run --example run_offline` | NOT AVAILABLE / NOT RUN | exit 0, B assertions and exact summary below |
| `git diff --check` | exit 0 | exit 0 |

The initial example did not exist. Its absence is not a failure of the old baseline.
No initial gate failure is replaced by a later PASS.

| Rust test target | Baseline passed | Current passed |
|---|---:|---:|
| Library | 166 | 195 |
| Binary | 16 | 17 |
| Managed-absence integration | 1 | 1 |
| Provider-contract integration | 4 | 4 |
| Run CLI integration | not present | 3 |
| Run-controller integration | not present | 24 |
| **Total** | **187** | **244** |

Both recorded suites had zero failed/ignored/filtered tests. The current suite also
reports zero measured. Doctest execution remains zero, not additional coverage.
Node's 152 tests are separate from Rust; repeat review runs do not increase counts.
No hosted CI execution or non-Linux behavior follows from these results.

Exact example ending:
`Completed: 50 (1 session, 3 model requests, 2 tool executions; offline)`.

## Matrix evidence

All test names below are exact source function names, not invented per-subcase
names. A table-driven test can cover several rows. `cargo test --all-targets`
executed these tests in the supplied observed final gate, exit 0, with zero filtered
or ignored. Source review identifies what their assertions prove; test existence
alone is not the execution evidence. References below name source paths and lines.

### Source key

- **R**: `src/run/mod.rs:20-461`, public request/result/controller and limits.
- **E**: `src/run/events.rs:6-60`, outer events, outcomes and sink errors.
- **C**: `src/run/collect.rs:1`, generic collector.
- **T**: `tests/run_controller.rs:1-820`, external controller tests and `healthy` helper.
- **S**: `tests/run_support/stop.rs:19-488`, deterministic stop/error tests.
- **B**: `tests/run_support/boundaries.rs:4-146`, cross-turn/sink tests.
- **F**: `tests/run_support/mod.rs:1`, independent provider, records and pure tool.
- **G**: `src/tools.rs:46`, shared registry; **GT**: `src/tools_batch_tests.rs:83-721`.
- **V**: `src/providers/openai_codex/consistency.rs:1`, adapter validator;
  `src/providers/openai_codex/session.rs:1`, enforcement before settle/publication.
- **VT**: `src/providers/openai_codex/consistency_tests.rs:121-301`, migrated regressions;
  **VL**: `src/providers/openai_codex/consistency_loopback_tests.rs:35-434`;
  **VS**: `src/providers/openai_codex/consistency_settlement_tests.rs:23`.
- **L**: `src/providers/openai_codex/run_loopback_tests.rs:127-434`, new-controller transports.
- **CLI**: `src/run_cli.rs:19-222`, `src/main.rs:1`, thin CLI routing/handler.
- **CT**: `src/run_cli_tests.rs:127`, six real-handler tests;
  **CB**: `tests/run_cli.rs:24-220`, three binary integration tests.
- **X**: `examples/run_offline.rs:1`, independent B example.

### M3-00 through M3-08

| ID / status | Paths and exact tests | Command and assertions |
|---|---|---|
| **M3-00 PASS** | `AGENTS.md:1`, `docs/WI_RUN_CONTROLLER.md:1`, `scripts/verify.py:1`, `scripts/cli_retest.mjs:1`; no invented baseline test name | `git rev-parse HEAD`; `git status --short`; `uv run scripts/verify.py`; `node scripts/cli_retest.mjs --self-test`; `git diff --check`. Baseline 187/152 and six gates pass; dirty planning authority preserved, example initially unavailable, no M3 live/auth permission, historical reports/ledger unchanged. |
| **M3-01 PASS** | R, T, F, X; `run_t_empty_reasoning_refusal_and_provenance_are_terminal`; `run_text_only_does_not_require_continuation_or_function_tools` | `cargo test --all-targets`; `cargo run --example run_offline`. Public library API works outside binary with independent native keys; T opens/generates/closes once. Controller contains neither OpenAI parsing nor agent invocation. |
| **M3-02 PASS** | R, T, S; `run_preadmission_rejects_without_observation_or_work`; `run_preadmission_requires_continuation_for_tools_in_check_order`; `run_invalid_snapshot_definition_is_checked_once_before_open`; `run_text_only_does_not_require_continuation_or_function_tools` | `cargo test --all-targets`. Twenty-case admission table rejects empty/oversized prompt, invalid options/tools/provider/transports/features, pre-cancel, model 0/33, tool 129, deadline zero/>600s before observation/open/work. Boundary validation accepts model 1/32, tool 0/128, positive duration/600s. Invalid definition snapshot and missing continuation reject; metadata checks do not authenticate. |
| **M3-03 PASS** | R, C, T, CT; `run_t_empty_reasoning_refusal_and_provenance_are_terminal`; `run_text_only_does_not_require_continuation_or_function_tools`; `run_collector_rejects_identity_order_idle_close_eof_and_accepts_gaps`; `run_cancel_on_completed_no_call_provider_terminal_preserves_completion`; `run_cli_refusal_completed_and_tool_limit_exit_codes` | `cargo test --all-targets`. T, empty, reasoning-only/refusal and terminal-only normalized streams stop once without tools/retry/invented text. Full serialized response and provenance retained. Cancellation triggered by successful no-call terminal observation cannot rewrite completion. Normalized start is not native-created evidence. |
| **M3-04 PASS** | R, T, L; `run_a_b_c_exact_inputs_order_and_lifecycle`; `run_websocket_a_native_and_recovered_one_socket_exact_linkage`; `run_sse_a_mime_and_missing_prolog_replay_exact_effective_native_history` | `cargo test --all-targets`. A uses two attempts/receipts/turns and one actual addition; result-only continuation under original call identity and final 42. Tool dispatch/finish precede turn finish and next turn. No generic arithmetic oracle. |
| **M3-05 PASS** | T, F, X; `run_a_b_c_exact_inputs_order_and_lifecycle` | `cargo test --all-targets`; `cargo run --example run_offline`. B checks exact initial/result vectors, distinct call IDs, 42 then 50, one session, three requests/two executions and no fourth request. C checks declared execution order and ordered result input. Example asserts final 50. |
| **M3-06 PASS** | G, GT, T; `whole_batch_authority_rejects_before_dispatch_or_reuse`; `cached_calls_still_require_authority_and_schema`; `call_id_at_512_byte_boundary_produces_valid_input`; `run_whole_batch_invalid_authority_has_no_dispatch`; `src/providers/openai_codex/tests.rs:262` `decoded_status_rejects_batch_without_execution_or_cache` | `cargo test --all-targets`. Twenty-two registry variants with fresh/cached first calls and 16 controller variants reject malformed JSON/schema, extra/noninteger/missing arguments, unknown tool, duplicate/conflicting/empty/>512-byte IDs, incomplete calls, string/object/numeric namespace, programmatic/unknown caller and unknown executable output. No new execution/cache entry/start or continuation. Inherited decoded-status test covers native malformed statuses and corrected omitted/exact completed positive controls; it is the equivalent adapter-level raw-status oracle. |
| **M3-07 PASS** | T, L; `run_outcomes_unsupported_output_and_exact_upstream_assessment`; `run_t_empty_reasoning_refusal_and_provenance_are_terminal`; `run_websocket_a_native_and_recovered_one_socket_exact_linkage`; `run_sse_a_mime_and_missing_prolog_replay_exact_effective_native_history`; `src/providers/openai_codex/recovery_tests.rs:31` `recovery_terminal_trigger_table`; `src/providers/openai_codex/recovery_loopback_tests.rs:160` `invalid_recovery_loopback_reports_received_without_settlement_or_second_send` | `cargo test --all-targets`. Incomplete/failed/provider-cancelled never dispatch or continue and remain inspectable. Native-final/recovered output preserves provenance/native metadata. Inherited trigger table covers missing/null/malformed output and noncompleted status; inherited invalid-recovery public loopback retains terminal_received without settlement or second send. These remain equivalent decoder/adapter recovery tests, not new fake live evidence. |
| **M3-08 PASS** | V, VT, VL, VS; `collect_rejects_discarded_or_changed_stream_before_second_send_or_execution`; `collect_accepts_interleaved_parts_without_arrival_order_authority`; `collect_rejects_type_conflicts_and_conservative_metadata_changes`; `collect_preserves_terminal_only_matching_suffix_and_empty_streams`; `consistency_public_session_rejects_before_publication_execution_or_next_send`; `consistency_public_session_accepts_effective_output_and_resets_each_request`; `consistency_drive_failure_leaves_conversation_unsettled` | `cargo test --all-targets`. Former CLI consistency coverage migrated, not removed. Public WS/SSE sessions reject discarded/changed streamed or finalized material, identity/index/type/metadata conflicts and byte/finalized/event overflow before publication/execution/next send. Direct settlement assertion prevents state mutation. Valid interleaved parts, compatible bounded output and per-request reset pass. Both legacy callers and new controller inherit adapter enforcement. |

### M3-09 through M3-18

| ID / status | Paths and exact tests | Command and assertions |
|---|---|---|
| **M3-09 PASS** | C, T, B; `run_collector_rejects_identity_order_idle_close_eof_and_accepts_gaps`; `run_cross_turn_sequence_failure_keeps_prior_validated_response`; `run_extension_envelope_is_opaque_and_turn_sink_failures_stop`; `src/providers/openai_codex/recovery_tests.rs:238` `recovery_known_parts_fields_prefixes_and_lifecycle`; `src/providers/openai_codex/codec.rs:421` `terminal_response_is_authoritative` | `cargo test --all-targets`; focused `cargo test --lib providers::openai_codex::codec::tests::terminal_response_is_authoritative -- --exact`. Wrong session/provider/request/response identity, nonincreasing sequence, duplicate start, idle null-request closure and EOF stop without continuation. Gaps pass; healthy helper compares unchanged inner envelopes. The adapter decoder synchronously rejects an exact second terminal with `event after terminal response` and retains created-after-terminal rejection. The collector adds no postterminal wait. |
| **M3-10 PASS** | R, T, B; `run_model_tool_limits_and_cached_batches_are_atomic`; `run_outcomes_unsupported_output_and_exact_upstream_assessment`; `run_cross_turn_sequence_failure_keeps_prior_validated_response` | `cargo test --all-targets`. A at model=1 executes no tool; B at 2 executes only first tool and never sends third request. Cached batch at limit is not replayed; terminal text on last allowed request completes. Attempts include rejection and uncertainty, separately from admissions. |
| **M3-11 PASS** | G, GT, T; `run_model_tool_limits_and_cached_batches_are_atomic`; `run_scope_isolation_conflicts_mixed_cache_and_capacity`; `capacity_counts_only_new_distinct_ids_and_preserves_eight_call_cap`; `prepared_batch_exposes_whole_new_dispatch_budget_without_work` | `cargo test --all-targets`. Tool=0 allows T, rejects A. One slot rejects two-new-call C atomically; cached/new pair costs one slot. Cache replay at 128 succeeds, new 129th and >8 batch calls reject before dispatch. |
| **M3-12 PASS** | G, GT, T; `run_scope_isolation_conflicts_mixed_cache_and_capacity`; `run_model_tool_limits_and_cached_batches_are_atomic`; `fresh_scopes_share_tools_but_never_consume_or_mutate_template_cache`; `whole_batch_authority_rejects_before_dispatch_or_reuse` | `cargo test --all-targets`. Same-run identical delivery reuses result; changed tool/arguments fail. Two runs with reused call IDs execute independently with distinct ownership, preserving caller cache. Only tool Arcs are shared. |
| **M3-13 PASS** | R, G, T, S; `run_preadmission_rejects_without_observation_or_work`; `run_cancel_open_generate_receipt_and_drop_cleanup`; `run_pending_tool_cancel_deadline_and_future_drop_no_fabricated_finish`; `run_cancel_boundaries_never_submit_partial_batch_or_rewrite_terminal` | `cargo test --all-targets`. Pre-cancel, pending open/generate/receipt-output, pending tool and between-tool boundaries stop later work. Deterministic notification/polling avoids sleep races. Healthy admitted cancellation finishes locally once; no fabricated tool finish/result or partial subset submission. Before generation is not_submitted; pending attempts unknown unless stronger evidence exists. Before any turn, upstream assessment is null. |
| **M3-14 PASS** | R, S, GT; `run_deadline_open_generate_receipt_and_cancel_priority`; `run_pending_tool_cancel_deadline_and_future_drop_no_fabricated_finish`; `run_absolute_deadline_includes_completed_turn_and_later_tool`; `run_cancel_boundaries_never_submit_partial_batch_or_rewrite_terminal`; `run_cancel_on_completed_no_call_provider_terminal_preserves_completion`; `ready_stop_wins_over_ready_tool_without_fabricating_finish` | `cargo test --all-targets`. Paused monotonic time covers open/generate/output/tools; completed early turn does not reset absolute deadline. Simultaneously ready cancellation wins. Terminal disposition is classified before a new stop checkpoint, so cancellation from a successfully delivered completed no-call terminal does not rewrite completion; call-bearing responses still checkpoint before tool work. No wall-clock arithmetic, rollback or kernel-blocking guarantee. |
| **M3-15 PASS** | G, T, S; `run_ordinary_tool_errors_and_output_bounds_are_correlated_results`; `run_whole_batch_invalid_authority_has_no_dispatch`; `run_pending_tool_cancel_deadline_and_future_drop_no_fabricated_finish`; `run_cancel_boundaries_never_submit_partial_batch_or_rewrite_terminal`; `run_sink_finish_and_reuse_failures_stop_without_prepared_results` | `cargo test --all-targets`. Overflow and oversized tool output become bounded correlated error results consumable by model. Invalid authority/schema remains preflight failure. Partial failure/cancellation sends no subset; only actual local results can be cached, never a fabricated cancelled result. |
| **M3-16 PASS** | R, C, T, B, L; `run_outcomes_unsupported_output_and_exact_upstream_assessment`; `run_cross_turn_sequence_failure_keeps_prior_validated_response`; `run_websocket_disconnect_and_error_stop_one_attempt_without_reopen`; `run_sse_wrong_mime_missing_invalid_prolog_and_http_errors_never_retry` | `cargo test --all-targets`. Preflight/generate rejection, failed receipt, HTTP 401/403/429 and disconnect/error stop at one attempt per step, without retry/reopen/account reselection/fallback. Fake exact upstream assessments distinguish not_submitted/unknown/terminal_received, including local failure after terminal. No ledger mutation. |
| **M3-17 PASS** | R, E, T, S, B; `run_t_empty_reasoning_refusal_and_provenance_are_terminal`; `run_a_b_c_exact_inputs_order_and_lifecycle`; `run_open_failure_has_no_turn_or_upstream_and_closes_before_final`; `run_model_tool_limits_and_cached_batches_are_atomic`; `run_cancel_boundaries_never_submit_partial_batch_or_rewrite_terminal`; `run_cancel_on_completed_no_call_provider_terminal_preserves_completion`; `run_extension_envelope_is_opaque_and_turn_sink_failures_stop` | `cargo test --all-targets`. T/A/B/open-failure/stopped traces assert start/end, one finish per started turn, fresh IDs, stable correlation and increasing outer sequence. The terminal-observer cancellation regression ends with ModelCompleted and RunFinished(Completed), retained TerminalReceived, one request and zero tool work. Healthy helper compares receipts/attempts/tool records and exact nested envelopes. Accepted dispatch boundary can count even if cancellation prevents tool body entry after start delivery; it is not a claim of completed execution. No invented agent/message/steering events. |
| **M3-18 PASS** | R, E, T, S, B, CT; `run_sink_variants_stop_once_and_final_failure_preserves_outcome`; `run_nonblocking_channel_observer_full_and_closed_stop_work`; `run_extension_envelope_is_opaque_and_turn_sink_failures_stop`; `run_sink_finish_and_reuse_failures_stop_without_prepared_results`; `run_cancel_open_generate_receipt_and_drop_cleanup`; `run_pending_tool_cancel_deadline_and_future_drop_no_fabricated_finish`; `run_cli_broken_output_stops_work_and_final_sink_error_overrides_completed` | `cargo test --all-targets`. Full/Closed/Failed at start/provider/tool start stop later emission/work and mark incomplete delivery. Final-emission failure retains selected outcome and sink_error with no second terminal, CLI exit1. Bounded nonblocking try_send is exercised. Future-drop closes acquired session and drops pending tool; no result/final-event guarantee, unbounded transcript/queue or detached tool task. |

### M3-19 through M3-26

| ID / status | Paths and exact tests | Command and assertions/blocker |
|---|---|---|
| **M3-19 PASS** | F, L; `run_websocket_a_native_and_recovered_one_socket_exact_linkage`; `run_sse_a_mime_and_missing_prolog_replay_exact_effective_native_history`; `src/providers/openai_codex/managed_loopback_tests.rs:40` `managed_ws_profile_selected_per_open_and_continuation_keeps_handshake`; `src/providers/openai_codex/managed_loopback_tests.rs:140` `managed_sse_renews_same_profile_for_tool_result_and_rejects_relogin`; `src/providers/openai_codex/managed_auth.rs:571` `managed_rotation_survives_cancelled_waiter_and_preserves_profiles`; `src/providers/openai_codex/managed_auth.rs:614` `managed_replacement_and_deletion_invalidate_bound_snapshot`; `tests/managed_absence_cli.rs:10` `managed_absent_cli_is_actionable_and_never_creates_store` | `uv run scripts/verify.py`; `cargo test --all-targets`. One provider open and synthetic preparation/load records at existing boundaries: WS once; SSE open and each request. Inherited managed tests are the equivalent profile-selection/incarnation/renewal oracles. Original store/read-only/auth suite remains green in isolated HOME/XDG/CODEX_HOME. No production auth source edits or controller auth calls, fallback or rotation-worker policy change. |
| **M3-20 PASS** | CLI, CT, CB; `run_cli_real_handler_json_outer_only_defaults_and_opt_in_tools`; `run_cli_plain_filters_controls_labels_validated_and_partial_outcomes`; `run_cli_refusal_completed_and_tool_limit_exit_codes`; `run_cli_broken_output_stops_work_and_final_sink_error_overrides_completed`; `run_cli_signal_cancels_and_awaits_close_and_terminal_result`; `run_cli_handler_prevalidates_before_factory_and_reads_bounded_utf8`; `run_binary_help_and_clap_conflicts_do_not_need_auth_locations`; `legacy_parse_errors_and_help_keep_clap_exit_behavior`; `run_binary_prevalidation_precedes_external_and_managed_auth_location` | `cargo test --all-targets`. Six real-handler and three binary tests cover defaults/tool opt-in, JSON outer-only, filtered/partial/refusal plain output, broken stdout, signal-await-close, stdin UTF-8/size, prompt conflicts, all limit bounds, repeat/unknown tools and explicit managed argument prevalidation without auth. Completed 0, cancel 130, failures/run parse 1; help 0, legacy parse 2. Old schemas unchanged. |
| **M3-21 PASS** | L, R; `run_websocket_a_native_and_recovered_one_socket_exact_linkage`; `run_websocket_disconnect_and_error_stop_one_attempt_without_reopen` | `cargo test --all-targets`. Library controller through Gateway-registered loopback adapter: A native/recovered cases use one socket, two response.create frames, previous_response_id, new-result-only input, original call identity and stable synthetic auth identity. Disconnect/error has one attempt/no reopen. Not a smoke shortcut. |
| **M3-22 PASS** | L, R; `run_sse_a_mime_and_missing_prolog_replay_exact_effective_native_history`; `run_sse_wrong_mime_missing_invalid_prolog_and_http_errors_never_retry` | `cargo test --all-targets`. Same library A uses two HTTP requests and exact ordered effective native history with synthetic opaque metadata/results. Valid MIME and missing-MIME prolog cases pass; wrong MIME, invalid or undelimited first prolog and HTTP errors fail without retry/WS fallback. |
| **M3-23 PASS** | R, T, CLI, CT; `run_preadmission_rejects_without_observation_or_work`; `run_outcomes_unsupported_output_and_exact_upstream_assessment`; `run_text_only_does_not_require_continuation_or_function_tools`; `run_cli_real_handler_json_outer_only_defaults_and_opt_in_tools` | `cargo test --all-targets`. Steering/skills/search/PTC/async required flags reject before auth/open/network. Unknown/program/custom/hosted executable shapes remain inspectable but cannot execute. Default tools empty. No shell/dynamic loader/account failover or hidden auth change. |
| **M3-24 PASS** | X; `scripts/verify.py:1`, `scripts/cli_retest.mjs:1`, `Cargo.toml:1`, `Cargo.lock:1`; no separate named test for example | `cargo fmt --all -- --check`; `cargo check --all-targets`; `cargo test --all-targets`; `cargo clippy --all-targets -- -D warnings`; `cargo build --all-targets`; `cargo test --doc`; `uv run scripts/verify.py`; `node scripts/cli_retest.mjs --self-test`; `cargo run --example run_offline`; `git diff --check`. All exit0; 244 Rust, 152 Node, doc0; B exact summary. Local Linux only; dev test-util only, lock unchanged. |
| **M3-25 PASS** | `README.md:1`, `docs/ARCHITECTURE.md:1`, `docs/EVENTS.md:1`, this report and JSON | Node documentation/JSON sanity check below; `cargo fmt --all -- --check`; `git diff --check`. Active API/CLI/events match source; explicit renewal live L1 versus automatic expiry/failure offline corrected without rewriting history. Both reports retain all 27 rows and observed evidence; acceptance changed to true only after M3-26 passed. Protected files and zero traffic preserved. |
| **M3-26 PASS** | This report and JSON; repeated independent review-a, review-b and review-c roles plus verification/remediation evidence below | The first accumulated review found one terminal-observer cancellation race. Independent verification reproduced it; focused remediation and the 244-test offline gate passed. The complete repeated accumulated review-a/b/c gate then passed with no blocking findings. |

The 24 controller integration names are all represented above: 12 in T, nine in
S, and three in B. Tests from included support modules execute under the
`run_controller` integration target, not as extra independently counted targets.

## Findings, fixes and review evidence

| Increment / independent roles | Finding and targeted resolution | Observed result |
|---|---|---|
| 1 / review-a, review-b, review-c | Adapter consistency relocation, public-session/settlement protection | a/b/c PASS |
| 2 / review-a, review-b, review-c | Confirmed >512-byte call_id preflight gap. Registry now rejects before execution; 512-byte ASCII/UTF-8 accepted and 513-byte batch rejected by `call_id_at_512_byte_boundary_produces_valid_input` and `whole_batch_authority_rejects_before_dispatch_or_reuse` | Remediated; repeat a/b/c PASS |
| 3 / review-a, review-b, review-c | Confirmed missing continuation capability admission for tool-enabled run. `run_preadmission_requires_continuation_for_tools_in_check_order` checks transport/function/continuation ordering; `run_text_only_does_not_require_continuation_or_function_tools` preserves text-only use | Remediated; repeat a/b/c PASS |
| 3 / independent reproduction role | Reported consistency-loopback timeout | Independently **NOT REPRODUCED in 20 runs**; not a confirmed defect or a timing guarantee |
| 4 / review-a, review-b, review-c | Confirmed run parse exit2 mismatch. `run_binary_help_and_clap_conflicts_do_not_need_auth_locations` and `legacy_parse_errors_and_help_keep_clap_exit_behavior` now prove run error1/help0/legacy error2 | Remediated; repeat a/b/c PASS |
| 5 / documentation implementor | Active documentation and observed reports only | No independent approval; final accumulated review pending |
| 6 / review-a, review-b, review-c | Exact M3-09 duplicate-terminal evidence gap. `terminal_response_is_authoritative` now submits a second terminal to the same decoder and asserts `event after terminal response`, while retaining created-after-terminal coverage | Focused test PASS; a/b/c PASS |
| Final gate / review-a, review-b, review-c; independent verification; remediation | Review-b found that cancellation from the completed no-call terminal observer could reach a checkpoint before terminal disposition classification and rewrite completion. Verification reproduced the race. `prepare_tools` now classifies terminal disposition first and checkpoints before any call-bearing tool work; `run_cancel_on_completed_no_call_provider_terminal_preserves_completion` covers the exact boundary | Remediated; 244-test offline gate PASS; complete repeated review-a/b/c PASS with no blockers |

Reviewer identities for M3-26 are the independent `review-a`, `review-b` and
`review-c` roles. The reviewed material was the complete uncommitted remediated
diff over baseline, not a new commit. Confirmed findings, remediation and passing
repeat reviews are supplied evidence; original red command transcripts are not
supplied, so no red exit code is invented. All three repeated reviewers checked
the accumulated diff, traces, cancellation/sink races, limits, validator relocation,
provider neutrality, auth/transport preservation and these reports. They returned
PASS with no blocking findings.

## Changed paths and implementation scope

This role changes only:

- `README.md`: public run API/CLI usage/defaults/limits, tool opt-in, isolation,
  cancellation, exit/delivery behavior, sensitive JSON and offline example.
- `docs/ARCHITECTURE.md`: adapter consistency boundary, shared two-phase registry,
  fresh scopes, generic controller/collector/events and thin CLI ownership.
- `docs/EVENTS.md`: outer schema1, four lifecycle kinds/two wrappers, exact outcomes,
  counters/sink/future-drop limits and legacy raw versus wrapped tool events.
- `docs/WI_RUN_VERIFICATION.md` and `docs/wi-run-verification.json`: observed evidence,
  counts, all matrix rows, findings, repeated reviewer roles and offline acceptance.

Prior implementation paths, preserved rather than edited by this role:

- `Cargo.toml`.
- `src/collect_lifecycle.rs` removed after relocation; `src/collect_tests.rs` updated.
- `src/lib.rs`, `src/main.rs`, `src/tools.rs`, `src/tools_batch_tests.rs`.
- `src/providers/openai_codex/mod.rs`, `session.rs`, `tests.rs`, `codec.rs`.
- `src/providers/openai_codex/consistency.rs`, `consistency_tests.rs`,
  `consistency_loopback_tests.rs`, `consistency_settlement_tests.rs`,
  `run_loopback_tests.rs`.
- `src/run/mod.rs`, `src/run/events.rs`, `src/run/collect.rs`.
- `src/run_cli.rs`, `src/run_cli_tests.rs`.
- `tests/run_cli.rs`, `tests/run_controller.rs`, `tests/run_support/mod.rs`,
  `tests/run_support/stop.rs`, `tests/run_support/boundaries.rs`.
- `examples/run_offline.rs`.

Consistency logic moved from CLI ownership into the adapter before settlement and
publication; recovery provenance/native retention stay unchanged. Registry changes
separate full-batch authority/capacity validation from ordered execution and give
each run an empty result cache. The controller adds bounded ordinary continuation,
not provider-native parsing, new authentication, a persistent service or retries.
No change outside the five allowed documentation paths belongs to this increment.

## Documentation checks and repeatable offline commands

After active-document edits, `git diff --check` exited 0. After JSON creation,
Node JSON parse/schema/matrix/acceptance assertions passed with:
`node -e 'const fs=require("fs"),r=JSON.parse(fs.readFileSync("docs/wi-run-verification.json","utf8"));if(r.schema_version!==1||r.matrix.length!==27||r.matrix.some(x=>x.required&&x.status!=="pass")||r.milestone_accepted!==true)process.exit(1); console.log("JSON parse/schema/matrix/acceptance: PASS");'`.
Final documentation
sanity checks validate JSON schema1/observed kind/27 unique ordered PASS rows and
true acceptance, exact referenced test names present in source, balanced
Markdown fences, local Markdown links, required event names and protected-file
scope. These are syntax/alignment checks, not an independent acceptance review.
`cargo fmt --all -- --check` is read-only and appropriate because only Markdown/JSON
changed. Final results after recording the repeated review: Node documentation/JSON sanity PASS (61 exact test names), Cargo fmt exit0,
`git diff --check` exit0. No full runtime rerun was needed for this docs-only increment.

To repeat runtime verification, use isolated temporary HOME/XDG_CONFIG_HOME/
CODEX_HOME and absent live credential locations, with the existing trusted Rust
and uv caches/toolchain available. Run the exact ten commands in the gate table.
Do not run auth-check, login, refresh, smoke or a live runner. The Node runner
command is `--self-test` only; the example is `run_offline` only.

## Deferred scope and remaining risks

No unresolved confirmed in-scope runtime regression remains after remediation,
offline gates and the repeated accumulated independent review.
Local Linux tests do not establish hosted/non-Linux behavior or account capability.
Real credential reads, profile checks, login/browser/refresh, provider generations,
hosted writes, commits, pushes and publication were not performed or authorized.
Pi's authoring conversation is separate from project tests.

RL1/RL2 require separate authorization and budget; old live smoke success is not
M3 run-controller evidence. No later live helper, persistent event service,
durable replay, approval system, shell/file executor, dynamic plugin loader,
parallel tools, steering, skills/search/PTC/async calling or account failover is
implemented by this increment. Cooperative cancellation cannot undo side effects
or guarantee upstream termination. Future drop/process loss cannot guarantee a
RunResult or terminal event. Final-emission failure can leave execution completed
but delivery incomplete; the returned result and CLI exit1 preserve that distinction.

**OFFLINE ACCEPTED. LIVE NOT AUTHORIZED / NOT RUN.**
