use super::*;
use crate::storage::test_hooks::{Action, Pause, Point};
use std::sync::Arc;

#[tokio::test]
async fn a5b2_snapshot_head_manifest_block_and_live_cursor_match() {
    let f = Fixture::new("anchor").await;
    let pause = Arc::new(Pause::default());
    f.store.inner.hooks.arm(
        Point::ConversationHeadCaptured,
        Action::Pause(pause.clone()),
    );
    let handle = f.handle.clone();
    let read = tokio::spawn(async move {
        handle
            .conversation_page(ConversationQuery::Latest)
            .await
            .unwrap()
    });
    pause.reached.notified().await;
    let mut sql = f.sql().await;
    let provenance: String = sqlx::query_scalar("SELECT creation_provenance_json FROM manifest")
        .fetch_one(&mut sql)
        .await
        .unwrap();
    let provenance = serde_json::from_str(&provenance).unwrap();
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
    let page = read.await.unwrap();
    assert_eq!(page.snapshot_head(), 2);
    assert_eq!(page.session().head_sequence(), 2);
    assert_eq!(page.session().title(), "synthetic");
    assert_eq!(page.block().unwrap().revision(), 2);
    assert_eq!(page.live_after().unwrap().sequence(), 2);
    assert_eq!(page.live_after().unwrap().rank(), 3);
    bounded_page(&page);
    let after = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    assert_eq!(after.snapshot_head(), 3);
    assert_eq!(after.session().title(), "later title");
    let (admitted, opened, retired, closing) = f.store.inner.lifecycle.gauge();
    assert_eq!(admitted, 0);
    assert_eq!(opened, retired);
    assert!(!closing);
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b2_page_dropped_waiter_close_and_quarantine() {
    for panic in [false, true] {
        let f = Fixture::new("anchor").await;
        let handle = f.handle.clone();
        if panic {
            f.store
                .inner
                .hooks
                .arm(Point::ConversationHeadCaptured, Action::Panic);
            let error = handle
                .conversation_page(ConversationQuery::Latest)
                .await
                .err()
                .unwrap();
            assert!(
                matches!(error, ConversationError::Storage(error) if error.kind() == StorageErrorKind::Io)
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
            let read =
                tokio::spawn(
                    async move { reader.conversation_page(ConversationQuery::Latest).await },
                );
            pause.reached.notified().await;
            read.abort();
            assert!(read.await.err().unwrap().is_cancelled());
            let close = tokio::spawn(async move { f.store.close().await });
            tokio::task::yield_now().await;
            assert!(!close.is_finished());
            pause.release.notify_one();
            close.await.unwrap().unwrap();
        }
        let error = handle
            .conversation_page(ConversationQuery::Latest)
            .await
            .err()
            .unwrap();
        assert!(
            matches!(error, ConversationError::Storage(error) if error.kind() == StorageErrorKind::Closed)
        );
    }
}

#[tokio::test]
async fn a5b2_actual_commit_interleavings_do_not_expose_uncommitted_projection() {
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
        let handle = f.handle.clone();
        let run = f.run.clone();
        let writer = tokio::spawn(async move {
            let record = crate::storage::identifier_tests::runtime(&run, 1, RunEvent::RunStarted);
            handle
                .append_run_records(OperationId::new(), run, vec![record])
                .await
        });
        pause.reached.notified().await;
        let mut sql = f.sql().await;
        let provenance: String =
            sqlx::query_scalar("SELECT creation_provenance_json FROM manifest")
                .fetch_one(&mut sql)
                .await
                .unwrap();
        let provenance = serde_json::from_str(&provenance).unwrap();
        let page = read(
            &mut sql,
            f.handle.session_id(),
            &provenance,
            ConversationQuery::Latest,
        )
        .await
        .unwrap();
        assert_eq!(page.snapshot_head(), 2);
        assert_eq!(page.live_after().unwrap().sequence(), 2);
        assert_eq!(
            page.block().unwrap().state(),
            crate::storage::RecordedRunState::Accepted
        );
        sql.close().await.unwrap();
        pause.release.notify_one();
        let written = writer.await.unwrap();
        let after = f
            .handle
            .conversation_page(ConversationQuery::Latest)
            .await
            .unwrap();
        if rollback {
            assert_eq!(written.unwrap_err().kind(), StorageErrorKind::Io);
            assert_eq!(after.snapshot_head(), 2);
            assert_eq!(
                after.block().unwrap().state(),
                crate::storage::RecordedRunState::Accepted
            );
        } else {
            written.unwrap();
            assert_eq!(after.snapshot_head(), 3);
            assert_eq!(after.live_after().unwrap().sequence(), 3);
            assert_eq!(
                after.block().unwrap().state(),
                crate::storage::RecordedRunState::Running
            );
        }
        f.store.close().await.unwrap();
    }
}
