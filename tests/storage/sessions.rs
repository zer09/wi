use super::fixtures::{self, Fixture};
use sqlx::{Connection, Row};
use std::path::PathBuf;
use wi::storage::{
    ApplicationSessionId, CommitCertainty, CreateSession, OperationId, SessionAvailability,
    SessionStore,
};

fn request(operation: OperationId, title: &str) -> CreateSession {
    CreateSession::new(operation, title.to_owned(), None).unwrap()
}

fn session_path(fixture: &Fixture, id: &ApplicationSessionId) -> PathBuf {
    fixture
        .root
        .join("sessions")
        .join(&id.as_str()[..2])
        .join(id.as_str())
        .join("session.sqlite3")
}

#[tokio::test]
async fn creation_receipts_provenance_and_concurrent_convergence() {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let operation = OperationId::new();
    let input = request(operation.clone(), "original\n雪");
    let (a, b) = tokio::join!(
        store.create_session(input.clone()),
        store.create_session(input.clone())
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.receipt(), b.receipt());
    assert_ne!(a.duplicate(), b.duplicate());
    assert_eq!(a.receipt().first_sequence(), 1);
    assert_eq!(a.receipt().last_sequence(), 1);
    assert_eq!(a.receipt().operation_id(), &operation);
    let mut session = fixtures::connect(&session_path(&fixture, a.session_id())).await;
    let row = sqlx::query("SELECT creation_provenance_json FROM manifest")
        .fetch_one(&mut session)
        .await
        .unwrap();
    let provenance: serde_json::Value =
        serde_json::from_str(&row.try_get::<String, _>(0).unwrap()).unwrap();
    let row = sqlx::query("SELECT event_id, payload_json FROM events WHERE sequence=1")
        .fetch_one(&mut session)
        .await
        .unwrap();
    let payload: serde_json::Value =
        serde_json::from_str(&row.try_get::<String, _>("payload_json").unwrap()).unwrap();
    assert_eq!(payload["creation_provenance"], provenance);
    assert_eq!(
        provenance["receipt"],
        serde_json::to_value(a.receipt()).unwrap()
    );
    assert_eq!(
        provenance["creation_event_id"],
        row.try_get::<String, _>("event_id").unwrap()
    );
    assert_eq!(provenance["session_id"], a.session_id().as_str());
    assert_eq!(payload["title"], "original\n雪");
    session.close().await.unwrap();
    let changed = store
        .create_session(request(operation.clone(), "different"))
        .await
        .unwrap_err();
    assert_eq!(changed.code(), "storage.command_conflict");
    assert_eq!(changed.certainty(), CommitCertainty::NotCommitted);
    let historical_path = fixture
        .temp
        .path()
        .join("never-created-workspace")
        .to_str()
        .unwrap()
        .to_owned();
    let changed = CreateSession::new(
        operation,
        input.title().into(),
        Some(historical_path.clone()),
    )
    .unwrap();
    assert_eq!(
        store.create_session(changed).await.unwrap_err().code(),
        "storage.command_conflict"
    );
    let created = store
        .create_session(
            CreateSession::new(OperationId::new(), "".into(), Some(historical_path.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(!PathBuf::from(&historical_path).exists());
    let handle = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    assert_eq!(
        handle.manifest().await.unwrap().workspace(),
        Some(historical_path.as_str())
    );
    store.close().await.unwrap();
    let reopened = SessionStore::open(fixture.root.clone()).await.unwrap();
    assert_eq!(
        reopened.create_session(input).await.unwrap().receipt(),
        a.receipt()
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn rename_exact_text_same_title_retry_immutable_receipts_and_stale_catalog() {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let create = request(OperationId::new(), "initial");
    let created = store.create_session(create.clone()).await.unwrap();
    let handle = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let path = session_path(&fixture, created.session_id());
    let mut sql = fixtures::connect(&path).await;
    let original: String = sqlx::query("SELECT payload_json FROM events WHERE sequence=1")
        .fetch_one(&mut sql)
        .await
        .unwrap()
        .try_get(0)
        .unwrap();
    sql.close().await.unwrap();
    let mut receipts = Vec::new();
    for title in ["\n雪🦀\r\t\0", "", ""] {
        let operation = OperationId::new();
        let committed = handle
            .rename(operation.clone(), title.into())
            .await
            .unwrap();
        assert!(!committed.duplicate());
        assert_eq!(
            committed.receipt().first_sequence(),
            receipts.len() as u64 + 2
        );
        assert_eq!(handle.manifest().await.unwrap().title(), title);
        assert_eq!(
            handle
                .lookup_receipt(operation.clone())
                .await
                .unwrap()
                .as_ref(),
            Some(committed.receipt())
        );
        let retry = handle
            .rename(operation.clone(), title.into())
            .await
            .unwrap();
        assert!(retry.duplicate());
        assert_eq!(retry.receipt(), committed.receipt());
        assert_eq!(
            handle
                .rename(operation, "conflict".into())
                .await
                .unwrap_err()
                .code(),
            "storage.command_conflict"
        );
        receipts.push((title, committed.receipt().clone()));
    }
    let retry = handle
        .rename(receipts[0].1.operation_id().clone(), receipts[0].0.into())
        .await
        .unwrap();
    assert!(retry.duplicate());
    assert_eq!(retry.receipt(), &receipts[0].1);
    assert_eq!(handle.manifest().await.unwrap().head_sequence(), 4);
    assert_eq!(
        store.create_session(create).await.unwrap().receipt(),
        created.receipt()
    );
    let page = store.list_sessions(None, 1).await.unwrap();
    assert_eq!(page.sessions()[0].title(), "initial");
    assert_eq!(page.sessions()[0].observed_head_sequence(), 1);
    let mut sql = fixtures::connect(&path).await;
    assert_eq!(
        sqlx::query("SELECT payload_json FROM events WHERE sequence=1")
            .fetch_one(&mut sql)
            .await
            .unwrap()
            .try_get::<String, _>(0)
            .unwrap(),
        original
    );
    for statement in [
        "UPDATE events SET payload_json='{}'",
        "DELETE FROM events",
        "UPDATE commands SET method='other'",
        "DELETE FROM commands",
        "UPDATE manifest SET session_id='other'",
        "UPDATE manifest SET created_at_ms=0",
        "UPDATE manifest SET creation_provenance_json='{}'",
    ] {
        assert!(sqlx::query(statement).execute(&mut sql).await.is_err());
    }
    sql.close().await.unwrap();
    assert!(!format!("{created:?} {handle:?} {page:?}").contains("initial"));
    drop(handle);
    let again = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    assert_eq!(again.manifest().await.unwrap().title(), "");
    store.close().await.unwrap();
    assert_eq!(
        again
            .rename(OperationId::new(), "x".into())
            .await
            .unwrap_err()
            .code(),
        "storage.closed"
    );
}

#[tokio::test]
async fn rename_busy_is_not_committed_and_identical_waiters_converge() {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let created = store
        .create_session(request(OperationId::new(), "initial"))
        .await
        .unwrap();
    let handle = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let mut sql = fixtures::connect(&session_path(&fixture, created.session_id())).await;
    let transaction = sql.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let operation = OperationId::new();
    let error = handle
        .rename(operation.clone(), "same".into())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "storage.busy");
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    transaction.rollback().await.unwrap();
    sql.close().await.unwrap();
    assert!(
        handle
            .lookup_receipt(operation.clone())
            .await
            .unwrap()
            .is_none()
    );
    let (a, b) = tokio::join!(
        handle.rename(operation.clone(), "same".into()),
        handle.rename(operation.clone(), "same".into())
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.receipt(), b.receipt());
    assert_ne!(a.duplicate(), b.duplicate());
    assert_eq!(a.receipt().first_sequence(), 2);
    let other = store
        .create_session(request(OperationId::new(), "other"))
        .await
        .unwrap();
    let other = store
        .open_session(other.session_id().clone())
        .await
        .unwrap();
    let independent = other.rename(operation, "same".into()).await.unwrap();
    assert!(!independent.duplicate());
    assert_eq!(independent.receipt().first_sequence(), 2);
    store.close().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn generated_session_database_and_sidecar_links_are_preserved_and_rejected() {
    for sidecar in [false, true] {
        let fixture = Fixture::new();
        let store = SessionStore::open(fixture.root.clone()).await.unwrap();
        let created = store
            .create_session(request(OperationId::new(), "initial"))
            .await
            .unwrap();
        let path = session_path(&fixture, created.session_id());
        let target = fixture.temp.path().join("sentinel");
        fixtures::file(&target, b"private-canary");
        let link = if sidecar {
            path.with_file_name("session.sqlite3-wal")
        } else {
            std::fs::remove_file(&path).unwrap();
            path
        };
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(
            store
                .open_session(created.session_id().clone())
                .await
                .unwrap_err()
                .code(),
            "storage.unavailable"
        );
        assert!(
            std::fs::symlink_metadata(link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(std::fs::read(target).unwrap(), b"private-canary");
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn catalog_keyset_listing_does_not_open_ready_missing_databases() {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let mut ids = Vec::new();
    for _ in 0..5 {
        ids.push(
            store
                .create_session(request(OperationId::new(), "same"))
                .await
                .unwrap()
                .session_id()
                .clone(),
        );
    }
    ids.sort();
    let missing = session_path(&fixture, &ids[0]);
    std::fs::remove_file(&missing).unwrap();
    let mut after = None;
    let mut found = Vec::new();
    loop {
        let page = store.list_sessions(after, 2).await.unwrap();
        assert!(page.sessions().len() <= 2);
        for session in page.sessions() {
            assert_eq!(session.availability(), SessionAvailability::Ready);
            found.push(session.session_id().clone());
        }
        after = page.next_after().cloned();
        if !page.has_more() {
            break;
        }
    }
    assert_eq!(found, ids);
    assert!(
        store
            .list_sessions(after, 2)
            .await
            .unwrap()
            .sessions()
            .is_empty()
    );
    assert_eq!(
        store.open_session(ids[0].clone()).await.unwrap_err().code(),
        "storage.not_found"
    );
    assert!(!missing.exists());
    for bad in [0, i64::MAX as u64, u64::MAX] {
        assert_eq!(
            store.list_sessions(None, bad).await.unwrap_err().code(),
            "storage.invalid_input"
        );
    }
    fixture
        .mutate("UPDATE catalog_meta SET repair_required=1")
        .await;
    assert_eq!(
        store.list_sessions(None, 1).await.unwrap_err().code(),
        "storage.catalog_repair_required"
    );
    assert_eq!(
        store.open_session(ids[1].clone()).await.unwrap_err().code(),
        "storage.catalog_repair_required"
    );
    assert_eq!(
        store
            .create_session(request(OperationId::new(), "x"))
            .await
            .unwrap_err()
            .code(),
        "storage.catalog_repair_required"
    );
    store.close().await.unwrap();
}
