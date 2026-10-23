# Conversation display protocol

The server maintains saved display records beside canonical events. The browser renders those records and applies generic identity/revision/range updates. It does not reconstruct the agent state machine.

Sources: [`src/conversation`](../src/conversation), [`storage reads`](../src/storage/conversation/reads.rs), [`HTTP adapter`](../src/http_api/router/conversation.rs), and [`web/src`](../web/src).

## Blocks and ordering

One accepted human task is one interaction block. The human anchor comes from `run.accepted`. Assistant responses, tools, reuse references, and outcome state retain their recorded chronological positions. Database categories do not regroup the chat.

The initial request returns only newest block B, with its human anchor, latest activity, and current status. It does not collect A to reach an entry-count target. Within a block, selected entries are returned in forward display order.

The browser renders B, starts live observation, and then measures the viewport. If unused space remains it fetches one older unit, renders it, and measures again. Automatic filling stops at overflow, end, or a read error. Afterward, upward user intent near the top or Load older admits one read. Resize/prepend callbacks alone cannot restart continuous backfill.

For an oversized B, load missing entry content first, then earlier B activity, then preceding block A. A repeated human anchor is the same entry, never a second message. A failed older read does not stop an otherwise healthy stream.

## Display values

All responses have `api_version:1` and `conversation_version:1`. Sequences, counters, timestamps, slots, generations, and byte offsets are canonical decimal strings. Versions and booleans retain their respective numeric/boolean types.

| Value | Fields |
|---|---|
| `ConversationPage` | `session_id`, `snapshot_head`, `session`, `block`, `entries`, `earlier_activity`, `previous_block`, `live_after`, version fields |
| `BlockView` | `run_id`, `accepted_sequence`, `revision`, `state`, `result_recorded`, `outcome`, `summary`, `events_complete`, `sink_error`, `human` |
| `EntryView` | `run_id`, `entry_id`, `position:{sequence,slot}`, `revision`, `content_epoch`, `kind`, `recorded_state`, `provisional`, `reference`, `fields`, `earlier_content`, `content_complete`, `result_recorded`, `finish_recorded`, `is_error` |
| `FieldFragment` | `field_id`, `order_key`, `kind`, `generation`, `total_bytes`, `from_byte`, `to_byte`, `text`, `has_earlier`, `has_later` |
| `EntryPage` | `session_id`, `snapshot_head`, `block`, `entry`, version fields |

`session` is the canonical SessionView with `api_version:1`, `view:"canonical"`, session ID, title, workspace, timestamps, and head. Receipt objects do not acquire a nested version field merely for uniformity.

Entry kinds are `human`, `assistant`, `tool`, `reuse`, and `notice`. Block states use the stored accepted/running/terminal states. The server supplies tool result/finish/error flags; the browser does not infer them from an error-shaped JSON string.

Entry fields represent text, refusal, reasoning summary/text, function name/arguments, tool name/result, authoritative fallback text, unsupported content, or notice. Private native payloads are not included. Unsupported content is labelled rather than invented.

The page's `entries` excludes the anchor already supplied in `block.human`. Empty sessions have `block:null` and no phantom messages. `live_after` is non-null only for Latest. Backward/content reads cannot reset live observation.

## Transfer bounds and content

| Boundary | Value |
|---|---:|
| Encoded conversation page/live batch | 512 KiB |
| Compact entry or anchor | 32 KiB |
| Activity entries per segment | 64 |
| Field descriptors per compact fragment | 64 |
| Stored UTF-8 text chunk | Up to 8 KiB |
| Encoded cursor | Up to 4096 bytes |

These are observation/representation bounds, not execution quotas or history deletion. Compact entries may contain a newest suffix. Explicit missing-content markers and continuations preserve access to original bytes.

Offsets are UTF-8 byte offsets at scalar boundaries. Compatible overlapping ranges must agree. Append growth preserves an issued upper boundary within the same field generation. Authoritative replacement changes generation/epoch and makes old content cursors stale (409). Refresh replaces only the affected entry/ranges. An older response cannot overwrite newer revision state.

A response's final snapshot replaces the same provisional entry in place. A final run result changes outcome information; it does not append the answer again. Live and saved state at the same committed head use identical identities, chronology, content, grouping, and recorded status.

## Cursor encoding

Cursors are typed opaque navigation tokens, not authentication. Each prefix is followed by URL-safe base64 without padding of a minified UTF-8 JSON array. The first field is numeric version 1; numeric positions/ranks below are decimal strings.

| Prefix | Decoded array |
|---|---|
| `g11b.` | `[1,sid,before_accepted_sequence]` |
| `g11s.` | `[1,sid,run_id,before_entry_sequence,before_slot]` |
| `g11c.` | `[1,sid,run_id,entry_id,content_epoch,upper_field_id,upper_generation,exclusive_upper_byte]` |
| `g11l.` | `[1,sid,sequence,rank,run_id_or_empty,entry_id_or_empty]` |

Live ranks are 0 metadata, 1 block, 2 entry, and 3 watermark. Ordering is numeric sequence/rank, then canonical identity order. Several entities can share one sequence; advancing past an unreturned entity is forbidden.

Backward membership uses immutable entry/run positions. Each response reads current revisions at its own short snapshot, not a frozen time-travel view of the original page head. The server validates resource/session/boundary/generation relationships. Clients must not derive SQL or paths from cursor contents.

## Snapshot and stream

Latest captures display state and canonical head H together. Attach the stream using that response's `live_after`, not a separately queried current head.

```text
Latest snapshot at H
    -> install B
    -> GET conversation/events?after=<H cursor>
    -> apply committed updates
```

A supplied Last-Event-ID must exactly match `after`. A frame uses:

```text
event: wi.conversation
id: <next cursor>
data: {"api_version":1,"conversation_version":1,"session_id":"...","observed_head":"...","changes":[...],"next_after":"..."}
```

The change union is `session.upsert`, `block.upsert`, or `entry.upsert`. Entry updates carry their block header/anchor. The stream synchronizes current projected state and may coalesce intermediate revisions; it does not promise every original raw delta.

Indexed changed-entity reads use sequence/rank/key ties and bounded lookahead. If more candidates remain, the cursor identifies the last returned entity. Otherwise it advances to the observed head watermark, including private-only changes. Connections/transactions retire before network yield. Caught-up polling waits 250 ms; idle keep-alive is 15 seconds.

A whole frame validates and applies before the browser advances its cursor. Older revisions do not overwrite newer state; conflicting equal revisions/ranges reject. Updates to unloaded old entries do not trigger backscroll or place out-of-context content at the bottom. EOF, `wi.closed`, and observation errors are not task completion.

## Reconnect and presentation

Reconnect latest is explicit. A successful fresh snapshot replaces the loaded window and older cursors, then attaches after the new head. A failed refresh retains stale content. Same-page rebase preserves the draft and pending command identities. A full page reload loses page memory and requires Connect; it never automatically resubmits tasks.

Session/connection epochs reject stale completions. Near-top upward intent uses a 96 CSS-pixel boundary; bottom following applies when previously within 24 pixels. Prepending preserves an entry/field visual anchor. New activity does not force a reader away from older content.

Rendering uses inert text, not model-supplied HTML. The interface is text-first; Markdown rendering, an editor, and a terminal are not implemented.
