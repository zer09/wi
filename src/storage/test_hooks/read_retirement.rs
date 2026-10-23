//! Test-only owned-task witnesses, not a second SQLx health or close authority.
use super::Hooks;
use crate::storage::StoredEventId;
use std::{
    collections::BTreeSet,
    future::Future,
    sync::{Arc, Mutex, OnceLock},
};
use tokio::sync::Notify;

pub(crate) struct Store {
    identity: StoredEventId,
    tracker: OnceLock<Arc<Tracker>>,
}
impl Default for Store {
    fn default() -> Self {
        Self {
            identity: StoredEventId::new(),
            tracker: OnceLock::new(),
        }
    }
}
impl Store {
    pub(super) fn enable(&self) -> Arc<Tracker> {
        self.tracker
            .get_or_init(|| {
                Arc::new(Tracker {
                    store: self.identity.clone(),
                    state: Mutex::default(),
                    changed: Notify::new(),
                })
            })
            .clone()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReadId {
    store: StoredEventId,
    local: u64,
}
impl ReadId {
    pub(crate) fn newer_than(&self, prefix: &Self) -> bool {
        self.store == prefix.store && self.local > prefix.local
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum OpenFailure {
    #[default]
    NotConsumed,
    Tracked(ReadId),
    Untracked(StoredEventId),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WaitError {
    WrongStore,
    Unsuccessful(ReadId),
}

#[derive(Default)]
struct State {
    highest: u64,
    pending: BTreeSet<u64>,
    unsuccessful: BTreeSet<u64>,
    // Keep only the latest actual consumption, never an arming/publication receipt.
    open_failure: OpenFailure,
}

pub(crate) struct Tracker {
    store: StoredEventId,
    state: Mutex<State>,
    changed: Notify,
}
impl Tracker {
    pub(crate) fn watermark(&self) -> ReadId {
        ReadId {
            store: self.store.clone(),
            local: self.state.lock().unwrap().highest,
        }
    }

    pub(crate) fn open_failure(&self) -> OpenFailure {
        self.state.lock().unwrap().open_failure.clone()
    }

    pub(crate) async fn wait_through(&self, prefix: &ReadId) -> Result<(), WaitError> {
        if prefix.store != self.store {
            return Err(WaitError::WrongStore);
        }
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let state = self.state.lock().unwrap();
                if let Some(local) = state.unsuccessful.range(..=prefix.local).next() {
                    return Err(WaitError::Unsuccessful(ReadId {
                        store: self.store.clone(),
                        local: *local,
                    }));
                }
                if state.pending.range(..=prefix.local).next().is_none() {
                    return Ok(());
                }
            }
            changed.await;
        }
    }

    fn admit(self: &Arc<Self>) -> Ticket {
        let mut state = self.state.lock().unwrap();
        state.highest = state.highest.checked_add(1).unwrap();
        let local = state.highest;
        assert!(state.pending.insert(local));
        Ticket {
            tracker: self.clone(),
            id: ReadId {
                store: self.store.clone(),
                local,
            },
            finished: false,
        }
    }
}

pub(in crate::storage) struct Ticket {
    tracker: Arc<Tracker>,
    id: ReadId,
    finished: bool,
}
impl Ticket {
    pub(in crate::storage) fn id(&self) -> ReadId {
        self.id.clone()
    }

    pub(in crate::storage) fn finish(mut self) {
        self.finished = true;
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        let mut state = self.tracker.state.lock().unwrap();
        assert!(state.pending.remove(&self.id.local));
        if !self.finished {
            state.unsuccessful.insert(self.id.local);
        }
        drop(state);
        self.tracker.changed.notify_waiters();
    }
}

tokio::task_local! {
    static CLASSIFIED: Arc<Hooks>;
    static WORKER: (StoredEventId, Option<ReadId>);
}

pub(in crate::storage) async fn classify<T>(
    hooks: &Arc<Hooks>,
    future: impl Future<Output = T>,
) -> T {
    if hooks.3.tracker.get().is_some() {
        CLASSIFIED.scope(hooks.clone(), future).await
    } else {
        future.await
    }
}

pub(in crate::storage) fn admit(hooks: &Arc<Hooks>) -> Option<Ticket> {
    if CLASSIFIED
        .try_with(|classified| Arc::ptr_eq(classified, hooks))
        .unwrap_or(false)
    {
        hooks.3.tracker.get().map(Tracker::admit)
    } else {
        None
    }
}

pub(in crate::storage) async fn worker<T>(
    hooks: &Hooks,
    read: Option<ReadId>,
    future: impl Future<Output = T>,
) -> T {
    WORKER.scope((hooks.3.identity.clone(), read), future).await
}

pub(super) fn consumed_open_failure(hooks: &Hooks) {
    if let Some(tracker) = hooks.3.tracker.get() {
        let receipt = WORKER
            .try_with(|(store, read)| match read {
                Some(read) => OpenFailure::Tracked(read.clone()),
                None => OpenFailure::Untracked(store.clone()),
            })
            // Direct isolated hook controls have no owned operation.
            .unwrap_or_else(|_| OpenFailure::Untracked(hooks.3.identity.clone()));
        tracker.state.lock().unwrap().open_failure = receipt;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{
        SessionStore, StorageError, StorageErrorKind,
        test_hooks::{Action, Point, Record},
    };

    #[tokio::test]
    async fn c60_abandoned_ticket_is_unsuccessful_and_keeps_quarantine_authoritative() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("synthetic"))
            .await
            .unwrap();
        let tracker = store.inner.hooks.track_reads();
        // Model loss of the owned task's bookkeeping without granting a test an abort handle.
        let guard = store.inner.lifecycle.admit().unwrap();
        let ticket = tracker.admit();
        let id = ticket.id();
        drop(ticket);
        drop(guard);
        assert_eq!(
            tracker.wait_through(&id).await,
            Err(WaitError::Unsuccessful(id))
        );
        assert_eq!(
            store.close().await.unwrap_err().kind(),
            StorageErrorKind::Io
        );
    }

    #[tokio::test]
    async fn c60_normal_error_bookkeeping_does_not_certify_healthy_storage_close() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("synthetic"))
            .await
            .unwrap();
        let hooks = store.inner.hooks.clone();
        let tracker = hooks.track_reads();
        let result = classify(
            &hooks,
            store.inner.clone().operation(false, |inner| async move {
                // SQLx can quarantine storage even when its error is handled by the owned action.
                inner.lifecycle.quarantine();
                Err::<(), _>(StorageError::new(StorageErrorKind::Io))
            }),
        )
        .await;
        assert_eq!(result.unwrap_err().kind(), StorageErrorKind::Io);
        tracker.wait_through(&tracker.watermark()).await.unwrap();
        assert_eq!(
            store.close().await.unwrap_err().kind(),
            StorageErrorKind::Io
        );
    }

    #[tokio::test]
    async fn c60_actual_open_receipt_precedes_and_does_not_replace_retirement() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("synthetic"))
            .await
            .unwrap();
        let hooks = store.inner.hooks.clone();
        let tracker = hooks.track_reads();
        let reached = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let entered = reached.clone();
        let released = release.clone();
        hooks.arm(Point::Open, Action::Fail(StorageErrorKind::Io));
        let mut read = Box::pin(classify(
            &hooks,
            store
                .inner
                .clone()
                .operation(false, move |inner| async move {
                    let result = crate::storage::catalog_ops::list(&inner, None, 1).await;
                    entered.notify_one();
                    released.notified().await;
                    result
                }),
        ));
        assert!(futures_util::poll!(&mut read).is_pending());
        reached.notified().await;
        let prefix = tracker.watermark();
        assert_eq!(tracker.open_failure(), OpenFailure::Tracked(prefix.clone()));
        let mut retired = Box::pin(tracker.wait_through(&prefix));
        assert!(futures_util::poll!(&mut retired).is_pending());
        release.notify_one();
        assert_eq!(read.await.unwrap_err().kind(), StorageErrorKind::Io);
        retired.await.unwrap();
        store.close().await.unwrap();
    }

    #[tokio::test]
    async fn c60_open_receipts_preserve_record_filter_one_shot_wrong_store_and_isolation() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("synthetic"))
            .await
            .unwrap();
        let other = SessionStore::open(temp.path().join("other")).await.unwrap();
        let hooks = store.inner.hooks.clone();
        let tracker = hooks.track_reads();
        let empty = tracker.watermark();
        hooks.arm_record(
            Record::PartialText,
            Point::Open,
            Action::Fail(StorageErrorKind::Io),
        );
        store.list_sessions(None, 1).await.unwrap();
        other.list_sessions(None, 1).await.unwrap();
        assert_eq!(tracker.open_failure(), OpenFailure::NotConsumed);
        assert_eq!(tracker.watermark(), empty);
        let result = store
            .inner
            .clone()
            .operation(false, |inner| async move {
                super::super::RECORD.with(|record| {
                    *record.borrow_mut() =
                        Some((Record::PartialText, crate::storage::OperationId::new()));
                });
                crate::storage::catalog_ops::list(&inner, None, 1).await
            })
            .await;
        assert_eq!(result.unwrap_err().kind(), StorageErrorKind::Io);
        assert_eq!(
            tracker.open_failure(),
            OpenFailure::Untracked(hooks.3.identity.clone())
        );
        store.list_sessions(None, 1).await.unwrap();
        // Explicit isolated hooks must not take the enclosing store's selected slot.
        let isolated = Arc::new(Hooks::default());
        let isolated_tracker = isolated.track_reads();
        hooks.arm(Point::Open, Action::Fail(StorageErrorKind::Busy));
        isolated.arm(Point::Open, Action::Fail(StorageErrorKind::Io));
        let worker_hooks = hooks.clone();
        let isolated_hooks = isolated.clone();
        let result = store
            .inner
            .clone()
            .operation(false, move |inner| async move {
                isolated_hooks
                    .scope(async {
                        worker_hooks.hit(Point::Open).await?;
                        crate::storage::catalog_ops::list(&inner, None, 1).await
                    })
                    .await
            })
            .await;
        assert_eq!(result.unwrap_err().kind(), StorageErrorKind::Io);
        assert_eq!(
            isolated_tracker.open_failure(),
            OpenFailure::Untracked(hooks.3.identity.clone())
        );
        assert_eq!(
            store.list_sessions(None, 1).await.unwrap_err().kind(),
            StorageErrorKind::Busy
        );
        store.list_sessions(None, 1).await.unwrap();
        assert_eq!(tracker.watermark(), empty);
        other.close().await.unwrap();
        store.close().await.unwrap();
    }
}
