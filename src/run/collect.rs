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
        if provider == crate::providers::openai_codex::PROVIDER_ID
            && !crate::identifiers::is_local_event_id(
                &envelope.event_id,
                &envelope.session_id,
                envelope.sequence,
            )
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{UpstreamOutcome, providers::openai_codex::PROVIDER_ID};

    #[test]
    fn id2b_invalid_local_identity_cannot_change_collector_order_response_or_terminal_state() {
        let session = "01234567-89ab-1cde-8fab-0123456789ab";
        for (id, local_sequence) in crate::identifiers::invalid_local_events(session) {
            let mut collector = Collector::default();
            let mut sequence = None;
            let mut event = EventEnvelope {
                schema_version: 1,
                sequence: local_sequence,
                event_id: id,
                session_id: session.into(),
                request_id: Some("request".into()),
                provider: PROVIDER_ID.into(),
                provider_sequence: Some(u64::MAX),
                event: ProviderEvent::RequestFailed {
                    code: "synthetic".into(),
                    message: "synthetic".into(),
                    upstream_outcome: UpstreamOutcome::TerminalReceived,
                },
            };
            assert_eq!(
                collector.observe(&event, session, PROVIDER_ID, "request", &mut sequence),
                Err(failed("provider_correlation"))
            );
            assert!(sequence.is_none());
            assert!(collector.response_id.is_none());
            assert!(!collector.started && !collector.terminal);
            event.sequence = u64::MAX;
            event.event_id = format!("{session}:{}", u64::MAX);
            event.event = ProviderEvent::ResponseStarted {
                response_id: "valid-response".into(),
            };
            collector
                .observe(&event, session, PROVIDER_ID, "request", &mut sequence)
                .unwrap();
            assert_eq!(sequence, Some(u64::MAX));
            assert_eq!(collector.response_id.as_deref(), Some("valid-response"));
            assert!(collector.started && !collector.terminal);
        }
    }
}
