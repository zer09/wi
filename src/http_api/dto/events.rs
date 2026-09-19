use serde::Serialize;

use super::super::wire::Decimal;
use super::{
    ApiVersion, ItemView, OutcomeView, ResponseStatus, ResponseView, ResultView, SafeCode,
    SummaryView, TurnOutcomeView, safe_code,
};
use crate::{
    DeltaKind, ProviderEvent, UpstreamOutcome,
    run::{RunEvent, RunEventEnvelope},
    storage::{
        ApplicationSessionId, InterruptionReason, RunId, StoredEvent, StoredEventId,
        StoredEventPayload,
    },
    tools::ToolExecutionEvent,
};

#[derive(Clone, Serialize)]
pub struct EventView {
    api_version: ApiVersion,
    session_id: ApplicationSessionId,
    sequence: Decimal,
    event_id: StoredEventId,
    created_at_ms: Decimal,
    run_id: Option<RunId>,
    #[serde(flatten)]
    data: EventData,
}
impl EventView {
    pub fn session_id(&self) -> &ApplicationSessionId {
        &self.session_id
    }
    pub fn sequence(&self) -> u64 {
        self.sequence.get()
    }
    pub fn data(&self) -> &EventData {
        &self.data
    }
}
impl From<&StoredEvent> for EventView {
    fn from(value: &StoredEvent) -> Self {
        let data = match value.payload() {
            StoredEventPayload::SessionCreated(created) => EventData::SessionCreated {
                title: created.title().to_owned(),
                workspace: created.workspace().map(str::to_owned),
            },
            StoredEventPayload::SessionRenamed { title } => EventData::SessionRenamed {
                title: title.clone(),
            },
            StoredEventPayload::RunAccepted(accepted) => {
                let input = accepted.input();
                EventData::RunAccepted {
                    user_text: input.user_text().to_owned(),
                    provider_id: input.prepared_request().provider_id.clone(),
                    model: input.prepared_request().options.model.clone(),
                    available_skills: input.available_skills().to_vec(),
                    active_skills: input.active_skills().to_vec(),
                }
            }
            StoredEventPayload::RunHistorySelected(_) | StoredEventPayload::RunProviderBound(_) => {
                EventData::Checkpoint {}
            }
            StoredEventPayload::RuntimeObserved(event) => event.into(),
            StoredEventPayload::ToolResultRecorded(result) => EventData::ToolResult {
                call_id: result.call_id().to_owned(),
                request_id: result.request_id().map(str::to_owned),
                output: result.output().to_owned(),
                is_error: result.is_error(),
            },
            StoredEventPayload::RunResultRecorded(result) => EventData::RunResult(result.into()),
            StoredEventPayload::RunInterrupted(interrupted) => EventData::RunInterrupted {
                reason: interrupted.reason(),
            },
        };
        Self {
            api_version: ApiVersion,
            session_id: value.application_session_id().clone(),
            sequence: value.sequence().into(),
            event_id: value.event_id().clone(),
            created_at_ms: (value.created_at_ms() as u64).into(),
            run_id: value.run_id().cloned(),
            data,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", content = "data")]
pub enum EventData {
    #[serde(rename = "checkpoint")]
    Checkpoint {},
    #[serde(rename = "session.created")]
    SessionCreated {
        title: String,
        workspace: Option<String>,
    },
    #[serde(rename = "session.renamed")]
    SessionRenamed { title: String },
    #[serde(rename = "run.accepted")]
    RunAccepted {
        user_text: String,
        provider_id: String,
        model: String,
        available_skills: Vec<String>,
        active_skills: Vec<String>,
    },
    #[serde(rename = "run.started")]
    RunStarted {},
    #[serde(rename = "turn.started")]
    TurnStarted {
        turn_id: Option<String>,
        number: Decimal,
    },
    #[serde(rename = "turn.finished")]
    TurnFinished {
        turn_id: Option<String>,
        number: Decimal,
        response_id: Option<String>,
        outcome: TurnOutcomeView,
        upstream_outcome: Option<UpstreamOutcome>,
    },
    #[serde(rename = "run.finished")]
    RunFinished {
        outcome: OutcomeView,
        summary: SummaryView,
    },
    #[serde(rename = "tool.started")]
    ToolStarted {
        call_id: String,
        tool_name: String,
        request_id: Option<String>,
    },
    #[serde(rename = "tool.finished")]
    ToolFinished {
        call_id: String,
        tool_name: String,
        request_id: Option<String>,
        is_error: bool,
    },
    #[serde(rename = "tool.reused")]
    ToolReused {
        call_id: String,
        tool_name: String,
        request_id: Option<String>,
    },
    #[serde(rename = "response.started")]
    ResponseStarted { response_id: String },
    #[serde(rename = "response.status")]
    ResponseStatus {
        response_id: String,
        status: ResponseStatus,
    },
    #[serde(rename = "response.item.started")]
    ItemStarted {
        response_id: String,
        output_index: Decimal,
        item: ItemView,
    },
    #[serde(rename = "response.item.finished")]
    ItemFinished {
        response_id: String,
        output_index: Decimal,
        item: ItemView,
    },
    #[serde(rename = "response.delta")]
    Delta {
        response_id: String,
        item_id: String,
        output_index: Decimal,
        content_index: Option<Decimal>,
        summary_index: Option<Decimal>,
        kind: DeltaKind,
        delta: String,
    },
    #[serde(rename = "response.finished")]
    ResponseFinished(ResponseView),
    #[serde(rename = "response.failed")]
    ResponseFailed {
        code: SafeCode,
        upstream_outcome: UpstreamOutcome,
    },
    #[serde(rename = "response.closed")]
    ResponseClosed {},
    #[serde(rename = "tool.result")]
    ToolResult {
        call_id: String,
        request_id: Option<String>,
        output: String,
        is_error: bool,
    },
    #[serde(rename = "run.result")]
    RunResult(ResultView),
    #[serde(rename = "run.interrupted")]
    RunInterrupted { reason: InterruptionReason },
}

impl From<&RunEventEnvelope> for EventData {
    fn from(value: &RunEventEnvelope) -> Self {
        match &value.event {
            RunEvent::RunStarted => Self::RunStarted {},
            RunEvent::TurnStarted { number } => Self::TurnStarted {
                turn_id: value.turn_id.clone(),
                number: (*number).into(),
            },
            RunEvent::TurnFinished {
                number,
                response_id,
                outcome,
                upstream_outcome,
            } => Self::TurnFinished {
                turn_id: value.turn_id.clone(),
                number: (*number).into(),
                response_id: response_id.clone(),
                outcome: outcome.into(),
                upstream_outcome: *upstream_outcome,
            },
            RunEvent::RunFinished { outcome, summary } => Self::RunFinished {
                outcome: outcome.into(),
                summary: summary.into(),
            },
            RunEvent::ToolEvent { event } => match event {
                ToolExecutionEvent::ToolExecutionStarted { call_id, tool_name } => {
                    Self::ToolStarted {
                        call_id: call_id.clone(),
                        tool_name: tool_name.clone(),
                        request_id: value.request_id.clone(),
                    }
                }
                ToolExecutionEvent::ToolExecutionFinished {
                    call_id,
                    tool_name,
                    is_error,
                } => Self::ToolFinished {
                    call_id: call_id.clone(),
                    tool_name: tool_name.clone(),
                    request_id: value.request_id.clone(),
                    is_error: *is_error,
                },
                ToolExecutionEvent::ToolResultReused { call_id, tool_name } => Self::ToolReused {
                    call_id: call_id.clone(),
                    tool_name: tool_name.clone(),
                    request_id: value.request_id.clone(),
                },
            },
            RunEvent::ProviderEvent { event } => match &event.event {
                ProviderEvent::SessionClosed { .. } => Self::ResponseClosed {},
                ProviderEvent::ResponseStarted { response_id } => Self::ResponseStarted {
                    response_id: response_id.clone(),
                },
                ProviderEvent::ResponseStatus {
                    response_id,
                    status,
                } => Self::ResponseStatus {
                    response_id: response_id.clone(),
                    status: status.as_str().into(),
                },
                ProviderEvent::OutputItemStarted {
                    response_id,
                    output_index,
                    item,
                } => Self::ItemStarted {
                    response_id: response_id.clone(),
                    output_index: (*output_index).into(),
                    item: item.into(),
                },
                ProviderEvent::OutputItemFinished {
                    response_id,
                    output_index,
                    item,
                } => Self::ItemFinished {
                    response_id: response_id.clone(),
                    output_index: (*output_index).into(),
                    item: item.into(),
                },
                ProviderEvent::OutputItemUpdated {
                    response_id,
                    item_id,
                    output_index,
                    content_index,
                    summary_index,
                    kind,
                    delta,
                } => Self::Delta {
                    response_id: response_id.clone(),
                    item_id: item_id.clone(),
                    output_index: (*output_index).into(),
                    content_index: content_index.map(Into::into),
                    summary_index: summary_index.map(Into::into),
                    kind: *kind,
                    delta: delta.clone(),
                },
                ProviderEvent::ResponseFinished { response } => {
                    Self::ResponseFinished(response.into())
                }
                ProviderEvent::RequestFailed {
                    code,
                    upstream_outcome,
                    ..
                } => Self::ResponseFailed {
                    code: safe_code(code),
                    upstream_outcome: *upstream_outcome,
                },
                ProviderEvent::ProviderExtension { .. } => Self::Checkpoint {},
            },
        }
    }
}
