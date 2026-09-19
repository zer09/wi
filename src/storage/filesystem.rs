use std::{
    fs::{self, File, Metadata, OpenOptions, TryLockError},
    io::ErrorKind,
    path::{Path, PathBuf},
};

use super::{ApplicationSessionId, StorageError, StorageErrorKind};

type Result<T> = std::result::Result<T, StorageError>;

fn io(_: std::io::Error) -> StorageError {
    StorageError::new(StorageErrorKind::Io)
}

fn private(metadata: &Metadata, directory: bool) -> Result<()> {
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err(StorageError::new(StorageErrorKind::Unavailable));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o7077 != 0 || (!directory && metadata.nlink() != 1) {
            return Err(StorageError::new(StorageErrorKind::Unavailable));
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != rustix::process::geteuid().as_raw() {
            return Err(StorageError::new(StorageErrorKind::Unavailable));
        }
    }
    Ok(())
}

pub(super) fn check_directory(path: &Path) -> Result<()> {
    private(&fs::symlink_metadata(path).map_err(io)?, true)
}

pub(super) fn check_file(path: &Path) -> Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            private(&metadata, false)?;
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io(error)),
    }
}

pub(super) fn create_directory(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(io(error)),
    }
    check_directory(path)
}

pub(super) fn resolve_root(root: PathBuf) -> Result<PathBuf> {
    if !root.is_absolute()
        || root.to_str().is_none()
        || root.as_os_str().as_encoded_bytes().contains(&0)
    {
        return Err(StorageError::new(StorageErrorKind::InvalidInput));
    }
    if !root.try_exists().map_err(io)? {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&root).map_err(io)?;
    }
    // Only the explicitly selected root can be an alias. Managed descendants cannot.
    let root = root.canonicalize().map_err(io)?;
    check_directory(&root)?;
    Ok(root)
}

pub(super) fn open_file(path: &Path, create: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options.open(path).map_err(io)?;
    private(&file.metadata().map_err(io)?, false)?;
    Ok(file)
}

pub(super) fn acquire_lease(root: &Path) -> Result<File> {
    let path = root.join("storage.lock");
    let missing = check_file(&path)?.is_none();
    // A concurrent first opener may win file creation, but ownership is always the OS lock.
    let file = match open_file(&path, missing) {
        Ok(file) => file,
        Err(error) if missing => {
            if check_file(&path)?.is_none() {
                return Err(error);
            }
            open_file(&path, false)?
        }
        Err(error) => return Err(error),
    };
    file.try_lock().map_err(|error| match error {
        TryLockError::WouldBlock => StorageError::new(StorageErrorKind::Busy),
        TryLockError::Error(_) => StorageError::new(StorageErrorKind::Io),
    })?;
    Ok(file)
}

pub(super) fn check_database(path: &Path) -> Result<Option<Metadata>> {
    let metadata = check_file(path)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        if check_file(Path::new(&sidecar))?.is_some() && metadata.is_none() {
            // An orphan WAL must not be attached to a newly initialized catalog.
            return Err(StorageError::new(StorageErrorKind::Integrity));
        }
    }
    Ok(metadata)
}

pub(super) fn session_relative_path(id: &ApplicationSessionId) -> String {
    format!(
        "sessions/{}/{}/session.sqlite3",
        &id.as_str()[..2],
        id.as_str()
    )
}

pub(super) fn session_path(
    root: &Path,
    id: &ApplicationSessionId,
    creating: bool,
) -> Result<PathBuf> {
    check_directory(root)?;
    let mut path = root.to_path_buf();
    for part in ["sessions", &id.as_str()[..2], id.as_str()] {
        path.push(part);
        if creating {
            create_directory(&path)?;
        } else {
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                if error.kind() == ErrorKind::NotFound {
                    StorageError::new(StorageErrorKind::NotFound)
                } else {
                    io(error)
                }
            })?;
            private(&metadata, true)?;
        }
    }
    path.push("session.sqlite3");
    check_database(&path)?;
    Ok(path)
}

pub(super) fn surviving_sessions(sessions: &Path) -> Result<bool> {
    let mut found = false;
    for bucket in fs::read_dir(sessions).map_err(io)? {
        let bucket = bucket.map_err(io)?;
        let name = bucket.file_name();
        let Some(prefix) = name.to_str() else {
            continue;
        };
        if prefix.len() != 2
            || !prefix
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            continue;
        }
        match check_directory(&bucket.path()) {
            Ok(()) => {}
            Err(error) if error.kind() == StorageErrorKind::Unavailable => {
                // A substituted bucket is repair evidence, not permission to follow it.
                found = true;
                continue;
            }
            Err(error) => return Err(error),
        }
        for entry in fs::read_dir(bucket.path()).map_err(io)? {
            let entry = entry.map_err(io)?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Ok(id) = name.parse::<ApplicationSessionId>() else {
                continue;
            };
            if !id.as_str().starts_with(prefix) {
                continue;
            }
            match check_directory(&entry.path()) {
                Ok(()) => {}
                Err(error) if error.kind() == StorageErrorKind::Unavailable => {}
                Err(error) => return Err(error),
            }
            found = true;
        }
    }
    Ok(found)
}
