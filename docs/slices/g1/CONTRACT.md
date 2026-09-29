# G1.1: human-anchored conversation views

Contract **g1.1**, September 29, 2026 (Asia/Manila). **IMPLEMENTATION HANDOFF, NOT ACCEPTANCE.**
Accepted master: `76bb32fd04fd4737c0efcceaabc7d10387453147`.
Preserved implementation checkpoint: `8f45dda2a2c168931735cf798560b8dfd02a1579` on PR #10.
Read SCHEMA.md, CLIENT_PROTOCOL.md, SECURITY.md, MATRIX.md, DISPOSITION.md and VALIDATION.md together.
Every new **G11-00 through G11-39** row starts NOT RUN. The owner authorized this design update and local implementation, not a merge or live test.

## 1. Result and authority

Wi opens the newest human interaction immediately. It requests older content only to fill unused initial viewport space or in response to subsequent upward navigation. The browser displays a server-produced conversation model; it does not reconstruct the agent from raw events. Live and saved views at the same committed point have identical message grouping, chronological order, content and recorded state. Typing animation and local scroll/focus state need not be replayed.

One accepted human request/run is one interaction block in this slice. Run ID identifies the block; accepted_sequence orders blocks. Internal model turns are not block boundaries. One ordinary page contains ONLY the selected block. The newest block B renders before a request for A. There is no ordinary 30-entry page spanning human interactions.

This replaces g1.0's browser replay from sid:0 and its Window B browser-internals requirement. Preserve the old source, reports and failures using the pinned references in DISPOSITION.md. Do not relabel old PASS_LOCAL_REVIEWED rows as g1.1 acceptance.

The owner's pagination handoff supplies the human-anchor and viewport semantics. Subsequent discussion adopts transactionally maintained display records instead of that handoff's read-time event reduction. Separate physical rows do not imply category-grouped UI. This is an explicit amendment, not a claim the handoff originally specified materialization.

## 2. Architecture

Retain one Rust process, the existing RunHost/B2/controller/registry/provider path, canonical SQLite events and receipts, and the existing TypeScript build/assets. Add a shared Rust conversation projection and storage reads. The same typed projector produces the state used by historical pages and live display updates.

```
canonical write + affected display rows + projection head -> same session transaction
                                       |
                        indexed display page / changed rows
                                       |
                              HTTP and SSE display DTOs
                                       |
                     small browser view store + safe rendering
```

No second agent loop, category-specific browser joins, raw provider reducer in JavaScript, Node server, new database engine, background projection queue, broadcast transcript cache or generic event-sourcing framework.

Add a `conversation` module for typed display values and deterministic interpretation. It may depend on existing provider/run/tool types but not HTTP, CLI, credentials or browser code. Storage owns SQL. HTTP owns decimal-string wire adaptation and request errors. Do not introduce storage -> HTTP module dependencies. Reuse or move existing allowlisted scalar extraction without broad public-API breakage.

## 3. Persisted display representation

Keep immutable `events` and `commands`. Add the derived tables specified in SCHEMA.md in the SAME session database. Store interaction headers, ordered display entries, field metadata and bounded text chunks, not a whole interaction JSON blob.

An entry's immutable position and stable ID determine its location. Its kind determines rendering only. Human text, assistant messages and tools are never regrouped by category. Update the same assistant entry as text grows. Finalization replaces that entry's authoritative contents without adding a second answer. Tool results use the actual output and is_error, not JSON-shape inference. RunResult updates outcome metadata, not assistant content.

Ordinary reads must not reconstruct the selected run or scan its earlier canonical deltas. Ordinary writes update only affected rows and chunks; do not rebuild a whole interaction after each event. Reading/serializing requested rows is allowed. Scanning a bounded page plus indexed lookups is allowed. An oversized message must not require fetching its full text merely to produce a preview.

## 4. Pagination and oversized content

Three different continuations are required: previous interaction, earlier entries within the same interaction, and earlier content within one entry. All are server-produced and session-qualified. They are not the live cursor.

Normal latest response: B's human anchor, B's recorded state, B's complete ordinary activity, and previous-block cursor. Oversized response: same anchor/state plus the newest contiguous activity segment and explicit earlier-in-block/content continuations. Navigation completes earlier content/activity in B before requesting A. The repeated anchor is metadata for the same human entry, never an extra message.

Fixed observation settings, not run limits:
- At most **64 activity entries per block segment**, exclusively within one block.
- At most **512 KiB encoded JSON** per conversation page or live batch.
- At most **32 KiB encoded JSON** per compact entry/anchor fragment, including its metadata/cursors.
- Stored text chunks at most **8 KiB of UTF-8 bytes**, cut on scalar boundaries.
These settings bound one response/read. They never reject, truncate or delete canonical work and never stop a task. Exact serialized overhead counts. SCHEMA/CLIENT_PROTOCOL define mandatory progress for long content and many fields.

Backward membership uses immutable positions. Page contents are current as of each page's own snapshot head, not an indefinitely retained database transaction or invented time-travel snapshot. Newer writes cannot shift older membership. Replacements invalidate only incompatible content cursors. No cursor expiry timer or history retention is added.

## 5. Browser responsibilities

Keep only presentation state: selected session, loaded blocks/entries/text ranges, server revisions/cursors, viewport/focus/draft, and pending command identity. Do not retain a fingerprint ledger of every historical event, infer run state from provider lifecycle, interpret tool success, or calculate B2 receipt ranges.

Initial selection or page refresh:
1. Request latest block and matching snapshot head.
2. Validate and install it; render at latest activity.
3. Attach display SSE after that head, independently of older loading.
4. After layout, if no overflow, request exactly one earlier content/segment/block.
5. Recheck after each render and stop when filled/end reached.
If B fills the viewport, A is never initially requested. Live growth before the next older request cancels that need. An already admitted older read can finish and merge safely; then remeasure. Resize/layout changes after initial fill do not restart automatic backfill. Later requests require upward intent near the top or an accessible Load older control. At most one older read per selection is in flight.

Preserve a stable visible entry/field and pixel offset while prepending. At-bottom readers follow live output; readers above bottom retain position and get a New activity indicator. New block arrival while reading older content cannot force navigation. Session/connection epochs discard stale pages and frames without cancelling execution.

## 6. Live and saved parity

New display SSE uses self-contained entry/header upserts, not raw event replay. It can coalesce intermediate revisions, but preserves current content and terminal facts. The same compact-entry encoder is used by page, content and stream reads. CLIENT_PROTOCOL defines revision, generation and range handling. Stable source correlation stays server-side.

Snapshot and captured canonical head H are read together. Stream starts after H, not after a separately read 'now'. Every newer committed display state remains observable; no browser holds a SQLite transaction. Private-only canonical records advance the watermark without exposing payloads. The stream is a current-state synchronization protocol, not an audit event feed.

On EOF/error, freeze visible state as disconnected. Explicit Reconnect latest discards the old observation epoch, obtains B anew, replaces loaded history only after success, resets backward traversal, then attaches after the new H. Failed rebase retains stale content. Same-page pending commands/receipts survive rebase and are checked through addressed server reconciliation; no task POST is automatic. A newly loaded page has no persisted token or pending command and submits nothing by itself.

## 7. Local access decision

Retain the existing small, centralized Wi owner bearer check and memory-only Connect flow. This resolves the final discussion conservatively: no authentication removal, optional bypass, cookie login, JWT, device registry or new credential mechanism. All APIs including new conversation routes require the same token. Existing fetch/SSE parsing remains a small transport utility; removing domain reduction is the simplification here. Native EventSource cannot silently replace header-authenticated fetch.

Literal-loopback HTTP is a NORMAL local mode, not a requirement to install HTTPS. Provider TLS/OAuth remains unchanged. No local certificate/reverse proxy is needed. Remote access stays outside this slice's acceptance; existing proxy documentation is conditional on choosing remote access. Full page refresh needs Connect again because token storage remains memory-only. Document this tradeoff instead of inventing persistent login. See SECURITY.md.

## 8. Compatibility and migration

Session schema advances to **3** only to add display projections. Catalog1, stored1, runtime2, provider1 and existing HTTP API1 remain. New display protocol is separately `conversation_version:1`. Preserve raw /history and /events for existing callers, and preserve all old mutation routes and result/error semantics.

Existing schema1/2 sessions upgrade once during explicit open under existing ownership. Schema1 first uses the existing 1->2 migration, then 2->3. Initial backfill is the documented exception to no event reduction on reads. The browser shows Preparing conversation during first-open upgrade; measure it separately. After successful upgrade, opening/paging cannot repeatedly backfill. Do not scan/upgrade every session merely to list the catalog. No provider/tool execution, account assignment or old-file overwrite occurs in upgrade. Details and failure rules are in SCHEMA.md.

Add one read-only task reconciliation route using the existing raw_receipt validation. This keeps receipt semantics on the server; it never dispatches work. Original ordinary CLI run remains nonpersistent. No separate migration CLI is required.

## 9. Work phases and exclusions

Phase A: preserve checkpoint; verify source/requirements/platform audit; implement schema/projector/reads and deterministic tests.
Phase B: add display HTTP/SSE and reconciliation with real storage/security tests.
Phase C: replace browser event reconstruction with display rendering and human-anchor navigation.
Phase D: joined browser acceptance, performance evidence, full regression, independent review and documentation.
All phases belong to this one contract; do not claim whole acceptance at a phase boundary.

Only a scoped residual platform defect, projection integration change or contradiction exposed by these requirements may be corrected. No new dependencies or toolchains: retain locked SQLx/Axum, TypeScript5.9.3, Playwright1.58.2 and Node24 tooling. Necessary schema3 additions, shared projection module, new display DTOs/routes and test replacement are explicitly authorized. Internal layout is flexible within these decisions; required semantics are not left to redesign.

No RunLimits, execution quota/deadline, optional budget, lifetime history cap, auto-deletion, model/tool retry, auto-resume, compaction, branching, new provider/tool, shell/editor, skill resources, token provisioning redesign, native Windows restoration, general project-management subsystem or deployment.

Verification is synthetic/offline/loopback only. Ledger remains 31/50 used,19 remaining. No real credentials/private skills/auth commands/provider generations. Existing host inference used to implement is not a Wi live test. Local changes remain uncommitted until owner authorizes commit/push. Merge, release and deployment are not authorized by this handoff.
