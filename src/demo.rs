//! Pure acceptance checks for the fixed synthetic demonstration, not registry policy.
use harness_gateway::{
    CallOrigin, FunctionCall, GatewayError, InputItem, ItemKind, ModelResponse, ResponseOutcome,
    Result,
};
use serde_json::{Value, json};

pub const TOOL_INSTRUCTIONS: &str = "You are testing a tool gateway. Use exactly one direct add_numbers call with a=17 and b=25. After receiving its output, reply with exactly 42 and stop. Do not request any other tool.";
pub const TOOL_PROMPT: &str = "Use add_numbers with a=17 and b=25. What is the sum?";

pub fn validate_call(response: &ModelResponse) -> Result<&FunctionCall> {
    if response.outcome != ResponseOutcome::Completed {
        return Err(GatewayError::NotCompleted);
    }
    let mut selected = None;
    for item in &response.output {
        match item.kind {
            ItemKind::Message | ItemKind::Reasoning => continue,
            ItemKind::FunctionCall => {}
            _ => return Err(GatewayError::UnsupportedOutput),
        }
        let call = item
            .function_call
            .as_ref()
            .ok_or(GatewayError::UnsupportedOutput)?;
        if selected.is_some() {
            return Err(GatewayError::TurnLimit);
        }
        if !call.complete
            || call.origin != CallOrigin::Direct
            || call.namespace.is_some()
            || item.native.get("namespace").is_some_and(|v| !v.is_null())
            || call.call_id.is_empty()
            || call.name != "add_numbers"
        {
            return Err(GatewayError::UnsupportedOutput);
        }
        if call.arguments.len() > 64 * 1024
            || serde_json::from_str::<Value>(&call.arguments).ok() != Some(json!({"a":17,"b":25}))
        {
            return Err(GatewayError::InvalidToolArguments);
        }
        selected = Some(call);
    }
    selected.ok_or(GatewayError::NoToolCall)
}

pub fn validate_result(results: &[InputItem], call_id: &str) -> Result<()> {
    if let [
        InputItem::ToolResult {
            call_id: actual,
            output,
        },
    ] = results
        && actual == call_id
        && serde_json::from_str::<Value>(output).ok() == Some(json!({"sum":42}))
    {
        return Ok(());
    }
    Err(GatewayError::ToolFailed)
}

pub fn validate_answer(response: &ModelResponse, expected: &str) -> Result<()> {
    if response.outcome != ResponseOutcome::Completed {
        return Err(GatewayError::NotCompleted);
    }
    let mut text = String::new();
    let mut has_text = false;
    for item in &response.output {
        match item.kind {
            ItemKind::Reasoning => continue,
            ItemKind::Message => {}
            _ => return Err(GatewayError::UnsupportedOutput),
        }
        let parts = item
            .native
            .get("content")
            .and_then(Value::as_array)
            .ok_or(GatewayError::UnsupportedOutput)?;
        for part in parts {
            if part.get("type").and_then(Value::as_str) != Some("output_text") {
                return Err(GatewayError::UnsupportedOutput);
            }
            text.push_str(
                part.get("text")
                    .and_then(Value::as_str)
                    .ok_or(GatewayError::UnsupportedOutput)?,
            );
            has_text = true;
        }
    }
    if !has_text || text.trim() != expected || response.text.trim() != expected {
        return Err(GatewayError::Protocol("synthetic answer did not match"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_gateway::OutputItem;
    fn response() -> ModelResponse {
        ModelResponse {
            id: "synthetic".into(),
            model: None,
            outcome: ResponseOutcome::Completed,
            output: vec![OutputItem {
                id: None,
                kind: ItemKind::FunctionCall,
                native_type: "function_call".into(),
                function_call: Some(FunctionCall {
                    call_id: "original".into(),
                    name: "add_numbers".into(),
                    arguments: "{\"a\":17,\"b\":25}".into(),
                    origin: CallOrigin::Direct,
                    namespace: None,
                    complete: true,
                }),
                native: Value::Null,
            }],
            text: String::new(),
            usage: None,
            native: Value::Null,
        }
    }
    #[test]
    fn demo_rejects_missing_multiple_and_unsupported_calls() {
        let good = response();
        assert!(validate_call(&good).is_ok());
        let mut bad = good.clone();
        bad.output.clear();
        assert!(validate_call(&bad).is_err());
        let mut bad = good.clone();
        bad.output.push(bad.output[0].clone());
        assert!(validate_call(&bad).is_err());
        for kind in [
            ItemKind::Unknown,
            ItemKind::Program,
            ItemKind::CustomToolCall,
            ItemKind::ToolSearchCall,
            ItemKind::ProgramOutput,
            ItemKind::ToolSearchOutput,
        ] {
            let mut bad = good.clone();
            bad.output[0].kind = kind;
            assert!(validate_call(&bad).is_err());
        }
        let mut bad = good;
        bad.outcome = ResponseOutcome::Incomplete { reason: None };
        assert!(validate_call(&bad).is_err());
    }
    #[test]
    fn demo_rejects_wrong_arguments_and_call_authority() {
        for arguments in [
            "{}",
            "{\"a\":17}",
            "{\"a\":25,\"b\":17}",
            "{\"a\":17,\"b\":25,\"extra\":0}",
            "{\"a\":",
            "{\"a\":17.0,\"b\":25}",
        ] {
            let mut bad = response();
            bad.output[0].function_call.as_mut().unwrap().arguments = arguments.into();
            assert!(validate_call(&bad).is_err());
        }
        for variant in 0..7 {
            let mut bad = response();
            let call = bad.output[0].function_call.as_mut().unwrap();
            match variant {
                0 => call.name = "other".into(),
                1 => call.origin = CallOrigin::Programmatic,
                2 => call.origin = CallOrigin::Unknown,
                3 => call.namespace = Some(String::new()),
                4 => call.complete = false,
                5 => call.call_id.clear(),
                _ => bad.output[0].native = json!({"namespace":123}),
            }
            assert!(validate_call(&bad).is_err());
        }
    }
    #[test]
    fn demo_requires_one_correlated_sum_result() {
        let good = InputItem::ToolResult {
            call_id: "original".into(),
            output: "{\"sum\":42}".into(),
        };
        assert!(validate_result(std::slice::from_ref(&good), "original").is_ok());
        for bad in [
            vec![],
            vec![good.clone(), good.clone()],
            vec![InputItem::user("42")],
            vec![InputItem::ToolResult {
                call_id: "wrong".into(),
                output: "{\"sum\":42}".into(),
            }],
        ] {
            assert!(validate_result(&bad, "original").is_err());
        }
        for output in [
            "42",
            "{\"sum\":41}",
            "{\"sum\":42,\"extra\":0}",
            "{\"error\":{}}",
            "{",
        ] {
            assert!(
                validate_result(
                    &[InputItem::ToolResult {
                        call_id: "original".into(),
                        output: output.into()
                    }],
                    "original"
                )
                .is_err()
            );
        }
    }
    #[test]
    fn demo_requires_ordinary_final_text_without_refusal_or_extra_output() {
        let mut good = response();
        good.text = " 42\n".into();
        good.output[0].kind = ItemKind::Message;
        good.output[0].function_call = None;
        good.output[0].native = json!({"content":[{"type":"output_text","text":" 42\n"}]});
        assert!(validate_answer(&good, "42").is_ok());
        for content in [
            json!([]),
            json!([{"type":"refusal","refusal":"42"}]),
            json!([{"type":"output_text","text":"42"},{"type":"output_text","text":" extra"}]),
            json!([{"type":"output_text","text":"42"},{"type":"refusal","refusal":""}]),
        ] {
            let mut bad = good.clone();
            bad.output[0].native["content"] = content;
            assert!(validate_answer(&bad, "42").is_err());
        }
        let mut bad = good.clone();
        bad.output.push(response().output.remove(0));
        assert!(validate_answer(&bad, "42").is_err());
        let mut bad = good.clone();
        bad.text = "other".into();
        assert!(validate_answer(&bad, "42").is_err());
        let mut bad = good;
        bad.outcome = ResponseOutcome::Failed;
        assert!(validate_answer(&bad, "42").is_err());
    }
}
