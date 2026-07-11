# ADR-0002: Use HTTP plus one multiplexed browser WebSocket

Status: Accepted  
Date: 2026-07-11

## Context

Wi's browser needs bidirectional interaction:

- submit messages
- cancel runs
- approve or deny tools
- answer pending questions
- subscribe to several sessions
- receive streamed provider and tool events

REST plus SSE could support this using separate command and event channels. A single WebSocket is a natural fit because Wi controls both browser and backend and needs frequent bidirectional messages.

WebSocket alone does not provide durable replay, command idempotency, or reconnection semantics. Wi must implement those at the application layer.

## Decision

Use:

- HTTP for the browser application, bootstrap/authentication, health, and future large file/blob endpoints
- one authenticated multiplexed WebSocket per browser client for commands, acknowledgements, subscriptions, replay, live events, approvals, cancellation, pending input, and heartbeats

Do not use browser SSE in v0.1.

## Protocol requirements

- every state-changing command has a stable `commandId`
- every durable session event has a monotonically increasing session-local sequence
- command acknowledgement is sent only after commit
- one connection can subscribe to many sessions
- one session can have many subscribers
- reconnect uses per-session sequence cursors
- replay uses a race-free replay/live barrier
- connection lifetime never owns run lifetime
- outbound queues are bounded
- slow consumers are disconnected and recover through replay

## Security requirements

- bind to loopback by default
- validate `Host` and WebSocket `Origin`
- require a valid local browser session credential
- enforce frame/message limits
- render model/tool output as untrusted text

## Consequences

Positive:

- one interactive channel for the GUI
- natural support for multi-session subscriptions
- low overhead for streamed events and approvals
- simpler browser state synchronization than separate SSE and command channels

Negative:

- Wi must implement replay and idempotency explicitly
- proxies and reconnect behavior require testing
- browser backpressure is application-managed
- large files still need HTTP/blob endpoints

## Alternatives considered

### REST plus SSE

Viable, but rejected for v0.1 because the browser is a rich bidirectional control surface and Wi controls both sides.

### One WebSocket per session

Rejected because it multiplies connections and complicates browser lifecycle. Sessions are multiplexed on one connection.

### WebSocket for all data including large binaries

Rejected. Large artifacts use HTTP endpoints and durable references.

## Validation

- WebSocket integration tests cover multiplexing and reconnect
- property tests prove replay/live equivalence
- Playwright tests cover multiple tabs and browser closure during active runs
- slow-consumer tests prove actors and other subscribers remain responsive
