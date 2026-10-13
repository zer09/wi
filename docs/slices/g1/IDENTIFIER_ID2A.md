# ID2a novel storage admission evidence

Scope: strict new UUID admission, actual execution/result call IDs, receipt/history compatibility and replacement A5b regressions. Not G1.1 acceptance. HEAD remained 318b7f0da7d503e2e3a8cf33be84e78ebbe8affb; index empty, all changes unstaged/uncommitted.

## Implemented behavior and review

src/storage/records.rs:214-253 adds validate_admission, separate from historical structural validation and serde decoding. It checks runtime run/event/optional turn/request UUIDs, nested request mirrors, RunFinished.summary.last_request_id, direct Result run/summary and ToolResult request IDs. Structural/version/correlation errors retain their existing precedence when multiple defects apply. Actual ToolExecutionEvent and ToolResult call IDs use the existing nonempty/512-UTF8-byte execution rule. Observed FunctionCall IDs and Result.last_response are not subjected to that execution rule.

src/storage/run_store.rs:603-623 resolves exact receipts and changed-payload conflicts first. It preflights the entire novel batch before sequence allocation and insertion. Invalid input cannot leave canonical, manifest, command/receipt or display rows committed.

The 23-path isolated increment contains 20 modified and three added files. Parent inspected the production diff and active replacement tests. Three independent reviewers inspected the complete isolated diff against /tmp/wi-id2a-baseline.dLRnVD, including fixtures/untracked files. All returned PASS without blocking findings. ID1 production and regressions remained byte-identical. Historical readers, shared binding validation, independent old-schema fixtures, dependency/schema/version files, parent docs, browser assets and CI remained unchanged.

## Regressions and disposition

Ten current test functions cover:

- src/storage/identifier_tests.rs:174: 13 malformed spellings across nine ID admission paths; exact errors/certainty, absent receipts and unchanged ten-table snapshots.
- :292: valid non-v4 UUID round-trip through runtime, summary, result and raw history.
- :351: valid optional absence and retained structural/version/correlation errors.
- :457: empty/513-byte actual execution/result call IDs reject; a 512-byte Unicode ID passes with exact output/result/reuse.
- :547: provisional observed empty/513-byte call IDs remain recordable.
- :616: an armed CanonicalInserted failure proves a later invalid record is detected before any earlier insert; the next valid append still reaches the armed failure.
- src/storage/identifier_tests/historical.rs:245: independently populated released schema1/2 with old opaque UUID-field values and a 513-byte old call. Typed and serde exact retries retain their receipt; changed payloads retain conflict precedence; novel input rejects. Raw reads, migration, repair, canonical bytes and prefix digest remain unchanged.
- src/execution/tests/storage_identifiers.rs:4: real persistent controller/SQLite retains tool_preflight, TerminalReceived and exact last_response for observed empty/513-byte calls. No tool effect or sink failure; final result/receipt and reopened history persist.
- src/storage/conversation/bounded_header_tests.rs:13: malformed36 and 524289-byte summary IDs reject before commit for both RunFinished and direct Result.
- :50: valid non-v4 summary UUIDs persist and fit the encoded Block budget for both paths.

The active a5b_canonical_summary_scalar_exceeds_required_block_wire_budget was replaced by id2a_invalid_and_oversized_summary_rejects_before_runtime_or_result_commit and id2a_valid_uuid_summary_fits_block_wire_cap_for_runtime_and_direct_result. No ignore/filter was added. This is explicit owner-authorized replacement, not a claim that the old conflict did not occur.

The exact archived pre-amendment source still equals the pre-ID2a source, SHA256 54e73efe544d343db05e1beee025f69d95816dd4e20144875886484c2be467f8. Original passing command/result and a5b_blocker JSON remain historical evidence. Protected old reports and the intentional opaque513-byte response test remain unchanged.

## Execution evidence

Implementation reported these final commands passing after all fixture changes:

- cargo fmt --all -- --check
- cargo check --locked --offline --all-targets
- cargo test --locked --offline --all-targets
- cargo clippy --locked --offline --all-targets -- -D warnings
- cargo build --locked --offline --all-targets
- cargo test --locked --offline --doc
- cargo test --locked --offline --test platform_support
- git diff --check

Library: 759 passed, 10 existing ignores. Binary: 59 passed, 1 existing ignore. Storage integration: 74 passed. Focused id2a: 10 passed. Doctests: 0. Platform: 1. All other executed targets passed. Test combinations are not unique test functions.

All eight retained offline examples passed using cargo run --locked --offline --example NAME: storage_offline, run_offline, skills_offline, skill_loading_offline, persisted_run_offline, conversation_offline, host_offline, http_api_offline. Only storage_offline changed in this increment. CARGO_NET_OFFLINE=true uv run scripts/verify.py --static-only passed; this is not full verify.py execution. node scripts/cli_retest.mjs --self-test passed 152 assertions with live_started=false.

Independent execution:

- review-a: locked/offline id2a (10), storage integration (74), storage library (135, three existing helper ignores), ID1 persistent (1), task privacy audit (4), actual-history DTO (1), intentional opaque native-response test (1), formatting/platform/whitespace. Other gates remained implementation evidence.
- review-b: locked/offline id2a (10), storage integration (74), formatting/whitespace; other gates remained implementation evidence.
- review-c: formatting, locked/offline Clippy/build/all-target tests; focused id2a, doc/platform, eight offline examples, static verifier and CLI self-test. Its focused/doc/platform command flags differ from the implementation's locked command chain; do not infer flags not reported. All-target counts matched implementation evidence.

No reviewer ran full verify.py, Chromium, hosted CI, macOS or live providers. These are increment reviews, not final accumulated-diff reviews.

## Initial failures preserved

- An initial focused run passed with an unused Value import warning. The import was removed; later Clippy/check were clean.
- Initial all-target library run: 743 passed, 14 failed, 10 ignores. Current append fixtures contained newly invalid turn/request IDs. Failures were actual_history_projects_receipts_private_checkpoints_and_terminal_without_result; task_audit_allows_wall_clock_regression_between_append_batches; task_audit_rejects_corrupt_completed_metadata_projection_and_appends; p1b2_04_25_binding_transition_atomic_batch_projection_and_repair; p1b2_remediation_bound_atomic_batch_and_legacy_activity_remain_valid; p1b2_remediation_unbound_activity_append_is_atomic; p1b2_remediation_unbound_terminal_cannot_claim_submitted_activity; p1b2_04_binding_rejects_legacy_late_and_wrong_links_but_records_actual_identity; a4_all_canonical_writers_apply_borrowed_events_and_duplicates_write_zero_bytes; a4_canonical_active_turn_permits_repeated_terminal_and_later_content_without_new_entry; a4_latest_metadata_later_run_events_keep_correct_revision_but_reject_stale; a4_owned_atomicity_pause_rollback_batch_and_real_projection_constraint; p1a17_process_lazy_interruption_retains_partial_text_tool_and_receipt; p1a11_accept_append_faults_roll_back_events_projections_head_and_receipt.
- Initial storage integration: 54 passed, 20 failed. Failures were p1a11_correlation_nested_identities_provider_and_sequences; p1a11_correlation_unadmitted_and_early_final_identities; p1a14_correlation_active_turn_request_and_reuse_original_request; p1a14_correlation_finish_and_result_keep_start_identity; p1a13_partial_native_response_and_unknown_extension_exact_roundtrip; p1a26_finite_history_and_tool_results_exceed_old_context_thresholds; p1a11_atomic_mixed_batch_and_unsupported_envelopes; p1a11_mixed_records_rollback_and_receipt_replay_after_terminal; p1a12_source_gaps_duplicates_and_multiple_runs; p1a16_all_outcomes_terminal_delivery_and_no_resurrection; p1a16_conflicting_terminal_outcome_identity_and_delivery_reject; p1a17_restart_interrupts_once_preserves_partial_results_and_old_receipts; repair_integrity_replays_transition_and_correlation_rules; repair_integrity_run_partial_result_interruption_and_opaque_controls; repair_integrity_run_projection_matches_full_replay; repair_integrity_tool_partial_order_and_reuse_controls; repair_integrity_tool_projection_is_bidirectional_and_immutable; p1a14_mismatch_duplicate_missing_output_and_completed_guard; p1a14_real_registry_success_failure_limit_and_both_recording_orders; p1a15_saved_reuse_scoped_call_ids_exact_bytes_and_zero_storage_execution.
- Initial formatting check failed on increment edits. Formatting changed no unrelated baseline file.

Corrections changed only current Wi identities, retaining distinct valid mismatches, native values, SQL corruption mutations, error categories and privacy canaries. Correlation negatives now explicitly reject accidental storage.invalid_input classification. Genuine old-schema fixture bytes were not updated. No required test was excluded.

The full implementation report remains /tmp/wi-id2a-baseline.dLRnVD/IMPLEMENTATION_REPORT.md; original indexed diagnostic labels include ID2a-all-targets-initial, ID2a-storage-integration-initial and ID2a-format-initial.

## Limits and next scope

ID2b supported OpenAI local session/composite/accepted-provider checks remain pending. General native formats, generic provider identifiers, account/managed-store compatibility and genuinely oversized historical summaries remain separate decisions. No read policy for those old summaries was invented. G1 display reads, HTTP/SSE/reconciliation, browser and final closure remain incomplete. No real-store/credential/private-skill/auth/live access, Git write, hosted mutation, new dependency, quota, retry or Windows support was introduced.
