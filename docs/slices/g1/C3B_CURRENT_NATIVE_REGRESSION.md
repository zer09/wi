# C43: current-source full native functional regression

Status: parent-owned local execution and saved-evidence audit PASS. All 40 rows remain PARTIAL; accepted=false. This is not G1.1 acceptance, default-concurrency failure resolution, hosted CI, or a final complete-diff review.

## Verified baseline and source binding

On October 11, the current baseline matched the owner-approved staging update: HEAD `318b7f0da7d503e2e3a8cf33be84e78ebbe8affb`, branch `docs/g1-browser-conversation-client`, 386 staged changed paths, zero tracked unstaged paths, and zero nonignored untracked paths. Accepted master and preserved checkpoint are ancestors. The older handoff counts are historical, not drift.

The recorder captured 739 tracked/nonignored project records with per-file hashes and modes before execution. This includes generated assets, lockfiles, reports and historical absences. It saved pre-execution copies of `src/storage/conversation/reads/tests/content.rs`, `src/storage/conversation/reads/tests/atomicity.rs`, `src/storage/b2_tests/migration/activation.rs` and `scripts/agent_env.mjs`. The three historical G1.0 reports still match their checkpoint bytes. Ignored caches and fixture contents are outside this finite preservation inventory.

## Actual execution

The parent native-read (local record) before shell execution. The canonical launcher used absolute Node24.18.0 with NODE_OPTIONS empty. The detached recorder verified and inherited all six approved values without retyping PATH. Additional harness values were `CARGO_NET_OFFLINE=true` and `RUST_TEST_THREADS=4`.

One product invocation ran from `<repo>`:

`cargo test --locked --offline --all-targets -- --test-threads=4`

The direct program was `/usr/bin/cargo`. The recorder added no timeout, retry, selector, skip or assertion change. Start: `2026-10-11T06:23:08.877Z`. Terminal close: `2026-10-11T06:37:02.147Z`. Exit 0, no signal, no spawn error.

| Scope | Observed result |
|---|---|
| Library | 916 passed, 10 existing ignores, 0 failed/filtered; 736.96 seconds |
| Binary | 59 passed, 1 existing ignore, 0 failed/filtered |
| Remaining integration/example test targets | 218 passed, 0 failed/ignored/filtered |
| Total | 1193 passed, 11 existing ignores, 0 failed/measured/filtered |
| Changed C39-C42 tests | Content reconstruction, real transaction atomicity and genuine legacy migration all appear as passing tests in the closed log |

Counts overlap earlier executions. Example test targets are not fresh example-main runs. This execution does not replay or relabel the saved C39-C42 measurement samples. The scoped formatting/check/Clippy/build/doc/platform results remain separately attributed prior evidence. Platform_support also passes inside this full suite.

**Four-thread qualification:** this pass does not diagnose or repair historical default-concurrency SSE lifecycle failures. Those failures remain unresolved. No timeout inflation, serialization-as-repair claim or failed-case promotion occurred.

## Preservation and cleanup evidence

Before/after project records, physical index, stage listing, HEAD and branch match exactly. No repository source or generated file changed during execution. The recorder observed 163 PID/start-tick/executable identity records across Cargo and sampled descendants. No sampled owned identity remained active at completion. The agent temp directory had no new remaining top-level names. No uncertain root or unrelated process was deleted or stopped. Sampling is not a universal process census or certification of historical incomplete-run cleanup.

Closed stdout: 141812 bytes, SHA256 `bf4133c37a8fa6cbaefbd88e3fe51326ac7e3ada8012a24e6285a806e97e3c4c`. Closed stderr: 2932 bytes, SHA256 `51c275c5572c6339f35bb6d6f9ad6ab38f6e452b9289e02ffc2fdadb12ccf811`. The parent audit rehashed logs and source copies, verified current source equality, checked all summaries and located the changed tests without another product execution.

Evidence root: (local record). `CONTRACT.md`, `BEFORE.json`, `SOURCE_BINDINGS.json`, `launch.json`, `START.json`, `CHILD.json`, `process-identities.jsonl`, `AFTER.json`, `TERMINAL.json` and `AUDIT.json` bind the actual command, environment, source, process identities, terminal result and preservation limits.

## Initial diagnostic and remaining limits

The first optional read-only Node check put the target separator before `--input-type=module`. Node treated the option as a filename and reported MODULE_NOT_FOUND before script evaluation. The corrected invocation verified Git state. No intended Git check or product test ran in that initial attempt. This correctable diagnostic is disclosed in the external contract; it does not promote any historical failed/BLOCKED role.

G11-36's current evidence sentence now includes the already executed C37-C42 finite native subset. Its PARTIAL status remains unchanged. Transport/browser-server timing and memory, true-peak limits, remaining parity/fidelity/restart cases, complete Chromium, hosted exact-head CI and three final complete-diff reviews remain open. C15 and active1 remain owner-deferred. The application JSON reader, authentication boundary and Windows-removal audit remain unchanged. Ledger remains 31 used/19 remaining. No commit, push, hosted mutation, merge, release or deployment occurred.
