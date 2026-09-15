use std::fmt;

use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteRow};

use super::{
    ApplicationSessionId, RecordedRunInput, RunId, StorageError, StoredEventId, database,
    dto::{self, CreatedPayload, RenamedPayload},
    records,
    session_schema::integrity,
};
use crate::run::{RunEvent, RunEventEnvelope, RunResult};

type Result<T> = std::result::Result<T, StorageError>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedPayload {
    pub(super) run_id: RunId,
    pub(super) input: RecordedRunInput,
    pub(super) owner_instance_id: StoredEventId,
}
impl AcceptedPayload {
    pub fn run_id(&self) -> &RunId {
        &self.run_id
    }
    pub fn input(&self) -> &RecordedRunInput {
        &self.input
    }
    pub fn owner_instance_id(&self) -> &StoredEventId {
        &self.owner_instance_id
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolResultPayload {
    pub(super) request_id: Option<String>,
    pub(super) call_id: String,
    pub(super) output: String,
    pub(super) is_error: bool,
}
impl ToolResultPayload {
    pub fn request_id(&self) -> Option<&str> {
        self.request_id.as_deref()
    }
    pub fn call_id(&self) -> &str {
        &self.call_id
    }
    pub fn output(&self) -> &str {
        &self.output
    }
    pub fn is_error(&self) -> bool {
        self.is_error
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InterruptionReason {
    ProcessRestart,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InterruptedPayload {
    pub(super) run_id: RunId,
    pub(super) reason: InterruptionReason,
}
impl InterruptedPayload {
    pub fn run_id(&self) -> &RunId {
        &self.run_id
    }
    pub fn reason(&self) -> InterruptionReason {
        self.reason
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "event_type", content = "payload")]
pub enum StoredEventPayload {
    #[serde(rename = "session.created")]
    SessionCreated(CreatedPayload),
    #[serde(rename = "session.renamed")]
    SessionRenamed { title: String },
    #[serde(rename = "run.accepted")]
    RunAccepted(AcceptedPayload),
    #[serde(rename = "runtime.observed")]
    RuntimeObserved(RunEventEnvelope),
    #[serde(rename = "tool.result.recorded")]
    ToolResultRecorded(ToolResultPayload),
    #[serde(rename = "run.result.recorded")]
    RunResultRecorded(RunResult),
    #[serde(rename = "run.interrupted")]
    RunInterrupted(InterruptedPayload),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(try_from = "StoredEventFields")]
pub struct StoredEvent {
    schema_version: u32,
    application_session_id: ApplicationSessionId,
    sequence: u64,
    event_id: StoredEventId,
    created_at_ms: i64,
    event_version: u32,
    run_id: Option<RunId>,
    #[serde(flatten)]
    payload: StoredEventPayload,
}
impl StoredEvent {
    pub fn schema_version(&self) -> u32 {
        self.schema_version
    }
    pub fn application_session_id(&self) -> &ApplicationSessionId {
        &self.application_session_id
    }
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
    pub fn event_id(&self) -> &StoredEventId {
        &self.event_id
    }
    pub fn created_at_ms(&self) -> i64 {
        self.created_at_ms
    }
    pub fn event_version(&self) -> u32 {
        self.event_version
    }
    pub fn run_id(&self) -> Option<&RunId> {
        self.run_id.as_ref()
    }
    pub fn payload(&self) -> &StoredEventPayload {
        &self.payload
    }
    pub fn event_type(&self) -> &'static str {
        match &self.payload {
            StoredEventPayload::SessionCreated(_) => "session.created",
            StoredEventPayload::SessionRenamed { .. } => "session.renamed",
            StoredEventPayload::RunAccepted(_) => "run.accepted",
            StoredEventPayload::RuntimeObserved(_) => "runtime.observed",
            StoredEventPayload::ToolResultRecorded(_) => "tool.result.recorded",
            StoredEventPayload::RunResultRecorded(_) => "run.result.recorded",
            StoredEventPayload::RunInterrupted(_) => "run.interrupted",
        }
    }
}

#[derive(Clone, Serialize)]
pub struct HistoryPage {
    through_sequence: u64,
    next_after: u64,
    has_more: bool,
    records: Vec<StoredEvent>,
}
impl HistoryPage {
    pub fn through_sequence(&self) -> u64 {
        self.through_sequence
    }
    pub fn next_after(&self) -> u64 {
        self.next_after
    }
    pub fn has_more(&self) -> bool {
        self.has_more
    }
    pub fn records(&self) -> &[StoredEvent] {
        &self.records
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredEventFields {
    schema_version: u32,
    application_session_id: ApplicationSessionId,
    sequence: u64,
    event_id: StoredEventId,
    created_at_ms: i64,
    event_version: u32,
    run_id: Option<RunId>,
    event_type: String,
    payload: serde_json::Value,
}

impl TryFrom<StoredEventFields> for StoredEvent {
    type Error = StorageError;

    fn try_from(fields: StoredEventFields) -> Result<Self> {
        let StoredEventFields {
            schema_version,
            application_session_id,
            sequence,
            event_id,
            created_at_ms,
            event_version,
            run_id,
            event_type,
            payload,
        } = fields;
        if schema_version != 1
            || event_version != 1
            || sequence == 0
            || sequence > i64::MAX as u64
            || created_at_ms < 0
            || (sequence == 1) != (event_type == "session.created")
        {
            return Err(integrity());
        }
        let id = &application_session_id;
        let json = dto::canonical_json(&payload)?;
        let payload = match event_type.as_str() {
            "session.created" => {
                let payload: CreatedPayload = dto::decode(&json)?;
                let provenance = &payload.creation_provenance;
                let original = provenance.request()?;
                if sequence != 1
                    || run_id.is_some()
                    || provenance.session_id != *id
                    || provenance.creation_event_id != event_id
                    || provenance.created_at_ms != created_at_ms
                    || original.title() != payload.title
                    || original.workspace() != payload.workspace.as_deref()
                {
                    return Err(integrity());
                }
                StoredEventPayload::SessionCreated(payload)
            }
            "session.renamed" => {
                if sequence == 1 || run_id.is_some() {
                    return Err(integrity());
                }
                let payload: RenamedPayload = dto::decode(&json)?;
                StoredEventPayload::SessionRenamed {
                    title: payload.title,
                }
            }
            "run.accepted" => {
                let payload: AcceptedPayload = dto::decode(&json)?;
                if run_id.as_ref() != Some(&payload.run_id) {
                    return Err(integrity());
                }
                StoredEventPayload::RunAccepted(payload)
            }
            "runtime.observed" => {
                let event: RunEventEnvelope = dto::decode(&json)?;
                records::validate_runtime(&event).map_err(|_| integrity())?;
                if run_id.as_ref().map(RunId::as_str) != Some(event.run_id.as_str()) {
                    return Err(integrity());
                }
                StoredEventPayload::RuntimeObserved(event)
            }
            "tool.result.recorded" => {
                if run_id.is_none() {
                    return Err(integrity());
                }
                StoredEventPayload::ToolResultRecorded(dto::decode(&json)?)
            }
            "run.result.recorded" => {
                let result: RunResult = dto::decode(&json)?;
                if run_id.as_ref().map(RunId::as_str) != Some(result.run_id.as_str()) {
                    return Err(integrity());
                }
                StoredEventPayload::RunResultRecorded(result)
            }
            "run.interrupted" => {
                let payload: InterruptedPayload = dto::decode(&json)?;
                if run_id.as_ref() != Some(&payload.run_id) {
                    return Err(integrity());
                }
                StoredEventPayload::RunInterrupted(payload)
            }
            _ => return Err(integrity()),
        };
        Ok(StoredEvent {
            schema_version,
            application_session_id,
            sequence,
            event_id,
            created_at_ms,
            event_version,
            run_id,
            payload,
        })
    }
}

pub(super) fn decode(row: &SqliteRow, id: &ApplicationSessionId) -> Result<StoredEvent> {
    let sequence: i64 = row.try_get("sequence").map_err(|_| integrity())?;
    let run: Option<String> = row.try_get("run_id").map_err(|_| integrity())?;
    let fields = StoredEventFields {
        schema_version: 1,
        application_session_id: id.clone(),
        sequence: u64::try_from(sequence).map_err(|_| integrity())?,
        event_id: row
            .try_get::<String, _>("event_id")
            .map_err(|_| integrity())?
            .parse()
            .map_err(|_| integrity())?,
        created_at_ms: row.try_get("created_at_ms").map_err(|_| integrity())?,
        event_version: u32::try_from(
            row.try_get::<i64, _>("event_version")
                .map_err(|_| integrity())?,
        )
        .map_err(|_| integrity())?,
        run_id: run
            .map(|s| s.parse::<RunId>().map_err(|_| integrity()))
            .transpose()?,
        event_type: row.try_get("event_type").map_err(|_| integrity())?,
        payload: dto::decode(
            &row.try_get::<String, _>("payload_json")
                .map_err(|_| integrity())?,
        )?,
    };
    let event = StoredEvent::try_from(fields)?;
    let source_id: Option<String> = row.try_get("source_event_id").map_err(|_| integrity())?;
    let source_sequence: Option<i64> = row.try_get("source_sequence").map_err(|_| integrity())?;
    if let StoredEventPayload::RuntimeObserved(runtime) = event.payload() {
        if source_id.as_deref() != Some(runtime.event_id.as_str())
            || source_sequence != Some(runtime.sequence as i64)
        {
            return Err(integrity());
        }
    } else if source_id.is_some() || source_sequence.is_some() {
        return Err(integrity());
    }
    Ok(event)
}

pub(super) async fn event(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
    sequence: u64,
) -> Result<StoredEvent> {
    let row = sqlx::query("SELECT * FROM events WHERE sequence=?")
        .bind(i64::try_from(sequence).map_err(|_| integrity())?)
        .fetch_optional(connection)
        .await
        .map_err(database::error)?
        .ok_or_else(integrity)?;
    decode(&row, id)
}

pub(super) async fn page(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
    after: u64,
    through: Option<u64>,
    limit: i64,
) -> Result<HistoryPage> {
    let mut transaction = connection.begin().await.map_err(database::error)?;
    let result = async {
        let head: i64 = sqlx::query("SELECT head_sequence FROM manifest WHERE singleton=1")
            .fetch_one(&mut *transaction)
            .await
            .map_err(database::error)?
            .try_get(0)
            .map_err(|_| integrity())?;
        let through = through.unwrap_or(head as u64);
        if head < 1 || through > head as u64 || after > through {
            return Err(records::invalid());
        }
        let rows = sqlx::query(
            "SELECT * FROM events WHERE sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?",
        )
        .bind(after as i64)
        .bind(through as i64)
        .bind(limit)
        .fetch_all(&mut *transaction)
        .await
        .map_err(database::error)?;
        let has_more = rows.len() == limit as usize;
        let mut records = Vec::new();
        let mut next_after = after;
        for row in rows.iter().take((limit - 1) as usize) {
            let record = decode(row, id)?;
            if record.sequence != next_after.checked_add(1).ok_or_else(integrity)? {
                return Err(integrity());
            }
            next_after = record.sequence;
            records.push(record);
        }
        if !has_more && next_after != through {
            return Err(integrity());
        }
        Ok(HistoryPage {
            through_sequence: through,
            next_after,
            has_more,
            records,
        })
    }
    .await;
    transaction.rollback().await.map_err(database::error)?;
    result
}

pub(super) fn terminal_outcome(
    event: &StoredEvent,
) -> Option<(&crate::run::RunOutcome, Option<&str>)> {
    match event.payload() {
        StoredEventPayload::RuntimeObserved(RunEventEnvelope {
            event: RunEvent::RunFinished { outcome, .. },
            session_id,
            ..
        }) => Some((outcome, session_id.as_deref())),
        StoredEventPayload::RunResultRecorded(result) => {
            Some((&result.outcome, result.session_id.as_deref()))
        }
        _ => None,
    }
}

macro_rules! redacted {
    ($($name:ident),+ $(,)?) => {$(impl fmt::Debug for $name {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(concat!(stringify!($name), "([redacted])")) }
    })+};
}
redacted!(
    AcceptedPayload,
    ToolResultPayload,
    InterruptedPayload,
    StoredEventPayload,
    StoredEvent,
    HistoryPage
);
