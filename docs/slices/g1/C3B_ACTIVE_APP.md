# C3b1 active display entry: scoped local evidence

Contract: **g1.1**. First C3b increment: **IMPLEMENTED; REVIEW-A/B PASS, WITH DISCLOSED PROCESS DEVIATIONS**. Accepted: **false**.

The active app now uses the reviewed display controller and renderer. This report covers the four-path entry increment only. Raw-source/helper retirement and old joined-suite adaptation remain open. No Phase D, whole-C3b, final complete-diff, hosted CI or G1.1 acceptance is claimed.

## Source and actual-entry obligations

| Path | Change | SHA256 |
|---|---|---|
| `web/src/app.ts:1-34` | Mount createDisplayClient/mountDisplayView. Retain hash navigation, just-connected selection and local unload/pagehide disconnect. | `9baf10d9f7279084ebed3bbd6ead811d3efaae270ca633a010da5c9fa0fffb30` |
| `web/dist/app.js:1-35` | Locked compiler output. Other generated asset bytes and names are unchanged. | `5edec7a5f6ed378f7a54621ca6476cf7b14c97a2137efa910f946c893b3a5a66` |
| `web/test/reload-app-realm.test.mjs:1-113` | Two fresh actual-app display realms. Replace rejected raw-prefix expectations; retain memory, hash, pending identity, stale completion and unload obligations. | `d07c017039d134723bd90558953ea85e36e5ce234ed5e51b926185a02ea9afeb` |
| `web/e2e/display-app.spec.mjs:1-222` | Nine actual-entry Chromium cases. Real Rust embedded page/assets; only API destinations redirect to an owned synthetic loopback DTO server. | `f8c3116b6af4760469b8c3073c8772455e66f43056b69ecda85edb21bc1383e0` |

The active runtime graph is app -> display-client/display-view -> api/display-api/display-store/sse. Neither independent compile traversal nor actual browser asset requests reach client.js, state.js or view.js. The type-only raw-client imports do not survive compilation. The raw full-prefix loop, history.complete gate, fingerprint/domain reduction and receipt-range proof are unreachable from the active app. Their old source/dist/tests/helpers remain intact for later explicit disposition.

| Actual-entry assertion | Source | Evidence |
|---|---|---|
| Hash opening, explicit memory-only Connect, B-before-older, zero older requests on overflow, inert narrow/wide text | `display-app.spec.mjs:103-121` | Two C/B cases |
| Serial short-B fill; live observation while an older read is held; overflow stop; no resize/programmatic cascade | `display-app.spec.mjs:123-140` | One C/B case |
| B content, then B activity, then A; keyboard Load older; one human anchor | `display-app.spec.mjs:142-160` | One C/B case |
| EOF does not rebase; explicit latest success/failure; matching H; exact pending/reconcile body | `display-app.spec.mjs:162-181` | One C/B case |
| Real reload/unload retains only hash; no automatic mutation or old-realm authority | `display-app.spec.mjs:183-196`; `reload-app-realm.test.mjs:10-113` | One C/B case and two C realm tests |
| Disconnect and HTTP401 clear memory-only fields, transcript and commands without implicit mutation | `display-app.spec.mjs:198-212` | Two C/B cases |
| Invalid hash, catalog navigation and empty session | `display-app.spec.mjs:214-222` | One C/B case |

API transport in these browser cases is synthetic. The evidence is C/B plus separately attributed actual embedded asset/boundary H. It is **not** browser-to-real-display-storage/RunHost/B2/provider/tools joined J proof. Common rendering alone does not establish live/saved producer DOM parity.

## Implementation and independent reviews

Implementation: (local record), SHA256 `38da1b97a7f5ab4be58ce02627ba05c56abcc554e85221daad2388410e407dfb`.

| Role | Result | Report and SHA256 |
|---|---|---|
| review-a | COMPLETED PASS; no actionable findings | (local record); `f04bc0d40b278661440c6e4c4f5191cb7af71480103ac018add8f01922bbd01c` |
| review-b | COMPLETED PASS; no actionable findings; one disclosed no-op PATH exception | (local record); `c280066f798695e414cacda150c88be972e7d728aa91bb7204110eac5ecae66c` |

Both fresh reviews ran without Fastlane. Each independently passed realm2, unfiltered Node1345, typecheck, complete ten-asset compile/name/byte parity, complete new Chromium9 and retained renderer Chromium43. Review-a also performed separate nonmutating asset verification and actual asset/settings/boundary probes. Counts overlap and are not summed. All old Node tests remain in the unfiltered run. Neither review ran or certified the complete old Chromium suite.

The parent read both reports completely. Its (local record) rehashed all10 review-a and7 review-b command records. Every gate exit was zero with null signal. Gate cwd and all six required environment fields matched. Both browser runs had52 matching Start/Stop/reap records per reviewer; all owned gate/fixture PIDs were absent. Review-a's additional H probe also stopped and exited zero. No blocker required a finding-verification or remediation role. These are increment reviews, not the three later whole-PR reviews.

Implementation typecheck, deliberate build and separate nonmutating verification passed. Its fresh native fixture was compiled before reuse. Six serial native gates passed: fmt/check/test/clippy/build/doc. The unfiltered default-scheduled all-target gate reported1184 passes,11 existing ignores, zero failures and zero filtering. Platform1 and focused asset6 passed and overlap the native total. Reviews inspected and rehashed native evidence; they did not independently rerun native gates. Required full scripts/examples, npmci, old browser suite, macOS and hosted gates are not newly claimed.

Exact commands, cwd, ordered environment, UTC times, PIDs, OS exits and stdout/stderr hashes remain in implementation `logs/*.json`, review-a `logs/*.json` and review-b's top-level command JSON. Browser execution used workers1/retries0 with trace/screenshots/video off. Existing watchdog/control deadlines were unchanged. No new dependency, ignore, runtime budget/retry or authentication mode was added.

## Retained failures and process deviations

The additional concurrent HTTP-router group failed twice, each103 passed/1 failed/exit101. Both failures name `b2_owned_partial_commit_reader_drop_error_and_shutdown_never_cancel_host`, at `src/http_api/router/tests/conversation_tests/sse.rs:40:51`, reqwest Decode/Body/TimedOut. The failing Rust files are unchanged by C3b1. A scheduling-different complete router run passed104 with `--test-threads=1`; this is not a fix or green concurrent evidence. Both reviewers classify the failure as an open native scheduling/fixture risk, not an established four-path entry defect.

| Execution | Metadata | stdout SHA256 |
|---|---|---|
| Concurrent first, child252490, exit101 | `wi-c3b1-impl/logs/cargo-router.json` | `c7247074f12649c5c337cb45e4e1492279d0ac6a00eb6446303991d91049baaa` |
| Concurrent second, child266002, exit101 | `wi-c3b1-impl/logs/cargo-router-second.json` | `2334fb141198dfbde41840e8859e365cbad7b26eadaa8db40911167488718c1b` |
| Serialized, child281383, exit0 | `wi-c3b1-impl/logs/cargo-router-serialized.json` | `b2ce336f80435654f38880edf6c20e30165114c74e76d7c4bd9616c1613b420f` |

These paths are below (local record). The second concurrent run repeated a failed command without a material change. Preserve that process deviation; do not treat repetition as a fix. No further equivalent run occurred in either review. A future diagnostic must first establish the intended fault recipient/admitted-read retirement or a relevant phase interleaving. Do not raise deadlines, weaken assertions or serialize merely to obtain green. No Rust correction is included here.

Other retained implementation failures: initial capture ENOBUFS, two adapted VM failures before adding standard atob/btoa, and a no-index diff-exit interpretation error. The VM correction is test-only and does not weaken production cursor validation. Exact failed and corrected logs remain in the implementation directory.

Review-b disclosed one `env ... true` no-op with a mistyped PATH order. It supplied no evidence and read/wrote no project state. All recorded discovery/evidence commands used the required environment. Its technical review completed, but perfect shell-protocol compliance is not claimed.

The parent retained the owner's staged index instead of performing the requested unstage-before-delegation step. That step was not performed. Fresh before-byte copies and the exact increment patch distinguish new edits, but do not satisfy the requested staging procedure. No Git mutation occurred. New source/evidence edits remain unstaged and uncommitted; the222-path owner baseline remains staged.

The parent's first review-closure checker used the wrong fixture marker and failed with `Fixture count mismatch`. It was corrected to DISPLAY_APP_FIXTURE/DISPLAY_BROWSER_FIXTURE, then checked every Start/Stop/reap record successfully. This diagnostic failure remains in session evidence; it is not a product or reviewer failure. Earlier failed/UNKNOWN roles and all historical evidence remain unchanged and uncounted as fresh completion.

## Preservation and fixture identity

Exact fresh-baseline increment patch: (local record), SHA256 `4104d0291fbcd2081f01c7daf4ad7b8e9be7fdceacae0d0204abbb1644b38521`.

Fresh implementation baseline:714 present records. Final source seal:718 records, comprising715 present paths plus three historical absences. Parent/reviews matched every record before parent evidence reconciliation. Only three existing paths changed and one path was added. Parent reconciliation documentation is additional to that immutable source seal. HEAD318b7f0, both required ancestors and all unrelated source/generated/report/handoff bytes stayed unchanged. Owner index SHA256 remained `6fcf88808a6ee98fa37ab962fcba1f4fe9a4f966db686962c7b55cd6bf20d072`; the staged patch also matched exactly.

Parent final closure is (local record):719 project records including three historical absences, unchanged222 staged paths, seven unstaged paths and three untracked paths. Historical report hashes, source/generated bytes, fixture inputs and whitespace checks match. No relevant owned process remains. This manifest includes the parent evidence reconciliation, unlike the immutable implementation seal.

Fresh fixture: (local record), SHA256 `0866b7011b1fac6167708d681d9e05e78fbda8ef501d2192d687c0c2c7b809ab`. All435 compiler/source/asset inputs match. The old C3a shared-target fixture hash is historical, not current reusable evidence. The parent checked all27 implementation command log pairs and all17 independent review command pairs.

Only synthetic roots, skills and credentials with loopback/scripted providers were used. No real credential/private workspace skill/auth/live generation, Windows restoration, hosted mutation, user-service shutdown, shared-cache cleanup or acceptance was added. Ledger31/50 used19remaining remains unchanged.

## Partial progress and deferred work

G11-20/22..28/30/31/37..39 gain scoped actual-entry, C/B or separately attributed asset H evidence. G11-19 retains both new native failures explicitly. G11-32 becomes **PARTIAL** because DISPOSITION.md maps affected raw suites and the actual-app realm obligation was replaced and reviewed. Full raw-source/helper retirement and per-assertion old-suite adaptation remain open. No existing suite was silently filtered, excluded, skipped or removed.

Totals: **37 PARTIAL / 3 NOT_RUN**, accepted=false. G11-29/33/34 remain NOT_RUN. Raw retirement, real joined adaptation/proof, process restart, live/saved DOM parity, measurements/examples, Ubuntu browser CI, complete regressions, final complete-diff reviews and exact-head closure remain later work. No later increment started from this report.
