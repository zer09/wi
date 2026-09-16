use super::faults::{attempted, connection, one_request, pause_record, rows, watchdog};
use super::*;
use crate::storage::{
    CommitCertainty, StorageErrorKind,
    test_hooks::{Point, Record},
};
use sqlx::Connection;

#[tokio::test]
async fn real_sqlite_busy_during_acceptance_starts_no_provider_or_tool() {
    let rig = Rig::new(vec![], ToolMode::Add).await;
    let mut writer = connection(&rig, false).await;
    let transaction = writer.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let failure = watchdog(rig.start(CancellationToken::new()))
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(failure.stage(), PersistentRunStage::Acceptance);
    assert_eq!(failure.operation_id(), Some(&rig.operation_id));
    assert!(failure.acceptance().is_none());
    assert!(failure.observed_result().is_none());
    assert!(
        matches!(failure.cause(), PersistentRunCause::Storage(error) if error.kind() == StorageErrorKind::Busy && error.certainty() == CommitCertainty::NotCommitted)
    );
    transaction.rollback().await.unwrap();
    writer.close().await.unwrap();
    assert!(
        rig.session
            .lookup_receipt(rig.operation_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        rig.session
            .run_record(rig.run_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(history(&rig.session).await.len(), 1);
    assert_eq!(count(&rig.script.records.opens), 0);
    assert_eq!(count(&rig.script.records.closes), 0);
    assert_eq!(count(&rig.script.records.calls), 0);
    assert!(rig.script.records.inputs.lock().unwrap().is_empty());
    rig.close().await;
}

#[tokio::test]
async fn real_sqlite_constraint_on_final_result_keeps_completed_terminal_and_static_error() {
    let model = response("final", vec![], "private constraint result");
    let rig = Rig::new(vec![Step::Response(model.clone())], ToolMode::Add).await;
    let mut writer = connection(&rig, false).await;
    // A real SQLite constraint in this private fixture, not a fabricated storage error.
    sqlx::raw_sql("CREATE TRIGGER fixture_result_constraint BEFORE INSERT ON events WHEN NEW.event_type='run.result.recorded' BEGIN SELECT RAISE(ABORT, 'private-sql-constraint-canary'); END;")
        .execute(&mut writer).await.unwrap();
    writer.close().await.unwrap();
    let pause = pause_record(&rig, Record::FinalResult, Point::Open);
    let task = rig.start(CancellationToken::new());
    watchdog(pause.reached.notified()).await;
    let operation = attempted(&pause);
    let mut reader = connection(&rig, true).await;
    let prefix = rows(&mut reader).await;
    assert_eq!(prefix.len(), 8);
    pause.release.notify_one();
    let failure = watchdog(task).await.unwrap().unwrap_err();
    assert_eq!(failure.stage(), PersistentRunStage::FinalResult);
    assert_eq!(failure.operation_id(), Some(&operation));
    assert_eq!(
        failure.acceptance().unwrap().operation_id(),
        &rig.operation_id
    );
    let PersistentRunCause::Storage(error) = failure.cause() else {
        panic!("concrete SQLite error required")
    };
    assert_eq!(error.kind(), StorageErrorKind::Integrity);
    assert_eq!(error.code(), "storage.integrity");
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    assert!(!format!("{failure:?} {failure} {error:?} {error}").contains("canary"));
    assert!(
        rig.session
            .lookup_receipt(operation)
            .await
            .unwrap()
            .is_none()
    );
    let result = failure.observed_result().unwrap();
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    assert_eq!(value(result.last_response.as_ref().unwrap()), value(&model));
    let saved = rig
        .session
        .run_record(rig.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.state(), RecordedRunState::Completed);
    assert_eq!(saved.terminal_sequence(), Some(8));
    assert!(saved.result_sequence().is_none());
    assert!(saved.result().is_none());
    assert_eq!(rows(&mut reader).await, prefix);
    one_request(&rig, 0);
    reader.close().await.unwrap();
    rig.close().await;
}
