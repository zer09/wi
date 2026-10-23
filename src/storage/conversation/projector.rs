use sqlx::{Row, SqliteConnection};

use super::fields::{self, FieldKey, FieldOrder};
use crate::{
    conversation::{EntryId, FieldKind, interpretation::State},
    run::{RunEventEnvelope, RunResult},
    storage::{
        AppendRunRecord, RecordedRunInput, RecordedRunState, RunId, StorageError, StorageErrorKind,
        StoredEvent, StoredEventPayload, database,
    },
};

mod content;
pub(super) mod rows;
mod runtime;
#[cfg(test)]
mod tests;

use rows::{BlockHeader, EntryMetadata, Outcome, Source, Summary};
pub(super) use runtime::tool_order;
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

pub(in crate::storage) enum Input<'a> {
    Created,
    Renamed,
    Accepted(&'a RecordedRunInput),
    HistorySelected,
    ProviderBound,
    Runtime(&'a RunEventEnvelope),
    ToolResult {
        request_id: Option<&'a str>,
        call_id: &'a str,
        output: &'a str,
        is_error: bool,
    },
    Result(&'a RunResult),
    Interrupted,
}

// Writers borrow their already available typed inputs. Backfill borrows one StoredEvent.
// Neither path reads earlier canonical payloads or owns a transaction.
pub(in crate::storage) struct Event<'a> {
    pub(in crate::storage) sequence: u64,
    pub(in crate::storage) run: Option<&'a RunId>,
    pub(in crate::storage) input: Input<'a>,
}
impl<'a> Event<'a> {
    pub(in crate::storage) fn record(
        sequence: u64,
        run: &'a RunId,
        record: &'a AppendRunRecord,
    ) -> Result<Self> {
        let input = match record {
            AppendRunRecord::ProviderBinding(binding) => {
                if binding.run_id() != run {
                    return Err(integrity());
                }
                Input::ProviderBound
            }
            AppendRunRecord::Runtime(event) => Input::Runtime(event),
            AppendRunRecord::ToolResult {
                request_id,
                call_id,
                output,
                is_error,
            } => Input::ToolResult {
                request_id: request_id.as_deref(),
                call_id,
                output,
                is_error: *is_error,
            },
            AppendRunRecord::Result(result) => Input::Result(result),
        };
        Ok(Self {
            sequence,
            run: Some(run),
            input,
        })
    }
}
impl<'a> TryFrom<&'a StoredEvent> for Event<'a> {
    type Error = StorageError;
    fn try_from(event: &'a StoredEvent) -> Result<Self> {
        let run = event.run_id();
        let input = match event.payload() {
            StoredEventPayload::SessionCreated(_) => Input::Created,
            StoredEventPayload::SessionRenamed { .. } => Input::Renamed,
            StoredEventPayload::RunAccepted(accepted) => {
                if run != Some(accepted.run_id()) {
                    return Err(integrity());
                }
                Input::Accepted(accepted.input())
            }
            StoredEventPayload::RunHistorySelected(selected) => {
                if run != Some(selected.run_id()) {
                    return Err(integrity());
                }
                Input::HistorySelected
            }
            StoredEventPayload::RunProviderBound(binding) => {
                if run != Some(binding.run_id()) {
                    return Err(integrity());
                }
                Input::ProviderBound
            }
            StoredEventPayload::RuntimeObserved(event) => Input::Runtime(event),
            StoredEventPayload::ToolResultRecorded(result) => Input::ToolResult {
                request_id: result.request_id(),
                call_id: result.call_id(),
                output: result.output(),
                is_error: result.is_error(),
            },
            StoredEventPayload::RunResultRecorded(result) => Input::Result(result),
            StoredEventPayload::RunInterrupted(interrupted) => {
                if run != Some(interrupted.run_id()) {
                    return Err(integrity());
                }
                Input::Interrupted
            }
        };
        Ok(Self {
            sequence: event.sequence(),
            run,
            input,
        })
    }
}

// The caller inserts canonical rows first and rolls back the entire transaction on error.
pub(in crate::storage) async fn apply(sql: &mut SqliteConnection, event: Event<'_>) -> Result<()> {
    let Event {
        sequence,
        run,
        input,
    } = event;
    integer(sequence)?;
    let head = sqlx::query("SELECT format_version,applied_sequence,metadata_sequence FROM conversation_projection WHERE singleton=1")
        .fetch_optional(&mut *sql).await.map_err(database::error)?;
    if matches!(input, Input::Created) {
        if sequence != 1 || run.is_some() || head.is_some() {
            return Err(integrity());
        }
        sqlx::query("INSERT INTO conversation_projection VALUES (1,1,1,1)")
            .execute(sql)
            .await
            .map_err(database::error)?;
        return Ok(());
    }
    let head = head.ok_or_else(integrity)?;
    let applied = unsigned(head.try_get("applied_sequence").map_err(database::error)?)?;
    let metadata = unsigned(head.try_get("metadata_sequence").map_err(database::error)?)?;
    if head
        .try_get::<i64, _>("format_version")
        .map_err(database::error)?
        != 1
        || applied.checked_add(1) != Some(sequence)
        || metadata == 0
        || metadata > applied
    {
        return Err(integrity());
    }
    if matches!(input, Input::Renamed) {
        if run.is_some() {
            return Err(integrity());
        }
        sqlx::query("UPDATE conversation_projection SET metadata_sequence=? WHERE singleton=1")
            .bind(integer(sequence)?)
            .execute(&mut *sql)
            .await
            .map_err(database::error)?;
    } else {
        let run = run.ok_or_else(integrity)?;
        match input {
            Input::Accepted(input) => accept(sql, run, sequence, input).await?,
            Input::HistorySelected | Input::ProviderBound => {
                rows::block(sql, run, sequence).await?;
            }
            Input::Runtime(event) => runtime::observe(sql, run, sequence, event).await?,
            Input::ToolResult {
                request_id,
                call_id,
                output,
                is_error,
            } => {
                runtime::tool_result(sql, run, sequence, request_id, call_id, output, is_error)
                    .await?
            }
            Input::Result(result) => {
                if result.run_id != run.as_str() {
                    return Err(integrity());
                }
                let mut header = rows::block(sql, run, sequence).await?;
                if header.result_recorded || header.state == RecordedRunState::Interrupted {
                    return Err(integrity());
                }
                let outcome = Outcome::new(&result.outcome);
                if header.outcome.as_ref().is_some_and(|old| old != &outcome)
                    || (header.outcome.is_none() && result.events_complete)
                {
                    return Err(integrity());
                }
                header.state = outcome.state();
                header.outcome = Some(outcome);
                header.summary = Some(Summary::from(&result.summary));
                header.result_recorded = true;
                header.events_complete = Some(result.events_complete);
                header.sink_error = result.sink_error;
                header.current_turn = None;
                header.current_assistant = None;
                runtime::settle(sql, run, sequence, State::unfinished(&result.outcome)).await?;
                rows::save_block(sql, run, sequence, &header).await?;
            }
            Input::Interrupted => {
                let mut header = rows::block(sql, run, sequence).await?;
                if !matches!(
                    header.state,
                    RecordedRunState::Accepted | RecordedRunState::Running
                ) {
                    return Err(integrity());
                }
                header.state = RecordedRunState::Interrupted;
                header.current_turn = None;
                header.current_assistant = None;
                runtime::settle(sql, run, sequence, State::Interrupted).await?;
                rows::save_block(sql, run, sequence, &header).await?;
            }
            Input::Created | Input::Renamed => return Err(integrity()),
        }
    }
    sqlx::query("UPDATE conversation_projection SET applied_sequence=? WHERE singleton=1")
        .bind(integer(sequence)?)
        .execute(sql)
        .await
        .map_err(database::error)?;
    Ok(())
}

async fn accept(
    sql: &mut SqliteConnection,
    run: &RunId,
    sequence: u64,
    input: &RecordedRunInput,
) -> Result<()> {
    let id = EntryId::new(sequence, 0).map_err(|_| integrity())?;
    let header = BlockHeader {
        human: id.to_string(),
        state: RecordedRunState::Accepted,
        result_recorded: false,
        outcome: None,
        summary: None,
        events_complete: None,
        sink_error: None,
        current_turn: None,
        current_assistant: None,
    };
    sqlx::query("INSERT INTO conversation_blocks (run_id,accepted_sequence,changed_sequence,header_json) VALUES (?,?,?,?)")
        .bind(run.as_str()).bind(integer(sequence)?).bind(integer(sequence)?).bind(rows::encode(&header)?)
        .execute(&mut *sql).await.map_err(database::error)?;
    let entry = rows::create(
        sql,
        run,
        sequence,
        EntryMetadata::new(Source::Human, State::Accepted, false),
    )
    .await?;
    let key = FieldKey::new(run.clone(), entry.id, FieldOrder::Human, FieldKind::Text)?;
    fields::insert(sql, &key, sequence, input.user_text()).await?;
    Ok(())
}
