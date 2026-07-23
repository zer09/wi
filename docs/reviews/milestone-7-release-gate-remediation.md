# Milestone 7 release-gate review remediation

Status: **READY FOR INDEPENDENT REVIEW — implementation and automated gates passed.**

The second adversarial review and final evidence are recorded in [Milestone 7 release-gate remediation 2](milestone-7-release-gate-remediation-2.md).

Review target: `dd932c9c774aa9c28c68f7aff66690a5b2c526f3` plus the unstaged Milestone 7 implementation worktree.

This ledger validates the local Milestone 7 release-gate review. A finding should be reopened only with a new reproducer against the current worktree.

## Validation and resolution

| Finding | Validation | Resolution |
| --- | --- | --- |
| Partial catalog repair is not restart-safe | **Confirmed, High.** Startup used only the catalog worker's process-local `catalogCreated` observation. A crash after one reconstructed row left a valid but incomplete catalog that skipped discovery on restart. | Catalog repair state is durable and fresh/replaced catalog initialization commits its repair intent atomically. Restart resumes any marked repair and idempotently reconciles rows already written. Test-only repair failpoints exercise continuation. |
| Storage failpoints bypass the second gate | **Confirmed, High.** `allowTestOperations` plus `NODE_ENV=test` reached process-exit branches without `WI_ALLOW_TEST_FAILPOINTS=1`. | Ordinary test operations and process-exit failpoints now use separate worker capabilities. The failpoint capability requires `allowTestOperations`, `NODE_ENV=test`, and `WI_ALLOW_TEST_FAILPOINTS=1`. A child-process probe removes the allow environment variable, attempts the direct storage failpoint, requires `storage.worker_failed`, and verifies no event was stored. Existing crash tests explicitly provide both gates. |
| Scanner enumeration is unbounded | **Confirmed, Medium.** `readdirSync()` materialized complete directories and invalid entries did not consume the record limit. | Discovery now streams `fs.Dir` entries through one prefix handle and one nested session handle. Session records retain the configured 1–10,000 cap; all inspected entries share a second hard cap of `min(40,000, sessionLimit * 8 + 256)`. A 300-invalid-entry tree with `sessionDiscoveryLimit: 1` must fail with `storage.resource_limit`. |
| Failpoint process assertions do not prove the matrix | **Confirmed, Medium.** Provider-text and terminal windows allowed zero terminal events and did not assert their exact durable outcomes. | Every workflow case now waits for and requires exactly one expected terminal event. Provider-text recovery stages a complete tool call before committed text, then requires the same ledger row to be `discarded` with attempt count zero, committed text delta, exactly one `run.interrupted`, no assistant completion, and no tool execution. Terminal-commit recovery requires exactly one `run.completed`, retained assistant completion, and no interruption. Replayed event IDs must be unique. Existing tool cases retain ledger-row, attempt-count, and one-execution assertions. |
| Required shutdown/recovery probes are absent | **Partially confirmed, Medium.** Pending-input real-process recovery, partial repair, repeated pending approval, approval-resolution death, replay shutdown, catalog-observation shutdown, and blocked storage-request shutdown were absent. The review's demand for a separate process probe for every shutdown component is broader than the implementation prompt; lower-level timeout tests and Milestone 5 provider/tool/HTTP/WebSocket isolation tests already cover several phases. | Added real-process probes for all named missing recovery states and for SIGTERM during replay/catalog observation. Added a blocked session-worker request with a concurrent timeout: shutdown remains bounded, exits nonzero with a diagnostic, and restart recovers canonical data. Existing Milestone 5 noncooperative provider/tool and HTTP/WebSocket lifecycle probes remain authoritative for those phases. No speculative production hook was added solely to make every internal close method ignore shutdown. |
| Windows cleanup does not terminate descendants | **Confirmed, Medium.** Windows called `child.kill()` only on the direct process. | Windows cleanup now invokes `taskkill /pid <pid> /t`, adding `/f` for `SIGKILL`; POSIX retains detached process-group signaling. Pure unit coverage fixes the Windows/POSIX command plan, and process assertions accept Windows termination semantics rather than requiring a POSIX signal code. Real Windows execution remains a CI/platform verification responsibility. |

## Additional scanner validation

The repaired process suite now proves:

- a healthy catalog starts and serves bootstrap even when both session database files have been moved offline, demonstrating that startup did not open them;
- a corrupt database and a valid database copied under a different generated session ID are both classified unavailable and quarantined;
- a valid ID under the wrong prefix is ignored and left untouched;
- a session-directory symlink is not followed on POSIX and creates no catalog row;
- invalid-entry floods hit the entry budget rather than materializing the whole tree;
- a repair crash after one row retains a durable continuation marker and reconstructs every session on restart.

The scanner no longer sorts directory listings because sorting requires materialization. Determinism does not depend on enumeration order: the generated layout admits one canonical path per session ID, wrong-prefix entries are ignored, and manifest/path mismatches are always quarantined.

## Recovery and shutdown validation added

- repeated restart while an approval remains pending;
- approval resolution committed immediately before process exit, followed by same-command duplicate reconciliation;
- repeated restart while a pending input remains unresolved, one durable resolution, and duplicate same-command retry;
- SIGTERM during historical replay;
- SIGTERM while a committed catalog observation is blocked;
- blocked session-worker request timing out during shutdown, followed by successful restart;
- exact provider-text interruption and exact terminal-commit preservation;
- partial catalog repair crash/restart via exit code 99.

## Implementation boundaries and residual risks

- Catalog schema version is now 4. Session schema version is now 4; the v4 migration advances `manifest.schema_version` and adds immutable creation provenance.
- A marked incomplete repair with repair mode `off` fails startup rather than serving a knowingly partial catalog.
- The separate entry budget intentionally exceeds the session-record cap by bounded metadata/invalid-entry overhead. It is not an alias for the record cap.
- Shutdown carries one absolute deadline through transport, runtime, and storage. A timed-out storage worker retains close-RPC diagnostics, forces worker boundaries, and exits nonzero; restart recovery remains the source of truth.
- Windows descendant termination is unit-validated as a `taskkill /t` plan but was not executed on Windows in this Linux worktree.
- `prompts/` remains a local workflow artifact and is not part of the remediation.

## Verification

| Command/probe | Result |
| --- | --- |
| `pnpm lint` | Passed through `pnpm check` |
| `pnpm typecheck` | Passed through `pnpm check` |
| Focused process-harness/property tests | 2 files, 3 tests passed |
| Focused storage integration suite | 59/59 passed |
| Focused storage recovery process suite | 13/13 passed |
| Focused Milestone 7 process suite | 25/25 passed |
| Real POSIX descendant cleanup | 2/2 passed |
| `pnpm check` | 63 files, 791 tests passed; lint, typecheck, all unit/integration/property/process tests, build, and package-export verification passed |
| `pnpm test:e2e` | 33/33 passed |
| `git diff --check` | Passed |
| Cleanup check | No matching fixture process, `wi-m7-*` home, or `wi-e2e-*` home remained |

Implementation and automated local gates are green. Independent release-gate review remains pending; this ledger does not claim PASS.
