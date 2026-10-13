// Authoritative response projection is consumed by the next storage increment.
#![cfg_attr(not(test), allow(dead_code))]

use serde_json::Value;

use super::FieldKind;
use crate::{FunctionCall, ItemKind, ModelResponse, OutputItem, OutputProvenance};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PartSource {
    Summary(Option<usize>),
    Content(Option<usize>),
    FunctionName,
    FunctionArguments,
    Fallback(Option<usize>),
    Unsupported,
}

#[derive(Clone)]
pub(crate) struct DisplayPart<'a> {
    pub(crate) kind: FieldKind,
    pub(crate) text: &'a str,
    pub(crate) source: PartSource,
}
impl DisplayPart<'_> {
    fn unsupported(source: PartSource) -> Self {
        Self {
            kind: FieldKind::Unsupported,
            text: "Unsupported content",
            source,
        }
    }
    fn answer(&self) -> bool {
        matches!(self.kind, FieldKind::Text | FieldKind::Refusal)
    }
}

pub(crate) struct ItemProjection<'a> {
    pub(crate) item_id: Option<&'a str>,
    pub(crate) kind: ItemKind,
    pub(crate) function_call: Option<&'a FunctionCall>,
    pub(crate) parts: Vec<DisplayPart<'a>>,
}
impl ItemProjection<'_> {
    pub(crate) fn unsupported_content(&self) -> bool {
        self.parts
            .iter()
            .any(|part| part.kind == FieldKind::Unsupported)
    }
}

pub(crate) fn project_item(item: &OutputItem) -> ItemProjection<'_> {
    let mut projection = ItemProjection {
        item_id: item.id.as_deref(),
        kind: item.kind.clone(),
        function_call: None,
        parts: Vec::new(),
    };
    match item.kind {
        ItemKind::Message => parts(
            &mut projection.parts,
            item.native.get("content"),
            false,
            false,
        ),
        ItemKind::Reasoning => {
            let summary = item.native.get("summary");
            let content = item.native.get("content");
            if summary.is_none() && content.is_none() {
                projection
                    .parts
                    .push(DisplayPart::unsupported(PartSource::Unsupported));
            }
            if summary.is_some() {
                parts(&mut projection.parts, summary, true, true);
            }
            if content.is_some() {
                parts(&mut projection.parts, content, true, false);
            }
        }
        ItemKind::FunctionCall => {
            if let Some(call) = &item.function_call {
                projection.function_call = Some(call);
                projection.parts.push(DisplayPart {
                    kind: FieldKind::FunctionName,
                    text: &call.name,
                    source: PartSource::FunctionName,
                });
                projection.parts.push(DisplayPart {
                    kind: FieldKind::FunctionArguments,
                    text: &call.arguments,
                    source: PartSource::FunctionArguments,
                });
            } else {
                projection
                    .parts
                    .push(DisplayPart::unsupported(PartSource::Unsupported));
            }
        }
        _ => projection
            .parts
            .push(DisplayPart::unsupported(PartSource::Unsupported)),
    }
    projection
}

fn parts<'a>(
    output: &mut Vec<DisplayPart<'a>>,
    value: Option<&'a Value>,
    reasoning: bool,
    summary: bool,
) {
    let source = |index| {
        if summary {
            PartSource::Summary(index)
        } else {
            PartSource::Content(index)
        }
    };
    let Some(parts) = value.and_then(Value::as_array) else {
        output.push(DisplayPart::unsupported(source(None)));
        return;
    };
    for (index, part) in parts.iter().enumerate() {
        // Only these named strings are display content. Objects and extra keys
        // stay private, even when the enclosing provider type is recognized.
        let scalar = match (reasoning, part.get("type").and_then(Value::as_str)) {
            (false, Some("output_text")) => Some((FieldKind::Text, "text")),
            (false, Some("refusal")) => Some((FieldKind::Refusal, "refusal")),
            (true, Some("summary_text")) => Some((FieldKind::ReasoningSummary, "text")),
            (true, Some("reasoning_text")) => Some((FieldKind::ReasoningText, "text")),
            _ => None,
        };
        let display = scalar.and_then(|(kind, field)| {
            part.get(field)
                .and_then(Value::as_str)
                .map(|text| DisplayPart {
                    kind,
                    text,
                    source: source(Some(index)),
                })
        });
        output.push(display.unwrap_or_else(|| DisplayPart::unsupported(source(Some(index)))));
    }
}

pub(crate) struct ResponseField<'a> {
    pub(crate) output_index: usize,
    pub(crate) part: DisplayPart<'a>,
}
pub(crate) struct ResponseProjection<'a> {
    pub(crate) fields: Vec<ResponseField<'a>>,
    pub(crate) output_provenance: OutputProvenance,
}

/// A snapshot replaces provisional fields; it never consults earlier deltas or
/// native terminal output. Effective output may already be provider-recovered.
pub(crate) fn project_response(response: &ModelResponse) -> ResponseProjection<'_> {
    let fields: Vec<_> = response
        .output
        .iter()
        .enumerate()
        .flat_map(|(output_index, item)| {
            project_item(item)
                .parts
                .into_iter()
                .map(move |part| ResponseField { output_index, part })
        })
        .collect();
    let answers: Vec<_> = fields
        .iter()
        .filter(|field| field.part.answer())
        .map(|field| field.part.text)
        .collect();
    let text = response.text.as_str();
    // "Normalized" is the provider's response.text, not whitespace normalization.
    let represented = text.is_empty()
        || answers.iter().any(|answer| answer.contains(text))
        || answers.concat().contains(text)
        || answers.join("\n").contains(text);
    if represented {
        return ResponseProjection {
            fields,
            output_provenance: response.output_provenance,
        };
    }
    let first = fields
        .iter()
        .position(|field| field.part.answer())
        .unwrap_or(fields.len());
    let output_index = fields
        .get(first)
        .map(|field| field.output_index)
        .unwrap_or(response.output.len());
    // Keep the original native content index, not the flattened field ordinal.
    let content_index = fields.get(first).and_then(|field| match field.part.source {
        PartSource::Content(index) => index,
        _ => None,
    });
    let mut fallback = Some(ResponseField {
        output_index,
        part: DisplayPart {
            kind: FieldKind::AuthoritativeText,
            text,
            source: PartSource::Fallback(content_index),
        },
    });
    let mut result = Vec::with_capacity(fields.len() + 1);
    for (index, field) in fields.into_iter().enumerate() {
        if index == first {
            result.push(fallback.take().expect("first answer visited once"));
        }
        // Remove only answers covered by the fallback. Independent refusals,
        // reasoning, function arguments and unsupported markers remain.
        if !(field.part.answer() && !field.part.text.is_empty() && text.contains(field.part.text)) {
            result.push(field);
        }
    }
    if let Some(fallback) = fallback {
        result.push(fallback);
    }
    ResponseProjection {
        fields: result,
        output_provenance: response.output_provenance,
    }
}

#[cfg(test)]
mod tests;
