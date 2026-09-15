use sqlx::{Connection, Row, SqliteConnection};

use super::{dto, session_schema::integrity, *};

pub(super) async fn reconcile(
    connection: &mut SqliteConnection,
    provenance: &CreationProvenance,
    owner: &StoredEventId,
) -> Result<(), StorageError> {
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| database::error(error).not_committed())?;
    let result = async {
        let id = provenance.session_id();
        let manifest = session_schema::validate(&mut transaction, id, Some(provenance)).await?;
        // The v1 unique partial index permits at most one unfinished run.
        let row = sqlx::query("SELECT run_id FROM runs WHERE state IN ('accepted','running') AND owner_instance_id <> ?")
            .bind(owner.as_str()).fetch_optional(&mut *transaction).await.map_err(database::error)?;
        let Some(row) = row else { return Ok(()); };
        let run_id: RunId = row.try_get::<String, _>(0).map_err(database::error)?
            .parse().map_err(|_| integrity())?;
        run_store::run_record(&mut transaction, id, &run_id).await?.ok_or_else(integrity)?;
        let sequence = session::next_sequence(manifest.head_sequence())?;
        let timestamp = dto::now_ms()?;
        let payload = dto::canonical_json(&InterruptedPayload {
            run_id: run_id.clone(), reason: InterruptionReason::ProcessRestart,
        })?;
        sqlx::query("INSERT INTO events (sequence, event_id, event_type, event_version, created_at_ms, run_id, payload_json) VALUES (?, ?, 'run.interrupted', 1, ?, ?, ?)")
            .bind(sequence).bind(StoredEventId::new().as_str()).bind(timestamp).bind(run_id.as_str()).bind(&payload)
            .execute(&mut *transaction).await.map_err(database::error)?;
        sqlx::query("UPDATE runs SET state='interrupted', terminal_sequence=?, terminal_json=? WHERE run_id=?")
            .bind(sequence).bind(payload).bind(run_id.as_str()).execute(&mut *transaction).await.map_err(database::error)?;
        sqlx::query("UPDATE manifest SET head_sequence=?, updated_at_ms=? WHERE singleton=1")
            .bind(sequence).bind(timestamp).execute(&mut *transaction).await.map_err(database::error)?;
        Ok(())
    }.await;
    database::finish_transaction(transaction, result).await
}
