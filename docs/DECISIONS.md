# Durable decisions

**Reconciled:** 2026-10-25 against runtime `a2974d19a327d4a29de5e3b2352628d021f9b453`.
This register preserves adopted direction, rationale, and remaining scope. It does not independently authorize implementation. Exact dates of earlier owner statements are not invented; closure references identify the accepted slices that carried them forward.

## Adopted direction and implementation

| ID | Requirement / decision | Rationale and implemented boundary | Trace |
|---|---|---|---|
| D01 | Rust harness core with a thin Rust service in one initial application | A gateway is one component, not the whole harness. Shared library calls avoid a second agent loop or CLI subprocess backend. TypeScript in the browser needs no Node production server. | [Architecture](ARCHITECTURE.md); [V1-A PR #8](https://github.com/zer09/wi/pull/8), [V1-B PR #9](https://github.com/zer09/wi/pull/9), [G1.1 PR #10](https://github.com/zer09/wi/pull/10) |
| D02 | OpenAI-Codex first; provider-neutral Rust interfaces | One shipped provider is sufficient now. Static traits are not a dynamic plugin loader. Anthropic and other adapters need a separate requirement. | [Architecture](ARCHITECTURE.md); historical gateway/auth records in [acceptance archive](ACCEPTANCE.md#historical-evidence) |
| D03 | Wi-managed provider credentials and explicit external read-only sources remain distinct | Profiles bind identity per provider session. No silent account/model/transport/billing substitution. Experimental registration reuse is not provider approval. | [Authentication](AUTHENTICATION.md) |
| D04 | Small implementation slices do not impose small task workloads | C1 deleted RunLimits, quotas, whole-task deadlines, related outcomes/flags, and replacement optional budgets. Scoped payload/network/representation protections remain distinct. | [C1 PR #1](https://github.com/zer09/wi/pull/1); [Architecture](ARCHITECTURE.md) |
| D05 | Global plus project skill metadata; explicit scoped identities | Global and project names coexist. Bodies load through explicit selection or the catalog-bound main-SKILL tool, not automatic resource/script execution. | [Tools](TOOLS.md); [S1 PR #2](https://github.com/zer09/wi/pull/2), [S2 PR #3](https://github.com/zer09/wi/pull/3) |
| D06 | Embedded storage only; database-file readability is not a product criterion | Users read conversation in the UI. One SQLite engine stores canonical session data and projections; no external database server or unmeasured log-engine speed claim. | [Storage](STORAGE.md); [P1-A PR #5](https://github.com/zer09/wi/pull/5) |
| D07 | Canonical database per application session plus lightweight catalog | Session lifecycle/isolation and lazy ownership justify the topology, not a universal throughput claim. Catalog refresh can lag without revoking a session commit. | [Storage](STORAGE.md); P1-A |
| D08 | Commit-backed acceptance and actual result capture | Queue admission is not commit. Save actual prepared input and serialized tool output/is_error. Receipts support reconciliation but do not guarantee exactly-once arbitrary external effects. | [Architecture](ARCHITECTURE.md); [P1-B1 PR #6](https://github.com/zer09/wi/pull/6) |
| D09 | Persist sessions; do not automatically restart old tasks | Reopen preserves committed partial content and records interruption. No model/tool rerun or result resend merely because storage reopens. An explicit new task may use compatible stored context. | [Storage](STORAGE.md); [P1-B2 PR #7](https://github.com/zer09/wi/pull/7) |
| D10 | Service owns execution; browser disconnect is not cancellation | Clients and tickets observe work. Explicit cancellation addresses a run. Shutdown drains execution while storage remains writable, then closes storage. | [Architecture](ARCHITECTURE.md); V1-A/V1-B |
| D11 | One owner, multiple browser clients/devices | Present listener is loopback. Optional separately operated proxy is not a fully packaged remote deployment. Preserve the goal without claiming untested network deployment. | [Configuration](CONFIGURATION.md); V1-B/G1.1 |
| D12 | Small centralized owner bearer check; local HTTP without TLS setup | Retain the memory-only Connect flow and strict Host/Origin boundary. Do not expand to accounts/JWTs/cookies or silently remove access checks. A full reload requires Connect. | [Authentication](AUTHENTICATION.md); [Configuration](CONFIGURATION.md); adopted G1.1 |
| D13 | Open newest human-message interaction before older history | Show B immediately. Fill unused initial viewport one older unit at a time; then require upward intent. Keep previous-block, within-block, content, and live positions separate. | [Conversation](CONVERSATION.md); G1.1 |
| D14 | Saved ordered display records beside immutable events | Update affected projection in the canonical transaction. Ordinary reads use indexed display records, not whole raw-prefix reconstruction or one giant interaction JSON row. Live/reopened chat must agree at the same committed point. | [Storage](STORAGE.md); [Conversation](CONVERSATION.md); schema 3 / G1.1 |
| D15 | Browser handles presentation, not agent semantics | Server determines tool/run outcome and partial-to-final replacement. Client handles rendering, input, ranges/revisions, epochs, viewport, and command identities. HTTP commands and display SSE have separate roles. | [API](API.md); [Conversation](CONVERSATION.md) |
| D16 | Linux/macOS native scope; Windows withdrawn | Do not restore Windows-specific code or CI incidentally. Managed-auth filesystem support remains Linux-specific; a native macOS test pass is not an auth-support claim. | [Platforms](PLATFORM_SUPPORT.md); owner-approved withdrawal in PR #9 |

## Superseded or withdrawn proposals

| Proposal | Current disposition |
|---|---|
| M3 4-request / 8-tool / 120-second run policy; optional C1 budgets | Removed by C1. Do not revive as disabled, renamed, optional, or test-derived runtime policy. |
| Universal M4 tool-timeout/progress framework | Withdrawn, not the next task. A future individual tool needs its own approved behavior. |
| Hosted skills, automatic upload, API-key billing fallback | Withdrawn from active scope. S1 removed active hosted-skill scaffolding. |
| S2 `ToolFailed` implies wire code `tool_failed` | Incorrect. The retained mapping is `gateway_error`; enum spelling is not serialization evidence. |
| G1.0 replay from event zero before displaying or observing chat | Replaced by human-anchored latest-first G1.1. Raw event APIs remain separate. |
| Initial 30-entry view spanning interactions; never fill an initially blank viewport | Rejected. Fetch B alone, then let measured initial viewport space request older content. |
| G1 read-time reduction of every event in the selected large run | Replaced by transactionally maintained saved display records. |
| One giant saved JSON row per interaction; category-grouped history | Not adopted. One logical block may contain multiple ordered records without changing the normal chat UI. |
| Exact Chromium-internal Window B experiment | Superseded by deterministic application-boundary coverage and real latest-state recovery tests. Preserve the failed experiments. |
| G11-36 exact native-release-to-DOM timing | Owner-waived. It remains a waiver, not a benchmark result. |
| Earlier suggestion to remove the owner token or use native EventSource | Discussion only. The accepted G1.1 retains bearer access and the fetch-based stream path. |
| Old TypeScript automatic task recovery, retries, fixed installation limits, Node worker architecture | Not inherited into Rust. Import only an explicitly adopted requirement. |

## Evidence and changes to decisions

Use owner statements to establish requirements and authorization. Use pinned code to establish behavior. Use executed reports and exact-head jobs to establish observations. Upstream research is advisory. Do not change production code simply to satisfy stale prose, and do not redefine an owner requirement to conceal narrower implementation.

For a change, identify the affected D-ID, the reason, the approved replacement scope, source/test implications, and the superseding decision. Keep the earlier disposition visible. Link a concrete contract only when approved. Do not create runtime scaffolding for every deferred idea.

Historical source material remains in the [evidence archive](ACCEPTANCE.md#historical-evidence) and the separately preserved Project-source backup. The saved Rust/Pi chats are design and research history, not a higher-priority specification than these later reconciled decisions.
