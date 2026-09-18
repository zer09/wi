//! Shared B2 producers. Service tests submit their requests, never their execution futures.
use super::*;
pub(super) use crate::execution::tests::{
    Barrier, call, history,
    in_session::fixture::{Fixture, Plan, Task, identity, replay_tools},
    response, value,
};
use crate::tools::{AddNumbers, Tool, add_numbers_definition};
pub(super) use crate::{
    GatewayError, InputItem, UpstreamOutcome,
    execution::{
        PersistentRunCause, PersistentRunFailure, PersistentRunResult, PersistentRunStage,
    },
    run::{RunEvent, RunOutcome, RunResult, RunSinkError},
    storage::{
        CommitCertainty, CommitResult, RecordedRunState, StorageErrorKind, StoredEventPayload,
        test_hooks::{Action, Pause, Point, Record},
    },
};
use sqlx::{ConnectOptions, Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
};

pub(super) fn submit(host: &RunHost, task: &Task) -> RunTicket {
    host.client()
        .submit(
            task.session.session_id().clone(),
            task.request(),
            task.tools.fresh_scope(),
        )
        .unwrap()
}

pub(super) fn executed(
    completion: &Arc<RunCompletion>,
) -> (&CommitResult, &CommitResult, &RunResult) {
    let RunCompletion::Execution(Ok(PersistentRunResult::Executed {
        acceptance,
        final_record,
        result,
    })) = completion.as_ref()
    else {
        panic!("expected executed result: {completion:?}")
    };
    assert!(result.events_complete);
    assert!(result.sink_error.is_none());
    (acceptance, final_record, result)
}

pub(super) fn failure(completion: &RunCompletion) -> &PersistentRunFailure {
    let RunCompletion::Execution(Err(failure)) = completion else {
        panic!("expected concrete execution failure: {completion:?}")
    };
    failure
}

pub(super) fn pause(session: &SessionHandle, record: Record, point: Point) -> Arc<Pause> {
    let pause = Arc::new(Pause::default());
    session
        .test_hooks()
        .arm_record(record, point, Action::Pause(pause.clone()));
    pause
}

pub(super) async fn closed(host: &RunHost) {
    assert!(matches!(
        &*watchdog(host.begin_shutdown().wait()).await,
        ShutdownOutcome::Closed
    ));
    assert!(host.inner.gate().entries.is_empty());
    assert!(host.inner.tracker.is_empty());
}

pub(super) async fn retired(host: &RunHost) {
    watchdog(async {
        while !host.inner.tracker.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(host.inner.gate().entries.is_empty());
}

pub(super) async fn connection(root: &Path, id: &ApplicationSessionId) -> SqliteConnection {
    let id = id.as_str();
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(
                root.join("sessions")
                    .join(&id[..2])
                    .join(id)
                    .join("session.sqlite3"),
            )
            .read_only(true)
            .busy_timeout(Duration::ZERO)
            .disable_statement_logging(),
    )
    .await
    .unwrap()
}

pub(super) async fn rows(connection: &mut SqliteConnection) -> Vec<(i64, String, String)> {
    sqlx::query_as("SELECT sequence, event_type, payload_json FROM events ORDER BY sequence")
        .fetch_all(connection)
        .await
        .unwrap()
}

pub(super) fn no_work(task: &Task) {
    use super::fixture::count;
    assert_eq!(count(&task.observed.records.opens), 0);
    assert_eq!(count(&task.observed.validations), 0);
    assert_eq!(count(&task.observed.installs), 0);
    assert!(task.observed.records.inputs.lock().unwrap().is_empty());
}

#[derive(Default)]
pub(super) struct ToolProbe {
    pub definitions: AtomicUsize,
    pub calls: AtomicUsize,
    pub effects: AtomicUsize,
    pub pause: Option<Arc<Barrier>>,
    pub panic: bool,
}
impl ToolProbe {
    pub fn registry(self: &Arc<Self>) -> Arc<ToolRegistry> {
        let mut tools = ToolRegistry::new();
        tools.register(self.clone()).unwrap();
        Arc::new(tools)
    }
}
#[async_trait::async_trait]
impl Tool for ToolProbe {
    fn definition(&self) -> crate::ToolDefinition {
        self.definitions.fetch_add(1, Ordering::SeqCst);
        add_numbers_definition()
    }
    fn validate(&self, arguments: &serde_json::Value) -> crate::Result<()> {
        AddNumbers.validate(arguments)
    }
    async fn execute(&self, arguments: serde_json::Value) -> crate::Result<serde_json::Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(pause) = &self.pause {
            pause.wait().await;
        }
        assert!(!self.panic, "synthetic tool unwind");
        self.effects.fetch_add(1, Ordering::SeqCst);
        AddNumbers.execute(arguments).await
    }
}
