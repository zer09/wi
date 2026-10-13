# A5b3: changed-entity reads and shared integrity checks

Status: **IMPLEMENTED_REVIEWED_SCOPED_OWNER_REDUCED_GATE**. G1.1 remains unaccepted.

## Implemented behavior

- `src/storage/session.rs:116-136` exposes `conversation_changes(after: LiveCursor)` through the existing owned read operation and connection-retirement path.
- `src/storage/conversation/reads/changes.rs:50-171` captures canonical and projection head U in one short read snapshot. The snapshot ends before public return.
- Metadata, blocks and entries merge in numeric sequence/rank and canonical ASCII identity order. Each indexed block/entry partition reads at most 65 keys.
- A batch emits a contiguous prefix of at most 64 self-contained changes within the exact 524,288-byte wire budget. It stops rather than skips an entity.
- Partial batches retain the last emitted tuple, including same-sequence identity ties. Exhausted batches use U's rank-3 watermark, including private-only changes.
- Issued cursors remain usable after a referenced entity advances to a newer saved revision. Coalesced current rows do not promise every intermediate raw event.
- Entry changes include the current block and mandatory human anchor. Shared compact construction preserves content progress and the approved legacy `DisplayUnavailable` classification.
- Addressed cursors validate canonical acceptance and the mandatory human anchor even when no changed entities remain. Missing-resource and wrong-owner precedence remain explicit.

`src/storage/conversation/reads.rs:198-305` supplies shared Tool/Reuse validation to page, entry, content and changed reads. One primary-key lookup selects only canonical result sequence, finish sequence and error flag. It does not fetch saved output or event payloads.

Result and finish presence are independent. A finish sequence must be positive and within the entry revision. Known result or finish evidence requires the actual canonical error boolean. Pending Tools require both canonical and display flags to be null. Existing result descriptors, actual output, generation checks and field ordering remain.

Reuse checks the saved target result and immutable error flag. An earlier Reuse occurrence can retain finish=false after its target records finish=true. No lifecycle event or enum was removed or renamed. Started + ToolResult and clearer enum naming remain separate proposed contract changes.

## Owner-authorized retained test update

`src/storage/conversation/reads/tests/remediation.rs:1130-1230` retains its original function name, pending-null success and healthy finish-only false/true controls. Clearing a known finish flag now requires `storage.integrity` on repeated entry and name-only content reads.

The owner explicitly rejected permissive finish-only-null validation. The exact old file and function remain in:

- (local record), SHA256 `aadf141f542450e6cd42dd16a4601a032370cad14d7282121b27e1788a482fff`.
- (local record), SHA256 `0154a62c2af8021ab1ebe1918e6b680a3e1843cb327ba07b9d507997e549d6aa`.

The old 88-pass/1-fail reader run remains in (local record). No test was silently removed, renamed, ignored or excluded.

## Findings and retained failures

Independent verification preceded each integrity correction:

| Finding | Corrected behavior | Evidence directory under (local record) |
|---|---|---|
| A5B3-A-01 | Rank-2 cursors validate canonical run acceptance. | `wi-a5b3-a01-remediation-Tjzk5M7d` |
| A5B3-RA-02 | Genuine opposite Tool result booleans reject; integer JSON remains a separate malformed-type control. | `wi-a5b3-two-remediation-Z6Lww4sa` |
| A5B3-B-01 | Exhausted rank-1/rank-2 cursors validate the mandatory human anchor without content reads. | `wi-a5b3-two-remediation-Z6Lww4sa` |
| A5B3-RB-01 | Original Tool finish presence agrees with canonical finish evidence, independently of result order. | `wi-a5b3-rb01-remediation-PZqWvv9g` |
| Finish-only error and hidden-result findings | Known finish errors agree with canonical values; removing derived output cannot hide canonical result presence. | `wi-tool-scalars-remediation-g131mdVO`, `wi-tool-null-retained-rrsmQ8Gc` |
| A5B3-REVIEW-B-01 | Pending canonical and display error flags must both be null. | `wi-a5b3-b01-remediation-lIr5h75T` |

Initial compile/fixture failures and strict pre-guard failures remain in those reports and logs. The old idle-interrupted reader run remains UNKNOWN. Its failed delegate is not relabelled completed.

The subsequent direct-Bash run passed 1,135 tests but failed warning-denied Clippy on a nested test conditional. That failure remains in `wi-retained-resume-n5YYhv68`. `wi-clippy-mechanical-HSK8Ql9e` records the test-only let-chain correction and later passing gates. Every Reuse control and assertion stayed unchanged.

The final pending regression retained all 60 missing-Integrity outcomes before its guard. After the guard, all 60 calls reject. Derived-only, canonical-only and combined cases quantify exact one/two-cell changes. Canonical-only damage correctly makes the canonical Tool getter return Integrity; no healthy getter outcome is invented.

## Current execution and review

Latest remediation report: (local record).

All six local Linux native gates passed: formatting, locked/offline all-target check, warning-denied Clippy, unfiltered all-target tests, all-target build and warning-denied doctests. Platform and tracked/untracked whitespace checks also passed.

Unfiltered all-target execution: **1,137 passed, 11 existing ignores, zero failures/filtering**. Components: 861 library, 59 binary, 216 integration and one example-target test. Example test targets do not prove example-main execution. Focused filters overlap this total.

Cargo tests ran through direct Bash with external logs and periodic process/progress checks. Context Mode only inspected completed logs. Exact commands, environments, cwd, exits, times and full logs remain in the evidence directory.

Fresh complete fourteen-path reviews:

| Role | Verdict | Independent execution | Report |
|---|---|---|---|
| review-a | PASS | 91 readers, 23 projector, 13 wire, 4 cursor, 1 observer, 1 platform; format, Clippy and whitespace. | (local record) |
| review-b | PASS | 43 changed-reader, 1 corrected retained, 11 wire, 1 platform; format and whitespace. | (local record) |

Both reviewers inspected the entire original A5b3 baseline-to-current increment and shared integration. Neither reported a finding. The supplied six-gate evidence remains attributed to remediation, not independently rerun by both reviewers. Review-c remains owner-waived and uncounted.

There are 43 changed-reader test functions. Parameter combinations, repeated calls and overlapping filters are not additional unique tests.

## Preservation, measurements and limits

Current source manifest: (local record), SHA256 `0f5c2cc79349b0518949aff642aee9ed1b5d66dd5650dba1aba506c15d6551c8`. Parent and reviewers matched all 677 records: 674 present files and three unchanged historical absences. Reviewers also matched all 1,170 Git-file records. HEAD remains `318b7f0da7d503e2e3a8cf33be84e78ebbe8affb`; index remains empty. All work is unstaged and uncommitted.

The accumulated source scope is fourteen paths, with no new source deletion. Historical handoff absences omitted from an older manifest are not new deletions. Owner assets, generated/untracked work and historical reports remain preserved. Automatic ignored CodeGraph cache changes are recorded separately; caches were not cleaned.

Tests retain indexed bounded candidates at 100/10,000 synthetic blocks, exact byte/count splits, same-sequence/coalesced traversal, sparse MAX and >2^53 controls, snapshots, rollback, duplicates and owned-read lifecycle checks. Scalar EXPLAIN/VDBE checks retain primary-key lookup and exclude the output column. These are finite observations, not universal performance or physical-durability claims.

This is S-level local Linux source and synthetic SQLite/public-library evidence. HTTP/SSE/422, task reconciliation, the offline display example, browser replacement, joined tests, native macOS, hosted CI and final complete-diff review remain open. No G11 row or G1.1 acceptance follows from this scoped gate.
