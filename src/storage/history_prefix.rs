use std::collections::BTreeMap;

use futures_util::TryStreamExt;
use ring::digest::{Context, SHA256};
use serde::Serialize;
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};

use super::{StorageError, database, dto, records::invalid, session_schema::integrity};
use crate::provider::replay::valid_digest;

type Result<T> = std::result::Result<T, StorageError>;

// Call only inside an operation-owned read. The fixed prefix remains immutable if
// another operation later appends. Checkpoints retain digests, never the event log.
pub(super) async fn digest(
    connection: &mut SqliteConnection,
    through: u64,
    checkpoints: &[(u64, String)],
) -> Result<String> {
    if through == 0 || through > i64::MAX as u64 {
        return Err(invalid());
    }
    let mut expected = BTreeMap::new();
    for (sequence, digest) in checkpoints {
        if *sequence == 0 || *sequence > through || !valid_digest(digest) {
            return Err(integrity());
        }
        if expected
            .insert(*sequence, digest)
            .is_some_and(|old| old != digest)
        {
            return Err(integrity());
        }
    }
    let head: i64 = sqlx::query("SELECT head_sequence FROM manifest WHERE singleton=1")
        .fetch_one(&mut *connection)
        .await
        .map_err(database::error)?
        .try_get(0)
        .map_err(database::error)?;
    if head < 1 || through > head as u64 {
        return Err(invalid());
    }
    let mut context = Context::new(&SHA256);
    context.update(b"wi.history-prefix.v1\0");
    let mut sequence = 0;
    let mut rows = sqlx::query("SELECT * FROM events WHERE sequence<=? ORDER BY sequence")
        .bind(through as i64)
        .fetch(connection);
    while let Some(row) = rows.try_next().await.map_err(database::error)? {
        sequence += 1;
        if row.try_get::<i64, _>("sequence").map_err(database::error)? as u64 != sequence {
            return Err(integrity());
        }
        let json = canonical_row(&row)?;
        context.update(&(json.len() as u64).to_be_bytes());
        context.update(json.as_bytes());
        if let Some(digest) = expected.get(&sequence)
            && hex(context.clone().finish().as_ref()) != **digest
        {
            return Err(integrity());
        }
    }
    if sequence != through {
        return Err(integrity());
    }
    Ok(hex(context.finish().as_ref()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn canonical_row(row: &SqliteRow) -> Result<String> {
    #[derive(Serialize)]
    struct CanonicalRow {
        sequence: i64,
        event_id: String,
        event_type: String,
        event_version: i64,
        created_at_ms: i64,
        run_id: Option<String>,
        source_event_id: Option<String>,
        source_sequence: Option<i64>,
        payload: serde_json::Value,
    }
    dto::canonical_json(&CanonicalRow {
        sequence: row.try_get("sequence").map_err(database::error)?,
        event_id: row.try_get("event_id").map_err(database::error)?,
        event_type: row.try_get("event_type").map_err(database::error)?,
        event_version: row.try_get("event_version").map_err(database::error)?,
        created_at_ms: row.try_get("created_at_ms").map_err(database::error)?,
        run_id: row.try_get("run_id").map_err(database::error)?,
        source_event_id: row.try_get("source_event_id").map_err(database::error)?,
        source_sequence: row.try_get("source_sequence").map_err(database::error)?,
        payload: dto::decode(
            &row.try_get::<String, _>("payload_json")
                .map_err(database::error)?,
        )?,
    })
    .map_err(|_| integrity())
}
