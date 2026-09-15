//! Closed controls compiled only into the library test executable.

use super::{StorageError, StorageErrorKind};
use std::{
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

tokio::task_local! {
    static ACTIVE: Arc<Hooks>;
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Point {
    Reserved,
    Initializing,
    Materialized,
    CatalogAccepted,
    BeforeCommit,
    CommitStart,
    AfterCommit,
    WriteClosed,
    UncertainWriteClose,
    RepairCandidate,
    Open,
}

pub(super) enum Action {
    Pause(Arc<Pause>),
    Fail(StorageErrorKind),
    Exit,
}

#[derive(Default)]
pub(super) struct Pause {
    pub reached: Notify,
    pub release: Notify,
    pub rollback: bool,
}

#[derive(Default)]
pub(super) struct Hooks(Mutex<Option<(Point, Action)>>);

impl Hooks {
    pub fn arm(&self, point: Point, action: Action) {
        assert!(self.0.lock().unwrap().replace((point, action)).is_none());
    }

    pub async fn scope<T>(self: &Arc<Self>, future: impl Future<Output = T>) -> T {
        ACTIVE.scope(self.clone(), future).await
    }
}

pub(super) async fn hit(point: Point) -> Result<(), StorageError> {
    let action = ACTIVE
        .try_with(|hooks| {
            let mut armed = hooks.0.lock().unwrap();
            if armed.as_ref().is_some_and(|(at, _)| *at == point) {
                armed.take().map(|(_, action)| action)
            } else {
                None
            }
        })
        .ok()
        .flatten();
    match action {
        Some(Action::Pause(pause)) => {
            pause.reached.notify_one();
            pause.release.notified().await;
            if pause.rollback {
                return Err(StorageError::new(StorageErrorKind::Io));
            }
        }
        Some(Action::Fail(kind)) => return Err(StorageError::new(kind)),
        // exit bypasses Rust destructors, including transaction/connection/lease cleanup.
        Some(Action::Exit) => std::process::exit(73),
        None => {}
    }
    Ok(())
}
