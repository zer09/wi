# Wi: V1-B review and native-platform follow-up

The V1-B HTTP implementation is present in PR #9. Accepted runtime foundation:
`16d623a3317abc7796ec203e4fe15d580791a769` (V1-A merge).
Original submitted head: `f0adbddc31cc1f967ccb2df68c3481b2c7ff5b53`.
Platform-cleanup source: `4edb2d73a6c52b6617feecb60d18cfab0c510150`.
Its push 35458188836 and PR 35458191471 each passed all six Cargo gates on
Ubuntu and macOS. This statement is exact-source CI, not local execution or
CI for a later documentation head. Check the actual current PR state before
claiming a merge. Do not resume old implementation prompts automatically.

## Current owner decision

Native Windows backend support is withdrawn as of September 20, 2026.
Read docs/PLATFORM_SUPPORT.md and docs/slices/v1b/PLATFORM_FOLLOWUP.md first.
Linux/macOS CI and their six existing Cargo gates remain. No native Windows
runner, first-party reparse-point/signal implementation or Windows-only test
accommodation should be restored. Third-party lockfile target metadata and
historical Windows test results are not first-party platform support.
This does not ban Windows browser clients or change Linux-in-WSL semantics.
Existing Linux-only managed-auth filesystem behavior remains Linux-only; no
new macOS auth or live-provider guarantee follows from Cargo CI.

The original V1-B report remains LOCAL_VERIFIED, accepted=false, 38 PASS/2 PARTIAL
at its original source. V1B-03's Windows token proof and V1B-33's Windows Ctrl+C
proof are withdrawn from current applicability, not retroactively executed.
All non-Windows assertions, privacy checks and core behavior remain required.
Frozen CONTRACT/MATRIX/VALIDATION/IMPLEMENTOR_PROMPT and old verification reports
are historical evidence. The dated support policy supersedes only their platform
applicability; it does not authorize skipping remaining tests or new features.

## Required fresh-agent check

Before the next authorized feature, independently inspect the complete accumulated
change from f0adbdd through the accepted follow-up, including tracked/untracked work.
Run `cargo test --test platform_support`, manually audit native-platform branches,
process launchers, suffix/path alternatives, filesystem and signal code, current
usage/security documentation and retained CI. A lexical scan alone is not proof
of complete removal. Check that Unix permission/no-follow/hardlink/signal tests
were preserved and the retired Windows-only tests were not shared regressions.
Run the normal six Cargo gates, `uv run scripts/verify.py`, Node self-tests and all
eight offline examples. Record actual commands and counts separately from historical
ones. Preserve failures and report any residual discrepancy before broadening scope.

## Fixed foundation and invariants

Gateway/managed auth, M3/C1, S1/S2, R1/NB-02, P1-A storage, B1 capture, B2 replay
and V1-A ownership remain accepted dependencies. V1-B uses HTTP JSON plus committed-
history SSE over RunHost/B2/SQLite. Dispatch, durable acceptance and actual completion
remain different. Dropping HTTP clients/tickets/readers never cancels the host run.
Cancellation is explicit and session/run addressed; shutdown drains while storage
is writable before closing it. Restart performs no model/tool/task resumption.
Empty application conversations have empty replay; a fresh provider connection is
not a new application conversation. Incomplete/unbound history remains readable
without automatic repair, truncation, account adoption or reexecution.

Service authentication is a separate provisioned owner bearer secret, not provider
OAuth or API billing. Preserve loopback binding, same-host HTTPS proxy requirements,
authorized workspaces, strict request parsing and closed browser projections.
Core APIs and sessionDB2/catalog1/stored1/runtime2/provider1 are unchanged.
No RunLimits, optional budgets, global call quotas, whole-task deadlines, lifetime
history caps, deletion, retries/failover, hosted skills, new executors/providers,
permission framework or unrelated reorganization follows from this task.

## Evidence and authority

Read the current V1-B API and SECURITY documents, then frozen requirements and
original VERIFICATION.md/verification.json plus the separate platform follow-up.
Source review is not test execution; same-SHA rerun success is not a fixed-flake
claim; old fingerprints apply to their original snapshots, not changed source.
Current source/CI observations are separate from local implementation and reviewer
reports. No new independent local-agent review was performed by the planner.

The owner authorized PR #9 support-policy/code/docs commits and conditional merge.
Any next local implementation commit/push/merge/release/deployment needs its own
permission. The planner's follow-up does not grant live access. Use synthetic roots,
skills, owner/provider credentials and loopback/scripted providers only. No real
credentials/private skills, auth commands or provider generations. Ledger remains
31/50 used, 19 remaining; balance is not authorization. Preserve owner work; no reset,
clean, forced checkout or unsolicited stash. Report exact producer/consumer evidence
for a genuine contract conflict instead of inventing another architecture.
