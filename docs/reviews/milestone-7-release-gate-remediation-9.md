# Milestone 7 release-gate remediation 9

Status: **READY FOR INDEPENDENT REVIEW — implementation and local automated gates passed**

Review target: `dd932c9c774aa9c28c68f7aff66690a5b2c526f3` plus the unstaged Milestone 7 worktree and remediations 1–8.

This ledger independently validates the ninth local Milestone 7 release-gate review and records the resulting remediation. It supersedes any conflicting readiness claim in earlier Milestone 7 remediation ledgers. No accepted ADR was changed.

## Findings and resolutions

| Finding | Validation | Resolution and regression evidence |
|---|---|---|
| Windows cleanup does not verify or reliably terminate orphaned descendants | **Confirmed, Medium.** `taskkill /t` depended on a still-addressable leader, its fallback targeted only that leader, and Windows verification returned success from leader exit alone. The real leader-exit descendant test was skipped on Windows. | `@wi/test-support` now creates one named Windows Job Object per fixture. A Node preload assigns the fixture to that job and blocks before fixture code until the parent acknowledges assignment, eliminating the spawn-before-assignment window. Descendants inherit the non-breakaway job. The parent retains the independent job handle, terminates the job as a unit, and queries `ActiveProcesses` until zero even after the leader exits. Unowned Windows cleanup fails closed; the `taskkill`/leader fallback was removed. Every process-suite Node spawn now goes through the shared managed spawn boundary, and the real leader-live/leader-exits descendant test is enabled on Windows. POSIX detached-group behavior is unchanged. |
| Successful IPC waits leave referenced timeout timers alive | **Confirmed, Low.** `waitForMessage()` created a raw timeout for each race and neither cleared nor unrefed it when IPC won. Its waiter also remained registered until a later message or close after timeout. | IPC waits now use the shared cleared/unrefed bounded timeout helper. Each loop removes its wake callback in `finally`, covering success, timeout, and child exit. Existing readiness, recovery, and force-stop process suites exercise successful and failing IPC paths. |
| Production-main tests use a release-and-rebind port race | **Confirmed, Low.** The test closed an ephemeral reservation before production main bound the selected port. | Production configuration now accepts the conventional `WI_PORT=0` request for an operating-system-assigned loopback port. The production-main tests parse the actual port from the structured `server_started` record before connecting. The reservation helper and race were removed; default production port 4317 is unchanged. |

## Design decisions

- Node.js 24 has no JavaScript Job Object API. The test-support package therefore uses the exact `koffi@3.1.1` FFI dependency to call documented Win32 Job Object functions. The dependency is confined to `@wi/test-support`, loaded only on Windows, pinned exactly, lockfile-integrity protected, and explicitly allowlisted for its install script.
- Microsoft documents Job Objects as the process-unit primitive whose membership survives direct-parent exit, whose processes can be terminated together, and whose accounting can be queried. A PID-only `taskkill` retry cannot provide the same ownership proof.
- Assignment occurs in `--import` preload code before the fixture module executes. Two inherited pipes form a parent/preload handshake, preventing a fixture from spawning descendants before the parent has retained ownership.
- The job name and handshake descriptors are harness-reserved environment fields and are removed before fixture code runs. Descendants inherit job membership, not assignment credentials.
- The parent closes the Job Object handle only after querying zero active processes. A failed query or residual process is a cleanup failure and prevents temporary-home deletion.
- The real descendant test is no longer conditionally skipped on Windows. Linux validation still proves the unchanged POSIX path; actual Win32 FFI execution requires Windows CI or a Windows host.
- Port zero is accepted only as an explicit configuration value. `WiServer` already supported it and logs the resolved nonzero listening port; no default endpoint or browser security rule changed.

## Added or updated regression coverage

- platform planning now requires Windows Job Object ownership rather than a `taskkill` plan;
- real descendant cleanup remains covered for both a live leader and an already-exited leader and is enabled on Windows;
- all direct lifecycle and generic fixture spawns use the managed Node process-tree boundary;
- production configuration accepts port zero and rejects negative/noninteger/out-of-range ports;
- both production-main lifecycle probes consume the actual structured startup port;
- existing successful IPC-heavy process suites exercise the cleared/unrefed wait path.

## Verification

| Command | Result |
|---|---|
| Test-support and server package typechecks | Passed |
| Focused changed-file ESLint | Passed |
| Focused harness/config/lifecycle/storage suites | 5 files, 32 tests passed in 8.64s |
| Full process suite | 7 files, 66 tests passed in 56.49s |
| `pnpm check` | 64 files, 805 tests passed; lint, typecheck, all unit/integration/property/process tests, build, and package-export verification passed |
| `pnpm test:e2e` | 33 tests passed in 52.7s |
| `git diff --check` | Passed after final documentation update |
| Cleanup inspection | Passed; no matching fixture/server/browser process, temporary Milestone 7/E2E/process/storage/force-stop home, or port 4317 listener |

Changes remain unstaged and uncommitted. `prompts/` remains a local workflow artifact and was not modified by this remediation.
