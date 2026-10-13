# B2: display SSE HTTP increment

Contract: **g1.1**. Status: **IMPLEMENTED; SCOPED REVIEW PASS/PASS**. Accepted: **false**.

B2 here names the second Phase B HTTP increment. Retained B2 provider context is unchanged. This evidence does not establish browser/J behavior, hosted CI, final complete-diff review or G1.1 acceptance.

## Implemented behavior and scope

`GET /v1/sessions/{sid}/conversation/events?after=<LiveCursor>` requires after, even when Last-Event-ID is present. One valid header must exactly match the decoded query spelling. Initial resource/read validation and shared bounded encoding finish before200. Unknown/repeated keys, methods, bodies, media/size and bearer/Host/Origin controls remain strict. Raw /events retains its separate optional raw-after/header behavior.

Frames use event wi.conversation, ID exactly next_after and data exactly DisplayJson::Changes bytes. Partial batches retain the last emitted tuple; exhausted batches use their snapshot watermark. Private-only advancement emits an empty changes batch. Unchanged caught-up reads do not repeat frames. More batches read immediately; caught-up reads wait250ms. Idle comments use15s. SQL and views retire before yielding; no producer task or queue runs ahead. Later errors emit safe no-ID wi.error and end. Shutdown/EOF is observation loss, not execution completion or Cancel.

Reviewed source references:

- `src/http_api/router.rs:123-126,190-199,311-366`: new route and separate raw parsing.
- `src/http_api/router/conversation.rs:23-71`: required after and exact single-header comparison.
- `src/http_api/router/conversation/events.rs:21-152`: initial read/encoding, shared frames, pull polling and endings.
- `src/http_api/router/conversation/events/test_hooks.rs:1-68`: cfg(test) typed retired-read/observer/heartbeat seams, not raw/CDP interception.
- `src/http_api/router/tests/conversation_tests/sse.rs:142-605`, `sse/parity.rs:92-266`, `sse/lifecycle.rs:145-584`: actual H and unit controls.

Original baseline to current changes thirteen paths: eight modified and five new. No deletion. Remediation changes only lifecycle.rs. Raw-stream source, DTO mapper, storage/projector, dependencies, provider/controller/registry/B2, auth modes, lifecycle names and Windows policy remain unchanged.

## Actual observations and commands

Thirteen new H tests use real TCP/Axum/SQLite/public writers. Lifecycle tests use an actual scripted RunHost; parity tests use actual synthetic ToolRegistry outputs. Four new unit controls cover intervals and test-frame selection. These seventeen named tests are not a task-wide unique total.

- An actual latest HTTP H/live_after precedes pre-attach text, Tool, rename and new-block commits. The stream returns exact self-contained shared data/ID, without independently reading a starting now.
- Private binding advancement produces an exact empty batch/new watermark without internal canaries. Caught-up polls emit no duplicate conversation frame.
- Count-limited traversal covers145 Tool starts plus one assistant in three batches. Byte/moving-revision traversal covers26 nonhuman identities in four batches, including524,287 and524,283 encoded bytes. Exact tuple boundaries/head and final state are verified.
- A generic display-upsert normalizer matches actual page/addressed IDs/order/grouping/content/state at controlled heads for partial, pending/result-before-finish/Reuse, terminal/result and reopened interruption. This is H parity, not a browser reducer or every-delta audit proof.
- Initial legacy422 preserves genuine schema2 migration/canonical/receipt/raw bytes and healthy blocks. Actual unread TCP observers stop pull traversal while another observer, same-session writer and scripted host progress. Admitted SQL and drain controls retain ownership after dropped waiters.
- Idle H controls use a cfg(test)75ms override and an independent production-interval assertion. No15s wall-clock guarantee, universal RSS claim or exact network-delivery guarantee is inferred.

Latest command records: (local record). Six native gates passed: fmt, locked/offline all-target check, Clippy with -D warnings, unfiltered all-target tests, all-target build and doctests with RUSTDOCFLAGS=-Dwarnings. Platform and tracked/all103-untracked-file whitespace checks passed.

Unfiltered result: **1,167 passed, 11 existing ignores, zero failed/filtered**. Components:891 library,59 binary,216 integration and one example-target test. Example-target tests do not establish example-main execution. Focused lifecycle9, conversation29 and retained HTTP135 overlap; they are not summed.

Every Cargo test used direct Bash, external logs, real OS exits and periodic process/progress checks. Context Mode inspected completed logs only. TMPDIR=(local record), CARGO_TARGET_DIR=(local record), current-repository RUSTFLAGS='--cfg a5b2_max01_biuto9e0'. No owned process remained unfinished.

## RB-B2-01 and review evidence

The first completed gate returned PASS / CHANGES_REQUIRED. Review-b's conversation run had23 passes/one failure at the immediate-error assertion. Its unexpected frame was not printed and remains UNKNOWN. Independent verification captured a permitted queued TCP heartbeat followed by strict safe storage.io/no-ID/EOF and normal host completion. That capture does not identify the original frame.

Remediation adds one fixture-local selector bounded to16 frames and the existing total watchdog. It skips only exact complete `: keep-alive\n\n`. It returns unexpected application/mixed/malformed frames immediately; EOF/exhaustion fail. Raw Reader semantics and error/EOF/cursor/provider-close/host/shutdown assertions remain. Three selection controls and two actual-TCP queued/no-comment controls pass. Production code did not change.

Evidence chain:

- Implementation: (local record).
- First review-b failure: (local record).
- Independent verification: (local record).
- Remediation: (local record).
- Fresh complete review-a PASS: (local record).
- Fresh complete review-b PASS: parent-saved completed tool report (local record); original evidence directory (local record) has no report file.

Both fresh roles completed with no findings. Each independently passed135 HTTP tests including29 conversation tests. Review-b also passed43 changed-reader and13 wire tests, formatting and platform. Supplied full native gates remain attributed to remediation, not independent reruns. Review-c remains waived/uncounted; B1's failed role/owner disposition is unchanged. Final three complete-diff reviews remain required.

## Preservation, failures and limits

Before documentation updates, parent/reviewers matched all690 inventory records,687 present and three historical absences. Final manifest SHA256: `3af0a522be1c1ebe65207ba609a4c78fa136b8bda863e682600588d9d32b1217`. All1,170 Git-file records remain unchanged. HEAD318b7f0da7d503e2e3a8cf33be84e78ebbe8affb and empty index remain unchanged. Parent B1 docs and owner generated/untracked work stayed exact during implementation/review.

Initial compile/fixture failures, interrupted UNKNOWN broad-filter run, first unfiltered timeout failure and the23-pass/one-fail review remain archived. Only the new test reader timeout changed to60s. Pre-fix selection controls had one pass/two failures. External evidence-checker corrections and original logs remain recorded; no required test was silently removed, ignored or filtered.

At the B2 checkpoint, the matrix was **25 PARTIAL / 15 NOT_RUN**, with no accepted rows. Reconciliation followed as provisional B3; see B3_RECONCILIATION.md. Offline example, browser replacement/disposition/CI, joined proof, measurements and final closure remain open. No new polling changes endpoint, dependency, production provider/tool, budget or retry policy was added. No real credential/private-skill read, auth command, live generation, hosted action or Git write occurred. Ledger remains31/50 used,19 remaining. Changes remain unstaged/uncommitted.
