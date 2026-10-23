# Wi events, history and display representations

Accepted master76bb32f and historical unaccepted checkpoint8f45dda remain distinct from the later committed but unaccepted G1.1 runtime. Schema3 projection, typed entry/content/page/change reads, display HTTP/SSE, server reconciliation and browser replacement are implemented. Current row outcomes are in the [merge assessment](slices/g1/VERIFICATION_G1_1.md#current-merge-readiness) and [machine matrix](slices/g1/verification-g1.1.json). G1.1 remains accepted=false; owner acceptance is separate from row outcomes. Source completion alone proves neither CI nor acceptance. Earlier detailed event narrative is preserved at the [checkpoint](https://github.com/zer09/wi/blob/8f45dda2a2c168931735cf798560b8dfd02a1579/docs/EVENTS.md). This current overview removes stale unqualified R1 NOT RUN/status claims while retaining their original evidence.

## Implemented layers

| Layer | Version / meaning |
|---|---|
| Provider envelope | schema1; source-native and normalized streaming observations |
| Run envelope | schema2 after C1; run/turn/provider/tool lifecycle and correlation |
| Stored application envelope | schema1; application-session identity and canonical sequence |
| Session database | schema3 in local G1.1 work; schema2 at accepted/checkpoint runtime |
| Catalog | schema1; session index/observed summary, not live execution authority |
| HTTP | API1; explicit safe projections, commands, raw history and committed SSE |
| Conversation display | conversation_version:1; materialized human blocks, ordered entries, bounded fields/content and changed-state SSE |

Provider-session ID is not application-session ID. Provider/run-local sequence is not stored application sequence. Dispatch is not durable acceptance. Observing stream EOF is not run completion. Tool-start is intent, not proof of effect/result. A finished callback contains no actual output; ToolResultRecorded carries exact output/is_error separately.

Stored types are session.created, session.renamed, run.accepted, runtime.observed, tool.result.recorded, run.result.recorded, run.interrupted, run.history.selected and run.provider.bound. Events and commands are immutable. Related projections, manifest head and receipts update transactionally. Raw runtime/provider payloads retain their source correlations; no UI should infer missing successful execution from an event name.

## Capture and provider replay

B1 commits acceptance before provider work and records actual runtime observations. After validated provider output and full tool preflight, tool intent commits before execution; actual serialized result/cache insertion precedes result recording, finish observation and continuation. Successful error-shaped JSON remains is_error=false. ToolFailed stays gateway_error. Existing output-limit errors and upstream uncertainty remain unchanged.

The returned RunResult is stored separately from RunFinished. Execution outcome, events_complete and sink_error are distinct facts. Completed external work is not rolled back by a later failed write/observer. Cancellation does not guarantee upstream termination. Existing owned-operation/quarantine behavior remains.

B2 adds selected-history and opened-account provenance for a NEW explicit task. A fresh provider connection can receive prior history from the same application session; a new empty application conversation has no prior replay. Incomplete/unbound history can remain readable while unsuitable for provider replay. Reopening or receipt retry never executes old tools/model work automatically.

## Existing raw HTTP history

/history returns canonical committed records in (after,through] pages. /events catches up then streams later committed records. These raw interfaces remain compatible in G1.1. They are not the new chat-pagination unit and are not deleted merely because the browser stops using them to render conversations.

Internal native/binding/prepared configuration objects remain private. Public text/tool strings can themselves contain user-private material and must be rendered as inert text, not executable HTML.

<a id="native-mapping"></a>

## Native mapping and local identifier admission

Public display extraction copies only allowlisted text/refusal/reasoning strings and typed function data, not arbitrary native objects. Unknown structures get an unsupported marker. Authoritative effective output, including provider-recovered output, replaces provisional fields in the same assistant entry; normalized-text fallback is a server rule. Native terminal bytes and output provenance remain separate. Upstream response/item IDs retain their existing opaque rules; the request-ID amendment is not a universal native-ID format or a new trimming rule. See `src/conversation/projection.rs:52-214`.

The owner's October1 amendment requires canonical 36-character non-nil lowercase hyphenated UUID request IDs for new producer and storage input, not length-only validation or v4-only parsing. Runtime event/turn/run IDs and both RunFinished/RunResult summary paths are checked. Actual tool-execution/result call IDs retain the existing nonempty/512-byte rule; untrusted observed calls retain their separate preflight behavior.

For the supported OpenAI adapter, the locally generated provider-session ID is a UUID and its envelope event ID is exactly that UUID plus a colon and positive decimal local envelope.sequence. This is not the upstream provider_sequence. Checks use the actual selected/accepted provider, not an untrusted label. Generic and upstream identifiers are not UUID-converted.

Strict new admission follows exact historical receipt/conflict resolution. Old raw/B2/migration/binding reads and canonical bytes remain unchanged. No partial-summary marker or paged identifier was added. General external-ID formats remain undefined beyond existing boundary-specific rules. Oversized historical mandatory headers have the approved display-read disposition below. See [identifier audit](slices/g1/IDENTIFIERS.md) and [local evidence](slices/g1/IDENTIFIER_ID2B.md).

## Current local G1.1 display path

See [schema](slices/g1/SCHEMA.md), [Rust reads](slices/g1/RUST_API.md) and [protocol](slices/g1/CLIENT_PROTOCOL.md) for the fixed contract. Current ownership is `src/conversation` for typed interpretation/encoding, `src/storage/conversation` for SQL/projector/reads, `src/http_api` for transport and `web/src/display-store.ts` for display-buffer merging.

- Schema3 saves ordered blocks/entries/fields and scalar-aligned UTF-8 chunks beside immutable canonical events/receipts, in the same transaction. Explicit old-session open retains 1->2 then additive 2->3/backfill; warm indexed reads do not replay raw history.
- Latest returns newest human block B before older A, not an unbounded whole interaction. Pages/live batches fit 512 KiB encoded JSON, compact entries/anchors 32 KiB, activity segments 64 entries and stored chunks 8 KiB. Separate continuations cover earlier fields/content and earlier activity before the previous block. These read bounds never truncate canonical work or impose task budgets.
- Previous-block, within-block, content and live cursors are distinct session-qualified opaque tokens. Older membership is stable under newer writes; each page has current values at its own snapshot head, not time travel at the initial H. Append-compatible content boundaries remain stable; replacement can return api.conversation_cursor_stale/409 for the affected entry.
- Matching snapshot H installs before changed-display SSE after H. Self-contained session/block/entry upserts can coalesce intermediate revisions; private-only canonical writes advance the watermark without exposing payloads. The sequence/rank/identity tie-break prevents advancing past unsent current rows. This is current-state synchronization, not an audit feed of every delta.
- The browser merges identities/revisions/generations/ranges in chronological order. Final output replaces the same assistant entry; RunResult updates outcome metadata, not another answer. Tool result bytes/is_error, result existence, finish existence and reuse references remain distinct recorded facts.
- Initial viewport filling requests one earlier content/segment/block at a time until filled/end. Later reads require upward intent or Load older. Live observation does not wait for older loading. Reconnect latest explicitly obtains fresh canonical state before a new stream; failed rebase keeps stale content. EOF/error is not execution completion or permission to retry/cancel work.
- Read-only POST /v1/sessions/{sid}/runs/reconcile checks captured original operation/run/text with server raw_receipt proof. It returns addressed acceptance/run state or point-in-time not_found, not proof of rollback. It never prepares context or submits work; explicit-open migration/interruption remains possible. Read run-status uses its separate GET route.

Typed read retirement and snapshot capture are in `src/storage/session.rs:94-183` and `src/storage/conversation/reads/pages.rs:21-39`. Display routes are in `src/http_api/router.rs:136-203`; SSE retains bounded frames and retires SQL before delivery (`src/http_api/router/conversation/events.rs:18-139`). Reconciliation uses `src/http_api/router/runs.rs:29-128`. Public static assets require Host/Origin checks; APIs still require the existing bearer and memory-only Connect. Normal literal-loopback HTTP requires no HTTPS/proxy. Provider auth and the remote access boundary are unchanged. All display strings render as inert text; private native/config/credential objects remain excluded.

An otherwise readable legacy mandatory header that cannot fit after progress-preserving fragment reduction returns api.conversation_display_unavailable/422 (ConversationError::DisplayUnavailable). This is a display-read error, not corruption, quota or task rejection. It does not rewrite canonical bytes, skip the block or change raw history/execution state. Other representable blocks remain readable. Mapping: `src/http_api/dto/errors.rs:146-155`.

The old Window B CDP experiment and exclusive raw browser runtime/tests are retired with explicit dispositions, not relabelled PASS or proof of a production defect. The [human report](slices/g1/VERIFICATION_G1_1.md), [JSON](slices/g1/verification-g1.1.json) and [runtime retirement](slices/g1/C3B_RAW_RUNTIME_RETIREMENT.md) preserve old failures and failed roles. Historical [C48 typed S2 display](slices/g1/C3B_S2_SKILL_DISPLAY.md) and [C49 saved-skill browser evidence](slices/g1/C3B_SKILL_SOURCE_FIDELITY.md) retain their scoped proofs of recorded skill/tool values despite changed or deleted source. They do not instruct display reads to reread skills. The October13 [handoff](../handoffs/2026-10-13-032423-g1-1-c49-reviewed-resume.md) is historical context, not current next-task authority.

[Historical C93 verification](slices/g1/VERIFICATION_G1_1.md#c93-fixed-browser-and-current-head-verification) records local and successful hosted verification scoped to source `1b8b50c7abd8ebdac95d8964a4788bf257ce3547`. Later documentation-only commits retain a separate cutoff and do not inherit exact-head CI results. See the [current merge assessment and C15/active1 dispositions](slices/g1/VERIFICATION_G1_1.md#current-merge-readiness) and [machine matrix](slices/g1/verification-g1.1.json) for row outcomes and revision-scoped checks, and the [requirements matrix](slices/g1/MATRIX.md) for obligations. The application reader/SSE/no-store policy is unchanged; exact release-to-DOM remains WAIVED_BY_OWNER, not measured. Both workflows pass for submitted implementation e61c881; each later pushed head needs its own CI. Owner merge approval is separate from row outcomes.

For completed milestone records and historical CI attempts, use the [slice register](slices/README.md) and each frozen verification report. No live/CI result is created by this documentation update.
