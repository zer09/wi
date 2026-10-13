# C49: persisted skill fidelity after source change and deletion

Contract **g1.1**. Current successor: **COMPLETED_SCOPED_REVIEWED**. Both fresh accumulated-scope reviews completed with **PASS**, without actionable findings. This is local Linux joined-browser evidence, not G1.1 acceptance. All **40 G11 rows remain PARTIAL**, accepted=false. Ledger remains **31/50 used, 19 remaining**.

C48 was already reconciled in `C3B_S2_SKILL_DISPLAY.md`. C49 adds the missing browser evidence. This document preserves C48's native H/S/C classification and every earlier C49 failure.

## Implemented and observed result

The genuine presentation fixture runs two explicit Tasks through the actual browser, HTTP, RunHost/B2, SQLite, scripted OpenAI WebSocket provider and real tools. Task A completes at H118. Task B completes at H235 using the saved provider history. Each task records AddNumbers, the main `project:presentation` SKILL result, and an actual overflow gateway_error.

The test then changes the owned main SKILL file and proves the readback. A fresh independent browser Connects at newest B. The browser shows the exact previously saved skill ID, frontmatter, body and is_error=false, not the changed source. After one genuine upward key action, the browser requests older A using B's saved previous-block cursor. A and B retain exact DTO/DOM content, identities, chronological order, ranges, epochs, generations and recorded state.

The test deletes the same owned SKILL file and proves absence. A second fresh browser repeats the complete newest-B and older-A checks. The original live browser remains consistent. Final three-client privacy, inert rendering, assets and no-work checks pass. No observer submits, cancels or resumes a Task.

## Corrections included in the reviewed scope

### Ordinary Task B polling

The normal presentation gate10 path now uses a reply-local typed incremental cursor. It polls `Database::records_after` instead of decoding the whole canonical prefix on every committed-delta check. It validates contiguous advancement, including unrelated rows, and preserves exact equality barriers and the existing 10ms mismatch sleep. Explicit diagnostic Baseline/Incremental modes retain their separate behavior. Normal execution needs no latency collector.

The five reader/native-helper changes are:

- `src/providers/openai_codex/tests/replay/http_api_joined/browser.rs:740-769`.
- `src/providers/openai_codex/tests/replay/http_api_joined/browser/presentation.rs:443-592`.
- `src/providers/openai_codex/tests/replay/http_api_joined/browser/failure_tests.rs:549-818`.
- `web/test-support/restart-display.mjs:155-166`, the exact browser.rs source pin only.
- `web/test/fixture-protocol.test.mjs:196-211`.

`web/test/restart-display.test.mjs` remains byte-identical. Executable hashing, optional strict supplied-digest checks and pre-spawn rehashes remain. This is a test-fixture reader correction, not an application JSON-reader, public raw API, provider-context or production storage change.

### Near-top keyboard setup

The shared two-observer path in `web/e2e/skill-source-fidelity.spec.mjs:190-226` keeps upward-intent permission false through top positioning, transcript focus and layout settling. It verifies focus, finite near-top geometry and overflow after focus. Setup must issue zero backward reads across block, activity and content routes.

Only then does one genuine awaited Home keypress admit exactly one older-block request. The cursor must equal the saved B previous-block cursor. Content/activity/extra reads and collector faults must remain zero. `web/test/skill-source-fidelity.test.mjs:141-195,215-328` binds regression controls to the executed collector and shared observer loop. Failure output uses bounded fixed labels, booleans, counts and route enums.

This proves **near-top Home intent**. It does not prove one Home from the bottom, or identify the root cause of the previous timeout. No application behavior, timeout, watchdog, filter, retry or cleanup predicate was weakened.

## Final source identities

| Path | SHA256 |
|---|---|
| `web/e2e/skill-source-fidelity.spec.mjs` | `2a2f35fd856d88155d0f0aa0eb2152231cb5e419b0a00704f3811ad4c9107d81` |
| `web/test/skill-source-fidelity.test.mjs` | `317e901cee7b0fb67f96005d87b8e9a9dc8dc9e58a66116f355fd20d89bf3709` |
| `src/providers/openai_codex/tests/replay/http_api_joined/browser.rs` | `777b43e5225bac8b13b7bb0a8694e68b6809c4a77fdbf05391a8148c7d00694f` |
| `src/providers/openai_codex/tests/replay/http_api_joined/browser/presentation.rs` | `bcff9bda560ebb4457a6ed2cc2198822cf66f74e45261dd320d28aff6fb56160` |
| `src/providers/openai_codex/tests/replay/http_api_joined/browser/failure_tests.rs` | `3354c24a567ec3163aa524a2503ed6d6a10ba453e69ea31d6f722f5db0840151` |
| `web/test-support/restart-display.mjs` | `73739644d3f6bffa9de7955aaf9d66aaaf1fc7df7b6fd7919840357081d7a3a2` |
| `web/test/fixture-protocol.test.mjs` | `8cb032fa02665a7bc015ae4b4c0a6f45f466ddd1d66be72671e6ef45947248fd` |

The successor spec and unit file have 256 and 328 newline-terminated lines. The reviewed integration does not certify every line of the separately supplied latency/fixture diagnostic work. That work remains preserved and must receive applicable review before final closure.

## Actual checks

Counts overlap. Focused controls, full suites and parameter configurations are not additive unique tests.

| Command or check | Current retained result |
|---|---|
| Focused Node controls, five files, `--test-concurrency=1` | 606 passed; zero failed/skipped. Serial scheduling retains the prior unchanged ownership helper's concurrent-ancestor sensitivity. |
| `npm --prefix web test` | 3,850 passed; zero failed/cancelled/skipped/todo. Unfiltered, unchanged default scheduling. |
| Syntax, typecheck and nonmutating assets | PASS; eight generated JS assets verified. |
| `uv run scripts/verify.py --static-only` | PASS; 420 source files, 1,197 Rust test definitions, 25 fixture events. Static counts are not native execution. |
| `npm --prefix web run test:e2e -- --list` | 82 cases in 27 files. No bodies ran; C15/reload and active-conflict remain collected. |
| Strict-cleanup controls | 12 passed; zero failed. |
| `npm --prefix web run test:e2e -- skill-source-fidelity.spec.mjs --workers=1 --retries=0` | Exactly one successor case passed in **42.2 seconds**. |
| Six native Cargo gates | Prior source-bound Linux results reused after native/TOML/lock/executable identity checks. No new Cargo run in the near-top successor. |
| Prior native all-target gate | 1,217 passed, 11 existing ignores, zero failed/filtered; four threads. This does not resolve historical default-concurrency SSE failures. |

The reused native commands are fmt, locked/offline all-target check, Clippy, build, all-target tests with `--test-threads=4`, and locked/offline doc tests. They originally ran for the preceding reader correction. The four-thread qualifier and initial focused-control failures remain explicit.

## Complete successor browser evidence

- Pinned Chromium 145.0.7632.6; one worker, zero retries; path-only WI_C3A_FIXTURE. Trace, screenshot and video were off.
- Current native executable SHA256: `e8ddbb739d3fff1a33dc9d80aba6a8706dc925f1c8079e42726f95fd2b367a2c`. The test rehashed it before spawn.
- Two actual completed tasks; heads H118/H235; two recorded terminals/results; six actual tool results. AddNumbers produces 42/50. Main-SKILL success and overflow error preserve actual output/is_error.
- Gate11: 72 frames, 70 deltas; native elapsed 8,770ms and Node parse/match 8,771ms. These are finite fixture observations, not HTTP/browser performance guarantees or historical-cause proof.
- Both changed/deleted observers: focused=true, top=0, scrollHeight=3178, clientHeight=383; zero setup backward reads; exactly one saved-cursor block read after Home; zero activity/content/extra reads.
- Observer sequence: latest, newest-rendered, upward-intent, older-request, older-rendered. Newest B renders before A is requested.
- Three-client POST counts: 3/0/0; nine exact served assets per context; all seven fault counters zero; native task/work facts unchanged.
- Strict Stop acknowledgment, drain, native exit0/empty stderr, handle closure, all three context closures, reaping and owned PID/root absence pass. No SIGTERM/SIGKILL fallback supplies success.

Independent typed HTTP proofs are not original browser response-byte capture or application Fetch-consumption proof. No macOS, hosted CI, live-provider or complete-browser-suite result follows.

## Failure chronology remains unchanged

| Attempt | Retained disposition |
|---|---|
| Initial C49, default 60-second case bound | FAILED/incomplete before Task B finalized. |
| Owner-authorized 180-second continuation | Both retained browser executions failed; later attribution reached paused-11. No third blind retry occurred. |
| Separate diagnostic comparison | Full-prefix versus incremental polling measured 38,103 versus 72 decoded rows, and 11.181s versus 7.470s gate windows. This supports a contribution, not the sole historical cause or complete proof. |
| Ordinary reader correction | Implementation role remains FAILED/verification_failure because its single complete C49 case timed out at changed-observer/upward-intent. Both tasks and gate11 completed; strict cleanup passed. |
| Read-only upward-intent investigation | Exact failed await and runtime cause remain unknown. Missing focus/near-top proof was a test precondition gap, not proven causal attribution. |
| Authorized near-top successor | COMPLETED_SCOPED_REVIEWED; one complete case PASS. Its initial file-level control failure and whitespace-preflight failure remain preserved. |

The predecessor reader run crossed gate11 at about 6.7s. The successor's 8.8s observation is a different finite run, not a claimed stable speedup. The native comparison pair was not repeated. The unchanged ownership helper's ancestor-link-count sensitivity remains qualified, not repaired.

## Evidence, review and preservation

- Successor: (local record), `FINAL_MANIFEST.json`, `PROOF_FACTS.json`, `BROWSER_FACTS.json`, `BROWSER_RESULT.json`, `GATES.json`, `NATIVE_REUSE_CORRECTED.json`.
- Parent: (local record), `BASELINE.json`, `REVIEW_OUTCOME.md`.
- Preceding failed role: (local record), with parent (local record).
- Original failures and diagnostic evidence: (local record), `wi-c3b49-resume`, `wi-c49-diagnosis`, `wi-c49-latency`, `wi-c49-proof`.

The successor parent audit rehashed 76 closed logs and 76 certificates. It verified 761 source records, 759 nonassigned records and 4,933 prior external records unchanged. Post-review preservation matched every current source record and mode. The historical comparison boundary differs from this documentation task's later snapshot.

Fresh independent review-a and review-b both returned COMPLETED/PASS in the parent session. They reviewed the two successor files and integration with the five preceding reader/native-helper corrections. They changed no files and replayed no product tests. No per-role report file was saved; the parent's `REVIEW_OUTCOME.md` records the completed gate. These are two scoped reviews, not the three final complete-diff reviews.

At that review boundary: HEAD318b7f0da7d503e2e3a8cf33be84e78ebbe8affb; branch docs/g1-browser-conversation-client; 406 staged, 14 unstaged and three untracked paths; index SHA25644cc5c1638f9c74b1ae1fe183b41800b53c127a5a196019e56c56019f927c7f9. Those are historical pre-documentation/pre-staging facts, not a claim that the later owner-requested checkpoint leaves changes unstaged.

## Remaining scope and next increment

C49 supplies representative main-SKILL browser source-fidelity and actual B-before-A/near-top intent evidence for G11-22/24/29/34. It does not close those requirements. C48 still supplies the six-variant native H/S/C source-change-before-next-task proof; C49's source mutations occur after both tasks complete.

The recommended next increment is **same-H interrupted-task parity between two independent real browsers**, using the existing C46/C47 restart producer/observer. C47 already proves H23-to-H24 preservation for one fresh browser and warm reconnects. Do not replay that case solely to refresh its label. Add a distinct case where two fresh independent browsers observe the same committed interrupted H, compare exact rich content/order/status, retain original Latest-before-SSE identity for each, and prove zero automatic native work through strict cleanup.

Upgrade/reopen coverage, expanded required barriers, qualified transport/browser-server memory and timing measurements, final native/offline/browser gates, hosted exact-head Linux/macOS/browser CI, three final complete-diff reviews and owner acceptance remain open. C15 and historical active1 stay OPEN_OWNER_DEFERRED. Keep the application JSON reader unchanged. No new dependencies, providers/tools, authentication modes, Node backend, Windows support, execution limits, history caps, automatic resume/retry or live work is authorized by this evidence document.
