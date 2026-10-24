# G1.1 acceptance and evidence

G1.1 is technically accepted within its offline/loopback scope: **39 PASS, 1 PASS_WITH_WAIVER, 0 PARTIAL**. The owner authorized documentation cleanup followed by squash merge. PR #10 is merged as `a2974d19a327d4a29de5e3b2352628d021f9b453`. Historical acceptance and [current regression health](PROJECT_STATE.md) are separate.

## Reviewed implementation

| Boundary | Revision |
|---|---|
| Previously accepted master | `76bb32fd04fd4737c0efcceaabc7d10387453147` |
| Focused completion implementation | `e61c8815e377d0a9085df5d268c251f69eea3423` |
| Pre-cleanup reviewed head | `1f18c33b1084898e60aaa4a87a189614390af49f` |
| Final cleanup head | `c10c922be6b596b88ed4b832a4736cea2211f093` |
| Squash merge | `a2974d19a327d4a29de5e3b2352628d021f9b453` |

G1-MR-01 is closed by the joined browser scenario that loads the actual synthetic skill in A, changes its owned source before explicit B, and verifies B's actual provider request contains the original stored correlated result. The loader dispatch count stays one. Existing source-change/deletion and transport tests remain.

C15 is closed for current fixed-browser compatibility. ACTIVE1 is closed for current regression acceptance; its original body-read failure's cause remains undetermined. Neither closure attributes every old failure to Chromium.

G11-36 is PASS_WITH_WAIVER because exact native-release-to-DOM timing was waived by the owner, not measured. Other finite timing, payload, query-work, disk/WAL and observed-memory results retain their stated limits.

## Executed evidence and limitations

The local implementation report records 1,254 native passes with 12 existing ignored helpers, 9,971 Node passes, and 90 browser cases across 35 files. These are attributed local results, not extra executions by the remote reviewer or inferred hosted counts.

At pre-cleanup head `1f18c33`, attempt-1 [push 39972458452](https://github.com/zer09/wi/actions/runs/39972458452) and [PR 39972465937](https://github.com/zer09/wi/actions/runs/39972465937) passed Ubuntu/macOS native gates and the Ubuntu browser job. Hosted case-level/private cleanup facts are not substituted with local counts.

At final cleanup head `c10c922`, attempt-1 [push 40018124643](https://github.com/zer09/wi/actions/runs/40018124643) and [PR 40018135987](https://github.com/zer09/wi/actions/runs/40018135987) passed the Ubuntu/macOS native and Ubuntu browser jobs. The merge and final head have the same tree `69c2440e975e7492c39647b9c3fa22f14dd7ed2a`. See the [merge record](https://github.com/zer09/wi/pull/10#issuecomment-6374360346). A different commit still needs its own required checks.

The prior reviews covered the complete change inventory with risk-based substantive inspection. They did not claim every changed line or private log was independently read. The final follow-up review record discloses an output-directory collision; it does not claim two independently preserved Markdown reports.

An initial native runtime-destruction test encountered SQLite `database is locked`; the diagnostic and subsequent unchanged full gate passed. The historical interleaving remains unknown. Passing CI is not a proof of every schedule, absence of all defects, hostile-filesystem isolation, physical power-loss behavior, or live provider entitlement.

No additional live provider requests or credential operations are part of this acceptance or documentation cleanup. The historical ledger remains 31/50 used.

## Post-merge observation, recorded 2026-10-25

[Workflow 40021350573](https://github.com/zer09/wi/actions/runs/40021350573), attempt 1 on squash `a2974d1`, passed Ubuntu native and browser jobs but failed macOS Cargo tests. Subsequent macOS Clippy/build/doctests were skipped. This is new regression-health evidence, not a retroactive edit to the passing pre-merge observations.

The [macOS job](https://github.com/zer09/wi/actions/runs/40021350573/job/120646410322) records `b1_strict_queries_methods_bodies_media_ids_and_encoded_entry_segments_before_open` failing at the request-send helper with BodyWrite/BrokenPipe, before its status/header assertions. Its library summary was 931 passed, 1 failed, 11 ignored. PM-CI-01 is **OPEN; cause unestablished**. No current failure is declared a harmless flake or fixed by a passing rerun. The focused source findings and follow-up are in [PROJECT_STATE.md](PROJECT_STATE.md).

The owner subsequently reported local use working so far without an exact tested revision or case inventory. Preserve that observation without expanding it into complete acceptance or changing the historical generation ledger.

## Documentation cleanup

Current docs describe startup, runtime ownership, HTTP/display protocols, storage, auth, tools, platforms, and development. The G1.1 cleanup changed no production behavior, generated asset, dependency, or workflow. One test's include path moved to the SQL reference in STORAGE.md; its schema/constraint assertions remained unchanged. A focused source/documentation cross-check covered startup/configuration, request routing, transaction/projector/read boundaries, migration, identity validation, tools and browser state.

Large old root handoffs, packaging manifests, slice contracts, increment diaries and process reports left the active tree. Their exact pre-cleanup content remains in the archive below. Removing them from normal documentation did not erase failures or relabel historical acceptance.

Cleanup head `20c5de2` initially failed Cargo check because the schema regression included the removed planning file. The follow-up moved the exact SQL into STORAGE.md and changed only that include path. The initial failure remains recorded in CI; it is not a runtime regression or a waived test.

The October 25 maintenance change adds a current checkpoint and decision register, records later CI, and corrects two stale source comments. It does not change runtime policy or claim to repair PM-CI-01. Its own review and CI belong to its maintenance PR, not these earlier runs.

## Historical evidence

The retained branch [`archive/g1.1-evidence-2026-10-24`](https://github.com/zer09/wi/tree/archive/g1.1-evidence-2026-10-24) points to **`1f18c33b1084898e60aaa4a87a189614390af49f`**, preserving the entire reviewed tree and its ancestry independently of the PR branch's squash/deletion.

Do not advance or delete that archival reference without first preserving another durable copy. It is an archive, not a branch for further implementation.

Pinned entry points:

- [Full G1.1 human report](https://github.com/zer09/wi/blob/1f18c33b1084898e60aaa4a87a189614390af49f/docs/slices/g1/VERIFICATION_G1_1.md)
- [Machine report](https://github.com/zer09/wi/blob/1f18c33b1084898e60aaa4a87a189614390af49f/docs/slices/g1/verification-g1.1.json)
- [Requirements and assertion index](https://github.com/zer09/wi/tree/1f18c33b1084898e60aaa4a87a189614390af49f/docs/slices/g1)
- [Earlier milestone documents](https://github.com/zer09/wi/tree/1f18c33b1084898e60aaa4a87a189614390af49f/docs)
- [Historical handoffs](https://github.com/zer09/wi/tree/1f18c33b1084898e60aaa4a87a189614390af49f/handoffs)
- [Completion handoff](https://github.com/zer09/wi/pull/10#issuecomment-6368053314)

These records retain their original cutoffs and obsolete instructions. They are not active assignments, current platform claims, or permission to replay a consumed test bundle. Upload-only Project reports are separately backed up; repository ancestry alone does not prove their preservation.
