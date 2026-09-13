# P1-A acceptance matrix

Contract **p1a.0**, runtime baseline `dd720c0e66eceaaea831ad03e489656f77fc1cec`.
All **32 rows P1A-00 through P1A-31 are NOT RUN**. CONTRACT.md and SCHEMA.md are the
fixed requirements. VALIDATION.md distinguishes source observations from new design.
This is not authority to implement P1-B, launch providers, or port wi-old wholesale.

## Evidence and fixtures

Use real bundled SQLite in private temporary roots, never owner storage or credentials.
Keep trusted toolchain caches available but remove provider API-key environment data
and redirect HOME/XDG_CONFIG_HOME/CODEX_HOME for subprocess checks. Unit/source-derived
fixtures may use existing DTOs, S2 context preparation and pure synthetic ToolRegistry
execution to obtain real serialized values; the STORAGE layer itself must never call
those executors or a provider. No live test is needed.

Fixtures: two separate installations A/B; several sessions with renamed and same-name
titles; synthetic workspaces and global/project skills; UUID operation/run IDs; a
complete ordinary runtime trace; real registry success/gateway_error/tool_output_limit
outputs; a final RunResult with events_complete=false; partial text; missing/foreign/
future-schema stores; old-instance nonterminal records; immutable replay head H.
Use independently constructed SQL fixtures, not only today's initializer, for v1
compatibility tests. Fault hooks are cfg(test)-only and closed/internal: no production
environment failpoint or arbitrary SQL endpoint. Process fixtures should reuse the
repository's subprocess discipline and clean only their own temporary roots.

A new feature does not need a contrived failing old test for every row. Record missing
baseline functionality honestly. After implementation, exercise actual SQL/transactions
and public producers/consumers; mocked commit success is not SQLite evidence. Repeated
runs are not additional unique tests and source inventory is not execution count.

## Required rows

| ID | Requirement | Concrete acceptance observations | Status |
|---|---|---|---|
| P1A-00 | Baseline and authorization | Exact HEAD, ancestry, complete dirty/untracked work, toolchain and current gates recorded. No P1 storage exists at the baseline. Preserve C1/S1/S2/R1 and prior evidence. | NOT RUN |
| P1A-01 | Driver and linked engine | Resolve only SQLx 0.9.0 runtime-tokio/sqlite-bundled plus necessary transitive dependencies; inspect cargo tree/features and sqlite_version/source_id. SQLite >=3.51.3; actual six connection settings asserted. No server driver, macros/build DB, extension loading or broad upgrade. | NOT RUN |
| P1A-02 | Library-only explicit roots | Public library works without CLI, HOME, provider registration or auth. Relative/invalid roots reject. Workspace snapshots need not currently exist and are not read. Fresh data root layout is generated exactly; different roots do not share state. | NOT RUN |
| P1A-03 | Single installation ownership | A second SessionStore for the same canonical root, including an alias and another process, gets storage.busy before DB work. Distinct roots succeed. Clean close and process death release ownership; no PID-file deletion/lock stealing. Closing one browser-equivalent handle does not close the Store. | NOT RUN |
| P1A-04 | Filesystem and privacy | Private Unix modes on new files/directories; unsafe existing paths fail without chmod/deletion. Applicable Unix symlink/special-file and Windows reparse/junction tests remain real platform tests. Generated IDs cannot traverse paths. Ready missing DB is not recreated. SQL logs/Debug/errors expose no synthetic canary content/path/token-like data. State Windows ACL and same-user TOCTOU limits honestly. | NOT RUN |
| P1A-05 | Schema identity and initialization | New catalog/session application IDs, versions, required schema and manifest agree. Initialization DDL failure rolls back. Independent populated v1 fixtures reopen. Foreign application ID, missing trigger/schema, unknown future version and corrupt data fail without overwrite/downgrade. Do not invent historical migrations. | NOT RUN |
| P1A-06 | Canonical creation and receipt | One create reserves then materializes/registers one generated session; event 1, manifest, immutable provenance and catalog receipt agree. Same-ID/content returns same ID/range; changed title/workspace conflicts. Concurrent identical creates converge on one session. | NOT RUN |
| P1A-07 | Interrupted creation | Real child exits after reservation, during session initialization, after session commit before catalog completion, and after catalog acceptance before reply. Reopen/retry retains reserved identities and completes valid stages; invalid partial files stay preserved/unavailable; operational failures retain uncertainty rather than allocate another session. Empty-file recovery only under known creating reservation. | NOT RUN |
| P1A-08 | Rename | Rename commits exactly one title event, current manifest and receipt. Unicode/newlines/empty title preserved as data. Earlier history remains byte-identical. Same operation returns original result; new same-title operation is ordered normally. Rename during a recorded active run is allowed. | NOT RUN |
| P1A-09 | Snapshot capture from real S2 types | Capture original user text, actual PreparedRun request, ContextManifest getter values and matching registry definitions. Preserve S1 no-loader and S2 loader paths. Validate cloned tools-inclusive options while stored prepared_request.options.tools stays empty. No context reread/auth/network. No false claim that snapshot alone authorizes execution. | NOT RUN |
| P1A-10 | Run acceptance | User/prepared input/options errors precede session mutation. Accept atomically records snapshot/run/receipt. Same-ID retry works after later terminal state and restart; another method/content conflicts. New accepted/running run in the same session fails active_run_exists; a different session proceeds. Caller run UUID is fixed before acceptance and not confused with provider-session ID. | NOT RUN |
| P1A-11 | Atomic whole-batch recording | A mixed valid/invalid record batch changes no event, projection, receipt or head. Valid batch commits all records in order. Inject errors after event insertion and after projection update to prove rollback. Runtime/source identity and wrong-run/version failures are rejected before partial commit. | NOT RUN |
| P1A-12 | Immutability and sequence | Direct synthetic SQL UPDATE/DELETE of events/receipts is rejected; API offers none. Session head spans title and multiple runs; runtime sequence remains separately nested. Duplicate source IDs/sequences under another operation fail; original operation retry succeeds. Checked i64/u64 boundary does not wrap. No provider-supplied session sequence. | NOT RUN |
| P1A-13 | Partial history and native fidelity | Persist actual Runtime OutputItemUpdated text/refusal/reasoning/function-argument variants, indexes, Unicode/control strings and partial content, without treating fragments as executable. ModelResponse native/effective output/provenance/usage round-trip. Recovered native output=[] remains [] while effective output stays present. Unknown native extensions and opaque strings survive. Equality is parsed native Value plus exact strings, not raw transport whitespace. | NOT RUN |
| P1A-14 | Tool result source and ordering | Obtain success, ToolFailed->gateway_error and tool_output_limit through real existing registry outside storage. Record exact returned output string and observed is_error. Start/finish without a result leaves output None. Result-before-finish and finish-before-result both work consistently; disagreement/unknown call/wrong original request fails. No Ok(error-shaped JSON) workaround. | NOT RUN |
| P1A-15 | Scoped reuse | Same call ID in two different runs is independent. Same-run reuse references the exact stored original output without a new execution/result row or file reread. A reuse with missing result or wrong name fails. Storage itself executes zero tools, including on error/retry/open. | NOT RUN |
| P1A-16 | Terminal and delivery distinction | Record Completed/Failed/CancelledLocally and preserve upstream uncertainty. Actual DTO fixture for completed execution plus events_complete=false/sink_error remains completed execution with failed delivery. A Result can terminalize an active run or supplement identical RunFinished once; conflicting/duplicate/new ordinary events cannot resurrect terminal state. Completed with missing started-tool results rejects. | NOT RUN |
| P1A-17 | Reopen and interruption | Fresh process opens a saved session, retains partial text/results and atomically marks old accepted/running work interrupted without provider construction, tool execution, continuation, queue drain or credential access. Existing terminal records remain unchanged. Same-instance second handle does not interrupt current work. Repeat restart/open produces no second interruption. | NOT RUN |
| P1A-18 | Commit acknowledgment and waiter drop | Hold a test transaction before commit: caller success is unavailable. Drop the caller waiter after admission: the owned DB operation finishes/rolls back under its lease, and original operation receipt resolves outcome. New same-ID request never duplicates rows. No timeout interpreted as rollback. Pre-commit error is NotCommitted; uncertain COMMIT error is commit_unknown. | NOT RUN |
| P1A-19 | Post-commit failures | Exit after commit before reply; exact receipt/history survive. Post-commit cleanup warning does not turn accepted data into rollback. Failed catalog refresh leaves primary receipt valid. Close waits for owned DB operations and rejects new work; no detached SQL write can outlive released root ownership in tested normal/cancel paths. | NOT RUN |
| P1A-20 | Snapshot history pages | Capture H, page an immutable prefix while other records append above H, return contiguous ordered records exactly once with correct next_after/has_more. Empty/equal-head, exact page boundary, invalid/ahead cursors and checked n+1 are tested. Queries use SQL range/LIMIT, not whole-history materialization. No read transaction remains after returning the page. | NOT RUN |
| P1A-21 | Catalog-only listing | Listing uses catalog keyset pages without opening session DBs. Rename/head changes appear after explicit refresh. Ordering is stable by ID; concurrent insert semantics are honestly live, not claimed global snapshot. Availability/observed-head state is explicit. No runtime liveness claimed from cached run state. | NOT RUN |
| P1A-22 | Catalog synchronization | Canonical mutation succeeds before refresh. Failed refresh does not undo it. Refresh rereads real manifest rather than accepting caller summary; stale head cannot replace a newer summary. It cannot create/promote unknown/missing/unavailable rows. Creation remains its separately specified two-store acknowledgment. | NOT RUN |
| P1A-23 | Lost catalog and explicit reconstruction | Missing catalog with surviving sessions requires repair before normal use. Stream exact generated session paths; rebuild session rows and accepted creation identities from immutable provenance, including a session renamed after creation. Same original create returns old session. No arbitrary directory scan, no full-history/error inventory, and no new project/provider registration or credential binding. | NOT RUN |
| P1A-24 | Repair interruption and fault isolation | Crash mid-repair keeps intent and repeated repair converges. Missing/corrupt/future-schema/foreign/noncanonical/symlink candidates are preserved and classified without blocking healthy session reconstruction; operational failures keep repair intent. Duplicate creation-command claimants are both unavailable, not an enumeration-order winner. Complement marks absent known paths missing only after a complete scan. | NOT RUN |
| P1A-25 | Concurrent sessions and lifecycle | Concurrent writes to two sessions keep independent committed order and no global model/tool serialization. Same-session concurrent mutation is serialized. Reads/close/repair ownership cannot deadlock or use closed connections. Repeated operations release connections/workers; historical session count does not retain pools/threads. Test gauges count lifecycle; OS RSS alone is not proof. | NOT RUN |
| P1A-26 | No copied lifetime limits | Stored history can exceed the provider's 128-item/8-MiB retained-context capacities and old 2,048-row threshold across finite valid records; those are not storage-lifetime limits. More than 128 small tool results can be recorded in a run. No 1,000-session/256-MiB discovery ceiling, result-cache budget, timer, truncation or auto-deletion exists. Code audit plus finite workload evidence, not an infinite-execution claim. | NOT RUN |
| P1A-27 | Faults and static error boundaries | Real SQLite busy/rollback constraints and injected I/O/commit/close failures exercise public storage codes/certainty. Disk-full simulation records exactly what was simulated; no physical power-loss claim. Corruption/future-version paths preserve original main-file evidence. GatewayError::code and runtime errors remain untouched. | NOT RUN |
| P1A-28 | Regression and nonintegration | All existing S1/S2/R1/C1/auth/run/transport tests retain assertions and pass. Existing wi CLI/options/output and RunRequest/provider schemas unchanged. A normal CLI help/no-op invocation creates no storage. No new provider, executor, runtime persistence call, history-restoration shortcut, permission framework or service exists. | NOT RUN |
| P1A-29 | Offline example and performance observations | storage_offline creates/renames, captures synthetic context, records a small full trace plus actual tool-result data, refreshes/list/pages, closes/reopens, and asserts retained data without provider/auth. Record latency samples for create/append batch/rename/list/page/reopen, linked SQLite settings, data sizes, transaction sizes and open/close cost; no invented fastest claim or CI wall-clock SLA. Keep benchmark fixtures separate from production policy. | NOT RUN |
| P1A-30 | Documentation and evidence | README/architecture/events/index/AGENTS describe storage-only acceptance and explicit catalog refresh/lazy recovery; wi run persistence and P1-B/V1 stay NOT IMPLEMENTED. Both reports cover all 32 rows, exact revision/worktree, failures/cleanup, IDs/provenance, actual commands, platform gaps and unchanged ledger. Historical reports unchanged. | NOT RUN |
| P1A-31 | Final review and merge boundary | Complete local gate set passes on the accumulated diff; fresh independent review examines schema/transactions, creation/repair, async ownership, security and real source DTO compatibility. Record actual reviewer work and unresolved findings. After separate owner-authorized push, require exact-head Ubuntu/macOS/Windows job and step results before merge; no check/OS/lint weakening. | NOT RUN |

## Required gates

Record baseline and final actual results; use isolated roots. Newly permitted normal
Cargo dependency fetching is build traffic, not authorization for model/auth traffic.

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
git diff --check
```

Inspect cargo tree -e features and the lockfile diff. Baseline reported 422 Rust/152
Node and three examples; these are attributed earlier results, not counters to fake.
Zero doctests is zero additional coverage. subprocess/helper-only ignored tests,
filtered focused runs and platform exclusions must be explained. Keep actual Linux,
macOS and Windows behavior distinct. Existing GitHub Cargo CI does not run Node or
all example mains implicitly.

No cargo run --example two_turns, smoke, cli_retest --run-live, auth/profile/login/
refresh command, API entitlement probe or real private-skill input. Test watchdogs
and fixed datasets are not new product budgets. Scope ends after offline acceptance
and review; no implementation commit/push/merge without owner authorization.

## Reports

Create docs/slices/p1a/VERIFICATION.md and verification.json during actual work.
Do not modify the frozen plan's NOT RUN headings to manufacture original PASS.
Human report: verdict and tested tree; baseline; dependency/engine/runtime versions;
32-row actual assertion map; schema/operation ownership; initial failures/fixes;
commands/counts; process boundaries; performance observations; independent review;
permission/FS/corruption/power-loss limitations; pending CI; authorization.

JSON minimum:

```json
{
  "contract": "p1a.0",
  "status": "NOT_RUN",
  "accepted": false,
  "baseline": "dd720c0e66eceaaea831ad03e489656f77fc1cec",
  "tested_revision": null,
  "worktree": null,
  "environment": {},
  "dependency_and_sqlite": {},
  "matrix": [],
  "commands": [],
  "process_faults": [],
  "performance_observations": [],
  "reviews": [],
  "submitted_ci": [],
  "limitations": [],
  "runtime_integrated": false,
  "provider_history_restoration_implemented": false,
  "live_started": false,
  "real_credential_reads": 0,
  "provider_generations": 0,
  "ledger": {"used":31,"cap":50,"remaining":19,"changed":false}
}
```

Each row records status, actual test/command, observer, assertions and blockers.
Tests authored but not executed remain NOT RUN. A pre-push report may legitimately
show CI pending; later exact-head evidence is appended or linked, not backdated.
Database FULL configuration and process-crash tests do not certify arbitrary device
power-loss behavior. All diagnostics are synthetic/static and no raw stored session
content, credential data or private filesystem paths should enter the public report.
