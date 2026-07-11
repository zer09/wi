# ADR-0006: Do not use `codex app-server` as a fallback

Status: Accepted  
Date: 2026-07-11

## Context

`codex app-server` could provide an official embedded Codex runtime, but it would introduce a second harness that owns threads, turns, approvals, and history alongside Wi.

Using it only when the direct adapter fails would hide protocol bugs, create inconsistent behavior, and complicate storage/accounting.

## Decision

Wi will not invoke, embed, spawn, or automatically fall back to `codex app-server`.

When a direct provider adapter encounters an error:

- recover within that adapter only when the documented retry/continuation policy permits it
- otherwise fail or interrupt the affected provider step/run
- commit a safe durable error state when possible
- send a safe browser message with `diagnosticId`
- write detailed redacted logs
- keep unrelated sessions and the web server alive

## Failure boundary

```text
ordinary provider request failure
  -> fail provider step/run

provider adapter invariant failure
  -> reset/terminate affected adapter resource
  -> fail active run
  -> start clean resource for later work when safe

catalog/core global invariant failure
  -> terminate Wi server
```

The entire Wi process should not die merely because one provider response is malformed, unless continued global state cannot be trusted.

## Consequences

Positive:

- one authoritative agent loop
- failures remain visible and debuggable
- no hidden behavior or billing changes
- no dual session histories

Negative:

- direct adapter breakage can temporarily make that provider unavailable
- Wi must maintain its own compatibility tests and diagnostics
- there is no emergency alternate execution implementation

## Alternatives considered

### Automatic `codex app-server` fallback

Rejected because it changes the runtime semantics precisely when diagnosis is most important.

### User-selectable app-server provider

Not part of v0.1. A future explicit adapter would require a separate ADR and must never be an automatic fallback.

## Validation

- dependency and source scans reject `codex app-server` invocation
- provider protocol failure tests assert no fallback process starts
- browser receives a durable/safe failure event
- unrelated sessions continue
