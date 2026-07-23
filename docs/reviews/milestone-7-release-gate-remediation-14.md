# Milestone 7 release-gate remediation 14

Status: **READY FOR WINDOWS CI VALIDATION — all executable local gates passed**

Review target: `dd932c9c774aa9c28c68f7aff66690a5b2c526f3` plus the unstaged Milestone 7 worktree and remediations 1–13.

This ledger independently validates the fourteenth local Milestone 7 release-gate review and records the resulting remediation. It supersedes any conflicting readiness claim in earlier Milestone 7 remediation ledgers. No accepted ADR was changed.

## Findings and resolutions

| Finding | Validation | Resolution and regression evidence |
|---|---|---|
| 10,000-session repair can exceed the worker-RPC payload limit | **Confirmed, Medium.** Discovery retained a bounded 10,000-ID set on the manager, but the complement pass copied the whole set into one catalog-worker request. Ten thousand valid 124-unit IDs exceed the generic one-million-unit request bound before repository logic runs. | The aggregate `markUnobservedSessionsMissing` RPC was removed. Repair now checks the bounded catalog count, reads lightweight `{ sessionId, status, unavailableReason }` records in cursor pages of at most 1,000, compares each page against the manager-owned discovery set, and writes canonical missing-path repairs in batches of at most 1,000. The generic worker-RPC ceiling was not enlarged. A process regression seeds exactly 10,000 catalog rows with 124-unit valid IDs, runs forced repair at `sessionDiscoveryLimit: 10_000`, and verifies the count plus first/last canonical missing rows without `storage.payload_too_large`. |
| Missing preserved databases remain incorrectly unavailable | **Confirmed, Medium.** The complement SQL excluded every unavailable row. Status and canonical path did not distinguish a successful corruption quarantine from unsupported/oversized data intentionally preserved at that path. | Catalog schema version 5 adds nullable `unavailable_reason`, currently admitting only `quarantined`. Corrupt classifications record quarantine intent before the filesystem rename and clear it if rename fails; successful incomplete-creation quarantine updates the same provenance in the command/catalog transaction. Unsupported, oversized, lazy-fault, and failed-quarantine unavailable rows retain null. Ready/missing reconciliation clears the field. The complement preserves only unavailable rows with explicit `quarantined` provenance and marks every other absent canonical row missing. A process regression classifies unsupported, oversized, and corrupt sessions, deletes the first two canonical directories, force-repairs, and verifies missing/missing/unavailable respectively. |

## Design decisions

- The generic one-million-unit worker-RPC bound remains unchanged. Raising a shared safety ceiling to accommodate one aggregate maintenance request would weaken every worker operation and repeat the materialization problem.
- Catalog complement records are intentionally lightweight and session-ID ordered. Status updates do not alter the cursor key, so page writes cannot skip or repeat later IDs.
- The manager already owns the bounded discovery `Set`; no second installation-sized worker-side temporary table or transaction-spanning RPC protocol is needed.
- Both catalog reads and missing writes are capped at 1,000 records. Maximum-length IDs and generated paths remain comfortably below generic node/unit limits per request.
- `unavailable_reason` is catalog-only repair provenance, not browser protocol or canonical session data. It is excluded from `SessionSummary` responses and exposed only through the bounded internal repair-page schema.
- Quarantine intent is written before rename so a crash cannot rename the directory and lose the classification. A caught rename failure clears the provenance; a process crash leaves durable repair intent, and the next scan observes the still-canonical corrupt directory and retries isolation.
- Catalog migrations cannot safely infer the cause of a pre-version-5 unavailable row. They initialize provenance to null. A later absent canonical path is therefore reported truthfully as missing rather than guessing that an out-of-band quarantine exists.
- Catalog-only tests that require preservation now declare `unavailableReason: "quarantined"` explicitly instead of relying on all unavailable rows being exempt from complement repair.

## Added or updated coverage

- exact 10,000-session configured maximum with 124-unit protocol-valid IDs through real catalog worker RPCs;
- bounded page reads and bounded batch missing writes;
- unsupported and oversized preserved databases becoming missing after deletion;
- successfully quarantined corruption remaining unavailable while its generated path is absent;
- retained catalog-v1 migration through current catalog schema version 5;
- healthy in-place explicit repair preserving explicitly quarantined catalog-only metadata.

## Verification

| Command | Result |
|---|---|
| Storage build/typecheck and focused ESLint | Passed |
| New focused process regressions | 2 tests passed in 3.58s |
| Affected Milestone 7 and storage-recovery process suites | 2 files, 53 tests passed in 68.12s |
| Storage integration suite | 1 file, 61 tests passed in 16.95s after explicit fixture-provenance correction |
| Full serialized `pnpm test:process` | 7 files; 74 passed and 1 Windows-only skipped in 104.09s |
| `pnpm check` | 64 files; 816 passed and 1 Windows-only skipped in 136.43s; lint, typecheck, tests, build, and package-export verification passed |
| `pnpm test:e2e` | 33 tests passed in 50.6s |
| `git diff --check` | Passed after final documentation update |
| Cleanup inspection | Passed; no matching fixture/server/browser process, temporary Milestone 7/E2E/process/storage/force-stop home, or port 4317 listener |
| Hosted `windows-latest` process suite | Pending; unchanged limitation from remediation 13 |

Changes remain unstaged and uncommitted. `prompts/` remains a local workflow artifact and was not modified by this remediation.
