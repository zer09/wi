# V1-B merge review and native-platform follow-up

Date: **September 20, 2026, Asia/Manila**. Owner-authorized follow-up to PR #9.
Contract `v1b.0` retains its runtime/API semantics. Native support is now governed by
[PLATFORM_SUPPORT.md](../../PLATFORM_SUPPORT.md). This record is separate from the
original [verification](VERIFICATION.md) and [machine evidence](verification.json).

## 1. Reviewed input and disposition

Submitted head: `f0adbddc31cc1f967ccb2df68c3481b2c7ff5b53`.
Original tested source: `6e28cc339f25a95b78170e7c4171de48f122d07a`.
Accepted foundation: `16d623a3317abc7796ec203e4fe15d580791a769`.
The original report remains LOCAL_VERIFIED, accepted=false, 38 PASS/2 PARTIAL.
Its local commands and independent-agent reviews remain attributed evidence.

The planner's scoped source-and-evidence review found no new confirmed Linux/macOS
V1-B production blocker. Reviewed paths include HTTP auth/authority/origin/body
checks, raw-command receipt reconciliation, actual preparation and host dispatch,
closed event/error projection, canonical SSE reads, network shutdown and real joined
HTTP -> RunHost -> B2 -> SQLite -> OpenAI-loopback -> tools fixtures. This is not a
complete security audit, exhaustive codebase proof or independently rerun local suite.

Original head CI was observed green: PR35451748311 attempt1 and push35451745622
attempt2. The earlier Windows request watchdog remains historical and is not declared
fixed. The owner then explicitly withdrew Windows support and authorized same-PR
CI, code/test removal and documentation alignment commits.

## 2. Published support-policy changes

| Revision | Purpose |
|---|---|
| `4e79cffb0e0f9fec63b0810e06cdc25082a90185` | Remove only the Windows runner; retain Ubuntu/macOS and all six Cargo gates. |
| `3ccf63d7931c3e4d3c7454edc67fe6e1b87f3a90` | Add first-party native-platform removal inventory. |
| `b2ba6c69aa7b3957fea4b4ce9a5010595eb23148` | Remove Windows filesystem/signal branches and correct inventory formatting. |
| `4edb2d73a6c52b6617feecb60d18cfab0c510150` | Remove the ten remaining Windows-only test accommodations, preserving applicable Unix/portable assertions. |

Production edits are confined to Windows-only branches in context, HTTP file opening,
storage file validation and service CLI signals. Unix permission, no-follow,
nonblocking-open, hardlink, root-identity and signal behavior remains. Test edits
remove Windows-only reparse tests, SystemRoot carry-through and Windows filename
alternatives. Full published commit patches were inspected for accidental unrelated
assertion changes. An unreferenced draft containing unintended test-tail changes was
rejected before branch publication; only the corrected narrow diff was pushed.
No dependency, lockfile, schema, provider/auth policy, execution limit or live behavior
was added. Windows transitive lock entries and historical report data remain.

## 3. Retained failures and exact-source CI

The first planner-added inventory revision stopped at rustfmt before test execution.
The formatting correction was applied rather than disabling the gate. At b2ba6c6,
existing runtime suites passed before the new inventory rejected ten remaining
Windows test branches; downstream gates did not run in that failed job. The inventory
finding drove the narrow 4edb2d7 cleanup. These were intermediate incomplete-removal
checks, not evidence that V1-B's production behavior failed.

At **4edb2d73a6c52b6617feecb60d18cfab0c510150**:

| Workflow | Run | Attempt | Ubuntu | macOS |
|---|---:|---:|---|---|
| Push | 35458188836 | 1 | PASS | PASS |
| Pull request | 35458191471 | 1 | PASS | PASS |

Every job passed formatting, all-target check/test, warning-denied Clippy, build and
the doctest command. The new platform inventory passed. Local Cargo/Node/examples
were not rerun by the planner; those original counts are not new-head local evidence.
Documentation descendants require their own exact-head CI before merge. Their later
closure belongs on PR #9, not a claim that these source runs tested future commits.

## 4. Requirement applicability

V1B-03 and V1B-33 retain all non-Windows requirements. Their original native Windows
proof gaps are **WITHDRAWN_BY_OWNER**, not PASS, waived proof or a repaired Windows
implementation. All other V1-B assertions retain their original semantics. The frozen
40-row matrix and original evidence remain unchanged. Technical acceptance for the
supported scope depends on the reviewed changes and final retained-platform CI;
merge state must be read from PR #9 rather than inferred from this pre-merge record.

## 5. Documentation alignment and bounded audit

Current README, API, SECURITY, AGENTS and slice register separate original evidence
from the new platform policy. Native Windows signal/filesystem/provisioning claims
are removed from active service usage. V1-A's old open/draft statement is qualified
by its actual merged state. The unverified Rust-1.94 minimum statement is replaced
with the repository's stable toolchain; no new minimum-version claim is made.
Older reference-page platform remarks are superseded explicitly by the dated policy,
not permission to resurrect removed code. Historical source paths/counts stay intact.

Runtime/API producer-consumer paths reviewed still agree on actual commit receipts,
raw retry identity, static error mapping, private native/binding exclusion, qualified
cursors, one-record/one-view projection, no duplicate final answer, short storage
reads and explicit shutdown. This review does not promise that no other code/doc
inconsistency exists. The fresh local follow-through below is required; do not label
it performed by the planner or make it an excuse to start a larger feature silently.

## 6. Mandatory next fresh-agent audit

Before the next feature edits, inspect the complete f0adbdd-to-follow-up diff and
current tracked/untracked source. Run the platform inventory and independently check
Windows-only branches/scripts, process launchers, executable suffixes, path fixtures,
current platform/security/usage documentation and the two retained CI jobs. Confirm
Unix protections and shared tests were not lost. Distinguish portable APIs, negative
fixtures, historical references and third-party target metadata from removed support.
Run all six Cargo gates, verify.py, Node self-tests and all eight offline examples;
record actual results and any discrepancy. Do not port managed auth or reintroduce
Windows to make a historical report's old expectation pass. Additional changes need
the next assignment's scope and owner Git authorization.

No real credential/private-skill access, authentication command, provider generation,
release or deployment occurred in this follow-up. Ledger stays **31/50 used, 19
remaining**, not permission to call a provider. No GUI implementation is included.
