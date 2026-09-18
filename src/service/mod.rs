//! In-process execution ownership. Dispatch is not durable acceptance.
//! Keep the runtime alive through observed shutdown; Drop only requests shutdown.
mod tickets;
mod types;

pub use tickets::{RunTicket, ShutdownTicket};
pub use types::{CancelDisposition, RunCompletion, RunHostError, ShutdownOutcome};

use std::{
    collections::HashMap,
    fmt,
    future::Future,
    panic::AssertUnwindSafe,
    sync::{Arc, Mutex, MutexGuard, Weak},
};

use futures_util::FutureExt;
use tokio::{runtime::Handle, sync::watch};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use uuid::Uuid;

use crate::{
    Gateway,
    execution::{PersistentRunRequest, run_in_session_notifying},
    storage::{ApplicationSessionId, RunId, SessionStore},
    tools::ToolRegistry,
};

pub struct RunHost {
    inner: Arc<HostInner>,
}

#[derive(Clone)]
pub struct RunClient {
    inner: Weak<HostInner>,
}

struct HostInner {
    store: SessionStore,
    gateway: Arc<Gateway>,
    runtime: Handle,
    gate: Mutex<Gate>,
    tracker: TaskTracker,
    cancel: CancellationToken,
    shutdown: watch::Sender<Option<Arc<ShutdownOutcome>>>,
}

#[derive(Default)]
struct Gate {
    closing: bool,
    worker_lost: bool,
    entries: HashMap<Uuid, Entry>,
}

struct Entry {
    session_id: ApplicationSessionId,
    run_id: RunId,
    cancel: CancellationToken,
}

impl RunHost {
    pub fn new(store: SessionStore, gateway: Arc<Gateway>) -> Result<Self, RunHostError> {
        let runtime = Handle::try_current().map_err(|_| RunHostError::RuntimeUnavailable)?;
        Ok(Self {
            inner: Arc::new(HostInner {
                store,
                gateway,
                runtime,
                gate: Mutex::new(Gate::default()),
                tracker: TaskTracker::new(),
                cancel: CancellationToken::new(),
                shutdown: watch::channel(None).0,
            }),
        })
    }

    pub fn storage(&self) -> &SessionStore {
        &self.inner.store
    }

    pub fn client(&self) -> RunClient {
        RunClient {
            inner: Arc::downgrade(&self.inner),
        }
    }

    pub fn begin_shutdown(&self) -> ShutdownTicket {
        self.inner.begin_shutdown()
    }
}

impl Drop for RunHost {
    fn drop(&mut self) {
        self.inner.begin_shutdown();
    }
}

impl RunClient {
    /// Return local ownership of dispatch, not a committed acceptance receipt.
    pub fn submit(
        &self,
        session_id: ApplicationSessionId,
        request: PersistentRunRequest,
        tools: ToolRegistry,
    ) -> Result<RunTicket, RunHostError> {
        let host = self.inner.upgrade().ok_or(RunHostError::Closed)?;
        let (ticket, worker) = host.register(session_id, request, tools)?;
        // A stopped runtime can destroy this future here. Its guard must not hold the gate.
        host.runtime.spawn(worker);
        Ok(ticket)
    }

    pub fn cancel(&self, session_id: &ApplicationSessionId, run_id: &RunId) -> CancelDisposition {
        let Some(host) = self.inner.upgrade() else {
            return CancelDisposition::Closed;
        };
        let gate = host.gate();
        if gate.closing {
            return CancelDisposition::Closed;
        }
        let mut disposition = CancelDisposition::NotTracked;
        for entry in gate.entries.values() {
            if &entry.session_id == session_id && &entry.run_id == run_id {
                entry.cancel.cancel();
                disposition = CancelDisposition::Requested;
            }
        }
        disposition
    }
}

impl HostInner {
    fn gate(&self) -> MutexGuard<'_, Gate> {
        self.gate.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn register(
        self: &Arc<Self>,
        session_id: ApplicationSessionId,
        request: PersistentRunRequest,
        tools: ToolRegistry,
    ) -> Result<(RunTicket, impl Future<Output = ()> + Send + 'static), RunHostError> {
        let ticket = RunTicket::new(
            session_id.clone(),
            request.operation_id.clone(),
            request.run_id.clone(),
        );
        let dispatch = Uuid::new_v4();
        let cancel = self.cancel.child_token();
        let entry = Entry {
            session_id,
            run_id: request.run_id.clone(),
            cancel: cancel.clone(),
        };
        let mut guard = WorkerGuard {
            host: self.clone(),
            dispatch,
            ticket: ticket.clone(),
            registered: false,
            finished: false,
        };
        let worker = {
            let mut gate = self.gate();
            if gate.closing {
                // Prepared tools and guards can have destructors. Release the gate first.
                drop(gate);
                return Err(RunHostError::Closed);
            }
            gate.entries.insert(dispatch, entry);
            guard.registered = true;
            // Registration, not spawn, prevents shutdown from passing the drain boundary.
            self.tracker.track_future(async move {
                let job = async {
                    let session = match guard
                        .host
                        .store
                        .open_session(guard.ticket.session_id().clone())
                        .await
                    {
                        Ok(session) => session,
                        Err(error) => return RunCompletion::SessionOpenFailed(error),
                    };
                    let notify = |commit| guard.ticket.publish_acceptance(commit);
                    RunCompletion::Execution(
                        run_in_session_notifying(
                            &guard.host.gateway,
                            &session,
                            request,
                            &tools,
                            cancel,
                            &notify,
                        )
                        .await,
                    )
                };
                let completion = AssertUnwindSafe(job).catch_unwind().await;
                match completion {
                    Ok(completion) => guard.finish(completion),
                    // Do not format or log the panic payload. The process panic hook is unchanged.
                    Err(_) => guard.finish(RunCompletion::WorkerLost),
                }
            })
        };
        Ok((ticket, worker))
    }

    fn close_gate(&self, gate: &mut Gate) -> bool {
        if gate.closing {
            return false;
        }
        gate.closing = true;
        self.cancel.cancel();
        self.tracker.close();
        true
    }

    fn begin_shutdown(self: &Arc<Self>) -> ShutdownTicket {
        let start = self.close_gate(&mut self.gate());
        if start {
            self.spawn_shutdown();
        }
        ShutdownTicket::new(self.shutdown.clone())
    }

    fn spawn_shutdown(self: &Arc<Self>) {
        let mut guard = ShutdownGuard {
            host: self.clone(),
            finished: false,
        };
        // This coordinator is deliberately outside the tracker it waits on.
        self.runtime.spawn(async move {
            let drain = async {
                guard.host.tracker.wait().await;
                let storage_error = guard.host.store.close().await.err();
                let worker_lost = guard.host.gate().worker_lost;
                if worker_lost || storage_error.is_some() {
                    ShutdownOutcome::Incomplete {
                        worker_lost,
                        storage_error,
                    }
                } else {
                    ShutdownOutcome::Closed
                }
            };
            if let Ok(outcome) = AssertUnwindSafe(drain).catch_unwind().await {
                guard.finish(outcome);
            }
        });
    }
}

struct WorkerGuard {
    host: Arc<HostInner>,
    dispatch: Uuid,
    ticket: RunTicket,
    registered: bool,
    finished: bool,
}

impl WorkerGuard {
    fn finish(&mut self, completion: RunCompletion) {
        let (retired, start_shutdown) = {
            let mut gate = self.host.gate();
            let mut start = false;
            if matches!(completion, RunCompletion::WorkerLost) {
                gate.worker_lost = true;
                start = self.host.close_gate(&mut gate);
            }
            (gate.entries.remove(&self.dispatch), start)
        };
        self.ticket.publish_completion(completion);
        self.finished = true;
        drop(retired);
        if start_shutdown {
            self.host.spawn_shutdown();
        }
    }
}

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        if self.registered && !self.finished {
            self.finish(RunCompletion::WorkerLost);
        }
    }
}

struct ShutdownGuard {
    host: Arc<HostInner>,
    finished: bool,
}

impl ShutdownGuard {
    fn finish(&mut self, outcome: ShutdownOutcome) {
        self.host.shutdown.send_modify(|state| {
            if state.is_none() {
                *state = Some(Arc::new(outcome));
            }
        });
        self.finished = true;
    }
}

impl Drop for ShutdownGuard {
    fn drop(&mut self) {
        if !self.finished {
            // A lost coordinator cannot prove that drain or storage close completed.
            self.host.gate().worker_lost = true;
            self.finish(ShutdownOutcome::Incomplete {
                worker_lost: true,
                storage_error: None,
            });
        }
    }
}

impl fmt::Debug for RunHost {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RunHost([redacted])")
    }
}

impl fmt::Debug for RunClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RunClient([redacted])")
    }
}

#[cfg(test)]
mod tests;
