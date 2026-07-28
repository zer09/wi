# Milestone 8 release-gate remediation 2

Status: RESOLVED

Baseline reviewed: `908777ebfb161144ed4119e1222fc96a14cffb09`

Previous remediation: [`milestone-8-release-gate-remediation.md`](./milestone-8-release-gate-remediation.md)

Final PASS follow-up: [`milestone-8-release-gate-remediation-3.md`](./milestone-8-release-gate-remediation-3.md)

## Review outcome

The follow-up independent review classified Milestone 8 as **PASS WITH REQUIRED FIXES**. All three High findings were
valid:

1. event-store reference state incorporated events returned by production storage;
2. a durable failure near operation 1,000 could spend the 120-second test timeout replaying unbounded shrink
   candidates before artifact creation;
3. the global artifact reporter emitted `WI_FC_*` variables for a suite that reads `WI_M4_FC_*`.

The review also correctly observed that `WI_FC_NUM_RUNS` did not affect durable histories. Generated worker replacement,
positive actor interaction races, every valid protocol family, and every terminal ledger state remain breadth gaps, but
strong deterministic process/integration/E2E or generated agent-loop coverage already owns those boundaries. They were
not duplicated in this correction.

## Corrections

### Independent event-store oracle

Both production-backed event-store properties now build expected `SessionEvent` objects from generated requests and
known session-creation inputs. They no longer append `result.events` or `created.events` to the reference model.

The independent model specifies and compares:

- session ID and monotonically increasing sequence;
- event ID and event type;
- creation timestamp;
- complete versioned payload;
- complete suffix and final replay after normal append, catalog lag, rollback, restart, and reconciliation;
- reconciled head equal to the independently maintained expected-event count.

This catches a store that rewrites an event and returns the same rewritten value: the returned event and durable replay
would now differ from the generated-input model.

### Fresh and bounded durable shrink candidates

The generated 1,000-operation array remains one self-contained counterexample, preserving accumulated-state coverage.
The execution boundary changed:

- every initial run receives a fresh temporary home and `SessionStoreManager`;
- every shrink candidate receives another fresh home and manager;
- no candidate observes rows, heads, IDs, catalog reservations, or ledger projections left by an earlier candidate;
- `fc.limitShrink(history, 1)` allows at most one minimization replay before artifact writing.

A temporary injected failure at event operation 1,000 verified the slow path. The initial run plus one shrink completed
and wrote the artifact in 28.16 seconds, well below the 120-second test limit. The artifact recorded seed `737373`, path
`0:0`, `numShrinks: 1`, `sessionId=ses_m8Durable1`, and `runId=run_m8DurableEvent1000`, with mode `0600`. Running its
exact command against another fresh database reproduced the same operation-1,000 failure in 16.04 seconds. The probe
and artifact were removed.

Do not move durable SQLite setup back outside the property predicate. Do not remove the shrink cap without adding a
separately bounded minimizer and proving worst-case artifact creation under the test timeout.

### Milestone 4 reproduction variables

The property reporter now maps:

- `milestone4-agent-loop-model.test.ts` to `WI_M4_AGENT_FC_SEED` / `WI_M4_AGENT_FC_PATH`;
- `milestone4-state-machines.test.ts` to `WI_M4_FC_SEED` / `WI_M4_FC_PATH`;
- all other property files to `WI_FC_SEED` / `WI_FC_PATH`.

The state-machine suite's placeholder catch wrapper was removed so it cannot append a misleading `<path>` command after
the reporter has produced exact metadata. A temporary failure probe at seed `811004` produced path `0`, preserved
`commandId=cmd_stateMachineProbe`, and emitted an exact command using the required `WI_M4_FC_*` variables. The probe and
artifact were removed.

### Meaningful operation-count override

`milestone8OperationCount` now parses `WI_FC_NUM_RUNS` once in the shared support module. Normal core properties use it
as their fast-check run count; durable properties use it as the fixed history length while retaining one reproducible
history invocation. A five-operation override completed all three durable models in 1.40 seconds.

## Deliberately deferred breadth

No new worker-crash generator, actor race system, protocol family matrix, or ledger terminal-state model was added.
Those would duplicate existing deterministic process/integration/E2E and generated agent-loop coverage without fixing
the release-blocking oracle or reproduction defects.

Revisit a deferred generator only when:

1. a production bug escapes the authoritative fixed suite;
2. interaction between already-covered operations is the suspected cause; and
3. the generator has an independent observable oracle and a bounded reproduction strategy.

## Recurrence checklist

If an event-store model or durable artifact is questioned again:

1. verify expected event objects are built before and independently of `appendTransaction` results;
2. compare complete final replay to that model, not only head numbers or sequences;
3. verify storage setup occurs inside the property predicate so every shrink candidate starts fresh;
4. verify durable history uses `fc.limitShrink(..., 1)` or an explicitly tested bounded replacement;
5. inject a temporary failure at operation 1,000 and require artifact creation below the Vitest timeout;
6. execute the artifact command and require the same seed, path, operation, and identifiers against a fresh database;
7. when adding a suite-specific seed variable, update `fuzz-artifacts-setup.ts` and probe its exact generated command;
8. verify `WI_FC_NUM_RUNS` changes both ordinary run counts and durable operation counts as documented.

## Validation

```text
focused durable default:          3/3 passed; 1,000 operations per history
focused durable override:         3/3 passed with WI_FC_NUM_RUNS=5
focused event-store companion:    1/1 passed with independent complete-event model
operation-1,000 failure probe:    artifact in 28.16s; one bounded shrink; mode 0600
operation-1,000 reproduction:     identical seed/path/failure in 16.04s against fresh SQLite
state-machine variable probe:     exact WI_M4_FC_SEED/WI_M4_FC_PATH command emitted
property:                          12 files, 45/45 passed
local fuzz:                        2 rounds, seeds 737373-737374, 34/34 per round, 91,989ms wall
extended fuzz:                     13 rounds, seeds 737373-737385, 34/34 per round, >=600,000ms
pnpm check:                        71 files, 900/900 passed; lint/typecheck/build/exports passed
E2E:                               33/33 passed
git diff check:                    passed
```

The remediated extended profile completed 442 test invocations without a property failure, missing artifact, or Vitest
worker-RPC timeout.
