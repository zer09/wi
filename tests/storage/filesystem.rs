use std::fs;

use wi::storage::SessionStore;

use super::fixtures::{self, Fixture};

#[tokio::test]
async fn storage_existing_managed_wrong_entry_types_are_preserved() {
    let fixture = Fixture::new();
    fixtures::file(&fixture.root, b"synthetic-root-canary");
    assert_eq!(
        SessionStore::open(fixture.root.clone())
            .await
            .unwrap_err()
            .code(),
        "storage.unavailable"
    );
    assert_eq!(fs::read(&fixture.root).unwrap(), b"synthetic-root-canary");
    for name in [
        "storage.lock",
        "catalog.sqlite3",
        "catalog.sqlite3-wal",
        "catalog.sqlite3-shm",
        "catalog.sqlite3-journal",
    ] {
        let fixture = Fixture::new();
        let path = fixture.root.join(name);
        fixtures::directory(&path);
        assert_eq!(
            SessionStore::open(fixture.root.clone())
                .await
                .unwrap_err()
                .code(),
            "storage.unavailable"
        );
        assert!(path.is_dir());
    }
    let fixture = Fixture::new();
    fixtures::directory(&fixture.root);
    fixtures::file(
        &fixture.root.join("sessions"),
        b"synthetic-session-directory-canary",
    );
    assert_eq!(
        SessionStore::open(fixture.root.clone())
            .await
            .unwrap_err()
            .code(),
        "storage.unavailable"
    );
    assert_eq!(
        fs::read(fixture.root.join("sessions")).unwrap(),
        b"synthetic-session-directory-canary"
    );
}

#[tokio::test]
async fn storage_orphan_catalog_sidecars_prevent_initialization() {
    for suffix in ["-wal", "-shm", "-journal"] {
        let fixture = Fixture::new();
        fixtures::directory(&fixture.root);
        let sidecar = fixture.root.join(format!("catalog.sqlite3{suffix}"));
        fixtures::file(&sidecar, b"synthetic-orphan-canary");
        assert_eq!(
            SessionStore::open(fixture.root.clone())
                .await
                .unwrap_err()
                .code(),
            "storage.integrity"
        );
        assert!(!fixture.catalog().exists());
        assert_eq!(fs::read(sidecar).unwrap(), b"synthetic-orphan-canary");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn storage_new_unix_directories_files_and_sidecars_are_private() {
    use sqlx::Connection;
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new();
    let ancestor_mode = fs::metadata(fixture.temp.path())
        .unwrap()
        .permissions()
        .mode();
    let root = fixture.root.join("nested/root");
    let store = SessionStore::open(root.clone()).await.unwrap();
    store.close().await.unwrap();
    for path in [
        &fixture.root,
        &fixture.root.join("nested"),
        &root,
        &root.join("sessions"),
    ] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o7777,
            0o700
        );
    }
    for name in ["storage.lock", "catalog.sqlite3"] {
        assert_eq!(
            fs::metadata(root.join(name)).unwrap().permissions().mode() & 0o7777,
            0o600
        );
    }
    let mut connection = fixtures::connect(&root.join("catalog.sqlite3")).await;
    sqlx::query("SELECT * FROM catalog_meta")
        .fetch_all(&mut connection)
        .await
        .unwrap();
    for name in ["catalog.sqlite3-wal", "catalog.sqlite3-shm"] {
        assert_eq!(
            fs::metadata(root.join(name)).unwrap().permissions().mode() & 0o7777,
            0o600
        );
    }
    connection.close().await.unwrap();
    assert_eq!(
        fs::metadata(fixture.temp.path())
            .unwrap()
            .permissions()
            .mode(),
        ancestor_mode
    );
}

#[cfg(unix)]
#[tokio::test]
async fn storage_insecure_unix_paths_are_rejected_without_chmod_or_content_changes() {
    use std::os::unix::fs::PermissionsExt;

    for name in ["", "sessions"] {
        let fixture = Fixture::new();
        let path = fixture.root.join(name);
        fixtures::directory(&path);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            SessionStore::open(fixture.root.clone())
                .await
                .unwrap_err()
                .code(),
            "storage.unavailable"
        );
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o7777,
            0o755
        );
        assert!(!fixture.catalog().exists());
    }
    for name in [
        "storage.lock",
        "catalog.sqlite3",
        "catalog.sqlite3-wal",
        "catalog.sqlite3-shm",
        "catalog.sqlite3-journal",
    ] {
        let fixture = Fixture::new();
        fixtures::directory(&fixture.root);
        let path = fixture.root.join(name);
        fixtures::file(&path, b"synthetic-private-file-canary");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            SessionStore::open(fixture.root.clone())
                .await
                .unwrap_err()
                .code(),
            "storage.unavailable"
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
            0o644
        );
        assert_eq!(fs::read(path).unwrap(), b"synthetic-private-file-canary");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn storage_selected_root_alias_converges_but_managed_links_are_preserved_and_rejected() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let alias = fixture.temp.path().join("alias");
    symlink(&fixture.root, &alias).unwrap();
    assert_eq!(
        SessionStore::open(alias.clone()).await.unwrap_err().code(),
        "storage.busy"
    );
    store.close().await.unwrap();
    SessionStore::open(alias)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    for name in [
        "storage.lock",
        "catalog.sqlite3",
        "catalog.sqlite3-wal",
        "catalog.sqlite3-shm",
        "catalog.sqlite3-journal",
        "sessions",
    ] {
        let fixture = Fixture::new();
        fixtures::directory(&fixture.root);
        let target = fixture.temp.path().join("untouched-target");
        fixtures::file(&target, b"synthetic-link-target-canary");
        let path = fixture.root.join(name);
        symlink(&target, &path).unwrap();
        assert_eq!(
            SessionStore::open(fixture.root.clone())
                .await
                .unwrap_err()
                .code(),
            "storage.unavailable"
        );
        assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(target).unwrap(), b"synthetic-link-target-canary");
    }
}

#[cfg(windows)]
#[tokio::test]
async fn storage_windows_sessions_junction_is_preserved_and_rejected() {
    use std::{os::windows::fs::MetadataExt, process::Command};

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    let fixture = Fixture::new();
    fixtures::directory(&fixture.root);
    let target = fixture.temp.path().join("outside");
    fixtures::directory(&target);
    let sentinel = target.join("sentinel");
    fixtures::file(&sentinel, b"synthetic-junction-target-canary");
    let path = fixture.root.join("sessions");
    let system_root = std::env::var_os("SystemRoot").expect("Windows SystemRoot must be set");
    let output = Command::new("cmd.exe")
        .env_clear()
        .env("SystemRoot", system_root)
        .args(["/D", "/C", "mklink", "/J"])
        .arg(&path)
        .arg(&target)
        .output()
        .expect("Windows junction fixture must be created");
    assert!(output.status.success(), "mklink /J failed: {output:?}");
    let metadata = fs::symlink_metadata(&path).unwrap();
    assert_ne!(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT, 0);
    assert!(fs::metadata(&path).unwrap().is_dir());
    assert_eq!(path.canonicalize().unwrap(), target.canonicalize().unwrap());
    let link_target = fs::read_link(&path).unwrap();

    assert_eq!(
        SessionStore::open(fixture.root.clone())
            .await
            .unwrap_err()
            .code(),
        "storage.unavailable"
    );
    let preserved = fs::symlink_metadata(&path).unwrap();
    assert_ne!(
        preserved.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT,
        0
    );
    assert_eq!(preserved.creation_time(), metadata.creation_time());
    assert_eq!(fs::read_link(&path).unwrap(), link_target);
    assert_eq!(
        fs::read(sentinel).unwrap(),
        b"synthetic-junction-target-canary"
    );
    assert_eq!(fs::read_dir(target).unwrap().count(), 1);
    assert!(!fixture.catalog().exists());
}

#[cfg(windows)]
#[tokio::test]
async fn storage_windows_managed_file_reparse_points_are_preserved_and_rejected() {
    use std::os::windows::fs::{MetadataExt, symlink_file};

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    for name in [
        "storage.lock",
        "catalog.sqlite3",
        "catalog.sqlite3-wal",
        "catalog.sqlite3-shm",
        "catalog.sqlite3-journal",
    ] {
        let fixture = Fixture::new();
        fixtures::directory(&fixture.root);
        let outside = fixture.temp.path().join("outside");
        fixtures::directory(&outside);
        let target = outside.join("sentinel");
        fixtures::file(&target, b"synthetic-reparse-target-canary");
        let path = fixture.root.join(name);
        symlink_file(&target, &path).expect("Windows file symlink fixture must be created");
        let metadata = fs::symlink_metadata(&path).unwrap();
        assert_ne!(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT, 0);
        assert!(metadata.file_type().is_symlink());
        assert_eq!(path.canonicalize().unwrap(), target.canonicalize().unwrap());
        let link_target = fs::read_link(&path).unwrap();

        assert_eq!(
            SessionStore::open(fixture.root.clone())
                .await
                .unwrap_err()
                .code(),
            "storage.unavailable",
            "{name}"
        );
        let preserved = fs::symlink_metadata(&path).unwrap();
        assert_ne!(
            preserved.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT,
            0
        );
        assert_eq!(preserved.creation_time(), metadata.creation_time());
        assert_eq!(fs::read_link(&path).unwrap(), link_target);
        assert_eq!(
            fs::read(target).unwrap(),
            b"synthetic-reparse-target-canary"
        );
        assert_eq!(fs::read_dir(outside).unwrap().count(), 1);
        if name != "catalog.sqlite3" {
            assert!(!fixture.catalog().exists());
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn storage_special_files_and_hardlinks_are_rejected_without_opening_them() {
    use std::os::unix::net::UnixListener;

    for name in [
        "storage.lock",
        "catalog.sqlite3",
        "catalog.sqlite3-wal",
        "catalog.sqlite3-shm",
        "catalog.sqlite3-journal",
    ] {
        let fixture = Fixture::new();
        fixtures::directory(&fixture.root);
        let path = fixture.root.join(name);
        let socket = UnixListener::bind(&path).unwrap();
        assert_eq!(
            SessionStore::open(fixture.root.clone())
                .await
                .unwrap_err()
                .code(),
            "storage.unavailable"
        );
        assert!(fs::symlink_metadata(path).is_ok());
        drop(socket);
    }
    for name in ["storage.lock", "catalog.sqlite3"] {
        let fixture = Fixture::new();
        fixtures::directory(&fixture.root);
        let target = fixture.temp.path().join("hardlink-target");
        fixtures::file(&target, b"synthetic-hardlink-canary");
        fs::hard_link(&target, fixture.root.join(name)).unwrap();
        assert_eq!(
            SessionStore::open(fixture.root.clone())
                .await
                .unwrap_err()
                .code(),
            "storage.unavailable"
        );
        assert_eq!(fs::read(target).unwrap(), b"synthetic-hardlink-canary");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn storage_missing_catalog_checks_canonical_directory_links_without_following_them() {
    use std::os::unix::fs::symlink;

    for name in [
        "sessions/ab",
        "sessions/ab/ab123456-789a-4bcd-8abc-0123456789ab",
    ] {
        let fixture = Fixture::new();
        let path = fixture.root.join(name);
        fixtures::directory(path.parent().unwrap());
        let target = fixture.temp.path().join("outside");
        fixtures::directory(&target);
        symlink(&target, &path).unwrap();
        let store = SessionStore::open(fixture.root.clone()).await.unwrap();
        assert_eq!(
            store.list_sessions(None, 1).await.unwrap_err().code(),
            "storage.catalog_repair_required"
        );
        assert!(fixture.catalog().exists());
        assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_dir(target).unwrap().count(), 0);
        store.close().await.unwrap();
    }
}
