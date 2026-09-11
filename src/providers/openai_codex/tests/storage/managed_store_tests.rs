use super::managed_store::{Profile, Store};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
};
fn profile() -> Profile {
    Profile {
        incarnation: uuid::Uuid::new_v4().to_string(),
        account: "synthetic-account".into(),
        access: "synthetic-access".into(),
        refresh: "synthetic-refresh".into(),
        expires: u64::MAX,
        enabled: true,
        reauth: false,
    }
}
fn initialized() -> (tempfile::TempDir, Store) {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::synthetic(temp.path().join("wi/auth"));
    let lock = store.locked(true).unwrap();
    let mut doc = lock.read().unwrap();
    doc.profiles.insert("a".into(), profile());
    lock.write(&doc).unwrap();
    (temp, store)
}
#[test]
fn store_absence_is_read_only_but_existing_unsafe_paths_fail() {
    for suffix in ["missing-xdg/wi/auth", "missing-home/.config/wi/auth"] {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::synthetic(temp.path().join(suffix));
        assert!(store.read().unwrap().profiles.is_empty());
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
        assert!(store.locked(false).is_err());
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("wi/auth");
    fs::create_dir(temp.path().join("wi")).unwrap();
    fs::set_permissions(temp.path().join("wi"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let store = Store::synthetic(root.clone());
    assert!(store.read().unwrap().profiles.is_empty());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(store.read().is_err());
    assert_eq!(fs::metadata(&root).unwrap().mode() & 0o777, 0o755);
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let path = root.join("openai-codex.json");
    fs::write(&path, br#"{"version":1,"profiles":{}}"#).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(store.read().is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(!root.join("update.lock").exists());
    fs::remove_file(&path).unwrap();
    symlink(root.join("missing"), &path).unwrap();
    assert!(store.read().is_err());
    fs::remove_file(&path).unwrap();
    symlink(root.join("missing"), root.join("update.lock")).unwrap();
    assert!(store.read().is_err());
}
#[test]
fn store_guard_creation_failures_block_visible_incarnation() {
    for phase in ["guard-file-sync", "guard-directory-sync"] {
        let (_temp, store) = initialized();
        let lock = store.locked(false).unwrap();
        let doc = lock.read().unwrap();
        super::managed_store::fail_next(phase);
        assert!(lock.guard("a", &doc.profiles["a"].incarnation).is_err());
        drop(lock);
        assert!(store.read().unwrap().profiles["a"].reauth);
    }
}
#[test]
fn store_child_process_update() {
    let Some(root) = std::env::var_os("WI_SYNTHETIC_STORE") else {
        return;
    };
    let name = std::env::var("WI_SYNTHETIC_PROFILE").unwrap();
    let store = Store::synthetic(root.into());
    let lock = store.locked(false).unwrap();
    let mut doc = lock.read().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    doc.profiles.insert(name, profile());
    lock.write(&doc).unwrap();
}
#[test]
fn store_cross_process_updates_preserve_unrelated_profiles() {
    let (temp, store) = initialized();
    let children: Vec<_> = (0..4)
        .map(|i| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .env_clear()
                .env("WI_SYNTHETIC_STORE", temp.path().join("wi/auth"))
                .env("WI_SYNTHETIC_PROFILE", format!("child{i}"))
                .args([
                    "--exact",
                    "providers::openai_codex::managed_store_tests::store_child_process_update",
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap()
        })
        .collect();
    for mut child in children {
        assert!(child.wait().unwrap().success());
    }
    assert_eq!(store.read().unwrap().profiles.len(), 5);
}
#[test]
fn store_private_creation_and_unrelated_concurrent_updates() {
    let (temp, store) = initialized();
    let path = temp.path().join("wi/auth/openai-codex.json");
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    assert_eq!(
        fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777,
        0o700
    );
    let threads: Vec<_> = (0..8)
        .map(|i| {
            let store = store.clone();
            std::thread::spawn(move || {
                let lock = store.locked(false).unwrap();
                let mut doc = lock.read().unwrap();
                doc.profiles.insert(format!("profile{i}"), profile());
                lock.write(&doc).unwrap();
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(store.read().unwrap().profiles.len(), 9);
}
#[test]
fn store_rejects_permissions_symlinks_hardlinks_and_size() {
    for case in [
        "mode",
        "directory",
        "symlink",
        "hardlink",
        "size",
        "version",
    ] {
        let (temp, store) = initialized();
        let path = temp.path().join("wi/auth/openai-codex.json");
        match case {
            "mode" => fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap(),
            "directory" => {
                fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o755))
                    .unwrap()
            }
            "symlink" => {
                let target = temp.path().join("synthetic-target");
                fs::rename(&path, &target).unwrap();
                symlink(&target, &path).unwrap();
            }
            "hardlink" => fs::hard_link(&path, temp.path().join("synthetic-link")).unwrap(),
            "size" => fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(1024 * 1024 + 1)
                .unwrap(),
            "version" => fs::write(&path, br#"{"version":2,"profiles":{}}"#).unwrap(),
            _ => unreachable!(),
        }
        assert!(store.read().is_err(), "{case}");
    }
}
#[test]
fn store_oversized_atomic_update_preserves_original() {
    let (temp, store) = initialized();
    let path = temp.path().join("wi/auth/openai-codex.json");
    let original = fs::read(&path).unwrap();
    let lock = store.locked(false).unwrap();
    let mut doc = lock.read().unwrap();
    doc.profiles.get_mut("a").unwrap().refresh = "synthetic".repeat(200000);
    assert!(lock.write(&doc).is_err());
    assert_eq!(original, fs::read(&path).unwrap());
}
#[test]
fn store_parent_symlink_is_rejected_without_target_writes() {
    let temp = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    symlink(target.path(), temp.path().join("wi")).unwrap();
    let store = Store::synthetic(temp.path().join("wi/auth"));
    assert!(store.locked(true).is_err());
    assert_eq!(fs::read_dir(target.path()).unwrap().count(), 0);
}
