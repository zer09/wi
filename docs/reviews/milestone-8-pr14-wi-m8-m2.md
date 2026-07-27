# Milestone 8 PR #14 remediation — `WI-M8-M2`

Status: RESOLVED

Milestone 8 base: `908777ebfb161144ed4119e1222fc96a14cffb09`

Reviewed PR head before remediation: `116d976bc88d24fccd605d5ca183961260885632`

Implementation parent: `b9a6b3ee39ce42abb859db3cc29339c54cac15e0`

Implementation commit: `61a6fcdea345e4660b00df7019af0dcba6b1505d`

Independent verification verdict: RESOLVED

This record documents the run-count resource-bound correction requested by the independent remote review of PR #14.
It follows the resolved [`WI-M8-H1` record](milestone-8-pr14-wi-m8-h1.md).

## Finding validated

The finding was correct. `WI_FC_NUM_RUNS` accepted every positive safe integer. In the deterministic profile, that value
was passed directly to fast-check as `numRuns`; the durable models also used it as the fixed generated array length.
Values such as `Number.MAX_SAFE_INTEGER` could therefore request impractical work or fail inside arbitrary construction
instead of producing one early, actionable configuration error.

## Bound decision

The supported range is `1..1000`, inclusive. One shared bound intentionally applies to both meanings of the variable:

- stateless fast-check run count; and
- operation count in each durable SQLite history.

The maximum equals the existing release profile: 1,000 stateless runs and 1,000 durable operations. A durable operation
performs real SQLite work, and the full generated history must remain available for execution and bounded shrink replay.
Allowing larger deterministic overrides would multiply worker time and retained history size without defining a new
release profile. Additional breadth belongs to timed fuzzing, which rotates seeds under an outer workflow timeout.

Separate stateless and durable limits were not added. They would complicate one environment variable without a current
need for a larger supported stateless profile. The single default-sized maximum is the smallest safe correction.

## Correction

`tests/property/support/milestone8.ts` now:

- exports `MAXIMUM_MILESTONE8_RUNS = 1000`;
- parses `WI_FC_NUM_RUNS` through one dedicated `parseMilestone8RunCount` function;
- accepts only safe integers from 1 through 1,000;
- uses 1,000 when the variable is unset; and
- reports the bounded message `WI_FC_NUM_RUNS must be an integer between 1 and 1000` for every invalid value.

The exported operation count is initialized before importing property-suite module bodies can construct arbitraries.
If validation throws, ESM dependency evaluation prevents the hardening and durable suite bodies from evaluating, so
their arbitraries are not constructed and their predicates cannot create temporary SQLite homes or workers. Because no
property runs, the failure-artifact writer is also unreachable.

## Retained regression coverage

`tests/property/milestone8-bounds.test.ts` covers:

- unset input;
- minimum `1`;
- normal default `1000`;
- exact maximum;
- maximum plus one;
- zero;
- a negative integer;
- a fractional number;
- nonnumeric input; and
- `Number.MAX_SAFE_INTEGER`.

It also dynamically reloads the shared support module with an excessive value, requires initialization to reject, and
asserts that the fuzz-artifact directory remains unchanged.

Process-level durable-suite probes with `WI_FC_NUM_RUNS=1001` and `WI_FC_NUM_RUNS=9007199254740991` confirmed
collection failed with the bounded RangeError, zero tests executed, and unchanged `wi-m8-*` temporary-directory and
fuzz-artifact snapshots. This directly exercises the real import path used before durable arbitrary and storage
construction.

## Documentation correction

`docs/testing/fuzzing.md` now documents:

- the exact `1..1000` range;
- early rejection before arbitrary or durable-resource construction;
- the memory, SQLite-worker, and shrink-replay consequences of durable history length; and
- timed seed rotation as the supported way to obtain more breadth.

## Deliberately unchanged

No production package, database schema, runtime worker, workflow, or provider behavior changes. The seed and duration
bounds remain separate because they have different accepted ranges and were not part of this finding. Timed stateless
properties continue to use their time interruption budget; the durable operation count remains bounded by this shared
limit.

No extra subprocess harness was added to the repository. The retained initialization and parser tests plus the explicit
real-suite process probe establish the required ordering without maintaining a second test runner.

## Recurrence checklist

1. Validate resource-count environment variables before passing them to a generator or allocator.
2. Keep the accepted maximum finite, documented, and exercised by a real supported workload.
3. Test unset, minimum, normal default, exact maximum, maximum plus one, zero, negative, fractional, nonnumeric, and
   maximum-safe-integer values.
4. Use one bounded error message that does not echo attacker- or environment-controlled input.
5. Confirm invalid configuration fails during module initialization with zero property tests executed.
6. Check that rejection leaves temporary SQLite homes, workers, and fuzz artifacts unchanged.
7. Treat timed rotating-seed profiles—not oversized deterministic arrays—as the supported breadth mechanism.
8. Reassess the bound only with measured memory, SQLite, shrink, and CI-time evidence.

## Validation evidence before independent review

```text
boundary suite:                    1 file, 11/11 passed
minimum 1, stateless + durable:    2 files, 9/9 passed in 2.82s
maximum 1000, stateless + durable: 2 files, 9/9 passed in 32.27s
invalid 1001 real-suite probe:     exit 1; zero tests; bounded RangeError
invalid MAX_SAFE real-suite probe: exit 1; zero tests; bounded RangeError
invalid-probe resource snapshots:  unchanged temporary homes and artifacts
complete property project:         13 files, 58/58 passed in 45.93s
pnpm check:                         72 files, 913/913 passed
lint/typecheck/build/exports:       passed
git diff check:                     passed
```

## Independent verification closure

A fresh review-only agent verified the exact parent and implementation identities, inspected the complete correction,
and classified `WI-M8-M2` as RESOLVED with no blocking defect.

```text
boundary suite:                    1 file, 11/11 passed in 456ms
minimum 1, stateless + durable:    2 files, 9/9 passed in 2.38s
maximum 1000, stateless + durable: 2 files, 9/9 passed in 30.23s
invalid 1001 durable probe:        exit 1; zero tests in 800ms
invalid MAX_SAFE durable probe:    exit 1; zero tests in 829ms
invalid 1001 hardening probe:      exit 1; zero tests in 1.35s
invalid-probe resource snapshots:  no homes, artifacts, or surviving Vitest processes
complete property project:         13 files, 58/58 passed in 53.04s
parent-to-implementation check:    passed
tracked working tree:              clean
classification:                    RESOLVED
```

The independent review did not rerun `pnpm check`, timed fuzz profiles, process tests, or Playwright. The implementation
gate supplied the green `pnpm check` result above; all aggregate and timed gates will be rerun after the remaining
`WI-M8-M1` correction.
