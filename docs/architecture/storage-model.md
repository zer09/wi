# Wi v0.1 storage model

Status: canonical for the first vertical slice

## 1. Goals

The storage design must support:

- fast session listing without opening every session database
- one durable, self-contained database per session
- multiple sessions progressing concurrently
- exact event replay after browser or server interruption
- idempotent command handling
- durable approvals and pending questions
- crash recovery without cross-database atomic transactions
- lazy opening and bounded database-handle usage
- future export, backup, migration, and catalog reconstruction

## 2. Filesystem layout

```text
$WI_HOME/
├── catalog.sqlite3
├── sessions/
│   └── <two-character-prefix>/
│       └── <session-id>/
│           ├── session.sqlite3
│           └── artifacts/
├── logs/
└── tmp/
```

Rules:

- `WI_HOME` is resolved once at startup.
- The backend generates session paths; browser input never supplies them.
- Catalog paths are relative to `WI_HOME`.
- Session-directory prefixes are derived from session IDs to avoid oversized directories.
- Every test uses a unique temporary `WI_HOME`.
- Credentials are not stored in catalog or session databases.

## 3. Canonical ownership

The dedicated session database is canonical for one session.

The catalog database is a rebuildable index used to:

- list sessions
- map a session ID to a relative database path
- show lightweight status and attention counts
- locate sessions needing recovery or migration
- avoid opening every session database at startup

A successful session write never depends on a catalog write succeeding.

```text
session transaction commit
  -> publish committed session events
  -> update catalog summary asynchronously or immediately afterward
```

If the catalog update fails, the session remains valid and the catalog is reconciled later.

## 4. Catalog schema responsibilities

Minimum catalog records:

```text
catalog_meta
projects
sessions
catalog_commands
```

### `projects`

Stores registered project metadata and canonical paths. The first slice may create one test project and does not yet expose real filesystem tools.

### `sessions`

Stores only summary/index data:

- session ID
- optional project ID
- database relative path
- title
- lifecycle status
- created and updated timestamps
- last event sequence
- last run state
- last message preview
- attention flag
- pending approval/input counts
- session schema version

### `catalog_commands`

Provides idempotency for global commands such as `session.create`, where no session database exists yet.

A catalog command stores:

- `command_id`
- method
- canonical payload hash
- current creation/acceptance state
- reserved session ID and path
- durable result
- timestamps

## 5. Session database responsibilities

Every session database contains at least:

```text
manifest
events
accepted_commands
runs
messages
message_parts
provider_steps
tool_executions
approvals
pending_inputs
```

### `manifest`

Contains enough information to reconstruct the catalog entry:

- session ID
- project ID when present
- creation time
- schema version
- session-format version
- title
- last event sequence

### `events`

The canonical ordered history. Rows cannot be updated or deleted.

Representative schema:

```sql
CREATE TABLE events (
    sequence INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    event_version INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    run_id TEXT,
    item_id TEXT,
    payload_json TEXT NOT NULL
) STRICT;
```

Triggers reject update and delete operations.

### `accepted_commands`

Provides session-scoped command idempotency.

It stores:

- command ID
- method
- canonical payload hash
- accepted event sequence
- run ID when applicable
- durable result JSON
- acceptance time

### Projection tables

`runs`, `messages`, `message_parts`, `provider_steps`, `tool_executions`, `approvals`, and `pending_inputs` are query-optimized projections maintained transactionally with events.

They are rebuildable from canonical events in principle, but Wi updates them during normal operation to avoid full-history replay for ordinary UI reads.

## 6. Append-only meaning

Wi's event history is logically append-only:

- application code appends new events
- event rows are never updated
- event rows are never deleted
- corrections are represented by later events

SQLite's physical database and WAL files are not required to be physically append-only. Checkpoints, page reuse, and maintenance operations may rewrite database pages.

The guarantee is semantic and enforced by schema, triggers, repositories, and tests.

## 7. Transaction boundary

One session mutation transaction performs:

```text
BEGIN IMMEDIATE
  -> verify command idempotency
  -> append one or more events
  -> update affected projections
  -> update manifest head
  -> persist command result when applicable
COMMIT
  -> publish committed events
```

Publication before commit is forbidden.

A crash:

- before commit leaves no visible durable mutation
- after commit but before publication is recovered by replay

## 8. Event sequencing

`sequence` is session-local and monotonically increasing.

The repository derives the next sequence under the session's serialized writer path. It does not accept a browser- or provider-supplied sequence.

Rules:

- no gaps are intentionally created by normal commits
- event IDs are globally unique but do not determine order
- the browser reducer applies events by sequence
- duplicate sequence delivery is ignored only when the event identity/content matches the already applied event
- conflicting content for an existing sequence is a fatal session integrity error

## 9. Database worker architecture

SQLite operations run in Node.js worker threads.

```text
main server thread
  ├── CatalogClient -> catalog worker
  └── SessionStoreClient -> fixed session worker pool
```

### Catalog worker

- owns the catalog connection
- processes validated RPC requests serially
- performs catalog migrations and reconciliation metadata updates

### Session worker pool

- has a bounded fixed size
- assigns a session consistently using a stable hash
- lazily opens session databases
- keeps an LRU cache of open handles
- serializes writes for each assigned session
- closes idle handles when capacity is exceeded

No worker is created per session.

## 10. Worker RPC

Worker messages use a versioned internal RPC envelope and runtime validation.

Every request carries:

- RPC version
- request ID
- operation name
- bounded payload
- relevant session ID
- trace identifiers when available

Every response carries:

- request ID
- success result or typed error
- worker ID
- optional diagnostic ID

A worker crash rejects its in-flight requests, emits a diagnostic, and causes the supervisor to create a clean replacement. The web server remains alive unless storage-wide invariants can no longer be trusted.

## 11. Session creation state machine

Session creation spans catalog and session databases without pretending to be one atomic transaction.

```text
1. Canonicalize and hash `session.create` command.
2. Reserve command, session ID, and generated path in catalog.
3. Create session directory.
4. Initialize and migrate session database.
5. Insert manifest and `session.created` event.
6. Commit session database.
7. Mark catalog session and command ready/accepted.
8. Acknowledge browser.
```

Recovery handles:

```text
catalog says creating + valid session DB exists
  -> inspect manifest and complete registration

catalog says creating + no valid DB exists
  -> retry or clean incomplete reservation

session DB exists + no catalog row
  -> reconstruct catalog row from manifest

catalog row exists + DB missing
  -> mark missing and report diagnostic
```

## 12. Command idempotency

Canonical JSON is hashed with SHA-256.

For the same `commandId`:

```text
same method + same payload hash
  -> return stored result; do not execute again

different method or payload hash
  -> conflict; do not execute
```

A command acknowledgement is sent only after its acceptance record and related events commit.

This protects against:

- lost WebSocket acknowledgements
- browser retry after reconnect
- two tabs submitting the same command
- process death after commit but before reply

## 13. Catalog reconciliation

The reconciler compares catalog summary data with session manifests and heads.

It may repair:

- last event sequence
- status
- title and preview
- pending attention counts
- schema version
- orphaned session entries

It never rewrites canonical session events.

Reconciliation runs:

- at startup for incomplete catalog states
- when opening a session whose summary appears stale
- through an explicit maintenance operation

## 14. SQLite configuration

Each connection should configure at minimum:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = FULL;
```

The exact adapter is internal to `packages/storage`. The first plan recommends `better-sqlite3`, but callers depend only on Wi repositories and clients.

Databases are expected on local storage. Network filesystems are outside the supported v0.1 boundary.

## 15. Migrations

Catalog and session databases have separate migration sequences.

Requirements:

- schema version stored explicitly
- deterministic ordered migrations
- tests from every retained prior version
- no eager opening/migration of every session database at server startup
- session migration occurs when that session is opened or through explicit maintenance
- a failed session migration quarantines only that session
- a failed catalog migration prevents normal server startup because session discovery cannot be trusted

The first vertical slice begins at schema version 1 but still implements the migration framework.

## 16. Recovery states

At startup, unfinished projections are interpreted conservatively:

```text
provider step marked streaming
  -> interrupted

run marked running with no resumable active task
  -> interrupted or waiting, based on latest durable state

pending approval/input
  -> remain pending

tool marked started with no result
  -> reconcile according to effect class

completed run
  -> remain completed
```

The first slice's pure tools may safely retry only under the ledger policy defined in ADR-0008.

## 17. Artifacts and large payloads

Large outputs should not be stored repeatedly inside event JSON.

A later artifact layer may store content-addressed blobs beneath the session's `artifacts/` directory. Events then contain:

- artifact/blob ID
- content type
- byte length
- preview
- integrity hash

The first slice can keep outputs small but should preserve the abstraction boundary.

## 18. Backup and export

A session export uses a consistent SQLite backup or snapshot operation and optionally includes session artifacts.

It never includes:

- API keys
- OAuth tokens
- browser session secrets
- credential-vault material

The catalog is rebuildable, but a complete installation backup should include both catalog and session directories.

## 19. Failure tests

Process-level tests must cover:

- death before session commit
- death after session commit but before catalog update
- death after commit but before publication
- death during session creation
- database worker death during a request
- stale catalog reconciliation
- corrupt or missing session database handling
- disk-full or write-failure simulation where practical
- too many open session handles and LRU eviction

The core assertion is always:

```text
browser-visible durable state == committed session database state
```
