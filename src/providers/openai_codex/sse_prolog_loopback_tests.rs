use super::super::observation::{
    FOLLOW_UP, MediaClass, OpaqueReplay, SampleState, SmokeCase, SmokeObserver, required_proof,
};
use super::*;

fn start(id: &str) -> Value {
    json!({"type":"response.created","response":{"id":id}})
}
fn terminal(id: &str, output: Value) -> Value {
    json!({"type":"response.completed","response":{"id":id,"status":"completed","output":output}})
}
fn message(text: &str) -> Value {
    json!({"type":"message","id":"m","content":[{"type":"output_text","text":text}]})
}
fn frames(values: &[Value]) -> Vec<u8> {
    values
        .iter()
        .map(|value| format!("data: {value}\n\n"))
        .collect::<String>()
        .into_bytes()
}
async fn reply(tcp: &mut TcpStream, body: &[u8]) {
    tcp.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    tcp.write_all(body).await.unwrap();
    tcp.shutdown().await.unwrap();
}
async fn open_wire(address: std::net::SocketAddr, observer: Option<SmokeObserver>) -> wire::Wire {
    wire::Wire::open(
        Transport::Sse,
        &format!("http://{address}"),
        Arc::new(FakeAuth),
        "synthetic",
        Duration::from_secs(2),
        observer.map(|o| (o, SmokeCase::Text)),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn missing_mime_loopback_proof_before_eof_replays_partial_tail_once_observer_on_off() {
    for enabled in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let release = Arc::new(tokio::sync::Notify::new());
        let ready = release.clone();
        let values = vec![
            start("private"),
            json!({"type":"future1"}),
            json!({"type":"future2"}),
            terminal("private", json!([])),
        ];
        let expected = values.clone();
        let server = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            read_http(&mut tcp).await;
            tcp.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            let mut bytes = frames(&values[..3]);
            let tail = frames(&values[3..]);
            let split = tail.len() / 2;
            bytes.extend(&tail[..split]);
            tcp.write_all(&bytes).await.unwrap();
            ready.notified().await;
            tcp.write_all(&tail[split..]).await.unwrap();
        });
        let observer = SmokeObserver::default();
        let mut wire = open_wire(address, enabled.then_some(observer.clone())).await;
        let mut upstream = UpstreamOutcome::NotSubmitted;
        timeout(
            Duration::from_secs(1),
            wire.send(json!({"input":[]}), "synthetic", &mut upstream),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(upstream, UpstreamOutcome::Unknown);
        for value in &expected[..3] {
            assert_eq!(wire.receive().await.unwrap().as_ref(), Some(value));
        }
        release.notify_one();
        assert_eq!(wire.receive().await.unwrap().as_ref(), Some(&expected[3]));
        assert!(wire.receive().await.unwrap().is_none());
        let records = observer.snapshot();
        if enabled {
            let http = records[0].http.as_ref().unwrap();
            assert_eq!(http.media, MediaClass::Missing);
            assert_eq!(http.sample_state, SampleState::SsePrologAdmitted);
            assert_eq!(records[0].native_created_count, 0);
            assert!(!serde_json::to_string(&records).unwrap().contains("private"));
        } else {
            assert!(records.is_empty());
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn missing_mime_loopback_s1_s2_s3_keep_required_proof_and_actual_tool_linkage() {
    for case in [SmokeCase::Text, SmokeCase::Continuation, SmokeCase::Tool] {
        for enabled in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut tcp, _) = listener.accept().await.unwrap();
                let first = read_http(&mut tcp).await;
                let text = if case == SmokeCase::Text {
                    "gateway connected"
                } else {
                    "remembered"
                };
                let output = if case == SmokeCase::Tool {
                    json!([{"type":"function_call","id":"fc","call_id":"private-call","name":"add_numbers","arguments":"{\"a\":17,\"b\":25}"}])
                } else {
                    json!([{"type":"reasoning","encrypted_content":"private-opaque","summary":[]}, message(text)])
                };
                let mut values = vec![start("private-first")];
                if case != SmokeCase::Tool {
                    values.push(json!({"type":"response.output_text.delta","item_id":"m","output_index":1,"content_index":0,"delta":text}));
                }
                values.push(terminal("private-first", output.clone()));
                reply(&mut tcp, &frames(&values)).await;
                if case == SmokeCase::Text {
                    return;
                }
                let (mut tcp, _) = listener.accept().await.unwrap();
                let second = read_http(&mut tcp).await;
                let mut expected = first["input"].as_array().unwrap().clone();
                expected.extend(output.as_array().unwrap().clone());
                if case == SmokeCase::Tool {
                    expected.push(json!({"type":"function_call_output","call_id":"private-call","output":"{\"sum\":42}"}));
                } else {
                    expected.push(
                        json!({"role":"user","content":[{"type":"input_text","text":FOLLOW_UP}]}),
                    );
                }
                assert_eq!(second["input"], json!(expected));
                assert!(second.get("previous_response_id").is_none());
                let answer = if case == SmokeCase::Tool {
                    "42"
                } else {
                    "lantern"
                };
                reply(
                    &mut tcp,
                    &frames(&[
                        start("private-second"),
                        terminal("private-second", json!([message(answer)])),
                    ]),
                )
                .await;
            });
            let observer = SmokeObserver::default();
            let mut provider =
                OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::Sse, address);
            if enabled {
                provider = provider.with_smoke_observer(observer.clone(), case);
            }
            let mut registry = ToolRegistry::new();
            registry.register(Arc::new(AddNumbers)).unwrap();
            let mut options = SessionOptions::new("synthetic");
            options.transport = Transport::Sse;
            if case == SmokeCase::Tool {
                options.tools = registry.definitions();
            }
            let mut session = provider.open_session(options).await.unwrap();
            let receipt = session
                .control
                .generate(vec![InputItem::user(case.first_prompt())])
                .await
                .unwrap();
            let first = response(&mut session, &receipt.request_id).await;
            assert_eq!(first.outcome, ResponseOutcome::Completed);
            if case == SmokeCase::Text {
                assert_eq!(first.text, "gateway connected");
            } else {
                let input = if case == SmokeCase::Tool {
                    let call = first.output[0].function_call.as_ref().unwrap();
                    assert_eq!(call.name, "add_numbers");
                    assert_eq!(
                        serde_json::from_str::<Value>(&call.arguments).unwrap(),
                        json!({"a":17,"b":25})
                    );
                    registry.execute_response(&first, |_| {}).await.unwrap()
                } else {
                    assert_eq!(first.text, "remembered");
                    vec![InputItem::user(FOLLOW_UP)]
                };
                let receipt = session.control.generate(input).await.unwrap();
                let second = response(&mut session, &receipt.request_id).await;
                assert_eq!(
                    second.text,
                    if case == SmokeCase::Tool {
                        "42"
                    } else {
                        "lantern"
                    }
                );
                assert_eq!(second.outcome, ResponseOutcome::Completed);
            }
            let records = observer.snapshot();
            if enabled {
                assert!(required_proof(&records, case, Transport::Sse));
                assert_eq!(records.len(), if case == SmokeCase::Text { 1 } else { 2 });
                for record in &records {
                    assert_eq!(record.native_created_count, 1);
                    assert_eq!(record.http.as_ref().unwrap().media, MediaClass::Missing);
                    assert_eq!(
                        record.http.as_ref().unwrap().sample_state,
                        SampleState::SsePrologAdmitted
                    );
                }
                if case == SmokeCase::Continuation {
                    assert_eq!(records[1].opaque_replay, Some(OpaqueReplay::Matched));
                }
                if case == SmokeCase::Tool {
                    assert_eq!(records[1].result_linkage_equal, Some(true));
                }
                assert!(!serde_json::to_string(&records).unwrap().contains("private"));
            } else {
                assert!(records.is_empty());
            }
            session.control.close();
            server.await.unwrap();
        }
    }
}

#[tokio::test]
async fn missing_mime_loopback_cancel_preserves_pending_receipt_and_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        read_http(&mut tcp).await;
        tcp.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10000\r\n\r\n")
            .await
            .unwrap();
        let mut byte = [0];
        assert_eq!(tcp.read(&mut byte).await.unwrap(), 0);
    });
    let observer = SmokeObserver::default();
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::Sse, address)
        .with_smoke_observer(observer.clone(), SmokeCase::Text);
    let mut options = SessionOptions::new("synthetic");
    options.transport = Transport::Sse;
    let mut session = provider.open_session(options).await.unwrap();
    session
        .control
        .generate(vec![InputItem::user("synthetic")])
        .await
        .unwrap();
    timeout(Duration::from_secs(1), async {
        loop {
            if observer
                .snapshot()
                .first()
                .is_some_and(|r| r.http.is_some())
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    session.control.close();
    let event = timeout(Duration::from_secs(1), session.events.next())
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
    assert_eq!(
        observer.snapshot()[0].http.as_ref().unwrap().sample_state,
        SampleState::SsePrologPending
    );
    server.await.unwrap();
}

#[tokio::test]
async fn missing_mime_loopback_wrong_present_mime_and_non_success_never_probe() {
    for status in [200, 401, 403, 429, 503] {
        for mime in [
            None,
            Some("text/plain"),
            Some("application/json"),
            Some("text/html"),
            Some("application/octet-stream"),
            Some(""),
            Some("invalid"),
            Some("\u{00ff}"),
        ] {
            if status == 200 && mime.is_none() {
                continue;
            }
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut tcp, _) = listener.accept().await.unwrap();
                read_http(&mut tcp).await;
                let body = frames(&[start("private")]);
                let mut header = format!(
                    "HTTP/1.1 {status} Synthetic\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                );
                if let Some(mime) = mime {
                    header.push_str(&format!("Content-Type: {mime}\r\n"));
                }
                header.push_str("\r\n");
                tcp.write_all(header.as_bytes()).await.unwrap();
                tcp.write_all(&body).await.unwrap();
                drop(tcp);
                assert!(
                    timeout(Duration::from_millis(20), listener.accept())
                        .await
                        .is_err()
                );
            });
            let observer = SmokeObserver::default();
            let mut wire = open_wire(address, Some(observer.clone())).await;
            let mut upstream = UpstreamOutcome::NotSubmitted;
            let error = wire
                .send(json!({"input":[]}), "synthetic", &mut upstream)
                .await
                .unwrap_err();
            assert_eq!(
                error.code(),
                match status {
                    200 => "unexpected_content_type",
                    401 => "unauthorized",
                    403 => "forbidden",
                    429 => "rate_limited",
                    _ => "http_error",
                }
            );
            assert_eq!(upstream, UpstreamOutcome::Unknown);
            assert_eq!(
                observer.snapshot()[0].http.as_ref().unwrap().sample_state,
                SampleState::Complete
            );
            server.await.unwrap();
        }
    }
}

#[tokio::test]
async fn missing_mime_loopback_decisive_rejection_precedes_observation_with_or_without_observer() {
    for enabled in [false, true] {
        for prefix in [
            "data:\n\n",
            "data: [DONE]\n\n",
            "data: garbage\n\n",
            "data: {\"type\":\"future\"}\n\n",
            "<html>\n",
            "plain\n",
            "\0binary\n",
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut tcp, _) = listener.accept().await.unwrap();
                read_http(&mut tcp).await;
                tcp.write_all(b"HTTP/1.1 202 Accepted\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
                let mut body = prefix.as_bytes().to_vec();
                body.extend(frames(&[start("private"), terminal("private", json!([]))]));
                tcp.write_all(&body).await.unwrap();
                // Leave the stream open until admission closes the body.
                let mut byte = [0];
                assert_eq!(tcp.read(&mut byte).await.unwrap(), 0);
                assert!(
                    timeout(Duration::from_millis(20), listener.accept())
                        .await
                        .is_err()
                );
            });
            let observer = SmokeObserver::default();
            let mut wire = open_wire(address, enabled.then_some(observer.clone())).await;
            let mut upstream = UpstreamOutcome::NotSubmitted;
            let error = timeout(
                Duration::from_secs(1),
                wire.send(json!({"input":[]}), "synthetic", &mut upstream),
            )
            .await
            .unwrap()
            .unwrap_err();
            assert_eq!(error.code(), "unexpected_content_type");
            assert_eq!(upstream, UpstreamOutcome::Unknown);
            let records = observer.snapshot();
            if enabled {
                assert_eq!(records[0].native_created_count, 0);
                assert!(!records[0].validated_terminal);
                assert_eq!(
                    records[0].http.as_ref().unwrap().sample_state,
                    SampleState::SsePrologRejected
                );
            } else {
                assert!(records.is_empty());
            }
            server.await.unwrap();
        }
    }
}

#[tokio::test]
async fn missing_mime_loopback_outer_total_timeout_preserves_pending_receipt() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        read_http(&mut tcp).await;
        tcp.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10000\r\n\r\n: keepalive\n\n")
            .await
            .unwrap();
        let mut byte = [0];
        assert_eq!(tcp.read(&mut byte).await.unwrap(), 0);
    });
    let observer = SmokeObserver::default();
    let mut provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::Sse, address)
        .with_smoke_observer(observer.clone(), SmokeCase::Text);
    provider.timeouts.total = Duration::from_millis(200);
    let mut options = SessionOptions::new("synthetic");
    options.transport = Transport::Sse;
    let mut session = provider.open_session(options).await.unwrap();
    session
        .control
        .generate(vec![InputItem::user("synthetic")])
        .await
        .unwrap();
    let event = timeout(Duration::from_secs(2), session.events.next())
        .await
        .unwrap()
        .unwrap();
    match event.event {
        ProviderEvent::RequestFailed {
            code,
            upstream_outcome,
            ..
        } => {
            assert_eq!(code, "timeout");
            assert_eq!(upstream_outcome, UpstreamOutcome::Unknown);
        }
        _ => panic!("expected timeout"),
    }
    assert_eq!(
        observer.snapshot()[0].http.as_ref().unwrap().sample_state,
        SampleState::SsePrologPending
    );
    server.await.unwrap();
}

#[tokio::test]
async fn missing_mime_loopback_read_error_is_admission_error_without_retry() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        read_http(&mut tcp).await;
        tcp.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10000\r\n\r\n: prefix\n")
            .await
            .unwrap();
    });
    let observer = SmokeObserver::default();
    let mut wire = open_wire(address, Some(observer.clone())).await;
    assert_eq!(
        wire.send(
            json!({"input":[]}),
            "synthetic",
            &mut UpstreamOutcome::NotSubmitted
        )
        .await
        .unwrap_err()
        .code(),
        "unexpected_content_type"
    );
    assert_eq!(
        observer.snapshot()[0].http.as_ref().unwrap().sample_state,
        SampleState::SsePrologReadError
    );
    server.await.unwrap();
}

#[tokio::test]
async fn missing_mime_loopback_replay_response_and_later_frame_limits_exact_and_plus_one() {
    for frame_limit in [false, true] {
        for extra in [0, 1] {
            let mut body = frames(&[start("private")]);
            if frame_limit {
                body.extend(format!(":{}\n\n", "x".repeat(8 * 1024 * 1024 - 3 + extra)).as_bytes());
            } else {
                let target = 32 * 1024 * 1024 + extra;
                while body.len() < target {
                    let count = (target - body.len()).min(1024 * 1024);
                    if count >= 3 {
                        body.extend(format!(":{}\n\n", "x".repeat(count - 3)).as_bytes());
                    } else {
                        body.extend(std::iter::repeat_n(b'\n', count));
                    }
                }
            }
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut tcp, _) = listener.accept().await.unwrap();
                read_http(&mut tcp).await;
                tcp.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
                // The receiver may close as soon as a bound fails.
                let _ = tcp.write_all(&body).await;
            });
            let mut wire = open_wire(address, None).await;
            wire.send(
                json!({"input":[]}),
                "synthetic",
                &mut UpstreamOutcome::NotSubmitted,
            )
            .await
            .unwrap();
            assert_eq!(wire.receive().await.unwrap(), Some(start("private")));
            let result = wire.receive().await;
            if extra == 0 {
                assert!(result.unwrap().is_none());
            } else {
                assert!(matches!(result, Err(GatewayError::StreamTooLarge)));
            }
            drop(wire);
            server.await.unwrap();
        }
    }
}
