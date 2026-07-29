# Wi source snapshot ledger

Status: frozen v0.2 design-reference ledger

Date recorded: 2026-07-29

Implementation baseline: `v0.1.0-vertical-slice`

## 1. Purpose and certainty policy

This ledger records the sources inspected during the research that informed Wi. It is an evidence ledger, not a dependency manifest and not a claim that upstream architecture is Wi architecture.

Certainty categories:

- **Exact pin:** tag and commit were retained and can identify exact source.
- **High-confidence reconstructed reference:** the commit is strongly reconstructed from surrounding evidence but was not recorded cryptographically at the original research moment.
- **Branch/date only:** repository, branch, approximate access date, and inspected areas are known; original SHA was not retained.
- **Mutable documentation reference:** the documentation area and approximate research window are known; content may change at the same URL.

Do not promote a reconstructed or branch/date reference to an exact historical pin. In particular, do not invent or backfill a modern SHA for Codex or OpenCode.

## 2. Frozen design references

### 2.1 `earendil-works/pi` — exact pin

```text
repository: earendil-works/pi
tag: v0.80.6
commit: 2b3fda9921b5590f285165287bd442a25817f17b
accessed: initial Wi research window before 2026-07-29; exact day not retained
certainty: exact released pin
```

Inspected areas:

```text
packages/agent/src/agent-loop.ts
packages/coding-agent/src/modes/rpc/rpc-mode.ts
packages/ai provider/auth/Responses code
```

Design topics reviewed:

- deterministic outer/inner agent loop;
- steering and follow-up queues;
- provider conversion boundary;
- JSONL/RPC mode;
- incomplete tool-call protection;
- provider/authentication and Responses integration patterns.

### 2.2 `zer09/pi-config` — high-confidence reconstruction

```text
repository: zer09/pi-config
commit: 659ddbff080274feade7b17d9490bace94e7380f
accessed: initial Wi research window before 2026-07-29; exact day not retained
certainty: reconstructed high confidence; not recorded cryptographically at the original research moment
```

Associated package baseline:

```text
Pi: 0.80.6
CodeGraph: 1.4.0
Context Mode: 1.0.169
```

Inspected areas:

```text
agent/extensions/codegraph
agent/extensions/context-mode
settings and compatibility documentation
```

Design topics reviewed:

- public-library CodeGraph integration;
- lean Context Mode tool allowlist;
- project-service lifecycle and compatibility patterns.

Why this remains reconstructed:

- the preceding upgrade established Pi `0.80.6` and Context Mode `1.0.169`;
- CodeGraph was upgraded to `1.4.0` before this snapshot;
- later CodeGraph implementation changes followed the initial Wi research window;
- the original research record did not cryptographically retain this checkout at that moment.

### 2.3 `openai/codex` — branch/date only

```text
repository: openai/codex
branch: main
accessed: approximately 2026-07-10/11
original SHA: not retained
certainty: branch/date only
```

Inspected areas include:

```text
codex-rs/core/src/client.rs
codex-rs/core/src/tools
protocol/model-provider/WebSocket/client code
```

Design topics reviewed:

- session-scoped provider clients and turn-scoped transport;
- connection prewarming and continuation;
- provider WebSocket/client behavior;
- tool/control-plane separation;
- observed HTTP recovery behavior.

These observations do not authorize Wi fallback. [ADR-0006](../adr/0006-no-app-server-fallback.md) remains authoritative.

### 2.4 `anomalyco/opencode` — branch/date only

```text
repository: anomalyco/opencode
branch: dev
accessed: approximately 2026-07-10/11
original SHA: not retained
certainty: branch/date only
```

Inspected areas include:

```text
session LLM/processor
prompt/provider/tool code
server event route
```

Design topics reviewed:

- provider normalization;
- persisted message/part forms;
- permission and tool boundaries;
- retry/compaction behavior;
- downstream event delivery.

## 3. Mutable documentation references

### 3.1 OpenAI documentation

Research window: approximately 2026-07-10/11. These URLs are mutable and are not content-addressed snapshots.

| Area | Reference | Design topic |
|---|---|---|
| Responses API | <https://platform.openai.com/docs/api-reference/responses> | request/response and item model |
| Authentication | <https://platform.openai.com/docs/api-reference/authentication> | Platform API authentication boundary |
| Function calling | <https://platform.openai.com/docs/guides/function-calling> | tool-call schemas and lifecycle |
| Reasoning | <https://platform.openai.com/docs/guides/reasoning> | reasoning controls, summaries, opaque state boundary |
| Prompt caching | <https://platform.openai.com/docs/guides/prompt-caching> | cached-token accounting and affinity |
| Streaming Responses | <https://platform.openai.com/docs/guides/streaming-responses> | HTTP/SSE event transport |
| WebSocket mode | <https://platform.openai.com/docs/guides/websocket-mode> | later persistent provider transport |

OpenAI documentation must be revalidated during the implementation milestone that uses it. Revalidation does not silently amend Wi's account, durability, tool, or fallback decisions.

### 3.2 SQLite documentation

Research window: v0.1 architecture and implementation. These URLs are mutable documentation references.

| Area | Reference | Design topic |
|---|---|---|
| Write-ahead logging | <https://sqlite.org/wal.html> | WAL behavior and backup sidecars |
| Pragmas | <https://sqlite.org/pragma.html> | connection safety/durability configuration |
| Backup API | <https://sqlite.org/backup.html> | future consistent snapshots |
| Attached databases | <https://sqlite.org/lang_attach.html> | cross-database limits and rejection of cross-store atomic assumptions |

Accepted storage ADRs and current Wi tests remain authoritative for implemented behavior.

## 4. What is frozen

The **Frozen design references** category contains:

- the exact Pi pin;
- the explicitly labeled reconstructed `pi-config` reference and package versions;
- the branch/date-only Codex and OpenCode observations;
- the mutable documentation areas above as research inputs.

“Frozen” means later Wi work compares against this recorded baseline. It does not mean Wi copies all upstream behavior or that mutable URLs preserve old content.

Implementation must preserve Wi-specific decisions:

- backend-owned runs;
- canonical durable session events and commit-before-publication;
- terminal-response tool promotion and durable effects;
- explicit account/workspace/billing identity;
- provider-chain isolation;
- no hidden provider/auth/billing switch;
- no `codex app-server` fallback.

## 5. Upstream watchlist

Track, but do not silently adopt:

```text
openai/codex main
earendil-works/pi releases after v0.80.6
anomalyco/opencode dev
zer09/pi-config after the reconstructed 659ddbff... reference
CodeGraph after 1.4.0
Context Mode after 1.0.169
OpenAI Responses/authentication/function-calling/reasoning/caching/WebSocket documentation
SQLite WAL/pragma/backup/attached-database documentation
```

Watchlist changes are observations only. They do not alter the active milestone or accepted ADRs.

## 6. Update-review gate

After the Platform and ChatGPT/Codex provider/authentication milestones stabilize:

1. compare the frozen source/reference with current upstream;
2. classify differences as security, protocol, useful improvement, or breaking change;
3. identify the concrete Wi requirement each proposed adoption solves;
4. reject changes that violate backend ownership, account/billing identity, durable events, tool-effect rules, provider-chain isolation, or no-fallback decisions;
5. adopt approved changes only through an ADR, ADR amendment, or explicit compatibility note;
6. add deterministic regression evidence before considering the update complete.

## 7. Known evidence limits

- The original Codex and OpenCode SHAs were not retained. Branch/date-only is the strongest honest claim.
- Exact access days for Pi and `pi-config` were not retained; “initial Wi research window before 2026-07-29” is the narrowest honest window and is distinct from the ledger recording date.
- The `pi-config` commit is a high-confidence reconstruction, not an originally recorded cryptographic pin.
- Mutable provider and SQLite documentation may differ from content seen during the research window.
- Inspected paths list research areas, not an assertion that every file or revision was exhaustively audited.
