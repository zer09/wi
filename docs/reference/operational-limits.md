# Wi v0.1 configuration and operational limits

This reference describes the production entry `apps/server/dist/main.js`. Most internal limits are intentionally fixed in v0.1; they are not environment configuration promises.

## Environment configuration

| Variable | Default | Validation | Effect |
|---|---:|---|---|
| `WI_HOME` | `~/.wi` | non-empty string | Root for catalog, session databases, artifacts, logs, and temporary files |
| `WI_PORT` | `4317` | integer `0..65535` | Loopback HTTP/WebSocket port; `0` selects an ephemeral port |
| `WI_SHUTDOWN_DEADLINE_MS` | `15000` | safe integer `100..120000` | Overall graceful shutdown budget; hard watchdog fires 2 seconds later |
| `WI_SESSION_DISCOVERY_LIMIT` | `1000` | safe integer `1..10000` | Maximum generated session directories inventoried during repair discovery |
| `WI_CATALOG_REPAIR` | unset | exactly `1` when present | Forces explicit catalog reconstruction |

The host is fixed to `127.0.0.1`; there is no bind-address option. Configuration is parsed before workers start. Unknown environment variables are ignored unless used by Node.js or the test harness; production test-failpoint variables are inert without both test mode and explicit gates.

## HTTP and browser bootstrap

| Limit | Value |
|---|---:|
| Header size | 16 KiB |
| Header timeout | 5 seconds |
| Request timeout | 10 seconds |
| Keep-alive timeout | 5 seconds |
| Static asset size | 5 MiB |
| Bootstrap session summaries | 1,000 maximum |
| Default HTTP shutdown timeout | 2 seconds |
| Maximum configurable internal HTTP shutdown timeout | 30 seconds |

Bootstrap reports `sessionsTruncated` when more than 1,000 rows exist. An explicit `?session=<id>` remains authoritative even if that session is omitted from the bounded page.

## WebSocket defaults

| Limit | Default |
|---|---:|
| Client frame size | 64 KiB |
| JSON container depth | 32 |
| Pending inbound frames | 64 |
| Pending inbound bytes | 512 KiB |
| Protocol violations before close | 3 |
| Subscriptions per connection | 64 |
| Outbound queued messages | 256 |
| Outbound queued bytes | 1 MiB |
| Single outbound message | 256 KiB |
| Replay live backlog | 1,024 events / 1 MiB |
| Replay live single event | 256 KiB |
| Historical replay page | 64 events |
| Historical page bytes | 257 KiB (`256 KiB` payload plus `1 KiB` envelope reserve) |
| Historical single event | 256 KiB |
| Replay queue wait | 5 seconds |
| Heartbeat interval | 15 seconds |
| Initial hello timeout | 10 seconds |
| Gateway shutdown timeout | 2 seconds |

The server disables WebSocket compression. Slow consumers are disconnected rather than losing durable event frames. They recover through replay.

The durable command payload allowance is derived from frame, outbound, replay, and worker-RPC capacities and leaves a 4 KiB server-owned event-envelope reserve. The browser receives its effective limits in bootstrap and rejects oversized drafts before submission.

Internal gateway overrides are constructor-only test/composition options, capped by `WEBSOCKET_LIMIT_CAPS`; they are not production environment variables.

## Provider boundary

The v0.1 provider is deterministic fake only.

| Limit | Value |
|---|---:|
| Provider configuration | 48 KiB, depth 32, 4,096 nodes |
| Input items per request | 256 |
| Tool calls per step | 256 |
| Complete provider request | 512 KiB, depth 34, 16,384 nodes |
| Individual message text | 16 KiB UTF-8 |
| Cumulative response text per step | 16 KiB UTF-8 |
| Text delta | 16 KiB UTF-8 |
| Tool name | 256 bytes |
| Tool arguments envelope | 48 KiB |
| Provider failure message | 8 KiB |
| Provider response ID | 256 bytes |

Provider output remains provisional until a valid terminal event is accepted. A boundary violation fails the provider step/run and cannot promote staged tools.

## Storage and workers

| Limit/default | Value |
|---|---:|
| Catalog workers | 1 |
| Session worker pool | `min(4, max(2, availableParallelism() - 1))` |
| Open session handles per session worker | 32 |
| Worker request timeout | 10 seconds |
| Worker termination/close confirmation | 2 seconds |
| Worker RPC payload | depth 64, 20,000 nodes, 1,000,000 units |
| Storage event page hard maximum | 256 events / 1,000,000 bytes |
| Storage event-page envelope reserve | 1,024 bytes |
| Discovery page | 64 session databases |
| Discovery request timeout | 10–120 seconds depending on configured inventory limit |

Session IDs are stably assigned to the fixed worker pool. Handles are opened lazily and evicted least-recently-used within each worker. A timed-out write has an ambiguous transport outcome and must be reconciled by durable IDs; it is not blindly replayed.

## Runtime concurrency and lifecycle

| Default | Value |
|---|---:|
| Provider concurrency | 4 |
| Tool concurrency | 4 |
| Actor idle timeout | 60 seconds |
| Actor eviction scan | 30 seconds |
| Active runs per session | 1 |

Multiple sessions may run concurrently. Later submissions to a busy session become durable queued follow-ups. Browser connection count does not own actor or run lifetime.

## Logs and untrusted data

Structured log data is bounded by depth, entry count, key length, and string length. Sensitive key concepts, cookies, authorization values, token-like text, URL credentials, and query strings are redacted. Error messages are represented by bounded fingerprints rather than raw untrusted text. Logs are diagnostic output, not an audit database.

## Fuzz limits

- fast-check seed: `1..2147483647`
- deterministic run/operation override: `WI_FC_NUM_RUNS=1..1000`
- timed profile duration: `WI_FUZZ_DURATION_MS=1000..86400000`
- local default: 60 seconds minimum fuzz budget
- extended default: 600 seconds minimum fuzz budget

See [property and fuzz testing](../testing/fuzzing.md) for reproduction and artifact behavior.
