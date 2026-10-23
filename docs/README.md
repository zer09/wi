# Wi documentation

These guides describe the implementation, not an agent assignment or an execution diary.

| Guide | Contents |
|---|---|
| [Configuration](CONFIGURATION.md) | Build, local startup, complete service JSON, token provisioning, shutdown |
| [Architecture](ARCHITECTURE.md) | Module ownership, execution and persistence flow, provider replay, failure boundaries |
| [HTTP API](API.md) | Routes, commands, receipts, errors, raw history, access checks |
| [Conversation protocol](CONVERSATION.md) | Human blocks, display DTOs, cursors, SSE, rebase and scrolling |
| [Storage](STORAGE.md) | Catalog/session layout, schema 3, commits, migrations, recovery and library reads |
| [Authentication](AUTHENTICATION.md) | Service owner token versus provider OAuth, managed profiles and limits |
| [Tools and context](TOOLS.md) | Global/project discovery, AGENTS.md, `load_skill`, result handling and exclusions |
| [Development](DEVELOPMENT.md) | Source map, builds, offline checks, assets and browser tests |
| [Platforms](PLATFORM_SUPPORT.md) | Linux/macOS scope, browser test environment, Windows withdrawal |
| [Milestones](MILESTONES.md) | Completed foundations and unapproved future work |
| [Acceptance](ACCEPTANCE.md) | G1.1 acceptance scope, known limitations, and preserved evidence |

The exact public Rust types live in `src/`; `cargo doc --no-deps` generates their reference. Test procedures for the separately pinned browser are in [web/BROWSER_TESTING.md](../web/BROWSER_TESTING.md). Earlier plans and investigation records are retained outside the normal documentation tree, as explained in [Acceptance](ACCEPTANCE.md#historical-evidence).
