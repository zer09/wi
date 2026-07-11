# ADR-0003: Use one catalog SQLite database and one SQLite database per session

Status: Accepted  
Date: 2026-07-11

## Context

Wi must list many sessions without opening all session histories, while allowing active sessions to write concurrently and remain independently exportable and recoverable.

A single large database would simplify cross-session queries but would centralize contention and require opening one shared store for all work. One database per session provides fault and lifecycle isolation, but requires a separate index to locate sessions.

## Decision

Use:

```text
catalog.sqlite3
  -> project and session index/summary
  -> session ID to relative database path

session.sqlite3 per session
  -> canonical append-only event history
  -> command idempotency
  -> runs/messages/provider/tool projections
  -> approvals and pending inputs
```

The session database is canonical. The catalog is rebuildable from session manifests.

SQLite access runs only in worker threads:

- one catalog worker
- a fixed session database worker pool
- stable session-to-worker assignment
- lazy database opening and LRU handle eviction

## Consistency rules

- no workflow requires an atomic transaction across catalog and session databases
- commit session events and projections first
- publish only after session commit
- update catalog summary afterward
- repair stale catalog state through reconciliation
- event history is logically append-only; physical SQLite pages/WAL are not required to be append-only

## Consequences

Positive:

- session listing opens only the catalog
- different sessions can progress on separate database workers
- session corruption can be quarantined independently
- session export/backup is naturally scoped
- inactive session databases stay closed

Negative:

- catalog/session consistency is eventually reconciled
- migrations may exist across many separate files
- cross-session search requires a separate rebuildable index later
- backup tooling must understand the multi-file layout

## Alternatives considered

### One SQLite database for everything

Rejected for v0.1 because it weakens per-session isolation and does not match the desired lazy session loading architecture.

### JSONL files

Rejected because Wi needs transactions, constraints, indices, idempotency queries, projections, and migrations.

### One worker per session

Rejected because worker count would grow with session count. Use a fixed pool.

## Validation

- process tests kill Wi before and after commit
- reconciliation tests rebuild catalog rows from session manifests
- concurrency tests write to several session databases simultaneously
- database triggers reject event updates/deletes
- dependency tests prevent SQLite drivers on the main server path
