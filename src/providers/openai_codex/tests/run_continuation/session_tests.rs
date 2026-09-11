use super::*;

#[tokio::test]
async fn websocket_two_requests_share_connection_and_use_parent_id() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let first = incoming(&mut socket).await;
        assert_eq!(first["type"], "response.create");
        assert!(first.get("stream").is_none());
        assert!(first.get("background").is_none());
        assert_eq!(first["store"], false);
        text_response(&mut socket, "r1", "one").await;
        let second = incoming(&mut socket).await;
        assert_eq!(second["previous_response_id"], "r1");
        assert_eq!(second["input"].as_array().unwrap().len(), 1);
        assert_eq!(first["prompt_cache_key"], second["prompt_cache_key"]);
        text_response(&mut socket, "r2", "two").await;
        let _ = socket.next().await;
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    let mut session = provider
        .open_session(SessionOptions::new("synthetic-model"))
        .await
        .unwrap();
    let a = session
        .control
        .generate(vec![InputItem::user("first")])
        .await
        .unwrap();
    assert_eq!(response(&mut session, &a.request_id).await.text, "one");
    let b = session
        .control
        .generate(vec![InputItem::user("second")])
        .await
        .unwrap();
    assert_ne!(a.request_id, b.request_id);
    assert_eq!(response(&mut session, &b.request_id).await.text, "two");
    session.control.close();
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn websocket_tool_round_trip_links_call_id_and_executes_outside_provider() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let first = incoming(&mut socket).await;
        assert_eq!(first["tools"][0]["name"], "add_numbers");
        send(
            &mut socket,
            json!({"type":"response.created","response":{"id":"r1"}}),
        )
        .await;
        send(&mut socket, json!({"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"item1","call_id":"call1","name":"add_numbers","arguments":"","status":"in_progress"}})).await;
        send(&mut socket, json!({"type":"response.function_call_arguments.delta","item_id":"item1","output_index":0,"delta":"{\"a\":17,"})).await;
        send(&mut socket, json!({"type":"response.function_call_arguments.delta","item_id":"item1","output_index":0,"delta":"\"b\":25}"})).await;
        send(&mut socket, json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"function_call","id":"item1","call_id":"call1","name":"add_numbers","arguments":"{\"a\":17,\"b\":25}","status":"completed"}]}})).await;
        let second = incoming(&mut socket).await;
        assert_eq!(second["previous_response_id"], "r1");
        assert_eq!(second["input"][0]["type"], "function_call_output");
        assert_eq!(second["input"][0]["call_id"], "call1");
        let output: Value =
            serde_json::from_str(second["input"][0]["output"].as_str().unwrap()).unwrap();
        assert_eq!(output["sum"], 42);
        text_response(&mut socket, "r2", "42").await;
        let _ = socket.next().await;
    });
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(AddNumbers)).unwrap();
    let mut options = SessionOptions::new("synthetic-model");
    options.tools = tools.definitions();
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    let mut session = provider.open_session(options).await.unwrap();
    let a = session
        .control
        .generate(vec![InputItem::user("add")])
        .await
        .unwrap();
    let first = response(&mut session, &a.request_id).await;
    assert_eq!(first.output[0].kind, ItemKind::FunctionCall);
    let result = tools.execute_response(&first, |_| {}).await.unwrap();
    let b = session.control.generate(result).await.unwrap();
    assert_eq!(response(&mut session, &b.request_id).await.text, "42");
    session.control.close();
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn terminal_call_status_gates_session_continuation_before_second_send() {
    for status in [
        Some(json!(null)),
        Some(json!(true)),
        Some(json!(7)),
        Some(json!({})),
        Some(json!([])),
        Some(json!("")),
        Some(json!("unknown")),
        Some(json!("in_progress")),
        None,
        Some(json!("completed")),
    ] {
        let complete = status.is_none() || status == Some(json!("completed"));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut socket = accept(listener).await;
            let _ = incoming(&mut socket).await;
            let mut call = json!({"type":"function_call", "id":"item1", "call_id":"call1",
                "name":"add_numbers", "arguments":"{\"a\":17,\"b\":25}"});
            if let Some(status) = status {
                call["status"] = json!(status);
            }
            send(
                &mut socket,
                json!({"type":"response.completed", "response":{
                    "id":"r1", "status":"completed", "output":[call]
                }}),
            )
            .await;
            if complete {
                let second = incoming(&mut socket).await;
                assert_eq!(second["input"][0]["call_id"], "call1");
                text_response(&mut socket, "r2", "42").await;
            }
            // Drain until close: any additional create frame fails the proof.
            while let Some(frame) = socket.next().await {
                match frame {
                    Ok(Message::Text(_)) => panic!("unexpected generation send"),
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(Message::Ping(_)) => socket.flush().await.unwrap(),
                    _ => {}
                }
            }
        });
        let provider =
            OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
        let mut session = provider
            .open_session(SessionOptions::new("test"))
            .await
            .unwrap();
        let first = session
            .control
            .generate(vec![InputItem::user("add")])
            .await
            .unwrap();
        let terminal = response(&mut session, &first.request_id).await;
        assert_eq!(terminal.outcome, ResponseOutcome::Completed);
        assert_eq!(
            terminal.output[0].function_call.as_ref().unwrap().complete,
            complete
        );
        let next = session
            .control
            .generate(vec![InputItem::ToolResult {
                call_id: "call1".into(),
                output: "{\"sum\":42}".into(),
            }])
            .await;
        if complete {
            assert_eq!(
                response(&mut session, &next.unwrap().request_id).await.text,
                "42"
            );
        } else {
            assert!(matches!(next, Err(GatewayError::UnsupportedOutput)));
            assert!(matches!(
                session
                    .control
                    .generate(vec![InputItem::user("continue")])
                    .await,
                Err(GatewayError::UnsupportedOutput)
            ));
        }
        session.control.close();
        timeout(Duration::from_secs(3), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn incomplete_terminal_is_exposed_and_session_is_not_continued() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let _ = incoming(&mut socket).await;
        send(&mut socket, json!({"type":"response.incomplete","response":{"id":"r1","status":"incomplete","output":[],"incomplete_details":{"reason":"max_output_tokens"}}})).await;
        let _ = socket.next().await;
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    let mut session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    let receipt = session
        .control
        .generate(vec![InputItem::user("run")])
        .await
        .unwrap();
    let result = response(&mut session, &receipt.request_id).await;
    assert!(matches!(result.outcome, ResponseOutcome::Incomplete { .. }));
    assert!(
        session
            .control
            .generate(vec![InputItem::user("again")])
            .await
            .is_err()
    );
    server.await.unwrap();
}

#[tokio::test]
async fn sse_two_requests_replay_full_native_context_and_parse_eof() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        let a = read_http(&mut first).await;
        assert_eq!(a["stream"], true);
        assert!(a.get("type").is_none());
        send_sse(&mut first, "r1", "first").await;
        let (mut second, _) = listener.accept().await.unwrap();
        let b = read_http(&mut second).await;
        assert!(b.get("previous_response_id").is_none());
        assert_eq!(b["input"].as_array().unwrap().len(), 4);
        assert_eq!(b["input"][1]["encrypted_content"], "opaque-test-data");
        send_sse(&mut second, "r2", "second").await;
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::Sse, address);
    let mut opts = SessionOptions::new("test");
    opts.transport = Transport::Sse;
    let mut session = provider.open_session(opts).await.unwrap();
    let a = session
        .control
        .generate(vec![InputItem::user("one")])
        .await
        .unwrap();
    assert_eq!(response(&mut session, &a.request_id).await.text, "first");
    let b = session
        .control
        .generate(vec![InputItem::user("two")])
        .await
        .unwrap();
    assert_eq!(response(&mut session, &b.request_id).await.text, "second");
    session.control.close();
    server.await.unwrap();
}
