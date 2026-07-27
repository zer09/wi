# Milestone 8 release-gate remediation

Status: RESOLVED

Follow-up: [`milestone-8-release-gate-remediation-2.md`](./milestone-8-release-gate-remediation-2.md) records the
independent-oracle, bounded-shrink, and Milestone 4 environment-variable corrections found by the next review.

Baseline reviewed: `908777ebfb161144ed4119e1222fc96a14cffb09`

## Review outcome

The independent review reported no Critical findings and classified the milestone as **PASS WITH REQUIRED FIXES**. The
three High findings were valid:

1. nightly upload omitted files under the dot-prefixed `.artifacts` directory;
2. plain `fc.assert` companion suites did not use the Milestone 8 artifact helper;
3. durable core properties mutated one database across independent fast-check invocations, so a minimized path could
   omit prerequisite state.

The pnpm passthrough issue was also valid. The ledger, actor, and worker-lifecycle findings describe useful additional
breadth, but existing generated agent-loop and deterministic integration/process suites already own those boundaries.
They were not release blockers and were not duplicated here.

## Corrections

### Hidden nightly artifacts

The nightly `actions/upload-artifact` step now sets `include-hidden-files: true` while retaining the narrow
`.artifacts/fuzz/**` path, failure-only condition, warning behavior, and 14-day retention. Do not remove this option
while the artifact root remains dot-prefixed: upload-artifact excludes hidden paths by default.

### Artifacts for companion properties

The property Vitest project now loads `tests/property/support/fuzz-artifacts-setup.ts`. Before each test it installs a
fast-check reporter that records ordinary `fc.assert` failures through the shared
`tests/property/support/fuzz-artifact.ts` writer. The existing Milestone 8 `fc.check` helper uses that same writer.

Artifacts contain the actual seed and minimized path, bounded counterexample preview and SHA-256 digest, bounded
command/session/run/call identifiers, run/shrink counts, and an exact single-test command. The reporter selects the
legacy `WI_M4_AGENT_FC_SEED` and `WI_M4_AGENT_FC_PATH` names for the agent-loop companion and the standard
`WI_FC_SEED`/`WI_FC_PATH` names elsewhere. Every write is followed by `chmod(0600)` so overwriting a permissive file
repairs its mode.

A temporary intentional-failure probe verified a plain companion `fc.assert` failure at seed `919191`, path `0`, and
counterexample `[{"commandId":"cmd_probe"}]`. Its generated command reproduced the same failure in exactly one test;
the 739-byte artifact contained `commandId=cmd_probe` and had mode `0600`. The probe and artifact were removed.

### Reproducible durable histories

Each durable command, event-store, and tool-ledger property now generates one fixed-length array containing exactly
1,000 operations. One fast-check invocation executes that array serially against a fresh SQLite setup. A minimized
path therefore includes and replays all operations before the failure; `caseNumber`, event sequence, IDs, catalog
rows, accepted commands, and prior ledger rows are reconstructed instead of beginning again at operation one.

This keeps the previous worker-efficient design—one worker setup per durable model—without the false claim that 1,000
independent stateful invocations can be reproduced from one isolated path. Do not change these models back to a
single-operation arbitrary with the database outside `fc.check`; that recreates the accumulated-state reproduction
bug.

### Runner argument handling and duration semantics

`run-fuzz.mjs` removes the optional leading pnpm `--`, consumes `--duration=<value>` or `--duration <value>` with
`ms`, `s`, or `m`, and forwards remaining arguments to Vitest. A focused probe using
`pnpm test:fuzz -- --duration=1000ms -t "..."` ran exactly one selected property.

The configured duration is a minimum measured fuzz budget, not an end-to-end deadline. Build, test collection, worker
startup, cleanup, and fixed-run companion suites add overhead. Very short overrides can overshoot; this is documented
rather than hidden behind a second scheduler or unsafe forced termination.

## Deliberately deferred breadth

The following were not expanded because doing so would duplicate stronger existing boundaries:

- additional durable generation for every terminal ledger state: fixed ledger/agent-loop suites already cover
  completed, failed, denied, cancelled, discarded, promotion, result reuse, and terminal regression;
- another generated positive approval/input race system: real actor integration and browser E2E suites cover the
  simultaneous race windows;
- generated worker timeout/replacement histories: deterministic process tests remain authoritative for ambiguous RPC,
  crash, owner replacement, and restart behavior.

Revisit these only when a production defect escapes the existing suites or a new milestone explicitly broadens the
model. Any such defect should first receive a focused deterministic regression, then the smallest useful generator
extension.

## Recurrence checklist

If fuzz artifacts disappear or a reproduction command stops matching:

1. confirm `.github/workflows/nightly-fuzz.yml` still has `include-hidden-files: true`;
2. confirm the property project still loads `fuzz-artifacts-setup.ts`;
3. confirm new companion properties use `fc.assert`/`fc.check` without overriding the global reporter;
4. run an intentional synthetic failure and verify seed, path, counterexample digest, IDs, exact `-t` command, and
   mode `0600`;
5. execute that command from a clean artifact directory and verify the same minimized counterexample;
6. for durable models, confirm the arbitrary still owns the complete prerequisite history rather than relying on
   state left by earlier fast-check invocations;
7. validate the nightly YAML and inspect upload-artifact behavior whenever its major version changes.

## Validation

```text
focused durable histories:       3/3 passed; exactly 1,000 operations per model
focused durable path replay:     1/1 passed from WI_FC_PATH=0 against a fresh database
focused gateway/agent companion: 7/7 passed
plain fc.assert failure probe:    expected failure reproduced; artifact mode 0600
pnpm passthrough/duration probe:  one selected property passed; 1000ms parsed by runner
property:                         12 files, 45/45 passed
local fuzz:                       2 rounds, seeds 737373-737374, 34/34 per round, 86,564ms wall
extended fuzz:                    14 rounds, seeds 737373-737386, 34/34 per round, >=600,000ms
pnpm check:                       71 files, 900/900 passed; lint/typecheck/build/exports passed
E2E:                              33/33 passed
nightly YAML/hidden option:       parsed and asserted true
git diff check:                   passed
```

The remediated 10-minute profile completed 476 test invocations without a property failure, missing artifact, or
Vitest worker-RPC timeout. Round count differs from earlier runs because the complete 1,000-operation durable histories
make each round longer; the measured-duration loop still crossed the requested 600-second minimum.
