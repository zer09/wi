# ADR-0008: Record every tool effect in a durable ledger

Status: Accepted  
Date: 2026-07-11

## Context

Strict exactly-once execution cannot be guaranteed for arbitrary shell commands or external systems. Wi may crash after an effect succeeds but before its result commits.

The harness still needs deterministic duplicate handling and conservative recovery.

## Decision

Every tool call is recorded in a durable ledger before execution.

Tool identity includes:

- session ID
- run ID
- provider `callId`
- tool name
- canonical arguments hash
- effect class

Canonical states:

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

## Duplicate rules

```text
same callId + same tool + same argument hash
  -> reuse the existing state/result

same callId + different tool or argument hash
  -> provider protocol error
```

A completed call never executes again.

## Effect classes

### Pure/read-only

May be retried after an ambiguous worker crash when policy permits.

First-slice examples:

- `echo`
- `guarded_echo`
- deterministic `delay` behavior under test control

### Locally transactional

Future file writes use pre-state hash, intended post-state hash, temporary file, and atomic replacement/reconciliation where possible.

### Externally idempotent

May retry only when the target system accepts and guarantees an idempotency key derived from the Wi call identity.

### Non-idempotent/unknown

If execution began and result cannot be proven, mark `outcome_unknown` and never retry automatically. Recovery derives that ambiguity from the persisted effect class even when automatic resumption is disabled or the current tool definition changed or disappeared.

## Approval integration

Approval is bound to the exact call identity and canonical arguments hash. Two tabs may race; only the first pending-to-resolved transition succeeds.

## Commit ordering

```text
commit requested/approved state
  -> execute
  -> commit result state
  -> publish result
  -> send result to provider
```

The provider never receives an uncommitted tool result.

## Consequences

Positive:

- duplicate provider calls cannot duplicate effects silently
- crash recovery is explicit
- effect risk is encoded in tool definitions
- tool results can be reused after lost acknowledgements/restarts

Negative:

- tool execution requires more database transitions
- ambiguous non-idempotent actions may require manual reconciliation
- tool authors must declare effect and retry semantics accurately

## Alternatives considered

### Assume at-most-once by process memory

Rejected because process restart loses memory and does not resolve external effects.

### Retry every started call

Rejected because it can duplicate destructive or external effects.

### Store only final results

Rejected because a crash after effect start would be invisible.

## Validation

- duplicate identical `callId` executes once
- conflicting duplicate `callId` fails
- process death after `started` produces the declared recovery state
- completed results are reused after restart
- provider continuation happens only after result commit
