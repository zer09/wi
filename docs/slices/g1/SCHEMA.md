# G1.1 storage and projection specification

Contract **g1.1**. Required additions, **not implemented by this document**. Runtime source is pinned in VALIDATION.md. Canonical session DB remains authoritative; a display projection is derived data in the same file, not a second transcript authority.

## 1. Versions and preservation

Session `user_version` and manifest.schema_version become 3. Catalog schema1, manifest.format_version1, stored envelope1, runtime2, provider1 and old HTTP API1 are unchanged. The new public display format has conversation_version1.

Schema3 contains every schema2 canonical table/index/trigger with its existing definition plus the five projection tables below. Do not edit existing event/receipt JSON, allocate new canonical sequences for projection maintenance, alter provider history selection/binding, or weaken immutable-event/receipt triggers. The added indexes are query machinery, not quotas.

## 2. Required logical schema

The following DDL fixes the table/column/identity boundaries. New table names may not be replaced by one giant interaction JSON column. Use checked typed decoding and equivalent explicit SQL constraints. Types/column additions required by a demonstrated implementation conflict must be reported before expanding the design.

```sql
CREATE TABLE conversation_projection (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 format_version INTEGER NOT NULL CHECK(format_version=1),
 applied_sequence INTEGER NOT NULL CHECK(applied_sequence>=1),
 metadata_sequence INTEGER NOT NULL CHECK(metadata_sequence>=1)
) STRICT;
CREATE TABLE conversation_blocks (
 run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
 accepted_sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence),
 changed_sequence INTEGER NOT NULL REFERENCES events(sequence),
 header_json TEXT NOT NULL
) STRICT;
CREATE INDEX conversation_blocks_changed
 ON conversation_blocks(changed_sequence,run_id);
CREATE TABLE conversation_entries (
 run_id TEXT NOT NULL REFERENCES runs(run_id),
 entry_id TEXT NOT NULL,
 source_key BLOB NOT NULL CHECK(length(source_key)=32),
 first_sequence INTEGER NOT NULL REFERENCES events(sequence),
 position_slot INTEGER NOT NULL CHECK(position_slot>=0),
 changed_sequence INTEGER NOT NULL REFERENCES events(sequence),
 content_epoch INTEGER NOT NULL REFERENCES events(sequence),
 kind TEXT NOT NULL CHECK(kind IN('human','assistant','tool','reuse','notice')),
 metadata_json TEXT NOT NULL,
 PRIMARY KEY(run_id,entry_id),
 UNIQUE(run_id,source_key),
 UNIQUE(run_id,first_sequence,position_slot)
) STRICT;
CREATE INDEX conversation_entries_order
 ON conversation_entries(run_id,first_sequence,position_slot);
CREATE INDEX conversation_entries_changed
 ON conversation_entries(changed_sequence,run_id,entry_id);
CREATE TABLE conversation_fields (
 run_id TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 field_id TEXT NOT NULL,
 order_key TEXT NOT NULL,
 generation INTEGER NOT NULL REFERENCES events(sequence),
 byte_length INTEGER NOT NULL CHECK(byte_length>=0),
 kind TEXT NOT NULL,
 metadata_json TEXT NOT NULL,
 PRIMARY KEY(run_id,entry_id,field_id),
 UNIQUE(run_id,entry_id,order_key),
 FOREIGN KEY(run_id,entry_id) REFERENCES conversation_entries(run_id,entry_id)
) STRICT;
CREATE TABLE conversation_chunks (
 run_id TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 field_id TEXT NOT NULL,
 start_byte INTEGER NOT NULL CHECK(start_byte>=0),
 bytes BLOB NOT NULL CHECK(length(bytes)>0 AND length(bytes)<=8192),
 PRIMARY KEY(run_id,entry_id,field_id,start_byte),
 FOREIGN KEY(run_id,entry_id,field_id)
  REFERENCES conversation_fields(run_id,entry_id,field_id)
) STRICT;
```

The INTEGER PRIMARY KEY of events already supplies canonical order. Existing runs.accepted_sequence uniqueness supplies a run-order index; use the matching block index rather than OFFSET. Chunk byte offsets and projection sequences fit existing checked SQLite i64 storage. Raw provider counters/indices remain decimal text where needed; do not narrow u64 to JavaScript Number or signed database integers silently.

`header_json` and `metadata_json` are compact, closed typed state WITHOUT growing message text, tool outputs, raw provider objects or arrays of all entries. Human text, tool name/arguments/results, assistant content and any potentially large displayed scalar belong to fields/chunks. Header contains run state, accepted position, result_recorded, observed outcome/uncertainty, summary and stable human-entry reference. No credentials, native/binding payloads, prepared instructions or tool-definition objects enter public state.

Internal `source_key` is SHA256 of a versioned canonical tuple identifying the logical source. It is never a browser capability or credential. Entry ID is `e:<first_sequence>:<position_slot>`; IDs are unique within run, so every public reference includes run_id. A source-key lookup fixes the entry's first position on creation. Replacements retain that position and ID. Hash collisions/conflicting source mappings are integrity failures, not overwrite permission.

Fields are ordered by one documented, lexically sortable ASCII `order_key`: numeric indices use fixed-width 16-digit lowercase hexadecimal u64 encoding; a fixed kind rank separates summary, content, function arguments, fallback and tool output. Null has a distinct rank, not the same value as zero. The encoder/decoder is centralized and tested at u64 extremes. Field IDs are opaque deterministic source keys; the browser uses supplied field order, not native indices.

## 3. Content mechanics

Store each field as valid UTF-8 chunks cut on scalar boundaries, no more than8192 bytes each. Positions are UTF-8 byte offsets. Store embedded NUL and all valid control/Unicode bytes exactly; display safety comes from text DOM, not deleting model content. Empty fields have byte_length0 and no chunks.

On an ordinary append delta, append bytes to the relevant field, updating only its final chunk and newly allocated chunks plus metadata. Do not concatenate/rewrite all preceding chunks or the complete interaction. Concatenating a bounded final chunk is permitted. Field.generation remains unchanged across append-only growth. On replacement of a field's text, discard only its derived chunks, assign generation=current canonical sequence, and write the authoritative value. Original canonical events are never discarded.

Entry.content_epoch changes when its field layout is authoritatively replaced, especially an item/response snapshot that removes or reorders provisional fields. It does not change on every text append or tool-state update. Within an epoch, unchanged fields retain their generations. Full authoritative response replacement can rebuild that response's fields from the already available bounded provider result, but must not reread/reduce prior canonical deltas. Derived field/chunk deletion is not canonical-history deletion or a retention feature.

Range reads use indexed chunk locations. Locate the containing chunk using greatest start_byte<=requested offset, then fetch the intersecting successor chunks. Do not fetch all chunks and slice in Rust. Pages end on UTF-8 boundaries. JSON escaping is included when applying the32KiB/512KiB transfer sizes; those sizes do not impose a stored-content maximum. Many empty/small fields are also segmented; count-limited descriptor reads prevent scanning an entire huge response for one compact entry.

## 4. Typed projector and stable conversation semantics

One pure, versioned interpretation plus targeted SQL updates is used for incremental writes and migration. Its data includes internal correlations needed for the affected entry only; never load an entire session into a JavaScript-like Map and serialize it after each event. Query existing source keys/current field state as needed. Migrate the relevant semantics from web/src/state.ts, not its whole historical fingerprint ledger.

| Actual recorded input | Projection action |
|---|---|
| session.created | Initialize projection watermark and metadata revision; no interaction or invented prompt. |
| session.renamed | Update metadata revision only; not a chat message or new block. |
| run.accepted | Create block keyed by actual run_id and human entry containing exact RecordedRunInput.user_text, not the prepared JSON prompt. Record accepted state; do not mark running/success. |
| run.history.selected / run.provider.bound | Advance applied_sequence only. Private provenance is not display content. |
| RunStarted/TurnStarted | Update block state/correlation as actually observed; no new human interaction. |
| Provider response start/status/delta/item snapshot | Create/update one assistant entry per (run_id, turn_id), with first contributing sequence. Repeated response IDs in different turns cannot collide. Sort sections by output/summary/content indices on the server. An item snapshot replaces that item's provisional sections, not a duplicate message. |
| response.finished | Replace the SAME assistant entry with actual authoritative effective output and OutputProvenance. Native terminal output=[] is not rewritten. Supported text, refusal, reasoning summaries/text and function arguments preserve their actual order. |
| ToolExecutionStarted | Create one tool entry for (run_id,call_id), at the actual start sequence. It can be pending with no result. Function intent displayed in the assistant response is not proof of execution. |
| actual ToolResultRecorded | Attach exact output and actual is_error. Do not infer failure from JSON shape; result existence and finish-event existence are different fields. |
| ToolExecutionFinished | Mark actual finish, preserving missing-result uncertainty. Never manufacture output or replace result is_error from a conflicting inference. |
| ToolResultReused | Add an ordered reuse-reference entry at this occurrence, pointing to the already saved same-run tool entry/result. Include enough compact context to render it. No new effect/result copy. Current caches do not authorize cross-run reuse. |
| RequestFailed/SessionClosed | Attach failure/closure to the current turn if known, or an explicit notice if there is no response identity. Never attach to an earlier turn merely because it has an ID. |
| RunFinished | Update block outcome and any provisional display status; completion is not inferred from EOF. |
| RunResultRecorded | Set result_recorded and actual result/summary/recording facts. Do not append result.last_response as another answer. If final runtime delivery failed, represent that exact outcome separately. |
| run.interrupted | Mark block interrupted; preserve all committed partial text/results. Pending tools remain unknown, not successful or rolled back. |

The old checkpoint's final-output fallback is preserved as a SERVER rule: render recognized effective output sections; if nonempty normalized response.text is not represented by an individual section or their concatenation/newline join, insert one labelled authoritative fallback at the first answer position. Remove only answer sections already covered by that fallback, retaining independent refusals/reasoning. No such heuristic remains in the browser. Unknown native structures get an explicit unsupported marker; do not dump native JSON or reject an otherwise valid execution merely because its display type is unsupported.

Tool names/arguments/results and response fields come from existing typed values and allowlisted native scalars, never a serialized StoredEvent or provider object. Cross-run identical call IDs remain separate. The chronological tuple is (accepted_sequence, first_sequence, position_slot), never category or timestamp. Parent human anchors are references to the same human entry, not additional user records.

## 5. Atomic update points

Integrate the projector into the actual canonical transactions:
- session_schema::initialize after creation insertion;
- session::rename_transaction;
- run_store::mutate for Accept, AcceptHistory and EVERY AppendRunRecord variant;
- interruption::reconcile;
- schema3 migration backfill.

For each transaction apply events in allocated canonical sequence order, update affected display state, then set conversation_projection.applied_sequence to the final manifest head. Receipt-first duplicate paths return existing receipts with ZERO second projection mutation. Multiple affected entities can share the same changed_sequence. The live cursor therefore uses a tie-break key, specified in CLIENT_PROTOCOL.md.

Any real SQL/projection failure rolls back the whole canonical transaction through existing finish_transaction semantics. Preserve commit-unknown, cleanup warnings, owned operations and quarantine. Do not catch a projection failure and publish success, or retroactively label completed external tool work rolled back. Existing execution failure semantics remain responsible for stopping later work. Unsupported display content is a marker, not such a failure.

## 6. Upgrade and validation

New databases initialize directly at schema3. Existing1 first follows the released1->2 path; existing2 receives only the additive display tables/indexes and schema-marker update. At explicit SessionStore::open_session, retain the existing root lease/session serialization, then run2->3 once using BEGIN IMMEDIATE. Stream canonical records in fixed pages of256 through the shared projector; do not fetch_all the whole history. Set applied_sequence and both schema markers only in the successful transaction. Restore connection settings and retire through existing lifecycle paths.

One-time first-open backfill can be expensive. The UI labels the request Preparing conversation; it does not render fake history or start work. A warm schema3 latest read performs NO backfill. Test/measure upgrade separately from warm access. No global installation scan or automatic upgrade of unrelated sessions when listing. Process death before commit leaves valid2; after commit leaves valid3. Duplicate open cannot double-create projections. Old1->2 may already have committed before2->3 fails; report that truthful intermediate state.

Historical event/command/receipt/source bytes and sequence values are preserved exactly. No current account assignment to legacy histories, credential read, skill reread, model open/generation or tool invocation. Existing B2 incomplete/unbound replay refusal remains independent from the ability to DISPLAY those runs.

Update session_schema::version/structure, new-db initialization, catalog observation/repair validators and tests that intentionally assert newest supported version. Do not globally replace every '2' in tests: independent populated1/2 fixtures remain genuine old schemas; future-version fixtures become unsupported4 or an explicitly higher version. Validate projection tables/indexes and applied_sequence==manifest head on ready3 access. Corrupt/missing/mismatched projections in a declared3 database fail safely as storage.integrity; do not silently delete/rebuild them or overwrite the DB. No generic repair/export command is introduced.

## 7. Query invariants

A conversation page opens one consistent read transaction and captures manifest head H plus projections at H. Return only after connection/lock retirement. Never keep a SQL transaction across a network write, browser wait or model call. Retain existing operation ownership rather than introducing a pool/worker registry.

Latest lookup selects greatest accepted_sequence<=H; previous lookup selects greatest accepted_sequence<cursor.before. Entry segment selects descending immutable (first_sequence,position_slot) within exactly one block, returns chronological order after selection. Choose only contiguous tail entries fitting the serialized payload and count bounds. Human anchor and block header are always supplied. If a block is otherwise empty, return the human anchor/state with empty activity. No OFFSET, raw-event prefix walk, run_record plus full event reconstruction, B2 replay preparation or full text fetch in warm page reads.

Field/content queries use current generation with a fixed upper content boundary, so later appends do not shift older membership. Replacement invalidates that entry's stale content cursor only. Metadata/state comes from the current page snapshot; do not claim cross-page time travel. The shared changed-entity reader uses indexed changed_sequence and type/identity ordering as defined by the protocol. These are implementation requirements to prove with query counters and EXPLAIN, not performance claims established by this plan.
