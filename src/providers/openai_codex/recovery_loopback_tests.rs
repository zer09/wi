use super::super::observation::{
    FOLLOW_UP, OpaqueReplay, SmokeCase, SmokeObserver, TextState, required_proof,
};
use super::*;
use crate::OutputProvenance;

fn output(tool: bool, second: bool) -> Vec<Value> {
    if tool && !second {
        vec![
            json!({"id":"reason","type":"reasoning","summary":[],"encrypted_content":"private-opaque","fingerprint":"private-fingerprint"}),
            json!({"id":"item","type":"function_call","call_id":"call","name":"add_numbers","arguments":"{\"a\":17,\"b\":25}"}),
        ]
    } else {
        vec![
            json!({"id":"message","type":"message","content":[{"type":"output_text","text":if second { if tool { "42" } else { "lantern" } } else { "remembered" }}]}),
        ]
    }
}
fn stream(id: &str, items: Vec<Value>) -> Vec<Value> {
    let mut events = vec![json!({"type":"response.created","response":{"id":id}})];
    for (index, item) in items.into_iter().enumerate().rev() {
        events.push(json!({"type":"response.output_item.done","output_index":index,"item":item}));
    }
    events.push(
        json!({"type":"response.completed","response":{"id":id,"status":"completed","output":[]}}),
    );
    events
}
async fn http_events(tcp: &mut TcpStream, events: Vec<Value>) {
    let body = events
        .iter()
        .map(|v| format!("data: {v}\n\n"))
        .collect::<String>();
    tcp.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    tcp.shutdown().await.unwrap();
}
fn second_request(first: &Value, second: &Value, transport: Transport, tool: bool) {
    let next = if tool {
        json!({"type":"function_call_output","call_id":"call","output":"{\"sum\":42}"})
    } else {
        json!({"role":"user","content":[{"type":"input_text","text":FOLLOW_UP}]})
    };
    if transport == Transport::WebSocket {
        assert_eq!(second["previous_response_id"], "r1");
        assert_eq!(second["input"], json!([next]));
    } else {
        assert!(second.get("previous_response_id").is_none());
        let mut expected = first["input"].as_array().unwrap().clone();
        expected.extend(output(tool, false));
        expected.push(next);
        assert_eq!(second["input"], json!(expected));
    }
    if tool {
        assert_eq!(first["tool_choice"], "auto");
    }
}
#[tokio::test]
async fn recovered_loopback_text_tool_continuation_and_observer_matrix() {
    for transport in [Transport::WebSocket, Transport::Sse] {
        for tool in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                if transport == Transport::WebSocket {
                    let mut socket = accept(listener).await;
                    let first = incoming(&mut socket).await;
                    for event in stream("r1", output(tool, false)) {
                        send(&mut socket, event).await;
                    }
                    let second = incoming(&mut socket).await;
                    second_request(&first, &second, transport, tool);
                    for event in stream("r2", output(tool, true)) {
                        send(&mut socket, event).await;
                    }
                    let _ = socket.next().await;
                } else {
                    let (mut tcp, _) = listener.accept().await.unwrap();
                    let first = read_http(&mut tcp).await;
                    http_events(&mut tcp, stream("r1", output(tool, false))).await;
                    let (mut tcp, _) = listener.accept().await.unwrap();
                    let second = read_http(&mut tcp).await;
                    second_request(&first, &second, transport, tool);
                    http_events(&mut tcp, stream("r2", output(tool, true))).await;
                }
            });
            let case = if tool {
                SmokeCase::Tool
            } else {
                SmokeCase::Continuation
            };
            let observer = SmokeObserver::default();
            let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), transport, address)
                .with_smoke_observer(observer.clone(), case);
            let mut options = SessionOptions::new("synthetic");
            options.transport = transport;
            let mut registry = ToolRegistry::new();
            registry.register(Arc::new(AddNumbers)).unwrap();
            if tool {
                options.tools = registry.definitions();
            }
            let mut session = provider.open_session(options).await.unwrap();
            let receipt = session
                .control
                .generate(vec![InputItem::user(case.first_prompt())])
                .await
                .unwrap();
            let first = response(&mut session, &receipt.request_id).await;
            assert_eq!(
                first.output_provenance,
                OutputProvenance::ValidatedOutputItemDone
            );
            assert_eq!(first.native["output"], json!([]));
            let next = if tool {
                let mut executed = 0;
                let results = registry
                    .execute_response(&first, |_| executed += 1)
                    .await
                    .unwrap();
                assert_eq!(executed, 2);
                assert!(
                    matches!(&results[0], InputItem::ToolResult { call_id, output } if call_id == "call" && output == "{\"sum\":42}")
                );
                results
            } else {
                assert_eq!(first.text, "remembered");
                vec![InputItem::user(FOLLOW_UP)]
            };
            let receipt = session.control.generate(next).await.unwrap();
            let second = response(&mut session, &receipt.request_id).await;
            assert_eq!(second.text, if tool { "42" } else { "lantern" });
            assert_eq!(second.native["output"], json!([]));
            let records = observer.snapshot();
            assert!(required_proof(&records, case, transport));
            for record in &records {
                assert_eq!(record.native_terminal_items, Some(0));
                assert_eq!(
                    record.output_provenance,
                    Some(OutputProvenance::ValidatedOutputItemDone)
                );
                assert_eq!(record.terminal_text_state, TextState::NoOrdinaryParts);
                assert_eq!(record.native_expected_text_equal, None);
                assert_eq!(record.normalized_native_text_equal, None);
            }
            assert_eq!(records[1].effective_expected_text_equal, Some(true));
            assert_eq!(records[1].normalized_effective_text_equal, Some(true));
            assert_eq!(records[1].effective_items, Some(1));
            if tool && transport == Transport::Sse {
                assert_eq!(records[1].opaque_replay, Some(OpaqueReplay::Matched));
            }
            assert!(!serde_json::to_string(&records).unwrap().contains("private"));
            session.control.close();
            timeout(Duration::from_secs(3), server)
                .await
                .unwrap()
                .unwrap();
        }
    }
}
#[tokio::test]
async fn invalid_recovery_loopback_reports_received_without_settlement_or_second_send() {
    for variant in 0..8 {
        for transport in [Transport::WebSocket, Transport::Sse] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let mut events = stream(
                    "r1",
                    vec![
                        output(false, false)[0].clone(),
                        output(true, false)[1].clone(),
                    ],
                );
                match variant {
                    0 => events[2]["item"] = json!({"type":"program","id":"unsupported"}),
                    1 => events[2]["call_id"] = json!("orphan"),
                    2 => {
                        events[2]["item"]["role"] = json!("assistant");
                        events.insert(1, json!({"type":"response.output_item.added","output_index":0,"item":{"id":"message","type":"message","role":"user","status":"in_progress","content":[]}}));
                    }
                    3 | 4 => {
                        let suffix = if variant == 3 { "added" } else { "done" };
                        events.insert(1, json!({"type":format!("response.reasoning_text_part.{suffix}"),"output_index":0,"item_id":"message","content_index":0,"part":{"type":"output_text","text":"remembered"}}));
                    }
                    5 => events[2]["content_index"] = json!(0),
                    6 => events[2]["item"]["caller"] = json!({"type":"direct"}),
                    7 => {
                        let mut start = events[1]["item"].clone();
                        start["status"] = json!("in_progress");
                        start["arguments"] = json!("{\"a\":0,\"b\":0}");
                        events.insert(1, json!({"type":"response.output_item.added","output_index":1,"item":start}));
                    }
                    _ => unreachable!(),
                }
                if transport == Transport::WebSocket {
                    let mut socket = accept(listener).await;
                    let _ = incoming(&mut socket).await;
                    for event in events {
                        send(&mut socket, event).await;
                    }
                    while let Some(frame) = socket.next().await {
                        if let Ok(frame) = frame {
                            assert!(!frame.is_text());
                        }
                    }
                } else {
                    let (mut tcp, _) = listener.accept().await.unwrap();
                    let _ = read_http(&mut tcp).await;
                    http_events(&mut tcp, events).await;
                    assert!(
                        timeout(Duration::from_millis(150), listener.accept())
                            .await
                            .is_err()
                    );
                }
            });
            let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), transport, address);
            let mut options = SessionOptions::new("synthetic");
            options.transport = transport;
            let mut registry = ToolRegistry::new();
            registry.register(Arc::new(AddNumbers)).unwrap();
            options.tools = registry.definitions();
            let mut executed = 0;
            let mut session = provider.open_session(options).await.unwrap();
            session
                .control
                .generate(vec![InputItem::user("synthetic")])
                .await
                .unwrap();
            loop {
                let envelope = timeout(Duration::from_secs(3), session.events.next())
                    .await
                    .unwrap()
                    .unwrap();
                match envelope.event {
                    ProviderEvent::RequestFailed {
                        code,
                        message,
                        upstream_outcome,
                    } => {
                        assert_eq!(code, "protocol_error");
                        assert_eq!(
                            message,
                            GatewayError::Protocol("invalid finalized output recovery").to_string()
                        );
                        assert_eq!(upstream_outcome, UpstreamOutcome::TerminalReceived);
                        break;
                    }
                    ProviderEvent::ResponseFinished { response } => {
                        let _ = registry
                            .execute_response(&response, |_| executed += 1)
                            .await;
                        panic!("invalid recovery must not finish")
                    }
                    _ => {}
                }
            }
            assert_eq!(executed, 0);
            assert!(
                session
                    .control
                    .generate(vec![InputItem::user("second")])
                    .await
                    .is_err()
            );
            session.control.close();
            timeout(Duration::from_secs(3), server)
                .await
                .unwrap()
                .unwrap();
        }
    }
}
