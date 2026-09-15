use super::{
    dto::{self, CreationProvenance},
    history::{self, AcceptedPayload, StoredEventPayload, ToolResultPayload},
    records::invalid,
    session_schema::integrity,
    *,
};
use crate::{
    run::{RunEvent, RunEventEnvelope, RunOutcome, RunResult},
    tools::ToolExecutionEvent,
};
use serde::Serialize;
use sqlx::{Connection, Row, SqliteConnection};
use std::fmt;

type Result<T> = std::result::Result<T, StorageError>;

mod repair;
pub(super) use repair::validate_run;

#[derive(Clone, Serialize)]
pub struct RecordedRun {
    run_id: RunId,
    accepted_sequence: u64,
    input: RecordedRunInput,
    state: RecordedRunState,
    last_runtime_sequence: u64,
    owner_instance_id: StoredEventId,
    provider_session_id: Option<String>,
    terminal: Option<StoredEvent>,
    result_sequence: Option<u64>,
    result: Option<RunResult>,
}
impl RecordedRun {
    pub fn run_id(&self) -> &RunId {
        &self.run_id
    }
    pub fn accepted_sequence(&self) -> u64 {
        self.accepted_sequence
    }
    pub fn input(&self) -> &RecordedRunInput {
        &self.input
    }
    pub fn state(&self) -> RecordedRunState {
        self.state
    }
    pub fn last_runtime_sequence(&self) -> u64 {
        self.last_runtime_sequence
    }
    pub fn owner_instance_id(&self) -> &StoredEventId {
        &self.owner_instance_id
    }
    pub fn provider_session_id(&self) -> Option<&str> {
        self.provider_session_id.as_deref()
    }
    pub fn terminal_sequence(&self) -> Option<u64> {
        self.terminal.as_ref().map(StoredEvent::sequence)
    }
    pub fn terminal(&self) -> Option<&StoredEvent> {
        self.terminal.as_ref()
    }
    pub fn result_sequence(&self) -> Option<u64> {
        self.result_sequence
    }
    pub fn result(&self) -> Option<&RunResult> {
        self.result.as_ref()
    }
}
impl fmt::Debug for RecordedRun {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecordedRun([redacted])")
    }
}

#[derive(Clone, Serialize)]
pub struct RecordedToolResult {
    run_id: RunId,
    call_id: String,
    tool_name: String,
    request_id: Option<String>,
    started_sequence: u64,
    finished_sequence: Option<u64>,
    result_sequence: Option<u64>,
    is_error: Option<bool>,
    output: Option<String>,
}
impl RecordedToolResult {
    pub fn run_id(&self) -> &RunId {
        &self.run_id
    }
    pub fn call_id(&self) -> &str {
        &self.call_id
    }
    pub fn tool_name(&self) -> &str {
        &self.tool_name
    }
    pub fn request_id(&self) -> Option<&str> {
        self.request_id.as_deref()
    }
    pub fn started_sequence(&self) -> u64 {
        self.started_sequence
    }
    pub fn finished_sequence(&self) -> Option<u64> {
        self.finished_sequence
    }
    pub fn result_sequence(&self) -> Option<u64> {
        self.result_sequence
    }
    pub fn is_error(&self) -> Option<bool> {
        self.is_error
    }
    pub fn output(&self) -> Option<&str> {
        self.output.as_deref()
    }
}
impl fmt::Debug for RecordedToolResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecordedToolResult([redacted])")
    }
}

fn transition() -> StorageError {
    StorageError::new(StorageErrorKind::InvalidTransition)
}
fn active(state: RecordedRunState) -> bool {
    matches!(
        state,
        RecordedRunState::Accepted | RecordedRunState::Running
    )
}
fn outcome_state(outcome: &RunOutcome) -> RecordedRunState {
    match outcome {
        RunOutcome::Completed => RecordedRunState::Completed,
        RunOutcome::Failed { .. } => RecordedRunState::Failed,
        RunOutcome::CancelledLocally => RecordedRunState::CancelledLocally,
    }
}
pub(super) fn state_name(state: RecordedRunState) -> &'static str {
    match state {
        RecordedRunState::Accepted => "accepted",
        RecordedRunState::Running => "running",
        RecordedRunState::Completed => "completed",
        RecordedRunState::Failed => "failed",
        RecordedRunState::CancelledLocally => "cancelled_locally",
        RecordedRunState::Interrupted => "interrupted",
    }
}
fn positive(value: i64) -> Result<u64> {
    if value <= 0 {
        Err(integrity())
    } else {
        Ok(value as u64)
    }
}

pub(super) async fn run_record(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
    run_id: &RunId,
) -> Result<Option<RecordedRun>> {
    let Some(row) = sqlx::query("SELECT * FROM runs WHERE run_id=?")
        .bind(run_id.as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(database::error)?
    else {
        return Ok(None);
    };
    let accepted_sequence = positive(row.try_get("accepted_sequence").map_err(|_| integrity())?)?;
    let accepted = history::event(connection, id, accepted_sequence).await?;
    let StoredEventPayload::RunAccepted(accepted) = accepted.payload() else {
        return Err(integrity());
    };
    let owner: String = row.try_get("owner_instance_id").map_err(|_| integrity())?;
    if accepted.run_id() != run_id || accepted.owner_instance_id().as_str() != owner {
        return Err(integrity());
    }
    let state: RecordedRunState = dto::decode(&dto::canonical_json(
        &row.try_get::<String, _>("state").map_err(|_| integrity())?,
    )?)?;
    let last: i64 = row
        .try_get("last_runtime_sequence")
        .map_err(|_| integrity())?;
    if last < 0 {
        return Err(integrity());
    }
    let provider_session_id: Option<String> = row
        .try_get("provider_session_id")
        .map_err(|_| integrity())?;
    let terminal_sequence = row
        .try_get::<Option<i64>, _>("terminal_sequence")
        .map_err(|_| integrity())?
        .map(positive)
        .transpose()?;
    let terminal_json: Option<String> = row.try_get("terminal_json").map_err(|_| integrity())?;
    if terminal_sequence.is_some() != terminal_json.is_some()
        || active(state) == terminal_sequence.is_some()
    {
        return Err(integrity());
    }
    let terminal = if let Some(sequence) = terminal_sequence {
        let event = history::event(connection, id, sequence).await?;
        if sequence <= accepted_sequence || event.run_id() != Some(run_id) {
            return Err(integrity());
        }
        if state == RecordedRunState::Interrupted {
            if !matches!(event.payload(), StoredEventPayload::RunInterrupted(_)) {
                return Err(integrity());
            }
        } else {
            let (outcome, provider) = history::terminal_outcome(&event).ok_or_else(integrity)?;
            if outcome_state(outcome) != state || provider != provider_session_id.as_deref() {
                return Err(integrity());
            }
        }
        let stored: serde_json::Value =
            dto::decode(terminal_json.as_deref().ok_or_else(integrity)?)?;
        let actual = serde_json::to_value(&event).map_err(|_| integrity())?;
        if stored != actual["payload"] {
            return Err(integrity());
        }
        Some(event)
    } else {
        None
    };
    let result_sequence = row
        .try_get::<Option<i64>, _>("result_sequence")
        .map_err(|_| integrity())?
        .map(positive)
        .transpose()?;
    let result = if let Some(sequence) = result_sequence {
        let event = history::event(connection, id, sequence).await?;
        let StoredEventPayload::RunResultRecorded(result) = event.payload() else {
            return Err(integrity());
        };
        let terminal = terminal.as_ref().ok_or_else(integrity)?;
        let (outcome, provider) = history::terminal_outcome(terminal).ok_or_else(integrity)?;
        if event.run_id() != Some(run_id)
            || result.outcome != *outcome
            || result.session_id.as_deref() != provider
            || sequence < terminal.sequence()
        {
            return Err(integrity());
        }
        Some(result.clone())
    } else {
        None
    };
    Ok(Some(RecordedRun {
        run_id: run_id.clone(),
        accepted_sequence,
        input: accepted.input().clone(),
        state,
        last_runtime_sequence: last as u64,
        owner_instance_id: accepted.owner_instance_id().clone(),
        provider_session_id,
        terminal,
        result_sequence,
        result,
    }))
}

pub(super) async fn tool_result(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
    run: &RunId,
    call: &str,
) -> Result<Option<RecordedToolResult>> {
    let Some(row) = sqlx::query("SELECT * FROM tool_results WHERE run_id=? AND call_id=?")
        .bind(run.as_str())
        .bind(call)
        .fetch_optional(&mut *connection)
        .await
        .map_err(database::error)?
    else {
        return Ok(None);
    };
    let recorded = RecordedToolResult {
        run_id: run.clone(),
        call_id: call.to_owned(),
        tool_name: row.try_get("tool_name").map_err(|_| integrity())?,
        request_id: row.try_get("request_id").map_err(|_| integrity())?,
        started_sequence: positive(row.try_get("started_sequence").map_err(|_| integrity())?)?,
        finished_sequence: row
            .try_get::<Option<i64>, _>("finished_sequence")
            .map_err(|_| integrity())?
            .map(positive)
            .transpose()?,
        result_sequence: row
            .try_get::<Option<i64>, _>("result_sequence")
            .map_err(|_| integrity())?
            .map(positive)
            .transpose()?,
        is_error: match row
            .try_get::<Option<i64>, _>("is_error")
            .map_err(|_| integrity())?
        {
            None => None,
            Some(0) => Some(false),
            Some(1) => Some(true),
            _ => return Err(integrity()),
        },
        output: row.try_get("output").map_err(|_| integrity())?,
    };
    if recorded.result_sequence.is_some() != recorded.output.is_some()
        || (recorded.result_sequence.is_some() || recorded.finished_sequence.is_some())
            != recorded.is_error.is_some()
    {
        return Err(integrity());
    }
    let started = history::event(connection, id, recorded.started_sequence).await?;
    match started.payload() {
        StoredEventPayload::RuntimeObserved(RunEventEnvelope {
            request_id,
            event:
                RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolExecutionStarted { call_id, tool_name },
                },
            ..
        }) if started.run_id() == Some(run)
            && request_id == &recorded.request_id
            && call_id == call
            && tool_name == &recorded.tool_name => {}
        _ => return Err(integrity()),
    }
    if let Some(sequence) = recorded.finished_sequence {
        let finished = history::event(connection, id, sequence).await?;
        match finished.payload() {
            StoredEventPayload::RuntimeObserved(RunEventEnvelope {
                request_id,
                event:
                    RunEvent::ToolEvent {
                        event:
                            ToolExecutionEvent::ToolExecutionFinished {
                                call_id,
                                tool_name,
                                is_error,
                            },
                    },
                ..
            }) if sequence > recorded.started_sequence
                && finished.run_id() == Some(run)
                && request_id == &recorded.request_id
                && call_id == call
                && tool_name == &recorded.tool_name
                && Some(*is_error) == recorded.is_error => {}
            _ => return Err(integrity()),
        }
    }
    if let Some(sequence) = recorded.result_sequence {
        let result = history::event(connection, id, sequence).await?;
        match result.payload() {
            StoredEventPayload::ToolResultRecorded(payload)
                if sequence > recorded.started_sequence
                    && result.run_id() == Some(run)
                    && payload.call_id() == call
                    && payload.request_id() == recorded.request_id()
                    && Some(payload.output()) == recorded.output()
                    && Some(payload.is_error()) == recorded.is_error => {}
            _ => return Err(integrity()),
        }
    }
    Ok(Some(recorded))
}

// Only the latest correlation evidence is needed between append transactions.
#[derive(Default)]
struct Correlation {
    session: Option<String>,
    turn: Option<(String, u64)>,
    request: Option<String>,
    provider_sequence: Option<u64>,
}

impl Correlation {
    async fn load(
        connection: &mut SqliteConnection,
        id: &ApplicationSessionId,
        run: &RecordedRun,
    ) -> Result<Self> {
        let mut state = Self {
            session: run.provider_session_id.clone(),
            ..Self::default()
        };
        if run.last_runtime_sequence == 0 {
            return Ok(state);
        }
        let latest = latest_runtime(connection, id, &run.run_id, None)
            .await?
            .ok_or_else(integrity)?;
        if latest.sequence != run.last_runtime_sequence {
            return Err(integrity());
        }
        state.request = latest.request_id;
        if !matches!(
            latest.event,
            RunEvent::RunStarted | RunEvent::TurnFinished { .. } | RunEvent::RunFinished { .. }
        ) {
            let started = latest_runtime(connection, id, &run.run_id, Some("turn_started"))
                .await?
                .ok_or_else(integrity)?;
            let RunEvent::TurnStarted { number } = started.event else {
                return Err(integrity());
            };
            if latest.turn_id != started.turn_id {
                return Err(integrity());
            }
            state.turn = Some((started.turn_id.ok_or_else(integrity)?, number));
        }
        if let Some(provider) =
            latest_runtime(connection, id, &run.run_id, Some("provider_event")).await?
        {
            let RunEvent::ProviderEvent { event } = provider.event else {
                return Err(integrity());
            };
            state.provider_sequence = Some(event.sequence);
        }
        Ok(state)
    }

    async fn observe(
        &mut self,
        connection: &mut SqliteConnection,
        run: &RecordedRun,
        event: &RunEventEnvelope,
        before_sequence: i64,
    ) -> Result<()> {
        if event.run_id != run.run_id.as_str() {
            return Err(invalid());
        }
        if event.sequence <= run.last_runtime_sequence
            || sqlx::query("SELECT 1 FROM events WHERE source_event_id=? AND sequence < ?")
                .bind(&event.event_id)
                .bind(before_sequence)
                .fetch_optional(&mut *connection)
                .await
                .map_err(database::error)?
                .is_some()
        {
            return Err(StorageError::new(StorageErrorKind::CommandConflict));
        }
        match event.event {
            RunEvent::RunStarted if run.state == RecordedRunState::Accepted => {}
            RunEvent::RunStarted => return Err(transition()),
            _ if run.state != RecordedRunState::Running => return Err(transition()),
            _ => {}
        }
        if self.session.is_some() && self.session != event.session_id {
            return Err(transition());
        }
        match &event.event {
            RunEvent::RunStarted => {}
            RunEvent::TurnStarted { number } => {
                if self.turn.is_some()
                    || sqlx::query("SELECT 1 FROM events WHERE run_id=? AND sequence < ? AND event_type='runtime.observed' AND json_extract(payload_json, '$.type')='turn_started' AND json_extract(payload_json, '$.turn_id')=? LIMIT 1")
                        .bind(run.run_id.as_str()).bind(before_sequence).bind(&event.turn_id)
                        .fetch_optional(connection).await.map_err(database::error)?.is_some()
                {
                    return Err(transition());
                }
                self.turn = Some((event.turn_id.clone().ok_or_else(transition)?, *number));
                self.request = None;
            }
            RunEvent::ProviderEvent { .. }
            | RunEvent::ToolEvent { .. }
            | RunEvent::TurnFinished { .. } => {
                let (turn, number) = self.turn.as_ref().ok_or_else(transition)?;
                if event.turn_id.as_ref() != Some(turn)
                    || (self.request.is_some() && self.request != event.request_id)
                {
                    return Err(transition());
                }
                // Admission has no separate runtime event. Its first visible request fixes the turn.
                self.request = event.request_id.clone();
                if let RunEvent::ProviderEvent { event: provider } = &event.event {
                    if provider.provider != run.input.prepared_request().provider_id
                        || self
                            .provider_sequence
                            .is_some_and(|previous| provider.sequence <= previous)
                    {
                        return Err(transition());
                    }
                    self.provider_sequence = Some(provider.sequence);
                }
                if let RunEvent::TurnFinished {
                    number: finished, ..
                } = &event.event
                {
                    if finished != number {
                        return Err(transition());
                    }
                    self.turn = None;
                }
            }
            RunEvent::RunFinished { .. } => {
                if self.turn.is_some() || self.request != event.request_id {
                    return Err(transition());
                }
            }
        }
        self.session = event.session_id.clone();
        Ok(())
    }
}

async fn latest_runtime(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
    run: &RunId,
    kind: Option<&str>,
) -> Result<Option<RunEventEnvelope>> {
    let row = sqlx::query("SELECT * FROM events WHERE run_id=? AND event_type='runtime.observed' AND (? IS NULL OR json_extract(payload_json, '$.type')=?) ORDER BY sequence DESC LIMIT 1")
        .bind(run.as_str()).bind(kind).bind(kind)
        .fetch_optional(connection).await.map_err(database::error)?;
    let Some(row) = row else { return Ok(None) };
    let stored = history::decode(&row, id)?;
    let StoredEventPayload::RuntimeObserved(event) = stored.payload() else {
        return Err(integrity());
    };
    Ok(Some(event.clone()))
}

#[derive(Serialize)]
#[serde(tag = "method")]
pub(super) enum Mutation {
    #[serde(rename = "accept_run")]
    Accept { input: Box<RecordedRunInput> },
    #[serde(rename = "append_run_records")]
    Append { records: Vec<AppendRunRecord> },
}
impl Mutation {
    fn method(&self) -> &'static str {
        match self {
            Self::Accept { .. } => "accept_run",
            Self::Append { .. } => "append_run_records",
        }
    }
}

#[cfg(test)]
#[derive(Clone, Copy)]
pub(super) enum RecordFault {
    AfterEvent,
    AfterProjection,
}

pub(super) fn sequence_range(head: u64, count: usize) -> Result<(i64, i64)> {
    if count == 0 {
        return Err(invalid());
    }
    let first = super::session::next_sequence(head)?;
    let last = i64::try_from(count)
        .ok()
        .and_then(|count| first.checked_add(count - 1))
        .ok_or_else(invalid)?;
    Ok((first, last))
}

pub(super) async fn mutate(
    connection: &mut SqliteConnection,
    provenance: &CreationProvenance,
    owner: &StoredEventId,
    operation: &OperationId,
    run_id: &RunId,
    mutation: &Mutation,
    #[cfg(test)] fault: Option<RecordFault>,
) -> Result<(CommitReceipt, bool)> {
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| database::error(e).not_committed())?;
    let result = async {
        #[derive(Serialize)]
        struct Request<'a> { session_id: &'a ApplicationSessionId, run_id: &'a RunId, #[serde(flatten)] mutation: &'a Mutation }
        let id = &provenance.session_id;
        let hash = dto::hash(&dto::canonical_json(&Request { session_id: id, run_id, mutation })?);
        // A retry returns its original range even after the run is terminal.
        if let Some(command) = session::command(&mut transaction, id, operation).await? {
            if command.method != mutation.method() || command.payload_hash != hash { return Err(StorageError::new(StorageErrorKind::CommandConflict)); }
            if command.receipt.run_id() != Some(run_id) { return Err(integrity()); }
            return Ok((command.receipt, true));
        }
        let manifest = session_schema::validate(&mut transaction, id, Some(provenance)).await?;
        let count = match mutation { Mutation::Accept { .. } => 1, Mutation::Append { records } => records.len() };
        let (first, last) = sequence_range(manifest.head_sequence(), count)?;
        let timestamp = dto::now_ms()?;
        match mutation {
            Mutation::Accept { input } => {
                if sqlx::query("SELECT 1 FROM runs WHERE run_id=?").bind(run_id.as_str()).fetch_optional(&mut *transaction).await.map_err(database::error)?.is_some() { return Err(transition()); }
                if sqlx::query("SELECT 1 FROM runs WHERE state IN ('accepted','running')").fetch_optional(&mut *transaction).await.map_err(database::error)?.is_some() { return Err(StorageError::new(StorageErrorKind::ActiveRunExists)); }
                let payload = AcceptedPayload { run_id: run_id.clone(), input: input.as_ref().clone(), owner_instance_id: owner.clone() };
                insert_event(&mut transaction, first, timestamp, run_id, "run.accepted", &dto::canonical_json(&payload)?, None).await?;
                #[cfg(test)]
                if matches!(fault, Some(RecordFault::AfterEvent)) { return Err(StorageError::new(StorageErrorKind::Io)); }
                sqlx::query("INSERT INTO runs (run_id, accepted_sequence, state, last_runtime_sequence, owner_instance_id) VALUES (?, ?, 'accepted', 0, ?)")
                    .bind(run_id.as_str()).bind(first).bind(owner.as_str()).execute(&mut *transaction).await.map_err(database::error)?;
                #[cfg(test)]
                if matches!(fault, Some(RecordFault::AfterProjection)) { return Err(StorageError::new(StorageErrorKind::Io)); }
            }
            Mutation::Append { records } => {
                let mut run = run_record(&mut transaction, id, run_id).await?.ok_or_else(transition)?;
                let mut correlation = Correlation::load(&mut transaction, id, &run).await?;
                for (index, record) in records.iter().enumerate() {
                    record.validate()?;
                    // Any later rejection rolls back this whole batch, including its projections.
                    let sequence = first + index as i64;
                    if let AppendRunRecord::Runtime(event) = record {
                        correlation.observe(&mut transaction, &run, event, sequence).await?;
                    }
                    append(&mut transaction, id, &mut run, sequence, timestamp, record, #[cfg(test)] fault).await?;
                }
            }
        }
        let receipt = CommitReceipt::run_batch(operation.clone(), id.clone(), run_id.clone(), first, last)?;
        sqlx::query("UPDATE manifest SET head_sequence=?, updated_at_ms=? WHERE singleton=1").bind(last).bind(timestamp).execute(&mut *transaction).await.map_err(database::error)?;
        sqlx::query("INSERT INTO commands (operation_id, method, payload_hash, first_sequence, last_sequence, receipt_json) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(operation.as_str()).bind(mutation.method()).bind(hash.as_slice()).bind(first).bind(last).bind(dto::canonical_json(&receipt)?)
            .execute(&mut *transaction).await.map_err(database::error)?;
        Ok((receipt, false))
    }.await;
    database::finish_transaction(transaction, result).await
}

async fn insert_event(
    connection: &mut SqliteConnection,
    sequence: i64,
    timestamp: i64,
    run: &RunId,
    kind: &'static str,
    json: &str,
    source: Option<&RunEventEnvelope>,
) -> Result<()> {
    sqlx::query("INSERT INTO events (sequence, event_id, event_type, event_version, created_at_ms, run_id, source_event_id, source_sequence, payload_json) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)")
        .bind(sequence).bind(StoredEventId::new().as_str()).bind(kind).bind(timestamp).bind(run.as_str())
        .bind(source.map(|e| e.event_id.as_str())).bind(source.map(|e| e.sequence as i64)).bind(json)
        .execute(connection).await.map_err(database::error)?;
    Ok(())
}

async fn require_outputs(
    connection: &mut SqliteConnection,
    run: &RunId,
    outcome: &RunOutcome,
) -> Result<()> {
    if matches!(outcome, RunOutcome::Completed)
        && sqlx::query(
            "SELECT 1 FROM tool_results WHERE run_id=? AND result_sequence IS NULL LIMIT 1",
        )
        .bind(run.as_str())
        .fetch_optional(connection)
        .await
        .map_err(database::error)?
        .is_some()
    {
        return Err(transition());
    }
    Ok(())
}

async fn append(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
    run: &mut RecordedRun,
    sequence: i64,
    timestamp: i64,
    record: &AppendRunRecord,
    #[cfg(test)] fault: Option<RecordFault>,
) -> Result<()> {
    let (kind, json, source) = match record {
        AppendRunRecord::Runtime(event) => {
            ("runtime.observed", dto::canonical_json(event)?, Some(event))
        }
        AppendRunRecord::ToolResult {
            request_id,
            call_id,
            output,
            is_error,
        } => (
            "tool.result.recorded",
            dto::canonical_json(&ToolResultPayload {
                request_id: request_id.clone(),
                call_id: call_id.clone(),
                output: output.clone(),
                is_error: *is_error,
            })?,
            None,
        ),
        AppendRunRecord::Result(result) => {
            ("run.result.recorded", dto::canonical_json(result)?, None)
        }
    };
    if run.state == RecordedRunState::Interrupted
        || (!active(run.state) && !matches!(record, AppendRunRecord::Result(_)))
    {
        return Err(transition());
    }
    insert_event(
        connection,
        sequence,
        timestamp,
        &run.run_id,
        kind,
        &json,
        source,
    )
    .await?;
    #[cfg(test)]
    if matches!(fault, Some(RecordFault::AfterEvent)) {
        return Err(StorageError::new(StorageErrorKind::Io));
    }
    match record {
        AppendRunRecord::Runtime(event) => {
            match &event.event {
                RunEvent::RunStarted => run.state = RecordedRunState::Running,
                RunEvent::RunFinished { outcome, .. } => {
                    require_outputs(connection, &run.run_id, outcome).await?;
                    terminalize(connection, run, sequence, outcome, &json).await?;
                }
                RunEvent::ToolEvent { event: tool } => {
                    record_tool_event(connection, id, run, sequence, event, tool).await?;
                }
                _ => {}
            }
            run.last_runtime_sequence = event.sequence;
            run.provider_session_id = event.session_id.clone();
        }
        AppendRunRecord::ToolResult {
            request_id,
            call_id,
            output,
            is_error,
        } => {
            if run.state != RecordedRunState::Running {
                return Err(transition());
            }
            let saved = tool_result(connection, id, &run.run_id, call_id)
                .await?
                .ok_or_else(transition)?;
            if saved.request_id != *request_id
                || saved.result_sequence.is_some()
                || saved.is_error.is_some_and(|observed| observed != *is_error)
            {
                return Err(transition());
            }
            sqlx::query("UPDATE tool_results SET result_sequence=?, output=?, is_error=? WHERE run_id=? AND call_id=?")
                .bind(sequence).bind(output).bind(*is_error).bind(run.run_id.as_str()).bind(call_id).execute(&mut *connection).await.map_err(database::error)?;
        }
        AppendRunRecord::Result(result) => {
            if result.run_id != run.run_id.as_str() || run.result_sequence.is_some() {
                return Err(transition());
            }
            if active(run.state) {
                // A result replaces missing final delivery, not a second runtime lifecycle.
                if result.events_complete
                    || (run.provider_session_id.is_some()
                        && run.provider_session_id != result.session_id)
                {
                    return Err(transition());
                }
                require_outputs(connection, &run.run_id, &result.outcome).await?;
                terminalize(connection, run, sequence, &result.outcome, &json).await?;
                run.provider_session_id = result.session_id.clone();
            } else {
                let terminal = history::event(
                    connection,
                    id,
                    run.terminal_sequence().ok_or_else(integrity)?,
                )
                .await?;
                let (outcome, provider) =
                    history::terminal_outcome(&terminal).ok_or_else(transition)?;
                if *outcome != result.outcome || provider != result.session_id.as_deref() {
                    return Err(transition());
                }
            }
            run.result_sequence = Some(sequence as u64);
        }
    }
    sqlx::query("UPDATE runs SET state=?, last_runtime_sequence=?, provider_session_id=?, result_sequence=? WHERE run_id=?")
        .bind(state_name(run.state)).bind(run.last_runtime_sequence as i64).bind(&run.provider_session_id).bind(run.result_sequence.map(|s| s as i64)).bind(run.run_id.as_str())
        .execute(&mut *connection).await.map_err(database::error)?;
    // Keep terminal identity available for a following Result in the same batch.
    if !active(run.state) && run.terminal.is_none() {
        run.terminal = Some(history::event(connection, id, sequence as u64).await?);
    }
    #[cfg(test)]
    if matches!(fault, Some(RecordFault::AfterProjection)) {
        return Err(StorageError::new(StorageErrorKind::Io));
    }
    Ok(())
}

async fn terminalize(
    connection: &mut SqliteConnection,
    run: &mut RecordedRun,
    sequence: i64,
    outcome: &RunOutcome,
    json: &str,
) -> Result<()> {
    run.state = outcome_state(outcome);
    sqlx::query("UPDATE runs SET terminal_sequence=?, terminal_json=? WHERE run_id=?")
        .bind(sequence)
        .bind(json)
        .bind(run.run_id.as_str())
        .execute(connection)
        .await
        .map_err(database::error)?;
    Ok(())
}

async fn record_tool_event(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
    run: &RecordedRun,
    sequence: i64,
    envelope: &RunEventEnvelope,
    event: &ToolExecutionEvent,
) -> Result<()> {
    let request = envelope.request_id.as_deref().ok_or_else(transition)?;
    match event {
        ToolExecutionEvent::ToolExecutionStarted { call_id, tool_name } => {
            if tool_result(connection, id, &run.run_id, call_id)
                .await?
                .is_some()
            {
                return Err(transition());
            }
            sqlx::query("INSERT INTO tool_results (run_id, call_id, tool_name, request_id, started_sequence) VALUES (?, ?, ?, ?, ?)")
                .bind(run.run_id.as_str()).bind(call_id).bind(tool_name).bind(request).bind(sequence).execute(connection).await.map_err(database::error)?;
        }
        ToolExecutionEvent::ToolExecutionFinished {
            call_id,
            tool_name,
            is_error,
        } => {
            let saved = tool_result(connection, id, &run.run_id, call_id)
                .await?
                .ok_or_else(transition)?;
            if saved.tool_name != *tool_name
                || saved.request_id() != Some(request)
                || saved.finished_sequence.is_some()
                || saved.is_error.is_some_and(|observed| observed != *is_error)
            {
                return Err(transition());
            }
            let started = history::event(connection, id, saved.started_sequence).await?;
            let StoredEventPayload::RuntimeObserved(started) = started.payload() else {
                return Err(integrity());
            };
            if started.turn_id != envelope.turn_id {
                return Err(transition());
            }
            sqlx::query("UPDATE tool_results SET finished_sequence=?, is_error=? WHERE run_id=? AND call_id=?")
                .bind(sequence).bind(*is_error).bind(run.run_id.as_str()).bind(call_id).execute(connection).await.map_err(database::error)?;
        }
        ToolExecutionEvent::ToolResultReused { call_id, tool_name } => {
            let saved = tool_result(connection, id, &run.run_id, call_id)
                .await?
                .ok_or_else(transition)?;
            // Reuse belongs to the current request; the saved row keeps its original request.
            if saved.tool_name != *tool_name
                || saved.request_id.is_none()
                || saved.result_sequence.is_none()
            {
                return Err(transition());
            }
        }
    }
    Ok(())
}
