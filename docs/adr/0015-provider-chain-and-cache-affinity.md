# ADR-0015: Pin runs to provider chains and connection-scoped cache affinity

Status: Accepted

Date: 2026-07-29

## Context

Provider APIs may expose response IDs, persistent transport continuations, opaque reasoning items, caches, and account-specific capabilities. Those values can improve continuity but are not canonical Wi history and may be valid only for one credential, account, workspace, model, or connection.

A user must be able to select another account for a later run in the same Wi session without leaking provider-private state or silently changing an active run. Naive reuse based only on provider/model name would violate account and billing identity.

## Decision

Every accepted run will snapshot at least:

```text
connectionId and credentialGeneration
providerId and authMode
subject/account/workspace identity
modelId and capabilitiesVersion
promptVersion and toolSchemaHash
reasoning configuration
transportMode
providerChainId
```

Acceptance commits this nonsecret snapshot before acknowledgement and provider work. Changing a session default cannot alter an active run.

`providerChainId` identifies one contiguous provider-affinity lineage. An explicit connection/account change always starts a new chain and is durably represented. Changes to credential identity, provider/auth/account/workspace, model, prompt, tool schema, reasoning contract, or transport continuation also start a new chain unless the adapter explicitly proves compatibility.

A new chain may rebuild from canonical Wi state:

```text
visible messages
durable tool calls/results
project/session/stable system instructions
compacted canonical summary when later implemented
context/compaction metadata explaining the rebuild
```

By default it may not reuse:

```text
previous_response_id
connection-local WebSocket continuation
opaque/encrypted reasoning or continuation state
provider response cache identity
account-specific capability state
provider-specific chain cursor
```

Opaque state is scoped to the exact connection/provider/auth/account/workspace/model/chain contract. Matching provider/model names do not establish portability.

Cache affinity includes at least:

```text
connectionId
modelId
promptVersion
toolSchemaHash
providerChainId
transportMode
```

Canonical bounded full replay is the correctness path after a cache miss or unavailable continuation. Provider cursor/cache state is only an optimization.

## Alternatives

### Treat the Wi session as one portable provider conversation

Rejected because a Wi session may deliberately change account/workspace/billing identity and provider-private state is not generally portable.

### Key affinity only by model and prompt

Rejected because it permits cross-account cache/cursor reuse and ignores tool, chain, and transport identity.

### Prohibit account changes within a Wi session

Rejected because canonical Wi history can safely rebuild a new provider chain and users need deliberate later-run selection.

### Copy opaque state unless the provider rejects it

Rejected because attempted cross-account transmission is already an isolation failure; portability must be proven before use.

## Consequences

Positive:

- active runs remain stable when session defaults change;
- canonical Wi history remains portable while provider-private state remains isolated;
- account/workspace/billing and cache identity are explicit;
- cache misses degrade to canonical replay rather than hidden fallback;
- later transport optimization cannot become the source of truth.

Negative:

- account/model/prompt/tool/transport changes may lose provider cache efficiency;
- run snapshots and durable chain-boundary events add storage/protocol work;
- adapters must classify every provider state item and capability dimension;
- full canonical replay needs bounded context/compaction behavior.

## Security/failure implications

- No provider cursor, opaque reasoning state, capability state, or cache identity crosses a connection by default.
- Credential-generation mismatch fails the pinned run rather than consuming replacement credentials.
- Deleting a connection does not erase the historical nonsecret run snapshot.
- Provider-private state is sensitive untrusted data: it is bounded, redacted, excluded from browser display unless it is an explicit provider-approved summary, and never authorizes a tool.
- Cache/continuation failure does not authorize another account, auth mode, endpoint, transport after unsafe output, billing source, or `codex app-server`.
- ADR-0007 still governs retry after semantic output; ADR-0008 still governs effects.

## Validation requirements

- Change a session default A to B during run A; prove run A stays A and the next run uses B/new chain.
- Prove run snapshots survive restart/replay and contain no secrets.
- Prove `previous_response_id`, WebSocket continuation, opaque state, provider cursor, and A-specific capabilities never enter a B request.
- Property-test affinity keys so `connectionId` and each required dimension affect identity.
- Prove canonical replay produces equivalent Wi-visible request history after cache/continuation miss.
- Prove credential-generation mismatch, deleted/disabled connection, and incompatible capability/model changes fail explicitly without fallback.
- Prove provider-approved reasoning summaries and opaque state take separate browser/storage paths.

## Implementation milestone

- Milestone 11: run snapshots, explicit chain identity, and default-change behavior.
- Milestone 14: opaque state, previous-response continuation, prompt-cache accounting, and transport affinity.
- Milestone 10 records architecture only.
