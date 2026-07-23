# Milestone 7 release-gate remediation 18

Status: **RESOLVED — independently verified at `fcf5f9fd755d8bba6d441bcac7d758158d53d4ab`**

Starting head: `27207689863b2cb8837aa2d6caa660c0af7eaf25` on `milestone-7-crash-recovery`.

Initial H2 commit: `64e68082047a59203b03aa93c0370329680ca14d`.

Stable ID: `WI-M7-H2` — unavailable sessions bypass storage isolation.

## Before-fix evidence

Two retained regression tests failed before production changes:

| Reproducer | Before-fix result |
|---|---|
| Normal APIs against catalog rows changed to `unavailable` and `missing` | `openSession()` resolved a `SessionClient` instead of rejecting; lazy reconciliation could read the preserved database and promote the row. |
| Generic reconciliation with a matching `unavailable` expected status | Catalog status changed from `unavailable` to `ready`. |

The old flow checked catalog status in browser/server call sites but `SessionStoreManager.openSessionInternal()` accepted every catalog status. `SessionClient` reads called generic reconciliation, and `CatalogRepository.reconcileSession()` upserted `ready` even when the inspected row was `unavailable` or `missing`. Direct `CatalogClient.createSessionIndex()` could also overwrite a non-ready row with `ready`.

## Correction

- `SessionStoreManager` now treats catalog status as authoritative before registration and before every client read, recovery, command acceptance, and append.
- A non-ready rejection closes any retained lazy session-worker handle before returning `storage.corrupt`, `storage.session_missing`, or `session.not_found`.
- Cached reconciliation never bypasses the current catalog check.
- `CatalogReconciler` rejects non-ready rows before inspection, rechecks status after worker-contained inspection, and closes the handle if status changes.
- Generic catalog reconciliation cannot promote `unavailable` or `missing`, including with a forged matching expected status.
- Normal `createSessionIndex` cannot overwrite a non-ready row with `ready`.
- The complete bounded repair scanner uses a package-internal validated-repair capability.
- Validated repair promotes only after the existing worker-contained path, identity, schema, size, manifest, projection, and creation-provenance checks complete.
- No catalog/session cross-database transaction was introduced.
- Browser/router status checks remain defense in depth.

## Independent verdict on the initial correction

The independent verifier reproduced the expected manager/server behavior and every committed regression, but classified `64e6808` as **NOT RESOLVED**:

1. The symbol-keyed validated-repair method was discoverable through `Object.getOwnPropertySymbols(CatalogClient.prototype)` and could promote a forged unavailable row without scanner validation.
2. `SessionStoreManager.sessions`, the root-exported `SessionWorkerPool`/`SessionClient` constructors, and `SessionClient.pool` exposed hookless access. The verifier read and appended directly to an unavailable database, changed its event head, and left its worker handle open while catalog status remained unavailable.

The report also identified the earlier test gap: integration coverage used the pool directly as an observation oracle but did not treat that root-visible pool as a public bypass.

## Follow-up correction

- `CatalogClient` RPC ownership moved to module-closure `WeakMap` state. The validated-repair call remains a relative internal module function used by the scanner, but no RPC field or repair symbol exists on client instances or prototypes.
- `SessionStoreManager` now stores its pool in a JavaScript `#sessions` field.
- `SessionClient` now stores its pool and lifecycle hooks in JavaScript private fields, preventing a manager-created client from leaking the pool reflectively.
- The normal `@wi/storage` runtime entry point no longer exports `SessionWorkerPool` or `SessionClient` values. `SessionClient` remains available as a TypeScript type for consumers of manager-produced clients.
- Build-time package-export checks now fail if either internal constructor reappears.
- Tests that need worker failpoints or direct diagnostics use an internal testing accessor. It is absent from package exports, requires `NODE_ENV=test`, and is never attached to a production manager.
- Retained negative tests prove the manager, client, catalog client, and normal package entry point expose no ordinary hookless or validated-repair route.

## Independent verdict on the API follow-up

The fresh verifier confirmed the original promotion defect and both reflective/public-surface bypasses were corrected, but classified `5abfc8f` as **NOT RESOLVED** because a status transition could commit after a client's final readiness check while its mutation waited in the session-worker queue. Releasing the worker then committed the append while the catalog already said `unavailable`. The verifier also found a nonblocking lifecycle race in the empty-catalog rebuild test because it called the public reconciler before awaiting manager readiness.

## Commit-time follow-up correction

- A FIFO per-session coordinator serializes manager-created client use with every catalog operation that can insert or change session status, including separately constructed catalog clients for the same normalized storage home.
- Client read/recovery guards span the final readiness check through the complete session-worker response.
- Command and append guards likewise span reconciliation, recovery-candidate marking, the final readiness check, and the complete worker commit response.
- A status transition requested during in-flight work waits. Later work queues behind the transition and rechecks the committed non-ready status before worker use.
- Nested status classification caused by a worker failure reuses the held session boundary instead of deadlocking.
- Catalog reconciliation inspection uses the same boundary through its worker-contained reads and catalog compare-and-swap.
- The retained blocked-worker regression reproduces the verifier's exact interval. It also uses a separately constructed normal `CatalogClient`, proving the coordination cannot be bypassed by opening another client for the same home.
- The empty-catalog rebuild test now awaits `SessionStoreManager.ready()` before invoking direct reconciliation.
- Coordination is process-local and introduces no catalog/session cross-database transaction. Hostile concurrent same-user processes remain outside the accepted v0.1 threat model under ADR-0012.

## Retained classifications and regression evidence

Process regressions now exercise preserved databases produced by the real repair classifier:

- two structurally valid databases with conflicting creation-command provenance;
- one semantically invalid creation-provenance database;
- one oversized but SQLite-readable database.

For those rows, normal open, direct manager command acceptance, and direct manager append reject. Catalog status, session event head, and DB inode identity remain unchanged; an unrelated ready session remains usable. Separate integration coverage proves cached clients reject reads and writes and that rejected sessions have no retained worker handle.

A deterministic server race returns a stale `ready` row from the command-router precheck only after atomically changing the catalog row to `unavailable`. Storage acquisition rejects before actor construction, the registry retains no actor, the worker retains no session handle, and the event head/file inode remain unchanged.

A healthy canonical replacement remains blocked during normal startup. A later explicit complete repair validates it and is the only path that restores `ready`. Migration-failure recovery tests likewise require explicit repair after the failed migration has marked the row unavailable.

## Initial-correction verification evidence

| Command/suite | Result |
|---|---|
| Pre-fix focused regressions | 2 failed as expected |
| Focused H2 integration/process regressions | 3 files; 10 passed |
| Full `tests/integration/storage.test.ts` | 63 passed |
| Full `tests/integration/milestone5-server.test.ts` | 86 passed |
| Full `tests/process/milestone7-recovery.test.ts` | 49 passed |
| `pnpm test:unit` | 40 files; 453 passed |
| `pnpm test:integration` | 6 files; 255 passed |
| `pnpm test:process` | 8 files; 90 passed |
| `pnpm check` | 66 files; 855 passed; no skips |
| `pnpm test:e2e` | 33 passed |
| Lint, typecheck, build, package exports, `git diff --check` | Passed |

No `.only`, `.skip`, or `.todo` was added. Exact-v3 migration, healthy lazy open, catalog projection races, explicit repair idempotency, recovery-candidate paging, browser unavailable-session behavior, H1 regressions, and Linux process ownership remain covered.

## Follow-up verification evidence

| Command/probe | Result |
|---|---|
| Retained public-surface regressions before follow-up | 2 failed as expected |
| Focused manager, reconciliation, server-race, and public-surface tests | 5 passed |
| Full storage + Milestone 5 server integration files | 151 passed |
| `pnpm test:unit` | 40 files; 453 passed |
| `pnpm test:process` | 8 files; 90 passed |
| `pnpm check` | 66 files; 857 passed; no skips |
| `pnpm test:e2e` | 33 passed |
| Build-time package export audit | Passed; internal constructors absent |
| Normal-runtime reflection probe | No pool/RPC own field, prototype symbol, manager/reconciler pool, or internal runtime export; temporary home removed |
| Lint, typecheck, build, `git diff --check` | Passed |

## Commit-time follow-up verification evidence

| Command/probe | Result |
|---|---|
| Retained blocked-worker regression before production correction | Failed as expected: status transition won and the blocked append later timed out during test cleanup |
| Coordinator unit tests | 2 passed; same-session FIFO, cross-session concurrency, and same-session reentrant coordination covered |
| Focused H2/fault-race integration tests | 7 passed |
| Full storage integration file | 66 passed |
| `pnpm test:unit` | 41 files; 455 passed |
| `pnpm test:integration` | 6 files; 258 passed |
| `pnpm test:process` | 8 files; 90 passed |
| `pnpm check` | 67 files; 860 passed; no skips |
| `pnpm test:e2e` | 33 passed |
| Lint, typecheck, build, package exports, `git diff --check` | Passed |

The first affected storage-file run exposed two test-only waits that expected an internal pool fault to complete while reconciliation deliberately held the new session boundary. Both tests now use a gated fault-observed signal, release reconciliation, and attach rejection assertions immediately; the full storage file and two later full gates passed without timeout or unhandled rejection. The previously flaky empty-catalog rebuild test now awaits manager readiness.

## Independent verdict on the commit-time follow-up

The fresh verifier confirmed that exact-path coordination closes the worker-queue race in both orders and that the earlier public/reflection bypasses remain closed, but classified `7d75684` as **NOT RESOLVED**:

1. Coordinator sharing used lexical `resolve(homeDirectory)`. A normal manager and normal catalog client opened before any mutation through static ancestor aliases of the same physical home received different coordinators; `unavailable` committed while an already-authorized append remained blocked, and the append committed afterward.
2. Normal `CatalogClient.reconcileSessionWithStatus()` bypassed coordination and generic repository reconciliation could insert an absent `ready` row. A deterministic probe inserted the row while that session's coordinator was held.

Both findings are within the supported trusted-user model: neither requires hostile concurrent filesystem mutation.

## Alias/reconciliation follow-up correction

- `CatalogClient` realpath-canonicalizes the existing home before deriving its coordinator key or catalog path. `SessionStoreManager` reuses that canonical value for discovery and every session path, so static final-component or ancestor aliases converge on one process-local boundary.
- Canonicalization failure returns a fixed bounded `storage.operational` error without forwarding the input pathname.
- Normal generic reconciliation now participates in the per-session coordinator and requires an existing `ready` row; it cannot insert an absent row.
- Incomplete session creation uses a separate module-internal reconciliation capability only after loading a durable `creating` reservation and initializing its exact reserved session identity. Validated scanner repair remains a distinct module-internal capability.
- Neither internal capability, coordinator accessor, nor canonical-home accessor is exported by the normal package entry point; the build-time export audit fails if one appears.
- Retained regressions use a static ancestor alias for the blocked-worker race and hold a session boundary while an ordinary catalog client attempts absent-row generic reconciliation.

## Alias/reconciliation follow-up verification evidence

| Command/probe | Result |
|---|---|
| Static-alias race and generic absent-row regressions before production correction | 2 failed as expected: the alias transition committed before the blocked append, and generic reconciliation resolved while the boundary was held |
| Focused corrected regressions | 3 passed |
| Full `tests/integration/storage.test.ts` | 67 passed |
| `pnpm test:unit` | 41 files; 455 passed |
| `pnpm test:integration` | 6 files; 259 passed |
| `pnpm test:process` | 8 files; 90 passed |
| `pnpm check` | 67 files; 861 passed; no skips |
| `pnpm test:e2e` | 33 passed |
| Lint, typecheck, build, package exports, `git diff --check` | Passed |

The first full storage-file run correctly exposed incomplete-creation recovery as a legitimate absent-row reconciliation path. It now uses a separate module-internal creation capability backed by the durable `creating` reservation; the retained injected catalog-failure test moved to a gated internal boundary rather than spying on the now-restricted public generic method. The full storage file and all later gates passed.

## Final independent verification

A fresh review-only verifier classified WI-M7-H2 **RESOLVED** at `fcf5f9fd755d8bba6d441bcac7d758158d53d4ab`.

Independent probes covered both construction orders for a real home and static ancestor alias, final-component and lexical aliases, partial/final coordinator release, bounded canonicalization failure, both exact-path race orders, generic absent-row reconciliation with null/matching/forged expectations, all missing/unavailable combinations, incomplete-creation identity and failure behavior, runtime reflection/exports, and retained H1 substitution regressions. The verifier found no blocking, nonblocking, or informational code findings.

Independent gates passed: 455 unit, 259 integration, 36 property, 90 process, 33 end-to-end, and 861 aggregate `pnpm check` tests with no skips. Final tracked state was clean; only the three permitted untracked workflow paths remained.

## Next action

Proceed to WI-M7-M1 bounded IPC payload memory. Do not merge PR #13 or begin Milestone 8 until all remaining remediation IDs pass independent verification.
