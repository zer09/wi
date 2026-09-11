//! Public-session proofs with synthetic native streams on both transports.
use super::*;
use crate::{DeltaKind, OutputProvenance};

#[path = "../harness/consistency_loopback.rs"]
mod harness;
use harness::*;

fn message(id: &str, text: &str) -> Value {
    json!({"type":"message","id":id,"content":[{"type":"output_text","text":text}]})
}
fn call() -> Value {
    json!({"type":"function_call","id":"item","call_id":"call","name":"add_numbers","arguments":"{\"a\":17,\"b\":25}"})
}
fn delta(id: &str, index: usize, content: usize, text: &str) -> Value {
    json!({"type":"response.output_text.delta","item_id":id,"output_index":index,"content_index":content,"delta":text})
}
fn done(index: usize, item: Value) -> Value {
    json!({"type":"response.output_item.done","output_index":index,"item":item})
}
fn terminal(id: &str, output: Vec<Value>) -> Value {
    json!({"type":"response.completed","response":{"id":id,"status":"completed","output":output,"opaque":"preserved"}})
}
fn started(mut events: Vec<Value>) -> Vec<Value> {
    events.insert(0, json!({"type":"response.created","response":{"id":"r1"}}));
    events
}

#[tokio::test]
async fn consistency_public_session_rejects_before_publication_execution_or_next_send() {
    let changed = terminal("r1", vec![message("m", "different"), call()]);
    let mut refusal = delta("m", 0, 0, "refused");
    refusal["type"] = json!("response.refusal.delta");
    let mut enriched = message("m", "answer");
    enriched["metadata"] = json!({"extra":true});
    let mut no_id = message("m", "answer");
    no_id.as_object_mut().unwrap().remove("id");
    let mut changed_call = call();
    changed_call["arguments"] = json!("{\"a\":1,\"b\":2}");
    let mut part_kind = delta("m", 0, 0, "answer");
    part_kind["type"] = json!("response.refusal.delta");
    let mut missing_content = delta("m", 0, 0, "answer");
    missing_content
        .as_object_mut()
        .unwrap()
        .remove("content_index");
    let cases = vec![
        (
            "empty delta without finalized recovery",
            vec![delta("m", 0, 0, ""), terminal("r1", vec![])],
            true,
        ),
        (
            "discarded text",
            vec![delta("m", 0, 0, "visible"), terminal("r1", vec![])],
            true,
        ),
        (
            "changed text",
            vec![delta("m", 0, 0, "visible"), changed.clone()],
            true,
        ),
        (
            "discarded message",
            vec![
                done(0, message("m", "visible")),
                terminal("r1", vec![call()]),
            ],
            true,
        ),
        (
            "discarded call",
            vec![
                done(0, call()),
                terminal("r1", vec![message("m", "answer")]),
            ],
            true,
        ),
        (
            "changed finalized text",
            vec![done(0, message("m", "visible")), changed.clone()],
            true,
        ),
        (
            "changed finalized call",
            vec![done(0, call()), terminal("r1", vec![changed_call])],
            true,
        ),
        (
            "metadata enrichment",
            vec![
                done(0, message("m", "answer")),
                terminal("r1", vec![enriched]),
            ],
            true,
        ),
        (
            "terminal identity",
            vec![
                delta("m", 0, 0, "ans"),
                terminal("r1", vec![message("other", "answer")]),
            ],
            true,
        ),
        (
            "index identity",
            vec![delta("m", 0, 0, "ans"), done(1, message("m", "answer"))],
            false,
        ),
        (
            "item identity",
            vec![delta("m", 0, 0, "ans"), done(0, message("other", "answer"))],
            false,
        ),
        ("missing identity", vec![done(0, no_id)], false),
        ("refusal loss", vec![refusal, changed.clone()], true),
        (
            "part type conflict",
            vec![delta("m", 0, 0, "ans"), part_kind],
            false,
        ),
        (
            "stream item type",
            vec![
                done(0, json!({"type":"reasoning","id":"m","summary":[]})),
                delta("m", 0, 0, "ans"),
            ],
            false,
        ),
        (
            "terminal item type",
            vec![
                delta("m", 0, 0, "ans"),
                terminal(
                    "r1",
                    vec![json!({"type":"reasoning","id":"m","summary":[]})],
                ),
            ],
            true,
        ),
        ("missing content index", vec![missing_content], false),
        (
            "item index bound",
            vec![done(512, message("m", "answer"))],
            false,
        ),
        (
            "content index bound",
            vec![delta("m", 0, 512, "ans")],
            false,
        ),
        (
            "byte bound",
            vec![done(0, message("m", &"a".repeat(300_000))); 4],
            false,
        ),
        (
            "finalized bound",
            vec![done(0, message("m", "")); 513],
            false,
        ),
        (
            "event bound",
            vec![delta("m", 0, 0, ""); super::super::consistency::MAX_EVENTS + 1],
            false,
        ),
    ];
    for (name, events, received) in cases {
        for transport in [Transport::WebSocket, Transport::Sse] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let events = started(events.clone());
            let (stop, stopped) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                if transport == Transport::WebSocket {
                    let mut socket = accept(listener).await;
                    incoming(&mut socket).await;
                    for event in events {
                        if socket
                            .send(Message::Text(event.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    while let Some(Ok(frame)) = socket.next().await {
                        assert!(!frame.is_text(), "unexpected second submission");
                    }
                } else {
                    let (mut tcp, _) = listener.accept().await.unwrap();
                    read_http(&mut tcp).await;
                    http_events(&mut tcp, events).await;
                    tokio::select! {
                        _ = listener.accept() => panic!("unexpected second submission"),
                        _ = stopped => {}
                    }
                }
            });
            let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), transport, address);
            let mut options = SessionOptions::new("synthetic");
            options.transport = transport;
            let mut registry = ToolRegistry::new();
            registry.register(Arc::new(AddNumbers)).unwrap();
            options.tools = registry.definitions();
            let mut session = provider.open_session(options).await.unwrap();
            let receipt = session
                .control
                .generate(vec![InputItem::user("synthetic")])
                .await
                .unwrap();
            let mut executed = 0;
            loop {
                let event = timeout(Duration::from_secs(5), session.events.next())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    event.request_id.as_deref(),
                    Some(receipt.request_id.as_str())
                );
                match event.event {
                    ProviderEvent::RequestFailed {
                        code,
                        upstream_outcome,
                        ..
                    } => {
                        assert_eq!(code, "protocol_error", "{name}");
                        assert_eq!(
                            upstream_outcome,
                            if received {
                                UpstreamOutcome::TerminalReceived
                            } else {
                                UpstreamOutcome::Unknown
                            },
                            "{name}"
                        );
                        break;
                    }
                    ProviderEvent::ResponseFinished { response } => {
                        let _ = registry
                            .execute_response(&response, |_| executed += 1)
                            .await;
                        panic!("{name}: invalid response was published");
                    }
                    // An event rejected by observe must never be forwarded.
                    ProviderEvent::OutputItemUpdated {
                        kind: DeltaKind::Refusal,
                        ..
                    } if name == "part type conflict" => panic!("conflicting delta forwarded"),
                    ProviderEvent::OutputItemFinished {
                        output_index: 512, ..
                    } => panic!("out-of-bounds item forwarded"),
                    _ => {}
                }
            }
            assert_eq!(executed, 0, "{name}");
            assert!(
                session
                    .control
                    .generate(vec![InputItem::user("second")])
                    .await
                    .is_err(),
                "{name}"
            );
            session.control.close();
            let _ = stop.send(());
            timeout(Duration::from_secs(5), server)
                .await
                .unwrap()
                .unwrap();
        }
    }
}

#[tokio::test]
async fn consistency_public_session_accepts_effective_output_and_resets_each_request() {
    let mut first = message("m", "AD");
    first["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"output_text","text":"E"}));
    let mut refusal = delta("m", 0, 0, "no");
    refusal["type"] = json!("response.refusal.delta");
    let cases = vec![
        (vec![terminal("r1", vec![])], "", false),
        (
            vec![terminal("r1", vec![message("m", "answer")])],
            "answer",
            false,
        ),
        (
            started(vec![
                delta("m", 0, 0, "ans"),
                terminal("r1", vec![message("m", "answer")]),
            ]),
            "answer",
            false,
        ),
        (
            started(vec![
                delta("m", 0, 0, "answer"),
                done(0, message("m", "answer")),
                terminal("r1", vec![message("m", "answer")]),
            ]),
            "answer",
            false,
        ),
        (
            started(vec![
                delta("m", 0, 0, "ans"),
                done(0, message("m", "answer")),
                terminal("r1", vec![]),
            ]),
            "answer",
            true,
        ),
        (
            started(vec![done(0, call()), terminal("r1", vec![])]),
            "",
            true,
        ),
        (
            started(vec![done(0, call()), terminal("r1", vec![call()])]),
            "",
            false,
        ),
        (
            started(vec![
                delta("second", 1, 0, "B"),
                delta("m", 0, 1, "E"),
                delta("m", 0, 0, "A"),
                terminal("r1", vec![first, message("second", "BC")]),
            ]),
            "ADEBC",
            false,
        ),
        (
            started(vec![
                refusal,
                terminal(
                    "r1",
                    vec![
                        json!({"type":"message","id":"m","content":[{"type":"refusal","refusal":"no thanks"}]}),
                    ],
                ),
            ]),
            "no thanks",
            false,
        ),
        (
            started(vec![
                delta("m", 0, 0, ""),
                terminal("r1", vec![message("m", "")]),
            ]),
            "",
            false,
        ),
    ];
    for (events, text, recovered) in cases {
        for transport in [Transport::WebSocket, Transport::Sse] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let events = events.clone();
            let server = tokio::spawn(async move {
                if transport == Transport::WebSocket {
                    let mut socket = accept(listener).await;
                    incoming(&mut socket).await;
                    for event in events {
                        send(&mut socket, event).await;
                    }
                    let next = incoming(&mut socket).await;
                    assert_eq!(next["previous_response_id"], "r1");
                    send(&mut socket, terminal("r2", vec![])).await;
                    while let Some(Ok(frame)) = socket.next().await {
                        assert!(!frame.is_text());
                    }
                } else {
                    let (mut tcp, _) = listener.accept().await.unwrap();
                    read_http(&mut tcp).await;
                    http_events(&mut tcp, events).await;
                    let (mut tcp, _) = listener.accept().await.unwrap();
                    read_http(&mut tcp).await;
                    http_events(&mut tcp, vec![terminal("r2", vec![])]).await;
                }
            });
            let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), transport, address);
            let mut options = SessionOptions::new("synthetic");
            options.transport = transport;
            let mut registry = ToolRegistry::new();
            registry.register(Arc::new(AddNumbers)).unwrap();
            options.tools = registry.definitions();
            let mut session = provider.open_session(options).await.unwrap();
            let receipt = session
                .control
                .generate(vec![InputItem::user("synthetic")])
                .await
                .unwrap();
            let first = response(&mut session, &receipt.request_id).await;
            assert_eq!(first.text, text);
            assert_eq!(first.native["opaque"], "preserved");
            assert_eq!(
                first.output_provenance,
                if recovered {
                    OutputProvenance::ValidatedOutputItemDone
                } else {
                    OutputProvenance::NativeTerminal
                }
            );
            if recovered {
                assert_eq!(first.native["output"], json!([]));
            }
            let next = if first.output.iter().any(|item| item.function_call.is_some()) {
                registry.execute_response(&first, |_| {}).await.unwrap()
            } else {
                vec![InputItem::user("second")]
            };
            let receipt = session.control.generate(next).await.unwrap();
            let second = response(&mut session, &receipt.request_id).await;
            assert!(second.output.is_empty());
            assert!(second.text.is_empty());
            session.control.close();
            timeout(Duration::from_secs(5), server)
                .await
                .unwrap()
                .unwrap();
        }
    }
}
