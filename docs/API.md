# HTTP API

The Rust adapter is implemented in [`src/http_api/router.rs`](../src/http_api/router.rs). Normal local operation uses loopback HTTP. API version is 1.

## Request boundary

Host/authority and Origin are checked before routing. Every `/v1` operation requires the shared owner bearer header. Credentials are not accepted in URLs. The exact root page and embedded assets are public after the authority/origin checks; there is no arbitrary static-file route.

Use `Authorization: Bearer <owner-token>`. Mutations use JSON. Unknown/repeated query keys, unexpected body fields, unsupported methods, invalid IDs, and invalid content types are rejected. Responses use `Cache-Control: no-store`; browser content is not a cache of provider credentials.

Wi-owned UUIDs use canonical lowercase hyphenated non-nil spelling, without a version-4-only restriction. Sequence values, timestamps, counters, and byte offsets in views are decimal strings. Do not parse them through JavaScript Number.

## Routes

`{sid}`, `{rid}`, and `{oid}` identify an application session, run, and operation. Entry IDs are scoped by run.

| Method and path | Meaning |
|---|---|
| GET `/v1/settings` | Published workspaces and current safe provider/settings summary |
| GET `/v1/sessions?after_id=...&limit=...` | Catalog ID-keyset page, not a global recent-activity sort |
| POST `/v1/sessions` | Create a persistent session |
| GET `/v1/sessions/{sid}` | Canonical session metadata |
| POST `/v1/sessions/{sid}/rename` | Rename with durable operation identity |
| POST `/v1/sessions/{sid}/refresh` | Explicit independent catalog refresh |
| POST `/v1/sessions/{sid}/runs` | Submit an explicit task |
| POST `/v1/sessions/{sid}/runs/reconcile` | Read-only proof of the original task's acceptance |
| GET `/v1/sessions/{sid}/runs/{rid}` | Safe recorded run state |
| POST `/v1/sessions/{sid}/runs/{rid}/cancel` | Request local cancellation |
| GET `/v1/sessions/{sid}/operations/{oid}` | Addressed durable operation receipt |
| GET `/v1/sessions/{sid}/conversation` | Newest human-message block |
| GET `/v1/sessions/{sid}/conversation?before=...` | Immediately older block |
| GET `/v1/sessions/{sid}/conversation?within=...` | Earlier activity in the same block |
| GET `/v1/sessions/{sid}/conversation/entries/{rid}/{entry_id}` | Current compact entry for addressed refresh |
| GET `/v1/sessions/{sid}/conversation/content?cursor=...` | Earlier content/fields of an entry |
| GET `/v1/sessions/{sid}/conversation/events?after=...` | Committed display-state SSE |
| GET `/v1/sessions/{sid}/history?after=...&through=...&limit=...` | Retained raw-event-facing projected history API |
| GET `/v1/sessions/{sid}/events?after=...` | Retained raw-event-facing SSE API |

The conversation routes have no client `limit` or `through` parameter. `before` and `within` are mutually exclusive. Catalog/raw history default to 32 records. Their raw cursors are not conversation cursors. Supported OPTIONS requests perform narrow preflight validation.

## Commands and receipts

Create body: `{operation_id,title,workspace}`. A new session returns 201; a matching creation retry returns 200. Select the exact canonical workspace value returned in settings.

Rename body: `{operation_id,title}`. Refresh and Cancel accept an empty JSON object.

Task and task-reconciliation body:

```json
{
  "operation_id": "11111111-1111-4111-8111-111111111111",
  "run_id": "22222222-2222-4222-8222-222222222222",
  "text": "The exact task"
}
```

A task's 202 response requires its actual durable receipt. It is not successful execution. Preserve the original operation ID, run ID, and exact text when explicitly retrying an ambiguous response. The server validates an existing raw receipt before preparing current context. Reusing an ID for changed content conflicts.

Reconcile returns either `{api_version:1,state:"accepted",acceptance:<receipt>,run:<run view>}` or `{api_version:1,state:"not_found",acceptance:null,run:null}`. It performs no dispatch, context preparation, or provider/tool work. Explicit session opening can still perform storage migration/restart interruption. Point-in-time absence is not proof that an earlier uncertain operation rolled back.

Cancel returns 202 for `requested` and 200 for `not_tracked`. These are signal/tracking dispositions, not terminal-state or rollback proof. A closed host reports an error.

## Errors and private data

Errors use the existing flat `ErrorView`, not an invented nested provider error. Preserve its stage, certainty, and receipt fields when supplied. Source definitions and mappings are in [`src/http_api/dto`](../src/http_api/dto) and [`src/http_api/router/runs.rs`](../src/http_api/router/runs.rs).

Conversation-specific codes are `api.conversation_cursor_invalid` (400), `api.conversation_cursor_stale` (409), and `api.conversation_display_unavailable` (422). Missing resources are 404; corrupt or unsupported storage reports its actual storage error. A legacy mandatory header that cannot fit the display response is not silently truncated, skipped, or treated as an empty session.

Browser views exclude prepared instructions, native provider payloads, account-binding markers, and credential/config objects. Raw-event-facing HTTP views are also explicit projections, not arbitrary SQL or raw database dumps.

See [conversation protocol](CONVERSATION.md) for display DTOs, attachment, coalescing, and pagination. See [authentication](AUTHENTICATION.md) for access assumptions.
