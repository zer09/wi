use std::{path::Path, time::Duration};

use sqlx::{ConnectOptions, Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};

use super::{StorageError, StorageErrorKind, filesystem, lifecycle::Lifecycle};

type Result<T> = std::result::Result<T, StorageError>;

pub(super) fn error(error: sqlx::Error) -> StorageError {
    let kind = match error {
        sqlx::Error::Database(error) => {
            let code = error.code().and_then(|code| code.parse::<i32>().ok());
            match code.map(|code| code & 0xff) {
                Some(5 | 6) => StorageErrorKind::Busy,
                Some(1 | 11 | 17 | 19 | 26) => StorageErrorKind::Integrity,
                _ => StorageErrorKind::Io,
            }
        }
        sqlx::Error::RowNotFound => StorageErrorKind::NotFound,
        sqlx::Error::ColumnNotFound(_)
        | sqlx::Error::ColumnIndexOutOfBounds { .. }
        | sqlx::Error::ColumnDecode { .. }
        | sqlx::Error::Decode(_) => StorageErrorKind::Integrity,
        _ => StorageErrorKind::Io,
    };
    StorageError::new(kind)
}

fn options(path: &Path, read_only: bool) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .read_only(read_only)
        .shared_cache(false)
        .busy_timeout(Duration::ZERO)
        .foreign_keys(true)
        .pragma("trusted_schema", "OFF")
        .disable_statement_logging()
}

pub(super) async fn open(
    path: &Path,
    read_only: bool,
    lifecycle: &Lifecycle,
) -> Result<SqliteConnection> {
    if !path.is_absolute() {
        return Err(StorageError::new(StorageErrorKind::InvalidInput));
    }
    filesystem::check_directory(
        path.parent()
            .ok_or_else(|| StorageError::new(StorageErrorKind::InvalidInput))?,
    )?;
    if filesystem::check_database(path)?.is_none() {
        return Err(StorageError::new(StorageErrorKind::NotFound));
    }
    #[cfg(test)]
    super::test_hooks::hit(super::test_hooks::Point::Open).await?;
    let mut connection = options(path, read_only).connect().await.map_err(|cause| {
        // SQLx can fail its own setup after starting a worker without returning its handle.
        lifecycle.quarantine();
        error(cause)
    })?;
    #[cfg(test)]
    lifecycle.connection_opened();
    let result = async {
        if !read_only {
            sqlx::query("PRAGMA journal_mode = WAL")
                .execute(&mut connection)
                .await
                .map_err(error)?;
        }
        sqlx::query("PRAGMA synchronous = FULL")
            .execute(&mut connection)
            .await
            .map_err(error)?;
        check_settings(&mut connection, !read_only).await?;
        filesystem::check_database(path)?;
        Ok(())
    }
    .await;
    if let Err(error) = result {
        close(connection, lifecycle).await?;
        return Err(error);
    }
    Ok(connection)
}

pub(super) async fn close(connection: SqliteConnection, lifecycle: &Lifecycle) -> Result<()> {
    connection.close().await.map_err(|_| {
        lifecycle.quarantine();
        StorageError::new(StorageErrorKind::Io)
    })?;
    #[cfg(test)]
    lifecycle.connection_closed();
    Ok(())
}

pub(super) async fn finish_transaction<T>(
    transaction: sqlx::Transaction<'_, sqlx::Sqlite>,
    result: Result<T>,
) -> Result<T> {
    #[cfg(test)]
    let result = match result {
        Ok(value) => super::test_hooks::hit(super::test_hooks::Point::BeforeCommit)
            .await
            .map(|()| value),
        Err(error) => Err(error),
    };
    match result {
        Ok(value) => {
            #[cfg(test)]
            if let Err(error) = super::test_hooks::hit(super::test_hooks::Point::CommitStart).await
            {
                // Simulate an ambiguous COMMIT failure with a known fixture-side rollback.
                transaction.rollback().await.map_err(self::error)?;
                return Err(error);
            }
            transaction
                .commit()
                .await
                .map_err(|_| StorageError::new(StorageErrorKind::CommitUnknown))?;
            #[cfg(test)]
            super::test_hooks::hit(super::test_hooks::Point::AfterCommit).await?;
            Ok(value)
        }
        Err(cause) => {
            // SQLite can already have rolled back (for example after SQLITE_FULL).
            // Keep the primary failure. No COMMIT was attempted, and the caller still
            // explicitly closes the connection before releasing operation ownership.
            let _ = transaction.rollback().await;
            Err(cause.not_committed())
        }
    }
}

pub(super) async fn finish_read<T>(
    connection: SqliteConnection,
    lifecycle: &Lifecycle,
    result: Result<T>,
) -> Result<T> {
    let cleanup = close(connection, lifecycle).await;
    match result {
        Ok(value) => {
            cleanup?;
            Ok(value)
        }
        Err(error) => Err(error),
    }
}

pub(super) async fn finish_write<T>(
    connection: SqliteConnection,
    lifecycle: &Lifecycle,
    result: Result<T>,
    #[cfg(test)] fail_cleanup: bool,
) -> Result<(T, Option<super::CleanupWarning>)> {
    let cleanup = close(connection, lifecycle).await;
    // Test a reported cleanup failure after real, known-safe worker retirement.
    #[cfg(test)]
    let cleanup = if fail_cleanup {
        cleanup.and(Err(StorageError::new(StorageErrorKind::Io)))
    } else {
        cleanup
    };
    #[cfg(test)]
    let cleanup = match super::test_hooks::hit(super::test_hooks::Point::WriteClosed).await {
        Ok(()) => cleanup,
        Err(error) => Err(error),
    };
    #[cfg(test)]
    let cleanup = match super::test_hooks::hit(super::test_hooks::Point::UncertainWriteClose).await
    {
        Ok(()) => cleanup,
        Err(error) => {
            // The fixture retired the real worker but simulates an uncertain close report.
            lifecycle.quarantine();
            Err(error)
        }
    };
    // The commit result is authoritative. Cleanup cannot turn a receipt into rollback.
    result.map(|value| {
        (
            value,
            cleanup
                .err()
                .map(|_| super::CleanupWarning::ConnectionCloseFailed),
        )
    })
}

pub(super) async fn check_settings(
    connection: &mut SqliteConnection,
    writable: bool,
) -> Result<()> {
    let version: String = sqlx::query("SELECT sqlite_version() AS version")
        .fetch_one(&mut *connection)
        .await
        .map_err(error)?
        .try_get("version")
        .map_err(error)?;
    let components: Vec<u32> = version
        .split('.')
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()
        .map_err(|_| StorageError::new(StorageErrorKind::UnsupportedVersion))?;
    if components.len() != 3 || components.as_slice() < [3, 51, 3].as_slice() {
        return Err(StorageError::new(StorageErrorKind::UnsupportedVersion));
    }
    let journal: String = sqlx::query("PRAGMA journal_mode")
        .fetch_one(&mut *connection)
        .await
        .map_err(error)?
        .try_get(0)
        .map_err(error)?;
    if writable && journal != "wal" {
        return Err(StorageError::new(StorageErrorKind::Integrity));
    }
    for (pragma, expected) in [
        ("PRAGMA synchronous", 2_i64),
        ("PRAGMA foreign_keys", 1),
        ("PRAGMA trusted_schema", 0),
        ("PRAGMA busy_timeout", 0),
    ] {
        let actual: i64 = sqlx::query(pragma)
            .fetch_one(&mut *connection)
            .await
            .map_err(error)?
            .try_get(0)
            .map_err(error)?;
        if actual != expected {
            return Err(StorageError::new(StorageErrorKind::Integrity));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn storage_bundled_engine_settings_private_cache_and_explicit_close() {
        let temp = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) {
            "root%3Fcache=shared"
        } else {
            "root?cache=shared"
        };
        let root = filesystem::resolve_root(temp.path().join(name)).unwrap();
        let lifecycle = Lifecycle::new(filesystem::acquire_lease(&root).unwrap());
        let guard = lifecycle.admit().unwrap();
        let path = root.join("catalog.sqlite3");
        drop(filesystem::open_file(&path, true).unwrap());
        let settings = format!("{:?}", options(&path, false));
        assert!(settings.contains("shared_cache: false"));
        assert!(settings.contains("statements_level: Off"));
        assert!(settings.contains("slow_statements_level: Off"));
        let mut writer = open(&path, false, &lifecycle).await.unwrap();
        let row = sqlx::query("SELECT sqlite_version(), sqlite_source_id()")
            .fetch_one(&mut writer)
            .await
            .unwrap();
        let version: String = row.try_get(0).unwrap();
        let source: String = row.try_get(1).unwrap();
        println!("sqlite_version={version}; sqlite_source_id={source}");
        check_settings(&mut writer, true).await.unwrap();
        sqlx::query("CREATE TABLE cache_probe(value INTEGER) STRICT")
            .execute(&mut writer)
            .await
            .unwrap();
        let mut reader = open(&path, false, &lifecycle).await.unwrap();
        sqlx::query("PRAGMA read_uncommitted = ON")
            .execute(&mut reader)
            .await
            .unwrap();
        let mut transaction = writer.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query("INSERT INTO cache_probe VALUES (1)")
            .execute(&mut *transaction)
            .await
            .unwrap();
        let count: i64 = sqlx::query("SELECT count(*) FROM cache_probe")
            .fetch_one(&mut reader)
            .await
            .unwrap()
            .try_get(0)
            .unwrap();
        // A shared cache with read_uncommitted would expose the writer's pending row.
        assert_eq!(count, 0);
        let busy = sqlx::query("INSERT INTO cache_probe VALUES (2)")
            .execute(&mut reader)
            .await
            .map_err(error)
            .unwrap_err();
        assert_eq!(busy.code(), "storage.busy");
        transaction.rollback().await.unwrap();
        close(reader, &lifecycle).await.unwrap();
        close(writer, &lifecycle).await.unwrap();
        guard.finish();
        lifecycle.close().await.unwrap();
        assert!(!root.join("catalog.sqlite3-wal").exists());
        drop(filesystem::acquire_lease(&root).unwrap());
    }
}
