use sqlx::{Connection, Row, SqliteConnection};

use super::{
    ApplicationSessionId, SessionManifest, StorageError, StorageErrorKind, catalog, database,
    dto::{self, CreatedPayload, CreationProvenance, RenamedPayload},
};

type Result<T> = std::result::Result<T, StorageError>;
pub(super) const V1: &str = include_str!("session_v1.sql");
pub(super) const V2: &str = include_str!("session_v2.sql");

pub(super) async fn version(connection: &mut SqliteConnection) -> Result<u64> {
    let value: i64 = sqlx::query("PRAGMA user_version")
        .fetch_one(connection)
        .await
        .map_err(database::error)?
        .try_get(0)
        .map_err(database::error)?;
    match value {
        1 | 2 => Ok(value as u64),
        _ => Err(StorageError::new(StorageErrorKind::UnsupportedVersion)),
    }
}

pub(super) fn integrity() -> StorageError {
    StorageError::new(StorageErrorKind::Integrity)
}

pub(super) async fn empty(connection: &mut SqliteConnection) -> Result<bool> {
    let row = sqlx::query("SELECT (SELECT application_id FROM pragma_application_id) AS application, (SELECT user_version FROM pragma_user_version) AS version, (SELECT count(*) FROM sqlite_schema) AS objects")
        .fetch_one(connection).await.map_err(database::error)?;
    Ok(row
        .try_get::<i64, _>("application")
        .map_err(database::error)?
        == 0
        && row.try_get::<i64, _>("version").map_err(database::error)? == 0
        && row.try_get::<i64, _>("objects").map_err(database::error)? == 0)
}

pub(super) async fn initialize(
    connection: &mut SqliteConnection,
    provenance: &CreationProvenance,
    #[cfg(test)] fail_after_ddl: bool,
) -> Result<SessionManifest> {
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| database::error(error).not_committed())?;
    let result = async {
        // Only the creating-reservation caller reaches this function. Recheck emptiness
        // under the write lock so an existing history can never be initialized over.
        if !empty(&mut transaction).await? { return Err(integrity()); }
        sqlx::raw_sql(V2).execute(&mut *transaction).await.map_err(database::error)?;
        #[cfg(test)]
        if fail_after_ddl { return Err(StorageError::new(StorageErrorKind::Io)); }
        #[cfg(test)]
        super::test_hooks::hit(super::test_hooks::Point::Initializing).await?;
        let input = provenance.request()?;
        let payload = CreatedPayload { title: input.title().to_owned(), workspace: input.workspace().map(str::to_owned), creation_provenance: provenance.clone() };
        let workspace = input.workspace().map(|value| dto::canonical_json(&value)).transpose()?;
        sqlx::query("INSERT INTO manifest (singleton, session_id, schema_version, format_version, title, workspace_json, created_at_ms, updated_at_ms, head_sequence, creation_provenance_json) VALUES (1, ?, 2, 1, ?, ?, ?, ?, 1, ?)")
            .bind(provenance.session_id.as_str()).bind(input.title()).bind(workspace)
            .bind(provenance.created_at_ms).bind(provenance.created_at_ms).bind(dto::canonical_json(provenance)?)
            .execute(&mut *transaction).await.map_err(database::error)?;
        sqlx::query("INSERT INTO events (sequence, event_id, event_type, event_version, created_at_ms, payload_json) VALUES (1, ?, 'session.created', 1, ?, ?)")
            .bind(provenance.creation_event_id.as_str()).bind(provenance.created_at_ms).bind(dto::canonical_json(&payload)?)
            .execute(&mut *transaction).await.map_err(database::error)?;
        validate(&mut transaction, &provenance.session_id, Some(provenance)).await
    }.await;
    database::finish_transaction(transaction, result).await
}

pub(super) async fn validate(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
    expected: Option<&CreationProvenance>,
) -> Result<SessionManifest> {
    let application: i64 = sqlx::query("PRAGMA application_id")
        .fetch_one(&mut *connection)
        .await
        .map_err(database::error)?
        .try_get(0)
        .map_err(database::error)?;
    if application != 1464423233 {
        return Err(integrity());
    }
    let version = version(connection).await? as i64;
    structure(connection, version).await?;
    let rows = sqlx::query("SELECT * FROM manifest LIMIT 2")
        .fetch_all(&mut *connection)
        .await
        .map_err(database::error)?;
    if rows.len() != 1 {
        return Err(integrity());
    }
    let row = &rows[0];
    if row
        .try_get::<i64, _>("singleton")
        .map_err(database::error)?
        != 1
        || row
            .try_get::<i64, _>("schema_version")
            .map_err(database::error)?
            != version
        || row
            .try_get::<i64, _>("format_version")
            .map_err(database::error)?
            != 1
        || row
            .try_get::<String, _>("session_id")
            .map_err(database::error)?
            != id.as_str()
    {
        return Err(integrity());
    }
    let head: i64 = row.try_get("head_sequence").map_err(database::error)?;
    if head < 1 {
        return Err(integrity());
    }
    let maximum: Option<i64> = sqlx::query("SELECT max(sequence) FROM events")
        .fetch_one(&mut *connection)
        .await
        .map_err(database::error)?
        .try_get(0)
        .map_err(database::error)?;
    if maximum != Some(head) {
        return Err(integrity());
    }
    let provenance: CreationProvenance = dto::decode(
        &row.try_get::<String, _>("creation_provenance_json")
            .map_err(database::error)?,
    )?;
    let input = provenance.request()?;
    let workspace = workspace(row.try_get("workspace_json").map_err(database::error)?)?;
    let manifest = SessionManifest {
        session_id: id.clone(),
        title: row.try_get("title").map_err(database::error)?,
        workspace,
        created_at_ms: row.try_get("created_at_ms").map_err(database::error)?,
        updated_at_ms: row.try_get("updated_at_ms").map_err(database::error)?,
        head_sequence: head as u64,
    };
    if &provenance.session_id != id
        || manifest.created_at_ms != provenance.created_at_ms
        || manifest.workspace.as_deref() != input.workspace()
        || manifest.updated_at_ms < 0
        || expected.is_some_and(|expected| *expected != provenance)
    {
        return Err(integrity());
    }
    let event = sqlx::query("SELECT * FROM events WHERE sequence=1")
        .fetch_optional(&mut *connection)
        .await
        .map_err(database::error)?
        .ok_or_else(integrity)?;
    let payload: CreatedPayload = dto::decode(
        &event
            .try_get::<String, _>("payload_json")
            .map_err(database::error)?,
    )?;
    if event
        .try_get::<String, _>("event_id")
        .map_err(database::error)?
        != provenance.creation_event_id.as_str()
        || event
            .try_get::<String, _>("event_type")
            .map_err(database::error)?
            != "session.created"
        || event
            .try_get::<i64, _>("event_version")
            .map_err(database::error)?
            != 1
        || event
            .try_get::<i64, _>("created_at_ms")
            .map_err(database::error)?
            != provenance.created_at_ms
        || event
            .try_get::<Option<String>, _>("run_id")
            .map_err(database::error)?
            .is_some()
        || event
            .try_get::<Option<String>, _>("source_event_id")
            .map_err(database::error)?
            .is_some()
        || event
            .try_get::<Option<i64>, _>("source_sequence")
            .map_err(database::error)?
            .is_some()
        || payload.creation_provenance != provenance
        || payload.title != input.title()
        || payload.workspace.as_deref() != input.workspace()
    {
        return Err(integrity());
    }
    let last = sqlx::query("SELECT event_type, event_version, created_at_ms, payload_json FROM events WHERE sequence=?")
        .bind(head).fetch_one(&mut *connection).await.map_err(database::error)?;
    if last
        .try_get::<i64, _>("created_at_ms")
        .map_err(database::error)?
        != manifest.updated_at_ms
        || last
            .try_get::<i64, _>("event_version")
            .map_err(database::error)?
            != 1
    {
        return Err(integrity());
    }
    let kind: String = last.try_get("event_type").map_err(database::error)?;
    if head == 1 && manifest.title != input.title() {
        return Err(integrity());
    }
    if kind == "session.renamed" {
        let renamed: RenamedPayload = dto::decode(
            &last
                .try_get::<String, _>("payload_json")
                .map_err(database::error)?,
        )?;
        if renamed.title != manifest.title {
            return Err(integrity());
        }
    }
    Ok(manifest)
}

pub(super) fn workspace(value: Option<String>) -> Result<Option<String>> {
    let value: Option<String> = value.map(|json| dto::decode(&json)).transpose()?;
    dto::validate_workspace(value.as_deref()).map_err(|_| integrity())?;
    Ok(value)
}

async fn structure(connection: &mut SqliteConnection, version: i64) -> Result<()> {
    if sqlx::query("SELECT 1 FROM sqlite_schema WHERE name='events_p1b2_new'")
        .fetch_optional(&mut *connection)
        .await
        .map_err(database::error)?
        .is_some()
    {
        return Err(integrity());
    }
    let schema = if version == 1 { V1 } else { V2 };
    for table in ["manifest", "events", "commands", "runs", "tool_results"] {
        let actual: String =
            sqlx::query("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
                .bind(table)
                .fetch_one(&mut *connection)
                .await
                .map_err(|_| integrity())?
                .try_get(0)
                .map_err(database::error)?;
        let expected = table_ddl(schema, table)?;
        // SQLite quotes the target name after ALTER TABLE RENAME. Constraints and FK
        // targets must otherwise remain exactly the released table definitions.
        let actual_body = actual.split_once('(').ok_or_else(integrity)?.1;
        let expected_body = expected.split_once('(').ok_or_else(integrity)?.1;
        if normalized(actual_body) != normalized(expected_body) {
            return Err(integrity());
        }
    }
    for (table, columns) in [
        (
            "manifest",
            &[
                ("singleton", "INTEGER", 0, 1),
                ("session_id", "TEXT", 1, 0),
                ("schema_version", "INTEGER", 1, 0),
                ("format_version", "INTEGER", 1, 0),
                ("title", "TEXT", 1, 0),
                ("workspace_json", "TEXT", 0, 0),
                ("created_at_ms", "INTEGER", 1, 0),
                ("updated_at_ms", "INTEGER", 1, 0),
                ("head_sequence", "INTEGER", 1, 0),
                ("creation_provenance_json", "TEXT", 1, 0),
            ][..],
        ),
        (
            "events",
            &[
                ("sequence", "INTEGER", 0, 1),
                ("event_id", "TEXT", 1, 0),
                ("event_type", "TEXT", 1, 0),
                ("event_version", "INTEGER", 1, 0),
                ("created_at_ms", "INTEGER", 1, 0),
                ("run_id", "TEXT", 0, 0),
                ("source_event_id", "TEXT", 0, 0),
                ("source_sequence", "INTEGER", 0, 0),
                ("payload_json", "TEXT", 1, 0),
            ][..],
        ),
        (
            "commands",
            &[
                ("operation_id", "TEXT", 1, 1),
                ("method", "TEXT", 1, 0),
                ("payload_hash", "BLOB", 1, 0),
                ("first_sequence", "INTEGER", 1, 0),
                ("last_sequence", "INTEGER", 1, 0),
                ("receipt_json", "TEXT", 1, 0),
            ][..],
        ),
        (
            "runs",
            &[
                ("run_id", "TEXT", 1, 1),
                ("accepted_sequence", "INTEGER", 1, 0),
                ("state", "TEXT", 1, 0),
                ("last_runtime_sequence", "INTEGER", 1, 0),
                ("owner_instance_id", "TEXT", 1, 0),
                ("provider_session_id", "TEXT", 0, 0),
                ("terminal_sequence", "INTEGER", 0, 0),
                ("terminal_json", "TEXT", 0, 0),
                ("result_sequence", "INTEGER", 0, 0),
            ][..],
        ),
        (
            "tool_results",
            &[
                ("run_id", "TEXT", 1, 1),
                ("call_id", "TEXT", 1, 2),
                ("tool_name", "TEXT", 1, 0),
                ("request_id", "TEXT", 0, 0),
                ("started_sequence", "INTEGER", 1, 0),
                ("finished_sequence", "INTEGER", 0, 0),
                ("result_sequence", "INTEGER", 0, 0),
                ("is_error", "INTEGER", 0, 0),
                ("output", "TEXT", 0, 0),
            ][..],
        ),
    ] {
        catalog::validate_table(connection, table, columns).await?;
    }
    for (table, columns, unique) in [
        ("manifest", &["session_id"][..], true),
        ("events", &["event_id"][..], true),
        ("events", &["run_id", "sequence"][..], false),
        ("commands", &["operation_id"][..], true),
        ("runs", &["run_id"][..], true),
        ("runs", &["accepted_sequence"][..], true),
        ("tool_results", &["run_id", "call_id"][..], true),
    ] {
        catalog::require_index(connection, table, columns, unique).await?;
    }
    // Compare the fixed partial predicates and trigger bodies, not just object names.
    let objects = sqlx::query("SELECT type, name, sql FROM sqlite_schema WHERE type IN ('index','trigger') AND sql IS NOT NULL")
        .fetch_all(connection).await.map_err(database::error)?;
    for required in [
        "CREATE UNIQUE INDEX events_source_id ON events(source_event_id) WHERE source_event_id IS NOT NULL",
        "CREATE UNIQUE INDEX events_source_sequence ON events(run_id, source_sequence) WHERE source_sequence IS NOT NULL",
        "CREATE UNIQUE INDEX one_unfinished_run ON runs((1)) WHERE state IN('accepted','running')",
    ] {
        let tail = normalized(required.split_once(" ON ").ok_or_else(integrity)?.1);
        if !objects.iter().any(|row| {
            let Ok(sql) = row.try_get::<String, _>("sql") else {
                return false;
            };
            let sql = normalized(&sql);
            sql.starts_with("createuniqueindex") && sql.ends_with(&format!("on{tail}"))
        }) {
            return Err(integrity());
        }
    }
    for (name, required) in [
        (
            "events_no_update",
            "CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable history'); END",
        ),
        (
            "events_no_delete",
            "CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'immutable history'); END",
        ),
        (
            "commands_no_update",
            "CREATE TRIGGER commands_no_update BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT,'immutable receipt'); END",
        ),
        (
            "commands_no_delete",
            "CREATE TRIGGER commands_no_delete BEFORE DELETE ON commands BEGIN SELECT RAISE(ABORT,'immutable receipt'); END",
        ),
        (
            "manifest_creation_immutable",
            "CREATE TRIGGER manifest_creation_immutable BEFORE UPDATE OF session_id, created_at_ms, creation_provenance_json ON manifest BEGIN SELECT RAISE(ABORT,'immutable session identity'); END",
        ),
    ] {
        if !objects.iter().any(|row| {
            row.try_get::<String, _>("name").ok().as_deref() == Some(name)
                && row
                    .try_get::<String, _>("sql")
                    .is_ok_and(|sql| normalized(&sql) == normalized(required))
        }) {
            return Err(integrity());
        }
    }
    Ok(())
}

pub(super) fn table_ddl<'a>(schema: &'a str, table: &str) -> Result<&'a str> {
    let start = schema
        .find(&format!("CREATE TABLE {table} ("))
        .ok_or_else(integrity)?;
    let tail = &schema[start..];
    Ok(&tail[..tail.find(';').ok_or_else(integrity)?])
}

fn normalized(sql: &str) -> String {
    let mut result = String::new();
    let mut literal = false;
    for value in sql.chars() {
        if value == '\'' {
            literal = !literal;
        }
        // SQL keywords ignore case and spacing, but CHECK values and trigger messages do not.
        if literal || value == '\'' {
            result.push(value);
        } else if !value.is_whitespace() {
            result.extend(value.to_lowercase());
        }
    }
    result
}
