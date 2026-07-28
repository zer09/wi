# Wi v0.1 known limitations

These are intentional first-vertical-slice boundaries, not hidden roadmap promises.

## Provider and model

- The only provider is deterministic fake.
- There are no OpenAI Platform calls or API-key configuration.
- There is no ChatGPT/Codex OAuth adapter.
- Wi does not invoke or fall back to `codex app-server`.
- There is no automatic provider, model, endpoint, account, transport, or billing switch.

## Tools and projects

- Only safe deterministic test tools (`echo`, `guarded_echo`, and controlled delay behavior) exist.
- There is no real shell/process tool exposed to the model.
- There are no general filesystem read/write/edit tools in the product.
- CodeGraph, Context Mode, MCP/plugin services, project indexing, and arbitrary plugins are not implemented.
- The project model does not yet provide production project registration/management workflows in the GUI.

## Deployment and users

- Server operating system support is Linux only.
- Production binds only to `127.0.0.1`.
- Remote access and deployment are not supported.
- Wi assumes one trusted operating-system user; it has no human-user accounts, roles, permissions, or tenant isolation.
- Hostile same-user mutation of `WI_HOME` while Wi is running is outside the threat model.
- There is no Windows or macOS server support or CI.

## Storage and data lifecycle

- There is no production backup command, session-export API/UI, import command, or restore wizard.
- A stopped full-directory copy is the only documented manual backup procedure.
- Project catalog metadata is not reconstructable solely from session manifests.
- Retained pre-v4 session databases cannot reconstruct an already-lost original `session.create` command ID.
- Corrupt/unsupported databases are preserved and marked unavailable; there is no automatic repair of canonical session contents.
- Session databases may accumulate indefinitely; there is no compaction, retention policy, archival UI, or cross-session full-text search.
- Large content-addressed artifact/blob transfer is deferred; `/blobs/` and `/files/` return not implemented.

## Browser and interface

- The GUI is functional rather than polished.
- One browser connection can multiplex sessions, but there is no offline mode.
- Browser refresh/reconnect can temporarily show replaying/reconnecting states.
- Slow consumers are disconnected and must recover through replay.
- Browser SSE is not available.
- There is no session export UI or rich operational administration UI.

## Runtime and operations

- Most concurrency, queue, replay, and worker limits are fixed internal defaults rather than user-tunable environment settings.
- A non-cooperative in-process provider/tool that ignores cancellation beyond the bounded shutdown policy is process-fatal in this slice; restart recovery protects durable state.
- SQLite work is isolated in workers, but the installation still uses one local process and local files rather than distributed scheduling/storage.
- Logs are structured diagnostics written to standard output; there is no log rotation or metrics/telemetry service.
- No automatic updater, package installer, binary distribution, or service-unit installer is provided.

## Testing constraints

- Property/fuzz profiles are time-budgeted and can overshoot because durable histories and companion suites finish current work.
- Fast-check artifacts intentionally contain only bounded previews and identifiers, not complete arbitrary model/tool payloads.
- Browser E2E targets Chromium; cross-browser compatibility is not a v0.1 release gate.
- The final acceptance uses deterministic fake provider scenarios and test-only inspection controls; it does not validate any real provider or real host tool.

## Deferred next work

Only after the vertical-slice marker and review may later milestones consider direct provider adapters. Deferred work must preserve the established provider boundary, backend ownership, durable event/tool semantics, local security rules, and no-fallback decisions.
