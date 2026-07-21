# Milestone 7 release-gate remediation 18

Status: **FOLLOW-UP IMPLEMENTED — fresh independent WI-M7-H2 verification pending**

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

## Next action

Create one atomic WI-M7-H2 follow-up commit, then obtain a fresh verification-only review that reruns both independent public-surface probes. Do not begin WI-M7-M1, merge PR #13, or begin Milestone 8 until H2 is independently resolved.
