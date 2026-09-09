//! Only normalized identity and ordering belong here. Native payloads are opaque.
use super::{RunOutcome, failed};
use crate::{EventEnvelope, ProviderEvent};

#[derive(Default)]
pub(super) struct Collector {
    pub response_id: Option<String>,
    started: bool,
    terminal: bool,
}

impl Collector {
    pub fn observe(
        &mut self,
        envelope: &EventEnvelope,
        session: &str,
        provider: &str,
        request: &str,
        sequence: &mut Option<u64>,
    ) -> Result<(), RunOutcome> {
        if envelope.session_id != session
            || envelope.provider != provider
            || envelope.request_id.as_deref() != Some(request)
            || sequence.is_some_and(|previous| envelope.sequence <= previous)
            || self.terminal
        {
            return Err(failed("provider_correlation"));
        }
        *sequence = Some(envelope.sequence);
        let id = match &envelope.event {
            ProviderEvent::SessionClosed { .. } => return Err(failed("session_closed")),
            ProviderEvent::ResponseStarted { response_id } => {
                if self.started {
                    return Err(failed("provider_correlation"));
                }
                self.started = true;
                Some(response_id)
            }
            ProviderEvent::ResponseStatus { response_id, .. }
            | ProviderEvent::OutputItemStarted { response_id, .. }
            | ProviderEvent::OutputItemUpdated { response_id, .. }
            | ProviderEvent::OutputItemFinished { response_id, .. } => Some(response_id),
            ProviderEvent::ResponseFinished { response } => {
                self.terminal = true;
                Some(&response.id)
            }
            ProviderEvent::RequestFailed { .. } => {
                self.terminal = true;
                None
            }
            ProviderEvent::ProviderExtension { .. } => None,
        };
        if let Some(id) = id {
            if id.is_empty() || self.response_id.as_ref().is_some_and(|known| known != id) {
                return Err(failed("provider_correlation"));
            }
            self.response_id = Some(id.clone());
        }
        Ok(())
    }
}
