use super::b2::*;
use super::fixture::{Control, Script, count};
use super::*;

#[tokio::test]
async fn active_session_rejects_new_work_without_queueing_independent_session() {
    let (_temp, store) = store().await;
    let a = session(&store).await;
    let b = session(&store).await;
    let waiting = Arc::new(Control::default());
    let other = Arc::new(Control::default());
    let (gateway, script) = Script::gateway(vec![waiting.clone(), other.clone()]);
    let host = RunHost::new(store, gateway).unwrap();
    let first = host
        .client()
        .submit(a.session_id().clone(), request(), ToolRegistry::new())
        .unwrap();
    watchdog(waiting.waiting.notified()).await;
    let next_request = request();
    let next_run = next_request.run_id.clone();
    let rejected = host
        .client()
        .submit(a.session_id().clone(), next_request, ToolRegistry::new())
        .unwrap();
    let completion = watchdog(rejected.completion()).await;
    assert_eq!(failure(&completion).stage(), PersistentRunStage::History);
    assert!(matches!(
        failure(&completion).cause(),
        PersistentRunCause::Gateway(GatewayError::InvalidRequest(
            "stored history is incomplete for native replay"
        ))
    ));
    assert!(Arc::ptr_eq(
        &completion,
        &rejected.accepted().await.unwrap_err()
    ));
    assert!(a.run_record(next_run.clone()).await.unwrap().is_none());
    assert!(futures_util::poll!(Box::pin(first.completion())).is_pending());
    let independent = host
        .client()
        .submit(b.session_id().clone(), request(), ToolRegistry::new())
        .unwrap();
    watchdog(other.waiting.notified()).await;
    other.release.notify_one();
    assert_eq!(
        executed(&watchdog(independent.completion()).await)
            .2
            .outcome,
        RunOutcome::Completed
    );
    assert_eq!(count(&waiting.closes), 0);
    waiting.release.notify_one();
    assert_eq!(
        executed(&watchdog(first.completion()).await).2.outcome,
        RunOutcome::Completed
    );
    retired(&host).await;
    assert!(a.run_record(next_run).await.unwrap().is_none());
    assert_eq!(count(&script.opens), 2);
    closed(&host).await;
}

#[tokio::test]
async fn both_absent_host_receipts_yield_one_executor_and_one_duplicate() {
    let fixture = Fixture::new().await;
    let task = fixture.task("absent host race", Plan::default());
    let pause = Arc::new(Pause::default());
    fixture
        .session
        .test_hooks()
        .arm(Point::ReceiptLookupComplete, Action::Pause(pause.clone()));
    let host = RunHost::new(fixture.store, task.gateway.clone()).unwrap();
    let first = submit(&host, &task);
    watchdog(pause.reached.notified()).await;
    let second = submit(&host, &task);
    let actual = watchdog(second.completion()).await;
    let (acceptance, _, _) = executed(&actual);
    pause.release.notify_one();
    let duplicate = watchdog(first.completion()).await;
    let RunCompletion::Execution(Ok(PersistentRunResult::Duplicate {
        acceptance: repeated,
        run,
    })) = &*duplicate
    else {
        panic!("expected duplicate")
    };
    assert_eq!(run.state(), RecordedRunState::Completed);
    assert!(repeated.duplicate());
    assert_eq!(repeated.receipt(), acceptance.receipt());
    assert_eq!(first.accepted().await.unwrap(), *repeated);
    assert_eq!(second.accepted().await.unwrap(), *acceptance);
    assert_eq!(count(&task.observed.records.opens), 1);
    assert_eq!(count(&task.observed.validations), 1);
    assert_eq!(count(&task.observed.installs), 1);
    assert_eq!(task.observed.records.inputs.lock().unwrap().len(), 1);
    closed(&host).await;
}

#[tokio::test]
async fn direct_storage_acceptance_wins_host_lookup_and_late_acceptance_races() {
    for late in [false, true] {
        let fixture = Fixture::new().await;
        let task = fixture.task("storage race", Plan::default());
        let selection = crate::execution::prepare_session_replay(
            &fixture.session,
            "execution-script",
            "synthetic",
        )
        .await
        .unwrap()
        .selection();
        let pause = Arc::new(Pause::default());
        let point = if late {
            Point::ReplayHeadCaptured
        } else {
            Point::ReceiptLookupComplete
        };
        fixture
            .session
            .test_hooks()
            .arm(point, Action::Pause(pause.clone()));
        let host = RunHost::new(fixture.store, task.gateway.clone()).unwrap();
        let ticket = submit(&host, &task);
        watchdog(pause.reached.notified()).await;
        let original = if late {
            fixture
                .session
                .test_accept_history_run_uncoordinated(
                    task.operation_id.clone(),
                    task.run_id.clone(),
                    task.input.clone(),
                    selection,
                )
                .await
                .unwrap()
        } else {
            fixture
                .session
                .accept_history_run(
                    task.operation_id.clone(),
                    task.run_id.clone(),
                    task.input.clone(),
                    selection,
                )
                .await
                .unwrap()
        };
        pause.release.notify_one();
        let completion = watchdog(ticket.completion()).await;
        let RunCompletion::Execution(Ok(PersistentRunResult::Duplicate { acceptance, run })) =
            &*completion
        else {
            panic!("expected duplicate")
        };
        assert_eq!(run.state(), RecordedRunState::Accepted);
        assert!(run.result().is_none());
        assert_eq!(acceptance.receipt(), original.receipt());
        assert!(acceptance.duplicate());
        assert_eq!(ticket.accepted().await.unwrap(), *acceptance);
        assert_eq!(count(&task.observed.records.opens), 0);
        assert_eq!(count(&task.observed.validations), usize::from(late));
        assert_eq!(count(&fixture.counts.effects), 0);
        closed(&host).await;
    }
}

#[tokio::test]
async fn completed_and_reopened_duplicates_ignore_current_checks_but_not_identity() {
    let fixture = Fixture::new().await;
    let task = fixture.task("original", Plan::default());
    let host = RunHost::new(fixture.store, task.gateway.clone()).unwrap();
    let ticket = submit(&host, &task);
    let completed = watchdog(ticket.completion()).await;
    let (original, final_record, _) = executed(&completed);
    let mut host = host;
    for reopened in [false, true] {
        if reopened {
            closed(&host).await;
            let store = SessionStore::open(fixture.temp.path().join("root"))
                .await
                .unwrap();
            host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
        }
        let session = host
            .storage()
            .open_session(task.session.session_id().clone())
            .await
            .unwrap();
        let head = session.manifest().await.unwrap().head_sequence();
        // Current-thread runtime: cancellation is signalled before the worker's first poll.
        let repeated = host
            .client()
            .submit(
                session.session_id().clone(),
                task.request(),
                ToolRegistry::new(),
            )
            .unwrap();
        assert_eq!(
            host.client()
                .cancel(repeated.session_id(), repeated.run_id()),
            CancelDisposition::Requested
        );
        let receipt = watchdog(repeated.accepted()).await.unwrap();
        assert!(receipt.duplicate());
        assert_eq!(receipt.receipt(), original.receipt());
        let completion = repeated.completion().await;
        let RunCompletion::Execution(Ok(PersistentRunResult::Duplicate { run, .. })) = &*completion
        else {
            panic!("expected duplicate")
        };
        assert_eq!(run.state(), RecordedRunState::Completed);
        assert_eq!(value(run.input()), value(&task.input));
        for conflict in ["run", "input", "method"] {
            let mut changed = task.request();
            match conflict {
                "run" => changed.run_id = RunId::new(),
                "input" => changed.input = request().input,
                "method" => changed.operation_id = final_record.receipt().operation_id().clone(),
                _ => unreachable!(),
            }
            let ticket = host
                .client()
                .submit(session.session_id().clone(), changed, ToolRegistry::new())
                .unwrap();
            let completion = watchdog(ticket.accepted()).await.unwrap_err();
            assert!(Arc::ptr_eq(&completion, &ticket.completion().await));
            assert_eq!(failure(&completion).stage(), PersistentRunStage::Acceptance);
            assert!(
                matches!(failure(&completion).cause(), PersistentRunCause::Storage(error) if error.kind() == StorageErrorKind::CommandConflict)
            );
        }
        assert_eq!(session.manifest().await.unwrap().head_sequence(), head);
        assert_eq!(count(&task.observed.records.opens), 1);
        assert_eq!(count(&task.observed.validations), 1);
    }
    closed(&host).await;
}

#[tokio::test]
async fn concurrent_receipt_and_completion_waiters_share_stable_terminal_arc() {
    for fail in [false, true] {
        let fixture = Fixture::new().await;
        let task = fixture.task("waiter races", Plan::default());
        let gate = pause(&fixture.session, Record::Acceptance, Point::BeforeCommit);
        let host = RunHost::new(fixture.store, task.gateway.clone()).unwrap();
        let ticket = submit(&host, &task);
        watchdog(gate.reached.notified()).await;
        let subscribed = Arc::new(tokio::sync::Barrier::new(9));
        let waiters: Vec<_> = (0..8)
            .map(|_| {
                let ticket = ticket.clone();
                let subscribed = subscribed.clone();
                tokio::spawn(async move {
                    let mut accepted = Box::pin(ticket.accepted());
                    let mut completed = Box::pin(ticket.completion());
                    assert!(futures_util::poll!(&mut accepted).is_pending());
                    assert!(futures_util::poll!(&mut completed).is_pending());
                    subscribed.wait().await;
                    (accepted.await, completed.await)
                })
            })
            .collect();
        watchdog(subscribed.wait()).await;
        if fail {
            fixture.session.test_hooks().arm_record(
                Record::Acceptance,
                Point::WriteClosed,
                Action::Fail(StorageErrorKind::Io),
            );
        }
        gate.release.notify_one();
        let completion = watchdog(ticket.completion()).await;
        for waiter in waiters {
            let (accepted, result) = watchdog(waiter).await.unwrap();
            assert!(Arc::ptr_eq(&completion, &result));
            match accepted {
                Ok(receipt) => {
                    assert!(!fail);
                    assert_eq!(receipt, ticket.accepted().await.unwrap());
                }
                Err(error) => {
                    assert!(fail);
                    assert!(Arc::ptr_eq(&completion, &error));
                }
            }
        }
        assert!(Arc::ptr_eq(&completion, &ticket.clone().completion().await));
        closed(&host).await;
    }
}

#[tokio::test]
async fn finite_submissions_retire_entries_and_retained_tickets_release_resources() {
    let (temp, store) = store().await;
    let controls: Vec<_> = (0..12).map(|_| Arc::new(Control::default())).collect();
    let (gateway, _) = Script::gateway(controls.clone());
    let weak_gateway = Arc::downgrade(&gateway);
    let host = RunHost::new(store, gateway).unwrap();
    let weak_host = Arc::downgrade(&host.inner);
    let client = host.client();
    let mut tickets = Vec::new();
    for control in controls {
        let session = session(host.storage()).await;
        control.release.notify_one();
        let ticket = client
            .submit(session.session_id().clone(), request(), ToolRegistry::new())
            .unwrap();
        assert_eq!(
            executed(&watchdog(ticket.completion()).await).2.outcome,
            RunOutcome::Completed
        );
        retired(&host).await;
        assert_eq!(
            client.cancel(ticket.session_id(), ticket.run_id()),
            CancelDisposition::NotTracked
        );
        tickets.push(ticket);
    }
    closed(&host).await;
    drop(host);
    watchdog(async {
        while weak_host.upgrade().is_some() || weak_gateway.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    SessionStore::open(temp.path().join("root"))
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    assert_eq!(tickets.len(), 12);
    for ticket in tickets {
        assert_eq!(
            executed(&ticket.completion().await).2.outcome,
            RunOutcome::Completed
        );
    }

    let fixture = Fixture::new().await;
    let tool = Arc::new(ToolProbe::default());
    let weak_tool = Arc::downgrade(&tool);
    let task = Task::new(
        &fixture.session,
        tool.registry(),
        "release tool",
        Plan::default(),
    );
    let host = RunHost::new(fixture.store, task.gateway.clone()).unwrap();
    let ticket = submit(&host, &task);
    drop(task);
    drop(tool);
    watchdog(ticket.completion()).await;
    retired(&host).await;
    assert!(weak_tool.upgrade().is_none());
    closed(&host).await;
}
