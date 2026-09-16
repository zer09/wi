use super::{
    fault_tests::fixture,
    test_hooks::{Action, Pause, Point},
    *,
};

#[tokio::test]
async fn p1b1_acceptance_lock_coordinates_direct_calls_and_reclaims_weak_keys() {
    let (_temp, store, handle) = fixture().await;
    let other_handle = store
        .open_session(handle.session_id().clone())
        .await
        .unwrap();
    let operation = OperationId::new();
    let run_id = RunId::new();
    let input = RecordedRunInput::new(
        "original".into(),
        crate::run::RunRequest {
            provider_id: "synthetic".into(),
            options: crate::SessionOptions::new("synthetic"),
            prompt: "prepared".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap();
    let before = store.inner.lifecycle.gauge();
    let acceptance = handle.run_acceptance(operation.clone()).await;
    assert_eq!(store.inner.lifecycle.gauge(), before);
    let mut direct = Box::pin(other_handle.accept_run(operation.clone(), run_id.clone(), input));
    assert!(futures_util::poll!(&mut direct).is_pending());
    assert_eq!(store.inner.lifecycle.gauge(), before);
    assert_eq!(handle.manifest().await.unwrap().head_sequence(), 1);
    store.repair_catalog().await.unwrap();

    let mut other_operation = Box::pin(handle.run_acceptance(OperationId::new()));
    assert!(futures_util::poll!(&mut other_operation).is_ready());
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "other".into(), None).unwrap())
        .await
        .unwrap();
    let other_session = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let mut other_session_acceptance = Box::pin(other_session.run_acceptance(operation.clone()));
    assert!(futures_util::poll!(&mut other_session_acceptance).is_ready());

    drop(acceptance);
    let committed = direct.await.unwrap();
    assert!(!committed.duplicate());
    assert_eq!(
        handle.lookup_receipt(operation).await.unwrap().as_ref(),
        Some(committed.receipt())
    );
    assert_eq!(
        handle.run_record(run_id).await.unwrap().unwrap().state(),
        RecordedRunState::Accepted
    );
    for _ in 0..32 {
        let acceptance = handle.run_acceptance(OperationId::new()).await;
        assert_eq!(store.inner.acceptance_locks.lock().unwrap().len(), 1);
        drop(acceptance);
    }
    assert!(
        store
            .inner
            .acceptance_locks
            .lock()
            .unwrap()
            .values()
            .all(|lock| lock.strong_count() == 0)
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1b1_dropped_acceptance_waiter_keeps_key_until_owned_sql_drains() {
    let (_temp, store, handle) = fixture().await;
    let operation = OperationId::new();
    let run_id = RunId::new();
    let input = RecordedRunInput::new(
        "original".into(),
        crate::run::RunRequest {
            provider_id: "synthetic".into(),
            options: crate::SessionOptions::new("synthetic"),
            prompt: "prepared".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap();
    let pause = Arc::new(Pause::default());
    store
        .inner
        .hooks
        .arm(Point::BeforeCommit, Action::Pause(pause.clone()));
    let writer = tokio::spawn({
        let handle = handle.clone();
        let operation = operation.clone();
        let run_id = run_id.clone();
        async move { handle.accept_run(operation, run_id, input).await }
    });
    pause.reached.notified().await;
    writer.abort();
    assert!(writer.await.unwrap_err().is_cancelled());
    let mut waiting = Box::pin(handle.run_acceptance(operation.clone()));
    assert!(futures_util::poll!(&mut waiting).is_pending());
    let mut close = Box::pin(store.close());
    assert!(futures_util::poll!(&mut close).is_pending());
    assert_eq!(
        filesystem::acquire_lease(&store.inner.root)
            .unwrap_err()
            .code(),
        "storage.busy"
    );
    pause.release.notify_one();
    drop(waiting.await);
    close.await.unwrap();
    let reopened = SessionStore::open(store.inner.root.clone()).await.unwrap();
    let handle = reopened
        .open_session(handle.session_id().clone())
        .await
        .unwrap();
    let receipt = handle.lookup_receipt(operation).await.unwrap().unwrap();
    assert_eq!(receipt.run_id(), Some(&run_id));
    assert_eq!(
        handle.run_record(run_id).await.unwrap().unwrap().state(),
        RecordedRunState::Interrupted
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn p1b1_execution_close_signals_rejects_admission_and_waits_for_finished_hold() {
    let (_temp, store, handle) = fixture().await;
    let hold = handle.execution_hold().unwrap();
    let signal = hold.closing_token();
    let mut notified = Box::pin(signal.cancelled());
    assert!(futures_util::poll!(&mut notified).is_pending());

    let mut close = Box::pin(store.close());
    assert!(futures_util::poll!(&mut close).is_pending());
    assert!(futures_util::poll!(&mut notified).is_ready());
    assert!(hold.closing_token().is_cancelled());
    assert_eq!(
        handle.execution_hold().err().unwrap().code(),
        "storage.closed"
    );
    let error = handle
        .rename(OperationId::new(), "rejected".into())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "storage.closed");
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    assert_eq!(
        SessionStore::open(store.inner.root.clone())
            .await
            .unwrap_err()
            .code(),
        "storage.busy"
    );

    // Dropping the close waiter must not reopen admission or release the hold.
    drop(close);
    assert!(signal.is_cancelled());
    assert_eq!(
        handle.manifest().await.unwrap_err().code(),
        "storage.closed"
    );
    assert_eq!(store.inner.lifecycle.gauge().0, 1);
    assert_eq!(
        filesystem::acquire_lease(&store.inner.root)
            .unwrap_err()
            .code(),
        "storage.busy"
    );
    hold.finish();
    assert_eq!(store.inner.lifecycle.gauge().0, 0);
    // Drain releases a healthy lease even without a surviving close waiter.
    let reopened = SessionStore::open(store.inner.root.clone()).await.unwrap();
    store.close().await.unwrap();
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn p1b1_execution_close_drains_hold_and_admitted_sql_in_either_order() {
    for hold_first in [false, true] {
        let (_temp, store, handle) = fixture().await;
        let hold = handle.execution_hold().unwrap();
        let pause = Arc::new(Pause::default());
        store
            .inner
            .hooks
            .arm(Point::BeforeCommit, Action::Pause(pause.clone()));
        let writer = tokio::spawn({
            let handle = handle.clone();
            async move { handle.rename(OperationId::new(), "changed".into()).await }
        });
        pause.reached.notified().await;
        assert_eq!(store.inner.lifecycle.gauge().0, 2);
        let mut close = Box::pin(store.close());
        assert!(futures_util::poll!(&mut close).is_pending());

        if hold_first {
            hold.finish();
            assert_eq!(store.inner.lifecycle.gauge().0, 1);
            assert!(futures_util::poll!(&mut close).is_pending());
            assert_eq!(
                filesystem::acquire_lease(&store.inner.root)
                    .unwrap_err()
                    .code(),
                "storage.busy"
            );
            pause.release.notify_one();
            writer.await.unwrap().unwrap();
        } else {
            pause.release.notify_one();
            writer.await.unwrap().unwrap();
            assert_eq!(store.inner.lifecycle.gauge().0, 1);
            assert!(futures_util::poll!(&mut close).is_pending());
            assert_eq!(
                filesystem::acquire_lease(&store.inner.root)
                    .unwrap_err()
                    .code(),
                "storage.busy"
            );
            hold.finish();
        }
        close.await.unwrap();
        let (admitted, opened, closed, closing) = store.inner.lifecycle.gauge();
        assert_eq!(admitted, 0);
        assert_eq!(opened, closed);
        assert!(closing);
        let reopened = SessionStore::open(store.inner.root.clone()).await.unwrap();
        reopened.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1b1_execution_hold_uses_no_database_session_or_maintenance_lock() {
    let (_temp, store, handle) = fixture().await;
    let before = store.inner.lifecycle.gauge();
    let maintenance = store.inner.maintenance.write().await;
    let session = store.inner.session_lock(handle.session_id()).await;
    let hold = {
        let _session_map = store.inner.session_locks.lock().unwrap();
        handle.execution_hold().unwrap()
    };
    let _: &dyn Send = &hold;
    assert_eq!(
        store.inner.lifecycle.gauge(),
        (before.0 + 1, before.1, before.2, false)
    );
    let cancelled_observer = hold.closing_token();
    cancelled_observer.cancel();
    assert!(!hold.closing_token().is_cancelled());
    drop(session);
    drop(maintenance);

    // The hold must neither need these locks nor prevent later storage operations.
    assert!(store.inner.maintenance.try_write().is_ok());
    let mut session = Box::pin(store.inner.session_lock(handle.session_id()));
    assert!(futures_util::poll!(&mut session).is_ready());
    handle.manifest().await.unwrap();
    store.repair_catalog().await.unwrap();
    hold.finish();
    assert!(!store.inner.lifecycle.gauge().3);
    store.close().await.unwrap();
}
