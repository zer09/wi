//! Real loopback WebSocket/HTTP protocol tests. All authentication is SYNTHETIC.
//! These never read ~/.codex, ~/.pi, or real environment credentials.
use super::*;
use crate::{
    GatewayError, InputItem, ItemKind, ProviderEvent, ResponseOutcome, UpstreamOutcome,
    tools::{AddNumbers, ToolRegistry},
};
use auth::{CredentialSource, SubscriptionCredentials};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::{Duration, timeout},
};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};

#[path = "boundary_tests.rs"]
mod boundary_tests;
#[path = "consistency_loopback_tests.rs"]
mod consistency_loopback_tests;
#[path = "diagnostic_tests.rs"]
mod diagnostic_tests;
#[path = "lifecycle_tests.rs"]
mod lifecycle_tests;
#[cfg(target_os = "linux")]
#[path = "managed_loopback_tests.rs"]
mod managed_loopback_tests;
#[path = "observation_tests.rs"]
mod observation_tests;
#[path = "recovery_loopback_tests.rs"]
mod recovery_loopback_tests;
#[path = "run_loopback_tests.rs"]
mod run_loopback_tests;
#[path = "sse_prolog_loopback_tests.rs"]
mod sse_prolog_loopback_tests;

struct FakeAuth;
#[async_trait]
impl CredentialSource for FakeAuth {
    async fn load(&self) -> Result<SubscriptionCredentials> {
        SubscriptionCredentials::from_access_token(
            "synthetic-oauth-token".into(),
            Some("synthetic-account".into()),
            None,
        )
    }
}
struct ExplodingAuth;
#[async_trait]
impl CredentialSource for ExplodingAuth {
    async fn load(&self) -> Result<SubscriptionCredentials> {
        panic!("feature guard must run before auth")
    }
}
// Tungstenite fixes the callback error type; the test cannot box it.
#[allow(clippy::result_large_err)]
async fn accept(listener: TcpListener) -> WebSocketStream<TcpStream> {
    let (tcp, _) = listener.accept().await.unwrap();
    accept_hdr_async(tcp, |req: &Request, response: Response| {
        assert_eq!(req.uri().path(), "/codex/responses");
        assert_eq!(
            req.headers()["authorization"],
            "Bearer synthetic-oauth-token"
        );
        assert_eq!(req.headers()["chatgpt-account-id"], "synthetic-account");
        assert_eq!(req.headers()["originator"], "wi");
        assert_eq!(req.headers()["openai-beta"], wire::WS_BETA);
        Ok(response)
    })
    .await
    .unwrap()
}
async fn incoming(socket: &mut WebSocketStream<TcpStream>) -> Value {
    loop {
        match socket.next().await.unwrap().unwrap() {
            Message::Text(text) => return serde_json::from_str(text.as_str()).unwrap(),
            Message::Ping(_) => {
                socket.flush().await.unwrap();
            }
            _ => {}
        }
    }
}
async fn send(socket: &mut WebSocketStream<TcpStream>, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
async fn text_response(socket: &mut WebSocketStream<TcpStream>, id: &str, text: &str) {
    send(
        socket,
        json!({"type":"response.created","sequence_number":0,"response":{"id":id}}),
    )
    .await;
    send(socket, json!({"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"m1","content":[]}})).await;
    send(socket, json!({"type":"response.output_text.delta","item_id":"m1","output_index":0,"content_index":0,"delta":text})).await;
    send(socket, json!({"type":"response.completed","response":{"id":id,"status":"completed","model":"synthetic-model","output":[{"type":"message","id":"m1","content":[{"type":"output_text","text":text}]}]}})).await;
}
async fn response(session: &mut ProviderSession, request_id: &str) -> crate::ModelResponse {
    loop {
        let event = timeout(Duration::from_secs(4), session.events.next())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.request_id.as_deref(), Some(request_id));
        match event.event {
            ProviderEvent::ResponseFinished { response } => return response,
            ProviderEvent::RequestFailed { code, .. } => panic!("request failed: {code}"),
            _ => {}
        }
    }
}

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
async fn busy_and_close_work_while_output_is_being_read() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let _ = incoming(&mut socket).await;
        send(
            &mut socket,
            json!({"type":"response.created","response":{"id":"r1"}}),
        )
        .await;
        let _ = socket.next().await;
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    let mut session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    let _ = session
        .control
        .generate(vec![InputItem::user("run")])
        .await
        .unwrap();
    let _ = session.events.next().await.unwrap();
    assert!(matches!(
        session
            .control
            .generate(vec![InputItem::user("another")])
            .await,
        Err(GatewayError::Busy)
    ));
    assert!(matches!(
        session.control.steer("change".into()).await,
        Err(GatewayError::UnsupportedFeature(_))
    ));
    session.control.close();
    let event = timeout(Duration::from_secs(2), session.events.next())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        event.event,
        ProviderEvent::RequestFailed {
            upstream_outcome: UpstreamOutcome::Unknown,
            ..
        }
    ));
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn disconnected_partial_response_is_failure_not_completed_and_is_not_retried() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let _ = incoming(&mut socket).await;
        send(
            &mut socket,
            json!({"type":"response.created","response":{"id":"r1"}}),
        )
        .await;
        send(&mut socket, json!({"type":"response.output_text.delta","item_id":"m1","output_index":0,"delta":"partial"})).await;
        socket.close(None).await.unwrap();
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    let mut session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    session
        .control
        .generate(vec![InputItem::user("run")])
        .await
        .unwrap();
    let mut failed = false;
    while let Some(e) = timeout(Duration::from_secs(3), session.events.next())
        .await
        .unwrap()
    {
        assert!(!matches!(e.event, ProviderEvent::ResponseFinished { .. }));
        if matches!(
            e.event,
            ProviderEvent::RequestFailed {
                upstream_outcome: UpstreamOutcome::Unknown,
                ..
            }
        ) {
            failed = true;
        }
    }
    assert!(failed);
    assert!(matches!(
        session
            .control
            .generate(vec![InputItem::user("retry")])
            .await,
        Err(GatewayError::SessionClosed)
    ));
    server.await.unwrap();
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
async fn dropping_unpolled_events_releases_session() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let _ = socket.next().await;
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    let session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    let control = session.control.clone();
    drop(session);
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        control.generate(vec![InputItem::user("x")]).await,
        Err(GatewayError::SessionClosed)
    ));
}

#[tokio::test]
async fn advanced_feature_requirement_fails_before_authentication() {
    let provider = OpenAiCodexProvider::new(Arc::new(ExplodingAuth));
    for feature in [
        Feature::NativeSteering,
        Feature::ToolSearch,
        Feature::ProgrammaticTools,
        Feature::AsyncTools,
        Feature::HostedSkills,
    ] {
        let mut opts = SessionOptions::new("test");
        opts.required_features.push(feature);
        assert!(matches!(
            provider.open_session(opts).await,
            Err(GatewayError::UnsupportedFeature(_))
        ));
    }
}

#[tokio::test]
async fn slow_event_consumer_gets_terminal_failure_without_unbounded_buffering() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let _ = incoming(&mut socket).await;
        send(
            &mut socket,
            json!({"type":"response.created","response":{"id":"r1"}}),
        )
        .await;
        for _ in 0..100 {
            let frame = json!({"type":"response.output_text.delta","item_id":"m1","output_index":0,"content_index":0,"delta":"x"});
            if socket
                .send(Message::Text(frame.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = socket.next().await;
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    let mut session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    session
        .control
        .generate(vec![InputItem::user("run")])
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut failure = false;
    let mut count = 0;
    while let Some(e) = timeout(Duration::from_secs(3), session.events.next())
        .await
        .unwrap()
    {
        count += 1;
        if matches!(&e.event, ProviderEvent::RequestFailed { code, .. } if code == "slow_consumer")
        {
            failure = true;
        }
    }
    assert!(failure);
    assert!(count <= 65);
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}

async fn read_http(stream: &mut TcpStream) -> Value {
    let mut raw = Vec::new();
    let mut byte = [0u8; 1];
    while !raw.ends_with(b"\r\n\r\n") {
        assert!(raw.len() < 16 * 1024);
        stream.read_exact(&mut byte).await.unwrap();
        raw.push(byte[0]);
    }
    let headers = String::from_utf8(raw).unwrap();
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("authorization: bearer synthetic-oauth-token")
    );
    let len: usize = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    let mut body = vec![0; len];
    stream.read_exact(&mut body).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}
async fn send_sse(stream: &mut TcpStream, id: &str, text: &str) {
    // Terminal frame deliberately has NO final newline; codec closes it at EOF.
    let body = format!(
        "data: {}\r\n\r\ndata: {}",
        json!({"type":"response.created","response":{"id":id}}),
        json!({"type":"response.completed","response":{"id":id,"status":"completed","output":[{"type":"reasoning","id":"opaque1","encrypted_content":"opaque-test-data"},{"type":"message","id":"m1","content":[{"type":"output_text","text":text}]}]}})
    );
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await.unwrap();
    stream.write_all(body.as_bytes()).await.unwrap();
    stream.shutdown().await.unwrap();
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

#[tokio::test]
async fn sse_redirect_is_not_followed_and_no_secret_body_is_exposed() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        let _ = read_http(&mut tcp).await;
        tcp.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://example.invalid/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::Sse, address);
    let mut opts = SessionOptions::new("test");
    opts.transport = Transport::Sse;
    let mut session = provider.open_session(opts).await.unwrap();
    session
        .control
        .generate(vec![InputItem::user("hello")])
        .await
        .unwrap();
    let event = session.events.next().await.unwrap();
    assert!(
        matches!(&event.event, ProviderEvent::RequestFailed { code, message, .. } if code == "http_error" && !message.contains("synthetic-oauth-token"))
    );
    server.await.unwrap();
}

#[tokio::test]
async fn idle_timeout_is_explicit_and_does_not_replay_request() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let _ = incoming(&mut socket).await;
        let _ = socket.next().await;
    });
    let mut provider =
        OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    provider.timeouts.idle = Duration::from_millis(50);
    let mut session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    session
        .control
        .generate(vec![InputItem::user("run")])
        .await
        .unwrap();
    let event = timeout(Duration::from_secs(2), session.events.next())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(&event.event, ProviderEvent::RequestFailed { code, upstream_outcome:UpstreamOutcome::Unknown, .. } if code == "timeout")
    );
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn websocket_responds_to_ping_while_idle() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (pong_tx, pong_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        socket
            .send(Message::Ping(vec![1, 2, 3].into()))
            .await
            .unwrap();
        let frame = timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(frame, Message::Pong(_)));
        let _ = pong_tx.send(());
        let _ = socket.next().await;
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    let session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    timeout(Duration::from_secs(2), pong_rx)
        .await
        .unwrap()
        .unwrap();
    session.control.close();
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}
