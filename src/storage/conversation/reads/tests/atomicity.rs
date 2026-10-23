use super::*;
use crate::storage::{
    RecordedRunState, identifier_tests,
    test_hooks::{Action, Pause, Point},
};
use std::sync::Arc;

#[tokio::test]
async fn a5b1_actual_canonical_transaction_exposes_no_uncommitted_head_or_state() {
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
        let operation = OperationId::new();
        let write_op = operation.clone();
        disk_snapshot(&f.path, rollback, "before_writer");
        let writer = tokio::spawn(async move {
            let record = identifier_tests::runtime(&run, 1, RunEvent::RunStarted);
            handle.append_run_records(write_op, run, vec![record]).await
        });
        pause.reached.notified().await;
        disk_snapshot(&f.path, rollback, "display_applied_uncommitted");
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
            Address::Entry(f.run.clone(), "e:2:0".parse().unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(page.snapshot_head(), 2);
        assert_eq!(page.block().state(), RecordedRunState::Accepted);
        sql.close().await.unwrap();
        pause.release.notify_one();
        let result = writer.await.unwrap();
        disk_snapshot(&f.path, rollback, "after_writer_result");
        let page = f.entry("e:2:0").await;
        if rollback {
            assert_eq!(result.unwrap_err().code(), "storage.io");
            assert_eq!(page.snapshot_head(), 2);
            assert_eq!(page.block().state(), RecordedRunState::Accepted);
            assert!(f.handle.lookup_receipt(operation).await.unwrap().is_none());
        } else {
            result.unwrap();
            assert_eq!(page.snapshot_head(), 3);
            assert_eq!(page.block().state(), RecordedRunState::Running);
            assert!(f.handle.lookup_receipt(operation).await.unwrap().is_some());
        }
        f.store.close().await.unwrap();
    }
}

fn disk_snapshot(path: &std::path::Path, rollback: bool, stage: &str) {
    // The paused writer keeps its real transaction open; metadata reads do not checkpoint it.
    for (file, suffix) in [
        ("database", ""),
        ("wal", "-wal"),
        ("shm", "-shm"),
        ("journal", "-journal"),
    ] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        let (present, logical_bytes) = match std::fs::metadata(std::path::PathBuf::from(name)) {
            Ok(metadata) => (true, metadata.len()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (false, 0),
            Err(_) => panic!("synthetic atomicity disk snapshot failed"),
        };
        println!(
            "g11 atomicity_disk rollback={rollback} stage={stage} file={file} present={present} logical_bytes={logical_bytes}",
        );
    }
}

#[tokio::test]
async fn a5b1_owned_read_unwind_quarantines_and_retains_static_storage_error() {
    let f = Fixture::new("anchor").await;
    f.store
        .inner
        .hooks
        .arm(Point::ConversationHeadCaptured, Action::Panic);
    let error = f
        .handle
        .conversation_entry(f.run.clone(), "e:2:0".parse().unwrap())
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
    let error = f
        .handle
        .conversation_entry(f.run.clone(), "e:2:0".parse().unwrap())
        .await
        .err()
        .unwrap();
    assert!(
        matches!(error, ConversationError::Storage(error) if error.kind() == StorageErrorKind::Closed)
    );
}
