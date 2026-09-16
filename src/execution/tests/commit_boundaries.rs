use super::faults::{attempted, connection, one_request, pause_record, rows, watchdog};
use super::*;
use crate::storage::{
    CommitCertainty,
    test_hooks::{Action, Pause, Point, Record},
};
use sqlx::Connection;

#[tokio::test]
async fn cancellation_during_intent_commit_drains_sql_without_polling_the_tool() {
    let rig = Rig::new(
        vec![Step::Response(response(
            "r1",
            vec![call("one", 17, 25), call("later", 1, 2)],
            "",
        ))],
        ToolMode::Add,
    )
    .await;
    let pause = pause_record(&rig, Record::ToolIntent, Point::BeforeCommit);
    let cancel = CancellationToken::new();
    let mut task = rig.start(cancel.clone());
    watchdog(pause.reached.notified()).await;
    let operation = attempted(&pause);
    let mut reader = connection(&rig, true).await;
    let prefix = rows(&mut reader).await;
    assert_eq!(prefix.len(), 6);
    let terminal: run::RunEventEnvelope = serde_json::from_str(&prefix.last().unwrap().1).unwrap();
    assert!(
        matches!(terminal.event, RunEvent::ProviderEvent { event } if matches!(event.event, ProviderEvent::ResponseFinished { .. }))
    );
    let intents: i64 = sqlx::query_scalar("SELECT count(*) FROM tool_results")
        .fetch_one(&mut reader)
        .await
        .unwrap();
    assert_eq!(intents, 0);
    cancel.cancel();
    assert!(futures_util::poll!(&mut task).is_pending());
    assert_eq!(count(&rig.script.records.calls), 0);
    pause.release.notify_one();
    let (_, final_record, result) = executed(watchdog(task).await.unwrap().unwrap());
    assert_eq!(result.outcome, RunOutcome::CancelledLocally);
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    // Dispatch counts describe intent, not proof that execute was polled.
    assert_eq!(result.summary.new_tool_dispatches, 1);
    assert_eq!(result.summary.tool_results_prepared, 0);
    one_request(&rig, 0);
    let saved = rig
        .session
        .tool_result(rig.run_id.clone(), "one".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.started_sequence(), 7);
    assert!(saved.result_sequence().is_none());
    assert!(saved.finished_sequence().is_none());
    assert!(saved.output().is_none());
    assert!(saved.is_error().is_none());
    assert!(
        rig.session
            .tool_result(rig.run_id.clone(), "later".into())
            .await
            .unwrap()
            .is_none()
    );
    let receipt = rig
        .session
        .lookup_receipt(operation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((receipt.first_sequence(), receipt.last_sequence()), (7, 7));
    let records = history(&rig.session).await;
    assert_eq!(records.len(), 10);
    assert!(
        !records
            .iter()
            .any(|r| matches!(r.payload(), StoredEventPayload::ToolResultRecorded(_)))
    );
    assert_eq!(final_record.receipt().last_sequence(), 10);
    assert_eq!(&rows(&mut reader).await[..prefix.len()], prefix);
    reader.close().await.unwrap();
    rig.close().await;
}

#[tokio::test]
async fn cancellation_during_actual_result_commit_keeps_exact_bytes_and_truthful_finish() {
    for (mode, expected, is_error) in [
        (ToolMode::Add, "{\"sum\":42}".to_owned(), false),
        (
            ToolMode::Failed,
            "{\"error\":{\"code\":\"gateway_error\"}}".to_owned(),
            true,
        ),
        (
            ToolMode::Large,
            "{\"error\":{\"code\":\"tool_output_limit\"}}".to_owned(),
            true,
        ),
        (
            ToolMode::ErrorShaped,
            json!({"error":{"code":"not_an_error","text":"雪\n\0\\\""}}).to_string(),
            false,
        ),
    ] {
        let rig = Rig::new(
            vec![Step::Response(response(
                "r1",
                vec![call("one", 17, 25), call("later", 1, 2)],
                "",
            ))],
            mode,
        )
        .await;
        let pause = pause_record(&rig, Record::ToolResult, Point::BeforeCommit);
        let cancel = CancellationToken::new();
        let mut task = rig.start(cancel.clone());
        watchdog(pause.reached.notified()).await;
        let operation = attempted(&pause);
        assert_eq!(count(&rig.script.records.calls), 1);
        let mut reader = connection(&rig, true).await;
        let prefix = rows(&mut reader).await;
        assert_eq!(prefix.len(), 7);
        let saved: (Option<String>, Option<i64>, Option<i64>) = sqlx::query_as(
            "SELECT output, result_sequence, finished_sequence FROM tool_results WHERE call_id='one'"
        ).fetch_one(&mut reader).await.unwrap();
        assert_eq!(saved, (None, None, None));
        // This transaction follows actual serialization and cache insertion, not queued tool work.
        cancel.cancel();
        assert!(futures_util::poll!(&mut task).is_pending());
        pause.release.notify_one();
        let (_, _, result) = executed(watchdog(task).await.unwrap().unwrap());
        assert_eq!(result.outcome, RunOutcome::CancelledLocally);
        assert!(result.events_complete);
        assert_eq!(result.sink_error, None);
        assert_eq!(result.summary.new_tool_dispatches, 1);
        assert_eq!(result.summary.tool_results_prepared, 1);
        assert_eq!(
            result.summary.last_upstream_outcome,
            Some(UpstreamOutcome::TerminalReceived)
        );
        one_request(&rig, 1);
        let saved = rig
            .session
            .tool_result(rig.run_id.clone(), "one".into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.output(), Some(expected.as_str()));
        assert_eq!(saved.is_error(), Some(is_error));
        assert_eq!(saved.request_id(), Some("q1"));
        assert_eq!(saved.started_sequence(), 7);
        assert_eq!(saved.result_sequence(), Some(8));
        assert_eq!(saved.finished_sequence(), Some(9));
        assert!(
            rig.session
                .tool_result(rig.run_id.clone(), "later".into())
                .await
                .unwrap()
                .is_none()
        );
        let receipt = rig
            .session
            .lookup_receipt(operation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!((receipt.first_sequence(), receipt.last_sequence()), (8, 8));
        let records = history(&rig.session).await;
        assert_eq!(records.len(), 12);
        assert!(
            matches!(records[8].payload(), StoredEventPayload::RuntimeObserved(event) if matches!(&event.event,
            RunEvent::ToolEvent { event: ToolExecutionEvent::ToolExecutionFinished { is_error: flag, call_id, .. } } if *flag == is_error && call_id == "one"))
        );
        let run = rig
            .session
            .run_record(rig.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(value(run.result().unwrap()), value(&result));
        assert_eq!(&rows(&mut reader).await[..prefix.len()], prefix);
        reader.close().await.unwrap();
        rig.close().await;
    }
}

#[tokio::test]
async fn dropped_database_waiter_does_not_cancel_execution_or_prove_rollback() {
    for rollback in [false, true] {
        let rig = Rig::new(vec![Step::Wait], ToolMode::Add).await;
        let cancel = CancellationToken::new();
        let mut task = rig.start(cancel.clone());
        watchdog(rig.script.records.waiting.notified()).await;
        let pause = Arc::new(Pause {
            rollback,
            ..Pause::default()
        });
        rig.session
            .test_hooks()
            .arm(Point::BeforeCommit, Action::Pause(pause.clone()));
        let operation = OperationId::new();
        let writer = tokio::spawn({
            let session = rig.session.clone();
            let operation = operation.clone();
            async move {
                session
                    .rename(operation, "dropped waiter committed title".into())
                    .await
            }
        });
        watchdog(pause.reached.notified()).await;
        // Drop only the public database waiter, never the owning execution future.
        writer.abort();
        assert!(writer.await.unwrap_err().is_cancelled());
        assert!(!cancel.is_cancelled());
        assert!(!task.is_finished());
        let mut reader = connection(&rig, true).await;
        let prefix = rows(&mut reader).await;
        assert_eq!(prefix.len(), 4);
        cancel.cancel();
        assert!(futures_util::poll!(&mut task).is_pending());
        pause.release.notify_one();
        let (_, _, result) = executed(watchdog(task).await.unwrap().unwrap());
        assert_eq!(result.outcome, RunOutcome::CancelledLocally);
        assert!(result.events_complete);
        assert_eq!(result.sink_error, None);
        assert_eq!(
            result.summary.last_upstream_outcome,
            Some(UpstreamOutcome::Unknown)
        );
        assert!(result.last_response.is_none());
        one_request(&rig, 0);
        let receipt = rig.session.lookup_receipt(operation.clone()).await.unwrap();
        assert_eq!(receipt.is_some(), !rollback);
        if let Some(receipt) = receipt {
            assert_eq!(receipt.operation_id(), &operation);
            assert_eq!((receipt.first_sequence(), receipt.last_sequence()), (5, 5));
        }
        let manifest = rig.session.manifest().await.unwrap();
        assert_eq!(
            manifest.title(),
            if rollback {
                "synthetic session"
            } else {
                "dropped waiter committed title"
            }
        );
        let after = rows(&mut reader).await;
        assert_eq!(&after[..prefix.len()], prefix);
        assert_eq!(after.len(), 7 + usize::from(!rollback));
        let records = history(&rig.session).await;
        assert_eq!(
            records
                .iter()
                .filter(|r| matches!(r.payload(), StoredEventPayload::SessionRenamed { .. }))
                .count(),
            usize::from(!rollback)
        );
        assert!(
            !records
                .iter()
                .any(|r| matches!(r.payload(), StoredEventPayload::ToolResultRecorded(_)))
        );
        reader.close().await.unwrap();
        rig.close().await;
    }
}

#[tokio::test]
async fn close_drains_completed_result_then_rejects_finish_without_releasing_root_early() {
    let rig = Rig::new(
        vec![Step::Response(response(
            "r1",
            vec![call("one", 17, 25), call("later", 1, 2)],
            "",
        ))],
        ToolMode::Add,
    )
    .await;
    let pause = pause_record(&rig, Record::ToolResult, Point::BeforeCommit);
    let cancel = CancellationToken::new();
    let mut task = rig.start(cancel.clone());
    watchdog(pause.reached.notified()).await;
    let result_operation = attempted(&pause);
    let mut reader = connection(&rig, true).await;
    let prefix = rows(&mut reader).await;
    assert_eq!(prefix.len(), 7);
    assert_eq!(count(&rig.script.records.calls), 1);
    let mut close = Box::pin(rig.store.close());
    assert!(futures_util::poll!(&mut close).is_pending());
    let lease = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(rig.temp.path().join("root/storage.lock"))
        .unwrap();
    assert!(matches!(
        lease.try_lock(),
        Err(std::fs::TryLockError::WouldBlock)
    ));
    assert!(futures_util::poll!(&mut task).is_pending());
    assert!(futures_util::poll!(&mut close).is_pending());
    assert!(!cancel.is_cancelled());
    pause.release.notify_one();
    let failure = watchdog(task).await.unwrap().unwrap_err();
    watchdog(close).await.unwrap();
    assert_eq!(failure.stage(), PersistentRunStage::RuntimeEvent);
    assert_ne!(failure.operation_id(), Some(&result_operation));
    assert!(
        matches!(failure.cause(), PersistentRunCause::Storage(error) if error.code() == "storage.closed" && error.certainty() == CommitCertainty::NotCommitted)
    );
    assert_eq!(
        failure.acceptance().unwrap().operation_id(),
        &rig.operation_id
    );
    let observed = failure.observed_result().unwrap();
    assert_eq!(
        observed.outcome,
        RunOutcome::Failed {
            code: "event_sink".into()
        }
    );
    assert!(!observed.events_complete);
    assert_eq!(observed.sink_error, Some(RunSinkError::Failed));
    assert!(!cancel.is_cancelled());
    one_request(&rig, 1);
    let after = rows(&mut reader).await;
    assert_eq!(&after[..prefix.len()], prefix);
    assert_eq!(after.len(), 8);
    let saved: (String, i64, Option<i64>) = sqlx::query_as(
        "SELECT output, is_error, finished_sequence FROM tool_results WHERE call_id='one'",
    )
    .fetch_one(&mut reader)
    .await
    .unwrap();
    assert_eq!(saved, ("{\"sum\":42}".into(), 0, None));
    let run: (String, Option<i64>, Option<i64>) =
        sqlx::query_as("SELECT state, terminal_sequence, result_sequence FROM runs")
            .fetch_one(&mut reader)
            .await
            .unwrap();
    assert_eq!(run, ("running".into(), None, None));
    let committed: i64 = sqlx::query_scalar("SELECT count(*) FROM commands WHERE operation_id=?")
        .bind(result_operation.as_str())
        .fetch_one(&mut reader)
        .await
        .unwrap();
    assert_eq!(committed, 1);
    let failed: i64 = sqlx::query_scalar("SELECT count(*) FROM commands WHERE operation_id=?")
        .bind(failure.operation_id().unwrap().as_str())
        .fetch_one(&mut reader)
        .await
        .unwrap();
    assert_eq!(failed, 0);
    reader.close().await.unwrap();
    // Healthy close unlocks only after the execution and admitted SQL have both returned.
    lease.try_lock().unwrap();
    lease.unlock().unwrap();
}

#[tokio::test]
async fn no_call_completion_wins_over_cancellation_during_terminal_commits() {
    for record in [
        Record::ResponseFinished,
        Record::RunFinished,
        Record::FinalResult,
    ] {
        let model = response("final", vec![], "completed before cancellation λ\n\0");
        let rig = Rig::new(vec![Step::Response(model.clone())], ToolMode::Add).await;
        let pause = pause_record(&rig, record, Point::BeforeCommit);
        let cancel = CancellationToken::new();
        let mut task = rig.start(cancel.clone());
        watchdog(pause.reached.notified()).await;
        let operation = attempted(&pause);
        cancel.cancel();
        assert!(futures_util::poll!(&mut task).is_pending());
        pause.release.notify_one();
        let (_, _, result) = executed(watchdog(task).await.unwrap().unwrap());
        assert_eq!(result.outcome, RunOutcome::Completed);
        assert!(result.events_complete);
        assert_eq!(result.sink_error, None);
        assert_eq!(
            result.summary.last_upstream_outcome,
            Some(UpstreamOutcome::TerminalReceived)
        );
        assert_eq!(value(result.last_response.as_ref().unwrap()), value(&model));
        one_request(&rig, 0);
        assert!(
            rig.session
                .lookup_receipt(operation)
                .await
                .unwrap()
                .is_some()
        );
        let saved = rig
            .session
            .run_record(rig.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.state(), RecordedRunState::Completed);
        assert_eq!(saved.terminal_sequence(), Some(8));
        assert_eq!(saved.result_sequence(), Some(9));
        assert_eq!(value(saved.result().unwrap()), value(&result));
        assert!(
            matches!(saved.terminal().unwrap().payload(), StoredEventPayload::RuntimeObserved(event) if matches!(event.event, RunEvent::RunFinished { outcome: RunOutcome::Completed, .. }))
        );
        rig.close().await;
    }
}
