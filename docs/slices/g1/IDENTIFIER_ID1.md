# ID1 producer correction evidence

Scope: producer receipt validation only. Not G1.1 acceptance. HEAD: 318b7f0da7d503e2e3a8cf33be84e78ebbe8affb. Local Linux/WSL execution; index empty, all changes unstaged and uncommitted.

## Implemented and reviewed

- src/identifiers.rs:3-10 validates exact 36-byte ASCII lowercase hyphenated non-nil UUID spelling. It rejects invalid values without normalization and accepts non-v4 UUIDs.
- src/run/mod.rs:378-384 validates a returned receipt before admission or identity assignment. Failure is static provider_correlation. Generation was polled, so attempted count and Unknown upstream outcome remain.
- Malformed later receipts preserve the previous summary.last_request_id and last_response. Current request remains None. Rejected event streams receive no poll; their queued tool calls cause no effect. Existing cleanup and final delivery remain truthful.
- src/run/observation_tests.rs:584-715 exercises malformed first/later receipts, counters, polling, tool effects, privacy, generated IDs, close-before-final and valid non-v4 receipts.
- src/execution/tests/identifiers.rs:3-122 exercises the real controller, PersistentObserver, SQLite, final receipt and exact reopen preservation. Four new test functions were added; parameter combinations are not separate unique tests.

Parent inspected the isolated production diff and regression sources. The implementation saved pre-edit src/tests/examples copies and its exact report in /tmp/wi-id1-baseline.4vgGuY. Three independent reviewers compared the complete 35-path increment against those copies, including two new source files and all current producer fixture adaptations. No source/test deletion or new ignore attribute was found. No storage production source, old-schema fixtures, native-ID policy, dependency, schema, managed-auth, browser, CI or prior display implementation changed in ID1.

## Executed checks

Implementation delegate reported these exact final commands passing after all fixture corrections:

- cargo fmt --all -- --check
- cargo check --locked --offline --all-targets
- cargo test --locked --offline --all-targets
- cargo clippy --locked --offline --all-targets -- -D warnings
- cargo build --locked --offline --all-targets
- cargo test --locked --offline --doc
- cargo test --locked --offline --test platform_support
- git diff --check

Reported all-target library result: 750 passed, 10 existing ignores. Binary: 59 passed, 1 existing ignore. Storage integration: 74 passed. All other executed targets passed. Doctests: 0. Platform test: 1 passed. No test was newly excluded.

Seven changed offline examples passed with cargo run --locked --offline --example NAME: run_offline, skills_offline, skill_loading_offline, persisted_run_offline, conversation_offline, host_offline, http_api_offline. These used synthetic/scripted producers; HTTP used loopback. They are not live evidence or display/browser acceptance. storage_offline was unchanged by ID1 and was not executed as an ID1 example gate.

## Independent review and execution

All three fresh ID1 reviews returned PASS with no blocking findings.

- review-a executed cargo test --locked --offline --lib identifiers (2 passes), --lib run::observation_tests (9), --test run_controller (39), --test platform_support (1), formatting and whitespace checks. Full native/example results were attributed to implementation evidence only.
- review-b executed the UUID predicate, malformed first/later controller, valid non-v4 and persistent SQLite/reopen tests. Each named function passed; the persistent function covers 26 cases. Whitespace and ancestry checks passed. The complete native chain was not repeated.
- review-c executed formatting, all-target check/Clippy/tests, doctests, platform and focused observation/persistence/controller/in-session/storage tests. Its all-target run reached the final example targets without a failure. It did not run the seven example binaries or the build gate separately. Do not attribute those commands to review-c.

These reviews cover ID1 and integration with prior A1-A5a work, not the accumulated final G1 diff. ID2 is deferred scope, not an ID1 pass.

## Initial failures retained

The implementation report and indexed diagnostics retained these failures and their fixture corrections:

1. run_controller: 38 passed, 1 failed because workloads still expected q1. Corrected the receipt expectation; 39 passed.
2. execution tests: 60 passed, 3 failed, 2 ignored because in-session tests still expected run-id-q1. Corrected current receipt expectations.
3. in-session rerun: 21 passed, 1 failed, 1 ignored because a process test retained a dynamic run-id-qN expectation. Corrected it; 22 passed, 1 ignored.
4. Formatting check initially failed on increment edits. Formatting changed no unrelated prior source, verified against the saved baseline.
5. First all-target run: 746 library passes, 4 failures, 10 ignores. Replay fidelity/interruption and unbound-history expectations retained request-0/legacy-request. Corrected only current producer expectations.
6. Replay rerun: 33 passed, 1 failed, 1 ignored because fidelity retained another request-0 assertion. Corrected it; later all-target tests passed.
7. Initial example group passed four examples, then conversation_offline failed because saved_tool still expected a-request-1. Corrected its current receipt assertions. The remaining example executions and exact final native chain passed afterward.

No failure was converted into a pass by excluding a required test. No broad native observation rule was introduced to make these tests pass.

## Preservation and limits

The original bounded-header reproducer remains active and unchanged in ID1: SHA256 54e73efe544d343db05e1beee025f69d95816dd4e20144875886484c2be467f8. Its old conflict test still passes because direct storage is intentionally unchanged until ID2.

The intentional opaque/513-byte native response acceptance test remains unchanged: SHA256 c5485a4752bf1c96b6655ce24f6f8bc293a197b09b38e485becaa07fd6c091c4. Protected VERIFICATION.md, verification.json and DESIGN_REVIEW.md hashes match verification-g1.1.json. Parent contract/evidence documents were unchanged by the implementation/review delegates.

ID2 owns novel storage admission, both summary paths, direct tool/results, supported OpenAI local identities, receipt precedence and historical compatibility. General native ID formats and genuinely oversized historical summary display behavior remain explicit decisions. No real-store inspection, credentials, auth commands, live generations, hosted CI, macOS or browser execution is claimed. No commit/push/merge/deployment was authorized or performed.
