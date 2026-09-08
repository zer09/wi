//! Wi-owned profiles with guarded experimental credential renewal.
use super::{
    auth::{CredentialSource, SubscriptionCredentials},
    managed_store::{Profile, Store},
    profile_selection::{ProfileMetadata, select_profile, validate_name},
};
use crate::{GatewayError, Result};
use async_trait::async_trait;
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(all(test, target_os = "linux"))]
const OAUTH_CONFIGURATION_BLOCKER: &str = "synthetic renewal is unconfigured";
#[cfg(all(test, target_os = "linux"))]
fn production_oauth_blocker() -> Result<()> {
    Err(GatewayError::InvalidAuth(OAUTH_CONFIGURATION_BLOCKER))
}
fn now() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| GatewayError::Clock)?
        .as_secs())
}

// Only a reviewed provider-local exchange may attest identity. JWT hints are not used here.
#[async_trait]
pub(super) trait Exchange: Send + Sync {
    fn configured(&self) -> Result<()>;
    async fn refresh(&self, refresh: &str) -> Result<Profile>;
}
#[cfg(all(test, target_os = "linux"))]
struct Unconfigured;
#[cfg(all(test, target_os = "linux"))]
#[async_trait]
impl Exchange for Unconfigured {
    fn configured(&self) -> Result<()> {
        production_oauth_blocker()
    }
    async fn refresh(&self, _: &str) -> Result<Profile> {
        Err(GatewayError::InvalidAuth(OAUTH_CONFIGURATION_BLOCKER))
    }
}
#[derive(Clone)]
pub struct AuthManager {
    store: Store,
    exchange: Arc<dyn Exchange>,
}
impl AuthManager {
    pub fn default_location() -> Result<Self> {
        Ok(Self {
            store: Store::default_location()?,
            exchange: Arc::new(super::refresh::RefreshExchange::default()),
        })
    }
    pub fn list(&self) -> Result<Vec<ProfileMetadata>> {
        Ok(self
            .store
            .read()?
            .profiles
            .iter()
            .map(|(name, p)| p.metadata(name))
            .collect())
    }
    pub fn status(&self, name: &str) -> Result<ProfileMetadata> {
        validate_name(name)?;
        self.list()?
            .into_iter()
            .find(|p| p.name == name)
            .ok_or(GatewayError::InvalidAuth("Wi profile does not exist"))
    }
    pub fn logout(&self, name: &str) -> Result<()> {
        validate_name(name)?;
        let lock = self
            .store
            .locked_read()?
            .ok_or(GatewayError::InvalidAuth("Wi profile does not exist"))?;
        let mut doc = lock.read()?;
        let removed = doc
            .profiles
            .remove(name)
            .ok_or(GatewayError::InvalidAuth("Wi profile does not exist"))?;
        lock.write(&doc)?;
        lock.finish_guard(name, &removed.incarnation);
        Ok(())
    }
    pub async fn refresh(&self, name: &str) -> Result<()> {
        // This gate precedes any store read, including refresh secrets.
        self.exchange.configured()?;
        let source = self.select(Some(name))?;
        source.prepare(true).await
    }
    pub fn select(&self, explicit: Option<&str>) -> Result<ManagedCredentials> {
        if let Some(name) = explicit {
            validate_name(name)?;
        }
        let doc = self.store.read()?;
        let metadata: Vec<_> = doc.profiles.iter().map(|(n, p)| p.metadata(n)).collect();
        let name = select_profile(&metadata, explicit, || {
            use ring::rand::SecureRandom;
            let mut bytes = [0; 8];
            ring::rand::SystemRandom::new()
                .fill(&mut bytes)
                .map_err(|_| GatewayError::InvalidAuth("secure randomness unavailable"))?;
            Ok(u64::from_le_bytes(bytes))
        })?;
        let p = &doc.profiles[&name];
        Ok(ManagedCredentials {
            manager: self.clone(),
            name,
            incarnation: p.incarnation.clone(),
            account: p.account.clone(),
        })
    }
    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn synthetic(store: Store, exchange: Arc<dyn Exchange>) -> Self {
        Self { store, exchange }
    }
    pub(super) fn preflight_login(&self, name: &str, replace: bool) -> Result<()> {
        validate_name(name)?;
        let lock = self.store.locked_login()?;
        if lock.read()?.profiles.contains_key(name) && !replace {
            return Err(GatewayError::InvalidAuth(
                "profile exists; explicit replacement required",
            ));
        }
        Ok(())
    }
    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn login(&self, name: &str, profile: Profile, replace: bool) -> Result<bool> {
        self.login_before(
            name,
            profile,
            replace,
            std::time::Instant::now() + std::time::Duration::from_secs(180),
        )
    }
    pub(super) fn login_before(
        &self,
        name: &str,
        mut profile: Profile,
        replace: bool,
        deadline: std::time::Instant,
    ) -> Result<bool> {
        validate_name(name)?;
        let lock = self.store.locked_login()?;
        if std::time::Instant::now() >= deadline {
            return Err(GatewayError::InvalidAuth(
                "experimental browser login timed out",
            ));
        }
        let mut doc = lock.read()?;
        if doc.profiles.contains_key(name) && !replace {
            return Err(GatewayError::InvalidAuth(
                "profile exists; explicit replacement required",
            ));
        }
        profile.incarnation = uuid::Uuid::new_v4().to_string();
        let incarnation = profile.incarnation.clone();
        // Guard only the candidate: a failed replacement must not disable the old login.
        lock.guard(name, &incarnation)?;
        let previous = doc.profiles.insert(name.into(), profile);
        if std::time::Instant::now() >= deadline {
            return Err(GatewayError::InvalidAuth(
                "experimental browser login timed out",
            ));
        }
        lock.write(&doc)?;
        lock.finish_guard(name, &incarnation);
        if let Some(previous) = previous {
            lock.finish_guard(name, &previous.incarnation);
        }
        Ok(lock
            .read()
            .map(|doc| !doc.profiles[name].reauth)
            .unwrap_or(false))
    }
}

#[derive(Clone)]
pub struct ManagedCredentials {
    manager: AuthManager,
    name: String,
    incarnation: String,
    account: String,
}
impl ManagedCredentials {
    pub fn selected_profile(&self) -> &str {
        &self.name
    }
    fn bound<'a>(&self, doc: &'a super::managed_store::Document) -> Result<&'a Profile> {
        let p = doc
            .profiles
            .get(&self.name)
            .ok_or(GatewayError::AuthAccountChanged)?;
        if p.incarnation != self.incarnation || p.account != self.account {
            return Err(GatewayError::AuthAccountChanged);
        }
        if !p.enabled || p.reauth {
            return Err(GatewayError::InvalidAuth(
                "selected Wi profile requires login",
            ));
        }
        Ok(p)
    }
    async fn prepare(&self, force: bool) -> Result<()> {
        let store = self.manager.store.clone();
        let doc = tokio::task::spawn_blocking(move || store.read())
            .await
            .map_err(|_| GatewayError::InvalidAuth("auth read worker failed"))??;
        let p = self.bound(&doc)?;
        if !force && p.expires > now()?.saturating_add(30) {
            return Ok(());
        }
        self.manager.exchange.configured()?;
        let source = self.clone();
        let runtime = tokio::runtime::Handle::current();
        // A blocking worker owns the lock and exchange until persistence, even if its waiter is dropped.
        tokio::task::spawn_blocking(move || {
            let lock = source.manager.store.locked(false)?;
            let mut doc = lock.read()?;
            let p = source.bound(&doc)?;
            if !force && p.expires > now()?.saturating_add(30) {
                return Ok(());
            }
            let refresh = zeroize::Zeroizing::new(p.refresh.clone());
            // The separate durable guard survives replacement of the token document.
            lock.guard(&source.name, &source.incarnation)?;
            let mut rotated = runtime.block_on(async {
                tokio::time::timeout(
                    std::time::Duration::from_secs(60),
                    source.manager.exchange.refresh(&refresh),
                )
                .await
                .map_err(|_| GatewayError::InvalidAuth("renewal timed out; login required"))?
            })?;
            if rotated.account != source.account
                || rotated.expires <= now()?.saturating_add(30)
                || rotated.refresh.is_empty()
                || rotated.access.is_empty()
            {
                return Err(GatewayError::InvalidAuth(
                    "renewal identity or token validation failed; login required",
                ));
            }
            rotated.incarnation = source.incarnation.clone();
            rotated.enabled = true;
            rotated.reauth = false;
            doc.profiles.insert(source.name.clone(), rotated);
            lock.write(&doc)?;
            lock.finish_guard(&source.name, &source.incarnation);
            Ok(())
        })
        .await
        .map_err(|_| GatewayError::InvalidAuth("renewal worker failed; login required"))?
    }
}
#[async_trait]
impl CredentialSource for ManagedCredentials {
    async fn prepare_submission(&self) -> Result<()> {
        self.prepare(false).await
    }
    async fn load(&self) -> Result<SubscriptionCredentials> {
        let store = self.manager.store.clone();
        let doc = tokio::task::spawn_blocking(move || store.read())
            .await
            .map_err(|_| GatewayError::InvalidAuth("auth read worker failed"))??;
        let p = self.bound(&doc)?;
        SubscriptionCredentials::from_access_token(
            p.access.clone(),
            Some(p.account.clone()),
            Some(p.expires),
        )
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    pub(super) fn profile(account: &str, expires: u64) -> Profile {
        Profile {
            incarnation: uuid::Uuid::new_v4().to_string(),
            account: account.into(),
            access: "synthetic-access".into(),
            refresh: "synthetic-refresh".into(),
            expires,
            enabled: true,
            reauth: false,
        }
    }
    #[test]
    fn managed_logout_preserves_missing_alias_bytes_and_unrelated_profiles() {
        use std::{fs, os::unix::fs::MetadataExt};

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("wi/auth");
        let manager =
            AuthManager::synthetic(Store::synthetic(root.clone()), Arc::new(Unconfigured));
        for name in ["a", "b"] {
            manager
                .login(name, profile("synthetic-account", u64::MAX), false)
                .unwrap();
        }
        let path = root.join("openai-codex.json");
        let before = fs::read(&path).unwrap();
        let original: serde_json::Value = serde_json::from_slice(&before).unwrap();
        let lock_inode = fs::metadata(root.join("update.lock")).unwrap().ino();
        assert_eq!(
            manager.logout("missing").unwrap_err().to_string(),
            GatewayError::InvalidAuth("Wi profile does not exist").to_string()
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        manager.logout("a").unwrap();
        let after: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(after["profiles"].as_object().unwrap().len(), 1);
        assert_eq!(after["profiles"]["b"], original["profiles"]["b"]);
        assert_eq!(
            fs::metadata(root.join("update.lock")).unwrap().ino(),
            lock_inode
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
    }
    #[test]
    fn managed_logout_rejects_unsafe_and_malformed_documents_without_writes() {
        use std::{fs, os::unix::fs::PermissionsExt};

        for case in ["mode", "symlink", "hardlink", "malformed"] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("wi/auth");
            let manager =
                AuthManager::synthetic(Store::synthetic(root.clone()), Arc::new(Unconfigured));
            manager
                .login("a", profile("synthetic-account", u64::MAX), false)
                .unwrap();
            let path = root.join("openai-codex.json");
            match case {
                "mode" => fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap(),
                "symlink" => {
                    let target = temp.path().join("synthetic-target");
                    fs::rename(&path, &target).unwrap();
                    std::os::unix::fs::symlink(target, &path).unwrap();
                }
                "hardlink" => fs::hard_link(&path, temp.path().join("synthetic-link")).unwrap(),
                "malformed" => fs::write(&path, b"{").unwrap(),
                _ => unreachable!(),
            }
            let before = fs::read(&path).unwrap();
            for name in ["a", "missing"] {
                assert_eq!(
                    manager.logout(name).unwrap_err().to_string(),
                    GatewayError::InvalidAuth("Wi auth store unavailable or unsafe").to_string(),
                    "{case}"
                );
                assert_eq!(fs::read(&path).unwrap(), before);
                assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
            }
        }
    }
    struct FailedExchange(bool);
    #[async_trait]
    impl Exchange for FailedExchange {
        fn configured(&self) -> Result<()> {
            Ok(())
        }
        async fn refresh(&self, _: &str) -> Result<Profile> {
            if self.0 {
                return Ok(profile("different-account", now()? + 3600));
            }
            Err(GatewayError::InvalidAuth("synthetic invalid grant"))
        }
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn renewal_failure_and_identity_mismatch_persist_reauth_before_exchange() {
        for mismatch in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let manager = AuthManager::synthetic(
                Store::synthetic(temp.path().join("wi/auth")),
                Arc::new(FailedExchange(mismatch)),
            );
            manager
                .login("a", profile("synthetic-account", 1), false)
                .unwrap();
            let source = manager.select(Some("a")).unwrap();
            assert!(source.prepare(false).await.is_err());
            assert!(manager.status("a").unwrap().requires_reauthentication);
            assert!(manager.select(None).is_err());
            assert!(source.prepare(false).await.is_err());
        }
    }
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn renewal_concurrent_preparation_rotates_only_once() {
        let temp = tempfile::tempdir().unwrap();
        let exchange = Arc::new(Rotation(AtomicUsize::new(0)));
        let manager = AuthManager::synthetic(
            Store::synthetic(temp.path().join("wi/auth")),
            exchange.clone(),
        );
        manager
            .login("a", profile("synthetic-account", 1), false)
            .unwrap();
        let a = manager.select(Some("a")).unwrap();
        let b = manager.select(Some("a")).unwrap();
        let (a, b) = tokio::join!(a.prepare(false), b.prepare(false));
        a.unwrap();
        b.unwrap();
        assert_eq!(exchange.0.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn renewal_persistence_failure_keeps_fail_closed_marker() {
        struct Oversized;
        #[async_trait]
        impl Exchange for Oversized {
            fn configured(&self) -> Result<()> {
                Ok(())
            }
            async fn refresh(&self, _: &str) -> Result<Profile> {
                let mut p = profile("synthetic-account", now()? + 3600);
                p.refresh = "synthetic-rotated".repeat(100000);
                Ok(p)
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let manager = AuthManager::synthetic(
            Store::synthetic(temp.path().join("wi/auth")),
            Arc::new(Oversized),
        );
        manager
            .login("a", profile("synthetic-account", 1), false)
            .unwrap();
        assert!(manager.refresh("a").await.is_err());
        assert!(manager.status("a").unwrap().requires_reauthentication);
        assert!(manager.select(Some("a")).is_err());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn renewal_cannot_overwrite_concurrent_logout_or_relogin() {
        for replace in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let exchange = Arc::new(Rotation(AtomicUsize::new(0)));
            let manager = AuthManager::synthetic(
                Store::synthetic(temp.path().join("wi/auth")),
                exchange.clone(),
            );
            manager
                .login("a", profile("synthetic-account", 1), false)
                .unwrap();
            let selected = manager.select(Some("a")).unwrap();
            let task_source = selected.clone();
            let renewal = tokio::spawn(async move { task_source.prepare(false).await });
            while exchange.0.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
            let writer = manager.clone();
            tokio::task::spawn_blocking(move || {
                if replace {
                    writer
                        .login("a", profile("new-account", now()? + 3600), true)
                        .map(|_| ())
                } else {
                    writer.logout("a")
                }
            })
            .await
            .unwrap()
            .unwrap();
            renewal.await.unwrap().unwrap();
            assert!(selected.load().await.is_err());
            let doc = manager.store.read().unwrap();
            if replace {
                assert_eq!(doc.profiles["a"].account, "new-account");
            } else {
                assert!(doc.profiles.is_empty());
            }
        }
    }
    #[tokio::test]
    async fn renewal_write_phases_keep_restart_blocked_until_durable_commit() {
        struct FaultExchange(&'static str, AtomicUsize);
        #[async_trait]
        impl Exchange for FaultExchange {
            fn configured(&self) -> Result<()> {
                Ok(())
            }
            async fn refresh(&self, _: &str) -> Result<Profile> {
                self.1.fetch_add(1, Ordering::SeqCst);
                super::super::managed_store::fail_next(self.0);
                let mut p = profile("synthetic-account", now()? + 3600);
                p.refresh = "synthetic-rotated".into();
                Ok(p)
            }
        }
        for phase in [
            "write",
            "file-sync",
            "rename",
            "directory-sync",
            "guard-unlink",
            "guard-cleanup-sync",
            "success",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let store = Store::synthetic(temp.path().join("wi/auth"));
            let exchange = Arc::new(FaultExchange(phase, AtomicUsize::new(0)));
            let manager = AuthManager::synthetic(store.clone(), exchange.clone());
            manager
                .login("a", profile("synthetic-account", 1), false)
                .unwrap();
            manager
                .login("b", profile("other-account", now().unwrap() + 3600), false)
                .unwrap();
            let source = manager.select(Some("a")).unwrap();
            let committed = matches!(phase, "guard-unlink" | "guard-cleanup-sync" | "success");
            assert_eq!(source.prepare(false).await.is_ok(), committed, "{phase}");
            assert_eq!(exchange.1.load(Ordering::SeqCst), 1);
            let fresh = AuthManager::synthetic(store.clone(), exchange.clone());
            let blocked = !committed || phase == "guard-unlink";
            assert_eq!(
                fresh.status("a").unwrap().requires_reauthentication,
                blocked
            );
            assert_eq!(fresh.select(Some("a")).is_err(), blocked);
            assert_eq!(source.load().await.is_err(), blocked);
            assert!(fresh.select(Some("b")).unwrap().load().await.is_ok());
            assert_eq!(
                store.read().unwrap().profiles["b"].refresh,
                "synthetic-refresh"
            );
            if phase == "directory-sync" || committed {
                // Rename visibility is not evidence of durable rollback on an fsync error.
                let bytes = std::fs::read(temp.path().join("wi/auth/openai-codex.json")).unwrap();
                let raw: super::super::managed_store::Document =
                    serde_json::from_slice(&bytes).unwrap();
                assert!(!raw.profiles["a"].reauth);
                assert_eq!(raw.profiles["a"].refresh, "synthetic-rotated");
            }
            if blocked {
                assert!(source.prepare(false).await.is_err());
                assert_eq!(exchange.1.load(Ordering::SeqCst), 1);
                fresh
                    .login(
                        "a",
                        profile("synthetic-account", now().unwrap() + 3600),
                        true,
                    )
                    .unwrap();
                assert!(fresh.select(Some("a")).unwrap().load().await.is_ok());
                fresh.logout("a").unwrap();
                assert!(fresh.select(Some("b")).is_ok());
            }
        }
    }
    struct Rotation(AtomicUsize);
    #[async_trait]
    impl Exchange for Rotation {
        fn configured(&self) -> Result<()> {
            Ok(())
        }
        async fn refresh(&self, _: &str) -> Result<Profile> {
            self.0.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            let mut p = profile("synthetic-account", now()? + 3600);
            p.refresh = "synthetic-rotated".into();
            Ok(p)
        }
    }
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn managed_rotation_survives_cancelled_waiter_and_preserves_profiles() {
        let temp = tempfile::tempdir().unwrap();
        let exchange = Arc::new(Rotation(AtomicUsize::new(0)));
        let manager = AuthManager::synthetic(
            Store::synthetic(temp.path().join("wi/auth")),
            exchange.clone(),
        );
        manager
            .login("a", profile("synthetic-account", 1), false)
            .unwrap();
        manager
            .login("b", profile("other-account", now().unwrap() + 3600), false)
            .unwrap();
        let source = manager.select(Some("a")).unwrap();
        assert!(source.load().await.is_err());
        assert_eq!(exchange.0.load(Ordering::SeqCst), 0);
        let task_source = source.clone();
        let waiter = tokio::spawn(async move { task_source.prepare(false).await });
        while exchange.0.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        waiter.abort();
        // Reading on a blocking worker waits for the auth operation, not the cancelled waiter.
        let check = manager.clone();
        let metadata = tokio::task::spawn_blocking(move || check.list())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(metadata.len(), 2);
        let public = serde_json::to_string(&metadata).unwrap();
        assert!(!public.contains("synthetic-account"));
        assert!(!public.contains("synthetic-access"));
        assert!(!public.contains("synthetic-refresh"));
        assert!(!metadata[0].requires_reauthentication);
        source.load().await.unwrap();
        source.prepare(false).await.unwrap();
        assert_eq!(exchange.0.load(Ordering::SeqCst), 1);
        let doc = manager.store.read().unwrap();
        assert_eq!(doc.profiles["a"].refresh, "synthetic-rotated");
        assert_eq!(doc.profiles["b"].account, "other-account");
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn managed_replacement_and_deletion_invalidate_bound_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let manager = AuthManager::synthetic(
            Store::synthetic(temp.path().join("wi/auth")),
            Arc::new(Unconfigured),
        );
        manager
            .login(
                "a",
                profile("synthetic-account", now().unwrap() + 3600),
                false,
            )
            .unwrap();
        let source = manager.select(Some("a")).unwrap();
        assert!(
            manager
                .login(
                    "a",
                    profile("synthetic-account", now().unwrap() + 3600),
                    false
                )
                .is_err()
        );
        manager
            .login(
                "a",
                profile("synthetic-account", now().unwrap() + 3600),
                true,
            )
            .unwrap();
        assert!(matches!(
            source.load().await,
            Err(GatewayError::AuthAccountChanged)
        ));
        let source = manager.select(Some("a")).unwrap();
        manager.logout("a").unwrap();
        assert!(source.load().await.is_err());
        assert!(manager.list().unwrap().is_empty());
    }
    #[tokio::test]
    async fn managed_production_blocker_precedes_store_reads() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("does-not-exist/wi/auth");
        let manager =
            AuthManager::synthetic(Store::synthetic(path.clone()), Arc::new(Unconfigured));
        assert_eq!(
            manager.refresh("a").await.unwrap_err().to_string(),
            GatewayError::InvalidAuth(OAUTH_CONFIGURATION_BLOCKER).to_string()
        );
        assert!(!path.exists());
        assert!(production_oauth_blocker().is_err());
    }
}
