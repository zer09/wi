use super::*;

async fn duplicate_without_dependencies(
    task: &Task,
    session: &SessionHandle,
    expected: &CommitResult,
    state: RecordedRunState,
) {
    let cancel = CancellationToken::new();
    cancel.cancel();
    let head = session.manifest().await.unwrap().head_sequence();
    let PersistentRunResult::Duplicate { acceptance, run } = run_in_session(
        &Gateway::new(),
        session,
        task.request(),
        &ToolRegistry::new(),
        cancel,
    )
    .await
    .unwrap() else {
        panic!("expected duplicate")
    };
    assert!(acceptance.duplicate());
    assert_eq!(acceptance.receipt(), expected.receipt());
    assert_eq!(run.run_id(), &task.run_id);
    assert_eq!(run.state(), state);
    assert_eq!(value(run.input()), value(&task.input));
    assert_eq!(session.manifest().await.unwrap().head_sequence(), head);
}

#[tokio::test]
async fn p1b2_23_receipt_first_completed_reopened_and_unstarted_duplicates_conflicts() {
    let fixture = Fixture::new().await;
    let task = fixture.task("first", Plan::default());
    let (acceptance, final_record, _) = task.execute().await;
    fixture
        .session
        .rename(OperationId::new(), "new head".into())
        .await
        .unwrap();
    duplicate_without_dependencies(
        &task,
        &fixture.session,
        &acceptance,
        RecordedRunState::Completed,
    )
    .await;
    for conflict in ["run", "input", "method"] {
        let mut request = task.request();
        match conflict {
            "run" => request.run_id = RunId::new(),
            "input" => request.input = fixture.task("different", Plan::default()).input,
            "method" => request.operation_id = final_record.receipt().operation_id().clone(),
            _ => unreachable!(),
        }
        let cancel = CancellationToken::new();
        cancel.cancel();
        let failure = run_in_session(
            &Gateway::new(),
            &fixture.session,
            request,
            &ToolRegistry::new(),
            cancel,
        )
        .await
        .unwrap_err();
        assert_eq!(failure.stage(), PersistentRunStage::Acceptance);
        assert!(
            matches!(failure.cause(), PersistentRunCause::Storage(error) if error.kind() == StorageErrorKind::CommandConflict)
        );
    }
    // B1 cannot use a B2 receipt, even with exactly the same run and supplied input.
    let failure = run_persisted(
        &Gateway::new(),
        &fixture.session,
        task.request(),
        &ToolRegistry::new(),
        CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(failure.cause(), PersistentRunCause::Storage(error) if error.code() == "storage.command_conflict")
    );
    let selection = prepare_session_replay(&fixture.session, ID, "synthetic")
        .await
        .unwrap()
        .selection();
    let conflict = fixture
        .session
        .accept_history_run(
            task.operation_id.clone(),
            task.run_id.clone(),
            task.input.clone(),
            selection.clone(),
        )
        .await
        .unwrap_err();
    assert_eq!(conflict.code(), "storage.command_conflict");
    let unstarted = fixture.task("accepted only", Plan::default());
    let receipt = fixture
        .session
        .accept_history_run(
            unstarted.operation_id.clone(),
            unstarted.run_id.clone(),
            unstarted.input.clone(),
            selection,
        )
        .await
        .unwrap();
    // This prefix is not replayable. Receipt-first lookup must still return the old acceptance.
    duplicate_without_dependencies(
        &unstarted,
        &fixture.session,
        &receipt,
        RecordedRunState::Accepted,
    )
    .await;
    assert_eq!(count(&unstarted.observed.validations), 0);
    assert_eq!(count(&task.observed.validations), 1);
    assert_eq!(count(&task.observed.records.opens), 1);
    fixture.store.close().await.unwrap();
    let reopened = SessionStore::open(fixture.temp.path().join("root"))
        .await
        .unwrap();
    let session = reopened
        .open_session(fixture.session.session_id().clone())
        .await
        .unwrap();
    duplicate_without_dependencies(&task, &session, &acceptance, RecordedRunState::Completed).await;
    duplicate_without_dependencies(
        &unstarted,
        &session,
        &receipt,
        RecordedRunState::Interrupted,
    )
    .await;
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_22_23_b1_receipt_conflicts_and_legacy_history_fails_before_current_checks() {
    let fixture = Fixture::new().await;
    let task = fixture.task("legacy", Plan::default());
    fixture
        .session
        .accept_run(
            task.operation_id.clone(),
            task.run_id.clone(),
            task.input.clone(),
        )
        .await
        .unwrap();
    let failure = run_in_session(
        &Gateway::new(),
        &fixture.session,
        task.request(),
        &ToolRegistry::new(),
        CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(failure.stage(), PersistentRunStage::Acceptance);
    assert!(
        matches!(failure.cause(), PersistentRunCause::Storage(error) if error.code() == "storage.command_conflict")
    );
    let next = fixture.task("new", Plan::default());
    fixture.counts.definitions.store(0, Ordering::SeqCst);
    let failure = watchdog(next.start(CancellationToken::new()))
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(failure.stage(), PersistentRunStage::History);
    assert!(matches!(
        failure.cause(),
        PersistentRunCause::Gateway(GatewayError::InvalidRequest(
            "stored history has no replay provenance"
        ))
    ));
    assert_eq!(count(&fixture.counts.definitions), 0);
    assert_eq!(count(&next.observed.records.capabilities), 0);
    assert_eq!(count(&next.observed.records.opens), 0);
    fixture.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_23_both_absent_lookups_recheck_and_execute_only_once() {
    let fixture = Fixture::new().await;
    let task = fixture.task("race", Plan::default());
    let pause = Arc::new(Pause::default());
    fixture
        .session
        .test_hooks()
        .arm(Point::ReceiptLookupComplete, Action::Pause(pause.clone()));
    let first = task.start(CancellationToken::new());
    watchdog(pause.reached.notified()).await;
    let (acceptance, _, _) = task.execute().await;
    pause.release.notify_one();
    let PersistentRunResult::Duplicate {
        acceptance: repeated,
        run,
    } = watchdog(first).await.unwrap().unwrap()
    else {
        panic!("expected duplicate")
    };
    assert_eq!(repeated.receipt(), acceptance.receipt());
    assert_eq!(run.state(), RecordedRunState::Completed);
    assert_eq!(count(&task.observed.validations), 1);
    assert_eq!(count(&task.observed.records.opens), 1);
    assert_eq!(count(&task.observed.installs), 1);
    assert_eq!(task.observed.records.inputs.lock().unwrap().len(), 1);
    fixture.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_23_direct_selected_acceptance_wins_lookup_race_without_execution() {
    let fixture = Fixture::new().await;
    let task = fixture.task("direct race", Plan::default());
    let selected = prepare_session_replay(&fixture.session, ID, "synthetic")
        .await
        .unwrap()
        .selection();
    let pause = Arc::new(Pause::default());
    fixture
        .session
        .test_hooks()
        .arm(Point::ReceiptLookupComplete, Action::Pause(pause.clone()));
    let pending = task.start(CancellationToken::new());
    watchdog(pause.reached.notified()).await;
    let accepted = fixture
        .session
        .accept_history_run(
            task.operation_id.clone(),
            task.run_id.clone(),
            task.input.clone(),
            selected,
        )
        .await
        .unwrap();
    pause.release.notify_one();
    let PersistentRunResult::Duplicate { acceptance, run } =
        watchdog(pending).await.unwrap().unwrap()
    else {
        panic!("expected duplicate")
    };
    assert_eq!(acceptance.receipt(), accepted.receipt());
    assert_eq!(run.state(), RecordedRunState::Accepted);
    assert_eq!(count(&task.observed.validations), 0);
    assert_eq!(count(&task.observed.records.opens), 0);
    fixture.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_06_stale_captured_head_is_not_rebuilt_or_executed() {
    let fixture = Fixture::new().await;
    let task = fixture.task("stale", Plan::default());
    let pause = Arc::new(Pause::default());
    fixture
        .session
        .test_hooks()
        .arm(Point::ReplayHeadCaptured, Action::Pause(pause.clone()));
    let pending = task.start(CancellationToken::new());
    watchdog(pause.reached.notified()).await;
    fixture
        .session
        .rename(OperationId::new(), "advance H".into())
        .await
        .unwrap();
    pause.release.notify_one();
    let failure = watchdog(pending).await.unwrap().unwrap_err();
    assert_eq!(failure.stage(), PersistentRunStage::Acceptance);
    assert!(matches!(failure.cause(), PersistentRunCause::Storage(error)
        if error.code() == "storage.stale_history" && error.certainty() == CommitCertainty::NotCommitted));
    assert_eq!(count(&task.observed.validations), 1);
    assert_eq!(count(&task.observed.records.opens), 0);
    assert!(
        fixture
            .session
            .lookup_receipt(task.operation_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        fixture
            .session
            .run_record(task.run_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(fixture.session.manifest().await.unwrap().head_sequence(), 2);
    fixture.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_17_25_pure_replay_rejection_and_selection_rollback_do_no_provider_work() {
    for selection_fault in [false, true] {
        let fixture = Fixture::new().await;
        let task = fixture.task(
            "reject",
            Plan {
                unsupported: !selection_fault,
                ..Plan::default()
            },
        );
        if selection_fault {
            fixture
                .session
                .test_hooks()
                .arm(Point::HistorySelection, Action::Fail(StorageErrorKind::Io));
        }
        let failure = watchdog(task.start(CancellationToken::new()))
            .await
            .unwrap()
            .unwrap_err();
        if selection_fault {
            assert_eq!(failure.stage(), PersistentRunStage::Acceptance);
            assert!(
                matches!(failure.cause(), PersistentRunCause::Storage(error) if error.certainty() == CommitCertainty::NotCommitted)
            );
        } else {
            assert_eq!(failure.stage(), PersistentRunStage::Preflight);
            assert!(matches!(
                failure.cause(),
                PersistentRunCause::Gateway(GatewayError::UnsupportedFeature("history_replay"))
            ));
        }
        assert_eq!(count(&task.observed.validations), 1);
        assert_eq!(count(&task.observed.records.opens), 0);
        assert!(
            fixture
                .session
                .lookup_receipt(task.operation_id.clone())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(fixture.session.manifest().await.unwrap().head_sequence(), 1);
        fixture.store.close().await.unwrap();
    }
}
