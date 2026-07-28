# Milestone 8 PR #14 remediation — `WI-M8-H1`

Status: RESOLVED

Milestone 8 base: `908777ebfb161144ed4119e1222fc96a14cffb09`

Reviewed PR head before correction: `116d976bc88d24fccd605d5ca183961260885632`

Implementation commit: `2fa5cefc22c2ab3346ddd05e7a674af4591442f0`

Independent verification verdict: RESOLVED

This record covers the replay/live oracle defect identified by the independent remote review of PR #14. It follows the
prior Milestone 8 release-gate records, ending with
[`milestone-8-release-gate-remediation-3.md`](milestone-8-release-gate-remediation-3.md).

## Finding validated

The finding was correct. The old gateway and harness replay properties retained only each event's session-local
`sequence`. A delivery could therefore preserve sequence while changing `eventId`, `eventType`, `createdAtMs`, or the
complete versioned `data` payload without failing those properties.

The old client properties also lacked an independent browser-state oracle:

- duplicate delivery compared one production `replaySessionEvents` result with another;
- chunked replay compared `replaySessionEventChunks` with another production `replaySessionEvents` invocation.

Those comparisons established grouping consistency, but not equivalence with an independently modeled browser
projection.

A deterministic pre-fix probe changed one complete-event field at a time while retaining sequence. All four mutations
passed the former sequence-only comparison and differed from the expected complete event.

## Correction

### Complete committed-event oracle

`tests/property/support/replay-oracle.ts` now provides:

- independently generated complete `SessionEvent` objects;
- five event families with distinct payload shapes: session creation, user message, provider text, tool result, and
  pending input; and
- test-only mutations for event ID, event type, timestamp, and payload that preserve sequence.

The corrected gateway and harness properties retain and compare complete `SessionEvent[]` values. Deep equality covers
`v`, `kind`, `sessionId`, `sequence`, `eventId`, `eventType`, `createdAtMs`, and the complete versioned payload.
Reconnect suffixes and replay/live races use the same complete-field oracle.

### Independent browser projection

`buildReplayScenario` in `tests/property/client-reducer.test.ts` constructs expected browser state directly from generated
scenario input. It does not invoke `reduceSessionEvent`, `replaySessionEvents`, or `replaySessionEventChunks` on the
expected side.

The independent expected state covers every `BrowserSessionState` field:

- session identity, title, and message preview;
- trusted cursor and replay status;
- complete timeline;
- active and queued runs;
- pending approvals and inputs;
- sequence and event-ID identity maps;
- retained canonical event size; and
- integrity error state.

The production reducer is used only for the actual result.

### Retained mutation sensitivity

The gateway regression first proves the former sequence-only comparison remains blind to each mutation, then requires
the complete-event assertion to reject it. The client regression applies each same-sequence mutation after trusted
replay and requires the reducer to enter `event_conflict`.

The corrected suite retains generated coverage for duplicates, reconnect cursors, replay chunking, subscriber
disconnection, events published before head capture/during history/after replay, replay-complete boundaries, gaps,
identity conflicts, and multiple event families.

## Regression map

The correction is owned by these named tests:

- `preserves replay/live equivalence across generated race boundaries`;
- `reconstructs generated reconnect suffixes from the last trusted cursor`;
- `rejects same-sequence mutations that the former sequence-only oracle missed`;
- `merges replay and concurrently published live events into exact database order`;
- `composes replay publication with generated subscriber disconnects`;
- `duplicates produce the independently modeled browser state`;
- `replay and reconnect grouping produces the independently modeled browser state`; and
- `rejects same-sequence mutations to every complete event field`.

## Deliberately unchanged

The correction changes property tests and test documentation only. It does not change the production replay barrier,
protocol schemas, browser reducer, persistence, or runtime behavior. A second reducer implementation was not added.
The independent model is intentionally limited to the generated scenario vocabulary needed to assert browser
projections without duplicating the production reducer.

Separate mutations for `v`, `kind`, and `sessionId` were not added. Complete deep equality already covers the envelope,
and existing protocol/reducer tests own unsupported envelopes and session mismatch. The blocking review specifically
required retained mutation sensitivity for event ID, type, timestamp, and payload.

`WI-M8-M1`, `WI-M8-M2`, nightly workflow behavior, and Milestone 9 remain outside this correction.

## Recurrence checklist

1. Replay delivery properties must retain complete events, not only sequences or selected identifiers.
2. A replay/live oracle must compare every durable envelope and payload field with independently generated expected
   events.
3. Reducer grouping tests must also compare with an independently constructed projection; reducer-versus-reducer
   equality is insufficient.
4. Keep same-sequence mutations for event ID, type, timestamp, and payload as sensitivity tests.
5. When adding a browser projection field, update the independent expected state and require exact full-state equality.
6. Preserve cursor, duplicate, disconnect, replay-race, gap, and conflict generation when refactoring replay tests.
7. Keep production behavior unchanged unless a corrected oracle exposes an actual production defect.

## Validation evidence

Independent verification ran against the exact implementation commit and reported:

```text
focused seed 737373:       3 files, 24/24 passed
focused seed 811001:       3 files, 24/24 passed
seed 737373, path 0:       3 files, 24/24 passed
complete property project: 12 files, 47/47 passed
parent-to-commit diff check: passed
tracked working tree:       clean
classification:             RESOLVED
```

Implementation-gate evidence additionally recorded:

```text
pnpm check: 71 files, 902/902 passed; lint/typecheck/build/exports passed
Playwright: 33/33 passed
fuzz artifacts: none
leftover test processes: none
```

The independent reviewer did not rerun `pnpm check`, process, or Playwright; those are implementation evidence and will
be rerun as part of the final aggregate Milestone 8 remediation gate.
