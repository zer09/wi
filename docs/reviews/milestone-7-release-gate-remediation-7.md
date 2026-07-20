# Milestone 7 release-gate remediation 7

Status: **READY FOR INDEPENDENT REVIEW — implementation and automated gates passed**

Review target: `dd932c9c774aa9c28c68f7aff66690a5b2c526f3` plus the unstaged Milestone 7 worktree and remediations 1–6.

This ledger independently validates the seventh local Milestone 7 release-gate review and records the resulting remediation. It supersedes any conflicting readiness claim in earlier Milestone 7 remediation ledgers. No accepted ADR was changed.

## Findings and resolutions

| Finding | Validation | Resolution and regression evidence |
|---|---|---|
| Valid catalogs can become permanently unrecoverable because scanner results are not paged | **Confirmed, High.** Discovery accumulated every full record into one RPC response capped at 2,000,000 bytes. Enough independently valid records could exceed the cumulative cap, return no records, and retain repair intent forever. | Discovery now has two bounded RPC forms: a compact sorted inventory of canonical session IDs, followed by independently byte-bounded record pages. The manager performs a compact provenance-owner pass and a reconciliation pass over pages without retaining all full records. A supported record can occupy a page by itself. A real-process regression creates 12 sessions with supported 175,000-character titles—over 2 MB cumulatively—deletes the catalog, and proves all 12 sessions and creation commands reconstruct successfully. |
| Corrupt/unsupported/missing records do not safely repair stale catalog paths | **Confirmed, High.** Valid reconciliation alone enabled repair-only path changes. Missing records changed only status, while corrupt/unsupported records used ordinary `createSessionIndex()` and could throw on a stale path. | Added a catalog-worker-only classification repair operation that atomically applies the generated path and fault status while preserving existing catalog-only metadata. It records an observed newer schema version and clears stale recovery candidacy when applicable. Missing files, entirely missing directories, corrupt databases, unsupported schemas, conflicting valid claimants, and valid records now all converge on the generated path. A process regression combines stale paths with corrupt, unsupported, missing, and healthy canonical storage and proves one bad session cannot abort repair. |
| Wrong-prefix policy contradicts the recovery matrix | **Confirmed, Medium documentation defect.** Implementation and tests intentionally ignore wrong-prefix directories without opening or modifying them; the matrix incorrectly promised quarantine. | Corrected the canonical matrix: wrong-prefix IDs are noncanonical entries and are ignored untouched. Only exact generated-path databases are claimants; canonical-path manifest identity mismatch remains quarantinable corruption. |
| Required SIGTERM-during-tool probe is absent | **Confirmed, Medium coverage gap.** The prior noncooperative tool test initiated shutdown through IPC; SIGTERM only released fixture resources afterward. | The force-stop fixture now routes real SIGTERM through `server.close()`. The tool process test sends SIGTERM while a pure tool is executing, proves fail-closed exit with no false terminal event or released permit, restarts the same home, and verifies the same ledger row completes at attempt 2 with no `outcome_unknown` event. The provider IPC probe remains to preserve its existing control-path coverage. |
| Robust process harness is not used consistently | **Confirmed, Medium test-infrastructure defect.** Several direct suites used leader-only signals, lacked per-child deadlines, or removed homes without verified descendant cleanup. | Exported shared process-tree signaling/termination from `@wi/test-support`. `FixtureProcessRunner` now starts detached POSIX groups, applies per-child deadlines, and uses shared TERM-to-KILL tree cleanup. The storage crash suite migrated to that runner. The force-stop suite migrated to `RealServerHarness`. The direct server-lifecycle suite now starts detached groups, uses shared group signals, and verifies tree termination before deleting homes. Windows continues to use bounded `taskkill /t`. |

## Design decisions

- The inventory contains only validated canonical session IDs, so its maximum serialized size is bounded below the worker response limit even at the declared 10,000-session maximum.
- Full database-derived records are never accumulated into one worker response or retained across all sessions on the main thread.
- The first paged pass retains only compact provenance ownership. The second rereads each database and reconciles it. This bounded-memory tradeoff is preferable to trusting provisional ownership or adding long-lived scanner state to a replaceable worker.
- Page requests accept session IDs only, never browser-supplied or arbitrary filesystem paths; workers always derive and revalidate canonical paths.
- Ordinary catalog writes still reject path changes. Only explicit recovery operations can replace a stale path with the generated path.
- Wrong-prefix entries are not opened to determine whether they are duplicates. Ignoring them is safer and matches the existing no-follow/no-mutate test contract.
- Real signal testing complements, rather than replaces, deterministic IPC controls where both boundaries provide distinct evidence.

## Added or updated regression coverage

- catalog reconstruction above the former 2 MB cumulative response cap;
- exact reconstruction of 12 supported large-title sessions;
- stale-path repair for valid, corrupt, unsupported, missing-file, and missing-directory classifications;
- preservation of unrelated catalog metadata during non-valid path repair;
- real SIGTERM during a noncooperative pure tool;
- restart completion through the same pure-tool ledger row at attempt 2;
- no false `outcome_unknown` event for the safely retryable pure tool;
- process-tree cleanup for generic fixtures, storage crash fixtures, force-stop fixtures, and direct server lifecycle fixtures;
- wrong-prefix documentation aligned with the existing untouched-directory assertion.

## Verification

| Command | Result |
|---|---|
| Workspace typecheck | Passed |
| Focused changed-file ESLint | Passed |
| Focused adversarial process regressions | 4 tests passed |
| Full process suite | 7 files, 66 tests passed in 55.96s |
| Full storage integration suite | 1 file, 59 tests passed in 16.91s |
| `pnpm check` | 63 files, 802 tests passed; lint, typecheck, all unit/integration/property/process tests, build, and package-export verification passed |
| `pnpm test:e2e` | 33 tests passed in 54.7s |
| `git diff --check` | Passed after final documentation update |
| Cleanup inspection | Passed; no matching fixture/server/browser process, temporary Milestone 7/E2E/process/storage/force-stop home, or port 4317 listener |

Changes remain unstaged and uncommitted. `prompts/` remains a local workflow artifact and was not modified by this remediation.
