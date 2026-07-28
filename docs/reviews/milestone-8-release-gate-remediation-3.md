# Milestone 8 release-gate review follow-up 3

Status: RESOLVED

Review baseline: `908777ebfb161144ed4119e1222fc96a14cffb09`

Review verdict: PASS

This record covers the two Low documentation findings from the final independent Milestone 8 release-gate review.
No production behavior or test semantics changed.

## Findings validated

### The 45-second value is not an end-to-end round cap

The finding was correct. `scripts/run-fuzz.mjs` caps the shared fast-check interruption budget supplied to one round at
45 seconds. Durable histories and fixed-run companion suites finish their current work, so process-level round wall time
can exceed 45 seconds. The measured 60-second profile completed in 98.525 seconds across two rounds.

`docs/testing/fuzzing.md` previously said that no round exceeds 45 seconds. It now distinguishes:

- the shared fast-check interruption budget, capped at 45 seconds;
- complete round wall time, which can exceed that budget; and
- the requested profile duration, which is a minimum fuzz budget rather than an end-to-end deadline.

The nearby runner comment uses the same terminology. No hard-kill deadline was added because terminating durable or
fixed companion work would create incomplete state, ambiguous cleanup, and false failures. The nightly workflow's
20-minute job timeout remains the outer safety bound.

### Durable models execute 1,000 operations, not 1,000 independent histories

The finding was correct. Six stateless Milestone 8 core properties execute 1,000 fast-check runs each. Each of the three
stateful durable models executes one generated, prerequisite-preserving history containing 1,000 operations.

The profile table now states those units separately instead of describing every core property as 1,000 cases. This is a
documentation correction only; the stateful design remains intentional because one complete history exercises
accumulated SQLite state and supports exact seed/path replay against a fresh database.

## Deliberately unchanged

The review found no Critical, High, or Medium defect. The following remain documented non-blocking coverage boundaries:

- worker death, timeout, and replacement combinations use deterministic process tests;
- simultaneous approval/input races use integration and E2E coverage;
- less common tool terminal states use agent-loop and deterministic integration coverage;
- repeated command IDs across time/restart use the companion storage model; and
- extended fuzz obtains durable history-shape diversity by rotating seeds.

Adding parallel generators for those already-owned boundaries would not address either Low documentation finding.

## Recurrence checklist

1. Describe `WI_FUZZ_DURATION_MS` and `--duration` as minimum budgets, never hard deadlines.
2. Distinguish the per-round fast-check interruption budget from complete Vitest round wall time.
3. State fast-check `numRuns` and generated history operation counts as separate units.
4. When changing durable model packaging, verify seed/path replay still reconstructs prerequisite state in fresh SQLite.
5. Keep the nightly outer timeout greater than the extended minimum budget plus realistic round-completion overhead.

## Validation evidence

```text
independent review:                PASS; no Critical, High, or Medium findings
property:                          12 files, 45/45 passed
local fuzz:                        2 rounds, 68 invocations, 98.525s measured wall
extended fuzz:                     13 rounds, 442 invocations, >=600s
process:                           9 files, 108/108 passed
E2E:                               33/33 passed
pnpm check:                        71 files, 900/900 passed; lint/typecheck/build/exports passed
seed/path family reproductions:    passed at seed 811008, path 0
```
