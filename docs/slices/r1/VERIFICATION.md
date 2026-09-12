# Wi R1 verification report

Contract: **r1.0**. Status: **OFFLINE_ACCEPTED**. Accepted: **true**.

A-01..A-05 and **R1-00..R1-19 PASS** in the accepted worktree. The first final
complete-diff review returned three PASS verdicts with nonblocking report
observations. Verification confirmed the observations, report-only remediation
resolved them, and the repeated review returned three PASS verdicts with no
actionable findings. The owner later authorized implementation commit
`88b76c50756255193d0b681da748ed96ceec9f74`. Exact-head cross-platform CI is
**NOT RUN**. See [verification.json](verification.json) for structured evidence
and [MATRIX.md](MATRIX.md) for the governing requirements.

## Revision, worktree and attribution

| Item | Evidence |
|---|---|
| Runtime baseline | `4eed18be8baaf43be886164d192021b2e2e5aa28`, S2 merge in PR #3 |
| Planning/accepted-evidence HEAD | `b714ecac3825b1397274e5d252232a793fff726d` |
| Ancestry | Both supplied revisions are ancestors of the accepted-evidence HEAD |
| Tested revision | `null`: acceptance tests and reviews covered the uncommitted worktree, not a commit |
| Later implementation commit | `88b76c50756255193d0b681da748ed96ceec9f74`, owner-authorized after offline acceptance |
| Implementation start | Clean worktree, supplied parent observation before edits |
| Prior reporting route start, D | 12 modified tracked and four untracked source/test files; nothing staged |
| Restart start, E | 18 modified tracked and six untracked paths, including existing docs/reports; nothing staged |
| Draft footprint | Six current documentation edits and two new reports, in addition to preserved source/tests |
| Final code-gate time | Owner-supplied observation: 2026-09-12, around 12:13 UTC; individual command timestamps were not supplied |
| Git authority | No Git write occurred during acceptance. The owner later authorized commit `88b76c5`; no push or merge followed. |

**P** denotes owner-supplied parent/delegate execution or review history.
**S** denotes reporting source/diff inspection.
**D** denotes checks recorded by the prior reporting route attempt.
**E** denotes checks executed after the reporting restart. D records remain
attributed to that attempt; E does not claim its earlier checks as new execution.
Earlier red tests and reviews are P, not re-executed or independently approved by
D or E. No private delegate logs or hosted CI records were retrieved. This
assignment changes documentation only and preserves the accepted source/test
increments.

The historical [S2 audit](../s2/VERIFICATION.md), particularly A-01..A-05 at
`docs/slices/s2/VERIFICATION.md:379-387`, records inherited findings, not R1 repair
execution. S2 and older evidence remain byte-for-byte unchanged. R1 contract,
matrix, validation and prompt retain their original planning wording.

Before editing, D fingerprinted all **187** tracked/untracked nonignored files
outside the eight authorized documentation paths. Algorithm: SHA-256 over sorted
UTF-8 path, NUL, file contents, NUL. Initial fingerprint:
`4e39f6ff765d5c244879dac48e288a12cc2a7a942b6dd527ff5618b81eb0ce22`.
Initial SHA-256 of `git ls-files --stage -z`:
`8109fb4a29398114d364691274dfe8aa842321e792080e04a9b66b358a764688`.
These identify preserved file/index state, not behavioral proof or a commit.
Final comparison is recorded under reporting checks below.

## Environment and isolation

| Platform/tool | Observation, confirmed by D and E |
|---|---|
| Platform | Linux 6.18.33.2-microsoft-standard-WSL2 x86_64 GNU/Linux |
| Rust | rustc 1.98.1 (48a229cea 2026-09-01) |
| Cargo | cargo 1.98.1 (797e8a9bc 2026-08-05) |
| uv | 0.12.10 |
| Node | v24.18.0 |

P final accumulated code gates ran in sanitized `env -i` with synthetic `HOME`,
`XDG_CONFIG_HOME` and `CODEX_HOME`, trusted Cargo/Rustup/uv caches, and
`CARGO_NET_OFFLINE=true`. D rechecks use the same isolation policy, with separate
synthetic roots and offline uv configuration. Ambient provider keys are not
inherited. Tests use synthetic credentials, filesystem fixtures and loopback
WS/HTTP endpoints. Source/build inspection of this checkout is not use of private
owner projects or skills as model input. Cache access is development work, not
credential access or a model request.

No real credential reads, auth/profile/login/refresh commands, provider generations,
hosted probes, live smoke, live Node runner, `two_turns` main, release or deployment
ran. **live_started=false; real_credential_reads=0; provider_generations=0.**
Synthetic session submissions and fake-provider request counters are not live
provider generations. These statements describe the controlled commands and
fixtures, not a kernel-level I/O audit. Pi authoring traffic is separate.
The ledger remains **31/50 used, 19 remaining**, unchanged and not authorization.

## Findings: behavioral red, repair and green

All five repairs have local offline acceptance evidence. This acceptance does not
include exact-head cross-platform CI or live checks. Command IDs refer to the
command tables and machine report. Counts are
passed/failed/filtered unless stated otherwise; fixture loops are not extra tests.

### A-01: PASS, legacy plain presentation

P preserved evidence for `cargo test --bin wi r1_` (R01) compiled and failed:
**4 passed, 5 failed, 27 filtered** across A-01/A-02. Actual legacy collection
leaked controls into captured plain output. After the semantic fix, G01 passed
**10/0/27**. After formatting-only remediation, parent/reviewers confirmed the
same 10 focused tests and all 37 CLI tests (G02/G03).

P confirms that `r1_single_line_diagnostics_still_drop_all_controls`
(`src/cli/presentation_tests.rs:70-80`) was added after R01 and before G01 as a
positive one-line compatibility control. R01 selected nine focused tests
(4 pass + 5 fail); G01 selected ten, with 27 filtered in both runs. The added
test is positive compatibility evidence, not another behavioral red regression.

The actual shared collect/write path now filters displayed text/refusal deltas,
terminal-only text, final suffixes and labelled fallback. Raw prefix comparison,
returned response/native data, JSON, labels, flushes and I/O failures remain.
Production references: `src/cli/mod.rs:163-224,312-349` and
`src/cli/context_cli.rs:66-74`. Test references:
`src/cli/presentation_tests.rs:3-80` and `src/cli/collect_tests.rs:62-289`.
Named evidence includes `r1_a01_legacy_multiline_branches_preserve_raw_response_and_json`,
`r1_a01_legacy_split_sequences_and_raw_prefix_comparison` and
`r1_a01_legacy_writer_errors_stop_each_output_branch`.

The original blocked implementation delegate remains **BLOCKED**. Its preserved
behavioral evidence is attributed to P; later remediation and passing reviews do
not relabel that delegate as completed. Initial formatting trouble concerned
only assertion layout in `src/cli/run_cli_tests.rs:219-570`. Rustfmt-only remediation
changed no semantics. Exact initial formatting invocation/exit/time was not supplied.

### A-02: PASS, multiline wi run presentation

R01's compiled failures included actual run rendering collapsing LF/HT. G01/G02
passed **10/0/27** jointly with A-01; these are not ten tests per finding.
`src/cli/run_cli.rs:152-190` uses the shared multiline filter for provisional
text/refusal and authoritative response bodies. The one-line filter still removes
all controls from its diagnostic/listing consumers. LF, HT, spaces, fences and
non-control Unicode remain; CRLF becomes LF; other C0/C1 controls are dropped.
Filtering is stateless, without trimming, normalization or an ANSI parser.

Tests: `src/cli/presentation_tests.rs:50-80`,
`src/cli/run_cli_tests.rs:219-570`, with actual captured handler evidence at
`src/cli/run_cli_tests.rs:343-450`. Exact tests include
`r1_a02_run_render_multiline_golden_and_raw_json`,
`r1_a02_run_render_split_sequences_match_whole_bodies_and_keep_run_labels`,
`r1_a02_run_handler_multiline_outcomes_and_json_are_unmodified`,
`r1_a02_run_sink_failures_stop_work_and_keep_exit_precedence` and
`r1_a02_run_plain_cancellation_label_and_final_sink_precedence`.

### A-03: PASS, legacy generate preflight

R02, `cargo test --bin wi r1_a03_`, compiled red: **9/5/37**. Empty initial input
reached counters `[factory,credential,open,generate,close]=[1,1,1,1,1]`.
Invalid follow-up reached `[1,1,1,2,1]` and emitted **9 stdout bytes**.
Invalid options reached `[1,1,0,0,0]`. Error precedence returned the options
error before empty-input validation. These are observed failures, not compile errors.

`src/cli/mod.rs:225-311` now reads the source, validates the actual one-item initial
input, validates a supplied follow-up separately, validates actual options, then
opens the provider session. Invalid operations keep all five counters zero and
stdout empty. Existing validators and stdin errors remain. Accepted bytes, one
session, response checks, cancellation and normal close remain. There is no new
combined quota or S1/S2 preparation in legacy generate.

G04 passed **14/0/37**. `src/cli/generate_tests.rs:177-378` covers invalid input,
source errors, follow-up, options and precedence; `:381-773` covers valid flows,
exact serialized capacity, failures, cancellation and parsing. Process remediation
G05, `cargo test --test run_cli r1_a03_`, passed **1/0/5**:
`r1_a03_generate_binary_runtime_and_parse_exit_codes_before_auth`
(`tests/cli/run_cli.rs:230-279`) proves parsed invalid operations exit 1 with empty
stdout versus malformed Clap exit 2. Reviewers requested this as a consolidated
nonblocking coverage improvement; it is not separately claimed as a red regression.

### A-04: PASS, owner-specific AuthExpired guidance

R03, `cargo test --lib r1_a04_`, compiled red: **1/1/213**, with an old-wording
mismatch. G06 passed **2/0/213**. The actual expired WS RequestFailed test also
failed on old wording (**0/1/214**, R04) and passed (**1/0/214**, G07).
The targeted test name is known; its exact command invocation was not supplied.

The only production change in `src/error.rs:35-38` is the display attribute:

> login expired or expires within 30 seconds; renew Wi-managed credentials through Wi, or external credentials through Codex/Pi; then open a new provider session; established WebSockets cannot renew in place

`GatewayError::code()` at `src/error.rs:102-125` remains byte-for-byte unchanged.
`AuthExpired` stays `auth_expired`; `ToolFailed` stays `gateway_error`; Protocol
stays `protocol_error`. Auth selection, freshness, renewal and persistence are
unchanged. No real auth operation establishes this evidence.

`r1_a04_synthetic_freshness_error_has_owner_specific_display` and
`r1_a04_error_codes_remain_compatible` are at `src/error.rs:133-153`.
`expired_websocket_preflight_does_not_write_generation` at
`src/providers/openai_codex/tests/transport/boundary_tests.rs:178-244` checks the
actual correlated schema-1 event, exact message, `auth_expired`, `not_submitted`
and no generation write. The unrelated older Node diagnostic classification is
not broadened by this wording repair.

### A-05: PASS, nonempty decoded response identity

The first test compilation issue involved `ProviderEvent` lacking Debug (R05).
It is **not behavioral red evidence**. The compiled direct-decoder run R06,
`cargo test --lib r1_a05_`, produced **3/4/215**. Empty created returned `Ok(1)`
and assigned `Some("")`; empty completed terminal returned `Ok(2)`, assigned
`Some("")`, and set `terminal_received=true`, `finished=true`.

The private response-ID helper at `src/providers/openai_codex/codec.rs:323-335`
rejects only empty required response identities. Its consumers are created-ID
establishment (`:38-49`) and `parse_response` (`:242-259`), including terminal
aliases and recovered parsing. Empty IDs fail before normalized start/finish,
identity assignment, terminal-received state, recovery or settlement. Missing,
null and non-string required IDs retain the prior error. Nonempty IDs remain
opaque without trimming or new bounds; empty text/deltas remain valid.

G08 passed **12/0/215** direct tests; G09 passed **19/0/215** with integrations.
Actual loopbacks passed **7 tests** (G10); fake public-run defense passed
**1/0/38** (G11). Exact separate G10/G11 invocations were not supplied.

- Direct negatives/positives: `src/providers/openai_codex/tests/wire_format/response_identity_tests.rs:15-430`.
  Created, completed/done/incomplete/failed/cancelled terminal-only, prior-valid-start,
  required-type, opaque-ID, empty-content, recovery and later-consistency cases pass.
- Actual WS and labelled SSE: `src/providers/openai_codex/tests/wire_format/response_identity_loopback_tests.rs:109-189,500-525`.
  Invalid created/terminal IDs emit no invalid start or successful finish, one
  `RequestFailed(protocol_error, unknown)`, session EOF/closure and no second send.
  A previously valid start need not be retracted.
- Missing-MIME SSE: the same file `:528-539` preserves the earlier prolog's
  `unexpected_content_type`/unknown rejection. This is **preservation evidence,
  not red evidence**.
- Actual public run: the same file `:263-323` preserves outer
  `provider_request_failed`, nested `protocol_error`/unknown, no tools and no
  continuation. Positive native/recovered tool flows and terminal failures at
  `:326-497` pass. A fake bypass separately retains `provider_correlation` in
  `tests/run_support/validation.rs:152-207`.

P independent throwaway-copy review corroborated coupled red sensitivity of the
WS/SSE/public-run adapter tests. This reporting delegate did not repeat that
experiment or change source. **Primary A-05 red remains the compiled direct decoder.**

## Commands and counts

### Unchanged baseline, P

All unchanged baseline gates passed before implementation. This is a new R1
pre-edit baseline observation supplied by P, not only a quotation of S2's old
results. Detailed per-target counts/timestamps were not supplied for that run.

| IDs | Exact commands | Observed result |
|---|---|---|
| B01-B06 | `cargo fmt --all -- --check`; `cargo check --all-targets`; `cargo test --all-targets`; `cargo clippy --all-targets -- -D warnings`; `cargo build --all-targets`; `cargo test --doc` | All PASS; 374 Rust tests |
| B07 | `uv run scripts/verify.py` | PASS; inventory 123 source files / 361 test definitions / 25 fixture events; six Cargo gates repeated |
| B08 | `node scripts/cli_retest.mjs --self-test` | 152 passed; live_started=false |
| B09-B11 | `cargo run --example run_offline`; `cargo run --example skills_offline`; `cargo run --example skill_loading_offline` | PASS; 50, 42, Reviewed offline |
| B12 | `git diff --check` | PASS |

### Increment failures and focused greens, P

| IDs | Command or supplied target | Result / attribution |
|---|---|---|
| R01 / G01 | `cargo test --bin wi r1_` | Compiled 4/5/27, then 10/0/27; actual A-01/A-02 consumers |
| FMT01 | Initial formatting issue; exact invocation not supplied | Assertion layout only; not behavioral red; blocked delegate remains BLOCKED |
| G02 / G03 | Focused `r1_` and full CLI reconfirmation after rustfmt | 10 and 37 passing; parent/reviewers; exact invocations not supplied |
| R02 / G04 | `cargo test --bin wi r1_a03_` | Compiled 9/5/37, then 14/0/37 |
| G05 | `cargo test --test run_cli r1_a03_` | 1/0/5 process-exit remediation |
| R03 / G06 | `cargo test --lib r1_a04_` | Compiled 1/1/213, then 2/0/213 |
| R04 / G07 | `expired_websocket_preflight_does_not_write_generation` | Compiled 0/1/214, then 1/0/214; exact invocation not supplied |
| R05 | Initial A-05 compilation | ProviderEvent lacks Debug; no behavioral conclusion |
| R06 / G08 / G09 | `cargo test --lib r1_a05_` | Compiled 3/4/215; direct green 12/0/215; final green 19/0/215 |
| G10 / G11 | Actual response-identity loopbacks / fake public-run defense | 7 and 1 passing; fake target 38 filtered; exact invocations not supplied |

### Final accumulated code gates, P, around 12:13 UTC

Every command below passed with exit 0. These are the final unique direct local
code gates, not an assertion that every historical command ran only once.

| ID | Exact command | Result |
|---|---|---|
| F01 | `cargo fmt --all -- --check` | PASS |
| F02 | `cargo check --all-targets` | PASS |
| F03 | `cargo test --all-targets` | 421 passed, 0 failed/ignored |
| F04 | `cargo clippy --all-targets -- -D warnings` | PASS on Linux |
| F05 | `cargo build --all-targets` | PASS |
| F06 | `cargo test --doc` | PASS; 0 doctests |
| F07 | `uv run scripts/verify.py` | PASS; inventory 127 / 408 / 25; six internal Cargo gates pass again |
| F08 | `node scripts/cli_retest.mjs --self-test` | 152 passed; live_started=false |
| F09 | `cargo run --example run_offline` | `Completed: 50 (1 session, 3 model requests, 2 tool executions; offline)` |
| F10 | `cargo run --example skills_offline` | `Completed: 42 (2 catalog entries, 1 active skill, 1 session, 2 model requests, 1 tool execution; offline)` |
| F11 | `cargo run --example skill_loading_offline` | `Completed: Reviewed offline. (1 session, 2 model requests, 1 tool execution; offline)` |
| F12 | `git diff --check` | PASS on accumulated code |

F07 repeats F01-F06 through `scripts/verify.py:53-66`, recorded as V01-V06 in
JSON. Repeated Cargo runs and later D rechecks are **not additional unique tests**.
Static definitions are not executed tests. The final increase over baseline is
47 Rust tests and four source files, not a prescribed count to reach.

| Cargo target | F03 passed |
|---|---:|
| lib | 234 |
| binary wi | 51 |
| context_catalog | 28 |
| context_prepare | 26 |
| managed_absence_cli | 1 |
| provider_contract | 5 |
| run_cli | 6 |
| run_controller | 39 |
| skill_loading | 20 |
| skills_cli | 11 |
| run_offline, skills_offline, skill_loading_offline, two_turns example harnesses | 0 each |
| **Total** | **421** |

Testing the zero-test `two_turns` harness does not execute its main. Only the three
offline example mains above ran. Native platform exclusions are unmeasured, not
zero ignored tests. Linux results do not prove macOS or Windows execution.

### Reporting checks, D

After the six current-doc edits, `git diff --check` and an inline Node status/link
check passed. The check confirmed all six docs distinguish local implementation,
`accepted=false`, pending review and unrun CI. Links to the not-yet-created drafts
were checked for presence, not resolution at that intermediate step.

Post-draft checks **PASS**, with no failed check or failure-triggered retry:

| ID | Check / exact runtime command | D observation on 2026-09-12 UTC |
|---|---|---|
| D03 | `cargo fmt --all -- --check` | Exit 0; 12:34:07.377-12:34:07.833 |
| D04 | `cargo test --all-targets` | Exit 0; 12:34:07.833-12:34:26.032; 421 passed, 0 failed/ignored/measured/filtered; all 14 target counts match F03 |
| D05 | `node scripts/cli_retest.mjs --self-test` | Exit 0; 12:34:26.033-12:34:26.993; 152 passed, live_started=false |
| D06 | Inline `node -e` report-shape/preservation assertions | Exit 0 at 12:33:35.790; exact five findings/20 unique rows, matching Markdown statuses, red/green counts, target sum, reviews, test names/ranges, report links and zero-live/ledger fields |
| D07 | `git diff --check` | Exit 0; 12:34:26.993-12:34:27.015; after draft creation, before these factual result updates |

D03-D05/D07 used an allowlisted `env -i` through an inline Node `spawnSync` runner.
Synthetic roots were under `/tmp/wi-r1-docs.mzvWlt`; HOME, XDG_CONFIG_HOME,
CODEX_HOME and TMPDIR were separate private directories. Trusted Cargo/Rustup/uv
caches were retained, with `CARGO_NET_OFFLINE=true`, `UV_OFFLINE=true`,
`UV_PYTHON_DOWNLOADS=never`, `GIT_OPTIONAL_LOCKS=0` and C.UTF-8 locale.
D06 independently counted inventory **127/408/25** and confirmed byte-identical
`GatewayError` code mapping. All **187** protected files and the index matched the
initial hashes. The worktree contains **18 modified tracked / six untracked / zero
staged** paths. No source/test or historical-report bytes changed in this increment.

The prior route left these result fields for a final consistency/preservation
check. These reporting checks are not independent review. At that checkpoint, the
parent-owned complete-diff review remained pending and acceptance did not change.

### Restart checks, E

E resumed the existing six current-doc edits and two report drafts, rather than
recreating them. HEAD and both ancestry checks passed. At
2026-09-12T12:40:00.133Z, all 187 protected files and the index matched D's recorded
fingerprints. The ten tracked slice files outside these reports also matched HEAD;
the protected fingerprint includes all older evidence elsewhere in `docs/`.
Platform/tool versions match the environment table. This restart changed only report attribution, one source-line range and fresh
check evidence. The existing six active-document edits remain unchanged.

All fresh post-edit checks passed on the first attempt:

| ID | Check / exact runtime command | E observation on 2026-09-12 UTC |
|---|---|---|
| E00 | Inline Node protected-file/index comparison; HEAD and ancestry checks | PASS at 12:40:00.133; 187 protected files/index match, ten slice files match HEAD; 18 modified / six untracked / zero staged |
| E01 | Inline `node -e` report-shape/evidence assertions | Exit 0 at 12:43:26.511; exact five findings/20 unique rows and matching Markdown statuses; all red/green counts, 49 named tests, source ranges, links, reviews, CI and ledger fields pass; inventory 127/408/25 |
| E02 | `cargo fmt --all -- --check` | Exit 0; 12:44:24.306-12:44:24.776 |
| E03 | `cargo test --all-targets` | Exit 0; 12:44:24.777-12:44:43.591; 421 passed, 0 failed/ignored/measured/filtered; all 14 target counts match F03 |
| E04 | `node scripts/cli_retest.mjs --self-test` | Exit 0; 12:44:43.592-12:44:44.544; 152 passed, live_started=false |
| E05 | `git diff --check` | Exit 0; 12:44:44.545-12:44:44.566; before insertion of these factual results |

E02-E05 ran under `env -i` through an inline Node `spawnSync` runner. Separate
synthetic HOME/XDG_CONFIG_HOME/CODEX_HOME/TMPDIR directories were under
`/tmp/wi-r1-docs-restart.8xpTlZ`. The runner retained only trusted tool paths and
Cargo/Rustup/uv caches, with the same offline settings and locale recorded for D.
No ambient provider keys were inherited. These repeated suites add no unique tests.
E did not rerun the baseline, red tests, Clippy/build/verify wrapper, doctests or
example mains; their P results remain separately attributed.

A final read-only consistency, preservation and whitespace check follows this
result insertion. Its outcome belongs in the delegate handoff, without another
report rewrite or runtime rerun. No reporting check closes independent review.

## Matrix: exactly 20 required rows

Named tests are current S references exercised by P final gates, the recorded
focused commands, and D04/E03's complete 421-test rechecks. Cross-references above
provide exact source ranges and red assertions; this table does not infer PASS
from source inspection alone.

| ID | Status | Tests / observed evidence |
|---|---|---|
| R1-00 | PASS | P B01-B12 unchanged baseline; D HEAD/worktree/ancestry and 187-file fingerprint; S protected diff and current consumers. Synthetic roots only. |
| R1-01 | PASS | `r1_multiline_policy_golden_all_controls_and_every_split`, `r1_single_line_diagnostics_still_drop_all_controls` (`src/cli/presentation_tests.rs:50-80`); golden LF/HT/fences/Unicode/CRLF/empty/control and every-split assertions, G01/F03. |
| R1-02 | PASS | `r1_a01_legacy_multiline_branches_preserve_raw_response_and_json`, `r1_a01_legacy_split_sequences_and_raw_prefix_comparison` (`src/cli/collect_tests.rs:62-189`); all contract-enumerated response-body branches; R01 red and G01 green. |
| R1-03 | PASS | `r1_a02_run_render_multiline_golden_and_raw_json`, `r1_a02_run_render_split_sequences_match_whole_bodies_and_keep_run_labels`, `r1_a02_run_handler_multiline_outcomes_and_json_are_unmodified` (`src/cli/run_cli_tests.rs:219-450`); actual renderer/handler, outcomes and labels; R01/G01. |
| R1-04 | PASS | Legacy raw-response/JSON and split-prefix tests above; run render/handler JSON tests above; filtered presentation never replaces original serialized/native response data, G01/F03. |
| R1-05 | PASS | `r1_a01_legacy_writer_errors_stop_each_output_branch` (`src/cli/collect_tests.rs:224-289`), `r1_a02_run_sink_failures_stop_work_and_keep_exit_precedence`, `r1_a02_run_plain_cancellation_label_and_final_sink_precedence` (`src/cli/run_cli_tests.rs:453-570`); BrokenPipe/WouldBlock/other failures, no later work and cancellation/exit behavior pass. |
| R1-06 | PASS | `r1_a03_initial_prompt_preflight_before_open`, `r1_a03_initial_stdin_preflight_before_open`, `r1_a03_stdin_source_errors_and_read_bound_precede_validation` (`src/cli/generate_tests.rs:225-298`); raw/serialized/escaping overflow, UTF-8/source precedence, zero counters/stdout; R02/G04. |
| R1-07 | PASS | `r1_a03_follow_up_preflight_before_first_generation`, `r1_a03_initial_then_follow_up_then_options_error_precedence`, `r1_a03_inputs_validate_separately_and_accept_exact_serialized_limit` (`src/cli/generate_tests.rs:301-316,354-378,473-507`); no consumed first request or aggregate quota; R02/G04. |
| R1-08 | PASS | `r1_a03_options_preflight_before_open` and precedence test (`src/cli/generate_tests.rs:319-378`); `r1_a03_generate_binary_runtime_and_parse_exit_codes_before_auth` (`tests/cli/run_cli.rs:230-279`); zero counters, existing errors, runtime 1 versus parser 2; R02/G04/G05. |
| R1-09 | PASS | `r1_a03_valid_requests_preserve_bytes_options_auth_and_legacy_output`, `r1_a03_first_and_follow_up_response_checks_stop_and_close`, `r1_a03_cancellation_during_generation_or_collection_closes_once` (`src/cli/generate_tests.rs:381-470,510-557,696-745`), plus generation/collection/output failure tests `:560-693`; G04/F03. |
| R1-10 | PASS | `r1_a04_synthetic_freshness_error_has_owner_specific_display` (`src/error.rs:133-146`); old wording fails, exact owner-specific wording passes; R03/G06. |
| R1-11 | PASS | `r1_a04_error_codes_remain_compatible` (`src/error.rs:149-153`) and `expired_websocket_preflight_does_not_write_generation` (`src/providers/openai_codex/tests/transport/boundary_tests.rs:178-244`); actual display/event, codes/schema/not_submitted and no send; R04/G07; code() unchanged. |
| R1-12 | PASS | `r1_a05_empty_created_identity_is_not_published_or_assigned`, `r1_a05_created_missing_or_non_string_identity_keeps_required_string_error` (`src/providers/openai_codex/tests/wire_format/response_identity_tests.rs:15-59`); no assignment/start, required-type controls; R06/G08. |
| R1-13 | PASS | `r1_a05_parse_response_rejects_empty_terminal_identity`, `r1_a05_empty_terminal_only_identity_is_not_started_finished_or_received`, `r1_a05_empty_terminal_after_valid_start_keeps_only_prior_identity`, required-type and recovery-precedence tests (`src/providers/openai_codex/tests/wire_format/response_identity_tests.rs:62-171,283-328`); all five aliases and flags; R06/G08. |
| R1-14 | PASS | `r1_a05_websocket_empty_identities_close_without_finish_or_continuation`, `r1_a05_labelled_sse_empty_identities_close_without_finish_or_continuation`, `r1_a05_missing_mime_empty_first_identity_keeps_prolog_category` (`src/providers/openai_codex/tests/wire_format/response_identity_loopback_tests.rs:500-539`); actual actor closure/unknown/no second send, separate MIME preservation; G09/G10. |
| R1-15 | PASS | `r1_a05_public_run_adapter_failure_stops_before_tools_or_second_send` (`src/providers/openai_codex/tests/wire_format/response_identity_loopback_tests.rs:263-323`) and `r1_a05_public_run_fake_provider_empty_identity_keeps_correlation_guard` (`tests/run_support/validation.rs:152-207`); real nested adapter failure versus fake correlation defense, zero dispatch/continuation; G09-G11. |
| R1-16 | PASS | `r1_a05_nonempty_terminal_only_and_matching_created_ids_remain_opaque`, `r1_a05_empty_content_deltas_and_initial_arguments_remain_valid`, `r1_a05_recovered_output_preserves_opaque_identity_and_state_continuation`, `r1_a05_valid_terminal_keeps_received_after_consistency_rejection` (`src/providers/openai_codex/tests/wire_format/response_identity_tests.rs:174-430`); actual public-run valid content/tool/failure controls (`response_identity_loopback_tests.rs:326-497` in the same directory); G08-G10/F03. |
| R1-17 | PASS | F01-F12; retained S1/S2 and registry/run/auth suites. `skill_loading_websocket_uses_one_session_parent_and_only_correlated_result` and `skill_loading_sse_replays_exact_prepared_context_native_call_and_result` (`src/providers/openai_codex/tests/context_integration/context_loopback_tests.rs:88-156`); all three offline examples. Protected behavior/files remain unchanged. |
| R1-18 | PASS | Both reports, exact five findings/20 rows, current docs and attributed commands/reviews; D/E report-shape/preservation checks recorded above. Historical reports and ledger remain unchanged. |
| R1-19 | PASS | P F01-F12 all PASS and completed increment reviews below. First final complete-diff round: three PASS verdicts with nonblocking observations, verification-confirmed and remediated in these reports. Repeated review: three PASS verdicts with no actionable findings. Source was uncommitted during review and was later committed as `88b76c5`; exact-head cross-platform CI remains separate. |

## Independent review history, P

Increment reviewer identities and individual timestamps were not supplied. The
first final round uses the supplied labels review-a, review-b and review-c. Counts
below represent owner-supplied completed independent reviews by stage, not reviews
performed or orchestrated by this remediation delegate.

| Stage | Reported result | Findings, action and rerun |
|---|---|---|
| Increment 1, A-01/A-02 | Three PASS | No findings after assertion-layout-only formatting remediation. Parent/reviewers reconfirmed 10 focused and 37 CLI passes. The blocked implementor remains BLOCKED. |
| Increment 2, A-03 initial | Three PASS, no blockers | Two reviewers independently raised the same nonblocking missing process-exit regression. Consolidated as one remediation, not two different defects. |
| Increment 2, remediation/repeated gate | Three PASS, no findings | Added actual process-exit regression, G05 1 passed/5 filtered; repeated three-review gate passed. |
| Increment 3, A-04 | Three PASS | No findings. Exact display and actual WS failure path passed. |
| Increment 4a, decoder | Three PASS | No findings. Compiled direct red/green evidence distinguished from the initial compilation issue. |
| Increment 4b, integration | Three PASS, no blockers | One reviewer made two nonblocking observations described below. No code change required. |
| Final complete accumulated diff, docs and reports, round 1 | Three PASS, no blockers | review-a: NB reference defect; review-b: no findings; review-c: NB count ambiguity and deferred residual NB-02. Verification confirmed the observations; report remediation is recorded below. |
| Repeated final complete-diff review | Three PASS, no findings | review-a, review-b and review-c inspected the complete remediated worktree. No blocking or actionable nonblocking findings remained. |

Increment 4b observation 1: missing-MIME rejection is preservation evidence, not
red evidence. This report applies that attribution. Observation 2: the public-run
helper does not assert the total forwarded provider-event count. Current assertions
prove the contract-critical absence of an invalid start/successful finish, one
failure, no tool execution and no second send. Behavior is correct; no code change
was requested. Session-level tests do assert exact event totals. This is a bounded
coverage observation, not an unresolved in-scope behavioral regression.

### First final-review findings and report remediation

The first-round verdicts and verification confirmation below are supplied P
evidence. This remediation changes only the two reports, not source or tests.

| Reviewer | Verdict | Verification-confirmed observation and report action |
|---|---|---|
| review-a | PASS | Nonblocking reference defect. A-02 now cites the actual handler at `src/cli/run_cli_tests.rs:343-450`; the footprint identifies `src/cli/run_cli_context_tests.rs:443-444,446` as writer-fixture wiring. |
| review-b | PASS | No findings. |
| review-c | PASS | Nonblocking count ambiguity and deferred residual NB-02. The A-01/A-02 explanation now records the positive control added between R01 and G01; NB-02 is recorded below and in JSON. |

NB-02 originally identified that `collect_to` printed
`ProviderEvent::RequestFailed.message` directly to stderr without either
presentation filter. Contract section 3.2 did not require this diagnostic branch,
so the finding did not block R1 acceptance.

After acceptance, the owner authorized and committed the small follow-up.
`src/cli/mod.rs:226-229` applies the existing one-line filter
before writing the diagnostic. The real collector regression at
`src/cli/collect_tests.rs:320-363` preserves raw JSON event data and the returned
`ProviderFailed` error while requiring control-free stderr with one newline.
Before the semantic fix, the focused command failed 0/1 because stderr retained
ESC, LF, HT and C1 controls. After the fix it passed 1/1, the CLI suite passed
52/52, and the complete Rust suite passed 422 tests. Static inventory is
127/409/25; Node remains 152 with `live_started=false`. Three independent
follow-up reviewers returned PASS with no actionable findings. Review-a observed
one unchanged loopback timing failure on its first full-verifier attempt; its
permitted full-suite rerun passed 422 tests. Review-b and review-c passed their
checks without that observation. NB-02 is resolved and independently accepted in
this committed follow-up.

## Footprint, compatibility and remaining limits

R1 implementation paths are committed in `88b76c5`:

- Modified production/private seams: `src/cli/mod.rs:156-311`,
  `src/cli/context_cli.rs:66-74`, `src/cli/run_cli.rs:1-3,152-190`,
  `src/error.rs:35-38,127-154`, `src/providers/openai_codex/codec.rs:9-14,38-49,242-259,323-335`.
- Modified tests/wiring: `src/cli/collect_tests.rs:62-289`,
  `src/cli/run_cli_tests.rs:219-570`,
  `src/cli/run_cli_context_tests.rs:443-444,446` (writer-fixture wiring),
  `src/providers/openai_codex/tests/run_continuation/run_loopback_tests.rs:1-22`,
  `src/providers/openai_codex/tests/transport/boundary_tests.rs:178-244`,
  `tests/cli/run_cli.rs:230-279`, `tests/run_support/validation.rs:152-207`.
- New tests: `src/cli/presentation_tests.rs:1-80`, `src/cli/generate_tests.rs:1-773`,
  `src/providers/openai_codex/tests/wire_format/response_identity_tests.rs:1-430`,
  `src/providers/openai_codex/tests/wire_format/response_identity_loopback_tests.rs:1-539`.

The R1 commit includes `AGENTS.md`, `README.md`, `docs/README.md`,
`docs/ARCHITECTURE.md`, `docs/EVENTS.md`, `docs/WI_AUTH.md` and both R1 reports.
The committed follow-up changes the private diagnostic sink, its collector test
and current status documentation. Exact-head CI remains pending.

Deliberate compatibility changes are limited to plain presentation, legacy input
validation precedence, one AuthExpired sentence and rejection of empty decoded
response IDs. Provider schema 1, run schema 2, public APIs, code mappings, S1 direct
no-loader API, S2 catalog/body preparation and registry pairing remain intact.
Full-batch validation, result cache/order, run ownership, cooperative cancellation,
recovery/provenance, execution versus delivery, managed/external auth ownership
and both transport paths remain. No RunLimits, runtime quota/deadline, optional
budget replacement, dependencies, manifest/lock/CI/script changes or CI weakening.

| Evidence / deferred work | Status or limit |
|---|---|
| Linux local code gates | PASS; local offline evidence only |
| Final complete-diff independent review | First round: three PASS verdicts with report observations; verification-confirmed remediation; repeated round: three PASS verdicts with no actionable findings |
| Submitted R1 CI | NOT RUN; head null, runs empty; implementation commit `88b76c5` exists but was not pushed |
| Native macOS/Windows | NOT RUN locally; compile-time exclusions unmeasured |
| Exact-head CI after separate Git authorization | Both configured push/PR workflows and Ubuntu/macOS/Windows jobs must pass on the submitted head; historical S2 CI is not R1 evidence |
| Live model behavior/auth | NOT RUN; not authorized; no account access, model choice or adherence claim |
| Broader safety | Control filtering is not Unicode/bidi/prompt-injection or terminal-emulator certification; filesystem/other retained trust limits remain |
| NB-02, diagnostic stderr | RESOLVED in the committed follow-up; focused red 0/1, green 1/1, CLI 52/52, complete Rust 422/422; raw JSON and ProviderFailed preserved |
| Unrelated audit notes | Older Node diagnostic classification and other non-R1 notes remain outside this patch |
| Later product work | Provider reorganization, storage/P1, service/V1, GUI, generic tools, retries/failover and new feature frameworks remain deferred |

The final product's one-owner multi-device service requirements do not begin here.
Browser disconnect must not own service cancellation; persistent application
sessions and restart-without-replay still require later design. Neither local
repair evidence nor the unchanged ledger authorizes later product or live work. The
owner authorized only implementation commit `88b76c5`; no push or merge occurred.
