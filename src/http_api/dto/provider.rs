use serde::Serialize;

use super::super::wire::Decimal;
use crate::{
    CallOrigin, FunctionCall, ItemKind, ModelResponse, OutputItem, OutputProvenance,
    ResponseOutcome, Usage,
    conversation::{FieldKind, projection::project_item},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TextBlockKind {
    Text,
    Refusal,
    ReasoningSummary,
    ReasoningText,
}

#[derive(Clone, Serialize)]
pub struct TextBlockView {
    kind: TextBlockKind,
    text: String,
}

#[derive(Clone, Serialize)]
pub struct FunctionCallView {
    call_id: String,
    name: String,
    arguments: String,
    origin: CallOrigin,
    namespace: Option<String>,
    complete: bool,
}
impl From<&FunctionCall> for FunctionCallView {
    fn from(value: &FunctionCall) -> Self {
        Self {
            call_id: value.call_id.clone(),
            name: value.name.clone(),
            arguments: value.arguments.clone(),
            origin: value.origin,
            namespace: value.namespace.clone(),
            complete: value.complete,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct ItemView {
    item_id: Option<String>,
    kind: ItemKind,
    function_call: Option<FunctionCallView>,
    content: Vec<TextBlockView>,
    unsupported_content: bool,
}
impl From<&OutputItem> for ItemView {
    fn from(value: &OutputItem) -> Self {
        let projection = project_item(value);
        Self {
            item_id: projection.item_id.map(str::to_owned),
            kind: projection.kind.clone(),
            function_call: projection.function_call.map(FunctionCallView::from),
            content: projection
                .parts
                .iter()
                .filter_map(|part| {
                    let kind = match part.kind {
                        FieldKind::Text => TextBlockKind::Text,
                        FieldKind::Refusal => TextBlockKind::Refusal,
                        FieldKind::ReasoningSummary => TextBlockKind::ReasoningSummary,
                        FieldKind::ReasoningText => TextBlockKind::ReasoningText,
                        _ => return None,
                    };
                    Some(TextBlockView {
                        kind,
                        text: part.text.to_owned(),
                    })
                })
                .collect(),
            unsupported_content: projection.unsupported_content(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ResponseOutcomeView {
    Completed,
    Incomplete { reason: Option<IncompleteReason> },
    Failed,
    Cancelled,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IncompleteReason {
    MaxOutputTokens,
    ContentFilter,
    Unknown,
}
impl From<&ResponseOutcome> for ResponseOutcomeView {
    fn from(value: &ResponseOutcome) -> Self {
        match value {
            ResponseOutcome::Completed => Self::Completed,
            ResponseOutcome::Failed => Self::Failed,
            ResponseOutcome::Cancelled => Self::Cancelled,
            ResponseOutcome::Incomplete { reason } => Self::Incomplete {
                reason: reason.as_deref().map(|reason| match reason {
                    "max_output_tokens" => IncompleteReason::MaxOutputTokens,
                    "content_filter" => IncompleteReason::ContentFilter,
                    _ => IncompleteReason::Unknown,
                }),
            },
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseStatus {
    Queued,
    InProgress,
    Completed,
    Incomplete,
    Failed,
    Cancelled,
    Unknown,
}
impl From<&str> for ResponseStatus {
    fn from(value: &str) -> Self {
        match value {
            "queued" => Self::Queued,
            "in_progress" => Self::InProgress,
            "completed" => Self::Completed,
            "incomplete" => Self::Incomplete,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Unknown,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct UsageView {
    input_tokens: Decimal,
    output_tokens: Decimal,
    total_tokens: Decimal,
    cached_input_tokens: Option<Decimal>,
    reasoning_tokens: Option<Decimal>,
}
impl From<&Usage> for UsageView {
    fn from(value: &Usage) -> Self {
        Self {
            input_tokens: value.input_tokens.into(),
            output_tokens: value.output_tokens.into(),
            total_tokens: value.total_tokens.into(),
            cached_input_tokens: value.cached_input_tokens.map(Into::into),
            reasoning_tokens: value.reasoning_tokens.map(Into::into),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct ResponseView {
    response_id: String,
    model: Option<String>,
    outcome: ResponseOutcomeView,
    output_provenance: OutputProvenance,
    text: String,
    items: Vec<ItemView>,
    usage: Option<UsageView>,
}
impl From<&ModelResponse> for ResponseView {
    fn from(value: &ModelResponse) -> Self {
        Self {
            response_id: value.id.clone(),
            model: value.model.clone(),
            outcome: (&value.outcome).into(),
            output_provenance: value.output_provenance,
            text: value.text.clone(),
            items: value.output.iter().map(ItemView::from).collect(),
            usage: value.usage.as_ref().map(UsageView::from),
        }
    }
}
