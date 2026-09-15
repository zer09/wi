use sqlx::{Connection, Row, SqliteConnection};

use super::{dto, session_schema::integrity, *};

type Result<T> = std::result::Result<T, StorageError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefreshResult {
    Updated,
    Unchanged,
}

// Read manifest and run state in one snapshot, never from a caller's receipt.
pub(super) async fn observe(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
) -> Result<SessionSummary> {
    let manifest = session_schema::validate(connection, id, None).await?;
    let run = sqlx::query("SELECT run_id FROM runs ORDER BY accepted_sequence DESC LIMIT 1")
        .fetch_optional(&mut *connection)
        .await
        .map_err(database::error)?;
    let mut last_run_id = None;
    let mut last_run_state = None;
    if let Some(row) = run {
        let run_id: RunId = row
            .try_get::<String, _>(0)
            .map_err(database::error)?
            .parse()
            .map_err(|_| integrity())?;
        let run = run_store::run_record(connection, id, &run_id)
            .await?
            .ok_or_else(integrity)?;
        last_run_state = Some(run.state());
        last_run_id = Some(run_id);
    }
    Ok(SessionSummary {
        manifest,
        schema_version: 1,
        availability: SessionAvailability::Ready,
        fault_code: None,
        last_run_id,
        last_run_state,
    })
}

pub(super) async fn refresh(
    inner: &StoreInner,
    id: &ApplicationSessionId,
) -> Result<RefreshResult> {
    let observed = {
        let _lock = inner.session_lock(id).await;
        let (mut connection, _) = session::connection(inner, id, false).await?;
        let result = async {
            let mut transaction = connection.begin().await.map_err(database::error)?;
            let result = observe(&mut transaction, id).await;
            transaction.rollback().await.map_err(database::error)?;
            result
        }
        .await;
        database::finish_read(connection, &inner.lifecycle, result).await?
    };
    // Release the session connection and lock before taking catalog ownership.
    publish(inner, &observed).await
}

pub(super) async fn publish(
    inner: &StoreInner,
    observed: &SessionSummary,
) -> Result<RefreshResult> {
    let _lock = inner.catalog_lock.lock().await;
    let mut connection = catalog_ops::connect(inner, true).await?;
    let result = async {
        let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await.map_err(database::error)?;
        let result = async {
            let row = sqlx::query("SELECT * FROM sessions WHERE session_id=?")
                .bind(observed.session_id().as_str()).fetch_optional(&mut *transaction)
                .await.map_err(database::error)?.ok_or_else(|| StorageError::new(StorageErrorKind::NotFound))?;
            let current = catalog_ops::summary(&row)?;
            match current.availability() {
                SessionAvailability::Ready => {}
                SessionAvailability::Creating => return Err(StorageError::new(StorageErrorKind::CreationIncomplete)),
                SessionAvailability::Missing => return Err(StorageError::new(StorageErrorKind::NotFound)),
                SessionAvailability::Unavailable => return Err(StorageError::new(StorageErrorKind::Unavailable)),
            }
            if current.observed_head_sequence() >= observed.observed_head_sequence() {
                if current.observed_head_sequence() == observed.observed_head_sequence() && current != *observed {
                    return Err(integrity());
                }
                return Ok(RefreshResult::Unchanged);
            }
            let manifest = observed.observed_manifest();
            sqlx::query("UPDATE sessions SET title=?, workspace_json=?, created_at_ms=?, updated_at_ms=?, head_sequence=?, schema_version=?, last_run_id=?, last_run_state=? WHERE session_id=? AND availability='ready' AND head_sequence < ?")
                .bind(manifest.title()).bind(manifest.workspace().map(|value| dto::canonical_json(&value)).transpose()?)
                .bind(manifest.created_at_ms()).bind(manifest.updated_at_ms()).bind(manifest.head_sequence() as i64)
                .bind(observed.schema_version() as i64).bind(observed.last_run_id().map(RunId::as_str))
                .bind(observed.last_run_state().map(run_store::state_name)).bind(observed.session_id().as_str())
                .bind(manifest.head_sequence() as i64).execute(&mut *transaction).await.map_err(database::error)?;
            Ok(RefreshResult::Updated)
        }.await;
        database::finish_transaction(transaction, result).await
    }.await;
    let (result, warning) = database::finish_write(
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
    Ok(result)
}
