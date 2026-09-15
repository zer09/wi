//! Explicit-root application storage. Ordinary `wi run` does not use this module.

mod catalog;
mod catalog_ops;
mod catalog_repair;
mod catalog_sync;
mod creation;
mod database;
mod dto;
mod error;
#[cfg(test)]
mod fault_tests;
mod filesystem;
mod history;
mod ids;
mod interruption;
mod lifecycle;
#[cfg(test)]
mod operation_tests;
#[cfg(test)]
mod process_tests;
#[cfg(test)]
mod recording_tests;
mod records;
#[cfg(test)]
mod recovery_tests;
mod run_store;
#[cfg(test)]
mod schema_tests;
mod session;
mod session_schema;
#[cfg(test)]
mod test_hooks;

pub use catalog_repair::RepairReport;
pub use catalog_sync::RefreshResult;
pub use dto::{
    CleanupWarning, CommitReceipt, CommitResult, CreateResult, CreateSession, CreatedPayload,
    CreationProvenance, RecordedRunState, SessionAvailability, SessionManifest, SessionPage,
    SessionSummary,
};
pub use error::{CommitCertainty, StorageError, StorageErrorKind};
pub use history::{
    AcceptedPayload, HistoryPage, InterruptedPayload, InterruptionReason, StoredEvent,
    StoredEventPayload, ToolResultPayload,
};
pub use ids::{ApplicationSessionId, OperationId, RunId, StoredEventId};
pub use records::{AppendRunRecord, RecordedRunInput};
pub use run_store::{RecordedRun, RecordedToolResult};

pub use session::SessionHandle;
use std::{
    collections::HashMap,
    fmt,
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, RwLock};

use lifecycle::Lifecycle;

pub struct SessionStore {
    inner: Arc<StoreInner>,
}

struct StoreInner {
    root: PathBuf,
    instance_id: StoredEventId,
    lifecycle: Arc<Lifecycle>,
    catalog_lock: AsyncMutex<()>,
    maintenance: RwLock<()>,
    session_locks: Mutex<HashMap<ApplicationSessionId, Weak<AsyncMutex<()>>>>,
    #[cfg(test)]
    hooks: Arc<test_hooks::Hooks>,
}

impl StoreInner {
    async fn session_lock(&self, id: &ApplicationSessionId) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self
                .session_locks
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            // Keep coordination only for live handles/operations, not historical sessions.
            locks.retain(|_, lock| lock.strong_count() != 0);
            match locks.get(id).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(AsyncMutex::new(()));
                    locks.insert(id.clone(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        lock.lock_owned().await
    }

    async fn operation<T, F, Fut>(
        self: Arc<Self>,
        mutation: bool,
        action: F,
    ) -> Result<T, StorageError>
    where
        T: Send + 'static,
        F: FnOnce(Arc<Self>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, StorageError>> + Send + 'static,
    {
        let guard = self.lifecycle.admit().map_err(|error| {
            if mutation {
                error.not_committed()
            } else {
                error
            }
        })?;
        tokio::spawn(async move {
            let _maintenance = self.maintenance.read().await;
            let action = action(self.clone());
            #[cfg(test)]
            let action = self.hooks.scope(action);
            let result = action.await;
            guard.finish();
            result
        })
        .await
        .map_err(|_| {
            StorageError::new(if mutation {
                StorageErrorKind::CommitUnknown
            } else {
                StorageErrorKind::Io
            })
        })?
    }
}

impl SessionStore {
    /// Open an explicit absolute root on a Tokio runtime. No ambient roots are read.
    pub async fn open(absolute_root: PathBuf) -> Result<Self, StorageError> {
        // The owned task keeps its lease through validation, bootstrap, and explicit close,
        // even if the caller stops waiting for open(). No abort handle leaves this module.
        tokio::spawn(async move {
            let root = filesystem::resolve_root(absolute_root)?;
            let lease = filesystem::acquire_lease(&root)?;
            let store = Self {
                inner: Arc::new(StoreInner {
                    root,
                    instance_id: StoredEventId::new(),
                    lifecycle: Lifecycle::new(lease),
                    catalog_lock: AsyncMutex::new(()),
                    maintenance: RwLock::new(()),
                    session_locks: Mutex::new(HashMap::new()),
                    #[cfg(test)]
                    hooks: Arc::default(),
                }),
            };
            let guard = store.inner.lifecycle.admit()?;
            let result = catalog::open(&store.inner.root, &store.inner.lifecycle).await;
            guard.finish();
            result?;
            Ok(store)
        })
        .await
        .map_err(|_| StorageError::new(StorageErrorKind::Io))?
    }

    pub async fn create_session(&self, input: CreateSession) -> Result<CreateResult, StorageError> {
        self.inner
            .clone()
            .operation(true, move |inner| async move {
                creation::create(&inner, input).await
            })
            .await
    }

    pub async fn open_session(
        &self,
        id: ApplicationSessionId,
    ) -> Result<SessionHandle, StorageError> {
        self.inner
            .clone()
            .operation(
                false,
                move |inner| async move { session::open(inner, id).await },
            )
            .await
    }

    /// Catalog-only, live ID-keyset view. A page does not open any session database.
    pub async fn list_sessions(
        &self,
        after_id: Option<ApplicationSessionId>,
        page_size: u64,
    ) -> Result<SessionPage, StorageError> {
        let limit = dto::page_limit(page_size)?;
        self.inner
            .clone()
            .operation(false, move |inner| async move {
                catalog_ops::list(&inner, after_id, limit).await
            })
            .await
    }

    /// Rebuild the catalog without executing or resuming recorded work.
    pub async fn repair_catalog(&self) -> Result<RepairReport, StorageError> {
        let inner = self.inner.clone();
        let guard = inner.lifecycle.admit()?;
        tokio::spawn(async move {
            let _maintenance = inner.maintenance.write().await;
            let action = catalog_repair::repair(
                &inner,
                #[cfg(test)]
                None,
            );
            #[cfg(test)]
            let action = inner.hooks.scope(action);
            let result = action.await;
            guard.finish();
            result
        })
        .await
        .map_err(|_| StorageError::new(StorageErrorKind::CommitUnknown))?
    }

    /// Reject new admission, drain admitted operations, then release the OS lease.
    pub async fn close(&self) -> Result<(), StorageError> {
        self.inner.lifecycle.close().await
    }
}

impl fmt::Debug for SessionStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SessionStore([redacted])")
    }
}
