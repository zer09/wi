# C48: saved S2 skill results through typed display reads

Implementation COMPLETED. Both fresh scoped reviewers COMPLETED/PASS with no findings. All40 rows remain PARTIAL; accepted=false. Ledger remains31 used/19 remaining. This adds native H/S and assertion C, not browser J.

## Changed source

`src/providers/openai_codex/tests/replay/http_api_joined/fidelity.rs:1-935`,36180 bytes/SHA256 `4f649142568f949688aae958eb363b88b1cdaea899537d5650001570f762de92`, is the only implementation change. The original16662-byte source has SHA256 `f4554a08161390509ced0e6825bae3dfea28b237af110d7ef0e656f12c7703c0`. Complete22361-byte diff SHA256 is `d9f43e6db6a2f10da3e4813236f775ac35d33f9253fe0e8f80eb098a416d607b`:485 insertions/one replacement capturing the existing B receipt.

All original assertions remain. `mixed_items`, `results`, `assert_saved` and the three original Tokio definitions remain byte-identical. Parent Fixture/Wire, production/projector/context/replay/storage/API/reader, browser protocols/source, generated assets, dependencies, module registration and workflow/config remain unchanged. Both C47 native source pins remain exact; normal Cargo compilation changes its external artifact, not those sources or prior J evidence.

## Actual producer boundaries

The existing genuine RunHost/B2/controller/ToolRegistry/OpenAiCodex loopback/SQLite fixture already loads the main `project:same` SKILL, saves its exact qualified ID/frontmatter/body result, and sends that result to the continued model request. The main body contains error-shaped text, but the actual load is successful/is_error=false. A separately advertised then deleted `project:vanish` produces a real gateway_error/is_error=true. AddNumbers produces `{"sum":42}`. These are actual executions, not manually appended transcript records.

C48 extends that producer with four typed display pages and nine addressed-entry reads per variant:

1. After A completes, Latest binds the actual run/receipt/result/head/outcome/summary/completion and exact human anchor. Five activities match actual response/tool-start sequences in assistant/tool/tool/tool/assistant order.
2. Each of the three tool entries matches an independent canonical start/result/finish oracle and existing `results()`. Run/call/name/request/turn/output/error facts correlate; start<result<finish. SourceKey/OrderKey primitives derive identities from those real sequences, not the response under test.
3. Latest and addressed entries have exact complete bytes, position/revision/epoch/generation, field order, recorded state/result/finish/is_error and full ranges. Null earlier_content, content_complete=true, from0/to=total=actual UTF8 length and false fragment flags reject preview-only equality.
4. Existing source mutation changes the current body or deletes the main file, then changes AGENTS before another same-session Task. Complete A Latest/addressed entries/run/records remain exact; auth loads and actual wire observations stay unchanged.
5. Existing explicit B runs with the original saved A results in its provider input. Latest selects completed B at a new H. Its public previous_block cursor selects A once. A's complete block/entries/fields remain exact at that new read head; backward live_after is null. Old addressed entries/run/receipt/canonical prefix remain exact.
6. The existing wire/server/store finishes normally. The captured owned root must be absent before reachability is reported. No fallback cleanup supplies success.

New reads use authenticated public typed routes and existing privacy/no-store/nosniff guards. Canonical equality, auth counts and actual wire/no-request probes are specific no-new-work evidence. They are not C46's full counter vector or fresh-process proof. No new raw-history call is added. Existing native raw replay/SSE checks remain because those endpoints/B2 semantics are unchanged. The fixture's class named Browser is a Reqwest raw-SSE reader, not Chromium.

## Six existing variants and one new control definition

| Transport/provenance | Current main source before B | Original A H | B/historical-read H |
|---|---|---:|---:|
| WebSocket/native | changed body |24|41|
| WebSocket/recovered | deleted source |30|49|
| Labelled SSE/native | changed body |24|41|
| Labelled SSE/recovered | deleted source |30|49|
| Missing-MIME SSE/native | changed body |24|41|
| Missing-MIME SSE/recovered | deleted source |30|49|

The three retained test definitions each run native/recovered. These are six variants, not six new tests. Every captured variant reaches all new assertions, three saved tools, one previous-block read and strict root absence. Each retains the existing other-workspace Task and five real provider requests. Native and recovered refer to response-output provenance, not OS or session migration.

One new C definition at `fidelity.rs:820-915` applies the actual shared assertion to34 pointer/four structural mutations. It rejects output loss/change/current-body substitution and semantically equal pretty-printed JSON with coherent lengths. It also rejects state/flag/run/entry/position/revision/epoch/field identity/order/generation/range/completeness and missing/reordered entries/fields. Synthetic control DTOs are not positive H/J evidence.

## Source-bound checks

| Check | Executed result |
|---|---|
| Six Cargo gates: fmt/check/clippy/build/full all-target/doc |PASS, locked/offline as applicable |
| Full `cargo test --locked --offline --all-targets -- --test-threads=4` |1197 pass/11 existing ignores/0 fail-measure-filter; one full run |
| Doc tests |0 tests, PASS |
| New focused C |1 definition/38 mutations, PASS; overlaps full1197 |
| Extended focused producer |3 retained definitions/six variants, PASS; overlaps full1197 |
| Full unfiltered Node |3563 pass/0 fail-cancel-skip-todo |
| Typecheck/nonmutating assets |PASS/8 emitted JS assets |
| Unfiltered Playwright collection |81 cases/26 files; C15/active1 retained; no bodies |
| Working/HEAD/cached whitespace and finite preservation |PASS |

The full native gate ran26m55s with no added timeout/retry. Library920/10 and binary59/1 are included in1197/11, not extra totals. Four-thread success does not resolve historical default-concurrency SSE failures. The unchanged Windows-removal inventory test passes inside that unfiltered run; this is not a replacement independent audit. No standalone prior browser/process/CLI/measurement proof ran. Required full native regression includes ordinary process tests.

Evidence root (local record) contains per-gate START/BEFORE/AFTER/CHILD/TERMINAL, closed logs and identity records, REPORT.md, AUDIT.json, both FACTS files, PRESERVATION.json, BASELINE.json, ASSIGNED_DIFF.patch and SEALED.json. `record.mjs` verifies/inherits the approved six-value environment through the canonical launcher and explicitly records offline/four-thread overlays. Native Cargo/rustc proxy hashes/version facts are not mislabeled compiler binary hashes.

Parent (local record) independently rehashes34 stdout/stderr logs and17 identity logs. All13 required final checks bind current source before execution, approved environment/argv and identical after-state. All754 finite records/all753 nonassigned content/modes/index401/HEAD/branch remain. Exclusions are ignored caches/node_modules, external target/evidence and owned roots, not all ignored files.

Individual50ms `/proc` PID/start-tick/executable/cwd observations remain. Direct children close; no sampled owned identity survives. The native recorder423828/start3525278 is absent. Final native/build/browser candidate inventory is empty. All six explicitly captured roots remain absent. Short-lived unsampled descendants are not claimed inventoried.

Fresh scoped reviews (local record) and `.../wi-c3b48-review-b/REPORT.md` inspect source/integration/saved evidence without proof replay. They are not final whole-diff reviews.

## Initial failures and limits

- `controls-initial` retains compile exit101: four missing ToolExecutionEvent E0433 errors and unavailable Reqwest query E0599. Enum import and already URL-safe cursor interpolation correct only the assigned source.
- `joined-extended` retains zero selected/930 filtered and INVALID_ZERO_MATCHES. Its exit0/execution-pass flag is not positive proof. Inspected corrected filtering executes all three extended definitions; the required full gate is unfiltered.
- Initial FACTS.json retains a wrong suffix lookup selecting another fidelity.rs. Corrected facts and parent exact-path baseline identify the actual original source without replay.
- AUDIT.baseline_source hashes the166954-byte BASELINE.json snapshot, not the old assigned source. Do not confuse this field with FACTS_CORRECTED.original_source.
- Parent's guessed audit.mjs read ENOENT is disclosed; the actual finish-audit.mjs is inspected. No source/product effect follows.

G11-34 gains actual main-SKILL typed display/source-change-delete evidence at H/S/C. Browser main-skill/source fidelity, expanded parity/upgrade/transports/backscroll/peak measurements, required platform/hosted/full-browser closure, three final complete-diff reviews and owner acceptance remain open. C15/active1/application reader/ledger/history remain unchanged. No real credentials/private skills/auth commands/live generations, hosted mutation, commit/push/merge/release/deployment or new acceptance follows.
