# Milestone 8 PR #14 — intentional failure and local release probes

Status: RESOLVED — LOCAL PROBES COMPLETE

Post-merge hosted attestations: PENDING

Milestone 8 base: `908777ebfb161144ed4119e1222fc96a14cffb09`

Probe parent: `c265da4cff5297dcd23ed8c469346a5ad4a4c1b2` (`docs: resolve WI-M8-M1 implementation`)

Reproduction correction: `ff6d6d00d39241d7b76fa80dc95996a0dc9aed2e`

This record closes the local portion of
`Wi_M8_PR14_Remediation_Handoff/80_INTENTIONAL_FAILURE_AND_NIGHTLY_PROBES.md`. The two hosted probes are deliberately
excluded from pre-merge closure under the accepted
[`WI-M8-M1` availability decision](milestone-8-pr14-wi-m8-m1.md): GitHub cannot dispatch this new workflow until it
exists on the default branch.

## Probe-discovered reproduction defect

The first shell-sensitive probe found one real test-infrastructure defect. Artifact reproduction commands used
`JSON.stringify(testTitle)` after `-t`. A title containing `$HOME` and backticks was therefore changed by shell expansion,
and Vitest also interpreted `$` as a regular-expression anchor. The generated command selected zero tests and exited
successfully:

```text
Test Files  1 skipped
Tests       2 skipped
reproduction_exit=0
```

### Correction

`tests/property/support/fuzz-artifact.ts` now performs two independent encodings:

1. escape every Vitest regular-expression metacharacter so the title becomes a literal test-name pattern;
2. quote that pattern as one POSIX shell argument, including the standard close/quote/reopen encoding for apostrophes.

The final generated argument for the probe title was:

```text
-t 'fc\.check probe: "quotes" '"'"'apostrophe'"'"' \$HOME `uname`'
```

The unchanged title then selected exactly the intended test and reproduced the same seed/path failure with exit `1`.
`tests/architecture/nightly-fuzz-workflow.test.ts` retains a focused regression for dollar-sign and apostrophe handling.
No artifact schema, runner behavior, or production package changed.

## Intentional probe matrix

### Milestone 8 `fc.check`

```text
seed:          919191
path:          0
mode:          0600 after overwriting a pre-existing 0644 artifact
preview:       truncated at 16384 code units
sha256:        a28b66785da83c3201ec18f8f12152c567f44aa5744de782eb87f5c1e553cb38
sha verified:  independently recomputed from the complete fc.stringify value
identifiers:   ses_intentionalProbe, run_intentionalProbe,
               call_intentionalProbe, cmd_intentionalProbe
replay:        exact generated command failed the same single test with exit 1
```

### Ordinary companion `fc.assert`

```text
seed:          929292
path:          0
commandId:     cmd_companionProbe
mode:          0600
replay:        exact generated command failed one test and skipped the other
```

The property-project global reporter wrote the artifact and emitted the exact seed/path command.

### Milestone 4 environment families

```text
agent-loop:
  WI_M4_AGENT_FC_SEED=939393
  WI_M4_AGENT_FC_PATH=0
  commandId=cmd_agentLoopProbe
  exact replay: failed the intended property

state-machine:
  WI_M4_FC_SEED=949494
  WI_M4_FC_PATH=0
  commandId=cmd_stateMachineProbe
  exact replay: failed the intended property
```

Both artifacts used the correct suite-specific environment family rather than `WI_FC_*`.

### Durable operation 1000

A temporary failure at event-store history operation 1000 produced:

```text
seed:          959595
path:          0:0
numRuns:       1
numShrinks:    1
mode:          0600
sha256:        7a491ba5793095f9e58b714aac5e1b51ccad5bc92c45304ccb5dc63de264ce1e
identifiers:   sessionId=ses_m8Durable1, runId=run_m8DurableEvent999
first failure: 31.36s
exact replay:  18.25s
```

Both the initial run and replay began and ended with no `wi-m8-event-core-*` directories. The one bounded shrink created
a fresh SQLite home and cleaned it before the artifact was reported. The temporary operation-1000 failure was removed.

### Duration and test-title passthrough

```text
pnpm test:fuzz -- --duration=1000ms \
  -t 'bounds scheduler concurrency, preserves FIFO, removes cancellations, and restores permits'
```

The runner parsed `1000ms`, executed one intended test, skipped 35 others across the eight selected files, and exited
successfully after `2875ms`. This confirms the pnpm `--`, duration option, and Vitest `-t` passthrough remain distinct.

### Real Vitest-child failure propagation

A temporary post-cleanup failure in a production-backed agent-loop property was run through the actual fuzz runner:

```text
starting seed: 969696
round seed:    969696
child result:  1 failed, 35 skipped
runner result: exit 1
artifact path: correct WI_M4_AGENT_FC_SEED/WI_M4_AGENT_FC_PATH command
```

The generated real-storage case cleaned its actor, worker manager, and temporary home before returning false. Before and
after snapshots contained no `wi-m4-property-agent-*` homes, and no Vitest, run-fuzz, session-worker, or catalog-worker
process remained. The temporary failure was removed.

## Clean validation after removing every probe

```text
frozen install:          all 11 workspaces already up to date
focused lint/typecheck:  passed
architecture project:   3 files, 34/34 passed in 1.58s
property project:       13 files, 58/58 passed in 37.35s
local fuzz:             2 rounds, seeds 737373..737374,
                        72 test invocations, elapsed 78812ms
extended fuzz:          15 rounds, seeds 737373..737387,
                        540 test invocations, crossed the 600000ms budget
process project:         9 files, 108/108 passed in 144.79s
Playwright E2E:          33/33 passed in 48.4s
pnpm check:             73 files, 926/926 passed in 205.28s
build/package exports:  passed
```

No timed run produced an unexpected artifact, unhandled worker error, or `ELIFECYCLE` failure.

## Cleanup

All temporary probe branches in test source were restored exactly. The temporary
`tests/property/milestone8-intentional-probe.test.ts`, all generated `.artifacts/fuzz` files, temporary shell scripts,
SQLite homes, and worker/child processes were removed. Only the reproduction-quoting correction, its regression, this
record, and the accompanying testing documentation remain.

## Deferred hosted attestations

Immediately after the independently approved PR is merged and the workflow is registered on `master`:

1. run the controlled no-manual-seed failure from a disposable test-only branch and verify real run-identity selection,
   hidden artifact upload, mode, redaction, digest, and replay;
2. delete that branch without changing `master`;
3. run the clean extended profile last on exact `master` with manual seed `811009` and verify deterministic rounds,
   the 600-second minimum, success, no artifact, and cleanup.

Either hosted failure blocks Milestone 9 and requires a focused corrective PR. It does not retroactively reopen M1
unless its trace points to seed selection, validation, or propagation.

## Recurrence checklist

1. A reproduction command must quote for both the test runner's pattern language and the invoking shell.
2. Execute generated commands containing spaces, both quote kinds, dollar signs, backticks, and regex punctuation.
3. Require a nonzero reproduction that runs exactly one intended failing test; zero selected tests is a failed probe.
4. Verify artifact digest from the complete counterexample, not the truncated preview.
5. Verify overwrite mode, suite-specific env names, bounded shrink count, fresh storage, and cleanup independently.
6. Keep every intentional failure temporary and prove the clean suites after removal.
7. Never substitute PR CI for unavailable default-branch workflow execution; retain the post-merge blocker explicitly.
