# ID2b supported local identity evidence

Scope: supported OpenAI local session UUIDs and local event composites at producer and novel storage boundaries. Not G1.1 acceptance or universal external-ID policy. HEAD remained 318b7f0da7d503e2e3a8cf33be84e78ebbe8affb. Index empty; all work unstaged/uncommitted.

## Implemented behavior

- src/identifiers.rs:14-22 shares exact local composite validation. Session is a canonical non-nil UUID, not v4-only. Event ID equals session UUID, colon and positive canonical decimal envelope.sequence. Maximum spelling: 57 ASCII bytes. Numeric gaps and u64::MAX pass. provider_sequence is not used.
- src/run/mod.rs:284-290 validates the actual selected supported provider's session after installing cleanup and before assigning identity, binding, turn or generation work.
- src/run/collect.rs:21-38 validates the supported local composite before collector sequence/response/terminal changes, summary/last_response, publication or tools.
- src/storage/records.rs:255-286 validates supported Runtime/Result optional sessions, nested local composite/provider label and Binding local session using the actual accepted provider. Supplied nested/binding labels cannot bypass validation. Structural/correlation precedence remains.
- src/storage/run_store.rs:603-627 preserves historical receipt/conflict precedence and preflights the complete novel batch with actual accepted input before sequence allocation/inserts.

Invalid producer identities yield static provider_correlation with healthy cleanup/final persistence and no invalid identity disclosure/tool effect. Invalid new storage identities reject without committed canonical/display/manifest/receipt changes. Generic opaque local identities, historical constructors/serde/runtime/binding/B2/repair decoding and native observation policy remain unchanged.

The parent compared all source/test/example/doc bytes against /tmp/wi-id2b-before/tree.tar in memory. Exactly 14 isolated paths changed: 11 modified and three added, no deletions. Three new regression files are execution/tests/local_identifiers.rs, storage/identifier_tests/local.rs and local/historical.rs. Four current producer/append fixture files changed local IDs, not genuine old-schema fixtures. No docs/examples/top-level integration-test/dependency/schema/CI changes occurred in the increment. Tar SHA256: afc52344ff1ef3a6660f9446bca9e823210a6d4ab7417f2bf506709f8361bdf1.

## Regression coverage

Ten new functions cover exact composites; collector state barriers; malformed supported sessions; malformed composites/labels; non-v4/gap/max-u64/generic success; Runtime/Result/Binding new sessions; supported nested paths; preinsert whole-batch rejection; valid supported binding/runtime/result/optional/duplicate/repair paths; and independently populated released schema1/2 supported opaque local history.

Persistent tests use real controller/PersistentObserver/SQLite and a RunFinished BeforeCommit barrier. They independently observe close/poll/tool counters before release, then verify final receipt/result and reopened history. Invalid sessions perform no turn/generation/identity/install work. Invalid events preserve correlation uncertainty and never publish the invalid wrapper. Historical tests retain bytes/source fields, commands/receipts, run projections and digest through raw/migration/binding/B2/repair reads and typed/serde exact retries/conflicts. No provider work occurs during reconstruction.

## Initial review finding and remediation

Initial ID2b review-a required changes; review-b and review-c passed. Preserve the initial disagreement, not just the later passes.

ID2b-A-01: replacing private-session-canary with the canonical LOCAL_SESSION UUID weakened the serve-process log privacy assertion. The existing check rejected TOKEN and the word canary, but not the replacement UUID. Independent verification reproduced the missing coverage with actual substring predicates, both stdout/stderr and graceful/crash modes, including valid lifecycle notices. No production leak was observed.

Remediation added exactly assert!(!output.contains(LOCAL_SESSION)) at src/cli/serve_cli/tests/process.rs:292 inside the existing both-channel loop. Token/canary/lifecycle assertions remained. Twenty in-memory oracle cases and the exact binary fresh-process test passed, followed by formatting/all-target check/Clippy/whitespace. The pre-fix file and isolation record remain /tmp/wi-id2b-a01.cFtvq4. No other source changed during remediation.

Three fresh full ID2b repeat reviews returned PASS with no blocking findings. All reviewed the complete 14-path increment and exact one-line remediation, not only the last assertion. review-a reran ID2b (10), ID2a (10), ID1 persistent (1), storage integration (74), privacy audits (4), unbound history (1), opaque response compatibility (1), platform (1) and whitespace. review-b reran ID2b (10), the exact binary fresh-process regression (1) and whitespace. review-c reran ID2b (10), the binary fresh-process regression (1), formatting, Clippy for lib/bins/tests and whitespace. A lib-target fresh-process filter produced zero tests in review-c; only the subsequent binary-target one-test run is execution evidence.

Initial review-a's all-target invocation timed out after 769 library passes. Separate binary/storage/controller runs passed, but that timeout is not a full independent all-target pass. Other reviewers' initial focused/native executions remain increment evidence, not final acceptance.

## Parent final scoped native gates

After remediation and all three repeat reviews, the parent ran this exact successful chain on the current source:

- cargo fmt --all -- --check
- cargo check --locked --offline --all-targets
- cargo test --locked --offline --all-targets
- cargo clippy --locked --offline --all-targets -- -D warnings
- cargo build --locked --offline --all-targets
- cargo test --locked --offline --doc
- cargo test --locked --offline --test platform_support
- git diff --check

Library: 769 passed, 10 existing ignores. Binary: 59 passed, one existing ignore. Storage integration: 74 passed. Run controller: 39 passed. All other executed targets passed. Doctests: zero. Platform: one. No new ignore/exclusion was added. Indexed diagnostic label: final scoped identifier native gates. This is local Linux/WSL evidence, not hosted/macOS/browser/live evidence.

Before remediation, the implementation independently ran the same native gates, all eight offline examples, static-only verifier and 152 CLI self-test assertions. Those example/static/self-test results remain implementation evidence. Parent's final chain does not claim it reran example binaries or full verify.py. Protected old reports, exact archived conflict source, native513-byte acceptance, active ID2a summary replacements and old fixture bytes remained unchanged.

## Retained implementation failures

The original implementation report remains /tmp/wi-id2b-before/IMPLEMENTATION_REPORT.md. Initial diagnostic labels/fixes:

1. ID2b-all-targets-initial timed out at 120000ms without a final summary. Later complete execution used a longer observation window; no Wi task deadline was added.
2. ID2b-storage-new-initial: E0618, a new result binding shadowed a fixture function. Renamed only that new local binding; four focused tests passed.
3. ID2b-historical-initial: released schema1 CHECK rejected run.history.selected. The new fixture now models genuine unbound schema1 and bound schema2, without changing existing DDL/fixtures.
4. ID2b-historical-fixed: E0308, new finite receipt boundaries used u64 instead of i64. Corrected the fixture types.
5. ID2b-historical-sequences-fixed: schema2 binding read returned storage.integrity because the new fixture lacked the authentic acceptance+selection command receipt/hash. Added that synthetic receipt; production historical readers remained unchanged.
6. ID2b-format-initial failed on increment formatting; no unrelated baseline path was reformatted.
7. ID2b-tests-final: 766 library passes, three failures, 10 ignores. Current task_audit_allows_wall_clock_regression_between_append_batches, task_audit_rejects_corrupt_completed_metadata_projection_and_appends and unbound_history_real_seed_and_private_audit_corruption_negatives still supplied opaque supported sessions/composites. Only their current IDs changed; task-audit UUID privacy canary stayed explicit.
8. ID2b-clippy-initial: collapsible_if in the new historical fixture. Corrected without warning suppression.
9. ID2b-tests-final-fixed: library passed; binary had 46 passes, 13 failures, one ignore. Current CLI/shared scripted producers still used opaque supported local IDs. Failures were run_cli_empty_catalog_preserves_project_context_without_loader_claim; run_cli_prepared_catalog_and_explicit_bodies_reach_existing_controller; run_cli_unselected_body_is_not_validated_before_provider_construction; r1_a02_run_handler_multiline_outcomes_and_json_are_unmodified; r1_a02_run_plain_cancellation_label_and_final_sink_precedence; r1_a02_run_sink_failures_stop_work_and_keep_exit_precedence; run_cli_broken_output_stops_work_and_final_sink_error_overrides_completed; run_cli_handler_prevalidates_before_factory_and_reads_bounded_utf8; run_cli_plain_filters_controls_labels_validated_and_partial_outcomes; run_cli_real_handler_json_outer_only_defaults_and_opt_in_tools; run_cli_refusal_completed_exit_code; run_cli_signal_cancels_and_awaits_close_and_terminal_result; fresh_process_reads_complete_partial_and_unbound_history_without_resume. Corrected only producer identities; final binary/native gates passed.

No failed required test was hidden by an ignore/filter. The later privacy review finding, confirmed counterexample and remediation remain separately recorded above.

## Remaining policy and G1 work

Defined request/local-identity correction is implemented and reviewed. Complete identifier-audit closure is not claimed: universal native response/item formats, generic provider local formats, private account bounds and managed-incarnation compatibility need separate decisions. Preserving old canonical history also leaves genuinely oversized old summaries incompatible with the unchanged mandatory header/page budget. No real database was inspected and no read-error/omission/continuation policy was invented. G1 display reads/HTTP/SSE/browser/CI/final complete-diff closure remain incomplete. No real-store/credential/private-skill/auth/live work, new dependencies/quotas/retries/Windows support, Git write or hosted action occurred.
