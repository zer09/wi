use sqlx::{Connection, Row};

use super::*;

async fn create(store: &SessionStore) -> SessionHandle {
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "original".into(), None).unwrap())
        .await
        .unwrap();
    store
        .open_session(created.session_id().clone())
        .await
        .unwrap()
}

async fn reservation_snapshot(connection: &mut sqlx::SqliteConnection) -> Vec<String> {
    let mut snapshot = Vec::new();
    for query in [
        "SELECT json_group_array(json_array(session_id, relative_path, title, workspace_json, created_at_ms, updated_at_ms, head_sequence, schema_version, availability, fault_code, last_run_id, last_run_state, seen_repair_id)) FROM (SELECT * FROM sessions ORDER BY session_id)",
        "SELECT json_group_array(json_array(command_id, hex(payload_hash), request_json, session_id, creation_event_id, created_at_ms, state, receipt_json, failure_code)) FROM (SELECT * FROM creation_commands ORDER BY command_id)",
    ] {
        snapshot.push(
            sqlx::query(query)
                .fetch_one(&mut *connection)
                .await
                .unwrap()
                .try_get(0)
                .unwrap(),
        );
    }
    snapshot
}

#[tokio::test]
async fn repair_integrity_paired_creating_reservations_fail_closed() {
    let mutations = [
        "UPDATE creation_commands SET command_id='00000000-0000-0000-0000-000000000000'",
        "UPDATE creation_commands SET command_id='AB123456-789A-4BCD-8ABC-0123456789AB'",
        "UPDATE sessions SET session_id=''; UPDATE creation_commands SET session_id=''",
        "UPDATE creation_commands SET creation_event_id='not-an-event-id'",
        "UPDATE creation_commands SET creation_event_id='AB123456-789A-4BCD-8ABC-0123456789AB'",
        "UPDATE creation_commands SET created_at_ms=-1",
        "UPDATE creation_commands SET created_at_ms=created_at_ms+1",
        "UPDATE creation_commands SET request_json='{'",
        "UPDATE creation_commands SET request_json='{}'",
        "UPDATE creation_commands SET request_json=json_set(request_json,'$.method','rename')",
        "UPDATE creation_commands SET request_json=json_set(request_json,'$.workspace','relative')",
        "UPDATE creation_commands SET request_json=json_set(request_json,'$.extra',1)",
        "UPDATE creation_commands SET request_json=' ' || request_json",
        "UPDATE creation_commands SET payload_hash=zeroblob(32)",
        "UPDATE creation_commands SET receipt_json='{}'",
        "UPDATE creation_commands SET failure_code='storage.integrity'",
        "UPDATE sessions SET relative_path='sessions/wrong/session.sqlite3'",
        "UPDATE sessions SET title='wrong'",
        "UPDATE sessions SET workspace_json='null'",
        "UPDATE sessions SET workspace_json='\"relative\"'",
        "UPDATE sessions SET workspace_json='\"/different-synthetic-workspace\"'",
        "UPDATE sessions SET created_at_ms=-1",
        "UPDATE sessions SET created_at_ms=created_at_ms+1",
        "UPDATE sessions SET updated_at_ms=-1",
        "UPDATE sessions SET updated_at_ms=updated_at_ms+1",
        "UPDATE sessions SET head_sequence=1",
        "UPDATE sessions SET schema_version=2",
        "UPDATE sessions SET fault_code='storage.integrity'",
        "UPDATE sessions SET seen_repair_id='invalid'",
        "UPDATE sessions SET last_run_id='not-a-run'",
        "UPDATE sessions SET last_run_state='running'",
        "UPDATE sessions SET last_run_id='ab123456-789a-4bcd-8abc-0123456789ab', last_run_state='accepted'",
    ];
    let mut missed = Vec::new();
    for mutation in mutations {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let store = SessionStore::open(root.clone()).await.unwrap();
        let input = CreateSession::new(OperationId::new(), "reserved".into(), None).unwrap();
        let guard = store.inner.lifecycle.admit().unwrap();
        let (reservation, _) = catalog_ops::reserve(&store.inner, &input).await.unwrap();
        let mut connection = catalog_ops::connect(&store.inner, true).await.unwrap();
        sqlx::raw_sql(mutation)
            .execute(&mut connection)
            .await
            .unwrap();
        // Rehash altered requests so structural validation, not only hash equality, is exercised.
        if mutation.contains("request_json=") {
            let request: String = sqlx::query("SELECT request_json FROM creation_commands")
                .fetch_one(&mut connection)
                .await
                .unwrap()
                .try_get(0)
                .unwrap();
            sqlx::query("UPDATE creation_commands SET payload_hash=?")
                .bind(dto::hash(&request).as_slice())
                .execute(&mut connection)
                .await
                .unwrap();
        }
        // This unrelated absent row must not be changed by a failed finish transaction.
        sqlx::query("INSERT INTO sessions (session_id, relative_path, title, created_at_ms, updated_at_ms, head_sequence, schema_version, availability) VALUES ('ab123456-789a-4bcd-8abc-0123456789ab', 'sessions/ab/ab123456-789a-4bcd-8abc-0123456789ab/session.sqlite3', 'absent', 0, 0, 1, 1, 'ready')")
            .execute(&mut connection).await.unwrap();
        let before = reservation_snapshot(&mut connection).await;
        database::close(connection, &store.inner.lifecycle)
            .await
            .unwrap();
        guard.finish();
        for _ in 0..2 {
            let result = store.repair_catalog().await;
            if !matches!(result, Err(error) if error.code() == "storage.integrity") {
                missed.push(mutation);
                break;
            }
            assert_eq!(
                store.list_sessions(None, 10).await.unwrap_err().code(),
                "storage.catalog_repair_required"
            );
            assert_eq!(
                store
                    .create_session(input.clone())
                    .await
                    .unwrap_err()
                    .code(),
                "storage.catalog_repair_required"
            );
            let guard = store.inner.lifecycle.admit().unwrap();
            let mut connection = catalog_ops::connect_maintenance(&store.inner)
                .await
                .unwrap();
            assert_eq!(
                reservation_snapshot(&mut connection).await,
                before,
                "{mutation}"
            );
            let intent: i64 = sqlx::query("SELECT repair_required FROM catalog_meta")
                .fetch_one(&mut connection)
                .await
                .unwrap()
                .try_get(0)
                .unwrap();
            assert_eq!(intent, 1, "{mutation}");
            database::close(connection, &store.inner.lifecycle)
                .await
                .unwrap();
            guard.finish();
            assert!(
                !root
                    .join(filesystem::session_relative_path(
                        &reservation.provenance.session_id
                    ))
                    .parent()
                    .unwrap()
                    .exists()
            );
            assert_eq!(std::fs::read_dir(root.join("sessions")).unwrap().count(), 0);
        }
        store.close().await.unwrap();
    }
    assert!(
        missed.is_empty(),
        "repair accepted malformed pairs: {missed:?}"
    );
}

#[tokio::test]
async fn repair_integrity_creating_keyset_and_recovery_controls() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let store = SessionStore::open(root.clone()).await.unwrap();
    let mut reservations = Vec::new();
    for title in ["", "雪\nreserved", "last"] {
        let input = CreateSession::new(
            OperationId::new(),
            title.into(),
            Some(
                temp.path()
                    .join("missing-workspace")
                    .to_str()
                    .unwrap()
                    .into(),
            ),
        )
        .unwrap();
        let guard = store.inner.lifecycle.admit().unwrap();
        let (reservation, _) = catalog_ops::reserve(&store.inner, &input).await.unwrap();
        guard.finish();
        reservations.push((input, reservation.provenance));
    }
    for _ in 0..2 {
        let report = store.repair_catalog().await.unwrap();
        assert_eq!(report.scanned_sessions(), 0);
        assert_eq!(report.missing_sessions(), 0);
        assert_eq!(report.unavailable_sessions(), 0);
        assert!(
            store
                .list_sessions(None, 10)
                .await
                .unwrap()
                .sessions()
                .iter()
                .all(|s| s.availability() == SessionAvailability::Creating)
        );
    }
    for (input, provenance) in reservations {
        let created = store.create_session(input).await.unwrap();
        assert_eq!(created.receipt(), &provenance.receipt);
        let history = store
            .open_session(created.session_id().clone())
            .await
            .unwrap()
            .history_page(0, None, 10)
            .await
            .unwrap();
        assert_eq!(
            history.records()[0].event_id(),
            &provenance.creation_event_id
        );
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn storage_recovery_unmaterialized_reservation_keeps_original_identity() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let store = SessionStore::open(root.clone()).await.unwrap();
    let input = CreateSession::new(OperationId::new(), "reserved".into(), None).unwrap();
    let guard = store.inner.lifecycle.admit().unwrap();
    let (reservation, _) = catalog_ops::reserve(&store.inner, &input).await.unwrap();
    let provenance = reservation.provenance;
    guard.finish();
    let path = root.join(filesystem::session_relative_path(&provenance.session_id));
    assert!(!path.parent().unwrap().exists());
    let report = store.repair_catalog().await.unwrap();
    assert_eq!(report.scanned_sessions(), 0);
    assert_eq!(report.missing_sessions(), 0);
    assert_eq!(report.unavailable_sessions(), 0);
    let page = store.list_sessions(None, 2).await.unwrap();
    assert_eq!(page.sessions().len(), 1);
    assert_eq!(
        page.sessions()[0].availability(),
        SessionAvailability::Creating
    );
    assert!(!path.parent().unwrap().exists());

    let created = store.create_session(input.clone()).await.unwrap();
    assert_eq!(created.session_id(), &provenance.session_id);
    assert_eq!(created.receipt(), &provenance.receipt);
    assert_eq!(created.receipt().operation_id(), input.operation_id());
    let retry = store.create_session(input).await.unwrap();
    assert!(retry.duplicate());
    assert_eq!(retry.receipt(), &provenance.receipt);
    let handle = store
        .open_session(provenance.session_id.clone())
        .await
        .unwrap();
    let history = handle.history_page(0, None, 2).await.unwrap();
    assert_eq!(history.through_sequence(), 1);
    assert_eq!(history.records().len(), 1);
    assert_eq!(
        history.records()[0].event_id(),
        &provenance.creation_event_id
    );
    let StoredEventPayload::SessionCreated(payload) = history.records()[0].payload() else {
        panic!()
    };
    assert_eq!(payload.creation_provenance(), &provenance);
    let guard = store.inner.lifecycle.admit().unwrap();
    let entry = catalog_ops::entry(&store.inner, &provenance.session_id)
        .await
        .unwrap();
    assert_eq!(entry.summary.availability(), SessionAvailability::Ready);
    assert!(entry.reservation.state == catalog_ops::CreationState::Accepted);
    assert_eq!(entry.reservation.provenance, provenance);
    let mut connection = catalog_ops::connect(&store.inner, false).await.unwrap();
    let row = sqlx::query("SELECT (SELECT count(*) FROM sessions), (SELECT count(*) FROM creation_commands), (SELECT state FROM creation_commands), (SELECT receipt_json FROM creation_commands)")
        .fetch_one(&mut connection).await.unwrap();
    assert_eq!(row.try_get::<i64, _>(0).unwrap(), 1);
    assert_eq!(row.try_get::<i64, _>(1).unwrap(), 1);
    assert_eq!(row.try_get::<String, _>(2).unwrap(), "accepted");
    assert_eq!(
        dto::decode::<CommitReceipt>(&row.try_get::<String, _>(3).unwrap()).unwrap(),
        provenance.receipt
    );
    database::close(connection, &store.inner.lifecycle)
        .await
        .unwrap();
    guard.finish();
    store.close().await.unwrap();
}

#[tokio::test]
async fn storage_recovery_complement_does_not_exempt_unmatched_creating_rows() {
    for mutation in [
        "DELETE FROM creation_commands",
        "UPDATE creation_commands SET session_id='ab123456-789a-4bcd-8abc-0123456789ab'",
        "UPDATE creation_commands SET state='accepted'",
        "UPDATE creation_commands SET state='failed', failure_code='storage.integrity'",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("root")).await.unwrap();
        let input = CreateSession::new(OperationId::new(), "reserved".into(), None).unwrap();
        let guard = store.inner.lifecycle.admit().unwrap();
        let (reservation, _) = catalog_ops::reserve(&store.inner, &input).await.unwrap();
        let mut connection = catalog_ops::connect(&store.inner, true).await.unwrap();
        sqlx::query(mutation)
            .execute(&mut connection)
            .await
            .unwrap();
        database::close(connection, &store.inner.lifecycle)
            .await
            .unwrap();
        guard.finish();
        let report = store.repair_catalog().await.unwrap();
        assert_eq!(report.missing_sessions(), 1);
        let page = store.list_sessions(None, 2).await.unwrap();
        assert_eq!(page.sessions().len(), 1);
        assert_eq!(
            page.sessions()[0].session_id(),
            &reservation.provenance.session_id
        );
        assert_eq!(
            page.sessions()[0].availability(),
            SessionAvailability::Missing
        );
        assert_eq!(page.sessions()[0].fault_code(), Some("storage.not_found"));
        store.close().await.unwrap();
    }
}

#[test]
fn storage_recovery_bootstrap_scan_distinguishes_empty_evidence_and_io() {
    for bucket_entry in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join("sessions");
        assert_eq!(
            filesystem::surviving_sessions(&sessions)
                .unwrap_err()
                .code(),
            "storage.io"
        );
        filesystem::create_directory(&sessions).unwrap();
        assert!(!filesystem::surviving_sessions(&sessions).unwrap());
        let bucket = sessions.join("ab");
        let path = if bucket_entry {
            bucket
        } else {
            filesystem::create_directory(&bucket).unwrap();
            bucket.join("ab123456-789a-4bcd-8abc-0123456789ab")
        };
        drop(filesystem::open_file(&path, true).unwrap());
        assert!(filesystem::surviving_sessions(&sessions).unwrap());
        assert!(std::fs::symlink_metadata(path).unwrap().is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let denied = sessions.join("cd");
            filesystem::create_directory(&denied).unwrap();
            std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o300)).unwrap();
            let result = filesystem::surviving_sessions(&sessions);
            std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(result.unwrap_err().code(), "storage.io");
        }
    }
}

#[tokio::test]
async fn storage_recovery_refresh_is_monotonic_and_never_creates_or_promotes_rows() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let handle = create(&store).await;
    let guard = store.inner.lifecycle.admit().unwrap();
    let (mut connection, _) = session::connection(&store.inner, handle.session_id(), false)
        .await
        .unwrap();
    let mut transaction = connection.begin().await.unwrap();
    let old = catalog_sync::observe(&mut transaction, handle.session_id())
        .await
        .unwrap();
    transaction.rollback().await.unwrap();
    database::close(connection, &store.inner.lifecycle)
        .await
        .unwrap();
    guard.finish();
    handle
        .rename(OperationId::new(), "new".into())
        .await
        .unwrap();
    assert_eq!(
        handle.refresh_catalog().await.unwrap(),
        RefreshResult::Updated
    );
    let current = store.list_sessions(None, 2).await.unwrap();
    let guard = store.inner.lifecycle.admit().unwrap();
    assert_eq!(
        catalog_sync::publish(&store.inner, &old).await.unwrap(),
        RefreshResult::Unchanged
    );
    guard.finish();
    assert_eq!(store.list_sessions(None, 2).await.unwrap(), current);
    for (availability, expected) in [
        ("missing", "storage.not_found"),
        ("unavailable", "storage.unavailable"),
        ("creating", "storage.creation_incomplete"),
        ("absent", "storage.not_found"),
    ] {
        let guard = store.inner.lifecycle.admit().unwrap();
        let mut connection = catalog_ops::connect(&store.inner, true).await.unwrap();
        if availability == "absent" {
            sqlx::query("DELETE FROM sessions WHERE session_id=?")
                .bind(handle.session_id().as_str())
                .execute(&mut connection)
                .await
                .unwrap();
        } else {
            sqlx::query("UPDATE sessions SET availability=?, fault_code=NULL WHERE session_id=?")
                .bind(availability)
                .bind(handle.session_id().as_str())
                .execute(&mut connection)
                .await
                .unwrap();
        }
        database::close(connection, &store.inner.lifecycle)
            .await
            .unwrap();
        assert_eq!(
            catalog_sync::publish(&store.inner, &old)
                .await
                .unwrap_err()
                .code(),
            expected
        );
        guard.finish();
        if availability != "creating" {
            assert_eq!(handle.refresh_catalog().await.unwrap_err().code(), expected);
        }
        let page = store.list_sessions(None, 2).await.unwrap();
        if availability == "absent" {
            assert!(page.sessions().is_empty());
        } else {
            assert_eq!(
                serde_json::to_value(page.sessions()[0].availability()).unwrap(),
                availability
            );
            assert_eq!(page.sessions()[0].title(), "new");
        }
    }
    // Explicit repair is the only operation allowed to register that canonical DB again.
    assert_eq!(store.repair_catalog().await.unwrap().ready_sessions(), 1);
    assert_eq!(
        handle.refresh_catalog().await.unwrap(),
        RefreshResult::Unchanged
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn storage_recovery_interrupted_scans_keep_intent_seen_ids_and_delay_complement() {
    for stop_after in [0, 1, 2] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let store = SessionStore::open(root.clone()).await.unwrap();
        let first = create(&store).await;
        let second = create(&store).await;
        let missing = create(&store).await;
        let path = filesystem::session_path(&root, missing.session_id(), false).unwrap();
        std::fs::rename(path.parent().unwrap(), temp.path().join("missing-session")).unwrap();
        let guard = store.inner.lifecycle.admit().unwrap();
        let maintenance = store.inner.maintenance.write().await;
        assert_eq!(
            catalog_repair::repair(&store.inner, Some(stop_after))
                .await
                .unwrap_err()
                .code(),
            "storage.io"
        );
        drop(maintenance);
        let mut connection = catalog_ops::connect_maintenance(&store.inner)
            .await
            .unwrap();
        let row = sqlx::query("SELECT repair_required, (SELECT count(*) FROM sessions WHERE seen_repair_id IS NOT NULL), (SELECT count(*) FROM sessions WHERE availability='ready'), (SELECT count(DISTINCT seen_repair_id) FROM sessions) FROM catalog_meta")
            .fetch_one(&mut connection).await.unwrap();
        assert_eq!(row.try_get::<i64, _>(0).unwrap(), 1);
        assert_eq!(row.try_get::<i64, _>(1).unwrap(), stop_after as i64);
        assert_eq!(row.try_get::<i64, _>(2).unwrap(), 3);
        assert_eq!(
            row.try_get::<i64, _>(3).unwrap(),
            i64::from(stop_after != 0)
        );
        let previous_id: Option<String> = sqlx::query(
            "SELECT seen_repair_id FROM sessions WHERE seen_repair_id IS NOT NULL LIMIT 1",
        )
        .fetch_optional(&mut connection)
        .await
        .unwrap()
        .map(|row| row.try_get(0).unwrap());
        if let Some(id) = &previous_id {
            assert!(id.parse::<StoredEventId>().is_ok());
        }
        database::close(connection, &store.inner.lifecycle)
            .await
            .unwrap();
        guard.finish();
        assert_eq!(
            first
                .rename(OperationId::new(), "blocked".into())
                .await
                .unwrap_err()
                .code(),
            "storage.catalog_repair_required"
        );
        store.close().await.unwrap();
        let store = SessionStore::open(root.clone()).await.unwrap();
        assert_eq!(
            store.list_sessions(None, 5).await.unwrap_err().code(),
            "storage.catalog_repair_required"
        );
        let report = store.repair_catalog().await.unwrap();
        assert_eq!(report.ready_sessions(), 2);
        assert_eq!(report.missing_sessions(), 1);
        assert_eq!(report.unavailable_sessions(), 0);
        let guard = store.inner.lifecycle.admit().unwrap();
        let mut connection = catalog_ops::connect(&store.inner, false).await.unwrap();
        let next_id: String = sqlx::query("SELECT seen_repair_id FROM sessions WHERE session_id=?")
            .bind(first.session_id().as_str())
            .fetch_one(&mut connection)
            .await
            .unwrap()
            .try_get(0)
            .unwrap();
        assert!(next_id.parse::<StoredEventId>().is_ok());
        assert_ne!(Some(next_id), previous_id);
        database::close(connection, &store.inner.lifecycle)
            .await
            .unwrap();
        guard.finish();
        assert_eq!(
            store
                .open_session(first.session_id().clone())
                .await
                .unwrap()
                .manifest()
                .await
                .unwrap()
                .head_sequence(),
            1
        );
        assert_eq!(
            store
                .open_session(second.session_id().clone())
                .await
                .unwrap()
                .manifest()
                .await
                .unwrap()
                .head_sequence(),
            1
        );
        assert_eq!(store.repair_catalog().await.unwrap(), report);
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn storage_recovery_seen_missing_file_is_not_classified_until_scan_completes() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    create(&store).await;
    let missing = create(&store).await;
    let path = filesystem::session_path(&store.inner.root, missing.session_id(), false).unwrap();
    std::fs::remove_file(&path).unwrap();
    let guard = store.inner.lifecycle.admit().unwrap();
    let maintenance = store.inner.maintenance.write().await;
    assert_eq!(
        catalog_repair::repair(&store.inner, Some(2))
            .await
            .unwrap_err()
            .code(),
        "storage.io"
    );
    drop(maintenance);
    let mut connection = catalog_ops::connect_maintenance(&store.inner)
        .await
        .unwrap();
    let row = sqlx::query("SELECT availability, seen_repair_id, (SELECT repair_required FROM catalog_meta) FROM sessions WHERE session_id=?")
        .bind(missing.session_id().as_str()).fetch_one(&mut connection).await.unwrap();
    assert_eq!(row.try_get::<String, _>(0).unwrap(), "ready");
    assert_eq!(row.try_get::<Option<String>, _>(1).unwrap(), None);
    assert_eq!(row.try_get::<i64, _>(2).unwrap(), 1);
    database::close(connection, &store.inner.lifecycle)
        .await
        .unwrap();
    guard.finish();
    let report = store.repair_catalog().await.unwrap();
    assert_eq!(report.ready_sessions(), 1);
    assert_eq!(report.missing_sessions(), 1);
    assert!(!path.exists());
    store.close().await.unwrap();
}

#[tokio::test]
async fn storage_recovery_maintenance_excludes_operations_survives_waiter_drop_and_close_drains() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let store = Arc::new(SessionStore::open(root.clone()).await.unwrap());
    let handle = create(&store).await;
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let inner = store.inner.clone();
    let operation = tokio::spawn(inner.operation(false, move |_| async move {
        entered.send(()).unwrap();
        released.await.unwrap();
        Ok(())
    }));
    waiting.await.unwrap();
    let mut repair = Box::pin(store.repair_catalog());
    assert!(futures_util::poll!(&mut repair).is_pending());
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        // Tokio's fair lock blocks new readers once the repair writer queues.
        while store.inner.maintenance.try_read().is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut rename = Box::pin(handle.rename(OperationId::new(), "after repair".into()));
    let mut list = Box::pin(store.list_sessions(None, 2));
    let mut create = Box::pin(store.create_session(
        CreateSession::new(OperationId::new(), "after repair".into(), None).unwrap(),
    ));
    assert!(futures_util::poll!(&mut rename).is_pending());
    assert!(futures_util::poll!(&mut list).is_pending());
    assert!(futures_util::poll!(&mut create).is_pending());
    // No repair transaction runs while the earlier normal operation holds ownership.
    let guard = store.inner.lifecycle.admit().unwrap();
    let mut connection = catalog_ops::connect(&store.inner, false).await.unwrap();
    assert_eq!(
        sqlx::query("SELECT repair_required FROM catalog_meta")
            .fetch_one(&mut connection)
            .await
            .unwrap()
            .try_get::<i64, _>(0)
            .unwrap(),
        0
    );
    database::close(connection, &store.inner.lifecycle)
        .await
        .unwrap();
    guard.finish();
    drop(repair);
    let mut close = Box::pin(store.close());
    assert!(futures_util::poll!(&mut close).is_pending());
    assert_eq!(
        filesystem::acquire_lease(&root).unwrap_err().code(),
        "storage.busy"
    );
    release.send(()).unwrap();
    operation.await.unwrap().unwrap();
    rename.await.unwrap();
    list.await.unwrap();
    create.await.unwrap();
    close.await.unwrap();
    let reopened = SessionStore::open(root).await.unwrap();
    assert_eq!(
        reopened
            .list_sessions(None, 5)
            .await
            .unwrap()
            .sessions()
            .len(),
        2
    );
    assert_eq!(
        reopened
            .open_session(handle.session_id().clone())
            .await
            .unwrap()
            .manifest()
            .await
            .unwrap()
            .title(),
        "after repair"
    );
    reopened.close().await.unwrap();
}
