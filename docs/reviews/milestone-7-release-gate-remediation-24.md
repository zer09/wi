# Milestone 7 release-gate remediation 24

Status: **IMPLEMENTED — PENDING INDEPENDENT VERIFICATION**

Starting head: `2b6e50a537034686a16e9c2baef633482fffe5cd` on `milestone-7-crash-recovery`.

Stable ID: `WI-M7-M5` — numeric PGID reuse could retarget test-support cleanup to an unrelated process group.

## Verification-first finding

The third remote review required a real reuse trace before any process-ownership change. The probe ran inside an unprivileged Linux user/PID namespace with a private `/proc` and writable namespace-local `ns_last_pid`. It deliberately:

1. started a managed detached fixture group and recorded its PID/PGID;
2. let every process in that group exit;
3. held the watchdog through its test-only `ignore-first` release barrier;
4. set `ns_last_pid` so an unrelated detached sentinel acquired the exact old PID/PGID;
5. triggered target cleanup or harness-owner death;
6. inspected the sentinel before any probe fallback cleanup.

Baseline `2b6e50a` reproduced both unsafe paths:

```json
{"probe":"explicit-cleanup","oldFixturePid":19,"reusedSentinelPid":19,"reusedSentinelPgid":19,"sentinelObserved":{"event":"SIGTERM","pid":19},"sentinelExitCode":42,"releaseAttempts":2,"watchdogGone":true}
{"probe":"owner-death-cleanup","oldFixturePid":27,"sentinelPid":27,"sentinelPgid":27,"sentinelLiveAfterOwnerDeath":false,"releaseAttempts":1,"watchdogLiveAfterCleanup":false}
```

The explicit `terminateProcessTree()` path sent `SIGTERM` to the unrelated sentinel. Owner-pipe EOF made the watchdog send `SIGKILL` to the separately reproduced sentinel. `waitForProcessTreeGone()` and watchdog `groupExists()` had no lifetime identity beyond the numeric PGID, so their later checks could not distinguish the replacement group.

Classification before correction: **NOT RESOLVED**.

## Correction

The existing Linux preload gate now starts a minimal anchor process inside the detached fixture process group before fixture code can run. The anchor is unreferenced by the fixture but remains a kernel member of the group until ordinary, explicit, or owner-death watchdog cleanup signals that group.

This is a lifetime-stable ownership boundary:

- Linux retains the process-group identity while any member exists;
- after the direct fixture leader and all application descendants exit, the anchor still owns group membership;
- the old numeric PGID therefore cannot be allocated as a new PID and cannot become an unrelated new process group;
- normal target cleanup and owner-pipe EOF still use the existing bounded TERM/KILL and verified-release paths, but those paths can address only the still-anchored owned group;
- the anchor has no inherited application stdio or IPC and does not change the returned fixture `ChildProcess`, exit code, signal, output, or readiness semantics;
- setup remains fail-closed because anchor creation completes before the preload reports readiness and before fixture code is acknowledged.

No numeric existence heuristic, timing assumption, cgroup privilege, or platform expansion was added.

## Corrected independent namespace probes

The same namespace setup attempted to force immediate reuse after the fixture leader exited. The kernel skipped the anchored PGID and assigned the sentinel a different PID/PGID:

```json
{"probe":"corrected-explicit-cleanup","oldFixturePid":20,"oldGroupRetainedUntilCleanup":true,"sentinelPid":21,"sentinelPgid":21,"numericReusePrevented":true,"sentinelAliveAfterTargetCleanup":true,"sentinelAliveAfterRetry":true,"firstCleanupError":"Server process cleanup failed","releaseAttempts":2}
{"probe":"corrected-owner-death-cleanup","oldFixturePid":27,"sentinelPid":28,"sentinelPgid":28,"numericReusePrevented":true,"sentinelLiveAfterOwnerDeath":true,"releaseAttempts":1,"watchdogLiveAfterCleanup":false}
```

Both probes checked the sentinel before fallback probe cleanup. Explicit target cleanup, failed-release retry, and owner-death cleanup left it alive and unsignalled. Probe fallback then removed only the unrelated sentinel after evidence had been captured.

## Retained regressions

- A fixture mode with no application descendant exits its direct leader while `ignore-first` retains the watchdog. The direct PID is gone but `process.kill(-oldPid, 0)` still confirms the anchor-held group exists.
- The first explicit cleanup removes the anchored group but preserves retryable watchdog ownership; the second release succeeds and removes the watchdog.
- Existing leader-live, leader-exits-with-descendant, owner-death, setup-failure, release retry/error/disconnect/delay, concurrent cleanup, and `FixtureProcessRunner` tests remain required.
- Full process, repository, browser, and static gates remain required before independent verification.

## Validation evidence

| Command/probe | Result |
|---|---|
| Baseline isolated explicit-cleanup reuse probe | Reproduced unrelated `SIGTERM`; sentinel exited 42 |
| Baseline isolated owner-death reuse probe | Reproduced unrelated sentinel death |
| Corrected isolated explicit-cleanup probe | Reuse prevented; sentinel alive after cleanup and retry |
| Corrected isolated owner-death probe | Reuse prevented; sentinel alive; watchdog gone |
| Focused anchor regression | 1 passed |
| Complete process-harness descendant suite | 12 passed |
| `pnpm test:unit` | 42 files; 461 passed |
| `pnpm test:integration` | 6 files; 262 passed |
| `pnpm test:property` | 10 files; 36 passed |
| `pnpm test:process` | 9 files; 101 passed |
| `pnpm check` | 69 files; 881 passed; no skips |
| `pnpm test:e2e` | 33 passed |
| Lint, typecheck, build, package exports, `git diff --check` | Passed |

## Independent verification required

A fresh review-only verifier must reproduce or inspect the exact old-head PID/PGID trace, independently establish that the anchor is created before fixture code and keeps the kernel group identity allocated, rerun both corrected namespace paths, verify the unrelated sentinel remains unsignalled before fallback cleanup, and confirm all ordinary ownership/retry regressions and cleanup. The verifier must classify `WI-M7-M5` as `RESOLVED`, `PARTIALLY RESOLVED`, `NOT RESOLVED`, or `INSUFFICIENT PROBE` and stop.
