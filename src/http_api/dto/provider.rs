use serde::Serialize;
use serde_json::Value;

use super::super::wire::Decimal;
use crate::{
    CallOrigin, FunctionCall, ItemKind, ModelResponse, OutputItem, OutputProvenance,
    ResponseOutcome, Usage,
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
        let mut view = Self {
            item_id: value.id.clone(),
            kind: value.kind.clone(),
            function_call: None,
            content: Vec::new(),
            unsupported_content: false,
        };
        match value.kind {
            ItemKind::Message => view.parts(value.native.get("content"), false),
            ItemKind::Reasoning => {
                let summary = value.native.get("summary");
                let content = value.native.get("content");
                if summary.is_none() && content.is_none() {
                    view.unsupported_content = true;
                }
                if summary.is_some() {
                    view.parts(summary, true);
                }
                if content.is_some() {
                    view.parts(content, true);
                }
            }
            ItemKind::FunctionCall => {
                view.function_call = value.function_call.as_ref().map(FunctionCallView::from);
                view.unsupported_content = view.function_call.is_none();
            }
            _ => view.unsupported_content = true,
        }
        view
    }
}
impl ItemView {
    fn parts(&mut self, value: Option<&Value>, reasoning: bool) {
        let Some(parts) = value.and_then(Value::as_array) else {
            self.unsupported_content = true;
            return;
        };
        for part in parts {
            // Read only named scalar fields. Native objects never cross this boundary.
            let (kind, field) = match (reasoning, part.get("type").and_then(Value::as_str)) {
                (false, Some("output_text")) => (TextBlockKind::Text, "text"),
                (false, Some("refusal")) => (TextBlockKind::Refusal, "refusal"),
                (true, Some("summary_text")) => (TextBlockKind::ReasoningSummary, "text"),
                (true, Some("reasoning_text")) => (TextBlockKind::ReasoningText, "text"),
                _ => {
                    self.unsupported_content = true;
                    continue;
                }
            };
            match part.get(field).and_then(Value::as_str) {
                Some(text) => self.content.push(TextBlockView {
                    kind,
                    text: text.to_owned(),
                }),
                None => self.unsupported_content = true,
            }
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
