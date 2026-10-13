# C3b21: offline conversation display example

Technical checks and both fresh scoped reviews **PASS**. Implementation role **FAILED/policy_violation**, not COMPLETED. All40 rows PARTIAL; accepted=false; ledger31/50 unchanged. This is scoped G11-37 local evidence, not acceptance or a final whole-repository review.

## Implemented behavior

Only `examples/conversation_view_offline.rs:1-509` was created by implementation. SHA256899738e02cdec949ed3113a8b4a68a340abc3b73f253247f9cc9901206d22892. It remains untracked/unstaged. Parent subsequently wrote this progress document and the report/matrix/disposition/machine-state updates.

- Lines24-92 supply finite synthetic RecordedRunInput and typed runtime/provider envelopes through public storage mutations. No provider/client/tool implementation or registration exists. Main calls no provider, reads no credentials/skills and opens no network connection.
- Lines94-217 compare every available public page/block/summary/entry/field getter, complete session metadata and separate cursors. Repeated Latest/Before/addressed-entry reads preserve H and representation. No raw history_page/run_record or generic event reducer builds the view.
- Lines219-394 commit terminal A, then unfinished B with two multibyte partial deltas. Latest contains only B, its human anchor and chronological activity. B is asserted and printed at H16 before the explicit typed Before request for A. A has no live cursor.
- Lines396-496 await store closure before actual reopen. Explicit session open interrupts B once, at H17, without a fabricated terminal result. Partial UTF8, stable IDs/order, epoch and field generation survive. A stays unchanged. Another fresh reopen compares the complete representation at the same H17. The seed assertion task is joined so a panic still permits storage retirement. Successful stores close before explicit synthetic-root cleanup.
- Lines498-509 provide main and one actual Tokio regression of the same real-store scenario. Focused test, aggregate test and main are three executions, not three unique tests.

The sample uses actual storage/projector behavior with supplied records. It is S evidence, not actual provider/tool J, browser layout, process-kill or scale proof. Ordinary warm reads use the existing saved projection APIs; equality and elapsed time alone do not prove internal no-replay counters.

## Actual saved execution

Report: (local record). Each gate record contains exact arguments, validated six-value environment, exit, durations and log byte/hash bindings. Locked/offline Cargo flags were used where supported; execution was serial. No product replay occurred during reviews or parent audit.

| Gate | Local result |
|---|---|
| cargo fmt --all -- --check | PASS after new-file-only formatting repair |
| cargo check --locked --offline --all-targets | PASS |
| cargo test --locked --offline --all-targets -- --test-threads=1 | Completed continuation PASS:1190 passed,11 existing ignored,0 failed/filtered,23 target summaries |
| cargo clippy --locked --offline --all-targets -- -D warnings | PASS |
| cargo build --locked --offline --all-targets | PASS |
| cargo test --locked --offline --doc | PASS; zero doctests |
| New example check / focused test / main | PASS /1 actual test /H16→H17→same-H parity and cleanup |
| Exact retained native no-replay regression |1 selected PASS;922 filtered only for this named proof |
| Eight retained offline mains | All PASS; standard dev/synthetic modes |
| Linux platform_support |1 PASS inside all-targets, not an additional unique test |

All-target breakdown: library913/10 ignores; binary59/1 ignore; integration216; example tests2, including new1 and retained host1. Counts overlap. The retained mains are run_offline, skills_offline, skill_loading_offline, storage_offline, persisted_run_offline, conversation_offline, host_offline and http_api_offline. Their bytes stayed unchanged. two_turns main was not run; its zero-test target was only compiled/tested by all-targets. Release/loaded HTTP was not run.

The completed native test gate took3168421ms. This is a finite local observation, not a performance target. The exact native Before proof printed descriptors2/chunks2/bytes8800. Its source at `src/storage/conversation/reads/pages/tests/scale.rs:319-357` asserts replay metrics(0,0), projection_pages0 and read_transactions1. The actual one-test pass supports those assertions; stdout does not itself print their values. No universal Latest/content/stream no-replay or cost proof follows.

## Preserved initial failures and limits

- Baseline collection failed ENOBUFS before edits because the Node buffer was too small for the inherited binary diff. The bounded32MiB runner correction preserved owner work.
- Initial formatting check exited1 with only new-file differences. Native write applied nonmutating formatter output only to the assigned file; the corrected check passed.
- The first formatting-output launch failed `PATH mismatch` before rustfmt launched. Reading its absent output then returned ENOENT. Later compliant launches cannot repair historical compliance. **Implementation remains FAILED/policy_violation.** Future commands must copy the complete vetted prefix verbatim and validate all six values before launching children.
- First all-target attempt returned no route result and has no gate JSON/final summary. Saved27206/172 stdout/stderr bytes end at the SSE slow-reader test. It remains INCOMPLETE/unaccounted, with unknown cause. Exactly one detached continuation completed with unchanged source/arguments/assertions and no aggregate filtering. The completed pass does not establish the first termination cause or repair a native SSE risk.
- Added-file `git diff --no-index --check` exited1 with empty output. That exact result remains saved, not relabeled0. Separate explicit byte/line audit and ordinary Cargo/Git formatting checks passed.

Initial records: `wi-c3b21-impl/initial-failures.md` and `rejected-format-launch.md`. Earlier C3b20/C15/active1 and all historical failures/reports remain unchanged.

## Reviews and parent preservation audit

Fresh review-a and review-b both completed PASS, no blocking or nonblocking findings. They used native reads/CodeGraph only: zero commands, tests, scripts, browser/native/network/Git operations or writes. Parent summaries: (local record) and `REVIEW_B_PASS.md`. These are not the three required final complete-diff reviews.

Parent independently verified the current source hash, all752 nonassigned path/mode/hash records, cached/unstaged diff hashes, HEAD/branch/index/cached284,21 successful gate records and42 stdout/stderr byte/hash bindings. It recomputed the1190/11/0/0 totals from23 saved summaries. It retained incomplete/exit1 records without replay. (local record) records that pre-documentation audit at2026-10-09T14:33:17.591Z.

HEAD318b7f0da7d503e2e3a8cf33be84e78ebbe8affb; index2592c3d79271d456e1fa884b46d1ac45245f8c7152cbaf7415dc8da990250698; cached284. The source increment changed no production/dependency/lockfile/browser/generated/CI/docs/auth path. Parent progress documentation is separate. No Git state mutation occurred. The prior independent Windows-removal audit stayed intact; Linux platform execution passed and the example adds no Windows support. No macOS/hosted evidence is claimed.

Successful new scenario executions explicitly retired their synthetic roots. Final implementation process inventory found no active Cargo/Wi native processes and the detached runner retired. Cleanup of every fixture from the incomplete first aggregate attempt was not independently proved. No universal census or cleanup claim follows.

## Remaining scope

No browser/presentation replay, real credentials/auth/live generation or ledger change occurred. C15/active1 owner deferrals, unchanged reader and native SSE risk remain open. Exclusive Window B/raw-browser retirement, release/loaded HTTP, verify.py/CLI, expanded browser/measurements, Ubuntu CI, exact-head final gates/documentation and three final accumulated reviewers remain required. The local native/offline pass does not promote G11-37 or complete G1.1. The failed role does not authorize automatic advancement.
