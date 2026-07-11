# Wi v0.1 run state machine

Status: canonical for the first vertical slice

## 1. Purpose

A run is backend-owned work initiated by a durable user command. It may include several provider steps, tool calls, approvals, and provider continuations before reaching one terminal state.

The state machine must remain correct when:

- browsers disconnect and reconnect
- commands are retried
- provider streams fail partially
- tools are cancelled or duplicated
- the backend process restarts
- two sessions run concurrently
- late asynchronous events arrive after cancellation

## 2. Domain entities

### Session

A durable conversation/task container with one dedicated database. One session may have many runs but at most one active run in v0.1.

### Run

Work created from a user message or explicit continuation. The run owns its provider/tool loop and terminal outcome.

### Provider step

One request/stream interaction with the provider. A run can contain multiple steps because a tool result may be returned to the provider for continuation.

### Tool call

A provider-requested action linked by a stable `callId`. Tool execution is governed by the durable ledger.

### Approval

A durable user decision required before a tool may execute.

### Pending input

A durable question or request that requires explicit user input before the run can continue.

## 3. Run states

Canonical run states:

```text
created
queued
running
waiting_for_user
cancelling
completed
failed
cancelled
interrupted
```

Terminal states:

```text
completed
failed
cancelled
interrupted
```

A terminal run never returns to a nonterminal state.

## 4. Principal transitions

```text
created
  -> queued
  -> running

running
  -> waiting_for_user
  -> cancelling
  -> completed
  -> failed
  -> interrupted

waiting_for_user
  -> running
  -> cancelling
  -> failed
  -> interrupted

cancelling
  -> cancelled
  -> interrupted
```

`cancelled` is used when cancellation is durably requested and active operations acknowledge/complete cancellation according to policy.

`interrupted` is used when continuation cannot safely be proven, such as server death during a provider stream or an ambiguous external operation.

## 5. SessionActor ownership

One active session has one `SessionActor`.

The actor owns:

- serialized command handling for that session
- current run identity and state
- queued follow-up messages
- pending approval or input state
- the active run's `AbortController`
- calls to storage and scheduler interfaces
- post-commit event publication requests

The actor does not own:

- browser sockets
- SQLite connections
- worker threads
- provider credentials
- plugin processes

## 6. Mailbox responsiveness

The actor mailbox must not await an entire run as one blocking message.

Bad pattern:

```ts
await executeWholeRun();
```

Correct pattern:

```text
start asynchronous run task
  -> return control to mailbox
  -> receive cancellation/approval/subscription-related messages
  -> asynchronous task posts result events back to actor
```

Every callback from provider, tool, timer, or storage includes the expected `runId`. Late callbacks for an older or terminal run are rejected or ignored safely.

## 7. Run creation

`message.submit` follows:

```text
1. Validate command and session state.
2. Check durable command idempotency.
3. Append user.message.appended and run.created.
4. Insert/update message and run projections.
5. Commit.
6. Acknowledge command.
7. Schedule run if session has no active run.
8. Append run.started when execution begins.
```

A duplicate identical command returns the original run ID and does not create another run.

## 8. Provider-step states

Provider step states:

```text
created
streaming
completed
failed
cancelled
interrupted
```

A provider step reaches exactly one terminal state.

Events may include:

```text
provider.step.started
provider.text.delta
provider.tool_call.staged
provider.step.completed
provider.step.failed
provider.step.interrupted
```

## 9. Provisional output

Text received during `streaming` is provisional.

Wi may coalesce and commit provisional text deltas so the browser can render live progress. The associated assistant message/part remains marked streaming.

On valid provider completion:

```text
provider step -> completed
assistant item -> completed or ready for tool continuation
```

On failure after visible output:

```text
provider step -> failed/interrupted
assistant item -> interrupted
partial text remains visible
```

Wi does not delete or pretend the partial output never occurred.

## 10. Tool-call staging and promotion

A provider may stream partial function arguments. These are never executable.

When the provider emits a syntactically complete tool-call item, Wi may store it as:

```text
staged
```

It still cannot execute.

Only after the provider step reaches an accepted successful terminal event does one transaction:

```text
mark provider step completed
validate staged call identity and final arguments
promote call to requested
append tool.call.requested
commit
```

Only after this commit may policy, approval, and execution proceed.

If the provider step fails, is cancelled, is incomplete, or ends without a terminal event:

```text
staged calls -> discarded/non-executable
execution count -> zero
```

## 11. Tool execution states

Canonical tool states:

```text
staged
requested
awaiting_approval
approved
started
completed
failed
denied
cancelled
outcome_unknown
discarded
```

Important transitions:

```text
staged -> requested      only after provider completion
requested -> started     when no approval is required
requested -> awaiting_approval
awaiting_approval -> approved -> started
awaiting_approval -> denied
started -> completed | failed | cancelled | outcome_unknown
```

Terminal tool states do not regress.

## 12. Approval behavior

When approval is required:

```text
1. Persist tool state awaiting_approval.
2. Append tool.approval.requested.
3. Mark run waiting_for_user.
4. Commit.
5. Publish to any connected browsers.
```

No browser subscriber is required. The approval remains durable.

Two tabs may attempt resolution. The first valid database transition from `pending` wins. Later attempts receive `approval_already_resolved` and do not alter execution.

Approval records bind to:

- approval ID
- session ID
- run ID
- call ID
- tool name
- canonical arguments hash
- presented command/path summary

A changed call cannot reuse an old approval.

## 13. Provider continuation after tool result

After tool completion:

```text
1. Commit tool.execution.completed and result projection.
2. Construct provider continuation input from canonical run state.
3. Start a new provider step.
4. Continue until no tool calls remain or a terminal failure occurs.
```

The provider never receives a tool result that has not committed.

## 14. Cancellation

`run.cancel` is a durable idempotent command.

```text
1. Commit run.cancel.requested / cancelling state.
2. Signal active provider/tool operations through AbortController.
3. Reject new tool promotions and executions for that run.
4. Wait for bounded cancellation cleanup.
5. Commit run.cancelled, or interrupted when safe completion cannot be proven.
```

Late provider completion after cancellation cannot transition the run to completed.

Browser disconnect does not invoke this path.

## 15. Automatic retry policy

A provider request may retry automatically only when all conditions hold:

- failure is classified transient
- no semantic output has been committed
- no completed tool call has been accepted
- no tool has started
- request is not cancelled
- retry budget remains

After visible semantic output, Wi does not restart the request from scratch. Verified provider continuation may be used later when a direct provider adapter supports it and exact compatibility is established.

The fake provider must model both pre-output transient failure and post-output failure.

## 16. Exactly-one terminal transition

All asynchronous completion paths use a durable/state-checked compare-and-transition operation.

Examples:

```text
running -> completed
running -> failed
cancelling -> cancelled
```

If the current state is already terminal or belongs to another run, the transition is rejected.

This prevents:

- cancel then complete
- timeout then success
- old provider callback reviving a run
- duplicate tool completion changing a terminal result

## 17. Session queue behavior

Only one active run is allowed per session.

A later `message.submit` while a run is active is represented as a durable queued message/follow-up according to the first-slice policy. The actor starts it only after the active run terminates or reaches a supported steering boundary.

The first vertical slice may use simple FIFO follow-up behavior and must document any unsupported steering semantics.

## 18. Server restart recovery

On startup/open:

```text
run waiting_for_user + pending approval/input
  -> restore waiting_for_user

provider step streaming
  -> mark interrupted

run running with interrupted provider step
  -> mark interrupted unless deterministic fake-provider recovery is explicitly supported

tool started without committed result
  -> reconcile through tool-effect policy

run completed/failed/cancelled
  -> preserve terminal state
```

The first slice must prove durable approval recovery and conservative provider interruption.

## 19. Scheduler interaction

The actor obtains bounded permits for:

- provider operations
- tool operations

Permits are released in `finally`-equivalent paths after success, error, cancellation, worker death, and timeout.

Property tests prove configured concurrency limits are never exceeded and permits are not leaked.

## 20. Required state-machine properties

Property/model tests must prove:

- at most one active run per session
- exactly one terminal run state
- terminal states never regress
- browser subscriber changes never change run state
- cancellation prevents later completion
- tool execution never precedes provider completion
- approval resolves at most once
- duplicate tool calls do not duplicate effects
- late provider/tool callbacks cannot resurrect old work
- a session failure does not mutate another session
