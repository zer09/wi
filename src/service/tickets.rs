use std::{fmt, sync::Arc};

use tokio::sync::watch;

use crate::storage::{ApplicationSessionId, CommitResult, OperationId, RunId};

use super::{RunCompletion, ShutdownOutcome};

#[derive(Default)]
struct TicketState {
    acceptance: Option<CommitResult>,
    completion: Option<Arc<RunCompletion>>,
}

#[derive(Clone)]
pub struct RunTicket {
    session_id: ApplicationSessionId,
    operation_id: OperationId,
    run_id: RunId,
    state: watch::Sender<TicketState>,
}

impl RunTicket {
    pub(super) fn new(
        session_id: ApplicationSessionId,
        operation_id: OperationId,
        run_id: RunId,
    ) -> Self {
        Self {
            session_id,
            operation_id,
            run_id,
            state: watch::channel(TicketState::default()).0,
        }
    }

    pub fn session_id(&self) -> &ApplicationSessionId {
        &self.session_id
    }

    pub fn operation_id(&self) -> &OperationId {
        &self.operation_id
    }

    pub fn run_id(&self) -> &RunId {
        &self.run_id
    }

    pub async fn accepted(&self) -> Result<CommitResult, Arc<RunCompletion>> {
        let mut receiver = self.state.subscribe();
        loop {
            {
                let state = receiver.borrow_and_update();
                if let Some(acceptance) = &state.acceptance {
                    return Ok(acceptance.clone());
                }
                if let Some(completion) = &state.completion {
                    return Err(completion.clone());
                }
            }
            receiver.changed().await.expect("ticket retains sender");
        }
    }

    pub async fn completion(&self) -> Arc<RunCompletion> {
        let mut receiver = self.state.subscribe();
        loop {
            if let Some(completion) = receiver.borrow_and_update().completion.clone() {
                return completion;
            }
            receiver.changed().await.expect("ticket retains sender");
        }
    }

    pub(super) fn publish_acceptance(&self, commit: CommitResult) {
        self.state.send_modify(|state| {
            if state.acceptance.is_none() && state.completion.is_none() {
                state.acceptance = Some(commit);
            }
        });
    }

    pub(super) fn publish_completion(&self, completion: RunCompletion) {
        self.state.send_modify(|state| {
            if state.completion.is_none() {
                state.completion = Some(Arc::new(completion));
            }
        });
    }
}

#[derive(Clone)]
pub struct ShutdownTicket {
    state: watch::Sender<Option<Arc<ShutdownOutcome>>>,
}

impl ShutdownTicket {
    pub(super) fn new(state: watch::Sender<Option<Arc<ShutdownOutcome>>>) -> Self {
        Self { state }
    }

    pub async fn wait(&self) -> Arc<ShutdownOutcome> {
        let mut receiver = self.state.subscribe();
        loop {
            if let Some(outcome) = receiver.borrow_and_update().clone() {
                return outcome;
            }
            receiver
                .changed()
                .await
                .expect("shutdown ticket retains sender");
        }
    }
}

impl fmt::Debug for RunTicket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RunTicket([redacted])")
    }
}

impl fmt::Debug for ShutdownTicket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ShutdownTicket([redacted])")
    }
}
