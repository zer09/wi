use super::*;

pub(super) async fn collect(
    session: &mut ProviderSession,
    _: &str,
    _: bool,
) -> Result<ModelResponse> {
    let mut lifecycle = collect_lifecycle::Lifecycle::default();
    while let Some(envelope) = session.events.next().await {
        lifecycle.observe(&envelope.event)?;
        if let ProviderEvent::ResponseFinished { response } = envelope.event {
            lifecycle.validate(&response)?;
            return Ok(response);
        }
    }
    Err(crate::GatewayError::UnexpectedEnd)
}

#[derive(Default)]
pub(super) struct Control(pub(super) AtomicUsize);
#[async_trait::async_trait]
impl SessionControl for Control {
    async fn generate(&self, _: Vec<InputItem>) -> Result<RequestReceipt> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(RequestReceipt {
            request_id: "request".into(),
        })
    }
    fn close(&self) {}
}
pub(super) fn session(events: Vec<ProviderEvent>) -> (ProviderSession, Arc<Control>) {
    let control = Arc::new(Control::default());
    let envelopes = events
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
        });
    (
        ProviderSession {
            id: "session".into(),
            control: control.clone(),
            events: Box::pin(futures_util::stream::iter(envelopes)),
        },
        control,
    )
}
