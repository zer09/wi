# ADR-0017: Keep OpenAI state opaque and implement HTTP/SSE before WebSocket continuation

Status: Accepted

Date: 2026-07-29

## Context

OpenAI Responses integrations may include reasoning controls and summaries, opaque continuation items, response IDs, prompt-cache usage, compaction metadata, and persistent WebSocket transport. Wi needs provider-neutral concepts for these features without making the core parse hidden reasoning or treating provider-private state as canonical history.

Implementing persistent provider WebSocket continuation before basic HTTP/SSE would combine authentication, event normalization, transport recovery, cache identity, and opaque-state recovery in one milestone. It could also encourage unsafe fallback after visible output.

ADR-0005 requires direct adapters and ADR-0006 prohibits `codex app-server` fallback. ADR-0007 and ADR-0008 remain authoritative for partial output and tools.

## Decision

The provider-neutral contract will represent:

```text
stable system instructions and promptVersion
model selection
tool schemas and toolSchemaHash
reasoning effort/configuration
provider-approved reasoning summaries
opaque provider continuation items
usage and cached-token accounting
provider response metadata/cursors
connection-specific capability snapshots
transport selection/transitions
context/compaction metadata
```

Wi core must not parse, expose, request for display, or depend on private hidden chain-of-thought. Provider-approved reasoning summaries are explicit bounded provider output. Opaque reasoning/continuation items remain uninterpreted and cannot authorize tool execution.

Opaque state is scoped to connection, provider, auth mode, account/workspace, credential identity, model, and provider chain. It is non-portable by default under ADR-0015. Milestone 14 may persist it in bounded canonical session storage only with explicit schema, redaction, browser-exclusion, and recovery rules.

Implementation order is fixed:

1. Milestone 12: OpenAI Platform Responses HTTP/SSE;
2. Milestone 13: direct ChatGPT/Codex OAuth adapter on its supported Responses surface;
3. Milestone 14: persistent Responses WebSocket optimization, provider-state persistence, prompt-cache metrics, and previous-response continuation.

Provider WebSocket is an optimization. Canonical bounded full replay is the correctness path when cache/continuation is missing or invalid.

A WebSocket transport failure may recover to HTTP/SSE only within the same explicit connection/account/workspace/auth mode/model/billing identity and policy. The transition is durably represented and must satisfy ADR-0007: before semantic output it may retry within policy; after output it requires a verified continuation that cannot duplicate output/effects, otherwise the run is interrupted. It never switches auth mode and never invokes `codex app-server`.

## Alternatives

### Expose or parse hidden reasoning

Rejected because Wi must not depend on private chain-of-thought and provider-private internals are not a stable domain contract.

### Implement provider WebSocket first

Rejected because HTTP/SSE gives a simpler deterministic base for auth, event normalization, partial-stream behavior, tools, and mock-server tests.

### Make `previous_response_id` canonical state

Rejected because it is provider-private, connection-scoped, and may expire or miss. Canonical Wi history must rebuild without it.

### Fall back from ChatGPT/Codex transport to Platform API

Rejected because it changes auth and billing identity. The two adapters are separate under ADR-0005.

### Fall back to `codex app-server`

Rejected and already prohibited by ADR-0006.

## Consequences

Positive:

- core stays provider-neutral and independent of hidden reasoning;
- HTTP/SSE establishes a testable correctness baseline;
- opaque provider state and caches remain optimizations with explicit scope;
- transport recovery cannot hide an account/billing change;
- canonical replay remains available after cache loss.

Negative:

- WebSocket/cache performance arrives later;
- adapters need explicit conversion and capability contracts;
- opaque-state persistence needs bounded sensitive-data handling;
- post-output transport failures may interrupt runs when safe continuation cannot be proven.

## Security/failure implications

- Hidden reasoning is neither parsed nor shown to the browser.
- Provider-approved summaries are bounded, untrusted text and distinct from opaque state.
- Opaque state is sensitive, bounded, redacted, connection/chain-bound, and non-executable.
- Provider metadata and usage never include credentials or arbitrary unbounded payloads in diagnostics/telemetry.
- A capability contradiction or malformed provider state fails the affected provider step/run and does not reroute.
- Transport recovery is same-identity only and cannot bypass provisional-output or tool-ledger rules.
- No transport failure authorizes another provider, account, workspace, auth mode, model, billing source, or app-server runtime.

## Validation requirements

- Contract tests distinguish reasoning configuration, provider-approved summaries, and opaque continuation state.
- Prove core never parses opaque state or treats it as tool authorization.
- Prove run/capability snapshots bind model, reasoning controls, transport, and capability version.
- Mock HTTP/SSE tests precede and remain the correctness oracle for WebSocket tests.
- Prove previous-response and WebSocket continuation are never reused across connections/chains.
- Prove cache/continuation miss rebuilds from bounded canonical Wi state.
- Test WebSocket-to-SSE recovery before output, safe verified continuation after output, and interruption when continuation cannot be proven.
- Assert no auth-mode, billing, account, or `codex app-server` fallback.
- Test usage/cached-token accounting and context/compaction metadata bounds.

## Implementation milestone

- Milestone 12: Platform Responses HTTP/SSE and normalized events.
- Milestone 13: ChatGPT/Codex OAuth adapter using direct supported transport.
- Milestone 14: opaque state, reasoning summaries/state, caching metrics, WebSocket transport, and continuation.
- Milestone 10 records architecture only.
