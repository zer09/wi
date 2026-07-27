# Milestone 8 PR #14 remediation — `WI-M8-M1`

Status: INSUFFICIENT PROBE — HOSTED DISPATCH UNAVAILABLE BEFORE MERGE

Milestone 8 base: `908777ebfb161144ed4119e1222fc96a14cffb09`

Reviewed PR head before remediation: `116d976bc88d24fccd605d5ca183961260885632`

Implementation parent: `3619173e2a18b19f89db341b6d6756c6863f0795`

Implementation commit: `cada38aa22907aa66f0cd9209552820e02a2b40d`

This record documents the nightly seed-diversity correction requested by the independent remote review of PR #14. It
follows the resolved [`WI-M8-H1`](milestone-8-pr14-wi-m8-h1.md) and
[`WI-M8-M2`](milestone-8-pr14-wi-m8-m2.md) records.

## Finding validated

The finding was correct. `.github/workflows/nightly-fuzz.yml` exported the fixed starting seed `737373` for every
scheduled and manually dispatched run. The fuzz runner rotated deterministically inside a run, but every night began the
same sequence. Repeated nights therefore did not accumulate seed diversity.

## Correction

### Deterministic selector

`scripts/select-nightly-fuzz-seed.mjs` derives a starting seed from recorded GitHub Actions metadata:

- `GITHUB_RUN_ID`;
- `GITHUB_RUN_ATTEMPT`; and
- a versioned domain separator.

It hashes that identity with SHA-256, maps the first unsigned 64 bits into `1..2147483647`, and adds one so zero is
impossible. Identical recorded identities reproduce the same seed; distinct scheduled runs receive deterministic seed
diversity. The selector does not read secrets, system time, process IDs, or a random source.

Run metadata is validated as a positive decimal integer of at most 32 digits. This accommodates real GitHub run IDs,
which already exceed the fast-check seed range, without allowing unbounded `BigInt` input.

### Manual dispatch

`workflow_dispatch` now exposes one optional string input named `seed`. A supplied value must be a canonical positive
decimal integer in `1..2147483647` and is used exactly. Invalid values exit 64 with one bounded message before dependency
installation or fuzz execution. A dispatch with no seed uses recorded-run derivation.

### Workflow propagation

The selector runs after Node setup and before dependency installation. It:

1. prints the exact selected seed, source, run ID, and attempt;
2. writes `seed=<value>` to its GitHub output file; and
3. exposes that one output to the extended-fuzz step as `WI_FC_SEED`.

The workflow-level fixed seed was removed. `run-fuzz.mjs` remains the sole fuzz orchestrator and keeps its existing
per-round deterministic increment and wrap. It already prints the starting and each round seed and exits with a
nonzero child status.

## Retained regression coverage

`tests/architecture/nightly-fuzz-workflow.test.ts` exercises the selector as a real Node process and verifies:

- two distinct scheduled run IDs produce distinct in-range seeds;
- a second run attempt also produces a distinct in-range seed;
- the same recorded identity reproduces exactly;
- manual seeds `1`, `737373`, and `2147483647` are exact;
- zero, negative, fractional, nonnumeric, above-maximum, and `Number.MAX_SAFE_INTEGER` manual values fail before an
  output is published;
- workflow wiring has one optional input, no fixed seed, and passes only the selector output;
- the selected seed is stored in a failure artifact and its reproduction command;
- a fake extended-fuzz child exit 23 is propagated unchanged by `run-fuzz.mjs`; and
- the workflow step does not opt into `continue-on-error`.

The artifact writer's `RunDetails` parameter is now generic. This is a type-only correction matching its existing
runtime behavior and allows the architecture regression to pass actual typed fast-check failure details without a cast.

## Deliberately unchanged

The fuzz runner's seed validation, per-round rotation, measured-duration loop, companion suites, artifact format, and
cleanup behavior are unchanged. No second runner or seed state file was added. GitHub run metadata is already recorded
with the workflow run, so persisting another seed registry would add state without improving reproducibility.

The nightly schedule, permissions, concurrency policy, timeout, and failure-only hidden artifact upload are unchanged.
No secret or repository write permission is required.

### Hosted availability boundary

The correction commit was pushed to the PR branch, but GitHub rejected the authorized manual dispatch attempt:

```text
HTTP 404: workflow .github/workflows/nightly-fuzz.yml not found on the default branch
```

`nightly-fuzz.yml` was introduced by PR #14 and is absent from `origin/master`. Publishing the branch therefore makes
the implementation and ordinary PR CI available, but does not register this dispatch-only workflow on GitHub's default
branch. The hosted `workflow_dispatch` probe cannot run until the workflow reaches the default branch.

No temporary default-branch change, extra trigger, duplicate workflow, or premature merge was added to manufacture this
evidence. Those options would either weaken the requested probe or violate the review gate. The actual manual dispatch
remains a post-merge attestation unless the remote reviewer explicitly approves another safe ordering.

## Recurrence checklist

1. Never pin a scheduled fuzz workflow to one permanent starting seed.
2. Derive schedule seeds only from recorded metadata or accept an explicitly logged manual seed.
3. Keep derivation deterministic, versioned, and bounded to fast-check's accepted range.
4. Do not use secrets, clocks, process IDs, or random APIs as unrecorded seed material.
5. Print the selected starting seed before fuzz execution and every actual round seed in the runner.
6. Preserve the exact failing round seed in artifacts and reproduction commands.
7. Validate manual input before installing dependencies or invoking fuzz work.
8. Keep the extended-fuzz step ordinary and fail-closed; never add `continue-on-error`.
9. Retain child nonzero-exit propagation tests when changing the runner.
10. Run an actual manual dispatch after workflow changes become available on GitHub.

## Validation evidence before independent review

```text
focused architecture suite:       1 file, 13/13 passed in 1.25s
complete architecture project:    3 files, 34/34 passed in 1.90s
workflow YAML parse:               passed
selector diversity/reproduction:  passed with recorded run IDs and attempts
manual min/default/max:            exact values passed
invalid manual inputs:             exit 64 before output publication
artifact selected-seed proof:      seed and reproduction command matched
child exit propagation:            exact child exit 23 propagated
complete property project:         13 files, 58/58 passed in 50.67s
pnpm check:                         73 files, 926/926 passed in 208.76s
lint/typecheck/build/exports:       passed
git diff check:                     passed
exact-commit PR CI 30307918559:     checks, e2e, and required passed
hosted workflow_dispatch:           rejected before run with default-branch 404
```

## Independent verification result

The fresh verification-only review correctly classified `WI-M8-M1` as `INSUFFICIENT PROBE` rather than substituting
local or PR-CI evidence for a hosted dispatch. It independently confirmed:

- exact implementation and parent identities;
- the former fixed-seed behavior;
- deterministic scheduled diversity and exact repeated-identity reproduction;
- exact manual minimum, default, and maximum seeds;
- invalid-value exit 64 before output or fuzz work;
- independent seed calculations, including the signed-range wrap boundary;
- workflow output propagation and retained child-failure propagation;
- artifact seed and reproduction-command fidelity; and
- unchanged security, timeout, concurrency, and artifact-upload behavior.

All local evidence is sufficient to validate the implementation itself. The only missing evidence is selector and
runner behavior inside an actual GitHub-hosted manual run. Keep this record `INSUFFICIENT PROBE` until that hosted
execution exists or the remote reviewer explicitly accepts post-merge attestation for this new default-branch workflow.
