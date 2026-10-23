use super::*;
use crate::storage::test_hooks::{Action, Pause, Point};
use std::sync::Arc;

#[tokio::test]
async fn a5b1_snapshot_read_sees_only_committed_projection_and_head() {
    let f = Fixture::new("anchor").await;
    let pause = Arc::new(Pause::default());
    f.store.inner.hooks.arm(
        Point::ConversationHeadCaptured,
        Action::Pause(pause.clone()),
    );
    let handle = f.handle.clone();
    let run = f.run.clone();
    let read = tokio::spawn(async move {
        handle
            .conversation_entry(run, "e:2:0".parse().unwrap())
            .await
            .unwrap()
    });
    pause.reached.notified().await;
    // An independent writer commits after the read snapshot was captured.
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
    assert_eq!(page.entry().fields()[0].text(), "anchor");
    assert_eq!(f.entry("e:2:0").await.snapshot_head(), 3);
    let (admitted, opened, closed, closing) = f.store.inner.lifecycle.gauge();
    assert_eq!(admitted, 0);
    assert_eq!(opened, closed);
    assert!(!closing);
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b1_dropped_waiter_keeps_owned_sql_and_close_waits_for_retirement() {
    let f = Fixture::new("anchor").await;
    let pause = Arc::new(Pause::default());
    f.store.inner.hooks.arm(
        Point::ConversationHeadCaptured,
        Action::Pause(pause.clone()),
    );
    let handle = f.handle.clone();
    let run = f.run.clone();
    let read = tokio::spawn(async move {
        handle
            .conversation_entry(run, "e:2:0".parse().unwrap())
            .await
    });
    pause.reached.notified().await;
    read.abort();
    assert!(read.await.err().unwrap().is_cancelled());
    let handle = f.handle.clone();
    let run = f.run.clone();
    let close = tokio::spawn(async move { f.store.close().await });
    tokio::task::yield_now().await;
    assert!(!close.is_finished());
    pause.release.notify_one();
    close.await.unwrap().unwrap();
    let error = handle
        .conversation_entry(run, "e:2:0".parse().unwrap())
        .await
        .err()
        .unwrap();
    assert!(
        matches!(error, ConversationError::Storage(error) if error.kind() == StorageErrorKind::Closed)
    );
}

#[tokio::test]
async fn a5b1_read_failure_and_open_failure_keep_storage_error_classification() {
    for point in [Point::ConversationHeadCaptured, Point::Open] {
        let f = Fixture::new("anchor").await;
        f.store
            .inner
            .hooks
            .arm(point, Action::Fail(StorageErrorKind::Io));
        let error = f
            .handle
            .conversation_entry(f.run.clone(), "e:2:0".parse().unwrap())
            .await
            .err()
            .unwrap();
        assert!(
            matches!(error, ConversationError::Storage(error) if error.kind() == StorageErrorKind::Io)
        );
        assert_eq!(f.entry("e:2:0").await.entry().fields()[0].text(), "anchor");
        f.store.close().await.unwrap();
    }
}
