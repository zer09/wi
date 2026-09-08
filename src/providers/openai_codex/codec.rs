//! Shared Responses decoder for WebSocket JSON messages and SSE data frames.
//! Partial function arguments are strings, never executable parsed calls.
use crate::{
    CallOrigin, DeltaKind, FunctionCall, GatewayError, ItemKind, ModelResponse, OutputItem,
    ProviderEvent, ResponseOutcome, Result, Usage,
};
use serde_json::Value;

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod recovery_tests;

const MAX_ITEMS: usize = 512;

#[derive(Default)]
pub(super) struct ResponseDecoder {
    response_id: Option<String>,
    pub finished: bool,
    pub terminal_received: bool,
    finalized: super::finalized::FinalizedItems,
}

impl ResponseDecoder {
    pub fn apply(&mut self, value: Value) -> Result<Vec<ProviderEvent>> {
        if self.finished {
            return Err(GatewayError::Protocol("event after terminal response"));
        }
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .ok_or(GatewayError::Protocol("missing event type"))?;
        self.finalized.observe(&value);
        let mut events = Vec::new();
        match kind {
            "response.created" => {
                let response = value
                    .get("response")
                    .ok_or(GatewayError::Protocol("response missing"))?;
                let id = required_str(response, "id")?;
                if self.response_id.is_some() {
                    return Err(GatewayError::Protocol("duplicate response.created"));
                }
                self.response_id = Some(id.to_owned());
                events.push(ProviderEvent::ResponseStarted {
                    response_id: id.to_owned(),
                });
            }
            "response.in_progress" | "response.queued" => {
                let id = self.response_id(&value)?;
                events.push(ProviderEvent::ResponseStatus {
                    response_id: id,
                    status: kind.trim_start_matches("response.").into(),
                });
            }
            "response.output_item.added" | "response.output_item.done" => {
                let response_id = self.response_id(&value)?;
                let output_index = required_u64(&value, "output_index")?;
                let item = parse_item(
                    value
                        .get("item")
                        .cloned()
                        .ok_or(GatewayError::Protocol("missing output item"))?,
                )?;
                events.push(if kind.ends_with(".added") {
                    ProviderEvent::OutputItemStarted {
                        response_id,
                        output_index,
                        item,
                    }
                } else {
                    ProviderEvent::OutputItemFinished {
                        response_id,
                        output_index,
                        item,
                    }
                });
            }
            "response.output_text.delta"
            | "response.refusal.delta"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_text.delta"
            | "response.function_call_arguments.delta"
            | "response.custom_tool_call_input.delta" => {
                let delta_kind = match kind {
                    "response.output_text.delta" => DeltaKind::Text,
                    "response.refusal.delta" => DeltaKind::Refusal,
                    "response.reasoning_summary_text.delta" => DeltaKind::ReasoningSummary,
                    "response.reasoning_text.delta" => DeltaKind::ReasoningText,
                    "response.function_call_arguments.delta" => DeltaKind::FunctionArguments,
                    _ => DeltaKind::CustomToolInput,
                };
                events.push(ProviderEvent::OutputItemUpdated {
                    response_id: self.response_id(&value)?,
                    item_id: required_str(&value, "item_id")?.into(),
                    output_index: required_u64(&value, "output_index")?,
                    content_index: value.get("content_index").and_then(Value::as_u64),
                    summary_index: value.get("summary_index").and_then(Value::as_u64),
                    kind: delta_kind,
                    delta: required_str(&value, "delta")?.into(),
                });
            }
            "response.completed"
            | "response.done"
            | "response.incomplete"
            | "response.failed"
            | "response.cancelled" => {
                let native = value
                    .get("response")
                    .cloned()
                    .ok_or(GatewayError::Protocol("terminal response missing"))?;
                let mut response = parse_response(native)?;
                if !matches!(kind, "response.completed" | "response.done")
                    && response.outcome == ResponseOutcome::Completed
                {
                    return Err(GatewayError::Protocol(
                        "non-success terminal event claims completed status",
                    ));
                }
                if let Some(id) = &self.response_id {
                    if id != &response.id {
                        return Err(GatewayError::Protocol("response ID changed"));
                    }
                } else {
                    // Some error/terminal-only streams omit created. This reports
                    // observed response identity, not a fabricated earlier delta.
                    events.push(ProviderEvent::ResponseStarted {
                        response_id: response.id.clone(),
                    });
                    self.response_id = Some(response.id.clone());
                }
                // Upstream completed even when local recovery cannot be trusted.
                self.terminal_received = true;
                if matches!(kind, "response.completed" | "response.done")
                    && response.outcome == ResponseOutcome::Completed
                    && response
                        .native
                        .get("output")
                        .and_then(Value::as_array)
                        .is_some_and(Vec::is_empty)
                {
                    let recovered = self.finalized.recover(&response.id)?;
                    if !recovered.is_empty() {
                        let mut effective = response.native.clone();
                        effective["output"] = Value::Array(recovered);
                        let parsed = parse_response(effective)?;
                        response.output = parsed.output;
                        response.text = parsed.text;
                        response.output_provenance =
                            crate::OutputProvenance::ValidatedOutputItemDone;
                    }
                }
                self.finished = true;
                events.push(ProviderEvent::ResponseFinished { response });
            }
            "error" => return Err(GatewayError::ProviderFailed),
            // Part boundaries, annotations, final text/arguments, hosted-tool
            // progress, and future protocol extensions are retained verbatim.
            // Final output_item / response objects remain authoritative.
            _ => events.push(ProviderEvent::ProviderExtension {
                event_type: kind.into(),
                payload: value.clone(),
            }),
        }
        Ok(events)
    }

    fn response_id(&self, event: &Value) -> Result<String> {
        let id = self
            .response_id
            .as_ref()
            .ok_or(GatewayError::Protocol("content before response identity"))?;
        let reported = event
            .get("response_id")
            .and_then(Value::as_str)
            .or_else(|| event.pointer("/response/id").and_then(Value::as_str));
        if reported.is_some_and(|other| other != id) {
            return Err(GatewayError::Protocol("cross-response event"));
        }
        Ok(id.clone())
    }
}

pub(super) fn parse_item(native: Value) -> Result<OutputItem> {
    let native_type = required_str(&native, "type")?.to_owned();
    let kind = match native_type.as_str() {
        "message" => ItemKind::Message,
        "reasoning" => ItemKind::Reasoning,
        "function_call" => ItemKind::FunctionCall,
        "custom_tool_call" => ItemKind::CustomToolCall,
        "tool_search_call" => ItemKind::ToolSearchCall,
        "tool_search_output" => ItemKind::ToolSearchOutput,
        "program" => ItemKind::Program,
        "program_output" => ItemKind::ProgramOutput,
        _ => ItemKind::Unknown,
    };
    let function_call = if kind == ItemKind::FunctionCall {
        let origin = match native.get("caller") {
            None | Some(Value::Null) => CallOrigin::Direct,
            Some(c) if c.get("type").and_then(Value::as_str) == Some("direct") => {
                CallOrigin::Direct
            }
            Some(c) if c.get("type").and_then(Value::as_str) == Some("program") => {
                CallOrigin::Programmatic
            }
            Some(_) => CallOrigin::Unknown,
        };
        Some(FunctionCall {
            call_id: required_str(&native, "call_id")?.into(),
            name: required_str(&native, "name")?.into(),
            arguments: native
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            origin,
            namespace: native
                .get("namespace")
                .and_then(Value::as_str)
                .map(String::from),
            // Omission is compatible; malformed present values cannot authorize execution.
            complete: match native.get("status") {
                None => true,
                Some(Value::String(status)) => status == "completed",
                Some(_) => false,
            },
        })
    } else {
        None
    };
    Ok(OutputItem {
        function_call,
        id: native.get("id").and_then(Value::as_str).map(String::from),
        kind,
        native_type,
        native,
    })
}

pub(super) fn parse_response(native: Value) -> Result<ModelResponse> {
    let id = required_str(&native, "id")?.to_owned();
    let outcome = match required_str(&native, "status")? {
        "completed" => ResponseOutcome::Completed,
        "incomplete" => ResponseOutcome::Incomplete {
            reason: native
                .pointer("/incomplete_details/reason")
                .and_then(Value::as_str)
                .map(String::from),
        },
        "failed" => ResponseOutcome::Failed,
        "cancelled" => ResponseOutcome::Cancelled,
        _ => {
            return Err(GatewayError::Protocol(
                "non-terminal or unknown terminal status",
            ));
        }
    };
    let output = match native.get("output") {
        Some(Value::Array(items)) if items.len() <= MAX_ITEMS => items
            .iter()
            .cloned()
            .map(parse_item)
            .collect::<Result<Vec<_>>>()?,
        Some(Value::Array(_)) => return Err(GatewayError::StreamTooLarge),
        None | Some(Value::Null)
            if matches!(
                outcome,
                ResponseOutcome::Failed | ResponseOutcome::Cancelled
            ) =>
        {
            vec![]
        }
        _ => return Err(GatewayError::Protocol("invalid response output")),
    };
    let mut text = String::new();
    for item in &output {
        if item.kind == ItemKind::Message
            && let Some(parts) = item.native.get("content").and_then(Value::as_array)
        {
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("output_text") => text.push_str(required_str(part, "text")?),
                    Some("refusal") => text.push_str(required_str(part, "refusal")?),
                    _ => {}
                }
            }
        }
    }
    let usage = native
        .get("usage")
        .filter(|v| !v.is_null())
        .map(|u| -> Result<Usage> {
            Ok(Usage {
                input_tokens: required_u64(u, "input_tokens")?,
                output_tokens: required_u64(u, "output_tokens")?,
                total_tokens: required_u64(u, "total_tokens")?,
                cached_input_tokens: u
                    .pointer("/input_tokens_details/cached_tokens")
                    .and_then(Value::as_u64),
                reasoning_tokens: u
                    .pointer("/output_tokens_details/reasoning_tokens")
                    .and_then(Value::as_u64),
            })
        })
        .transpose()?;
    Ok(ModelResponse {
        output_provenance: crate::OutputProvenance::NativeTerminal,
        id,
        model: native
            .get("model")
            .and_then(Value::as_str)
            .map(String::from),
        outcome,
        output,
        text,
        usage,
        native,
    })
}

fn required_str<'a>(v: &'a Value, field: &str) -> Result<&'a str> {
    v.get(field)
        .and_then(Value::as_str)
        .ok_or(GatewayError::Protocol("required string missing"))
}
fn required_u64(v: &Value, field: &str) -> Result<u64> {
    v.get(field)
        .and_then(Value::as_u64)
        .ok_or(GatewayError::Protocol("required integer missing"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn created(d: &mut ResponseDecoder) {
        d.apply(json!({"type":"response.created","response":{"id":"r1"}}))
            .unwrap();
    }
    #[test]
    fn function_argument_fragments_stay_unparsed() {
        let mut d = ResponseDecoder::default();
        created(&mut d);
        let e = d.apply(json!({"type":"response.function_call_arguments.delta","item_id":"i1","output_index":0,"delta":"{\"a\":"})).unwrap();
        assert!(
            matches!(&e[0], ProviderEvent::OutputItemUpdated { kind: DeltaKind::FunctionArguments, delta, .. } if delta == "{\"a\":")
        );
    }
    #[test]
    fn incomplete_is_not_success() {
        let r = parse_response(json!({"id":"r1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]})).unwrap();
        assert_eq!(
            r.outcome,
            ResponseOutcome::Incomplete {
                reason: Some("max_output_tokens".into())
            }
        );
    }
    #[test]
    fn preserves_unknown_program_fingerprints_and_caller() {
        for kind in [
            "program",
            "program_output",
            "future_output",
            "tool_search_call",
        ] {
            let native = json!({"type":kind,"id":"i1","fingerprint":"opaque","caller":{"id":"p1"}});
            assert_eq!(parse_item(native.clone()).unwrap().native, native);
        }
    }
    #[test]
    fn refuses_cross_response_output() {
        let mut d = ResponseDecoder::default();
        created(&mut d);
        assert!(d.apply(json!({"type":"response.output_text.delta","response_id":"r2","item_id":"i1","output_index":0,"delta":"bad"})).is_err());
    }
    #[test]
    fn done_alias_preserves_actual_status() {
        let mut d = ResponseDecoder::default();
        let e = d.apply(json!({"type":"response.done","response":{"id":"r1","status":"incomplete","output":[]}})).unwrap();
        assert!(
            matches!(&e[1], ProviderEvent::ResponseFinished { response } if matches!(response.outcome, ResponseOutcome::Incomplete { .. }))
        );
    }
    #[test]
    fn incomplete_event_cannot_be_upgraded_to_success() {
        let mut d = ResponseDecoder::default();
        assert!(d.apply(json!({"type":"response.incomplete","response":{"id":"r1","status":"completed","output":[]}})).is_err());
    }
    #[test]
    fn provider_errors_do_not_echo_raw_body() {
        let mut d = ResponseDecoder::default();
        let error = d
            .apply(json!({"type":"error","message":"private-token-or-prompt"}))
            .err()
            .unwrap();
        assert!(!error.to_string().contains("private-token-or-prompt"));
    }
    #[test]
    fn unknown_event_is_not_lost() {
        let mut d = ResponseDecoder::default();
        let value = json!({"type":"response.future_event","extra":123});
        let e = d.apply(value.clone()).unwrap();
        assert!(
            matches!(&e[0], ProviderEvent::ProviderExtension { payload, .. } if payload == &value)
        );
    }
    #[test]
    fn refusal_is_content_not_a_transport_failure() {
        let r = parse_response(json!({"id":"r1","status":"completed","output":[{"type":"message","content":[{"type":"refusal","refusal":"Cannot comply"}]}]})).unwrap();
        assert_eq!(r.text, "Cannot comply");
        assert_eq!(r.outcome, ResponseOutcome::Completed);
    }
    #[test]
    fn usage_breakdowns_are_not_added_twice() {
        let r = parse_response(json!({"id":"r1","status":"completed","output":[],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":{"cached_tokens":50},"output_tokens_details":{"reasoning_tokens":10}}})).unwrap();
        let u = r.usage.unwrap();
        assert_eq!(u.total_tokens, 120);
        assert_eq!(u.reasoning_tokens, Some(10));
    }
    #[test]
    fn terminal_response_is_authoritative() {
        let mut d = ResponseDecoder::default();
        created(&mut d);
        let e = d.apply(json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"message","id":"m1","content":[{"type":"output_text","text":"entire answer"}]}]}})).unwrap();
        assert!(
            matches!(&e[0], ProviderEvent::ResponseFinished { response } if response.text == "entire answer")
        );
        assert!(
            d.apply(json!({"type":"response.created","response":{"id":"r2"}}))
                .is_err()
        );
    }
}

#[cfg(test)]
mod fixture_tests {
    use super::super::sse::SseDecoder;
    use super::*;
    #[test]
    fn native_json_and_sse_frames_share_event_contract() {
        let fixtures = [
            include_str!("../../../tests/fixtures/text_response.jsonl"),
            include_str!("../../../tests/fixtures/tool_request.jsonl"),
            include_str!("../../../tests/fixtures/tool_response.jsonl"),
            include_str!("../../../tests/fixtures/advanced_output.jsonl"),
        ];
        for fixture in fixtures {
            let mut native = ResponseDecoder::default();
            let mut sse_codec = ResponseDecoder::default();
            let mut framer = SseDecoder::default();
            let mut expected = vec![];
            let mut actual = vec![];
            for line in fixture.lines() {
                expected.extend(native.apply(serde_json::from_str(line).unwrap()).unwrap());
                let framed = format!("data: {line}\r\n\r\n");
                for byte in framed.bytes() {
                    for data in framer.feed(&[byte]).unwrap() {
                        actual.extend(
                            sse_codec
                                .apply(serde_json::from_str(&data).unwrap())
                                .unwrap(),
                        );
                    }
                }
            }
            assert!(native.finished && sse_codec.finished);
            assert_eq!(
                serde_json::to_value(expected).unwrap(),
                serde_json::to_value(actual).unwrap()
            );
        }
    }
}
