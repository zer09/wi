# Wi v0.1 browser protocol

Status: canonical for the first vertical slice

## 1. Design objective

The browser is a temporary view into durable backend state. The protocol must support interactive commands and live output without making a browser connection the owner of a run.

Wi therefore uses:

```text
HTTP
  -> application assets
  -> bootstrap and health
  -> local browser authentication
  -> future large files/blobs/uploads

one multiplexed WebSocket per browser client
  -> commands
  -> acknowledgements
  -> subscriptions
  -> replay
  -> live events
  -> approvals and pending input
  -> cancellation
  -> heartbeats
```

Browser SSE is not used in v0.1.

## 2. Transport independence

The canonical Wi command and event schemas live in `packages/protocol`. They are not framework-specific and must not contain Fastify, `ws`, React, or browser transport types.

The WebSocket gateway is only a carrier for versioned JSON envelopes.

## 3. Connection lifecycle

```text
HTTP bootstrap/auth
  -> WebSocket upgrade
  -> hello
  -> welcome
  -> subscribe or resume sessions
  -> replay committed events
  -> replay.complete
  -> live events
  -> reconnect when transport fails
```

A WebSocket close removes subscriptions for that connection. It does not issue `run.cancel` and does not modify run state.

## 4. General envelope

Every message is a JSON object with:

```ts
interface WireEnvelope {
  v: 1;
  kind: string;
}
```

Reject:

- non-object JSON
- unsupported protocol versions
- unknown top-level kinds
- unknown command methods
- messages beyond configured byte or nesting limits
- invalid UTF-8 at the transport boundary
- invalid field types
- non-finite numbers

Runtime schemas define whether unknown optional fields are tolerated. State-changing commands should be strict by default.

## 5. Client messages

### Hello

```json
{
  "v": 1,
  "kind": "hello",
  "clientId": "client_01...",
  "resume": [
    { "sessionId": "ses_A", "afterSequence": 184 },
    { "sessionId": "ses_B", "afterSequence": 45 }
  ]
}
```

`clientId` identifies the browser installation or tab for diagnostics. It is not an authorization credential and does not provide command idempotency.

### Subscribe

```json
{
  "v": 1,
  "kind": "subscribe",
  "requestId": "req_01...",
  "sessionId": "ses_A",
  "afterSequence": 184
}
```

### Unsubscribe

```json
{
  "v": 1,
  "kind": "unsubscribe",
  "requestId": "req_02...",
  "sessionId": "ses_A"
}
```

### Command

```json
{
  "v": 1,
  "kind": "command",
  "commandId": "cmd_01...",
  "sessionId": "ses_A",
  "method": "message.submit",
  "params": {
    "text": "Inspect the failing tests."
  }
}
```

Initial methods:

```text
session.create
message.submit
run.cancel
approval.resolve
input.respond
```

`session.create` has no pre-existing `sessionId`; the server reserves one durably.

### Client heartbeat

An application-level heartbeat carries the client timestamp and is not a durable event.

```json
{
  "v": 1,
  "kind": "heartbeat",
  "clientTimeMs": 1783742612000
}
```

## 6. Server messages

### Welcome

Communicates connection ID, protocol version, heartbeat settings, and safe server metadata.

```json
{
  "v": 1,
  "kind": "welcome",
  "connectionId": "conn_01...",
  "serverTimeMs": 1783742612000,
  "heartbeatIntervalMs": 15000
}
```

### Command accepted

```json
{
  "v": 1,
  "kind": "command.accepted",
  "commandId": "cmd_01...",
  "sessionId": "ses_A",
  "acceptedSequence": 185,
  "runId": "run_01...",
  "result": {},
  "duplicate": false
}
```

It is sent only after durable acceptance commits.

For an identical retry, `duplicate` is `true` and the original result is returned.

### Command rejected

```json
{
  "v": 1,
  "kind": "command.rejected",
  "commandId": "cmd_01...",
  "code": "protocol.command_id_conflict",
  "message": "This command ID was already used with different content.",
  "diagnosticId": "err_01...",
  "recoverable": false
}
```

A rejection distinguishes:

- schema/protocol errors
- authorization errors
- command conflicts
- invalid state transitions
- missing sessions
- recoverable resource limits
- internal diagnostic failures

### Durable event

```json
{
  "v": 1,
  "kind": "event",
  "sessionId": "ses_A",
  "sequence": 186,
  "eventId": "evt_01...",
  "eventType": "provider.text.delta",
  "createdAtMs": 1783742612000,
  "data": {
    "eventVersion": 1,
    "runId": "run_01...",
    "stepId": "step_01...",
    "messageId": "msg_01...",
    "partId": "part_01...",
    "text": "I will inspect the tests."
  }
}
```

The sequence is assigned by the session database. The WebSocket transport never invents or renumbers durable events.

### Replay complete

```json
{
  "v": 1,
  "kind": "replay.complete",
  "requestId": "req_01...",
  "sessionId": "ses_A",
  "throughSequence": 193
}
```

This marks the boundary between historical replay and live delivery for that subscription.

### Protocol error

Used for connection-level invalid input. Repeated or severe violations may close the socket.

### Heartbeat

Non-durable connection health message.

## 7. Command idempotency

Every state-changing command uses a caller-generated stable `commandId`.

The backend canonicalizes:

```text
method + params + relevant session identity
```

and stores a payload hash.

Rules:

```text
same commandId + same canonical content
  -> return original durable result

same commandId + different canonical content
  -> reject as conflict
```

This handles the ambiguity where the server commits a command but the acknowledgement is lost before the browser receives it.

`requestId` is only for non-state-changing request correlation and may be retried freely.

## 8. Multiplexing

One socket can subscribe to many sessions, and one session can have many subscribers.

Every event contains a session ID and sequence, so interleaved delivery is unambiguous:

```text
ses_A sequence 185
ses_B sequence 46
ses_A sequence 186
ses_C sequence 12
```

Ordering is guaranteed only within one session, not globally across all sessions.

## 9. Replay barrier

A replay/live race can otherwise lose an event that commits between the historical query and live subscription registration.

Use this algorithm inside the session event coordinator:

```text
1. Register subscriber in replaying state.
2. Capture committed session head H.
3. Query events (afterSequence, H].
4. Queue newly committed events whose sequence is > H.
5. Send historical events in order.
6. Send replay.complete through H.
7. Drain queued live events in order.
8. Mark subscriber live.
```

A subscriber may receive a duplicate around reconnect boundaries, but it must never miss a committed event. The client reducer is duplicate-safe.

## 10. Browser reducer rules

For each session, the browser stores `lastAppliedSequence`.

```text
incoming sequence == last + 1
  -> apply

incoming sequence <= last
  -> ignore only when already-known event identity/content matches

incoming sequence > last + 1
  -> mark gap and resubscribe after last
```

The same pure reducer processes replayed and live events.

The reducer does not decide backend actions. It renders the durable backend state represented by events.

## 11. Backpressure

Each WebSocket connection has bounded:

- queued message count
- queued byte count
- maximum single message size
- maximum replay batch size

Policy:

1. Coalesce or batch nonterminal text deltas where semantically safe.
2. Never drop approvals, tool state, run state, errors, or terminal events.
3. Store large output as a future blob/artifact and send a bounded preview/reference.
4. Disconnect a persistently slow consumer.
5. Let it recover using durable replay.

A slow browser must not block the SessionActor, database worker, provider stream, or other subscribers.

## 12. Heartbeats and liveness

The server library may use protocol-level Ping/Pong to detect dead connections. The application may also send a Wi heartbeat.

Heartbeat failure closes only the browser connection. It does not cancel active runs.

## 13. Local security

The v0.1 server binds to loopback by default.

The WebSocket upgrade must:

- validate `Host`
- validate `Origin`
- require a valid local browser session credential
- reject unsupported subprotocol/version values
- enforce frame and message limits

HTTP should establish an `HttpOnly`, same-site browser session cookie. Provider credentials never enter browser storage or WebSocket payloads.

All rendered model, project, and tool content is untrusted text. The GUI must not inject it as unsanitized HTML.

## 14. Error and diagnostic policy

Browser errors contain:

- stable safe category/code
- human-readable safe message
- `diagnosticId`
- recoverability when useful

Server logs contain detailed but redacted diagnostics. Never log:

- cookies
- authorization headers
- API keys
- OAuth access or refresh tokens
- authorization codes
- complete sensitive callback URLs
- unbounded malformed payloads

## 15. Reconnect policy

The browser reconnects with bounded exponential backoff and jitter.

After reconnect:

1. send `hello` with per-session cursors
2. re-establish subscriptions
3. replay missing committed events
4. reconcile command acknowledgements by retrying unresolved command IDs

A pending command is not treated as failed merely because its acknowledgement was lost.

## 16. Schema policy and v1 payload examples

All v1 wire-message objects and all versioned durable-event payload objects are strict: unknown fields are rejected. Optional fields are accepted only where the schema explicitly declares them. JSON-valued command, result, tool-result, and input fields accept only null, booleans, finite numbers, strings, arrays, and string-keyed objects composed from the same values.

Initial command parameters are:

```json
{
  "session.create": { "title": "Optional title", "projectId": "project_01..." },
  "message.submit": { "text": "Inspect the failing tests." },
  "run.cancel": { "runId": "run_01..." },
  "approval.resolve": { "approvalId": "approval_01...", "resolution": "approved" },
  "input.respond": { "inputId": "input_01...", "value": { "answer": "yes" } }
}
```

`session.create` omits `sessionId`; all other initial commands require it. A command's durable identity hashes its method, parameters, and session identity when present. `commandId`, transport metadata, and object key insertion order do not affect that hash.

Every durable event payload contains `eventVersion: 1`. Representative state-bearing payloads are:

```json
{
  "run.completed": {
    "eventVersion": 1,
    "runId": "run_01..."
  },
  "tool.approval.requested": {
    "eventVersion": 1,
    "runId": "run_01...",
    "callId": "call_01...",
    "approvalId": "approval_01...",
    "toolName": "guarded_echo",
    "actionDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "summary": "Echo the supplied text"
  },
  "input.requested": {
    "eventVersion": 1,
    "runId": "run_01...",
    "inputId": "input_01...",
    "prompt": "Continue?"
  }
}
```

The canonical error codes are exported by `packages/protocol` and match the taxonomy in the implementation plan. Browser-facing rejection and protocol-error messages always carry a safe message and diagnostic ID.

## 17. Protocol tests

Required tests include:

- valid message decoding
- unsupported version rejection
- unknown method rejection
- malformed and oversized message handling
- exact command retry after lost acknowledgement
- command-ID conflict
- one socket multiplexing two sessions
- two sockets subscribing to one session
- disconnect during an active run
- replay/live race with no loss
- duplicate event tolerance
- sequence-gap detection and resubscription
- slow-consumer isolation
- origin and host rejection
- XSS-shaped output rendered as text
- protocol fuzzing with bounded errors and no process crash
