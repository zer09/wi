# P1-A: durable application-session storage

Contract **p1a.0**. Prepared 2026-09-13. Runtime baseline:
`dd720c0e66eceaaea831ad03e489656f77fc1cec` (R1 including NB-02, merged).
Status: **PLAN ONLY / NOT IMPLEMENTED / NOT RUN**.
Read SCHEMA.md, MATRIX.md, VALIDATION.md and IMPLEMENTOR_PROMPT.md together.
This is the next implementation assignment, not permission to execute older prompts.

## 1. Goal and slice boundary

Implement a reusable Rust library for creating, naming, recording, querying and
reopening persistent application sessions. Use **SQLite**, one canonical database
per session plus a rebuildable session catalog. There is no second storage engine,
canonical JSONL, ORM, database-plugin framework or network database service.

The owner requests service-owned sessions viewed through browsers, embedded storage,
rename, persistence across restart, and no automatic task resumption. Database-file
human readability is irrelevant. The previous checkpoint called the topology and
SQLx proposals; this contract makes explicit choices for this assignment rather
than presenting them as already implemented facts.

**P1-A is storage, not integration of ordinary wi run.** Its example and tests use
the library. It adds no CLI storage commands, web server, browser protocol or GUI.
P1-B must later add awaited runtime capture and valid provider-history restoration.
No provider, Gateway, Tool::execute, credential reader or skill discovery is invoked
by opening, reading, recovering or repairing this storage layer.

Preserve the current runtime, provider/auth contracts, S1/S2 behavior, R1 repairs,
error mappings and run/provider event schemas. C1's deleted RunLimits stays deleted.
No task deadline, execution quota, session-count cap, history-lifetime cap,
auto-deletion, speculative approvals/queues/effect-class engine or auto-retry.

## 2. Fixed technology and ownership

Add exactly this direct dependency, subject only to a demonstrated build conflict:

```toml
sqlx = { version = "=0.9.0", default-features = false, features = ["runtime-tokio", "sqlite-bundled"] }
```

Use bound dynamic queries and Row extraction, not query!/derive macros requiring
a build-time database. Do not enable Any, PostgreSQL, MySQL, TLS, extension loading,
deserialization, an SQLx CLI or ORM. SQLx 0.9 requires Rust >=1.94; record the actual
local/CI toolchain. Existing uuid v4, ring SHA-256, serde, Tokio and tempfile suffice.
Cargo.lock may change only for the new dependency's necessary resolution. Do not
broadly upgrade existing packages. Record the resolved libsqlite3-sys version and
actual sqlite_version()/sqlite_source_id(). Require SQLite >=3.51.3; that is the
fixed compatibility floor covering the referenced WAL fix, not a claim of latest.
Do not silently substitute the machine's older dynamic SQLite.

Per writable connection: WAL, synchronous=FULL, foreign_keys=ON, trusted_schema=OFF,
shared_cache=false, busy_timeout=0. Check the effective settings. Zero busy timeout
means report SQLite lock contention without a hidden wait/retry; it is not a task
timer. Leave SQLite's checkpoint policy alone. Disable statement logging and never
include bound values/raw SQLx errors in ordinary logs or errors.

SQLx provides its SQLite worker. P1-A uses **operation-scoped connections**, opened
lazily and explicitly closed before releasing operation ownership. Do not retain a
pool/worker per historical session, add an LRU framework or a custom worker RPC.
This deliberately simple first implementation has connection-open/close cost;
measure end-to-end operations including that cost. Do not claim fastest or introduce
an unreviewed cache to improve a benchmark. Batching records in one transaction is
supported. Later measured optimization is separate work.

One SessionStore owns one canonical data root under an OS-backed exclusive lease.
Use the stable std::fs::File try_lock facility for a private fixed storage.lock;
never break a lock using a PID or age. Root aliases converge through canonicalization.
A second store, even in the same process, fails storage.busy rather than becoming
an independent owner. Distinct roots can coexist. A SessionHandle is lightweight,
not an idle SQLite connection. Per-session mutation locks serialize changes; catalog
transactions use separate short coordination. Never await session work while holding
a catalog transaction/lock. Different sessions can make progress independently.

Each admitted operation runs in a small privately owned Tokio task that retains its
lifecycle guard/root lease, per-session ownership, and connection through commit or
rollback and explicit close. Dropping the caller's JoinHandle/waiter does not cancel
that database transaction. This is in-flight storage completion, not a durable job
queue or model/tool retry. Do not expose abort handles. close() rejects new admission,
awaits all admitted operation guards, then releases the lease. No unbounded event
queue is introduced. On a post-commit cleanup error, retain the committed receipt
and report a separate static cleanup warning; do not report rollback. Latch an
unhealthy store closed to further writes if safe resource retirement is uncertain.
A process crash can bypass close; no software-shutdown guarantee is a power-loss test.

## 3. Files, trust and availability

The library accepts an explicit absolute data-root PathBuf. No HOME/XDG/WI_HOME
resolution or configuration migration belongs in P1-A. The future service chooses
its root. Layout:

```text
<root>/storage.lock
<root>/catalog.sqlite3
<root>/sessions/<first-two-hex-digits>/<session-uuid>/session.sqlite3
```

SQLite may maintain its normal -wal/-shm sidecars. Never delete those to fix locks.
No artifacts directory is needed yet. Generate session paths internally from
validated IDs; do not accept paths from catalog values without checking the exact
expected relative path. No SQLite URI from a caller: use filename(Path).

New Unix private directories use 0700 and files 0600. Reject insecure existing
owned directories/files rather than chmod arbitrary old paths. Do not chmod trusted
ancestors such as /tmp. On Windows use the owner's protected directory and preserve
normal reparse/junction checks; do not call Unix mode bits Windows ACL protection.
An explicitly selected root may canonicalize an alias. Descendants and managed
DB/lock/sidecar paths must be regular expected entries, not symlinks/reparse points
or special files. Check static substitutions before opening. Parent-path checks
are defense-in-depth, not a guarantee against hostile concurrent same-user TOCTOU.
No arbitrary user-data cleanup, credential import, full-home scan or network mount
support is added. Local filesystem support/permission limits must be reported.

Only a new reserved session may initialize a new database. A ready session whose
file vanished is missing: never recreate an empty replacement. Corrupt/foreign/
unsupported databases are preserved; ordinary open must not overwrite, downgrade,
rename or auto-quarantine them. Validate existing application_id/user_version and
manifest before normal mutation. Read-only validation may need SQLite WAL/SHM
handling: do not use immutable=true to ignore a live WAL or claim sidecars never
change. No old wi-old database import/migration is supported.

A catalog missing while generated session directories survive is freshly created
with repair_required=1. Normal listing/open/creation/mutation returns
storage.catalog_repair_required until explicit repair_catalog() completes. A truly
fresh empty root starts without repair intent. An existing nonempty corrupt catalog
fails closed and is preserved, not automatically replaced. Unknown/empty preexisting
catalog files also fail closed; initial bootstrap failure is reported honestly.

Session availability is creating, ready, missing or unavailable. Ordinary use of
missing/unavailable entries fails explicitly. Explicit repair may revalidate and
restore a canonical session; no generic summary update can promote availability.

## 4. Public library surface

Expose wi::storage. Keep SQLx/connection/SQL types private. Names below are fixed
public operation names; private helper layout and ordinary representation details
are implementation choices, not a second architecture exercise.

```text
SessionStore::open(absolute_root) -> SessionStore
SessionStore::create_session(CreateSession) -> CreateResult
SessionStore::open_session(ApplicationSessionId) -> SessionHandle
SessionStore::list_sessions(after_id, nonzero_page_size) -> SessionPage
SessionStore::repair_catalog() -> RepairReport
SessionStore::close()

SessionHandle::manifest() -> SessionManifest
SessionHandle::rename(operation_id, title) -> CommitResult
SessionHandle::accept_run(operation_id, run_id, RecordedRunInput) -> CommitResult
SessionHandle::append_run_records(operation_id, run_id, records) -> CommitResult
SessionHandle::history_page(after_sequence, through_sequence, nonzero_page_size) -> HistoryPage
SessionHandle::run_record(run_id) -> optional RecordedRun
SessionHandle::tool_result(run_id, call_id) -> optional RecordedToolResult
SessionHandle::lookup_receipt(operation_id) -> optional CommitReceipt
SessionHandle::refresh_catalog() -> Updated | Unchanged
```

All operations involving disk/SQL are async. Returned owned data is usable outside
the CLI. Private fields plus validating constructors prevent unsupported IDs or
records bypassing validation through direct construction or deserialization.
Application session IDs, operation IDs, run IDs and generated stored-event IDs use
canonical lowercase, hyphenated, non-nil UUID strings. Reuse uuid v4 for generated
identities. Provider response/request/call identities remain opaque existing strings;
do not apply the storage UUID rule to them. Store-owned checked i64 sequences map
to nonnegative u64 at the API boundary; overflow is a representation error, never a
quota or sentinel for unlimited execution. Timestamps are Unix milliseconds; session
sequence, not wall-clock ordering, orders history.

CreateSession fields: operation_id, title:String, workspace:Option<String>.
Workspace is a historical UTF-8 absolute path spelling validated on creation, not
permission to access it. Missing/moved historical projects do not prevent reading
history. Do not stat/read a project merely to create a storage record. Titles may
be empty; preserve text exactly. Rendering safety remains a presentation concern.
No new title/input/history byte or count quota is part of this contract. Physical
SQLite/representation errors remain explicit and no data is silently truncated.

RecordedRunInput fields:
- user_text:String: the original user task, not the composed prompt substituted as UI text;
- prepared_request: existing RunRequest, with options.tools empty;
- tool_definitions: Vec<ToolDefinition> captured from the matching registry;
- available_skills: Vec<String>, active_skills: Vec<String>,
  project_instructions_source: Option<String> copied from ContextManifest getters.

Provide a capture constructor taking original user text, &PreparedRun and
&ToolRegistry. It copies owned data only; no reread/discovery/authentication. Also
allow a validated constructor from the equivalent fields for plain library callers.
Validate user_text and prepared prompt separately through current validate_input;
validate a cloned SessionOptions with the captured tool definitions installed.
Do not apply provider input-item/history limits to the whole stored conversation.
Do not require Gateway capability/auth checks or claim accepting a stored request
proves the provider can execute it. Record fields/definitions, not executable Arcs.

accept_run takes a caller-generated run_id fixed before acceptance. The future
P1-B composition root will use it in an explicitly authorized runtime seam; current
run() still generates its own ID and is unchanged here. Do not create a second
ambiguous task ID or reinterpret provider-session IDs as application-session IDs.

## 5. Canonical records and minimum projections

The stored envelope is version 1 and has application_session_id, sequence, event_id,
created_at_ms, event_type, event_version and payload. Its sequence spans renames
and all runs. Runtime envelopes remain nested verbatim in their own schema 2;
provider envelopes remain schema 1. Stored JSON preserves parsed values; embedded
strings (prompt, tool output, opaque provider strings) preserve their exact bytes.
Do not claim original wire JSON whitespace/property order was retained by Value.

Closed event set:

| Stored event | Producer and payload |
|---|---|
| session.created | create_session; initial title/workspace and immutable creation provenance |
| session.renamed | rename; new title |
| run.accepted | accept_run; run_id, RecordedRunInput and store instance ownership ID |
| runtime.observed | append_run_records; complete existing RunEventEnvelope |
| tool.result.recorded | append_run_records; request_id, call_id, exact output:String, is_error:bool |
| run.result.recorded | append_run_records; complete existing RunResult |
| run.interrupted | storage-only prior-instance reconciliation; fixed reason process_restart |

append_run_records accepts a nonempty ordered vector of Runtime(RunEventEnvelope),
ToolResult{request_id,call_id,output,is_error}, or Result(RunResult). It cannot append
raw SQL, arbitrary event-name JSON, session.created or a synthetic successful tool
execution. The storage module never invokes a tool. Typed runtime payload acceptance
is recording of caller evidence, not independent verification of provider authenticity.

Minimum projections are manifest, runs, tool_results, command receipts and catalog
summaries (see SCHEMA.md). The indexed canonical history is the paged conversation
record. Do not add unused message/parts/approval/input/provider-management tables.
A rendered-chat snapshot projection is deferred to P1-B/V1 if its consumer needs it;
P1-A does not claim to return finished browser bubbles. Partial runtime text is
nonetheless retained exactly and readable in history pages.

### Runtime recording and lifecycle rules

A run must first be accepted. Only one accepted/running recorded run per session is
allowed; this preserves the original conversation-serialization requirement, not
an overall model/tool execution allowance. A second accept fails
storage.active_run_exists. Independent sessions are independent.

The runtime envelope run_id must match the recorded run. Enforce outer schema 2,
nested provider schema 1, increasing positive runtime sequence and nonconflicting
runtime event IDs. Preserve source sequence separately; do not use it as the session
sequence. Reject unsupported envelope versions before writing. Unknown native
ProviderExtension payloads remain valid inside the supported envelope.

RunStarted changes accepted to running once. Intermediate runtime records require
running. RunFinished sets completed/failed/cancelled_locally from its existing
RunOutcome, retaining the exact outcome and summary. A Result record can terminalize
an otherwise active run when its final observer delivery failed, or supplement an
already identical RunFinished terminal state. It preserves events_complete,
sink_error, summary and last_response; it never emits a second terminal transition.
Conflicting terminal outcomes, duplicate Result under a different operation, or
later ordinary runtime records cannot revive a terminal run. A new user submission
must have a new run ID. Failed and locally cancelled records never imply proven
upstream termination. Preserve UpstreamOutcome and OutputProvenance as data.

ToolExecutionStarted creates (run_id,call_id) with tool name and originating request.
ToolExecutionFinished records finish observation and is_error; it does NOT fabricate
or derive output. ToolResult stores the actual output separately, matching the
started identity/request and any observed finish flag. Allow result-before-finish
and finish-before-result so the actual producer seam is not falsely constrained;
require consistency when both exist. The result string is not reparsed/reserialized
or interpreted as success based on its JSON contents. ToolResultReused requires an
existing matching saved result and creates no new execution/result row. Duplicate
call identities in another run are valid. A completed run requires a stored result
for every started tool; failed/cancelled/interrupted runs may retain missing results
with that absence visible. Finish observed without output means result missing,
not automatically unknown external outcome; start without finish/result remains
unresolved. No exactly-once external-effects claim or retry policy is introduced.

## 6. Atomic mutation, retry identity and error certainty

One session mutation transaction does: BEGIN IMMEDIATE; verify operation receipt;
validate the complete proposed transition/batch; append events with fresh contiguous
sequences; update projections and manifest head; save the receipt; COMMIT.
Validation failure rolls back all rows. No callback/publication is invoked before
commit. Primary returned CommitReceipt contains operation_id, session_id, optional
run_id, first_sequence and last_sequence. CreateResult also contains its generated
session ID. CommitResult wraps the immutable receipt plus duplicate and any static
post-commit cleanup warning; warning/delivery metadata is not a new durable result.

Idempotency scope: create operation IDs in the catalog; rename/accept/append IDs in
one session. Within a scope the same ID with the same method/session/content returns
the original receipt, even after restart or state changes; different content/method
conflicts without mutation. Check the receipt before current-state eligibility.
Payload hashes use existing ring SHA-256 over a documented canonical serialization
of the complete typed request (excluding operation ID and generated fields): sort
all JSON object keys recursively, preserve array order and all strings. This is a
Wi typed-JSON convention, not a claim of RFC 8785 numeric equivalence. The encoded
number 1 and 1.0 may differ. Inner tool-output/arguments strings are not canonicalized.
Same title with a new operation ID is a real ordered metadata operation, not hidden
coalescing. An exact repeat of a source runtime event with a different operation ID
is a conflict; callers retry their original operation ID.

Receipt, events, projections and head either all commit or all roll back. A missing
reply/dropped waiter does not prove no commit. Reconcile by receipt before retry;
retrying the identical storage operation must not duplicate rows. No model/tool is
reissued by storage retry. A COMMIT-stage error that cannot prove rollback is
storage.commit_unknown, with the operation ID available for lookup. Known validation
or pre-commit rollback failures are explicitly NotCommitted. Successful COMMIT remains
committed even if catalog refresh, connection close or result delivery later fails.

StorageError has its own static code/display mapping, never a new GatewayError arm.
Codes: storage.invalid_input, storage.busy, storage.closed, storage.not_found,
storage.unavailable, storage.unsupported_version, storage.integrity,
storage.command_conflict, storage.invalid_transition, storage.active_run_exists,
storage.catalog_repair_required, storage.creation_incomplete, storage.io,
storage.commit_unknown. Include a NotApplicable/NotCommitted/Unknown certainty
classification as appropriate. Debug/Display must not expose SQL, paths, prompts,
provider/native payloads, results, credentials or arbitrary exception text.

## 7. Catalog publication and creation protocol

For existing sessions, mutation returns immediately after its canonical commit and
connection cleanup. **Catalog refresh is a separate explicit operation**, not a
background observer framework and not a precondition for a session write. Callers
can publish the receipt/history first, then refresh_catalog(). This deliberate
P1-A choice makes commit ownership testable. The example performs the refresh;
P1-B must wire post-commit refresh at its composition boundary. A stale catalog is
not a false canonical rollback. Summaries report observed head and recorded state,
not live liveness. Listing does not open session databases.

refresh_catalog reads a validated canonical manifest/current run summary itself;
it does not accept caller-supplied titles/heads. Apply monotonically by head. Older
observations cannot overwrite newer summaries. No ordinary refresh can create an
unknown row or promote missing/unavailable. Correct availability requires explicit
repair or completion of a known creation reservation.

Creation crosses two databases without an atomicity claim:
1. Validate; in one catalog transaction find the existing command or reserve the
   command hash/input, fresh session ID/path, creation event ID and timestamp.
2. Under session ownership, create only the reserved directories/file and initialize
   schema/manifest/session.created in one canonical session transaction.
3. Complete catalog registration/receipt in a catalog transaction.
4. Return creation success only after both steps are established.

A repeat/next open of a known creating reservation uses the same identities. Missing
reserved DB can initialize; a valid matching manifest/provenance completes registration.
A zero-length or empty SQLite database may initialize ONLY under that still-creating
reservation, after confirming no foreign schema/application identity or committed Wi
history. Other partial/foreign/corrupt files are preserved and terminally classified
unavailable/failed; do not repeatedly overwrite/retry them. Operational I/O or uncertain
commit failures retain the creating reservation and return creation_incomplete or
commit_unknown, not a newly allocated session. A later identical call inspects the
canonical evidence. Failed creation with the same ID returns the stored safe failure.

Immutable creation provenance includes original command ID, method/canonical request
and hash, generated session/event IDs/time, and original receipt. Current title changes
must not alter it. This permits restoring accepted creation identity after catalog loss.
It cannot reconstruct a failed reservation whose session never materialized; report
that limit rather than promise recovery of every lost catalog-only fact.

## 8. Reads, repair and reopening

History pages read an immutable range (after_sequence, through_sequence] in ascending
session order. A first page with no through_sequence captures committed head H in
its read transaction. Later pages use the same H. Return H, next_after, has_more and
owned typed records; no held transaction/cursor lives with a browser. Reject negative,
ahead or inconsistent cursors instead of silently skipping. A nonzero caller page
size is a query parameter, not a history/work limit. Do not fetch the entire transcript
then truncate in memory. New appends above H do not change that replay window.

Catalog listing is keyset-paged by immutable canonical session ID ascending. It is
an explicitly live index view, not an installation-wide historical snapshot; clients
can refresh from the beginning to see concurrently inserted earlier IDs. Metadata
updates do not change pagination keys. No recency-sort/search framework in P1-A.

open_session performs validated prior-instance reconciliation before returning:
accepted/running rows owned by an older SessionStore instance get one run.interrupted
record with process_restart, in the same transaction as their projection/head update.
This is storage-only; completed/failed/cancelled/interrupted rows remain unchanged.
Current-instance handles/readers do not interrupt current recorded work. A same-ID
old command returns its original receipt, never a new execution. Tool bytes and
partial runtime records stay intact; no missing result is manufactured. Recovery is
lazy for selected sessions, not an eager scan of every history at normal startup.
Catalog summaries explicitly retain observed-head semantics until refreshed; they
are not proof that an old task is live. P1-B will own service-wide startup reconciliation
of the sessions it adopts without launching tasks.

Explicit repair_catalog takes exclusive maintenance ownership against normal store
operations, sets durable repair intent, and streams only exact generated paths.
Read and validate one database at a time without migrating future/foreign schemas.
Rebuild manifest-derived session rows and valid accepted creation receipts. Verify
creation provenance against sequence 1 and original creation request, NOT the renamed
title. If two valid canonical candidates claim one creation command, mark both
unavailable and reject that command rather than choose a traversal-order winner.
Ignore noncanonical layouts/links without following them. Missing/corrupt/unsupported
sessions get explicit catalog availability and stay in place; healthy ones continue.
Only after a complete scan mark formerly known absent paths missing and clear repair
intent. Operational scan failure retains intent; subsequent repair is idempotent.
Use paged SQL/streaming directories, not a hard session-count/database-size cutoff or
an unbounded array of entire histories/errors. RepairReport returns counts; per-session
faults are available through paged catalog results. No canonical event rewrite.
Reconstruction does not create project/provider registrations or credential bindings.

## 9. Implementation boundary and deliverables

Allowed production footprint: new src/storage/ and src/lib.rs export, the specified
Cargo dependency/necessary lockfile changes, and current documentation explaining
storage-only behavior. New tests under tests/storage/ with thin Cargo target wrappers;
unit tests may exercise private paths. Add examples/storage_offline.rs. No changes
to src/run/, provider/auth modules, src/tools.rs, context or CLI behavior. No production
failpoint environment variables or injected application-side DB URLs. Test-only crash
harnesses/controls must not enter normal wi execution or read owner storage.

Sequence: baseline gates; dependency/SQLite version probe; schema/transactions; root
lease/creation; canonical operations/projections; history queries; catalog refresh/repair;
reopen/interruptions; process-failure and real DTO round-trips; example/performance
observations; full gates; independent complete-diff review; reports.

Reports: docs/slices/p1a/VERIFICATION.md and verification.json, all P1A-00..P1A-31.
No prefilled PASS. Store source/test counts separately from executed counts. Preserve
all earlier reports. P1-B and V1 remain unimplemented. No live provider/adherence test
is necessary or authorized; ledger remains 31/50 used, 19 remaining.

The local implementor may implement, run offline gates and review. It may not commit,
push, merge, release or deploy without the owner's separate instruction. The planning
PR is documentation only. A genuine contradiction must be raised with producer and
consumer source evidence, not resolved through unauthorized changes.
