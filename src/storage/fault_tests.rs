use super::{
    test_hooks::{Action, Pause, Point},
    *,
};
use sqlx::Row;
use std::time::Duration;

pub(super) async fn fixture() -> (tempfile::TempDir, SessionStore, SessionHandle) {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "original".into(), None).unwrap())
        .await
        .unwrap();
    let handle = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    (temp, store, handle)
}

async fn watchdog<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(20), future)
        .await
        .expect("test watchdog, not a rollback observation")
}

fn idle(store: &SessionStore) -> usize {
    let (admitted, opened, closed, _) = store.inner.lifecycle.gauge();
    assert_eq!(admitted, 0);
    assert_eq!(opened, closed);
    opened
}

#[tokio::test]
async fn p1a18_fault_waiter_drop_commit_or_rollback_drains_before_lease_release() {
    for rollback in [false, true] {
        let (_temp, store, handle) = fixture().await;
        let operation = OperationId::new();
        let pause = Arc::new(Pause {
            rollback,
            ..Pause::default()
        });
        store
            .inner
            .hooks
            .arm(Point::BeforeCommit, Action::Pause(pause.clone()));
        let writer = tokio::spawn({
            let handle = handle.clone();
            let operation = operation.clone();
            async move { handle.rename(operation, "changed".into()).await }
        });
        watchdog(pause.reached.notified()).await;
        assert!(!writer.is_finished(), "success must wait for COMMIT");
        let (admitted, opened, closed, _) = store.inner.lifecycle.gauge();
        assert_eq!(admitted, 1);
        assert_eq!(opened - closed, 1);
        writer.abort(); // Drop only the public waiter, not storage's private task.
        assert!(writer.await.unwrap_err().is_cancelled());
        let mut closing = Box::pin(store.close());
        assert!(futures_util::poll!(&mut closing).is_pending());
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
        drop(closing); // Dropping close's waiter does not reopen admission.
        pause.release.notify_one();
        watchdog(store.close()).await.unwrap();
        idle(&store);
        let reopened = SessionStore::open(store.inner.root.clone()).await.unwrap();
        let handle = reopened
            .open_session(handle.session_id().clone())
            .await
            .unwrap();
        let before = handle.lookup_receipt(operation.clone()).await.unwrap();
        assert_eq!(before.is_some(), !rollback);
        assert_eq!(
            handle.manifest().await.unwrap().head_sequence(),
            if rollback { 1 } else { 2 }
        );
        let retry = handle
            .rename(operation.clone(), "changed".into())
            .await
            .unwrap();
        assert_eq!(retry.duplicate(), !rollback);
        if let Some(receipt) = before {
            assert_eq!(retry.receipt(), &receipt);
        }
        let again = handle.rename(operation, "changed".into()).await.unwrap();
        assert!(again.duplicate());
        assert_eq!(again.receipt(), retry.receipt());
        assert_eq!(
            handle
                .history_page(0, None, 10)
                .await
                .unwrap()
                .records()
                .len(),
            2
        );
        reopened.close().await.unwrap();
        idle(&reopened);
    }
}

#[tokio::test]
async fn p1a18_fault_acknowledgment_only_after_commit_and_unknown_lookup_both_outcomes() {
    let (_temp, store, handle) = fixture().await;
    let pause = Arc::new(Pause::default());
    store
        .inner
        .hooks
        .arm(Point::BeforeCommit, Action::Pause(pause.clone()));
    let mut writer = Box::pin(handle.rename(OperationId::new(), "held".into()));
    assert!(futures_util::poll!(&mut writer).is_pending());
    watchdog(pause.reached.notified()).await;
    assert!(futures_util::poll!(&mut writer).is_pending());
    pause.release.notify_one();
    let receipt = watchdog(writer).await.unwrap();
    assert_eq!(receipt.receipt().last_sequence(), 2);
    for (point, committed) in [(Point::CommitStart, false), (Point::AfterCommit, true)] {
        let operation = OperationId::new();
        store
            .inner
            .hooks
            .arm(point, Action::Fail(StorageErrorKind::CommitUnknown));
        let error = handle
            .rename(operation.clone(), "uncertain".into())
            .await
            .unwrap_err();
        assert_eq!(error.code(), "storage.commit_unknown");
        assert_eq!(error.certainty(), CommitCertainty::Unknown);
        let found = handle.lookup_receipt(operation.clone()).await.unwrap();
        assert_eq!(found.is_some(), committed);
        let result = handle.rename(operation, "uncertain".into()).await.unwrap();
        assert_eq!(result.duplicate(), committed);
        if let Some(receipt) = found {
            assert_eq!(result.receipt(), &receipt);
        }
    }
    store.close().await.unwrap();
    idle(&store);
}

#[tokio::test]
async fn p1a19_fault_precommit_io_cleanup_warning_and_failed_refresh_keep_receipt() {
    let (_temp, store, handle) = fixture().await;
    for point in [Point::Open, Point::BeforeCommit] {
        let operation = OperationId::new();
        store
            .inner
            .hooks
            .arm(point, Action::Fail(StorageErrorKind::Io));
        let error = handle
            .rename(operation.clone(), "not committed".into())
            .await
            .unwrap_err();
        assert_eq!(error.code(), "storage.io");
        assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
        assert!(handle.lookup_receipt(operation).await.unwrap().is_none());
        assert_eq!(handle.manifest().await.unwrap().head_sequence(), 1);
        idle(&store);
    }
    let operation = OperationId::new();
    store
        .inner
        .hooks
        .arm(Point::WriteClosed, Action::Fail(StorageErrorKind::Io));
    let result = handle
        .rename(operation.clone(), "committed".into())
        .await
        .unwrap();
    assert_eq!(
        result.cleanup_warning(),
        Some(CleanupWarning::ConnectionCloseFailed)
    );
    assert_eq!(
        handle
            .lookup_receipt(operation.clone())
            .await
            .unwrap()
            .as_ref(),
        Some(result.receipt())
    );
    store
        .inner
        .hooks
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    let error = handle.refresh_catalog().await.unwrap_err();
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    assert_eq!(
        handle
            .lookup_receipt(operation.clone())
            .await
            .unwrap()
            .as_ref(),
        Some(result.receipt())
    );
    assert_eq!(
        store.list_sessions(None, 1).await.unwrap().sessions()[0].title(),
        "original"
    );
    assert_eq!(
        handle
            .rename(operation, "committed".into())
            .await
            .unwrap()
            .receipt(),
        result.receipt()
    );
    handle.refresh_catalog().await.unwrap();
    store.close().await.unwrap();
    idle(&store);
}

#[tokio::test]
async fn p1a25_fault_independent_sessions_serial_order_reads_repair_and_close_drain() {
    let (_temp, store, first) = fixture().await;
    let second = store
        .create_session(CreateSession::new(OperationId::new(), "second".into(), None).unwrap())
        .await
        .unwrap();
    let second = store
        .open_session(second.session_id().clone())
        .await
        .unwrap();
    let pause = Arc::new(Pause::default());
    store
        .inner
        .hooks
        .arm(Point::BeforeCommit, Action::Pause(pause.clone()));
    let one = tokio::spawn({
        let first = first.clone();
        async move { first.rename(OperationId::new(), "one".into()).await }
    });
    watchdog(pause.reached.notified()).await;
    // A held transaction in A must not stop B's commit or short reads.
    assert_eq!(
        watchdog(second.rename(OperationId::new(), "independent".into()))
            .await
            .unwrap()
            .receipt()
            .last_sequence(),
        2
    );
    assert_eq!(
        watchdog(second.manifest()).await.unwrap().title(),
        "independent"
    );
    let two = tokio::spawn({
        let first = first.clone();
        async move { first.rename(OperationId::new(), "two".into()).await }
    });
    let reader = tokio::spawn({
        let first = first.clone();
        async move { first.history_page(0, None, 20).await }
    });
    let store = Arc::new(store);
    let repair = tokio::spawn({
        let store = store.clone();
        async move { store.repair_catalog().await }
    });
    watchdog(async {
        while store.inner.lifecycle.gauge().0 != 4 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let mut close = Box::pin(store.close());
    assert!(futures_util::poll!(&mut close).is_pending());
    pause.release.notify_one();
    assert_eq!(
        watchdog(one)
            .await
            .unwrap()
            .unwrap()
            .receipt()
            .last_sequence(),
        2
    );
    assert_eq!(
        watchdog(two)
            .await
            .unwrap()
            .unwrap()
            .receipt()
            .last_sequence(),
        3
    );
    assert!(
        !watchdog(reader)
            .await
            .unwrap()
            .unwrap()
            .records()
            .is_empty()
    );
    watchdog(repair).await.unwrap().unwrap();
    watchdog(close).await.unwrap();
    idle(&store);
    let reopened = SessionStore::open(store.inner.root.clone()).await.unwrap();
    let first = reopened
        .open_session(first.session_id().clone())
        .await
        .unwrap();
    assert_eq!(first.manifest().await.unwrap().title(), "two");
    assert_eq!(
        first
            .history_page(0, None, 10)
            .await
            .unwrap()
            .records()
            .iter()
            .map(|e| e.sequence())
            .collect::<Vec<_>>(),
        [1, 2, 3]
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn p1a25_fault_historical_handles_retain_no_connections_or_sql_workers() {
    let (_temp, store, first) = fixture().await;
    let mut handles = vec![first];
    let initial = idle(&store);
    for _ in 0..32 {
        let created = store
            .create_session(
                CreateSession::new(OperationId::new(), "historical".into(), None).unwrap(),
            )
            .await
            .unwrap();
        handles.push(
            store
                .open_session(created.session_id().clone())
                .await
                .unwrap(),
        );
        idle(&store);
    }
    for handle in &handles {
        let receipt = handle
            .rename(OperationId::new(), "retained".into())
            .await
            .unwrap();
        handle.manifest().await.unwrap();
        handle
            .lookup_receipt(receipt.receipt().operation_id().clone())
            .await
            .unwrap()
            .unwrap();
        handle.history_page(0, None, 2).await.unwrap();
        idle(&store);
    }
    let opened = idle(&store) - initial;
    assert!(opened > handles.len() * 4);
    assert!(
        store
            .inner
            .session_locks
            .lock()
            .unwrap()
            .values()
            .all(|lock| lock.strong_count() == 0)
    );
    println!(
        "lifecycle: retained_handles={} operation_scoped_opens={} active_connections=0 admitted=0",
        handles.len(),
        opened
    );
    store.close().await.unwrap();
    for handle in handles {
        assert_eq!(
            handle.manifest().await.unwrap_err().code(),
            "storage.closed"
        );
    }
}

#[tokio::test]
async fn p1a27_fault_real_sqlite_full_and_constraint_roll_back_whole_mutation() {
    for full in [false, true] {
        let (_temp, store, handle) = fixture().await;
        let operation = OperationId::new();
        let id = handle.session_id().clone();
        let error = store.inner.clone().operation(true, {
            let operation = operation.clone();
            move |inner| async move {
                let _lock = inner.session_lock(&id).await;
                let (mut connection, provenance) = session::connection(&inner, &id, true).await?;
                if full {
                    let pages: i64 = sqlx::query("PRAGMA page_count").fetch_one(&mut connection).await.unwrap().try_get(0).unwrap();
                    // SQLite clamps a value below the current count to the current count.
                    let maximum: i64 = sqlx::query("PRAGMA max_page_count=1").fetch_one(&mut connection).await.unwrap().try_get(0).unwrap();
                    assert_eq!(maximum, pages);
                } else {
                    sqlx::raw_sql("CREATE TRIGGER fixture_constraint BEFORE UPDATE OF title ON manifest BEGIN SELECT RAISE(ABORT, 'synthetic-sensitive-canary'); END;").execute(&mut connection).await.unwrap();
                }
                let result = session::rename_transaction(&mut connection, &provenance, &operation, &"x".repeat(512 * 1024), None).await;
                database::finish_write(connection, &inner.lifecycle, result, false).await
            }
        }).await.unwrap_err();
        assert_eq!(
            error.code(),
            if full {
                "storage.io"
            } else {
                "storage.integrity"
            }
        );
        assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
        assert!(!format!("{error:?} {error}").contains("canary"));
        assert!(handle.lookup_receipt(operation).await.unwrap().is_none());
        assert_eq!(handle.manifest().await.unwrap().head_sequence(), 1);
        assert_eq!(
            handle
                .history_page(0, None, 10)
                .await
                .unwrap()
                .records()
                .len(),
            1
        );
        store.close().await.unwrap();
        idle(&store);
    }
    println!("disk-full fixture: SQLite max_page_count exhaustion, not device-full or power-loss");
}
