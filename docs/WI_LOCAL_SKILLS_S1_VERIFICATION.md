# Wi S1 verification report

Contract: **s1.0**. Status: **OFFLINE ACCEPTED**. Accepted: **true**.

The supplied final offline gates passed. S1-00 through S1-23 have passing evidence. Three independent reviewers inspected the complete accumulated implementation and both report drafts. All three returned PASS with no blocking findings. Live verification remains NOT RUN and was not authorized.

## Tested revision/worktree and environment

| Item | Evidence |
|---|---|
| Accepted runtime baseline and merge-base | `b33ca4bb1cdf8ae58da8d83123b87956535d6a2c` |
| Initial and current HEAD | `ed712c9df548b10962e527bbb634dbe53fe3fa36` |
| Branch | `docs/s1-local-skills-context` |
| Initial worktree | Clean, according to the supplied parent observation |
| Tested worktree | Uncommitted implementation on that HEAD; the SHA does **not** represent the implementation or these reports |
| Report-author inspection | HEAD, branch, merge-base and unstaged inventory match the supplied summary; no staged changes |
| Operating system | Linux `6.18.33.2-microsoft-standard-WSL2`, x86_64 |
| Toolchain | rustc `1.98.1`; cargo `1.98.1`; uv `0.12.10`; Node `v24.18.0` |
| Isolation | Isolated temporary roots for HOME, XDG_CONFIG_HOME and CODEX_HOME; trusted Cargo/Rustup caches preserved; `CARGO_NET_OFFLINE=true` for final Cargo and verify commands |
| Other platforms | Windows and macOS NOT RUN |

### Evidence attribution

- **Parent-observed execution:** the command outcomes, counts, environment, baseline and final-run history supplied with this assignment. The report author did not rerun Cargo, verify, Node self-tests or examples.
- **Supplied review history:** three increments each received review-a, review-b and review-c. Confirmed fixes passed repeated gates. This is not the pending accumulated complete-diff review.
- **Report-author source inspection:** governing documents, current status, focused diffs, implementation and test assertions. A named test below means inspected source mapped to the parent-observed passing suite, not a separately executed test command.
- **Live evidence:** none for S1. Offline prompt composition and scripted execution do not prove that a live model follows a skill. Historical authentication/provider evidence remains historical.

## Scope

The implementation adds reusable explicit-root discovery and preparation, global-plus-project metadata, root-only project instructions, qualified explicit body activation, thin CLI callers and an offline example. It removes the unsupported hosted-skill capability surface.

Public boundaries are `ContextRoots` and `discover` in `src/context.rs:26-31,454-494`, and `prepare_run`/`PreparedRun`/`ContextManifest` in `src/context/preparation.rs:21-165`. The manifest exposes available scoped IDs, active scoped IDs and the project-instruction source. Existing `RunRequest` and the run controller remain the execution boundary. `src/run_cli.rs:109-123` prepares before provider construction and then calls `wi::run::run`; `src/skills_cli.rs:70-79` calls discovery only.

This report assignment creates only the two verification reports. It does not modify implementation, tests, dependencies, README, other documentation or Git state.

## Baseline and actual fixes

The isolated pre-edit baseline passed all six Cargo gates, `uv run scripts/verify.py`, Node self-tests, `run_offline` and `git diff --check`. Baseline Rust tests: **260 passed, 0 failed, 0 ignored**. Baseline Node self-tests: **152**, `live_started=false`. Baseline `run_offline` completed with **50**. Baseline passes are comparison evidence, not evidence that S1 existed at HEAD.

The implementation added discovery, preparation and CLI coverage and removed hosted-only declarations/expectations. Confirmed review findings were fixed:

| Finding | Resolution and focused regression source | Result |
|---|---|---|
| Quoted `<<` keys were incorrectly treated as YAML merges | Reject plain merge keys, retain quoted keys as data. `context_catalog_quoted_merge_keys_are_retained_as_data`, `tests/context_catalog.rs:326-353`; malformed nested merge/duplicate cases at `tests/context_catalog.rs:390-443` | Fixed; included in passing final suite |
| Context wrapping made blank original task/instructions valid | Validate original and effective requests. `context_prepare_rejects_blank_original_task_with_context_before_construction` and `context_prepare_rejects_blank_original_instructions_with_context_before_construction`, `tests/context_prepare/validation.rs:228-257`; preserve error precedence at `tests/context_prepare/validation.rs:260-285` | Fixed; included in passing final suite |
| Invalid UTF-8 in changed frontmatter returned `read_failed` | Revalidate metadata before decoding the selected body. `context_prepare_revalidates_frontmatter_before_decoding_selected_body`, `tests/context_prepare/validation.rs:78-92`, asserts `context_changed` | Fixed; included in passing final suite |
| Provenance manifest omitted available scoped IDs | Populate available and active IDs and compare each list to the payload. `context_prepare_exact_metadata_body_separation_selection_order_and_prefix`, `tests/context_prepare.rs:73-174`; catalog-only/no-context cases at `tests/context_prepare.rs:177-238` | Fixed; included in passing final suite |
| Absolute workspace unnecessarily depended on cwd | Resolve cwd only for omitted/relative workspace. `context_cli_unavailable_cwd_is_ignored_only_for_absolute_workspace`, `src/context_cli.rs:146-178`; deleted-cwd binary regressions at `tests/skills_cli.rs:190-303` | Fixed; included in passing final suite |

Implementation delegates also corrected initial compile/test assertion issues before reporting their increments complete. The supplied evidence does not identify those commands or exit codes. These intermediate issues are not final-parent-run failures. The final parent run had **no failures and no retries**.

## S1 matrix: named tests, assertions, results and blockers

**PASS** below means passing offline technical evidence, not overall acceptance. Unless a row names another observer, execution is the parent-observed final `cargo test --all-targets` pass. Source locations explain the assertions. Every PASS row has no known in-scope blocker; platform and trust limits remain as documented below.

| ID | Named tests / observed evidence and source | Assertions and result | Blockers |
|---|---|---|---|
| S1-00 | Parent baseline gate set; report-author `git status --short --untracked-files=all`, HEAD/branch/merge-base inspection and focused diffs | **PASS.** Initial clean state and current uncommitted implementation distinguished; baseline 260/152 retained; no historical report/ledger edits in the changed inventory | None |
| S1-01 | `context_catalog_uses_no_ambient_roots_even_without_home`, `tests/context_catalog.rs:652-716`; `context_catalog_independent_concurrent_callers_keep_workspace_context_separate`, `tests/context_catalog.rs:616-649`; `context_prepare_simultaneous_workspaces_share_only_explicit_global_metadata`, `tests/context_prepare/filesystem.rs:4-69` | **PASS.** Explicit library roots work without HOME; concurrent catalogs/preparations do not change cwd or mix project context. Library discovery/preparation has no CLI, provider or auth-manager dependency | None |
| S1-02 | `context_cli_roots_resolve_both_environment_routes_and_workspace_once`, `src/context_cli.rs:104-143`; `context_cli_invalid_environment_is_explicit_and_sanitized`, `src/context_cli.rs:181-209`; `context_cli_unavailable_cwd_is_ignored_only_for_absolute_workspace`, `src/context_cli.rs:146-178`; `context_catalog_missing_roots_are_read_only_empty_scopes`, `tests/context_catalog.rs:59-71`; `context_catalog_existing_wrong_type_roots_fail`, `tests/context_catalog.rs:101-120` | **PASS.** Absolute XDG route or HOME fallback; relative XDG and missing/invalid HOME reject; project scope uses `.agents/skills`; missing scopes stay empty without creation; absolute workspace does not require cwd | None |
| S1-03 | `context_prepare_catalog_only_never_reopens_unselected_files`, `tests/context_prepare.rs:177-213`; `run_cli_prepared_catalog_and_explicit_bodies_reach_existing_controller`, `src/run_cli_context_tests.rs:98-218`; `skills_binary_both_global_routes_project_addition_and_metadata_only_output`, `tests/skills_cli.rs:103-163` | **PASS.** Global frontmatter is present without activation and with/without project skills. Project metadata adds to globals; no implicit body activation or global-disable behavior | None |
| S1-04 | `context_catalog_stops_at_valid_malformed_and_root_package_boundaries`, `tests/context_catalog.rs:254-297`; `context_catalog_unreadable_manifest_is_excluded_but_resources_are_not_traversed`, `tests/context_catalog.rs:917-940`; `skills_binary_missing_scopes_are_empty_without_creating_config_or_auth_paths`, `tests/skills_cli.rs:166-186` | **PASS.** Deterministic iterative traversal stays within selected skill roots and stops at valid/malformed package boundaries. A root-level package is included without a false directory-name warning. Other harness directories, arbitrary Markdown and package resources are not loaded; discovery creates nothing | None |
| S1-05 | `context_catalog_scopes_coexist_and_sort_by_name_not_source_path`, `tests/context_catalog.rs:123-182`; `context_catalog_duplicate_validated_names_fail_in_either_scope`, `tests/context_catalog.rs:185-206`; `context_prepare_exact_metadata_body_separation_selection_order_and_prefix`, `tests/context_prepare.rs:73-174` | **PASS.** Same-name global/project entries coexist in catalog and payload; globals-by-name precede projects-by-name; duplicates within either scope fail instead of selecting a traversal winner | None |
| S1-06 | `context_catalog_yaml_strings_comments_bom_crlf_and_json_data_are_retained`, `tests/context_catalog.rs:299-323`; `context_catalog_quoted_merge_keys_are_retained_as_data`, `tests/context_catalog.rs:326-353`; `context_catalog_malformed_yaml_excludes_only_the_located_skill`, `tests/context_catalog.rs:390-443`; `context_catalog_required_optional_field_shapes_and_scalar_lengths`, `tests/context_catalog.rs:446-520`; `context_catalog_requires_delimiter_lines_and_utf8_metadata`, `tests/context_catalog.rs:523-550` | **PASS.** Real YAML parser handles strings/comments/Unicode/BOM/line endings. Invalid fields, duplicate keys, tags, plain merges, anchors/aliases, multiple documents, malformed delimiters and non-UTF-8 metadata reject safely. Required name/description limits are format validation, not body recommendations | None; stricter standard-tag rejection documented |
| S1-07 | `context_catalog_optional_behavior_is_data_and_directory_mismatch_only_warns`, `tests/context_catalog.rs:357-388`; `context_catalog_stops_at_valid_malformed_and_root_package_boundaries`, `tests/context_catalog.rs:254-297`; `context_catalog_required_optional_field_shapes_and_scalar_lengths`, `tests/context_catalog.rs:447-521`; `context_prepare_selected_references_do_not_read_register_execute_or_fetch`, `tests/context_prepare/filesystem.rs:252-303` | **PASS.** Valid optional/unknown data is retained. Behavioral fields warn but do not grant tools or hide entries; actual package-directory mismatches warn without exclusion. Root-level packages do not receive that warning. Standard `allowed-tools` accepts a string, not an array | None |
| S1-08 | `context_catalog_large_non_utf8_unselected_body_is_not_loaded_or_size_checked`, `tests/context_catalog.rs:553-570`; `context_prepare_catalog_only_never_reopens_unselected_files`, `tests/context_prepare.rs:177-213`; `context_prepare_selected_body_must_be_nonblank_utf8_and_bounded`, `tests/context_prepare/validation.rs:41-75` | **PASS.** Metadata discovery accepts a large/non-UTF-8 unselected body and retains no body. Activation requires bounded nonblank UTF-8 instructions. Parsing stops at the delimiter; buffered physical read-ahead is not ruled out | None |
| S1-09 | `context_catalog_malformed_yaml_excludes_only_the_located_skill`, `tests/context_catalog.rs:390-443`; `context_catalog_unreadable_roots_and_traversal_are_fatal`, `tests/context_catalog.rs:892-913`; `context_catalog_debug_redacts_metadata_and_host_paths`, `tests/context_catalog.rs:590-613`; `skills_binary_visible_diagnostics_keep_valid_entries_and_filter_controls`, `tests/skills_cli.rs:306-355` | **PASS.** Malformed located skills are excluded with visible diagnostics; unrelated valid entries remain. Unreadable traversal and duplicates are fatal. Ordinary diagnostics/Debug omit content and canonical private paths | None |
| S1-10 | `context_catalog_canonicalizes_only_selected_roots`, `tests/context_catalog.rs:767-786`; `context_catalog_descendant_package_and_manifest_links_are_diagnosed_not_followed`, `tests/context_catalog.rs:789-851`; `context_catalog_linked_agents_and_project_skills_roots_are_skipped`, `tests/context_catalog.rs:854-875`; `context_catalog_fifo_and_directory_manifests_are_excluded_without_reading`, `tests/context_catalog.rs:976-1002`; `context_prepare_selected_manifest_and_ancestor_replacement_links_fail_closed`, `tests/context_prepare/filesystem.rs:183-221`; `context_prepare_fifo_and_device_instructions_or_selected_manifest_are_not_read`, `tests/context_prepare/filesystem.rs:308-349` | **PASS on Linux.** Explicit root links may select boundaries; descendant links/special files fail or are diagnosed without being read. Device-target links reject; no device node was created. This is not proof against adversarial ancestor races or hardlinks | None; Windows/macOS unrun |
| S1-11 | `context_skill_ids_require_qualified_valid_names`, `tests/context_catalog.rs:209-251`; `context_prepare_unknown_and_invalid_selections_are_not_paths`, `tests/context_prepare/validation.rs:11-38`; `context_prepare_exact_metadata_body_separation_selection_order_and_prefix`, `tests/context_prepare.rs:73-174`; `run_cli_parser_requires_qualified_ids_and_keeps_selection_order`, `src/run_cli_context_tests.rs:38-95` | **PASS.** Qualified catalog selection only; unknown, bare and path-like IDs reject. Repeated IDs activate once at first position; cross-scope selection order is preserved. Selection does not modify actual tools or provider/model/auth choices | None |
| S1-12 | `context_prepare_agents_is_root_only_and_loaded_after_discovery`, `tests/context_prepare.rs:241-269`; `context_prepare_no_context_is_byte_identical_with_missing_or_empty_agents`, `tests/context_prepare.rs:216-238`; `context_prepare_agents_links_including_dangling_are_errors_not_missing`, `tests/context_prepare/filesystem.rs:164-180`; `context_prepare_unreadable_instructions_and_selected_manifest_fail`, `tests/context_prepare/filesystem.rs:224-249`; metadata-only list test at `tests/skills_cli.rs:103-163` | **PASS.** Only root AGENTS.md is loaded, only during preparation. Missing/empty is benign; unsafe, unreadable or non-UTF-8 text fails before construction. Ancestor/nested/global instructions and SYSTEM.md are not loaded; source label is `project:AGENTS.md` | None |
| S1-13 | `context_prepare_exact_metadata_body_separation_selection_order_and_prefix`, `tests/context_prepare.rs:73-174`; `context_prepare_delimiter_injection_is_escaped_data_not_instructions`, `tests/context_prepare.rs:321-359` | **PASS.** Exact task and instruction prefix retained. Four fixed JSON fields contain all frontmatter and only selected bodies, with sorted nested keys and selection order. Framing adds no permission/loader; file bodies stay out of higher-priority instructions | None; JSON structure is not prompt-injection prevention |
| S1-14 | `context_prepare_no_context_is_byte_identical_with_missing_or_empty_agents`, `tests/context_prepare.rs:216-238`; `context_prepare_file_limits_and_rendered_input_overhead_fail_without_truncation`, `tests/context_prepare/validation.rs:95-133`; `context_prepare_oversized_mandatory_catalog_is_not_partially_included`, `tests/context_prepare/validation.rs:136-150`; `context_prepare_uses_existing_one_item_input_byte_boundary`, `tests/context_prepare/validation.rs:153-170`; `context_prepare_validates_framed_options_with_actual_tools_at_existing_limit`, `tests/context_prepare/validation.rs:192-225`; blank-original regressions at `tests/context_prepare/validation.rs:228-257`; `run_cli_context_errors_and_final_validation_precede_all_constructors`, `src/run_cli_context_tests.rs:221-298` | **PASS.** No-context request remains byte-identical. Original and rendered requests use existing complete-input and tools-inclusive options checks; oversize mandatory context fails without truncation. Returned options.tools is empty. No count quota, budget or provider-limit change | None |
| S1-15 | `context_prepare_revalidates_metadata_and_keeps_an_owned_body_snapshot`, `tests/context_prepare.rs:272-318`; `context_prepare_revalidates_frontmatter_before_decoding_selected_body`, `tests/context_prepare/validation.rs:78-92`; `context_prepare_simultaneous_workspaces_share_only_explicit_global_metadata`, `tests/context_prepare/filesystem.rs:4-69`; `context_prepare_resolved_root_links_do_not_redirect_the_snapshot`, `tests/context_prepare/filesystem.rs:124-161` | **PASS.** Changed/invalid metadata yields `context_changed`; body edits before activation can load. Prepared owned bytes survive subsequent edits/deletion; fresh discovery sees changes; independent workspaces remain isolated | None |
| S1-16 | `context_prepare_selected_references_do_not_read_register_execute_or_fetch`, `tests/context_prepare/filesystem.rs:252-303`; `context_prepare_unknown_and_invalid_selections_are_not_paths`, `tests/context_prepare/validation.rs:11-38` | **PASS.** Inert scripts/references/assets/installation/URL text causes no resource loading, tool registration or network connection. Denied resource directories do not prevent instruction-only activation; unknown selection is an error, not fictitious execution | None |
| S1-17 | `context_prepare_external_provider_receives_snapshot_and_only_ordinary_tool_continuation`, `tests/run_support/context.rs:6-136` | **PASS.** External scripted Provider receives exact prepared task/catalog/bodies/options through `wi::run::run`, after fixture deletion. Non-OpenAI native fields survive. One session, two ordinary model requests and one tool dispatch complete with 42; no skill-load request | None |
| S1-18 | `context_prepare_websocket_exact_initial_context_then_same_session_parent_delta`, `src/providers/openai_codex/context_loopback_tests.rs:121-160`; `context_prepare_sse_replays_exact_initial_context_once_with_native_history`, `src/providers/openai_codex/context_loopback_tests.rs:163-196` | **PASS.** Actual adapter loopback WS keeps one-session parent/delta continuation and fixed instructions; SSE replays exact initial prepared context once within native history. Native/recovered cases retain ordinary tool flow; no extra generation or auth/wire/codec policy change | None |
| S1-19 | `skills_binary_both_global_routes_project_addition_and_metadata_only_output`, `tests/skills_cli.rs:103-163`; `skills_binary_visible_diagnostics_keep_valid_entries_and_filter_controls`, `tests/skills_cli.rs:306-355`; `run_binary_context_failures_precede_each_auth_source_and_preserve_relative_labels`, `tests/skills_cli.rs:459-488`; `run_cli_prepared_catalog_and_explicit_bodies_reach_existing_controller`, `src/run_cli_context_tests.rs:98-218`; `run_cli_context_errors_and_final_validation_precede_all_constructors`, `src/run_cli_context_tests.rs:221-298`; `run_cli_diagnostics_are_delivered_before_construction_and_not_to_ndjson`, `src/run_cli_context_tests.rs:312-343` | **PASS.** Local metadata-only list and shared run preparation work. Context/validation failures do not reach provider/auth constructors. Plain controls are filtered; diagnostics go to stderr; run schema2/provider schema1 remain unchanged | None |
| S1-20 | `hosted_skills_required_feature_is_unknown_before_provider_construction`, `tests/provider_contract.rs:120-154`; `skills_binary_help_parser_is_metadata_only_and_capabilities_exclude_hosted`, `tests/skills_cli.rs:530-572`; `advanced_feature_requirement_fails_before_authentication`, `src/providers/openai_codex/tests.rs:562-577`; focused enum/provider diff inspection | **PASS.** HostedSkills enum/mapping/report entry removed without alias. Old `hosted_skills` input fails unknown-variant decoding with zero constructors. Other four advanced features remain unsupported; generic native data remains preserved; no hosted probe or fallback | None |
| S1-21 | `run_request_contains_only_task_fields_and_rejects_obsolete_configuration`, `tests/run_controller.rs:119-143`; `run_collector_rejects_identity_order_idle_close_eof_and_accepts_gaps`, `tests/run_controller.rs:545-611`; `run_cached_batches_reuse_results_without_new_dispatch`, `tests/run_controller.rs:614-629`; `run_sink_variants_stop_once_and_final_failure_preserves_outcome`, `tests/run_controller.rs:723-798`; `run_l_160_distinct_calls_then_final_uses_161_requests`, `tests/run_support/workloads.rs:8-83`; `run_pending_tool_survives_120_600_3600_seconds_then_release_or_cancel`, `tests/run_support/stop.rs:134-225`; `whole_batch_authority_rejects_before_dispatch_or_reuse`, `src/tools_batch_tests.rs:83-137`; recovery/consistency and managed-auth suites listed below | **PASS.** C1/M3 cancellation, correlation, authority, validation, result reuse, recovery/uncertainty and synthetic auth regressions pass. Existing expectations change only for hosted removal/automatic preparation. No RunLimits, run timers/quotas, service, persistence, watcher or extra executor added | None; earlier loopback observation retained below |
| S1-22 | Parent-observed `cargo run --example run_offline` and `cargo run --example skills_offline`; new example assertions in `examples/skills_offline.rs:147-258`; future requirements in `README.md:256-264` and `docs/ARCHITECTURE.md:326-337` | **PASS.** run_offline Completed 50: one session/three requests/two tools. skills_offline Completed 42: two catalog entries/one active skill/one session/two requests/one tool. Finite scripted work only. Future service/storage requirements recorded, not implemented | None |
| S1-23 | All final commands below passed; supplied increment review-a/review-b/review-c gates passed after fixes; final review-a/review-b/review-c inspected the complete accumulated source, tests, docs, examples, dependency lock and both report drafts | **PASS.** All three final reviewers returned PASS with no blocking findings. Active documentation and help agree with s1.0; historical evidence remains intact; these reports retain observer attribution and live NOT RUN | None |

Additional retained suite anchors for S1-21 are `recovered_loopback_text_tool_continuation_and_observer_matrix` and `invalid_recovery_loopback_reports_received_without_settlement_or_second_send` (`src/providers/openai_codex/recovery_loopback_tests.rs:58-272`); both `consistency_public_session_*` tests (`src/providers/openai_codex/consistency_loopback_tests.rs:35-434`); `managed_ws_profile_selected_per_open_and_continuation_keeps_handshake` and `managed_sse_renews_same_profile_for_tool_result_and_rejects_relogin` (`src/providers/openai_codex/managed_loopback_tests.rs:40-235`); and `store_absence_is_read_only_but_existing_unsafe_paths_fail` / `store_rejects_permissions_symlinks_hardlinks_and_size` (`src/providers/openai_codex/managed_store_tests.rs:27-60,136-170`). These are offline synthetic regression tests, not new real credential operations.

## Commands and exit codes

Observer for every row: **parent/orchestrator, supplied observed final execution**. Each command exited **0**. No final-parent failures or retries occurred.

| Command | Exit | Observed result |
|---|---:|---|
| `cargo fmt --all -- --check` | 0 | PASS |
| `cargo check --all-targets` | 0 | PASS |
| `cargo test --all-targets` | 0 | 339 passed, 0 failed, 0 ignored |
| `cargo clippy --all-targets -- -D warnings` | 0 | PASS |
| `cargo build --all-targets` | 0 | PASS |
| `cargo test --doc` | 0 | PASS; 0 doctests |
| `uv run scripts/verify.py` | 0 | PASS; source_files 76, rust_test_definitions 326, fixture_events 25 |
| `node scripts/cli_retest.mjs --self-test` | 0 | 152 passed; live_started false |
| `cargo run --example run_offline` | 0 | Completed 50; 1 session, 3 model requests, 2 tool executions; offline |
| `cargo run --example skills_offline` | 0 | Completed 42; 2 catalog entries, 1 active skill, 1 session, 2 model requests, 1 tool execution; offline |
| `git diff --check` | 0 | PASS on the implementation before these report drafts |

Final Rust breakdown: lib **207**; bin wi **24**; context_catalog **28**; context_prepare **26**; managed_absence_cli **1**; provider_contract **5**; run_cli integration **4**; run_controller **33**; skills_cli **11**; example test harnesses **0**. Sum: **339**. Doctests: **0**. This is 79 more passing Rust tests than the baseline, not a test-count requirement. Verify's 326 source test definitions are a different inventory measure from executed tests.

The supplied full-suite command has no test-name filter. Separate filtered-test totals were not supplied. Linux/Unix conditional tests contribute to the observed Linux result; Windows/macOS execution and their platform-specific exclusions were not measured. Zero ignored does not mean all platforms ran.

## Parser dependency and compatibility choices

- `Cargo.toml:29-30` pins `yaml-rust2 = "=0.12.0"` with default features disabled. The event parser exposes anchors, tags and duplicate keys before expansion or replacement (`src/context/frontmatter.rs:65-142`).
- The lockfile adds only yaml-rust2 **0.12.0** and required arraydeque **0.5.1**, hashlink **0.12.2**, hashbrown **0.17.1**, foldhash **0.2.0**. No broad dependency upgrades were observed in the diff.
- Initial implementation fetched/locked this permitted development dependency. Final verification used cached offline resolution. Development dependency fetching is not provider traffic or live skill verification.
- Metadata uses a JSON-compatible YAML subset. Quoted/block strings, comments, nested values and exact validated name/description text are retained. Names are 1..64 lowercase ASCII letters/digits/hyphens with the specified hyphen rules. Descriptions are nonblank and at most 1024 Unicode scalars. Compatibility is nonblank and at most 500 characters. Metadata is a string-to-string map. Standard `license` and `allowed-tools` use string shape.
- Plain merge keys, anchors/aliases, duplicate mapping keys, non-string mapping keys, multiple documents and tags reject. Quoted `<<` is ordinary data. The implementation also rejects standard tags such as `!!str`; this stricter subset is a documented compatibility limitation, not an acceptance blocker under the supplied review disposition.
- A root-level SKILL.md is accepted without a directory/name mismatch warning. The comparison uses only an actual package directory (`src/context.rs:590-597`). Nested package-directory mismatches still produce the nonfatal warning.
- No full Pi/Codex discovery or format parity is claimed. Removing `Feature::HostedSkills` is a focused API/config compatibility break: `hosted_skills` no longer deserializes. There is no no-op alias or mapping to local skills.

## Instruction/catalog/body provenance

| Data | Source and treatment |
|---|---|
| Original task | Caller RunRequest prompt bytes become the JSON `task` value unchanged; no-context requests keep the original prompt unchanged |
| Higher-priority instructions | Original SessionOptions.instructions remains the exact prefix; only fixed context/tool-authority framing is appended |
| Project instructions | Only selected workspace root AGENTS.md, read at preparation; payload label `project:AGENTS.md`; not read by discovery/list |
| Available skills | All valid parsed frontmatter from explicit global root plus project `.agents/skills`, sorted global-by-name then project-by-name; bodies absent |
| Active skills | Explicit catalog IDs only; metadata revalidated before body decoding; deduplicated in first-selection order; owned body snapshot |
| Manifest | Available scoped IDs, active scoped IDs and optional project source; no canonical host paths or body text |
| Provider continuation | Initial prepared payload enters the existing controller once; WS uses subsequent deltas, SSE retains initial context within native-history replay; instructions stay fixed |

Implementation anchors: `src/context/preparation.rs:17-165,168-206`, `src/context.rs:454-494,563-621`, `src/run_cli.rs:109-123`. Filesystem source handles remain private. Wi does not add canonical host paths to model context or list output, but retained user metadata can itself contain private text or paths. No complete prepared request is used as an ordinary log payload.

## Security/trust limitations

- Roots are trusted, owner-selected local filesystem boundaries. S1 is not a hostile-filesystem sandbox or a hardlink-isolation mechanism.
- Unix final opens use `O_NOFOLLOW | O_NONBLOCK`; Windows source uses reparse-point handling and post-open checks (`src/context.rs:319-382`). Only Linux execution was observed. Known links/special files fail closed; ancestor replacement and TOCTOU races are not eliminated.
- Metadata-only reading stops logically at closing frontmatter. Buffered I/O may physically read ahead; no zero-body-byte I/O claim is made.
- Existing MAX_INPUT_BYTES checks bound consumed prompt material and complete rendered input/options. They are not a universal memory bound and do not introduce run budgets or arbitrary catalog-count limits.
- JSON escaping protects payload structure, not model behavior or prompt-injection resistance. Project/skill text grants no permissions, tools, account changes or executable configuration.
- Explicit metadata/list output is intentionally sensitive user data. Debug and ordinary diagnostics redact content/host paths; callers must still protect catalog/prepared inputs and intentional list output.
- Synthetic resource canaries were not executed. No file/shell/coding executor, resource fetcher or skill-loading model tool exists in S1.

## Independent review findings and resolutions

| Review evidence | Disposition |
|---|---|
| Increment 1: review-a, review-b, review-c | After confirmed remediation, each repeated gate passed with no confirmed blocking finding |
| Increment 2: review-a, review-b, review-c | After confirmed remediation, each repeated gate passed with no confirmed blocking finding |
| Increment 3: review-a, review-b, review-c | After confirmed remediation, each repeated gate passed with no confirmed blocking finding |
| Five confirmed findings | Fixed as listed above; focused regression assertions are included in the final passing suite |
| Request to retain allowed-tools array shape | Rejected: under s1.0 the optional standard allowed-tools field has string shape; arbitrary unknown fields remain data |
| Consistency loopback `event bound` timeout | Observed in two reviewer full-suite attempts in pre-existing consistency coverage. Related files were unchanged. Independent verification could not reproduce it: two named attempts and one module attempt passed. Later full/verify gates passed. Retained as a test-infrastructure observation, not a confirmed S1 regression |
| Root-level mismatch warning | **Fixed after final review at the user's request.** Root-level packages now skip the package-directory comparison; the existing real-mismatch test still passes, and the root-package test now requires no diagnostics |
| Standard-tag rejection | Nonblocking compatibility limitation, documented above |
| Final independent accumulated complete-diff review | **PASS.** Review-a, review-b and review-c reviewed the accumulated implementation changes and both report drafts before the focused root-warning follow-up. Each returned PASS with no blocking findings. Review-b independently reran `cargo test --all-targets` with 339 passing tests; review-c independently reran the full required offline gate set with matching results |

The final complete-diff review closed S1-23 with no actionable in-scope findings. The user later requested and approved the focused root-warning fix. Parent-observed offline repetition after that follow-up passed all six Cargo gates with 339 Rust tests, `scripts/verify.py`, 152 Node self-tests, both offline examples, and staged/unstaged diff checks. The first JSON parse check after the earlier acceptance-status updates found a missing comma introduced by the status edit. The comma was restored, and the final JSON and whitespace checks passed.

## Changed files

Report-author inventory before drafting found **16 modified tracked files** and **14 untracked implementation files**. These two new reports make **32 changed paths**. All implementation changes predate this report assignment; only the final two report paths were created here. Nothing is staged or committed.

### Modified tracked files, preserved

- `Cargo.lock`
- `Cargo.toml`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/EVENTS.md`
- `src/lib.rs`
- `src/main.rs`
- `src/provider.rs`
- `src/providers/openai_codex/mod.rs`
- `src/providers/openai_codex/run_loopback_tests.rs`
- `src/providers/openai_codex/tests.rs`
- `src/run_cli.rs`
- `src/run_cli_tests.rs`
- `tests/provider_contract.rs`
- `tests/run_cli.rs`
- `tests/run_controller.rs`

### Untracked implementation files, preserved

- `examples/skills_offline.rs`
- `src/context.rs`
- `src/context/frontmatter.rs`
- `src/context/preparation.rs`
- `src/context_cli.rs`
- `src/providers/openai_codex/context_loopback_tests.rs`
- `src/run_cli_context_tests.rs`
- `src/skills_cli.rs`
- `tests/context_catalog.rs`
- `tests/context_prepare.rs`
- `tests/context_prepare/filesystem.rs`
- `tests/context_prepare/validation.rs`
- `tests/run_support/context.rs`
- `tests/skills_cli.rs`

### New report files from this assignment

- `docs/WI_LOCAL_SKILLS_S1_VERIFICATION.md`
- `docs/wi-local-skills-s1-verification.json`

Historical reports/manifests and governing planning documents remain unchanged. Their PLAN ONLY/NOT RUN text records the planning state; this report records the later uncommitted worktree evidence without rewriting history.

## User-repeatable local commands

Run from the checkout with HOME, XDG_CONFIG_HOME and CODEX_HOME set to isolated temporary roots. Preserve trusted Cargo/Rustup cache locations before changing HOME. Do not point discovery/tests at actual owner skills or private projects. Use the recorded toolchain and cached dependency resolution. These commands are repetition instructions, not additional execution claims:

```sh
export CARGO_NET_OFFLINE=true
cargo fmt --all -- --check
cargo check --all-targets
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo build --all-targets
cargo test --doc
uv run scripts/verify.py
node scripts/cli_retest.mjs --self-test
cargo run --example run_offline
cargo run --example skills_offline
git diff --check
```

No live, auth, profile, login or renewal command is part of this gate set. Test watchdogs and finite scripted fixtures are not runtime work limits.

## Remaining deferred work

- **S2:** model-selected activation and separately approved on-demand resources. S1 supplies preparation and explicit activation only.
- **P1:** storage design and persistent application sessions/history. No database, persistence interface, schema/migrations, retention policy or recovery worker is implemented by S1.
- **V1:** one-owner/multiple-device service, service-client authentication, API, subscriptions and UI. Browser disconnection must not cancel service-owned work. Application sessions must persist. Restart stops active tasks and never automatically restarts/resumes them; continuation requires explicit user action. These are requirements, not S1 service behavior.
- Shell/file/coding tools, watchers, uploads and resource execution remain out of scope. Hosted execution and API-key fallback remain excluded, not silently enabled or promised as the next increment.

`service_and_storage_implemented=false`. Existing in-memory ProviderSession is a transport handle, not persistent application-session storage. No S2/P1/V1 work is authorized by this report.

## Live status

**NOT RUN; not authorized.** S1 live generations **0**; live provider requests **0**; real credential/auth/profile/login/renewal operations **0**; hosted API probes/uploads **0**; real global-skill/private-project content reads for verification **0**. Tests use synthetic roots/credentials, scripted providers and loopback transports. No commits, pushes, merges, releases, publication, deployments or hosted-service writes occurred in the supplied implementation evidence or this report assignment.

The permitted initial development dependency fetch is separate from live provider traffic. Pi's authoring conversation is separate from Wi verification.

Generation ledger: **31/50 used, 19 remaining, changed=false; new allocation 0**.

## Merge-readiness follow-up: 2026-09-12 (MR-00 through MR-04)

**Local offline repairs and independent review passed; submitted-revision merge
readiness remains pending.** This dated follow-up supplements the original Linux
observations above. It does not revise historical acceptance or claim acceptance
of a submitted repair revision.

### Revision, observers and failed CI record

- Reviewed and locally confirmed HEAD: `71e0ce8b3ed3c7fb9fd65348a264c789f989280f`,
  branch `docs/s1-local-skills-context`. The implementor observed a clean initial
  worktree. Tested repairs are unstaged, uncommitted changes on that HEAD; the SHA
  does not contain them. No repair revision was submitted.
- Governing review: [issuecomment-5638072481](https://github.com/zer09/wi/pull/2#issuecomment-5638072481).
  The implementor retrieved the comment, job outcomes and failure logs using
  authenticated, read-only `gh api` / `gh run view` commands. The CI outcomes below
  are GitHub execution evidence, not local native macOS/Windows execution.
- Preserved failed workflow: [34625704647](https://github.com/zer09/wi/actions/runs/34625704647),
  started `2026-09-11T17:05:18Z`, conclusion **failure**, at the reviewed SHA.

| Original CI job | fmt | check | test | Clippy `-D warnings` | build | doctests |
|---|---|---|---|---|---|---|
| Ubuntu, job `103350146214` | PASS | PASS | PASS | PASS | PASS | PASS |
| macOS, job `103350146402` | PASS | PASS | FAIL | SKIPPED | SKIPPED | SKIPPED |
| Windows, job `103350146474` | PASS | PASS | PASS | FAIL | SKIPPED | SKIPPED |

The macOS catalog suite reported **26 passed, 1 failed, 0 ignored, 0 filtered**.
Its only failure was
`filesystem_safety::unix::context_catalog_non_utf8_traversal_names_fail_without_lossy_labels`:
creating the directory from byte `0xff` panicked at
`tests/context_catalog/filesystem_safety.rs:269:10` in the reviewed revision,
with OS error **92**, **Illegal byte sequence** (Cargo exit **101**). The fixture
failed before `discover` ran; it did not demonstrate a discovery-validation defect.
Windows Clippy rejected `return meta.file_attributes() & 0x400 != 0;` at
`src/context.rs:379` as `needless_return`. Windows build/doctest results remain
unknown because those steps were skipped. macOS Clippy/build/doctests were also
skipped, not passing evidence.

### Focused repairs and platform coverage

- `tests/context_catalog/filesystem_safety.rs:256-274`: apply
  `#[cfg(target_os = "linux")]` only to the malformed-name test. Move its
  `OsStringExt` import inside the test so other Unix targets have no unused import.
  Keep real directory creation, `discover(...).unwrap_err()`, `ReadFailed` and
  the exact `global:.` label assertion. No I/O error is caught or treated as success.
- `src/context.rs:374-383`: make the Windows block return its tail expression.
  `MetadataExt::file_attributes() & 0x400 != 0` still detects reparse points,
  including junctions. No lint suppression, validation change or link-policy change.

| Platform | Coverage of this uncommitted repair |
|---|---|
| Linux x86_64 / WSL2 | Observed focused and full offline passes. The real malformed-name fixture ran and passed; no additional Linux test exclusion. |
| macOS | NOT RUN locally. Only that exact fixture is newly excluded at compile time. Source/cfg inspection predicts 26 catalog tests instead of the failed run's 27; this is not a native result. All other existing Unix tests retain their guards and assertions. Native suite and downstream gates remain pending. |
| Windows | NOT RUN or cross-compiled locally. The Windows expression was inspected for equivalence; Linux Clippy does not check it. Existing Unix exclusions are unchanged. Native warning-denied Clippy and remaining gates are pending. |
| Other Unix targets | NOT RUN. The malformed-name fixture is excluded; all other existing platform guards are unchanged. No native pass is inferred. |

Linux execution used a filesystem that accepted the malformed bytes. The fixture
still fails on setup errors; an OS guard does not guarantee every Linux filesystem
supports such names. Existing trusted-owner, hardlink and ancestor-race limitations
remain unchanged. No module, dependency, feature, CI job or other test was changed.

### Implementor-observed local commands and results

Local execution used Linux `6.18.33.2-microsoft-standard-WSL2`, x86_64, an
unprivileged process, rustc/cargo `1.98.1`, uv `0.12.10`, and Node `v24.18.0`.
The shell UTC date was **2026-09-11**; the follow-up heading uses the assigned
**2026-09-12** review date. These results are this implementor's execution evidence,
not a restatement of the original parent-supplied report.

Cargo, uv and Node commands used `env -i` with PATH and trusted Cargo/Rustup caches
preserved. HOME, XDG_CONFIG_HOME, CODEX_HOME and TMPDIR selected synthetic temporary
roots. Cargo used `CARGO_NET_OFFLINE=true`; uv also used a trusted cache,
`UV_OFFLINE=true` and `UV_PYTHON_DOWNLOADS=never`. No dependencies were downloaded
or changed. The table gives exact program arguments; the isolation prefix applies
to every Cargo/uv/Node row.

| Command | Exit | Observed result |
|---|---:|---|
| `cargo test --test context_catalog filesystem_safety` | 0 | 10 passed, 0 failed, 0 ignored, 18 filtered; malformed-name discovery and applicable filesystem protections passed |
| `cargo fmt --all -- --check` | 0 | PASS |
| `cargo check --all-targets` | 0 | PASS |
| `cargo test --all-targets` | 0 | 339 passed, 0 failed, 0 ignored, 0 filtered |
| `cargo clippy --all-targets -- -D warnings` | 0 | PASS on Linux only |
| `cargo build --all-targets` | 0 | PASS |
| `cargo test --doc` | 0 | PASS; 0 doctests |
| `uv run scripts/verify.py` | 0 | All six Cargo gates passed again; 339 Rust tests, 0 doctests; source_files 113, rust_test_definitions 326, fixture_events 25 |
| `node scripts/cli_retest.mjs --self-test` | 0 | 152 passed; live_started=false |
| `cargo run --example run_offline` | 0 | Completed 50; 1 session, 3 scripted model requests, 2 tool executions; offline |
| `cargo run --example skills_offline` | 0 | Completed 42; 2 catalog entries, 1 active skill, 1 session, 2 scripted model requests, 1 tool execution; offline |
| `git diff --check` | 0 | Final four-file source, test and report diff passed |

The parent independently repeated the focused filesystem test, `scripts/verify.py`,
Node self-tests, both offline examples, final JSON parsing, historical-content
preservation checks and `git diff --check`. Results matched the table. The parent
observed the six Cargo gates through `scripts/verify.py`, not as six additional
direct command invocations.

Three independent reviewers inspected the complete four-file repair diff. Review-a,
review-b and review-c each returned **PASS** with no blocking findings. Review-a
and review-b repeated the focused filesystem test and diff/report checks. Review-c
repeated the full offline gate set with 339 Rust tests, 152 Node self-tests and
both offline examples. No reviewer performed native macOS or Windows execution.

Both implementor full Rust passes had the same breakdown: lib **207**, bin **24**,
context_catalog **28**, context_prepare **26**, managed_absence_cli **1**,
provider_contract **5**, run_cli **4**, run_controller **33**, skills_cli **11**,
example harnesses **0**. All had zero failed, ignored or filtered tests. Each full
Cargo gate ran once directly and once through the required verification runner;
no failed local gate or retry occurred. Source inventory **113** reflects the
current organization, not a change made by this repair; the original **76** remains
historical evidence. Cross-platform totals are not forced to match Linux.

### MR disposition, changed paths and pending work

| ID | Disposition |
|---|---|
| MR-00 | Initial HEAD/clean tree and failed-run record verified; original report content, S1 behavior, organization and no-live boundary preserved. |
| MR-01 | Focused platform guard implemented; real Linux regression passed. Native macOS closure pending. |
| MR-02 | Equivalent Windows tail expression implemented without suppressions. Native Windows Clippy closure pending. |
| MR-03 | Required local offline commands passed. All three OS jobs on a submitted repair revision remain pending; skipped downstream gates are not presumed fixed. |
| MR-04 | This follow-up and the new top-level JSON `merge_readiness_follow_up` object retain revision-specific evidence. Three independent reviews passed with no blocking findings. Submitted-revision CI remains pending. |

Changed paths are only `src/context.rs`,
`tests/context_catalog/filesystem_safety.rs`,
`docs/WI_LOCAL_SKILLS_S1_VERIFICATION.md`, and
`docs/wi-local-skills-s1-verification.json`. The implementor inspected the focused
source diff; that inspection alone was not independent review or merge approval.
The later review-a, review-b and review-c results above independently passed the
complete diff. No staging, commits, pushes, merges, deployments, releases,
publication or hosted-service writes occurred. Changes remain unstaged and
uncommitted.

Live verification is **NOT RUN / not authorized**: **0** real provider requests or
generations, real credential/profile/auth/login/renewal operations, hosted API
probes/uploads, and owner global-skill/private-project content reads for tests.
Synthetic credentials, scripted providers and loopback tests remain offline;
read-only GitHub evidence retrieval is separate from Wi provider traffic. Pi's
authoring conversation is separate. Ledger: **31/50 used, 19 remaining,
changed=false, new allocation 0**.

S2/P1/V1, storage/service/UI work, resource execution, uploads, API-key fallback,
dependencies, feature additions and reorganization remain outside this increment.
Submitted-revision CI and native macOS/Windows closure require later authorized
work; this follow-up does not claim merge readiness.
