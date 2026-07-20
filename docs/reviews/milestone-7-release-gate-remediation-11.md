# Milestone 7 release-gate remediation 11

Status: **READY FOR INDEPENDENT REVIEW — implementation and repeated local automated gates passed**

Review target: `dd932c9c774aa9c28c68f7aff66690a5b2c526f3` plus the unstaged Milestone 7 worktree and remediations 1–10.

This ledger independently validates the eleventh local Milestone 7 release-gate review and records the resulting remediation. It supersedes any conflicting readiness claim in earlier Milestone 7 remediation ledgers. No accepted ADR was changed.

## Findings and resolutions

| Finding | Validation | Resolution and regression evidence |
|---|---|---|
| Full release gate is nondeterministic | **Confirmed, High.** The intentional `FixtureProcessRunner` timeout began at spawn rather than readiness, so full-workspace scheduling could kill the child before its PID record was complete. The retained-v1 process test relied on Vitest's 5-second default despite worker startup and multiple child processes. All process files also competed concurrently with one another and the integration/property projects. | `FixtureProcessRunner.run()` now optionally waits for an explicit stdout marker under a separate 5-second readiness deadline before starting the intentional hang deadline. The descendant test uses the fixture's complete JSON readiness marker. The retained-v1 test has an explicit 15-second timeout. The process Vitest project has a 15-second default and serial file execution; process fixtures continue to exercise their own intentional concurrency internally. |
| Windows “SIGTERM” is an immediate Job Object force kill | **Confirmed, High.** Both SIGTERM and SIGKILL called `TerminateJobObject`, so Windows could not execute fixture signal handlers or prove ordered graceful close. | Every Windows managed fixture now receives a random one-child control credential and inherited IPC channel during the existing pre-execution Job Object handshake. The preload removes the credential from the fixture environment, validates control messages, and emits only authenticated SIGTERM/SIGINT requests into the fixture handler. The channel is unrefed so it cannot keep a completed fixture alive. SIGKILL and graceful-delivery cleanup failures escalate through `TerminateJobObject`; direct graceful signaling never calls Job termination. Signal-plan tests enforce the separation. |
| Scanner capacity limits can permanently block the whole server | **Confirmed, Medium.** A database above 256 MiB became retryable `transient`, retaining installation repair forever. The default 1,000-session scanner bound had no matching creation bound or production override. | Oversized database files now have a distinct permanent `oversized` discovery classification. Repair creates or updates only that session's `unavailable` row, preserves its canonical database in place, continues healthy repair, and clears installation repair intent. Normal session creation is serialized at admission and rejects a new command before reservation when the catalog has reached the same configured limit used by discovery; duplicate commands remain idempotent at the limit. Production exposes `WI_SESSION_DISCOVERY_LIMIT` from 1 through 10,000 and passes it to storage. Tests cover a sparse 256 MiB+1 valid session file, duplicate behavior at capacity, and configuration validation. |
| Replay/catalog shutdown probes manually unblock the component | **Confirmed, Medium.** The existing probes released both test gates before calling `server.close()`, so they covered cooperative shutdown only. | Existing cooperative probes remain. Two additional real-process probes retain their gates through shutdown under a one-second runtime deadline. Retained replay is isolated cleanly and exits zero without waiting for the hook. Retained catalog observation reaches the shared deadline, exits nonzero with shutdown failure, preserves the committed message, and reconstructs correctly after restart. Both assert bounded exit under five seconds. |

## Design decisions

- Readiness waiting is opt-in and fixture-specific; ordinary `FixtureProcessRunner` callers retain their existing timeout semantics.
- A missing readiness marker has a distinct `FixtureProcessReadinessTimeoutError`, so it cannot be confused with the intentional post-readiness hang timeout.
- Process files are serialized instead of merely increasing every timeout. This removes cross-file child-process/SQLite contention from deadline semantics while retaining concurrency tests inside each file.
- Windows graceful control uses inherited Node IPC rather than console-control injection. The channel is parent-created, the random credential is scoped to one child, and fixture descendants never receive it because the preload deletes it before fixture code runs.
- Job Object ownership remains mandatory and independently verifiable. If the leader exits or disconnects before graceful delivery, cleanup still escalates against the retained job and verifies `ActiveProcesses === 0`.
- The session-count limit is an explicit v0.1 product/storage bound, not merely a scanner tuning value. New normal writes cannot create an installation larger than the scanner configured for the same process.
- Capacity is checked before a new global command reservation. An existing command ID still reaches normal duplicate/conflict handling at capacity, preserving command idempotency.
- The 256 MiB discovery budget remains a defensive worker bound. Oversized data is not declared corrupt or renamed; it becomes a truthful per-session unavailable state that an operator can address without losing healthy catalog reconstruction.
- Noncooperative replay and catalog-observation outcomes differ intentionally: the replay subscription has a disconnect isolation boundary, while an in-process catalog projection writer has no smaller hard boundary and therefore fails the bounded shutdown.

## Added or updated regression coverage

- explicit fixture readiness precedes the 200 ms intentional hang deadline;
- retained session-v1 process recovery has a realistic explicit timeout;
- process project files run serially with a 15-second default test timeout;
- Windows signal planning distinguishes graceful IPC from Job Object force termination;
- production session-limit override accepts 1–10,000 and rejects invalid values;
- a duplicate create remains accepted while a new create is rejected at the configured session cap;
- a sparse 256 MiB+1 session database is preserved in place and isolated without retained repair intent;
- retained replay and catalog-observation gates both exit under five seconds and recover durable state correctly.

## Verification

| Command | Result |
|---|---|
| Storage, test-support, and server typechecks plus focused changed-file ESLint | Passed |
| Focused config and Windows signal-plan unit tests | 2 files, 13 tests passed |
| Focused storage capacity tests | 2 tests passed |
| Focused readiness and retained-gate process tests | 3 files, 5 tests passed in 4.76s |
| Full affected integration/process suites | 5 files, 123 tests passed in 67.13s |
| Repeated `pnpm check` | Passed twice consecutively: 64 files and 814 tests in 101.39s, then the same 64 files and 814 tests in 100.05s; lint, typecheck, test, build, and package-export verification passed both times |
| `pnpm test:e2e` | 33 tests passed in 50.1s |
| `git diff --check` | Passed after final documentation update |
| Cleanup inspection | Passed; no matching fixture/server/browser process, temporary Milestone 7/E2E/process/storage/force-stop home, or port 4317 listener |

Changes remain unstaged and uncommitted. `prompts/` remains a local workflow artifact and was not modified by this remediation.
