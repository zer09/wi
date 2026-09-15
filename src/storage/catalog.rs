use std::path::Path;

use sqlx::{Connection, Row, SqliteConnection};

use super::{StorageError, StorageErrorKind, database, filesystem, lifecycle::Lifecycle};

type Result<T> = std::result::Result<T, StorageError>;

const APPLICATION_ID: i64 = 1464419137;
const VERSION: i64 = 1;

// Version 1 initializes only a file created by this open operation. There is no v0 migration.
const MIGRATIONS: &[&str] = &[
    "PRAGMA application_id = 1464419137;
    CREATE TABLE catalog_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        format_version INTEGER NOT NULL CHECK(format_version=1),
        repair_required INTEGER NOT NULL CHECK(repair_required IN(0,1))
    ) STRICT;
    CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        workspace_json TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        head_sequence INTEGER NOT NULL CHECK(head_sequence>=0),
        schema_version INTEGER NOT NULL,
        availability TEXT NOT NULL CHECK(availability IN('creating','ready','missing','unavailable')),
        fault_code TEXT,
        last_run_id TEXT,
        last_run_state TEXT,
        seen_repair_id TEXT
    ) STRICT;
    CREATE TABLE creation_commands (
        command_id TEXT PRIMARY KEY,
        payload_hash BLOB NOT NULL CHECK(length(payload_hash)=32),
        request_json TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        creation_event_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN('creating','accepted','failed')),
        receipt_json TEXT,
        failure_code TEXT
    ) STRICT;
    CREATE INDEX sessions_availability_id ON sessions(availability, session_id);
    PRAGMA user_version = 1;",
];

pub(super) async fn open(root: &Path, lifecycle: &Lifecycle) -> Result<()> {
    filesystem::check_directory(root)?;
    let sessions = root.join("sessions");
    filesystem::create_directory(&sessions)?;
    let path = root.join("catalog.sqlite3");
    let existing = filesystem::check_database(&path)?;
    if let Some(metadata) = existing {
        if metadata.len() == 0 {
            return Err(StorageError::new(StorageErrorKind::Integrity));
        }
        // Do not change a foreign/future catalog's journal mode just to inspect it.
        let mut connection = database::open(&path, true, lifecycle).await?;
        let result = validate(&mut connection).await;
        database::close(connection, lifecycle).await?;
        result?;
    } else {
        let repair_required = filesystem::surviving_sessions(&sessions)?;
        drop(filesystem::open_file(&path, true)?);
        let mut connection = database::open(&path, false, lifecycle).await?;
        let result = initialize(&mut connection, repair_required).await;
        database::close(connection, lifecycle).await?;
        result?;
    }
    let mut connection = database::open(&path, false, lifecycle).await?;
    let result = validate(&mut connection).await;
    database::close(connection, lifecycle).await?;
    result?;
    filesystem::check_database(&path)?;
    Ok(())
}

async fn initialize(connection: &mut SqliteConnection, repair_required: bool) -> Result<()> {
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| database::error(error).not_committed())?;
    let result = async {
        for migration in MIGRATIONS {
            sqlx::raw_sql(*migration).execute(&mut *transaction).await.map_err(database::error)?;
        }
        sqlx::query("INSERT INTO catalog_meta (singleton, format_version, repair_required) VALUES (1, 1, ?)")
            .bind(i64::from(repair_required)).execute(&mut *transaction).await.map_err(database::error)?;
        validate(&mut transaction).await
    }.await;
    if let Err(error) = result {
        transaction
            .rollback()
            .await
            .map_err(|error| database::error(error).not_committed())?;
        return Err(error.not_committed());
    }
    transaction
        .commit()
        .await
        .map_err(|_| StorageError::new(StorageErrorKind::CommitUnknown))
}

pub(super) async fn validate(connection: &mut SqliteConnection) -> Result<()> {
    let application: i64 = sqlx::query("PRAGMA application_id")
        .fetch_one(&mut *connection)
        .await
        .map_err(database::error)?
        .try_get(0)
        .map_err(database::error)?;
    let version: i64 = sqlx::query("PRAGMA user_version")
        .fetch_one(&mut *connection)
        .await
        .map_err(database::error)?
        .try_get(0)
        .map_err(database::error)?;
    if application != APPLICATION_ID {
        return Err(StorageError::new(StorageErrorKind::Integrity));
    }
    if version != VERSION {
        return Err(StorageError::new(StorageErrorKind::UnsupportedVersion));
    }
    validate_table(
        connection,
        "catalog_meta",
        &[
            ("singleton", "INTEGER", 0, 1),
            ("format_version", "INTEGER", 1, 0),
            ("repair_required", "INTEGER", 1, 0),
        ],
    )
    .await?;
    validate_table(
        connection,
        "sessions",
        &[
            ("session_id", "TEXT", 1, 1),
            ("relative_path", "TEXT", 1, 0),
            ("title", "TEXT", 1, 0),
            ("workspace_json", "TEXT", 0, 0),
            ("created_at_ms", "INTEGER", 1, 0),
            ("updated_at_ms", "INTEGER", 1, 0),
            ("head_sequence", "INTEGER", 1, 0),
            ("schema_version", "INTEGER", 1, 0),
            ("availability", "TEXT", 1, 0),
            ("fault_code", "TEXT", 0, 0),
            ("last_run_id", "TEXT", 0, 0),
            ("last_run_state", "TEXT", 0, 0),
            ("seen_repair_id", "TEXT", 0, 0),
        ],
    )
    .await?;
    validate_table(
        connection,
        "creation_commands",
        &[
            ("command_id", "TEXT", 1, 1),
            ("payload_hash", "BLOB", 1, 0),
            ("request_json", "TEXT", 1, 0),
            ("session_id", "TEXT", 1, 0),
            ("creation_event_id", "TEXT", 1, 0),
            ("created_at_ms", "INTEGER", 1, 0),
            ("state", "TEXT", 1, 0),
            ("receipt_json", "TEXT", 0, 0),
            ("failure_code", "TEXT", 0, 0),
        ],
    )
    .await?;
    require_index(connection, "sessions", &["session_id"], true).await?;
    require_index(connection, "sessions", &["relative_path"], true).await?;
    require_index(
        connection,
        "sessions",
        &["availability", "session_id"],
        false,
    )
    .await?;
    require_index(connection, "creation_commands", &["command_id"], true).await?;
    require_index(connection, "creation_commands", &["session_id"], true).await?;
    let meta =
        sqlx::query("SELECT singleton, format_version, repair_required FROM catalog_meta LIMIT 2")
            .fetch_all(connection)
            .await
            .map_err(database::error)?;
    if meta.len() != 1
        || meta[0]
            .try_get::<i64, _>("singleton")
            .map_err(database::error)?
            != 1
        || meta[0]
            .try_get::<i64, _>("format_version")
            .map_err(database::error)?
            != VERSION
        || !matches!(
            meta[0]
                .try_get::<i64, _>("repair_required")
                .map_err(database::error)?,
            0 | 1
        )
    {
        return Err(StorageError::new(StorageErrorKind::Integrity));
    }
    Ok(())
}

pub(super) async fn validate_table(
    connection: &mut SqliteConnection,
    table: &str,
    columns: &[(&str, &str, i64, i64)],
) -> Result<()> {
    let invalid = || StorageError::new(StorageErrorKind::Integrity);
    let metadata = sqlx::query(
        "SELECT type, ncol, wr, strict FROM pragma_table_list(?) WHERE schema = 'main'",
    )
    .bind(table)
    .fetch_optional(&mut *connection)
    .await
    .map_err(database::error)?
    .ok_or_else(invalid)?;
    if metadata
        .try_get::<String, _>("type")
        .map_err(database::error)?
        != "table"
        || metadata
            .try_get::<i64, _>("ncol")
            .map_err(database::error)?
            != columns.len() as i64
        || metadata.try_get::<i64, _>("wr").map_err(database::error)? != 0
        || metadata
            .try_get::<i64, _>("strict")
            .map_err(database::error)?
            != 1
    {
        return Err(invalid());
    }
    let actual = sqlx::query(
        "SELECT name, type, \"notnull\", pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid",
    )
    .bind(table)
    .fetch_all(connection)
    .await
    .map_err(database::error)?;
    if actual.len() != columns.len() {
        return Err(invalid());
    }
    for (row, (name, kind, not_null, pk)) in actual.iter().zip(columns) {
        if row.try_get::<String, _>("name").map_err(database::error)? != *name
            || row.try_get::<String, _>("type").map_err(database::error)? != *kind
            || row.try_get::<i64, _>("notnull").map_err(database::error)? != *not_null
            || row.try_get::<i64, _>("pk").map_err(database::error)? != *pk
            || row.try_get::<i64, _>("hidden").map_err(database::error)? != 0
        {
            return Err(invalid());
        }
    }
    Ok(())
}

pub(super) async fn require_index(
    connection: &mut SqliteConnection,
    table: &str,
    columns: &[&str],
    unique: bool,
) -> Result<()> {
    let indexes =
        sqlx::query("SELECT name FROM pragma_index_list(?) WHERE \"unique\" = ? AND partial = 0")
            .bind(table)
            .bind(i64::from(unique))
            .fetch_all(&mut *connection)
            .await
            .map_err(database::error)?;
    for index in indexes {
        let name: String = index.try_get("name").map_err(database::error)?;
        let keys = sqlx::query(
            "SELECT name, desc, coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno",
        )
        .bind(name)
        .fetch_all(&mut *connection)
        .await
        .map_err(database::error)?;
        if keys.len() != columns.len() {
            continue;
        }
        let mut matches = true;
        for (key, expected) in keys.iter().zip(columns) {
            if key
                .try_get::<Option<String>, _>("name")
                .map_err(database::error)?
                .as_deref()
                != Some(*expected)
                || key.try_get::<i64, _>("desc").map_err(database::error)? != 0
                || key.try_get::<String, _>("coll").map_err(database::error)? != "BINARY"
            {
                matches = false;
            }
        }
        if matches {
            return Ok(());
        }
    }
    Err(StorageError::new(StorageErrorKind::Integrity))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn storage_catalog_initialization_failure_rolls_back_identity_and_ddl() {
        let temp = tempfile::tempdir().unwrap();
        let root = filesystem::resolve_root(temp.path().join("root")).unwrap();
        let lifecycle = Lifecycle::new(filesystem::acquire_lease(&root).unwrap());
        let guard = lifecycle.admit().unwrap();
        let path = root.join("catalog.sqlite3");
        drop(filesystem::open_file(&path, true).unwrap());
        let mut connection = database::open(&path, false, &lifecycle).await.unwrap();
        sqlx::query("CREATE TABLE sessions (canary TEXT)")
            .execute(&mut connection)
            .await
            .unwrap();
        let error = initialize(&mut connection, false).await.unwrap_err();
        assert_eq!(
            error.certainty(),
            super::super::CommitCertainty::NotCommitted
        );
        for pragma in ["PRAGMA application_id", "PRAGMA user_version"] {
            assert_eq!(
                sqlx::query(pragma)
                    .fetch_one(&mut connection)
                    .await
                    .unwrap()
                    .try_get::<i64, _>(0)
                    .unwrap(),
                0
            );
        }
        let tables: Vec<String> = sqlx::query("SELECT name FROM sqlite_schema WHERE type='table'")
            .fetch_all(&mut connection)
            .await
            .unwrap()
            .iter()
            .map(|row| row.try_get(0).unwrap())
            .collect();
        assert_eq!(tables, ["sessions"]);
        database::close(connection, &lifecycle).await.unwrap();
        guard.finish();
        lifecycle.close().await.unwrap();
    }
}
