# Milestone 7 release-gate validation 15

Status: **PASS — no remediation required; hosted Windows process execution remains required**

Review target: `dd932c9c774aa9c28c68f7aff66690a5b2c526f3` plus the unstaged Milestone 7 worktree and remediations 1–14.

This ledger independently validates the fifteenth local Milestone 7 release-gate review. The review reported no findings, so this entry records validation rather than a production remediation. No source, test, configuration, dependency, or accepted ADR was changed in response to this review.

## Verdict validation

The reported **PASS** is supported. No release-blocking finding was identified.

- The immediately preceding independent full-suite execution on the same worktree passed with 64 files, 816 tests passed, and one Windows-only process test skipped on Linux. This is consistent with the review's separately reported unit, integration, property, and process totals.
- The independent process run passed 7 files with 74 tests passed and one Windows-only skip in 104.09 seconds. The review's 106.33-second process duration and 61.29-second Milestone 7 duration are normal timing variation relative to the independent run.
- The independent browser end-to-end run passed all 33 tests in 50.6 seconds.
- Lint, typecheck, build, package-export verification, and `git diff --check` passed.
- `pnpm why openai` and `pnpm why codex` returned no dependency path.

## Recovery and failpoint validation

Current process coverage exercises the documented Milestone 7 boundaries, including:

- command/event commit-before-ack and commit-before-publish recovery;
- staged, promoted, started, result-committed, provider-text, and terminal run/tool windows;
- session creation committed before catalog readiness;
- durable repair intent across partial repair and catalog replacement;
- repeated recovery crashes;
- approvals and pending inputs across restart and duplicate resolution;
- graceful signal, forced termination, shutdown deadline, and noncooperative resource behavior;
- corrupt, mismatched, unsupported, oversized, missing, symlink/junction, and wrong-prefix discovery cases;
- bounded discovery pages, canonical path repair for every classification, and a 10,000-session complement pass using maximum-length valid session IDs;
- deletion of unsupported/oversized preserved databases becoming `missing` while explicit successful quarantine remains `unavailable`.

No matrix contradiction was found during source and test inspection.

## Scanner and repair validation

- `SessionStoreManager.runStartupRecovery` invokes discovery only for a new, corrupt, incomplete, or explicitly forced catalog repair. A healthy catalog with no durable repair marker skips discovery and proceeds directly to incomplete-command recovery.
- Inventory enumeration accepts at most the configured 1–10,000 canonical session IDs, applies a separate inspected-entry limit, ignores invalid or wrong-prefix directory entries, and sorts the bounded inventory.
- Discovery classifies at most 64 requested session IDs per worker page with a 1,750,000-byte page budget and independently bounded diagnostic fields.
- Before and after read-only database inspection, generated paths are checked using `lstat`, canonical prefix derivation, realpath containment, non-link directory/file requirements, and device/inode identity. Manifest identity must match the path-derived session ID.
- Catalog complement repair retains the manager-owned bounded discovery set, reads lightweight catalog records in cursor pages of at most 1,000, and writes missing classifications in batches of at most 1,000. It does not send the complete 10,000-ID inventory through one worker RPC.
- Project metadata remains catalog-only and is not reconstructed from session databases.

## Windows validation boundary

Windows Job Object, authenticated graceful-signal IPC, forced-exit shape, owner-death kill-on-close, and junction behavior were not executable on this Linux host. This is not hidden by the local PASS:

- `.github/workflows/ci.yml` defines a `windows-process` job on `windows-latest` that runs the complete `pnpm test:process` project.
- The aggregate `required` job depends on `checks`, `windows-process`, and `e2e` and fails unless all three succeed.
- Final release readiness therefore remains conditional on successful hosted Windows execution for the exact committed revision.

## Verification evidence

| Check | Result |
|---|---|
| Independent full `pnpm test:process` | 7 files; 74 passed, 1 Windows-only skipped; 104.09s |
| Independent full `pnpm check` | 64 files; 816 passed, 1 Windows-only skipped; lint/typecheck/test/build/export checks passed |
| Independent `pnpm test:e2e` | 33 passed; 50.6s |
| Storage integration after remediation 14 | 61 passed |
| 10,000-ID and unavailable-provenance regressions | Passed |
| `pnpm why openai`; `pnpm why codex` | No dependency path |
| `git diff --check` | Passed |
| Post-suite process/home/port cleanup inspection | Passed |
| Hosted `windows-latest` process project | Required and pending for the exact committed revision |

Changes remain unstaged and uncommitted. The only change made for this review is this validation ledger. `prompts/` remains a local workflow artifact and was not modified.
