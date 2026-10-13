# A5b1 compact entry/content reads: scoped review complete

Contract g1.1. Accepted: false. Status: IMPLEMENTED_REVIEWED_SCOPED. This is local implementation and execution evidence, not G1 acceptance. HEAD remains 318b7f0da7d503e2e3a8cf33be84e78ebbe8affb. Index empty; all work remains unstaged/uncommitted.

## Owner decision and implemented scope

The owner approved an explicit display-read error for a genuinely oversized legacy mandatory header. CONTRACT/SCHEMA/RUST_API/CLIENT_PROTOCOL/MATRIX/IDENTIFIERS record the decision. Canonical/raw history stays unchanged. No partial summary, paged identifier, truncation, rewrite, omission, corruption reclassification or silent block skipping is authorized.

Implemented Rust scope:

- src/storage/session.rs:94-131: public conversation_entry and conversation_content through the existing owned operation(false), session lock, connection and retirement paths.
- src/storage/conversation/error.rs:6-46: public ConversationError with Storage, CursorInvalid, CursorStale and DisplayUnavailable; static diagnostics and preserved storage source.
- src/storage/conversation/reads.rs:41-194: one explicit consistent snapshot of manifest/head/projection and addressed state, released before return. No warm backfill, repair, raw prefix reduction, B2 preparation, full run_record or provider work.
- reads.rs:336-455 and reads/ranges.rs:12-113: indexed reverse field/chunk suffix selection, forward returned fragments, scalar-aligned exact UTF-8, at most 64 descriptors plus lookahead and four bounded chunk blobs per selected field. Empty descriptors and nonempty scalars progress.
- reads/compact.rs:142-246: exact existing DisplayJson accounting for 32,768-byte entry/anchor and 524,288-byte EntryPage, including cursors/escaping. Minimum progress is checked before reporting DisplayUnavailable; near-cap headers reduce previews.
- Tool/reuse reads preserve actual bytes, result/finish distinctions, references and actual is_error. Source/field identities and malformed/stale/missing/corrupt classifications use typed validation.

HTTP/SSE and the specified flat api.conversation_display_unavailable/422 mapping are NOT implemented. Latest/backward pages, changed-entity reads, reconciliation, browser replacement, CI/examples and whole-G1 closure remain deferred.

## Isolation and preservation

Original pre-increment snapshot: /tmp/wi-a5b1-baseline-Aw7K4u2l/before.tar, SHA256 40dc4318b351d0f6e69d34f7d0cffe7c33a84e4e42e52cd424d117e5f6660c63. Original increment.diff SHA256 51a43baca2752aedd1edae7984e8b0f7a3c9e087aed61f78b7aa707975888e7d.

Original increment: 23 paths, eight modified and 15 new. First remediation: seven paths, three overlapping, adding one new test file. Later two-file remediations touched only existing increment paths. Completed reviewers independently counted 27 accumulated paths. No original baseline file disappeared. Contracts/docs/examples/assets/dependencies/schema/historical fixtures were not changed by delegates.

Private remediation evidence:

| Directory | Isolated diff SHA256 |
|---|---|
| /tmp/wi-a5b1-remediation-qt9xQJ3t | c0385126b27ded2d635731316a9cd5fd79f11e1e67e4e3a69e6b4f42a3d61d65 |
| /tmp/wi-a5b1-a02-remediation-ajs2dbzg | f1f7e74c0322cb1076c22eb6e904e5b4e9d6be802b01ccb634d3ec077546e126 |
| /tmp/wi-a5b1-b03-remediation-vPvf2amN | d5be7810793fc017d769029abefaf3546b7c36406246423ad6b38c24ba2cdf16 |
| /tmp/wi-a5b1-b04-remediation-7SHqXXHh | 2a11f11eeb1ce9c0c6f11a73b165b35f92e033909d03ae526f35ae92940c1376 |

Each directory retains REPORT.md, exact command/log records, pre-fix failures and byte manifests. The original and first remediation baselines are tar archives; later baselines are extracted baseline/ directories, not before.tar. Two parent diagnostic commands incorrectly assumed extracted/original-tar paths; those commands failed, not the source gates. Subsequent reads used the actual artifacts.

After the failed after-B03 review role, the parent compared all 652 current repository files to the latest tested after-manifest: zero mismatches. The parent then authored this evidence/documentation update. HEAD/index remained unchanged. The exact archived original conflict source still hashes to 54e73efe544d343db05e1beee025f69d95816dd4e20144875886484c2be467f8. Historical VERIFICATION.md, verification.json and DESIGN_REVIEW.md hashes remain unchanged.

## Actual native execution

The implementation and each remediation ran these gates locally with synthetic fixtures:

- cargo fmt --all -- --check
- cargo check --locked --offline --all-targets
- cargo test --locked --offline --all-targets
- cargo clippy --locked --offline --all-targets -- -D warnings
- cargo build --locked --offline --all-targets
- cargo test --locked --offline --doc
- cargo test --locked --offline --test platform_support
- git diff --check and untracked whitespace inspection

Final B03 remediation execution: all passed; library 795 passed with 10 existing ignores; binary 59 passed with one existing ignore; storage integration 74 passed; platform one; doctests zero. All other Cargo test targets passed. No required all-target test was filtered or ignored. Example targets were built/tested, not example mains. The parent did not rerun these final six gates; these are delegated execution records, independently checked against preserved manifests/logs by completed reviewers. Earlier independent review-c reran all six gates on the pre-B03 794-library source; do not attribute that older run to the current 795-library state.

B04 remediation subsequently passed all six native gates: 796 library passes with 10 existing ignores, 59 binary passes with one existing ignore, 216 integration passes including 74 storage tests, and one example test. Platform and tracked/untracked whitespace checks passed. This is delegated Linux execution, not a parent rerun or final acceptance.

The failed RB-01 remediation left two more test functions in the tree. There are now 29 added A5b1 test functions: 19 original, four initial remediation tests, two A02 tests, one B03 test, one B04 test and two RB-01 tests. Parameter combinations and API assertions are not extra unique tests. Filtered groups overlap and are not added into a task-wide count.

Observed finite measurements after human integrity validation: both 60,000-byte and 6,000,000-byte fields read three descriptors and five chunk rows including the anchor; fetched content bytes 27,246/29,496, encoded pages 33,619/33,616. EXPLAIN reported indexed SEARCH without scan/temp sort. Near-cap legacy page: 524,287 bytes; reduced anchor/entry: 671/1,230 bytes. These are fixture observations, not universal SLAs or a claim that latest-page scaling is already tested.

A genuine independently populated schema2 oversized-summary fixture migrates to3 and gives DisplayUnavailable on its addressed display read. Raw history, canonical rows, receipts, digest and exact retry remain unchanged. A healthy addressed block succeeds. Near-cap traversal restores exact content. No real existing database was inspected.

## Review, verification and remediation history

Results are ordered review-a/review-b/review-c:

| Gate | Dispositions | Action |
|---|---|---|
| Initial A5b1 | CHANGES_REQUIRED / CHANGES_REQUIRED / PASS | Three findings independently reproduced, then one focused remediation. |
| After initial remediation | CHANGES_REQUIRED / PASS / PASS | A02 independently reproduced, then focused remediation. |
| After A02 | PASS / CHANGES_REQUIRED / PASS | B03 independently reproduced, then focused remediation. |
| After B03 | PASS / CHANGES_REQUIRED / FAILED(routes_unavailable) | Gate incomplete; owner later authorized B04 verification and its retry. |
| After B04, initial | PASS / CHANGES_REQUIRED / FAILED(routes_unavailable, invalid_stream) | RB-01 reported; automatic advancement stopped. |
| After B04, owner-directed review-c retry | PASS / CHANGES_REQUIRED / CHANGES_REQUIRED | gpt-5.5 review-c completed and reproduced the same is_error mismatch. Independent verification then confirmed RB-01. |
| After completed RB-01 retry, latest | PASS / PASS / PASS | Three fresh current-increment reviewers found no blocking findings. A5b1 scope reviewed; whole G1 remains unaccepted. |

Confirmed and implemented corrections:

- A01, P2: healthy human upper-zero content cursor falsely returned storage.integrity. Real public API verification preserved all raw/display state and separated actual missing/corrupt human fields. Bounded unfiltered human validation now precedes filtered selection; invalid selection returns CursorInvalid.
- B01, High: a new lower-order delta field entered an old content traversal without epoch change. Public API verification compared lower insertion, higher insertion and existing-field growth. A bounded indexed order lookup now advances epoch only for incompatible lower insertion. Existing field generations/bytes/entry position remain. The current interleaved projector test's unconditional epoch oracle was corrected, not removed.
- B02, P2: deleting the derived actual-result descriptor/chunks left a complete-looking tool page. Public API verification covered nonempty finished and empty pre-finish results. The exact deterministic descriptor now validates independently of the selected fragment and on reuse targets; pending/finish-only/empty actual results remain distinct.
- A02, P2: clearing actual is_error on a recorded result still returned success. Public verification covered 12 valid bool/output/finish combinations and three API paths. Shared Tool/Reuse row validation now requires is_error when result_recorded is true. The pre-fix repository regression missed 48 expected errors; all pass after the fix. No-result controls remain valid.
- B03, P2: a false result flag hid a retained output descriptor. Public verification covered 18 canonical combinations and exact raw preservation. Source::Tool now requires descriptor absence when the flag is false through one indexed SELECT 1, independent of fragment selection. The pre-fix regression missed 120 errors; 36 reuse-target controls already passed. All 156 API checks pass after the fix.

At the after-B03 gate, completed review-a independently ran A5b1 (26), projector (23), identifier (19), legacy (10), wire (13), platform (one), ancestry and whitespace. Latest completed review-b ran A5b1 (26), formatting and whitespace. Both verified current byte manifests and artifact hashes. The failed review-c returns no completed verdict or accepted execution evidence, even if its last diagnostic started.

## Historical after-B03 finding and failed required role

B04, P2, reported by latest review-b: a Reuse entry can carry result_recorded=false while its unchanged reference targets a recorded Tool result. rows.rs:278-294 only requires flag presence; reads.rs:221-232 validates the target but not the reuse's own true result fact; compact.rs:39-53 returns the false flag. The suggested reproducer changes only reuse metadata after a normal ToolResultReused occurrence. This remains source-review evidence, NOT independently verified through a new public API probe. No B04 fix was applied. Completed review findings remain binding pending verification.

Latest review-c failed with routes_unavailable after its only route stalled. Reported elapsed 1214.7 seconds; last active tool ctx_batch_execute elapsed 600.1 seconds. This is an operational delegate failure, not an accepted source or test verdict. No automatic retry or next increment occurred. User direction is required before continuation. Latest review-a PASS does not complete the gate or erase B04.

## Historical owner-directed continuation and first verification route failure

The owner authorized continuation from the completed reviews to verify B04 without retrying the failed previous review run. The parent inspected current HEAD/index, source and protected hashes, then assigned one fresh verification for B04 only.

That verification failed with routes_unavailable in phase complete after its only route returned provider_failed. Reported elapsed: 567.1 seconds; last event: agent_settled. No completed verification report was returned. B04 is still unresolved; the attempted run is not confirmation or a pass. No B04 remediation, fresh review gate or next implementation increment was started. The previous review-c failure remains preserved and was not retried.

Parent checked all 652 files from the last source manifest. Only the four known parent documentation updates differ; there are no unexpected changes. HEAD remains 318b7f0da7d503e2e3a8cf33be84e78ebbe8affb, the index remains empty and whitespace checks pass. No source fix was applied. Automatic advancement stopped at the new required-role failure; further user direction is needed.

## B04 retry, confirmed remediation and fresh review

The owner explicitly authorized retrying verification. The fresh verification completed CONFIRMED/REPRODUCED in /tmp/wi-a5b1-b04-fresh-6Tnm8WI5/REPORT.md. All 12 combinations of actual error flag, empty/nonempty output and absent/before/after finishes returned a false Reuse result flag after changing only that derived flag. Healthy controls passed, canonical/raw/receipt/target/content state remained unchanged and repeated reads performed no repair. All 653 repository preservation records and Git state matched. An initial external SQLx harness compilation failure was corrected only outside the worktree.

The focused remediation changed only src/storage/conversation/projector/rows.rs:285-287 and reads/tests/remediation.rs:359-593. Reuse now requires result_recorded==Some(true) in the shared row validator. The new regression first failed on all 24 repeated reads across 12 cases, then passed after the guard. Pending and finish-without-result Tools and non-tool null flags remain valid. No extra SQL, output copying, replay, repair, API/schema/dependency or identifier policy change occurred. The two-path proof preserves 651 other paths, HEAD, index and status. No required native gate remained failing.

Three fresh reviews then inspected the complete accumulated A5b1 increment, not only the B04 guard:

- review-a completed PASS. It independently ran 76 conversation tests plus observer, identifier, B2, platform, formatting, check, Clippy and whitespace checks. An optional isolated B04 diagnostic timed out; the repository B04 regression passed in the conversation suite. Report: /tmp/wi-review-a-f02L65jr/REPORT.md.
- review-b completed CHANGES_REQUIRED. A5b1 (27), projector (23), identifiers (7), formatting and whitespace checks passed. Its isolated probe reproduced RB-01 below. Report: /tmp/wi-review-b-report-wbVQHK/REPORT.md.
- review-c failed with routes_unavailable/invalid_stream in phase turn_complete after 1718.7 seconds. Last event: message_end. It returned no completed verdict. No automatic retry occurred.

Before updating this evidence, the parent checked all 653 files against the B04 after-manifest with zero mismatches. HEAD/index stayed unchanged and git diff --check passed. B04 is confirmed and fixed, but the full increment is not review-approved.

## Historical after-B04 open finding and failed review role

RB-01, P2, from the after-B04 review-b: a Reuse can publish an is_error value that differs from its unchanged recorded Tool target. The reviewer changed only Reuse is_error from true to false in an isolated probe; conversation_entry returned success. reads.rs:221-232 validates the target but does not compare these immutable result facts; rows.rs:282-293 requires a present error flag; compact.rs:39-53 publishes the copied value. This is reviewer reproduction, not a completed independent verification. No RB-01 remediation was assigned or applied. A verification must check both actual booleans and empty/nonempty output, repeated reads, unchanged canonical/raw/receipts/target/content and healthy controls. Occurrence finish facts remain separate from later target updates.

The latest required review-c failed as recorded above. Automatic advancement stopped before RB-01 verification or the next increment. User direction is required. The completed review-a PASS does not erase RB-01 or complete the gate. Previous stalled-review and provider-failed-verification evidence remains preserved.

## Historical RB-01 verification and failed remediation

The owner requested gpt-5.5/high for future review-c runs in this session. Global routing configuration was not changed. The owner then authorized continuation. The fresh review-c completed with a blocking finding in /tmp/wi-review-c-a5b1-report-20261001/REPORT.md. It independently reproduced the same Reuse is_error mismatch as review-b; the duplicate is consolidated as RB-01. Review-b rated it P2 and review-c rated it High. Eight remediation tests, the B04 regression and 25 read tests passed in a fresh target. A stale default-target test name was not accepted as current execution evidence. The original A5b1 archive and B04 incremental diff were unavailable to both reviewer and parent; current-source review is not a new baseline comparison. Prior artifact hashes and attributed historical evidence remain recorded, not reconstructed.

Fresh verification completed CONFIRMED/REPRODUCED in /tmp/wi-rb01-verify-o36X2cPj/REPORT.md. All 12 primary cases returned contradictory Reuse error flags through the real public API after changing only that derived boolean. Three repeated reads per case performed no repair. Canonical/raw/receipt/head/watermark/target/content state and healthy controls stayed unchanged. Four legitimate controls confirmed that a later target finish leaves the earlier Reuse's finish flag false while the target becomes true. The result error remains equal. Do not require occurrence finish facts to equal later target facts. All 653 repository records, modes, status, HEAD and diffs were preserved. A private toolchain/dependency-resolution difference was corrected before the authoritative stable-toolchain proof; no source policy changed.

The focused remediation delegate failed with routes_unavailable in phase catalog after 3021.5 seconds. Attempts returned catalog_unavailable and invalid_stream. There is no completed remediation report. No automatic retry or new review was started. This is failed delegation with partial tree changes, not completed remediation.

Parent inspected those changes:

- src/storage/conversation/reads.rs:225-230 adds only actual is_error equality to the already loaded target check, with a why comment. No extra SQL, output copying, replay, repair or finish/state comparison was added.
- reads/tests/remediation.rs:595-929 adds one 12-case mismatch regression and one four-case later-finish control. Existing source/test bytes match the pre-remediation hashes after removing only those additions.
- All 653 files were compared with the fresh verification manifest. Only these two source paths differ; the other 651 records are preserved. HEAD/index stay unchanged. Work remains unstaged/uncommitted.

Parent inspected existing execution artifacts in /tmp/wi-rb01-remediation-l5A58ABD without running new native gates. They show a new-test compilation failure, then the expected 24 missing-integrity-error failure, followed by two passing regressions. Formatting, locked/offline all-target check and unfiltered all-target tests have successful command records. Tests: 798 library passes with 10 existing ignores, 59 binary passes with one existing ignore, 216 integration passes including 74 storage tests, and one example test. These are partial execution records from a failed delegate, not a completed report or acceptance.

Clippy's log reports No space left on device (os error 28) while writing its query cache. The Clippy JSON record is empty, so no exact exit code or PASS is assigned. Build, doctest, standalone platform and delegate whitespace records/logs are also empty; they provide no completed evidence. Parent git diff --check passed. The first parent artifact audit encountered JSONDecodeError on the empty Clippy record; a read-only audit that handles empty records identified the actual disk failure. No required failure was filtered or relabeled.

Actual capacity: /tmp is a 16 GiB tmpfs at 100%, with 616 KiB available when checked. The new generated cargo-target cache occupies 6.6 GiB. The repository filesystem has 699 GiB available. No cache was deleted. User direction is needed for cleanup and the failed remediation. Finish the remaining gates and completion/scope report before a fresh three-role review. RB-01 remains open with confirmed evidence and partial code; A5b1 and G1 remain unaccepted.

## Owner-directed command paths and cache cleanup

The owner prohibited new builds, Cargo targets, test workspaces and large artifacts in /tmp. Commands now set TMPDIR=(local record) and CARGO_TARGET_DIR=(local record). The directory resolves to the disk-backed repository filesystem, with 699 GiB available when checked. This does not alter product behavior or global model routing.

The owner authorized cleanup of files created by this task, subject to confirming that no active process needs them. No delegate run was active. Parent checked process command/cwd/executable references and lsof open files before deletion, then repeated those checks in the cleanup command. All four checks found no active references or open files. Only these generated caches were removed:

- /tmp/wi-rb01-remediation-l5A58ABD/cargo-target
- /tmp/wi-rb01-verify-o36X2cPj/target
- /tmp/wi-review-c-target
- /tmp/wi-review-c-probe-target

Reports, logs, baseline records, synthetic stores and probe source remain untouched. /tmp usage fell to 390 MiB, 3%, with roughly 16 GiB available. No remediation retry or new review was started. gpt-5.5 completed review-c; the failed remediation used gpt-6.1-sol. The proposed gpt-5.5 remediation retry has not run. Remediation completion, remaining gates and fresh review are still pending.

## Completed RB-01 retry and current scoped approval

The owner directed the remediation retry to use gpt-6.1-sol. It completed without editing source. Report: (local record). All shell commands/children used the specified disk-backed TMPDIR and CARGO_TARGET_DIR. The original failed remediation remains failed historical evidence.

Fresh retry passed both RB-01 tests, retained guards, focused suites, all six native gates, platform and tracked/66-file untracked whitespace checks. Unfiltered all-target result: 798 library, 59 binary, 216 integration and one example test passed, totaling 1,074 passes; 11 existing ignores, zero failures or filtered tests. Doctests: zero, successful exit. Counts across focused reruns are overlapping and are not added into a task-wide total. The first fresh-target regression command timed out during compilation; a longer-timeout attempt passed. Private whitespace and preservation-audit harness failures were retained and corrected without source changes.

The retry preserved all 653 repository records, byte modes and Git state. Its new rb01-only.diff is a computed two-path comparison with actual pre-RB-01 bytes; it is not the missing historical A5b1 archive. The confirmed guard and regressions remain at reads.rs:225-230 and remediation.rs:595-929. Actual result errors must match; valid later occurrence finish differences remain allowed. Source/Git work remains unstaged/uncommitted.

Three fresh reviewers then inspected the complete current A5b1 source/integration scope:

- review-a PASS: independently ran 27 a5b1-prefixed tests, 78 storage-conversation tests including both RB-01 tests, 12 identifier-storage tests, 13 wire tests, platform, formatting, warning-denied Clippy and whitespace checks. Report: (local record).
- review-b PASS: independently ran 27 read tests, one persistent-observer integration test and whitespace checks. Report: (local record).
- review-c PASS, gpt-5.5/high: independently ran 27 read tests, one observer test, 13 wire tests, 23 projector tests and eight projection tests. A malformed two-filter Cargo command was rejected before execution, then each corrected command passed. Report: (local record).

No blocking finding remains in this increment. Parent inspected all reports and compared all 653 current files/modes with the completed retry snapshot: zero drift before this documentation update. HEAD/index stayed unchanged and git diff --check passed. The 1,074-pass complete native run is delegated execution, not an independent parent rerun. All three review verdicts are current-source increment approval, not missing-archive equivalence or the required final master-to-checkpoint-to-new complete-diff review.

Current implemented/reviewed scope is Rust entry/content reads and DisplayUnavailable. Latest/older/page/change APIs, HTTP/SSE/422 mapping, reconciliation, browser/CI/examples and full G11 closure remain pending. No whole-G1, native macOS, hosted CI, browser or live evidence is claimed. Historical failures and their available artifacts remain preserved.

## Retained initial execution failures

Original implementation retained: empty-human invalid-input fixture; private-safe EntryPage Debug test compilation; bounded creation-validation payload oracle; legacy receipt/getter types; near-cap diagnostic timeout and pagination-count fixture error; Rust minimum-size expression parse error; PersistentObserver finish/result fixture mismatch; formatting/clone-on-Copy Clippy failures; private whitespace exit-status oracle. Each was corrected without hidden exclusions. Details remain in the original REPORT.md.

Initial three-finding remediation: pre-fix one pass/three failures; first post-fix three passes/one tail-preview oracle failure; corrected public traversal oracle then passed. A02 retained the 48-error pre-fix failure, a scoped instruction-inventory timeout and a private whitespace collector correction. B03 retained the 120-error pre-fix failure and new-test formatting failure. B04 retained its 24-error pre-fix failure, new-test formatting failure and private whitespace-harness exit-status correction. The fresh verification retained its external SQLx compilation failure. External verifiers retained probe compilation/cursor-constructor and invalid conflicting-finish/control assumptions; only probes changed. The intentional owned-read synthetic panic is a passing quarantine test, not a regression failure.

## Limits

No G1 acceptance, complete-diff final review, hosted CI, native macOS, browser, managed-auth/live, real credential/private-skill/auth or deployment evidence. Windows support stays withdrawn. Ledger remains31/50 used19 remaining. No source quotas/deletion/retry/resume/auth modes/dependencies were added. General native/generic/account ID policies remain open. Page/change/HTTP/browser work remains unimplemented and must not be described as completed.
