use super::*;

#[tokio::test]
async fn overflow_becomes_tool_error_result() {
    let mut r = single_call::registry();
    let mut resp = single_call::response(ResponseOutcome::Completed);
    resp.output[0].function_call.as_mut().unwrap().arguments =
        json!({"a":i64::MAX,"b":1}).to_string();
    let result = r.execute_response(&resp, |_| {}).await.unwrap();
    assert!(matches!(&result[0], InputItem::ToolResult { output, .. } if output.contains("error")));
}

#[tokio::test]
async fn overflow_and_oversized_output_are_bounded_correlated_cached_results() {
    for oversized in [false, true] {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(RecordingTool {
                calls: calls.clone(),
                oversized,
                name: "add_numbers",
            }))
            .unwrap();
        let mut response = response(&["error"]);
        response.output[0].function_call.as_mut().unwrap().arguments =
            json!({"a":i64::MAX,"b":1}).to_string();
        let mut events = Vec::new();
        let results = registry
            .execute_response(&response, |event| events.push(event))
            .await
            .unwrap();
        let InputItem::ToolResult { call_id, output } = &results[0] else {
            panic!()
        };
        assert_eq!(call_id, "error");
        assert!(output.len() <= 64 * 1024);
        let expected = if oversized {
            "tool_output_limit"
        } else {
            "gateway_error"
        };
        assert_eq!(
            serde_json::from_str::<Value>(output).unwrap(),
            json!({"error":{"code":expected}})
        );
        assert!(matches!(
            events[1],
            ToolExecutionEvent::ToolExecutionFinished { is_error: true, .. }
        ));
        assert_eq!(registry.results["error"].output, *output);
        registry
            .execute_response(&response, |event| {
                assert!(matches!(event, ToolExecutionEvent::ToolResultReused { .. }))
            })
            .await
            .unwrap();
        assert_eq!(calls.lock().unwrap().len(), 1);
    }
}
