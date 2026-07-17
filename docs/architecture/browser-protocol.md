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
  -> WebSocket upgrade with exactly `wi.v1`
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

`clientId` identifies the browser installation or tab for diagnostics. It is not an authorization credential and does not provide command idempotency. Resume cursors do not carry client request IDs, so every subscription-related `protocol.error` includes the affected `sessionId`; mixed resume successes and failures remain actionable even when their asynchronous outcomes arrive in a different order.

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

For an identical retry, `duplicate` is `true` and the original result is returned. For `input.respond` and `approval.resolve`, durable acceptance resolves the selected interaction but does not wake its backend waiter while another interaction for that run remains pending. The final interaction transaction also returns the run from `waiting_for_user` to `running`; only after that commit are all deferred resolved waiters released with their canonical values. All subscribers observe the individual resolution events, plus exactly one `run.started` when the run resumes.

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

A terminally failed global command, including `session.create`, returns its original durable safe code, message, and diagnostic ID on every identical retry. Gateway logs for those retries reuse that same ID rather than creating unrelated correlation records.

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
3. Query `(afterSequence, H]` as worker-enforced pages bounded by event count, complete serialized worker-response bytes, and single-event bytes. Page capacity includes an explicit reserve for the page and RPC envelopes, and live single-event capacity never exceeds historical capacity.
4. Queue newly committed events whose sequence is > H under count and byte bounds.
5. Validate and send each historical page in order, releasing it before requesting the next page.
6. Send replay.complete through H only after every historical page has been accepted by the transport queue.
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

A sequence gap or incomplete replay is recoverable by replaying from the last trusted cursor. Conflicting content at an applied sequence, event-ID reuse, session mismatch, an impossible run transition, or a second active run is a fatal integrity error. Replay cannot clear a fatal error; only rebuilding the session state from a trusted fresh snapshot can do so.

The reducer does not decide backend actions. It renders the durable backend state represented by events.

## 11. Backpressure

Each WebSocket connection has bounded:

- queued message count
- queued byte count
- maximum single message size
- replay page event count, serialized bytes, and single-event bytes
- replay/live backlog event count, total bytes, and single-event bytes

Policy:

1. Coalesce or batch nonterminal text deltas where semantically safe.
2. Never drop approvals, tool state, run state, errors, or terminal events.
3. Store large output as a future blob/artifact and send a bounded preview/reference.
4. Disconnect a persistently slow consumer.
5. Let it recover using durable replay.

Both the transport queue and one connection-wide replay budget enforce this policy. The replay live-event count and byte allowance is shared across every multiplexed session subscription; it is never multiplied by the subscription count, and reservations remain charged until delivery or discard. Duplicate verification retains only fixed-size event-ID/SHA-256-digest identities in one connection-wide LRU constrained by the same configured count and byte ceilings; subscriptions do not retain full delivered events or canonical payload strings. A connection also permits only one materialized historical page at a time, held through validation and delivery. Public overrides are constrained by server-owned hard maxima and are rejected rather than clamped: frames are at most 1 MiB and depth 64; outbound and pending-inbound queues are at most 4,096/1,024 messages and 16 MiB; one connection has at most 256 subscriptions and 16 protocol violations; replay live/page counts are at most 4,096/256 and replay/page bytes remain within the 16 MiB live and 1,000,000-byte storage contracts. Historical replay waits asynchronously for per-connection transport capacity up to a bounded deadline; a healthy draining connection is paced rather than disconnected merely because its history exceeds queue capacity. A subscriber that does not drain by the deadline, or whose aggregate live backlog exceeds count or byte bounds, closes the connection with the slow-consumer code, removes all of its actor subscriptions, and requires replay from the last trusted cursors. It must never leave an open socket attached to a deactivated replay subscriber.

A slow browser must not block the SessionActor, database worker, provider stream, or other subscribers.

## 12. Heartbeats and liveness

The server library may use protocol-level Ping/Pong to detect dead connections. The application may also send a Wi heartbeat.

Heartbeat failure closes only the browser connection. It does not cancel active runs. Public heartbeat intervals are capped at 60 seconds, hello deadlines at 30 seconds, and replay-capacity, WebSocket-shutdown, and HTTP-shutdown waits at 30 seconds.

Server shutdown stops the HTTP listener immediately. Non-upgraded HTTP sockets have a separate bounded drain deadline; incomplete headers, stalled requests, and keep-alive connections are force-closed when it expires. From the HTTP `upgrade` event onward, the gateway owns every raw socket, including sockets whose authentication or handshake is rejected. Rejection responses get a fixed two-second drain window before forced destruction, and gateway shutdown immediately destroys any remaining pending or rejected upgrade sockets alongside accepted WebSockets. WebSocket connection cleanup is observed as a settled outcome: timeout or rejection forces transport termination, and the WebSocket server close path remains bounded and unconditional. Custom logging failures cannot prevent connection cleanup. Failed-start cleanup uses the same bounded HTTP close path.

## 13. Local security

The v0.1 server binds only to exact IPv4 loopback `127.0.0.1`. The exported server constructor runtime-validates this invariant and rejects every other value before constructing or opening a listener; its TypeScript literal type is not treated as a security boundary. Caller-configurable gateway limits and test hooks are spread before server-owned runtime, authentication, request-policy, and logger dependencies. Supplying any of those reserved dependencies as own properties is rejected at runtime rather than trusting TypeScript `Omit` types.

The WebSocket upgrade must:

- validate literal `Host` syntax before URL normalization, rejecting numeric loopback aliases
- validate exactly one raw `Origin` field
- validate the raw `Connection`, `Upgrade`, `Sec-WebSocket-Key`, and `Sec-WebSocket-Version` fields before invoking `ws`
- require a valid local browser session credential
- require exactly the bootstrap-advertised `wi.v1` subprotocol
- reject missing, duplicate, unsupported, malformed, or empty-token subprotocol/version values
- enforce frame and message limits

Every rejected upgrade—including wrong endpoint, malformed handshake, and gateway-unavailable paths—returns a bounded JSON body and `X-Wi-Diagnostic-Id` header containing the same opaque diagnostic ID as its redacted server record. HTTP parser failures return the same correlated header and bounded JSON body as their `http_client_error` record. Every emitted in-band `protocol.error` is logged centrally with the exact returned diagnostic ID, code, request ID when present, and recoverability. Every direct HTTP error response follows the same correlation rule, including invalid Host, method, target, route, authentication, and unavailable-foundation responses. HTTP rejection logs contain only fixed classifications and bounded identifiers; they never include the Cookie header or raw request target/query. Authentication text remains generic and never reveals credential details.

HTTP should establish an `HttpOnly`, same-site browser session cookie. Provider credentials never enter browser storage or WebSocket payloads.

All rendered model, project, and tool content is untrusted text. The GUI must not inject it as unsanitized HTML.

## 14. Error and diagnostic policy

Browser errors contain:

- stable safe category/code
- human-readable safe message
- `diagnosticId`
- recoverability when useful

Only concrete server-owned command rejection types may supply a durable safe message or diagnostic ID. Structurally similar properties on arbitrary exceptions are untrusted: the gateway uses fixed code-derived text and generates a new server-owned diagnostic ID.

New durable and connection-level diagnostic messages are stable server-authored text bounded to 512 characters. Raw provider, tool, cancellation-cleanup, or generic run-task exception text—and arbitrary messages returned by a run task—are never copied into new events, projections, or browser payloads. The actor maps terminal run messages from the stable error code and sends raw detail only to the redacting diagnostic sink. The provider-step event and its immediately resulting run terminal event reuse the diagnostic ID created at the failure boundary, including during restart recovery. Tool failure events likewise reuse the ID from their redacted server diagnostic, including for a resulting unknown-outcome run interruption and restart recovery.

Server logs contain detailed but redacted diagnostics. Every injected logger is normalized through an idempotent non-throwing adapter at the runtime and transport composition boundaries. The production stdout sink keeps at most the stream's current bounded write: after `write()` reports backpressure it drops records until `drain`, and after a stream error such as `EPIPE` it permanently disables itself without emitting an unhandled error. A logger failure can lose a diagnostic record, but it cannot prevent an HTTP/WebSocket rejection, protocol response, socket close, cleanup, or other mandatory control-plane action. Before URL parsing, regular-expression scrubbing, UTF-8 encoding, or hashing, untrusted strings are reduced to a fixed-size prefix. Exception messages and malformed payloads are represented by source unit/length, sampled byte length, sampled SHA-256 digest, and a truncation flag rather than raw text or a synchronous full-input digest. Never log:

- cookies
- authorization headers
- API keys
- OAuth access or refresh tokens
- authorization codes
- complete sensitive callback URLs
- cookie assignments or sensitive query assignments embedded in arbitrary text fields
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

Most durable event payloads contain `eventVersion: 1`. Safe failure payloads use `eventVersion: 2`, whose message is server-authored and bounded to 512 characters. Storage continues to decode retained failure payload v1 messages up to the former 8 KiB UTF-8 provider boundary so prior session databases remain readable. Canonical legacy rows are never rewritten. Before browser delivery, the gateway deterministically projects a legacy v1 failure to v2 with a fixed safe message while preserving its event identity, sequence, code, and diagnostic ID. Raw legacy failure text is never sent over the WebSocket.

Representative state-bearing payloads are:

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

The canonical error codes are exported by `packages/protocol` and match the taxonomy in the implementation plan. Browser-facing rejection and protocol-error messages always carry a safe message and diagnostic ID. Subscription-related protocol errors additionally carry `sessionId`. A faulted actor, a catalog row already marked `unavailable`, or a permanent storage failure discovered by a replay head/page query is exposed as non-recoverable `storage.corrupt`; a missing session is exposed as non-recoverable `replay.unknown_session`. Replay wrappers preserve the classification of their immediate concrete `StorageError` cause rather than converting it to recoverable `replay.query_failed`.

A provider-step terminal projection stores the same diagnostic ID as its canonical failure event. If the process restarts after the step terminal commit but before the run terminal commit, run adoption reuses that stored ID instead of minting a second causal identity.

Subscription failures use typed `protocol.error` codes so a client can choose the correct recovery:

```text
replay.cursor_ahead
replay.unknown_session
replay.disconnected
replay.query_failed
replay.sequence_gap
replay.sequence_conflict
replay.subscriber_overflow
subscription.already_exists
subscription.not_found
```

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
