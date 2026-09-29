# G1.1 Rust read surface

Contract **g1.1**. These are explicitly authorized NEW library operations. Existing SessionHandle methods, RunHost, execution, Tool and Provider APIs remain. Types below have private fields with public read-only getters; HTTP formatting is an adapter, not the only way to access conversation state.

## Types

In `wi::conversation`, define typed values corresponding to CLIENT_PROTOCOL.md: ConversationPage, BlockView, EntryView, FieldFragment, EntryPage, ConversationChanges and DisplayChange. Rust uses checked numeric types internally; the HTTP adapter renders decimal strings. DisplayChange is the closed session/block/entry upsert union. Do not derive a generic conversion from arbitrary native JSON.

Define distinct BlockCursor, ActivityCursor, ContentCursor and LiveCursor types, with FromStr/Display for their versioned encodings. They are not interchangeable. Parse syntax without I/O; validate referenced session/resource/boundary inside the actual read. Bounds and encoding are fixed in CLIENT_PROTOCOL.md.

```rust
pub enum ConversationQuery {
    Latest,
    Before(BlockCursor),
    Within(ActivityCursor),
}
```

Use private fields/getters for EntryId and cursor internals. EntryId is scoped by run_id; it is not a file path. Internal projector mutation types are crate-private, not a plugin/middleware API.

In `wi::storage`, add:

```rust
pub enum ConversationError {
    Storage(StorageError),
    CursorInvalid,
    CursorStale,
}

impl SessionHandle {
    pub async fn conversation_page(
        &self,
        query: ConversationQuery,
    ) -> Result<ConversationPage, ConversationError>;

    pub async fn conversation_entry(
        &self,
        run_id: RunId,
        entry_id: EntryId,
    ) -> Result<EntryPage, ConversationError>;

    pub async fn conversation_content(
        &self,
        cursor: ContentCursor,
    ) -> Result<EntryPage, ConversationError>;

    pub async fn conversation_changes(
        &self,
        after: LiveCursor,
    ) -> Result<ConversationChanges, ConversationError>;
}
```

Signatures are requirements, not runnable Rust source. Constructors needed for HTTP parsing may be added without exposing arbitrary SQL, arbitrary paths, projection writes or raw prepared/provider objects. SessionHandle supplies session authority; a cursor cannot redirect the query to a different database.

ConversationPage has the page fields from CLIENT_PROTOCOL; live_after is present only for Latest. EntryPage is current entry/header state at its own read head. ConversationChanges contains observed_head, changed entities, next_after and a has_more observation for the server. API consumers do not own a DB transaction or connection through the returned values.

## Implementation boundaries

Each method uses StoreInner::operation(false,...) and existing session connection/retirement ownership. Short explicit read transactions capture head and projection together. Reject new operations after storage close with existing StorageError; a dropped waiter does not cancel owned SQL. No connection/session mutex survives return or a network yield. These additions do not expand RunHost shutdown into a second task manager.

The canonical projector is crate-private. Implement it as typed transforms plus affected-row reads/writes inside existing transactions. Methods above cannot mutate an already-ready projection. Explicit session open performs the one-time schema migration; normal reads never repair or backfill a declared3 store.

For HTTP, map ConversationError::Storage through existing ErrorView::storage; CursorInvalid and CursorStale use the two API codes in CLIENT_PROTOCOL. Preserve source stage/commit certainty rather than report generic success/empty history. Debug/Display of new errors and cursor types must not reveal secret paths or content.

## Explicit source-level adaptations

The existing session_schema::validate path selects payload_json from the last event even when only event metadata is checked. Do not defeat bounded display reads by loading a huge canonical response payload through this shared prerequisite. A narrow query split is authorized: read last-event type/version/time first, and fetch the payload only for the existing session.renamed title check. Preserve every validation assertion and its error classification. Creation identity validation remains; it must not become a full accepted-prompt/run scan. Add regressions showing the metadata-only path avoids unrelated large payloads without bypassing identity/head validation.

Likewise, public run_record returns RecordedRunInput and may include a full final result. New display reads must use the saved compact block/header projection instead of reading full run input/result to build a title/status. Receipt reconciliation intentionally retains the existing raw_receipt proof and can read the addressed acceptance; it is not a warm history-page implementation.

Encoded HTTP byte bounds and generic Rust views must use the same field-size calculation/encoder contract. Do not create storage -> http_api dependencies: keep the bounded display-wire encoding helper in the shared conversation module, or have HTTP budget construction call the same bounded fragment builder without refetching whole content. The nested SessionView retains api_version1/view canonical as explicitly shown in CLIENT_PROTOCOL. This check caught a draft omission before publication; no new public shape is inferred from it.

## Deliberately unchanged surfaces

Do not change raw SessionHandle::history_page, provider-native replay, RunRequest, accepted receipt shapes, RunEventEnvelope, ProviderEventEnvelope, ToolRegistry execution, provider account identity, or context preparation to accommodate display. Existing public HTTP raw routes keep their meaning. No new session store engine, write queue, pool, repair API, generic background projector or callback into JavaScript is introduced.
