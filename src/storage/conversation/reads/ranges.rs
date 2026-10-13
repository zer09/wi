use sqlx::{Row, SqliteConnection};

use super::{Descriptor, Result, integer, integrity, unsigned};
use crate::{
    conversation::{EntryId, primitives::CHUNK_BYTES},
    storage::{ConversationError, RunId, database},
};

// Four bounded blobs suffice for one compact entry, regardless of field length.
const RANGE_CHUNKS: i64 = 4;

pub(super) async fn suffix(
    sql: &mut SqliteConnection,
    run: &RunId,
    entry: &EntryId,
    field: &Descriptor,
    upper: u64,
) -> Result<(u64, String)> {
    if upper > field.total {
        return Err(ConversationError::CursorInvalid);
    }
    if upper == 0 {
        if field.total == 0 {
            let exists: Option<i64> = sqlx::query_scalar("SELECT start_byte FROM conversation_chunks WHERE run_id=? AND entry_id=? AND field_id=? LIMIT 1")
                .bind(run.as_str()).bind(entry.to_string()).bind(&field.id)
                .fetch_optional(sql).await.map_err(database::error)?;
            if exists.is_some() {
                return Err(integrity().into());
            }
        }
        return Ok((0, String::new()));
    }
    let rows = sqlx::query("SELECT start_byte,bytes FROM conversation_chunks WHERE run_id=? AND entry_id=? AND field_id=? AND start_byte<? ORDER BY start_byte DESC LIMIT ?")
        .bind(run.as_str()).bind(entry.to_string()).bind(&field.id).bind(integer(upper)?)
        .bind(RANGE_CHUNKS).fetch_all(&mut *sql).await.map_err(database::error)?;
    #[cfg(test)]
    super::measure(
        0,
        rows.len(),
        rows.iter()
            .map(|row| row.get::<Vec<u8>, _>("bytes").len())
            .sum(),
    );
    if rows.is_empty() {
        return Err(integrity().into());
    }
    let mut end = upper;
    let mut pieces = Vec::new();
    let mut top_end = 0;
    for (index, row) in rows.iter().enumerate() {
        let start = unsigned(row.try_get("start_byte").map_err(database::error)?)?;
        let bytes: Vec<u8> = row.try_get("bytes").map_err(database::error)?;
        if bytes.is_empty() || bytes.len() > CHUNK_BYTES {
            return Err(integrity().into());
        }
        let text = String::from_utf8(bytes).map_err(|_| integrity())?;
        let chunk_end = start.checked_add(text.len() as u64).ok_or_else(integrity)?;
        if chunk_end > field.total || (index > 0 && chunk_end != end) {
            return Err(integrity().into());
        }
        if index == 0 {
            if chunk_end < upper {
                return Err(integrity().into());
            }
            top_end = chunk_end;
        }
        let cut = usize::try_from(end - start).map_err(|_| integrity())?;
        if !text.is_char_boundary(cut) {
            return Err(ConversationError::CursorInvalid);
        }
        pieces.push(text[..cut].to_owned());
        end = start;
    }
    // Check the neighboring offsets without fetching their content.
    let previous: Option<(i64, i64)> = sqlx::query_as("SELECT start_byte,length(bytes) FROM conversation_chunks WHERE run_id=? AND entry_id=? AND field_id=? AND start_byte<? ORDER BY start_byte DESC LIMIT 1")
        .bind(run.as_str()).bind(entry.to_string()).bind(&field.id).bind(integer(end)?)
        .fetch_optional(&mut *sql).await.map_err(database::error)?;
    let previous_end = match previous {
        None => 0,
        Some((start, size)) => {
            let size = unsigned(size)?;
            if size == 0 || size > CHUNK_BYTES as u64 {
                return Err(integrity().into());
            }
            unsigned(start)?.checked_add(size).ok_or_else(integrity)?
        }
    };
    let next: Option<(i64, i64)> = sqlx::query_as("SELECT start_byte,length(bytes) FROM conversation_chunks WHERE run_id=? AND entry_id=? AND field_id=? AND start_byte>? ORDER BY start_byte LIMIT 1")
        .bind(run.as_str()).bind(entry.to_string()).bind(&field.id)
        .bind(rows[0].get::<i64,_>("start_byte"))
        .fetch_optional(sql).await.map_err(database::error)?;
    if previous_end != end {
        return Err(integrity().into());
    }
    match next {
        None if top_end != field.total => return Err(integrity().into()),
        Some((start, size)) => {
            let size = unsigned(size)?;
            if unsigned(start)? != top_end
                || size == 0
                || size > CHUNK_BYTES as u64
                || top_end
                    .checked_add(size)
                    .is_none_or(|end| end > field.total)
            {
                return Err(integrity().into());
            }
        }
        _ => {}
    }
    pieces.reverse();
    Ok((end, pieces.concat()))
}
