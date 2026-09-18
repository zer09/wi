use super::fixture::*;
use super::*;
use crate::{
    execution::{PersistentRunCause, PersistentRunResult, PersistentRunStage},
    run::RunOutcome,
    storage::{
        CommitCertainty, StorageErrorKind,
        test_hooks::{Action, Pause, Point, Record},
    },
};

fn executed(completion: &Arc<RunCompletion>) -> &crate::run::RunResult {
    let RunCompletion::Execution(Ok(PersistentRunResult::Executed { result, .. })) =
        completion.as_ref()
    else {
        panic!("expected actual execution: {completion:?}")
    };
    assert!(result.events_complete);
    assert!(result.sink_error.is_none());
    result
}

#[tokio::test]
async fn dispatch_receipt_and_completion_are_distinct_and_observers_can_disappear() {
    let (temp, store) = store().await;
    let session = session(&store).await;
    let pause = Arc::new(Pause::default());
    session.test_hooks().arm_record(
        Record::Acceptance,
        Point::BeforeCommit,
        Action::Pause(pause.clone()),
    );
    let control = Arc::new(Control::default());
    let (gateway, script) = Script::gateway(vec![control.clone()]);
    let host = RunHost::new(store, gateway).unwrap();
    assert_eq!(count(&script.capabilities), 0);
    assert_eq!(count(&script.opens), 0);
    let client = host.client();
    let request = request();
    let operation = request.operation_id.clone();
    let run = request.run_id.clone();
    let ticket = client
        .submit(session.session_id().clone(), request, ToolRegistry::new())
        .unwrap();
    assert_eq!(ticket.session_id(), session.session_id());
    assert_eq!(ticket.operation_id(), &operation);
    assert_eq!(ticket.run_id(), &run);
    assert_eq!(count(&script.capabilities), 0);
    watchdog(pause.reached.notified()).await;
    let mut accepted_waiter = Box::pin(ticket.accepted());
    assert!(futures_util::poll!(&mut accepted_waiter).is_pending());
    assert!(futures_util::poll!(Box::pin(ticket.completion())).is_pending());
    assert_eq!(count(&script.opens), 0);
    drop(accepted_waiter);
    pause.release.notify_one();
    watchdog(control.waiting.notified()).await;
    let accepted = watchdog(ticket.accepted()).await.unwrap();
    let receipt = session.lookup_receipt(operation).await.unwrap().unwrap();
    assert_eq!(accepted.receipt(), &receipt);
    assert_eq!((receipt.first_sequence(), receipt.last_sequence()), (2, 3));
    assert!(!accepted.duplicate());
    assert!(accepted.cleanup_warning().is_none());
    assert!(control.installed.lock().unwrap()[0].runs().is_empty());
    let mut completion_waiter = Box::pin(ticket.completion());
    assert!(futures_util::poll!(&mut completion_waiter).is_pending());
    drop(completion_waiter);
    drop(ticket);
    drop(client);
    control.release.notify_one();
    watchdog(async {
        loop {
            let saved = session.run_record(run.clone()).await.unwrap().unwrap();
            if let Some(result) = saved.result() {
                assert_eq!(result.outcome, RunOutcome::Completed);
                assert_eq!(
                    result.last_response.as_ref().unwrap().text,
                    "synthetic final output"
                );
                assert!(result.events_complete);
                assert!(result.sink_error.is_none());
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    watchdog(async {
        while !host.inner.gate().entries.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert_eq!(
        host.client().cancel(session.session_id(), &run),
        CancelDisposition::NotTracked
    );
    assert!(host.inner.gate().entries.is_empty());
    assert_eq!(count(&control.closes), 1);
    assert!(matches!(
        &*watchdog(host.begin_shutdown().wait()).await,
        ShutdownOutcome::Closed
    ));
    let reopened = SessionStore::open(temp.path().join("root")).await.unwrap();
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn active_duplicate_retains_exact_receipt_without_current_checks() {
    let (_temp, store) = store().await;
    let session = session(&store).await;
    let control = Arc::new(Control::default());
    let (gateway, script) = Script::gateway(vec![control.clone()]);
    let host = RunHost::new(store, gateway).unwrap();
    let client = host.client();
    let request = request();
    let duplicate = PersistentRunRequest {
        operation_id: request.operation_id.clone(),
        run_id: request.run_id.clone(),
        input: request.input.clone(),
    };
    let ticket = client
        .submit(session.session_id().clone(), request, ToolRegistry::new())
        .unwrap();
    watchdog(control.waiting.notified()).await;
    let original = ticket.accepted().await.unwrap();
    let capabilities = count(&script.capabilities);
    let validations = count(&script.validations);
    let repeated = client
        .submit(session.session_id().clone(), duplicate, ToolRegistry::new())
        .unwrap();
    let acceptance = watchdog(repeated.accepted()).await.unwrap();
    assert!(acceptance.duplicate());
    assert_eq!(acceptance.receipt(), original.receipt());
    let completion = watchdog(repeated.completion()).await;
    let RunCompletion::Execution(Ok(PersistentRunResult::Duplicate {
        acceptance: final_receipt,
        ..
    })) = &*completion
    else {
        panic!("expected duplicate")
    };
    assert_eq!(final_receipt, &acceptance);
    assert_eq!(count(&script.capabilities), capabilities);
    assert_eq!(count(&script.validations), validations);
    assert_eq!(count(&script.opens), 1);
    assert!(futures_util::poll!(Box::pin(ticket.completion())).is_pending());
    assert_eq!(
        client.cancel(ticket.session_id(), ticket.run_id()),
        CancelDisposition::Requested
    );
    assert_eq!(
        executed(&watchdog(ticket.completion()).await).outcome,
        RunOutcome::CancelledLocally
    );
    assert_eq!(ticket.accepted().await.unwrap(), original);
    assert!(matches!(
        &*watchdog(host.begin_shutdown().wait()).await,
        ShutdownOutcome::Closed
    ));
}

#[tokio::test]
async fn cancellation_matches_session_and_run_without_stopping_other_work() {
    let (_temp, store) = store().await;
    let first_session = session(&store).await;
    let second_session = session(&store).await;
    let first_control = Arc::new(Control::default());
    let second_control = Arc::new(Control::default());
    let (gateway, _) = Script::gateway(vec![first_control.clone(), second_control.clone()]);
    let host = RunHost::new(store, gateway).unwrap();
    let client = host.client();
    let first_request = request();
    let mut second_request = request();
    second_request.run_id = first_request.run_id.clone();
    let first = client
        .submit(
            first_session.session_id().clone(),
            first_request,
            ToolRegistry::new(),
        )
        .unwrap();
    watchdog(first_control.waiting.notified()).await;
    let second = client
        .submit(
            second_session.session_id().clone(),
            second_request,
            ToolRegistry::new(),
        )
        .unwrap();
    watchdog(second_control.waiting.notified()).await;
    assert_eq!(
        client.cancel(first.session_id(), &RunId::new()),
        CancelDisposition::NotTracked
    );
    assert_eq!(
        client.cancel(&ApplicationSessionId::new(), first.run_id()),
        CancelDisposition::NotTracked
    );
    assert_eq!(
        client.cancel(first.session_id(), first.run_id()),
        CancelDisposition::Requested
    );
    assert_eq!(
        client.cancel(first.session_id(), first.run_id()),
        CancelDisposition::Requested
    );
    assert_eq!(
        executed(&watchdog(first.completion()).await).outcome,
        RunOutcome::CancelledLocally
    );
    assert_eq!(
        client.cancel(first.session_id(), first.run_id()),
        CancelDisposition::NotTracked
    );
    assert_eq!(count(&second_control.closes), 0);
    assert!(futures_util::poll!(Box::pin(second.completion())).is_pending());
    second_control.release.notify_one();
    let completion = watchdog(second.completion()).await;
    assert_eq!(executed(&completion).outcome, RunOutcome::Completed);
    assert_eq!(
        client.cancel(second.session_id(), second.run_id()),
        CancelDisposition::NotTracked
    );
    assert!(Arc::ptr_eq(&completion, &second.completion().await));
    assert!(matches!(
        &*watchdog(host.begin_shutdown().wait()).await,
        ShutdownOutcome::Closed
    ));
}

#[tokio::test]
async fn owner_drop_starts_shutdown_but_clients_and_tickets_are_passive() {
    let (temp, store) = store().await;
    let session = session(&store).await;
    let control = Arc::new(Control::default());
    let (gateway, _) = Script::gateway(vec![control.clone()]);
    let gateway_weak = Arc::downgrade(&gateway);
    let host = RunHost::new(store, gateway).unwrap();
    let client = host.client();
    let ticket = client
        .submit(session.session_id().clone(), request(), ToolRegistry::new())
        .unwrap();
    watchdog(control.waiting.notified()).await;
    drop(ticket.clone());
    drop(client.clone());
    assert_eq!(count(&control.closes), 0);
    let shutdown = ShutdownTicket::new(host.inner.shutdown.clone());
    assert_eq!(format!("{host:?}"), "RunHost([redacted])");
    assert_eq!(format!("{client:?}"), "RunClient([redacted])");
    assert_eq!(format!("{shutdown:?}"), "ShutdownTicket([redacted])");
    drop(host);
    assert_eq!(
        client
            .submit(session.session_id().clone(), request(), ToolRegistry::new())
            .unwrap_err(),
        RunHostError::Closed
    );
    assert_eq!(
        executed(&watchdog(ticket.completion()).await).outcome,
        RunOutcome::CancelledLocally
    );
    assert!(matches!(
        &*watchdog(shutdown.wait()).await,
        ShutdownOutcome::Closed
    ));
    // Old tickets and weak clients must not keep the gateway or lease alive.
    watchdog(async {
        while gateway_weak.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert_eq!(
        client.cancel(ticket.session_id(), ticket.run_id()),
        CancelDisposition::Closed
    );
    assert_eq!(
        format!("{:?}", ticket.completion().await),
        "RunCompletion::Execution([redacted])"
    );
    SessionStore::open(temp.path().join("root"))
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
}

#[tokio::test]
async fn shutdown_is_once_only_and_drains_final_sql_after_all_waiters_drop() {
    let (_temp, store) = store().await;
    let session = session(&store).await;
    let control = Arc::new(Control::default());
    let (gateway, _) = Script::gateway(vec![control.clone()]);
    let host = RunHost::new(store, gateway).unwrap();
    let ticket = host
        .client()
        .submit(session.session_id().clone(), request(), ToolRegistry::new())
        .unwrap();
    watchdog(control.waiting.notified()).await;
    let pause = Arc::new(Pause::default());
    session.test_hooks().arm_record(
        Record::FinalResult,
        Point::BeforeCommit,
        Action::Pause(pause.clone()),
    );
    let first = host.begin_shutdown();
    watchdog(pause.reached.notified()).await;
    let second = host.begin_shutdown();
    fn send<T: Send>(_: T) {}
    send(first.wait());
    assert!(futures_util::poll!(Box::pin(second.wait())).is_pending());
    assert!(futures_util::poll!(Box::pin(ticket.completion())).is_pending());
    drop(first);
    drop(second);
    pause.release.notify_one();
    assert_eq!(
        executed(&watchdog(ticket.completion()).await).outcome,
        RunOutcome::CancelledLocally
    );
    let later = host.begin_shutdown();
    let result = watchdog(later.wait()).await;
    assert!(matches!(&*result, ShutdownOutcome::Closed));
    assert!(Arc::ptr_eq(&result, &host.begin_shutdown().wait().await));
    assert_eq!(count(&control.closes), 1);
    assert!(host.inner.gate().entries.is_empty());
    assert!(host.inner.tracker.is_empty());
    assert_eq!(
        session.manifest().await.unwrap_err().code(),
        "storage.closed"
    );
}

#[tokio::test]
async fn opening_and_acceptance_failures_preserve_actual_completion() {
    let (_temp, store) = store().await;
    let host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
    let missing = host
        .client()
        .submit(ApplicationSessionId::new(), request(), ToolRegistry::new())
        .unwrap();
    let failure = watchdog(missing.accepted()).await.unwrap_err();
    assert!(Arc::ptr_eq(&failure, &missing.completion().await));
    let RunCompletion::SessionOpenFailed(error) = &*failure else {
        panic!("expected session error")
    };
    assert_eq!(error.code(), "storage.not_found");
    assert_eq!(
        format!("{failure:?}"),
        "RunCompletion::SessionOpenFailed([redacted])"
    );
    assert!(matches!(
        &*watchdog(host.begin_shutdown().wait()).await,
        ShutdownOutcome::Closed
    ));

    for (point, certainty, known) in [
        (
            Point::BeforeCommit,
            Some(CommitCertainty::NotCommitted),
            false,
        ),
        (Point::AfterCommit, Some(CommitCertainty::Unknown), false),
        (Point::WriteClosed, None, true),
    ] {
        let (_temp, store) = super::store().await;
        let session = session(&store).await;
        let kind = if certainty == Some(CommitCertainty::Unknown) {
            StorageErrorKind::CommitUnknown
        } else {
            StorageErrorKind::Io
        };
        session
            .test_hooks()
            .arm_record(Record::Acceptance, point, Action::Fail(kind));
        let (gateway, script) = Script::gateway(vec![]);
        let host = RunHost::new(store, gateway).unwrap();
        let ticket = host
            .client()
            .submit(session.session_id().clone(), request(), ToolRegistry::new())
            .unwrap();
        let completion = watchdog(ticket.accepted()).await.unwrap_err();
        assert!(Arc::ptr_eq(&completion, &ticket.completion().await));
        let RunCompletion::Execution(Err(failure)) = &*completion else {
            panic!("expected acceptance failure")
        };
        assert_eq!(failure.stage(), PersistentRunStage::Acceptance);
        assert_eq!(failure.acceptance().is_some(), known);
        match failure.cause() {
            PersistentRunCause::Storage(error) => assert_eq!(Some(error.certainty()), certainty),
            PersistentRunCause::Cleanup { commit, .. } => {
                assert!(known);
                assert!(commit.cleanup_warning().is_some());
            }
            _ => panic!("expected storage failure"),
        }
        assert_eq!(count(&script.opens), 0);
        assert!(matches!(
            &*watchdog(host.begin_shutdown().wait()).await,
            ShutdownOutcome::Closed
        ));
    }
}

#[tokio::test]
async fn accepted_receipt_survives_later_recording_failure() {
    let (_temp, store) = store().await;
    let session = session(&store).await;
    let control = Arc::new(Control::default());
    let (gateway, _) = Script::gateway(vec![control.clone()]);
    let host = RunHost::new(store, gateway).unwrap();
    let ticket = host
        .client()
        .submit(session.session_id().clone(), request(), ToolRegistry::new())
        .unwrap();
    watchdog(control.waiting.notified()).await;
    let receipt = ticket.accepted().await.unwrap();
    session.test_hooks().arm_record(
        Record::FinalResult,
        Point::BeforeCommit,
        Action::Fail(StorageErrorKind::Io),
    );
    control.release.notify_one();
    let completion = watchdog(ticket.completion()).await;
    let RunCompletion::Execution(Err(failure)) = &*completion else {
        panic!("expected final recording failure")
    };
    assert_eq!(failure.stage(), PersistentRunStage::FinalResult);
    assert_eq!(failure.acceptance(), Some(receipt.receipt()));
    assert_eq!(
        failure.observed_result().unwrap().outcome,
        RunOutcome::Completed
    );
    assert_eq!(ticket.clone().accepted().await.unwrap(), receipt);
    assert!(matches!(
        &*watchdog(host.begin_shutdown().wait()).await,
        ShutdownOutcome::Closed
    ));
}
