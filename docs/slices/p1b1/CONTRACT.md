# P1-B1 contract: persist actual run execution

Contract **p1b1.0** · 2026-09-15 · **PLAN ONLY / NOT IMPLEMENTED**.
Accepted baseline: `34b4cfd0d3ecf286869a239997267dbd75c28c0b` (P1-A merge).
Read MATRIX.md, VALIDATION.md and IMPLEMENTOR_PROMPT.md with this contract.

## 1. Outcome and boundary

Connect the existing model/tool loop to the accepted storage library so that an
explicit library invocation records its actual accepted input, incremental runtime
events, serialized tool results and final RunResult as execution happens. Tests must
use the real controller, registry and SQLite, not append a manufactured trace after
the controller has finished.

This is the first of two P1-B integration increments:

- **B1 now:** awaited execution recording of an explicitly supplied prepared input.
- **B2 next, separately contracted:** build a new explicit submission from retained
  conversation history, with valid provider-native replay and provider/account binding.

B1 does not silently read previous conversation records into model input. Its caller
supplies the complete prepared input to execute. It must not be described as restored
conversation support. Ordinary `wi run` keeps its existing diagnostic/nonpersistent
interface in B1; the new persistent library path is exercised by a runnable offline
example. The service, browser protocol, application submit/attach manager and GUI
remain V1. B1 is not completion of all P1-B requirements.

The split is deliberate: current run observation is synchronous; run IDs are currently
created inside the loop; tool results are not event payloads; the provider has no
public restored-history input. Solving those capture boundaries first does not remove
the requirement for B2. This is not another database/schema design exercise.

## 2. Preserve the accepted architecture

Keep one shared orchestration loop. The public `wi::run::run` function, RunRequest,
RunResult, RunOutcome, RunEventEnvelope schema 2 and nested provider schema 1 retain
their existing signatures/serialized meanings and ordinary behavior.

Add a small composition module `wi::execution`. It depends on run, tools and storage;
providers and the Tool trait do not depend on SQLx or a browser. Storage repositories
do not execute providers/tools. No CLI subprocess, second loop, storage plugin system,
job scheduler, generic event bus, alternate backend, or new dependency is required.

The current input is `RunRequest { provider_id, options, prompt }`. Do not add a
limits field or reinterpret its prompt as a rendered historical conversation.
ApplicationSessionId is separate from runtime/provider session_id. The supplied run
UUID must be the actual runtime run_id, not a rewritten ID on copied events.

## 3. Public composition API

Add the following semantic API under `wi::execution` (boxing large enum payloads is
an ordinary implementation detail, not a semantic change):

```rust
pub struct PersistentRunRequest {
    pub operation_id: wi::storage::OperationId,
    pub run_id: wi::storage::RunId,
    pub input: wi::storage::RecordedRunInput,
}

pub async fn run_persisted(
    gateway: &wi::Gateway,
    session: &wi::storage::SessionHandle,
    request: PersistentRunRequest,
    tools: &wi::tools::ToolRegistry,
    cancel: tokio_util::sync::CancellationToken,
) -> Result<PersistentRunResult, PersistentRunFailure>;
```

PersistentRunResult is an enum with:

- `Executed`: the actual acceptance CommitResult, final RunResult-record CommitResult,
  and actual returned RunResult. A successfully recorded failed/cancelled run is still
  Executed; inspect RunResult.outcome rather than treating storage success as model success.
- `Duplicate`: the original acceptance CommitResult (duplicate=true) and current
  RecordedRun. It performs no provider opening, generation or tool execution.

PersistentRunFailure exposes the stage (lookup, preflight, acceptance, runtime_event,
tool_result or final_result), the attempted OperationId when one exists, any already
committed acceptance receipt, and the observed RunResult when execution returned one.
It preserves the concrete existing GatewayError or StorageError, or a committed
CleanupWarning with its receipt. A registry mismatch is an existing
GatewayError::InvalidRequest with static text `recorded tool definitions do not match
registry`; do not add a GatewayError variant or change GatewayError::code().

Use a closed enum or private-field struct to prevent inconsistent failure combinations.
Debug/Display are redacted/static; no input, native payload, output, path or secret is
formatted. Explicit result/receipt access is sensitive application access, not logging.
No serialization or new wire schema for these composition types is needed in B1.

The function is one backend-owned future. It does not spawn a detached agent task or
return an unowned execution handle. A future V1 owner must retain/await it independently
of client connections. The future must be Send with the existing Send/Sync gateway,
registry and storage types, so a backend can spawn and own it. Do not add Send/'static
requirements to the existing synchronous run callback API.

## 4. Acceptance and duplicate algorithm

1. Acquire the narrow store-lifecycle hold described in section 9. This is not a
   SQLite transaction or session mutex held for the duration of a model request.
2. Look up the requested operation receipt. If present, call the existing accept_run
   with the identical supplied IDs/input to let P1-A verify method/content identity.
   Return Duplicate and the stored run if it matches. Conflicting content returns the
   existing storage conflict. Do not turn an old accepted-but-unstarted run into work.
   Existing duplicate receipts do not require current provider capabilities, current
   registry definitions, fresh credentials or an uncancelled token to be returned.
3. For a genuinely new operation, compare actual registry definitions with the captured
   definitions using parsed serde values in original array order (all fields, including
   descriptions, strict and schemas). Preserve exact snapshot strings. Use the existing
   run admission checks for input/options, caller tools empty, capabilities, transport,
   required features and pre-cancellation before acceptance. These are pure/local checks;
   they must not open a provider or prepare/refresh credentials.
4. Call session.accept_run(operation_id, run_id, input). Concurrent identical callers
   may both have seen no receipt; only the caller receiving duplicate=false can execute.
   A loser returns Duplicate. Another active run returns P1-A active_run_exists.
5. A committed acceptance with a cleanup warning is still accepted data, but must NOT
   start provider work. Return a failure carrying the committed receipt/warning. An
   uncertain acceptance error also starts no work; expose its operation ID for lookup.
6. Only after an unqualified commit success, enter the shared admitted run engine using
   the supplied run UUID and the exact prepared request/registry already checked.

Extract shared pure admission instead of validating differently in two controllers.
Do not call public run(), let it generate another UUID, then rewrite emitted records.
The extracted admitted engine must handle cancellation that arrives during acceptance:
record ordinary run_started/run_finished cancellation if storage remains usable, with
zero provider opening. Do not apply a second pre-admission cancellation rejection that
leaves a committed accepted task silently unaccounted for.

A stored input is structurally validated caller evidence; it is not proof that the
caller owns a project/account or that an old provider request happened. B1 adds no
permission system and never reads credentials from the snapshot.

## 5. Awaitable core observation without a second loop

Refactor private run observation so the shared engine can await an event acknowledgment.
The existing public run() wraps its synchronous fallible callback in a ready-future
adapter. The new persistent path wraps SessionHandle in an awaited storage adapter.
The same drive/collect/preflight/tool loop must serve both.

A private observer interface needs two operations:

1. Observe an actual RunEventEnvelope, preserving its complete fields and sequence.
2. Observe a newly serialized tool result with its call_id, exact output string and
   actual is_error, while the current request/turn correlation is still available.

A boxed-future or associated-future implementation is permitted. A synchronous adapter
can evaluate the callback before returning a ready future; do not accidentally require
its closure to be Send. The persistent instantiation must nevertheless be Send; include
both compile-level tests. Private helper names and borrowing details are implementor
choices. Do not expose a general public middleware/plugin framework.

Preserve the observer's sticky failure behavior. Core observer failures still use the
existing RunSinkError and event_sink path. The persistent adapter separately retains
the actual StorageError/cleanup receipt and stage for its caller; it must not lose that
information behind `RunSinkError::Failed`.

Do not select cancellation against an already admitted persistence acknowledgment.
Await that operation's outcome, then honor cancellation before the next executable
boundary. P1-A already shields admitted SQL work from waiter drop; a cancelled await
must not be misreported as proof that its transaction rolled back.

## 6. Actual event and tool-result recording order

The persistent event adapter calls append_run_records with a fresh OperationId and
one AppendRunRecord::Runtime containing the exact event. It awaits the CommitResult.
No public session observer is called before commit. B1 has no client event callback:
observers use P1-A history_page/manifest/receipt reads, which expose committed data.
Closing/cancelling a reader does not signal the execution token.

Use direct awaited recording first: no background write queue, timer, configurable
batch budget, full-run buffer or connection cache. There is at most the current
observation/result pending in this composition. Event batching/performance changes
are not silently authorized by B1; measure the actual cost (section 12).

For one newly executed tool, the required sequence is:

```text
provider ResponseFinished observed and committed
whole-batch authority/schema/identity validation succeeds
ToolExecutionStarted emitted through the real runtime and committed
checkpoint cancellation
actual Tool::execute
existing serialization/error mapping/output-size replacement
existing per-run cache insertion
await recording the exact output and actual is_error
ToolExecutionFinished through the real runtime and committed
return the ToolResult to the controller
validate the entire next input
next provider request
```

The ToolExecutionStarted record is dispatch intent, not proof the effect occurred.
A cancellation arriving while that record commits prevents execution at the next
checkpoint. A completed result is real even if cancellation arrives while its storage
commit is pending; preserve it and permit its truthful finish observation, then stop
before the next tool/request under the existing controller rules.

The serialization code is shared, not reimplemented in the persistence adapter:
ToolFailed still becomes gateway_error; oversized serialized output still becomes
tool_output_limit. Never return Ok(error-shaped JSON) or infer is_error from output
text. Do not reparse/reformat the output string before saving it.

Add the awaited result boundary inside the existing registry execution path, after
cache insertion and before its finish event. Legacy public registry operations use a
no-op result observer and retain their original behavior. The runtime adapter supplies
the active request ID; it must not guess this from the last completed run later.

A reused call emits and persists ToolResultReused using the current request correlation.
It uses the existing original saved result; do not append another ToolResult record or
rerun/read the skill again. Conflicting/unknown/malformed calls still reject during
whole-batch preflight, before any new tool intent, result or execution.

If the result persistence callback fails, the already inserted in-memory cache is not
rolled back and the completed effect is not undone. The loop stops and sends no result
subset or further provider request. Persisted evidence contains only proven commits.

## 7. Completion and storage failure

When all runtime observation commits succeed, append one actual RunResult after the
core returns. Return Executed only after that final record commits. Its final
CommitResult can carry a cleanup warning without rewriting the actual execution
outcome; no further execution follows it. Existing RunFinished and supplemental
RunResult semantics remain those in P1-A SCHEMA.md, not newly strict summary equality.

A provider/tool execution failure recorded successfully returns Executed with the
actual Failed/CancelledLocally outcome. It is not a storage failure. No-call completed
terminal output still wins over later observer-triggered cancellation as in C1/M3.

On the FIRST event/result storage error or committed cleanup warning:

- retain its operation ID, stage, error/certainty or receipt/warning;
- fail core observation, close the owned provider session through the existing guard;
- do not call the failed observer again, retry the write, reopen storage, execute tools,
  submit a provider request, refresh credentials, or change account/transport;
- do not append a fabricated terminal record through a second best-effort writer;
- when core returns, attach its actual RunResult to PersistentRunFailure;
- release the execution lifecycle hold only after local orchestration has stopped.

For a final-result append failure, RunFinished may already be committed. Preserve that
terminal state; report the failed/unknown final-result operation separately. In particular,
a completed runtime with failed final persistence is not changed to a fictitious failed
model response or a storage-confirmed rollback.

The committed prefix may remain nonterminal after a recording failure, while local
execution has stopped. That is explicit in the returned failure. B1 does not pretend
that a catalog's cached state is live activity. A subsequent fresh store instance's
normal open_session interruption handles old unfinished work; it never resumes it.
An old command retry returns Duplicate even if the accepted record never reached work.
A new task identity cannot bypass P1-A's same-session active-record guard.

## 8. Stable operation identities and receipts

Acceptance uses the caller's OperationId and RunId. Each actual runtime observation,
new tool result and final RunResult uses a newly allocated OperationId, fixed before
its storage call. Keep the currently attempted ID until the call resolves; return it
on failure. No retry allocates a replacement ID to conceal an uncertain write.

Do not accumulate all receipts/events in memory. Successful intermediate receipts can
be released after acknowledgment. Persisted IDs/records remain queryable through P1-A.
The final result includes the acceptance and final-record receipts; a failed intermediate
commit includes its own attempted/committed identity. Original operation receipts are
returned on duplicate submission, not fabricated new acknowledgments.

B1's no-retry rule does not prohibit the CALLER from performing a read-only receipt
lookup to establish whether an uncertain mutation committed. That lookup does not
restart execution, and run_persisted must not use an old receipt as new execution authority.

## 9. Store close, owned execution and future drop

P1-A tracks SQL operations, not model/tool work between them. Without an integration
hold, close() could release the installation lease while a persistent run was waiting
on a model. B1 must close that gap with a minimal crate-private lifecycle addition.

Add a crate-private execution hold obtained from SessionHandle, backed by the existing
Lifecycle admission/drain accounting. It retains root ownership across acceptance and
execution without retaining any SQLite connection, transaction, session mutex or
maintenance lock. This hold is not a persisted job, public scheduler or extra pool.

Add a crate-private closing notification (existing tokio-util CancellationToken is
sufficient). close(), quarantine and abnormal operation retirement signal it when
closing begins. The persisted composition combines it with a child of the caller's
cancellation token, without mutating the caller's token or spawning a detached watcher.
It then awaits the shared engine's local cancellation/close path. Existing SQL operations
retain P1-A's drain behavior; new SQL admission still rejects after closing starts.

Consequences to test and document:

- Controlled user cancellation while storage remains open can persist the actual final
  cancellation result. It must not close SessionStore.
- Store close cancels active persistent work locally and waits for its execution hold
  plus admitted SQL work before healthy lease unlock. Because new recording operations
  reject during close, terminal persistence is not guaranteed; preserve the prefix and
  return the storage/closing failure honestly. Next-instance selection interrupts it.
- Normal completion/errors explicitly finish the hold after orchestration returns.
- Direct abort/drop/panic of the owning execution future is NOT a browser disconnect.
  The core close guard still runs; an unfinished hold follows P1-A's conservative
  quarantine/retain-lease behavior until process exit. Do not claim a fabricated result
  or verified external termination. Test this in an isolated child, not the test runner.
- Root ownership must never be released while admitted SQL work can still publish.
  Retain the accepted explicit-unlock regression; no lock stealing, PID expiry or timer.

No holding a maintenance read lock for the entire run: a queued repair writer followed
by a nested read could deadlock. Storage calls keep their existing short locks. No
await with a std::sync::Mutex guard. The storage module itself does not call a provider
or tool; only the composition owns execution and observes the closing notification.

For a later V1 graceful shutdown, cancel/await runs while storage is open, then close
storage. B1's close notification is a safety boundary, not a full service lifecycle.

## 10. Isolation and nonintegration boundaries

Provider opens once per actual new run, with existing managed/external selection,
renewal and handshake policies. No credentials/profile references are copied to
conversation storage. No stored native history is submitted in B1. The ordinary input
sent is exactly RecordedRunInput.prepared_request, with actual definitions inserted
by the shared admission path.

Two runs may intentionally share a provider call_id; result scope remains per run.
There is no application-session-wide exactly-once external-effect claim. A separate
run with a new explicit ID does not consume another run's cache. P1-A's one active run
per session and independent sessions remain. There is no new queue or steering behavior.

The persistent function does not create/open/repair roots or create sessions implicitly.
Callers use existing SessionStore APIs and explicit roots. Catalog refresh remains a
separate operation; the example calls it explicitly. Do not start an automatic catalog
observer or call refresh for every token.

CLI flags/output, authentication code, provider protocol/transport, request capacities,
SQL schemas and schema versions remain unchanged. No migration is expected. A concrete
schema contradiction must be raised before changing the frozen v1 storage contract.

## 11. Permitted implementation changes

- New `src/execution/` composition/types/tests and export in src/lib.rs.
- Private refactoring in src/run/ for shared admission, supplied UUID and awaitable
  observation; existing public run API/serialized envelopes remain compatible.
- Private refactoring in src/tools.rs and tools tests to share an awaited result/event
  path while preserving the public Tool/registry APIs and old no-op adapter.
- Narrow crate-private hold/closing hooks in src/storage/session.rs, lifecycle.rs and
  associated module exports/tests. No new public storage API or provider dependency.
- Test-only fault/barrier visibility sufficient for the new real integration tests;
  cfg(test) only, closed selectors, no production environment/SQL injection API.
- New grouped integration tests, one offline example, and accurate current docs.

No Cargo.toml/Cargo.lock change, new dependency, provider production code change,
GatewayError mapping change, schema change, CI weakening, or unrelated restructuring.
Normal Rust helper names/boxing/borrowing and test organization can be chosen locally;
architecture, observable behavior, evidence and scope cannot be silently changed.

## 12. Verification and performance honesty

Use actual SQLite and actual run/ToolRegistry producers with synthetic inputs. Require
both independent scripted-provider and existing OpenAI WS/SSE loopback evidence. Save
partial text before a controlled provider waits; read it from another connection before
releasing the provider. Assert every effect boundary against a committed record, not
a mocked enqueue acknowledgment. Cover captured S2 main-file loading and exact errors.

P1-A's dev/WSL samples included roughly 72-88 ms for a 12-record append operation,
including connection/schema-check/close cost. This is not a per-record production SLA,
a release benchmark, or a universal SQLite speed claim. B1's direct awaited recording
can affect streaming latency. Measure finite end-to-end and per-stage samples and
report per-observation open/close cost. Do not tune with an unapproved pool or timer.

The provider already has a bounded event queue, consumer timeout and final-slot
behavior. Slow persistence can exercise these existing boundaries. Include a pressure
case that proves truthful terminal/closed/uncertainty handling and no silent dropped
history, retry or false continuation. Do not promise transparent behavior under
arbitrarily slow disk or change provider guards to make a timing test pass. Use barriers
for correctness and label latency samples separately; a concrete integration blocker
must be reported, not waived by a successful small fixture.

Every existing test/gate remains required. Live model requests are unnecessary and not
authorized. No target test-count increase or unmeasured performance claim.

## 13. Deferred next work and authorization

B2 remains required: reconstruct ordered role/call/result/native history for a NEW
explicit task, including reopen; preserve exact provider identity boundaries; handle
unusable/incomplete histories without replaying effects or flattening them into a user
string; integrate the ordinary session-oriented client entry point. The interface and
account binding must be checked against actual provider code in that separate contract.

V1 later owns these run futures independently of clients and supplies authenticated
submit/cancel/read/attach operations. No browser transport is selected by B1. Supporting
skill resources, real coding tools, approvals, compaction, branches, search and hosted
skills are outside this assignment.

The local agent implements B1 and runs offline tests only. No real credentials/private
skills, auth commands, provider requests, live probes, implementation commit/push/merge,
release/deployment or B2/V1 work without separate owner authorization. Keep the ledger
31/50 used, 19 remaining. Publish truthful VERIFICATION.md and verification.json for
P1B1-00..P1B1-29; all requirements start NOT RUN.
