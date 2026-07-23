# Milestone 7 release-gate remediation 4

Status: **READY FOR INDEPENDENT REVIEW — implementation and automated gates passed**

Review target: `dd932c9c774aa9c28c68f7aff66690a5b2c526f3` plus the unstaged Milestone 7 worktree and the third remediation.

This ledger independently validates the fourth local Milestone 7 release-gate review and records the resulting remediation. It supersedes any conflicting readiness claim in earlier Milestone 7 remediation ledgers. No accepted ADR was changed.

## Findings and resolutions

| Finding | Validation | Resolution and regression evidence |
|---|---|---|
| One unsupported session schema prevents installation-wide catalog reconstruction | **Confirmed, High.** Read-only discovery threw retryable `storage.migration_failed` for `user_version` above the supported version. The scanner converted every migration failure to `transient`, and the manager retained repair intent and rejected startup even after reconstructing healthy sessions. | A newer schema now produces a distinct `unsupported` discovery record. Repair creates a session-scoped `unavailable` catalog row with the observed schema version, preserves the database at its canonical path, completes the installation repair, and serves healthy sessions. A real-process test changes one session to `user_version=999`, deletes the catalog, verifies one healthy ready session and one unavailable unsupported session with zero quarantines, verifies the file and version remain unchanged, and verifies the next startup is catalog-only with no retained repair marker. Invalid/nonpositive schema versions remain structural corruption. |
| Provenance conflict with an existing catalog command aborts the whole repair | **Confirmed, High.** The duplicate-discovery pre-pass did not compare discovered provenance with existing catalog command ownership. The manager reconciled the claimant ready before detecting the mismatch and throwing installation-wide. | Repair now preflights every discovered provenance record against any existing command before session reconciliation. It verifies command method, payload hash, owner session, event ID, normalized request, timestamp, state, and accepted result. A mismatch adds only the claimant to the existing session-scoped isolation path, so it is cataloged unavailable and quarantined before it can become ready. A real-process test removes the original owner database, gives an otherwise-valid second session the original command ID with a matching payload hash, runs explicit repair, and proves the owner becomes `missing` without losing metadata, the claimant becomes unavailable, the original accepted command remains owned by the original session, and an unrelated healthy session is served and replayable. |

## Design decisions

- A newer schema is not proof of corruption. Wi must not migrate, rewrite, or rename it with an older binary, so the canonical database is preserved in place for a compatible future version.
- Unsupported schemas are terminal for the affected session under the current binary, not retryable installation failures. Repeated automatic scans cannot make the binary understand them.
- Invalid schema values below the retained range remain corruption because they do not identify a supported or future format.
- Existing catalog command provenance is checked before `reconcileSession()`, preventing a conflicting claimant from being transiently or durably marked ready.
- Operational scanner errors such as busy, permission, descriptor, disk, I/O, and resource failures remain retryable and retain repair intent.

## Added regression coverage

- newer unsupported schema during total catalog reconstruction;
- unsupported database preserved byte-domain/path-wise with `user_version=999` retained;
- repair marker cleared after classifying an unsupported session;
- discovered provenance conflicting with an existing accepted catalog command;
- conflicting claimant isolated before ready reconciliation;
- independent healthy session served and replayable after explicit repair;
- existing command ownership remains unchanged.

## Verification

| Command | Result |
|---|---|
| `pnpm --filter @wi/storage typecheck` | Passed |
| Focused Milestone 7 process suite | 1 file, 30 tests passed in 47.33s |
| `pnpm check` | 63 files, 796 tests passed; lint, typecheck, all unit/integration/property/process tests, build, and package-export verification passed |
| `pnpm test:e2e` | 33 tests passed in 50.6s |
| `git diff --check` | Passed |
| Cleanup inspection | Passed; no matching fixture/server/browser process, temporary Milestone 7/E2E/process home, port 4317 listener, or retained test WAL/SHM file |

Changes remain unstaged and uncommitted. `prompts/` remains a local workflow artifact and was not modified by this remediation.
