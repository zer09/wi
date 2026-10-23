use sqlx::{Row, SqliteConnection};

use super::super::fields::{self, FieldKey, FieldOrder};
use super::{Result, integer, integrity, rows::Entry, unsigned};
use crate::{
    conversation::{
        FieldKind,
        primitives::{CHUNK_BYTES, OrderKey},
    },
    storage::{RunId, database},
};

pub(super) struct Part<'a> {
    pub(super) order: OrderKey,
    pub(super) kind: FieldKind,
    pub(super) text: &'a str,
}

pub(super) async fn delta(
    sql: &mut SqliteConnection,
    run: &RunId,
    entry: &mut Entry,
    sequence: u64,
    part: Part<'_>,
) -> Result<()> {
    let key = FieldKey::new(
        run.clone(),
        entry.id,
        FieldOrder::Indexed(part.order),
        part.kind,
    )?;
    let old_kind: Option<String> = sqlx::query_scalar(
        "SELECT kind FROM conversation_fields WHERE run_id=? AND entry_id=? AND field_id=?",
    )
    .bind(run.as_str())
    .bind(entry.id.to_string())
    .bind(key.field_id())
    .fetch_optional(&mut *sql)
    .await
    .map_err(database::error)?;
    if let Some(old_kind) = old_kind {
        let old_kind = fields::decode_kind(&old_kind)?;
        if old_kind != part.kind {
            // Canonical deltas may change kind at one position. Replace only this provisional field.
            let old_key = FieldKey::new(
                run.clone(),
                entry.id,
                FieldOrder::Indexed(part.order),
                old_kind,
            )?;
            if fields::load(sql, &old_key).await?.generation > entry.revision {
                return Err(integrity());
            }
            remove(sql, run, entry, &old_key).await?;
            fields::insert(sql, &key, sequence, part.text).await?;
            entry.epoch = sequence;
            return Ok(());
        }
        // Unsupported input is a fixed marker, not untrusted delta text or repeated markers.
        let text = if part.kind == FieldKind::Unsupported {
            ""
        } else {
            part.text
        };
        let field = fields::append(sql, &key, text).await?;
        if field.generation > entry.revision {
            return Err(integrity());
        }
    } else {
        let later: Option<String> = sqlx::query_scalar("SELECT order_key FROM conversation_fields WHERE run_id=? AND entry_id=? AND order_key>? ORDER BY order_key LIMIT 1")
            .bind(run.as_str()).bind(entry.id.to_string()).bind(part.order.to_string())
            .fetch_optional(&mut *sql).await.map_err(database::error)?;
        fields::insert(sql, &key, sequence, part.text).await?;
        if later.is_some() {
            // An older cursor must not gain a newly inserted preceding field.
            entry.epoch = sequence;
        }
    }
    Ok(())
}

// Snapshot comparison streams one old chunk at a time, never joins prior text.
pub(super) async fn same_text(
    sql: &mut SqliteConnection,
    key: &FieldKey,
    run: &RunId,
    entry: &Entry,
    text: &str,
) -> Result<bool> {
    let descriptor = fields::load(sql, key).await?;
    if descriptor.generation > entry.revision {
        return Err(integrity());
    }
    if descriptor.byte_length != u64::try_from(text.len()).map_err(|_| integrity())? {
        return Ok(false);
    }
    let mut offset = 0u64;
    loop {
        let row = sqlx::query("SELECT start_byte,bytes FROM conversation_chunks WHERE run_id=? AND entry_id=? AND field_id=? AND start_byte>=? ORDER BY start_byte LIMIT 1")
            .bind(run.as_str()).bind(entry.id.to_string()).bind(key.field_id()).bind(integer(offset)?)
            .fetch_optional(&mut *sql).await.map_err(database::error)?;
        let Some(row) = row else {
            if offset != descriptor.byte_length {
                return Err(integrity());
            }
            return Ok(true);
        };
        let start = unsigned(row.try_get("start_byte").map_err(database::error)?)?;
        let bytes: Vec<u8> = row.try_get("bytes").map_err(database::error)?;
        if start != offset
            || bytes.is_empty()
            || bytes.len() > CHUNK_BYTES
            || std::str::from_utf8(&bytes).is_err()
        {
            return Err(integrity());
        }
        let end = offset
            .checked_add(u64::try_from(bytes.len()).map_err(|_| integrity())?)
            .ok_or_else(integrity)?;
        if end > descriptor.byte_length {
            return Err(integrity());
        }
        if text.as_bytes().get(
            usize::try_from(offset).map_err(|_| integrity())?
                ..usize::try_from(end).map_err(|_| integrity())?,
        ) != Some(bytes.as_slice())
        {
            return Ok(false);
        }
        offset = end;
    }
}

async fn remove(
    sql: &mut SqliteConnection,
    run: &RunId,
    entry: &Entry,
    key: &FieldKey,
) -> Result<()> {
    // An authoritative replacement must not hide damaged field metadata or its tail.
    fields::append(sql, key, "").await?;
    sqlx::query("DELETE FROM conversation_chunks WHERE run_id=? AND entry_id=? AND field_id=?")
        .bind(run.as_str())
        .bind(entry.id.to_string())
        .bind(key.field_id())
        .execute(&mut *sql)
        .await
        .map_err(database::error)?;
    sqlx::query("DELETE FROM conversation_fields WHERE run_id=? AND entry_id=? AND field_id=?")
        .bind(run.as_str())
        .bind(entry.id.to_string())
        .bind(key.field_id())
        .execute(sql)
        .await
        .map_err(database::error)?;
    Ok(())
}

pub(super) async fn snapshot(
    sql: &mut SqliteConnection,
    run: &RunId,
    entry: &mut Entry,
    sequence: u64,
    output: Option<u64>,
    parts: &[Part<'_>],
) -> Result<()> {
    let (lower, upper) = match output {
        Some(index) => OrderKey::output_range(index),
        None => (String::new(), "~".into()),
    };
    // Only this item's descriptors (or this terminal response's descriptors) are read.
    let old = sqlx::query("SELECT field_id,order_key,kind FROM conversation_fields WHERE run_id=? AND entry_id=? AND order_key>=? AND order_key<? ORDER BY order_key")
        .bind(run.as_str()).bind(entry.id.to_string()).bind(lower).bind(upper)
        .fetch_all(&mut *sql).await.map_err(database::error)?;
    let mut layout_changed = false;
    let mut retained = std::collections::BTreeSet::new();
    for row in old {
        let order_text: &str = row.try_get("order_key").map_err(database::error)?;
        let order = FieldOrder::decode(order_text)?;
        let kind = fields::decode_kind(row.try_get("kind").map_err(database::error)?)?;
        let key = FieldKey::new(run.clone(), entry.id, order, kind)?;
        if key.field_id()
            != row
                .try_get::<&str, _>("field_id")
                .map_err(database::error)?
        {
            return Err(integrity());
        }
        if fields::load(sql, &key).await?.generation > entry.revision {
            return Err(integrity());
        }
        if let Some(part) = parts
            .iter()
            .find(|part| FieldOrder::Indexed(part.order) == order && part.kind == kind)
        {
            if !same_text(sql, &key, run, entry, part.text).await? {
                fields::replace(sql, &key, sequence, part.text).await?;
            }
            retained.insert(part.order);
        } else {
            remove(sql, run, entry, &key).await?;
            layout_changed = true;
        }
    }
    let mut unique = std::collections::BTreeSet::new();
    for part in parts {
        if !unique.insert(part.order) {
            return Err(integrity());
        }
        if !retained.contains(&part.order) {
            let key = FieldKey::new(
                run.clone(),
                entry.id,
                FieldOrder::Indexed(part.order),
                part.kind,
            )?;
            fields::insert(sql, &key, sequence, part.text).await?;
            layout_changed = true;
        }
    }
    if layout_changed {
        entry.epoch = sequence;
    }
    Ok(())
}
