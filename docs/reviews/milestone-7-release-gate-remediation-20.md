# Milestone 7 release-gate remediation 20

Status: **RESOLVED**

Starting head: `ff0a735a79372f84fe6dd795c48591d4352f01cc` on `milestone-7-crash-recovery`.

Stable ID: `WI-M7-M4` — retry failed Linux watchdog release.

## Independent remote finding

`releasePosixSupervisor()` stored the first release promise permanently. If that attempt timed out or rejected, every later cleanup received the same rejected promise. The process-harness ownership entry remained present but could never start a new release request, so `FixtureProcessRunner.terminateAll()` could not recover cleanup.

## Pre-correction proof

A real detached fixture group was registered under the Linux owner watchdog. The watchdog was configured to ignore its first release request while remaining alive. Before correction, the first cleanup resolved normally because the watchdog did not yet expose this deterministic mode; source inspection separately showed that any rejected `ownership.release` promise was returned forever without a reset path. The retained test now fails against the prior implementation because its required first timeout does not occur and no retry state machine exists.

## Correction

- Ownership now records only `releaseAttempt`, the currently active release promise.
- Concurrent cleanup calls share that one active attempt.
- Success is accepted only after the fixture process group and watchdog are both verified gone; only then is the ownership entry removed.
- Rejection removes all temporary close, disconnect, error, and message listeners, clears `releaseAttempt`, and leaves ownership available for retry.
- Normal watchdog IPC disconnect is treated as provisional because watchdog self-termination disconnects before `close`.
- A later attempt that observes disconnected IPC safely kills and verifies the fixture group, then kills and verifies the watchdog.
- Explicit cleanup suppresses the direct-child close callback's duplicate release request. Natural leader exit retains automatic watchdog release.
- `FixtureProcessRunner` retains children after failed cleanup, clears only its active termination promise, and `terminateAll()` can start a later attempt. Fire-and-forget timeout/readiness cleanup observes expected rejection so it cannot become an unhandled promise rejection.

Linux-only v0.1 scope applies under ADR-0011; no removed Windows Job Object behavior was reintroduced.

## Retained regressions

`tests/process/process-harness-descendant.test.ts` uses real fixture groups and watchdog processes to prove:

1. first release timeout, retained live watchdog, second successful release;
2. first watchdog protocol error, second successful release;
3. first IPC disconnect, second safe escalation;
4. concurrent duplicate cleanup calls produce one watchdog request;
5. `FixtureProcessRunner.terminateAll()` retries after its first cleanup failure;
6. group and watchdog disappearance after success;
7. existing leader-live, leader-exit, owner-death, and setup-failure behavior remains intact.

Test-only watchdog modes record bounded state outside the repository so assertions observe real release request counts and PIDs rather than timing alone.

## Verification evidence

| Command/probe | Result |
|---|---|
| Pre-correction focused timeout regression | Failed as expected: first cleanup resolved instead of rejecting |
| Focused descendant/ownership process file | 11 passed |
| `pnpm test:unit` | 42 files; 458 passed |
| `pnpm test:process` | 8 files; 97 passed |
| `pnpm check` | 68 files; 871 passed; no skips |
| `pnpm test:e2e` | 33 passed |
| Typecheck, build, package exports, lint, `git diff --check` | Passed |

No assertion failure or unhandled rejection occurred in the successful runs. No fixture group or watchdog remained after the focused, process, full-check, or E2E gates.

## Independent verification closure

Fresh independent verification at `434e5952514a9e202363ec6197da7010b2649988` classified `WI-M7-M4` as **RESOLVED** with no blocking or nonblocking findings. The verifier independently reproduced the permanent cached-rejection defect at `ff0a735`, then used real fixture leaders, descendants, process groups, and watchdogs to confirm:

- timeout and authenticated supervisor-error failures retain ownership and permit a second real release request;
- disconnected IPC is not accepted as success and a later cleanup safely verifies group termination before watchdog escalation;
- concurrent callers share exactly one active attempt, while a post-failure caller starts a new attempt;
- temporary close, disconnect, error, and message listeners return to baseline on every outcome;
- natural leader close, explicit cleanup, owner-pipe EOF reclamation, preload gating, and setup-failure behavior remain intact;
- `FixtureProcessRunner` retains failed cleanup ownership and `terminateAll()` retries to verified success.

The independent gates passed: 458 unit tests, 97 process tests, 871 tests under `pnpm check`, 33 browser E2E tests, and all lint, typecheck, build, package-export, and diff checks. No fixture, descendant, watchdog, state file, or unhandled rejection remained.

## Next action

Proceed to the documentation-only `WI-M7-L1` correction. Do not merge PR #13 or begin Milestone 8 until that correction receives fresh independent verification and the final full local review is complete.
