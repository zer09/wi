# Changelog

## Unreleased

### Conversation client and storage

- Embedded text-first TypeScript browser client served by the Rust application.
- Newest-human-interaction-first pages, explicit older activity/content continuation, viewport-aware backscroll, and latest-state reconnect.
- Session schema 3 adds transactionally maintained display blocks, entries, fields, and UTF-8 chunks alongside canonical events.
- Shared conversation reads, display SSE, and addressed read-only task reconciliation.
- Stable live/history identities and chronological display without a browser-side raw agent-event reducer.
- Transactional migration of retained session schemas; no model/tool execution during migration or recovery.

### Runtime and service

- Persistent SQLite sessions, actual runtime capture, and compatible provider-native history for a new explicit task.
- Service-owned tasks, passive observers, durable acceptance, explicit cancellation, and drain-before-storage-close shutdown.
- Authenticated loopback HTTP, strict operator configuration, approved workspaces, and separate provider/service credentials.
- Global/project local skills and catalog-bound `load_skill`; optional arithmetic diagnostic tool.
- Wi-managed experimental provider login/renewal; explicit read-only external credential sources for diagnostic callers.

### Compatibility and verification

Native Windows backend support is withdrawn. Linux/macOS native checks and the Linux-x64 browser gate remain. Managed authentication is Linux-specific. No release, deployment, or new live-provider certification is implied.

G1.1 closes with 39 PASS and one PASS_WITH_WAIVER. See [acceptance](docs/ACCEPTANCE.md) for the exact scope, measurement waiver, historical reliability observations, and original reports. The documentation cleanup changes no production behavior, dependency, or workflow. The schema regression's include path moves to the exact SQL reference in STORAGE.md without changing assertions.

## 0.2.0 source handoff, September 2026

The original handoff introduced provider sessions, WebSocket/SSE transports, typed events, and a diagnostic tool round trip. Its then-unimplemented capabilities and initial verification failures are historical, not current product status. The complete original changelog and subsequent reports are in the [archive](docs/ACCEPTANCE.md#historical-evidence).
