use super::*;
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
            let response = collect(&mut session, "request", mode).await.unwrap();
            assert_eq!(response.text, text);
            assert_eq!(response.native["opaque"], "provider-owned");
        }
    }
}
#[tokio::test]
async fn collect_preserves_correlation_failure_and_eof() {
    for mode in [false, true] {
        assert!(
            collect(&mut session(vec![terminal("answer")]), "wrong", mode)
                .await
                .is_err()
        );
        assert!(
            collect(&mut session(vec![]), "request", mode)
                .await
                .is_err()
        );
        assert!(
            collect(
                &mut session(vec![ProviderEvent::RequestFailed {
                    code: "protocol_error".into(),
                    message: "synthetic failure".into(),
                    upstream_outcome: wi::UpstreamOutcome::TerminalReceived,
                }]),
                "request",
                mode
            )
            .await
            .is_err()
        );
    }
}
