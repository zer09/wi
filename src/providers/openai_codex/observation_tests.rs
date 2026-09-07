use super::super::observation::{
    FOLLOW_UP, OpaqueReplay, SmokeCase, SmokeObserver, required_proof,
};
use super::*;

#[test]
fn observer_rejects_changed_parent_delta_replay_and_result_linkage() {
    use super::super::{codec::parse_response, observation::Observation};
    for transport in [Transport::WebSocket, Transport::Sse] {
        let observer = SmokeObserver::default();
        let mut observation = Observation::new(observer.clone(), SmokeCase::Tool, transport);
        observation.send(&json!({"input":[{"role":"user","content":[{"type":"input_text","text":SmokeCase::Tool.first_prompt()}]}]}));
        let response = parse_response(json!({"id":"private-parent","status":"completed","output":[
            {"type":"reasoning","encrypted_content":"private-opaque"},
            {"type":"function_call","call_id":"private-call","name":"add_numbers","arguments":"{\"a\":17,\"b\":25}"}]})).unwrap();
        observation.terminal(&response);
        observation.send(&json!({"previous_response_id":"wrong-parent","input":[{"type":"function_call_output","call_id":"wrong-call","output":"{\"sum\":41}"}]}));
        let records = observer.snapshot();
        assert_eq!(records[1].result_linkage_equal, Some(false));
        if transport == Transport::WebSocket {
            assert_eq!(records[1].prior_response_equal, Some(false));
            assert_eq!(records[1].new_input_only_equal, Some(false));
        } else {
            assert_eq!(records[1].native_sse_replay_equal, Some(false));
            assert_eq!(records[1].opaque_replay, Some(OpaqueReplay::Mismatched));
        }
        assert!(!required_proof(&records, SmokeCase::Tool, transport));
        assert!(!serde_json::to_string(&records).unwrap().contains("private"));
    }
}

#[test]
fn observer_snapshot_schema_counts_and_stability_are_sanitized() {
    use super::super::observation::Observation;
    let observer = SmokeObserver::default();
    let mut observation = Observation::new(observer.clone(), SmokeCase::Text, Transport::WebSocket);
    observation.send(&json!({"input":[], "private-header":"private-token"}));
    for kind in [
        "response.created",
        "response.output_text.delta",
        "response.refusal.delta",
        "response.reasoning_text.delta",
        "response.reasoning_summary_text.delta",
        "response.function_call_arguments.delta",
        "response.custom_tool_call_input.delta",
    ] {
        observation
            .native(&json!({"type":kind,"delta":"private-text","response":{"id":"private-id"}}));
    }
    observation
        .native(&json!({"type":"response.completed","response":{"status":"private-status"}}));
    let snapshot = observer.snapshot();
    let record = serde_json::to_value(&snapshot[0]).unwrap();
    let keys = [
        "transport",
        "ordinal",
        "socket_reused",
        "prior_response_equal",
        "new_input_only_equal",
        "native_sse_replay_equal",
        "opaque_replay",
        "result_linkage_equal",
        "native_created_count",
        "terminal_type",
        "terminal_status",
        "validated_terminal",
        "text_deltas",
        "refusal_deltas",
        "reasoning_deltas",
        "argument_deltas",
    ];
    assert_eq!(record.as_object().unwrap().len(), keys.len());
    for key in keys {
        assert!(record.get(key).is_some());
    }
    assert_eq!(record["native_created_count"], 1);
    assert_eq!(record["text_deltas"], 1);
    assert_eq!(record["refusal_deltas"], 1);
    assert_eq!(record["reasoning_deltas"], 2);
    assert_eq!(record["argument_deltas"], 2);
    assert_eq!(record["terminal_status"], "unknown");
    assert_eq!(record["validated_terminal"], false);
    assert!(!record.to_string().contains("private"));
    observation.send(&json!({"input":[]}));
    assert_eq!(snapshot.len(), 1);
    assert_eq!(serde_json::to_value(&snapshot[0]).unwrap(), record);
    assert_eq!(observer.snapshot().len(), 2);
    assert!(!required_proof(
        &observer.snapshot(),
        SmokeCase::Text,
        Transport::WebSocket
    ));
}

#[tokio::test]
async fn observer_websocket_matches_actual_socket_and_serialized_input() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let first = incoming(&mut socket).await;
        assert_eq!(
            first["input"][0]["content"][0]["text"],
            SmokeCase::Continuation.first_prompt()
        );
        text_response(&mut socket, "private-response-id", "remembered").await;
        let second = incoming(&mut socket).await;
        let mut first_config = first.clone();
        let mut second_config = second.clone();
        first_config.as_object_mut().unwrap().remove("input");
        second_config.as_object_mut().unwrap().remove("input");
        second_config
            .as_object_mut()
            .unwrap()
            .remove("previous_response_id");
        assert_eq!(first_config, second_config);
        assert_eq!(second["previous_response_id"], "private-response-id");
        assert_eq!(
            second["input"],
            json!([{"role":"user","content":[{"type":"input_text","text":FOLLOW_UP}]}])
        );
        text_response(&mut socket, "private-second-id", "lantern").await;
        let _ = socket.next().await;
    });
    let observer = SmokeObserver::default();
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address)
        .with_smoke_observer(observer.clone(), SmokeCase::Continuation);
    let mut session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    for prompt in [SmokeCase::Continuation.first_prompt(), FOLLOW_UP] {
        let receipt = session
            .control
            .generate(vec![InputItem::user(prompt)])
            .await
            .unwrap();
        response(&mut session, &receipt.request_id).await;
    }
    let records = observer.snapshot();
    assert!(required_proof(
        &records,
        SmokeCase::Continuation,
        Transport::WebSocket
    ));
    assert_eq!(records[0].text_deltas, 1);
    assert!(!records[0].socket_reused);
    assert!(records[1].socket_reused);
    let serialized = serde_json::to_string(&records).unwrap();
    for secret in [
        "private-response-id",
        "private-second-id",
        "synthetic-account",
        "synthetic-oauth-token",
        "remembered",
        "lantern",
        "authorization",
        "prompt_cache_key",
    ] {
        assert!(!serialized.contains(secret));
    }
    session.control.close();
    timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn observer_sse_matches_native_body_and_conditional_opaque_replay() {
    for opaque in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let first = read_http(&mut tcp).await;
            let mut output = vec![
                json!({"type":"message","content":[{"type":"output_text","text":"remembered"}]}),
            ];
            if opaque {
                output.insert(0,json!({"type":"reasoning","encrypted_content":"private-opaque","fingerprint":"private-fingerprint","summary":[]}));
            }
            let body = format!(
                "data: {}\n\ndata: {}\n\n",
                json!({"type":"response.created","response":{"id":"private-id"}}),
                json!({"type":"response.completed","response":{"id":"private-id","status":"completed","output":output}})
            );
            tcp.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            tcp.shutdown().await.unwrap();
            let (mut tcp, _) = listener.accept().await.unwrap();
            let second = read_http(&mut tcp).await;
            let mut first_config = first.clone();
            let mut second_config = second.clone();
            first_config.as_object_mut().unwrap().remove("input");
            second_config.as_object_mut().unwrap().remove("input");
            assert_eq!(first_config, second_config);
            let mut expected = first["input"].as_array().unwrap().clone();
            expected.extend(output);
            expected
                .push(json!({"role":"user","content":[{"type":"input_text","text":FOLLOW_UP}]}));
            assert_eq!(second["input"], json!(expected));
            assert!(second.get("previous_response_id").is_none());
            send_sse(&mut tcp, "private-second-id", "lantern").await;
        });
        let observer = SmokeObserver::default();
        let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::Sse, address)
            .with_smoke_observer(observer.clone(), SmokeCase::Continuation);
        let mut opts = SessionOptions::new("test");
        opts.transport = Transport::Sse;
        let mut session = provider.open_session(opts).await.unwrap();
        for prompt in [SmokeCase::Continuation.first_prompt(), FOLLOW_UP] {
            let receipt = session
                .control
                .generate(vec![InputItem::user(prompt)])
                .await
                .unwrap();
            response(&mut session, &receipt.request_id).await;
        }
        let records = observer.snapshot();
        assert!(required_proof(
            &records,
            SmokeCase::Continuation,
            Transport::Sse
        ));
        assert_eq!(
            records[1].opaque_replay,
            Some(if opaque {
                OpaqueReplay::Matched
            } else {
                OpaqueReplay::NotEmitted
            })
        );
        assert_eq!(records[0].text_deltas, 0);
        let serialized = serde_json::to_string(&records).unwrap();
        for secret in [
            "private-id",
            "private-opaque",
            "private-fingerprint",
            "private-second-id",
            "synthetic-oauth-token",
        ] {
            assert!(!serialized.contains(secret));
        }
        session.control.close();
        server.await.unwrap();
    }
}

#[tokio::test]
async fn observer_distinguishes_native_created_from_synthetic_started_and_withholds_errors() {
    for malformed in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut socket = accept(listener).await;
            let _ = incoming(&mut socket).await;
            let status = if malformed {
                "private-error-status"
            } else {
                "completed"
            };
            send(&mut socket,json!({"type":"response.completed","private":"private-payload","response":{"id":"private-id","status":status,"output":[]}})).await;
            let _ = socket.next().await;
        });
        let observer = SmokeObserver::default();
        let provider =
            OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address)
                .with_smoke_observer(observer.clone(), SmokeCase::Text);
        let mut session = provider
            .open_session(SessionOptions::new("test"))
            .await
            .unwrap();
        session
            .control
            .generate(vec![InputItem::user(SmokeCase::Text.first_prompt())])
            .await
            .unwrap();
        let mut starts = 0;
        loop {
            let event = timeout(Duration::from_secs(2), session.events.next())
                .await
                .unwrap()
                .unwrap();
            match event.event {
                ProviderEvent::ResponseStarted { .. } => starts += 1,
                ProviderEvent::ResponseFinished { .. } | ProviderEvent::RequestFailed { .. } => {
                    break;
                }
                _ => {}
            }
        }
        let records = observer.snapshot();
        assert_eq!(records[0].native_created_count, 0);
        assert_eq!(starts, usize::from(!malformed));
        assert_eq!(records[0].validated_terminal, !malformed);
        assert!(!required_proof(
            &records,
            SmokeCase::Text,
            Transport::WebSocket
        ));
        assert!(!serde_json::to_string(&records).unwrap().contains("private"));
        session.control.close();
        timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn observer_result_linkage_is_checked_on_actual_tool_delivery() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let _ = incoming(&mut socket).await;
        send(
            &mut socket,
            json!({"type":"response.created","response":{"id":"private-id"}}),
        )
        .await;
        send(&mut socket,json!({"type":"response.completed","response":{"id":"private-id","status":"completed","output":[{"type":"function_call","call_id":"private-call","name":"add_numbers","arguments":"{\"a\":17,\"b\":25}"}]}})).await;
        let second = incoming(&mut socket).await;
        assert_eq!(second["input"][0]["call_id"], "private-call");
        assert_eq!(second["input"][0]["output"], "{\"sum\":42}");
        text_response(&mut socket, "private-second-id", "42").await;
        let _ = socket.next().await;
    });
    let observer = SmokeObserver::default();
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address)
        .with_smoke_observer(observer.clone(), SmokeCase::Tool);
    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(AddNumbers)).unwrap();
    let mut opts = SessionOptions::new("test");
    opts.tools = registry.definitions();
    let mut session = provider.open_session(opts).await.unwrap();
    let receipt = session
        .control
        .generate(vec![InputItem::user(SmokeCase::Tool.first_prompt())])
        .await
        .unwrap();
    let first = response(&mut session, &receipt.request_id).await;
    let results = registry.execute_response(&first, |_| {}).await.unwrap();
    let receipt = session.control.generate(results).await.unwrap();
    response(&mut session, &receipt.request_id).await;
    let records = observer.snapshot();
    assert!(required_proof(
        &records,
        SmokeCase::Tool,
        Transport::WebSocket
    ));
    assert_eq!(records[1].result_linkage_equal, Some(true));
    assert!(!serde_json::to_string(&records).unwrap().contains("private"));
    session.control.close();
    timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}
