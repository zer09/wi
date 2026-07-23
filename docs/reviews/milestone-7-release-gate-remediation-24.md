# Milestone 7 release-gate remediation 24

Status: **PRE-READINESS BOOTSTRAP FOLLOW-UP IMPLEMENTED — PENDING INDEPENDENT VERIFICATION**

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
- A rejected first explicit cleanup retains the anchored group and retryable watchdog ownership; the second release succeeds and removes both.
- Existing leader-live, leader-exits-with-descendant, owner-death, setup-failure, release retry/error/disconnect/delay, concurrent cleanup, and `FixtureProcessRunner` tests remain required.
- Full process, repository, browser, and static gates remain required before independent verification.

## Validation evidence

| Command/probe | Result |
|---|---|
| Baseline isolated explicit-cleanup reuse probe | Reproduced unrelated `SIGTERM`; sentinel exited 42 |
| Baseline isolated owner-death reuse probe | Reproduced unrelated sentinel death |
| Corrected isolated explicit-cleanup probe | Reuse prevented; sentinel alive after cleanup and retry |
| Corrected isolated owner-death probe | Reuse prevented; sentinel alive; watchdog gone |
| Corrected isolated failed-release retry probe | Old group retained after rejection; forced allocation skipped PID/PGID 20 for sentinel 21; sentinel survived retry |
| Focused anchor/retry regressions | 6 passed |
| Setup/pre-readiness and accepted-watchdog-death follow-up | 4 passed |
| Complete process-harness descendant suite | 16 passed |
| `pnpm test:unit` | 42 files; 461 passed |
| `pnpm test:integration` | 6 files; 262 passed |
| `pnpm test:property` | 10 files; 36 passed |
| `pnpm test:process` | 9 files; 105 passed |
| `pnpm check` | 69 files; 885 passed; no skips |
| `pnpm test:e2e` | 33 passed |
| Lint, typecheck, build, package exports, `git diff --check` | Passed |

The first complete follow-up `pnpm check` encountered the previously known unrelated 5-second timeout in the catalog bootstrap-bound integration test. That exact test then passed three consecutive `CI=true` focused runs in 959–978 ms, and a complete fresh `pnpm check` passed all 882 tests. No timeout or unrelated test behavior was changed.

## First independent verification and retry-gap follow-up

The first fresh verifier independently reproduced both baseline paths and confirmed the anchor prevents immediate post-leader and owner-death reuse, but classified the first correction **NOT RESOLVED**. Explicit `terminateProcessTree()` still signalled and removed the anchor before asking the watchdog to release. When the first release was deliberately rejected, ownership remained in the WeakMap while the group was empty. The verifier then forced the old PGID onto a sentinel, and the supported second cleanup attempt sent that unrelated sentinel `SIGTERM`; it exited 42.

The follow-up correction closes that interval:

- a watchdog-owned `terminateProcessTree()` now requests `releasePosixSupervisor()` without first signalling the group;
- a rejected release retains the live watchdog, anchor, and kernel-held PGID together;
- public signals to watchdog-owned fixtures target the direct leader, leaving the anchor and descendants for watchdog reclamation after leader settlement;
- an unexpected or disconnected watchdog that has not accepted reclamation is stopped and verified gone while the anchor still reserves the group, then the harness directly reclaims that exact anchored group;
- the watchdog sends an authenticated acceptance before its first group signal; after acceptance, the harness never uses a numeric fallback and fails closed unless watchdog-owned reclamation is verified;
- unowned detached children retain the prior direct process-group TERM/KILL behavior;
- retry regressions now require the group to remain present after ignore, error, and disconnect failures and to disappear only after successful retry.

A fresh review-only verifier must independently repeat the failed-release exact-reuse probe against the pre-follow-up commit and current HEAD, then confirm no path retains numeric cleanup authority after losing the anchor. The verifier must also reconfirm initial explicit cleanup, owner death, direct SIGTERM/SIGKILL, disconnected escalation, ordinary descendants, retry bounds, and cleanup before classifying `WI-M7-M5` as `RESOLVED`, `PARTIALLY RESOLVED`, `NOT RESOLVED`, or `INSUFFICIENT PROBE` and stopping.

## Second independent verification and setup-cleanup follow-up

The follow-up verifier independently reproduced the retry-gap defect at `2675198`, confirmed the exact-reuse correction at `37df1aa`, and verified owner death, direct leader signals, pre-acceptance retry/escalation, and post-acceptance fail-closed behavior. Its classification was **PARTIALLY RESOLVED** because the `spawnNodeProcessTree()` setup-error catch sent best-effort signals and deleted ownership immediately without bounded verification that an already-created anchor, fixture group, and watchdog had disappeared.

The correction now routes failed setup through bounded anchored escalation:

- watchdog readiness failure stops and verifies the watchdog before returning, aggregating setup and cleanup errors if verification fails;
- if fixture spawn never succeeds, the watchdog is stopped and verified gone;
- before anchor readiness, preload gate pipes are closed and the direct child is awaited without ever signalling an unanchored numeric PGID;
- after anchor readiness, the watchdog is stopped while the anchor reserves the group, then the exact anchored group is reclaimed;
- group (when anchored), fixture-leader, and watchdog disappearance are verified before the ownership record is deleted or the original setup error is returned;
- cleanup failure is aggregated with the setup error and does not falsely delete ownership;
- a real preload test hook records fixture/anchor identities and the harness injects failure immediately after anchor readiness; the regression requires fixture, anchor, group, and watchdog disappearance while proving fixture code remained gated;
- a separate accepted-then-watchdog-death regression requires repeated cleanup to fail closed without numeric fallback while the group remains anchored, then uses explicit test fallback cleanup.

Independent verification remains required before M5 can be closed.

## Third independent verification and pre-readiness bootstrap follow-up

The setup-cleanup verifier confirmed watchdog readiness cleanup, after-anchor setup cleanup, post-acceptance fail-closed behavior, and the exact-reuse correction, but classified M5 **PARTIALLY RESOLVED**. A caller-provided earlier `NODE_OPTIONS --import` could execute before the Wi preload, spawn a descendant in the fixture group, and throw. Because anchor readiness had not occurred, cleanup correctly avoided unsafe numeric group signalling but incorrectly assumed no descendant could exist; it verified only the leader/watchdog, deleted ownership, and returned while the descendant group remained.

The correction removes that executable pre-readiness surface:

- `spawnNodeProcessTree()` launches a fixed `posix-owner-bootstrap` as the actual fixture process;
- the child `NODE_OPTIONS` value is replaced, so caller or inherited `--import`/`--require` hooks cannot run before ownership;
- the bootstrap statically imports the ownership preload first, preserving the same native child PID, stdio, IPC, exit, and signal behavior;
- only after the preload creates the anchor, the watchdog is registered, and the gate is acknowledged does the bootstrap dynamically import the requested fixture module with the original fixture `process.argv`;
- a retained malicious caller-import fixture would spawn a descendant and throw if executed; the regression passes it through `NODE_OPTIONS`, requires the real fixture to run normally, and requires the malicious state file never to exist;
- the pre-anchor failure regression now uses a harness-owned preload failpoint, keeping that path deterministic without executing caller code before ownership.

Independent verification remains required before M5 can be closed.
