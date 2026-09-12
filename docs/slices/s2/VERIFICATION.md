# Wi S2 verification report

Contract: **s2.1**. Status: **OFFLINE_ACCEPTED**. Accepted: **true**.

All required offline execution gates passed on the accumulated, uncommitted S2
worktree. **All 24 matrix rows PASS.** Three fresh independent reviewers inspected
the complete accumulated implementation, tests, example, current documentation,
and both report drafts. All three returned PASS with no blocking findings.

Live model selection and adherence: **NOT RUN; not authorized**. Scripted providers
and loopbacks prove local loading and continuation, not a live model's choice or
compliance. See [verification.json](verification.json) for structured evidence.

## Tested revision and worktree

| Item | Observed value / attribution |
|---|---|
| Accepted runtime baseline | `94d86e0c9db62d9fec208a26f5b4bb2487bcb5fa`, PR #2 merge; acceptance supplied by the owner |
| Current audit-tested HEAD | `97ad00c109040edaf212fc141c34d307bc64442a` |
| Current revision meaning | HEAD contains the complete 25-path S2 implementation and original verification reports. The later consistency-audit report amendments are unstaged and are not represented by that SHA. |
| Original pre-commit gate basis | Uncommitted S2 worktree on planning HEAD `24aab8396303dac1de17284e0d4fbee4e5b3bc1a`; retained as historical execution evidence below |
| Original implementation start | Clean worktree, according to the supplied parent observation; not the reporting delegate's initial state |
| Reporting delegate's initial state | Dirty: 13 modified tracked files and 10 untracked implementation files; no staged changes |
| Original reporting increment | Created these two reports and updated only the S2 report links/state in `docs/README.md` |
| Original resulting inventory | 13 modified tracked files and 12 untracked files, including both reports; all were later committed in `97ad00c` |
| Pre-audit worktree | Clean with no untracked files at `97ad00c`; observed by the parent before the audit follow-up |
| Baseline ancestry | `94d86e0c9db62d9fec208a26f5b4bb2487bcb5fa` is an ancestor of current HEAD |

Before report edits, the delegate hashed all 182 tracked/untracked, nonignored
files except the three authorized report/index paths. Algorithm: SHA-256 over
lexically sorted UTF-8 path, NUL, file contents, NUL. Fingerprint:
`a1504c1c4866f2d9292f01f69d0447f5d761d40222b299be21ff3fc5fbfa446d`.
The report consistency check compares this fingerprint again. This identifies
preserved worktree content; it is not a commit or behavioral proof.

## Environment and isolation

Actual execution clock: **2026-09-11 UTC**, gates from
`21:54:21.084Z` through `21:55:23.027Z`. The governing documents use the prepared
date 2026-09-12; that date is not substituted for the observed local clock.

| Tool / platform | Actual observation |
|---|---|
| OS | openSUSE `20260902.0.0`, Linux `6.18.33.2-microsoft-standard-WSL2`, x86_64 |
| Kernel build | `#1 SMP PREEMPT_DYNAMIC Thu Jun 18 21:54:43 UTC 2026` |
| Rust | `rustc 1.98.1 (48a229cea 2026-09-01)`, host `x86_64-unknown-linux-gnu`, LLVM `22.1.8` |
| Cargo | `cargo 1.98.1 (797e8a9bc 2026-08-05)` |
| Toolchain | `stable-x86_64-unknown-linux-gnu`, selected by `rust-toolchain.toml` |
| Rustfmt / Clippy | `rustfmt 1.9.0-stable (48a229ceae 2026-09-01)` / `clippy 0.1.98 (48a229ceae 2026-09-01)` |
| uv / Python | `uv 0.12.10 (x86_64-unknown-linux-gnu)` / Python `3.14.6` through isolated `uv run python --version` |
| Node / Git | `v24.18.0` / `2.55.0` |

Each gate ran from the checkout through a temporary local Node wrapper,
`/tmp/wi-s2-final-k5UCVkK4/gate.mjs`. The wrapper passed the exact program/arguments
in the table below using `spawnSync`, inherited terminal output, and recorded
start/end timestamps and exit codes. It constructed an allowlisted environment,
not a copy of ambient credential/profile variables:

- `HOME`, `XDG_CONFIG_HOME`, `CODEX_HOME`, and `TMPDIR` point to separate synthetic
  directories under `/tmp/wi-s2-final-k5UCVkK4`, created with mode 0700.
- Trusted `PATH` and the original Cargo/Rustup/uv cache locations were preserved:
  `$ORIGINAL_HOME/.cargo`, `$ORIGINAL_HOME/.rustup`, `$ORIGINAL_HOME/.cache/uv`.
  These are trusted build-tool locations, not Wi credential or skill roots.
- `CARGO_NET_OFFLINE=true`, `UV_OFFLINE=true`, `UV_PYTHON_DOWNLOADS=never`,
  `GIT_OPTIONAL_LOCKS=0`, and `LANG=LC_ALL=C.UTF-8` applied to every gate.
- Tests/examples create their own synthetic workspace, skill, and credential
  fixtures under the temporary roots. Provider protocol tests use independent
  scripts or literal loopback servers. Build/source inspection of this checkout
  is distinct from using private owner projects or skills as test context.
- No real credential/private owner skill/project reads, real auth/profile/login/
  refresh operations, live provider requests, hosted probes, or uploads occurred.
  Existing synthetic auth regressions are not real account operations.
- No dependency download, dependency/lock change, runtime budget, quota, or timer
  was added. Test watchdogs and finite fixtures are not product run limits.

These privacy/traffic statements describe the controlled commands, fixture
boundaries and inspected source. They are not a kernel-level I/O audit.

## Evidence attribution and baseline comparison

**D** means this reporting delegate's actual local execution. **S** means this
delegate's source inspection, mapped to tests executed by D in the complete suite.
**P** means the owner-supplied parent/prior-delegate summary, not a new execution
by this delegate. Named tests below were executed as part of the full suite, not
as additional individually filtered commands. Loop variations are assertions
inside tests, not additional test-count entries.

The supplied **pre-edit parent baseline** passed all six Cargo gates with **339
Rust tests**, verify inventory **113 source files / 326 Rust test definitions /
25 fixture events**, **152 Node self-tests**, `live_started=false`, `run_offline`
Completed **50**, `skills_offline` Completed **42**, and `git diff --check`.
This is attributed baseline comparison only, not S2 acceptance. Exact baseline
per-command timestamps, exit codes and detailed filtered counts were not supplied;
this report does not invent them or relabel baseline execution as D.

The accepted S1 report and its dated MR follow-up retain their original evidence
and pending-at-that-time CI wording. The owner supplies the separate later S1
repair/merge acceptance at the baseline above. This delegate did not retrieve
hosted CI records or rerun the historical baseline. See
[accepted S1 evidence](../../WI_LOCAL_SKILLS_S1_VERIFICATION.md) and
[its machine report](../../wi-local-skills-s1-verification.json).

## Source changes and compatibility

Preserved implementation adds `LoadedSkill`, `load_skill` and the private
catalog-bound ordinary tool (`src/context/skill_loading.rs:13-177`). Both
preparation paths share the loader, validate all selected IDs before file I/O,
and retain explicit selection order (`src/context/preparation.rs:104-184`).
The shared reader still uses `SkillSource::open` and the existing 1 MiB guard
(`src/context/preparation.rs:206-216`).

Normal `wi run` calls the paired helper before provider construction and preserves
discovery diagnostics on preparation failure (`src/cli/run_cli.rs:112-123`). A
nonempty catalog exposes one `load_skill` without a flag. Empty catalogs and direct
S1 `prepare_run` retain no-loader behavior. The manifest records initial bodies,
not subsequent result delivery. Tests, both transport loopbacks, the offline
example, and current README/architecture/events/help document this behavior.

Source/diff inspection found no change to `src/error.rs`, existing ToolFailed
regression expectations, ToolRegistry/cache behavior, run orchestration, provider
production behavior, auth, event schemas, dependencies or lockfile. ToolFailed
still maps to `gateway_error`; there is no `tool_failed` category or fabricated
`Ok` error-shaped result. Bad arguments fail preflight; executed read failures
produce correlated errors with `is_error=true` on the existing finish event.
A whole file above 1 MiB fails loading first. A successfully loaded value above
64 KiB serialized JSON produces `tool_output_limit`; exactly 64 KiB is permitted.
No truncated success or new body cache exists.

C1 deletion is preserved: no RunLimits, count quotas, whole-run timers, optional
replacement budgets, or withdrawn M4 timeout/progress feature. Run ownership,
cancellation, correlation, validated recovery, ordering/reuse, authentication,
and WebSocket/SSE continuation remain. Run schema **2**, provider schema **1**,
and the three-field RunRequest remain unchanged. Production-provider
restructuring remains **DEFERRED**.

## Exact commands and results

Observer: **D** for every row. All exact commands below ran once directly with
the isolation wrapper described above. **Every exit code was 0.** No gate failed
and no failure-triggered retry occurred in this increment.

| ID | Exact command | Exit | Actual result |
|---|---|---:|---|
| C01 | `cargo fmt --all -- --check` | 0 | PASS |
| C02 | `cargo check --all-targets` | 0 | PASS |
| C03 | `cargo test --all-targets` | 0 | 374 passed; 0 failed, ignored, measured, filtered |
| C04 | `cargo clippy --all-targets -- -D warnings` | 0 | PASS on Linux |
| C05 | `cargo build --all-targets` | 0 | PASS |
| C06 | `cargo test --doc` | 0 | 0 doctests; no additional coverage |
| C07 | `uv run scripts/verify.py` | 0 | Inventory 123 / 361 / 25; all six internal Cargo gates passed again |
| C08 | `node scripts/cli_retest.mjs --self-test` | 0 | `self_test=passed`, tests=152, `live_started=false` |
| C09 | `cargo run --example run_offline` | 0 | `Completed: 50 (1 session, 3 model requests, 2 tool executions; offline)` |
| C10 | `cargo run --example skills_offline` | 0 | `Completed: 42 (2 catalog entries, 1 active skill, 1 session, 2 model requests, 1 tool execution; offline)` |
| C11 | `cargo run --example skill_loading_offline` | 0 | `Completed: Reviewed offline. (1 session, 2 model requests, 1 tool execution; offline)` |
| C12 | `git diff --check` | 0 | PASS before report/index edits |

C07 invokes the same six Cargo commands in C01-C06 order
(`scripts/verify.py:53-66`). These are **internal required repetitions**, not six
more direct commands or distinct coverage. Each internal gate succeeded; the
runner stops at the first nonzero exit and returned 0. Internal tests again passed
374, with zero failed/ignored/measured/filtered and zero doctests.

| Cargo target | C03 passed | C07 internal passed |
|---|---:|---:|
| lib | 213 | 213 |
| bin wi | 27 | 27 |
| context_catalog | 28 | 28 |
| context_prepare | 26 | 26 |
| managed_absence_cli | 1 | 1 |
| provider_contract | 5 | 5 |
| run_cli | 5 | 5 |
| run_controller | 38 | 38 |
| skill_loading | 20 | 20 |
| skills_cli | 11 | 11 |
| Four example test harnesses | 0 | 0 |
| **Total per full execution** | **374** | **374** |

All targets report zero failures, ignored, measured and filtered tests. The four
zero-test example harnesses are run_offline, skills_offline, skill_loading_offline,
and two_turns; compiling/testing the last harness does not run its live example
main. Only C09-C11 execute example mains. Static definitions **361** differ from
executed summaries **374**; no rerun or fixture-loop inflation is applied. The
increase over the supplied 339 baseline is 35, not a fixed count requirement.

Report consistency / preservation check: **PASS**, exit **0**, observed by D at
`2026-09-11T22:10:12.896Z` using
`node /tmp/wi-s2-final-k5UCVkK4/report-check.mjs` through the same isolation wrapper.
The check validates JSON, exactly 24 unique IDs and matching Markdown statuses,
named source assertions/ranges, command/count consistency, pending-review/CI
attribution, zero-live fields/ledger, report links, HEAD/index/dirty inventory,
the unchanged 182-file fingerprint, protected baseline paths, static inventory,
and report/index whitespace. These are report checks, not extra Rust tests.

Post-draft `git diff --check`: **PASS**, exit **0**, observed by D at
`2026-09-11T22:10:12.987Z`, after report/index creation and before this factual
validation-status update. This is the second diff-check execution, justified by
the new report/index edits, not a failed-gate retry. Final status edits receive
the same read-only consistency/whitespace check without another runtime suite.

## Matrix: 24 distinct rows

Unless marked otherwise, observer is **D + S**: inspected named assertions and
actual passing C03/C07 suite execution. Each PASS is Linux offline technical
evidence within the limits below. Only S2-23 has a blocker.

| ID | Status | Exact named tests / source | Actual evidence and assertions | Blockers |
|---|---|---|---|---|
| S2-00 | PASS | P baseline above; D HEAD/status/ancestry, protected-path diff and fingerprint checks | Correct s2.1, accepted baseline and dirty implementation distinguished. Prior clean/baseline history is P, not D. Governing/current docs, S1/MR evidence and verifier inspected. C01-C12 passed without real data or Git writes. | None |
| S2-01 | PASS | `shared_loader_preserves_scoped_identity_frontmatter_and_owned_body`, `all_selected_ids_precede_project_and_body_io_and_keep_error_order` (`tests/skill_loading/loading.rs:8-119`) | Shared global/project loader preserves metadata/body and S1 explicit output. All identities precede AGENTS.md/body reads; later invalid/unknown ID wins over earlier missing file. All 26 S1 preparation tests also pass. | None |
| S2-02 | PASS | `shared_loader_preserves_scoped_identity_frontmatter_and_owned_body`, `directly_constructed_invalid_ids_and_unknown_ids_never_select_paths` (`tests/skill_loading/loading.rs:8-84`); `direct_validation_is_strict_pure_and_execute_defends_itself` (`src/context/skill_loading/tests.rs:126-192`) | Same-name scopes return their own bodies. Directory mismatch does not redefine identity. Constructed invalid IDs, bare/path/URL/unknown IDs cannot select another source. | None |
| S2-03 | PASS | `registered_definition_and_lazy_success_are_exact_and_correlated` (`tests/skill_loading/registry.rs:5-39`); `direct_validation_is_strict_pure_and_execute_defends_itself` (`src/context/skill_loading/tests.rs:126-192`) | Exact strict ordinary definition, one required string id, no extra fields/catalog enum/paths/body. Both validate and direct execute reject malformed arguments as InvalidToolArguments. | None |
| S2-04 | PASS | `invalid_load_or_unsupported_authority_rejects_whole_batch_without_execution` (`tests/skill_loading/registry.rs:42-139`); `direct_validation_is_strict_pure_and_execute_defends_itself` (`src/context/skill_loading/tests.rs:126-192`) | Validation still succeeds for a known removed source. Invalid mixed batches emit no events or dispatch/cache/reuse; caller/namespace/incomplete/duplicate protections hold. A later valid batch actually executes and returns a correlated read error. | None |
| S2-05 | PASS | `registered_definition_and_lazy_success_are_exact_and_correlated` (`tests/skill_loading/registry.rs:5-39`) | Actual registry load returns exactly id/frontmatter/body, unchanged Markdown/CRLF/whitespace, sorted nested objects and preserved arrays; call_id and success start/finish events match. No fabricated acceptance result. | None |
| S2-06 | PASS | `known_load_failures_are_sanitized_correlated_error_results` (`tests/skill_loading/boundaries.rs:8-61`); `missing_or_directory_manifest_fails_only_when_executed` (`tests/skill_loading/filesystem.rs:5-34`); `worker_join_failure_uses_existing_tool_failed_mapping_and_error_event` (`src/context/skill_loading/tests.rs:195-222`) | Public ContextError categories, direct ToolFailed and registry gateway_error are distinct. Changed/corrupt/non-UTF-8 metadata, empty/non-UTF-8/oversized body, missing/directory/denied source and synthetic worker panic covered. Exact error JSON has no is_error; finish does. Static Debug/errors redact content and host paths. Direct mapping also covered by S2-03; denied source by S2-09. | None |
| S2-07 | PASS | `new_calls_reread_bodies_cached_calls_reuse_and_fresh_scopes_stay_independent` (`tests/skill_loading/registry.rs:142-224`); `paired_preparation_keeps_metadata_explicit_order_and_truthful_framing` (`tests/skill_loading/preparation.rs:6-119`) | Body-only edits before a new call are visible; returned bytes survive edit/deletion. Distinct call reads again; added entry remains unknown to the captured catalog. No implicit refresh. | None |
| S2-08 | PASS | `new_calls_reread_bodies_cached_calls_reuse_and_fresh_scopes_stay_independent` (`tests/skill_loading/registry.rs:142-224`); `exactly_64_kib_is_allowed_escape_overhead_counts_and_output_errors_are_reused` (`tests/skill_loading/boundaries.rs:96-150`) | Same call reuses exact success/gateway_error/tool_output_limit after source changes, with only ToolResultReused and no is_error field. Conflicting tool/arguments reject; fresh scopes read independently without a body cache. | None |
| S2-09 | PASS | `manifest_and_ancestor_replacement_links_and_denied_sources_fail_closed`, `canonical_selected_roots_cannot_be_redirected_by_replacing_root_aliases`, `fifo_and_device_link_manifests_are_not_read` (`tests/skill_loading/filesystem.rs:60-234`); `context_catalog_non_utf8_traversal_names_fail_without_lossy_labels` (`tests/context_catalog/filesystem_safety.rs:256-274`) | Linux actual tests retain selected-root/no-follow/regular-file checks, replacement-link rejection, denied sources and real malformed-byte fixture. Windows reparse handling is unchanged source only; native Windows/macOS are unrun. No hardlink/ancestor-race sandbox claim. | None within local scope |
| S2-10 | PASS | `resource_commands_urls_and_allowed_tools_remain_inert_instruction_data` (`tests/skill_loading/filesystem.rs:148-195`) | Actual load succeeds with denied resource directories; output contains main body only, no resource/script canaries, no execution marker, unchanged definitions and no connection to the synthetic listener. Source uses only the recorded main file; no arbitrary resource/process/network path. | None |
| S2-11 | PASS | `helper_retains_ordinary_definitions_without_sharing_template_results` (`tests/skill_loading/registry.rs:227-267`); `collision_and_all_id_validation_precede_file_io`, `automatic_definition_and_framing_use_existing_configuration_limits` (`tests/skill_loading/preparation.rs:174-290`) | Same catalog pairs preparation/loader; ordinary tools and template cache remain intact. Collision fails before I/O; actual definitions participate in existing limits; caller tools reject and returned options.tools is empty. Run-owned scope is observed through events, not the template cache. | None |
| S2-12 | PASS | `empty_catalog_keeps_no_context_bytes_and_project_only_semantics` (`tests/skill_loading/preparation.rs:122-171`); `run_cli_prepared_catalog_and_explicit_bodies_reach_existing_controller`, `run_cli_empty_catalog_preserves_project_context_without_loader_claim` (`src/cli/run_cli_context_tests.rs:98-235,392-425`) | Global-only and combined catalogs expose loader without enable flags/selections. Empty catalogs preserve unrelated tools/project instructions and no-context bytes, without false loader framing. Legacy behavior remains. | None |
| S2-13 | PASS | `paired_preparation_keeps_metadata_explicit_order_and_truthful_framing` (`tests/skill_loading/preparation.rs:6-119`) | Exact caller prefix/task, four fields, all metadata, only explicit bodies, escaped injection-shaped task, truthful suffix and legacy no-loader framing. No caller substring replacement or body promotion. | None |
| S2-14 | PASS | `paired_preparation_keeps_metadata_explicit_order_and_truthful_framing` (`tests/skill_loading/preparation.rs:6-119`); `skill_loading_public_run_delivers_real_body_with_explicit_selections_or_without` (`tests/run_support/skill_loading.rs:172-235`) | Selection order/deduplication retained; second and already-active skills can load. Manifest remains initial provenance after actual registry/public-controller execution. Scripted provider exercises empty/global/project initial selections. | None |
| S2-15 | PASS | `whole_file_limit_precedes_serialized_output_limit_without_truncation`, `exactly_64_kib_is_allowed_escape_overhead_counts_and_output_errors_are_reused` (`tests/skill_loading/boundaries.rs:64-150`) | Exactly 1 MiB file loads but exceeds result capacity; one more file byte fails InputTooLarge/gateway_error. Exactly 64 KiB serialized success and one-byte-over tool_output_limit, including escapes, are actual registry outputs. Combined input validation rejects oversized aggregate; no truncation/budget change. | None |
| S2-16 | PASS | `skill_loading_public_run_delivers_real_body_with_explicit_selections_or_without` (`tests/run_support/skill_loading.rs:89-235`) | Independent scripted Provider receives metadata and real definition, then actual correlated body from returned registry through public run(). One session/two requests/final fixture response; unchanged caller options and schema correlation. No OpenAI-only loop. | None |
| S2-17 | PASS | `skill_loading_public_run_loads_workflow_then_adds_in_three_requests`, `skill_loading_public_run_can_complete_without_loading` (`tests/run_support/skill_loading.rs:238-334`) | One session: load workflow, add_numbers, final 42; exact ordered inputs/tool events. Separate one-request final response dispatches no tool even after main files are deleted. Fixture operands stay outside loader/controller production code. | None |
| S2-18 | PASS | `skill_loading_websocket_uses_one_session_parent_and_only_correlated_result`, `skill_loading_sse_replays_exact_prepared_context_native_call_and_result` (`src/providers/openai_codex/tests/context_integration/context_loopback_tests.rs:88-156`); `assert_skill_first`, `assert_skill_second`, `assert_skill_success` (`src/providers/openai_codex/tests/harness/context.rs:213-322`) | Actual loopbacks: WS one socket/parent/new result only; SSE exact complete effective native history, including opaque item and result. Both native/recovered cases; SSE explicit/missing MIME variants. Exactly two requests, no extra classifier/reopen; synthetic auth only. These two named tests contain six fixture variations, not six extra test entries. | None |
| S2-19 | PASS | `pending_blocking_load_cancel_or_waiter_drop_cannot_publish_or_cache`, `cancellation_and_sink_failure_keep_completed_cache_and_stop_later_loads` (`src/context/skill_loading/tests.rs:237-415`); `skill_loading_public_run_cancels_before_dispatch_or_before_later_call`, `skill_loading_public_run_observer_failure_stops_later_work_and_delivery` (`tests/run_support/skill_loading.rs:337-505`) | Deterministic worker barriers prove pending cancel/drop yields no finish/cache; released abandoned worker cannot publish. Before/start/after-load cancellation stops later work. Finish-observer failure keeps completed cache, stops delivery/later calls; Full/Closed/Failed sinks retain controller ordering. No runtime timeout added. | None |
| S2-20 | PASS | `run_cli_context_errors_and_final_validation_precede_all_constructors`, `run_cli_diagnostics_are_delivered_before_construction_and_not_to_ndjson`, `run_cli_unselected_body_is_not_validated_before_provider_construction`, `run_cli_diagnostic_sink_failure_precedes_preparation_error_and_factory` (`src/cli/run_cli_context_tests.rs:238-468`); `run_binary_explicit_selections_and_tools_preserve_preparation_diagnostics` (`tests/cli/run_cli.rs:115-190`); `skills_binary_both_global_routes_project_addition_and_metadata_only_output` (`tests/cli/skills_cli.rs:103-168`) | Real handler uses injected synthetic factory and shared pair; process tests preserve explicit tools/selections and parsing. Diagnostics survive preparation failure, precede factory and stay outside NDJSON. Listing stays metadata-only. C11 supplies non-CLI integration without a subprocess backend. | None |
| S2-21 | PASS | `concurrent_same_id_workspaces_keep_sources_results_and_catalogs_separate` (`tests/skill_loading/boundaries.rs:153-195`); `shared_loader_preserves_scoped_identity_frontmatter_and_owned_body` (`tests/skill_loading/loading.rs:8-46`); `direct_validation_is_strict_pure_and_execute_defends_itself` (`src/context/skill_loading/tests.rs:126-192`); `assert_completed_session` (`tests/run_support/skill_loading.rs:119-156`) | Concurrent project IDs return only their own source; fresh-scope/error reuse covered by S2-08/11. Debug omits bodies/paths. Actual envelopes preserve schema 2/1. Protected production and existing error regressions unchanged; full retained C1/auth/recovery suites pass. | None |
| S2-22 | PASS | C11; `Control::generate`, `main` (`examples/skill_loading_offline.rs:35-111,164-282`); current README/architecture/events/help/index inspection | Real helper/registry/run example proves initial body absence, exact follow-up body, one successful load and final Reviewed offline. Current docs cover automatic/explicit paths, manifest/read/cache semantics, result limit and main-file-only boundary. Report files exist and the index links both accepted reports. | None |
| S2-23 | PASS | D C01-C12 and report checks; P increment review history; final review-a/review-b/review-c | All required technical gates passed. Three fresh independent reviewers inspected the entire accumulated implementation plus reports/index and returned PASS with no blocking findings. Review-a and review-b independently repeated the 374-test full suite; review-c repeated the complete required offline gate set with matching counts. Native/current submitted CI and live checks remain separately unrun. | None |

## First failures, fixes and increment reviews

Observer for prior history: **P**, supplied by the owner. This delegate inspected
the resulting tree and executed the final gates, but did not rerun earlier failed
attempts or inspect private delegate logs.

| Stage | Reported history and disposition |
|---|---|
| s2.0 conflict | Correct `assignment_conflict`: designer incorrectly specified tool_failed while prohibiting production error changes. s2.1 corrects the requirement to gateway_error. Not an implementation failure; no production mapping repair was made. |
| Increment 1 | Core loader/helper: reported 363 Rust tests and three independent PASS reviews. |
| Increment 2 | CLI and independent public-controller scripted-provider tests: three independent PASS reviews. An initially wrong test-only relative diagnostic label was corrected before focused gates passed. Exact failed command/exit/timestamp was not supplied; no value is invented. |
| Increment 3 | Transport loopbacks, example and current docs: reported 374 Rust tests, requested checks passing, and three independent PASS reviews without blocking findings. |
| Interrupted authoring attempt | One prior delegate exhausted its attempt budget after partial edits. Owner-directed continuation completed/audited them. This is workflow history, not an implementation test failure. |
| Nonblocking notes | Brittle Arc strong_count assertion (`tests/skill_loading/preparation.rs:34`), redundant CODEX_HOME env_remove in one process test, minor docs wording ambiguities. Supplied reviews required no remediation. These are not silently promoted to blocking defects. |
| This reporting increment | No source/test/example edits, failed runtime gates, or failure-triggered reruns. C07's internal repeats are mandatory verification, not recovery attempts. |
| Final accumulated review | **PASS.** Parent-launched review-a, review-b and review-c independently inspected the complete implementation, tests, example, current docs, reports and index. All returned PASS with no blocking findings. Review-a reran all 374 Rust tests and diff/fingerprint checks. Review-b reran the 20-test focused target, all 374 tests, the loading example, static inventory and diff/JSON checks. Review-c reran the complete required offline gate set with matching 374/152/123/361/25 results and all three examples. Reviewer setup mistakes before two successful reruns were not product failures. |

Precise identities and timestamps for the nine earlier increment reviews were not
supplied, so they remain attributed history. The final reviewers are identified by
role as review-a, review-b and review-c. Their fresh accumulated review closes
S2-23 without changing the separate native CI or live-evidence status.

## Platform and CI status

| Platform / evidence | Status |
|---|---|
| Local Linux x86_64 / WSL2 | Actual C01-C12 execution PASS within this offline acceptance scope |
| Native macOS | NOT RUN by this delegate; no cross-compilation or native pass claimed |
| Native Windows | NOT RUN by this delegate; Linux Clippy does not check Windows-only code |
| Current S2 submitted-revision CI | NOT SUBMITTED / NOT RUN; implementation is uncommitted and no Git/hosted writes are authorized |
| Configured workflow | Source inspection only: `.github/workflows/ci.yml:1-24` retains ubuntu-latest, windows-latest, macos-latest and all six Cargo gates, including warning-denied Clippy |
| Accepted S1 CI/merge | Separate owner-supplied historical acceptance; not current S2 CI evidence |

Rust's Linux summaries report no ignored or filtered tests. Compile-time platform
exclusions are not listed by those summaries, so the aggregate excluded count is
**unmeasured**, not zero. Source inspection confirms the MR malformed-byte fixture
remains Linux-only (`tests/context_catalog/filesystem_safety.rs:256-274`), S2's
FIFO/device-link fixture is Linux-only, and three S2 filesystem tests remain Unix
(`tests/skill_loading/filesystem.rs:36-234`). Applicable Unix coverage is not
removed from macOS. Windows reparse/junction logic remains preserved but unexecuted
here. No I/O failure is caught and relabelled PASS. Local Linux success does not
equal native macOS/Windows or submitted-revision CI success.

## Changed paths and preservation

**This increment only:**

- `docs/slices/s2/VERIFICATION.md` (new report)
- `docs/slices/s2/verification.json` (new report)
- `docs/README.md` (existing changes preserved; report links/state updated)

**Preserved modified tracked paths from increments 1-3:**

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/EVENTS.md`
- `docs/README.md`
- `src/cli/run_cli.rs`
- `src/cli/run_cli_context_tests.rs`
- `src/context.rs`
- `src/context/preparation.rs`
- `src/providers/openai_codex/tests/context_integration/context_loopback_tests.rs`
- `src/providers/openai_codex/tests/harness/context.rs`
- `tests/cli/run_cli.rs`
- `tests/cli/skills_cli.rs`
- `tests/run_controller.rs`

**Preserved new implementation paths:**

- `examples/skill_loading_offline.rs`
- `src/context/skill_loading.rs`
- `src/context/skill_loading/tests.rs`
- `tests/run_support/skill_loading.rs`
- `tests/skill_loading.rs`
- `tests/skill_loading/boundaries.rs`
- `tests/skill_loading/filesystem.rs`
- `tests/skill_loading/loading.rs`
- `tests/skill_loading/preparation.rs`
- `tests/skill_loading/registry.rs`

Historical contracts, matrices, reports, PLAN ONLY text, dependencies and lockfile
remain unchanged. Temporary gate/report-check helpers are outside the repository;
no permanent verification framework or source reorganization is added.

## Remaining limits, deferred scope and authorization

- Only catalog main SKILL.md instructions load. Supporting files/references/assets,
  scripts, generic readers, coding tools, network execution, hosted skills/uploads,
  provider-native search, PTC, async tools, steering and permissions remain excluded
  or separately deferred. Loading does not perform a workflow.
- Catalogs fix metadata/source selection. New executions reread/revalidate; cached
  call IDs reuse results. Owned returned bytes persist in history. No body cache,
  watcher, automatic rescan, retry, reconnect or account/billing fallback is added.
- Existing 1 MiB file/input and 64 KiB tool-result guards remain; JSON overhead
  counts. Some S1-explicit bodies exceed tool-result capacity. Complete next-input
  validation still applies. No paging, quota or universal memory bound is claimed.
- Trusted-owner filesystem limitations include hardlinks and ancestor races.
  Buffered metadata reads may read ahead. JSON framing is not prompt-injection
  immunity; explicit metadata/body/provider output remains sensitive data.
- Blocking I/O may finish after cancellation of its waiter. It cannot publish a
  result after that drop. Finish-observer failure cannot undo an already cached
  completed operation. No forced kernel-I/O termination is promised.
- P1 persistent application sessions/history and V1 one-owner, multi-device service
  remain deferred. Browser disconnect must not cancel service-owned work; restart
  stops tasks without automatic resume/replay. Storage must precede service
  acceptance. No storage interface/database/session owner/server/UI is implemented.
  `service_implemented=false`, `storage_implemented=false`, `ui_implemented=false`.
- Final accumulated review passed with no blocking findings. Native macOS/Windows
  and current submitted CI remain unrun. Live model choice/adherence has no proof
  and remains NOT RUN.

The original reporting phase used scoped report/index changes and offline synthetic
verification only. The owner later separately authorized staging and commit
`97ad00c109040edaf212fc141c34d307bc64442a`. The pre-push audit made only unstaged
report amendments. **No push, merge, deployment, release, publication or hosted-
service write occurred.** No reset, clean, stash, overwrite of owner work, revert,
or unauthorized Git write occurred. Pi review work did not create Wi provider
traffic or change the ledger.

`live_started=false`, `real_credential_reads=0`, `provider_generations=0`.
Real owner skills/projects/auth/profile/login/refresh/provider/hosted operations
remain zero. Pi authoring traffic is separate from Wi verification.

Ledger: **31/50 used, 19 remaining, changed=false; new allocation 0**.
Remaining balance is not authorization. Offline technical acceptance is complete;
Git submission, native CI, and live verification remain separate and unauthorized
or unrun as stated above.

## Pre-push repository-consistency audit follow-up — 2026-09-12

Audit source: [PR #3 issue comment 5640780593](https://github.com/zer09/wi/pull/3#issuecomment-5640780593).
The designer reviewed baseline `94d86e0c` and planning head `24aab839`; the reviewer
could not see the local S2 implementation. The parent retrieved the complete comment
with authenticated read-only `gh api` and compared it with current local commit
`97ad00c109040edaf212fc141c34d307bc64442a`. The pre-audit worktree was clean and
had no untracked implementation files. The 25 implementation/report paths are all
represented by that commit. No hosted mutation occurred.

### A-01 through A-05 disposition

All five findings are **corroborated, inherited, open, and not S2 blockers**. No
counterexample regression or repair was added because the audit did not authorize
unrelated cleanup. None makes s2.1 unsatisfiable. A path-limited baseline-to-HEAD
diff is empty for every cited production path except `src/cli/run_cli.rs`; its S2
hunks change loader preparation and help only, not `render`.

| ID | Status and current source evidence | S2 impact | Repair evidence |
|---|---|---|---|
| A-01 | **OPEN_INHERITED_CORROBORATED (medium).** Legacy `collect` passes streamed deltas, terminal suffixes and fallback text to byte-preserving `write_text` (`src/cli/mod.rs:156-209`). Unsupported terminal controls therefore reach plain `generate`/`tool-demo`. | `src/cli/mod.rs` is byte-identical to baseline. S2 does not use or modify this legacy renderer. Not introduced or worsened. | NOT RUN; no approved fix or focused control-sequence regression. |
| A-02 | **OPEN_INHERITED_CORROBORATED (medium).** `context_cli::filtered` removes every Unicode control (`src/cli/context_cli.rs:66-68`); `run_cli::render` applies it to deltas and final text (`src/cli/run_cli.rs:150-185`), so LF/tab formatting collapses with unsafe controls. | `src/cli/run_cli.rs` changed for help and preparation/registry pairing only. The render body and shared filter are unchanged. S2 can produce ordinary model text but does not introduce or worsen the presentation rule. | NOT RUN; existing control filtering test does not prove multiline/code-block preservation. |
| A-03 | **OPEN_INHERITED_CORROBORATED (low/medium).** Legacy `generate` calls `open` before its first `SessionControl::generate`, where input validation occurs (`src/cli/mod.rs:145-150,210-264`; `src/providers/openai_codex/session.rs:54-72`). Invalid prompt validation can therefore follow credential/provider/session work. | Legacy CLI and provider/session paths are unchanged. S2 `wi run` validates prompt/options at `src/cli/run_cli.rs:60-106` before discovery, diagnostics and provider construction. Not introduced or worsened. | NOT RUN; no approved legacy-ordering repair or new injected-counter regression. |
| A-04 | **OPEN_INHERITED_CORROBORATED (low).** `AuthExpired` still says the gateway never rotates refresh tokens (`src/error.rs:35-38`), while managed credentials renew in `ManagedCredentials::prepare` (`src/providers/openai_codex/managed_auth.rs:207-263`). Exported code remains `auth_expired` (`src/error.rs:102-124`). | Error/auth/managed-auth files are byte-identical to baseline. S2 does not alter authentication or error categories. Not introduced or worsened. | NOT RUN; no wording change or auth regression was authorized. |
| A-05 | **OPEN_INHERITED_CORROBORATED (medium).** Decoder `required_str` checks type but not nonempty identity. `ResponseDecoder::apply` and `parse_response` can produce and settle a terminal-only completed response with `id:""` (`src/providers/openai_codex/codec.rs:24-165,239-324`; `session.rs:321-378`), while `run::Collector::observe` rejects empty IDs (`src/run/collect.rs:13-60`). Strict missing-Content-Type SSE admission is a separate earlier check. | Codec, consistency, state, wire, run collector and production provider files are byte-identical to baseline. Normal S2 runs still pass through the rejecting collector; loopbacks use valid IDs. Not introduced or worsened. | NOT RUN; no approved decoder/loopback empty-ID regression or fix. |

The audit's additional README wording, stale Node diagnostic literal, workflow
coverage and static-inventory notes are also inherited review notes. S2 did not
change `scripts/cli_retest.mjs` or `.github/workflows/ci.yml`; local examples,
Node self-tests, verifier output and hosted CI remain separately attributed.
No claim marks those notes fixed.

### S2 producer-to-consumer corroboration

| Required path | Actual production path | Executed regression evidence |
|---|---|---|
| Loader failure to correlated error/event | `load_skill` returns `ContextError`; `SkillLoader::execute` maps load/join failure to `ToolFailed` (`src/context/skill_loading.rs:128-177`); registry converts `error.code()` to JSON, caches it, emits finish `is_error=true`, then returns correlated `InputItem::ToolResult` (`src/tools.rs:181-248`). `GatewayError::code()` leaves ToolFailed on wildcard `gateway_error` (`src/error.rs:102-124`). `run::prepare_tools` sends that real result into the next ordinary turn (`src/run/mod.rs:238-295,341-401`). | `known_load_failures_are_sanitized_correlated_error_results`; `worker_join_failure_uses_existing_tool_failed_mapping_and_error_event`; public scripted-provider and loopback continuations. |
| Mixed-batch preflight | `ToolRegistry::preflight` validates the entire response and every tool argument before it returns `PreparedBatch`; execution starts only afterward (`src/tools.rs:104-181`). | `invalid_load_or_unsupported_authority_rejects_whole_batch_without_execution` asserts mixed `add_numbers`/bad-load rejection with no execution, event or cache result. |
| Metadata identity and read timing | Catalog lookup selects only the captured entry. Each new `load_skill` read reparses frontmatter and compares it before decoding/returning the owned body (`src/context/skill_loading.rs:51-72,157-177`). | `shared_loader_preserves_scoped_identity_frontmatter_and_owned_body`; `all_selected_ids_precede_project_and_body_io_and_keep_error_order`; changed/corrupt metadata cases in `known_load_failures_are_sanitized_correlated_error_results`. |
| Cache-before-finish and reuse | Registry inserts the serialized success/error result at `src/tools.rs:224-231` before emitting finish at `:232-236`; exact same call ID/arguments returns saved output and emits only reuse at `:190-199`. | `new_calls_reread_bodies_cached_calls_reuse_and_fresh_scopes_stay_independent`; `exactly_64_kib_is_allowed_escape_overhead_counts_and_output_errors_are_reused`; `cancellation_and_sink_failure_keep_completed_cache_and_stop_later_loads`. |
| Cancellation | Run checkpoints and biased cancellation surround generate/preflight/each execution/result validation (`src/run/mod.rs:71-90,238-295,341-401`). A dropped pending loader future cannot insert or emit because registry mutation occurs only after awaited execution returns. | Deterministic `pending_blocking_load_cancel_or_waiter_drop_cannot_publish_or_cache` plus public-run cancellation and observer-failure tests. |
| Catalog/registry pairing | Helper clones one caller `Arc<SkillCatalog>` into the loader and uses the same catalog for composition, returning a fresh registration scope (`src/context/preparation.rs:104-121`). Public `run` takes a new result scope while preserving registrations. | `helper_retains_ordinary_definitions_without_sharing_template_results`; `paired_preparation_keeps_metadata_explicit_order_and_truthful_framing`; concurrent same-ID workspace test; scripted provider and both transport loopbacks. |
| Diagnostic delivery before construction | CLI captures diagnostics before preparation, returns both without an early preparation `?`, emits notices, unwraps preparation, then calls provider/auth factory (`src/cli/run_cli.rs:107-127`). | `run_cli_diagnostics_are_delivered_before_construction_and_not_to_ndjson`; `run_cli_diagnostic_sink_failure_precedes_preparation_error_and_factory`; process-level auth-precedence tests. |

This is path verification, not a fabricated expected-JSON review: the named tests
exercise the actual registry and public controller. Direct tool tests separately
prove the intermediate `ToolFailed` variant. The source trace confirms preflight
errors never become correlated execution results, file-size and serialization-size
failures occur at different stages, and no production error category changed.

### Fresh post-audit offline gates

Parent-observed execution used synthetic `/tmp/wi-s2-audit-final` HOME,
XDG_CONFIG_HOME, CODEX_HOME and TMPDIR, trusted Cargo/Rustup/uv caches, an allowlisted
`env -i`, `CARGO_NET_OFFLINE=true`, `UV_OFFLINE=true`, and
`UV_PYTHON_DOWNLOADS=never`. Platform/toolchain at completion: Linux
`6.18.33.2-microsoft-standard-WSL2` x86_64; rustc/cargo 1.98.1; uv 0.12.10;
Node v24.18.0; Git 2.55.0. Completion observation: `2026-09-12T05:55:35Z`.

All required commands exited 0: format, check, **374 Rust tests**, warning-denied
Clippy, build, zero doctests, `uv run scripts/verify.py` with inventory
**123 source files / 361 Rust test definitions / 25 fixture events** and its six
internal Cargo gates, **152 Node self-tests** with `live_started=false`, all three
offline examples (50, 42, and Reviewed offline), and `git diff --check`. No gate
failed or required a retry. This repeats unchanged S2 runtime evidence after reading
the audit; it does not execute A-01 through A-05 counterexample regressions.

### Follow-up independent complete-diff review

**PASS.** Three fresh parent-launched reviewers independently inspected
`94d86e0c..97ad00c`, both unstaged report amendments, the complete worktree and the
seven required producer-to-consumer paths. Each returned PASS with no blocking
findings:

- review-a corroborated all five inherited classifications and all seven paths,
  then independently ran all 374 Rust tests and `git diff --check` successfully;
- review-b corroborated the complete diff, source paths, report JSON and audit
  comment with focused read-only checks; and
- review-c independently reran the complete isolated offline set with matching
  374/152/123/361/25 results and all three examples.

The review confirms A-01 through A-05 remain open inherited findings, are not
introduced or worsened by S2, and do not make s2.1 unsatisfiable. No reviewer
recommended an S2 remediation. The S2 matrix remains **24/24 PASS** and its status
remains **OFFLINE_ACCEPTED**. The unrelated inherited findings have no claim of a
fix or executed counterexample regression. A reviewer also noted that the root
`AGENTS.md` planning-handoff sentence is stale after the authorized implementation
commit; it is an inherited phase-documentation note, not a runtime or S2 matrix
failure, and was not changed under this audit.

Native macOS/Windows, submitted-revision CI and live model adherence remain NOT
RUN. No real credentials/authentication commands/provider traffic, hosted mutation,
or new ledger allocation occurred. These report amendments remain unstaged and
uncommitted; push remains separately unauthorized.
