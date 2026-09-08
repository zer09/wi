//! Private Linux file storage. No ambient external credential discovery.
use super::profile_selection::ProfileMetadata;
#[cfg(target_os = "linux")]
use super::profile_selection::validate_name;
use crate::{GatewayError, Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};
use zeroize::Zeroize;

#[cfg(target_os = "linux")]
const LIMIT: usize = 1024 * 1024;
fn storage_error() -> GatewayError {
    GatewayError::InvalidAuth("Wi auth store unavailable or unsafe")
}

// Never derive Debug: both tokens and provider identity are private.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Profile {
    pub incarnation: String,
    pub account: String,
    pub access: String,
    pub refresh: String,
    pub expires: u64,
    pub enabled: bool,
    pub reauth: bool,
}
impl Drop for Profile {
    fn drop(&mut self) {
        self.access.zeroize();
        self.refresh.zeroize();
    }
}
impl Profile {
    pub fn metadata(&self, name: &str) -> ProfileMetadata {
        ProfileMetadata {
            name: name.into(),
            enabled: self.enabled,
            logged_in: !self.access.is_empty() && !self.refresh.is_empty(),
            requires_reauthentication: self.reauth,
            expires_at_unix: self.expires,
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Document {
    version: u32,
    pub profiles: BTreeMap<String, Profile>,
}
impl Default for Document {
    fn default() -> Self {
        Self {
            version: 1,
            profiles: BTreeMap::new(),
        }
    }
}
impl Document {
    #[cfg(target_os = "linux")]
    fn validate(&self) -> Result<()> {
        if self.version != 1 {
            return Err(storage_error());
        }
        for (name, p) in &self.profiles {
            validate_name(name)?;
            if uuid::Uuid::parse_str(&p.incarnation).is_err()
                || p.account.trim().is_empty()
                || p.access.is_empty()
                || p.refresh.is_empty()
                || p.expires == 0
            {
                return Err(storage_error());
            }
            reqwest::header::HeaderValue::from_str(&p.account).map_err(|_| storage_error())?;
            reqwest::header::HeaderValue::from_str(&p.access).map_err(|_| storage_error())?;
        }
        Ok(())
    }
}
#[derive(Clone)]
pub(super) struct Store {
    root: PathBuf,
}
impl Store {
    pub fn default_location() -> Result<Self> {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .filter(|v| !v.is_empty())
                    .map(|v| PathBuf::from(v).join(".config"))
            })
            .ok_or(GatewayError::HomeUnavailable)?;
        if !base.is_absolute() {
            return Err(storage_error());
        }
        Ok(Self {
            root: base.join("wi/auth"),
        })
    }
    #[cfg(all(test, target_os = "linux"))]
    pub fn synthetic(root: PathBuf) -> Self {
        Self { root }
    }
    pub fn read(&self) -> Result<Document> {
        match platform::open_read(&self.root)? {
            Some(lock) => lock.read(),
            None => Ok(Document::default()),
        }
    }
    pub fn locked_read(&self) -> Result<Option<platform::LockedStore>> {
        platform::open_read(&self.root)
    }
    pub fn locked(&self, create: bool) -> Result<platform::LockedStore> {
        platform::open(&self.root, create)
    }
    pub fn locked_login(&self) -> Result<platform::LockedStore> {
        platform::open_login(&self.root)
    }
}

#[cfg(all(test, target_os = "linux"))]
pub(super) use platform::fail_next;

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use rustix::fs::{self, Mode, OFlags};
    use std::{
        fs::File,
        io::{Read, Write},
        os::unix::fs::MetadataExt,
        path::{Component, Path},
    };
    pub(crate) struct LockedStore {
        directory: File,
        _lock: File,
    }
    fn open_at(parent: &File, name: &std::ffi::OsStr, flags: OFlags, mode: Mode) -> Result<File> {
        fs::openat(
            parent,
            name,
            flags | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            mode,
        )
        .map(File::from)
        .map_err(|_| storage_error())
    }
    fn private(file: &File, directory: bool) -> Result<()> {
        let meta = file.metadata().map_err(|_| storage_error())?;
        if meta.uid() != rustix::process::geteuid().as_raw()
            || meta.mode() & 0o7777 != if directory { 0o700 } else { 0o600 }
            || if directory {
                !meta.is_dir()
            } else {
                !meta.is_file() || meta.nlink() != 1
            }
        {
            return Err(storage_error());
        }
        Ok(())
    }
    #[cfg(test)]
    thread_local! {
        static FAULT: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
    }
    #[cfg(test)]
    pub(crate) fn fail_next(phase: &'static str) {
        FAULT.set(Some(phase));
    }
    fn phase(_phase: &str) -> Result<()> {
        #[cfg(test)]
        if FAULT.get() == Some(_phase) {
            FAULT.set(None);
            return Err(storage_error());
        }
        Ok(())
    }
    pub(super) fn open(path: &Path, create: bool) -> Result<LockedStore> {
        open_inner(path, create, false, false)?.ok_or_else(storage_error)
    }
    pub(super) fn open_read(path: &Path) -> Result<Option<LockedStore>> {
        open_inner(path, false, true, false)
    }
    pub(super) fn open_login(path: &Path) -> Result<LockedStore> {
        open_inner(path, true, false, true)?.ok_or_else(storage_error)
    }
    fn open_inner(
        path: &Path,
        create: bool,
        absent_ok: bool,
        nonblocking: bool,
    ) -> Result<Option<LockedStore>> {
        if !path.is_absolute() {
            return Err(storage_error());
        }
        let mut directory = File::open("/").map_err(|_| storage_error())?;
        let components: Vec<_> = path.components().collect();
        for (index, component) in components.iter().enumerate().skip(1) {
            let Component::Normal(name) = component else {
                return Err(storage_error());
            };
            let managed = index >= components.len().saturating_sub(2);
            if create {
                match fs::mkdirat(&directory, *name, Mode::from_raw_mode(0o700)) {
                    Ok(()) => directory.sync_all().map_err(|_| storage_error())?,
                    Err(rustix::io::Errno::EXIST) => (),
                    Err(_) => return Err(storage_error()),
                }
            }
            // Descriptor-relative traversal rejects symlinks at every component.
            directory = match fs::openat(
                &directory,
                *name,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            ) {
                Ok(fd) => File::from(fd),
                Err(rustix::io::Errno::NOENT) if absent_ok => return Ok(None),
                Err(_) => return Err(storage_error()),
            };
            if managed {
                private(&directory, true)?;
            }
        }
        let flags = OFlags::RDWR
            | OFlags::NONBLOCK
            | if create {
                OFlags::CREATE
            } else {
                OFlags::empty()
            };
        if nonblocking
            && matches!(
                fs::statat(&directory, "update.lock", fs::AtFlags::SYMLINK_NOFOLLOW),
                Err(rustix::io::Errno::NOENT)
            )
            && !matches!(
                fs::statat(
                    &directory,
                    "openai-codex.json",
                    fs::AtFlags::SYMLINK_NOFOLLOW
                ),
                Err(rustix::io::Errno::NOENT)
            )
        {
            return Err(storage_error());
        }
        let lock = match fs::openat(
            &directory,
            "update.lock",
            flags | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from_raw_mode(0o600),
        ) {
            Ok(fd) => File::from(fd),
            Err(rustix::io::Errno::NOENT) if absent_ok => {
                // Only NOENT is absence; a dangling symlink or document without a lock is unsafe.
                return match fs::statat(
                    &directory,
                    "openai-codex.json",
                    fs::AtFlags::SYMLINK_NOFOLLOW,
                ) {
                    Err(rustix::io::Errno::NOENT) => Ok(None),
                    _ => Err(storage_error()),
                };
            }
            Err(_) => return Err(storage_error()),
        };
        private(&lock, false)?;
        // The lock file is stable and is never replaced or deleted.
        let operation = if nonblocking {
            fs::FlockOperation::NonBlockingLockExclusive
        } else {
            fs::FlockOperation::LockExclusive
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            match fs::flock(&lock, operation) {
                Ok(()) => break,
                Err(rustix::io::Errno::WOULDBLOCK)
                    if nonblocking && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(_) => return Err(storage_error()),
            }
        }
        Ok(Some(LockedStore {
            directory,
            _lock: lock,
        }))
    }
    impl LockedStore {
        pub fn read(&self) -> Result<Document> {
            let file = match fs::openat(
                &self.directory,
                "openai-codex.json",
                OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            ) {
                Ok(fd) => File::from(fd),
                Err(rustix::io::Errno::NOENT) => return Ok(Document::default()),
                Err(_) => return Err(storage_error()),
            };
            private(&file, false)?;
            if file.metadata().map_err(|_| storage_error())?.len() > LIMIT as u64 {
                return Err(storage_error());
            }
            let mut bytes = zeroize::Zeroizing::new(Vec::new());
            file.take((LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| storage_error())?;
            if bytes.len() > LIMIT {
                return Err(storage_error());
            }
            let mut doc: Document = serde_json::from_slice(&bytes).map_err(|_| storage_error())?;
            doc.validate()?;
            for (name, p) in &mut doc.profiles {
                match fs::statat(
                    &self.directory,
                    Self::guard_name(name, &p.incarnation),
                    fs::AtFlags::SYMLINK_NOFOLLOW,
                ) {
                    Err(rustix::io::Errno::NOENT) => (),
                    Ok(_) => p.reauth = true,
                    Err(_) => return Err(storage_error()),
                }
            }
            Ok(doc)
        }
        fn guard_name(name: &str, incarnation: &str) -> String {
            format!(".rotation-{name}-{incarnation}")
        }
        pub fn guard(&self, name: &str, incarnation: &str) -> Result<()> {
            validate_name(name)?;
            uuid::Uuid::parse_str(incarnation).map_err(|_| storage_error())?;
            let file = open_at(
                &self.directory,
                Self::guard_name(name, incarnation).as_ref(),
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
                Mode::from_raw_mode(0o600),
            )?;
            private(&file, false)?;
            phase("guard-file-sync")?;
            file.sync_all().map_err(|_| storage_error())?;
            phase("guard-directory-sync")?;
            self.directory.sync_all().map_err(|_| storage_error())
        }
        pub fn finish_guard(&self, name: &str, incarnation: &str) {
            // The JSON commit is already durable. Cleanup cannot turn it into a failed rotation.
            if phase("guard-unlink").is_ok() {
                let _ = fs::unlinkat(
                    &self.directory,
                    Self::guard_name(name, incarnation),
                    fs::AtFlags::empty(),
                );
                if phase("guard-cleanup-sync").is_ok() {
                    let _ = self.directory.sync_all();
                }
            }
        }
        pub fn write(&self, doc: &Document) -> Result<()> {
            doc.validate()?;
            self.read()?;
            let bytes =
                zeroize::Zeroizing::new(serde_json::to_vec(doc).map_err(|_| storage_error())?);
            if bytes.len() > LIMIT {
                return Err(storage_error());
            }
            let name = format!(".pending-{}", uuid::Uuid::new_v4());
            let mut file = open_at(
                &self.directory,
                name.as_ref(),
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
                Mode::from_raw_mode(0o600),
            )?;
            let result = (|| {
                private(&file, false)?;
                phase("write")?;
                file.write_all(&bytes).map_err(|_| storage_error())?;
                phase("file-sync")?;
                file.sync_all().map_err(|_| storage_error())?;
                phase("rename")?;
                fs::renameat(&self.directory, &name, &self.directory, "openai-codex.json")
                    .map_err(|_| storage_error())?;
                phase("directory-sync")?;
                self.directory.sync_all().map_err(|_| storage_error())
            })();
            // Remove only this operation's temporary name, never user data.
            let _ = fs::unlinkat(&self.directory, &name, fs::AtFlags::empty());
            result
        }
    }
}
#[cfg(not(target_os = "linux"))]
mod platform {
    use super::*;
    pub(crate) struct LockedStore;
    pub(super) fn open(_: &std::path::Path, _: bool) -> Result<LockedStore> {
        Err(GatewayError::InvalidAuth(
            "Wi managed persistence requires Linux permission controls",
        ))
    }
    pub(super) fn open_login(path: &std::path::Path) -> Result<LockedStore> {
        open(path, true)
    }
    pub(super) fn open_read(path: &std::path::Path) -> Result<Option<LockedStore>> {
        open(path, false).map(Some)
    }
    impl LockedStore {
        pub fn guard(&self, _: &str, _: &str) -> Result<()> {
            Err(storage_error())
        }
        pub fn finish_guard(&self, _: &str, _: &str) {}
        pub fn read(&self) -> Result<Document> {
            Err(storage_error())
        }
        pub fn write(&self, _: &Document) -> Result<()> {
            Err(storage_error())
        }
    }
}
