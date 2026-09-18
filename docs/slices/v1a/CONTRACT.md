# V1-A: service-owned execution, independent of callers

Contract **v1a.0**, 2026-09-17. **PLAN ONLY / NOT IMPLEMENTED / NOT RUN**.
Accepted baseline: `50f4dffe5d912615014edc46cf1bf1e1b68e6857` (PR #7, P1-B2 plus B2-E01).
Read API.md, MATRIX.md, VALIDATION.md and IMPLEMENTOR_PROMPT.md with this contract.

## 1. Outcome and slice boundary

Add a small shared `wi::service` run host. A trusted Rust application dispatches a
prepared task, receives a durable acceptance receipt without waiting for model
completion, drops every submission/observation waiter, and the host still finishes
the actual persisted execution. An explicit cancellation operation addresses the
run. Graceful shutdown cancels and drains owned work before closing storage.

This is the execution-ownership component of V1, not a network server. The owner
already required one owner across devices, browser disconnection not cancellation,
persisted sessions, and no automatic task resumption after restart. V1-A establishes
the required lifetime boundary using library clients. V1-B will separately specify
and implement network commands, client authentication, browser-safe DTOs, replay/
subscription protocol and reconnect behavior. The GUI follows that service API.
Do not claim those later features are delivered by an in-process client test.

Only the existing prepared-input form is submitted here. Reuse current S1/S2 context
preparation and B2 native replay; do not reread old skill files, flatten transcripts,
choose another account/model, or build another agent loop. Ordinary CLI behavior is
unchanged. No HTTP listener, new CLI command, auth token service, event bus, task queue,
permission system, scheduler, startup scan for work, storage migration or dependency
change is part of this assignment.

## 2. Three different acknowledgments

1. `submit` returning a RunTicket means local dispatch is owned by the host. It is
   NOT durable acceptance, a model submission, or task completion.
2. `ticket.accepted().await` returning Ok yields the actual unwarned CommitResult
   from B2 acceptance. A duplicate result preserves duplicate=true. It means exactly
   that receipt, not successful generation or completion.
3. `ticket.completion().await` returns the actual execution result/failure, session-
   opening failure, or explicit WorkerLost. Execution outcome, persistence certainty,
   final cleanup warning and observer delivery remain separate.

A future HTTP adapter must not translate mere dispatch into a durable 202 response.
No result is inferred from enqueue success, a run ID, a timer or absence of an event.

## 3. Ownership and public types

API.md fixes the additive public surface. RunHost is a non-Clone owner; RunClient,
RunTicket and ShutdownTicket are cloneable control/observation handles. They expose
no JoinHandle, AbortHandle, provider stream, execution future, mutable store internals
or cancellation token. Client/ticket Drop never cancels. Dropping the RunHost is an
owner shutdown request, not a browser disconnect.

RunHost consumes one existing non-Clone SessionStore and an Arc<Gateway>. Internally
it may share them through an Arc<HostInner>. Clients hold Weak<HostInner>; tickets
retain only their IDs and receipt/completion state. Completed tickets must not retain
the gateway, store, registry, provider receiver or root lease. storage() borrows the
existing store for trusted create/list/open/rename/history operations; do not duplicate
those APIs or introduce a second persistent session manager.

Construct the host on a live Tokio runtime, capturing Handle::try_current. This is
local memory setup and invokes no provider/auth/tool/storage operation. A constructor
outside a runtime returns host.runtime_unavailable. The application keeps that runtime
alive through observed shutdown. Submission may use the captured Handle from another
thread; browser/request lifetime must not control the runtime itself.

The intended embedding has one RunHost owning this SessionStore. SessionStore cannot
be cloned into two hosts, and the existing root lease rejects another independent
store owner. Previously obtained SessionHandles can still read/rename. Existing direct
run APIs remain available but independent executions started outside this host are not
managed by its cancellation registry; V1 must route its runs through this host. Calling
storage.close directly is not the graceful host shutdown sequence and may produce the
existing storage failures. Do not invent a new access-control framework to prohibit
trusted Rust callers from misusing other public APIs.

## 4. Dispatch and tracking algorithm

Use existing tokio-util TaskTracker (rt feature already enabled), captured Tokio
Handle, a short synchronous admission/registry mutex, child CancellationTokens and
small watch state. No new crates/features or unbounded command/output channel. No
retained history/transcript in the host registry. TaskTracker releases finished tasks;
its close alone does NOT prohibit spawn, so the host gate must enforce that rule.

For each submit(session_id, request, tools):

1. Upgrade client ownership. Prepare only local IDs/passive state, then take the host
   gate. Closing/closed rejects synchronously with host.closed and no work. Release
   the gate before dropping any prepared guard. No capabilities, tool-definition reads,
   replay building, authentication or receipt prevalidation occur in this call.
2. Preserve supplied operation/run/input and the owned ToolRegistry template unchanged.
   Under the gate, register a private dispatch entry and its guarded future/token with
   TaskTracker. This registration is the linearization point against shutdown. Release
   the gate BEFORE spawning that tracked future on the captured Handle: a runtime that
   is already stopping may drop it synchronously, and its guard must not reenter a held
   mutex. The tracker token already prevents shutdown from completing between registration
   and spawn. If shutdown wins after registration, the registered token is cancelled and
   still drained; the future is never silently abandoned. A dispatch rejected before
   registration is not WorkerLost. No await, user code, future polling or guarded-future
   destructor runs under the registry gate. Test the registration-to-spawn gap explicitly.
3. Return its passive ticket. The spawned job opens only the supplied application
   session through the owned store, then calls the B2 shared composition with its child
   token and the internal receipt notifier described below. No history/task starts at
   host construction. An invalid/missing session produces SessionOpenFailed.
4. Retain ownership regardless of ticket/client receiver count. Do not select on
   receiver.closed(), abandon a pending execution, or propagate observer delivery
   failures into the persistence observer. Return values are shared through Arc because
   existing PersistentRunResult/Failure need not become Clone.
5. Store the exact final result in ticket state, remove that private dispatch entry,
   and retire the tracked future. Every terminal path removes its entry. Retained
   tickets own only their outcome; dropping all tickets allows it to be freed. Old
   conversations remain in SQLite, not in a host-lifetime result cache.

Concurrent dispatch is not a task queue. Different sessions may progress concurrently.
A different new task aimed at an active session enters existing B2 checks and fails as
currently specified; it is not held until the active run finishes. Same-operation
races are resolved by existing receipt-first acceptance, not another dedupe subsystem.
Do not coalesce submissions merely by IDs without comparing the actual original input.
An internal dispatch identity is not another public execution ID or persisted record.

## 5. Minimal receipt notification in existing execution

The baseline run_in_session returns at completion; it has no early receipt callback.
An additive CRATE-PRIVATE entry point/optional notifier is explicitly authorized in
src/execution/mod.rs. It shares run_owned/run_held and the same run_admitted engine.
Public run_in_session and run_persisted signatures and results remain unchanged.

The host's trusted notifier is synchronous, nonblocking and infallible. It takes an
owned clone of CommitResult and updates only the host's receipt state. It is not a
public middleware/plugin hook and returns no sink failure. No await of a client occurs.

Invoke once, immediately after the existing acceptance check_commit succeeds and
before starting the admitted engine. Also invoke after a verified duplicate acceptance
and BEFORE the fallible duplicate run-record read. Cover the receipt-first early branch
and the later duplicate branch. No notification on preflight/history/session failure,
uncommitted or unknown acceptance, or acceptance with cleanup warning (check_commit
already returns a failure for that warning). Failure still retains its real receipt/
certainty through the existing type; a missing notification is not proof of rollback.

The notifier runs only after the actual SQL acknowledgment, outside its transaction.
Dropped receivers cannot stop the loop. Preserve acceptance and completion together
in watch state; a final update cannot overwrite an earlier receipt. A late accepted()
waiter prefers the stored receipt even if a later execution failed. A ticket whose run
ended before a successful notification returns that exact completion as Err. Never
reconstruct a missing acceptance notification by polling for a convenient event.

Use watch send_modify/send_replace or equivalent retained state: ordinary send can
fail when there are zero receivers. Never expose a watch borrow across await or give
clients a lock guard that can block the producer. There is no per-token observer here;
read actual committed partial history through the existing short paginated reads.

## 6. Duplicates, cancellation and isolation

Duplicate work uses the existing B2 method/content/run identity and original history
selection. The host must not call current Tool::definition, capability/replay validation
or auth before B2's original receipt checks. A duplicate after reopen never resumes an
old task. An active duplicate ticket represents its own Duplicate return, not permission
to start a second execution or a fabricated copy of the original worker's completion.

cancel(session_id, run_id) only signals all currently tracked entries matching BOTH
IDs, using the host-owned child tokens. It performs no SQL/provider operation and has
no operation receipt. Requested means cancellation was signalled, not that the run is
already cancelled, recorded durably, or stopped upstream. Repeated requests are harmless.
NotTracked does not prove a run is terminal or absent from storage. Closing/absent host
returns Closed; shutdown has already signalled its tracked work. No stored flag is later
replayed as an automatic cancellation/start command.

Preserve B2 priority: an already committed duplicate receipt may be returned despite
cancellation. Cancellation before new pure admission prevents new acceptance; cancellation
while an admitted acceptance write finishes follows the existing recorded cancellation
path. Await the SAME execution future through pending SQL; never race-drop it to make
shutdown fast. Completed tools/results stay real; cancellation does not undo effects.
One session's or run's token cannot stop another session sharing the host.

## 7. Shutdown and owner drop

begin_shutdown is a synchronous, once-only transition. Under the same gate as dispatch:
close host admission, signal every tracked run token, and close TaskTracker. Release the
gate, then arrange one host-owned shutdown coordinator on the captured runtime. Its
once-only reservation is made under the gate, not by a later uncoordinated spawn race.
Repeated calls return passive waiters for that same result. The coordinator is NOT in
the tracker it waits on. No potentially reentrant drop/spawn cleanup runs under the gate.

Coordinator order:

1. Await TaskTracker.wait until all registered jobs and their destructors have finished.
   Admission remains closed, and no new registration can enter after tracker closure.
2. Only then call and await SessionStore.close. Keeping storage open during orderly
   run drain permits their admitted SQL, cancellation events and final result to commit.
3. Publish ShutdownOutcome. Closed means tracked work drained and storage closed cleanly,
   not all runs succeeded, all remote inference stopped, or external effects rolled back.
   Worker loss or a storage-close error yields Incomplete, preserving the concrete
   storage error when present. Never release a quarantined lease manually.

Dropping one or all ShutdownTicket waiters does not drop the coordinator. RunHost Drop
initiates the same transition without blocking/awaiting. Client/ticket Drop does not.
Provide tests distinguishing these owners. Orderly shutdown requires keeping the runtime
alive and awaiting its ticket. Runtime destruction, aborting process, panic=abort, and
noncooperative blocking code cannot be made graceful by Drop; do not promise that.
No shutdown deadline, forced abort, automatic retry/restart or detached recovery worker.

## 8. Panic/drop/failure semantics

A small guarded task wrapper must finalize local ticket state even if a worker never
polls, unwinds, or is dropped by runtime teardown. Under ordinary unwinding, use the
existing FutureExt::catch_unwind with AssertUnwindSafe around the owned job, discard the
payload without formatting it, and publish WorkerLost if no concrete completion exists.
An outside guard handles cancellation/drop-before-first-poll; it must be created before
dispatch ownership can escape. Do not catch a storage error and call it success.

WorkerLost closes host admission and signals siblings, starts the same drain, and does
not create a fake RunResult, successful tool result or interruption row. A dropped B2
ExecutionHold already quarantines storage; preserve it. Tests for quarantine use isolated
children so a deliberately retained OS lease does not contaminate the parent suite.
A worker lost before acquiring the execution hold may leave no durable run; missing
history is not evidence that work was safely rolled back after acquisition.

The shutdown coordinator needs its own nonblocking drop guard: if it is never polled,
unwinds or disappears before publishing a result, resolve waiters as Incomplete rather
than leaving them pending or reporting Closed. Do not rerun a lost coordinator. This
is local loss reporting, not a proof of SQL rollback or a replacement for root quarantine.

No process-wide panic hook may be replaced by the library. The host does not itself log
panic payloads, prompts, markers, tokens or native items. A caller's process panic hook
is outside this redaction guarantee; use nonsecret synthetic panic fixtures. Process
termination remains different from a caught unwind. On restart construct only an empty
in-memory host. Existing storage open-session recovery may mark old work interrupted;
no startup model request, old tool execution, queue drain or task resumption is allowed.

## 9. Scope, implementation sequence and evidence

Allowed: new src/service module and tests; lib export; a narrow private acceptance
notifier refactor in execution/mod.rs plus focused tests; test-only barriers/shared
fixtures; host_offline example; current documentation and new V1-A reports. No changes
to production provider/auth/tool behavior, storage schema/lifecycle policy, public legacy
execution signatures, error mappings, dependency manifests/lock or CI configuration.
An exact producer/consumer contradiction is reported before scope expansion.

Sequence: source/baseline checks; notifier regression; ownership/ticket implementation;
real storage/duplicate/cancel/shutdown tests; isolated loss/restart tests; JOINED WS/SSE
public host tests; example and measurements; all old/new gates; fresh independent
complete-diff review. The implementor follows this plan rather than producing another
architecture proposal. Local storage status/receipts are not live-provider acceptance.

All V1A-00..V1A-29 start NOT RUN. No real credential/private-skill reads, auth commands,
live generation, implementation commit/push/merge, release/deployment or V1-B work is
authorized. Ledger remains31/50 used,19 remaining. No RunLimits, optional budgets,
execution count/time restrictions, retention caps, deletion, new tools or hosted billing.
