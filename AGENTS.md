# Wi repository instructions

## Product scope

Wi is a local, single-operating-system-user, Linux-only browser-based coding-agent harness.

The browser is a temporary GUI. The Node.js backend owns sessions, runs, provider requests, tool execution, approvals, pending questions, project services, and persistence. Browser refresh, disconnect, tab closure, or Wi UI sign-out must not cancel backend work.

The released v0.1 vertical slice uses a deterministic fake provider and safe built-in test tools only. It intentionally excludes OpenAI integration, ChatGPT/Codex OAuth, `codex app-server`, CodeGraph, Context Mode, real shell commands, real file mutation tools, browser SSE, remote deployment, and multi-user hosting.

The planned v0.2 provider-integration phase is governed by `docs/plans/v0.2-openai-provider-integration.md`. Architecture planning does not mean OpenAI connections, OAuth, credentials, or routing are already implemented.

## Required reading

Before changing code, read:

1. `docs/plans/v0.1-first-vertical-slice.md`
2. `docs/architecture/v0.1-overview.md`
3. The architecture document relevant to the milestone
4. `docs/adr/README.md`
5. Every ADR relevant to the files being changed

For Milestone 11 onward, also read completely:

1. `docs/plans/v0.2-openai-provider-integration.md`
2. `docs/architecture/v0.2-provider-connections.md`
3. `docs/reference/source-snapshots.md` when provider, authentication, transport, CodeGraph, or Context Mode references are relevant
4. ADR-0013 through ADR-0017 as applicable

Do not silently reinterpret an accepted ADR. Propose a new ADR or an explicit amendment when a decision must change.

## Version control

- Files under `prompts/` are local workflow artifacts. Do not stage any path under `prompts/`.

## Runtime and tooling

- Target Node.js 24 on Linux. The v0.1 server must fail fast on other operating systems.
- Use pnpm workspaces.
- Use TypeScript ESM with strict checking.
- Enable `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Keep production packages small and dependency-directed.
- Use Vitest for unit and integration tests.
- Use fast-check for property and fuzz tests.
- Use Playwright for browser end-to-end tests.
- Run `pnpm check` before completing a milestone.

## Hard architectural invariants

- Commit session events before publishing them.
- The per-session database is canonical; the catalog is a rebuildable index.
- Canonical session events are append-only.
- Every session event has a monotonically increasing session-local sequence.
- One active run is allowed per session; many sessions may run concurrently.
- Browser disconnect never cancels a run.
- Every state-changing browser command is idempotent by `commandId`.
- Do not execute a tool from a partial, failed, cancelled, incomplete, or nonterminal provider response.
- Every tool effect passes through the durable tool ledger.
- Do not run synchronous SQLite work on the main Node.js event loop.
- Do not run CPU-heavy work or plugins on the main Node.js event loop.
- Do not import Fastify, React, SQLite-driver, or worker implementation types into domain packages.
- Do not invoke or add a fallback to `codex app-server`.
- Do not add OpenAI integration during the first vertical slice.
- Milestone 11 is fake/no-network only; OpenAI requests, endpoint probes, OAuth exchanges, and live capability discovery begin no earlier than their Milestone 12 or 13 scope.
- Do not add browser SSE; use the multiplexed WebSocket protocol.
- Fail the smallest reasonable fault domain and log a redacted diagnostic.
- Treat the local operating-system user as trusted; hostile concurrent same-user mutation of `WI_HOME` is outside v0.1's threat model.
- Do not add Windows support or Windows CI without a new ADR.
- Do not silently switch provider, endpoint, transport, model, account, workspace, authentication mode, or billing source.
- Future OAuth callbacks retain strict loopback Host validation; attempt state/PKCE/redirect identity—not WebSocket Origin or the Wi browser cookie—authorizes completion.
- Multiple provider connections are isolated; refresh, logout, disable, deletion, or failure of one connection must not mutate another.
- One durable per-connection lifecycle owner serializes credential and administrative mutations through terminal catalog commit; conflicting commands cannot supersede it or resurrect credentials.
- Active runs are pinned to a provider connection and credential generation.
- Provider secrets stay outside catalog and session databases and never enter browser payloads; file API keys enter only through backend-local staged provisioning outside `WI_HOME`.
- Environment-backed runs pin a nonpersisted credential fingerprint before acknowledgement and interrupt on backend restart rather than accepting a changed value.
- Credential files stay outside `WI_HOME` and its backup/export boundary.
- Complete catalog loss never auto-imports credentials; explicit recovery claims one backend-issued opaque reference and restores only the envelope's original connection and generation after fail-closed conflict checks.
- Explicit connection selection is the only active routing policy until a later accepted ADR or telemetry gate authorizes another policy.
- Opaque provider state, provider cursors, and cache identity are not portable across connections by default.

## Dependency boundaries

- `packages/protocol` is dependency-light, runtime-validated, and browser-safe.
- `packages/storage` owns SQLite schemas, migrations, workers, and implementation details.
- `packages/provider-contract` defines the provider boundary.
- `packages/provider-fake` implements `provider-contract` and has no OpenAI dependency.
- `packages/tools` owns tool definitions, policy, execution, and ledger-facing abstractions.
- `packages/harness-core` depends on interfaces, not Fastify, React, or SQLite drivers.
- `packages/client-state` contains a pure reducer used for both replay and live events.
- `apps/server` composes backend packages and owns HTTP/WebSocket framework code.
- `apps/web` is a GUI and never owns backend run state.
- `packages/test-support` contains deterministic test fixtures and must not become a production dependency.

## Main-thread restrictions

The main server thread may perform networking, validation, scheduling, bounded serialization, lightweight state transitions, and provider network I/O.

The main server thread must not perform:

- synchronous SQLite access
- `spawnSync`, `execSync`, or equivalent synchronous process execution
- unbounded file walking or parsing
- CPU-heavy indexing, diffing, compression, or analysis
- arbitrary plugin code
- unbounded JSON parsing or logging

Use worker threads or child processes behind narrow, validated RPC boundaries.

## Persistence rules

- Event append and projection updates occur in one session-database transaction.
- Publish only after the transaction commits.
- A catalog update may happen after the session commit and may temporarily lag.
- No workflow may require an atomic transaction across catalog and session databases.
- Duplicate commands with identical canonical content return their original result.
- Reusing a command ID with different content is a conflict.
- Session database manifests must be sufficient to rebuild catalog entries.
- Database migrations are versioned, deterministic, transactional where supported, and tested from prior versions.

## Provider and tool rules

- Provider output remains provisional until a valid terminal event is accepted.
- Complete tool calls may be staged during streaming but may not execute yet.
- Promote staged tool calls only after provider-step completion is committed.
- Duplicate tool `callId` plus identical arguments reuses the existing execution or result.
- Duplicate tool `callId` plus different arguments is a provider protocol error.
- Never retry an ambiguous non-idempotent effect automatically.
- Preserve partial assistant text and mark it interrupted when a stream fails after visible output.

## WebSocket rules

- One browser connection may subscribe to multiple sessions.
- One session may have multiple browser subscribers.
- WebSocket connection lifetime never owns run lifetime.
- Reconnection uses per-session sequence cursors.
- Replay and live delivery must use a race-free replay barrier.
- Command acknowledgements are sent only after durable acceptance.
- Slow consumers use bounded queues and may be disconnected; they recover through replay.

## Security rules for the local v0.1 server

- Bind to loopback by default.
- Validate `Host` and WebSocket `Origin`.
- Require the local browser session credential.
- Treat all model, provider, project, and tool output as untrusted text.
- Bound frame sizes, parsing depth, logging previews, and outbound queues.
- Redact cookies, API keys, OAuth material, authorization headers, and sensitive query strings.
- Return a safe `diagnosticId` to the browser; keep detailed redacted diagnostics in server logs.

## Testing requirements

Add tests before or alongside behavior. The milestone plan defines the minimum suites.

- Unit tests cover schemas, state transitions, hashing, and reducers.
- Integration tests cover package boundaries and transactional behavior.
- Property tests exercise command idempotency, actor invariants, replay equivalence, and ledger semantics.
- Process tests kill and restart real child server processes at documented failpoints.
- End-to-end tests use the browser and real WebSocket gateway.
- Fuzz failures must print the seed, minimized counterexample, and a reproduction command.
- Use deterministic clocks and ID generators in tests.
- A test must fail if an event is published before commit.
- A test must fail if a duplicate command creates a duplicate run or tool effect.
- A test must fail if a tool executes before provider terminal completion.

## Milestone workflow

For every milestone:

1. Read the plan and relevant ADRs.
2. Inspect existing code and tests before editing.
3. Restate the milestone scope and expected files.
4. Implement only that milestone.
5. Add or update tests with the implementation.
6. Run the narrow test set repeatedly while developing.
7. Run the milestone exit gate and `pnpm check`.
8. Report changed files, invariants implemented, tests added, exact commands run, and remaining risks.
9. Stop at the milestone boundary.

A milestone is not complete merely because code compiles. Its exit gate must pass.
