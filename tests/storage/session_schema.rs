use super::fixtures::{self, Fixture};
use sqlx::{Connection, Row};
use wi::storage::{ApplicationSessionId, CreateSession, OperationId, SessionStore};

const ID: &str = "ab123456-789a-4bcd-8abc-0123456789ac";
const OP: &str = "ab123456-789a-4bcd-8abc-0123456789ad";
const EVENT: &str = "ab123456-789a-4bcd-8abc-0123456789ae";
const RENAME: &str = "ab123456-789a-4bcd-8abc-0123456789af";

fn path(fixture: &Fixture) -> std::path::PathBuf {
    fixture
        .root
        .join("sessions/ab")
        .join(ID)
        .join("session.sqlite3")
}

async fn independent() -> Fixture {
    let fixture = Fixture::new();
    fixture.independent_v1().await;
    fixtures::directory(path(&fixture).parent().unwrap());
    fixtures::file(&path(&fixture), b"");
    let mut sql = fixtures::connect(&path(&fixture)).await;
    sqlx::raw_sql(include_str!("session_v1.sql"))
        .execute(&mut sql)
        .await
        .unwrap();
    let request = r#"{"method":"create_session","title":"fixture-original","workspace":null}"#;
    let hash = ring::digest::digest(&ring::digest::SHA256, request.as_bytes());
    let receipt = serde_json::json!({"operation_id":OP,"session_id":ID,"run_id":null,"first_sequence":1,"last_sequence":1});
    let provenance = serde_json::json!({"operation_id":OP,"method":"create_session","session_id":ID,"creation_event_id":EVENT,
        "created_at_ms":42,"request_json":request,"payload_hash":hash.as_ref(),"receipt":receipt});
    let payload = serde_json::json!({"title":"fixture-original","workspace":null,"creation_provenance":provenance});
    sqlx::query("INSERT INTO manifest VALUES(1, ?, 1, 1, 'fixture-now', NULL, 42, 43, 2, ?)")
        .bind(ID)
        .bind(provenance.to_string())
        .execute(&mut sql)
        .await
        .unwrap();
    sqlx::query("INSERT INTO events VALUES(1, ?, 'session.created', 1, 42, NULL, NULL, NULL, ?)")
        .bind(EVENT)
        .bind(payload.to_string())
        .execute(&mut sql)
        .await
        .unwrap();
    sqlx::query("INSERT INTO events VALUES(2, 'ab123456-789a-4bcd-8abc-0123456789b0', 'session.renamed', 1, 43, NULL, NULL, NULL, '{\"title\":\"fixture-now\"}')")
        .execute(&mut sql).await.unwrap();
    let rename_request =
        format!(r#"{{"method":"rename","session_id":"{ID}","title":"fixture-now"}}"#);
    let rename_hash = ring::digest::digest(&ring::digest::SHA256, rename_request.as_bytes());
    let rename_receipt = serde_json::json!({"operation_id":RENAME,"session_id":ID,"run_id":null,"first_sequence":2,"last_sequence":2});
    sqlx::query("INSERT INTO commands VALUES(?, 'rename', ?, 2, 2, ?)")
        .bind(RENAME)
        .bind(rename_hash.as_ref())
        .bind(rename_receipt.to_string())
        .execute(&mut sql)
        .await
        .unwrap();
    sql.close().await.unwrap();
    let mut sql = fixtures::connect(&fixture.catalog()).await;
    sqlx::query("INSERT INTO sessions (session_id, relative_path, title, created_at_ms, updated_at_ms, head_sequence, schema_version, availability) VALUES(?, ?, 'fixture-original', 42, 42, 1, 1, 'ready')")
        .bind(ID).bind(format!("sessions/ab/{ID}/session.sqlite3")).execute(&mut sql).await.unwrap();
    sqlx::query("INSERT INTO creation_commands VALUES(?, ?, ?, ?, ?, 42, 'accepted', ?, NULL)")
        .bind(OP)
        .bind(hash.as_ref())
        .bind(request)
        .bind(ID)
        .bind(EVENT)
        .bind(receipt.to_string())
        .execute(&mut sql)
        .await
        .unwrap();
    sql.close().await.unwrap();
    fixture
}

#[tokio::test]
async fn independent_populated_session_v1_reopens_renames_and_retries_original_receipts() {
    let fixture = independent().await;
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let handle = store.open_session(ID.parse().unwrap()).await.unwrap();
    assert_eq!(handle.manifest().await.unwrap().title(), "fixture-now");
    let retry = handle
        .rename(RENAME.parse().unwrap(), "fixture-now".into())
        .await
        .unwrap();
    assert!(retry.duplicate());
    assert_eq!(retry.receipt().first_sequence(), 2);
    let create = store
        .create_session(
            CreateSession::new(OP.parse().unwrap(), "fixture-original".into(), None).unwrap(),
        )
        .await
        .unwrap();
    assert!(create.duplicate());
    assert_eq!(create.session_id().as_str(), ID);
    assert_eq!(
        handle
            .rename(OperationId::new(), "new\n雪".into())
            .await
            .unwrap()
            .receipt()
            .first_sequence(),
        3
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn session_foreign_future_and_missing_schema_are_preserved() {
    for (change, code) in [
        ("PRAGMA application_id=17", "storage.integrity"),
        ("PRAGMA user_version=3", "storage.unsupported_version"),
        ("PRAGMA user_version=0", "storage.unsupported_version"),
        ("DROP TABLE tool_results", "storage.integrity"),
        (
            "ALTER TABLE runs DROP COLUMN provider_session_id",
            "storage.integrity",
        ),
        ("DROP INDEX fixture_source_id", "storage.integrity"),
        ("DROP INDEX fixture_source_sequence", "storage.integrity"),
        ("DROP INDEX fixture_unfinished", "storage.integrity"),
        ("DROP INDEX fixture_run_sequence", "storage.integrity"),
        ("DROP TRIGGER events_no_update", "storage.integrity"),
        ("DROP TRIGGER events_no_delete", "storage.integrity"),
        ("DROP TRIGGER commands_no_update", "storage.integrity"),
        ("DROP TRIGGER commands_no_delete", "storage.integrity"),
        (
            "DROP TRIGGER manifest_creation_immutable",
            "storage.integrity",
        ),
        (
            "DROP TRIGGER events_no_delete; CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT 1; END",
            "storage.integrity",
        ),
        ("UPDATE manifest SET head_sequence=3", "storage.integrity"),
        ("UPDATE manifest SET schema_version=2", "storage.integrity"),
        (
            "UPDATE manifest SET workspace_json='\"/another-workspace\"'",
            "storage.integrity",
        ),
        (
            "UPDATE manifest SET title='not-the-head-title'",
            "storage.integrity",
        ),
    ] {
        let fixture = independent().await;
        let mut sql = fixtures::connect(&path(&fixture)).await;
        sqlx::raw_sql(change).execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        let before = std::fs::read(path(&fixture)).unwrap();
        let store = SessionStore::open(fixture.root.clone()).await.unwrap();
        let error = store.open_session(ID.parse().unwrap()).await.unwrap_err();
        assert_eq!(error.code(), code, "{change}");
        assert_eq!(std::fs::read(path(&fixture)).unwrap(), before, "{change}");
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn provenance_catalog_receipt_and_generated_path_must_agree() {
    for change in [
        "UPDATE creation_commands SET receipt_json=json_set(receipt_json,'$.last_sequence',2)",
        "UPDATE creation_commands SET payload_hash=zeroblob(32)",
        "UPDATE creation_commands SET request_json=json_set(request_json,'$.title','changed')",
        "UPDATE creation_commands SET created_at_ms=41",
        "UPDATE creation_commands SET creation_event_id='ab123456-789a-4bcd-8abc-0123456789b1'",
        "UPDATE sessions SET relative_path='../not-allowed' WHERE availability='ready'",
        "UPDATE sessions SET relative_path='sessions/ab/../ab/ab123456-789a-4bcd-8abc-0123456789ac/session.sqlite3' WHERE availability='ready'",
    ] {
        let fixture = independent().await;
        fixture.mutate(change).await;
        let before = std::fs::read(path(&fixture)).unwrap();
        let store = SessionStore::open(fixture.root.clone()).await.unwrap();
        assert_eq!(
            store
                .open_session(ID.parse().unwrap())
                .await
                .unwrap_err()
                .code(),
            "storage.integrity",
            "{change}"
        );
        assert_eq!(std::fs::read(path(&fixture)).unwrap(), before);
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn immutable_creation_evidence_is_validated_beyond_trigger_presence() {
    for change in [
        "UPDATE manifest SET creation_provenance_json=json_set(creation_provenance_json,'$.request_json','{}')",
        "UPDATE manifest SET creation_provenance_json=json_set(creation_provenance_json,'$.receipt.last_sequence',2)",
        "UPDATE events SET payload_json=json_set(payload_json,'$.title','not-original') WHERE sequence=1",
        "UPDATE events SET payload_json=json_set(payload_json,'$.extra',1) WHERE sequence=1",
        "UPDATE events SET created_at_ms=41 WHERE sequence=1",
        "UPDATE events SET event_id='ab123456-789a-4bcd-8abc-0123456789b1' WHERE sequence=1",
    ] {
        let fixture = independent().await;
        let mut sql = fixtures::connect(&path(&fixture)).await;
        sqlx::raw_sql("DROP TRIGGER manifest_creation_immutable; DROP TRIGGER events_no_update")
            .execute(&mut sql)
            .await
            .unwrap();
        sqlx::raw_sql(change).execute(&mut sql).await.unwrap();
        sqlx::raw_sql("CREATE TRIGGER manifest_creation_immutable BEFORE UPDATE OF session_id, created_at_ms, creation_provenance_json ON manifest BEGIN SELECT RAISE(ABORT,'immutable session identity'); END; CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable history'); END")
            .execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        let before = std::fs::read(path(&fixture)).unwrap();
        let store = SessionStore::open(fixture.root.clone()).await.unwrap();
        assert_eq!(
            store
                .open_session(ID.parse().unwrap())
                .await
                .unwrap_err()
                .code(),
            "storage.integrity"
        );
        assert_eq!(std::fs::read(path(&fixture)).unwrap(), before);
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn ready_empty_corrupt_and_missing_session_files_are_never_initialized() {
    for replacement in [Some(&b""[..]), Some(&b"corrupt-session-canary"[..]), None] {
        let fixture = independent().await;
        std::fs::remove_file(path(&fixture)).unwrap();
        if let Some(bytes) = replacement {
            fixtures::file(&path(&fixture), bytes);
        }
        let store = SessionStore::open(fixture.root.clone()).await.unwrap();
        let result = store
            .open_session(ID.parse::<ApplicationSessionId>().unwrap())
            .await
            .unwrap_err();
        assert!(matches!(
            result.code(),
            "storage.integrity" | "storage.not_found"
        ));
        if let Some(bytes) = replacement {
            assert_eq!(std::fs::read(path(&fixture)).unwrap(), bytes);
        } else {
            assert!(!path(&fixture).exists());
        }
        // A driver setup error can leave worker retirement uncertain; the lease then stays quarantined.
        let _ = store.close().await;
    }
}

#[tokio::test]
async fn rename_during_active_projection_and_concurrent_handles_is_allowed() {
    let fixture = independent().await;
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let a = store.open_session(ID.parse().unwrap()).await.unwrap();
    // Reopening now validates ownership against canonical acceptance, not an isolated projection.
    let run = wi::storage::RunId::new();
    a.accept_run(OperationId::new(), run.clone(), super::capture::input())
        .await
        .unwrap();
    a.append_run_records(
        OperationId::new(),
        run.clone(),
        vec![wi::storage::AppendRunRecord::Runtime(
            super::recording::runtime(&run, 1, wi::run::RunEvent::RunStarted),
        )],
    )
    .await
    .unwrap();
    let b = store.open_session(ID.parse().unwrap()).await.unwrap();
    let (a, b) = tokio::join!(
        a.rename(OperationId::new(), "a".into()),
        b.rename(OperationId::new(), "b".into())
    );
    let mut sequences = [
        a.unwrap().receipt().first_sequence(),
        b.unwrap().receipt().first_sequence(),
    ];
    sequences.sort();
    assert_eq!(sequences, [5, 6]);
    let mut sql = fixtures::connect(&path(&fixture)).await;
    assert_eq!(
        sqlx::query("SELECT state FROM runs")
            .fetch_one(&mut sql)
            .await
            .unwrap()
            .try_get::<String, _>(0)
            .unwrap(),
        "running"
    );
    sql.close().await.unwrap();
    store.close().await.unwrap();
}
