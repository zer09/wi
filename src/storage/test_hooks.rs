//! Closed controls compiled only into the library test executable.

use super::{AppendRunRecord, OperationId, StorageError, StorageErrorKind, run_store::Mutation};
use crate::{ProviderEvent, run::RunEvent, tools::ToolExecutionEvent};
use std::{
    cell::{Cell, RefCell},
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

tokio::task_local! {
    static ACTIVE: Arc<Hooks>;
    static RECORD: RefCell<Option<(Record, OperationId)>>;
    static RECORDING: Cell<bool>;
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Record {
    Acceptance,
    ProviderBinding,
    RunStarted,
    PartialText,
    ResponseFinished,
    ToolIntent,
    ToolResult,
    RunFinished,
    FinalResult,
}

pub(super) fn select_record(operation: &OperationId, mutation: &Mutation) {
    RECORDING.with(|recording| recording.set(true));
    let record = match mutation {
        Mutation::Accept { .. } | Mutation::AcceptHistory { .. } => Some(Record::Acceptance),
        Mutation::Append { records } => match records.as_slice() {
            [AppendRunRecord::ProviderBinding(_)] => Some(Record::ProviderBinding),
            [AppendRunRecord::ToolResult { .. }] => Some(Record::ToolResult),
            [AppendRunRecord::Result(_)] => Some(Record::FinalResult),
            [AppendRunRecord::Runtime(event)] => match &event.event {
                RunEvent::RunStarted => Some(Record::RunStarted),
                RunEvent::RunFinished { .. } => Some(Record::RunFinished),
                RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolExecutionStarted { .. },
                } => Some(Record::ToolIntent),
                RunEvent::ProviderEvent { event }
                    if matches!(
                        event.event,
                        ProviderEvent::OutputItemUpdated {
                            kind: crate::DeltaKind::Text,
                            ..
                        }
                    ) =>
                {
                    Some(Record::PartialText)
                }
                RunEvent::ProviderEvent { event }
                    if matches!(event.event, ProviderEvent::ResponseFinished { .. }) =>
                {
                    Some(Record::ResponseFinished)
                }
                _ => None,
            },
            _ => None,
        },
    };
    // Each admitted SQL task has its own selector, even when sessions share Hooks.
    RECORD.with(|current| *current.borrow_mut() = record.map(|record| (record, operation.clone())));
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Point {
    Reserved,
    Initializing,
    MigrationCreated,
    MigrationCopied,
    MigrationRebuilt,
    MigrationPrecommit,
    MigrationCommitted,
    Materialized,
    CatalogAccepted,
    BeforeCommit,
    CommitStart,
    AfterCommit,
    WriteClosed,
    UncertainWriteClose,
    RepairCandidate,
    Open,
    ReceiptLookupComplete,
    FinalResultCleanup,
    HistorySelection,
    ReplayHeadCaptured,
}

pub(crate) enum Action {
    Pause(Arc<Pause>),
    Fail(StorageErrorKind),
    Panic,
    Exit,
}

#[derive(Default)]
pub(crate) struct Pause {
    pub reached: Notify,
    pub release: Notify,
    pub rollback: bool,
    pub operation_id: Mutex<Option<OperationId>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Measurements {
    pub recording_commits: usize,
    pub other_commits: usize,
    pub read_transactions: usize,
}

#[derive(Default)]
pub(crate) struct Hooks(
    Mutex<Option<(Option<Record>, Point, Action)>>,
    Mutex<Measurements>,
);

impl Hooks {
    pub fn measurements(&self) -> Measurements {
        *self.1.lock().unwrap()
    }

    pub fn arm(&self, point: Point, action: Action) {
        assert!(
            self.0
                .lock()
                .unwrap()
                .replace((None, point, action))
                .is_none()
        );
    }

    pub fn arm_record(&self, record: Record, point: Point, action: Action) {
        assert!(
            self.0
                .lock()
                .unwrap()
                .replace((Some(record), point, action))
                .is_none()
        );
    }

    pub async fn hit(self: &Arc<Self>, point: Point) -> Result<(), StorageError> {
        // Keep explicitly isolated reader hooks; host workers use their store's hooks.
        if ACTIVE.try_with(|_| ()).is_ok() {
            hit(point).await
        } else {
            self.scope(hit(point)).await
        }
    }

    pub async fn scope<T>(self: &Arc<Self>, future: impl Future<Output = T>) -> T {
        ACTIVE
            .scope(
                self.clone(),
                RECORD.scope(
                    RefCell::new(None),
                    RECORDING.scope(Cell::new(false), future),
                ),
            )
            .await
    }
}

// Count explicit read snapshots, not SQLite's implicit per-statement transactions.
pub(super) fn read_transaction() {
    let _ = ACTIVE.try_with(|hooks| hooks.1.lock().unwrap().read_transactions += 1);
}

pub(crate) async fn hit(point: Point) -> Result<(), StorageError> {
    if point == Point::AfterCommit {
        let recording = RECORDING.try_with(Cell::get).unwrap_or(false);
        let _ = ACTIVE.try_with(|hooks| {
            let mut measurements = hooks.1.lock().unwrap();
            if recording {
                measurements.recording_commits += 1;
            } else {
                measurements.other_commits += 1;
            }
        });
    }
    let record = RECORD
        .try_with(|current| current.borrow().clone())
        .ok()
        .flatten();
    let action = ACTIVE
        .try_with(|hooks| {
            let mut armed = hooks.0.lock().unwrap();
            if armed.as_ref().is_some_and(|(selected, at, _)| {
                *at == point
                    && selected.is_none_or(|selected| {
                        record.as_ref().is_some_and(|(kind, _)| *kind == selected)
                    })
            }) {
                armed.take().map(|(_, _, action)| action)
            } else {
                None
            }
        })
        .ok()
        .flatten();
    match action {
        Some(Action::Pause(pause)) => {
            *pause.operation_id.lock().unwrap() = record.map(|(_, operation)| operation);
            pause.reached.notify_one();
            pause.release.notified().await;
            if pause.rollback {
                return Err(StorageError::new(StorageErrorKind::Io));
            }
        }
        Some(Action::Fail(kind)) => return Err(StorageError::new(kind)),
        Some(Action::Panic) => panic!("synthetic storage ownership unwind"),
        // exit bypasses Rust destructors, including transaction/connection/lease cleanup.
        Some(Action::Exit) => std::process::exit(73),
        None => {}
    }
    Ok(())
}
