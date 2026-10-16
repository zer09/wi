# C60: native SSE read retirement and fault attribution

**SCOPED IMPLEMENTED; both fresh source/evidence reviews PASS. All40PARTIAL; accepted=false.** This native test-control increment supplies current default-concurrency gate evidence. It does not recover the cause or exact phase of the two historical timeouts.

## Boundary and implementation

The old combined lifecycle test used one remaining observer guard as if every dropped observer's admitted SQL had retired. Those are different lifetimes. An owned read can open the catalog and then the session database. A store-wide one-shot Open failure can therefore be consumed by an older detached read.

C60 adds opt-in, library-test-only identities after actual storage admission and before worker spawn. The ticket stays in the owned worker. Normal bookkeeping follows action return, lifecycle release and maintenance-guard drop. Panic or abandonment produces an unsuccessful witness. A finite watermark waits for its admitted prefix, not global quiescence. Newer reads cannot hide an older pending read or prolong the prefix wait. Store-qualified IDs and registered-before-recheck notifications preserve attribution and multiple-waiter behavior.

The hook records actual selected Open-failure consumption, separately from arming and retirement. It distinguishes tracked, untracked and not-consumed states. The receipt identifies the actual worker/store, including isolated hook scopes. This witness does not independently certify healthy SQLx close. Existing quarantine and final storage-close checks remain authoritative.

| Changed source | Scope |
| --- | --- |
| `src/storage/mod.rs:137-189` | Test-only post-admission/pre-spawn registration and worker terminal ordering. |
| `src/storage/session.rs:116-146` | Classify the existing conversation_changes future; public signature and production behavior remain equivalent. |
| `src/storage/test_hooks.rs:155-167,268-281` | Opt-in tracker and actual selected-slot consumption evidence. |
| `src/storage/test_hooks/read_retirement.rs:1-364` | New closed tracker and four real-store controls. |
| `src/storage/conversation/reads/changes/tests/lifecycle.rs:140-437` | Five new storage controls and strengthened existing dropped-caller/panic/close assertions. |
| `src/http_api/router/tests/conversation_tests/sse/lifecycle.rs:229-471` | Combined case and both existing error_after_partial siblings wait through the prefix before arming the same unaddressed fault. Actual recipient must be newer, same-store and retired. |

No existing function was renamed. HTTP events, shared Reader, storage lifecycle/database policy, provider/host/B2, JS/assets, dependencies, workflows and examples remain unchanged. Existing privacy/no-ID/EOF/no-host-cancel/shutdown/completion/drain assertions and75ms/120s sibling heartbeat controls remain. Seventeen fixed phase labels identify entered waits in the combined case, not historical phases or independent completion facts. One raw-frame diagnostic became fixed text; assertions remain.

## Deterministic evidence and exact gates

Nine exact names are appended to the machine test inventory and bound at (local record). They cover unpolled/rejected admission, registration before maintenance progress, dropped callers, unsuccessful bookkeeping, authoritative quarantine, actual receipt before retirement, isolated/untracked/not-consumed controls, out-of-order completion, finite-prefix independence and notification safety.

The decisive old-recipient contrast pauses a real read's first catalog Open, drops its caller, arms a new failure after that Pause consumed its slot, then releases it. Its second session Open consumes the fault under the old ID. The contrast retires the old prefix before arming and proves a newer read consumes the failure. These are possible controlled schedules, not historical root-cause attribution.

All gates used locked/offline native tooling in fresh target (local record). Approved environment is (local record); only CARGO_TARGET_DIR changed from D4. Build additions were CARGO_BUILD_JOBS=2 and CARGO_NET_OFFLINE=true. RUST_TEST_THREADS was absent and no --test-threads override appeared. Build jobs do not serialize test execution.

| Saved command / record | Actual result |
| --- | --- |
| `cargo test --locked --offline --lib c60_` / `focused-controls-cursor-fix` | 9 passed,0 failed; focused977 filters explicitly retained. |
| Storage lifecycle selector / `storage-lifecycle` | 9 passed,0 failed; overlaps the new controls. |
| Exact combined and both sibling HTTP selectors | 1 pass each; three distinct native HTTP cases, not browser cases. |
| `cargo test --locked --offline --lib http_api::router::tests::` / `router-default` | One complete104-pass router invocation; ordinary default concurrency,0 failed/ignored. |
| `cargo test --locked --offline --all-targets` / `native-all-targets-detached` | 1252 passed,0 failed,12 existing ignored,0 filtered across23 harnesses. Library975/11 ignored and CLI59/1 ignored are included, not added again. |
| `cargo fmt --all -- --check` | PASS. |
| `cargo check --locked --offline --all-targets` | PASS. |
| `cargo clippy --locked --offline --all-targets -- -D warnings` | PASS. |
| `cargo build --locked --offline --all-targets` | PASS. |
| `cargo test --locked --offline --doc` | PASS with0 doctests; not a named-control pass. |
| `cargo test --locked --offline --test platform_support` | 1 pass, overlapping all-target execution. |
| `git diff --check` | PASS. |

Exact argv/cwd/source/environment/process/terminal/log records are under (local record), indexed by `FINAL_AUDIT.json`. Parent independently checked all14 final bindings, retained log hashes, current source and exact diff. Each final command has code0/null signal/close/reap/source-unchanged evidence. The recorder binds795 source rows plus6 assigned rows, whose union is796 paths. Parent report publication has a later documentation cutoff; native product inputs remain unchanged by that publication.

## Failures, interruptions and limits

- The first new-control run retained7PASS/2FAIL. Two multi-session fixtures used an invalid sequence0 cursor and were changed to use actual Latest live cursors before final gates. The original raw panic assertions were discarded; their original causes are not recovered by the later pass.
- Two earlier all-target launches lost their tool route and terminal evidence. `INTERRUPTED_ALL_TARGETS.json` and `INTERRUPTED_ALL_TARGETS_2.json` remain INCOMPLETE. Their completed-body counts, terminal states, exact causes and complete descendant retirement are unavailable. One partial sanitized log survives. Neither is green or a claim that no later failure occurred.
- Immediate line flushing, then a recorder independent of the long tool-call lifetime, corrected evidence persistence. The completed detached-recorded gate is separate. Its native argv/source/default concurrency/assertions/deadlines did not change.
- Initial harmless mkdir/edit/unused-helper/parser diagnostics and the implementation audit's assigned-input comparison error remain in REPORT.md. Parent also initially compared795 source rows with the796-path inventory before accounting for the separate assigned array; `AUDIT_CORRECTION.json` preserves that metadata error. Corrected checks passed without a test replay.
- Retained logs contain sanitized test names/status/counts/compiler phases and fixed labels. Discarded raw-output hashes do not replace retained logs or establish error causes. No API/DOM/request/response body or token is published.

The historical103/1 router failures remain failed at their recorded cutoff. C60 establishes current test-control and default-concurrency results, not a retrospective cause, universal scheduling guarantee or production ownership defect. Final process evidence covers40 sampled known identities, not complete descendants or all-host retirement. Earlier interrupted attempts have narrower limits.

## Reviews, preservation and continuation

Both fresh complete-C60 source/saved-evidence reviews PASS with no findings and zero product bodies:

- (local record).
- (local record).

Their cutoff covers the six-file source increment and integration, not this later parent-authored publication or the complete master diff. Parent (local record) freezes8 review files and preserves127 implementation files/294 prior sealed records/796 runtime-source paths. Old native inputs are438 unchanged current paths plus5 original assigned-file archives; current native inputs total444. The old a59 executable is preserved, not presented as a current-source artifact.

No ignored one-shot body, browser case, attempt marker, real credential/private skill/auth command/live provider or ledger use occurred. Required native synthetic loopback traffic is separately authorized; this is not a packet-level network audit. Retained failed fixture families remained unaccessed. Shared TMPDIR stays0755; new evidence/build roots stay0700. Source-preservation claims exclude volatile ignored caches.

Parent publishes the canonical human/JSON increment and makes the owner-authorized local checkpoint after documentation checks. The two staged C55 handoffs remain outside that commit. Current assertion inventory, browser-pagination adequacy, auxiliary/examples/browser gates, three final complete-diff reviews, explicit-push exact-head CI and owner acceptance remain open. C15/active1, application reader/SSE/no-store/access/pins/deadlines, release-to-DOM WAIVED_BY_OWNER and ledger remain unchanged. No push or acceptance follows C60.
