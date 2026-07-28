# Milestone 9 PR #15 remediation — `WI-M9-M1`

Status: RESOLVED

Milestone 9 base: `e8fc2a30730025f3108cd41d8225876297ad8f90`

Reviewed PR head before correction: `32ef81dffabe7027a2d6e70363ebd47171456c4d`

Implementation commit: `e8b93a8e70318785e8ae288751bb7c023379aa7f`

Independent verification verdict: RESOLVED

This record covers the predicate-isolation defect found by the independent remote review of PR #15.

## Finding validated

The finding was correct. `BoundedIpcRetention.accept()` stored one bounded message object in both pending retention and diagnostic history. `takeWhere()` then passed that same retention-owned object to caller-provided predicates. A predicate could therefore mutate nested retained data after byte accounting was established.

Independent pre-fix probes demonstrated both paths:

- a predicate returning `false` expanded and rewrote retained data while pending and history accounting remained unchanged;
- a predicate returning `true` expanded retained history beyond the string bound, after which return cloning and history reads failed even though the recorded history byte estimate remained small.

The permanent regression tests failed twice against the old implementation: matching-predicate mutation corrupted the selected/history path, and nonmatching-predicate mutation corrupted the retained pending/history path.

## Correction

`BoundedIpcRetention.takeWhere()` now evaluates every predicate against `cloneRetainedMessage(message)`, which applies the existing bounded IPC snapshot rules. Caller code never receives the object owned by pending retention and history.

After a predicate selects an internal record, `takeWhere()` removes that untouched record, updates pending accounting from its canonical retained estimate, and returns a second clone. Consequently:

- mutations made while matching cannot affect the selected canonical value;
- mutations made while rejecting a candidate cannot affect later predicates or reads;
- several preceding nonmatches remain canonical;
- returned values and history reads remain mutually independent;
- pending/history counts and byte estimates continue to describe the retained objects they own.

The existing clone implementation and limits were reused. No second serializer, proxy wrapper, deep-freeze layer, or unbounded `structuredClone` path was added.

## Regression map

The correction is owned by these tests in `packages/test-support/src/bounded-ipc.test.ts`:

- `isolates retained messages from mutating matching predicates`;
- `isolates retained messages from mutating nonmatching predicates`;
- `takes the first pending message matching a predicate`;
- `retains a bounded snapshot instead of the accepted callback object`;
- `isolates retained history from taken and history-returned message mutations`.

The two new tests cover a 2 MiB nested expansion, nested object/array rewrites, three preceding nonmatching candidates, matching and nonmatching predicates, exact accounting, canonical later reads, returned-value independence, and request-ID selection.

`docs/testing/strategy.md` now states that predicate matching, matched returns, and history reads use separate bounded clones.

## Deliberately unchanged

- Production server, browser, protocol, storage, provider, tool, and replay behavior are unchanged.
- Existing pending/history count and byte limits are unchanged.
- Existing estimated-byte, string, depth, node, protocol, accessor, proxy, cycle, and non-finite validation remains the cloning boundary.
- Request-ID predicates in both E2E fixtures retain their existing semantics.
- `WI-M9-L1` is a separate documentation correction and was not included in the implementation commit.
- No new abstraction or alternate retention implementation was introduced.

## Recurrence checklist

1. Never pass a pending/history-owned IPC value to caller callbacks or predicates.
2. Evaluate caller predicates against a bounded defensive clone of each candidate.
3. Return a separate clone of the untouched selected record after accounting is updated.
4. Keep matching and nonmatching nested-mutation tests, including multiple preceding candidates.
5. Assert retained history remains canonical after mutating predicate inputs, returned values, and prior history reads.
6. Assert pending and history count/byte diagnostics remain exact after selection and rejection.
7. Preserve request-ID matching tests whenever predicate consumption changes.
8. Reuse the existing IPC snapshot limits rather than adding an unbounded or second cloning path.
9. Run unit, process-harness, and E2E fixture coverage after changing bounded IPC ownership.

## Validation evidence

Implementation validation:

```text
focused bounded IPC: 1 file, 12/12 passed repeatedly
unit:                42 files, 467/467 passed
process:              9 files, 108/108 passed
typecheck:            passed
build/exports:        passed, 8 package entry points
e2e:                  34/34 passed
git diff --check:     passed
```

Independent verification additionally established:

```text
old implementation with unchanged regressions: 2 failed, 10 passed
corrected focused suite:                         12/12 passed
focused process bounds:                          6/6 passed
correction blob:                                 e8b93a8e70318785e8ae288751bb7c023379aa7f
classification:                                  RESOLVED
```

The verifier removed temporary worktrees and probes. No relevant process, listener, temporary Wi home, Playwright output, database, log, or fuzz artifact remained. The PR branch was not pushed during implementation or verification.

## Next gate

Proceed with the separate `WI-M9-L1` catalog-availability wording correction and its verification-only review. The complete local release matrix, detached final acceptance, exact-head hosted CI, remote re-review, merge, post-merge attestation, and tag authorization remain later gates.
