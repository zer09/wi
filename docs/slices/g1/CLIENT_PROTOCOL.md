# G1.1 conversation HTTP and browser protocol

Contract **g1.1**. NEW interfaces and replacement behavior, not checkpoint implementation evidence. Existing V1-B API1 commands and raw /history and /events remain compatible. SECURITY.md applies to every new route. RUST_API.md fixes the shared read surface.

## 1. Types and errors

Display responses use api_version1 plus conversation_version1. Sequences, counters, byte offsets, ordinals and timestamps are canonical decimal STRINGS; boolean/version fields retain their actual types. Rust uses checked integers; browser uses BigInt only where arithmetic is necessary. UUID/enum validation stays strict. Do not parse large numbers through JavaScript Number first.

`BlockView` has run_id, accepted_sequence, revision, state, result_recorded, outcome, summary, events_complete, sink_error and human. state uses existing accepted/running/completed/failed/cancelled_locally/interrupted. outcome/summary use V1-B's safe recorded representations or null. events_complete:boolean|null and sink_error:safe-code|null report actual evidence. human is the compact EntryView for the one human anchor.

`EntryView` has run_id, entry_id, position:{sequence,slot}, revision, content_epoch, kind, recorded_state, provisional, reference, fields, earlier_content and content_complete. kind=human|assistant|tool|reuse|notice. recorded_state=accepted|in_progress|completed|incomplete|failed|cancelled|interrupted|unknown. reference=null or {run_id,entry_id}. For uniform closed decoding add result_recorded:boolean|null, finish_recorded:boolean|null and is_error:boolean|null; these are meaningful for tool/reuse entries, null otherwise. The browser does not derive block/tool outcome from event order or JSON shape.

`FieldFragment` has field_id, order_key, kind, generation, total_bytes, from_byte, to_byte, text, has_earlier and has_later. Text encodes exact UTF-8 bytes[from_byte,to_byte), with scalar-aligned offsets. Fields arrive in server display order. kind is text|refusal|reasoning_summary|reasoning_text|function_name|function_arguments|tool_name|tool_result|authoritative_text|unsupported|notice. Human single text field can use order_key="0"; response numeric-index order keys follow SCHEMA.md. No native maps, prepared instructions, provider binding/digests or credential/config objects are public.

New storage ConversationError maps Storage(error) through existing ErrorView::storage. CursorInvalid adds api.conversation_cursor_invalid/400; CursorStale adds api.conversation_cursor_stale/409. Existing flat ErrorView structure, stages and certainty remain. Invalid syntax/resource/future boundary is400. Replaced content generation/epoch is409. Missing session/entry is404. Corrupt/future DB is its actual storage error, not empty history. Do not echo cursor/content diagnostics.

## 2. Latest and backward pages

```http
GET /v1/sessions/{sid}/conversation
GET /v1/sessions/{sid}/conversation?before=<previous_block>
GET /v1/sessions/{sid}/conversation?within=<earlier_activity>
```

Latest returns exactly newest accepted block B at a consistent read head H. No runs gives block=null and empty entries. Each ordinary response is one block, never A+B to reach an entry target. before returns greatest accepted_sequence strictly below its boundary; within returns the preceding contiguous entry segment inside the same run. Results are in forward display order after backward selection. Reject unknown/repeated queries or simultaneous before+within. No offset/limit/through query for these routes.

`ConversationPage` fields: api_version,conversation_version,session_id,snapshot_head,session,block,entries,earlier_activity,previous_block,live_after. session is the existing public metadata shape. entries excludes the human anchor already supplied by block.human. live_after is present ONLY on Latest; backward pages return null and cannot reset live observation. A backward response with no older block is200 with block=null and no older cursors.

Example of a newly accepted B with no assistant activity yet:

```json
{
  "api_version":1,
  "conversation_version":1,
  "session_id":"11111111-1111-4111-8111-111111111111",
  "snapshot_head":"211",
  "session":{"session_id":"11111111-1111-4111-8111-111111111111","title":"Review","workspace":"/synthetic/project","created_at_ms":"1","updated_at_ms":"10","head_sequence":"211"},
  "block":{
    "run_id":"22222222-2222-4222-8222-222222222222",
    "accepted_sequence":"210","revision":"210","state":"accepted",
    "result_recorded":false,"outcome":null,"summary":null,"events_complete":null,"sink_error":null,
    "human":{
      "run_id":"22222222-2222-4222-8222-222222222222","entry_id":"e:210:0",
      "position":{"sequence":"210","slot":"0"},"revision":"210","content_epoch":"210",
      "kind":"human","recorded_state":"accepted","provisional":false,"reference":null,
      "result_recorded":null,"finish_recorded":null,"is_error":null,
      "fields":[{"field_id":"text","order_key":"0","kind":"text","generation":"210","total_bytes":"6","from_byte":"0","to_byte":"6","text":"Task B","has_earlier":false,"has_later":false}],
      "earlier_content":null,"content_complete":true
    }
  },
  "entries":[],"earlier_activity":null,
  "previous_block":"<encoded g11b cursor before210>",
  "live_after":"<encoded g11l watermark211>"
}
```

Cursor placeholders above explain locations only; real DTOs use the encodings below. The acceptance has two canonical records210/211; private selection advances the snapshot watermark without adding display content. Timestamps are illustrative Unix milliseconds, not canonical sequence values.

A previous-block request using that g11b cursor returns A (accepted_sequence<210), A's anchor and entries, a new earlier_activity/previous_block if needed, its own snapshot_head and live_after:null. Newer B/C activity cannot shift A's membership. Example request meaning after decoding: [1,S,"210"] selects A, not 'skip210 events'.

For huge B, select newest contiguous activity fitting at most64 entries and512KiB encoded page, including anchor/header overhead. Each compact anchor/entry is<=32KiB. Return explicit earlier_activity and per-entry earlier_content; complete B's missing content/activity before navigating A. Repeated human metadata is the same entry, not another canonical message.

## 3. Entry/content reads

```http
GET /v1/sessions/{sid}/conversation/entries/{run_id}/{entry_id}
GET /v1/sessions/{sid}/conversation/content?cursor=<earlier_content>
```

Return {api_version,conversation_version,session_id,snapshot_head,block,entry}; no live cursor. Addressed entry read supplies its current compact state for stale-content recovery. A reuse's content reference may target the original same-run tool entry; it does not create a second result or execute work.

Compact encoding walks entry fields in reverse display order and reads newest field bytes first within32KiB, then returns selected fragments in forward order. It also bounds descriptor scanning for many empty fields (at most64 field descriptors per fragment). Earlier_content identifies the immediately preceding field/byte boundary, so it covers preceding fields and earlier text. Each nonterminal request yields at least one scalar or one previously absent empty/unsupported field descriptor. No zero-progress cursor loop. JSON escaping, metadata and token overhead count. Never fetch a complete huge value to slice a preview.

Within an unchanged content_epoch and field generation, append growth does not move an already issued upper boundary. Authoritative replacement invalidates old content cursors with409. Client shows Content changed and can explicitly refresh that entry, not silently retry or clear unrelated blocks.

Generic range merging: same-epoch/generation overlapping bytes must agree; merge compatible ranges once and keep their earlier loaded portions. New epoch clears only that entry's old field/range layout. New field generation replaces that field. A missing interval is labelled and has a continuation, not an invented concatenation. Entry revision/state comes from the newest received representation; an older page cannot overwrite it. This is display-buffer management, not provider-event reconstruction.

## 4. Distinct cursor types

Prefix plus URL-safe base64 without padding of minified UTF-8 JSON array. Version is number1; numeric positions/ranks are canonical decimal strings. Parse strict field counts/types, at most4096 encoded bytes. No embedded file path, SQL, token or provider object. Cursors are not authentication. Validate IDs/boundaries against the authenticated SessionHandle.

- g11b. + [1,sid,before_accepted_sequence]. Actual block boundary; select strictly older block.
- g11s. + [1,sid,run_id,before_entry_sequence,before_slot]. Actual same-run boundary; select strictly older entries.
- g11c. + [1,sid,run_id,entry_id,content_epoch,upper_field_id,upper_generation,exclusive_upper_byte]. Epoch/generation must match; upper byte is scalar-aligned and within append-compatible length. Upper0 means move to preceding field. Validate epoch before treating an old missing field as ordinary not_found.
- g11l. + [1,sid,sequence,rank,run_id_or_empty,entry_id_or_empty]. rank="0"metadata,"1"block,"2"entry,"3"watermark. IDs are empty only as their rank requires. Initial cursor is [1,sid,H,"3","",""] and represents all state at/below H.

Order changed entities by (sequence,rank,run_id,entry_id) using numeric first two fields and canonical ASCII identity order. Browser handles cursors opaquely, with lightweight version/session checks; server owns query semantics. No time expiry. New writes do not invalidate immutable older membership. Do not promise older pages are frozen at the initialH: each returns current revisions from its own snapshot while retaining stable membership.

## 5. Display stream

```http
GET /v1/sessions/{sid}/conversation/events?after=<g11l cursor>
```

Require after. If Last-Event-ID is also supplied it must exactly match. Reject before200 on conflict. Keep existing raw/events unchanged.

```
event: wi.conversation
id: <next g11l cursor>
data: {"api_version":1,"conversation_version":1,"session_id":"...","observed_head":"...","changes":[...],"next_after":"..."}

```

Closed change union:
- {kind:"session.upsert",session:<public metadata>}
- {kind:"block.upsert",block:<BlockView>}
- {kind:"entry.upsert",block:<BlockView>,entry:<EntryView>}

Header and human anchor accompany an entry update so it is self-contained. A human entry upsert updates the same block.human identity, not a second bubble. Changes can coalesce intermediate revisions. This is current display-state synchronization, not an audit feed or guarantee of every raw event/delta.

Actual server algorithm:
1. Open short consistent read transaction and capture canonical/projection head U.
2. Merge indexed current metadata/blocks/entries with changed tuple>after and changed_sequence<=U. Each source partition fetches at most64 candidates plus bounded lookahead. No entire-projection scan.
3. Emit a prefix fitting512KiB. If candidates remain, next_after is exactly the last emitted entity tuple, including ties. Otherwise use U's rank3 watermark, including an empty change batch if private-only events advanced U.
4. Retire SQL/locks before yielding. Continue from next_after. When caught up wait250ms; idle heartbeat every15s. Slow clients keep bounded pages only, not a producer queue.

Several entities can share a transaction's sequence. Never watermark toU after emitting only some of them. An entity updated between reads moves to a newer sequence and is subsequently delivered at that state; it cannot be skipped by a same-sequence page tie. Head and projections must come from one snapshot. Current rows do not disappear: field replacement uses epochs, not entry deletion. No need for a second per-delta display event log/full-text copies.

Snapshot H and stream afterH form one handshake: events committed after snapshot/before attach are reflected by newer projected revisions. Starting at an independently read 'now' is prohibited. A stream does not have to reproduce intermediate states already superseded, but must converge to the latest committed state without missing a final change.

Client inserts/replaces loaded entries by stable ID/position/revision. Older revisions cannot overwrite. Equal-generation overlapping content must match. Unloaded older entries remain unloaded; their upserts do not append out-of-context content at bottom or trigger backscroll. Newer blocks are appended with their anchors. Generic display changes apply atomically before cursor advancement, with no consecutive raw-sequence requirement. Server metadata updates do not change conversation order.

Retain existing safe wi.error and wi.closed observation endings. EOF/shutdown is not execution completion; a disconnected observer never sends Cancel implicitly.

## 6. Selection, rebase and scrolling

```
select/refresh -> latest read -> render B -> SSE after H
                              -> initial viewport fill independently
read failure -> disconnected/stale current view
explicit Reconnect latest -> new observation epoch -> latest read
 success -> replace loaded window/older cursors -> SSE after newH -> fill
 failure -> retain old stale window, no mutation or automatic retry
```

Full page reload requires Connect under the retained memory-only token policy. Same-page rebase preserves draft/pending IDs/known receipts and clears them only through explicit resolution or Disconnect. A new page does not recover page-memory commands and POST them. Session/connection epochs ignore stale readers and replies.

Render B before asking for A. After layout, if no overflow, request one earlier content/segment/block. Recheck after render/live growth. If filled before another read, stop. A read already admitted can complete subject to epochs; then stop if filled. Once initial fill ends, resize/font/layout callbacks cannot restart it.

After initial fill, upward human intent within96CSSpx of top or accessible Load older activates one read. Programmatic scroll after prepend/intersection/resize alone cannot cascade. Preserve stable entry/field+pixel anchor within2CSSpx in deterministic tests. Follow bottom only if within24px before update; otherwise show New activity and preserve reading position. Backscroll errors get a local retry; healthy live observation continues. End-of-history disables further older requests.

## 7. Pending tasks and server reconciliation

Keep existing create/rename/task/cancel/operation/run routes. Task body remains {operation_id,run_id,text}. Immutable page-memory command identity survives an ambiguous reply.202 means actual acceptance, never successful execution. Explicit retry uses the same body; rebase/EOF does not automatically POST.

Add:

```http
POST /v1/sessions/{sid}/runs/reconcile
Content-Type: application/json
{"operation_id":"...","run_id":"...","text":"exact original task"}
```

Reuse router/runs.rs::raw_receipt including its actual method/hash/input proof. No context preparation, host submission, credential/provider open or tool work. Existing explicit-open storage migration/interruption is the sole maintenance qualification. Return200 {api_version:1,state:"accepted",acceptance:<ReceiptView>,run:<RunView>} or {api_version:1,state:"not_found",acceptance:null,run:null}. not_found is only a point-in-time absence, not proof of rollback of a previously unknown operation. Conflict/read failures use existing flat errors and certainty.

The browser checks returned operation/session/run identity, not B2 sequence arithmetic or raw-event types. Off-screen accepted tasks resolve without walking all older blocks. It may show their acceptance without forced navigation. No queue/steering/account fallback or redispatch for reconciliation.

## 8. Retained catalog and thin-client boundary

Catalog remains ID-keyset/as-of with explicit refresh, not a false globally recent list. Selected session metadata updates live. Global recent-session ordering is deferred.

Retain generic same-origin fetch/media/DTO/UTF8 validation, one SSE framing parser, UI epochs, pending commands, range store and safe DOM. Remove raw run/turn/tool/provider reconstruction, full-prefix fingerprints, finalization heuristics and receipt method proof from JavaScript. No new framework, unsafe HTML, secret persistence or external resources. The SAME server projection and encoder feed live and history. At a fixed committed H, their visible grouping/order/content/recorded state must match.
