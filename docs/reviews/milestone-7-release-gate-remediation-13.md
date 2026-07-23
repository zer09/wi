# Milestone 7 release-gate remediation 13

Status: **READY FOR WINDOWS CI VALIDATION — all executable local gates passed**

Review target: `dd932c9c774aa9c28c68f7aff66690a5b2c526f3` plus the unstaged Milestone 7 worktree and remediations 1–12.

This ledger independently validates the thirteenth local Milestone 7 release-gate review and records the resulting remediation. It supersedes any conflicting readiness claim in earlier Milestone 7 remediation ledgers. No accepted ADR was changed.

## Findings and resolutions

| Finding | Validation | Resolution and regression evidence |
|---|---|---|
| Process tests are documented as serial but run concurrently | **Confirmed, Medium.** `poolOptions.threads.singleThread` was configured without selecting the threads pool. Vitest therefore retained its default pool, and process files overlapped despite the canonical claim. | The process project now explicitly sets `pool: "threads"` and retains `poolOptions.threads.singleThread: true`. A complete Linux process run took 105.12s wall time with 103.53s aggregate test time, proving files no longer overlap materially; all 72 Linux-applicable tests passed and the new Windows-only owner-death test was reported as one skip. |
| Canonical shutdown timeout policy contradicts code and tests | **Confirmed, Medium documentation defect.** HTTP and WebSocket drain deadlines force-close all owned transport resources and then resolve. The lifecycle process test deliberately requires `http_shutdown_forced`, complete shutdown, and exit zero. The broad canonical statement that every timed-out phase causes a nonzero aggregate contradicted both this behavior and the smaller-fault-domain principle. | The canonical failure-boundary and recovery-matrix documents now distinguish successful hard-boundary transport isolation from unresolved internal shutdown. HTTP/WebSocket drain expiry may emit a component warning and exit zero only after every owned socket/listener is force-closed. A failed forced isolation, unresolved in-process operation, worker deadline, or other non-isolatable phase remains an aggregated `server_shutdown_diagnostic` and nonzero exit. Production behavior and its existing process regression remain unchanged. |
| Windows Job Objects do not protect against harness-owner death | **Confirmed, Medium.** The harness retained and explicitly terminated each named Job Object but never set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Unexpected Vitest worker or harness-owner termination could therefore close the last handle without reclaiming the fixture tree. | `WindowsProcessJob.create()` now applies `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` through `SetInformationJobObject(JobObjectExtendedLimitInformation)` before any process can be assigned. Creation fails closed and closes the handle if limit setup fails. A Windows-only nested owner-death fixture creates a job-owned leader plus descendant, reports both PIDs, and exits without cleanup. The outer test requires both nested processes to disappear before ordinary outer-harness cleanup begins. |

## Design decisions

- Explicit pool selection fixes the configuration at the project boundary used by both `pnpm test:process` and the full workspace test gate. No separate command-only serialization flag can drift from `pnpm check`.
- Process files are serial with one another; intentional multi-session/process concurrency inside a file remains exercised.
- A transport drain timeout is not hidden: it emits the bounded component warning already asserted by process tests. It is successful isolation only when forced destruction removes the entire owned transport fault domain.
- Internal provider/tool/storage/worker deadlines retain fail-closed nonzero semantics because abort or timeout is not proof that those effects stopped.
- The Win32 limit uses the documented `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` layout: 64-byte basic limits, 48-byte `IO_COUNTERS`, and four pointer-width memory fields (144 bytes on the targeted 64-bit Windows runner). Only `LimitFlags` is active; every other field is zero.
- Kill-on-close is configured immediately after `CreateJobObjectW` and before the preload assignment handshake. No descendant can enter a job lacking the owner-death guarantee.
- The owner-death regression is nested under the ordinary outer test job. It checks nested PIDs before outer cleanup; therefore explicit `terminateProcessTree()` cannot make the owner-death assertion pass falsely. The outer job remains available solely for fail-safe cleanup after the assertion.
- Hosted Windows execution remains authoritative for Koffi/Win32 ABI behavior. Linux validates TypeScript, lint, struct sizing on a 64-bit ABI, explicit serialization, and all platform-independent behavior.

## Updated coverage

- explicitly selected single-thread process pool under the workspace configuration;
- measured serial wall/aggregate process-suite timing;
- canonical successful transport-isolation versus fatal unresolved-shutdown policy;
- Win32 Job Object kill-on-last-handle-close configuration;
- Windows nested leader-and-descendant cleanup after harness-owner death, before ordinary harness cleanup.

## Verification

| Command | Result |
|---|---|
| Build test dependencies and root TypeScript check | Passed |
| Focused ESLint | Passed after fixture import correction |
| Koffi 64-bit Win32 structure-layout probe | Passed: basic limits 64 bytes, I/O counters 48 bytes, extended limits 144 bytes |
| Serialized Linux `pnpm test:process` | 7 files; 72 passed and 1 Windows-only skipped in 105.12s; aggregate tests 103.53s |
| `pnpm check` | 64 files; 814 passed and 1 Windows-only skipped in 133.78s; lint, typecheck, tests, build, and package-export verification passed |
| `pnpm test:e2e` | 33 tests passed in 55.2s |
| `git diff --check` | Passed after final documentation update |
| Cleanup inspection | Passed; no matching fixture/server/browser process, temporary Milestone 7/E2E/process/storage/force-stop home, or port 4317 listener |
| Hosted `windows-latest` `pnpm test:process` | **Pending; cannot be executed on this Linux host. Release readiness remains conditional on the required CI job passing the owner-death probe and all other process tests.** |

Changes remain unstaged and uncommitted. `prompts/` remains a local workflow artifact and was not modified by this remediation.
