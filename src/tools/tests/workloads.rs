use super::*;

#[tokio::test]
async fn call_id_at_512_byte_boundary_produces_valid_input() {
    for call_id in ["x".repeat(512), "é".repeat(256)] {
        let (mut registry, calls) = registry();
        assert_eq!(call_id.len(), 512);
        let results = registry
            .execute_response(&response(&[&call_id]), |_| {})
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert!(matches!(
            &results[0],
            InputItem::ToolResult { call_id: result_id, .. } if result_id == &call_id
        ));
        crate::provider::validate_input(&results).unwrap();
        assert_eq!(calls.lock().unwrap().len(), 1);
        assert_eq!(registry.results.len(), 1);
        assert!(registry.results.contains_key(&call_id));
    }
}

#[tokio::test]
async fn nine_calls_and_input_capacity_batch_execute_in_order() {
    for size in [9, 128] {
        let (mut registry, calls) = registry();
        let ids: Vec<_> = (0..size).map(|i| format!("c{i}")).collect();
        let ids: Vec<_> = ids.iter().map(String::as_str).collect();
        let mut response = response(&ids);
        for (i, item) in response.output.iter_mut().enumerate() {
            item.function_call.as_mut().unwrap().arguments = json!({"a":i,"b":1}).to_string();
        }
        let mut events = Vec::new();
        let results = registry
            .execute_response(&response, |event| events.push(event))
            .await
            .unwrap();
        crate::provider::validate_input(&results).unwrap();
        assert_eq!(results.len(), size);
        assert_eq!(registry.results.len(), size);
        assert_eq!(events.len(), size * 2);
        assert_eq!(calls.lock().unwrap().len(), size);
        for (i, result) in results.iter().enumerate() {
            assert_eq!(calls.lock().unwrap()[i], json!({"a":i,"b":1}));
            assert!(matches!(
                &events[i * 2],
                ToolExecutionEvent::ToolExecutionStarted { call_id, .. } if call_id == ids[i]
            ));
            assert!(matches!(
                &events[i * 2 + 1],
                ToolExecutionEvent::ToolExecutionFinished { call_id, is_error: false, .. }
                    if call_id == ids[i]
            ));
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                json!({"kind":"tool_result","call_id":ids[i],"output":json!({"sum":i+1}).to_string()})
            );
        }
    }
}

#[tokio::test]
async fn result_item_capacity_rejects_whole_batch_before_dispatch_or_reuse() {
    let (mut registry, calls) = registry();
    registry
        .execute_response(&response(&["c0"]), |_| {})
        .await
        .unwrap();
    let ids: Vec<_> = (0..129).map(|i| format!("c{i}")).collect();
    let ids: Vec<_> = ids.iter().map(String::as_str).collect();
    let error = registry
        .execute_response(&response(&ids), |_| {
            panic!("oversized batch emitted an event")
        })
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GatewayError::InvalidRequest("tool results exceed input item capacity")
    ));
    assert_eq!(calls.lock().unwrap().len(), 1);
    assert_eq!(registry.results.len(), 1);
    assert!(registry.results.contains_key("c0"));
}

#[tokio::test]
async fn all_160_cached_results_survive_reuse_conflicts_and_fresh_scope() {
    let (mut registry, calls) = registry();
    let ids: Vec<_> = (0..160).map(|i| format!("c{i}")).collect();
    let ids: Vec<_> = ids.iter().map(String::as_str).collect();
    let mut original = Vec::new();
    for id in &ids {
        original.extend(
            registry
                .execute_response(&response(&[id]), |_| {})
                .await
                .unwrap(),
        );
    }
    assert_eq!(registry.results.len(), 160);
    let mut reused = Vec::new();
    let mut events = Vec::new();
    // Each replay fits one provider request, even though the cache is larger.
    for chunk in ids.chunks(128) {
        reused.extend(
            registry
                .execute_response(&response(chunk), |event| events.push(event))
                .await
                .unwrap(),
        );
    }
    assert_eq!(
        serde_json::to_value(&reused).unwrap(),
        serde_json::to_value(&original).unwrap()
    );
    assert_eq!(events.len(), 160);
    for (event, id) in events.iter().zip(&ids) {
        assert!(
            matches!(event, ToolExecutionEvent::ToolResultReused { call_id, .. } if call_id == id)
        );
    }
    for changed_name in [false, true] {
        let mut conflict = response(&["new", "c0"]);
        let call = conflict.output[1].function_call.as_mut().unwrap();
        if changed_name {
            call.name = "other".into();
        } else {
            call.arguments = json!({"a":4,"b":3}).to_string();
        }
        assert!(
            registry
                .execute_response(&conflict, |_| panic!("conflict emitted an event"))
                .await
                .is_err()
        );
    }
    assert_eq!(calls.lock().unwrap().len(), 160);
    assert_eq!(registry.results.len(), 160);
    let mut scope = registry.fresh_scope();
    assert!(scope.results.is_empty());
    for chunk in ids.chunks(128) {
        scope
            .execute_response(&response(chunk), |_| {})
            .await
            .unwrap();
    }
    assert_eq!(scope.results.len(), 160);
    assert_eq!(calls.lock().unwrap().len(), 320);
    drop(scope);
    assert_eq!(registry.results.len(), 160);
    registry
        .execute_response(&response(&["c0"]), |event| {
            assert!(matches!(event, ToolExecutionEvent::ToolResultReused { .. }));
        })
        .await
        .unwrap();
    assert_eq!(calls.lock().unwrap().len(), 320);
}
