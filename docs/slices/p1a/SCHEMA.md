# P1-A schema and record contract

Contract **p1a.0**; baseline `dd720c0`. Design specification, not installed schema.
CONTRACT.md controls behavior. This document fixes the first storage representation
and prevents the implementor from inventing an incompatible transcript model.

## 1. Versions, initialization and migrations

Catalog and session schemas each start at version 1; they have independent migration
sequences. PRAGMA application_id is 1464419137 (0x57494341) for the catalog and
1464423233 (0x57495341) for a session. PRAGMA user_version is 1. Manifest format is 1.
These are new Wi storage identifiers, not TypeScript schema versions or existing
run-event versions. Nested runtime/provider schema versions remain 2/1.

New-file initialization sets application_id, all schema objects and user_version in
one transaction. Application writes start only after successful initialization and
version checks. An existing supported file is opened, not reinitialized. Unsupported
higher versions, foreign application IDs, malformed manifests or missing schema
objects fail without downgrading/replacing the database. The known-creating-reservation
exception for an empty session file is precisely limited by CONTRACT.md.

Use one simple ordered migration list per database kind. At this first version, only
new-database initialization exists: do not invent a released v0 schema or TypeScript
import. Test initialized v1 reopening, initialization rollback, an independently
constructed v1 fixture and future-version rejection. Do not claim an old released
migration was tested when none exists. Store schema validation must cover required
columns/indexes/immutability triggers, application ID, manifest ID/head and version
agreement, not merely trust user_version. Full historical content replay is for an
explicit integrity test/repair, not every ordinary read.

## 2. Catalog DDL

This is the required logical schema. Equivalent extra CHECK constraints/index names
are permitted only if they preserve the contract; no additional product subsystem.

```sql
CREATE TABLE catalog_meta (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 format_version INTEGER NOT NULL CHECK(format_version=1),
 repair_required INTEGER NOT NULL CHECK(repair_required IN(0,1))
) STRICT;
CREATE TABLE sessions (
 session_id TEXT PRIMARY KEY,
 relative_path TEXT NOT NULL UNIQUE,
 title TEXT NOT NULL,
 workspace_json TEXT,
 created_at_ms INTEGER NOT NULL,
 updated_at_ms INTEGER NOT NULL,
 head_sequence INTEGER NOT NULL CHECK(head_sequence>=0),
 schema_version INTEGER NOT NULL,
 availability TEXT NOT NULL CHECK(availability IN('creating','ready','missing','unavailable')),
 fault_code TEXT,
 last_run_id TEXT,
 last_run_state TEXT,
 seen_repair_id TEXT
) STRICT;
CREATE TABLE creation_commands (
 command_id TEXT PRIMARY KEY,
 payload_hash BLOB NOT NULL CHECK(length(payload_hash)=32),
 request_json TEXT NOT NULL,
 session_id TEXT NOT NULL UNIQUE,
 creation_event_id TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN('creating','accepted','failed')),
 receipt_json TEXT,
 failure_code TEXT
) STRICT;
CREATE INDEX sessions_availability_id ON sessions(availability, session_id);
```

request_json is the canonical creation request, including its original title and
workspace, not the later manifest title. Receipt JSON contains only the fixed accepted
identity/range and generated identifiers; duplicate/warning response metadata lives
outside it. Known creating reservations remain inspectable for completion. Failed
reservations without a materialized session cannot be rebuilt from session files
if the catalog is lost; record that deliberate recovery limit.

Only session-index data is rebuildable. Do not add projects/provider credentials or
claim all installation configuration is reconstructed. Nonempty lost-catalog repair
is explicit and uses repair_required. seen_repair_id supports a streamed complete-scan
complement without retaining an installation-wide list of full records in memory.

## 3. Session DDL

```sql
CREATE TABLE manifest (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 session_id TEXT NOT NULL UNIQUE,
 schema_version INTEGER NOT NULL CHECK(schema_version>0),
 format_version INTEGER NOT NULL CHECK(format_version=1),
 title TEXT NOT NULL,
 workspace_json TEXT,
 created_at_ms INTEGER NOT NULL,
 updated_at_ms INTEGER NOT NULL,
 head_sequence INTEGER NOT NULL CHECK(head_sequence>=0),
 creation_provenance_json TEXT NOT NULL
) STRICT;
CREATE TABLE events (
 sequence INTEGER PRIMARY KEY CHECK(sequence>0),
 event_id TEXT NOT NULL UNIQUE,
 event_type TEXT NOT NULL CHECK(event_type IN(
   'session.created','session.renamed','run.accepted',
   'runtime.observed','tool.result.recorded','run.result.recorded','run.interrupted')),
 event_version INTEGER NOT NULL CHECK(event_version=1),
 created_at_ms INTEGER NOT NULL,
 run_id TEXT,
 source_event_id TEXT,
 source_sequence INTEGER,
 payload_json TEXT NOT NULL,
 CHECK((event_type='runtime.observed' AND source_event_id IS NOT NULL
          AND source_sequence IS NOT NULL AND source_sequence>0)
    OR (event_type<>'runtime.observed' AND source_event_id IS NULL AND source_sequence IS NULL))
) STRICT;
CREATE UNIQUE INDEX events_source_id ON events(source_event_id) WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX events_source_sequence ON events(run_id, source_sequence) WHERE source_sequence IS NOT NULL;
CREATE INDEX events_run_sequence ON events(run_id, sequence);
CREATE TABLE commands (
 operation_id TEXT PRIMARY KEY,
 method TEXT NOT NULL,
 payload_hash BLOB NOT NULL CHECK(length(payload_hash)=32),
 first_sequence INTEGER NOT NULL REFERENCES events(sequence),
 last_sequence INTEGER NOT NULL REFERENCES events(sequence),
 receipt_json TEXT NOT NULL,
 CHECK(last_sequence>=first_sequence)
) STRICT;
CREATE TABLE runs (
 run_id TEXT PRIMARY KEY,
 accepted_sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence),
 state TEXT NOT NULL CHECK(state IN('accepted','running','completed','failed','cancelled_locally','interrupted')),
 last_runtime_sequence INTEGER NOT NULL CHECK(last_runtime_sequence>=0),
 owner_instance_id TEXT NOT NULL,
 provider_session_id TEXT,
 terminal_sequence INTEGER REFERENCES events(sequence),
 terminal_json TEXT,
 result_sequence INTEGER REFERENCES events(sequence)
) STRICT;
CREATE UNIQUE INDEX one_unfinished_run ON runs((1)) WHERE state IN('accepted','running');
CREATE TABLE tool_results (
 run_id TEXT NOT NULL REFERENCES runs(run_id),
 call_id TEXT NOT NULL,
 tool_name TEXT NOT NULL,
 request_id TEXT,
 started_sequence INTEGER NOT NULL REFERENCES events(sequence),
 finished_sequence INTEGER REFERENCES events(sequence),
 result_sequence INTEGER REFERENCES events(sequence),
 is_error INTEGER CHECK(is_error IN(0,1)),
 output TEXT,
 PRIMARY KEY(run_id, call_id),
 CHECK((result_sequence IS NULL AND output IS NULL)
    OR (result_sequence IS NOT NULL AND output IS NOT NULL))
) STRICT;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
 BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
 BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER commands_no_update BEFORE UPDATE ON commands
 BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;
CREATE TRIGGER commands_no_delete BEFORE DELETE ON commands
 BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;
CREATE TRIGGER manifest_creation_immutable
 BEFORE UPDATE OF session_id, created_at_ms, creation_provenance_json ON manifest
 BEGIN SELECT RAISE(ABORT,'immutable session identity'); END;
```

Workspace is immutable in this slice: no workspace-change API. Manifest head/title,
update timestamp, and run/tool projections are mutable only through a corresponding
canonical mutation. No public SQL/connection handle lets ordinary callers bypass it.
Raw SQL fixture checks prove trigger behavior, not protection against a local owner
who deliberately replaces the file or schema.

Do not use AUTOINCREMENT or max(sequence)+1 outside the transaction. Read the current
manifest head under BEGIN IMMEDIATE; allocate the batch's next sequence range with
checked arithmetic; append; update head; write receipt; commit. No committed gaps
are intentionally introduced. Rollback must leave the former head and receipt absent.
An i64 representation exhaustion is an explicit error, not a configured task budget.

The event index supports immutable history paging; runs and tool_results support
current-state/result lookup without reading the complete transcript. This is the
minimum set of projections P1-A implements. It does not prebuild browser chat,
search, approvals, pending-input, provider-management or task-queue schemas.

## 4. DTO and payload rules

Use explicit storage-owned structs/enums with Serde and strict external field checks.
Do not expose SQLx types. Inner existing DTOs retain their existing serialization
rules, rather than silently adding deny_unknown_fields to provider code.

A stored session.created payload contains initial title/workspace and creation
provenance: creation operation ID, canonical request/hash, generated session ID,
creation event ID/time and original creation receipt. Cross-check it against the
singleton manifest and sequence 1. The manifest contains identical immutable
provenance. The original title can differ from today's title after rename.

session.renamed contains exactly the new title. run.accepted contains run_id,
RecordedRunInput, and the current store's instance ID. The instance ID is generated
when a SessionStore takes ownership; it is not persisted as an execution scheduler
or a credential/account identity. An old accepted command keeps its original instance
and result when retried; it is not reassigned to the new instance.

runtime.observed contains the existing full RunEventEnvelope. The columns run_id,
source_event_id/source_sequence must equal its values. Provider session IDs remain
in the nested fields and the non-authoritative run projection; they are not rewritten
as the enclosing application_session_id. Runtime sequence is checked increasing
within the recorded run; session sequence is allocated independently. A source-sequence
gap is recorded rather than filled with invented events. Duplicate IDs/sequences
under a different operation are rejected; exact operation retry returns its receipt.

ToolResult records contain request_id, call_id, output and is_error. The outer run_id
provides identity scope. request_id matches the original execution, not a subsequent
reuse occurrence. Store exact output String bytes, including JSON escaping contained
within that string and all Unicode/newlines; do not reserialize its parsed contents.
The bool is explicit observed data and must agree with a recorded finish flag. It
cannot be inferred from a string containing an error-shaped JSON object. Ordinary
ToolFailed still maps to gateway_error upstream of this store. A stored output-limit
result stays tool_output_limit; storage does not widen or reinterpret that policy.

run.result.recorded contains the complete RunResult. Preserve its execution outcome
and separate delivery status. It may add terminal evidence after an observer failure
left no RunFinished event. If terminal evidence already exists, require the same
outcome (including failure code) and same run/provider session identity; retain the
first terminal_sequence. Summary/delivery/last-response data belongs in the result
record, not an invented second run completion. Completed recording requires results
for every started tool; failed/cancelled recording may expose missing data.

RunOutcome::CancelledLocally is not upstream cancellation. run.interrupted is a new
STORAGE event, with fixed reason process_restart; it does not add a variant to the
existing RunOutcome API. Canonical existing responses, usage, parsed native Value,
effective output and output_provenance are retained without a new normalization pass.

## 5. Transition and projection table

| Input | Preconditions | Transactional effect |
|---|---|---|
| rename | ready session; new/replayed operation identity | title event + current manifest title + receipt; no message edit |
| accept_run | no accepted/running run; unused run ID; validated snapshot | accepted event + runs accepted/owner instance + receipt |
| RunStarted | matching accepted run; increasing source sequence | runtime event + runs running |
| intermediate runtime event | matching running run; supported envelopes | preserve event and advance observed sequence/correlation |
| ToolExecutionStarted | running; new (run,call) | runtime event + started tool row |
| ToolExecutionFinished | matching started row/name/request; no prior conflicting finish | event + finish sequence/is_error; output may still be absent |
| explicit ToolResult | matching started row/request; no prior result; agree with finish if any | result event + exact output/result sequence/is_error |
| ToolResultReused | matching previously saved result/name | runtime event only; no new execution/output row |
| RunFinished | active running; supported outcome; completed has all started results | runtime event + one terminal projection |
| RunResult | active accepted/running OR matching terminal without prior result record | result event + terminal if absent + result_sequence; no second terminal transition |
| prior-instance interruption | accepted/running belongs to an older store instance | interruption event + terminal projection; partial/results unchanged |

Envelope consistency checks should use fields the current types actually supply.
Do not create a second OpenAI parser or recalculate authority from raw native JSON.
P1-A is a recording boundary; only P1-B will connect durable intent to actual execution.

No ordinary runtime/result append is allowed after storage interruption. Recovery
runs under the same session serialization before a newly opened handle is returned.
Repeated opens in the same store do not interrupt that store's own accepted/running
records. Reopening another store requires the old OS lease to have ended. This avoids
mistaking a second browser/handle for a server restart.

## 6. Query shape and data exposure

SessionManifest exposes the application ID, exact current title, workspace snapshot,
created/updated times and committed head. Reading it does not read credentials,
projects, skills or provider sockets. RecordedRun exposes recorded state, not a claim
that some task currently exists. RecordedToolResult includes whether start/finish/result
were recorded; missing output remains None rather than an empty manufactured result.

HistoryPage contains through_sequence, next_after, has_more and ordered StoredEvent
values. Query with sequence > after AND sequence <= H ORDER BY sequence LIMIT n+1,
return at most n and derive has_more from the extra row. Convert n+1 with checked
arithmetic. Capture H and the first query in one read transaction. Later immutable
pages can use short new read transactions with the same H. Reject through > current
head and after > through. after=through produces an empty completed page. No browser
socket owns a transaction or open database connection.

SessionPage uses session_id > after_id ORDER BY session_id LIMIT n+1 and reports
observed catalog fields/availability. It makes no consistent-recency or global
snapshot promise under concurrent inserts. No OFFSET full-table materialization,
whole-session string concatenation, truncation, or history ceiling.

All record-bearing Debug output must be explicitly redacted. Error messages contain
fixed code/stage text only. Store files/backups are private data: excluding OAuth
fields does not imply user prompts cannot contain secrets. No encryption/keyring or
backup/export API is silently added by this schema.
