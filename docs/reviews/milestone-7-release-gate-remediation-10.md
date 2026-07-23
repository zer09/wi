# Milestone 7 release-gate remediation 10

Status: **READY FOR INDEPENDENT REVIEW — implementation and local automated gates passed**

Review target: `dd932c9c774aa9c28c68f7aff66690a5b2c526f3` plus the unstaged Milestone 7 worktree and remediations 1–9.

This ledger independently validates the tenth local Milestone 7 release-gate review and records the resulting remediation. It supersedes any conflicting readiness claim in earlier Milestone 7 remediation ledgers. No accepted ADR was changed.

## Findings and resolutions

| Finding | Validation | Resolution and regression evidence |
|---|---|---|
| `FixtureProcessRunner` drops process-tree ownership after a normal leader exit | **Confirmed, Medium.** `run()` removed the child after `close`, and `terminate()` returned immediately for a closed leader. Neither path verified the detached POSIX group or retained Windows Job Object. `terminateAll()` therefore lost the only tracked ownership after a successful leader exit. Existing descendant coverage used `RealServerProcess`, not this runner. | `run()` now always awaits `terminateProcessTree()` in `finally`, including zero exit, spawn error, and timeout. `terminate()` no longer treats leader close as tree close and removes ownership tracking only after the complete boundary is verified empty; a cleanup failure remains tracked for a later `terminateAll()` retry. Parameterized real-process regressions exercise `FixtureProcessRunner` with both the timeout-driven `leader-live` case and the normal-zero-exit `leader-exits` case and assert the descendant is gone plus runner ownership is empty. |
| Startup recovery materializes every candidate ID on the main thread | **Confirmed, Medium.** The catalog worker query was already cursor-bounded to 1,000 IDs, but `CatalogClient.listRecoveryCandidates()` repeatedly appended pages into one installation-sized array. `WiRuntime.finishReady()` could not adopt work or observe closing until the aggregate completed. | `CatalogClient` and `SessionStoreManager` now expose one independently schema-validated `RecoveryCandidatePage` at a time. `WiRuntime` requests and adopts one page before requesting the next and checks `closing` before and after every page request and before each actor acquisition. At most one page of candidate IDs is retained by enumeration. Real-process regressions prove adoption of 1,001 candidates across the 1,000-ID page boundary and clean SIGTERM cancellation while the second page request is blocked after the first 1,000 candidates were adopted. |

## Design decisions

- The catalog repository and worker operation remain unchanged: they already implement deterministic `(updatedAtMs, sessionId)` keyset pagination with a hard limit of 1,000.
- The aggregate client method was replaced rather than supplemented, preventing a future startup caller from accidentally restoring installation-sized retention.
- Candidate pages are validated again on the receiving thread, including the 1,000-entry ceiling and session-ID syntax.
- Runtime adoption remains sequential. This preserves existing per-session recovery behavior and avoids creating a second concurrency policy while removing only the aggregate memory defect.
- Closing checks surround the asynchronous page request because shutdown can begin while the catalog worker is responding. A page that arrives after closing is discarded without actor acquisition.
- `FixtureProcessRunner` uses the same shared process-tree boundary as `RealServerProcess`; it does not duplicate POSIX or Windows cleanup logic.
- A failed boundary verification keeps the fixture in runner tracking. This may cause `run()` and later suite cleanup to report the failure, but it cannot silently convert an unverified tree into success.
- The descendant fixture prints its ownership metadata for non-IPC runners while retaining the IPC readiness message used by `RealServerProcess`.

## Added or updated regression coverage

- `FixtureProcessRunner` cleans an ignoring descendant when the leader remains live until the fixture timeout;
- `FixtureProcessRunner` cleans an ignoring descendant after the leader exits normally with code zero;
- startup adopts 1,001 synthetic recovery candidates over two bounded pages without browser activity;
- SIGTERM while the second candidate page is blocked exits cleanly after exactly the first 1,000 candidates were adopted;
- the earlier SIGTERM boundary after storage readiness remains covered independently.

## Verification

| Command | Result |
|---|---|
| Storage, test-support, and server package typechecks plus focused changed-file ESLint | Passed |
| Focused catalog paging, descendant, and startup-lifecycle suites | 3 files, 96 tests passed in 31.27s |
| Full process suite | 7 files, 70 tests passed in 57.50s |
| `pnpm check` | 64 files, 809 tests passed; lint, typecheck, all unit/integration/property/process tests, build, and package-export verification passed |
| `pnpm test:e2e` | 33 tests passed in 51.9s |
| `git diff --check` | Passed after final documentation update |
| Cleanup inspection | Passed; no matching fixture/server/browser process, temporary Milestone 7/E2E/process/storage/force-stop home, or port 4317 listener |

Changes remain unstaged and uncommitted. `prompts/` remains a local workflow artifact and was not modified by this remediation.
