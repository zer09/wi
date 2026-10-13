# B1: display HTTP reads

Contract: **g1.1**. Status: **IMPLEMENTED; OWNER-AUTHORIZED CONTINUATION**. Accepted: **false**.

B1 adds actual H evidence to the scoped-reviewed Rust reads. It does not establish display streaming, browser behavior, joined producer proof, hosted CI or G1.1 acceptance.

## Implemented scope

Three protected GET interfaces use existing explicit session open, public SessionHandle reads and exact shared DisplayJson bytes:

- `/v1/sessions/{sid}/conversation`: Latest, or exactly one before/within cursor.
- `/v1/sessions/{sid}/conversation/entries/{run_id}/{entry_id}`: current addressed entry, without query.
- `/v1/sessions/{sid}/conversation/content?cursor=<ContentCursor>`: required content continuation.

Storage errors retain ErrorView::storage. CursorInvalid/400, CursorStale/409 and DisplayUnavailable/422 use the specified static flat errors. Only Latest supplies live_after. Typed reads retire SQL before encoding/delivery. Existing explicit-open migration/interruption remains the sole maintenance qualification.

B1 source references describe the reviewed tree:

- `src/http_api/router.rs:107-215,298-348`: routes, allowlists, typed parsing and dispatch.
- `src/http_api/router/conversation.rs:11-125`: public-read adapter, shared encoding and one-segment entry decoding.
- `src/http_api/dto/errors.rs:146-155`: conversation error mapping.
- `src/http_api/router/tests/mod.rs:77-109`: narrow loopback HTTP origin fixture; old fixture defaults remain.
- `src/http_api/router/tests/conversation_tests.rs:224-699` and child `security.rs`, `tools.rs`, `legacy.rs`, `limits.rs`: actual TCP/SQLite proof.

The footprint is three modified existing paths and six new paths, nine in total. No raw route, canonical writer, B2/provider context, dependency, authentication mode, lifecycle event/enum or Windows policy changed. Started + ToolResult and enum naming remain separate proposals.

## Actual execution and observations

The implementation and completed review-a ran all 13 new tests through actual reqwest/TCP/Axum and real SQLite/public writers. The saved review-b log separately contains the same successful HTTP execution. These are H fixtures, not browser or joined OpenAI generation.

| Observation | Evidence |
|---|---|
| Latest B before A, within B, empty/created/renamed sessions | Exact response bytes match shared Rust views. Seventy Tool entries plus one assistant traverse in order; the newest count-limited segment has 64 entries. No duplicate human anchor. |
| Content/byte limits | Unicode/NUL/escape-heavy human traversal restores 120,000 bytes in eight fragments. Assistant traversal restores 120,420 bytes across 85 fields, including 42 empty fields. A large B page contains 16 activities and 524,287 encoded bytes. Tool/name traversal restores 132,009 bytes in nine fragments. |
| Cursor classifications | Current/append-compatible boundaries succeed; replaced content returns 409; malformed/future/wrong-resource returns 400; missing returns 404. Backward/content responses have no live cursor. |
| Integrity and legacy availability | Index/head/source/Tool damage returns actual storage errors without repair. Independently populated schema2 legacy data migrates on first HTTP open; oversized mandatory headers return static 422 while raw/canonical/receipt bytes and healthy blocks remain readable. |
| Actual ToolRegistry facts | Success, error-shaped success, gateway/output-limit errors, pending/result-before-finish, Reuse, empty/absent output and cross-run isolation retain real output/error/state. Reuse has no second effect and does not inherit its target's later finish. |
| Access and lifecycle | Every route retains bearer/Host/Origin/input/preflight/common headers. Literal-loopback HTTP works without TLS/proxy/new auth. Warm logical tables remain unchanged. Paused owned reads retain captured head; writers and shutdown behave correctly after read retirement. |

Implementation command records are in (local record) with exact argv/env/cwd/times/PIDs/exits and matching logs. Six native gates passed: formatting, locked/offline all-target check, Clippy with `-D warnings`, unfiltered all-target tests, all-target build and doctests with `RUSTDOCFLAGS=-Dwarnings`. Platform and tracked/all-untracked whitespace checks passed.

Unfiltered result: **1,150 passed, 11 existing ignores, zero failed/filtered**. Components: 874 library, 59 binary, 216 integration and one example-target test. Example-target tests do not establish example-main execution. Focused reruns are not additional unique tests.

Cargo tests used direct Bash, external logs and periodic process/progress checks. Context Mode only inspected completed logs. Commands used TMPDIR=(local record), CARGO_TARGET_DIR=(local record) and RUSTFLAGS='--cfg a5b2_max01_biuto9e0'. No owned command remained unfinished.

## Review and continuation authority

- **review-a completed PASS**: (local record). It independently passed 118 HTTP tests, shared controls, platform, formatting, Clippy and whitespace. It verified supplied six-gate evidence separately.
- **review-b harness FAILED**: routes_unavailable after invalid_result, 616.4 seconds. Its saved report is (local record) and says PASS with no findings. `http-regressions-2.exit` is 0; its log has 118 passes, one existing helper ignore and zero failures. The first equivalent log has no captured OS exit and is not promoted to a known exit.
- The owner authorized using the saved review-b PASS report and proceeding without a rerun. The failed harness role remains failed and uncounted. This is not a completed automatic gate.
- Review-c remains owner-waived, not run or counted. Final complete-diff reviews remain required.

Both saved reports identify no blocking B1 source finding. Completed evidence and operational failures remain distinct.

## Preservation and failures

Implementation report: (local record).

The final manifest contains 684 records, 681 present and three preserved historical absences. SHA256: `dac5df361d29583753bce09cb50310d8a19115ed797c4ea67f7a4b2e38d2f822`. The parent matched all records, bytes/modes, full inventory and status before documentation updates. Reviewer audits preserve all 1,170 Git-file records. HEAD remains `318b7f0da7d503e2e3a8cf33be84e78ebbe8affb`; the index is empty.

Retained initial failures: compilation exit 101; first fixture correction eight passes/four failures; second correction ten passes/two failures. Corrections fixed only new fixture access/setup/expectations and preserved strict canonical validation, Tool/Reuse controls and lifecycle names. Logs remain in the implementation directory. No required test was removed, ignored or silently filtered.

At the B1 checkpoint, the matrix was **22 PARTIAL / 18 NOT_RUN**, with no accepted rows. Display SSE followed in B2; see B2_SSE.md. Reconciliation, offline example, browser replacement/disposition/CI, joined evidence, measurements and final closure remain deferred. No polling changes endpoint is authorized. No real credential/private-skill read, auth command, live generation, hosted mutation or Git write occurred. Ledger remains 31/50 used, 19 remaining. Local changes remain unstaged and uncommitted.
