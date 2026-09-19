use std::{fs, path::PathBuf};

use sqlx::{Connection, Row};
use wi::storage::{CommitCertainty, SessionStore};

use super::fixtures::{self, Fixture};

#[tokio::test]
async fn storage_fresh_layout_close_reopen_and_distinct_roots() {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let mut paths: Vec<_> = fs::read_dir(&fixture.root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    paths.sort();
    assert_eq!(paths, ["catalog.sqlite3", "sessions", "storage.lock"]);
    assert_eq!(
        fs::read_dir(fixture.root.join("sessions")).unwrap().count(),
        0
    );
    assert_eq!(format!("{store:?}"), "SessionStore([redacted])");
    let other = SessionStore::open(fixture.temp.path().join("independent"))
        .await
        .unwrap();
    store.close().await.unwrap();
    store.close().await.unwrap();
    let reopened = SessionStore::open(fixture.root.clone()).await.unwrap();
    reopened.close().await.unwrap();
    other.close().await.unwrap();
}

#[tokio::test]
async fn storage_requires_explicit_absolute_root_and_never_treats_paths_as_uris() {
    for root in [
        PathBuf::new(),
        PathBuf::from("relative-storage"),
        PathBuf::from("file:catalog?mode=memory"),
    ] {
        let error = SessionStore::open(root).await.unwrap_err();
        assert_eq!(error.code(), "storage.invalid_input");
        assert_eq!(error.certainty(), CommitCertainty::NotApplicable);
    }
    let fixture = Fixture::new();
    let root = fixture
        .root
        .join("nested")
        .join("literal?mode=memory&cache=shared");
    let store = SessionStore::open(root.clone()).await.unwrap();
    store.close().await.unwrap();
    assert!(root.join("catalog.sqlite3").is_file());
}

#[tokio::test]
async fn storage_same_process_os_lease_precedes_database_work() {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    // A directly opened OS handle also contends, independent of SessionStore bookkeeping.
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(fixture.root.join("storage.lock"))
        .unwrap();
    assert!(matches!(file.try_lock(), Err(fs::TryLockError::WouldBlock)));
    let error = SessionStore::open(fixture.root.join("."))
        .await
        .unwrap_err();
    assert_eq!(error.code(), "storage.busy");
    store.close().await.unwrap();
    file.try_lock().unwrap();
    // Corrupt data must not be inspected until the independent lock owner has released it.
    fs::write(fixture.catalog(), b"synthetic-token-canary").unwrap();
    assert_eq!(
        SessionStore::open(fixture.root.clone())
            .await
            .unwrap_err()
            .code(),
        "storage.busy"
    );
    file.unlock().unwrap();
    fixture.assert_rejected_preserved("storage.integrity").await;
}

#[tokio::test]
async fn storage_concurrent_first_openers_have_one_owner() {
    let fixture = Fixture::new();
    let (first, second) = tokio::join!(
        SessionStore::open(fixture.root.clone()),
        SessionStore::open(fixture.root.clone())
    );
    let store = match (first, second) {
        (Ok(store), Err(error)) | (Err(error), Ok(store)) => {
            assert_eq!(error.code(), "storage.busy");
            store
        }
        result => panic!("expected exactly one owner: {result:?}"),
    };
    store.close().await.unwrap();
}

#[tokio::test]
async fn storage_clean_drop_releases_idle_lease() {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    drop(store);
    fixture.initialized().await;
}

#[test]
fn storage_explicit_root_without_home_or_workspace_state() {
    const CHILD: &str = "WI_STORAGE_TEST_ROOT";
    if let Some(root) = std::env::var_os(CHILD) {
        assert!(std::env::var_os("HOME").is_none());
        assert!(std::env::var_os("XDG_CONFIG_HOME").is_none());
        assert!(std::env::var_os("CODEX_HOME").is_none());
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            SessionStore::open(root.into())
                .await
                .unwrap()
                .close()
                .await
                .unwrap();
        });
        return;
    }
    let fixture = Fixture::new();
    let workspace = fixture.temp.path().join("workspace");
    fixtures::directory(&workspace);
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "foundation::storage_explicit_root_without_home_or_workspace_state",
        ])
        .env_clear()
        .env(CHILD, &fixture.root)
        .current_dir(&workspace);
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(fixture.catalog().is_file());
    assert_eq!(fs::read_dir(workspace).unwrap().count(), 0);
}

#[tokio::test]
async fn storage_fresh_catalog_identity_and_repair_flag() {
    let fixture = Fixture::new();
    fixture.initialized().await;
    let mut connection = fixtures::connect(&fixture.catalog()).await;
    for (pragma, expected) in [
        ("PRAGMA application_id", 1464419137_i64),
        ("PRAGMA user_version", 1),
    ] {
        assert_eq!(
            sqlx::query(pragma)
                .fetch_one(&mut connection)
                .await
                .unwrap()
                .try_get::<i64, _>(0)
                .unwrap(),
            expected
        );
    }
    let row =
        sqlx::query("SELECT format_version, repair_required FROM catalog_meta WHERE singleton=1")
            .fetch_one(&mut connection)
            .await
            .unwrap();
    assert_eq!(row.try_get::<i64, _>(0).unwrap(), 1);
    assert_eq!(row.try_get::<i64, _>(1).unwrap(), 0);
    assert_eq!(
        sqlx::query("PRAGMA journal_mode")
            .fetch_one(&mut connection)
            .await
            .unwrap()
            .try_get::<String, _>(0)
            .unwrap(),
        "wal"
    );
    connection.close().await.unwrap();
}
