use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteRow};

use super::{
    ConversationError, fields,
    projector::{rows, tool_order},
};
use crate::{
    conversation::{
        BlockView, ContentCursor, EntryId, EntryPage, EntryView, FieldFragment, FieldKind,
        OutcomeView,
        primitives::{FieldRank, SourceKey},
        safe_code,
        wire::{DisplayJson, ENTRY_BYTES, FIELD_LIMIT},
    },
    storage::{
        ApplicationSessionId, RunId, StorageError, StorageErrorKind, database, session_schema,
    },
};

pub(in crate::storage) mod changes;
mod compact;
pub(in crate::storage) mod pages;
mod ranges;
#[cfg(test)]
mod tests;

type Result<T> = std::result::Result<T, ConversationError>;
fn integrity() -> StorageError {
    StorageError::new(StorageErrorKind::Integrity)
}
fn unsigned(value: i64) -> std::result::Result<u64, StorageError> {
    u64::try_from(value).map_err(|_| integrity())
}
fn integer(value: u64) -> std::result::Result<i64, StorageError> {
    i64::try_from(value).map_err(|_| integrity())
}

pub(in crate::storage) enum Address {
    Entry(RunId, EntryId),
    Content(ContentCursor),
}

pub(in crate::storage) async fn read(
    sql: &mut SqliteConnection,
    session: &ApplicationSessionId,
    provenance: &crate::storage::CreationProvenance,
    address: Address,
) -> Result<EntryPage> {
    let mut transaction = sql.begin().await.map_err(database::error)?;
    #[cfg(test)]
    crate::storage::test_hooks::read_transaction();
    let result = async {
        let manifest =
            session_schema::validate(&mut transaction, session, Some(provenance)).await?;
        let head = manifest.head_sequence();
        #[cfg(test)]
        crate::storage::test_hooks::hit(
            crate::storage::test_hooks::Point::ConversationHeadCaptured,
        )
        .await?;
        let (run, id, cursor) = match address {
            Address::Entry(run, id) => (run, id, None),
            Address::Content(cursor) => {
                if cursor.session_id() != session {
                    return Err(ConversationError::CursorInvalid);
                }
                (cursor.run_id().clone(), *cursor.entry_id(), Some(cursor))
            }
        };
        if cursor.is_some() {
            if id.first_sequence() > head || id.position_slot() > i64::MAX as u64 {
                return Err(ConversationError::CursorInvalid);
            }
            let owner: Option<Option<String>> =
                sqlx::query_scalar("SELECT run_id FROM events WHERE sequence=?")
                    .bind(integer(id.first_sequence())?)
                    .fetch_optional(&mut *transaction)
                    .await
                    .map_err(database::error)?;
            if owner
                .as_ref()
                .is_some_and(|owner| owner.as_deref() != Some(run.as_str()))
            {
                return Err(ConversationError::CursorInvalid);
            }
        }
        let entry = addressed(&mut transaction, &run, &id, head).await?;
        if let Some(cursor) = &cursor {
            if cursor.content_epoch() > head || cursor.upper_generation() > head {
                return Err(ConversationError::CursorInvalid);
            }
            // Replacement takes precedence over a field removed by that replacement.
            if cursor.content_epoch() > entry.epoch {
                return Err(ConversationError::CursorInvalid);
            }
            if cursor.content_epoch() < entry.epoch {
                return Err(ConversationError::CursorStale);
            }
        }
        let header = rows::block(&mut transaction, &run, head + 1).await?;
        let (accepted, revision): (i64, i64) = sqlx::query_as(
            "SELECT accepted_sequence,changed_sequence FROM conversation_blocks WHERE run_id=?",
        )
        .bind(run.as_str())
        .fetch_one(&mut *transaction)
        .await
        .map_err(database::error)?;
        let human_id: EntryId = header.human.parse().map_err(|_| integrity())?;
        let human_entry = addressed(&mut transaction, &run, &human_id, head)
            .await
            .map_err(|error| match error {
                ConversationError::Storage(error) if error.kind() == StorageErrorKind::NotFound => {
                    integrity().into()
                }
                error => error,
            })?;
        let human = compact_entry(&mut transaction, session, &run, &human_entry, None).await?;
        let entry = compact_entry(&mut transaction, session, &run, &entry, cursor.as_ref()).await?;
        let page = assemble(
            session,
            head,
            &run,
            unsigned(accepted)?,
            unsigned(revision)?,
            &header,
            human.clone(),
            entry.clone(),
        )?;
        if DisplayJson::EntryPage(&page).json_size().is_ok() {
            return Ok(page);
        }
        // First prove that the mandatory header can fit with actual minimum progress.
        // Full previews are optional; the header and progress are not.
        let small_human = compact::minimum(session, human.clone())?;
        let small_entry = compact::minimum(session, entry.clone())?;
        let small = assemble(
            session,
            head,
            &run,
            unsigned(accepted)?,
            unsigned(revision)?,
            &header,
            small_human.clone(),
            small_entry.clone(),
        )?;
        if DisplayJson::EntryPage(&small).json_size().is_err() {
            return Err(ConversationError::DisplayUnavailable);
        }
        let entry = compact::fit(session, entry, |entry| {
            assemble(
                session,
                head,
                &run,
                accepted as u64,
                revision as u64,
                &header,
                small_human.clone(),
                entry.clone(),
            )
            .is_ok_and(|page| DisplayJson::EntryPage(&page).json_size().is_ok())
        })?;
        let human = compact::fit(session, human, |human| {
            assemble(
                session,
                head,
                &run,
                accepted as u64,
                revision as u64,
                &header,
                human.clone(),
                entry.clone(),
            )
            .is_ok_and(|page| DisplayJson::EntryPage(&page).json_size().is_ok())
        })?;
        assemble(
            session,
            head,
            &run,
            accepted as u64,
            revision as u64,
            &header,
            human,
            entry,
        )
    }
    .await;
    // A read has no mutation commit certainty. Explicitly release its snapshot.
    let retirement = transaction.rollback().await.map_err(database::error);
    match result {
        Ok(page) => {
            retirement?;
            Ok(page)
        }
        Err(error) => Err(error),
    }
}

async fn addressed(
    sql: &mut SqliteConnection,
    run: &RunId,
    id: &EntryId,
    head: u64,
) -> Result<rows::Entry> {
    // Out-of-range IDs are missing resources for direct reads, not SQL overflows.
    let row = sqlx::query("SELECT entry_id,source_key,first_sequence,position_slot,changed_sequence,content_epoch,kind,metadata_json FROM conversation_entries WHERE run_id=? AND entry_id=?")
        .bind(run.as_str()).bind(id.to_string()).fetch_optional(&mut *sql).await.map_err(database::error)?
        .ok_or_else(|| StorageError::new(StorageErrorKind::NotFound))?;
    let entry = rows::entry_row(&row, run, head)?;
    let accepted: Option<i64> =
        sqlx::query_scalar("SELECT accepted_sequence FROM conversation_blocks WHERE run_id=?")
            .bind(run.as_str())
            .fetch_optional(&mut *sql)
            .await
            .map_err(database::error)?;
    let accepted = unsigned(accepted.ok_or_else(integrity)?)?;
    if matches!(entry.metadata.source, rows::Source::Human) {
        if entry.id.first_sequence() != accepted || entry.id.position_slot() != 0 {
            return Err(integrity().into());
        }
    } else if entry.id.first_sequence() <= accepted {
        return Err(integrity().into());
    }
    if let Some(reference) = &entry.metadata.reference {
        let target = sqlx::query("SELECT entry_id,source_key,first_sequence,position_slot,changed_sequence,content_epoch,kind,metadata_json FROM conversation_entries WHERE run_id=? AND entry_id=?")
            .bind(run.as_str()).bind(reference).fetch_optional(&mut *sql).await.map_err(database::error)?.ok_or_else(integrity)?;
        let target = rows::entry_row(&target, run, head)?;
        // Actual result errors are immutable; occurrence finish facts can differ later.
        if !matches!(target.metadata.source, rows::Source::Tool { .. })
            || target.metadata.result_recorded != Some(true)
            || entry.metadata.is_error != target.metadata.is_error
        {
            return Err(integrity().into());
        }
        recorded_tool_result(sql, run, &target).await?;
    }
    recorded_tool_result(sql, run, &entry).await?;
    Ok(entry)
}

async fn recorded_tool_result(
    sql: &mut SqliteConnection,
    run: &RunId,
    entry: &rows::Entry,
) -> Result<()> {
    if let rows::Source::Tool { call_id } = &entry.metadata.source {
        // Finish and result are separate facts; check scalars without loading saved output.
        let (sequence, flag, finished): (Option<i64>, Option<i64>, Option<i64>) = sqlx::query_as(
            "SELECT result_sequence,is_error,finished_sequence FROM tool_results WHERE run_id=? AND call_id=?",
        )
        .bind(run.as_str())
        .bind(call_id)
        .fetch_optional(&mut *sql)
        .await
        .map_err(database::error)?
        .ok_or_else(integrity)?;
        if let Some(finished) = finished {
            let finished = unsigned(finished)?;
            if finished == 0 || finished > entry.revision {
                return Err(integrity().into());
            }
        }
        if entry.metadata.finish_recorded != Some(finished.is_some()) {
            return Err(integrity().into());
        }
        if entry.metadata.result_recorded != Some(sequence.is_some()) {
            return Err(integrity().into());
        }
        // Either recorded fact fixes the error flag; a pending tool remains unknown.
        if sequence.is_some() || finished.is_some() {
            let flag = match flag {
                Some(0) => false,
                Some(1) => true,
                _ => return Err(integrity().into()),
            };
            if entry.metadata.is_error != Some(flag) {
                return Err(integrity().into());
            }
        } else if flag.is_some() || entry.metadata.is_error.is_some() {
            return Err(integrity().into());
        }
        let key = fields::FieldKey::new(
            run.clone(),
            entry.id,
            fields::FieldOrder::Indexed(tool_order(FieldRank::ToolOutput)),
            FieldKind::ToolResult,
        )?;
        if entry.metadata.result_recorded == Some(true) {
            if unsigned(sequence.ok_or_else(integrity)?)? == 0 {
                return Err(integrity().into());
            }
            // Recorded output needs its descriptor even when this page selects only the tool name.
            if fields::load(sql, &key).await?.generation > entry.revision {
                return Err(integrity().into());
            }
        } else {
            // A false flag cannot hide saved output, including an empty result with no chunks.
            let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM conversation_fields WHERE run_id=? AND entry_id=? AND field_id=? LIMIT 1")
                .bind(run.as_str()).bind(entry.id.to_string()).bind(key.field_id())
                .fetch_optional(sql).await.map_err(database::error)?;
            if exists.is_some() {
                return Err(integrity().into());
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn assemble(
    session: &ApplicationSessionId,
    head: u64,
    run: &RunId,
    accepted: u64,
    revision: u64,
    header: &rows::BlockHeader,
    human: EntryView,
    entry: EntryView,
) -> Result<EntryPage> {
    let block = build_block(run, accepted, revision, header, human)?;
    EntryPage::new(session.clone(), head, block, entry).map_err(|_| integrity().into())
}

fn build_block(
    run: &RunId,
    accepted: u64,
    revision: u64,
    header: &rows::BlockHeader,
    human: EntryView,
) -> Result<BlockView> {
    let outcome = header.outcome.as_ref().map(|outcome| match outcome {
        rows::Outcome::Completed => OutcomeView::Completed,
        rows::Outcome::CancelledLocally => OutcomeView::CancelledLocally,
        rows::Outcome::Failed { code } => OutcomeView::Failed {
            code: safe_code(code),
        },
    });
    BlockView::new(
        run.clone(),
        accepted,
        revision,
        header.state,
        header.result_recorded,
        outcome,
        header.summary.as_ref().map(rows::Summary::view),
        header.events_complete,
        header.sink_error,
        human,
    )
    .map_err(|_| integrity().into())
}

struct Descriptor {
    id: String,
    order: String,
    kind: FieldKind,
    generation: u64,
    total: u64,
}
fn descriptor(row: &SqliteRow, run: &RunId, entry: &rows::Entry) -> Result<Descriptor> {
    let id: String = row.try_get("field_id").map_err(database::error)?;
    let order: String = row.try_get("order_key").map_err(database::error)?;
    let kind = fields::decode_kind(row.try_get("kind").map_err(database::error)?)?;
    let generation = unsigned(row.try_get("generation").map_err(database::error)?)?;
    let total = unsigned(row.try_get("byte_length").map_err(database::error)?)?;
    let metadata: &str = row.try_get("metadata_json").map_err(database::error)?;
    let _: fields::FieldMetadata = rows::decode(metadata)?;
    let decoded = fields::FieldOrder::decode(&order)?;
    let human = matches!(entry.metadata.source, rows::Source::Human);
    let expected = match decoded {
        fields::FieldOrder::Human if human && kind == FieldKind::Text => "text".into(),
        fields::FieldOrder::Indexed(order) if !human => SourceKey::field(run, &entry.id, &order)
            .map_err(|_| integrity())?
            .field_id(),
        _ => return Err(integrity().into()),
    };
    if id != expected || generation < entry.id.first_sequence() || generation > entry.revision {
        return Err(integrity().into());
    }
    Ok(Descriptor {
        id,
        order,
        kind,
        generation,
        total,
    })
}

async fn compact_entry(
    sql: &mut SqliteConnection,
    session: &ApplicationSessionId,
    run: &RunId,
    entry: &rows::Entry,
    cursor: Option<&ContentCursor>,
) -> Result<EntryView> {
    if matches!(entry.metadata.source, rows::Source::Human) {
        // Validate the whole single-field projection before applying a cursor that can select nothing.
        let rows = sqlx::query("SELECT field_id,order_key,kind,generation,byte_length,metadata_json FROM conversation_fields WHERE run_id=? AND entry_id=? ORDER BY order_key LIMIT 2")
            .bind(run.as_str()).bind(entry.id.to_string()).fetch_all(&mut *sql).await.map_err(database::error)?;
        #[cfg(test)]
        measure(rows.len(), 0, 0);
        if rows.len() != 1 {
            return Err(integrity().into());
        }
        descriptor(&rows[0], run, entry)?;
    }
    let mut boundary = None;
    if let Some(cursor) = cursor {
        let row = sqlx::query("SELECT field_id,order_key,kind,generation,byte_length,metadata_json FROM conversation_fields WHERE run_id=? AND entry_id=? AND field_id=?")
            .bind(run.as_str()).bind(entry.id.to_string()).bind(cursor.upper_field_id())
            .fetch_optional(&mut *sql).await.map_err(database::error)?.ok_or(ConversationError::CursorInvalid)?;
        let field = descriptor(&row, run, entry)?;
        if cursor.upper_generation() > field.generation {
            return Err(ConversationError::CursorInvalid);
        }
        if cursor.upper_generation() < field.generation {
            return Err(ConversationError::CursorStale);
        }
        if cursor.exclusive_upper_byte() > field.total {
            return Err(ConversationError::CursorInvalid);
        }
        boundary = Some((field.order, cursor.exclusive_upper_byte()));
    }
    let (order, upper) = boundary
        .as_ref()
        .map(|(o, b)| (o.as_str(), *b))
        .unwrap_or(("~", u64::MAX));
    let query = if upper == 0 {
        "SELECT field_id,order_key,kind,generation,byte_length,metadata_json FROM conversation_fields WHERE run_id=? AND entry_id=? AND order_key<? ORDER BY order_key DESC LIMIT ?"
    } else {
        "SELECT field_id,order_key,kind,generation,byte_length,metadata_json FROM conversation_fields WHERE run_id=? AND entry_id=? AND order_key<=? ORDER BY order_key DESC LIMIT ?"
    };
    let rows = sqlx::query(query)
        .bind(run.as_str())
        .bind(entry.id.to_string())
        .bind(order)
        .bind((FIELD_LIMIT + 1) as i64)
        .fetch_all(&mut *sql)
        .await
        .map_err(database::error)?;
    #[cfg(test)]
    measure(rows.len(), 0, 0);
    if cursor.is_some() && rows.is_empty() {
        return Err(ConversationError::CursorInvalid);
    }
    let descriptors: Vec<Descriptor> = rows
        .iter()
        .map(|row| descriptor(row, run, entry))
        .collect::<Result<_>>()?;
    let mut fragments = Vec::new();
    let mut selected = compact::view(session, run, entry, vec![], None);
    for (index, field) in descriptors.iter().take(FIELD_LIMIT).enumerate() {
        let end = if field.order == order {
            upper
        } else {
            field.total
        };
        let (from, text) = ranges::suffix(sql, run, &entry.id, field, end).await?;
        let fragment = FieldFragment::new(
            field.id.clone(),
            field.order.clone(),
            field.kind,
            field.generation,
            field.total,
            from,
            end,
            text,
        )
        .map_err(|_| integrity())?;
        fragments.insert(0, fragment);
        let earlier = if from > 0 || index + 1 < descriptors.len() {
            Some(
                ContentCursor::new(
                    session.clone(),
                    run.clone(),
                    entry.id,
                    entry.epoch,
                    field.id.clone(),
                    field.generation,
                    from,
                )
                .map_err(|_| integrity())?,
            )
        } else {
            None
        };
        let candidate = compact::view(session, run, entry, fragments.clone(), earlier)?;
        let candidate = compact::fit(session, candidate, |value| {
            DisplayJson::Entry(value)
                .json_size()
                .is_ok_and(|size| size <= ENTRY_BYTES)
        })?;
        if candidate
            .fields()
            .first()
            .is_none_or(|f| f.field_id() != field.id)
        {
            break;
        }
        let partial = candidate.fields()[0].from_byte() > 0;
        fragments = candidate.fields().to_vec();
        selected = Ok(candidate);
        if partial {
            break;
        }
    }
    selected
}

#[cfg(test)]
fn measure(descriptors: usize, chunks: usize, bytes: usize) {
    crate::storage::test_hooks::conversation_read(descriptors, chunks, bytes);
}
