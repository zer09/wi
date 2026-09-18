use super::*;
use crate::{
    Capability, ConversationReplay, EventEnvelope, InputItem, ModelResponse, Provider,
    ProviderCapabilities, ProviderEvent, ProviderSession, ReplayIdentity, RequestReceipt,
    ResponseOutcome, SessionControl,
};
use async_trait::async_trait;
use std::{
    collections::VecDeque,
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;

#[derive(Default)]
pub(super) struct Control {
    pub waiting: Notify,
    pub release: Notify,
    pub closes: AtomicUsize,
    generated: Notify,
    pub inputs: Mutex<Vec<Vec<InputItem>>>,
    pub installed: Mutex<Vec<ConversationReplay>>,
}

pub(super) struct Script {
    pub opens: AtomicUsize,
    pub capabilities: AtomicUsize,
    pub validations: AtomicUsize,
    plans: Mutex<VecDeque<Arc<Control>>>,
}

impl Script {
    pub fn gateway(plans: Vec<Arc<Control>>) -> (Arc<Gateway>, Arc<Self>) {
        let script = Arc::new(Self {
            opens: AtomicUsize::new(0),
            capabilities: AtomicUsize::new(0),
            validations: AtomicUsize::new(0),
            plans: Mutex::new(plans.into()),
        });
        let mut gateway = Gateway::new();
        gateway.register(script.clone()).unwrap();
        (Arc::new(gateway), script)
    }
}

#[async_trait]
impl Provider for Script {
    fn id(&self) -> &'static str {
        "host-script"
    }

    fn capabilities(&self) -> ProviderCapabilities {
        self.capabilities.fetch_add(1, Ordering::SeqCst);
        let yes = Capability {
            implemented: true,
            verification: "scripted only".into(),
        };
        ProviderCapabilities {
            websocket: yes.clone(),
            sse: yes.clone(),
            continuation: yes.clone(),
            function_tools: yes,
            advanced: vec![],
        }
    }

    fn validate_replay(
        &self,
        options: &SessionOptions,
        replay: &ConversationReplay,
        input: &[InputItem],
    ) -> crate::Result<()> {
        self.validations.fetch_add(1, Ordering::SeqCst);
        assert!(replay.runs().is_empty());
        assert!(replay.expected_identity().is_none());
        assert_eq!(options.model, "synthetic");
        assert_eq!(
            serde_json::to_value(input).unwrap(),
            serde_json::to_value(vec![InputItem::user("synthetic prepared input")]).unwrap()
        );
        Ok(())
    }

    async fn open_session(&self, _: SessionOptions) -> crate::Result<ProviderSession> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        let control = self
            .plans
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected provider open");
        let observed = control.clone();
        Ok(ProviderSession {
            id: "synthetic-provider-session".into(),
            control,
            events: Box::pin(async_stream::stream! {
                observed.generated.notified().await;
                observed.waiting.notify_one();
                observed.release.notified().await;
                for (sequence, event) in [
                    ProviderEvent::ResponseStarted { response_id: "response-1".into() },
                    ProviderEvent::ResponseFinished { response: ModelResponse {
                        id: "response-1".into(), model: Some("synthetic".into()),
                        outcome: ResponseOutcome::Completed, output: vec![],
                        text: "synthetic final output".into(), usage: None,
                        native: serde_json::json!({"synthetic": true}), output_provenance: Default::default(),
                    } },
                ].into_iter().enumerate() {
                    yield EventEnvelope {
                        schema_version: 1, sequence: sequence as u64 + 1,
                        event_id: format!("event-{sequence}"), session_id: "synthetic-provider-session".into(),
                        request_id: Some("request-1".into()), provider: "host-script".into(), provider_sequence: None, event,
                    };
                }
            }),
        })
    }
}

#[async_trait]
impl SessionControl for Control {
    fn replay_identity(&self) -> Option<ReplayIdentity> {
        Some(
            ReplayIdentity::new("host-script".into(), "scripted-v1".into(), "a".repeat(64))
                .unwrap(),
        )
    }

    async fn install_replay(&self, replay: ConversationReplay) -> crate::Result<()> {
        self.installed.lock().unwrap().push(replay);
        Ok(())
    }

    async fn generate(&self, input: Vec<InputItem>) -> crate::Result<RequestReceipt> {
        self.inputs.lock().unwrap().push(input);
        self.generated.notify_one();
        Ok(RequestReceipt {
            request_id: "request-1".into(),
        })
    }

    fn close(&self) {
        self.closes.fetch_add(1, Ordering::SeqCst);
    }
}

pub(super) fn count(value: &AtomicUsize) -> usize {
    value.load(Ordering::SeqCst)
}
