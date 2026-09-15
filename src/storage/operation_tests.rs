use super::{catalog_ops::CreationState, session::RenameFault, *};
use sqlx::{Connection, Row};

fn input() -> CreateSession {
    CreateSession::new(OperationId::new(), "original-canary".into(), None).unwrap()
}

async fn accepted_creation_retry_ignores_availability(
    availability: SessionAvailability,
    fault_code: Option<&str>,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let mut store = SessionStore::open(root.clone()).await.unwrap();
    let input = input();
    let created = store.create_session(input.clone()).await.unwrap();
    assert!(!created.duplicate());
    let path = filesystem::session_path(&root, created.session_id(), false).unwrap();
    let saved = path.with_extension("saved");
    let original_bytes = std::fs::read(&path).unwrap();
    std::fs::rename(&path, &saved).unwrap();
    if availability == SessionAvailability::Unavailable {
        // A directory in place of the database makes even path validation fail.
        std::fs::create_dir(&path).unwrap();
    }
    let guard = store.inner.lifecycle.admit().unwrap();
    let mut connection =
        database::open(&root.join("catalog.sqlite3"), false, &store.inner.lifecycle)
            .await
            .unwrap();
    sqlx::query("UPDATE sessions SET availability=?, fault_code=? WHERE session_id=?")
        .bind(
            serde_json::to_value(availability)
                .unwrap()
                .as_str()
                .unwrap(),
        )
        .bind(fault_code)
        .bind(created.session_id().as_str())
        .execute(&mut connection)
        .await
        .unwrap();
    database::close(connection, &store.inner.lifecycle)
        .await
        .unwrap();
    guard.finish();

    let workspace = temp.path().join("never-created-workspace");
    for restart in [false, true] {
        if restart {
            store.close().await.unwrap();
            store = SessionStore::open(root.clone()).await.unwrap();
        }
        // Accepted receipts must not wait for session ownership or touch its database.
        let lock = store.inner.session_lock(created.session_id()).await;
        let retry = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            store.create_session(input.clone()),
        )
        .await
        .expect("accepted retry waited for session ownership")
        .unwrap();
        drop(lock);
        assert!(retry.duplicate());
        assert_eq!(retry.session_id(), created.session_id());
        assert_eq!(retry.receipt(), created.receipt());
        assert_eq!(retry.cleanup_warning(), None);
        for changed in [
            CreateSession::new(input.operation_id().clone(), "changed-title".into(), None).unwrap(),
            CreateSession::new(
                input.operation_id().clone(),
                input.title().into(),
                Some(workspace.to_str().unwrap().to_owned()),
            )
            .unwrap(),
        ] {
            let error = store.create_session(changed).await.unwrap_err();
            assert_eq!(error.code(), "storage.command_conflict");
            assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
        }
        let error = store
            .open_session(created.session_id().clone())
            .await
            .unwrap_err();
        let expected_error = if availability == SessionAvailability::Missing {
            "storage.not_found"
        } else {
            "storage.unavailable"
        };
        assert_eq!(error.code(), expected_error);
        let page = store.list_sessions(None, 2).await.unwrap();
        assert_eq!(page.sessions().len(), 1);
        assert_eq!(page.sessions()[0].session_id(), created.session_id());
        assert_eq!(page.sessions()[0].availability(), availability);
        assert_eq!(page.sessions()[0].fault_code(), fault_code);
        assert_eq!(page.sessions()[0].title(), input.title());
        assert_eq!(page.sessions()[0].observed_head_sequence(), 1);
        if availability == SessionAvailability::Missing {
            assert!(!path.exists());
        } else {
            assert!(path.is_dir());
            assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);
        }
        assert_eq!(std::fs::read(&saved).unwrap(), original_bytes);
        assert!(!path.with_file_name("session.sqlite3-wal").exists());
        assert!(!path.with_file_name("session.sqlite3-shm").exists());
        assert!(!workspace.exists());
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn storage_accepted_creation_retry_ignores_missing_session() {
    accepted_creation_retry_ignores_availability(
        SessionAvailability::Missing,
        Some("storage.not_found"),
    )
    .await;
}

#[tokio::test]
async fn storage_accepted_creation_retry_ignores_unavailable_session() {
    for fault_code in [None, Some("storage.integrity")] {
        accepted_creation_retry_ignores_availability(SessionAvailability::Unavailable, fault_code)
            .await;
    }
}

#[tokio::test]
async fn storage_reservations_recover_missing_zero_length_empty_and_postcommit_evidence() {
    for stage in 0..4 {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let store = SessionStore::open(root.clone()).await.unwrap();
        let input = input();
        let guard = store.inner.lifecycle.admit().unwrap();
        let (reserved, duplicate) = catalog_ops::reserve(&store.inner, &input).await.unwrap();
        assert!(!duplicate);
        let provenance = reserved.provenance;
        if stage == 1 || stage == 2 {
            let path = filesystem::session_path(&root, &provenance.session_id, true).unwrap();
            drop(filesystem::open_file(&path, true).unwrap());
            if stage == 2 {
                let mut connection = database::open(&path, false, &store.inner.lifecycle)
                    .await
                    .unwrap();
                sqlx::query("PRAGMA user_version=0")
                    .execute(&mut connection)
                    .await
                    .unwrap();
                assert!(session_schema::empty(&mut connection).await.unwrap());
                database::close(connection, &store.inner.lifecycle)
                    .await
                    .unwrap();
            }
        }
        if stage == 3 {
            creation::materialize(&store.inner, &provenance)
                .await
                .unwrap();
        }
        guard.finish();
        store.close().await.unwrap();
        let store = SessionStore::open(root.clone()).await.unwrap();
        // Selecting a known creating ID also reconciles without allocating a new identity.
        let handle = store
            .open_session(provenance.session_id.clone())
            .await
            .unwrap();
        let created = store.create_session(input).await.unwrap();
        assert!(created.duplicate());
        assert_eq!(created.receipt(), &provenance.receipt);
        assert_eq!(handle.manifest().await.unwrap().head_sequence(), 1);
        let guard = store.inner.lifecycle.admit().unwrap();
        let entry = catalog_ops::entry(&store.inner, &provenance.session_id)
            .await
            .unwrap();
        assert!(entry.reservation.state == CreationState::Accepted);
        assert_eq!(entry.reservation.provenance, provenance);
        guard.finish();
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn storage_invalid_partial_reservations_fail_once_without_overwriting_files() {
    for statement in [
        "CREATE TABLE foreign_history(value TEXT)",
        "PRAGMA application_id=17",
        "PRAGMA application_id=1464423233; PRAGMA user_version=2",
        "PRAGMA application_id=1464423233; PRAGMA user_version=1; CREATE TABLE manifest(value TEXT)",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let store = SessionStore::open(root.clone()).await.unwrap();
        let input = input();
        let guard = store.inner.lifecycle.admit().unwrap();
        let (reserved, _) = catalog_ops::reserve(&store.inner, &input).await.unwrap();
        let path = filesystem::session_path(&root, &reserved.provenance.session_id, true).unwrap();
        drop(filesystem::open_file(&path, true).unwrap());
        let mut connection = database::open(&path, false, &store.inner.lifecycle)
            .await
            .unwrap();
        sqlx::raw_sql(statement)
            .execute(&mut connection)
            .await
            .unwrap();
        database::close(connection, &store.inner.lifecycle)
            .await
            .unwrap();
        guard.finish();
        let before = std::fs::read(&path).unwrap();
        let error = store.create_session(input.clone()).await.unwrap_err();
        assert!(matches!(
            error.kind(),
            StorageErrorKind::Integrity | StorageErrorKind::UnsupportedVersion
        ));
        assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
        let retry = store.create_session(input.clone()).await.unwrap_err();
        assert_eq!(retry, error);
        let page = store.list_sessions(None, 2).await.unwrap();
        assert_eq!(
            page.sessions()[0].availability(),
            SessionAvailability::Unavailable
        );
        assert_eq!(page.sessions()[0].fault_code(), Some(error.code()));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        store.close().await.unwrap();
        let store = SessionStore::open(root).await.unwrap();
        assert_eq!(store.create_session(input).await.unwrap_err(), error);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn storage_creation_operational_busy_retains_reservation_and_reconciles() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let store = SessionStore::open(root.clone()).await.unwrap();
    let input = input();
    let guard = store.inner.lifecycle.admit().unwrap();
    let (reserved, _) = catalog_ops::reserve(&store.inner, &input).await.unwrap();
    let path = filesystem::session_path(&root, &reserved.provenance.session_id, true).unwrap();
    drop(filesystem::open_file(&path, true).unwrap());
    let mut connection = database::open(&path, false, &store.inner.lifecycle)
        .await
        .unwrap();
    let transaction = connection.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let error = store.create_session(input.clone()).await.unwrap_err();
    assert_eq!(error.code(), "storage.creation_incomplete");
    assert_eq!(error.certainty(), CommitCertainty::Unknown);
    let entry = catalog_ops::entry(&store.inner, &reserved.provenance.session_id)
        .await
        .unwrap();
    assert!(entry.reservation.state == CreationState::Creating);
    assert_eq!(entry.reservation.provenance, reserved.provenance);
    transaction.rollback().await.unwrap();
    database::close(connection, &store.inner.lifecycle)
        .await
        .unwrap();
    guard.finish();
    assert_eq!(
        store.create_session(input).await.unwrap().receipt(),
        &reserved.provenance.receipt
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn storage_rename_rolls_back_events_manifest_and_receipt_at_both_precommit_stages() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let created = store.create_session(input()).await.unwrap();
    let handle = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let guard = store.inner.lifecycle.admit().unwrap();
    let (mut connection, provenance) =
        session::connection(&store.inner, created.session_id(), true)
            .await
            .unwrap();
    for fault in [RenameFault::AfterEvent, RenameFault::AfterManifest] {
        let operation = OperationId::new();
        let error = session::rename_transaction(
            &mut connection,
            &provenance,
            &operation,
            "changed",
            Some(fault),
        )
        .await
        .unwrap_err();
        assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
        let row = sqlx::query("SELECT (SELECT count(*) FROM events), (SELECT count(*) FROM commands), head_sequence, title FROM manifest")
            .fetch_one(&mut connection).await.unwrap();
        assert_eq!(row.try_get::<i64, _>(0).unwrap(), 1);
        assert_eq!(row.try_get::<i64, _>(1).unwrap(), 0);
        assert_eq!(row.try_get::<i64, _>(2).unwrap(), 1);
        assert_eq!(row.try_get::<String, _>(3).unwrap(), "original-canary");
    }
    database::close(connection, &store.inner.lifecycle)
        .await
        .unwrap();
    guard.finish();
    let operation = OperationId::new();
    let committed = handle
        .rename(operation.clone(), "changed".into())
        .await
        .unwrap();
    assert_eq!(committed.receipt().first_sequence(), 2);
    store.close().await.unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let handle = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    handle
        .rename(OperationId::new(), "later".into())
        .await
        .unwrap();
    assert_eq!(
        handle
            .rename(operation, "changed".into())
            .await
            .unwrap()
            .receipt(),
        committed.receipt()
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn storage_commit_uncertainty_and_postcommit_cleanup_keep_their_distinct_results() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let created = store.create_session(input()).await.unwrap();
    let guard = store.inner.lifecycle.admit().unwrap();
    let (mut connection, provenance) =
        session::connection(&store.inner, created.session_id(), true)
            .await
            .unwrap();
    let operation = OperationId::new();
    let result =
        session::rename_transaction(&mut connection, &provenance, &operation, "committed", None)
            .await;
    let ((receipt, duplicate), warning) =
        database::finish_write(connection, &store.inner.lifecycle, result, true)
            .await
            .unwrap();
    let committed = CommitResult::new(receipt, duplicate, warning);
    assert_eq!(
        committed.cleanup_warning(),
        Some(CleanupWarning::ConnectionCloseFailed)
    );
    assert!(!committed.duplicate());
    let (mut connection, _) = session::connection(&store.inner, created.session_id(), true)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE fault_parent(id INTEGER PRIMARY KEY); CREATE TABLE fault_child(id INTEGER REFERENCES fault_parent(id) DEFERRABLE INITIALLY DEFERRED)")
        .execute(&mut connection).await.unwrap();
    let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::query("INSERT INTO fault_child VALUES(1)")
        .execute(&mut *transaction)
        .await
        .unwrap();
    let uncertain = database::finish_transaction(transaction, Ok(())).await;
    let error = database::finish_write(connection, &store.inner.lifecycle, uncertain, false)
        .await
        .unwrap_err();
    assert_eq!(error.code(), "storage.commit_unknown");
    assert_eq!(error.certainty(), CommitCertainty::Unknown);
    guard.finish();
    let handle = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    assert_eq!(
        handle.lookup_receipt(operation).await.unwrap().as_ref(),
        Some(committed.receipt())
    );
    assert_eq!(handle.manifest().await.unwrap().title(), "committed");
    store.close().await.unwrap();
}

#[tokio::test]
async fn storage_sequence_exhaustion_and_receipt_first_retry_are_not_quotas() {
    assert_eq!(
        session::next_sequence(i64::MAX as u64 - 1).unwrap(),
        i64::MAX
    );
    assert!(session::next_sequence(i64::MAX as u64).is_err());
    assert!(session::next_sequence(u64::MAX).is_err());
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let created = store.create_session(input()).await.unwrap();
    let handle = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let operation = OperationId::new();
    let receipt = handle
        .rename(operation.clone(), "changed".into())
        .await
        .unwrap();
    let guard = store.inner.lifecycle.admit().unwrap();
    let (mut connection, _) = session::connection(&store.inner, created.session_id(), true)
        .await
        .unwrap();
    // Synthetic exhaustion is not a valid gap-free history; ordinary validation checks the
    // indexed head, not a full replay. This isolates the checked allocation boundary.
    sqlx::query("INSERT INTO events(sequence,event_id,event_type,event_version,created_at_ms,payload_json) VALUES(9223372036854775807, ?, 'session.renamed', 1, 99, '{\"title\":\"changed\"}')")
        .bind(StoredEventId::new().as_str()).execute(&mut connection).await.unwrap();
    sqlx::query("UPDATE manifest SET head_sequence=9223372036854775807, updated_at_ms=99")
        .execute(&mut connection)
        .await
        .unwrap();
    database::close(connection, &store.inner.lifecycle)
        .await
        .unwrap();
    guard.finish();
    assert_eq!(
        handle
            .rename(operation, "changed".into())
            .await
            .unwrap()
            .receipt(),
        receipt.receipt()
    );
    let error = handle
        .rename(OperationId::new(), "new".into())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "storage.invalid_input");
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    store.close().await.unwrap();
}
