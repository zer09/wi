use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};

use super::{Result, integer, integrity, unsigned};
use crate::{
    OutputProvenance, UpstreamOutcome,
    conversation::{
        EntryId,
        interpretation::State,
        primitives::{EntrySource, SourceKey},
        safe_code,
    },
    run::{RunOutcome, RunSinkError, RunSummary},
    storage::{RecordedRunState, RunId, database},
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::storage::conversation) struct BlockHeader {
    pub(in crate::storage::conversation) human: String,
    pub(in crate::storage::conversation) state: RecordedRunState,
    pub(in crate::storage::conversation) result_recorded: bool,
    pub(in crate::storage::conversation) outcome: Option<Outcome>,
    pub(in crate::storage::conversation) summary: Option<Summary>,
    pub(in crate::storage::conversation) events_complete: Option<bool>,
    pub(in crate::storage::conversation) sink_error: Option<RunSinkError>,
    pub(super) current_turn: Option<String>,
    pub(super) current_assistant: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(in crate::storage::conversation) enum Outcome {
    Completed,
    Failed { code: String },
    CancelledLocally,
}
impl Outcome {
    pub(super) fn new(outcome: &RunOutcome) -> Self {
        match outcome {
            RunOutcome::Completed => Self::Completed,
            RunOutcome::Failed { code } => Self::Failed {
                code: safe_code(code).as_str().into(),
            },
            RunOutcome::CancelledLocally => Self::CancelledLocally,
        }
    }
    pub(super) fn state(&self) -> RecordedRunState {
        match self {
            Self::Completed => RecordedRunState::Completed,
            Self::Failed { .. } => RecordedRunState::Failed,
            Self::CancelledLocally => RecordedRunState::CancelledLocally,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::storage::conversation) struct Summary {
    turns_started: u64,
    turns_finished: u64,
    model_requests_attempted: u64,
    model_requests_admitted: u64,
    new_tool_dispatches: u64,
    tool_results_prepared: u64,
    reused_results: u64,
    last_request_id: Option<String>,
    last_upstream_outcome: Option<UpstreamOutcome>,
}
impl Summary {
    pub(in crate::storage::conversation) fn view(&self) -> crate::conversation::SummaryView {
        crate::conversation::SummaryView::from(&RunSummary {
            turns_started: self.turns_started,
            turns_finished: self.turns_finished,
            model_requests_attempted: self.model_requests_attempted,
            model_requests_admitted: self.model_requests_admitted,
            new_tool_dispatches: self.new_tool_dispatches,
            tool_results_prepared: self.tool_results_prepared,
            reused_results: self.reused_results,
            last_request_id: self.last_request_id.clone(),
            last_upstream_outcome: self.last_upstream_outcome,
        })
    }
}
impl From<&RunSummary> for Summary {
    fn from(value: &RunSummary) -> Self {
        Self {
            turns_started: value.turns_started,
            turns_finished: value.turns_finished,
            model_requests_attempted: value.model_requests_attempted,
            model_requests_admitted: value.model_requests_admitted,
            new_tool_dispatches: value.new_tool_dispatches,
            tool_results_prepared: value.tool_results_prepared,
            reused_results: value.reused_results,
            last_request_id: value.last_request_id.clone(),
            last_upstream_outcome: value.last_upstream_outcome,
        }
    }
}

// Only the affected source identity is retained, never a map of turns or items.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(in crate::storage::conversation) enum Source {
    Human,
    Assistant { turn_id: String },
    Tool { call_id: String },
    Reuse { sequence: u64, slot: u64 },
    Notice { sequence: u64, slot: u64 },
}
impl Source {
    pub(super) fn key(&self, run: &RunId) -> Result<SourceKey> {
        let source = match self {
            Self::Human => EntrySource::Human,
            Self::Assistant { turn_id } => EntrySource::Assistant { turn_id },
            Self::Tool { call_id } => EntrySource::Tool { call_id },
            Self::Reuse { sequence, slot } => EntrySource::Reuse {
                sequence: *sequence,
                slot: *slot,
            },
            Self::Notice { sequence, slot } => EntrySource::Notice {
                sequence: *sequence,
                slot: *slot,
            },
        };
        SourceKey::entry(run, source).map_err(|_| integrity())
    }
    pub(super) fn kind(&self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Assistant { .. } => "assistant",
            Self::Tool { .. } => "tool",
            Self::Reuse { .. } => "reuse",
            Self::Notice { .. } => "notice",
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::storage::conversation) struct EntryMetadata {
    pub(in crate::storage::conversation) source: Source,
    pub(in crate::storage::conversation) state: State,
    pub(in crate::storage::conversation) provisional: bool,
    pub(super) response_id: Option<String>,
    pub(super) provenance: Option<OutputProvenance>,
    pub(super) turn_id: Option<String>,
    pub(super) request_id: Option<String>,
    pub(in crate::storage::conversation) reference: Option<String>,
    pub(in crate::storage::conversation) result_recorded: Option<bool>,
    pub(in crate::storage::conversation) finish_recorded: Option<bool>,
    pub(in crate::storage::conversation) is_error: Option<bool>,
    pub(super) finish_is_error: Option<bool>,
    pub(super) failure: Option<String>,
    pub(super) upstream_outcome: Option<UpstreamOutcome>,
    pub(super) closed: bool,
}
impl EntryMetadata {
    pub(super) fn new(source: Source, state: State, provisional: bool) -> Self {
        Self {
            source,
            state,
            provisional,
            response_id: None,
            provenance: None,
            turn_id: None,
            request_id: None,
            reference: None,
            result_recorded: None,
            finish_recorded: None,
            is_error: None,
            finish_is_error: None,
            failure: None,
            upstream_outcome: None,
            closed: false,
        }
    }
}

pub(in crate::storage::conversation) struct Entry {
    pub(in crate::storage::conversation) id: EntryId,
    pub(in crate::storage::conversation) epoch: u64,
    pub(in crate::storage::conversation) revision: u64,
    pub(in crate::storage::conversation) metadata: EntryMetadata,
}

pub(super) fn encode(value: &impl Serialize) -> Result<String> {
    serde_json::to_string(value).map_err(|_| integrity())
}
pub(in crate::storage::conversation) fn decode<T: DeserializeOwned>(text: &str) -> Result<T> {
    if !text.trim_start().starts_with('{') {
        return Err(integrity());
    }
    serde_json::from_str(text).map_err(|_| integrity())
}

pub(in crate::storage::conversation) async fn block(
    sql: &mut SqliteConnection,
    run: &RunId,
    sequence: u64,
) -> Result<BlockHeader> {
    let row = sqlx::query("SELECT accepted_sequence,changed_sequence,header_json FROM conversation_blocks WHERE run_id=?")
        .bind(run.as_str()).fetch_optional(sql).await.map_err(database::error)?.ok_or_else(integrity)?;
    let accepted = unsigned(row.try_get("accepted_sequence").map_err(database::error)?)?;
    let changed = unsigned(row.try_get("changed_sequence").map_err(database::error)?)?;
    let header: BlockHeader = decode(row.try_get("header_json").map_err(database::error)?)?;
    let human: EntryId = header.human.parse().map_err(|_| integrity())?;
    if accepted == 0
        || human.first_sequence() != accepted
        || human.position_slot() != 0
        || changed < accepted
        || changed >= sequence
        || header
            .outcome
            .as_ref()
            .is_some_and(|outcome| match outcome {
                Outcome::Failed { code } => safe_code(code).as_str() != code,
                _ => false,
            })
    {
        return Err(integrity());
    }
    Ok(header)
}
pub(super) async fn save_block(
    sql: &mut SqliteConnection,
    run: &RunId,
    sequence: u64,
    header: &BlockHeader,
) -> Result<()> {
    let result = sqlx::query(
        "UPDATE conversation_blocks SET changed_sequence=?,header_json=? WHERE run_id=?",
    )
    .bind(integer(sequence)?)
    .bind(encode(header)?)
    .bind(run.as_str())
    .execute(sql)
    .await
    .map_err(database::error)?;
    if result.rows_affected() != 1 {
        return Err(integrity());
    }
    Ok(())
}

pub(in crate::storage::conversation) fn entry_row(
    row: &SqliteRow,
    run: &RunId,
    sequence: u64,
) -> Result<Entry> {
    let id: EntryId = row
        .try_get::<&str, _>("entry_id")
        .map_err(database::error)?
        .parse()
        .map_err(|_| integrity())?;
    let first = unsigned(row.try_get("first_sequence").map_err(database::error)?)?;
    let slot = unsigned(row.try_get("position_slot").map_err(database::error)?)?;
    let changed = unsigned(row.try_get("changed_sequence").map_err(database::error)?)?;
    let epoch = unsigned(row.try_get("content_epoch").map_err(database::error)?)?;
    let metadata: EntryMetadata = decode(row.try_get("metadata_json").map_err(database::error)?)?;
    let source: Vec<u8> = row.try_get("source_key").map_err(database::error)?;
    let kind: &str = row.try_get("kind").map_err(database::error)?;
    if id.first_sequence() != first
        || id.position_slot() != slot
        || epoch < first
        || changed < epoch
        || changed > sequence
        || source != metadata.source.key(run)?.bytes()
        || kind != metadata.source.kind()
        || metadata
            .failure
            .as_ref()
            .is_some_and(|code| safe_code(code).as_str() != code)
    {
        return Err(integrity());
    }
    if let Source::Reuse { sequence, slot } | Source::Notice { sequence, slot } = metadata.source
        && (sequence != first || slot != id.position_slot())
    {
        return Err(integrity());
    }
    let tool = matches!(metadata.source, Source::Tool { .. } | Source::Reuse { .. });
    if tool != metadata.result_recorded.is_some()
        || tool != metadata.finish_recorded.is_some()
        // Reuse always points to an actual recorded result, even without a finish event.
        || (matches!(metadata.source, Source::Reuse { .. })
            && metadata.result_recorded != Some(true))
        // A recorded result carries its actual flag, independently of any finish event.
        || (tool && metadata.result_recorded == Some(true) && metadata.is_error.is_none())
        || (matches!(metadata.source, Source::Reuse { .. })) != metadata.reference.is_some()
        || (!tool && (metadata.is_error.is_some() || metadata.finish_is_error.is_some()))
    {
        return Err(integrity());
    }
    if let Some(reference) = &metadata.reference {
        let target: EntryId = reference.parse().map_err(|_| integrity())?;
        if target >= id {
            return Err(integrity());
        }
    }
    Ok(Entry {
        id,
        epoch,
        revision: changed,
        metadata,
    })
}

pub(super) async fn lookup(
    sql: &mut SqliteConnection,
    run: &RunId,
    sequence: u64,
    source: &Source,
) -> Result<Option<Entry>> {
    let row = sqlx::query("SELECT entry_id,source_key,first_sequence,position_slot,changed_sequence,content_epoch,kind,metadata_json FROM conversation_entries WHERE run_id=? AND source_key=?")
        .bind(run.as_str()).bind(source.key(run)?.bytes().as_slice()).fetch_optional(sql).await.map_err(database::error)?;
    let entry = row
        .as_ref()
        .map(|row| entry_row(row, run, sequence))
        .transpose()?;
    if entry
        .as_ref()
        .is_some_and(|entry| entry.metadata.source != *source)
    {
        return Err(integrity());
    }
    Ok(entry)
}
pub(super) async fn create(
    sql: &mut SqliteConnection,
    run: &RunId,
    sequence: u64,
    metadata: EntryMetadata,
) -> Result<Entry> {
    if lookup(sql, run, sequence, &metadata.source)
        .await?
        .is_some()
    {
        return Err(integrity());
    }
    let id = EntryId::new(sequence, 0).map_err(|_| integrity())?;
    sqlx::query("INSERT INTO conversation_entries (run_id,entry_id,source_key,first_sequence,position_slot,changed_sequence,content_epoch,kind,metadata_json) VALUES (?,?,?,?,0,?,?,?,?)")
        .bind(run.as_str()).bind(id.to_string()).bind(metadata.source.key(run)?.bytes().as_slice())
        .bind(integer(sequence)?).bind(integer(sequence)?).bind(integer(sequence)?)
        .bind(metadata.source.kind()).bind(encode(&metadata)?).execute(sql).await.map_err(database::error)?;
    Ok(Entry {
        id,
        epoch: sequence,
        revision: sequence,
        metadata,
    })
}
pub(super) async fn save(
    sql: &mut SqliteConnection,
    run: &RunId,
    sequence: u64,
    entry: &Entry,
) -> Result<()> {
    let result = sqlx::query("UPDATE conversation_entries SET changed_sequence=?,content_epoch=?,metadata_json=? WHERE run_id=? AND entry_id=? AND source_key=?")
        .bind(integer(sequence)?).bind(integer(entry.epoch)?).bind(encode(&entry.metadata)?)
        .bind(run.as_str()).bind(entry.id.to_string()).bind(entry.metadata.source.key(run)?.bytes().as_slice())
        .execute(sql).await.map_err(database::error)?;
    if result.rows_affected() != 1 {
        return Err(integrity());
    }
    Ok(())
}
