# Milestone 7 release-gate remediation 6

Status: **READY FOR INDEPENDENT REVIEW — implementation and automated gates passed**

Review target: `dd932c9c774aa9c28c68f7aff66690a5b2c526f3` plus the unstaged Milestone 7 worktree and remediations 1–5.

This ledger independently validates the sixth local Milestone 7 release-gate review and records the resulting remediation. It supersedes any conflicting readiness claim in earlier Milestone 7 remediation ledgers. No accepted ADR was changed.

## Findings and resolutions

| Finding | Validation | Resolution and regression evidence |
|---|---|---|
| Explicit repair misses catalog sessions whose entire generated directory is absent | **Confirmed, High.** Filesystem discovery can emit `missing` only after enumerating an existing valid session directory. `discoverAndRepairCatalog()` had no complement pass over catalog rows, so an entirely absent directory produced no discovery record and the repair marker could be cleared while the existing row remained `ready`. | Catalog repair now sends the complete bounded set of observed discovery IDs to a catalog-worker transaction. The transaction rejects catalog cardinality above the configured repair limit, identifies catalog rows absent from the scan, changes `ready` rows to `missing`, and preserves existing `missing` or intentionally quarantined `unavailable` classifications. The manager records those session-scoped fault states before repair completion. A real-process test removes the entire generated directory, runs forced repair, proves discovery reports zero filesystem records, and verifies every catalog field except status is unchanged while the directory remains absent. |
| Startup and shutdown are not coordinated across all of `WiRuntime.ready()` | **Confirmed, High.** Runtime readiness had no memoized lifecycle or closing state. `server.close()` could close actors and storage after `storage.ready()` completed while candidate enumeration/adoption continued, causing startup to reject with a close-induced worker error. | `WiRuntime.ready()` is now one memoized startup promise. `close()` synchronously marks the runtime closing before any asynchronous shutdown phase. Startup checks that state after storage readiness, after candidate enumeration, before each actor adoption, and before installing eviction work. A close-induced error from an already-crossed asynchronous startup boundary resolves as startup cancellation; unrelated pre-close startup failures still reject. The process fixture now deterministically pauses after real storage readiness, completes `server.close()`, then resumes candidate adoption. It proves startup and shutdown both fulfill and no listener is created. |

## Design decisions

- Filesystem enumeration alone cannot prove catalog completeness. Repair must compare the bounded scan against the bounded catalog identity set before clearing durable repair intent; absence changes `ready` to `missing` but does not erase an intentional `unavailable` quarantine classification.
- The catalog complement operation runs transactionally inside the catalog worker, returns only bounded session IDs, and preserves all catalog-only metadata.
- A discovery record of any kind counts as observed. Transient, corrupt, unsupported, and file-missing records keep their existing classification path and are not overwritten by the complement pass.
- Server-owned shutdown cancels unfinished startup. A close-induced storage or actor error is not logged or surfaced as an independent startup failure after closing has begun.
- Runtime close still does not wait indefinitely for startup; the existing absolute shutdown deadline and hard worker cleanup boundaries remain authoritative.

## Added or updated regression coverage

- forced explicit repair after deleting an entire catalog-known generated session directory;
- exact catalog metadata preservation when the whole directory is absent;
- deterministic SIGTERM after storage readiness and before recovery-candidate adoption;
- startup resumes only after server shutdown has completed, proving closed storage is not queried;
- existing database-file-only missing-session coverage remains intact.

## Verification

| Command | Result |
|---|---|
| Storage and server package typechecks | Passed |
| Focused changed-file ESLint | Passed |
| Focused lifecycle and Milestone 7 process suites | 2 files, 39 tests passed in 50.32s |
| First full `pnpm check` attempt | Exposed an overbroad complement rule that changed an intentionally quarantined `unavailable` row to `missing`; implementation and documentation narrowed to preserve terminal unavailable state |
| Final `pnpm check` | 63 files, 800 tests passed; lint, typecheck, all unit/integration/property/process tests, build, and package-export verification passed |
| `pnpm test:e2e` | 33 tests passed in 48.3s |
| `git diff --check` | Passed after final documentation update |
| Cleanup inspection | Passed; no matching fixture/server/browser process, temporary Milestone 7/E2E/process home, port 4317 listener, or retained test-home WAL/SHM file |

Changes remain unstaged and uncommitted. `prompts/` remains a local workflow artifact and was not modified by this remediation.
