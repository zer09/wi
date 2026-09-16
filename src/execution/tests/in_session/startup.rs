use super::*;

fn pause_record(task: &Task, record: Record) -> Arc<Pause> {
    let pause = Arc::new(Pause::default());
    task.session
        .test_hooks()
        .arm_record(record, Point::BeforeCommit, Action::Pause(pause.clone()));
    pause
}

#[tokio::test]
async fn p1b2_09_25_binding_commit_is_awaited_before_install_and_generate() {
    let fixture = Fixture::new().await;
    let task = fixture.task("binding barrier", Plan::default());
    let pause = pause_record(&task, Record::ProviderBinding);
    let running = task.start(CancellationToken::new());
    watchdog(pause.reached.notified()).await;
    assert!(!running.is_finished());
    assert_eq!(count(&task.observed.records.opens), 1);
    assert_eq!(count(&task.observed.identity_reads), 1);
    assert_eq!(count(&task.observed.installs), 0);
    no_generation(&task);
    let operation = pause.operation_id.lock().unwrap().clone().unwrap();
    pause.release.notify_one();
    let (_, _, result) = executed(watchdog(running).await.unwrap().unwrap());
    assert_eq!(result.outcome, RunOutcome::Completed);
    let receipt = task
        .session
        .lookup_receipt(operation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(receipt.first_sequence(), receipt.last_sequence());
    let records = history(&fixture.session).await;
    assert!(matches!(
        records[(receipt.first_sequence() - 1) as usize].payload(),
        StoredEventPayload::RunProviderBound(_)
    ));
    assert_eq!(
        records
            .iter()
            .filter(|record| matches!(record.payload(), StoredEventPayload::RunProviderBound(_)))
            .count(),
        1
    );
    assert_eq!(count(&task.observed.installs), 1);
    assert_eq!(count(&task.observed.records.closes), 1);
    fixture.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_25_binding_failures_keep_first_stage_certainty_acceptance_and_observed_result() {
    for point in [
        Point::BeforeCommit,
        Point::CommitStart,
        Point::AfterCommit,
        Point::WriteClosed,
    ] {
        let fixture = Fixture::new().await;
        let task = fixture.task("binding fault", Plan::default());
        let error = if matches!(point, Point::CommitStart | Point::AfterCommit) {
            StorageErrorKind::CommitUnknown
        } else {
            StorageErrorKind::Io
        };
        task.session
            .test_hooks()
            .arm_record(Record::ProviderBinding, point, Action::Fail(error));
        let failure = watchdog(task.start(CancellationToken::new()))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(failure.stage(), PersistentRunStage::ProviderBinding);
        let receipt = task
            .session
            .lookup_receipt(task.operation_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(failure.acceptance(), Some(&receipt));
        assert_ne!(failure.operation_id(), Some(&task.operation_id));
        let committed = matches!(point, Point::AfterCommit | Point::WriteClosed);
        assert_eq!(
            task.session
                .lookup_receipt(failure.operation_id().unwrap().clone())
                .await
                .unwrap()
                .is_some(),
            committed
        );
        assert_eq!(
            task.session
                .provider_binding(task.run_id.clone())
                .await
                .unwrap()
                .is_some(),
            committed
        );
        match failure.cause() {
            PersistentRunCause::Storage(error) => {
                let expected = if point == Point::BeforeCommit {
                    CommitCertainty::NotCommitted
                } else {
                    CommitCertainty::Unknown
                };
                assert_eq!(error.certainty(), expected);
            }
            PersistentRunCause::Cleanup { commit, .. } => {
                assert!(point == Point::WriteClosed);
                assert_eq!(
                    commit.receipt().operation_id(),
                    failure.operation_id().unwrap()
                );
            }
            _ => panic!("not a binding persistence failure"),
        }
        let result = failure.observed_result().unwrap();
        assert_eq!(
            result.outcome,
            RunOutcome::Failed {
                code: "event_sink".into()
            }
        );
        assert_eq!(result.sink_error, Some(RunSinkError::Failed));
        assert!(!result.events_complete);
        assert_eq!(result.summary.model_requests_attempted, 0);
        assert_eq!(result.session_id, Some(format!("provider-{}", task.run_id)));
        assert_eq!(count(&task.observed.installs), 0);
        assert_eq!(count(&task.observed.records.closes), 1);
        no_generation(&task);
        let saved = task
            .session
            .run_record(task.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.state(), RecordedRunState::Running);
        assert!(saved.result().is_none());
        assert_eq!(saved.last_runtime_sequence(), 1);
        fixture.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1b2_25_cancellation_during_accepted_startup_awaits_sql_and_records_terminal() {
    for record in [
        Record::Acceptance,
        Record::RunStarted,
        Record::ProviderBinding,
    ] {
        let fixture = Fixture::new().await;
        let task = fixture.task("cancel accepted startup", Plan::default());
        let pause = pause_record(&task, record);
        let cancel = CancellationToken::new();
        let running = task.start(cancel.clone());
        watchdog(pause.reached.notified()).await;
        cancel.cancel();
        assert!(!running.is_finished(), "admitted SQL must remain awaited");
        pause.release.notify_one();
        let (_, _, result) = executed(watchdog(running).await.unwrap().unwrap());
        recorded_outcome(&task, &result, RunOutcome::CancelledLocally).await;
        assert_eq!(count(&task.observed.installs), 0);
        let opened = usize::from(record == Record::ProviderBinding);
        assert_eq!(count(&task.observed.records.opens), opened);
        assert_eq!(count(&task.observed.records.closes), opened);
        assert_eq!(
            task.session
                .provider_binding(task.run_id.clone())
                .await
                .unwrap()
                .is_some(),
            opened == 1
        );
        let prepared = prepare_session_replay(&fixture.session, ID, "synthetic")
            .await
            .unwrap();
        assert_eq!(prepared.excluded_runs()[0].run_id(), task.run_id);
        fixture.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1b2_18_23_26_install_cancellation_and_store_close_guard_session_without_retry() {
    for closing_store in [false, true] {
        let fixture = Fixture::new().await;
        let barrier = Arc::new(Barrier::default());
        let task = fixture.task(
            "pending installation",
            Plan {
                install_pause: Some(barrier.clone()),
                ..Plan::default()
            },
        );
        let cancel = CancellationToken::new();
        let running = task.start(cancel.clone());
        watchdog(barrier.reached.notified()).await;
        let acceptance = task
            .session
            .lookup_receipt(task.operation_id.clone())
            .await
            .unwrap()
            .unwrap();
        // The original future owns the work; another caller can only observe the current run.
        let duplicate = run_in_session(
            &Gateway::new(),
            &task.session,
            task.request(),
            &ToolRegistry::new(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let PersistentRunResult::Duplicate {
            acceptance: repeated,
            run,
        } = duplicate
        else {
            panic!("duplicate")
        };
        assert_eq!(repeated.receipt(), &acceptance);
        assert_eq!(run.state(), RecordedRunState::Running);
        if closing_store {
            watchdog(fixture.store.close()).await.unwrap();
        } else {
            cancel.cancel();
        }
        let returned = watchdog(running).await.unwrap();
        let result = if closing_store {
            // B1 close rejects new SQL admission, including the later terminal observation.
            let failure = returned.unwrap_err();
            assert_eq!(failure.stage(), PersistentRunStage::RuntimeEvent);
            assert_eq!(failure.acceptance(), Some(&acceptance));
            assert!(matches!(failure.cause(), PersistentRunCause::Storage(error)
                if error.code() == "storage.closed" && error.certainty() == CommitCertainty::NotCommitted));
            assert!(!cancel.is_cancelled());
            failure.observed_result().unwrap().clone()
        } else {
            executed(returned.unwrap()).2
        };
        assert_eq!(result.outcome, RunOutcome::CancelledLocally);
        assert_eq!(result.summary.model_requests_attempted, 0);
        assert_eq!(result.events_complete, !closing_store);
        assert_eq!(count(&task.observed.installs), 1);
        assert_eq!(count(&task.observed.records.opens), 1);
        assert_eq!(count(&task.observed.records.closes), 1);
        assert!(task.observed.installed.lock().unwrap().is_empty());
        no_generation(&task);
        if !closing_store {
            recorded_outcome(&task, &result, RunOutcome::CancelledLocally).await;
            fixture.store.close().await.unwrap();
        }
        let reopened = SessionStore::open(fixture.temp.path().join("root"))
            .await
            .unwrap();
        let session = reopened
            .open_session(fixture.session.session_id().clone())
            .await
            .unwrap();
        let saved = session
            .run_record(task.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        if closing_store {
            assert_eq!(saved.state(), RecordedRunState::Interrupted);
            assert!(saved.result().is_none());
        } else {
            assert_eq!(saved.state(), RecordedRunState::CancelledLocally);
            assert_eq!(value(saved.result().unwrap()), value(&result));
        }
        reopened.close().await.unwrap();
    }
}
