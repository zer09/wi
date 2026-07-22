# Milestone 7 release-gate remediation 23

Status: **RESOLVED**

Starting head: `adcbf23a696468b1c3ae9b6eb9d98ca558c52e56` on `milestone-7-crash-recovery`.

Stable ID: `WI-M7-H3` — a fresh installation could not start when `WI_HOME` did not already exist.

## Third remote-review finding

The third independent remote review classified `WI-M7-H3` as a merge-blocking first-run regression. `CatalogClient` called `realpathSync.native()` before constructing its worker, while neither production configuration nor `main()` created the configured home. Every existing test supplied a pre-created temporary directory, so the missing-home path was untested.

The failure occurred before catalog bootstrap:

```text
parse WI_HOME
  -> construct WiRuntime / SessionStoreManager
  -> construct CatalogClient
  -> realpathSync.native(absent home)
  -> bounded storage.operational failure
  -> catalog worker and missing-catalog bootstrap never start
```

## Before-fix evidence

An unchanged-head production-entrypoint probe used a unique absent nested `WI_HOME` and `WI_PORT=0`:

```text
exit=1 home_exists=no
server_start_failed code=storage.operational retryable=true
```

Test-first evidence reproduced the same defect:

- both actual-production-server process tests exited with code 1 before readiness;
- the storage integration test threw `Catalog storage is unavailable` while constructing `SessionStoreManager` for an absent nested home;
- the static-alias and inaccessible-home controls already passed;
- a file at `WI_HOME` was not rejected synchronously before worker construction.

## Correction

`CatalogClient` now performs one bounded synchronous home initialization before deriving worker paths or shared coordination identity:

1. resolve the configured home;
2. create a missing directory chain recursively with mode `0700`;
3. realpath-canonicalize the created or existing path;
4. verify the canonical path is a directory;
5. map every creation/canonicalization/wrong-type failure to the existing fixed bounded `storage.operational` error;
6. only then acquire the shared canonical-home coordinator and construct the catalog worker.

The correction does not move, overwrite, delete, or chmod existing storage. Static final-component and ancestor aliases still converge through `realpathSync.native()`. The trusted-local-user boundary from ADR-0012 is unchanged.

## Retained regressions

- The actual production entrypoint starts with an absent default-equivalent `$HOME/.wi`, creates it with mode `0700`, and creates the catalog.
- The actual production entrypoint starts with an absent nested configured home, creates a browser session, shuts down cleanly, restarts against the same home, and lists the retained ready session through bootstrap.
- A file at `WI_HOME` exits production startup with code 1, never logs `server_started`, preserves the file bytes, and does not disclose the home path.
- Storage integration proves nested-home creation, mode, readiness, and session creation.
- Storage integration proves wrong-type and inaccessible paths return a fixed bounded redacted error.
- The existing static-alias coordination race remains unchanged and green.
- Process cleanup is owned by the existing verified Linux process-tree harness; every started server is cleanly stopped or forcibly reclaimed in `afterEach`, and every temporary root is removed only afterward.

## Validation evidence

| Command/probe | Result |
|---|---|
| Unchanged-head production probe | Reproduced: exit 1, absent home remained absent |
| Test-first focused integration | Reproduced: 2 failed, 2 controls passed |
| Test-first production process test | Reproduced: 2 failed before readiness |
| Corrected focused integration | 4 passed, including static alias |
| Corrected production process test | 3 passed |
| Full storage integration file | 70 passed |
| `pnpm test:unit` | 42 files; 461 passed |
| `pnpm test:integration` | 6 files; 262 passed |
| `pnpm test:property` | 10 files; 36 passed |
| `pnpm test:process` | 9 files; 100 passed |
| `pnpm test:e2e` | 33 passed |
| `pnpm check` | 69 files; 880 passed; no skips |
| Install, lint, typecheck, build, package exports, `git diff --check` | Passed |

The first complete integration/check attempt exposed one retained test that constructed `WiRuntime` before asserting wrong-type startup failure. The corrected architecture rejects that path synchronously before runtime/server construction, so the regression was updated to assert the earlier boundary, fixed bounded error, redaction, and preserved file bytes. The focused test, full integration suite, and full `pnpm check` then passed.

## Independent verification closure

A fresh review-only verifier classified `WI-M7-H3` as **RESOLVED** at `62d2de7b82aaff5e2bd7996007cb9fe823a0c7d5`, with no correctness, regression, scope, or test-quality finding.

Independent evidence included:

- a full production build/probe of baseline `adcbf23` reproduced exit code 1 while the genuinely absent nested home remained absent;
- a Worker-constructor probe proved creation and directory validation complete before worker construction, while a wrong-type home reaches no worker;
- twelve concurrent clients across physical and static ancestor-alias paths converged on one canonical home and coordinator;
- newly created directory components had mode `0700`, while an existing mode and sentinel bytes remained unchanged;
- actual-production inaccessible-home startup returned the fixed redacted classification, started no listener, and disclosed no path;
- all focused tests, 262 integration tests, 100 process tests, 880 `pnpm check` tests, and 33 browser E2E tests passed without complete-suite skips;
- final cleanup found no server, fixture descendant, watchdog, listener, temporary home, probe directory, or tracked-tree mutation.

The independent H3 gate is closed. The next release-gate action is the verification-first `WI-M7-M5` PGID-reuse probe; no process-ownership correction is permitted unless that probe reproduces the claimed reuse hazard.
