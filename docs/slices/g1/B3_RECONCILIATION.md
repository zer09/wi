# B3: server task reconciliation

Contract: **g1.1**. Status: **SCOPED LOCAL COMPLETE; REVIEW-A/B PASS**. Accepted: **false**.

## Implemented behavior and source

Protected POST /v1/sessions/{sid}/runs/reconcile uses the existing strict Task body and common bearer/Host/Origin/body/media/size boundary. It accepts no query keys. Static matching precedes the generic addressed-run route.

The unchanged raw_receipt proof requires the actual accept_history method/hash/input/run/text and canonical acceptance/selection. A matching receipt returns exactly {api_version:1,state:"accepted",acceptance:ReceiptView,run:RunView}. The handler reads the current addressed run after proof. Missing or mismatched run is integrity. State may advance between those reads; this is not a frozen display snapshot or constant-cost proof.

Actual session command receipt absence returns exactly {api_version:1,state:"not_found",acceptance:null,run:null}. This is point-in-time absence, not rollback evidence or permission to redispatch. Conflicts and failed reads keep existing flat errors/stages/certainty. Catalog-only creation IDs have no session command receipt; they return not_found without catalog lookup. Cancel remains its existing distinct signal scope.

No context preparation/current configuration or account lookup, RunClient dispatch/cancel/retry, provider/tool effect or display-history walk occurs. Existing explicit-open migration/interruption is the sole maintenance qualification. Raw endpoints, strict Tool/Reuse facts, B2 provider context, lifecycle/drain/quarantine, dependencies/auth modes and Unix policy remain unchanged.

Whole B3 source footprint:

- src/http_api/router.rs:127,162-163,172-234,493-502: route, methods and strict Task dispatch.
- src/http_api/router/runs.rs:104-129: distinct reconcile_task handler. raw_receipt:29-102, submit:131-196 and old private reconcile:198-209 remain byte-identical to the original baseline.
- src/http_api/dto/mod.rs:431-463: closed four-field DTO, existing nested ReceiptView and RunView.
- src/http_api/router/tests/run_tests/mod.rs:24: test registration.
- src/http_api/router/tests/run_tests/reconcile_task.rs:1-361: real HTTP/storage helpers and behavior.
- src/http_api/router/tests/run_tests/reconcile_task/boundaries.rs:1-390: real HTTP/TCP boundaries.
- src/http_api/router/tests/run_tests/reconcile_task/proof.rs:1-446: receipt proof, errors and lifecycle.

## Execution and fresh reviews

All **17 B3 tests passed** through actual TCP/Axum, SQLite/public writers and synthetic scripted providers. They cover exact DTO/identity/decimal/private exclusions; actual active/terminal task and AddNumbers bytes/is_error; large and off-screen tasks; changed/missing setup without preparation; absence during active work and later actual acceptance; exact text/run/incompatible session command conflict; method/hash/input/source corruption; read error/unknown certainty; warm full-table snapshots and effect counters; cancellation, reopen interruption qualification and admitted-read drain.

Implementation evidence: (local record) and closure.json, including all19 recorded command groups, logs/exits/PIDs/times/hashes.

Six final locked/offline native gates passed: fmt, all-target check, warning-denied Clippy, unfiltered all-target tests, all-target build and warning-denied doctests. Unfiltered total: **1,184 passed / 11 existing ignores / 0 failed / 0 filtered**. Library908/10; binary59/1; doctests0. Platform1 passed; static-only verify inventory and tracked/index/all108-untracked-file whitespace passed. Source inventory counts are not runtime test counts.

Fresh independent complete-original-B3 reviews both returned **PASS**, no findings:

- review-a: (local record). Independently40 run-tests passed, including all17 B3; platform1 and fmt passed. All native log hashes/counts inspected, not a second unfiltered rerun.
- review-b: (local record). Independently17 B3 tests passed. Native gate records inspected, not a second full execution.

Their overlapping counts are not summed. Review-c remains owner-waived and uncounted. These scoped reviews are not the required final complete master->checkpoint->new reviews or whole-row acceptance.

Cargo ran serially through direct Bash with external real-exit logs and periodic progress. TMPDIR=(local record), CARGO_TARGET_DIR=(local record), RUSTFLAGS='--cfg a5b2_max01_biuto9e0'; doctests additionally RUSTDOCFLAGS=-Dwarnings. Reviews serialized Cargo with an external flock. All owned recorded commands/PIDs finished. Context Mode inspected completed Cargo logs only.

## Original failure and correction

The first B3 delegate stopped on the parent's erroneous409 expectation for a catalog creation ID. Its actual H response was200 not_found. Original report, assigned contract, test source, output and command remain at (local record) and copied under the continuation's original-failure/. Its **0 passed/1 failed, exit101** remains FAILED historical evidence.

The owner explicitly directed continuation. The authorized correction changed only that expectation/name: b3_creation_operation_is_a_conflict_not_receipt_absence -> b3_catalog_creation_operation_is_session_receipt_absence. The corrected exact200/not_found probe passed. There was no governing-policy conflict or receipt-policy change. An initial final fmt check failed on scaffold dispatch; a formatting-only correction passed. Both logs remain. Review-b's optional manifest helper initially failed on absence-record shape, then passed; it was not a product defect.

The parent incorrectly classified the known correction as an unsolvable shutdown blocker. PowerShell shutdown ended exit137; the owner confirmed shutdown and rejected that classification. Delegate failure alone does not justify another shutdown. The owner authorized continued implementation.

The previous categorical no-private-action claim was incorrect: the parent read ~/.pi/agent/skills/session-handoff/SKILL.md while handling the stopped run. This is disclosed and was not repeated. A later parent Context Mode JSON-inspection helper failed on an incorrect optional key and reported its small script under /tmp/.ctx-mode-G63WQv. No Cargo/store/build output ran there; subsequent parent JSON inspections use env-bound uv. These inspection failures did not stop work or change source. No automatic cleanup occurred.

## Preservation and remaining scope

Original B3 baseline:691 records, SHA699d781803a5154053c3c2be25c0f9847da68db5c48b74db2eff8fe5fb4efe6c. Continuation before:693 records. Final:695 records, SHA521a28261ba09abf8a4c30260e84e46cf23399f8419d3e6301d01e3d5355d5ad, at (local record). All three historical absences remain. Copied files/Git/diffs are under original-b3-before/, before/, final/, original-b3-diff/ and continuation-diff/.

Parent and both reviewers matched every final record and1,170 Git-file hashes/modes before this documentation update, with no extra paths. HEAD318b7f0da7d503e2e3a8cf33be84e78ebbe8affb, required ancestry and empty index remain. Ignored CodeGraph effects are separately inventoried; no cache was cleaned. All work remains unstaged/uncommitted.

Current matrix: **27 PARTIAL / 13 NOT_RUN**, no accepted rows. G11-21 has completed scoped H evidence. G11-28 has H-only actual receipt/uncertainty/off-screen/no-redispatch evidence; browser UX remains open. G11-20 remains H-only and G11-37 still needs final scripts/examples/browser closure.

Next is Phase C1: closed display validators and a pure small display store, before client/UI integration. Browser loading/rebase/commands, new offline example, prototype retirement, assets/CI, joined proof, measurements and final complete-diff closure remain open. No real credentials/auth/live generation/hosted or Git mutation occurred. Ledger remains31/50 used,19 remaining.
