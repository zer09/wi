# Milestone 7 release-gate remediation 5

Status: **READY FOR INDEPENDENT REVIEW — implementation and automated gates passed**

Review target: `dd932c9c774aa9c28c68f7aff66690a5b2c526f3` plus the unstaged Milestone 7 worktree and remediations 1–4.

This ledger independently validates the fifth local Milestone 7 release-gate review and records the resulting remediation. It supersedes any conflicting readiness claim in earlier Milestone 7 remediation ledgers. No accepted ADR was changed.

## Findings and resolutions

| Finding | Validation | Resolution and regression evidence |
|---|---|---|
| Explicit repair reports success without repairing existing valid rows | **Confirmed, High.** Discovery supplied `null` CAS expectations, so every existing non-null status made `CatalogRepository.reconcileSession()` return `applied: false`; the manager ignored that result and incremented `repaired`. | Scanner repair now reads the current catalog row, supplies its sequence/status as the CAS expectation, uses `reconcileSessionWithStatus()`, and increments `repaired` only after `applied: true`. A lost CAS retains repair intent instead of reporting false success. Reconciliation alone may repair a stale generated path; ordinary `createSessionIndex()` still rejects path changes. A process test corrupts status, project reference, path, title, creation/update timestamps, head, run/message summaries, attention counts, schema version, and recovery flag, then proves forced repair restores every canonical field. |
| Valid titles/messages above 1 KiB can permanently block reconstruction | **Confirmed, High.** Discovery imposed private 1,024-byte limits despite normal durable command/event capacity permitting larger strings; the resulting retryable resource error retained repair intent forever. | Title, canonical creation-event, and latest user-message budgets now use the existing maximum single durable-event capacity. Discovery still bounds bytes before parsing, but valid 2,000-character titles/messages reconstruct normally. The hostile-data regression now uses a value above durable-event capacity rather than treating 1,025 bytes as invalid. |
| Explicit repair treats a missing database as corruption and destroys catalog-only metadata | **Confirmed, High.** Scanner `ENOENT` fell through the corruption fallback; manager overwrote the row with placeholders and renamed the directory. | Missing files now produce a distinct `missing` discovery record. If a catalog row exists, repair changes only its status to `missing`; title, project reference, generated path, timestamps, head, summaries, counts, schema version, and recovery metadata remain unchanged. The remaining directory is never quarantined. If no catalog row exists, repair creates a bounded missing placeholder because no canonical metadata is available. A process test verifies exact metadata preservation and directory retention. |
| Reconstructed summaries differ from canonical normal projections | **Confirmed, Medium.** Discovery used manifest creation time, projection-table ordering by `(created_at_ms, run_id)`, and an untruncated message, while normal observation uses latest event sequence and a 200-character preview. | Discovery now mirrors `SessionRepository.getCatalogProjection()`: update time comes from the latest event sequence, run state comes from the latest run lifecycle event sequence, and the latest user message is truncated to 200 characters. A process test uses two terminal runs with equal timestamps but run-ID order opposite to event order, then proves the entire reconstructed summary equals the pre-deletion normal catalog summary. |

## Design decisions

- The per-session event sequence is the canonical ordering source; timestamps and projection-table tie-breakers cannot replace it.
- Scanner limits must reject data outside supported durable capacities, not data accepted through the normal public path.
- Explicit repair is an authoritative reconciliation from canonical session storage, but still uses a catalog CAS so an unexpected concurrent change cannot be overwritten silently.
- Path repair is limited to the reconciliation operation. Ordinary catalog writes retain the invariant that an existing session path cannot change.
- A missing file is absence, not evidence of corrupt bytes. Catalog-only metadata is therefore preserved.

## Added or updated regression coverage

- forced repair of every stale field on an existing catalog row;
- successful reconstruction of a 2,000-character title and user message;
- full before/after catalog-summary equality after total catalog deletion;
- latest run state selected by event sequence when timestamps tie;
- normal 200-character message-preview parity;
- catalog-known missing database preserves all metadata and its directory;
- hostile discovery data remains bounded above durable-event capacity;
- existing-command conflict test now verifies its absent owner is retained as `missing`.

## Verification

| Command | Result |
|---|---|
| `pnpm --filter @wi/storage typecheck` | Passed |
| Focused Milestone 7 process suite | 1 file, 33 tests passed in 49.38s |
| Focused oversized-discovery integration regression | Passed |
| Full storage integration suite | 1 file, 59 tests passed in 15.72s |
| `pnpm check` | 63 files, 799 tests passed; lint, typecheck, all unit/integration/property/process tests, build, and package-export verification passed |
| `pnpm test:e2e` | 33 tests passed in 50.8s |
| `git diff --check` | Passed |
| Cleanup inspection | Passed; no matching fixture/server/browser process, temporary Milestone 7/E2E/process home, port 4317 listener, or retained test WAL/SHM file |

Changes remain unstaged and uncommitted. `prompts/` remains a local workflow artifact and was not modified by this remediation.
