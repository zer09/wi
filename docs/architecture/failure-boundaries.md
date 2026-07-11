# Wi v0.1 failure boundaries

Status: canonical for the first vertical slice

## 1. Principle

Wi does not hide failures through undocumented fallbacks. It fails the smallest reasonable fault domain, persists a safe state when possible, informs the browser with a bounded error, and writes a detailed redacted diagnostic.

```text
fault occurs
  -> classify fault domain
  -> commit durable failure/interruption state when possible
  -> stop or replace only the affected component
  -> notify subscribers with diagnosticId
  -> preserve unrelated sessions and server availability
```

## 2. Fault-domain hierarchy

From smallest to largest:

```text
browser request/message
browser connection
provider step
tool execution
run
session actor/session store
worker process/thread
project service/plugin
catalog/storage subsystem
Wi server process
```

A failure escalates only when the smaller domain can no longer be trusted or isolated.

## 3. Browser-message failure

Examples:

- malformed JSON
- unsupported protocol version
- unknown command
- command-ID conflict
- unauthorized command

Action:

- reject the message with a typed safe error
- do not mutate session state
- keep the connection open for ordinary recoverable mistakes
- close the connection for repeated abuse, severe size violations, or authentication/origin failure

No run is cancelled.

## 4. Browser-connection failure

Examples:

- network loss
- tab closed
- heartbeat timeout
- slow-consumer queue overflow

Action:

- remove that connection's subscriptions
- discard only non-durable connection buffers
- continue backend runs
- allow reconnect and replay from committed sequence cursors

## 5. Provider-step failure

Examples:

- transient connection failure before output
- invalid provider event
- stream closes without terminal event
- post-output transport failure
- provider returns an explicit failed response

Action:

- classify the error
- retry only under the partial-stream policy
- preserve committed partial text and mark it interrupted when required
- discard/non-execute staged tool calls when terminal completion was not accepted
- fail or interrupt the affected provider step and run
- emit a safe `run.failed` or `run.interrupted` event

Do not invoke `codex app-server` or silently change provider/endpoint/transport.

## 6. Provider-adapter invariant failure

Examples:

- impossible event ordering
- duplicate response identity with conflicting content
- parser state corruption
- internal adapter assertion failure

Action:

- terminate or reset the affected adapter worker/resource
- fail the active run using a provider-protocol diagnostic
- start a clean adapter resource for later runs when safe
- keep unrelated sessions and the web server alive

A provider adapter may live in-process for lightweight asynchronous I/O, but an invariant failure must still be isolated at run/resource scope rather than crashing all sessions unless shared memory corruption is suspected.

## 7. Tool-execution failure

Examples:

- schema validation failure
- approval denied
- timeout
- cancellation
- tool throws
- worker dies

Action depends on the tool state and effect class:

- before `started`: return a normal denied/failed result when appropriate
- pure/read-only started with no result: eligible for controlled retry
- transactional local effect: reconcile intended and observed state
- non-idempotent effect with unknown outcome: mark `outcome_unknown`; never retry automatically

Commit the ledger outcome before provider continuation.

## 8. Run failure

A run fails when its provider/tool loop cannot safely continue.

Action:

- transition exactly once to `failed`, `cancelled`, or `interrupted`
- persist partial assistant content and diagnostics
- release scheduler permits
- terminate or detach active resources according to policy
- keep the session available for a later user message/resume decision

A run failure does not terminate its session database or the server.

## 9. Session failure

Examples:

- dedicated database corruption
- conflicting event at an existing sequence
- irreconcilable migration failure
- actor invariant corruption limited to one session

Action:

- stop accepting mutations for that session
- quarantine or mark the session unavailable
- close its actor and database handle
- preserve the file for diagnostics/recovery
- update catalog status when possible
- keep other sessions running

## 10. Database-worker failure

Examples:

- worker thread exits
- unhandled worker exception
- worker RPC response is invalid

Action:

- reject all in-flight requests assigned to that worker with typed errors
- log affected request/session IDs
- spawn a clean replacement
- lazily reopen session databases
- reconcile sessions whose operation outcome is uncertain

The server terminates only when repeated worker failures make persistence unreliable across the system or the catalog cannot be opened safely.

## 11. Catalog failure

Examples:

- catalog migration failure
- catalog corruption
- catalog path unavailable

Because catalog discovery is foundational, normal startup may stop.

Action:

- emit a clear fatal diagnostic
- avoid mutating session databases during uncertain discovery
- provide a maintenance/rebuild path from session manifests
- terminate the Wi server when safe operation cannot be guaranteed

A catalog summary-write failure after a committed session event is not fatal. It is a stale-index condition repaired by reconciliation.

## 12. Plugin/project-service failure

Plugins are not part of the first slice, but the boundary is fixed.

Action:

- fail the affected tool execution
- terminate and replace the plugin worker/process when safe
- preserve the session and server
- pin diagnostic data to plugin ID/version and tool call
- do not expose a different plugin behavior as a silent fallback

## 13. Wi server fatal conditions

The entire process should terminate only for conditions such as:

- catalog cannot be opened or migrated and no safe read-only/rebuild mode is implemented
- global configuration is invalid before serving
- core event-store invariants are violated across unknown scope
- credential/storage initialization fails in a way that would risk exposure or corruption
- unrecoverable main-thread exception where continued state cannot be trusted

Before graceful termination, Wi attempts to:

- stop accepting new commands
- notify connected browsers
- cancel/drain active operations according to policy
- terminate tool process groups
- flush database worker queues
- close handles
- write final redacted diagnostics

A sudden crash may bypass these steps; recovery tests cover durable consequences.

## 14. Error categories

Use stable categories rather than relying only on free-form messages.

Initial categories include:

```text
protocol_error
authentication_error
authorization_error
command_conflict
invalid_state
resource_limit
provider_transient_error
provider_protocol_error
provider_terminal_error
provider_stream_interrupted
tool_validation_error
tool_denied
tool_timeout
tool_execution_error
tool_outcome_unknown
storage_error
storage_corruption
worker_crash
migration_error
internal_invariant_error
```

## 15. Browser error shape

A safe durable or connection-level error contains:

```json
{
  "category": "provider_protocol_error",
  "message": "The provider stream ended with an invalid event sequence.",
  "diagnosticId": "err_01...",
  "recoverable": false
}
```

Do not include secrets, stack traces, raw authorization material, or unbounded provider payloads.

## 16. Structured logging

Every log record should include available identifiers:

```text
diagnosticId
requestId
commandId
clientId
sessionId
runId
stepId
callId
workerId
pluginId
```

Mandatory redaction:

- API keys
- OAuth access/refresh tokens
- authorization headers
- cookies
- authorization codes
- sensitive callback query values
- credential-vault references when they reveal paths or handles
- arbitrary provider/tool payloads beyond bounded reviewed previews

## 17. No hidden fallback

Wi must not respond to a direct adapter failure by:

- launching `codex app-server`
- switching ChatGPT-plan usage to Platform API billing
- switching accounts
- changing model
- changing provider endpoint
- changing transport after semantic output has begun

A documented, same-adapter pre-output transport retry may occur under the retry policy. Every other change requires an explicit user action and durable audit event in later milestones.

## 18. Failpoints

Test-only failpoints are placed at critical crash windows:

```text
after command reservation before commit
after command commit before acknowledgement
after event commit before publication
after provider text commit
after provider terminal commit before tool promotion publication
after tool request commit
after tool started commit
after tool result commit before provider continuation
after run terminal commit
after session database initialization before catalog ready
```

A process test starts Wi, triggers the failpoint, kills/exits the child process, restarts using the same `WI_HOME`, and verifies the exact durable outcome.

## 19. Recovery expectations

```text
uncommitted mutation
  -> absent after restart

committed event not published
  -> replayed after reconnect

stale catalog summary
  -> repaired from session database

streaming provider step
  -> interrupted

pending approval/input
  -> restored pending

completed tool result
  -> reused, not executed again

started ambiguous non-idempotent effect
  -> outcome_unknown

completed run
  -> remains completed
```

## 20. Testing fault isolation

Automated tests must prove:

- session A provider failure does not stop session B
- one malformed browser message does not crash the gateway
- slow browser A does not delay browser B or the run
- database-worker death does not terminate the server
- corrupt session A is quarantined without blocking session B
- provider protocol failure never invokes a fallback
- diagnostic logs are redacted and bounded
- fatal catalog failure prevents unsafe startup
