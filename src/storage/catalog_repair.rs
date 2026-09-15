use std::{fs, path::Path};

use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row, SqliteConnection};

use super::{dto, session_schema::integrity, *};

type Result<T> = std::result::Result<T, StorageError>;

/// Counts describe the completed catalog, except scanned_sessions and ignored_entries.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RepairReport {
    scanned_sessions: u64,
    ready_sessions: u64,
    missing_sessions: u64,
    unavailable_sessions: u64,
    ignored_entries: u64,
    conflicting_commands: u64,
}

impl RepairReport {
    pub fn scanned_sessions(&self) -> u64 {
        self.scanned_sessions
    }
    pub fn ready_sessions(&self) -> u64 {
        self.ready_sessions
    }
    pub fn missing_sessions(&self) -> u64 {
        self.missing_sessions
    }
    pub fn unavailable_sessions(&self) -> u64 {
        self.unavailable_sessions
    }
    pub fn ignored_entries(&self) -> u64 {
        self.ignored_entries
    }
    pub fn conflicting_commands(&self) -> u64 {
        self.conflicting_commands
    }
}

impl fmt::Debug for RepairReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RepairReport([redacted])")
    }
}

fn io(_: std::io::Error) -> StorageError {
    StorageError::new(StorageErrorKind::Io)
}

fn increment(count: &mut u64) -> Result<()> {
    *count = count.checked_add(1).ok_or_else(records::invalid)?;
    Ok(())
}

// The public caller owns exclusive maintenance for this whole operation. Each new
// attempt starts a new scan ID; committed seen_repair_id values survive interruption.
pub(super) async fn repair(
    inner: &StoreInner,
    #[cfg(test)] stop_after: Option<u64>,
) -> Result<RepairReport> {
    set_intent(inner).await?;
    let repair_id = StoredEventId::new();
    let mut scanned = 0;
    let mut ignored = 0;
    #[cfg(test)]
    if stop_after == Some(0) {
        return Err(io(std::io::ErrorKind::Interrupted.into()));
    }
    filesystem::check_directory(&inner.root)?;
    let sessions = inner.root.join("sessions");
    filesystem::check_directory(&sessions)?;
    for bucket in fs::read_dir(&sessions).map_err(io)? {
        let bucket = bucket.map_err(io)?;
        let name = bucket.file_name();
        let prefix = name.to_str().unwrap_or("");
        if prefix.len() != 2
            || !prefix
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            increment(&mut ignored)?;
            continue;
        }
        if !safe_directory(&bucket.path())? {
            increment(&mut ignored)?;
            // Do not descend into a substituted bucket. Known children are unavailable,
            // not absent; the complete-scan complement must not label them missing.
            reject_bucket(inner, prefix, &repair_id).await?;
            continue;
        }
        for entry in fs::read_dir(bucket.path()).map_err(io)? {
            let entry = entry.map_err(io)?;
            let name = entry.file_name();
            let Some(id) = name
                .to_str()
                .and_then(|name| name.parse::<ApplicationSessionId>().ok())
            else {
                increment(&mut ignored)?;
                continue;
            };
            if !id.as_str().starts_with(prefix) {
                increment(&mut ignored)?;
                continue;
            }
            // session_path checks every ancestor, DB and sidecar without following links.
            let observation = inspect(inner, &id).await;
            match observation {
                Ok((summary, provenance)) => {
                    register(inner, &repair_id, &summary, &provenance).await?
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        StorageErrorKind::NotFound
                            | StorageErrorKind::Integrity
                            | StorageErrorKind::UnsupportedVersion
                            | StorageErrorKind::Unavailable
                    ) =>
                {
                    record_fault(inner, &repair_id, &id, error).await?;
                }
                // Busy, I/O and uncertain cleanup are not evidence of a bad session.
                Err(error) => return Err(error),
            }
            increment(&mut scanned)?;
            #[cfg(test)]
            test_hooks::hit(test_hooks::Point::RepairCandidate).await?;
            #[cfg(test)]
            if stop_after == Some(scanned) {
                return Err(io(std::io::ErrorKind::Interrupted.into()));
            }
        }
    }
    finish(inner, &repair_id, scanned, ignored).await
}

fn safe_directory(path: &Path) -> Result<bool> {
    match filesystem::check_directory(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == StorageErrorKind::Unavailable => Ok(false),
        Err(error) => Err(error),
    }
}

async fn set_intent(inner: &StoreInner) -> Result<()> {
    let _lock = inner.catalog_lock.lock().await;
    let mut connection = catalog_ops::connect_maintenance(inner).await?;
    let result = async {
        let mut transaction = connection
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database::error)?;
        let result = sqlx::query("UPDATE catalog_meta SET repair_required=1 WHERE singleton=1")
            .execute(&mut *transaction)
            .await
            .map_err(database::error)
            .map(|_| ());
        database::finish_transaction(transaction, result).await
    }
    .await;
    database::finish_read(connection, &inner.lifecycle, result).await
}

async fn inspect(
    inner: &StoreInner,
    id: &ApplicationSessionId,
) -> Result<(SessionSummary, CreationProvenance)> {
    let path = filesystem::session_path(&inner.root, id, false)?;
    let mut connection = database::open(&path, true, &inner.lifecycle).await?;
    let result = async {
        let mut transaction = connection.begin().await.map_err(database::error)?;
        let result = async {
            let summary = catalog_sync::observe(&mut transaction, id).await?;
            let json: String =
                sqlx::query("SELECT creation_provenance_json FROM manifest WHERE singleton=1")
                    .fetch_one(&mut *transaction)
                    .await
                    .map_err(database::error)?
                    .try_get(0)
                    .map_err(database::error)?;
            let provenance = dto::decode(&json)?;
            validate_history(&mut transaction, &summary).await?;
            Ok((summary, provenance))
        }
        .await;
        transaction.rollback().await.map_err(database::error)?;
        result
    }
    .await;
    database::finish_read(connection, &inner.lifecycle, result).await
}

async fn validate_history(
    connection: &mut SqliteConnection,
    summary: &SessionSummary,
) -> Result<()> {
    let check: String = sqlx::query("PRAGMA quick_check(1)")
        .fetch_one(&mut *connection)
        .await
        .map_err(database::error)?
        .try_get(0)
        .map_err(database::error)?;
    if check != "ok" {
        return Err(integrity());
    }
    if sqlx::query("SELECT 1 FROM pragma_foreign_key_check LIMIT 1")
        .fetch_optional(&mut *connection)
        .await
        .map_err(database::error)?
        .is_some()
    {
        return Err(integrity());
    }
    let mut head = 0;
    let mut title = None;
    let mut rows = sqlx::query("SELECT * FROM events ORDER BY sequence").fetch(&mut *connection);
    while let Some(row) = rows.try_next().await.map_err(database::error)? {
        let event = history::decode(&row, summary.session_id())?;
        increment(&mut head)?;
        if event.sequence() != head {
            return Err(integrity());
        }
        match event.payload() {
            StoredEventPayload::SessionCreated(created) if head == 1 => {
                title = Some(created.title().to_owned())
            }
            StoredEventPayload::SessionCreated(_) => return Err(integrity()),
            StoredEventPayload::SessionRenamed { title: renamed } => title = Some(renamed.clone()),
            _ => {}
        }
    }
    drop(rows);
    if head != summary.observed_head_sequence() || title.as_deref() != Some(summary.title()) {
        return Err(integrity());
    }
    // Every run event needs a projection, anchored to its canonical acceptance.
    if sqlx::query("SELECT 1 FROM events e WHERE e.run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id=e.run_id AND (e.event_type<>'run.accepted' OR r.accepted_sequence=e.sequence)) LIMIT 1")
        .fetch_optional(&mut *connection)
        .await
        .map_err(database::error)?
        .is_some()
    {
        return Err(integrity());
    }
    // Check every projection, not just the latest run, including its acceptance and owner.
    // Foreign keys already checked above make accepted_sequence a positive, indexed cursor.
    let mut after = 0_i64;
    while let Some(row) = sqlx::query("SELECT run_id, accepted_sequence FROM runs WHERE accepted_sequence > ? ORDER BY accepted_sequence LIMIT 1")
        .bind(after)
        .fetch_optional(&mut *connection)
        .await
        .map_err(database::error)?
    {
        let run_id = row.try_get::<String, _>(0).map_err(database::error)?
            .parse().map_err(|_| integrity())?;
        run_store::validate_run(connection, summary.session_id(), &run_id).await?;
        after = row.try_get::<i64, _>(1).map_err(database::error)?;
    }
    Ok(())
}

async fn register(
    inner: &StoreInner,
    repair_id: &StoredEventId,
    summary: &SessionSummary,
    provenance: &CreationProvenance,
) -> Result<()> {
    let _lock = inner.catalog_lock.lock().await;
    let mut connection = catalog_ops::connect_maintenance(inner).await?;
    let result = async {
        let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await.map_err(database::error)?;
        let result = async {
            let claimant = sqlx::query("SELECT c.session_id, s.seen_repair_id, s.availability, s.fault_code FROM creation_commands c LEFT JOIN sessions s ON s.session_id=c.session_id WHERE c.command_id=?")
                .bind(provenance.operation_id.as_str()).fetch_optional(&mut *transaction).await.map_err(database::error)?;
            let mut conflict = None;
            if let Some(row) = claimant {
                let id: String = row.try_get("session_id").map_err(database::error)?;
                let seen: Option<String> = row.try_get("seen_repair_id").map_err(database::error)?;
                let availability: Option<String> = row.try_get("availability").map_err(database::error)?;
                let fault: Option<String> = row.try_get("fault_code").map_err(database::error)?;
                let validated = availability.as_deref() == Some("ready") || fault.as_deref() == Some("storage.command_conflict");
                if id != provenance.session_id.as_str() && seen.as_deref() == Some(repair_id.as_str()) && validated {
                    conflict = Some(id);
                }
            }
            let manifest = summary.observed_manifest();
            sqlx::query("INSERT INTO sessions (session_id, relative_path, title, workspace_json, created_at_ms, updated_at_ms, head_sequence, schema_version, availability, fault_code, last_run_id, last_run_state, seen_repair_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'ready', NULL, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET relative_path=excluded.relative_path, title=excluded.title, workspace_json=excluded.workspace_json, created_at_ms=excluded.created_at_ms, updated_at_ms=excluded.updated_at_ms, head_sequence=excluded.head_sequence, schema_version=1, availability='ready', fault_code=NULL, last_run_id=excluded.last_run_id, last_run_state=excluded.last_run_state, seen_repair_id=excluded.seen_repair_id")
                .bind(manifest.session_id().as_str()).bind(filesystem::session_relative_path(manifest.session_id())).bind(manifest.title())
                .bind(manifest.workspace().map(|value| dto::canonical_json(&value)).transpose()?)
                .bind(manifest.created_at_ms()).bind(manifest.updated_at_ms()).bind(manifest.head_sequence() as i64)
                .bind(summary.last_run_id().map(RunId::as_str)).bind(summary.last_run_state().map(run_store::state_name)).bind(repair_id.as_str())
                .execute(&mut *transaction).await.map_err(database::error)?;
            if let Some(first) = conflict {
                sqlx::query("UPDATE sessions SET availability='unavailable', fault_code='storage.command_conflict' WHERE session_id IN (?, ?)")
                    .bind(first).bind(provenance.session_id.as_str()).execute(&mut *transaction).await.map_err(database::error)?;
                sqlx::query("UPDATE creation_commands SET state='failed', receipt_json=NULL, failure_code='storage.command_conflict' WHERE command_id=?")
                    .bind(provenance.operation_id.as_str()).execute(&mut *transaction).await.map_err(database::error)?;
            } else {
                // Replace stale catalog claims only with this scan's validated evidence.
                sqlx::query("DELETE FROM creation_commands WHERE session_id=? AND command_id<>?")
                    .bind(provenance.session_id.as_str()).bind(provenance.operation_id.as_str()).execute(&mut *transaction).await.map_err(database::error)?;
                sqlx::query("INSERT INTO creation_commands (command_id, payload_hash, request_json, session_id, creation_event_id, created_at_ms, state, receipt_json, failure_code) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, NULL) ON CONFLICT(command_id) DO UPDATE SET payload_hash=excluded.payload_hash, request_json=excluded.request_json, session_id=excluded.session_id, creation_event_id=excluded.creation_event_id, created_at_ms=excluded.created_at_ms, state='accepted', receipt_json=excluded.receipt_json, failure_code=NULL")
                    .bind(provenance.operation_id.as_str()).bind(provenance.payload_hash.as_slice()).bind(&provenance.request_json)
                    .bind(provenance.session_id.as_str()).bind(provenance.creation_event_id.as_str()).bind(provenance.created_at_ms).bind(dto::canonical_json(&provenance.receipt)?)
                    .execute(&mut *transaction).await.map_err(database::error)?;
            }
            Ok(())
        }.await;
        database::finish_transaction(transaction, result).await
    }.await;
    database::finish_read(connection, &inner.lifecycle, result).await
}

async fn record_fault(
    inner: &StoreInner,
    repair_id: &StoredEventId,
    id: &ApplicationSessionId,
    error: StorageError,
) -> Result<()> {
    let _lock = inner.catalog_lock.lock().await;
    let mut connection = catalog_ops::connect_maintenance(inner).await?;
    // Unknown bad files have no trustworthy title/time/head. Keep known observations.
    let result = if error.kind() == StorageErrorKind::NotFound {
        // Leave known absent DBs unseen and unchanged until the complete-scan complement.
        sqlx::query("INSERT INTO sessions (session_id, relative_path, title, created_at_ms, updated_at_ms, head_sequence, schema_version, availability, fault_code) VALUES (?, ?, '', 0, 0, 0, 1, 'missing', 'storage.not_found') ON CONFLICT(session_id) DO NOTHING")
            .bind(id.as_str()).bind(filesystem::session_relative_path(id))
            .execute(&mut connection).await
    } else {
        sqlx::query("INSERT INTO sessions (session_id, relative_path, title, created_at_ms, updated_at_ms, head_sequence, schema_version, availability, fault_code, seen_repair_id) VALUES (?, ?, '', 0, 0, 0, 1, 'unavailable', ?, ?) ON CONFLICT(session_id) DO UPDATE SET relative_path=excluded.relative_path, availability=excluded.availability, fault_code=excluded.fault_code, seen_repair_id=excluded.seen_repair_id")
            .bind(id.as_str()).bind(filesystem::session_relative_path(id)).bind(error.code()).bind(repair_id.as_str())
            .execute(&mut connection).await
    }.map_err(|_| StorageError::new(StorageErrorKind::CommitUnknown)).map(|_| ());
    database::finish_read(connection, &inner.lifecycle, result).await
}

async fn reject_bucket(inner: &StoreInner, prefix: &str, repair_id: &StoredEventId) -> Result<()> {
    let _lock = inner.catalog_lock.lock().await;
    let mut connection = catalog_ops::connect_maintenance(inner).await?;
    let result = sqlx::query("UPDATE sessions SET availability='unavailable', fault_code='storage.unavailable', seen_repair_id=? WHERE substr(session_id, 1, 2)=?")
        .bind(repair_id.as_str()).bind(prefix).execute(&mut connection).await.map_err(|_| StorageError::new(StorageErrorKind::CommitUnknown)).map(|_| ());
    database::finish_read(connection, &inner.lifecycle, result).await
}

async fn finish(
    inner: &StoreInner,
    repair_id: &StoredEventId,
    scanned: u64,
    ignored: u64,
) -> Result<RepairReport> {
    let _lock = inner.catalog_lock.lock().await;
    let mut connection = catalog_ops::connect_maintenance(inner).await?;
    let result = async {
        let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await.map_err(database::error)?;
        let result = async {
            catalog_ops::validate_creating_reservations(&mut transaction).await?;
            // Only a complete scan can infer absence. NULL must participate in the complement.
            // Only structurally validated reservations can still materialize their original session.
            sqlx::query("UPDATE sessions SET availability='missing', fault_code='storage.not_found' WHERE seen_repair_id IS NOT ? AND NOT (availability='creating' AND EXISTS (SELECT 1 FROM creation_commands c WHERE c.session_id=sessions.session_id AND c.state='creating'))")
                .bind(repair_id.as_str()).execute(&mut *transaction).await.map_err(database::error)?;
            let row = sqlx::query("SELECT (SELECT count(*) FROM sessions WHERE availability='ready') AS ready, (SELECT count(*) FROM sessions WHERE availability='missing') AS missing, (SELECT count(*) FROM sessions WHERE availability='unavailable') AS unavailable, (SELECT count(*) FROM creation_commands WHERE state='failed' AND failure_code='storage.command_conflict') AS conflicts")
                .fetch_one(&mut *transaction).await.map_err(database::error)?;
            let count = |name| -> Result<u64> { u64::try_from(row.try_get::<i64, _>(name).map_err(database::error)?).map_err(|_| integrity()) };
            let report = RepairReport { scanned_sessions: scanned, ignored_entries: ignored, ready_sessions: count("ready")?, missing_sessions: count("missing")?, unavailable_sessions: count("unavailable")?, conflicting_commands: count("conflicts")? };
            sqlx::query("UPDATE catalog_meta SET repair_required=0 WHERE singleton=1")
                .execute(&mut *transaction).await.map_err(database::error)?;
            Ok(report)
        }.await;
        database::finish_transaction(transaction, result).await
    }.await;
    database::finish_read(connection, &inner.lifecycle, result).await
}
