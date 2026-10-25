# Wi documentation

[Delegate execution policy](DELEGATE_EXECUTION.md) documents the retained launcher and controlled verification procedure.

Start with [Current project state](PROJECT_STATE.md) for the dated baseline, open regression findings, and current scope. [Durable decisions](DECISIONS.md) records requirements and superseded proposals. Product guides describe implemented behavior, not an agent execution diary.

| Guide | Contents |
|---|---|
| [Current project state](PROJECT_STATE.md) | Restart point, accepted revision, current CI health, focused follow-up |
| [Durable decisions](DECISIONS.md) | Adopted direction, rationale, implementation trace, withdrawn proposals |
| [Configuration](CONFIGURATION.md) | Build, local startup, complete service JSON, token provisioning, shutdown |
| [Architecture](ARCHITECTURE.md) | Module ownership, execution and persistence flow, provider replay, failure boundaries |
| [HTTP API](API.md) | Routes, commands, receipts, errors, raw history, access checks |
| [Conversation protocol](CONVERSATION.md) | Human blocks, display DTOs, cursors, SSE, rebase and scrolling |
| [Storage](STORAGE.md) | Catalog/session layout, schema 3, commits, migrations, recovery and library reads |
| [Authentication](AUTHENTICATION.md) | Service owner token versus provider OAuth, managed profiles and limits |
| [Tools and context](TOOLS.md) | Global/project discovery, AGENTS.md, load_skill, result handling and exclusions |
| [Development](DEVELOPMENT.md) | Builds, offline checks, assets, browser tests, documentation maintenance |
| [Platforms](PLATFORM_SUPPORT.md) | Linux/macOS scope, browser test environment, Windows withdrawal |
| [Milestones](MILESTONES.md) | Delivered requirements, closure references, unapproved future work |
| [Acceptance](ACCEPTANCE.md) | G1.1 acceptance, later observations, waivers, preserved evidence |

## Source roles

Requirements and adopted decisions describe intent. Pinned code describes actual behavior. Test reports describe observed results at their revisions. Historical contracts retain their original status and do not authorize new work. Identify conflicts instead of silently changing the requirement or implementation.

The exact public Rust types live in src/; `cargo doc --no-deps` generates their reference. The pinned browser procedure is [web/BROWSER_TESTING.md](../web/BROWSER_TESTING.md). Old plans and investigations remain in the [evidence archive](ACCEPTANCE.md#historical-evidence), not the default reading path.

Project uploads are dated snapshots, not live repository synchronization. Follow the [export procedure](DEVELOPMENT.md#documentation-maintenance). Keep the two saved architecture chats as historical references; replace superseded checkpoints deliberately after verifying their separate backup.
