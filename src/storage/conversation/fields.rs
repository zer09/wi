use serde::{Deserialize, Serialize};
use sqlx::{Row, SqliteConnection};

use crate::conversation::{
    EntryId, FieldKind,
    primitives::{CHUNK_BYTES, OrderKey, SourceKey, TextChunks},
};
use crate::storage::{RunId, StorageError, StorageErrorKind, database};

type Result<T> = std::result::Result<T, StorageError>;

fn integrity() -> StorageError {
    StorageError::new(StorageErrorKind::Integrity)
}
fn integer(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| integrity())
}
fn unsigned(value: i64) -> Result<u64> {
    u64::try_from(value).map_err(|_| integrity())
}
fn length(text: &str) -> Result<u64> {
    let length = u64::try_from(text.len()).map_err(|_| integrity())?;
    integer(length)?;
    Ok(length)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum FieldOrder {
    Human,
    Indexed(OrderKey),
}
impl FieldOrder {
    fn encode(self) -> String {
        match self {
            Self::Human => "0".into(),
            Self::Indexed(order) => order.to_string(),
        }
    }
    pub(super) fn decode(value: &str) -> Result<Self> {
        if value == "0" {
            return Ok(Self::Human);
        }
        value.parse().map(Self::Indexed).map_err(|_| integrity())
    }
}

// All display scalars live in chunks. A2 needs no additional field state yet.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FieldMetadata {}

const KINDS: &[(FieldKind, &str)] = &[
    (FieldKind::Text, "text"),
    (FieldKind::Refusal, "refusal"),
    (FieldKind::ReasoningSummary, "reasoning_summary"),
    (FieldKind::ReasoningText, "reasoning_text"),
    (FieldKind::FunctionName, "function_name"),
    (FieldKind::FunctionArguments, "function_arguments"),
    (FieldKind::ToolName, "tool_name"),
    (FieldKind::ToolResult, "tool_result"),
    (FieldKind::AuthoritativeText, "authoritative_text"),
    (FieldKind::Unsupported, "unsupported"),
    (FieldKind::Notice, "notice"),
];

pub(super) fn decode_kind(value: &str) -> Result<FieldKind> {
    KINDS
        .iter()
        .find(|(_, code)| *code == value)
        .map(|(kind, _)| *kind)
        .ok_or_else(integrity)
}

pub(super) struct FieldKey {
    run: RunId,
    entry: EntryId,
    field_id: String,
    order: FieldOrder,
    kind: FieldKind,
}
impl FieldKey {
    pub(super) fn new(
        run: RunId,
        entry: EntryId,
        order: FieldOrder,
        kind: FieldKind,
    ) -> Result<Self> {
        integer(entry.first_sequence())?;
        integer(entry.position_slot())?;
        let field_id = match order {
            FieldOrder::Human => {
                if kind != FieldKind::Text {
                    return Err(integrity());
                }
                "text".into()
            }
            FieldOrder::Indexed(order) => SourceKey::field(&run, &entry, &order)
                .map_err(|_| integrity())?
                .field_id(),
        };
        Ok(Self {
            run,
            entry,
            field_id,
            order,
            kind,
        })
    }
    pub(super) fn field_id(&self) -> &str {
        &self.field_id
    }
    fn kind_code(&self) -> &'static str {
        KINDS
            .iter()
            .find(|(kind, _)| *kind == self.kind)
            .expect("closed field kind")
            .1
    }
    fn generation(&self, generation: u64) -> Result<i64> {
        if generation < self.entry.first_sequence() {
            return Err(integrity());
        }
        integer(generation)
    }
    async fn validate_entry(&self, sql: &mut SqliteConnection) -> Result<()> {
        let row = sqlx::query("SELECT first_sequence,position_slot,kind FROM conversation_entries WHERE run_id=? AND entry_id=?")
            .bind(self.run.as_str()).bind(self.entry.to_string())
            .fetch_optional(sql).await.map_err(database::error)?.ok_or_else(integrity)?;
        let kind: &str = row.try_get("kind").map_err(database::error)?;
        if unsigned(row.try_get("first_sequence").map_err(database::error)?)?
            != self.entry.first_sequence()
            || unsigned(row.try_get("position_slot").map_err(database::error)?)?
                != self.entry.position_slot()
            || !matches!(kind, "human" | "assistant" | "tool" | "reuse" | "notice")
            || (kind == "human") != (self.order == FieldOrder::Human)
        {
            return Err(integrity());
        }
        Ok(())
    }
}

pub(super) struct FieldDescriptor {
    pub(super) generation: u64,
    pub(super) byte_length: u64,
}

pub(super) async fn load(sql: &mut SqliteConnection, key: &FieldKey) -> Result<FieldDescriptor> {
    key.validate_entry(sql).await?;
    let row = sqlx::query("SELECT field_id,order_key,generation,byte_length,kind,metadata_json FROM conversation_fields WHERE run_id=? AND entry_id=? AND field_id=?")
        .bind(key.run.as_str()).bind(key.entry.to_string()).bind(key.field_id())
        .fetch_optional(sql).await.map_err(database::error)?.ok_or_else(integrity)?;
    let order = FieldOrder::decode(row.try_get("order_key").map_err(database::error)?)?;
    let kind: &str = row.try_get("kind").map_err(database::error)?;
    let generation = unsigned(row.try_get("generation").map_err(database::error)?)?;
    let byte_length = unsigned(row.try_get("byte_length").map_err(database::error)?)?;
    let metadata: &str = row.try_get("metadata_json").map_err(database::error)?;
    // Serde structs can also accept arrays; persisted metadata must be an object.
    if !metadata.trim_start().starts_with('{') {
        return Err(integrity());
    }
    let _: FieldMetadata = serde_json::from_str(metadata).map_err(|_| integrity())?;
    key.generation(generation)?;
    if order != key.order
        || kind != key.kind_code()
        || row
            .try_get::<&str, _>("field_id")
            .map_err(database::error)?
            != key.field_id()
    {
        return Err(integrity());
    }
    Ok(FieldDescriptor {
        generation,
        byte_length,
    })
}

struct Tail {
    start: u64,
    text: String,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct ChunkReads {
    pub(super) queries: usize,
    pub(super) rows: usize,
    pub(super) bytes: usize,
    pub(super) joined_bytes: usize,
}
#[cfg(test)]
tokio::task_local! {
    pub(super) static CHUNK_READS: std::cell::Cell<ChunkReads>;
}

// Only the final blob is read. The preceding location is metadata, not prior text.
// Full projection validation belongs to the later schema3 validation dispatch.
async fn tail(sql: &mut SqliteConnection, key: &FieldKey, total: u64) -> Result<Option<Tail>> {
    let row = sqlx::query("SELECT start_byte,bytes FROM conversation_chunks WHERE run_id=? AND entry_id=? AND field_id=? ORDER BY start_byte DESC LIMIT 1")
        .bind(key.run.as_str()).bind(key.entry.to_string()).bind(key.field_id())
        .fetch_optional(&mut *sql).await.map_err(database::error)?;
    #[cfg(test)]
    let _ = CHUNK_READS.try_with(|counter| {
        let mut count = counter.get();
        count.queries += 1;
        counter.set(count);
    });
    let Some(row) = row else {
        if total != 0 {
            return Err(integrity());
        }
        return Ok(None);
    };
    let start = unsigned(row.try_get("start_byte").map_err(database::error)?)?;
    let bytes: Vec<u8> = row.try_get("bytes").map_err(database::error)?;
    #[cfg(test)]
    let _ = CHUNK_READS.try_with(|counter| {
        let mut count = counter.get();
        count.rows += 1;
        count.bytes += bytes.len();
        counter.set(count);
    });
    if bytes.is_empty() || bytes.len() > CHUNK_BYTES {
        return Err(integrity());
    }
    let text = String::from_utf8(bytes).map_err(|_| integrity())?;
    if start.checked_add(length(&text)?).ok_or_else(integrity)? != total {
        return Err(integrity());
    }
    let previous: Option<(i64,i64)> = sqlx::query_as("SELECT start_byte,length(bytes) FROM conversation_chunks WHERE run_id=? AND entry_id=? AND field_id=? AND start_byte<? ORDER BY start_byte DESC LIMIT 1")
        .bind(key.run.as_str()).bind(key.entry.to_string()).bind(key.field_id()).bind(integer(start)?)
        .fetch_optional(sql).await.map_err(database::error)?;
    let previous_end = match previous {
        None => 0,
        Some((offset, size)) => {
            let size = unsigned(size)?;
            if size == 0 || size > CHUNK_BYTES as u64 {
                return Err(integrity());
            }
            unsigned(offset)?.checked_add(size).ok_or_else(integrity)?
        }
    };
    if previous_end != start {
        return Err(integrity());
    }
    Ok(Some(Tail { start, text }))
}

async fn insert_chunks(
    sql: &mut SqliteConnection,
    key: &FieldKey,
    text: &str,
    start: u64,
) -> Result<()> {
    integer(start.checked_add(length(text)?).ok_or_else(integrity)?)?;
    for chunk in TextChunks::new(text, start).map_err(|_| integrity())? {
        sqlx::query("INSERT INTO conversation_chunks (run_id,entry_id,field_id,start_byte,bytes) VALUES (?,?,?,?,?)")
            .bind(key.run.as_str()).bind(key.entry.to_string()).bind(key.field_id())
            .bind(integer(chunk.start_byte())?).bind(chunk.text().as_bytes())
            .execute(&mut *sql).await.map_err(database::error)?;
    }
    Ok(())
}

// The caller owns the transaction and must roll back any error, including partial SQL work.
pub(super) async fn insert(
    sql: &mut SqliteConnection,
    key: &FieldKey,
    generation: u64,
    text: &str,
) -> Result<FieldDescriptor> {
    let generation_sql = key.generation(generation)?;
    let byte_length = length(text)?;
    key.validate_entry(sql).await?;
    let metadata = serde_json::to_string(&FieldMetadata {}).map_err(|_| integrity())?;
    sqlx::query("INSERT INTO conversation_fields (run_id,entry_id,field_id,order_key,generation,byte_length,kind,metadata_json) VALUES (?,?,?,?,?,?,?,?)")
        .bind(key.run.as_str()).bind(key.entry.to_string()).bind(key.field_id())
        .bind(key.order.encode()).bind(generation_sql).bind(integer(byte_length)?)
        .bind(key.kind_code()).bind(metadata).execute(&mut *sql).await.map_err(database::error)?;
    insert_chunks(sql, key, text, 0).await?;
    Ok(FieldDescriptor {
        generation,
        byte_length,
    })
}

pub(super) async fn append(
    sql: &mut SqliteConnection,
    key: &FieldKey,
    delta: &str,
) -> Result<FieldDescriptor> {
    let mut field = load(sql, key).await?;
    let new_length = field
        .byte_length
        .checked_add(length(delta)?)
        .ok_or_else(integrity)?;
    integer(new_length)?;
    let tail = tail(sql, key, field.byte_length).await?;
    if delta.is_empty() {
        return Ok(field);
    }
    let mut consumed = 0;
    if let Some(mut tail) = tail {
        consumed = (CHUNK_BYTES - tail.text.len()).min(delta.len());
        while !delta.is_char_boundary(consumed) {
            consumed -= 1;
        }
        if consumed > 0 {
            tail.text.push_str(&delta[..consumed]);
            #[cfg(test)]
            let _ = CHUNK_READS.try_with(|counter| {
                let mut count = counter.get();
                count.joined_bytes = count.joined_bytes.max(tail.text.len());
                counter.set(count);
            });
            sqlx::query("UPDATE conversation_chunks SET bytes=? WHERE run_id=? AND entry_id=? AND field_id=? AND start_byte=?")
                .bind(tail.text.as_bytes()).bind(key.run.as_str()).bind(key.entry.to_string())
                .bind(key.field_id()).bind(integer(tail.start)?)
                .execute(&mut *sql).await.map_err(database::error)?;
        }
    }
    let consumed_bytes = u64::try_from(consumed).map_err(|_| integrity())?;
    let start = field
        .byte_length
        .checked_add(consumed_bytes)
        .ok_or_else(integrity)?;
    insert_chunks(sql, key, &delta[consumed..], start).await?;
    sqlx::query(
        "UPDATE conversation_fields SET byte_length=? WHERE run_id=? AND entry_id=? AND field_id=?",
    )
    .bind(integer(new_length)?)
    .bind(key.run.as_str())
    .bind(key.entry.to_string())
    .bind(key.field_id())
    .execute(sql)
    .await
    .map_err(database::error)?;
    field.byte_length = new_length;
    Ok(field)
}

pub(super) async fn replace(
    sql: &mut SqliteConnection,
    key: &FieldKey,
    generation: u64,
    text: &str,
) -> Result<FieldDescriptor> {
    let generation_sql = key.generation(generation)?;
    let byte_length = length(text)?;
    let field = load(sql, key).await?;
    if generation <= field.generation {
        return Err(integrity());
    }
    // Do not turn a malformed tail into a successful replacement.
    tail(sql, key, field.byte_length).await?;
    sqlx::query("DELETE FROM conversation_chunks WHERE run_id=? AND entry_id=? AND field_id=?")
        .bind(key.run.as_str())
        .bind(key.entry.to_string())
        .bind(key.field_id())
        .execute(&mut *sql)
        .await
        .map_err(database::error)?;
    sqlx::query("UPDATE conversation_fields SET generation=?,byte_length=? WHERE run_id=? AND entry_id=? AND field_id=?")
        .bind(generation_sql).bind(integer(byte_length)?).bind(key.run.as_str())
        .bind(key.entry.to_string()).bind(key.field_id()).execute(&mut *sql).await.map_err(database::error)?;
    insert_chunks(sql, key, text, 0).await?;
    Ok(FieldDescriptor {
        generation,
        byte_length,
    })
}
