# Milestone 7 release-gate remediation 21

Status: **RESOLVED**

Starting head: `434e5952514a9e202363ec6197da7010b2649988` on `milestone-7-crash-recovery`.

Stable ID: `WI-M7-L1` — failpoint documentation overstated final boundary matching.

## Independent remote finding

Canonical documentation said every configured selector field is matched at the final failpoint boundary. That was inaccurate for run-scoped failpoints. Their environment selector requires `sessionId + commandId + runId`, but the implementation uses those fields in two stages:

1. `takeRunIdForCommand(sessionId, commandId)` matches the configured target command and assigns its deterministic selected run ID once;
2. later committed publication/provider/tool/run boundaries call `hit()` with `sessionId + runId`, and the run selector matches those two fields before consuming the crash one-shot.

The later committed boundary does not carry or recheck `commandId`. This was a low-severity documentation defect; the independently reviewed selector behavior itself was already correct.

## Implementation confirmation

No production or test-support behavior changed under this Stable ID.

The final implementation remains:

- a closed failpoint-name inventory;
- unavailable unless both `NODE_ENV=test` and `WI_ALLOW_TEST_FAILPOINTS=1` are present;
- strict startup rejection for unknown names, malformed identities, missing fields, extra fields, and incompatible selector shapes;
- one-time command binding for the configured run selector;
- committed run-boundary matching by `sessionId + runId`;
- one crash trigger guarded by `triggered`;
- environment-owned selection that browser commands and provider output cannot change;
- concurrent-session process coverage proving unrelated work can cross the same named boundary without terminating Wi.

An unrelated command cannot acquire the configured selected run ID because command binding checks both `sessionId` and `commandId`. An unrelated session or run cannot consume the later crash one-shot because committed-boundary matching checks `sessionId + runId`.

## Documentation correction

Updated canonical documents now state the two-stage binding explicitly and no longer claim that `commandId` is rechecked at the later committed boundary:

- `docs/architecture/failure-recovery-matrix.md`
- `docs/architecture/failure-boundaries.md`
- `docs/plans/v0.1-first-vertical-slice.md`

The correction preserves the tested guarantees that unrelated sessions or commands cannot consume the selected target and that the one-shot fires at most once.

## Validation evidence

| Command/check | Result |
|---|---|
| Source-to-document comparison | Confirmed two-stage command binding and committed-boundary matching; no code change required |
| Focused failpoint-controller unit file | 23 passed |
| `pnpm lint` | Passed |
| `git diff --check` | Passed |
| `pnpm check` | 68 files; 871 passed; no skips; lint, typecheck, test, build, and package exports passed |
| `pnpm test:e2e` | 33 passed |

No assertion failure or unhandled rejection occurred. The canonical documentation no longer contains the inaccurate claim that every configured run-selector field is rechecked at the final committed boundary.

## Independent verification closure

Fresh independent verification at `d7971ba1fa29790f812ea646a41afe43c4d798d0` classified `WI-M7-L1` as **RESOLVED** with no findings. The verifier traced startup validation, all selector kinds, the separate `runIdAssigned` and `triggered` states, actor command acceptance, every committed run boundary, and the concurrent-session process matrix. Repository-wide canonical documentation search found no remaining present-tense claim that every configured run-selector field is rechecked at the final committed boundary.

Independent gates passed: 23 focused failpoint-controller tests, 871 tests under `pnpm check`, 33 browser E2E tests, lint, typecheck, build, package exports, and `git diff --check`. No test was changed or weakened under this documentation-only Stable ID.

## Next action

Run the final fresh full local review across every Stable ID. Do not merge PR #13 or begin Milestone 8 until that review passes and the exact committed head completes required CI and independent remote re-review.
