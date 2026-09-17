use sqlx::{Connection, Row, SqliteConnection};

use super::{dto::CreationProvenance, session_schema::integrity, *};

type Result<T> = std::result::Result<T, StorageError>;

// The caller retains session ownership. Only explicit open_session reaches this path.
pub(super) async fn migrate(inner: &StoreInner, provenance: &CreationProvenance) -> Result<()> {
    let path = filesystem::session_path(&inner.root, &provenance.session_id, false)?;
    let mut connection = database::open(&path, false, &inner.lifecycle).await?;
    let result = async {
        sqlx::query("PRAGMA foreign_keys=OFF")
            .execute(&mut connection)
            .await
            .map_err(database::error)?;
        let mut transaction = connection
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|e| database::error(e).not_committed())?;
        let result = rebuild(&mut transaction, provenance).await;
        database::finish_transaction(transaction, result).await
    }
    .await;
    #[cfg(test)]
    let result = match result {
        Ok(()) => test_hooks::hit(test_hooks::Point::MigrationCommitted)
            .await
            .map_err(StorageError::unknown),
        Err(error) => Err(error),
    };
    // Restore normal settings even after a rejected migration. Retirement always runs,
    // and a secondary cleanup failure must not replace the primary transaction failure.
    let restore = async {
        sqlx::query("PRAGMA foreign_keys=ON")
            .execute(&mut connection)
            .await
            .map_err(database::error)?;
        database::check_settings(&mut connection, true).await
    }
    .await;
    let result = match result {
        Ok(()) => restore.map_err(StorageError::unknown),
        Err(error) => Err(error),
    };
    let ((), warning) = database::finish_write(
        connection,
        &inner.lifecycle,
        result,
        #[cfg(test)]
        false,
    )
    .await?;
    if warning.is_some() {
        return Err(StorageError::new(StorageErrorKind::Io).unknown());
    }
    Ok(())
}

async fn rebuild(connection: &mut SqliteConnection, provenance: &CreationProvenance) -> Result<()> {
    let id = &provenance.session_id;
    let manifest = session_schema::validate(connection, id, Some(provenance)).await?;
    if session_schema::version(connection).await? != 1 {
        return Err(integrity());
    }
    let summary = catalog_sync::observe(connection, id).await?;
    catalog_repair::validate_history(connection, &summary).await?;
    sqlx::raw_sql("CREATE TABLE events_p1b2_new (
        sequence INTEGER PRIMARY KEY CHECK(sequence>0),
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL CHECK(event_type IN(
            'session.created','session.renamed','run.accepted',
            'runtime.observed','tool.result.recorded','run.result.recorded','run.interrupted',
            'run.history.selected','run.provider.bound')),
        event_version INTEGER NOT NULL CHECK(event_version=1),
        created_at_ms INTEGER NOT NULL,
        run_id TEXT,
        source_event_id TEXT,
        source_sequence INTEGER,
        payload_json TEXT NOT NULL,
        CHECK((event_type='runtime.observed' AND source_event_id IS NOT NULL
            AND source_sequence IS NOT NULL AND source_sequence>0)
            OR (event_type<>'runtime.observed' AND source_event_id IS NULL AND source_sequence IS NULL))
    ) STRICT;")
        .execute(&mut *connection)
        .await
        .map_err(database::error)?;
    #[cfg(test)]
    test_hooks::hit(test_hooks::Point::MigrationCreated).await?;
    let mut copied = 0;
    while copied < manifest.head_sequence() {
        let rows = sqlx::query("INSERT INTO events_p1b2_new (sequence,event_id,event_type,event_version,created_at_ms,run_id,source_event_id,source_sequence,payload_json) SELECT sequence,event_id,event_type,event_version,created_at_ms,run_id,source_event_id,source_sequence,payload_json FROM events WHERE sequence>? ORDER BY sequence LIMIT 256")
            .bind(copied as i64).execute(&mut *connection).await.map_err(database::error)?.rows_affected();
        if rows == 0 {
            return Err(integrity());
        }
        copied += rows;
        #[cfg(test)]
        test_hooks::hit(test_hooks::Point::MigrationCopied).await?;
    }
    sqlx::raw_sql("DROP TABLE events; ALTER TABLE events_p1b2_new RENAME TO events;
        CREATE UNIQUE INDEX events_source_id ON events(source_event_id) WHERE source_event_id IS NOT NULL;
        CREATE UNIQUE INDEX events_source_sequence ON events(run_id, source_sequence) WHERE source_sequence IS NOT NULL;
        CREATE INDEX events_run_sequence ON events(run_id, sequence);
        CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable history'); END;
        CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'immutable history'); END;
        UPDATE manifest SET schema_version=2 WHERE singleton=1; PRAGMA user_version=2;")
        .execute(&mut *connection).await.map_err(database::error)?;
    #[cfg(test)]
    test_hooks::hit(test_hooks::Point::MigrationRebuilt).await?;
    let migrated = session_schema::validate(connection, id, Some(provenance)).await?;
    let count: i64 = sqlx::query("SELECT count(*) FROM events")
        .fetch_one(&mut *connection)
        .await
        .map_err(database::error)?
        .try_get(0)
        .map_err(database::error)?;
    if migrated != manifest || count as u64 != manifest.head_sequence() {
        return Err(integrity());
    }
    let summary = catalog_sync::observe(connection, id).await?;
    catalog_repair::validate_history(connection, &summary).await?;
    #[cfg(test)]
    test_hooks::hit(test_hooks::Point::MigrationPrecommit).await?;
    Ok(())
}
