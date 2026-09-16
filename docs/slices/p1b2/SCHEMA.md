# P1-B2 storage extension and migration

Contract **p1b2.0**, baseline `6fe0a538edf6bae39c9f933db8394b7d8483e2be`.
**PLAN ONLY / NOT RUN.** This file defines the minimum storage changes for CONTRACT.md.
No new database engine, connection pool, catalog table or rendered-message projection.

## 1. Versions and ownership

Session application_id stays 1464423233. Session user_version and manifest.schema_version
become **2**; manifest.format_version stays 1. Catalog application_id 1464419137 and
schema/user_version **1** stay unchanged. Its existing sessions.schema_version is an
observation of a session file and may be 1 or 2.

New session creation initializes v2 directly. Existing valid v1 sessions are upgraded
lazily when explicitly selected with open_session, under the same root lease and
per-session ownership used for opening/interruption. No provider/tool code is reachable.
Catalog-only listing does not migrate or open all historical sessions. Explicit catalog
repair can inspect either supported version read-only without upgrading every file.
Foreign, corrupt, malformed or future-version data is preserved and rejected.

Keep the released session_v1.sql and independent populated v1 fixtures as genuine
migration inputs. Add session_v2.sql and a tested v1->v2 migration. Do not relabel a
new initializer as migration coverage. Every original event/receipt/manifest creation
identity and run/tool row must retain its data exactly. The migration adds no history
sequence, run, interruption, account binding or operation receipt merely for migration.
Existing open-session interruption, when applicable, follows successful migration.

## 2. Closed event-set extension

All current event types remain. Add only:

| event_type | event_version | payload |
|---|---:|---|
| run.history.selected | 1 | run_id plus StoredHistorySelection |
| run.provider.bound | 1 | run_id, provider_session_id, requested_model, ReplayIdentity |

Stored envelope schema remains 1; the session file schema distinguishes reader support
for the expanded event set. Existing runtime-observed envelopes remain schema 2 with
provider envelope schema 1. Both new event types have run_id set and source_event_id/
source_sequence NULL. Do not manufacture runtime/provider events for these facts.

The events table definition is unchanged except for the extra names in its CHECK:

```sql
CREATE TABLE events_p1b2_new (
 sequence INTEGER PRIMARY KEY CHECK(sequence>0),
 event_id TEXT NOT NULL UNIQUE,
 event_type TEXT NOT NULL CHECK(event_type IN(
   'session.created','session.renamed','run.accepted',
   'runtime.observed','tool.result.recorded','run.result.recorded','run.interrupted',
   'run.history.selected','run.provider.bound')),
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
```

New v2 databases create this as events rather than events_p1b2_new. Other table column
layouts and existing constraints remain as v1. No additional table is needed: the
existing events_run_sequence index supports the two typed point lookups. Enforce
unique selection/binding per run through transactional validation and repair replay.
Do not rely only on API constructors to validate stored input.

## 3. Transactional v1 migration

Use a dedicated operation-owned connection with no concurrent session mutation, after
validating the actual v1 schema/identity/provenance and referential integrity. SQLite's
CHECK expansion requires rebuilding events. Use the safe create/copy/drop/rename order;
never rename the original table first and accidentally retarget dependent foreign keys.

The migration connection may temporarily set foreign_keys=OFF BEFORE BEGIN IMMEDIATE;
this is an explicit migration-only exception to normal connection settings. Retain WAL,
FULL, private cache, trusted_schema=OFF and disabled statement logging. Normal connections
continue requiring foreign_keys=ON. No general configuration switch is added.

Within one transaction:

1. Recheck supported v1 identity/state and absence of preexisting migration-temp objects.
2. Create events_p1b2_new with the definition above.
3. Copy the nine original columns directly using INSERT ... SELECT. Do not deserialize,
   normalize, trim or reserialize historical payload_json/receipt strings.
4. Drop events (foreign keys are temporarily disabled), then rename events_p1b2_new to events.
5. Recreate its three explicit indexes exactly:

```sql
CREATE UNIQUE INDEX events_source_id ON events(source_event_id)
 WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX events_source_sequence ON events(run_id, source_sequence)
 WHERE source_sequence IS NOT NULL;
CREATE INDEX events_run_sequence ON events(run_id, sequence);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
 BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
 BEGIN SELECT RAISE(ABORT,'immutable history'); END;
UPDATE manifest SET schema_version=2 WHERE singleton=1;
PRAGMA user_version=2;
```

6. Validate v2 structure, row counts, manifest/head, creation provenance, all dependent
   foreign keys (PRAGMA foreign_key_check) and the unchanged dependent triggers/indexes.
7. Commit. Restore foreign_keys=ON and verify normal settings before any subsequent
   normal operation; explicitly close this connection. On failure roll back and close,
   preserving the primary failure. Uncertain commit/retirement follows P1-A certainty
   and lease rules; do not claim a successful rollback merely because an await failed.

Real fresh-process tests must kill/exit during copy, before commit and after commit,
then inspect either complete v1 or complete v2, never half a schema. Injected failure is
labelled as such. Ordinary process tests do not certify hardware power-loss durability.
A committed migration is not undone by later failed replay/preflight/recording.

Keep an independently populated v1 fixture containing multiple runs, title change,
partial content, an effective recovered response, a tool result and receipt. Compare
all old table row values, payload_json/receipt_json bytes, IDs, original creation
provenance and prefix hashes before/after migration. Test references using real foreign
key checks rather than count equality alone.

## 4. Selection payload and acceptance

StoredHistorySelection is an owned, private-field, validated, serializable type:

```text
policy: "closed-exchanges-v1"
through_sequence: positive u64 representable by SQLite i64
history_digest: 64 lowercase hexadecimal SHA-256 characters
provider_id: nonempty String
requested_model: nonempty String, valid under existing model validation
expected_identity: Option<ReplayIdentity>
```

It is provenance, not an executable provider handle or auth credential. The new
SessionHandle::accept_history_run(operation_id, run_id, input, selection) is an explicit
storage operation, sharing B1's acceptance coordination. Its command method is
`accept_history_run`, distinct from existing `accept_run`.

Canonical operation hashing uses the same recursive typed-JSON convention as P1-A,
covering method/session/run/input/selection and excluding operation ID/generated values.
Original operation receipt lookup precedes current-head/active-state eligibility. Same
method/content returns the old range. Different method/input/run/selection conflicts.

For new acceptance, BEGIN IMMEDIATE; check current manifest head equals selection.H;
validate positive H/provider/model linkage to input, then active-run and identity rules.
Append adjacent records:

```text
H+1 run.accepted       existing AcceptedPayload, unchanged
H+2 run.history.selected { run_id, selection }
```

The runs projection accepted_sequence is H+1. The one receipt covers H+1..H+2. Manifest
head and both rows commit atomically. No selection-only or accepted-only partial commit.
Mismatch to current head produces StorageErrorKind::StaleHistory / storage.stale_history
with NotCommitted certainty, no new rows. It does not automatically rebuild or retry.

The storage layer validates structural/link conditions; the execution builder validates
the actual digest and replayability. As with P1-A, caller-supplied records are not
cryptographically authenticated execution. Explicit repair independently checks digests
and canonical cross-links before classifying a session ready.

Selection must immediately follow its run.accepted record and have H=accepted_sequence-1.
No ordinary append_run_records variant can insert selection later. history_selection
validates its event/run link, stored policy/version/provider/model and adjacency on read.

## 5. Provider-binding payload and mutation

RecordedProviderBinding contains run_id, provider_session_id, requested_model and
identity:ReplayIdentity. It records what the newly opened provider actually reports;
it does not infer an account from old responses, current profile names or a token hash.
Its sensitive getters are explicit; Debug/Display redact all account/native values.

Add AppendRunRecord::ProviderBinding with that payload. This permits the existing
observer -> append_run_records -> receipt/error pipeline to save binding without a
second writer. It is valid only for a history-selected run that:

- is running and has observed RunStarted;
- has no provider-binding record yet;
- has not observed TurnStarted, provider/tool events or any result;
- names the input's provider/requested model and a nonempty actual provider-session ID.

Store the binding exactly once, update runs.provider_session_id consistently, and retain
run.last_runtime_sequence unchanged because this is not a runtime event. A normal next
TurnStarted/RunFinished must agree with that provider identity. A failed identity check
may deliberately bind to an actual DIFFERENT principal and then record failed execution
with zero model attempts; expected-vs-actual comparison belongs to the execution gate,
not a storage rejection that would strand the run.

Same operation ID returns the original receipt; another operation attempting a second
binding is an invalid transition. ProviderBinding failure obeys B1 recording-failure
semantics. No new tool result or runtime terminal is synthesized by storage.

provider_binding(run_id) validates the run's selection, event linkage and provider
projection. A definitely unsubmitted failed attempt can have no binding when the opened
provider did not supply one. Such an attempt is not retrospectively bound on replay.

## 6. Read/repair compatibility

Read v1 before migration and v2 after migration with version-aware structure checks.
Do not silently accept v3 or drop the old immutability checks. Existing reads/receipts
and ordinary supplied-input B1 runs keep working on v2; they simply lack replay metadata.

Extend run-history replay validation to account for selection after acceptance and
binding after RunStarted but before turns. No mutation may add selection/binding to an
already terminal legacy run. Verify forward and reverse links, uniqueness, provider
identity, policy, prefix digest and command receipt ranges. B2 capture must still pass
P1-A/B1 complete-run repair tests, including result-before-finish and finish-before-result.

Catalog repair inspects supported v1/v2 sessions without running them. Preserve fault
isolation, missing/future/corrupt classification, duplicate creation-claim handling and
explicit durable repair intent. A good catalog reconstruction does not imply a history
is replayable: a legacy unbound session can be ready/readable while run_in_session
rejects native replay.

A migration changes the file's schema version without changing its canonical head. A
subsequent explicit catalog refresh may advance observed schema 1->2 at the same head
ONLY when all other canonical summary values match. It must still reject regressed
heads, inconsistent same-head content, unknown/failed availability promotion and schema
downgrades. No atomic catalog/session migration promise: canonical success remains
successful if later catalog refresh fails.

## 7. New facts versus preserved facts

New: session v2, lazy v1 migration, two canonical event types, B2 acceptance method,
typed selection/binding reads and storage.stale_history. No other error code is renamed.
Preserved: all original history bytes and receipts; canonical creation; runtime/provider
schemas; tool-result serializer/error semantics; root lease; operation ownership; catalog
refresh/repair authority; no-auto-resume. No extra credential/materialized-message tables,
new retention threshold or automatic cleanup is authorized.
