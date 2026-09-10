//! Sensitive application events, not safe telemetry. No event history is retained.
use super::{RunOutcome, RunSummary};
use crate::{EventEnvelope, UpstreamOutcome, tools::ToolExecutionEvent};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunSinkError {
    Full,
    Closed,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TurnOutcome {
    ModelCompleted,
    ToolsPrepared,
    Stopped { reason: RunOutcome },
}

#[derive(Clone, Serialize, Deserialize)]
pub struct RunEventEnvelope {
    pub schema_version: u32,
    pub sequence: u64,
    pub event_id: String,
    pub run_id: String,
    pub turn_id: Option<String>,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
    #[serde(flatten)]
    pub event: RunEvent,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunEvent {
    RunStarted,
    TurnStarted {
        number: u64,
    },
    ProviderEvent {
        event: Box<EventEnvelope>,
    },
    ToolEvent {
        event: ToolExecutionEvent,
    },
    TurnFinished {
        number: u64,
        response_id: Option<String>,
        outcome: TurnOutcome,
        upstream_outcome: Option<UpstreamOutcome>,
    },
    RunFinished {
        outcome: RunOutcome,
        summary: RunSummary,
    },
}
