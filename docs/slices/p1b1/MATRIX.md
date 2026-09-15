# P1-B1 acceptance matrix

Contract **p1b1.0**. Baseline `34b4cfd0d3ecf286869a239997267dbd75c28c0b`.
All **30 rows P1B1-00 through P1B1-29 are NOT RUN**.
CONTRACT.md fixes behavior; VALIDATION.md distinguishes existing source from changes.
B1 is real runtime capture, not provider-history restoration or service acceptance.

## Fixtures and observation rules

Use real bundled SQLite in fresh private temporary roots. Use the actual public
context/registry/controller paths plus a separate scripted Provider. Loopback OpenAI
adapters use existing test-only endpoints and synthetic credentials. No actual account,
owner skill, provider traffic, login or refresh. Test authors must not execute current
live examples or claim the host Pi conversation is Wi verification.

- T: final text with no tools; also empty/refusal/reasoning-only final variants.
- A: one real add_numbers result and a final42 response.
- B: two sequential arithmetic cycles and final50.
- S: S2 catalog -> real load_skill -> ordinary tool -> final response.
- E: real tools returning ToolFailed, oversized output, and valid error-shaped Ok.
- P: controlled provider/tool futures and storage transaction barriers.
- R: same UUID operation/run/input repeated before, during and after work and restart.
- U: synthetic native-terminal/recovered-output/provenance and malformed provider cases.

Use actual execution counters separately from start events. An emitted tool-start is
not proof that execute was polled. Inspect real SQLite records from another connection
at effect boundaries, and actual submitted InputItem vectors. Fake helpers cannot
manually fabricate the transcript whose fidelity they purport to test.

Tests may exercise crate-private cfg(test) barriers/faults. No runtime environment
failpoint, public arbitrary SQL access, extra production worker or installed dependency.
Parent/child fixtures clean only their own temporary roots and verify child exit before
removal. Preserve platform-specific guards and previous macOS/Windows regressions.

## Required cases

| ID | Requirement | Concrete acceptance oracle | Initial status |
|---|---|---|---|
| P1B1-00 | Baseline and scope | Record actual HEAD/ancestry/dirty and untracked paths, toolchain and old gates. Master baseline has P1-A, not this composition. Preserve reports/ledger. No missing counts replaced with old totals. | NOT RUN |
| P1B1-01 | One shared loop and API | New execution::run_persisted drives real existing orchestration; no duplicate drive loop. Old run signature and FnMut callback with a non-Send Rc capture still compile/work. New persisted future satisfies Send and runs in an explicitly owned Tokio task. No public observer/plugin framework. | NOT RUN |
| P1B1-02 | Real snapshot and registry pairing | Capture actual S1 and S2 PreparedRun/registry data. Exact tool definitions match all fields and order; mismatch rejects before acceptance/provider work. Original task, prepared prompt, instructions, frontmatter/provenance and definitions are stored unchanged without rereading files. | NOT RUN |
| P1B1-03 | Shared pre-admission validation | New empty/invalid/oversized input/options, unknown provider, unsupported requested features/transport, caller tools, registry mismatch and pre-cancellation create zero acceptance/run events and zero provider opens/tool executes. Session-read activity is not model work. Use existing error codes. | NOT RUN |
| P1B1-04 | Receipt-first duplicates | Identical operation/run/input returns Duplicate with original acceptance and current RecordedRun, both while active and after terminal/restart. It performs zero new core events, provider opens or tool dispatches even with unavailable current provider or cancelled token. Different payload/method/run ID under that operation conflicts, not silently reused. | NOT RUN |
| P1B1-05 | Concurrent submission | Two same-ID calls that race through the initial absent lookup yield exactly one Executed and one Duplicate, with one real open/execution. Distinct new run IDs in the same session preserve active_run_exists; different sessions progress independently. No new queue or UUID rewriting. | NOT RUN |
| P1B1-06 | Accepted identity and sequencing | Acceptance commits before RunStarted/provider open. Runtime UUID equals caller RunId throughout results/events/tool rows. Application session sequence spans records; nested run/provider identities and source sequences remain unchanged. Rename interleaving remains ordered without changing source sequence. | NOT RUN |
| P1B1-07 | Real successful loops | T/A/B execute through actual shared core and registry. Saved initial input, every actual event, exact tool results, and actual RunResult match observed values. A has one open/two requests/one execution; B one open/three requests/two executions. Storage never fabricates provider or tool events. | NOT RUN |
| P1B1-08 | Incremental committed visibility | Hold actual SQLite event transaction before commit: another history read cannot observe it. Release commit, hold provider before completion: partial text is already readable and correctly ordered. No full-run buffering or precommit observer callback. Committed partial text remains after failed/cancelled execution. | NOT RUN |
| P1B1-09 | Native/effective fidelity | U stores native terminal values, effective recovered output/provenance, usage, Unicode/control strings, item indexes and unknown opaque data without reconstruction or native JSON rewrite. No provider-native values enter ordinary Debug/errors. Compare parsed native JSON and exact string values, not transport whitespace. | NOT RUN |
| P1B1-10 | Full preflight and durable intent | Invalid mixed batches execute zero tools and persist no new ToolExecutionStarted/result. A valid terminal response commits before dispatch intent, and intent commits before Tool::execute is polled. Cancellation during intent commit leaves real committed intent but zero effect. Partial/nonterminal calls remain non-executable. | NOT RUN |
| P1B1-11 | Actual serialized result boundary | Real success, ToolFailed->gateway_error, oversized->tool_output_limit and valid error-shaped Ok produce the original exact output and observed is_error. Result commit occurs after serialization/cache and before finish/next model request. Error-shaped Ok remains is_error=false; never infer the flag by parsing JSON. | NOT RUN |
| P1B1-12 | Reuse and scoped identity | Reuse the same call after a skill file changes/deletes: saved bytes reused, one execute/read, current reuse event recorded, no second ToolResult record. Original request ID is retained in the saved result; later runtime request remains its own identity. Conflicts reject; another run using the same call_id has a fresh cache and independent rows. | NOT RUN |
| P1B1-13 | Cancellation across commit boundaries | Cancel during acceptance, intent commit, pending tool, completed-result commit and provider wait with deterministic barriers. Admitted SQL drains rather than being assumed rolled back. No later tool/request. Completed real results survive cancellation; no fabricated pending result. Final no-call completion still wins where the existing controller selects it. | NOT RUN |
| P1B1-14 | Execution versus final observation | Inject final RunFinished persistence failure after actual completion: returned failure preserves observed Completed RunResult and sink failure, without claiming durable completion. Inject final RunResult-record failure after RunFinished committed: stored run stays completed, failure reports the final-record operation ID. No second synthetic terminal or changed outcome. | NOT RUN |
| P1B1-15 | Provider failures and terminal outcomes | Record ordinary session-open/provider errors, incomplete/failed/cancelled model outcomes and explicit local cancellation through the current real error paths. When storage succeeds, result is Executed with the true RunOutcome, not a persistence error. Preserve not_submitted/unknown/terminal_received and no tool effects on invalid output. | NOT RUN |
| P1B1-16 | Storage failure stages and ambiguity | Real SQL constraints/busy plus labelled test injections cover lookup/accept/runtime/result/final phases, both commit_unknown outcomes and dropped DB waiters. The first failure retains stage/operation/receipt/observed result; no writer retry, replay, extra provider request or fake rollback. Caller lookup can confirm a commit but cannot restart work. | NOT RUN |
| P1B1-17 | Cleanup warnings | Committed acceptance with close warning starts no provider. An intermediate committed observation plus cleanup warning stops future work without denying the commit. Final RunResult commit plus warning returns known committed completion with warning. Existing root quarantine/unlock policy remains; warnings never silently disappear. | NOT RUN |
| P1B1-18 | Store close and execution ownership | New crate-private lifecycle hold keeps root ownership while model/tool work awaits, without any DB/session/maintenance lock held across it. Store close signals local cancellation, rejects new writes, waits for execution plus admitted SQL, then healthy unlock. Second owner cannot acquire early; no deadlock with concurrent read/repair/close. | NOT RUN |
| P1B1-19 | Owning-future drop/panic | Never-polled future has zero acceptance/effects. In an isolated child, abort/drop after acceptance or while actual work waits closes the core provider and conservatively retires/quarantines the unfinished hold; no fabricated return/terminal and no early racing store owner. Already admitted SQL retains its own drain protection. Process death releases lease. Do not equate this with client disconnect. | NOT RUN |
| P1B1-20 | Fresh-process history and no resumption | Real persisted P traces interrupted after accepted input, partial text, tool intent and tool-result commit survive fresh-process opening. P1-A interruption runs once, terminal states stay unchanged, and constructors/executions/continuation counts on reopen are zero. Duplicate old submissions remain Duplicate. | NOT RUN |
| P1B1-21 | Backpressure and no silent loss | Exercise synthetic event bursts/slow storage against current provider queue/consumer/final-slot behavior. All claimed committed observations exist once in order; a provider closure/failure is surfaced truthfully with no retry or false successful continuation. Include a successful ordinary trace and a deterministic pressure/failure case. No timeout/queue capacity changes or hidden buffering. | NOT RUN |
| P1B1-22 | Actual WebSocket integration | Use public persisted path, real OpenAI loopback adapter and actual registry. One socket, two frames, correct previous_response_id/new-result-only continuation; original accepted input and actual committed tool bytes asserted at send. Native terminal and finalized-item recovery remain valid. Synthetic credentials only. | NOT RUN |
| P1B1-23 | Actual SSE integration | The same persisted path uses two HTTP requests and exact effective native-history replay, including initial context and committed correlated result. Cover labelled and existing missing-MIME admission; malformed identity/failed admission keeps established errors/uncertainty. No transport fallback. | NOT RUN |
| P1B1-24 | Actual S2 loading | Nonempty global/project catalog advertises load_skill automatically. Unselected body is absent initially, actual main file loads once, exact final serialized instructions persist before follow-up input. Same-name scopes and error/reuse behavior retain S2. No resource/script execution, model selector or snapshot reread. | NOT RUN |
| P1B1-25 | Independent observation and sessions | Cancel/drop a concurrent history-page reader while the backend-owned execution future remains retained: run continues. A second reader can recover committed history/current state. Two sessions isolate inputs/results and writes; no browser observer is wired to the critical persistence error path. Rename remains valid during recorded execution. | NOT RUN |
| P1B1-26 | Errors, privacy and receipt bounds | Actual failure Debug/Display shows static categories/stages only; sensitive inputs/results/native/path canaries absent. No new GatewayError/storage code mapping. Only current failed operation and returned receipts retained, not all events/receipts for the run. The actual source output/result is inspectable through explicit APIs. | NOT RUN |
| P1B1-27 | Existing contract and nonintegration | Old run/CLI/registry/context/auth/provider tests remain with their assertions, including non-Send callback and cancellation ordering. Storage schemas/version1, run schema2/provider schema1, input capacities and C1 deletion unchanged. No normal CLI persistence, history seed, new provider/account policy, dependency, queue/scheduler or V1 claim. | NOT RUN |
| P1B1-28 | Example, docs and measurements | New persisted_run_offline uses actual public composition/controller/tools/SQLite, incremental read, final saved result and reopen with no provider work. Existing four examples pass. Record finite per-observation/end-to-end timings and actual connection/transaction counts, including dev/release mode and stored sizes. No fastest/SLA assertion. Docs identify B1 versus B2 and V1. | NOT RUN |
| P1B1-29 | Full review and closure | Run the full command set; independent fresh complete-diff review covers newly tracked and untracked code, legacy adapters, persistence/fault/cancel ordering and ownership. Every ID maps to actual evidence. Exact submitted-head cross-platform CI is required after separately authorized push. Preserve failures and report genuinely unrun coverage. | NOT RUN |

## Execution gates

Use synthetic HOME/XDG_CONFIG_HOME/CODEX_HOME and data/workspace roots while preserving
trusted toolchain caches. Do not inherit API-key variables into tests. No dependency
changes are expected; raise a concrete contradiction before altering Cargo files.

```text
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
cargo run --example skill_loading_offline
cargo run --example storage_offline
cargo run --example persisted_run_offline
git diff --check
```

P1-A's 536 Rust tests, one ignored child helper and 152 Node tests are historical
reference counts, not target results. Existing Cargo CI does not execute Node self-tests
or example mains. Record actual passed/failed/ignored/filtered/platform-excluded counts
and source definitions separately. Zero doctests remains zero substantive coverage.

After an authorized push, inspect push and PR workflows on the EXACT submitted head,
including every Ubuntu/macOS/Windows step. Fix platform fixtures narrowly; do not disable
jobs/lints or mark a failed fixture as an allowed pass. A changed docs head needs its own
required checks. Keep no-live boundaries and ledger unchanged at 31/50.

## Required verification reports

Create VERIFICATION.md and verification.json only from observed implementation work.
Leave this matrix's plan-time NOT RUN statuses intact.

Human report must cover baseline/worktree/contract, changed files, shared-loop/adapter
proof, actual persistence and effect ordering, result/string provenance, failure table,
store-close/future-drop behavior, all 30 rows with test oracles, first failures/fixes,
commands/totals, loopback and process evidence, timings, independent reviews and limits.
State plainly that B2 restoration, the ordinary CLI's persistent session interface and
V1 are not delivered. Tests do not establish actual model adherence or physical power
loss. Preserve earlier P1-A failures and accepted evidence.

Machine report minimum:

```json
{
  "contract": "p1b1.0",
  "status": "NOT_RUN",
  "accepted": false,
  "baseline": "34b4cfd0d3ecf286869a239997267dbd75c28c0b",
  "tested_revision": null,
  "tested_worktree": null,
  "environment": {},
  "matrix": [],
  "commands": [],
  "ordering_evidence": [],
  "failure_and_drop_cases": [],
  "performance_observations": [],
  "reviews": [],
  "submitted_ci": [],
  "limitations": [],
  "actual_runtime_recording_implemented": false,
  "normal_cli_persistence_implemented": false,
  "provider_history_restoration_implemented": false,
  "service_implemented": false,
  "live_started": false,
  "real_credential_reads": 0,
  "provider_generations": 0,
  "ledger": {"used":31,"cap":50,"remaining":19,"changed":false}
}
```

Each ID appears exactly once with status, observer, tests, concrete assertions, source
and command references, and blockers. Do not label authoring a test as executing it.
No commit/push/merge/release/deployment or later-slice authority follows from acceptance.
