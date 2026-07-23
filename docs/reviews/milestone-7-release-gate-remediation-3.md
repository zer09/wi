# Milestone 7 release-gate remediation 3

Status: **READY FOR INDEPENDENT REVIEW — implementation and automated gates passed**

Review target: `dd932c9c774aa9c28c68f7aff66690a5b2c526f3` plus the unstaged Milestone 7 worktree.

This ledger independently validates the third local Milestone 7 release-gate review and records the resulting remediation. It supersedes any conflicting readiness claim in the earlier Milestone 7 remediation ledgers. No accepted ADR was changed.

## Findings and resolutions

| Finding | Validation | Resolution and regression evidence |
|---|---|---|
| Reconstructed creation provenance can produce an inconsistent command result | **Confirmed, High.** `CreationProvenanceSchema` accepted arbitrary canonical JSON, discovery performed only structural parsing, and repair copied the stored result and hash into the catalog. It did not compare event identity or acceptance time with canonical session data. | Creation provenance now requires the exact `{ sessionId }` shape. Read-only discovery verifies that the result identifies the manifest session, recomputes the supported canonical `session.create` payload hash from manifest-backed fields, and requires the provenance event ID and acceptance timestamp to match the sequence-1 `session.created` event and manifest creation time. Any mismatch is session-scoped structural corruption and is quarantined. A real-process repair test independently mutates result, hash, event ID, and timestamp fields, then proves all four sessions become unavailable while an unrelated session is reconstructed ready. |
| One cross-session provenance conflict aborts installation-wide catalog repair | **Confirmed, High.** The provenance-owner pre-pass threw before the repair loop, preventing unrelated healthy sessions from being reconstructed. | The pre-pass now records every ambiguous claimant. The repair loop isolates and quarantines all claimants while continuing independent records. A real-process test makes two otherwise valid databases claim one command ID, deletes the catalog, and proves both claimants become unavailable while a third healthy session is reconstructed. |
| Successful deadline-based storage close leaves a referenced timer alive | **Confirmed, Medium.** The startup-recovery `Promise.race` did not retain, clear, or unref its timeout after the startup promise won. | The timeout is retained, `unref()`ed immediately, and cleared after the race settles. A child-process fixture calls `SessionStoreManager.close(Date.now() + 60_000)` and must exit naturally within the two-second fixture deadline after printing `close-returned`. |

## Implementation notes

- Hash verification accepts the two wire-equivalent representations of an empty title: omitted (the normal default) and explicitly `""`. Non-empty titles and project IDs must be present exactly as represented by the manifest.
- Provenance validation remains inside the read-only, non-migrating session discovery worker boundary.
- Cross-session command ambiguity is treated as corruption of every claimant because no claimant can be selected safely from retained provenance alone.
- Busy/resource/operational discovery failures remain retryable and are not reclassified as corruption.

## Added regression coverage

- foreign-session creation result is quarantined;
- reconstructed creation payload hash is recomputed and checked;
- provenance event ID is checked against canonical sequence 1;
- provenance acceptance time is checked against the manifest and canonical creation event;
- two conflicting provenance claimants do not block an independent healthy repair;
- successful deadline-based storage close permits immediate natural process exit.

## Verification

| Command | Result |
|---|---|
| `pnpm --filter @wi/storage typecheck` | Passed |
| Focused Milestone 7 process suite | 1 file, 28 tests passed in 43.38s |
| Focused architecture + Milestone 7 process suites | 2 files, 45 tests passed in 43.44s |
| `pnpm check` | 63 files, 794 tests passed; lint, typecheck, all unit/integration/property/process tests, build, and package-export verification passed |
| `pnpm test:e2e` | 33 tests passed in 51.2s |
| `git diff --check` | Passed |
| Cleanup inspection | Passed; no matching fixture/server/browser process, temporary Milestone 7/E2E/process home, port 4317 listener, or retained WAL/SHM file |

Changes remain unstaged and uncommitted. `prompts/` remains a local workflow artifact and was not modified by this remediation.
