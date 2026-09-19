# Wi V1-B verification

Contract **v1b.0**. Evidence recorded 2026-09-19.
**LOCAL_VERIFIED; accepted=false; tested_revision=6e28cc339f25a95b78170e7c4171de48f122d07a.**
This is a committed implementation with exact-head hosted evidence, but it is not
accepted because two Windows-specific subcases remain intentionally deferred. It is
not a security certification or deployment. The [machine report](verification.json)
is the structured evidence record.

Current disposition: **38 PASS, 2 PARTIAL, 40 rows**. Only V1B-03 and V1B-33
remain PARTIAL. Persisted reference-reducer assertions close V1B-18; the complete
loaded sample closes V1B-37. Three fresh final complete-diff reviews passed with no
blocking findings. Exact-head push `35448837331` and pull_request `35448839843`
passed all six Cargo steps on Ubuntu, macOS and Windows.

## 1. Revision, scope and preservation

- Accepted baseline: `16d623a3317abc7796ec203e4fe15d580791a769`, V1-A merged in PR #8.
- Tested implementation head: `6e28cc339f25a95b78170e7c4171de48f122d07a`.
  The accepted V1-A baseline and planning commit are ancestors.
- Initial implementation intake had 5 modified tracked and 50 untracked files. The
  implementation, reducer remediation and three hosted-CI remediation commits are now
  committed. The final source inventory contains all 56 implementation paths.
- This synchronization changes only current status/evidence documentation. Source,
  tests, examples, manifests, lockfiles and frozen planning documents remain identical
  to the tested implementation head.
- Authorized commits and pushes occurred only for this V1-B branch. No merge,
  deployment, auth command, real credential read or live provider request occurred.
- `CONTRACT.md`, `MATRIX.md`, `VALIDATION.md`, `IMPLEMENTOR_PROMPT.md` and all old
  slice reports/contracts remain unchanged. Their NOT RUN headings describe planning,
  not this report's row dispositions. Failed hosted attempts remain recorded.

The **56-file tested implementation fingerprint** is
`815ffc38a7ad9de937430ac1b8d19cc3d5a30c97ca9cc81c301b7dc5dc8587fd`.
The prior 55-file fingerprint was
`a7cb2a897b9b7f8c6702500abfee91b3abe27e71a90eeb7348b64f5e6f769533`.
The reducer remediation added `src/http_api/router/tests/run_tests/reducer.rs`; later
commits changed only tests to make exact assertions portable and bounded.
The **395-file preservation fingerprint**, excluding the nine current status/evidence
documents, is `8321b462eb3ddafcdd2979b4a5c342d4e05dae871d0f73dbdba9b17b803ac53f`.
The **78 frozen-document fingerprint** is
`8d8b3f06f535c6da925eb8ff3b8582306d23f5f11078b8eaa1f5426ebc0413eb`.
The JSON contains the exact implementation paths and fingerprint algorithm:
lexicographically sorted UTF-8 `path`, NUL, lowercase SHA256(file bytes), LF;
SHA256 the concatenation. Documentation is excluded from the implementation hash.
These identify the observed worktree without inventing a tested commit.

### Environment and isolation

openSUSE/WSL2 Linux, x86_64, kernel `6.18.33.2-microsoft-standard-WSL2`;
Rust `rustc 1.98.1`, Cargo `1.98.1`, uv `0.12.10`, Node `v24.18.0`, Git `2.55.0`.
Local execution used the Linux environment above. Exact-head hosted Cargo gates also
ran on native Ubuntu, macOS and Windows runners. This does not prove the intentionally
omitted Windows reparse-point or Ctrl+C subcases.

Tests use synthetic temporary roots, skills, owner/provider credentials, isolated
process configuration, scripted providers and actual OpenAI WS/SSE loopback adapters.
No real private skills or credentials were read. Dependency/cache traffic is development
work, not live acceptance. Ledger: **31 used / 50 cap / 19 remaining, unchanged**.
`live_started=false`, `real_credential_reads=0`, `provider_generations=0` count live
provider use; synthetic scripted/loopback requests did occur.

## 2. Attribution and implemented boundary

**P** means the parent CLI agent's observed executions, supplied in the assignment
and retained in session `01a0b609-9296-75c3-a9b1-1bf331f276e3`. The pre-remediation
final batch ran from 2026-09-19T08:39:04Z through 08:46:00Z, messages 201-202;
message 206 retained performance excerpts. The remediation report is message 226.
The complete loaded rerun command is message 230, 2026-09-19T10:15:55Z.
Post-remediation complete gate commands are message 236, 2026-09-19T10:16:52Z.
The assignment supplies their observed results. **R** means prior independent
increment reviews in that session. **D** means documentation source/inventory
inspection and cheap checks: D00-D03 are prior work; D04-D06 are this synchronization.
D did not rerun Cargo, examples, Node self-tests or independent reviews. Source
inspection identifies assertions in executed tests; it is not new execution evidence.

The implementation adds authenticated HTTP JSON commands and canonical-history SSE
through `wi::http_api::serve`, with a thin `wi serve --config` adapter. It composes
RunHost, B2, S1/S2, SQLite and existing tools, not another agent loop. Task 202 means
actual durable acceptance. Raw-command retries validate the original typed B2 range
before new preparation; racing failures reconcile once by read, without redispatch.
HTTP/client/ticket/SSE loss does not cancel a dispatched run. Explicit addressed
cancel and owner shutdown retain the existing host/storage ownership rules.

Browser DTOs expose only allowed visible fields. Private history records become
sequence-preserving checkpoints. Native replay/account/binding/config internals stay
private; intended user/model/tool text can still contain secrets. Catalog listing is
an as-of index, not canonical task truth. SSE uses fixed-head pages and later committed
polls, not a provider receiver or producer queue. A slow observer stops its own polling.
No task resumes on reconnect, open or restart.

### Source and dependency delta

Five tracked implementation changes are `Cargo.toml`, `Cargo.lock`, `src/lib.rs`,
`src/cli/mod.rs` and `src/providers/openai_codex/tests/replay/loopback.rs`.
The last change only wires the test module. New files are enumerated in the JSON.
Production core service/execution/storage/provider/context/tool implementations and
schemas remain unchanged: session DB 2, catalog 1, stored envelope 1, runtime 2,
provider 1. HTTP API version 1 is separate.

Only one new direct dependency is present, exactly:
`axum = { version = "=0.8.9", default-features = false, features = ["http1", "json", "query", "tokio"] }`.
Lock additions: Axum 0.8.9, axum-core 0.5.6, httpdate 1.0.3, matchit 0.8.4,
mime 0.3.17, ryu 1.0.23, serde_path_to_error 0.1.20 and serde_urlencoded 0.7.1.
Existing hyper 1.11.1 adds httpdate; wi 0.2.0 adds Axum. No package was removed or
version-replaced. D checked the parsed HEAD/current lockfiles, not a dependency update.

## 3. Commands, counts and outcomes

C01-C36 retain the original and reducer-remediation phases. C37-C42 are the six
source-equivalent local Cargo gates after hosted remediation. **C01-C19 are the
pre-remediation final batch**, not latest-head gates. C20-C21 are focused increment-7
results. The JSON `command_batches` ties each phase to commands and fingerprints.
D00-D03 describe initial documentation work; D04-D06 cover this synchronization.

| Ref | Exact command | Result |
|---|---|---|
| C01 | `cargo fmt --all -- --check` | PASS |
| C02 | `cargo check --locked --offline --all-targets` | PASS |
| C03 | `cargo test --locked --offline --all-targets` | PASS; library 579 passed, 0 failed, 8 ignored; all binary/integration/example test targets passed |
| C04 | `cargo clippy --locked --offline --all-targets -- -D warnings` | PASS |
| C05 | `cargo build --locked --offline --all-targets` | PASS |
| C06 | `cargo test --locked --offline --doc` | PASS; 0 doctests |
| C07 | `uv run --no-sync scripts/verify.py` | PASS; 295 source files, 843 regex test definitions, 25 fixture events |
| C08 | `node scripts/cli_retest.mjs --self-test` | PASS; 152, live_started=false |
| C09 | `cargo run --locked --offline --example run_offline` | PASS |
| C10 | `cargo run --locked --offline --example skills_offline` | PASS |
| C11 | `cargo run --locked --offline --example skill_loading_offline` | PASS |
| C12 | `cargo run --locked --offline --example storage_offline` | PASS |
| C13 | `cargo run --locked --offline --example persisted_run_offline` | PASS |
| C14 | `cargo run --locked --offline --example conversation_offline` | PASS |
| C15 | `cargo run --locked --offline --example host_offline` | PASS |
| C16 | `cargo run --locked --offline --example http_api_offline` | PASS, retained dev sample; example unchanged |
| C17 | `cargo run --locked --offline --release --example http_api_offline` | PASS, retained release sample; example unchanged |
| C18 | `cargo run --locked --offline --example http_api_offline -- --loaded` | PASS, historical loaded sample; superseded by C36 |
| C19 | `git diff --check` | PASS, P and D; D03 also checks untracked files |
| C20 | `cargo test --locked --offline --lib http_api_joined -- --test-threads=2` | PASS; 13 passed, 1 ignored helper |
| C21 | `cargo test --locked --offline --lib http_api -- --test-threads=2` | PASS; 93 passed, 2 ignored helpers |

| Ref | Exact post-remediation command | Result |
|---|---|---|
| C22 | `cargo test --locked --offline --lib http_api::router::tests::run_tests::reducer::v1b_18_reference_reducer_uses_persisted_browser_events -- --exact --nocapture` | Attempt 1 watchdog FAIL; test-only counter reset; attempt 2 PASS, 1 test |
| C23 | `cargo test --locked --offline --lib http_api -- --test-threads=2` | PASS; 94 passed, 0 failed, 2 ignored |
| C24 | `cargo fmt --all -- --check` | PASS, focused remediation |
| C25 | `cargo check --locked --offline --all-targets` | PASS, focused remediation |
| C26 | `cargo clippy --locked --offline --all-targets -- -D warnings` | PASS, focused remediation |
| C27 | `git diff --check` | PASS, focused remediation |
| C28 | `cargo fmt --all -- --check` | PASS, complete post-remediation gate |
| C29 | `cargo check --locked --offline --all-targets` | PASS, complete post-remediation gate |
| C30 | `cargo test --locked --offline --all-targets` | PASS; library 580 passed, 0 failed, 8 ignored; all binary/integration/example test targets passed |
| C31 | `cargo clippy --locked --offline --all-targets -- -D warnings` | PASS, complete post-remediation gate |
| C32 | `cargo build --locked --offline --all-targets` | PASS, complete post-remediation gate |
| C33 | `cargo test --locked --offline --doc` | PASS; 0 doctests |
| C34 | `uv run --no-sync scripts/verify.py` | PASS; 296 source files, 844 regex test definitions, 25 fixture events; internally reran six Cargo gates |
| C35 | `node scripts/cli_retest.mjs --self-test` | PASS; 152, live_started=false |
| C36 | `cargo run --locked --offline --example http_api_offline -- --loaded` | PASS; complete loaded/dev sample in section 6 |
| C37 | `cargo fmt --all -- --check` | PASS, final source-equivalent gate |
| C38 | `cargo check --locked --offline --all-targets` | PASS, final source-equivalent gate |
| C39 | `cargo test --locked --offline --all-targets` | PASS; library 581 passed, 0 failed, 8 ignored; all remaining targets passed |
| C40 | `cargo clippy --locked --offline --all-targets -- -D warnings` | PASS, final source-equivalent gate |
| C41 | `cargo build --locked --offline --all-targets` | PASS, final source-equivalent gate |
| C42 | `cargo test --locked --offline --doc` | PASS; 0 doctests |

C07 and C34 internally invoke six Cargo gates without the standalone gates'
`--locked --offline` flags. Those are overlapping reruns, not unique tests. The
`--no-sync` warning outside a uv project remains nonfailure. Both complete batches
passed; the separate focused reducer watchdog is retained. Eight ignored library
entries include child helpers invoked by parent tests; their printed passes are not
added again. The binary process helper is separate. Current source inventory is
**296 files / 844 regex definitions**, not an executed-test total. C07's 295/843 and
C03's 579 and C30's 580 library passes remain historical; C39 reports 581. No
aggregate unique Rust total is asserted.
Seven existing examples remain seven; dev/release/loaded remain three sample modes.
C36 is one loaded rerun, not a new example or fourth sample mode. Test targets,
focused reruns, verifier reruns, examples and zero doctests remain separate.

D00-D03 previously checked HEAD/ancestry, inventory, config/provisioning syntax,
active statuses and documentation consistency. D03 passed on its second attempt;
its first failure remains recorded. D04 independently passed
`uv run --no-sync scripts/verify.py --static-only` with 296/844/25 and no Cargo run.
D05 is the updated embedded validation in section 8. D06 historically passed JSON
parsing and the then-current 37/3 snapshot after the first narrow JSON syntax failure
was corrected. The hosted synchronization validates 38/2 and clean committed source.
Exact commands and phases are in the JSON.

## 4. Fixed 40-row disposition

Test-group references below resolve to exact source paths, line ranges and function
names in `verification.json.test_catalog`; the source map follows this table.
A PASS records the supported assertions, not a product/security certification.
A PARTIAL preserves a required subcase that is not evidenced here. Detailed observer
mechanisms and command references also appear on every JSON row.

| ID | Status | Observed assertions, tests and commands | Observer / blocker |
|---|---|---|---|
| V1B-00 | PASS | Exact HEAD/ancestry, all tracked/untracked owner work, no staging; baseline acceptance stays historical. D00, C01-C06, D03. | D inventory/fingerprints; P local gates. No blocker. |
| V1B-01 | PASS | Exact Axum/lock delta; public Send service with injected host and real TCP. T18; C02-C05. | D dependency comparison; P public service test. No blocker. |
| V1B-02 | PASS | Strict config/options/origin/paths/listener; canonical aliases/cwd; missing skills root; invalid startup precedes auth. T01/T18/T22; C03/C21. | P parser/filesystem/builder/storage hooks on Linux. No blocker. |
| V1B-03 | PARTIAL | HMAC format/LF, redaction/load-once, malformed/oversize and Linux symlink/socket/FIFO/mode rejection. T02; C03/C21. | P Linux execution; Windows reparse fixture/execution and ACL proof absent. |
| V1B-04 | PASS | Static unauthorized responses, no spoof authentication and no protected body/storage/context/provider effects. T05/T07/T10/T14/T25; C03/C20/C21. | P HTTP and no-work hooks/counters. No blocker. |
| V1B-05 | PASS | Host/URI/port/IPv6/default-port/Origin and preflight/CORS boundary, including valid bearer with foreign Origin. T05-T07; C03/C21. | P raw TCP/HTTP headers and no-storage assertions. No blocker. |
| V1B-06 | PASS | Strict route/body/query/IDs/MIME/encoding/streamed bound; stalled body closes before dispatch. T05/T07/T10/T19; C03/C21. | P sockets, static errors and storage hooks. No blocker. |
| V1B-07 | PASS | Exact committed create/duplicate/conflict, lost reply retry, one session, retirement policy. T08; C03/C21. | P HTTP clients and actual receipts/catalog. No blocker. |
| V1B-08 | PASS | As-of keyset list, canonical reads, pending-run rename, exact titles and independent refresh/cleanup disposition. T08/T09; C03/C21. | P storage/refresh barriers and HTTP. No blocker. |
| V1B-09 | PASS | Pure allowlist first, retired/replaced workspace rejection, accepted retry despite deleted/changed roots. T01/T10/T11; C03/C21. | P filesystem fixtures and preparation/provider counters. No blocker. |
| V1B-10 | PASS | Real off-worker S1/S2/capture, raw bytes, metadata without unselected bodies, paired loader/AddNumbers, safe notices. T10/T25; C03/C20/C21. | P captured input, actual tools and joined wire. No blocker. |
| V1B-11 | PASS | No 202/provider before acceptance commit; actual receipt while model pending; cancel drains commit. T12/T20/T25/T28; C03/C20/C21. | P independent WAL read, not held-writer read; actual barriers. No blocker. |
| V1B-12 | PASS | Observer loss before/after acceptance leaves host work; dropped preparation waiter cannot dispatch later. T10/T12/T16/T28; C03/C20/C21. | P dropped sockets/tickets and independent saved results. No blocker. |
| V1B-13 | PASS | Receipt-first exact raw retry/reopen; different text/run and rename/B1/append conflict; forged/missing projections reject. T11/T25; C03/C20/C21. | P typed durable evidence and auth-load counters. No blocker. |
| V1B-14 | PASS | Absent racers/change/failure reconcile once, one executor; different raw conflict; stale selection does not rebuild. T12; C03/C21. | P read/dispatch/open counts and one acceptance. Initial racing submissions are not reconciliation redispatch. No blocker. |
| V1B-15 | PASS | Accepted failures remain 202; unknown/cleanup certainty and absent-receipt uncertainty; exact safe producer mappings. T04/T08/T13/T26; C03/C20/C21. | P actual producer/SQL/loopback failures. No blocker. |
| V1B-16 | PASS | Accepted/running/terminal/result distinction, terminal without final result, real operation receipt/not-found. T04/T09/T13/T25; C03/C20/C21. | P canonical records and GET responses, not queried provider state. No blocker. |
| V1B-17 | PASS | Exact target cancel, wrong/completed not_tracked, closed503; other sessions and owned SQL continue. T09/T20/T28; C03/C20/C21. | P real addressed HTTP and identity/tool commit gates. No blocker. |
| V1B-18 | PASS | Persisted EventViews equal HTTP history; run/item/response identity-scoped deltas and snapshot replacement; rich blocks OR fallback; actual tool output/error flags/reuse; status-only completion and duplicate replay. T04/T09/T25/T29/T30; C22/C23/C30/C34/C16/C17/C36. | P actual HTTP/host/B2/SQLite/scripted-provider/AddNumbers records; D exact reducer assertions. No blocker. |
| V1B-19 | PASS | Closed native/recovered/refusal/reasoning projection, canary exclusion, exact Unicode/CRLF, unsupported marker, unchanged stored bytes. T04/T25/T26; C03/C20/C21. | P whole views and independent stored-prefix equality. No blocker. |
| V1B-20 | PASS | Qualified cursor syntax/session/head/range; decimal strings above 2^53 and page windows without lifetime cap. T03/T04/T07/T09/T14; C03/C21. | P small numeric fixtures and real multipage history. No blocker. |
| V1B-21 | PASS | Fixed H plus page/attach/caught-up commits, rename/checkpoint order, no SQL lock over backpressure. T09/T15/T17/T25; C03/C20/C21. | P controlled commits, sequence equality and independent writer. No blocker. |
| V1B-22 | PASS | Real SSE framing/content type/Unicode/id, cursor/header equality/conflict, initial HTTP errors, no-id heartbeat. T14/T15/T17; C03/C21. | P wire parser and controlled clock/body stream. No blocker. |
| V1B-23 | PASS | Committed partial output while model pending, no uncommitted output, no catch-up/poll gap, 250ms wait. T15-T17; C03/C21. | P independent WAL/HTTP observer and real record barriers. No blocker. |
| V1B-24 | PASS | Unread clients leave fast reader/writer/host free; last-applied resume, duplicate/conflict detection, one-page ownership. T15-T17/T29; C03/C16-C18/C21. | P sockets, reducer and measured completion with unread clients. No blocker. |
| V1B-25 | PASS | Actual post-header error has no id, closes once, no cancel/cursor advance; shutdown is not completion. T14/T15/T19; C03/C21. | P storage fault and wire EOF; static paths/errors. No blocker. |
| V1B-26 | PASS | Joined HTTP/auth/preparation/RunHost/B2/SQLite/OpenAI WS/tools; empty then same-session native/recovered replay and fresh/new parent behavior. T25/T26/T28; C03/C20. | P actual wire, storage and browser SSE; no direct install_replay substitute. No blocker. |
| V1B-27 | PASS | Same joined path with labelled/missing-MIME provider SSE; native/recovered exact input/results; wrong MIME/empty ID uncertainty. T25/T26/T28; C03/C20. | P actual provider wire distinct from browser SSE. No blocker. |
| V1B-28 | PASS | Synthetic X/Y/X account guard for both transports; mismatch recorded without history-bearing generation, later explicit X works. T27; C03/C20. | P adapter auth/request counters and canonical results. No blocker. |
| V1B-29 | PASS | Actual loader/AddNumbers results persist across historical source change/deletion; current roots differ; scripts/resources inert. T10/T25; C03/C20/C21. | P real tool outputs and subsequent replay wire. No blocker. |
| V1B-30 | PASS | Admission/network closure plus original host/owned SQL drain; storage stays writable; no abort/deadline/unlock shortcut. T19/T20/T28; C03/C20/C21. | P stalled/nonreading sockets, commit gates, original outcome identity. No blocker. |
| V1B-31 | PASS | Unpolled/polled owner Drop, serving error/unwind initiate despite clones; WorkerLost/Incomplete/quarantine remain. T19/T21/T26; C03/C20/C21. | P isolated children, record/lease checks; only awaited drain is called complete. No blocker. |
| V1B-32 | PASS | Fresh process reads complete/partial/unbound history, interruption once, zero automatic work; explicit B2 rejects incomplete/unbound. T09/T23; C03. | P Linux child processes and separate work counters, not power-loss testing. No blocker. |
| V1B-33 | PARTIAL | Actual serve/help/static errors, injected startup, port0, Linux and hosted macOS SIGINT/SIGTERM, exit/drain and old CLI regression. T22-T24; C03/C08. | P/H process captures; native Windows Ctrl+C intentionally deferred. |
| V1B-34 | PASS | Whole route/error/SSE/Debug/normal diagnostic canary checks; auth before sensitive work, no raw native/error escape. T02/T04/T05/T07/T14/T22/T24/T25; C03/C20/C21/D03. | P captures; D report leak scan. Intended conversation text remains sensitive. No blocker. |
| V1B-35 | PASS | Post-remediation local/hosted gates pass; remediations changed only tests/test hooks; fixed core schemas/APIs, no new budget/store/executor/provider/GUI. C28-C42/D04/D05. | P gates/R prior increment reviews; D current inventory/preservation fingerprints. No blocker. |
| V1B-36 | PASS | Public authenticated TCP example, actual acceptance/tools/history/SSE, reconnect/slow clients/shutdown; seven old examples. T29; C09-C18. | P executions and retained example review. No blocker. |
| V1B-37 | PASS | Retained dev/release plus complete loaded/dev sample: acceptance 480.668ms, SSE 97.901ms, four pages 241.969ms, unread completion 2134.706ms, shutdown 144.367ms; full finite resources below. T29; C16/C17/C36. | P complete observations, no SLA/RSS claim. No blocker. |
| V1B-38 | PASS | Synchronized human/JSON 40-row evidence and nine current status documents; source, frozen plans and implementation preserved. D00-D06. | D prior validation and current static/report checks. No blocker. |
| V1B-39 | PASS | Complete local gates/examples and all review gates pass. Exact-head push 35448837331 and pull_request 35448839843 passed six Cargo steps on Ubuntu/macOS/Windows at `6e28cc339f25a95b78170e7c4171de48f122d07a`; three failed attempt pairs are retained. C09-C17/C22/C23/C27-C36/D05/D06. | P/R/H/D; no blocker. |

### Concrete test/source map

The JSON names every test in these groups, so commands can be reproduced with a
Rust name filter without inventing a test count. Representative names below identify
the mechanism; source ranges include the companion cases listed in the JSON.

| Group | Source and representative exact name |
|---|---|
| T01 | `src/http_api/config/tests.rs:16-272`, `strict_config_required_duplicate_unknown_null_fields_and_options` |
| T02 | `src/http_api/token.rs:88-168`, `hmac_verifier_is_fixed_format_redacted_and_loaded_once` |
| T03 | `src/http_api/wire.rs:146-218`, `decimals_preserve_range_and_reject_noncanonical_syntax` |
| T04 | `src/http_api/dto/tests.rs:116-884`, `actual_history_projects_receipts_private_checkpoints_and_terminal_without_result` |
| T05 | `src/http_api/router/tests/boundary_tests.rs:5-390`, `gates_precede_every_storage_open_and_stalled_body` |
| T06 | `src/http_api/router/tests/authority_tests.rs:5-102`, `ipv6_public_default_port_and_actual_listener_authority_over_tcp` |
| T07 | `src/http_api/router/tests/input_tests.rs:8-388`, `mime_encoding_streamed_size_and_body_failures_precede_storage` |
| T08 | `src/http_api/router/tests/metadata_tests.rs:5-399`, `rename_receipt_survives_cleanup_warning_and_failed_or_dropped_refresh` |
| T09 | `src/http_api/router/tests/observation_tests.rs:54-528`, `run_and_operation_reads_distinguish_acceptance_terminal_and_final_result` |
| T10 | `src/http_api/router/tests/run_tests/preparation.rs:14-320`, `preparation_is_blocking_owned_but_dropped_waiter_cannot_dispatch` |
| T11 | `src/http_api/router/tests/run_tests/receipts.rs:25-241`, `typed_evidence_rejects_forged_method_range_and_missing_projections` |
| T12 | `src/http_api/router/tests/run_tests/races.rs:4-192`, `absent_racers_with_different_snapshots_reconcile_once_without_redispatch` |
| T13 | `src/http_api/router/tests/run_tests/failures.rs:4-186`, `accepted_open_identity_install_and_model_failures_are_still_202` |
| T14 | `src/http_api/router/tests/events_tests.rs:69-214`, `sse_wire_cursor_equality_and_unicode_newline_safety` |
| T15 | `src/http_api/router/tests/events_tests/boundaries.rs:5-227`, `sse_commits_at_fixed_page_attach_and_caught_up_boundaries_have_no_gaps` |
| T16 | `src/http_api/router/tests/events_tests/live.rs:115-307`, `sse_only_committed_partial_output_and_reader_loss_never_cancels_host` |
| T17 | `src/http_api/router/events/tests.rs:25-110`, `body_backpressure_holds_only_one_page_and_no_storage_lock` |
| T18 | `src/http_api/serve/tests.rs:185-269`, `public_serve_is_send_reports_actual_address_and_closes_storage` |
| T19 | `src/http_api/serve/tests/network.rs:4-115`, `serving_error_and_unwind_initiate_shutdown_with_live_handler_clones` |
| T20 | `src/http_api/serve/tests/drain.rs:16-185`, `shutdown_awaits_run_sql_before_storage_close` |
| T21 | `src/http_api/serve/tests/loss.rs:12-109`, `worker_loss_preserves_incomplete_outcome_and_quarantine` and ignored `incomplete_child` |
| T22 | `src/cli/serve_cli/tests.rs:65-301`, `handler_signal_success_and_failure_drain_before_return_with_safe_notice` |
| T23 | `src/cli/serve_cli/tests/process.rs:205-535`, `fresh_process_reads_complete_partial_and_unbound_history_without_resume` and ignored `server_child` |
| T24 | `tests/serve_cli.rs:58-210`, `real_serve_port_zero_sigint_sigterm_close_without_profile_or_browser_work` |
| T25 | `src/providers/openai_codex/tests/replay/http_api_joined/fidelity.rs:77-451`, `v1b_26_29_http_websocket_native_recovered_s2_replay_and_reconnect`, plus labelled/missing-MIME SSE variants |
| T26 | `src/providers/openai_codex/tests/replay/http_api_joined/failures.rs:10-225`, `v1b_27_http_sse_wrong_mime_and_missing_mime_empty_id_keep_unknown_without_fallback` |
| T27 | `src/providers/openai_codex/tests/replay/http_api_joined/identity.rs:3-157`, `v1b_28_http_sse_account_x_y_x_records_mismatch_without_history_transmission`, plus WS variant |
| T28 | `src/providers/openai_codex/tests/replay/http_api_joined/ownership.rs:23-295`, `v1b_26_http_websocket_caller_response_and_observer_loss_drain_model_tools_sql`, plus SSE and cancel variants |
| T29 | `examples/http_api_offline.rs:354-886`, `Applied::apply`, `history`, `demonstrate`, `main`; executed example, not test-count entries |
| T30 | `src/http_api/router/tests/run_tests/reducer.rs:295-487`, `v1b_18_reference_reducer_uses_persisted_browser_events`; pure reducer at lines 19-159; registration in `src/http_api/router/tests/run_tests/mod.rs:23` |

T30's exact name is
`http_api::router::tests::run_tests::reducer::v1b_18_reference_reducer_uses_persisted_browser_events`.
The test submits two real HTTP runs and reads committed records through the session
store. It converts those records with `EventView::from` and checks equality with
HTTP history at `src/http_api/router/tests/run_tests/reducer.rs:328-345`.
The reducer assertions at lines 346-465 verify raw user text once, identity-scoped
delta accumulation, item and response replacement, rich blocks OR normalized-text
fallback, exact saved tool output/is_error, reuse without new result/dispatch, and
completion without answer duplication. Reapplying every record preserves state.
Repeated provider response/item/call IDs stay isolated by run. Lines 468-485 assert
event counts, two users, six responses, four tool results and two provider opens.
This is a test-only reference reducer, not a GUI or production behavior change.

## 5. Independent reviews and retained failures

Each completed increment gate had independent **review-a (gpt-5.6-sol:high)**,
**review-b (gpt-5.5:high)** and **review-c (glm-5.3:max)** roles. Three fresh reviewers
with the same role/model assignments then reviewed the complete accumulated diff,
including these reports and every untracked file. All three returned PASS with no
blocking findings. The JSON records scopes and separates review from execution.

| Increment | Scope | Completed gate observed UTC | Result |
|---|---|---|---|
| 1 | Config/token/wire/DTO foundation | 2026-09-18 20:25:31 | Three PASS |
| 2 | Boundary/read/metadata/cancel | 2026-09-18 22:28:01 | Three PASS after confirmed startup-order fix and full repeated gate |
| 3 | Receipt-first task/preparation/races | 2026-09-19 02:17:22 | Three PASS |
| 4 | Committed-history SSE | 2026-09-19 02:51:55 | Three PASS |
| 5 | Serving/transport/host shutdown | 2026-09-19 04:10:37 | Three PASS |
| 6 | CLI/signals/exits/fresh-process reopen | 2026-09-19 04:37:58 | Three PASS |
| 7 | Joined real OpenAI loopback and tools | 2026-09-19 05:27:25 | Three PASS |
| 8 | Offline example and finite resources | 2026-09-19 08:38:21 | Three PASS |
| Final | Complete accumulated diff including these docs and all untracked files | 2026-09-19, after reducer/evidence synchronization | Three PASS; no blocking findings |
| Hosted remediation 1 | Canonical paths and deterministic nonreading-response backpressure | Before `49a956c` | Three PASS; no blocking findings |
| Hosted remediation 2 | APFS fixture limits, Unix socket fixtures and bounded generic watchdog | Before `ccd1403` | Three PASS; no blocking findings |
| Hosted remediation 3 | Exact Windows executable suffix in CLI help test | Before `6e28cc3` | Three PASS; no blocking findings |

Retained first failures and fixes, without counting retries as unique tests:

1. **Increment 2:** initial delegate budget exhaustion followed import errors and
   a Reqwest panic from missing rustls ring provider installation. Continuation
   installed the established test crypto provider and passed focused gates.
2. **Increment 2 review:** ambiguous comma `public_origin` passed config parsing
   and failed only after core startup. Independent investigation confirmed the
   startup-order defect, not an authentication bypass. Config now rejects raw/encoded
   comma authorities; dedicated tests and all three repeated reviews passed.
3. **Increment 3:** budget exhaustion left **55 passed, 2 failed**, plus formatting
   differences. One test still expected 404 for a route now present; correct output
   was static 400. A corruption fixture violated an active foreign key. The fixture
   disables enforcement outside its corruption transaction and restores it before
   HTTP access. Continuation passed 57 focused tests and formatting.
4. **Increment 5:** budget exhaustion left a shutdown-reopen assertion failure and
   formatting differences. `Server::finish` dropped `TempDir` before reopening.
   The fixture now retains the temporary root through post-shutdown assertions.
5. **Increment 7:** module-path compile errors, an incorrect nested-receipt assertion,
   formatting and a fixture with a content type that B2 correctly refuses were fixed.
   The fixture/receipt comparison changed, not core replay policy. Thirteen joined
   tests subsequently passed; the worker-loss parent exercised its child for both transports.
6. **Increment 8:** initial parent-directory discovery hit a **10-second tool timeout**;
   repository-local discovery succeeded. First compile failed **E0117**, fixed with
   a local provider wrapper. Formatting and the first dev execution's nested-receipt
   expectation were corrected to the flattened receipt. Second dev execution passed.
   That failed dev attempt measured acceptance **507.313 ms**, gate **470.586 ms**,
   and gate-release-to-202 **36.731 ms**. No example watchdog expired.
7. **Audit command:** an initial increment-2 `git diff --no-index` directory invocation
   was invalid; the corrected per-file whitespace audit passed. This was not a runtime failure.
8. **Pre-remediation final local batch:** no failed gate. Only the uv `--no-sync`
   warning above. The later complete post-remediation batch also passed.
9. **Documentation validation:** the first D03 attempt stopped at inventory cardinality:
   54 listed paths versus 55 actual implementation files. The report omitted `src/lib.rs`;
   the source file was unchanged. The inventory entry was restored without changing the
   original fingerprint. The second cheap validation attempt passed without changing
   source or weakening a check. The failure remains in D03/F09.
10. **V1B-18 remediation:** focused C22 attempt 1 failed by HTTP watchdog because
    shared fixture request numbering persisted across connections. Resetting
    `script.control.inputs` at `src/http_api/router/tests/run_tests/reducer.rs:310-311`
    fixed attempt 2. The test-only reset changed no production behavior. C23 then
    passed 94 tests/2 ignored; the complete post-remediation gates also passed.
11. **Synchronization audit:** an optional retained-session extraction had an extra
    closing brace and failed with a Node SyntaxError before reading evidence. The
    corrected second extraction recovered the exact focused command/result. This
    was not a runtime or embedded-validation failure.
12. **Synchronization JSON check:** the first narrow parse failed because a report
    edit added an extra row delimiter. Two exact replacement attempts did not match
    and made no change. Corrected delimiters passed D06. F12 retains this failure.
13. **Hosted attempt 1:** push `35440634030` and pull_request `35440636096` failed
    macOS and Windows Cargo tests at `85c8d7504c87cfaf419aa4e8a69e2c3d2e258768`.
    macOS exposed `/var` versus `/private/var` canonicalization; both platforms exposed
    a test hook that waited for more than 1 MiB although backpressure occurred earlier.
    Canonical expectations and deterministic finite backpressure fixed both causes.
14. **Hosted attempt 2:** push `35445158998` and pull_request `35445160488` failed
    at `49a956ca28ce4b50ae386b12719b491246252806`. APFS returned EILSEQ before an
    invalid-UTF8 fixture could be created. Windows buffered socket fixtures differently,
    and slow generic HTTP work exceeded 15 seconds. The invalid-name proof remains where
    supported; Unix/macOS retain socket proofs; a tested 60-second watchdog keeps generic
    Windows coverage bounded.
15. **Hosted attempt 3:** push `35447171227` and pull_request `35447174195` passed
    Ubuntu/macOS but failed Windows at `ccd1403b92f2ee4b1d053bbacf9f353680f0d00b`.
    The exact CLI help test expected `wi`, while the real executable is `wi.exe`.
    Platform `EXE_SUFFIX` now preserves full-line equality.
16. **Hosted attempt 4:** push `35448837331` and pull_request `35448839843` passed
    all six Cargo steps on Ubuntu, macOS and Windows at
    `6e28cc339f25a95b78170e7c4171de48f122d07a`. Job IDs and exact steps are in JSON.

Historical V1-A first-attempt watchdog failures remain reliability observations.
No failure record, job, lint or assertion was removed to obtain a green result.

## 6. Final finite performance observations

All timings are milliseconds. P's unchanged dev/release samples are C16/C17.
The complete **post-remediation loaded/dev rerun C36** supplies every current loaded
value below. Production/example code did not change. These are three finite sample
modes, not three new example runs during this documentation synchronization.

| Observation | dev | release | loaded/dev |
|---|---:|---:|---:|
| Acceptance including fixture gate | 527.053 | 281.993 | 480.668 |
| Preacceptance validation gate | 491.496 | 260.822 | 447.420 |
| Gate release to HTTP 202 | 35.563 | 21.223 | 33.224 |
| Commit acknowledgment to SSE visibility | 109.484 | 47.809 | 97.901 |
| Fixed-head page reads | 275.581 | 147.466 | 241.969 |
| Number of fixed-head pages | 4 | 4 | 4 |
| Shutdown: original host plus HTTP drain | 139.351 | 73.084 | 144.367 |
| Mean authentication rejection | 1.046 | 0.332 | 1.002 |
| Mean empty HTTP poll | 81.818 | 45.432 | 259.005 |
| Mean SQLite probe open/query/close | 1.291 | 0.986 | 1.636 |
| Unread clients to exact completion | 2270.388 | 1097.612 | 2134.706 |

| Finite resource observation | dev | release | loaded |
|---|---:|---:|---:|
| Backlog records / text bytes | 4 / 262144 | 4 / 262144 | 40 / 10485760 (10 MiB) |
| Reader workers | 1 | 1 | 4 |
| Authentication rejects / empty polls | 4 / 4 | 4 / 4 | 64 / 64 |
| SQLite probes opened / closed | 4 / 4 | 4 / 4 | 16 / 16 |
| Catalog bytes before / after shutdown | 102400 / 102400 | 102400 / 102400 | 299008 / 299008 |
| Session bytes before / after shutdown | 495616 / 577536 | 495616 / 577536 | 10952704 / 11034624 |
| Catalog WAL / session WAL before and after | 0 / 0 | 0 / 0 | 0 / 0 |
| Tracked TCP connections closed | 3 | 3 | 3 |
| Server HTTP drained | true | true | true |
| Peak decoded client-held records / retained SSE record | 6 / 1 | 6 / 1 | 6 / 1 |

Additional C36 observations: backlog setup **10625.400 ms**, reader window
**4316.229 ms**, final history **301.563 ms**; final sequence **19**, exact tool
result **1**, answer **1**, duplicate **1**. SSE buffer peak **704 bytes**; unread
clients retain **0 decoded records**, not zero network-buffer bytes
(`examples/http_api_offline.rs:753-756`). Scripted provider connections
opened/closed **2/2**; socket drain discarded **3589769 bytes**.
All three tracked sockets closed and HTTP drained.

Historical C18 is retained separately in `historical_performance`: acceptance
613.353 ms, preacceptance gate 554.072 ms, gate-to-202 59.294 ms, shutdown 130.582 ms,
auth rejection mean 0.972 ms, empty poll mean 257.932 ms and SQLite probe mean
1.572 ms. That pre-remediation excerpt omitted full visibility/page values.
C36 replaces the active loaded sample; it does not reconstruct the missing C18
values or erase the earlier successful run. The old excerpt gap is no longer a
current V1B-37 blocker.

Earlier increment-8 completed samples separately reported six decoded client-held
records, one retained SSE record, a 704-byte SSE buffer peak, three tracked sockets
closed and two scripted provider connections opened/closed for each mode. Those are
**prior attributed observations**, not additional latest-run values or new tests.

Timing samples vary. Acceptance includes the deliberate validation gate. Visibility
is a client observation after commit acknowledgment, not a provider latency estimate.
Polling includes HTTP and operation-scoped SQLite open/validate/read/close costs.
The independent SQLite probe is not a count or isolated timing of every server SQL
operation. Three tracked socket closures are not an all-process connection census.
Client-held records measure this finite client, not server RSS. Point-in-time WAL zero
is not zero transient WAL. None of these values is an SLA, constant-RSS guarantee,
benchmark comparison, task quota or lifetime history cap.

## 7. Remaining boundaries and authorization

- **V1B-03/33:** Windows reparse-point token proof and native Windows Ctrl+C remain
  intentionally deferred. Linux and hosted macOS have positive Unix token/signal
  coverage. Passing Windows Cargo jobs do not execute these omitted subcases.
- **V1B-39:** three fresh final complete-diff reviews passed. Exact-head push
  `35448837331` and pull_request `35448839843` passed all six Cargo steps on
  Ubuntu/macOS/Windows at `6e28cc339f25a95b78170e7c4171de48f122d07a`.
  Three earlier failed run pairs and their remediations are retained below.
- One owner token authorizes all service operations/history. Rotation changes the
  file and restarts the service, revoking all devices together. There is no device
  identity/expiry/revocation system, cookie login or supplied browser token storage.
- Only literal-loopback HTTP is allowed. A trusted same-host HTTPS proxy must use
  valid TLS, preserve Authorization/Origin, send an allowed Host and disable SSE
  buffering/caching. Origin configuration does not prove TLS. No proxy or remote
  browser/device was deployed or validated. EventSource token-URL workarounds are
  not supported; use authenticated fetch with an SSE parser.
- Closed projections exclude internal metadata, not secrets volunteered in visible
  conversation text. Unknown native content is unsupported, not rendered arbitrarily.
  Catalog pages remain as-of indexes; canonical reads and explicit refresh are separate.
- Same-user processes, ancestor replacement/hardlinks, caller-owned Windows ACLs,
  physical power loss and Internet-edge/DDoS hardening are outside this evidence.
- No GUI, native TLS, deployment, automatic task resumption, generation retry/failover,
  replacement budget, lifetime history cap, new store/schema/executor/provider or
  ordinary `wi run` persistence is included.

See [API/CLI configuration](API.md#0-starting-the-service) and
[security/operator guidance](SECURITY.md) for exact behavior and provisioning.
No acceptance, live-provider approval, release, merge or deployment is authorized.

## 8. Documentation validation

Prior D01/D02 passed config/provisioning syntax, active statuses and diff whitespace.
Prior D03 passed on attempt 2 after the inventory correction, including 167 local
links/anchors. At that historical check, V1B-38 was still pending (34 PASS/6 PARTIAL);
the observed pass produced the then-current 35 PASS/5 PARTIAL. F09 retains its failure.
Those counts are historical, not the synchronized disposition.

Current D04 passed static-only inventory (296/844/25), without Cargo. D06 passed
JSON parsing and the then-current 37/3 count expectations; F12 retains the first
narrow JSON syntax failure. D05 passed at the pre-push 37 PASS/3 PARTIAL snapshot.
This hosted synchronization updates expectations to **38 PASS/2 PARTIAL**, validates
all retained CI attempts and job metadata, and uses the 395-file preservation
fingerprint while permitting only current documentation descendants of the tested head.
The exact D05 command is recorded in `verification.json.commands`. It extracts this
read-only script and runs it with Node; it does not generate tokens or execute
Cargo/tests/examples. The script checks exact row IDs/dispositions/blockers, command
batches and source/test references, links, syntax, numeric/status consistency,
source-definition counts, canaries, current implementation/frozen/preserved
fingerprints, tested-revision ancestry, docs-only descendants/worktree and unchanged staging.
External URLs are not probed; local link checks are not hosted-service reads.

Validation script, starting at the `const fs` line below:

<!-- validation-script -->
```javascript
const fs = require("node:fs"), path = require("node:path");
const cp = require("node:child_process"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const read = p => fs.readFileSync(p, "utf8");
const git = args => cp.execFileSync("git", args).toString();
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const fingerprint = files => hash([...files].sort().map(p => p + "\0" + hash(fs.readFileSync(p)) + "\n").join(""));
const reportPath = "docs/slices/v1b/verification.json";
const r = JSON.parse(read(reportPath));
const human = read("docs/slices/v1b/VERIFICATION.md");
const docs = ["AGENTS.md", "README.md", "CHANGELOG.md", "docs/README.md", "docs/slices/README.md", "docs/slices/v1b/API.md", "docs/slices/v1b/SECURITY.md", "docs/slices/v1b/VERIFICATION.md", reportPath];
for (const k of ["schema_version", "contract", "baseline", "tested_revision", "tested_worktree", "status", "accepted", "matrix", "commands", "reviews", "findings", "ci", "performance", "limitations", "live_started", "real_credential_reads", "provider_generations", "ledger"]) assert(Object.hasOwn(r, k), k);
assert.equal(r.schema_version, 1);
assert.equal(r.contract, "v1b.0");
assert.equal(r.baseline, "16d623a3317abc7796ec203e4fe15d580791a769");
assert.equal(r.tested_revision, "6e28cc339f25a95b78170e7c4171de48f122d07a");
assert.equal(r.status, "LOCAL_VERIFIED");
assert.equal(r.accepted, false);
assert.equal(r.live_started, false);
assert.equal(r.real_credential_reads, 0);
assert.equal(r.provider_generations, 0);
assert.deepEqual(r.ledger, {used:31, cap:50, remaining:19, changed:false});
const ids = Array.from({length:40}, (_, i) => "V1B-" + String(i).padStart(2, "0"));
assert.deepEqual(r.matrix.map(x => x.id), ids);
const commands = new Set(r.commands.map(x => x.id));
assert.equal(commands.size, r.commands.length);
for (const c of r.commands) assert(c.command.length && c.observer.length && c.result.length, c.id);
const batched = r.command_batches.flatMap(b => b.command_refs);
assert.deepEqual([...batched].sort(), Array.from({length:42}, (_, i) => "C" + String(i + 1).padStart(2, "0")));
for (const batch of r.command_batches) {
  for (const c of batch.command_refs) assert(commands.has(c), c);
  if (batch.phase === "hosted_remediation_final_local") assert.equal(batch.implementation_sha256, r.tested_worktree.implementation_sha256);
}
const humanRows = [...human.matchAll(/^\| (V1B-\d\d) \| (PASS|PARTIAL) \|/gm)].map(m => [m[1], m[2]]);
assert.deepEqual(humanRows, r.matrix.map(x => [x.id, x.status]));
for (const row of r.matrix) {
  for (const k of ["status", "assertions", "tests", "command_refs", "observer", "blockers"]) assert(Object.hasOwn(row, k), row.id + " " + k);
  assert(row.assertions.length && row.observer.length && row.command_refs.length, row.id);
  assert(["PASS", "PARTIAL"].includes(row.status), row.id);
  assert.equal(row.blockers.length > 0, row.status === "PARTIAL", row.id);
  for (const c of row.command_refs) assert(commands.has(c), c);
  for (const t of row.tests) assert(Object.hasOwn(r.test_catalog, t), t);
}
assert.deepEqual(r.matrix.filter(x => x.status === "PARTIAL").map(x => x.id), ["V1B-03", "V1B-33"]);
assert.equal(r.ci.length, 2);
assert(r.ci.every(c => c.status === "PASS" && c.head === r.tested_revision && c.jobs.length === 3 && c.steps.length === 6));
assert.deepEqual(r.ci_attempts.map(x => x.status), ["FAIL", "FAIL", "FAIL", "PASS"]);
assert.deepEqual(r.ci_attempts.map(x => x.head), ["85c8d7504c87cfaf419aa4e8a69e2c3d2e258768", "49a956ca28ce4b50ae386b12719b491246252806", "ccd1403b92f2ee4b1d053bbacf9f353680f0d00b", r.tested_revision]);
const finalReview = r.reviews.find(x => x.scope.startsWith("Final"));
assert.equal(finalReview.status, "PASS");
assert.deepEqual(finalReview.roles, ["review-a", "review-b", "review-c"]);
assert.deepEqual(finalReview.reviewers, ["gpt-5.6-sol:high", "gpt-5.5:high", "glm-5.3:max"]);
assert(finalReview.result.includes("All three fresh final reviews passed"));
for (let i = 1; i <= 8; i++) assert.equal(r.reviews.find(x => x.increment === i).roles.length, 3);
const pass = r.matrix.filter(x => x.status === "PASS").length;
assert.equal(r.counts.matrix_rows, 40);
assert.equal(pass, 38);
assert.equal(r.counts.matrix_pass, 38);
assert.equal(r.counts.matrix_partial, 2);
assert.equal(r.counts.library_passed, 581);
assert.equal(r.counts.library_failed, 0);
assert.equal(r.counts.library_ignored, 8);
assert.equal(r.counts.doc_tests, 0);
assert.equal(r.counts.node_self_tests_passed, 152);
assert.equal(r.counts.existing_example_runs, 7);
assert.equal(r.counts.http_example_samples, 3);
assert.equal(r.counts.post_remediation_loaded_reruns, 1);
assert(human.includes(`**${pass} PASS, ${40-pass} PARTIAL, 40 rows**`));
for (const t of Object.values(r.test_catalog)) {
  const source = read(t.source);
  for (const name of t.names) assert(source.includes("fn " + name + "("), t.source + " " + name);
  const [first, last] = t.lines.split("-").map(Number);
  assert(first > 0 && last >= first && last <= source.split("\n").length, t.source);
  for (const ref of t.supporting_sources || []) {
    const lines = read(ref.source).split("\n"), [start, end] = ref.lines.split("-").map(Number);
    assert(start > 0 && end >= start && end <= lines.length, ref.source);
  }
}
const reducer = r.test_catalog.T30;
assert.equal(reducer.exact_name, "http_api::router::tests::run_tests::reducer::" + reducer.names[0]);
assert(read("src/http_api/router/tests/run_tests/mod.rs").includes("mod reducer;"));
assert(r.commands.find(c => c.id === "C22").command.includes(reducer.exact_name + " -- --exact --nocapture"));
assert.deepEqual(r.commands.find(c => c.id === "C22").attempts.map(a => a.status), ["FAIL", "PASS"]);
const sources = ["src", "tests", "examples"].flatMap(dir => fs.readdirSync(dir, {recursive:true}).filter(p => p.endsWith(".rs")).map(p => path.join(dir, p)));
const definitions = sources.flatMap(p => [...read(p).matchAll(/#\[(?:tokio::)?test\]\s*(?:async\s+)?fn\s+(\w+)/g)].map(m => m[1]));
assert.equal(sources.length, 296);
assert.equal(r.counts.source_files, sources.length);
assert.equal(definitions.length, 844);
assert.equal(new Set(definitions).size, definitions.length);
assert.equal(r.counts.rust_test_regex_definitions, definitions.length);
const fixtures = fs.readdirSync("tests/fixtures").filter(p => p.endsWith(".jsonl")).flatMap(p => read("tests/fixtures/" + p).trim().split("\n").map(line => JSON.parse(line)));
assert(fixtures.every(x => typeof x.type === "string"));
assert.equal(fixtures.length, 25);
assert.equal(r.counts.fixture_events, fixtures.length);
assert.deepEqual(r.performance.map(p => p.label), ["dev", "release", "loaded/dev"]);
assert.deepEqual(r.performance.map(p => p.command_ref), ["C16", "C17", "C36"]);
for (const p of r.performance) {
  assert(commands.has(p.command_ref));
  for (const [k, v] of Object.entries(p)) if (k.endsWith("_ms") && v !== null) assert(human.includes(v.toFixed(3)), p.label + " " + k);
  assert(p.commit_ack_to_sse_ms > 0 && p.fixed_head_pages_ms > 0 && p.fixed_head_pages === 4, p.label);
  for (const phase of [p.db_before, p.db_after]) for (const v of Object.values(phase)) assert(human.includes(String(v)));
}
const loaded = r.performance.find(p => p.label === "loaded/dev");
assert.equal(loaded.unread_client_records, 0);
assert(!Object.hasOwn(loaded, "sse_unread_bytes"));
assert(read("examples/http_api_offline.rs").includes("unread_client_records=0"));
assert(!r.findings.some(f => ["L18", "L37"].includes(f.id)));
for (const p of docs.slice(0, 7)) assert(read(p).includes("LOCAL_VERIFIED") && read(p).includes("accepted=false"), p);
const api = read("docs/slices/v1b/API.md");
const config = JSON.parse(api.match(/```json\n([\s\S]*?)\n```/)[1]);
assert.deepEqual(Object.keys(config).sort(), ["schema_version","listen","public_origin","data_root","client_token_file","global_skills_root","workspaces","model","instructions","provider_transport","account","enable_add_numbers"].sort());
assert.equal(config.schema_version, 1);
assert.equal(config.account, null);
const recipe = read("docs/slices/v1b/SECURITY.md").match(/python -c '(.*)' \/absolute\/private\/wi-owner-token/)[1];
cp.execFileSync("uv", ["run", "--no-project", "python", "-c", "import ast,sys; ast.parse(sys.argv[1])", recipe]);
function slug(s) { return s.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /g, "-"); }
let links = 0;
for (const p of docs.filter(p => p.endsWith(".md"))) {
  const body = read(p).replace(/```[\s\S]*?```/g, "");
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = m[1];
    if (/^[a-z]+:/i.test(target)) continue;
    const [file, anchor] = target.split("#");
    const dest = file ? path.resolve(path.dirname(p), decodeURIComponent(file)) : path.resolve(p);
    assert(fs.existsSync(dest), p + " link " + target);
    if (anchor && dest.endsWith(".md")) {
      const headings = [...read(dest).matchAll(/^#{1,6} (.+)$/gm)].map(x => slug(x[1]));
      assert(headings.includes(decodeURIComponent(anchor)), p + " anchor " + target);
    }
    links++;
  }
}
const impl = r.tested_worktree.implementation_paths;
assert.equal(new Set(impl).size, 56);
assert.equal(r.tested_worktree.implementation_files, 56);
assert.equal(fingerprint(impl), r.tested_worktree.implementation_sha256);
assert(human.includes(r.tested_worktree.implementation_sha256));
const preserved = git(["ls-files", "-z"]).split("\0").filter(p => p && !docs.includes(p));
assert.equal(preserved.length, r.tested_worktree.synchronization_preserved_file_count);
assert.equal(fingerprint(preserved), r.tested_worktree.synchronization_preserved_sha256);
assert(human.includes(r.tested_worktree.synchronization_preserved_sha256));
const frozen = git(["ls-files", "-z", "docs"]).split("\0").filter(p => p && !docs.includes(p));
assert.equal(frozen.length, r.tested_worktree.frozen_document_count);
assert.equal(fingerprint(frozen), r.tested_worktree.frozen_documents_sha256);
assert(human.includes(r.tested_worktree.frozen_documents_sha256));
cp.execFileSync("git", ["merge-base", "--is-ancestor", r.baseline, r.tested_revision]);
cp.execFileSync("git", ["merge-base", "--is-ancestor", r.tested_revision, "HEAD"]);
const descendant = git(["diff", "--name-only", r.tested_revision + "..HEAD"]).trim().split("\n").filter(Boolean);
assert(descendant.every(p => docs.includes(p)), descendant.join(","));
assert.equal(git(["diff", "--cached", "--name-only"]), "");
const changed = git(["status", "--porcelain=v1", "--untracked-files=all", "-z"]).split("\0").filter(Boolean).map(x => x.slice(3));
assert(changed.every(p => docs.includes(p)), changed.join(","));
const canaries = new Set();
for (const p of impl.filter(p => p.endsWith(".rs"))) {
  const s = read(p);
  for (const m of s.matchAll(/const\s+(?:TOKEN|SYNTHETIC|PRIVATE|PROVIDER_SESSION)\s*:\s*&str\s*=\s*"([^"]+)"/g)) canaries.add(m[1]);
  for (const m of s.matchAll(/"((?:private[-_]|PRIVATE_)[^"\r\n]+)"/g)) if (m[1].length > 8) canaries.add(m[1]);
}
for (const p of docs) {
  const text = read(p);
  for (const secret of canaries) assert(!text.includes(secret), p + " synthetic secret/path leak");
  assert(!/Bearer [a-f0-9]{64}/.test(text), p + " literal bearer");
  assert(text.endsWith("\n"), p + " missing final newline");
}
for (const p of changed) assert(!read(p).split("\n").some(line => /[ \t]+$/.test(line)), p + " trailing whitespace");
const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
for (const p of untracked) assert(read(p).endsWith("\n"), p + " missing final newline");
assert.equal(untracked.filter(p => impl.includes(p)).length, 0);
console.log(`PASS: schema; 40 ordered unique rows (${pass} PASS/${40-pass} PARTIAL); test/command/source references; ${links} local links/anchors; config/recipe syntax; 296 source files/844 regex definitions/25 fixture events; CI attempts/jobs; numeric/status consistency; canary/whitespace scans; tested implementation/frozen/preserved fingerprints; allowed docs-only descendant/worktree; no staged changes.`);
```
<!-- end-validation-script -->
