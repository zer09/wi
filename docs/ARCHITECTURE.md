# Wi architecture and ownership

Current accepted runtime baseline: **76bb32f**, V1-B and platform withdrawal merged. PR #10 additionally contains unaccepted browser checkpoint8f45dda. The active replacement design is [G1.1](slices/g1/CONTRACT.md), not yet implemented or verified by the planner's documentation commit. This overview replaces stale status claims that V1-B is unimplemented or R1 CI has never run. Earlier detailed narrative remains at the [checkpoint](https://github.com/zer09/wi/blob/8f45dda2a2c168931735cf798560b8dfd02a1579/docs/ARCHITECTURE.md).

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

## Checkpoint browser versus replacement

The partial g1.0 browser follows the rejected whole-prefix loading model. It is useful unaccepted code, not the accepted product. Its report and failed Window B experiment remain historical; see [disposition](slices/g1/DISPOSITION.md).

G1.1 changes the display path:

```
canonical transaction -> affected saved display rows in same DB
                                      |
                     indexed latest human block / older segments
                                      |
                      display HTTP / self-contained SSE updates
                                      |
                     browser rendering, input and viewport only
```

This explicitly authorizes session schema3, shared server projection and new display reads. It does not authorize a second agent loop, separate database, background projector or browser provider-state machine. Canonical events/receipts and existing provider replay stay intact. Live and historical rendering must agree at the same committed point.

The schema3/read API is PLANNED here; checkpoint code still uses session2/catalog1/stored1/runtime2/provider1. One-time explicit-open migration is separate from warm indexed access and cannot execute tasks. The implementor updates this paragraph only after actual implementation and evidence.

## Source ownership

| Area | Responsibility |
|---|---|
| src/provider.rs, gateway.rs, providers/openai_codex | Provider contracts, credentials, protocol and transport |
| src/context*, tools.rs | Context/skill validation and actual local tool execution |
| src/run*, execution* | Shared orchestration and awaited canonical recording/replay |
| src/storage* | Canonical events/receipts/projections, transactions, identities and ownership |
| src/service* | Host-owned jobs, passive clients/tickets, explicit cancellation/drain |
| src/http_api* | Request security, config, commands, DTOs and streaming |
| web/* checkpoint | Partial browser assets/client/tests, not accepted G1 |
| proposed src/conversation* | Shared display interpretation with no HTTP/SQL/provider-call dependency |

Native support is Linux/macOS; see [platform authority](PLATFORM_SUPPORT.md). Existing managed-auth/live evidence remains Linux-specific. No new platform, whole-repository security, physical power-loss or live-provider certification follows from CI. Current completion/evidence is in the [slice register](slices/README.md), not outdated source-era introduction text.
