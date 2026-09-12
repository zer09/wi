use super::presentation_tests::{Captured, FRAGMENTS, GOLDEN};
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use wi::{EventEnvelope, RequestReceipt, SessionControl};

struct Control;
#[async_trait::async_trait]
impl SessionControl for Control {
    async fn generate(&self, _: Vec<InputItem>) -> Result<RequestReceipt> {
        unreachable!("collect must not submit requests")
    }
    fn close(&self) {}
}
fn session(events: Vec<ProviderEvent>) -> ProviderSession {
    ProviderSession {
        id: "session".into(),
        control: Arc::new(Control),
        events: Box::pin(futures_util::stream::iter(
            events
                .into_iter()
                .enumerate()
                .map(|(sequence, event)| EventEnvelope {
                    schema_version: 1,
                    sequence: sequence as u64,
                    event_id: "event".into(),
                    session_id: "session".into(),
                    request_id: Some("request".into()),
                    provider: "synthetic".into(),
                    provider_sequence: None,
                    event,
                }),
        )),
    }
}
fn terminal(text: &str) -> ProviderEvent {
    ProviderEvent::ResponseFinished {
        response: ModelResponse {
            id: "response".into(),
            model: None,
            outcome: ResponseOutcome::Completed,
            output_provenance: Default::default(),
            output: vec![],
            text: text.into(),
            usage: None,
            native: serde_json::json!({"opaque":"provider-owned"}),
        },
    }
}
fn delta(kind: DeltaKind, text: &str) -> ProviderEvent {
    ProviderEvent::OutputItemUpdated {
        response_id: "response".into(),
        item_id: "message".into(),
        output_index: 0,
        content_index: Some(0),
        summary_index: None,
        kind,
        delta: text.into(),
    }
}

#[tokio::test]
async fn r1_a01_legacy_multiline_branches_preserve_raw_response_and_json() {
    for &(raw, plain) in GOLDEN {
        for branch in 0..5 {
            let (events, expected, flushes) = match branch {
                0 => (vec![terminal(raw)], format!("{plain}\n"), 2),
                1 | 2 => {
                    let kind = if branch == 1 {
                        DeltaKind::Text
                    } else {
                        DeltaKind::Refusal
                    };
                    (
                        vec![delta(kind, raw), terminal(raw)],
                        format!("{plain}\n"),
                        3,
                    )
                }
                3 => (
                    vec![
                        delta(DeltaKind::Text, "prefix\x1b\u{009b}"),
                        terminal(&format!("prefix\x1b\u{009b}{raw}")),
                    ],
                    format!("prefix{plain}\n"),
                    3,
                ),
                4 => (
                    vec![delta(DeltaKind::Refusal, "provisional\x07"), terminal(raw)],
                    format!("provisional\n[Authoritative final response]\n{plain}\n"),
                    4,
                ),
                _ => unreachable!(),
            };
            let mut events = events;
            let Some(ProviderEvent::ResponseFinished { response }) = events.last_mut() else {
                panic!("missing fixture terminal")
            };
            response.native = serde_json::json!({"opaque": raw});
            let expected_response = serde_json::to_value(response).unwrap();
            for json in [false, true] {
                let expected_events: Vec<_> = session(events.clone()).events.collect().await;
                let mut session = session(events.clone());
                let mut out = Captured::default();
                let response = collect_to(&mut session, "request", json, &mut out)
                    .await
                    .unwrap();
                assert_eq!(serde_json::to_value(response).unwrap(), expected_response);
                if json {
                    let decoded: Vec<serde_json::Value> = String::from_utf8(out.bytes)
                        .unwrap()
                        .lines()
                        .map(|line| {
                            let _: EventEnvelope = serde_json::from_str(line).unwrap();
                            serde_json::from_str(line).unwrap()
                        })
                        .collect();
                    assert_eq!(
                        serde_json::to_value(decoded).unwrap(),
                        serde_json::to_value(expected_events).unwrap()
                    );
                    assert_eq!(out.flushes, 0);
                } else {
                    assert_eq!(
                        String::from_utf8(out.bytes).unwrap(),
                        expected,
                        "A-01 branch {branch}, raw {raw:?}"
                    );
                    assert_eq!(out.flushes, flushes, "branch {branch}");
                }
            }
        }
    }
}

#[tokio::test]
async fn r1_a01_legacy_split_sequences_and_raw_prefix_comparison() {
    let raw: String = FRAGMENTS.iter().map(|(raw, _)| *raw).collect();
    let plain: String = FRAGMENTS.iter().map(|(_, plain)| *plain).collect();
    for kind in [DeltaKind::Text, DeltaKind::Refusal] {
        for split in [false, true] {
            let deltas = if split {
                FRAGMENTS
                    .iter()
                    .map(|(raw, _)| delta(kind, raw))
                    .collect::<Vec<_>>()
            } else {
                vec![delta(kind, &raw)]
            };
            let count = deltas.len();
            let mut events = deltas;
            events.push(terminal(&raw));
            let mut out = Captured::default();
            collect_to(&mut session(events), "request", false, &mut out)
                .await
                .unwrap();
            assert_eq!(String::from_utf8(out.bytes).unwrap(), format!("{plain}\n"));
            assert_eq!(out.flushes, count + 2);
        }
    }
    // Equal displayed prefixes can still disagree in raw model text.
    for (provisional, final_text, expected) in [
        ("é\x1b\u{009b}", "é\x1b\u{009b}\n\t雪", "é\n\t雪\n"),
        (
            "é\x1b",
            "é\n\t雪",
            "é\n[Authoritative final response]\né\n\t雪\n",
        ),
        (
            "é",
            "\x1bé\n\t雪",
            "é\n[Authoritative final response]\né\n\t雪\n",
        ),
    ] {
        let mut out = Captured::default();
        let response = collect_to(
            &mut session(vec![
                delta(DeltaKind::Text, provisional),
                terminal(final_text),
            ]),
            "request",
            false,
            &mut out,
        )
        .await
        .unwrap();
        assert_eq!(response.text, final_text);
        assert_eq!(String::from_utf8(out.bytes).unwrap(), expected);
    }
}

struct Broken {
    kind: io::ErrorKind,
    fail_at: usize,
    on_flush: bool,
    writes: usize,
    flushes: usize,
    failed: bool,
    operations_after_failure: usize,
}
impl Write for Broken {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.operations_after_failure += usize::from(self.failed);
        let fail = !self.on_flush && self.writes == self.fail_at;
        self.writes += 1;
        if fail {
            self.failed = true;
            return Err(io::Error::from(self.kind));
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.operations_after_failure += usize::from(self.failed);
        let fail = self.on_flush && self.flushes == self.fail_at;
        self.flushes += 1;
        if fail {
            self.failed = true;
            return Err(io::Error::from(self.kind));
        }
        Ok(())
    }
}

#[tokio::test]
async fn r1_a01_legacy_writer_errors_stop_each_output_branch() {
    for kind in [
        io::ErrorKind::BrokenPipe,
        io::ErrorKind::WouldBlock,
        io::ErrorKind::Other,
    ] {
        for on_flush in [false, true] {
            for (events, fail_at, consumed) in [
                (
                    vec![delta(DeltaKind::Text, "a\x1b"), terminal("a\x1b")],
                    0,
                    1,
                ),
                (
                    vec![delta(DeltaKind::Refusal, "a\x1b"), terminal("a\x1b")],
                    0,
                    1,
                ),
                (vec![terminal("a\x1b")], 0, 1),
                (
                    vec![delta(DeltaKind::Text, "a\x1b"), terminal("a\x1bb\x07")],
                    1,
                    2,
                ),
                (
                    vec![delta(DeltaKind::Text, "a\x1b"), terminal("b\x07")],
                    1,
                    2,
                ),
                (
                    vec![delta(DeltaKind::Text, "a\x1b"), terminal("b\x07")],
                    2,
                    2,
                ),
                (
                    vec![delta(DeltaKind::Text, "a\x1b"), terminal("b\x07")],
                    3,
                    2,
                ),
            ] {
                let mut events = events;
                events.push(terminal("must not consume"));
                let polled = Arc::new(AtomicUsize::new(0));
                let observed = polled.clone();
                let mut session = session(events);
                session.events = Box::pin(session.events.inspect(move |_| {
                    observed.fetch_add(1, Ordering::SeqCst);
                }));
                let mut out = Broken {
                    kind,
                    fail_at,
                    on_flush,
                    writes: 0,
                    flushes: 0,
                    failed: false,
                    operations_after_failure: 0,
                };
                let result = collect_to(&mut session, "request", false, &mut out).await;
                assert!(matches!(result, Err(GatewayError::Io(error)) if error == kind));
                assert_eq!(polled.load(Ordering::SeqCst), consumed);
                assert_eq!(out.operations_after_failure, 0);
                assert_eq!(out.flushes, fail_at + usize::from(on_flush));
            }
        }
    }
}

#[tokio::test]
async fn collect_preserves_terminal_only_suffix_and_authoritative_fallback() {
    for mode in [false, true] {
        for (delta, text) in [
            ("", ""),
            ("", "answer"),
            ("ans", "answer"),
            ("BEA", "ADEBC"),
        ] {
            let mut session = session(vec![
                ProviderEvent::OutputItemUpdated {
                    response_id: "response".into(),
                    item_id: "message".into(),
                    output_index: 0,
                    content_index: Some(0),
                    summary_index: None,
                    kind: DeltaKind::Text,
                    delta: delta.into(),
                },
                terminal(text),
            ]);
            let response = collect_to(&mut session, "request", mode, &mut Vec::new())
                .await
                .unwrap();
            assert_eq!(response.text, text);
            assert_eq!(response.native["opaque"], "provider-owned");
        }
    }
}
#[tokio::test]
async fn request_failed_diagnostic_is_one_line_and_raw_json_is_unchanged() {
    let message = "\x1b[31mline\n\tindented\u{009b}tail";
    for json_mode in [false, true] {
        let mut session = session(vec![ProviderEvent::RequestFailed {
            code: "protocol_error".into(),
            message: message.into(),
            upstream_outcome: wi::UpstreamOutcome::TerminalReceived,
        }]);
        let mut out = Captured::default();
        let mut diagnostics = Captured::default();
        let result = collect_to_with_diagnostics(
            &mut session,
            "request",
            json_mode,
            &mut out,
            &mut diagnostics,
        )
        .await;

        assert!(matches!(result, Err(GatewayError::ProviderFailed)));
        assert_eq!(
            String::from_utf8(diagnostics.bytes).unwrap(),
            "[31mlineindentedtail\n"
        );
        assert_eq!(diagnostics.flushes, 0);
        if json_mode {
            let envelope: EventEnvelope = serde_json::from_slice(&out.bytes).unwrap();
            let ProviderEvent::RequestFailed {
                code,
                message: actual_message,
                upstream_outcome,
            } = envelope.event
            else {
                panic!("expected request failure")
            };
            assert_eq!(code, "protocol_error");
            assert_eq!(actual_message, message);
            assert_eq!(upstream_outcome, wi::UpstreamOutcome::TerminalReceived);
        } else {
            assert!(out.bytes.is_empty());
        }
    }
}

#[tokio::test]
async fn collect_preserves_correlation_failure_and_eof() {
    for mode in [false, true] {
        assert!(
            collect_to(
                &mut session(vec![terminal("answer")]),
                "wrong",
                mode,
                &mut Vec::new(),
            )
            .await
            .is_err()
        );
        assert!(
            collect_to(&mut session(vec![]), "request", mode, &mut Vec::new())
                .await
                .is_err()
        );
        assert!(
            collect_to(
                &mut session(vec![ProviderEvent::RequestFailed {
                    code: "protocol_error".into(),
                    message: "synthetic failure".into(),
                    upstream_outcome: wi::UpstreamOutcome::TerminalReceived,
                }]),
                "request",
                mode,
                &mut Vec::new(),
            )
            .await
            .is_err()
        );
    }
}
