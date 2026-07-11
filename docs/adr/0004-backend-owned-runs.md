# ADR-0004: Runs are owned by the backend, not browser connections

Status: Accepted  
Date: 2026-07-11

## Context

Wi is a backend service with a browser GUI. A model/tool run may outlive a tab, browser process, network connection, or UI login session. Coupling run lifetime to a WebSocket would lose work and make reconnect behavior unreliable.

## Decision

A run belongs to the backend `SessionActor` and durable session state.

The following do not cancel a run:

- tab close
- page refresh
- WebSocket loss
- browser process exit
- Wi UI sign-out
- browser device sleep

The user may reconnect, authenticate, subscribe, and replay the current state.

Only explicit durable actions or backend failure policy cancel/interrupt a run:

- `run.cancel`
- server shutdown policy
- unrecoverable provider/tool/session failure

## Waiting for the user

When a run requires approval or explicit input:

- persist the request
- transition the run to `waiting_for_user`
- expose attention metadata in the catalog
- continue only after a durable response or cancellation

No connected browser is required for the pending state to exist.

## UI sign-out versus provider disconnect

Signing out of the Wi browser UI ends only the browser session. It does not revoke provider credentials or stop runs.

Disconnecting an OpenAI provider connection is a separate future operation. Active runs retain the connection and credential generation they started with or fail explicitly; they never silently switch identity.

## Consequences

Positive:

- browser becomes a replaceable view
- work survives ordinary UI/network interruptions
- multi-tab behavior is consistent
- pending approvals/questions are durable

Negative:

- backend must manage orphaned subscribers and reconnection
- active work can continue when no GUI is visible
- server shutdown/restart semantics must be explicit
- user attention needs catalog/UI indicators

## Alternatives considered

### Cancel on socket close

Rejected because it makes transient browser/network failure destructive.

### Browser owns the run state and resubmits after reconnect

Rejected because it cannot safely reconstruct provider/tool effects and violates backend authority.

## Validation

- close all tabs during a fake-provider run and verify completion
- sign out and back in, then replay results
- restart while waiting for approval and verify the pending state remains
- property tests prove subscriber count does not affect run state
