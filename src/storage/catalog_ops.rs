use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteRow};

use super::{
    dto::{self, CreationProvenance},
    session_schema::{integrity, workspace},
    *,
};

type Result<T> = std::result::Result<T, StorageError>;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum CreationState {
    Creating,
    Accepted,
    Failed(StorageError),
}

#[derive(Clone)]
pub(super) struct Reservation {
    pub provenance: CreationProvenance,
    pub state: CreationState,
}

pub(super) struct Entry {
    pub summary: SessionSummary,
    pub reservation: Reservation,
}

pub(super) async fn connect(inner: &StoreInner, writable: bool) -> Result<SqliteConnection> {
    connect_checked(inner, writable, false).await
}

// Only explicit repair may bypass the durable intent gate.
pub(super) async fn connect_maintenance(inner: &StoreInner) -> Result<SqliteConnection> {
    connect_checked(inner, true, true).await
}

async fn connect_checked(
    inner: &StoreInner,
    writable: bool,
    repairing: bool,
) -> Result<SqliteConnection> {
    filesystem::check_directory(&inner.root)?;
    let path = inner.root.join("catalog.sqlite3");
    // Inspect identity before a writable connection can change journal mode.
    let mut connection = database::open(&path, true, &inner.lifecycle).await?;
    let result = async {
        catalog::validate(&mut connection).await?;
        let repair: i64 = sqlx::query("SELECT repair_required FROM catalog_meta WHERE singleton=1")
            .fetch_one(&mut connection)
            .await
            .map_err(database::error)?
            .try_get(0)
            .map_err(database::error)?;
        if repair != 0 && !repairing {
            return Err(StorageError::new(StorageErrorKind::CatalogRepairRequired));
        }
        Ok(())
    }
    .await;
    if !writable && result.is_ok() {
        return Ok(connection);
    }
    database::finish_read(connection, &inner.lifecycle, result).await?;
    database::open(&path, false, &inner.lifecycle).await
}

fn reservation(row: &SqliteRow) -> Result<Reservation> {
    let operation_id: OperationId = row
        .try_get::<String, _>("command_id")
        .map_err(database::error)?
        .parse()
        .map_err(|_| integrity())?;
    let session_id: ApplicationSessionId = row
        .try_get::<String, _>("session_id")
        .map_err(database::error)?
        .parse()
        .map_err(|_| integrity())?;
    let provenance = CreationProvenance {
        receipt: CommitReceipt::single(operation_id.clone(), session_id.clone(), 1)?,
        operation_id,
        session_id,
        method: "create_session".into(),
        request_json: row.try_get("request_json").map_err(database::error)?,
        payload_hash: row
            .try_get::<Vec<u8>, _>("payload_hash")
            .map_err(database::error)?
            .try_into()
            .map_err(|_| integrity())?,
        creation_event_id: row
            .try_get::<String, _>("creation_event_id")
            .map_err(database::error)?
            .parse()
            .map_err(|_| integrity())?,
        created_at_ms: row.try_get("created_at_ms").map_err(database::error)?,
    };
    provenance.request()?;
    let receipt: Option<String> = row.try_get("receipt_json").map_err(database::error)?;
    let failure: Option<String> = row.try_get("failure_code").map_err(database::error)?;
    let state = match row
        .try_get::<String, _>("state")
        .map_err(database::error)?
        .as_str()
    {
        "creating" if receipt.is_none() && failure.is_none() => CreationState::Creating,
        "accepted" if failure.is_none() => {
            if dto::decode::<CommitReceipt>(receipt.as_deref().ok_or_else(integrity)?)?
                != provenance.receipt
            {
                return Err(integrity());
            }
            CreationState::Accepted
        }
        "failed" if receipt.is_none() => {
            let error = failure
                .as_deref()
                .and_then(StorageError::from_code)
                .ok_or_else(integrity)?;
            if !matches!(
                error.kind(),
                StorageErrorKind::Integrity
                    | StorageErrorKind::Unavailable
                    | StorageErrorKind::UnsupportedVersion
                    | StorageErrorKind::CommandConflict
            ) {
                return Err(integrity());
            }
            CreationState::Failed(error.not_committed())
        }
        _ => return Err(integrity()),
    };
    Ok(Reservation { provenance, state })
}

pub(super) fn summary(row: &SqliteRow) -> Result<SessionSummary> {
    let id: ApplicationSessionId = row
        .try_get::<String, _>("session_id")
        .map_err(database::error)?
        .parse()
        .map_err(|_| integrity())?;
    if row
        .try_get::<String, _>("relative_path")
        .map_err(database::error)?
        != filesystem::session_relative_path(&id)
    {
        return Err(integrity());
    }
    let availability = match row
        .try_get::<String, _>("availability")
        .map_err(database::error)?
        .as_str()
    {
        "creating" => SessionAvailability::Creating,
        "ready" => SessionAvailability::Ready,
        "missing" => SessionAvailability::Missing,
        "unavailable" => SessionAvailability::Unavailable,
        _ => return Err(integrity()),
    };
    let head: i64 = row.try_get("head_sequence").map_err(database::error)?;
    let version: i64 = row.try_get("schema_version").map_err(database::error)?;
    let created: i64 = row.try_get("created_at_ms").map_err(database::error)?;
    let updated: i64 = row.try_get("updated_at_ms").map_err(database::error)?;
    if head < 0
        || version < 1
        || created < 0
        || updated < 0
        || (availability == SessionAvailability::Ready
            && (head == 0 || !(1..=2).contains(&version)))
    {
        return Err(integrity());
    }
    let fault: Option<String> = row.try_get("fault_code").map_err(database::error)?;
    let fault_code = fault
        .map(|code| {
            StorageError::from_code(&code)
                .map(|error| error.code())
                .ok_or_else(integrity)
        })
        .transpose()?;
    if matches!(
        availability,
        SessionAvailability::Ready | SessionAvailability::Creating
    ) && fault_code.is_some()
    {
        return Err(integrity());
    }
    let last_run_id: Option<RunId> = row
        .try_get::<Option<String>, _>("last_run_id")
        .map_err(database::error)?
        .map(|id| id.parse().map_err(|_| integrity()))
        .transpose()?;
    let state: Option<String> = row.try_get("last_run_state").map_err(database::error)?;
    let last_run_state = state
        .map(|state| {
            serde_json::from_value::<RecordedRunState>(state.into()).map_err(|_| integrity())
        })
        .transpose()?;
    if last_run_id.is_some() != last_run_state.is_some() {
        return Err(integrity());
    }
    Ok(SessionSummary {
        manifest: SessionManifest {
            session_id: id,
            title: row.try_get("title").map_err(database::error)?,
            workspace: workspace(row.try_get("workspace_json").map_err(database::error)?)?,
            created_at_ms: created,
            updated_at_ms: updated,
            head_sequence: head as u64,
        },
        schema_version: version as u64,
        availability,
        fault_code,
        last_run_id,
        last_run_state,
    })
}

async fn entry_rows(connection: &mut SqliteConnection, id: &ApplicationSessionId) -> Result<Entry> {
    let row = sqlx::query("SELECT * FROM sessions WHERE session_id=?")
        .bind(id.as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(database::error)?
        .ok_or_else(|| StorageError::new(StorageErrorKind::NotFound))?;
    let summary = summary(&row)?;
    if summary.availability == SessionAvailability::Missing {
        return Err(StorageError::new(StorageErrorKind::NotFound));
    }
    if summary.availability == SessionAvailability::Unavailable {
        // A failed creation still needs its original static failure below.
        if summary.fault_code.is_none() {
            return Err(StorageError::new(StorageErrorKind::Unavailable));
        }
    }
    let row = sqlx::query("SELECT * FROM creation_commands WHERE session_id=?")
        .bind(id.as_str())
        .fetch_optional(connection)
        .await
        .map_err(database::error)?
        .ok_or_else(|| {
            if summary.availability == SessionAvailability::Unavailable {
                StorageError::new(StorageErrorKind::Unavailable)
            } else {
                integrity()
            }
        })?;
    let reservation = reservation(&row)?;
    let input = reservation.provenance.request()?;
    if summary.manifest.created_at_ms != reservation.provenance.created_at_ms
        || summary.manifest.workspace.as_deref() != input.workspace()
        || (summary.availability == SessionAvailability::Ready
            && reservation.state != CreationState::Accepted)
        || (summary.availability == SessionAvailability::Creating
            && (reservation.state != CreationState::Creating
                || summary.manifest.head_sequence != 0
                || summary.manifest.title != input.title()
                || summary.manifest.updated_at_ms != reservation.provenance.created_at_ms
                || summary.schema_version != 1
                || summary.last_run_id.is_some()
                || summary.last_run_state.is_some()))
    {
        return Err(integrity());
    }
    Ok(Entry {
        summary,
        reservation,
    })
}

// Called inside repair's final transaction before exempting recoverable reservations.
pub(super) async fn validate_creating_reservations(
    connection: &mut SqliteConnection,
) -> Result<()> {
    let mut after: Option<String> = None;
    loop {
        let query = if let Some(id) = &after {
            sqlx::query("SELECT session_id, seen_repair_id FROM sessions WHERE availability='creating' AND session_id > ? AND EXISTS (SELECT 1 FROM creation_commands c WHERE c.session_id=sessions.session_id AND c.state='creating') ORDER BY session_id LIMIT 1")
                .bind(id)
        } else {
            // Include even an empty malformed ID on the first page.
            sqlx::query(
                "SELECT session_id, seen_repair_id FROM sessions WHERE availability='creating' AND EXISTS (SELECT 1 FROM creation_commands c WHERE c.session_id=sessions.session_id AND c.state='creating') ORDER BY session_id LIMIT 1",
            )
        };
        let Some(row) = query
            .fetch_optional(&mut *connection)
            .await
            .map_err(database::error)?
        else {
            break;
        };
        let id: String = row.try_get("session_id").map_err(database::error)?;
        let parsed: ApplicationSessionId = id.parse().map_err(|_| integrity())?;
        if let Some(seen) = row
            .try_get::<Option<String>, _>("seen_repair_id")
            .map_err(database::error)?
        {
            seen.parse::<StoredEventId>().map_err(|_| integrity())?;
        }
        entry_rows(connection, &parsed).await?;
        after = Some(id);
    }
    Ok(())
}

pub(super) async fn entry(inner: &StoreInner, id: &ApplicationSessionId) -> Result<Entry> {
    let _lock = inner.catalog_lock.lock().await;
    let mut connection = connect(inner, false).await?;
    let result = entry_rows(&mut connection, id).await;
    database::finish_read(connection, &inner.lifecycle, result).await
}

pub(super) async fn reserve(
    inner: &StoreInner,
    input: &CreateSession,
) -> Result<(Reservation, bool)> {
    let _lock = inner.catalog_lock.lock().await;
    let mut connection = connect(inner, true)
        .await
        .map_err(StorageError::not_committed)?;
    let result = async {
        let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await.map_err(|error| database::error(error).not_committed())?;
        let result = async {
            let request = dto::canonical_json(&input.request())?;
            if let Some(row) = sqlx::query("SELECT * FROM creation_commands WHERE command_id=?").bind(input.operation_id().as_str())
                .fetch_optional(&mut *transaction).await.map_err(database::error)? {
                let reserved = reservation(&row)?;
                if reserved.provenance.payload_hash != dto::hash(&request) || reserved.provenance.request_json != request {
                    return Err(StorageError::new(StorageErrorKind::CommandConflict));
                }
                // An accepted command keeps its receipt even when the session is no longer usable.
                if reserved.state == CreationState::Accepted { return Ok((reserved, true)); }
                let entry = entry_rows(&mut transaction, &reserved.provenance.session_id).await?;
                if let CreationState::Failed(error) = entry.reservation.state { return Err(error); }
                if matches!(entry.summary.availability, SessionAvailability::Missing | SessionAvailability::Unavailable) {
                    return Err(StorageError::new(StorageErrorKind::Unavailable));
                }
                return Ok((reserved, true));
            }
            let provenance = CreationProvenance::new(input)?;
            sqlx::query("INSERT INTO creation_commands (command_id, payload_hash, request_json, session_id, creation_event_id, created_at_ms, state) VALUES (?, ?, ?, ?, ?, ?, 'creating')")
                .bind(provenance.operation_id.as_str()).bind(provenance.payload_hash.as_slice()).bind(&provenance.request_json)
                .bind(provenance.session_id.as_str()).bind(provenance.creation_event_id.as_str()).bind(provenance.created_at_ms)
                .execute(&mut *transaction).await.map_err(database::error)?;
            sqlx::query("INSERT INTO sessions (session_id, relative_path, title, workspace_json, created_at_ms, updated_at_ms, head_sequence, schema_version, availability) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 'creating')")
                .bind(provenance.session_id.as_str()).bind(filesystem::session_relative_path(&provenance.session_id)).bind(input.title())
                .bind(input.workspace().map(|value| dto::canonical_json(&value)).transpose()?)
                .bind(provenance.created_at_ms).bind(provenance.created_at_ms)
                .execute(&mut *transaction).await.map_err(database::error)?;
            Ok((Reservation { provenance, state: CreationState::Creating }, false))
        }.await;
        database::finish_transaction(transaction, result).await
    }.await;
    let (reservation, warning) = database::finish_write(
        connection,
        &inner.lifecycle,
        result,
        #[cfg(test)]
        false,
    )
    .await?;
    if warning.is_some() {
        return Err(StorageError::new(StorageErrorKind::CreationIncomplete).unknown());
    }
    Ok(reservation)
}

pub(super) async fn complete(
    inner: &StoreInner,
    provenance: &CreationProvenance,
    manifest: &SessionManifest,
    schema_version: u64,
) -> Result<Option<CleanupWarning>> {
    let _lock = inner.catalog_lock.lock().await;
    let mut connection = connect(inner, true).await?;
    let result = async {
        let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await.map_err(database::error)?;
        let result = async {
            let entry = entry_rows(&mut transaction, &provenance.session_id).await?;
            if entry.reservation.provenance != *provenance { return Err(integrity()); }
            if entry.reservation.state == CreationState::Accepted { return Ok(()); }
            if entry.reservation.state != CreationState::Creating || entry.summary.availability != SessionAvailability::Creating { return Err(integrity()); }
            sqlx::query("UPDATE sessions SET title=?, updated_at_ms=?, head_sequence=?, schema_version=?, availability='ready', fault_code=NULL WHERE session_id=?")
                .bind(manifest.title()).bind(manifest.updated_at_ms()).bind(manifest.head_sequence() as i64).bind(schema_version as i64).bind(provenance.session_id.as_str())
                .execute(&mut *transaction).await.map_err(database::error)?;
            sqlx::query("UPDATE creation_commands SET state='accepted', receipt_json=? WHERE command_id=?")
                .bind(dto::canonical_json(&provenance.receipt)?).bind(provenance.operation_id.as_str())
                .execute(&mut *transaction).await.map_err(database::error)?;
            Ok(())
        }.await;
        database::finish_transaction(transaction, result).await
    }.await;
    database::finish_write(
        connection,
        &inner.lifecycle,
        result,
        #[cfg(test)]
        false,
    )
    .await
    .map(|(_, warning)| warning)
}

pub(super) async fn fail(
    inner: &StoreInner,
    provenance: &CreationProvenance,
    error: StorageError,
) -> Result<()> {
    let _lock = inner.catalog_lock.lock().await;
    let mut connection = connect(inner, true).await?;
    let result = async {
        let mut transaction = connection
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database::error)?;
        let result = async {
            let entry = entry_rows(&mut transaction, &provenance.session_id).await?;
            if entry.reservation.provenance != *provenance
                || entry.reservation.state != CreationState::Creating
            {
                return Err(integrity());
            }
            sqlx::query(
                "UPDATE creation_commands SET state='failed', failure_code=? WHERE command_id=?",
            )
            .bind(error.code())
            .bind(provenance.operation_id.as_str())
            .execute(&mut *transaction)
            .await
            .map_err(database::error)?;
            sqlx::query(
                "UPDATE sessions SET availability='unavailable', fault_code=? WHERE session_id=?",
            )
            .bind(error.code())
            .bind(provenance.session_id.as_str())
            .execute(&mut *transaction)
            .await
            .map_err(database::error)?;
            Ok(())
        }
        .await;
        database::finish_transaction(transaction, result).await
    }
    .await;
    database::finish_read(connection, &inner.lifecycle, result).await
}

pub(super) async fn list(
    inner: &StoreInner,
    after: Option<ApplicationSessionId>,
    limit: i64,
) -> Result<SessionPage> {
    let _lock = inner.catalog_lock.lock().await;
    let mut connection = connect(inner, false).await?;
    let result = async {
        // Empty text is below every validated UUID and gives the first page the same range plan.
        let rows =
            sqlx::query("SELECT * FROM sessions WHERE session_id > ? ORDER BY session_id LIMIT ?")
                .bind(after.as_ref().map_or("", ApplicationSessionId::as_str))
                .bind(limit)
                .fetch_all(&mut connection)
                .await
                .map_err(database::error)?;
        let mut sessions = rows.iter().map(summary).collect::<Result<Vec<_>>>()?;
        let has_more = sessions.len() as u64 == limit as u64;
        if has_more {
            sessions.pop();
        }
        let next_after = sessions
            .last()
            .map(|session| session.session_id().clone())
            .or(after);
        Ok(SessionPage {
            sessions,
            has_more,
            next_after,
        })
    }
    .await;
    database::finish_read(connection, &inner.lifecycle, result).await
}
