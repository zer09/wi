use super::*;
use crate::storage::{
    CommitCertainty,
    test_hooks::{Action, Pause, Point},
};
use sqlx::{ConnectOptions, Connection, SqliteConnection, sqlite::SqliteConnectOptions};

pub(super) async fn independent_connection(rig: &Rig) -> SqliteConnection {
    let id = rig.session.session_id().as_str();
    let path = rig
        .temp
        .path()
        .join("root/sessions")
        .join(&id[..2])
        .join(id)
        .join("session.sqlite3");
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .disable_statement_logging(),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn incremental_commit_visibility_and_dropped_reader_do_not_own_execution() {
    let before = Arc::new(Barrier::default());
    let after = Arc::new(Barrier::default());
    let rig = Rig::new(
        vec![Step::Partial {
            response: response("r1", vec![], "final"),
            before: before.clone(),
            after: after.clone(),
        }],
        ToolMode::Add,
    )
    .await;
    let cancel = CancellationToken::new();
    let task = rig.start(cancel.clone());
    before.reached.notified().await;
    let mut connection = independent_connection(&rig).await;
    let prefix = history(&rig.session).await;
    let pause = Arc::new(Pause::default());
    rig.session
        .test_hooks()
        .arm(Point::BeforeCommit, Action::Pause(pause.clone()));
    before.release.notify_one();
    pause.reached.notified().await;
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM events")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(rows, prefix.len() as i64);
    assert_eq!(count(&rig.script.records.calls), 0);
    assert!(!task.is_finished());
    pause.release.notify_one();
    after.reached.notified().await;
    // The stream resumes only after the preceding event acknowledgment committed.
    let payload: String =
        sqlx::query_scalar("SELECT payload_json FROM events ORDER BY sequence DESC LIMIT 1")
            .fetch_one(&mut connection)
            .await
            .unwrap();
    let event: run::RunEventEnvelope = serde_json::from_str(&payload).unwrap();
    assert!(
        matches!(&event.event, RunEvent::ProviderEvent { event } if matches!(&event.event, ProviderEvent::OutputItemUpdated { delta, .. } if delta == PARTIAL))
    );
    connection.close().await.unwrap();

    let read_pause = Arc::new(Pause::default());
    rig.session
        .test_hooks()
        .arm(Point::Open, Action::Pause(read_pause.clone()));
    let reader = tokio::spawn({
        let session = rig.session.clone();
        async move { session.history_page(0, None, 100).await }
    });
    read_pause.reached.notified().await;
    reader.abort();
    assert!(reader.await.unwrap_err().is_cancelled());
    read_pause.release.notify_one();
    let recovered = history(&rig.session).await;
    assert_eq!(recovered.len(), prefix.len() + 1);
    assert!(!task.is_finished());
    assert!(!cancel.is_cancelled());
    let rename = rig
        .session
        .rename(OperationId::new(), "renamed while executing".into())
        .await
        .unwrap();
    assert_eq!(rename.receipt().last_sequence(), recovered.len() as u64 + 1);
    after.release.notify_one();
    let (_, _, result) = executed(task.await.unwrap().unwrap());
    assert_eq!(result.outcome, RunOutcome::Completed);
    let history = history(&rig.session).await;
    let sequences = history
        .iter()
        .filter_map(|record| match record.payload() {
            StoredEventPayload::RuntimeObserved(event) => Some(event.sequence),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(sequences, (1..=7).collect::<Vec<_>>());
    assert_eq!(rig.script.records.inputs.lock().unwrap().len(), 1);
    rig.close().await;
}

#[tokio::test]
async fn cancellation_during_acceptance_awaits_commit_and_records_actual_cancellation() {
    let rig = Rig::new(vec![], ToolMode::Add).await;
    let pause = Arc::new(Pause::default());
    rig.session
        .test_hooks()
        .arm(Point::BeforeCommit, Action::Pause(pause.clone()));
    let cancel = CancellationToken::new();
    let mut task = rig.start(cancel.clone());
    pause.reached.notified().await;
    cancel.cancel();
    assert!(futures_util::poll!(&mut task).is_pending());
    assert_eq!(count(&rig.script.records.opens), 0);
    pause.release.notify_one();
    let (acceptance, _, result) = executed(task.await.unwrap().unwrap());
    assert_eq!(acceptance.receipt().operation_id(), &rig.operation_id);
    assert_eq!(result.outcome, RunOutcome::CancelledLocally);
    assert!(result.events_complete);
    assert_eq!(result.summary.model_requests_attempted, 0);
    assert_eq!(count(&rig.script.records.opens), 0);
    assert_eq!(count(&rig.script.records.calls), 0);
    let history = history(&rig.session).await;
    assert_eq!(history.len(), 5);
    assert!(
        matches!(history[2].payload(), StoredEventPayload::RuntimeObserved(event) if matches!(event.event, RunEvent::RunStarted))
    );
    assert!(
        matches!(history[3].payload(), StoredEventPayload::RuntimeObserved(event) if matches!(event.event, RunEvent::RunFinished { outcome: RunOutcome::CancelledLocally, .. }))
    );
    assert_eq!(
        value(
            rig.session
                .run_record(rig.run_id.clone())
                .await
                .unwrap()
                .unwrap()
                .result()
                .unwrap()
        ),
        value(&result)
    );
    rig.session
        .rename(OperationId::new(), "storage remains open".into())
        .await
        .unwrap();
    rig.close().await;
}

#[tokio::test]
async fn caller_cancellation_while_provider_or_tool_waits_records_no_pending_result() {
    for pending_tool in [false, true] {
        let step = if pending_tool {
            Step::Response(response("r1", vec![call("one", 17, 25)], ""))
        } else {
            Step::Wait
        };
        let rig = Rig::new(vec![step], ToolMode::Pending).await;
        let cancel = CancellationToken::new();
        let task = rig.start(cancel.clone());
        if pending_tool {
            rig.script.records.tool_entered.notified().await;
        } else {
            rig.script.records.waiting.notified().await;
        }
        cancel.cancel();
        let (_, _, result) = executed(task.await.unwrap().unwrap());
        assert_eq!(result.outcome, RunOutcome::CancelledLocally);
        assert!(result.events_complete);
        assert_eq!(result.sink_error, None);
        assert_eq!(count(&rig.script.records.opens), 1);
        assert_eq!(count(&rig.script.records.closes), 1);
        assert_eq!(count(&rig.script.records.calls), usize::from(pending_tool));
        assert_eq!(rig.script.records.inputs.lock().unwrap().len(), 1);
        assert!(
            !history(&rig.session)
                .await
                .iter()
                .any(|r| matches!(r.payload(), StoredEventPayload::ToolResultRecorded(_)))
        );
        if pending_tool {
            let saved = rig
                .session
                .tool_result(rig.run_id.clone(), "one".into())
                .await
                .unwrap()
                .unwrap();
            assert!(saved.output().is_none());
            assert!(saved.finished_sequence().is_none());
        }
        rig.session
            .rename(OperationId::new(), "still open".into())
            .await
            .unwrap();
        rig.close().await;
    }
}

#[tokio::test]
async fn close_cancels_locally_drains_hold_and_does_not_drop_pending_acknowledgment() {
    for during_commit in [false, true] {
        let before = Arc::new(Barrier::default());
        let after = Arc::new(Barrier::default());
        let step = if during_commit {
            Step::Partial {
                response: response("r1", vec![], "final"),
                before: before.clone(),
                after: after.clone(),
            }
        } else {
            Step::Wait
        };
        let rig = Rig::new(vec![step], ToolMode::Add).await;
        let cancel = CancellationToken::new();
        let mut task = rig.start(cancel.clone());
        let pause = Arc::new(Pause::default());
        if during_commit {
            before.reached.notified().await;
            rig.session
                .test_hooks()
                .arm(Point::BeforeCommit, Action::Pause(pause.clone()));
            before.release.notify_one();
            pause.reached.notified().await;
        } else {
            rig.script.records.waiting.notified().await;
        }
        let mut close = Box::pin(rig.store.close());
        assert!(futures_util::poll!(&mut close).is_pending());
        // This current-thread test does not yield between close admission and the lease probe.
        let lease = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(rig.temp.path().join("root/storage.lock"))
            .unwrap();
        assert!(matches!(
            lease.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        assert!(!cancel.is_cancelled());
        if during_commit {
            assert!(futures_util::poll!(&mut task).is_pending());
            assert!(futures_util::poll!(&mut close).is_pending());
            pause.release.notify_one();
        }
        let failure = task.await.unwrap().unwrap_err();
        close.await.unwrap();
        assert_eq!(failure.stage(), PersistentRunStage::RuntimeEvent);
        assert_eq!(
            failure.acceptance().unwrap().operation_id(),
            &rig.operation_id
        );
        assert!(
            matches!(failure.cause(), PersistentRunCause::Storage(error) if error.code() == "storage.closed" && error.certainty() == CommitCertainty::NotCommitted)
        );
        let observed = failure.observed_result().unwrap();
        assert_eq!(observed.run_id, rig.run_id.as_str());
        assert!(!observed.events_complete);
        assert_eq!(observed.sink_error, Some(RunSinkError::Failed));
        assert_eq!(
            format!("{failure:?}"),
            "persistent run runtime_event: storage"
        );
        assert_eq!(failure.to_string(), "persistent run runtime_event: storage");
        assert!(std::error::Error::source(&failure).is_none());
        assert!(!cancel.is_cancelled());
        assert_eq!(count(&rig.script.records.closes), 1);
        assert_eq!(count(&rig.script.records.calls), 0);
        assert_eq!(rig.script.records.inputs.lock().unwrap().len(), 1);
        let reopened = SessionStore::open(rig.temp.path().join("root"))
            .await
            .unwrap();
        let session = reopened
            .open_session(rig.session.session_id().clone())
            .await
            .unwrap();
        assert!(
            session
                .lookup_receipt(failure.operation_id().unwrap().clone())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            session
                .run_record(rig.run_id.clone())
                .await
                .unwrap()
                .unwrap()
                .state(),
            RecordedRunState::Interrupted
        );
        let history = history(&session).await;
        assert!(
            !history
                .iter()
                .any(|record| matches!(record.payload(), StoredEventPayload::RunResultRecorded(_)))
        );
        let deltas = history.iter().filter(|record| matches!(record.payload(), StoredEventPayload::RuntimeObserved(event) if matches!(&event.event, RunEvent::ProviderEvent { event } if matches!(&event.event, ProviderEvent::OutputItemUpdated { delta, .. } if delta == PARTIAL)))).count();
        assert_eq!(deltas, usize::from(during_commit));
        reopened.close().await.unwrap();
    }
}

#[tokio::test]
async fn provider_failures_are_executed_with_the_actual_recorded_outcome() {
    for case in [
        "open",
        "reject",
        "request",
        "failed",
        "incomplete",
        "cancelled",
    ] {
        let mut model = response("r1", vec![call("one", 17, 25)], "sensitive result canary");
        let (step, code, upstream) = match case {
            "open" => (Step::Wait, "session_open", None),
            "reject" => (
                Step::Reject,
                "generate_rejected",
                Some(UpstreamOutcome::NotSubmitted),
            ),
            "request" => (
                Step::Failure(UpstreamOutcome::Unknown),
                "provider_request_failed",
                Some(UpstreamOutcome::Unknown),
            ),
            "failed" => {
                model.outcome = ResponseOutcome::Failed;
                (
                    Step::Response(model),
                    "model_failed",
                    Some(UpstreamOutcome::TerminalReceived),
                )
            }
            "incomplete" => {
                model.outcome = ResponseOutcome::Incomplete {
                    reason: Some("synthetic reason".into()),
                };
                (
                    Step::Response(model),
                    "model_incomplete",
                    Some(UpstreamOutcome::TerminalReceived),
                )
            }
            "cancelled" => {
                model.outcome = ResponseOutcome::Cancelled;
                (
                    Step::Response(model),
                    "model_cancelled",
                    Some(UpstreamOutcome::TerminalReceived),
                )
            }
            _ => unreachable!(),
        };
        let rig = Rig::configured(vec![step], ToolMode::Add, case == "open").await;
        let result = rig.start(CancellationToken::new()).await.unwrap().unwrap();
        assert_eq!(
            format!("{result:?}"),
            "PersistentRunResult::Executed([redacted])"
        );
        let (acceptance, final_record, result) = executed(result);
        assert_eq!(result.outcome, RunOutcome::Failed { code: code.into() });
        assert_eq!(result.summary.last_upstream_outcome, upstream);
        assert!(result.events_complete);
        assert_eq!(result.sink_error, None);
        assert_eq!(count(&rig.script.records.calls), 0);
        assert_eq!(count(&rig.script.records.opens), 1);
        assert_eq!(
            count(&rig.script.records.closes),
            usize::from(case != "open")
        );
        let saved = rig
            .session
            .run_record(rig.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(value(saved.result().unwrap()), value(&result));
        assert_eq!(
            saved.accepted_sequence(),
            acceptance.receipt().first_sequence()
        );
        assert_eq!(
            saved.result_sequence(),
            Some(final_record.receipt().first_sequence())
        );
        rig.close().await;
    }
}
