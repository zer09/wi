//! Connection-local transcript and ordinary function-result bookkeeping.
//! SSE replays complete native output; WebSocket sends a parent ID plus delta.
//! Neither path automatically retries a request whose outcome is uncertain.
use crate::{
    GatewayError, InputItem, ItemKind, MAX_HISTORY_BYTES, ModelResponse, ResponseOutcome, Result,
    SessionOptions, Transport, validate_input,
};
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Default)]
pub(super) struct Conversation {
    history: Vec<Value>,
    last_response: Option<String>,
    pending_calls: HashSet<String>,
    advanced_output: bool,
    settled_ids: HashSet<String>,
}
impl Conversation {
    pub fn prepare(
        &self,
        options: &SessionOptions,
        input: &[InputItem],
    ) -> Result<(Value, Vec<Value>)> {
        validate_input(input)?;
        if self.advanced_output {
            return Err(GatewayError::UnsupportedOutput);
        }
        let mut supplied = HashSet::new();
        for item in input {
            if let InputItem::ToolResult { call_id, .. } = item
                && (!self.pending_calls.contains(call_id) || !supplied.insert(call_id.clone()))
            {
                return Err(GatewayError::InvalidRequest(
                    "unknown or duplicate tool result",
                ));
            }
        }
        if supplied != self.pending_calls {
            return Err(GatewayError::InvalidRequest(
                "supply exactly the outstanding tool results before continuing",
            ));
        }
        let delta: Vec<Value> = input
            .iter()
            .map(|i| match i {
                InputItem::User { text } => {
                    json!({"role":"user","content":[{"type":"input_text","text":text}]})
                }
                InputItem::ToolResult { call_id, output } => {
                    json!({"type":"function_call_output","call_id":call_id,"output":output})
                }
            })
            .collect();
        let mut full_input = self.history.clone();
        full_input.extend(delta.clone());
        check_history(&full_input)?;
        let tools: Vec<Value> = options
            .tools
            .iter()
            .map(|t| {
                json!({
                    "type":"function", "name":t.name, "description":t.description,
                    "parameters":t.parameters, "strict":t.strict,
                })
            })
            .collect();
        let mut body = json!({
            "model": options.model,
            "instructions": options.instructions,
            "store": false,
            "tools": tools,
            "tool_choice": if options.tools.is_empty() { "none" } else { "auto" },
            "parallel_tool_calls": true,
            "include": ["reasoning.encrypted_content"],
            "input": full_input,
        });
        match options.transport {
            Transport::WebSocket => {
                body["type"] = json!("response.create");
                // No stream/background fields on WebSocket create.
                if let Some(id) = &self.last_response {
                    body["previous_response_id"] = json!(id);
                    body["input"] = json!(delta);
                }
            }
            Transport::Sse => {
                body["stream"] = json!(true);
            }
        }
        Ok((body, full_input))
    }

    pub fn settle(&mut self, full_input: Vec<Value>, response: &ModelResponse) -> Result<()> {
        if response.outcome != ResponseOutcome::Completed {
            return Ok(());
        }
        if self.settled_ids.contains(&response.id) {
            return Err(GatewayError::Protocol("response ID reused"));
        }
        let mut pending = HashSet::new();
        let mut advanced = false;
        for item in &response.output {
            match item.kind {
                ItemKind::Message | ItemKind::Reasoning => {}
                ItemKind::FunctionCall => {
                    // A completed response can still contain an unfinished call.
                    if !item
                        .function_call
                        .as_ref()
                        .is_some_and(|call| call.complete)
                    {
                        advanced = true;
                        continue;
                    }
                    let id = item
                        .native
                        .get("call_id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .ok_or(GatewayError::Protocol("function call has no call_id"))?;
                    if !pending.insert(id.to_owned()) {
                        return Err(GatewayError::Protocol("duplicate call_id"));
                    }
                    if item.native.get("caller").is_some_and(|c| {
                        !c.is_null() && c.get("type").and_then(Value::as_str) != Some("direct")
                    }) {
                        advanced = true;
                    }
                    if item.native.get("namespace").is_some_and(|v| !v.is_null()) {
                        advanced = true;
                    }
                }
                _ => {
                    advanced = true;
                }
            }
        }
        let mut history = full_input;
        history.extend(response.output.iter().map(|i| i.native.clone()));
        check_history(&history)?;
        self.history = history;
        self.last_response = Some(response.id.clone());
        self.pending_calls = pending;
        self.advanced_output = advanced;
        self.settled_ids.insert(response.id.clone());
        Ok(())
    }
}
fn check_history(history: &[Value]) -> Result<()> {
    if history.len() > 2048
        || serde_json::to_vec(history)
            .map_err(|_| GatewayError::Serialization)?
            .len()
            > MAX_HISTORY_BYTES
    {
        return Err(GatewayError::InvalidRequest(
            "session context limit reached; this milestone has no automatic compaction",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::codec::parse_response;
    use super::*;
    fn first(options: &SessionOptions) -> Conversation {
        let mut state = Conversation::default();
        let (_, input) = state.prepare(options, &[InputItem::user("hello")]).unwrap();
        let r = parse_response(json!({"id":"r1","status":"completed","output":[{"type":"reasoning","id":"reason","encrypted_content":"opaque"},{"type":"message","id":"msg","content":[{"type":"output_text","text":"hello"}]}]})).unwrap();
        state.settle(input, &r).unwrap();
        state
    }
    #[test]
    fn websocket_uses_delta_and_parent_on_second_request() {
        let o = SessionOptions::new("test");
        let s = first(&o);
        let (b, full) = s.prepare(&o, &[InputItem::user("next")]).unwrap();
        assert_eq!(b["previous_response_id"], "r1");
        assert_eq!(b["input"].as_array().unwrap().len(), 1);
        assert!(b.get("stream").is_none());
        assert!(b.get("background").is_none());
        assert_eq!(full.len(), 4);
    }
    #[test]
    fn sse_replays_opaque_reasoning_without_parent_id() {
        let mut o = SessionOptions::new("test");
        o.transport = Transport::Sse;
        let s = first(&o);
        let (b, _) = s.prepare(&o, &[InputItem::user("next")]).unwrap();
        assert!(b.get("previous_response_id").is_none());
        assert_eq!(b["stream"], true);
        assert_eq!(b["input"][1]["encrypted_content"], "opaque");
        assert_eq!(b["store"], false);
    }
    #[test]
    fn results_must_match_call_id_not_item_id() {
        let o = SessionOptions::new("test");
        let mut s = Conversation::default();
        let (_, input) = s.prepare(&o, &[InputItem::user("add")]).unwrap();
        let r = parse_response(json!({"id":"r1","status":"completed","output":[{"type":"function_call","id":"item1","call_id":"call1","name":"add","arguments":"{}"}]})).unwrap();
        s.settle(input, &r).unwrap();
        assert!(s.prepare(&o, &[InputItem::user("skip it")]).is_err());
        assert!(
            s.prepare(
                &o,
                &[InputItem::ToolResult {
                    call_id: "item1".into(),
                    output: "3".into()
                }]
            )
            .is_err()
        );
        assert!(
            s.prepare(
                &o,
                &[InputItem::ToolResult {
                    call_id: "call1".into(),
                    output: "3".into()
                }]
            )
            .is_ok()
        );
    }
    #[test]
    fn incomplete_calls_settle_but_block_all_continuation() {
        for transport in [Transport::WebSocket, Transport::Sse] {
            for mixed in [false, true] {
                let mut o = SessionOptions::new("test");
                o.transport = transport;
                let mut s = Conversation::default();
                let (_, input) = s.prepare(&o, &[InputItem::user("add")]).unwrap();
                let mut output = vec![];
                if mixed {
                    output.push(json!({"type":"function_call", "call_id":"complete",
                        "name":"add_numbers", "arguments":"{}", "status":"completed"}));
                }
                output.push(json!({"type":"function_call", "call_id":"incomplete",
                    "name":"add_numbers", "arguments":"{}", "status":"in_progress"}));
                let r = parse_response(json!({"id":"r1", "status":"completed", "output":output}))
                    .unwrap();
                s.settle(input, &r).unwrap();
                assert_eq!(s.last_response.as_deref(), Some("r1"));
                assert_eq!(s.history.last(), Some(&r.output.last().unwrap().native));
                assert!(s.advanced_output);
                assert!(!s.pending_calls.contains("incomplete"));
                let mut results = vec![InputItem::ToolResult {
                    call_id: "incomplete".into(),
                    output: "42".into(),
                }];
                if mixed {
                    results.push(InputItem::ToolResult {
                        call_id: "complete".into(),
                        output: "42".into(),
                    });
                }
                for input in [results, vec![InputItem::user("continue")]] {
                    assert!(matches!(
                        s.prepare(&o, &input),
                        Err(GatewayError::UnsupportedOutput)
                    ));
                }
            }
        }
    }

    #[test]
    fn omitted_and_completed_call_status_allow_matching_results() {
        for transport in [Transport::WebSocket, Transport::Sse] {
            for status in [None, Some("completed")] {
                let mut o = SessionOptions::new("test");
                o.transport = transport;
                let mut s = Conversation::default();
                let (_, input) = s.prepare(&o, &[InputItem::user("add")]).unwrap();
                let mut call = json!({"type":"function_call", "call_id":"call1",
                    "name":"add_numbers", "arguments":"{}"});
                if let Some(status) = status {
                    call["status"] = json!(status);
                }
                let r = parse_response(json!({"id":"r1", "status":"completed", "output":[call]}))
                    .unwrap();
                s.settle(input, &r).unwrap();
                assert!(!s.advanced_output);
                assert!(s.pending_calls.contains("call1"));
                assert!(
                    s.prepare(
                        &o,
                        &[InputItem::ToolResult {
                            call_id: "call1".into(),
                            output: "42".into()
                        }]
                    )
                    .is_ok()
                );
            }
        }
    }

    #[test]
    fn cannot_inject_unrequested_tool_results() {
        assert!(
            Conversation::default()
                .prepare(
                    &SessionOptions::new("test"),
                    &[InputItem::ToolResult {
                        call_id: "x".into(),
                        output: "y".into()
                    }]
                )
                .is_err()
        );
    }
    #[test]
    fn unknown_executable_output_is_retained_but_not_driven() {
        let o = SessionOptions::new("test");
        let mut s = Conversation::default();
        let (_, input) = s.prepare(&o, &[InputItem::user("x")]).unwrap();
        let r = parse_response(
            json!({"id":"r1","status":"completed","output":[{"type":"program","fingerprint":"f"}]}),
        )
        .unwrap();
        s.settle(input, &r).unwrap();
        assert!(matches!(
            s.prepare(&o, &[InputItem::user("go")]),
            Err(GatewayError::UnsupportedOutput)
        ));
    }
    #[test]
    fn tool_schema_remains_a_normal_function() {
        let mut o = SessionOptions::new("test");
        o.tools.push(crate::tools::add_numbers_definition());
        let (b, _) = Conversation::default()
            .prepare(&o, &[InputItem::user("add")])
            .unwrap();
        assert_eq!(b["tools"][0]["type"], "function");
        assert_eq!(b["tools"][0]["strict"], true);
        assert!(b["tools"][0].get("async").is_none());
        assert_eq!(b["tool_choice"], "auto");
    }
}
