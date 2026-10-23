# G1.1 acceptance and evidence

G1.1 is technically accepted within its offline/loopback scope: **39 PASS, 1 PASS_WITH_WAIVER, 0 PARTIAL**. The owner authorized documentation cleanup followed by squash merge. The final cleanup-head checks and squash SHA are recorded on [PR #10](https://github.com/zer09/wi/pull/10); this file does not predict a future CI result.

## Reviewed implementation

| Boundary | Revision |
|---|---|
| Previously accepted master | `76bb32fd04fd4737c0efcceaabc7d10387453147` |
| Focused completion implementation | `e61c8815e377d0a9085df5d268c251f69eea3423` |
| Pre-cleanup reviewed head | `1f18c33b1084898e60aaa4a87a189614390af49f` |

G1-MR-01 is closed by the joined browser scenario that loads the actual synthetic skill in A, changes its owned source before explicit B, and verifies B's actual provider request contains the original stored correlated result. The loader dispatch count stays one. Existing source-change/deletion and transport tests remain.

C15 is closed for current fixed-browser compatibility. ACTIVE1 is closed for current regression acceptance; its original body-read failure's cause remains undetermined. Neither closure attributes every old failure to Chromium.

G11-36 is PASS_WITH_WAIVER because exact native-release-to-DOM timing was waived by the owner, not measured. Other finite timing, payload, query-work, disk/WAL and observed-memory results retain their stated limits.

## Executed evidence and limitations

The local implementation report records 1,254 native passes with 12 existing ignored helpers, 9,971 Node passes, and 90 browser cases across 35 files. These are attributed local results, not extra executions by the remote reviewer or inferred hosted counts.

At pre-cleanup head `1f18c33`, attempt-1 [push 39972458452](https://github.com/zer09/wi/actions/runs/39972458452) and [PR 39972465937](https://github.com/zer09/wi/actions/runs/39972465937) passed Ubuntu/macOS native gates and the Ubuntu browser job. Hosted case-level/private cleanup facts are not substituted with local counts. A later cleanup head needs its own checks.

The prior reviews covered the complete change inventory with risk-based substantive inspection. They did not claim every changed line or private log was independently read. The final follow-up review record discloses an output-directory collision; it does not claim two independently preserved Markdown reports.

An initial native runtime-destruction test encountered SQLite `database is locked`; the diagnostic and subsequent unchanged full gate passed. The historical interleaving remains unknown. Passing CI is not a proof of every schedule, absence of all defects, hostile-filesystem isolation, physical power-loss behavior, or live provider entitlement.

No additional live provider requests or credential operations are part of this acceptance or documentation cleanup. The historical ledger remains 31/50 used.

## Documentation cleanup

Current docs describe startup, runtime ownership, HTTP/display protocols, storage, auth, tools, platforms, and development. The cleanup changes no production behavior, generated asset, dependency, or workflow. One test's include path moves to the SQL reference in STORAGE.md; its schema/constraint assertions remain unchanged. A focused source/documentation cross-check covered startup/configuration, request routing, transaction/projector/read boundaries, migration, identity validation, tools and browser state.

Large old root handoffs, packaging manifests, slice contracts, increment diaries and process reports leave the active tree. Their exact pre-cleanup content remains in the archive below. Removing them from normal documentation does not erase failures or relabel historical acceptance.

Cleanup head `20c5de2` initially failed Cargo check because the schema regression included the removed planning file. The follow-up moves the exact SQL into STORAGE.md and changes only that include path. The initial failure remains recorded in CI; it is not a runtime regression or a waived test.

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

These records retain their original cutoffs and obsolete instructions. They are not active assignments, current platform claims, or permission to replay a consumed test bundle.
