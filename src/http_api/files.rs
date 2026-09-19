use std::{fs, fs::File, fs::Metadata, fs::OpenOptions, path::Path};

fn acceptable(meta: &Metadata, private: bool) -> bool {
    if !meta.is_file() || is_link(meta) {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if private && meta.permissions().mode() & 0o077 != 0 {
            return false;
        }
    }
    #[cfg(not(unix))]
    let _ = private;
    true
}

fn is_link(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    meta.file_type().is_symlink()
}

pub(super) fn open_regular(path: &Path, private: bool) -> Result<File, ()> {
    if !acceptable(&fs::symlink_metadata(path).map_err(|_| ())?, private) {
        return Err(());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A replacement link or FIFO must not redirect or block the startup read.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).map_err(|_| ())?;
    if !acceptable(&file.metadata().map_err(|_| ())?, private) {
        return Err(());
    }
    Ok(file)
}
