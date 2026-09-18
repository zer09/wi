use super::*;

#[tokio::test]
async fn notifier_waits_for_unwarned_commit_and_precedes_completion() {
    let fixture = Fixture::new().await;
    let provider_pause = Arc::new(Barrier::default());
    let task = fixture.task(
        "early receipt",
        Plan {
            install_pause: Some(provider_pause.clone()),
            ..Plan::default()
        },
    );
    let commit_pause = Arc::new(Pause::default());
    fixture.session.test_hooks().arm_record(
        Record::Acceptance,
        Point::BeforeCommit,
        Action::Pause(commit_pause.clone()),
    );
    let received = Mutex::new(Vec::new());
    let notify = |commit| received.lock().unwrap().push(commit);
    let mut running = Box::pin(run_in_session_notifying(
        &task.gateway,
        &task.session,
        task.request(),
        &task.tools,
        CancellationToken::new(),
        &notify,
    ));
    tokio::select! {
        _ = watchdog(commit_pause.reached.notified()) => {}
        _ = &mut running => panic!("completed before acceptance"),
    }
    assert!(received.lock().unwrap().is_empty());
    assert_eq!(count(&task.observed.records.opens), 0);
    commit_pause.release.notify_one();
    tokio::select! {
        _ = watchdog(provider_pause.reached.notified()) => {}
        _ = &mut running => panic!("completed before provider release"),
    }
    let notified = received.lock().unwrap().clone();
    assert_eq!(notified.len(), 1);
    let receipt = fixture
        .session
        .lookup_receipt(task.operation_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(notified[0].receipt(), &receipt);
    assert_eq!((receipt.first_sequence(), receipt.last_sequence()), (2, 3));
    assert!(!notified[0].duplicate());
    assert!(notified[0].cleanup_warning().is_none());
    provider_pause.release.notify_one();
    let (acceptance, _, _) = executed(watchdog(running).await.unwrap());
    assert_eq!(notified[0], acceptance);
    assert_eq!(received.lock().unwrap().len(), 1);
    fixture.store.close().await.unwrap();
}

#[tokio::test]
async fn notifier_duplicate_precedes_fallible_record_read_even_when_cancelled() {
    let fixture = Fixture::new().await;
    let task = fixture.task("duplicate", Plan::default());
    let (original, _, _) = task.execute().await;
    let received = Mutex::new(Vec::new());
    let hooks = fixture.session.test_hooks();
    let notify = |commit| {
        received.lock().unwrap().push(commit);
        hooks.arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    };
    let cancel = CancellationToken::new();
    cancel.cancel();
    let failure = run_in_session_notifying(
        &Gateway::new(),
        &fixture.session,
        task.request(),
        &ToolRegistry::new(),
        cancel,
        &notify,
    )
    .await
    .unwrap_err();
    {
        let notified = received.lock().unwrap();
        assert_eq!(notified.len(), 1);
        assert!(notified[0].duplicate());
        assert_eq!(notified[0].receipt(), original.receipt());
    }
    assert_eq!(failure.stage(), PersistentRunStage::Lookup);
    assert_eq!(failure.acceptance(), Some(original.receipt()));
    assert_eq!(count(&task.observed.records.opens), 1);
    fixture.store.close().await.unwrap();
}

#[tokio::test]
async fn notifier_late_duplicate_precedes_fallible_record_read_after_absent_lookups() {
    let fixture = Fixture::new().await;
    let task = fixture.task(
        "late duplicate",
        Plan {
            responses: vec![
                response("call", vec![call("sum", 17, 25)], ""),
                response("final", vec![], "42"),
            ],
            ..Plan::default()
        },
    );
    let selected = prepare_session_replay(&fixture.session, ID, "synthetic")
        .await
        .unwrap()
        .selection();
    let pause = Arc::new(Pause::default());
    let hooks = fixture.session.test_hooks();
    hooks.arm(Point::ReplayHeadCaptured, Action::Pause(pause.clone()));
    let received = Mutex::new(Vec::new());
    let notify = |commit| {
        received.lock().unwrap().push(commit);
        // Only the subsequent accepted_run_record read may consume this failure.
        hooks.arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    };
    let mut running = Box::pin(hooks.scope(run_in_session_notifying(
        &task.gateway,
        &task.session,
        task.request(),
        &task.tools,
        CancellationToken::new(),
        &notify,
    )));
    // The early duplicate branch cannot reach replay preparation after both lookups.
    tokio::select! {
        _ = watchdog(pause.reached.notified()) => {}
        _ = &mut running => panic!("completed before replay capture"),
    }
    assert!(received.lock().unwrap().is_empty());
    assert!(
        fixture
            .session
            .lookup_receipt(task.operation_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    let original = watchdog(fixture.session.test_accept_history_run_uncoordinated(
        task.operation_id.clone(),
        task.run_id.clone(),
        task.input.clone(),
        selected.clone(),
    ))
    .await
    .unwrap();
    assert!(!original.duplicate());
    pause.release.notify_one();
    let failure = watchdog(running).await.unwrap_err();
    let notified = received.lock().unwrap().clone();
    assert_eq!(notified.len(), 1);
    assert!(notified[0].duplicate());
    assert_eq!(notified[0].receipt(), original.receipt());
    assert!(notified[0].cleanup_warning().is_none());
    assert_eq!(failure.stage(), PersistentRunStage::Lookup);
    assert!(matches!(failure.cause(), PersistentRunCause::Storage(error)
        if error.kind() == StorageErrorKind::Io && error.certainty() == CommitCertainty::NotApplicable));
    assert_eq!(failure.acceptance(), Some(notified[0].receipt()));
    let expected = fixture
        .session
        .accept_history_run(
            task.operation_id.clone(),
            task.run_id.clone(),
            task.input.clone(),
            selected,
        )
        .await
        .unwrap();
    assert_eq!(notified[0], expected);
    assert_eq!(
        fixture
            .session
            .lookup_receipt(task.operation_id.clone())
            .await
            .unwrap()
            .as_ref(),
        Some(original.receipt())
    );
    assert_eq!(
        fixture.session.manifest().await.unwrap().head_sequence(),
        original.receipt().last_sequence()
    );
    assert_eq!(count(&task.observed.validations), 1);
    assert_eq!(count(&task.observed.records.opens), 0);
    assert_eq!(count(&task.observed.installs), 0);
    no_generation(&task);
    assert_eq!(count(&fixture.counts.effects), 0);
    fixture.store.close().await.unwrap();
}

#[tokio::test]
async fn notifier_skips_failed_unknown_and_warned_acceptance() {
    for (point, kind, known) in [
        (Point::BeforeCommit, StorageErrorKind::Io, false),
        (Point::AfterCommit, StorageErrorKind::CommitUnknown, false),
        (Point::WriteClosed, StorageErrorKind::Io, true),
    ] {
        let fixture = Fixture::new().await;
        let task = fixture.task("no notification", Plan::default());
        fixture
            .session
            .test_hooks()
            .arm_record(Record::Acceptance, point, Action::Fail(kind));
        let calls = AtomicUsize::new(0);
        let notify = |_| {
            calls.fetch_add(1, Ordering::SeqCst);
        };
        let failure = run_in_session_notifying(
            &task.gateway,
            &task.session,
            task.request(),
            &task.tools,
            CancellationToken::new(),
            &notify,
        )
        .await
        .unwrap_err();
        assert_eq!(failure.stage(), PersistentRunStage::Acceptance);
        assert_eq!(failure.acceptance().is_some(), known);
        assert_eq!(count(&calls), 0);
        assert_eq!(count(&task.observed.records.opens), 0);
        fixture.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn notifier_skips_preflight_failure() {
    let fixture = Fixture::new().await;
    let task = fixture.task("cancelled before admission", Plan::default());
    let cancel = CancellationToken::new();
    cancel.cancel();
    let failure = run_in_session_notifying(
        &task.gateway,
        &task.session,
        task.request(),
        &task.tools,
        cancel,
        &|_| panic!("failed admission must not notify"),
    )
    .await
    .unwrap_err();
    assert_eq!(failure.stage(), PersistentRunStage::Preflight);
    fixture.store.close().await.unwrap();
}
