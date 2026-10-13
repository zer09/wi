use super::*;
use crate::storage::test_hooks::{Action, Pause, Point};
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
            read.abort();
            assert!(read.await.err().unwrap().is_cancelled());
            let close = tokio::spawn(async move { f.store.close().await });
            tokio::task::yield_now().await;
            assert!(!close.is_finished());
            pause.release.notify_one();
            close.await.unwrap().unwrap();
        }
        assert!(
            matches!(handle.conversation_changes(after).await, Err(ConversationError::Storage(error)) if error.kind()==StorageErrorKind::Closed)
        );
    }
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
