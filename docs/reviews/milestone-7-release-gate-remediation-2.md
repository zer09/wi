# Milestone 7 release-gate remediation 2

Status: **READY FOR INDEPENDENT REVIEW — implementation and automated gates passed**

Review target: `dd932c9c774aa9c28c68f7aff66690a5b2c526f3` plus the unstaged Milestone 7 worktree.

This ledger validates the second local Milestone 7 release-gate findings and records the resulting remediation. It does not claim an independent PASS. No accepted ADR was changed.

## Findings and resolutions

| Finding | Validation | Resolution and evidence |
|---|---|---|
| Pre-marker catalog crash can skip repair | **Confirmed, High.** A replacement catalog could become valid before manager-level repair intent was written. | Fresh/replaced catalog initialization now commits `catalog_repair_state` in the same migration transaction. Exit 100 (`after_catalog_replacement_before_repair`) is exercised for both missing and corrupt catalogs through two consecutive crashes, followed by complete reconstruction. |
| Provider/tool/run recovery requires browser activity | **Confirmed, High.** Actor initialization was previously lazy behind commands/subscriptions. | A catalog recovery candidate is committed before any nonterminal session write and cleared only from canonical terminal observation. Runtime startup paginates all candidates and adopts actors before browser work. A process test crashes before catalog observation, restarts without HTTP/WebSocket activity, kills the restarted server, and verifies durable interruption with no nonterminal run. |
| Explicit repair destroys a healthy catalog | **Confirmed, High.** Force mode replaced healthy catalog storage and lost catalog-only data. | `WI_CATALOG_REPAIR=1` marks healthy catalogs `explicit` and reconciles in place. Integration coverage verifies the catalog inode, accepted global command, and unavailable row survive with no quarantine. A process test crashes mid-explicit repair and verifies marker-driven continuation and command idempotency. |
| Total reconstruction loses `session.create` idempotency | **Confirmed, High.** Session manifests lacked canonical global-command provenance. | Session schema v4 stores immutable creation provenance. Repair reconstructs accepted commands and verifies payload, session/event identity, result, and acceptance timestamp exactly. Process coverage retries the original command after catalog deletion (`duplicate: true`), rejects different content, and retains one session. Legacy v1-v3 databases explicitly cannot reconstruct already-lost command IDs. |
| Healthy lazy opens can follow paths outside `WI_HOME` | **Confirmed, High.** Catalog-backed opens used lexical containment and followed symlinks. | Catalog paths must equal the generated path. Worker validation rejects symlinked components, verifies sessions-root realpath containment, and compares pre/post file identity. Integration coverage moves a session outside `WI_HOME`, substitutes a symlink, and verifies rejection without modifying the external database. |
| Hyphen-derived prefixes are omitted | **Confirmed, Medium.** Scanner prefix grammar differed from the session-ID grammar. | Path generation and discovery share `sessionPrefixFromId`/`isValidSessionPrefix`. Process reconstruction covers `ses_a-review`; a 1,000-case property verifies every generated valid session ID has one scanner-valid canonical path. |
| Transient scanner failures are quarantined | **Confirmed, Medium.** Operational errors fell through to corruption. | Busy, permission, descriptor, full-disk, SQLite-open/I/O, generic I/O, and resource-limit errors are classified operationally. Repair retains its marker and performs no unavailable-row write or rename. Permission-denied coverage verifies canonical files remain and a later restart succeeds after the fault is removed. |
| Discovery is writable, migrating, and insufficiently bounded | **Confirmed, Medium.** Discovery reused the writable repository and materialized unbounded database-derived data. | Discovery now uses a read-only/query-only, non-migrating reader with database, title, event/provenance JSON, pending-row, entry, record, and response budgets before parsing/return. A retained v1 process fixture verifies byte-for-byte database stability, schema version 1, and no WAL/SHM sidecars. Oversized canonical data produces a retained operational repair failure rather than quarantine. |
| Scanner/lazy-open validation has TOCTOU exposure | **Partially confirmed, Medium.** Persistent substitution was exploitable; a narrower hostile same-user race remains. | Persistent substitution is closed with component, realpath, and pre/post inode checks for both discovery and lazy opens. Full same-user race resistance would require a stronger handle/openat-style boundary and remains a documented v0.1 hardening limit. |
| Storage shutdown lacks an independent deadline and diagnostics | **Confirmed, Medium/High.** Per-request timeouts did not prove one server-owned deadline, and close failures could be suppressed. | One absolute deadline flows through transport, runtime, storage drains, and worker close. Close-RPC failures remain aggregated after forced worker termination. The process test blocks a worker beyond its 60-second request timeout, uses a 1-second server deadline, requires bounded nonzero exit and a structured `server_shutdown_diagnostic`, then verifies restart recovery. |
| Process harness can leak descendants | **Confirmed, Medium.** Cleanup could stop after direct-child exit or wait indefinitely. | POSIX cleanup always signals and verifies the detached process group, escalating under bounded waits. Real process tests cover a live leader and a leader that exits before cleanup. Windows uses bounded `taskkill /t` planning and surfaces failure; real Windows execution remains a Windows-CI responsibility. |

## Additional regression coverage

- Every post-acceptance workflow failpoint retries the original command ID and requires `duplicate: true`.
- Provider-text recovery proves committed text, discarded staged tool state, zero execution, and one interruption.
- The two-consecutive-publication-crash test no longer races a browser connection against backend-owned startup recovery; three consecutive isolated repetitions passed.
- The blocked-worker test operation observes its pending RPC immediately, preventing an unhandled-rejection process exit from bypassing shutdown diagnostics.
- Healthy force repair rejects noncanonical catalog path changes.
- Discovery entry floods remain bounded independently from valid-session count.

## Verification

| Command/probe | Result |
|---|---|
| Focused process-harness/property tests | 2 files, 3 tests passed |
| Focused storage integration suite | 59 tests passed |
| Focused Milestone 7/storage/descendant process suites | 3 files, 40 tests passed |
| Consecutive publication-crash repetition | 3/3 isolated runs passed |
| `pnpm check` | 63 files, 791 tests passed; lint, typecheck, all tests, build, and package-export verification passed |
| `pnpm test:e2e` | 33/33 passed |
| `git diff --check` | Passed |
| Cleanup inspection | No matching fixture process or `wi-m7-*`, `wi-e2e-*`, or `wi-process-*` temporary home remained |

## Residual limits

- Pragmatic path/realpath/inode checks do not promise resistance to a hostile same-OS-user filesystem swap between checks.
- Real Windows junction and descendant-tree execution was not available on this Linux host; Windows command planning and bounded failure handling are unit-covered.
- Retained session schemas before v4 cannot reconstruct a global creation command ID that was never stored canonically.
- Total catalog loss still requires explicit project re-registration because project paths/configuration are intentionally catalog-only in v0.1.

Changes remain unstaged and uncommitted. `prompts/` remains a local workflow artifact and was not modified.
