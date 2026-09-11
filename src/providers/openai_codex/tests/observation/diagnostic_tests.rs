use super::super::observation::{
    BodyClass, MAX_DIAGNOSTIC_TEXT, MediaClass, Observation, SampleState, SmokeCase, SmokeObserver,
    TextState,
};
use super::*;

fn assert_allowlisted_values(value: &Value) {
    match value {
        Value::String(value) => assert!(
            [
                "web_socket",
                "websocket",
                "sse",
                "response.completed",
                "completed",
                "missing",
                "invalid",
                "event_stream",
                "json",
                "html",
                "plain_text",
                "other",
                "empty",
                "json_like",
                "html_like",
                "text_or_other",
                "binary_or_non_utf8",
                "not_sampled",
                "unavailable",
                "complete",
                "read_error",
                "timeout",
                "truncated",
                "sse_prolog_pending",
                "sse_prolog_admitted",
                "sse_prolog_rejected",
                "sse_prolog_timeout",
                "sse_prolog_read_error",
                "sse_prolog_truncated",
                "available",
                "no_ordinary_parts",
                "missing_or_invalid_output",
                "malformed_content",
                "unsupported_kind_or_part",
                "over_limit",
                "no_terminal",
                "no_deltas",
                "not_applicable",
                "not_validated",
                "native_terminal",
                "validated_output_item_done",
            ]
            .contains(&value.as_str())
        ),
        Value::Array(values) => values.iter().for_each(assert_allowlisted_values),
        Value::Object(values) => values.values().for_each(assert_allowlisted_values),
        _ => {}
    }
}

fn terminal_text(parts: &[&str]) -> Value {
    json!({"id":"synthetic-private-id", "status":"completed", "output":[{"type":"message", "content":parts.iter().map(|text| json!({"type":"output_text","text":text})).collect::<Vec<_>>()}]})
}
fn delta(observation: &Observation, text: &str) {
    observation.native(&json!({"type":"response.output_text.delta", "delta":text}));
}

#[test]
fn text_diagnostics_separate_expected_normalized_and_streamed_equality() {
    for (text, stream, changed, expected, consistent, streamed) in [
        (
            "gateway connected",
            "gateway connected",
            false,
            true,
            true,
            true,
        ),
        (
            "synthetic-private-wrong",
            "synthetic-private-wrong",
            false,
            false,
            true,
            true,
        ),
        ("gateway connected", "different", false, true, true, false),
        (
            "gateway connected",
            "gateway connected",
            true,
            true,
            false,
            true,
        ),
        (
            " gateway connected\n",
            " gateway connected\n",
            false,
            true,
            true,
            true,
        ),
    ] {
        let observer = SmokeObserver::default();
        let mut observation =
            Observation::new(observer.clone(), SmokeCase::Text, Transport::WebSocket);
        observation.send(&json!({"input":[]}));
        delta(&observation, stream);
        let native = terminal_text(&[text]);
        observation.native(&json!({"type":"response.completed", "response":native}));
        // Native diagnostics already exist before decoding or smoke acceptance.
        assert_eq!(
            observer.snapshot()[0].native_expected_text_equal,
            Some(expected)
        );
        let mut response = codec::parse_response(native).unwrap();
        if changed {
            response.output[0].native["content"][0]["text"] = json!("altered-normalized");
        }
        observation.terminal(&response);
        let records = observer.snapshot();
        assert_eq!(records[0].normalized_native_text_equal, Some(consistent));
        assert_eq!(records[0].streamed_native_text_equal, Some(streamed));
        let serialized = serde_json::to_string(&records).unwrap();
        assert!(!serialized.contains("private"));
        assert!(!format!("{records:?}").contains("private"));
        assert_allowlisted_values(&serde_json::to_value(&records).unwrap());
        response.text = "altered-text".into();
        observation.terminal(&response);
        assert_eq!(
            observer.snapshot()[0].normalized_native_text_equal,
            Some(false)
        );
    }
}

#[test]
fn text_diagnostics_unavailable_and_request_reset() {
    let observer = SmokeObserver::default();
    let mut observation =
        Observation::new(observer.clone(), SmokeCase::Continuation, Transport::Sse);
    observation.send(&json!({"input":[]}));
    assert_eq!(observer.snapshot()[0].native_expected_text_equal, None);
    delta(&observation, "remembered");
    observation.terminal(&codec::parse_response(terminal_text(&["remembered"])).unwrap());
    observation.send(&json!({"input":[]}));
    observation.terminal(&codec::parse_response(terminal_text(&["lantern"])).unwrap());
    let records = observer.snapshot();
    assert_eq!(records[0].streamed_native_text_equal, Some(true));
    assert_eq!(records[1].native_expected_text_equal, Some(true));
    assert_eq!(records[1].normalized_native_text_equal, Some(true));
    assert_eq!(records[1].streamed_native_text_equal, None);
    assert_eq!(records[1].text_deltas, 0);
    delta(&observation, "lantern");
    observation.terminal(&codec::parse_response(terminal_text(&["lantern"])).unwrap());
    assert_eq!(
        observer.snapshot()[1].streamed_native_text_equal,
        Some(true)
    );

    let observer = SmokeObserver::default();
    let mut observation = Observation::new(observer.clone(), SmokeCase::Tool, Transport::WebSocket);
    observation.send(&json!({"input":[]}));
    observation.terminal(&codec::parse_response(terminal_text(&["42"])).unwrap());
    assert_eq!(observer.snapshot()[0].native_expected_text_equal, None);
    assert_eq!(
        observer.snapshot()[0].native_expected_text_unavailable,
        Some(TextState::NotApplicable)
    );
    observation.send(&json!({"input":[]}));
    observation.terminal(&codec::parse_response(terminal_text(&["42"])).unwrap());
    assert_eq!(
        observer.snapshot()[1].native_expected_text_equal,
        Some(true)
    );
}

#[test]
fn text_diagnostics_reject_malformed_refusal_and_enforce_unicode_bound() {
    for content in [
        json!([{"type":"refusal","refusal":"gateway connected"}]),
        json!([{"type":"output_text","text":null}]),
        json!([{"type":"unknown","text":"gateway connected"}]),
        json!({}),
        json!([]),
    ] {
        let observer = SmokeObserver::default();
        let mut observation =
            Observation::new(observer.clone(), SmokeCase::Text, Transport::WebSocket);
        observation.send(&json!({"input":[]}));
        delta(&observation, "gateway connected");
        observation.native(&json!({"type":"response.completed","response":{"output":[{"type":"message","content":content}]}}));
        let record = &observer.snapshot()[0];
        assert_eq!(record.native_expected_text_equal, None);
        assert_eq!(record.normalized_native_text_equal, None);
        assert_eq!(record.streamed_native_text_equal, None);
    }
    let observer = SmokeObserver::default();
    let mut observation = Observation::new(observer.clone(), SmokeCase::Text, Transport::WebSocket);
    observation.send(&json!({"input":[]}));
    delta(&observation, "hé");
    delta(&observation, "世界");
    observation.terminal(&codec::parse_response(terminal_text(&["h", "é世", "界"])).unwrap());
    assert_eq!(
        observer.snapshot()[0].streamed_native_text_equal,
        Some(true)
    );
    observation.send(&json!({"input":[]}));
    let bounded = "a".repeat(MAX_DIAGNOSTIC_TEXT);
    delta(&observation, &bounded);
    observation.terminal(&codec::parse_response(terminal_text(&[&bounded])).unwrap());
    assert_eq!(
        observer.snapshot()[1].streamed_native_text_equal,
        Some(true)
    );
    delta(&observation, "b");
    observation.terminal(&codec::parse_response(terminal_text(&[&bounded])).unwrap());
    assert_eq!(observer.snapshot()[1].streamed_native_text_equal, None);
    assert_eq!(
        observer.snapshot()[1].streamed_text_state,
        TextState::OverLimit
    );
    assert_eq!(
        observer.snapshot()[1].streamed_native_text_unavailable,
        Some(TextState::OverLimit)
    );
    observation.send(&json!({"input":[]}));
    observation.native(&json!({"type":"response.output_text.delta","delta":null}));
    observation.terminal(&codec::parse_response(terminal_text(&["gateway connected"])).unwrap());
    assert_eq!(observer.snapshot()[2].streamed_native_text_equal, None);
    assert_eq!(
        observer.snapshot()[2].streamed_text_state,
        TextState::MalformedContent
    );
    observation.send(&json!({"input":[]}));
    observation.terminal(&codec::parse_response(terminal_text(&[&bounded, "b"])).unwrap());
    assert_eq!(observer.snapshot()[3].native_expected_text_equal, None);
    assert_eq!(observer.snapshot()[3].normalized_native_text_equal, None);
}

#[tokio::test]
async fn http_diagnostics_classify_actual_rejections_without_disclosure_or_retry() {
    for (status, mime, body, media, class) in [
        (
            200,
            None,
            b"".as_slice(),
            MediaClass::Missing,
            BodyClass::Empty,
        ),
        (
            201,
            Some("application/json; secret=private-header"),
            b"{\"private-body\":1}".as_slice(),
            MediaClass::Json,
            BodyClass::JsonLike,
        ),
        (
            200,
            Some("text/html"),
            b"<html>private-body</html>".as_slice(),
            MediaClass::Html,
            BodyClass::HtmlLike,
        ),
        (
            200,
            Some("text/plain"),
            b"private-body".as_slice(),
            MediaClass::PlainText,
            BodyClass::TextOrOther,
        ),
        (
            200,
            Some("application/octet-stream"),
            b"\x00\xffprivate-body".as_slice(),
            MediaClass::Other,
            BodyClass::BinaryOrNonUtf8,
        ),
        (
            200,
            Some("invalid"),
            b"private-body".as_slice(),
            MediaClass::Invalid,
            BodyClass::TextOrOther,
        ),
        (
            401,
            Some("application/json"),
            b"{}".as_slice(),
            MediaClass::Json,
            BodyClass::JsonLike,
        ),
        (
            403,
            Some("text/html"),
            b"<html>".as_slice(),
            MediaClass::Html,
            BodyClass::HtmlLike,
        ),
        (
            429,
            Some("text/plain"),
            b"private-body".as_slice(),
            MediaClass::PlainText,
            BodyClass::TextOrOther,
        ),
        (
            503,
            Some("text/event-stream"),
            b"private-body".as_slice(),
            MediaClass::EventStream,
            BodyClass::TextOrOther,
        ),
        (
            302,
            Some("text/plain"),
            b"private-body".as_slice(),
            MediaClass::PlainText,
            BodyClass::TextOrOther,
        ),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            read_http(&mut tcp).await;
            let mut headers = format!(
                "HTTP/1.1 {status} Synthetic\r\nContent-Length: {}\r\nLocation: http://{address}/private-location\r\nConnection: close\r\n",
                body.len()
            );
            if let Some(mime) = mime {
                headers.push_str(&format!("Content-Type: {mime}\r\n"));
            }
            headers.push_str("\r\n");
            tcp.write_all(headers.as_bytes()).await.unwrap();
            tcp.write_all(body).await.unwrap();
            drop(tcp);
            assert!(
                timeout(Duration::from_millis(50), listener.accept())
                    .await
                    .is_err()
            );
        });
        let observer = SmokeObserver::default();
        let mut wire = wire::Wire::open(
            Transport::Sse,
            &format!("http://{address}"),
            Arc::new(FakeAuth),
            "synthetic",
            Duration::from_secs(2),
            Some((observer.clone(), SmokeCase::Text)),
        )
        .await
        .unwrap();
        let error = wire
            .send(
                json!({"input":[]}),
                "synthetic",
                &mut UpstreamOutcome::NotSubmitted,
            )
            .await
            .unwrap_err();
        assert_eq!(
            error.code(),
            match status {
                200 | 201 => "unexpected_content_type",
                401 => "unauthorized",
                403 => "forbidden",
                429 => "rate_limited",
                _ => "http_error",
            }
        );
        let records = observer.snapshot();
        let http = records[0].http.as_ref().unwrap();
        assert_eq!(http.status, status);
        assert_eq!(http.media, media);
        assert_eq!(http.body_class, Some(class));
        assert_eq!(
            http.sample_state,
            if media == MediaClass::Missing && status == 200 {
                SampleState::SsePrologRejected
            } else {
                SampleState::Complete
            }
        );
        assert_eq!(records.len(), 1);
        let serialized = serde_json::to_value(&records).unwrap();
        let http_keys = serialized[0]["http"].as_object().unwrap();
        assert_eq!(http_keys.len(), 4);
        assert!(
            http_keys.keys().all(
                |key| ["status", "media", "body_class", "sample_state"].contains(&key.as_str())
            )
        );
        assert!(!serialized.to_string().contains("private"));
        assert_allowlisted_values(&serialized);
        assert!(!format!("{records:?} {error:?}").contains("private"));
        server.await.unwrap();
    }
}

#[tokio::test]
async fn http_diagnostics_bounds_timeout_read_error_invalid_header_and_disabled() {
    for mode in [0, 1, 2, 3, 5, 6, 7, 8, 9] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            read_http(&mut tcp).await;
            let mime = if mode == 5 {
                b"\xff".as_slice()
            } else {
                b"text/plain".as_slice()
            };
            let headers = if mode == 9 {
                b"HTTP/1.1 503 Synthetic\r\nContent-Length: 4096\r\nContent-Type: ".as_slice()
            } else {
                b"HTTP/1.1 503 Synthetic\r\nContent-Length: 10000\r\nContent-Type: ".as_slice()
            };
            tcp.write_all(headers).await.unwrap();
            tcp.write_all(mime).await.unwrap();
            tcp.write_all(b"\r\n\r\n").await.unwrap();
            match mode {
                0 => {
                    tcp.write_all(&vec![b'a'; 4096]).await.unwrap();
                    tokio::time::sleep(Duration::from_millis(1100)).await;
                }
                9 => tcp.write_all(&vec![b'a'; 4096]).await.unwrap(),
                1 | 3 => tokio::time::sleep(Duration::from_millis(1300)).await,
                6..=8 => {
                    let prefix = if mode == 7 {
                        b"<html>private-prefix".as_slice()
                    } else {
                        b"{\"private-prefix\":".as_slice()
                    };
                    tcp.write_all(prefix).await.unwrap();
                    tokio::time::sleep(Duration::from_millis(if mode == 8 { 100 } else { 1300 }))
                        .await;
                }
                _ => {}
            }
        });
        let observer = SmokeObserver::default();
        let enabled = mode != 3;
        let mut wire = wire::Wire::open(
            Transport::Sse,
            &format!("http://{address}"),
            Arc::new(FakeAuth),
            "synthetic",
            Duration::from_secs(2),
            enabled.then_some((observer.clone(), SmokeCase::Text)),
        )
        .await
        .unwrap();
        let started = std::time::Instant::now();
        let error = wire
            .send(
                json!({"input":[]}),
                "synthetic",
                &mut UpstreamOutcome::NotSubmitted,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), "http_error");
        if enabled {
            let records = observer.snapshot();
            let http = records[0].http.as_ref().unwrap();
            assert_eq!(http.status, 503);
            assert_eq!(
                http.sample_state,
                match mode {
                    0 | 9 => SampleState::Truncated,
                    1 | 6 | 7 => SampleState::Timeout,
                    _ => SampleState::ReadError,
                }
            );
            if mode == 0 || mode == 9 {
                assert_eq!(http.body_class, Some(BodyClass::TextOrOther));
            } else if mode >= 6 {
                assert_eq!(
                    http.body_class,
                    Some(if mode == 7 {
                        BodyClass::HtmlLike
                    } else {
                        BodyClass::JsonLike
                    })
                );
            } else {
                assert_eq!(http.body_class, None);
            }
            if mode == 5 {
                assert_eq!(http.media, MediaClass::Invalid);
            }
        } else {
            assert!(observer.snapshot().is_empty());
            assert!(started.elapsed() < Duration::from_millis(800));
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn http_diagnostics_cancellation_retains_receipt_with_unavailable_sample() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        read_http(&mut tcp).await;
        tcp.write_all(
            b"HTTP/1.1 503 Synthetic\r\nContent-Length: 10000\r\nContent-Type: text/plain\r\n\r\n",
        )
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
    timeout(Duration::from_millis(800), async {
        loop {
            if observer
                .snapshot()
                .first()
                .is_some_and(|record| record.http.is_some())
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
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
    let records = observer.snapshot();
    let http = records[0].http.as_ref().unwrap();
    assert_eq!(http.status, 503);
    assert_eq!(http.sample_state, SampleState::Unavailable);
    assert_eq!(http.body_class, None);
    timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn http_diagnostics_accepted_sse_does_not_sample_body() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let release = Arc::new(tokio::sync::Notify::new());
    let ready = release.clone();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        read_http(&mut tcp).await;
        tcp.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; private-header=secret\r\nConnection: close\r\n\r\n").await.unwrap();
        ready.notified().await;
        tcp.write_all(
            b"data: {\"type\":\"response.created\",\"response\":{\"id\":\"synthetic\"}}\n\n",
        )
        .await
        .unwrap();
    });
    let observer = SmokeObserver::default();
    let mut wire = wire::Wire::open(
        Transport::Sse,
        &format!("http://{address}"),
        Arc::new(FakeAuth),
        "synthetic",
        Duration::from_secs(2),
        Some((observer.clone(), SmokeCase::Text)),
    )
    .await
    .unwrap();
    timeout(
        Duration::from_millis(800),
        wire.send(
            json!({"input":[]}),
            "synthetic",
            &mut UpstreamOutcome::NotSubmitted,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    let records = observer.snapshot();
    let http = records[0].http.as_ref().unwrap();
    assert_eq!(http.status, 200);
    assert_eq!(http.media, MediaClass::EventStream);
    assert_eq!(http.sample_state, SampleState::NotSampled);
    assert_eq!(http.body_class, None);
    release.notify_one();
    assert_eq!(
        wire.receive().await.unwrap().unwrap()["type"],
        "response.created"
    );
    server.await.unwrap();
}
