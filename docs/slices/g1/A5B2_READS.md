# A5b2: latest and backward display pages

Status: **IMPLEMENTED_REVIEWED_SCOPED_OWNER_REDUCED_GATE**. Contract g1.1 remains unaccepted. The owner directed continuation without review-c after that role failed. Fresh review-a and review-b both passed. No third completed review is claimed.

## Implemented behavior

`src/storage/session.rs:94-114` exposes `SessionHandle::conversation_page`. The existing owned `operation(false)` path acquires and retires the session connection. `src/storage/conversation/reads/pages.rs:21-191` captures head and projection in one short read transaction and retires it before return.

Latest selects only the newest human block and a bounded newest activity segment. Before selects one strictly older block. Within selects an earlier segment in the same block. Entries return in chronological order. The human anchor stays in the block header. Previous-block, earlier-activity and per-entry content cursors remain separate. Only Latest returns the matching rank-3 live cursor at its snapshot head.

Reads reuse compact entry/content construction, exact shared wire accounting, UTF-8 scalar progress and retained Tool/Reuse result checks. Limits remain 64 activities, 65 identity candidates, 32,768 encoded bytes per compact entry and 524,288 bytes per page. These are transfer bounds, not stored-history limits. Oversized readable legacy mandatory headers return DisplayUnavailable without rewriting or omitting canonical content. HTTP mapping remains deferred.

## Confirmed findings and corrections

| Finding | Correction |
|---|---|
| RA-01: a missing immediate older projection could look like end-of-history | Compare canonical/projected predecessor run ID and accepted position before emitting previous_block. |
| RA-02: a corrupted present Before boundary could be accepted | Compare exact canonical/projected boundary identities. Both absent stays CursorInvalid; disagreement is Integrity. |
| RB-A5B2-01: selected run IDs could agree while accepted positions differed | Compare selected canonical/projected accepted positions through the existing run-ID indexes. |
| A5B2-MAX-01: H+1 could exceed SQLite i64 when H is representable | Latest/Before bind inclusive H. Within retains its strict tuple boundary. |
| RB-MAX-B-01: Within could accept a surviving projection with a missing canonical event | Reject missing canonical owner after successful addressed lookup. Both absent stays NotFound; present wrong-owner/runless stays CursorInvalid. |

Every finding received independent verification before focused remediation. Strict regressions failed before production corrections and passed afterward. The current source includes all five corrections. No global canonical scan, repair, new SQL statement for the last guard, canonical mutation or provider effect was added.

The accumulated increment changes 11 paths: session.rs, reads.rs, pages.rs, pages/tests.rs, pages/tests/{integrity_tests,lifecycle,max_head,scale}.rs, reads/tests.rs, reads/tests/fixture.rs and reads/tests/legacy.rs. It adds 20 test functions, not the number of parameter cases or repeated reads.

## Review history

| Gate | review-a | review-b | review-c |
|---|---|---|---|
| Original A5b2 | CHANGES_REQUIRED | PASS | PASS |
| After predecessor/boundary fixes | PASS | CHANGES_REQUIRED | PASS |
| After selected-position fix | CHANGES_REQUIRED | CHANGES_REQUIRED | PASS |
| After maximum-head fix | PASS | CHANGES_REQUIRED | FAILED: routes_unavailable |
| After Within presence fix, owner-directed reduced gate | PASS | PASS | Excluded by owner; earlier failure retained |

Current fresh reports:

- (local record)
- (local record)

Both reviewed the complete original A5b2 baseline to current 11-path diff and integration with prior work. Both independently passed 48 conversation-read tests and 11 wire tests. Review-a also passed projector, cursor, observer, platform, formatting, Clippy and whitespace checks. These focused runs overlap the full suite.

The failed review-c stalled during ctx_batch_execute after 812.7 seconds and returned no verdict. It remains FAILED. The owner then requested continuation without review-c. This reduced scoped gate does not invent final three-reviewer acceptance.

## Local execution and evidence

Latest remediation report: (local record). Its command records and logs preserve the final six native gates, standalone platform and tracked/untracked whitespace checks. All passed locally on Linux with locked/offline Cargo resolution.

Unfiltered all-target execution: **1,094 passed, 11 existing ignores, zero failures or filtered tests**. Breakdown: 818 library, 59 binary, 216 integration and one example-target test. Doctests: zero, successful exit. Example-target tests do not establish execution of example mains. The final focused remediation ran 48 read tests and 11 wire tests; those counts are not added to 1,094.

Every command and child uses TMPDIR=(local record) and CARGO_TARGET_DIR=(local record). Current-source build evidence uses RUSTFLAGS='--cfg a5b2_max01_biuto9e0'. External mirror probes used distinct cfg values after a prior review observed a stale shared-target binary. That failed diagnostic remains retained; no cache was cleaned.

Evidence chain:

- Original implementation: (local record); baseline in the same directory.
- Predecessor/Before remediation: (local record).
- Selected-position verification and remediation: (local record) and (local record).
- Maximum-head verification and remediation: (local record) and (local record).
- Within-presence verification and remediation: (local record) and the latest remediation report above.

Initial fixture/compile/format failures, strict pre-fix failures, timeouts and incomplete optional review attempts remain in those reports/logs. Incomplete attempts are not passes. No test was removed, ignored or filtered to hide a required failure.

## Measurements and limits

Exact production query plans use existing indexes without scans or temporary sorting at 100 and 10,000 synthetic older blocks. With two activity entries, selected/decode counts remain 2/2 at both scales; fetched content remains 54,472 bytes for 60,000-byte fields and 56,072 bytes for 6,000,000-byte fields. With 145 activities, candidate/decode counts remain 65/17 and fetched content is 462,952 bytes. Encoded pages stay within the shared cap. Poisoned older headers/text are not decoded by Latest/Within. These are finite synthetic observations, not universal timing, RSS or I/O guarantees.

Maximum-head fixtures have a deliberately sparse canonical prefix. A real final public writer reaches i64::MAX; Latest/Before and strict Within controls pass, including actual activity at MAX. Full-prefix raw history correctly rejects the sparse gap. Current writers create new entries at slot zero; inclusive SQL includes all slots by construction, but no fabricated multi-slot production proof is claimed.

Within corruption fixtures temporarily bypass immutable-trigger/FK protections to remove one interior event. Exact trigger restoration and reenabling FK enforcement precede reads. Full raw history correctly reports Integrity. Repeated display reads preserve logical tables, schema, populated raw ranges and every receipt. Normal writers did not create this damage. Logical preservation is not WAL/filesystem-byte durability proof.

## Preservation and deferred work

Before this documentation update, all 662 records, modes and Git metadata matched the latest source manifest. HEAD remains 318b7f0da7d503e2e3a8cf33be84e78ebbe8affb; the index is empty. Manifest SHA256: c2ed0f4c599494e6175546fc4bf1b909632c5308fea22838b0b901dbc9155479. Current final reviews changed no repository path.

All work remains unstaged and uncommitted. Historical g1.0 evidence and earlier failures remain unchanged. No credentials/private skills/auth commands/live generation, hosted operation, Windows restoration or dependency change occurred. Ledger unchanged.

Next scope is conversation_changes, followed by HTTP/SSE and reconciliation, then browser replacement and final closure. No macOS, hosted CI, browser, HTTP, joined producer or whole-G11 acceptance is claimed here. Formal matrix counts remain 17 PARTIAL and 23 NOT_RUN; no accepted row is added by this scoped report.
