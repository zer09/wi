# V1-A acceptance matrix

Contract **v1a.0**. Baseline `50f4dffe5d912615014edc46cf1bf1e1b68e6857`.
All **30 rows V1A-00 through V1A-29 are NOT RUN**. CONTRACT.md and API.md are normative.
A green old suite is baseline evidence, not new host acceptance.

## Fixtures and real paths

Use real bundled SQLite in private temporary roots, an independent scripted provider,
actual AddNumbers/S2 tools, and the existing OpenAI-Codex loopback adapter. A/B are
successive explicit tasks in one stored conversation, each with a real tool cycle.
Have a second session with overlapping run/call IDs for isolation. Use barriers at
actual acceptance/binding/tool/result SQL and provider waits. Never use a real profile,
private skill file, auth command, smoke runner or model request.

New host tests must dispatch through RunClient::submit and obtain history from its
actual writes. A manually spawned run_in_session or a directly installed Replay DTO
cannot substitute for the host path. Keep existing component tests. New joined tests
must prove host -> B2 -> SQLite -> real adapter -> real new tools -> stored result.
Test-only observation/barrier helpers may be factored without production restructuring.
Do not await a public locked history operation while deliberately pausing its writer;
use an independent read-only SQL snapshot or place the barrier after commit.

| ID | Requirement | Required observations | Status |
|---|---|---|---|
| V1A-00 | Baseline and scope | Record actual HEAD, ancestry, complete worktree, toolchain, dependencies and existing gate outcomes. Preserve B2-E01 closure, first failures, no-auto-resume, ledger and frozen earlier reports. | NOT RUN |
| V1A-01 | Additive API and ownership | RunHost consumes the non-Clone SessionStore; weak clients and cloneable passive tickets have required methods/Send+Sync behavior. Construction performs no provider/tool/storage work; unavailable runtime is a static error. Existing public signatures remain unchanged. | NOT RUN |
| V1A-02 | Atomic dispatch versus shutdown | Barrier-controlled races include registered-but-not-polled jobs. Exactly one side wins host admission; no post-close spawn escapes drain. Ticket return alone creates no durable acceptance claim. TaskTracker registration is inside the host gate; close alone is not admission enforcement. | NOT RUN |
| V1A-03 | Real early receipt | Pause actual selected acceptance before commit: accepted() is pending, no provider opening. Release commit and pause provider work: accepted() yields exact original range before task completion. Initial conversation replay is empty. Current prepared input and definitions are unchanged. | NOT RUN |
| V1A-04 | All waiters can disappear | Drop accepted() waiter during SQL, completion waiter during model/tool wait, all tickets and all clients. Keep the owner: actual run continues and commits final output. A later independent history reader observes it. No sink error, duplicate effect, cancellation or leaked status entry. | NOT RUN |
| V1A-05 | Duplicate receipt-first behavior | Matching duplicate while active, completed and reopened returns exact duplicate receipt/result with no fresh definitions/capability/replay/auth/execute checks. Cancelled duplicate still follows B2 receipt precedence. Changed request/method/run identity conflicts rather than coalescing by ID alone. | NOT RUN |
| V1A-06 | Concurrent absent receipts | Two host submissions whose original receipt lookups are both absent yield one executor and one duplicate. Acceptance notifications and completion variants are truthful. A direct existing storage acceptance winning the race produces no host generation. | NOT RUN |
| V1A-07 | No hidden task queue | Different new request targeting an active session receives existing B2 rejection without waiting for its completion or later auto-start. Independent session progresses concurrently. No rejection of valid work solely because another session is active. | NOT RUN |
| V1A-08 | Scoped explicit cancellation | Cancel addresses both session/run IDs; unknown returns NotTracked without SQL/open. Repetition is harmless; no other session/token changes. Requested proves signalling only. Completion selected before a late signal is not rewritten. | NOT RUN |
| V1A-09 | Cancellation boundaries | Exercise before pure admission, during acceptance commit, provider opening, model wait, tool intent, active cooperative tool, result commit and final recording. Preserve actual result, certainty and upstream distinctions; await admitted SQL; no fake cancelled tool output. | NOT RUN |
| V1A-10 | Failure fidelity and receipts | Session-open/preflight/history/acceptance/recording failures are represented by actual stages and errors. Acceptance cleanup warning is not Ok accepted(), but known receipt stays in failure. Acceptance survives a later failure; final cleanup warning remains existing Executed behavior. | NOT RUN |
| V1A-11 | Orderly shutdown | begin_shutdown is once-only; stops new dispatch, signals existing tokens, awaits jobs and only then closes store. Barriers prove cancellation/final records can commit while draining. Closed is not a claim all runs succeeded or upstream work terminated. | NOT RUN |
| V1A-12 | Shutdown during SQL | Pause accepted SQL/result/final write, request shutdown, release: same future is awaited, stored output/certainty retained, no root reacquisition before drain. Test postcommit lost reply and known cleanup warning using existing hooks, not invented rollback. | NOT RUN |
| V1A-13 | Shutdown waiter loss | Concurrent begin_shutdown calls share one coordinator. Drop the first/all waiters and later await a new ticket; drain still completes, storage close is not retried by another worker, late submit is rejected. Coordinator must not wait on itself in TaskTracker. | NOT RUN |
| V1A-14 | Owner Drop versus client Drop | Dropping client/ticket leaves task running. Dropping the actual owner requests cooperative shutdown even while clients survive; those clients reject new submissions. Kept runtime permits drain. No synchronous blocking in Drop or async destructor success claim. | NOT RUN |
| V1A-15 | Worker loss and quarantine | Isolated child tests for unwind during provider/tool/SQL-related ownership and dropped worker before first poll. Tickets terminate as WorkerLost where no actual result exists; host fails closed/cancels siblings, no fabricated DB terminal, existing ExecutionHold quarantine retains lease. Normal errors are not WorkerLost. | NOT RUN |
| V1A-16 | Runtime/process exit | Destroy runtime/exit child at accepted/model/tool/result phases. Reopen in new process preserves committed evidence and existing interruption rules. Constructing host, listing and reading perform zero provider/tool work. Old duplicate never resumes. No physical power-loss or panic=abort recovery guarantee. | NOT RUN |
| V1A-17 | Ticket state races | Receipt and completion cannot overwrite each other. Late/multiple waiters receive stable original values. Zero receivers at send does not lose state or fail the run. No watch borrow/registry lock survives await; every waiting path resolves on a real terminal/loss state. | NOT RUN |
| V1A-18 | Resource retirement | Finite repeated submissions remove completed registry/tracker entries without lifetime cache or quota. Retained ticket keeps only small identity/receipt and its final Arc, not store/gateway/tools/lease. Shutdown releases healthy ownership even with old tickets retained. | NOT RUN |
| V1A-19 | Independent history while running | A second reader sees actual committed partial text and exact tool output before continuation through existing short history_page/run_record APIs; dropping it has no effect. Rename during provider wait succeeds and remains ordered. No store/session lock across model/tool wait. | NOT RUN |
| V1A-20 | Explicit replay after host reopen | A runs through host and real tools, host shuts down, new store/host starts with zero executions, explicit B restores only A's validated context and executes only new effects. Incomplete/unbound history remains readable and fails without repair. | NOT RUN |
| V1A-21 | Joined WebSocket host path | Real RunClient dispatch -> B2 -> real SQLite -> actual WS loopback for A and B, native and recovered output. Verify first empty history, B fresh socket full validated context/no old parent, later result-only delta/new parent, actual acceptance/binding/result barriers and stored terminal. Dropped A ticket must not cancel A. | NOT RUN |
| V1A-22 | Joined SSE host path | Same joined host A/B for labelled and missing-MIME SSE, exact effective/native history and results each request. Include a real failed-admission/identity case with current code/upstream uncertainty and no retry. Model/tool/storage source cannot be bypassed by a prepared expected replay object. | NOT RUN |
| V1A-23 | Auth/replay boundaries | Joined synthetic account X A, Y explicit next task rejects before conversation payload transmission, records truthful result, later X succeeds. No second credential load/account search. Public host inherits current exact requested-model and closed-exchange policy. Old results/opaque fields unchanged. | NOT RUN |
| V1A-24 | Context and S2 through host | Real catalog preparation/load_skill result persists in A. Change/delete skill source before B; exact saved bytes replay without old-source read. Current preparation remains independent. Historical skills register/execute no new resource, script or permission. | NOT RUN |
| V1A-25 | Compatibility and exclusions | Existing P1-A/B1/B2/C1/S1/S2/R1/auth tests pass; old direct APIs/callbacks remain. No dependencies/features/schema/event/error mapping/provider/tool/auth change. No RunLimits, runtime deadline, retention/task-count cap, retry, network server, CLI persistence or GUI. | NOT RUN |
| V1A-26 | Public host_offline example | Synthetic real SQLite, actual S2/add tool, scripted provider, early accepted receipt, drop all A observers, independent saved-output read, normal A completion, orderly shutdown, no-work reopen and explicit B. Use public host/control APIs, not hidden direct-run or manual replay shortcut. Six older examples pass. | NOT RUN |
| V1A-27 | Measurements and watchdog evidence | Record dev/release dispatch-to-receipt, receipt-to-completion, cancellation-to-drain and shutdown durations plus active-entry/connection observations under finite fixtures. No SLA/fastest claim. Preserve every watchdog failure and runner context; diagnose rather than suppress or repeatedly rerun until green. Test sizes never become product limits. | NOT RUN |
| V1A-28 | Reports, docs and privacy | Both reports have all30 unique rows, actual producer/consumer paths, failures/fixes/review scope, exact revision and unchanged ledger. Current docs distinguish local host from network service/auth/GUI. Public Debug/static host errors expose no content; panic-hook limitations stated. Frozen prior reports unchanged. | NOT RUN |
| V1A-29 | Independent review and exact-head CI | Fresh complete-diff review includes all untracked files and joined host transport tests, dispatch/shutdown/drop races, early receipt point, failure retention and quarantine. All local gates pass; after authorized push both exact-head workflows/all six Cargo steps on3OS pass. Do not disable jobs, weaken assertions or infer Node/example coverage from Cargo CI. | NOT RUN |

## Required local commands

```text
cargo fmt --all -- --check
cargo check --all-targets
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo build --all-targets
cargo test --doc
uv run scripts/verify.py
node scripts/cli_retest.mjs --self-test
cargo run --example run_offline
cargo run --example skills_offline
cargo run --example skill_loading_offline
cargo run --example storage_offline
cargo run --example persisted_run_offline
cargo run --example conversation_offline
cargo run --example host_offline
cargo run --release --example host_offline
git diff --check
```

Inspect untracked whitespace too. Cache/build traffic is not model usage; normal build
caches may be used, but credentials and owner skill roots must remain isolated. Inspect
commands before running; never run two_turns/smoke/live/auth commands. Separate executed
parent tests, ignored child helpers, source definitions, examples, doctests and reruns.
No minimum numeric count is a substitute for the listed assertions.

## Reports produced by actual work

Create docs/slices/v1a/VERIFICATION.md and verification.json after verification.
Human report: exact source/worktree/environment; scope; baseline; APIs/notifier and
ownership diff; all30 rows; actual commit/cancel/drop/duplicate/shutdown traces; joined
transports; first failures/fixes; commands/counts; review; performance; remaining limits.
Machine minimum (initial template, NOT evidence):

```json
{
  "contract":"v1a.0", "status":"NOT_RUN", "accepted":false,
  "baseline":"50f4dffe5d912615014edc46cf1bf1e1b68e6857",
  "tested_revision":null, "worktree":null, "environment":{},
  "matrix":[], "commands":[], "ownership_and_fault_evidence":[],
  "joined_transport_evidence":[], "reviews":[], "submitted_ci":[],
  "performance_observations":[], "limitations":[],
  "network_service_implemented":false, "normal_cli_persistence_implemented":false,
  "live_started":false, "real_credential_reads":0, "provider_generations":0,
  "ledger":{"used":31,"cap":50,"remaining":19,"changed":false}
}
```

Each row records id/status/assertions/tests/commands/source/observer/blockers. Keep raw
synthetic conversation/headers/account markers in temporary fixtures, not reports. A
failing test newly exposes a defect only when it exercises an existing promised path;
old baseline lacks the new host and cannot be forced to pass a nonexistent API.
No implementation Git writes, merge, live traffic, release/deployment or next milestone
are authorized by completing this matrix.
