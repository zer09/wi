# C3b22: Window B prototype retirement

Status: **technical checks and scoped reviews passed; historical role failures preserved**. Contract g1.1. All40 rows remain PARTIAL; accepted=false. Fastlane OFF. Changes remain unstaged and uncommitted.

## Implemented scope

Removed eleven exclusive prototype files. Removed their dispatch from the shared JS fixture and private native browser fixture. Retired Start keys, controls and stdout replies now reject before resource setup, stdin, dispatch or publication.

The original retirement made two test declarations unused. R1 removed only the `FaultPlan` re-export and `RunClient::test_open_session` helper. The underlying fault type, shared fault implementation and three HTTP fault tests remain.

Independent review found RB-01: a duplicate top-level `event` could hide a retired reply behind `task_finished`. Fresh verification reproduced the bypass with literal and escaped keys. R2 adds nine fixture lines to count decoded top-level event members before dispatch. Ten regressions cover rejection, byte splits, prior publications and valid nested/string values. It does not add a generic JSON parser, dependency or all-key policy.

Current source references:
- `web/test-support/fixture.mjs:351-381,402-408,489-507`: duplicate-event rejection, Start admission and retired-control rejection.
- `web/test/window-b-retirement.test.mjs:47-175,203-256`: retired inputs, retained modes, actual parser/controller boundaries and R2 regressions.
- `src/providers/openai_codex/tests/replay/http_api_joined/browser.rs:49-219,943,1317-1340`: closed inputs, ordinary serving and retained drain/cleanup.
- `browser/failure_tests.rs:3-115` in the same directory: three native decoder regressions.
- `src/http_api/router/events/test_hooks.rs:14` and `src/service/tests/mod.rs:18`: two orphan declarations removed, with retained tests unchanged.

No production, application-reader, raw HTTP/B2, dependency, generated-asset, CI or authentication change occurred. Broad raw-browser modules and fixed-head machinery remain separate work. C15 remains owner-deferred and was not sampled.

## Explicit test disposition

The removed cases are **superseded instrumentation, not PASS, skipped or filtered**. Original bytes match checkpoint8f45dda and remain in Git and external archived copies. Old failed reports remain failed.

| Removed path | Cases and disposition | Retained or moved obligation |
|---|---|---|
| `web/e2e/read-reconnect.spec.mjs` | One Window B/CDP receipt-before-consumption case removed. | Frame/application boundaries use actual C-level parser/controller seams. Explicit latest rebase remains prior B/J evidence and required final browser coverage; no fresh browser proof here. |
| `web/test/read-reconnect-artifacts.test.mjs` | Six: recorder positive, four context/browser teardown combinations, privacy guard. | Retained selection/disconnect/reload artifact and fixture-failure guards remain. Three new real-pipe JS controls check Stop identity, reap and sandbox removal. |
| `web/test/read-reconnect-network.test.mjs` | Eight: split identity, substitutions/malformed input, allocation bounds, native terminal, four CDP terminal categories. | Shared framing/identity validation and controller terminal behavior remain. Deleted CDP allocation/timing obligations do not become new transport limits or passes. |
| `web/test/read-reconnect-observer.test.mjs` | Two: global/body-access restoration and copied-prefix ledger distinction. | Negative global-injection guards and display epochs/application merging remain. The retired raw ledger is not recreated. |
| `web/test/read-reconnect-protocol.test.mjs` | Three: mode admission, flat evidence, control ordering/identity. | Closed retired-input rejection and unchanged retained fixture protocols replace positive prototype admission. Shared native subscription/release faults remain. |
| `web/test-support/read-reconnect.mjs` | Exclusive observer removed. | No global observer/restoration requirement remains for deleted code. |
| `web/test-support/read-reconnect-network.mjs` | Exclusive CDP collector removed. | No native-network receipt proof is claimed. |
| `web/test-support/read-reconnect-privacy.mjs` | Exclusive privacy helper removed. | Shared artifact/privacy guards remain byte-identical. |
| `web/test-support/read-reconnect-protocol.mjs` | Exclusive protocol removed. | Retired controls/replies fail closed. |
| `web/test-support/read-reconnect.json` | Exclusive fixture data removed. | Deterministic display fixtures and retained native faults remain. |
| `src/providers/openai_codex/tests/replay/http_api_joined/browser/read_reconnect.rs` | Exclusive provider/audit helper removed; no standalone test. | Ordinary native serving and retained provider branches remain. |

Totals:19 unit cases and one browser case retired. New retirement cases:31 original plus10 R2, giving41. Node3197 before retirement minus19 plus41 equals3219. Focused and complete runs overlap; reruns are not additional unique tests. Full per-case names and original hashes are in the original implementation report and `HANDOFF_EVIDENCE.json`.

Shared `serve_with_event_faults`, underlying `FaultPlan` and `src/http_api/serve/tests/sse_faults.rs` remain. The HTTP tests still cover partial/whole writes, subscription isolation, paused-body retirement and unpolled-owner shutdown. `web/test/selection-epoch-artifacts.test.mjs:146-160,239` still prohibits Window B/global instrumentation. No suite exclusion was added.

## Observed checks

All commands used synthetic local input. Command records bind exact argv, cwd, environment, exit, counts and log bytes/SHA256. Web cwd is `web`; native cwd is the repository root.

| Attribution | Command or group | Observed result |
|---|---|---|
| Original implementation | Changed JS syntax; focused retirement/display transport/client/store; unfiltered `npm test` | PASS;671 focused,3209 complete, zero skips. Earlier execution, superseded by R2 for current JS. |
| Original implementation | `npm run typecheck`; `npm run verify:assets` | PASS; ten assets unchanged. |
| R1 | `cargo fmt --all -- --check` | PASS |
| R1 | `cargo check --locked --offline --all-targets` | PASS, no warnings |
| R1 | `cargo clippy --locked --offline --all-targets -- -D warnings` | PASS |
| R1 | `cargo test --locked --offline --lib http_api::serve::tests::sse_faults:: -- --test-threads=1` |3 passed,0 ignored; scoped selector, not full suite. |
| Parent completion | `cargo test --locked --offline --lib providers::openai_codex::tests::replay_loopback_tests::http_api_joined::browser:: -- --test-threads=1` |47 passed,1 existing private child ignored; includes new3 decoder regressions. |
| Parent completion | `cargo test --locked --offline --lib service::tests:: -- --test-threads=1` |37 passed,1 existing ignore. |
| Parent completion | `cargo test --locked --offline --test platform_support -- --test-threads=1` |1 passed; no Windows support restored. |
| Parent completion | `cargo test --lib --no-run --locked --offline --message-format=json`; bound executable `--list --exact --ignored` |Current artifact/hash and private-child name bound. Child listed only, never executed. |
| R2 | Changed JS syntax; retirement/display transport/client/store |681 passed:671 inherited plus10 new, zero skips. |
| R2 | Unfiltered `npm test` |3219 passed, zero skips. |
| R2 | `npm run typecheck`; `npm run verify:assets` |PASS; complete ten-asset set unchanged. |
| R2 | `git diff --check`; new-file no-index whitespace |No diagnostics. No-index exits1 because the new file differs, not an exit0 claim. |
| Final parent | Source/evidence audit, no product replay |755 current records,11 archived copies,256 prior external records,129 sealed R2 records,90 command records and180 logs rehashed. HEAD/index/cached284 unchanged. |

SSE HTTP faults are retained lower-level H evidence, not Window B or fresh browser evidence. JS boundaries are C. Native fixture tests and compiler listing do not execute the ignored browser child.

## Reviews and finding disposition

First gate: review-a PASS; review-b CHANGES_REQUIRED for RB-01. Fresh verification CONFIRMED/REPRODUCED. R2 remediation COMPLETED.

Final fresh complete-current-increment reviews both completed PASS. Review-a found no defect. Review-b reported one low, nonblocking test-quality issue: `window-b-retirement.test.mjs:247-254` asserts an unchanged local cursor variable. The parser case proves one callback, termination and no later delivery, not independent cursor publication. Actual controller application rejection at232-245 proves whole-state/cursor preservation. This optional cleanup remains disclosed and unmodified; no required coverage or failure is hidden.

Reviewers used native reads and CodeGraph only. They ran no shell, tests, browser/native/Git/network commands or writes. These are scoped reviews, not the three required final accumulated reviewers.

## Preserved failures and deviations

- Original implementation remains BLOCKED/assignment_conflict after Clippy reported the two out-of-scope unused declarations. Initial formatting failure and correction, Clippy101 and diagnostic no-index1 remain preserved.
- R1 remains FAILED/policy_violation. Its native-browser launcher omitted two PATH components. Preflight rejected before Cargo or a child. The original transcription mistake and corrected copy remain. Parent inspection then corrected only the launcher and ran the previously unstarted checks under the owner's continuation instruction. No unchanged failed product observation was replayed.
- R2 retains seven expected regression-first failures before the correction; all ten cases pass afterward. R2 completed. Earlier failures do not become passes or completed roles.
- A repeated parent audit hit its existing exclusive-creation output. A separate audit verified preservation without overwriting evidence.
- A parent source-audit launcher used the wrong CARGO_TARGET_DIR. Preflight rejected before Git/product execution or writes. The correctly prefixed audit passed; strict all-command-prefix compliance remains false. No product replay was used to cure the deviation.
- Native-read path lookup errors remain disclosed in the reports and parent deviation record. No private data or real credentials were accessed.

## Evidence locations and remaining work

- Original contract/copies: (local record).
- Original report/gates: (local record).
- Two-removal report/gates/failure: (local record).
- Parent remaining native checks: (local record).
- R2 report, regression failures, gates and seal: (local record).
- Final parent source/document audit, review summary and deviations: (local record).

Remaining matrix work includes dependency-aware raw-browser retirement, Ubuntu browser CI, required scripts/release-loaded examples, measurements, full native/browser gates, final accumulated reviews and documentation/exact-head CI closure. CI source currently has only the Linux/macOS native job. C15 and active1 owner deferrals remain. No browser replay, live generation, hosted write, Git transition, acceptance, merge or release follows this increment.
