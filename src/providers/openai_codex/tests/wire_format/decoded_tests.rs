use super::*;

#[tokio::test]
async fn decoded_native_namespace_rejects_entire_batch_without_caching() {
    for namespace in [json!({"name":"unsupported"}), json!(7)] {
        let mut tools = ToolRegistry::new();
        tools.register(Arc::new(AddNumbers)).unwrap();
        let mut decoded = codec::parse_response(json!({
            "id":"r1", "status":"completed", "output":[
                {"type":"function_call", "call_id":"call1", "name":"add_numbers",
                 "arguments":"{\"a\":17,\"b\":25}", "status":"completed"},
                {"type":"function_call", "call_id":"call2", "name":"add_numbers",
                 "arguments":"{\"a\":17,\"b\":25}", "status":"completed", "namespace":namespace}
            ]
        }))
        .unwrap();
        assert!(
            decoded.output[1]
                .function_call
                .as_ref()
                .unwrap()
                .namespace
                .is_none()
        );
        let mut events = vec![];
        assert!(matches!(
            tools.execute_response(&decoded, |e| events.push(e)).await,
            Err(GatewayError::UnsupportedOutput)
        ));
        assert!(events.is_empty());

        // Reuse both identities after correction to prove neither call was cached.
        decoded.output[1].native["namespace"] = Value::Null;
        let results = tools
            .execute_response(&decoded, |e| events.push(e))
            .await
            .unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(events.len(), 4);
        assert!(
            events
                .iter()
                .all(|e| !matches!(e, crate::tools::ToolExecutionEvent::ToolResultReused { .. }))
        );
    }
}

#[tokio::test]
async fn decoded_status_rejects_batch_without_execution_or_cache() {
    for status in [
        json!(null),
        json!(true),
        json!(7),
        json!({}),
        json!([]),
        json!(""),
        json!("unknown"),
        json!("in_progress"),
        json!("failed"),
    ] {
        let mut tools = ToolRegistry::new();
        tools.register(Arc::new(AddNumbers)).unwrap();
        let mut native = json!({"id":"r1", "status":"completed", "output":[
            {"type":"function_call", "call_id":"call1", "name":"add_numbers", "arguments":"{\"a\":17,\"b\":25}"},
            {"type":"function_call", "call_id":"call2", "name":"add_numbers", "arguments":"{\"a\":17,\"b\":25}", "status":status}
        ]});
        let decoded = codec::parse_response(native.clone()).unwrap();
        assert_eq!(decoded.output[1].native["status"], status);
        let mut events = vec![];
        assert!(matches!(
            tools.execute_response(&decoded, |e| events.push(e)).await,
            Err(GatewayError::UnsupportedOutput)
        ));
        assert!(events.is_empty());
        native["output"][1]["status"] = json!("completed");
        let corrected = codec::parse_response(native).unwrap();
        let results = tools
            .execute_response(&corrected, |e| events.push(e))
            .await
            .unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(events.len(), 4);
        assert!(
            events
                .iter()
                .all(|e| !matches!(e, crate::tools::ToolExecutionEvent::ToolResultReused { .. }))
        );
    }
}
