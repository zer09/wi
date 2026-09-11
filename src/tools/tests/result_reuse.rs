use super::*;

#[tokio::test]
async fn tool_executes_once_and_repeated_delivery_reuses_result() {
    let mut r = single_call::registry();
    let response = single_call::response(ResponseOutcome::Completed);
    let mut events = vec![];
    let first = r
        .execute_response(&response, |e| events.push(e))
        .await
        .unwrap();
    assert_eq!(events.len(), 2);
    let second = r
        .execute_response(&response, |e| events.push(e))
        .await
        .unwrap();
    assert_eq!(events.len(), 3);
    assert!(matches!(
        &events[2],
        ToolExecutionEvent::ToolResultReused { .. }
    ));
    assert_eq!(
        serde_json::to_value(first).unwrap(),
        serde_json::to_value(second).unwrap()
    );
}

#[tokio::test]
async fn fresh_scopes_share_tools_but_never_consume_or_mutate_template_cache() {
    let (mut template, calls) = registry();
    let response = response(&["same"]);
    let original = template.execute_response(&response, |_| {}).await.unwrap();
    for _ in 0..2 {
        let mut scope = template.fresh_scope();
        assert!(scope.results.is_empty());
        assert!(Arc::ptr_eq(
            &scope.tools["add_numbers"],
            &template.tools["add_numbers"]
        ));
        assert_eq!(scope.definitions().len(), template.definitions().len());
        scope.execute_response(&response, |_| {}).await.unwrap();
        scope
            .execute_response(&response, |event| {
                assert!(matches!(event, ToolExecutionEvent::ToolResultReused { .. }))
            })
            .await
            .unwrap();
        assert_eq!(scope.results.len(), 1);
    }
    assert_eq!(calls.lock().unwrap().len(), 3);
    assert_eq!(template.results.len(), 1);
    let reused = template
        .execute_response(&response, |event| {
            assert!(matches!(event, ToolExecutionEvent::ToolResultReused { .. }))
        })
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(original).unwrap(),
        serde_json::to_value(reused).unwrap()
    );
    assert_eq!(calls.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn mixed_batch_keeps_original_execution_event_and_result_order() {
    let (mut registry, calls) = registry();
    registry
        .execute_response(&response(&["saved"]), |_| {})
        .await
        .unwrap();
    let mut response = response(&["first", "saved", "last"]);
    response.output[2].function_call.as_mut().unwrap().arguments = json!({"a":7,"b":8}).to_string();
    let mut events = Vec::new();
    let results = registry
        .execute_response(&response, |event| events.push(event))
        .await
        .unwrap();
    let trace: Vec<_> = events
        .iter()
        .map(|event| match event {
            ToolExecutionEvent::ToolExecutionStarted { call_id, .. } => ("start", call_id.as_str()),
            ToolExecutionEvent::ToolExecutionFinished { call_id, .. } => {
                ("finish", call_id.as_str())
            }
            ToolExecutionEvent::ToolResultReused { call_id, .. } => ("reuse", call_id.as_str()),
        })
        .collect();
    assert_eq!(
        trace,
        [
            ("start", "first"),
            ("finish", "first"),
            ("reuse", "saved"),
            ("start", "last"),
            ("finish", "last")
        ]
    );
    let result_ids: Vec<_> = results
        .iter()
        .map(|item| match item {
            InputItem::ToolResult { call_id, .. } => call_id.as_str(),
            _ => panic!(),
        })
        .collect();
    assert_eq!(result_ids, ["first", "saved", "last"]);
    assert_eq!(
        *calls.lock().unwrap(),
        [
            json!({"a":2,"b":3}),
            json!({"a":2,"b":3}),
            json!({"a":7,"b":8})
        ]
    );
}
