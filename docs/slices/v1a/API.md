# V1-A library API and state meanings

Contract **v1a.0**. Baseline `50f4dffe5d912615014edc46cf1bf1e1b68e6857`.
**Proposed implementation contract, NOT IMPLEMENTED / NOT RUN.** No wire or database
schema is introduced. This fixes the public surface; private file layout is an
implementation detail within the CONTRACT.md boundaries.

## Public surface

```rust
// Types live under wi::service. Paths below omit imports for readability.
// RunHost is NOT Clone. RunClient, RunTicket and ShutdownTicket are Clone.
impl RunHost {
    pub fn new(store: SessionStore, gateway: Arc<Gateway>)
        -> Result<Self, RunHostError>;
    pub fn storage(&self) -> &SessionStore;
    pub fn client(&self) -> RunClient;
    pub fn begin_shutdown(&self) -> ShutdownTicket;
}

impl RunClient {
    pub fn submit(&self, session_id: ApplicationSessionId,
                  request: PersistentRunRequest, tools: ToolRegistry)
        -> Result<RunTicket, RunHostError>;
    pub fn cancel(&self, session_id: &ApplicationSessionId, run_id: &RunId)
        -> CancelDisposition;
}

impl RunTicket {
    pub fn session_id(&self) -> &ApplicationSessionId;
    pub fn operation_id(&self) -> &OperationId;
    pub fn run_id(&self) -> &RunId;
    pub async fn accepted(&self) -> Result<CommitResult, Arc<RunCompletion>>;
    pub async fn completion(&self) -> Arc<RunCompletion>;
}

impl ShutdownTicket {
    pub async fn wait(&self) -> Arc<ShutdownOutcome>;
}

pub enum RunHostError { RuntimeUnavailable, Closed }
pub enum CancelDisposition { Requested, NotTracked, Closed }
pub enum RunCompletion {
    Execution(Result<PersistentRunResult, PersistentRunFailure>),
    SessionOpenFailed(StorageError),
    WorkerLost,
}
pub enum ShutdownOutcome {
    Closed,
    Incomplete { worker_lost: bool, storage_error: Option<StorageError> },
}
```

Use existing IDs, input, CommitResult and execution result/failure types unchanged.
Only small RunHostError and CancelDisposition need Clone/Copy/Eq. RunCompletion and
ShutdownOutcome are shared by Arc; do not require existing errors/results to implement
Clone or serialize them for sharing. Public new result objects are Send+Sync; waiting
futures are Send. Callers inspect original errors explicitly. This library is trusted
in-process control, NOT a browser authentication/authorization boundary.

RunHostError::code/Display return static host.runtime_unavailable or host.closed;
Error has no secret-bearing source chain. All new handle/result Debug implementations
redact payloads and identifiers. Do not derive Debug over Arc<Gateway>, request input,
native results or panic data. No new Serialize/Deserialize/wire schema for these types.

## Ticket state

A ticket retains an optional acceptance and an optional Arc<RunCompletion>. Acceptance
is write-once. Completion is write-once. Neither requires any receiver to exist. The
internal receipt update takes a small clone, not a copy of stored conversation data.

| Condition | accepted() | completion() |
|---|---|---|
| Dispatched, no acknowledged acceptance, still working | Wait | Wait |
| Successful unwarned acceptance acknowledged | Exact CommitResult | Wait until returned result |
| Duplicate acceptance verified | Exact duplicate CommitResult | Actual Duplicate result or later read failure |
| Preflight/history/opening/acceptance failure before notification | Err with actual completion | Same shared completion |
| Acceptance committed with cleanup warning | Err with original failure containing known receipt | Same original failure; no false rollback |
| Work fails after successful acceptance | Original receipt remains Ok | Actual failure/result |
| Worker loss before/after acceptance | Err WorkerLost, or prior receipt if recorded | WorkerLost, not invented terminal state |

A late waiter must see an already stored receipt/result immediately. Waiting or dropping
a waiter has no execution side effect. Receiver closure must never produce event_sink,
change the run's event completeness, or change cancellation. No async wait is held under
the host registry lock or watch borrow.

## Cancellation and duplicate scope

A cancel command identifies application session plus run. It signals current local
ownership only. It has no durable command ID and does not mean an irreversible state
transition committed. No cancel operation scans old history to restart/cancel old work.

Each dispatch can have its own passive ticket, even for identical operations. Underlying
B2 acceptance supplies at-most-one executor for a matching receipt race. The original
worker's ticket and a duplicate caller's ticket need not have the same completion:
one returns Executed and the other Duplicate. Durable history is the reconnect source.
Do not add another permanent task result map or automatic retry algorithm.

## Existing storage remains the read API

Use host.storage().create_session/list_sessions/open_session and SessionHandle's
manifest/history_page/run_record/lookup_receipt/tool_result/rename APIs. The host does
not expose arbitrary SQL or a browser-native model payload stream. Catalog refresh and
repair remain explicit existing operations, not hidden per-token writes or startup work.

The first submitted task on a new application session has empty conversation replay.
An explicit later task uses that session's validated B2 history. Native account/model
compatibility and incomplete/unbound-history rejection are unchanged. Opening a new
provider connection is not creating a new application conversation.

## Example flow, not implementation evidence

```text
store = open explicit synthetic root
host = RunHost::new(store, configured gateway)
create session through host.storage()
client1 = host.client()
ticketA = client1.submit(session, prepared A, actual registry)
receiptA = await ticketA.accepted()       // actual SQL commit, not dispatch
save the application session/run IDs
drop ticketA and client1                // task keeps running
client2 = host.client()
read actual committed history through a SessionHandle
optionally client2.cancel(session, run)  // explicit signal only
await host.begin_shutdown().wait()       // cancel/drain jobs, then close store
```

A real example additionally demonstrates normal completion after ticket loss and a
new explicit task B after storage reopen. No browser, HTTP server or live provider is
implied. Network status enums, authentication, request idempotency DTOs, event projection,
and subscription cursors belong to the later V1-B contract.
