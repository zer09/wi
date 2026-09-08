//! Demonstrates a plugin that does NOT import any OpenAI module or credential.
use async_trait::async_trait;
use futures_util::StreamExt;
use std::sync::Arc;
use tokio::sync::mpsc;
use wi::*;

struct EchoProvider;
struct EchoControl {
    tx: mpsc::Sender<EventEnvelope>,
}
#[async_trait]
impl SessionControl for EchoControl {
    async fn generate(&self, input: Vec<InputItem>) -> Result<RequestReceipt> {
        validate_input(&input)?;
        let text = match &input[0] {
            InputItem::User { text } => text.clone(),
            _ => String::new(),
        };
        self.tx
            .send(EventEnvelope {
                schema_version: 1,
                sequence: 1,
                event_id: "e1".into(),
                session_id: "s1".into(),
                request_id: Some("q1".into()),
                provider: "echo".into(),
                provider_sequence: None,
                event: ProviderEvent::ResponseFinished {
                    response: ModelResponse {
                        output_provenance: Default::default(),
                        id: "r1".into(),
                        model: None,
                        outcome: ResponseOutcome::Completed,
                        output: vec![],
                        text,
                        usage: None,
                        native: serde_json::Value::Null,
                    },
                },
            })
            .await
            .map_err(|_| GatewayError::SessionClosed)?;
        Ok(RequestReceipt {
            request_id: "q1".into(),
        })
    }
    fn close(&self) {}
}
#[async_trait]
impl Provider for EchoProvider {
    fn id(&self) -> &'static str {
        "echo"
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let cap = || Capability {
            implemented: false,
            verification: "not_applicable".into(),
        };
        ProviderCapabilities {
            websocket: cap(),
            sse: cap(),
            continuation: cap(),
            function_tools: cap(),
            advanced: vec![],
        }
    }
    async fn open_session(&self, _: SessionOptions) -> Result<ProviderSession> {
        let (tx, mut rx) = mpsc::channel(2);
        Ok(ProviderSession {
            id: "s1".into(),
            control: Arc::new(EchoControl { tx }),
            events: Box::pin(async_stream::stream! {
                while let Some(event) = rx.recv().await { yield event; }
            }),
        })
    }
}
#[tokio::test]
async fn gateway_accepts_independent_provider_plugin() {
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(EchoProvider)).unwrap();
    let mut session = gateway
        .open_session("echo", SessionOptions::new("echo-model"))
        .await
        .unwrap();
    let receipt = session
        .control
        .generate(vec![InputItem::user("hello")])
        .await
        .unwrap();
    let event = session.events.next().await.unwrap();
    assert_eq!(
        event.request_id.as_deref(),
        Some(receipt.request_id.as_str())
    );
    assert!(
        matches!(event.event, ProviderEvent::ResponseFinished { response } if response.text == "hello")
    );
}
#[test]
fn duplicate_provider_does_not_replace_original() {
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(EchoProvider)).unwrap();
    assert!(matches!(
        gateway.register(Arc::new(EchoProvider)),
        Err(GatewayError::DuplicateProvider)
    ));
}
#[tokio::test]
async fn unknown_provider_is_rejected() {
    assert!(matches!(
        Gateway::new()
            .open_session("absent", SessionOptions::new("test"))
            .await,
        Err(GatewayError::UnknownProvider)
    ));
}
#[test]
fn input_and_session_limits_are_checked() {
    assert!(SessionOptions::new("").validate().is_err());
    assert!(validate_input(&[]).is_err());
    assert!(validate_input(&[InputItem::user("x".repeat(MAX_INPUT_BYTES + 1))]).is_err());
    let mut o = SessionOptions::new("test");
    o.tools.push(wi::tools::add_numbers_definition());
    o.tools.push(wi::tools::add_numbers_definition());
    assert!(o.validate().is_err());
}
