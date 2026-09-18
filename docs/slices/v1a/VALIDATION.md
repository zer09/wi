# V1-A source alignment and decision ledger

Contract **v1a.0**, 2026-09-17. Baseline `50f4dffe5d912615014edc46cf1bf1e1b68e6857`.
**Planning/source review only. No V1-A compilation or acceptance has occurred.**

## 1. Baseline acceptance

P1-B2 PR #7 merged at this baseline from e25279ad867d900487c4b41215fb957972493408.
B2-E01 was an acceptance-evidence gap, not a reproduced production malfunction. The
remediation added joined public execution/SQLite/OpenAI loopback/tool tests and evidence,
not production changes. Final push35227116004 attempt3 and PR35227120456 attempt1 passed
all configured Cargo gates on Ubuntu/macOS/Windows. Expected-head merge and zero-file
comparison were checked. Planner closure:
https://github.com/zer09/wi/pull/7#issuecomment-5716447572

Preserve failed Windows push attempts1/2: existing public-session/final-result/child-exit
watchdogs expired while the new joined tests passed. Same-SHA final success does not
establish that the root cause or timing sensitivity is repaired. No provider traffic was
used. Local test counts/examples/reviewer execution remain attributed report evidence.

P1-A/B1/B2, S1/S2 and R1/C1 are completed. Earlier uploaded checkpoints saying persistence
is unimplemented are dated historical material, not the current baseline. The original
one-owner/multiple-device, service-owned execution and no-auto-resume requirements remain.

## 2. Actual source versus newly authorized work

Every source below is pinned to the baseline. Follow symbols, not copied stale line numbers.

| Source | Existing behavior verified | V1-A consequence/new work |
|---|---|---|
| src/execution/mod.rs: run_in_session/run_owned/run_held | Caller owns the future; shared B2 receipt-first admission and restored context; completion-only public return | Host owns that same path; add one private early receipt notifier, not a new loop |
| src/execution/types.rs: check_commit | Unwarned acceptance proceeds; intermediate cleanup warning fails with known receipt; final cleanup warning preserves Executed | Notification occurs AFTER this helper succeeds; never replace failure with success |
| src/execution/types.rs: public result/failure types | Not Clone; concrete causes and observed result retained | Arc-shared ticket outcome; do not force Clone/Serde/error-code redesign |
| src/execution/observer.rs | Actual SQL record acknowledgment, sticky first failure | Unchanged; client receiver loss never becomes its sink error |
| src/run/mod.rs and src/run/observer.rs | One engine, awaited observer, legacy non-Send compatibility, close guard | Reuse; no service state embedded in provider loop or new public observer framework |
| src/storage/mod.rs: SessionStore | Non-Clone owner with Arc internal state; methods admit owned operations; close rejects new storage operations | Host consumes it, borrows it for reads; graceful host cancel/drain precedes close |
| src/storage/lifecycle.rs | ExecutionHold drop quarantines; close returns storage Io on unhealthy drain; no timer | Preserve actual quarantine and lease; host must not call finish on another layer's unfinished hold |
| src/storage/session.rs | Existing handles/receipt/cursor APIs, weak acceptance locks | Use original identity/coordinated acceptance; no new SQL/task-result cache |
| src/storage/dto.rs: CommitResult | Clone with receipt/duplicate/cleanup warning getters | Can notify exact small receipt without cloning all execution output |
| src/gateway.rs | Registered Arc<dyn Provider>, shared immutable gateway operations | Store Arc<Gateway>; configure outside host, no credential reads in constructor |
| src/tools.rs | Shared definitions/fresh run scope; serializer/cache/result/finish ordering | Own the supplied template; underlying B2 validates; no host-level tool execution |
| Cargo.toml | Tokio sync/runtime, tokio-util rt, futures-util, SQLite already present | TaskTracker/watch/catch_unwind need no new declared feature/crate |
| OpenAI tests/replay/joined*.rs | Real B2 SQLite-to-adapter tests at accepted baseline | Reuse fixtures but exercise the NEW host as outer action under test |

Pinned source root:
https://github.com/zer09/wi/tree/50f4dffe5d912615014edc46cf1bf1e1b68e6857/src

## 3. Decisions introduced now, not attributed to Pi/Codex

- Split V1 into V1-A owned execution library and V1-B network/auth/protocol. V1-A is not
  the final service or a claim of browser/device acceptance.
- Non-Clone RunHost owner, weak clients, passive ticket state and tracked spawned jobs.
- Synchronous dispatch, separate commit-backed acceptance wait, separate final outcome.
- Small private notification at actual B2 acceptance, infallible and receiver-independent.
- TaskTracker plus serialized host gate, no persistent queue/history cache or scheduler.
- Cancel only signals addressed tracked tokens; no new durable cancellation command schema.
- Orderly shutdown cancels/drains jobs before store.close, with a retained coordinator.
- Worker loss fails host admission closed and preserves storage quarantine; no invented
  RunResult or auto-recovery. Dropping the host is distinct from dropping its client.

These choices serve explicit lifetime requirements. They are not unrequested execution
quotas or evidence that current source already exposes a host. A trusted in-process API
is not a network authorization boundary. Model/tool activity occurs only after explicit
submit and existing acceptance; construction/read/reopen cannot start old work.

## 4. Dependency semantics checked

Primary documentation inspected for the new composition (not a request to upgrade):
- https://docs.rs/tokio-util/0.7.19/tokio_util/task/task_tracker/struct.TaskTracker.html
- https://docs.rs/tokio/latest/tokio/sync/watch/struct.Sender.html
- https://docs.rs/futures-util/latest/futures_util/future/trait.FutureExt.html
- https://docs.rs/tokio/latest/tokio/runtime/struct.Handle.html

TaskTracker's rt feature is already selected. Its wait requires closed AND empty and
accounts for future destruction; its close does not prevent additional spawn. Finished
tasks are retired, and dropping the tracker is not task abortion. Thus a host admission
gate and tracked guard are required rather than a new user-configured limit. Watch
send can fail with no receivers; send_replace/send_modify retain state. Exposed long
watch borrows could block writers, so tickets return owned clones/Arc and no guards.
Catch_unwind is not panic=abort handling and does not suppress the process panic hook.

The implementor must verify these APIs against actual Cargo.lock/build without upgrades.
Online documentation availability does not prove the planned code compiles. The exact
source-level lifetime/Send constraints are acceptance tests, not assumptions to paper over.

## 5. Pitfalls the matrix must catch

- Holding no real task owner after returning a ticket, or aborting when HTTP-like waiter drops.
- Publishing accepted before commit or mistaking a committed cleanup warning for rollback.
- Overwriting a known receipt with final state; losing updates when no watch receiver exists.
- Preventing duplicates using current tools/capabilities before their original receipt check.
- Letting shutdown see an empty tracker between dispatch registration and spawn.
- Calling storage.close first, then preventing cancellation/final records from being written.
- Tracking the shutdown coordinator in the tracker it awaits, causing a self-deadlock.
- Holding store/session/registry locks while a model or tool waits.
- Retaining completed job handles/transcripts forever because tasks were never reaped.
- Treating successful local drain as upstream rollback or exactly-once external effects.
- Repeating B2-E01: adapter tests plus host fake tests are NOT joined host acceptance.

## 6. Planner checks and limits

Read source APIs, actual commit-result behavior, lifecycle accounting, dependency features,
current docs, remediation files and final CI with previous failed-attempt logs. The merge
was reviewed without running the local Rust/Node suite. Cargo/rustc are unavailable in
this planner runtime. No V1-A source implementation, independent code review, runtime
race test, benchmark or network/browser security test was executed. All30 matrix rows
remain NOT RUN. No claim of a defect-free repository or fixed Windows test timing.

Current docs must distinguish this plan from implementation. Frozen earlier requirements
and reports remain unchanged. A genuine conflict is returned with precise actual producer/
consumer evidence before expanding scope. Plan source correspondence is not test execution.
