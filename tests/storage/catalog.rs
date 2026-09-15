use std::fs;

use sqlx::{Connection, Row};
use wi::storage::SessionStore;

use super::fixtures::{self, Fixture};

#[tokio::test]
async fn storage_independent_populated_v1_reopens_without_workspace_access() {
    let fixture = Fixture::new();
    fixture.independent_v1().await;
    fixture.initialized().await;
    let mut connection = fixtures::connect(&fixture.catalog()).await;
    let row = sqlx::query("SELECT title, workspace_json, availability FROM sessions")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(
        row.try_get::<String, _>(0).unwrap(),
        "Independent fixture: Ω"
    );
    assert_eq!(
        row.try_get::<String, _>(1).unwrap(),
        "\"/synthetic/nonexistent-workspace\""
    );
    assert_eq!(row.try_get::<String, _>(2).unwrap(), "missing");
    connection.close().await.unwrap();
    assert_eq!(
        fs::read_dir(fixture.root.join("sessions")).unwrap().count(),
        0
    );
}

#[tokio::test]
async fn storage_existing_empty_unknown_and_corrupt_catalogs_are_preserved() {
    for bytes in [
        b"".as_slice(),
        b"synthetic-token-canary",
        b"SQLite format 3\0malformed",
    ] {
        let fixture = Fixture::new();
        fixtures::directory(&fixture.root);
        fixtures::file(&fixture.catalog(), bytes);
        fixture.assert_rejected_preserved("storage.integrity").await;
    }
    let fixture = Fixture::new();
    fixtures::directory(&fixture.root);
    fixtures::file(&fixture.catalog(), b"");
    fixture.mutate("VACUUM").await;
    assert!(fs::metadata(fixture.catalog()).unwrap().len() > 0);
    fixture.assert_rejected_preserved("storage.integrity").await;
}

#[tokio::test]
async fn storage_foreign_future_and_unreleased_versions_are_preserved() {
    for (mutation, code) in [
        ("PRAGMA application_id=42", "storage.integrity"),
        ("PRAGMA application_id=1464423233", "storage.integrity"),
        ("PRAGMA user_version=2", "storage.unsupported_version"),
        ("PRAGMA user_version=0", "storage.unsupported_version"),
    ] {
        let fixture = Fixture::new();
        fixture.independent_v1().await;
        fixture.mutate(mutation).await;
        fixture.assert_rejected_preserved(code).await;
    }
}

#[tokio::test]
async fn storage_missing_required_schema_and_wrong_index_shape_are_preserved() {
    for mutation in [
        "DROP TABLE catalog_meta",
        "DROP TABLE sessions",
        "DROP TABLE creation_commands",
        "DROP INDEX fixture_availability",
        "ALTER TABLE sessions DROP COLUMN title",
        "ALTER TABLE creation_commands RENAME COLUMN payload_hash TO wrong_column",
        "DROP INDEX fixture_availability; CREATE INDEX fixture_availability ON sessions(session_id, availability)",
        "DROP INDEX fixture_availability; CREATE INDEX fixture_availability ON sessions(availability COLLATE NOCASE, session_id)",
        "DROP INDEX fixture_availability; CREATE INDEX fixture_availability ON sessions(availability, session_id) WHERE availability='ready'",
        "DROP TABLE catalog_meta; CREATE VIEW catalog_meta AS SELECT 1 AS singleton, 1 AS format_version, 0 AS repair_required",
        "DROP TABLE catalog_meta; CREATE TABLE catalog_meta(singleton INTEGER PRIMARY KEY, format_version INTEGER NOT NULL, repair_required INTEGER NOT NULL); INSERT INTO catalog_meta VALUES(1,1,0)",
        "DROP TABLE catalog_meta; CREATE TABLE catalog_meta(singleton INTEGER PRIMARY KEY, format_version TEXT NOT NULL, repair_required INTEGER NOT NULL) STRICT; INSERT INTO catalog_meta VALUES(1,'1',0)",
    ] {
        let fixture = Fixture::new();
        fixture.independent_v1().await;
        fixture.mutate(mutation).await;
        fixture.assert_rejected_preserved("storage.integrity").await;
    }
}

#[tokio::test]
async fn storage_meta_singleton_format_and_repair_agreement_are_required() {
    for mutation in [
        "DELETE FROM catalog_meta",
        "PRAGMA ignore_check_constraints=ON; INSERT INTO catalog_meta VALUES(2,1,0)",
        "PRAGMA ignore_check_constraints=ON; UPDATE catalog_meta SET singleton=2",
        "PRAGMA ignore_check_constraints=ON; UPDATE catalog_meta SET format_version=2",
        "PRAGMA ignore_check_constraints=ON; UPDATE catalog_meta SET repair_required=2",
    ] {
        let fixture = Fixture::new();
        fixture.independent_v1().await;
        fixture.mutate(mutation).await;
        fixture.assert_rejected_preserved("storage.integrity").await;
    }
}

#[tokio::test]
async fn storage_validation_observes_live_wal_without_modifying_foreign_main_file() {
    let fixture = Fixture::new();
    fixture.initialized().await;
    let mut connection = fixtures::connect(&fixture.catalog()).await;
    sqlx::query("PRAGMA application_id=42")
        .execute(&mut connection)
        .await
        .unwrap();
    assert!(fixture.root.join("catalog.sqlite3-wal").is_file());
    fixture.assert_rejected_preserved("storage.integrity").await;
    connection.close().await.unwrap();
}

#[tokio::test]
async fn storage_missing_catalog_with_generated_session_directory_sets_durable_repair_intent() {
    let fixture = Fixture::new();
    let session = fixture
        .root
        .join("sessions/ab/ab123456-789a-4bcd-8abc-0123456789ab");
    fixtures::directory(&session);
    fixtures::file(
        &session.join("session.sqlite3"),
        b"synthetic-session-content-canary",
    );
    fixture.initialized().await;
    fixture.initialized().await;
    let mut connection = fixtures::connect(&fixture.catalog()).await;
    assert_eq!(
        sqlx::query("SELECT repair_required FROM catalog_meta")
            .fetch_one(&mut connection)
            .await
            .unwrap()
            .try_get::<i64, _>(0)
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query("SELECT count(*) FROM sessions")
            .fetch_one(&mut connection)
            .await
            .unwrap()
            .try_get::<i64, _>(0)
            .unwrap(),
        0
    );
    connection.close().await.unwrap();
    assert_eq!(
        fs::read(session.join("session.sqlite3")).unwrap(),
        b"synthetic-session-content-canary"
    );
}

#[tokio::test]
async fn storage_noncanonical_survivors_are_not_followed_or_inferred_as_sessions() {
    let fixture = Fixture::new();
    for path in [
        "sessions/not-a-bucket/ab123456-789a-4bcd-8abc-0123456789ab",
        "sessions/ab/not-a-uuid",
        "sessions/ff/ab123456-789a-4bcd-8abc-0123456789ab",
        "sessions/00/00000000-0000-0000-0000-000000000000",
    ] {
        fixtures::directory(&fixture.root.join(path));
    }
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    store.close().await.unwrap();
    let mut connection = fixtures::connect(&fixture.catalog()).await;
    assert_eq!(
        sqlx::query("SELECT repair_required FROM catalog_meta")
            .fetch_one(&mut connection)
            .await
            .unwrap()
            .try_get::<i64, _>(0)
            .unwrap(),
        0
    );
    connection.close().await.unwrap();
    assert!(fixture.root.join("sessions/ab/not-a-uuid").is_dir());
}
