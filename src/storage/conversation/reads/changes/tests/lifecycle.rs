use super::*;
use crate::storage::test_hooks::{
    Action, Pause, Point,
    read_retirement::{OpenFailure, WaitError},
};
use std::sync::Arc;

async fn provenance(sql: &mut SqliteConnection) -> crate::storage::CreationProvenance {
    let text: String = sqlx::query_scalar("SELECT creation_provenance_json FROM manifest")
        .fetch_one(sql)
        .await
        .unwrap();
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn a5b3_snapshot_head_and_projection_match_during_commit() {
    let f = Fixture::new("anchor").await;
    let pause = Arc::new(Pause::default());
    f.store.inner.hooks.arm(
        Point::ConversationHeadCaptured,
        Action::Pause(pause.clone()),
    );
    let handle = f.handle.clone();
    let after = watermark(&f, 1);
    let reader = tokio::spawn(async move { handle.conversation_changes(after).await.unwrap() });
    pause.reached.notified().await;
    let mut sql = f.sql().await;
    let provenance = provenance(&mut sql).await;
    crate::storage::session::rename_transaction(
        &mut sql,
        &provenance,
        &OperationId::new(),
        "later title",
        None,
    )
    .await
    .unwrap();
    sql.close().await.unwrap();
    pause.release.notify_one();
    let batch = reader.await.unwrap();
    assert_eq!(batch.observed_head(), 2);
    assert_eq!(batch.next_after().sequence(), 2);
    assert_eq!(batch.changes().len(), 2);
    let attached = f
        .handle
        .conversation_changes(batch.next_after().clone())
        .await
        .unwrap();
    let [DisplayChange::SessionUpsert(session)] = attached.changes() else {
        panic!("committed rename must appear")
    };
    assert_eq!(session.title(), "later title");
    assert_eq!(session.head_sequence(), attached.observed_head());
    bounded(&batch);
    bounded(&attached);
    let (admitted, opened, retired, closing) = f.store.inner.lifecycle.gauge();
    assert_eq!(admitted, 0);
    assert_eq!(opened, retired);
    assert!(!closing);
    // A new write after return proves that no read transaction or session lock remains.
    f.handle
        .rename(OperationId::new(), "after return".into())
        .await
        .unwrap();
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b3_commit_rollback_barriers_and_duplicate_mutation_preservation() {
    for rollback in [false, true] {
        let f = Fixture::new("anchor").await;
        let pause = Arc::new(Pause {
            rollback,
            ..Default::default()
        });
        f.store
            .inner
            .hooks
            .arm(Point::DisplayApplied, Action::Pause(pause.clone()));
        let operation = OperationId::new();
        let record = identifier_tests::runtime(&f.run, 1, RunEvent::RunStarted);
        let handle = f.handle.clone();
        let run = f.run.clone();
        let op = operation.clone();
        let record_copy = record.clone();
        let writer =
            tokio::spawn(
                async move { handle.append_run_records(op, run, vec![record_copy]).await },
            );
        pause.reached.notified().await;
        let mut sql = f.sql().await;
        let provenance = provenance(&mut sql).await;
        let batch = read(
            &mut sql,
            f.handle.session_id(),
            &provenance,
            watermark(&f, 2),
        )
        .await
        .unwrap();
        assert_eq!(batch.observed_head(), 2);
        assert!(batch.changes().is_empty());
        sql.close().await.unwrap();
        pause.release.notify_one();
        let write = writer.await.unwrap();
        let batch = f
            .handle
            .conversation_changes(watermark(&f, 2))
            .await
            .unwrap();
        if rollback {
            assert_eq!(write.unwrap_err().kind(), StorageErrorKind::Io);
            assert_eq!(batch.observed_head(), 2);
            assert!(batch.changes().is_empty());
            assert!(f.handle.lookup_receipt(operation).await.unwrap().is_none());
        } else {
            let write = write.unwrap();
            assert_eq!(batch.observed_head(), 3);
            let saved = identifier_tests::snapshot(&f.path).await;
            let duplicate = f
                .handle
                .append_run_records(operation.clone(), f.run.clone(), vec![record])
                .await
                .unwrap();
            assert!(duplicate.duplicate());
            assert_eq!(duplicate.receipt(), write.receipt());
            assert_eq!(identifier_tests::snapshot(&f.path).await, saved);
            assert_eq!(
                f.handle.lookup_receipt(operation).await.unwrap().unwrap(),
                *write.receipt()
            );
        }
        bounded(&batch);
        f.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn a5b3_owned_dropped_waiter_close_reject_and_quarantine() {
    for panic in [false, true] {
        let f = Fixture::new("anchor").await;
        let tracker = f.store.inner.hooks.track_reads();
        let handle = f.handle.clone();
        let after = watermark(&f, 1);
        if panic {
            f.store
                .inner
                .hooks
                .arm(Point::ConversationHeadCaptured, Action::Panic);
            assert!(
                matches!(handle.conversation_changes(after.clone()).await, Err(ConversationError::Storage(error)) if error.kind()==StorageErrorKind::Io)
            );
            let prefix = tracker.watermark();
            assert_eq!(
                tracker.wait_through(&prefix).await,
                Err(WaitError::Unsuccessful(prefix.clone()))
            );
            assert_eq!(
                f.store.close().await.unwrap_err().kind(),
                StorageErrorKind::Io
            );
        } else {
            let pause = Arc::new(Pause::default());
            f.store.inner.hooks.arm(
                Point::ConversationHeadCaptured,
                Action::Pause(pause.clone()),
            );
            let reader = handle.clone();
            let position = after.clone();
            let read = tokio::spawn(async move { reader.conversation_changes(position).await });
            pause.reached.notified().await;
            let prefix = tracker.watermark();
            let mut retired = Box::pin(tracker.wait_through(&prefix));
            assert!(futures_util::poll!(&mut retired).is_pending());
            read.abort();
            assert!(read.await.err().unwrap().is_cancelled());
            assert!(futures_util::poll!(&mut retired).is_pending());
            let close = tokio::spawn(async move { f.store.close().await });
            tokio::task::yield_now().await;
            assert!(!close.is_finished());
            pause.release.notify_one();
            retired.await.unwrap();
            close.await.unwrap().unwrap();
        }
        let prefix = tracker.watermark();
        assert!(
            matches!(handle.conversation_changes(after).await, Err(ConversationError::Storage(error)) if error.kind()==StorageErrorKind::Closed)
        );
        assert_eq!(tracker.watermark(), prefix);
    }
}

#[tokio::test]
async fn c60_admission_precedes_maintenance_and_unpolled_rejected_and_unrelated_allocate_none() {
    let f = Fixture::new("anchor").await;
    // Disabled tracking must not retain reads performed before opt-in.
    f.handle
        .conversation_changes(watermark(&f, 1))
        .await
        .unwrap();
    let tracker = f.store.inner.hooks.track_reads();
    let empty = tracker.watermark();
    let unpolled = f.handle.conversation_changes(watermark(&f, 1));
    drop(unpolled);
    assert_eq!(tracker.watermark(), empty);
    let maintenance = f.store.inner.maintenance.write().await;
    let pause = Arc::new(Pause::default());
    f.store
        .inner
        .hooks
        .arm(Point::Open, Action::Pause(pause.clone()));
    let mut read = Box::pin(f.handle.conversation_changes(watermark(&f, 1)));
    assert!(futures_util::poll!(&mut read).is_pending());
    let admitted = tracker.watermark();
    assert!(admitted.newer_than(&empty));
    let mut reached = Box::pin(pause.reached.notified());
    assert!(futures_util::poll!(&mut reached).is_pending());
    let mut retired = Box::pin(tracker.wait_through(&admitted));
    assert!(futures_util::poll!(&mut retired).is_pending());
    drop(maintenance);
    reached.await;
    assert!(futures_util::poll!(&mut retired).is_pending());
    pause.release.notify_one();
    read.await.unwrap();
    f.store.list_sessions(None, 2).await.unwrap();
    assert_eq!(tracker.watermark(), admitted);
    retired.await.unwrap();
    assert_eq!(tracker.open_failure(), OpenFailure::NotConsumed);
    f.store.close().await.unwrap();
    assert!(
        f.handle
            .conversation_changes(watermark(&f, 1))
            .await
            .is_err()
    );
    assert_eq!(tracker.watermark(), admitted);
}

#[tokio::test]
async fn c60_old_first_open_dropped_waiter_can_consume_new_failure_on_second_open() {
    let f = Fixture::new("anchor").await;
    let tracker = f.store.inner.hooks.track_reads();
    let pause = Arc::new(Pause::default());
    f.store
        .inner
        .hooks
        .arm(Point::Open, Action::Pause(pause.clone()));
    let mut read = Box::pin(f.handle.conversation_changes(watermark(&f, 1)));
    assert!(futures_util::poll!(&mut read).is_pending());
    pause.reached.notified().await;
    let old = tracker.watermark();
    drop(read);
    let mut retired = Box::pin(tracker.wait_through(&old));
    assert!(futures_util::poll!(&mut retired).is_pending());
    f.store
        .inner
        .hooks
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    assert_eq!(tracker.open_failure(), OpenFailure::NotConsumed);
    pause.release.notify_one();
    retired.await.unwrap();
    assert_eq!(tracker.open_failure(), OpenFailure::Tracked(old));
    // The first catalog connection closed before the second, failing session open.
    let (admitted, opened, closed, _) = f.store.inner.lifecycle.gauge();
    assert_eq!(admitted, 0);
    assert_eq!(opened, closed);
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn c60_retirement_before_arming_attributes_failure_to_newer_read() {
    let f = Fixture::new("anchor").await;
    let tracker = f.store.inner.hooks.track_reads();
    let pause = Arc::new(Pause::default());
    f.store
        .inner
        .hooks
        .arm(Point::Open, Action::Pause(pause.clone()));
    let mut read = Box::pin(f.handle.conversation_changes(watermark(&f, 1)));
    assert!(futures_util::poll!(&mut read).is_pending());
    pause.reached.notified().await;
    let old = tracker.watermark();
    drop(read);
    pause.release.notify_one();
    tracker.wait_through(&old).await.unwrap();
    f.store
        .inner
        .hooks
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    assert_eq!(tracker.open_failure(), OpenFailure::NotConsumed);
    assert!(
        matches!(f.handle.conversation_changes(watermark(&f, 1)).await,
        Err(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Io)
    );
    let OpenFailure::Tracked(recipient) = tracker.open_failure() else {
        panic!("tracked read must consume Open failure")
    };
    assert!(recipient.newer_than(&old));
    tracker.wait_through(&recipient).await.unwrap();
    // The failure remains one-shot; the next real read succeeds.
    f.handle
        .conversation_changes(watermark(&f, 1))
        .await
        .unwrap();
    assert_eq!(tracker.open_failure(), OpenFailure::Tracked(recipient));
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn c60_out_of_order_finite_prefix_ignores_later_pending_and_wrong_store() {
    let f = Fixture::new("anchor").await;
    let other = Fixture::new("other store").await;
    let tracker = f.store.inner.hooks.track_reads();
    let other_tracker = other.store.inner.hooks.track_reads();
    let created = f
        .store
        .create_session(
            CreateSession::new(OperationId::new(), "second session".into(), None).unwrap(),
        )
        .await
        .unwrap();
    let second = f
        .store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let page = second
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    let after = page.live_after().unwrap().clone();
    let pause = Arc::new(Pause::default());
    f.store.inner.hooks.arm(
        Point::ConversationHeadCaptured,
        Action::Pause(pause.clone()),
    );
    let mut first = Box::pin(f.handle.conversation_changes(watermark(&f, 1)));
    assert!(futures_util::poll!(&mut first).is_pending());
    pause.reached.notified().await;
    let prefix = tracker.watermark();
    other
        .handle
        .conversation_changes(watermark(&other, 1))
        .await
        .unwrap();
    let foreign = other_tracker.watermark();
    assert!(!foreign.newer_than(&prefix));
    assert_eq!(
        tracker.wait_through(&foreign).await,
        Err(WaitError::WrongStore)
    );
    let mut wait_a = Box::pin(tracker.wait_through(&prefix));
    let mut wait_b = Box::pin(tracker.wait_through(&prefix));
    assert!(futures_util::poll!(&mut wait_a).is_pending());
    assert!(futures_util::poll!(&mut wait_b).is_pending());
    second.conversation_changes(after.clone()).await.unwrap();
    assert!(tracker.watermark().newer_than(&prefix));
    assert!(futures_util::poll!(&mut wait_a).is_pending());
    f.store.list_sessions(None, 2).await.unwrap();
    assert!(futures_util::poll!(&mut wait_b).is_pending());
    let later_pause = Arc::new(Pause::default());
    f.store
        .inner
        .hooks
        .arm(Point::Open, Action::Pause(later_pause.clone()));
    let mut later = Box::pin(second.conversation_changes(after));
    assert!(futures_util::poll!(&mut later).is_pending());
    later_pause.reached.notified().await;
    let later_prefix = tracker.watermark();
    pause.release.notify_one();
    first.await.unwrap();
    wait_a.await.unwrap();
    wait_b.await.unwrap();
    // Completion before registration is also safe, despite a later read staying paused.
    tracker.wait_through(&prefix).await.unwrap();
    let mut all = Box::pin(tracker.wait_through(&later_prefix));
    assert!(futures_util::poll!(&mut all).is_pending());
    later_pause.release.notify_one();
    later.await.unwrap();
    all.await.unwrap();
    other.store.close().await.unwrap();
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn c60_concurrent_read_completions_wake_multiple_registered_waiters() {
    let f = Fixture::new("anchor").await;
    let created = f
        .store
        .create_session(
            CreateSession::new(OperationId::new(), "second session".into(), None).unwrap(),
        )
        .await
        .unwrap();
    let second = f
        .store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let page = second
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    let after = page.live_after().unwrap().clone();
    let tracker = f.store.inner.hooks.track_reads();
    let first_pause = Arc::new(Pause::default());
    f.store.inner.hooks.arm(
        Point::ConversationHeadCaptured,
        Action::Pause(first_pause.clone()),
    );
    let mut first = Box::pin(f.handle.conversation_changes(watermark(&f, 1)));
    assert!(futures_util::poll!(&mut first).is_pending());
    first_pause.reached.notified().await;
    let second_pause = Arc::new(Pause::default());
    f.store.inner.hooks.arm(
        Point::ConversationHeadCaptured,
        Action::Pause(second_pause.clone()),
    );
    let mut second_read = Box::pin(second.conversation_changes(after));
    assert!(futures_util::poll!(&mut second_read).is_pending());
    second_pause.reached.notified().await;
    let prefix = tracker.watermark();
    let mut wait_a = Box::pin(tracker.wait_through(&prefix));
    let mut wait_b = Box::pin(tracker.wait_through(&prefix));
    assert!(futures_util::poll!(&mut wait_a).is_pending());
    assert!(futures_util::poll!(&mut wait_b).is_pending());
    first_pause.release.notify_one();
    second_pause.release.notify_one();
    let (a, b, read_a, read_b) = tokio::join!(wait_a, wait_b, first, second_read);
    a.unwrap();
    b.unwrap();
    read_a.unwrap();
    read_b.unwrap();
    tracker.wait_through(&prefix).await.unwrap();
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b3_read_open_failures_remain_storage_errors() {
    for point in [Point::ConversationHeadCaptured, Point::Open] {
        let f = Fixture::new("anchor").await;
        f.store
            .inner
            .hooks
            .arm(point, Action::Fail(StorageErrorKind::Io));
        assert!(
            matches!(f.handle.conversation_changes(watermark(&f, 1)).await, Err(ConversationError::Storage(error)) if error.kind()==StorageErrorKind::Io)
        );
        let batch = f
            .handle
            .conversation_changes(watermark(&f, 1))
            .await
            .unwrap();
        bounded(&batch);
        f.store.close().await.unwrap();
    }
}
