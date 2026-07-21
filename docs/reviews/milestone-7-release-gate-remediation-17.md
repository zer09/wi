# Milestone 7 release-gate remediation 17

Status: **IMPLEMENTED — owner accepted the trusted-user/Linux-only scope; independent verification pending**

Review target: `6acba7d2e0b49ce535281e5a335c71b026fe30c1` on `milestone-7-crash-recovery`.

This ledger records the independent H1 verification chain after the remote re-review of PR #13. It supersedes conflicting H1 readiness and Windows-support claims in earlier Milestone 7 ledgers. WI-M7-H2 and later findings remain blocked until this scope correction receives independent verification.

## Anti-cycle rule

`WI-M7-H1` received three atomic corrections and three independent `PARTIALLY RESOLVED` classifications. A fourth pathname-metadata patch is prohibited. The project owner selected the architecture path instead: ADR-0012 explicitly trusts the local operating-system user and accepts hostile concurrent same-user TOCTOU/ABA substitution as outside v0.1's threat model. ADR-0011 narrows v0.1 to Linux and removes the later-added Windows release gate.

A new review may reopen an already-covered in-scope trace only with a current-HEAD reproducer. Earlier H1 regressions for ordinary corruption, static links, visible substitutions, evidence preservation, and bounded errors remain cumulative and must not be removed or weakened.

## Remediation and verification chain

| Commit | Correction | Independent result | Newly exposed residual |
|---|---|---|---|
| `e511346cc0e753648bb9a50de3531e87baf33134` | Removed automatic pathname-based catalog quarantine/replacement and failed closed. | **PARTIALLY RESOLVED** | Canonical catalog was still opened read-write before corruption classification; SQLite recovery could rewrite DB and remove WAL/SHM evidence. |
| `db34512fa332167407e15166bc426f3779a8c232` | Moved recovery, `quick_check`, and migration validation to a disposable physical DB/WAL/SHM copy; preserved canonical bytes and identities during ordinary corrupt classification. | **PARTIALLY RESOLVED** | Final validation was not bound to the later canonical pathname open; raw filesystem errors exposed `WI_HOME` and probe paths. |
| `6acba7d2e0b49ce535281e5a335c71b026fe30c1` | Added `prepareOpen`/`openPrepared`, a pre-PRAGMA identity callback, missing-file reservation, post-validation substitution regressions, and fixed bounded startup-error messages. | **PARTIALLY RESOLVED** | A post-callback or ABA substitution can still decouple pathname metadata from SQLite's acquired/lazy handles; missing reservation can follow a substituted ancestor before the post-check. |

## Current independent findings

### H1-F1 — successful final check precedes pathname-dependent SQLite mutation

**Severity:** High

**Blocks H1:** Yes

`beforeConfigure` verifies current pathname metadata, not the identity of SQLite's acquired main-file handle. After it returns, recovery-capable PRAGMAs run and WAL/SHM may be opened lazily by pathname.

The verifier used the actual `openWorkerDatabase()` helper, passed the identity callback, swapped the home to an external corrupt DB/WAL/SHM set, and returned from the callback. The first PRAGMA changed the external SHM bytes. This is materially equivalent to the original H1 failure: validation of A authorized mutation of B.

ABA also remains possible: SQLite can acquire B's main handle, the pathname can be restored to A before the callback, and the callback can approve A's metadata while later operations use B's main handle and pathname-resolved sidecars.

### H1-F2 — missing-catalog reservation follows substituted ancestors

**Severity:** High

**Blocks H1:** Yes

`O_NOFOLLOW` protects only the final `catalog.sqlite3` component. A substituted home ancestor can redirect `openSync(O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW)` into an external tree. The post-creation directory identity check detects the mismatch only after a zero-byte external catalog has been created.

### Startup-error redaction

**Status:** Resolved

`safeCatalogStartupError()` preserves stable classification and retryability while replacing raw messages with fixed bounded text. Independent EACCES and classification probes exposed neither `WI_HOME` nor `wi-catalog-probe-*` paths.

## Cumulative regression evidence

The following current-head behaviors remain required:

- no automatic catalog quarantine or replacement;
- corrupt canonical DB/WAL/SHM bytes and identities survive ordinary classification;
- valid crash-left WAL/SHM startup succeeds;
- substitutions visible before `beforeConfigure` are rejected without mutation;
- post-validation direct-file and ancestor substitutions remain covered;
- a replacement after missing-file reservation is rejected;
- existing quarantine-style evidence is not overwritten;
- corrupt-catalog discovery does not run;
- missing-catalog rebuild remains idempotent;
- healthy startup remains catalog-only;
- session preserve-in-place behavior remains unchanged;
- startup errors remain bounded and path-redacted.

Independent verification at `6acba7d` passed:

| Command | Result |
|---|---|
| Focused H1 process tests | 8 passed |
| Full `milestone7-recovery.test.ts` | 49 passed |
| `pnpm test:integration` | 252 passed |
| `pnpm test:process` | 90 passed, 2 native-Windows-only skipped |
| `pnpm check` | 853 passed, 2 skipped |
| Lint, typecheck, build, `git diff --check` | Passed |

Those results predate the accepted scope correction and established the implementation baseline rather than closure under the new ADRs.

## Scope-correction implementation and verification

- Added ADR-0011 (Linux-only v0.1) and ADR-0012 (trusted local operating-system user).
- Updated the root agent instructions, vertical-slice plan, architecture overview, storage model, failure matrix, and failure boundaries.
- Added a production-entry platform guard before runtime/storage construction.
- Removed the Windows Job Object implementation and preload, Koffi dependency/build allowance, Windows-only owner-death/reload fixture coverage, junction branches, platform-specific forced-exit assertions, and required Windows CI job.
- Retained Linux detached process groups, owner watchdog/preload gate, graceful signals, escalation, direct-leader exit handling, and owner-death reclamation.
- Retained all cumulative H1 regressions for in-scope corruption, static links, visible substitutions, evidence preservation, missing-catalog recovery, and bounded redacted errors.

| Check | Result |
|---|---|
| Focused platform/config unit tests | 14 passed |
| Linux process-tree ownership suite | 6 passed |
| Focused cumulative H1 process tests | 5 passed |
| `pnpm check` | 66 files; 852 passed; no skips; lint, typecheck, tests, build, and package exports passed |
| `pnpm test:e2e` | 33 passed |
| `git diff --check` | Passed |
| Dependency inspection | No Koffi or `@koromix` lockfile/package/build-allowance entries remain |

## Accepted architecture decision

The project owner chose the trusted-user boundary documented in ADR-0012. Wi v0.1 does not defend `WI_HOME` against an actively hostile process running with the same user's authority. The post-callback SHM mutation, ABA sequence, and ancestor-racy missing reservation remain technically reproducible but are accepted residual risks outside the supported operating model.

ADR-0011 also makes the v0.1 server Linux-only. The Windows Job Object implementation, preload, Koffi dependency, Windows-only fixtures/tests, junction branches, and required Windows CI job are removed. Supporting Windows later requires a new ADR and release gate.

The existing storage checks remain defense-in-depth and must not be described as handle-relative security guarantees.

### Rejected incremental approaches

- another pre/post pathname identity check;
- `O_NOFOLLOW` on only the final component;
- predictable or random quarantine/runtime aliases without pinned handles;
- advisory/cooperative locks;
- detecting ancestor change only after creation or mutation;
- claiming a better-sqlite3 pathname constructor is equivalent to an identity-bound open.

## Platform boundary

Wi v0.1 now supports Linux only. The server fails before storage construction on unsupported operating systems. Linux process groups, owner-pipe watchdog behavior, signals, and directory symlinks remain release-gated. Historical native Windows evidence is retained in earlier ledgers but is no longer a current product requirement.

## Next action

Run the complete Linux gates, commit this scope correction atomically, and obtain fresh independent H1 verification against ADR-0011 and ADR-0012. Do not begin WI-M7-H2, merge PR #13, or begin Milestone 8 before that report.
