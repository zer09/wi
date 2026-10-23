// Private interpretation shared by incremental projection and stored-event backfill.
#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};

use super::{
    FieldKind,
    primitives::{FieldRank, OrderKey, ProjectionError},
    projection::PartSource,
};
use crate::{DeltaKind, ResponseOutcome, run::RunOutcome};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum State {
    Accepted,
    InProgress,
    Completed,
    Incomplete,
    Failed,
    Cancelled,
    Interrupted,
    Unknown,
}
impl State {
    pub(crate) fn response(outcome: &ResponseOutcome) -> Self {
        match outcome {
            ResponseOutcome::Completed => Self::Completed,
            ResponseOutcome::Incomplete { .. } => Self::Incomplete,
            ResponseOutcome::Failed => Self::Failed,
            ResponseOutcome::Cancelled => Self::Cancelled,
        }
    }
    pub(crate) fn status(status: &str) -> Self {
        match status {
            "queued" | "in_progress" => Self::InProgress,
            "completed" => Self::Completed,
            "incomplete" => Self::Incomplete,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Unknown,
        }
    }
    pub(crate) fn unfinished(outcome: &RunOutcome) -> Self {
        match outcome {
            // Run completion is not an authoritative response or missing tool result.
            RunOutcome::Completed => Self::Unknown,
            RunOutcome::Failed { .. } => Self::Failed,
            RunOutcome::CancelledLocally => Self::Cancelled,
        }
    }
}

pub(crate) fn part_order(output: u64, source: PartSource) -> Result<OrderKey, ProjectionError> {
    let index = |value: Option<usize>| {
        value
            .map(u64::try_from)
            .transpose()
            .map_err(|_| ProjectionError)
    };
    let (rank, summary, content) = match source {
        PartSource::Summary(value) => (FieldRank::Summary, index(value)?, None),
        PartSource::Content(value) => (FieldRank::Content, None, index(value)?),
        PartSource::FunctionName => (FieldRank::FunctionName, None, None),
        PartSource::FunctionArguments => (FieldRank::FunctionArguments, None, None),
        PartSource::Fallback(value) => (FieldRank::Fallback, None, index(value)?),
        PartSource::Unsupported => (FieldRank::Unsupported, None, None),
    };
    Ok(OrderKey::new(Some(output), rank, summary, content))
}

pub(crate) fn delta_field(
    output: u64,
    summary: Option<u64>,
    content: Option<u64>,
    kind: DeltaKind,
) -> (OrderKey, FieldKind) {
    let (rank, kind) = match kind {
        DeltaKind::Text => (FieldRank::Content, FieldKind::Text),
        DeltaKind::Refusal => (FieldRank::Content, FieldKind::Refusal),
        DeltaKind::ReasoningSummary => (FieldRank::Summary, FieldKind::ReasoningSummary),
        DeltaKind::ReasoningText => (FieldRank::Content, FieldKind::ReasoningText),
        DeltaKind::FunctionArguments => {
            (FieldRank::FunctionArguments, FieldKind::FunctionArguments)
        }
        DeltaKind::CustomToolInput => (FieldRank::Unsupported, FieldKind::Unsupported),
    };
    (OrderKey::new(Some(output), rank, summary, content), kind)
}
