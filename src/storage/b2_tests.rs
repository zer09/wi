use super::{
    test_hooks::{Action, Pause, Point, Record},
    *,
};
use crate::{
    ReplayIdentity, SessionOptions,
    run::{RunEvent, RunEventEnvelope, RunOutcome, RunRequest, RunSummary},
};
use sqlx::{Connection, Row, SqliteConnection};

mod migration;
mod prefix;
mod remediation;
mod repair;

fn input() -> RecordedRunInput {
    RecordedRunInput::new(
        "original 雪".into(),
        RunRequest {
            provider_id: "synthetic".into(),
            options: SessionOptions::new("model"),
            prompt: "prepared\r\n雪".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap()
}

async fn create(store: &SessionStore) -> SessionHandle {
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "title".into(), None).unwrap())
        .await
        .unwrap();
    store
        .open_session(created.session_id().clone())
        .await
        .unwrap()
}

async fn selection(store: &SessionStore, handle: &SessionHandle) -> StoredHistorySelection {
    let id = handle.session_id().clone();
    let digest = store
        .inner
        .clone()
        .operation(false, move |inner| async move {
            let _lock = inner.session_lock(&id).await;
            let (mut connection, _) = session::connection(&inner, &id, false).await?;
            let result = async {
                let head = session_schema::validate(&mut connection, &id, None)
                    .await?
                    .head_sequence();
                Ok((
                    head,
                    history_prefix::digest(&mut connection, head, &[]).await?,
                ))
            }
            .await;
            database::finish_read(connection, &inner.lifecycle, result).await
        })
        .await
        .unwrap();
    StoredHistorySelection::new(digest.0, digest.1, "synthetic".into(), "model".into(), None)
        .unwrap()
}

fn binding(run: &RunId) -> RecordedProviderBinding {
    RecordedProviderBinding::new(
        run.clone(),
        "session".into(),
        "model".into(),
        ReplayIdentity::new("synthetic".into(), "native-v1".into(), "a".repeat(64)).unwrap(),
    )
    .unwrap()
}

fn runtime(run: &RunId, sequence: u64, event: RunEvent) -> AppendRunRecord {
    AppendRunRecord::Runtime(RunEventEnvelope {
        schema_version: 2,
        sequence,
        event_id: StoredEventId::new().as_str().into(),
        run_id: run.as_str().into(),
        session_id: if matches!(event, RunEvent::RunStarted) {
            None
        } else {
            Some("session".into())
        },
        turn_id: if matches!(event, RunEvent::RunStarted | RunEvent::RunFinished { .. }) {
            None
        } else {
            Some("turn".into())
        },
        request_id: None,
        event,
    })
}

#[tokio::test]
async fn p1b2_05_atomic_acceptance_rollback_duplicate_conflicts_and_envelopes() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let handle = create(&store).await;
    let selected = selection(&store, &handle).await;
    let operation = OperationId::new();
    let run = RunId::new();
    store
        .inner
        .hooks
        .arm(Point::HistorySelection, Action::Fail(StorageErrorKind::Io));
    let error = handle
        .accept_history_run(operation.clone(), run.clone(), input(), selected.clone())
        .await
        .unwrap_err();
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    assert_eq!(handle.manifest().await.unwrap().head_sequence(), 1);
    assert!(handle.run_record(run.clone()).await.unwrap().is_none());
    assert!(
        handle
            .lookup_receipt(operation.clone())
            .await
            .unwrap()
            .is_none()
    );
    let accepted = handle
        .accept_history_run(operation.clone(), run.clone(), input(), selected.clone())
        .await
        .unwrap();
    assert_eq!(
        (
            accepted.receipt().first_sequence(),
            accepted.receipt().last_sequence()
        ),
        (2, 3)
    );
    assert!(!accepted.duplicate());
    assert_eq!(
        handle.history_selection(run.clone()).await.unwrap(),
        Some(selected.clone())
    );
    let history = handle.history_page(0, None, 10).await.unwrap();
    assert_eq!(history.records()[1].event_type(), "run.accepted");
    assert_eq!(history.records()[2].event_type(), "run.history.selected");
    for record in history.records() {
        assert_eq!((record.schema_version(), record.event_version()), (1, 1));
        let json = serde_json::to_value(record).unwrap();
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<StoredEvent>(json.clone()).unwrap())
                .unwrap(),
            json
        );
    }
    handle
        .rename(OperationId::new(), "later".into())
        .await
        .unwrap();
    let duplicate = handle
        .accept_history_run(operation.clone(), run.clone(), input(), selected.clone())
        .await
        .unwrap();
    assert!(duplicate.duplicate());
    assert_eq!(duplicate.receipt(), accepted.receipt());
    assert_eq!(
        handle
            .accept_run(operation.clone(), run.clone(), input())
            .await
            .unwrap_err()
            .code(),
        "storage.command_conflict"
    );
    assert_eq!(
        handle
            .accept_history_run(operation.clone(), RunId::new(), input(), selected.clone())
            .await
            .unwrap_err()
            .code(),
        "storage.command_conflict"
    );
    let changed =
        StoredHistorySelection::new(1, "0".repeat(64), "synthetic".into(), "model".into(), None)
            .unwrap();
    assert_eq!(
        handle
            .accept_history_run(operation.clone(), run.clone(), input(), changed)
            .await
            .unwrap_err()
            .code(),
        "storage.command_conflict"
    );
    let mut altered = serde_json::to_value(input()).unwrap();
    altered["user_text"] = "different".into();
    assert_eq!(
        handle
            .accept_history_run(
                operation,
                run.clone(),
                serde_json::from_value(altered).unwrap(),
                selected
            )
            .await
            .unwrap_err()
            .code(),
        "storage.command_conflict"
    );
    assert_eq!(
        handle
            .run_record(run)
            .await
            .unwrap()
            .unwrap()
            .accepted_sequence(),
        2
    );
    assert_eq!(store.repair_catalog().await.unwrap().ready_sessions(), 1);
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_06_stale_head_and_coordinated_duplicate_race() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let handle = create(&store).await;
    let selected = selection(&store, &handle).await;
    // The explicit barrier fixes H before a concurrent rename commits.
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let task = tokio::spawn({
        let handle = handle.clone();
        let barrier = barrier.clone();
        async move {
            handle
                .rename(OperationId::new(), "advanced".into())
                .await
                .unwrap();
            barrier.wait().await;
        }
    });
    barrier.wait().await;
    task.await.unwrap();
    let run = RunId::new();
    let operation = OperationId::new();
    let error = handle
        .accept_history_run(operation.clone(), run.clone(), input(), selected)
        .await
        .unwrap_err();
    assert_eq!(error.code(), "storage.stale_history");
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    assert!(handle.run_record(run.clone()).await.unwrap().is_none());
    assert!(
        handle
            .lookup_receipt(operation.clone())
            .await
            .unwrap()
            .is_none()
    );
    let selected = selection(&store, &handle).await;
    let pause = Arc::new(Pause::default());
    store.inner.hooks.arm_record(
        Record::Acceptance,
        Point::BeforeCommit,
        Action::Pause(pause.clone()),
    );
    let first = tokio::spawn({
        let h = handle.clone();
        let op = operation.clone();
        let run = run.clone();
        let s = selected.clone();
        async move { h.accept_history_run(op, run, input(), s).await.unwrap() }
    });
    pause.reached.notified().await;
    let second = tokio::spawn({
        let h = handle.clone();
        let op = operation.clone();
        let run = run.clone();
        async move {
            h.accept_history_run(op, run, input(), selected)
                .await
                .unwrap()
        }
    });
    pause.release.notify_one();
    let a = first.await.unwrap();
    let b = second.await.unwrap();
    assert!(!a.duplicate());
    assert!(b.duplicate());
    assert_eq!(a.receipt(), b.receipt());
    assert_eq!(handle.manifest().await.unwrap().head_sequence(), 4);
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_04_25_binding_transition_atomic_batch_projection_and_repair() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let handle = create(&store).await;
    let run = RunId::new();
    let selected = selection(&store, &handle).await;
    handle
        .accept_history_run(OperationId::new(), run.clone(), input(), selected)
        .await
        .unwrap();
    let bound = binding(&run);
    assert_eq!(
        handle
            .append_run_records(
                OperationId::new(),
                run.clone(),
                vec![AppendRunRecord::ProviderBinding(bound.clone())]
            )
            .await
            .unwrap_err()
            .code(),
        "storage.invalid_transition"
    );
    handle
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![runtime(&run, 1, RunEvent::RunStarted)],
        )
        .await
        .unwrap();
    store.inner.hooks.arm_record(
        Record::ProviderBinding,
        Point::BeforeCommit,
        Action::Fail(StorageErrorKind::Io),
    );
    let operation = OperationId::new();
    let error = handle
        .append_run_records(
            operation.clone(),
            run.clone(),
            vec![AppendRunRecord::ProviderBinding(bound.clone())],
        )
        .await
        .unwrap_err();
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    assert!(
        handle
            .provider_binding(run.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        handle
            .run_record(run.clone())
            .await
            .unwrap()
            .unwrap()
            .provider_session_id(),
        None
    );
    let receipt = handle
        .append_run_records(
            operation.clone(),
            run.clone(),
            vec![AppendRunRecord::ProviderBinding(bound.clone())],
        )
        .await
        .unwrap();
    assert!(
        handle
            .append_run_records(
                operation,
                run.clone(),
                vec![AppendRunRecord::ProviderBinding(bound.clone())]
            )
            .await
            .unwrap()
            .duplicate()
    );
    assert_eq!(
        handle.provider_binding(run.clone()).await.unwrap(),
        Some(bound.clone())
    );
    assert_eq!(
        handle
            .run_record(run.clone())
            .await
            .unwrap()
            .unwrap()
            .last_runtime_sequence(),
        1
    );
    assert_eq!(
        handle
            .append_run_records(
                OperationId::new(),
                run.clone(),
                vec![AppendRunRecord::ProviderBinding(bound)]
            )
            .await
            .unwrap_err()
            .code(),
        "storage.invalid_transition"
    );
    let mut wrong = runtime(&run, 2, RunEvent::TurnStarted { number: 1 });
    if let AppendRunRecord::Runtime(event) = &mut wrong {
        event.session_id = Some("wrong".into());
    }
    assert_eq!(
        handle
            .append_run_records(OperationId::new(), run.clone(), vec![wrong])
            .await
            .unwrap_err()
            .code(),
        "storage.invalid_transition"
    );
    handle
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![runtime(
                &run,
                2,
                RunEvent::RunFinished {
                    outcome: RunOutcome::Failed {
                        code: "history_identity".into(),
                    },
                    summary: RunSummary::default(),
                },
            )],
        )
        .await
        .unwrap();
    assert_eq!(receipt.receipt().first_sequence(), 5);
    assert_eq!(store.repair_catalog().await.unwrap().ready_sessions(), 1);
    store.close().await.unwrap();
}
