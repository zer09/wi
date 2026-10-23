# Wi architecture and ownership

Accepted master remains **76bb32f**, with V1-B and platform withdrawal merged. Historical unaccepted checkpoint8f45dda and the later committed but unaccepted G1.1 runtime on PR #10 are separate source states. Local schema3, typed display reads, HTTP/SSE, reconciliation and browser replacement are implemented under [G1.1](slices/g1/CONTRACT.md); current row outcomes are in the [merge assessment](slices/g1/VERIFICATION_G1_1.md#current-merge-readiness) and [machine matrix](slices/g1/verification-g1.1.json). G1.1 remains accepted=false with inventory OPEN. This overview replaces stale status claims that V1-B is unimplemented or R1 CI has never run. Earlier detailed narrative remains at the [checkpoint](https://github.com/zer09/wi/blob/8f45dda2a2c168931735cf798560b8dfd02a1579/docs/ARCHITECTURE.md).

## Implemented boundaries

```
HTTP / library / diagnostic CLI adapters
                   |
          workspace/context preparation
                   |
        RunHost (service-owned execution)
                   |
    execution::run_in_session / run_persisted
                   |
         one shared controller + ToolRegistry
               /                    \
     provider gateway            owned SQLite recording
```

The gateway is a component, not the entire harness. HTTP calls the shared Rust library rather than launching Wi, Pi or Codex subprocesses. RunHost owns execution; client/ticket/stream lifetime is not execution lifetime. Cancellation is explicit. Shutdown drains runs while storage is writable, then closes storage. Restart preserves history and interrupts old unfinished work without automatic model/tool activity.

Provider traits and OpenAI-Codex adapters preserve normalized and native output, account identity, WebSocket/SSE continuation and uncertainty. Current tools/context include AddNumbers, global/project catalog and main-SKILL.md loading; no generic shell/edit executor or hosted skills/billing is implied. C1 deleted run-wide quotas/deadlines completely.

P1-A provides per-session canonical SQLite and a catalog. P1-B1 captures actual accepted input, runtime records and exact serialized tool results. B2 reconstructs compatible closed provider exchanges for a NEW explicit task; display history is not provider context. Application session IDs, run IDs and provider-session IDs have different scopes. Tool result caches/identities are run-scoped.

V1-B provides actual authenticated HTTP commands and raw committed-history SSE over the host/storage path. It returns commit-backed acceptance and separate execution outcomes, retains receipt-first raw-command proof and safe browser DTOs, and isolates slow/disconnected observers. The listener is loopback. Normal local HTTP needs no certificate/proxy; separately selected remote access has its own HTTPS boundary. Shared owner access is separate from provider OAuth.

## Current local conversation display

The historical g1.0 checkpoint used rejected whole-prefix loading. The current app uses the display controller/store/renderer; raw state/view modules and their served asset routes are retired. The empty compiler client.js type artifact is neither active runtime nor served. The old report and failed Window B experiment remain historical, not PASS; see [disposition](slices/g1/DISPOSITION.md) and [runtime retirement](slices/g1/C3B_RAW_RUNTIME_RETIREMENT.md).

The implemented local display path is:

```
canonical transaction -> affected saved display rows in same DB
                                      |
                     indexed latest human block / older segments
                                      |
                      display HTTP / self-contained SSE updates
                                      |
                     browser rendering, input and viewport only
```

Session schema3 adds ordered blocks/entries/fields and UTF-8 chunks in the same SQLite database. Canonical writes, affected display rows, receipts and projection head commit in the same transaction. Events/receipts remain immutable; warm reads use indexed display rows, not raw-history replay. Catalog1/stored1/runtime2/provider1/API1 remain unchanged; display uses conversation_version:1. Explicit old-session open retains 1->2 migration, then additive 2->3 backfill in 256-record batches. Warm schema3 open does not backfill again. Catalog listing does not upgrade every session. See `src/storage/session_schema.rs:43-77`, `src/storage/session.rs:526-557` and `src/storage/migration.rs:59-154`.

`SessionHandle` exposes page Latest/Before/Within, changed-state, addressed-entry and content reads (`src/storage/session.rs:94-183`). Latest returns only the newest human block, with bounded activity/content rather than a giant interaction row. Page/live JSON is bounded to 512 KiB, compact entries to 32 KiB and activity segments to 64 entries. These are read bounds, not execution quotas. Previous-block, within-block and content positions are separate from live state. Each read captures its own snapshot; stable older membership does not promise cross-page time travel. Loaded browser ranges and stored history can grow; response bounds are not lifetime caps or constant-RSS guarantees.

The browser installs matching snapshot H before live observation. Initial viewport fill admits one older content/segment/block at a time until filled/end; subsequent reads require upward intent or Load older. Reconnect latest obtains a fresh snapshot and attaches after its new H; failure retains stale content without resubmitting work. The display store merges server IDs/revisions/generations/ranges, not provider events. Final output replaces the same assistant entry; tool output/is_error, result existence and finish existence remain separate recorded facts. Source: `web/src/display-client.ts:112-123,255-335`, `web/src/display-view.ts:300-438`.

Display SSE publishes self-contained current-state upserts and can coalesce intermediate revisions. SQL/locks retire before network delivery. Slow observers retain bounded frames, not an unbounded producer queue. Read-only task reconciliation reuses the original operation/run/text proof; it does not submit another task. Explicit-open migration/interruption is its storage-maintenance qualification. A legacy mandatory header that cannot fit returns DisplayUnavailable/HTTP 422, not corruption, quota or task rejection; raw history remains readable. See [protocol](slices/g1/CLIENT_PROTOCOL.md) and [identifier amendment](slices/g1/IDENTIFIERS.md).

The root page and exact static assets are public after Host/Origin checks; APIs retain the existing bearer check and memory-only Connect. Normal literal-loopback HTTP needs no HTTPS/proxy. Remote access and provider auth keep their existing boundaries. User/model/tool strings render as inert text; native/config/credential objects are not public DTOs. No second agent loop, separate database, background projector, automatic resume/retry or new auth mode is added.

## Source ownership

| Area | Responsibility |
|---|---|
| src/provider.rs, gateway.rs, providers/openai_codex | Provider contracts, credentials, protocol and transport |
| src/context*, tools.rs | Context/skill validation and actual local tool execution |
| src/run*, execution* | Shared orchestration and awaited canonical recording/replay |
| src/storage* | Canonical events/receipts/projections, transactions, identities and ownership |
| src/service* | Host-owned jobs, passive clients/tickets, explicit cancellation/drain |
| src/http_api* | Request security, config, commands, DTOs and streaming |
| src/conversation | Typed display values, shared interpretation and bounded wire encoder; no SQL/HTTP/provider calls |
| src/storage/conversation | Transactional projector, chunk storage and indexed display reads |
| web/src/display-store.ts | Server identity/revision/range display buffer; no raw-agent reducer |
| web/src/display-client.ts, display-view.ts, app.ts | Authenticated transport, pending commands, epochs, safe rendering and viewport navigation |

[Historical C93 verification](slices/g1/VERIFICATION_G1_1.md#c93-fixed-browser-and-current-head-verification) records local and successful hosted verification scoped to source `1b8b50c7abd8ebdac95d8964a4788bf257ce3547`. Later documentation-only commits retain a separate cutoff and do not inherit exact-head CI results. The [current merge assessment and C15/active1 dispositions](slices/g1/VERIFICATION_G1_1.md#current-merge-readiness) and [machine matrix](slices/g1/verification-g1.1.json) record row outcomes and remaining reviews, distinguishing source review, local execution and hosted evidence. Historical C44-C48 and [C49 saved-skill fidelity](slices/g1/C3B_SKILL_SOURCE_FIDELITY.md) retain their scoped cutoffs; C49's Task B polling correction is test-fixture-only. The application reader/SSE/no-store policy is unchanged; exact release-to-DOM remains WAIVED_BY_OWNER, not measured. Exact new-head CI remains pending after separately authorized commit/push; owner merge approval is separate from row outcomes. Source completion alone proves neither CI nor acceptance.

Native support is Linux/macOS; see [platform authority](PLATFORM_SUPPORT.md). Existing managed-auth/live evidence remains Linux-specific. No new platform, whole-repository security, physical power-loss or live-provider certification follows from CI. Current completion/evidence is in the [slice register](slices/README.md), not outdated source-era introduction text.
