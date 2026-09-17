use super::{dto::CreationProvenance, session_schema::*, *};
use sqlx::Row;

#[tokio::test]
async fn storage_session_initialization_rollback_and_v1_identity() {
    let temp = tempfile::tempdir().unwrap();
    let root = filesystem::resolve_root(temp.path().join("root")).unwrap();
    let lifecycle = lifecycle::Lifecycle::new(filesystem::acquire_lease(&root).unwrap());
    let guard = lifecycle.admit().unwrap();
    let path = root.join("session.sqlite3");
    drop(filesystem::open_file(&path, true).unwrap());
    let mut connection = database::open(&path, false, &lifecycle).await.unwrap();
    let input = CreateSession::new(OperationId::new(), "雪\n".into(), None).unwrap();
    let provenance = CreationProvenance::new(&input).unwrap();
    let error = initialize(&mut connection, &provenance, true)
        .await
        .unwrap_err();
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    assert!(empty(&mut connection).await.unwrap());
    let manifest = initialize(&mut connection, &provenance, false)
        .await
        .unwrap();
    assert_eq!(manifest.head_sequence(), 1);
    assert_eq!(manifest.title(), "雪\n");
    let row = sqlx::query("SELECT (SELECT application_id FROM pragma_application_id), (SELECT user_version FROM pragma_user_version)")
        .fetch_one(&mut connection).await.unwrap();
    assert_eq!(row.try_get::<i64, _>(0).unwrap(), 1464423233);
    assert_eq!(row.try_get::<i64, _>(1).unwrap(), 2);
    let version: i64 = sqlx::query("SELECT schema_version FROM manifest")
        .fetch_one(&mut connection)
        .await
        .unwrap()
        .try_get(0)
        .unwrap();
    assert_eq!(version, 2);
    assert_eq!(
        validate(&mut connection, &provenance.session_id, Some(&provenance))
            .await
            .unwrap(),
        manifest
    );
    assert_eq!(
        initialize(&mut connection, &provenance, false)
            .await
            .unwrap_err()
            .code(),
        "storage.integrity"
    );
    database::close(connection, &lifecycle).await.unwrap();
    guard.finish();
    lifecycle.close().await.unwrap();
}
