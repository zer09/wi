# Milestone 7 release-gate remediation 22

Status: **RESOLVED**

Starting head: `4c490af7cc17838343fa26907ab90d8ddd7e4bff` on `milestone-7-crash-recovery`.

Stable ID: `WI-M7-M1-F1` — non-finite outbound numbers were silently coerced to `null` by JSON-mode child IPC.

## Final local-review finding

The independent final local review classified the second remediation as **PASS WITH REQUIRED FIXES** because `snapshotIpcValue()` accepted all JavaScript numbers. For `NaN`, positive infinity, or negative infinity it charged the JSON representation `null` but returned the original non-finite number. `RealServerProcess.send()` then passed that snapshot to JSON-mode `child.send()`, whose serialization silently changed the value to `null`.

The same values were accepted by direct retained-message analysis because their charged JSON representation also used `null`. That violated the strict test-control protocol: unsupported values must fail preflight or be represented only by a bounded rejection summary, not be accepted and changed by transport serialization.

## Independent reproduction

Before correction, direct current-head inspection produced:

```text
NaN       snapshot=NaN       JSON={"type":"probe","value":null} retainedRejected=0
Infinity  snapshot=Infinity  JSON={"type":"probe","value":null} retainedRejected=0
-Infinity snapshot=-Infinity JSON={"type":"probe","value":null} retainedRejected=0
```

Test-first regressions then failed in four places: three direct retention/snapshot cases and one real-child outbound-control case.

## Correction

- The module captures `Number.isFinite` at initialization with the other snapshot intrinsics.
- Retention analysis classifies every non-finite number as a `protocol` rejection. The original object is not retained; history receives only the existing bounded truncation summary.
- Outbound snapshotting rejects every non-finite number synchronously with the protocol-limit error before `child.send()`.
- Finite numbers retain their existing complete JSON-encoding charge and transport behavior.
- Unit regressions cover `NaN`, positive infinity, and negative infinity through both direct retention and outbound snapshot APIs.
- The real-child control regression attempts all three values and proves none reaches the child by preserving the exact valid-control count.
- Canonical process-boundary documentation now names finite-number encoding and explicitly classifies non-finite numbers as protocol-invalid.

No production Wi server behavior changed; this correction remains inside `@wi/test-support` and process-test infrastructure.

## Validation evidence

| Command/probe | Result |
|---|---|
| Pre-correction direct probe | All three snapshots retained the non-finite value while JSON encoding changed it to `null`; retention rejected none |
| Test-first focused run | Failed as expected: 4 failed, 7 passed |
| Focused corrected unit/process files | 11 passed |
| `pnpm test:unit` | 42 files; 461 passed |
| `pnpm test:process` | 8 files; 97 passed |
| `pnpm check` | 68 files; 874 passed; no skips |
| `pnpm test:e2e` | 33 passed |
| Typecheck, build, package exports, lint, `git diff --check` | Passed |

No assertion failure or unhandled rejection occurred in the successful runs. No fixture, descendant, watchdog, server, or release-state file remained after the focused and full gates.

## Independent verification closure

Fresh independent verification at `50dca3949062c3c0f34aa3190c681c47f8e0c1e4` classified `WI-M7-M1-F1` as **RESOLVED** with no blocking, nonblocking, or informational findings. The verifier independently reproduced the baseline coercion with direct retention, snapshot, and real-child probes, then confirmed all three non-finite values are represented only by bounded protocol summaries on retention and synchronously rejected before any outbound `child.send()` call.

The verification also exercised nested shapes, summary/hash completeness, a finite-number corpus including `-0` JSON semantics, startup-captured intrinsic resistance, accidental child-receipt instrumentation, all cumulative M1 bounds, and process cleanup. Independent gates passed: 461 unit tests, 97 process tests, 874 tests under `pnpm check`, 33 browser E2E tests, and all typecheck, build, package-export, lint, and diff checks.

## Next action

Run the final fresh full local review against the new exact head. Do not push or merge PR #13 and do not begin Milestone 8 until that review passes, the committed head completes required CI, and a fresh independent remote re-review approves it.
