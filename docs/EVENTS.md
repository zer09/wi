# Wi events, history and display representations

Updated September29,2026. Accepted runtime master76bb32f; unaccepted browser checkpoint8f45dda. G1.1 is a replacement specification, not an implemented event change. Earlier detailed event narrative is preserved at the [checkpoint](https://github.com/zer09/wi/blob/8f45dda2a2c168931735cf798560b8dfd02a1579/docs/EVENTS.md). This current overview removes stale unqualified R1 NOT RUN/status claims while retaining their original evidence.

## Implemented layers

| Layer | Version / meaning |
|---|---|
| Provider envelope | schema1; source-native and normalized streaming observations |
| Run envelope | schema2 after C1; run/turn/provider/tool lifecycle and correlation |
| Stored application envelope | schema1; application-session identity and canonical sequence |
| Session database | schema2 at accepted/checkpoint runtime |
| Catalog | schema1; session index/observed summary, not live execution authority |
| HTTP | API1; explicit safe projections, commands, raw history and committed SSE |

Provider-session ID is not application-session ID. Provider/run-local sequence is not stored application sequence. Dispatch is not durable acceptance. Observing stream EOF is not run completion. Tool-start is intent, not proof of effect/result. A finished callback contains no actual output; ToolResultRecorded carries exact output/is_error separately.

Stored types are session.created, session.renamed, run.accepted, runtime.observed, tool.result.recorded, run.result.recorded, run.interrupted, run.history.selected and run.provider.bound. Events and commands are immutable. Related projections, manifest head and receipts update transactionally. Raw runtime/provider payloads retain their source correlations; no UI should infer missing successful execution from an event name.

## Capture and provider replay

B1 commits acceptance before provider work and records actual runtime observations. After validated provider output and full tool preflight, tool intent commits before execution; actual serialized result/cache insertion precedes result recording, finish observation and continuation. Successful error-shaped JSON remains is_error=false. ToolFailed stays gateway_error. Existing output-limit errors and upstream uncertainty remain unchanged.

The returned RunResult is stored separately from RunFinished. Execution outcome, events_complete and sink_error are distinct facts. Completed external work is not rolled back by a later failed write/observer. Cancellation does not guarantee upstream termination. Existing owned-operation/quarantine behavior remains.

B2 adds selected-history and opened-account provenance for a NEW explicit task. A fresh provider connection can receive prior history from the same application session; a new empty application conversation has no prior replay. Incomplete/unbound history can remain readable while unsuitable for provider replay. Reopening or receipt retry never executes old tools/model work automatically.

## Existing raw HTTP history

/history returns canonical committed records in (after,through] pages. /events catches up then streams later committed records. These raw interfaces remain compatible in G1.1. They are not the new chat-pagination unit and are not deleted merely because the browser stops using them to render conversations.

Internal native/binding/prepared configuration objects remain private. Public text/tool strings can themselves contain user-private material and must be rendered as inert text, not executable HTML.

## Planned G1.1 display path

See [schema](slices/g1/SCHEMA.md), [Rust reads](slices/g1/RUST_API.md) and [protocol](slices/g1/CLIENT_PROTOCOL.md). Required, NOT YET VERIFIED:

- Add session schema3 for saved ordered display blocks/entries/fields/chunks. Keep canonical event types/bytes and all envelope versions above.
- New display responses use conversation_version1 alongside existing API1. Distinct /conversation routes return human-anchored pages and self-contained updates.
- Every display update commits with its canonical fact. Same projection/encoder supplies live and saved views.
- Previous-block, within-block and content cursors navigate historical display independently from the changed-display live cursor.
- Live updates can coalesce intermediate revisions; they are current-state synchronization, not a replacement canonical audit log.
- Snapshot H and stream afterH close the attachment race. Browser rebase fetches latest state; no raw prefix from0 or provider/tool reducer in JavaScript.
- Authoritative final output replaces the same assistant entry. Final run result updates status, not another answer. Tool output uses actual bytes/is_error.

The old Window B CDP experiment is superseded as an acceptance requirement, not relabelled PASS or proof of a production defect. New deterministic apply-before-cursor and actual browser rebase tests are in the [matrix](slices/g1/MATRIX.md). All G11 rows start NOT RUN. Local implementation must update current version statements only after source and evidence actually change.

For completed milestone records and historical CI attempts, use the [slice register](slices/README.md) and each frozen verification report. No live/CI result is created by this documentation update.
