# Wi P1-A verification report

Contract **p1a.0**. Status: **ACCEPTED**. Final acceptance: **accepted=true**.

**P1A-00..P1A-31 PASS.** The required local gates and independent complete-diff
review passed. Commit `2fb600a` fixed the first macOS fixture failure. The later
`2d26cd9` PR workflow exposed delayed healthy-lease release during immediate reopen.
Commit `0839af9` explicitly unlocks a healthy lease before dropping its file and adds
a duplicate-descriptor regression. Exact-head push run 34930157178 and PR run
34930160788 passed every configured Cargo step on Ubuntu, macOS and Windows.

Increments 1-5 passed their three-review gates after confirmed remediations. Three
fresh reviewers examined the final complete diff. Two passed without blocking
findings. One proposed a RunResult equality blocker; independent verification rejected
it against the exact rule in `SCHEMA.md:217-223` and existing runtime
delivery-distinction tests.

P1-A is a shared storage library, not ordinary `wi run` persistence. P1-B's awaited
runtime seam and provider-history restoration remain **NOT IMPLEMENTED**. Service,
browser protocol, authentication for the service and GUI/V1 remain **NOT IMPLEMENTED**.
See [verification.json](verification.json) for the structured evidence and complete
named-test map, and [MATRIX.md](MATRIX.md) for the frozen requirements.

## Revision, attribution and preserved worktree

| Item | Observation |
|---|---|
| Runtime baseline | `dd720c0e66eceaaea831ad03e489656f77fc1cec`, R1/NB-02 merge |
| Planning HEAD | `21b1feacd2a278d74452fefd970a016170a83917`; documentation-only child of the runtime baseline |
| Implementation commit | `d4291817e9668456e3b8f6c8a07cb76927edb853` |
| Accepted source revision | `2fb600a545dfdf8adf89e34609e00fc07d95027b`; implementation plus macOS fixture remediation |
| Remediation scope | `tests/storage/fixtures.rs` and `tests/storage/filesystem.rs`; no production change |
| Original verification snapshot | 8 modified tracked / 49 untracked / 0 staged files, later committed as `d429181` |
| Original commit preparation | 57 staged paths: 8 modified and 49 added; 0 unstaged/untracked |
| Final local gate window | 2026-09-15T04:17:48.220Z through 04:19:12.258Z, actual UTC clock |
| Current report edits | Documentation-only evidence update after both `2fb600a` workflows completed successfully |

**D** means this increment's actual execution. **S** means current source, config,
diff or inventory inspection. **P** means prior parent/delegate evidence, verified
against retained local completion/review records. P failures, fixes and reviews
are not new D executions. The parent summary that all five increment review gates
passed agrees with those records. Private logs are not copied into these reports.
Some earlier exact failed commands, filtered counts and timestamps were not retained
in completion summaries; no missing detail is invented.

Before editing, D fingerprinted **242** tracked/untracked nonignored files outside
the seven permitted documentation paths. Algorithm: SHA-256 over sorted UTF-8 path,
NUL, file bytes, NUL. Fingerprint:
`e82a0fbe4ea0954f46e66962b1ef7867e7bb3d11996ba390246929056b6aba51`.
SHA-256 of `git ls-files --stage -z`:
`077fcc98df038d345abc5947cddef4b7b591f6389005992c186c04b35fe32cf2`.
These identify preservation, not a commit or behavioral proof. Historical R1/S2
reports, the frozen P1-A plan and ledger stay unchanged.

### Complete dirty/untracked inventory

Initial modified tracked files, preserved by this increment:

- `Cargo.lock`
- `Cargo.toml`
- `src/lib.rs`

All 47 initial untracked files, preserved:

- `examples/storage_offline.rs`
- `src/storage/catalog.rs`
- `src/storage/catalog_ops.rs`
- `src/storage/catalog_repair.rs`
- `src/storage/catalog_sync.rs`
- `src/storage/creation.rs`
- `src/storage/database.rs`
- `src/storage/dto.rs`
- `src/storage/error.rs`
- `src/storage/fault_tests.rs`
- `src/storage/filesystem.rs`
- `src/storage/history.rs`
- `src/storage/ids.rs`
- `src/storage/interruption.rs`
- `src/storage/lifecycle.rs`
- `src/storage/mod.rs`
- `src/storage/operation_tests.rs`
- `src/storage/process_tests.rs`
- `src/storage/recording_tests.rs`
- `src/storage/records.rs`
- `src/storage/recovery_tests.rs`
- `src/storage/run_store.rs`
- `src/storage/run_store/repair.rs`
- `src/storage/schema_tests.rs`
- `src/storage/session.rs`
- `src/storage/session_schema.rs`
- `src/storage/session_v1.sql`
- `src/storage/test_hooks.rs`
- `tests/storage.rs`
- `tests/storage/capture.rs`
- `tests/storage/catalog.rs`
- `tests/storage/catalog_v1.sql`
- `tests/storage/cli.rs`
- `tests/storage/correlation.rs`
- `tests/storage/filesystem.rs`
- `tests/storage/fixtures.rs`
- `tests/storage/foundation.rs`
- `tests/storage/history.rs`
- `tests/storage/lifetime.rs`
- `tests/storage/producer.rs`
- `tests/storage/recording.rs`
- `tests/storage/recovery.rs`
- `tests/storage/repair_integrity.rs`
- `tests/storage/session_schema.rs`
- `tests/storage/session_v1.sql`
- `tests/storage/sessions.rs`
- `tests/storage/tools.rs`

The verification snapshot added exactly these five modified tracked files:
`README.md`, `docs/ARCHITECTURE.md`, `docs/EVENTS.md`, `docs/README.md`, `AGENTS.md`.
It added exactly two reports:
`docs/slices/p1a/VERIFICATION.md` and `docs/slices/p1a/verification.json`.
The owner subsequently authorized staging. Commit preparation now contains 57 staged
paths: 8 modified and 49 added, with no unstaged or untracked paths.

## Environment, dependency and linked engine

| Tool/platform | D observation |
|---|---|
| Platform | Linux 6.18.33.2-microsoft-standard-WSL2 x86_64 GNU/Linux |
| Effective UID | 1000; denied-mode test exercised as nonroot |
| Rust | rustc 1.98.1 (48a229cea 2026-09-01), x86_64-unknown-linux-gnu, LLVM 22.1.8 |
| Cargo | 1.98.1 (797e8a9bc 2026-08-05) |
| Rustfmt / Clippy | 1.9.0-stable / 0.1.98 (48a229ceae 2026-09-01) |
| uv / Python through uv | 0.12.10 / 3.13.14 |
| Node / Git | v24.18.0 / 2.55.0 |
| Driver | SQLx 0.9.0, minimal `runtime-tokio` and `sqlite-bundled` |
| Bundled SQLite binding | libsqlite3-sys 0.37.0 |
| Actual linked SQLite | 3.51.3, meeting the fixed >=3.51.3 floor |
| Actual sqlite_source_id() | `2026-03-13 10:38:09 737ae4a34738ffa0c3ff7f9bb18df914dd1cad163f28fd6b6e114a344fe6d618` |

D used `/tmp/wi-p1a-inc6-final-wNEdt9eR/gate.mjs`, a temporary Node `spawnSync`
wrapper. Each actual command receives an allowlisted environment, not ambient
provider keys. Separate mode-0700 `home`, `xdg`, `codex`, `tmp` directories under
that newly named root supply HOME, XDG_CONFIG_HOME, CODEX_HOME and TMPDIR. Trusted
PATH, CARGO_HOME, RUSTUP_HOME and UV_CACHE_DIR remain available. Settings are
`CARGO_NET_OFFLINE=true`, `UV_OFFLINE=true`, `UV_PYTHON_DOWNLOADS=never`,
`GIT_OPTIONAL_LOCKS=0`, and `LANG=LC_ALL=C.UTF-8`. Storage child fixtures clear
their environment and also redirect TEMP/TMP. Synthetic workspace/skill/credential
fixtures and loopback/scripted providers are separate from owner data.

`Cargo.toml:24` contains the exact specified dependency. F13 inspects
`cargo tree -e features`. SQLx's active features are `runtime-tokio`,
`sqlite-bundled`, `_rt-tokio`, `_sqlite` and `sqlx-sqlite`. No SQLx macros, Any,
server driver, TLS, extension loading or deserialization is enabled. Inactive
SQLx macro packages occur in Cargo.lock; this does not enable them. Other existing
dependencies retain their own macros/TLS.

F14 compares package name/version pairs against `git show HEAD:Cargo.lock`:
**196 -> 233 packages; 37 added; zero old pairs removed or versions changed**.
The lock diff is **388 added / 2 removed lines**. Existing hashbrown/hashlink
references gain version disambiguation, not upgrades. Final gates preserve the
resolved lockfile. No unrelated dependency upgrade or host dynamic SQLite fallback.

Writable connections assert **WAL**, **synchronous=FULL (2)**,
**foreign_keys=ON (1)**, **trusted_schema=OFF (0)**, **busy_timeout=0**, and
**shared_cache=false**. The cache property has both an option assertion and an
actual two-connection read_uncommitted isolation test, not an invented PRAGMA.
Statement/slow-statement logging is disabled. Default checkpoint policy is unchanged.
F12's separate probe and F15's production helper test establish linked-engine and
settings evidence (`src/storage/database.rs:29-39,191-299`). No machine SQLite CLI
or Python SQLite version is substituted for the linked Rust engine.

## Storage behavior and source compatibility

- `SessionStore` owns an explicit absolute root through an OS-backed exclusive
  lease. Canonical root aliases converge. Session paths are generated from validated
  UUIDs; canonical session databases and catalog have schema v1 application IDs
  **1464423233** and **1464419137**, respectively. Independent populated fixtures
  reopen. There is no released-v0 migration claim.
- ApplicationSessionId, OperationId, RunId and StoredEventId validate lowercase,
  hyphenated, non-nil UUIDs. Provider/request/call IDs remain opaque. Store-owned
  checked i64/u64 sequence boundaries are separate from runtime sequences; Unix-ms
  timestamps are metadata, not history order.
- Immutable creation provenance agrees with event 1, original input/hash, generated
  identities/time and original receipt, even after rename. Hashes use ring SHA-256
  over recursively object-key-sorted typed JSON. Arrays and strings remain exact,
  including encoded tool output. This is not RFC 8785 numeric equivalence
  (`src/storage/dto.rs:475-524`).
- One `BEGIN IMMEDIATE` mutation checks the operation receipt before transition
  eligibility, validates the whole batch, appends contiguous events, updates
  projections/head, saves the receipt and commits. Known precommit errors are
  NotCommitted. An unknown COMMIT outcome requires receipt lookup. A post-commit
  cleanup warning does not invalidate committed evidence
  (`src/storage/database.rs:98-189`, `src/storage/session.rs:60-157`).
- Creation reserves in the catalog, materializes the canonical session, completes
  catalog acceptance, then responds. It does not claim atomicity across databases.
  Only a known creating reservation can initialize a missing/empty file. Accepted
  retries bypass availability; ordinary open remains fail-closed
  (`src/storage/creation.rs:13-44`).
- Operation-owned Tokio tasks retain guards, session ownership and explicit
  connection cleanup despite dropped waiters. `close()` drains admitted operations
  and rejects new admission. Uncertain retirement quarantines admission and retains
  the lease until process exit. Idle handles retain no worker/pool. Maintenance
  excludes normal operations during explicit repair (`src/storage/mod.rs:99-225`).
- Session commits do not auto-refresh summaries. Explicit `refresh_catalog()` reads
  canonical state and publishes monotonically without creating/promoting invalid
  availability. Catalog pages are live session-ID keysets, not liveness or global
  snapshots. History uses SQL `(after, through]` plus LIMIT at a captured head; owned
  pages retain no transaction (`src/storage/history.rs:343-370`).
- Lost-catalog repair is explicit and streamed. It validates canonical histories,
  run/tool projections and original creation identity. It preserves bad files,
  rejects duplicate creation claimants and clears intent only after a complete
  scan. Lost catalog-only failed reservations without canonical sessions cannot
  all be reconstructed. Ordinary use never initializes an empty replacement for a
  missing ready session.
- Selected `open_session()` calls lazily interrupt older-instance accepted/running
  records once with `process_restart`. Current-instance handles and terminal records
  stay unchanged. Partial output and missing/recorded results remain visible.
  Recovery and receipt retries execute no tool, provider or credential reader.

Current PreparedRun/ContextManifest getters and matching registry definitions are
used without adding serialization to context (`src/context/preparation.rs:28-78`,
`src/storage/records.rs:54-119`). Runtime/provider envelopes remain **2/1**;
RunRequest remains `provider_id/options/prompt`. Native Value equality plus exact
embedded strings is preserved, not original wire whitespace/property order.
ToolFailed remains `gateway_error`; storage has a separate static error namespace.
Actual registry success/error/limit outputs and offline public-run DTO traces are
produced outside storage (`tests/storage/tools.rs:127-551`,
`tests/storage/producer.rs:127`). Saving caller evidence does not authenticate a
provider or authorize execution. No protected run/provider/auth/tools/context/CLI
production source changed in this increment or the accumulated storage footprint.

## Exact final local commands and counts

D ran F01-F12 once directly, with exit **0** for each command. F07 necessarily
repeats all six Cargo commands in `scripts/verify.py:53-66`; those also exit 0.
No direct runtime gate failed and no failure-triggered retry occurred. F15/F16 are
focused output probes to expose engine/process/fault/workload counts, not extra
unique tests. F13/F14 are dependency/source inspection, not behavior execution.

| ID | Exact command | Result |
|---|---|---|
| F01 | `cargo fmt --all -- --check` | PASS |
| F02 | `cargo check --all-targets` | PASS |
| F03 | `cargo test --all-targets` | **535 passed, 0 failed, 1 ignored, 0 measured/filtered** |
| F04 | `cargo clippy --all-targets -- -D warnings` | PASS on Linux |
| F05 | `cargo build --all-targets` | PASS |
| F06 | `cargo test --doc` | PASS; **0 doctests** |
| F07 | `uv run scripts/verify.py` | PASS; source inventory **171/525/25**, six repeated Cargo gates, **535 passed / 1 ignored / 0 doctests** |
| F08 | `node scripts/cli_retest.mjs --self-test` | **152 passed**, live_started=false |
| F09 | `cargo run --example run_offline` | Completed 50; 1 session, 3 scripted requests, 2 tool executions |
| F10 | `cargo run --example skills_offline` | Completed 42; 2 catalog entries, 1 active skill, 1 session, 2 scripted requests, 1 tool execution |
| F11 | `cargo run --example skill_loading_offline` | Completed Reviewed offline.; 1 session, 2 scripted requests, 1 tool execution |
| F12 | `cargo run --example storage_offline` | Three samples, three real registry executions; zero provider construction/requests |
| F13 | `cargo tree -e features` | PASS; minimal bundled SQLx feature graph |
| F14 | `git diff -- Cargo.lock` | Inspected; additive 37-package resolution and unchanged existing versions |
| F15 | `cargo test --lib storage:: -- --nocapture` | **39 passed, 0 failed, 1 ignored, 234 filtered** |
| F16 | `cargo test --test storage lifetime::p1a26_finite_history_and_tool_results_exceed_old_context_thresholds -- --exact --nocapture` | **1 passed, 0 failed/ignored, 73 filtered** |
| F17 | `git diff --check` | PASS after current-doc edits; those tracked edits remain unchanged; final validator repeats this check |
| F18 | `git diff --no-index --check -- /dev/null <each untracked path>` | PASS; all 49 files, zero diagnostics; enumerate with `git ls-files --others --exclude-standard -z` |
| F19 | `node /tmp/wi-p1a-inc6-final-wNEdt9eR/report-check.mjs --draft` | PASS, exit 0 at 2026-09-15T02:11:10.995Z; report consistency/preservation, not independent review |

F15 ran 01:52:58.999Z-01:53:06.483Z; F16 ran
01:53:06.578Z-01:53:11.340Z on 2026-09-15 UTC. JSON records F01-F16 timestamps
where observed. Tool metadata used `rustc -Vv`, `cargo -V`, `rustfmt -V`,
`cargo clippy -V`, `uv --version`, `uv run python --version`, `node --version`,
`git --version`, `uname -srmo` and `id -u`. Inspection used `git status
--porcelain=v1 --untracked-files=all`, `git rev-parse HEAD`, `git rev-parse HEAD^`,
`git diff --name-only HEAD^ HEAD`, `git ls-tree -r HEAD src/storage tests/storage
examples/storage_offline.rs`, and the fingerprint/package comparison described above.
All are local read-only Git operations. Temporary helpers remain outside Git.

| Cargo target | F03 passed | F07 internal passed |
|---|---:|---:|
| lib | 273 | 273 |
| bin wi | 52 | 52 |
| context_catalog | 28 | 28 |
| context_prepare | 26 | 26 |
| managed_absence_cli | 1 | 1 |
| provider_contract | 5 | 5 |
| run_cli | 6 | 6 |
| run_controller | 39 | 39 |
| skill_loading | 20 | 20 |
| skills_cli | 11 | 11 |
| storage | 74 | 74 |
| Five example harnesses | 0 | 0 |
| **Total** | **535** | **535** |

Storage accounts for **39 unit + 74 integration = 113** unique executed tests.
The single ignored library test is `storage::process_tests::storage_child`, a closed
helper invoked explicitly by its process parents, not a missing standalone test.
The five zero-test example harnesses are run_offline, skill_loading_offline,
skills_offline, storage_offline and two_turns. Testing the last harness does **not**
execute its credential-using main. Only the four offline mains above ran.

Inventory **171 source files / 525 test definitions / 25 fixture events** is static
source analysis, not a test execution count. Whole-repository compile-time platform
exclusions are unmeasured, not zero. Three new Windows-only storage tests are
excluded on Linux; names and source locations appear under platform limits.
Repeated suites, fixture variations, subprocess exits and example mains do not
increase the 535 unique Rust tests. Historical R1/NB-02 **422 Rust / 152 Node** is
not used as a target or substituted for the current result.

## Matrix: exactly 32 dispositions

D+S means the named tests ran in F03/F07 or F15, with source assertions inspected.
P applies to earlier review/remediation and baseline history. A local PASS is
bounded by the platform/simulation limits below. JSON contains additional named
controls, exact command associations and blockers for each row.

| ID | Status | Executed evidence and assertion |
|---|---|---|
| P1A-00 | PASS | D HEAD/ancestry/inventory/fingerprints and F01-F19; P00 baseline; no storage at planning HEAD. Prior source/reports and authorization preserved. |
| P1A-01 | PASS | F12-F15; `storage_bundled_engine_settings_private_cache_and_explicit_close` (`src/storage/database.rs:238-299`): actual linked engine, settings/cache/logging and minimal dependency graph. |
| P1A-02 | PASS | `storage_fresh_layout_close_reopen_and_distinct_roots`, `storage_requires_explicit_absolute_root_and_never_treats_paths_as_uris`, `storage_explicit_root_without_home_or_workspace_state` (`tests/storage/foundation.rs:9-152`): generated explicit roots, no ambient workspace requirement, separate installations. |
| P1A-03 | PASS | `storage_concurrent_first_openers_have_one_owner` (`tests/storage/foundation.rs:87-101`); `p1a03_process_lease_canonical_alias_distinct_clean_exit_and_kill` (`src/storage/process_tests.rs:367-431`): busy before DB, aliases, distinct roots, clean/death release. |
| P1A-04 | PASS | Unix mode/no-chmod tests (`tests/storage/filesystem.rs:78-222`) and `p1a04_process_private_permissions_links_special_files_and_redaction` (`src/storage/process_tests.rs:862-954`): actual denied/link/socket/hardlink/FIFO and safe diagnostics. Windows tests inspected, not executed here. |
| P1A-05 | PASS | Initialization rollback unit tests, independent populated v1 fixtures and foreign/future/missing-schema preservation (`src/storage/schema_tests.rs:1`, `tests/storage/session_schema.rs:18-158`, `tests/storage/catalog_v1.sql:1`). New v1 only; no invented old migration. |
| P1A-06 | PASS | `creation_receipts_provenance_and_concurrent_convergence` (`tests/storage/sessions.rs:23-110`), accepted-create missing/unavailable retry regressions (`src/storage/operation_tests.rs:8`): same reserved identity/receipt, content conflicts and concurrent convergence. |
| P1A-07 | PASS | Two `p1a07_process_*` tests (`src/storage/process_tests.rs:433-538`) and operational-busy reservation test (`src/storage/operation_tests.rs:237-266`): four real exit stages, invalid partial preservation, creating-only recovery and no reallocation. |
| P1A-08 | PASS | `rename_exact_text_same_title_retry_immutable_receipts_and_stale_catalog` (`tests/storage/sessions.rs:113-220`) plus active-recording rename (`tests/storage/session_schema.rs:252-293`): exact text, ordered same-title new operations and unchanged earlier bytes. |
| P1A-09 | PASS | `p1a09_capture_real_s1_and_s2_snapshots_without_reread` and input/tools validation (`tests/storage/capture.rs:32-174`): real getters/registry, original task separate from prepared prompt, no reread or provider authorization claim. |
| P1A-10 | PASS | `p1a10_acceptance_receipt_first_active_session_scope_and_restart` (`tests/storage/recording.rs:80-178`): atomic acceptance, original receipt after terminal/restart, active-session exclusion and independent-session progress. |
| P1A-11 | PASS | Atomic/mixed/version tests (`tests/storage/recording.rs:181-272,494-655`), correlation regressions (`tests/storage/correlation.rs:111`) and private stage rollback (`src/storage/recording_tests.rs:1`): no partial rows/head/receipt on failure. |
| P1A-12 | PASS | `p1a12_source_gaps_duplicates_and_multiple_runs` (`tests/storage/recording.rs:275-373`), checked-boundary unit tests and direct immutable SQL assertions (`tests/storage/sessions.rs:113-220`): separate source/session order, no wrap or quota. |
| P1A-13 | PASS | `p1a13_partial_native_response_and_unknown_extension_exact_roundtrip` (`tests/storage/history.rs:56-183`): partial delta kinds/indexes/strings, native/effective output, provenance/usage and opaque extensions preserved. |
| P1A-14 | PASS | Real registry success/gateway_error/tool_output_limit, both finish/result orders and mismatch controls (`tests/storage/tools.rs:127-391`); actual offline public-run DTO traces (`tests/storage/producer.rs:127`). No finish-derived output. |
| P1A-15 | PASS | `p1a15_saved_reuse_scoped_call_ids_exact_bytes_and_zero_storage_execution` (`tests/storage/tools.rs:394-551`): exact saved reuse, run-scoped calls, missing/wrong-name rejection, no storage execution/reread. |
| P1A-16 | PASS | Outcome/delivery/conflicting-terminal tests (`tests/storage/recording.rs:376-491,658-735`): execution versus sink status retained, Result terminalization/supplement once, no resurrection, completed requires results. |
| P1A-17 | PASS | Restart/terminal/rollback tests (`tests/storage/recovery.rs:78-275,1053-1091`) and fresh-process lazy reopen (`src/storage/process_tests.rs:706-860`): one interruption, unchanged partial/tool/receipt/terminal data, no execution or eager unselected scan. |
| P1A-18 | PASS | Two `p1a18_fault_*` tests (`src/storage/fault_tests.rs:36-152`): precommit acknowledgment barrier, waiter-drop ownership, commit/rollback drain, no duplicate retry and receipt reconciliation of both injected unknown outcomes. |
| P1A-19 | PASS | Cleanup/refresh test (`src/storage/fault_tests.rs:155-223`) and lost-reply/quarantine process test (`src/storage/process_tests.rs:540-609`): durable receipt despite postcommit failure; lease held through uncertain retirement. |
| P1A-20 | PASS | `p1a20_immutable_snapshot_pages_with_appends_and_cursor_edges` (`tests/storage/history.rs:186-254`): immutable H despite new appends, edge/cursor checks; source SQL range/LIMIT and short transactions (`src/storage/history.rs:343-370`). |
| P1A-21 | PASS | Catalog-only keyset test (`tests/storage/sessions.rs:389-460`) and explicit-refresh test (`tests/storage/recovery.rs:17-75`): no session DB open during listing, observed-head semantics and live index, not liveness. |
| P1A-22 | PASS | `p1a21_22_refresh_is_explicit_catalog_only_and_receipts_survive_failure` (`tests/storage/recovery.rs:17-75`) plus private stale/publication controls (`src/storage/recovery_tests.rs:1`): canonical success independent of refresh; no stale overwrite/promotion. |
| P1A-23 | PASS | Lost catalog/renamed creation and malformed generated-entry tests (`tests/storage/recovery.rs:296-537`): explicit repair gate, streamed canonical discovery, restored original create receipt, no provider/project registrations. |
| P1A-24 | PASS | Interrupted repair process (`src/storage/process_tests.rs:611-682`), fault isolation/duplicate claimants (`tests/storage/recovery.rs:540-1050`) and replay/reservation regressions (`tests/storage/repair_integrity.rs:1`, `src/storage/recovery_tests.rs:1`): intent retained, complete-scan complement, no canonical rewrite. |
| P1A-25 | PASS | Two `p1a25_fault_*` tests (`src/storage/fault_tests.rs:226-387`): independent sessions/order, read/repair/close drain and lifecycle gauges; 33 handles, 617 additional opens/closes, idle zero connections/admissions. |
| P1A-26 | PASS | F16 `p1a26_finite_history_and_tool_results_exceed_old_context_thresholds` (`tests/storage/lifetime.rs:16-130`): 2492 events, 8601600 delta bytes, 9991604 payload bytes, 129 tool results/executions. No lifetime/storage quota; finite evidence only. |
| P1A-27 | PASS | `p1a27_fault_real_sqlite_full_and_constraint_roll_back_whole_mutation` (`src/storage/fault_tests.rs:390-437`), busy/static-error/commit controls: real SQLite constraints/FULL simulation and labeled injections; no physical power-loss/device-full claim. |
| P1A-28 | PASS | F01-F11 retain old regression assertions. `p1a28_process_normal_cli_help_and_noop_create_no_storage` (`tests/storage/cli.rs:4-39`): four CLI invocations create nothing. Protected production schemas/errors/runtime unchanged. |
| P1A-29 | PASS | F12 actual `examples/storage_offline.rs:125-482` main: three finite samples, synthetic capture, real registry output, explicit refresh/list/page and retained-data reopen after context deletion. Exact samples below, no SLA. |
| P1A-30 | PASS | Five current docs plus these two reports distinguish local and submitted evidence. P1-B/V1 remain unimplemented; final complete-diff review and exact-head CI passed; ledger unchanged. |
| P1A-31 | PASS | F01-F19 and R02 local acceptance passed. Three fresh final reviewers examined the complete accumulated diff before submission; review-a's sole blocker was independently rejected against `SCHEMA.md:217-223`, and review-b/review-c passed. After the two macOS findings were remediated, exact-head push run 34930157178 and PR run 34930160788 passed all six Cargo steps on Ubuntu, macOS and Windows at `0839af9`. |

## First failures, fixes and prior commands

These are **P**, not rerun red tests or independent approval by D. The machine
report's `prior_history` retains exact recorded command strings and separates
missing invocation details. Counts overlap subsequent full suites.

| Record | Prior observation, first failure and remediation |
|---|---|
| P00, baseline | On 2026-09-13, parent ran the required pre-edit Cargo/Python/Node/three-example/diff gates in synthetic `wi-p1a-baseline.iM7Ux5` roots. All passed. Retained summary gives 234 lib passes, inventory 127/409/25 and 152 Node passes. It does not retain the full baseline aggregate or every command timestamp; historical 422 is not substituted. |
| P01, increment 1 | 5 storage unit / 22 integration passes. `cargo check --lib`, `cargo test --locked --lib storage:: -- --nocapture`, `cargo test --locked --test storage`, format, locked all-target check/Clippy and diff checks passed. No build/test failure reported. Outside-repository instruction discovery timed out; scoped discovery succeeded. |
| P02, increment 2 | First compile rejected migration SQL as `&&str`; dereferencing fixed it. `cargo test --lib storage::` passed 13; `cargo test --test storage` passed 33. Review confirmed accepted create retries incorrectly depended on missing/unavailable status. `cargo test --locked --lib storage::operation_tests::storage_accepted_creation_retry_ignores_` failed two tests before fix, passed both after. Receipt return moved before availability/session access, preserving content-conflict and normal open failures. Final unit/integration counts 15/33; new-test formatting corrected. |
| P03, increment 3 | Two inherited `Box<RecordedRunInput>` call-site mismatches fixed. Initial `cargo test --test storage -- --nocapture` passed 49; `cargo test --lib storage:: -- --nocapture` passed 17, 234 filtered. Focused capture/history/recording/private-recording counts 3/3/6/2 overlap these tests. Review confirmed missing runtime/provider/turn/request and originating-tool correlation. An unqualified `--exact` selected zero tests, not proof; qualified regression failed because invalid RunStarted committed. Indexed latest-event correlation validation fixed it; `cargo test --locked --test storage correlation` passed 6, unit 17, integration 55. Real offline public-run completion/failure DTOs round-trip. Earlier finite fixture had 2491 events; required TurnStarted changed final count to 2492, not data loss. |
| P04, blocked attempt | Initial route reported provider_failed; active fallback ended budget_exhausted at 2026-09-13T12:25:16.693Z with incomplete repair and two E0559 `name` versus `tool_name` fixtures. This was not a stall; the blocked attempt remains blocked. Owner-authorized continuation completed the work, not an invented successful retry of that attempt. |
| P04, continuation | Correcting both tool field names produced three recovery passes. SQLx E0277 rejected generated test SQL; fixed literals resolved it. Expanded recovery was 7 passed/2 failed: loss simulation needed the complete catalog set and Unix sockets needed shorter paths. Integration was 64 passed/1 failed: inconsistent raw running projection replaced by canonical acceptance/start records. Format corrected. Completed stage had 21 unit/65 integration passes. |
| P04, remediation 1 | Reviews/verification confirmed repair lost valid incomplete reservations, bootstrap rejected malformed generated entries before explicit repair, and repair missed run projections. Five new tests failed; complement control passed. Preserve matching creating reservations, mark malformed layout as repair evidence without following it, and validate all run projections. Unit 24 passed; integration initially 67/1 on an obsolete bootstrap expectation, then 68 passed after aligning it without weakening no-follow checks. Added-file whitespace status 1 was initially misclassified, not a whitespace defect. |
| P04, remediation 2 | Further review/verification confirmed incomplete run/tool replay and malformed paired reservation acceptance. Three regression tests reproduced eight run mutations, fifteen tool mutations and 31 malformed reservations. Full indexed run replay, bidirectional tool validation and transactional paired-reservation validation fixed them without rewriting canonical events/projections. `cargo test --locked --lib --test storage repair_integrity_` passed 7; unit 26/integration 73 passed. |
| P05, increment 5 | Initial compilation needed correct HistoryPage accessor use and fixed PRAGMA SQL. Fault run was 5 passed/1 failed: SQLite auto-rollback masked primary storage.io; preserving the precommit error fixed it. Process run was 6 passed/1 failed: add missing TurnStarted fixture. Storage/full suites exposed an older private fixture without lifecycle admission; add guard and tracked close. Whitespace wrapper exit 123 misclassified new-file diff status 1. Final locked full suite passed 535 with one helper ignored; unit 39/integration 74, process parents 7, fault tests 6; 152 Node passes, zero doctests and four example mains passed. `uv run scripts/verify.py --static-only` reported 171/522/25; full wrapper was not repeated by that implementor. |
| P05, Windows remediation | Review/verification confirmed absent native Windows junction/reparse test coverage. Three nonignored cfg(windows) tests now assert real fixture creation, reparse flags, public API rejection and preservation. No production or Unix test change. Locked Linux filesystem/session subsets passed 7/5; storage integration 74 and unit 39 passed with helper ignored. Formatting corrected. Final static definitions become 525; Linux runtime count stays 535 because the three Windows tests are excluded here. Native execution was unverified at that stage; the later `2fb600a` Windows jobs passed. |
| P06, prior increment 6 | Terminal assignment_conflict at 2026-09-15T00:54:47.719Z. Assignment named nonexistent `docs/INDEX.md`; this assignment corrects the path to `docs/README.md`. No report drafts existed at D start. The earlier blocked attempt is not relabeled completed. |
| D06, this increment | No production/test changes or failed runtime gate. Early artifact-location inspection found no var/tmp match and denied access to unrelated systemd temporary directories; those paths are not acceptance inputs. Required verifier repetitions and focused probes are identified separately. |
| P06, final complete-diff review | Three fresh reviewers inspected the entire accumulated diff and reports. Review-b and review-c passed. Review-a proposed that supplemental RunResult summary/delivery fields must equal RunFinished; independent verification rejected the claim because `SCHEMA.md:217-223` requires equality only for run identity, provider session and complete outcome. Existing P1A-16 and repair tests exercise differing delivery metadata. Review-c observed one unnamed, unreproduced full-suite failure followed by five passing reruns; this remained a low hosted-CI flake risk, not evidence of a contract defect. |
| Post-submission remediation 1 | Both `d429181` workflows passed Ubuntu/Windows and failed one macOS test before reaching later Cargo steps. `UnixListener::bind` rejected the long temporary path at `tests/storage/filesystem.rs:345` with `path must be shorter than SUN_LEN`. Commit `2fb600a` adds a short private Unix fixture constructor and uses it only for socket cases. The focused test passed, then the isolated 12-gate wrapper passed from 04:17:48.220Z through 04:19:12.258Z with 535 Rust passes, one helper ignored, 152 Node passes, four offline examples and `live_started=false`. Both exact-head workflows subsequently passed every configured OS job and Cargo step. |
| Post-submission remediation 2 | At evidence commit `2d26cd9`, push run 34929149332 passed all jobs. PR run 34929152971 passed Ubuntu/Windows but failed macOS at `src/storage/operation_tests.rs:164`: immediate reopen after `SessionStore::close()` returned `storage.busy`. The lease was released only by dropping the file descriptor, so a concurrent process spawn could briefly retain a duplicate. `src/storage/lifecycle.rs` now explicitly calls `File::unlock()` on healthy retirement and retains ownership on unlock uncertainty. A regression keeps a cloned descriptor open while proving immediate reacquisition. An initial focused command was malformed with two Cargo filters and exited 1 before execution; `cargo test --locked --lib storage::` then passed 40 tests. The isolated 12-gate wrapper passed from 04:38:11.682Z through 04:39:47.568Z with 536 Rust passes, one helper ignored, 152 Node passes, four offline examples and `live_started=false`. Commit `0839af9` passed exact-head push run 34930157178 and PR run 34930160788 on all three operating systems. |

All completed implementation/remediation stages also reported format, all-target
check, warning-denied Clippy and whitespace passes. Initial increment-2/3 commands
used unqualified all-target check/Clippy; later remediation commands used `--locked`.
For P02, the final unit command was `cargo test --locked --lib storage:: -- --skip
providers::`; it excluded unrelated provider tests and did not claim full regression.
P04 final commands were `cargo test --locked --lib storage::` and `cargo test
--locked --test storage`. JSON records each stage's command set and uncertainty.

P05's exact final commands additionally used `cargo test --locked --lib
storage::process_tests -- --nocapture`, `cargo test --locked --lib storage:: --
--nocapture`, `cargo test --locked --all-targets`, `cargo build --locked
--all-targets`, `cargo test --locked --doc`, and `cargo run --locked --example`
for each of storage_offline/run_offline/skills_offline/skill_loading_offline.
Its initial untracked check covered 47 files. These historical commands are not
substitutes for the fresh F01-F19 acceptance here.

## Process boundaries, fault certainty and resource observations

F15 executes seven process-parent tests. The branch/loop exit assertions establish
**26 child invocations: 17 exit 0, 7 exit 73, 2 SIGKILL (signal 9)**. P reports the
same counts; D's nocapture output confirms stages. This is an assertion-derived
count from executed tests, not OS process tracing. These children also run during
F03/F07, without adding unique tests.

| Process test / stage | Children | Exit 0 | Exit 73 | SIGKILL | Observation |
|---|---:|---:|---:|---:|---|
| Lease/root alias/distinct roots | 8 | 7 | 0 | 1 | Busy before catalog access; clean/death release |
| Four creation stages | 4 | 0 | 4 | 0 | Reservation and generated identities/receipt retained |
| Invalid partial creation | 1 | 0 | 1 | 0 | Original bad bytes preserved; unavailable/failed once |
| Committed rename/lost reply/quarantine | 2 | 0 | 1 | 1 | Exact receipt/history and duplicate retry; lease held until death |
| Repair after one candidate | 1 | 0 | 1 | 0 | repair_required=1 and one seen candidate; two repairs converge on three sessions |
| Fresh process lazy reopen twice | 2 | 2 | 0 | 0 | One interruption; partial/tool/receipt/terminal data unchanged; unselected accepted run untouched |
| Unix permissions/link/special files | 8 | 8 | 0 | 0 | Five mode/denied/link/socket/hardlink cases plus three Linux FIFO cases |
| **Total per process suite** | **26** | **17** | **7** | **2** | All expected outcomes asserted |

Creation exits occur at **0 Reserved**, after catalog reservation; **1 Initializing**,
inside uncommitted session DDL; **2 Materialized**, after session commit before catalog
completion; **3 CatalogAccepted**, after registration before reply
(`src/storage/process_tests.rs:233-242,433-494`). Exit 73 is `cfg(test)` process exit
at real transaction boundaries, not an exception that runs normal shutdown. The
helper clears environment, receives synthetic stdin, validates diagnostics and reaps
children (`src/storage/process_tests.rs:80-207`). The 20-second fixture watchdog is
not a product timer or proof of rollback.

F03/F07 separately execute four CLI cases: `--help`, `run --help`, `--version`
exit 0; no arguments exit 2. All five synthetic directories remain empty
(`tests/storage/cli.rs:4-39`). These four children and the explicit-root self-spawn
fixture are outside the seven-test/26-child total.

F15 also executes six fault tests. Admission barriers check acknowledgment before
COMMIT, waiter-drop ownership, both injected unknown-commit outcomes, cleanup warning
versus committed receipt, failed explicit refresh, maintenance/close drain and
independent session progress. Lifecycle gauges observed **33 retained handles**,
**617 additional operation-scoped opens/closes**, **active_connections=0**, **admitted=0**
(`src/storage/fault_tests.rs:226-387`). This is stronger lifecycle evidence than RSS,
but not a bound on arbitrary workload memory.

The disk-full fixture sets `PRAGMA max_page_count=1`, which SQLite clamps to current
page count. A **512-KiB rename** then produces real SQLITE_FULL. The other branch
uses a real aborting constraint. Both preserve head=1, only event 1 and absent receipt,
with NotCommitted and static storage.io/storage.integrity respectively
(`src/storage/fault_tests.rs:390-437`). This does **not** fill a physical device.
I/O/commit/cleanup tests also use explicitly labeled injected outcomes. The uncertain
close fixture retires its actual worker before simulating a report of uncertain
retirement. Neither these simulations nor WAL/FULL nor SIGKILL proves physical
power-loss durability, device-full behavior, upstream cancellation or exactly-once
external effects. No production failpoint environment variable or SQL API exists.

## Finite workload and performance observations

F16 retained **2492 events**, **2100 deltas**, **8601600 exact delta bytes**,
**9991604 canonical payload bytes**, and **129 saved tool results / real registry
executions**. Each fixture response contains one actual registry call. Paging reads
all expected bytes/results; provider item/byte capacities are not copied into a
storage-lifetime ceiling (`tests/storage/lifetime.rs:16-130`). Absence of a
1000-session/256-MiB discovery cutoff is a source observation, not execution of
that scale or proof of infinite storage.

F12 executes `examples/storage_offline.rs:125-482` in dev profile, unoptimized with
debug info and warm build artifacts, on the local Linux filesystem. Each of three
independent synthetic samples uses real context preparation and one AddNumbers
registry execution outside storage. Supplied complete DTO traces are recorded,
refreshed/listed/paged and checked after synthetic context deletion and close/reopen.
There is no provider construction or request. List size is 10; history page size is 4.

All values below are **milliseconds**, API end-to-end including operation-scoped
connection open/validation/close. close_reopen includes old store close, new store
open and selected session open. No benchmark-derived production policy is added.

| Operation | Sample 1 | Sample 2 | Sample 3 |
|---|---:|---:|---:|
| create | 88.931 | 79.729 | 68.937 |
| accept | 65.627 | 66.750 | 55.336 |
| append_batch | 71.510 | 88.362 | 81.859 |
| rename | 52.022 | 72.794 | 56.597 |
| list | 17.991 | 12.039 | 17.236 |
| page | 38.090 | 37.241 | 42.857 |
| close_reopen | 57.392 | 52.061 | 68.279 |
| close | 0.018 | 0.024 | 0.014 |

Separate linked-engine probe connection: **open 7.922 ms / close 0.519 ms**.
Every sample's canonical event transactions are **create=1, accept=1, append=12,
rename=1**, reaching **head=15**. Creation additionally uses its catalog phases.
After close, catalog/session file sizes are **36864/86016 bytes**; input snapshot
**2059**, typed append JSON **6018**, tool output **10** bytes per sample.
Serialized history sizes are **12911 / 12914 / 12909 bytes**. These are actual
sample sizes, not fixed product fields or wire-byte commitments.

Earlier P05 samples remain attributed observations: create
56.051/39.878/45.290; append 35.739/37.165/38.322; rename 25.450/26.771/34.801;
list 8.030/6.467/6.723; page 17.457/26.511/16.684; close_reopen
66.619/48.334/55.316 ms; separate probe open/close 1.991/0.495 ms.
They are not substituted for F12 or used as a speed-regression comparison. No
percentile, cache-disabled, cross-engine, largest-scale, fastest or CI SLA claim.

## Independent review and submitted-CI boundary

All entries below are **P** completion records, not reviews performed by D.
Reviewer role labels identify review-a/review-b/review-c; repeated roles are not
asserted to be the same agent instance. Dates are recorded return times, not
invented individual test timestamps. Full source/schema/transaction/ownership,
creation/repair, privacy and DTO compatibility were reviewed as each scope landed.

| Review record | Three-review completion UTC | Result and confirmed remediation |
|---|---|---|
| I1-three-review | 2026-09-13T09:58:05.860Z | Three PASS, no blocking foundation findings; session/process scope was still deferred then |
| I2-three-review-repeat | 2026-09-13T10:57:26.910Z | Three PASS after accepted-create availability/receipt finding, independently confirmed 10:41:33Z and remediated 10:49:40Z; two red/green regressions |
| I3-three-review-repeat | 2026-09-13T12:18:28.684Z | Three PASS after 11:43:12Z correlation findings, verification 11:49:35Z and remediation 12:06:50Z; real producer DTO controls retained |
| I4-three-review-second-repeat | 2026-09-14T09:12:11.084Z | Three PASS after 07:59:48Z reservation/bootstrap/projection findings and 08:35:11Z run/tool replay/malformed reservation findings; independently confirmed, second remediation 08:59:40Z |
| I5-three-review-repeat | 2026-09-15T00:52:18.118Z | Three PASS after 00:18:21Z missing Windows test finding, verification 00:23:42Z, remediation 00:33:40Z; native execution remained unverified at that stage |
| final-complete-diff | 2026-09-15T02:45:43Z | Three fresh reviewers inspected the complete implementation, tests and reports. Review-b/review-c passed; review-a's RunResult claim was rejected against `SCHEMA.md:217-223`. |

The owner-requested personal source-to-contract audit found no storage semantic
mismatch at `2fb600a`. It also corrected stale report state and the first macOS
fixture failure. A later duplicate workflow at `2d26cd9` exposed a real healthy-lease
release race. The explicit-unlock remediation passed both exact-head workflows.
Remaining observations concern explicit Windows ACL, symlink privilege and same-user
TOCTOU limits, not permission to weaken tests.

| Platform/evidence | Status |
|---|---|
| Local Linux | Required gates PASS for the accepted remediation; 536 Rust passes, one helper ignored |
| Prior exact-head `2fb600a` | Push 34928386247 and PR 34928389304 PASS on Ubuntu/macOS/Windows |
| `2d26cd9` push | [34929149332](https://github.com/zer09/wi/actions/runs/34929149332), all OS jobs PASS |
| `2d26cd9` PR | [34929152971](https://github.com/zer09/wi/actions/runs/34929152971), Ubuntu/Windows PASS; macOS FAIL at immediate lease reopen |
| Accepted `0839af9` push | [34930157178](https://github.com/zer09/wi/actions/runs/34930157178), all OS jobs PASS |
| Accepted `0839af9` PR | [34930160788](https://github.com/zer09/wi/actions/runs/34930160788), all OS jobs PASS |

Every successful `2fb600a` job passed checkout, stable toolchain setup, `cargo fmt
--all -- --check`, `cargo check --all-targets`, `cargo test --all-targets`, `cargo
clippy --all-targets -- -D warnings`, `cargo build --all-targets`, and `cargo test
--doc`. The failed `2d26cd9` macOS job stopped at `cargo test --all-targets`; no later
step is claimed. The workflow does not implicitly run Node self-tests, Python inventory
or example mains. No job, lint or platform check was weakened.

The three Windows-only tests are:

- `storage_windows_sessions_junction_is_preserved_and_rejected`
  (`tests/storage/filesystem.rs:226-274`).
- `storage_windows_managed_file_reparse_points_are_preserved_and_rejected`
  (`tests/storage/filesystem.rs:278-328`).
- `generated_session_database_and_sidecar_reparse_points_are_preserved_and_rejected`
  (`tests/storage/sessions.rs:316-386`).

File-symlink fixture creation requires **Developer Mode or
SeCreateSymbolicLinkPrivilege**; it fails instead of silently skipping if unavailable.
Junction coverage uses `mklink /J`. Windows root ACL protection remains caller-owned;
Unix 0700/0600 claims are not Windows ACL enforcement. Static reparse checks do not
eliminate the check-file/open-file race or hostile concurrent same-user ancestor
replacement. These tests and Linux checks are not a hostile-filesystem sandbox.
Applicable Unix/macOS tests remain configured. The later hosted macOS and Windows jobs provide native CI execution evidence, not certification of every owner machine or filesystem.

## Report checks, limitations and authorization

Original report validation passed at **2026-09-15T02:11:10.995Z**; final review
status was reconciled at **2026-09-15T02:45:43Z**. This evidence update records
exactly **32** ordered unique row IDs, all **PASS**. The current local target sum is
**536** after one lease regression was added. Initial untracked count **47** and process totals
**26/17/7/2** remain historical implementation evidence.
JSON/Markdown statuses, command/count/sample values, source names/ranges and current-doc
links agree. Before owner-authorized staging, all **242** protected files and the
index matched the initial fingerprints. The verified implementation snapshot was
**8 modified tracked / 49 untracked / 0 staged**. Commit preparation now has **57
staged paths: 8 modified and 49 added**, with no unstaged/untracked paths. All 49
added files have zero whitespace diagnostics. The parent repeated tracked, untracked
and staged diff checks after final review reconciliation.

The original report validation is not runtime execution or independent review. The
subsequent independent complete-diff review is recorded above. During commit preparation,
the isolated wrapper repeated all 12 required Cargo/Python/Node/example gates from
**2026-09-15T03:49:59.062Z through 03:51:21.607Z**; all exited 0, including 535 Rust
passes with one ignored helper and 152 Node passes with `live_started=false`. After
the lease remediation, a new 12-gate run passed from **04:38:11.682Z through
04:39:47.568Z** with **536 Rust passes**, one ignored helper, 152 Node passes and all
four offline examples. JSON, row/status consistency and whitespace checks pass.

Deliberate remaining limits:

- No physical power-loss, device-full, network-filesystem, encryption/keyring,
  backup/export or adversarial filesystem certification. Store data can contain
  secrets even when Debug/errors are redacted.
- Lost catalog-only failed reservations cannot all be rebuilt. Corrupt existing
  catalogs are preserved and fail closed, not automatically replaced. Only newly
  specified schema v1 is supported; no old Wi/TypeScript import is claimed.
- Caller-supplied runtime evidence is not independently authenticated execution.
  Missing output remains missing; failure/cancellation/interruption does not prove
  upstream termination or authorize model/tool retry. No exactly-once external
  effect claim.
- Ordinary run persistence, P1-B restored provider history/runtime seam, V1 service,
  browser protocol and GUI remain unimplemented. No RunLimits, budgets, session/history
  caps, auto-deletion, auto-resume, new executor or unrelated cleanup.
- Finite observations do not prove arbitrary scale or bounded RSS. Zero doctests is
  zero coverage. Whole-repository platform exclusions remain unmeasured.
- Earlier summary gaps are labeled, not fabricated. Temporary synthetic gate roots
  remain outside Git for local inspection; no owner data was deleted or overwritten.

No credential/auth/profile/login/refresh command, private-skill access or live provider
request occurred. Synthetic auth regression tests are not owner account operations.
The owner authorized the recorded commits and pushes. No agent was delegated for the
personal audit or macOS remediation. No reset, clean, stash, forced checkout, merge,
release, deploy or publication occurred.

**live_started=false; real_credential_reads=0; provider_generations=0.**
Ledger remains exactly **31/50 used, 19 remaining, changed=false; new allocation 0**.
The remaining balance is not authorization. Final independent review and exact-head
hosted CI passed. Merge remains a separate owner action.
