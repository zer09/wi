# G1.1 checkpoint disposition and decision closure

Date: September29,2026. Contract g1.1 supersedes g1.0 for resumed implementation on PR #10. This is a design/assignment record, NOT verification. Accepted master remains76bb32f. The preserved unaccepted checkpoint is8f45dda2a2c168931735cf798560b8dfd02a1579.

## 1. Historical records remain intact

Do not rewrite these files as new acceptance:
- VERIFICATION.md (checkpoint g1.0)
- verification.json (checkpoint g1.0)
- DESIGN_REVIEW.md (the September28 open-decision packet)
- handoffs/2026-09-22-161411-g1-browser-client-continuation.md
- handoffs/2026-09-22-161411-g1-browser-client-continuation-prompt.md
- handoffs/2026-09-28-200127-g1-browser-client-pause.md
- V1-B original verification and platform-follow-up records.

Their instruction/status wording describes its date. This g1.1 contract and root AGENTS are the new resume authority. New evidence goes to VERIFICATION_G1_1.md and verification-g1.1.json. Historical accepted=false and failed/blocked observations remain unchanged.

Original planning documents are preserved byte-for-byte in Git at the checkpoint:
https://github.com/zer09/wi/tree/8f45dda2a2c168931735cf798560b8dfd02a1579/docs/slices/g1
Current CONTRACT, CLIENT_PROTOCOL, MATRIX, VALIDATION and IMPLEMENTOR_PROMPT intentionally become g1.1. That is explicit specification replacement, not rewriting the old requirements at their old commit. Links in old evidence remain interpreted at their recorded source revision.

Original Git blob identities:
- CONTRACT.md:5b168b4a0dbcbb3bb5c70cfe28be274db52b27f6
- CLIENT_PROTOCOL.md:e572cce9a8476ed0e3ef71bb592821854f42e628
- MATRIX.md:287862cab0b8b39e29e953d9bcc4ce7b0443d667
- VALIDATION.md:11e803cd8bcf1c1337970ab807a23188f2470e4c
- IMPLEMENTOR_PROMPT.md:e2ffabc0c6b82f98b54e848fe0f7d90b112674a8
- VERIFICATION.md:51b70d39c2dbf1cd0bbbe7cd6446cd2c65be6467
- verification.json:a7fc6f8a0e4f568987f52c8b183a81522841ed01
- DESIGN_REVIEW.md:33d20d117f42a44011e696fd1014950e421dca22

## 2. Decisions resolved

| Question | Fixed g1.1 decision |
|---|---|
| Pagination unit | One accepted human run/interaction, not internal turn or raw event. |
| Initial content | Latest B only, render before asking for A. |
| Empty viewport | Browser requests one older content/segment/block after layout until filled/end. |
| Normal/live/history UI | One chronological chat and the same server display representation. No grouping by database category. |
| Saved representation | Immutable canonical events plus incrementally saved display rows in the same DB. NOT one giant row. |
| Large B | Human anchor + newest contiguous segment + recorded outcome and explicit missing-content indicators. Finish B before A. |
| Huge entry | Generic chunk/field continuation with exact bytes and explicit partial state. |
| Server cost | Indexed display/chunk queries; no warm read-time event reduction. |
| Existing history | Explicit-open one-time schema3 backfill, separately measured; never automatic model/tool work. |
| Concurrent old-page reads | Stable immutable membership; current content at each read head, not cross-page time travel. |
| Live handshake | Matching snapshot H; changed-display SSE after H, separate from backscroll. |
| Reconnect | Explicit fresh-latest rebase; no automatic task retry or old raw-prefix recovery. |
| Authentication | Keep existing small shared bearer check/memory Connect; no new auth system or bypass. Local HTTP requires no HTTPS/proxy. |
| Window B | Superseded as a mandatory browser-internal proof; deterministic application invariant + actual browser rebase acceptance. Not PASS. |
| Sidebar ordering | Existing ID-keyset/as-of catalog and explicit refresh retained; global recent-activity ordering deferred. |
| Frameworks/deps | Existing TypeScript/browser tooling retained; no new Rust or JS dependency. |

The source handoff `G1_Design_Handoff_Human-Message-Anchored_Pagination.md` defined human anchoring, viewport fill and large-block questions. Its read-time projection suggestion is intentionally replaced by the owner's later acceptance of saved display records. Prior chat proposals to start with30entries, require full-prefix recovery, mandate HTTPS for local use or remove auth are not active. Neither snapshot rendering nor DB upgrade restores provider execution.

## 3. Remove/update/add map for local implementation

| Current path or area | Disposition |
|---|---|
| web/src/state.ts createConversation/applyEvent/reduceEvent/activeTurn/requireOutputs/reduceResponse/reduceTool/selectDisplay | Move relevant display interpretation to one server projector; DELETE the browser raw-agent state machine and full event fingerprints/sequence ledger. Replace with a small identity/revision/range display store. Do not port unrelated agent authority into a second server loop. |
| web/src/client.ts selectSession/historyRequest/history.complete gate | REPLACE with latest-block request, immediate rendering, independent SSE, viewport-driven older reads. No sid:0 walk. |
| web/src/client.ts matchPending/taskReceipt/storage-range checks | REPLACE full-history dependency with server-proven receipt/reconcile responses. Preserve immutable command IDs, exact user text, known acceptance and uncertainty. |
| web/src/client.ts observe/reconnect/epoch wrappers | ADAPT to display changes and latest-state rebase; keep ordinary abort/epoch isolation. No browser-internal receipt-window requirements. |
| web/src/sse.ts | KEEP as one small transport parser; adapt accepted event names/payload dispatch only. Keep framing unit tests. No provider semantics. |
| web/src/api.ts | KEEP generic safe decoding/decimal/UUID/error guards. ADD display DTO/cursor/route parsing. Remove browser-only raw schema types once no current client code uses them; raw Rust APIs remain. |
| web/src/view.ts | KEEP safe DOM/accessibility/style components. Consume display rows, not RunState/ResponseState. Add anchor-preserving prepend, partial content controls and latest-rebase status. Normal live and saved layout must agree. |
| web/src/app.ts, embedded assets/build tooling | RETAIN current configuration/build separation. Regenerate committed dist only after source changes; full asset-set verification remains. |
| src/storage/session_v2.sql | PRESERVE historical schema fixture. ADD session_v3.sql and targeted3 support; do not editv2 to masquerade as new schema. |
| src/storage/session_schema.rs, migration.rs, session.rs, run_store.rs, interruption.rs | ADD shared projection updates and reads/migration in existing owned transaction paths. Keep receipts/canonical source semantics, uncertain retirement and all non-display validation. |
| src/storage/catalog_sync.rs/catalog_repair.rs and schema tests | ADAPT actual version/validation consumers to3. Keep genuine1/2/future fixtures and canonical preservation. No catalog schema change or silent damaged-projection rebuild. |
| src/conversation/ (new) | Typed private-safe display interpretation used by incremental writes/migration; no SQL/HTTP/provider-call dependency. |
| src/http_api/router*.rs/dto | ADD display page/content/SSE plus read-only task reconciliation. KEEP existing raw routes, security and mutation contracts. Use existing raw_receipt proof on server. |
| src/http_api/boundary.rs/token.rs/files.rs/config.rs | RETAIN existing access implementation. No new auth framework or credential storage. Update current local-use wording, not provider authentication. |
| src/service/mod.rs/types.rs submit_exclusive checkpoint edits | PRESERVE pending independent whole-diff review; do not undo operation-aware admission because browser changes. New spec does not certify these checkpoint edits by itself. |
| .github/workflows | RETAIN Linux/macOS six gates. ADD required Ubuntu browser job. No Windows job, no skip-ci closure, no silent test filtering. |
| docs/ARCHITECTURE.md, EVENTS.md, README.md, V1-B API/SECURITY | At implementation completion update actual schema/display/local-use behavior and compatibility; preserve earlier evidence. During planning, active G1docs identify proposed changes, not false implementation claims. |

## 4. Test migration, especially Window B

The checkpoint's web/e2e/read-reconnect.spec.mjs and the exclusive web/test-support/read-reconnect*.mjs/json plus their tests embody a blocked CDP experiment. Remove them from the active required suite when replaced; preserve exact historical source at8f45dda. Do not add test.skip/grep-invert and call the new suite complete. Keep reusable framing/epoch/privacy coverage outside the retired prototype.

Inspect references before removing exclusive Rust fixtures: browser/read_reconnect.rs, router/events/test_hooks/fault* and serve_with_event_faults. Remove only Window-B-specific instrumentation and tests made purposeless by canonical rebase. Lower-level framing/partial-write/server shutdown tests still serve valid invariants and can remain. Do not delete all fault hooks by filename. Do not add production globals or monkeypatch Map/Object.freeze/stream readers to observe browser internals.

Fixed-head/raw-prefix browser tests (task-fixed-head, fixed_head helpers) are REPLACED with latest-B/before-A, stable backscroll and snapshot-attach tests. Raw-history API regression tests remain valid. Renderer/command/epoch/XSS/tool fixtures are ADAPTED to display DTOs rather than blanket discarded. Deterministic before-apply/after-apply tests live at a controlled JavaScript function seam; browser tests assert real reconnect convergence, not native network-byte timing.

## 5. Mapping old32 rows to new40

| g1.0 row(s) | g1.1 disposition / required rows |
|---|---|
|00,01|Retain/recheck provenance/platform audit: G11-00,01.|
|02,03,04,05,06|Retain build/assets/security/generic decoding; adapt DTOs:20,25,26,30,37,38.|
|07,08|Retain commands/catalog; replace selection:14,21,22,27,31.|
|09,10,11|Preserve acceptance/error semantics; move proof to server:06,07,21,28.|
|12|REJECTED_PRODUCT_REQUIREMENT, not failed implementation: replace11..18,22..24.|
|13,14,15|Retain framing/identity/epochs, remove raw consecutive-prefix semantics:15,18,25..27.|
|16,17,18|Move interpretation server-side; prove live/history parity:02..07,13,29,34,35.|
|19|Retain explicit cancellation and observer independence:19,28,35.|
|20|SUPERSEDED_BROWSER_PROOF: replace17,18,26,27,35; no Window B completion prerequisite.|
|21|Retain multi-client outcome via new latest model:29,35.|
|22,23,24|Retain joined actual producers, change display path:33,34.|
|25,27|Retain safe DOM/accessibility; add real backscroll:23,24,30.|
|26|Still requires real process/reopen acceptance:35.|
|28|Discard full-prefix speed as acceptance for latest UI; replace12,36.|
|29,30,31|Fresh complete suite/reviews/CI/reports:32,37..39.|

This map preserves useful evidence, not automatic PASS. The original32 IDs remain in the checkpoint report; new40 IDs must have actual evidence. Reviewers inspect BOTH76bb32f->checkpoint and checkpoint->new implementation, including generated/untracked work.

## 6. Documentation consistency findings from this planning pass

The current slice register and docs index still contain 'unimplemented at this planning commit' or paused instructions alongside actual unaccepted checkpoint code. This update routes active work to g1.1 and preserves those claims at their historical revision. Do not erase the fact that203 paths changed in the checkpoint or that no head workflow had run; a documentation-only redesign commit does not accept that implementation.

The original read-time proposal and the earlier g1.1 downloadable design are research inputs, not conflicting active contracts. This document closes their open decisions only to the extent specified by CONTRACT/SCHEMA/CLIENT_PROTOCOL. Any actual source conflict found during implementation receives evidence and a scoped amendment, not silent product policy invention.
