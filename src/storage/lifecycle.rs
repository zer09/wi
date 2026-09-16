use std::{
    fs::File,
    sync::{Arc, Mutex, MutexGuard},
};

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::{StorageError, StorageErrorKind};

struct State {
    lease: Option<File>,
    admitted: usize,
    closing: bool,
    unhealthy: bool,
    #[cfg(test)]
    opened: usize,
    #[cfg(test)]
    closed: usize,
}

pub(super) struct Lifecycle {
    state: Mutex<State>,
    changed: Notify,
    closing: CancellationToken,
}

// Reuse SQL drain accounting without retaining a connection or a storage lock.
pub(crate) struct ExecutionHold(pub(super) OperationGuard);

impl ExecutionHold {
    pub(crate) fn closing_token(&self) -> CancellationToken {
        // Cancelling an observer's token must not close storage admission.
        self.0.lifecycle.closing.child_token()
    }

    pub(crate) fn finish(self) {
        self.0.finish();
    }
}

pub(super) struct OperationGuard {
    lifecycle: Arc<Lifecycle>,
    finished: bool,
}

impl OperationGuard {
    pub(super) fn finish(mut self) {
        self.finished = true;
    }
}

impl Lifecycle {
    pub(super) fn new(lease: File) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                lease: Some(lease),
                admitted: 0,
                closing: false,
                unhealthy: false,
                #[cfg(test)]
                opened: 0,
                #[cfg(test)]
                closed: 0,
            }),
            changed: Notify::new(),
            closing: CancellationToken::new(),
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub(super) fn admit(self: &Arc<Self>) -> Result<OperationGuard, StorageError> {
        let mut state = self.state();
        if state.closing {
            return Err(StorageError::new(StorageErrorKind::Closed));
        }
        state.admitted = state
            .admitted
            .checked_add(1)
            .ok_or_else(|| StorageError::new(StorageErrorKind::InvalidInput))?;
        Ok(OperationGuard {
            lifecycle: self.clone(),
            finished: false,
        })
    }

    #[cfg(test)]
    pub(super) fn connection_opened(&self) {
        let mut state = self.state();
        assert!(state.lease.is_some() && state.admitted > 0);
        state.opened += 1;
    }

    #[cfg(test)]
    pub(super) fn connection_closed(&self) {
        let mut state = self.state();
        assert!(state.lease.is_some() && state.admitted > 0);
        state.closed += 1;
        assert!(state.closed <= state.opened);
    }

    #[cfg(test)]
    pub(super) fn gauge(&self) -> (usize, usize, usize, bool) {
        let state = self.state();
        (state.admitted, state.opened, state.closed, state.closing)
    }

    pub(super) fn quarantine(&self) {
        let mut state = self.state();
        state.closing = true;
        state.unhealthy = true;
        self.closing.cancel();
    }

    pub(super) async fn close(&self) -> Result<(), StorageError> {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let mut state = self.state();
                state.closing = true;
                self.closing.cancel();
                if state.admitted == 0 {
                    if state.unhealthy {
                        return Err(StorageError::new(StorageErrorKind::Io));
                    }
                    return release_lease(&mut state);
                }
            }
            changed.await;
        }
    }
}

fn release_lease(state: &mut State) -> Result<(), StorageError> {
    let Some(lease) = state.lease.as_ref() else {
        return Ok(());
    };
    if lease.unlock().is_err() {
        // Keep uncertain ownership until process exit instead of permitting a racing owner.
        state.unhealthy = true;
        return Err(StorageError::new(StorageErrorKind::Io));
    }
    state.lease.take();
    Ok(())
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        let mut state = self.lifecycle.state();
        // An unfinished guard cannot prove that SQL or owned execution has stopped.
        if !self.finished {
            state.closing = true;
            state.unhealthy = true;
            self.lifecycle.closing.cancel();
        }
        state.admitted -= 1;
        if state.admitted == 0 {
            if state.closing && !state.unhealthy {
                let _ = release_lease(&mut state);
            }
            self.lifecycle.changed.notify_waiters();
        }
    }
}

impl Drop for Lifecycle {
    fn drop(&mut self) {
        let state = self
            .state
            .get_mut()
            .unwrap_or_else(|error| error.into_inner());
        if state.unhealthy {
            // If retirement is uncertain, keep the OS lease until process exit.
            // Releasing it here could let another owner race unfinished work.
            if let Some(lease) = state.lease.take() {
                std::mem::forget(lease);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::filesystem;

    #[tokio::test]
    async fn storage_close_waits_rejects_admission_and_survives_dropped_waiter() {
        let temp = tempfile::tempdir().unwrap();
        let root = filesystem::resolve_root(temp.path().join("root")).unwrap();
        let lifecycle = Lifecycle::new(filesystem::acquire_lease(&root).unwrap());
        let guard = lifecycle.admit().unwrap();
        let (finish, wait) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            wait.await.unwrap();
            guard.finish();
        });
        drop(task);
        let mut close = Box::pin(lifecycle.close());
        assert!(futures_util::poll!(&mut close).is_pending());
        assert_eq!(lifecycle.admit().err().unwrap().code(), "storage.closed");
        assert_eq!(
            filesystem::acquire_lease(&root).unwrap_err().code(),
            "storage.busy"
        );
        // Cancelling a close waiter still leaves admission closed and the operation owned.
        drop(close);
        finish.send(()).unwrap();
        lifecycle.close().await.unwrap();
        lifecycle.close().await.unwrap();
        drop(filesystem::acquire_lease(&root).unwrap());
    }

    #[tokio::test]
    async fn storage_close_explicitly_unlocks_before_all_duplicate_descriptors_close() {
        let temp = tempfile::tempdir().unwrap();
        let root = filesystem::resolve_root(temp.path().join("root")).unwrap();
        let lease = filesystem::acquire_lease(&root).unwrap();
        let inherited = lease.try_clone().unwrap();
        let lifecycle = Lifecycle::new(lease);

        lifecycle.close().await.unwrap();
        drop(filesystem::acquire_lease(&root).unwrap());
        drop(inherited);
    }
}
