# Storage and recovery

Wi uses SQLx with bundled SQLite. The data root is explicit and owned by one SessionStore. It is not a provider session and is not shared with Pi or Codex.

```text
data-root/
  catalog.sqlite3
  sessions/<first-two-session-id-characters>/<session-id>/session.sqlite3
```

An OS-backed exclusive root lease prevents independent owners. Multiple clients use one service owner. Connections are operation-scoped; historical sessions do not retain permanent per-session pools.

## Canonical data and versions

Each session owns its manifest, immutable event history and command receipts, run/tool projections, and saved conversation projection. The catalog contains session location and lightweight summaries. A canonical session commit and a later catalog refresh are separate operations; failure of the latter does not undo the former.

| Layer | Version |
|---|---:|
| Session SQLite schema | 3 |
| Catalog schema | 1 |
| Stored event envelope | 1 |
| Runtime event envelope | 2 |
| Nested provider envelope | 1 |
| HTTP API / conversation view | 1 / 1 |

Canonical event types include session creation/rename, run acceptance, history selection, provider binding, runtime observation, actual tool-result recording, final-result recording, and restart interruption. Update/delete triggers preserve canonical history. A title change appends a fact and updates the current manifest, not old messages.

New supported Wi-owned request/local identities are validated at admission. Historical decoding preserves older stored values. This distinction does not reinterpret opaque upstream IDs or fabricate missing provenance.

## Transactional display records

Schema 3 adds five tables:

| Table | Purpose |
|---|---|
| `conversation_projection` | Applied and metadata sequence watermarks |
| `conversation_blocks` | Human interaction identity and current run header |
| `conversation_entries` | Stable ordered display entries and metadata |
| `conversation_fields` | Ordered field identity, generation, and length |
| `conversation_chunks` | Scalar-aligned UTF-8 content chunks |

One logical interaction has several ordered records, not one giant JSON blob or category-separated transcript. Indexed latest/backward reads retrieve saved state. Ordinary warm reads do not reduce the canonical prefix, prepare provider history, or load an entire large text value to truncate a preview.

The shared projector borrows typed writer inputs and applies changes inside the canonical transaction. Event insertion, display updates, receipts, projections, and head commit or roll back together. Backfill uses the same projector, not an independent interpretation. Result bytes and their actual `is_error` are preserved.

Sources: [`session_v3.sql`](../src/storage/session_v3.sql), [`projector`](../src/storage/conversation/projector.rs), and [`reads`](../src/storage/conversation/reads.rs).

## Acknowledgment and failures

Writer connections use WAL and `synchronous=FULL`, foreign keys enabled, and trusted schema disabled. A success receipt follows commit. These settings are not physical power-loss, device, or network-filesystem certification.

Busy timeout is zero: contention is reported, not hidden by an automatic retry loop. Commit ambiguity remains distinct from known noncommit. Durable operation identity supports reconciliation. A lost waiting future does not prove SQL rollback, and a database transaction cannot undo an already executed external effect.

Explicit retirement closes connections. Uncertain worker/lease retirement quarantines ownership rather than admitting a racing owner. Healthy close stops admission, drains owned operations and releases the root lease. The service drains active execution before requesting storage close.

Source: [`database.rs`](../src/storage/database.rs), [`lifecycle.rs`](../src/storage/lifecycle.rs).

## Migration and restart

Explicit `open_session` migrates valid retained version-1 sessions to 2 and version-2 sessions to 3. The additive display migration replays existing canonical records once, in 256-record batches inside its transaction, and commits projection plus version markers together. A completed 1-to-2 migration can remain valid if the subsequent 2-to-3 step fails.

Cold upgrade cost is separate from warm display reads. Declared version-3 corruption does not silently trigger a rebuild or become empty history. Unknown/future/foreign databases are not overwritten.

Opening prior-instance unfinished work records interruption once and preserves committed partial output/results. It starts no model, tool, continuation, or automatic retry. A later explicit task is new work, with provider replay subject to compatibility and completeness checks.

Source: [`migration.rs`](../src/storage/migration.rs), [`session.rs`](../src/storage/session.rs).

## Library queries

SessionStore supports creation, open, catalog listing, repair, and close. SessionHandle supports manifest/rename, acceptance/appends, history/run/tool/receipt reads, catalog refresh, and:

- `conversation_page(ConversationQuery::{Latest, Before, Within})`
- `conversation_entry(run_id, entry_id)`
- `conversation_content(cursor)`
- `conversation_changes(after)`

Returned values retain no database transaction. Short consistent reads capture head and projection together and retire before HTTP delivery.

There is no implemented backup/export/import utility, search index, compaction, branch/fork model, retention deletion, or automatic task recovery. Do not edit SQLite tables manually to bypass an integrity or replay error.
