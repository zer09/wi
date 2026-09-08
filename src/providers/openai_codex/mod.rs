//! Compatibility adapter for the Codex SUBSCRIPTION backend, not the public
//! API-key endpoint. Platform feature documentation is not a guarantee of
//! subscription endpoint entitlement. No credentials leave the fixed endpoint.
pub mod auth;
mod codec;
mod finalized;
pub mod observation;
mod session;
mod sse;
mod state;
mod wire;

use crate::{
    Capability, Feature, FeatureCapability, Provider, ProviderCapabilities, ProviderSession,
    Result, SessionOptions, Transport,
};
use async_trait::async_trait;
use auth::CredentialSource;
use session::Timeouts;
use std::sync::Arc;
use uuid::Uuid;

pub const PROVIDER_ID: &str = "openai-codex";
const WS_ENDPOINT: &str = "wss://chatgpt.com/backend-api/codex/responses";
const SSE_ENDPOINT: &str = "https://chatgpt.com/backend-api/codex/responses";

pub struct OpenAiCodexProvider {
    credentials: Arc<dyn CredentialSource>,
    websocket_endpoint: String,
    sse_endpoint: String,
    timeouts: Timeouts,
    observation: Option<(observation::SmokeObserver, observation::SmokeCase)>,
}
impl OpenAiCodexProvider {
    pub fn new(credentials: Arc<dyn CredentialSource>) -> Self {
        Self {
            credentials,
            websocket_endpoint: WS_ENDPOINT.into(),
            sse_endpoint: SSE_ENDPOINT.into(),
            timeouts: Timeouts::default(),
            observation: None,
        }
    }
    /// Enable allowlisted evidence only for an explicitly selected synthetic smoke case.
    pub fn with_smoke_observer(
        mut self,
        observer: observation::SmokeObserver,
        case: observation::SmokeCase,
    ) -> Self {
        self.observation = Some((observer, case));
        self
    }
    /// Evidence concerns code only. No account entitlement / live success claim.
    pub fn capability_report() -> ProviderCapabilities {
        let implemented = || Capability {
            implemented: true,
            verification: "source_implemented_live_unverified".into(),
        };
        ProviderCapabilities {
            websocket: implemented(),
            sse: implemented(),
            continuation: implemented(),
            function_tools: implemented(),
            advanced: [
                Feature::NativeSteering,
                Feature::ToolSearch,
                Feature::ProgrammaticTools,
                Feature::AsyncTools,
                Feature::HostedSkills,
            ]
            .into_iter()
            .map(|feature| FeatureCapability {
                feature,
                capability: Capability {
                    implemented: false,
                    verification: "not_implemented_subscription_support_unverified".into(),
                },
            })
            .collect(),
        }
    }
    #[cfg(test)]
    fn loopback(
        credentials: Arc<dyn CredentialSource>,
        transport: Transport,
        address: std::net::SocketAddr,
    ) -> Self {
        assert!(
            address.ip().is_loopback(),
            "test endpoints must be loopback"
        );
        let mut p = Self::new(credentials);
        match transport {
            Transport::WebSocket => {
                p.websocket_endpoint = format!("ws://{address}/codex/responses")
            }
            Transport::Sse => p.sse_endpoint = format!("http://{address}/codex/responses"),
        }
        p.timeouts = Timeouts {
            connect: std::time::Duration::from_secs(3),
            idle: std::time::Duration::from_secs(3),
            total: std::time::Duration::from_secs(10),
            consumer: std::time::Duration::from_millis(100),
        };
        p
    }
}
#[async_trait]
impl Provider for OpenAiCodexProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }
    fn capabilities(&self) -> ProviderCapabilities {
        Self::capability_report()
    }
    async fn open_session(&self, options: SessionOptions) -> Result<ProviderSession> {
        options.validate()?;
        self.capabilities().require(&options.required_features)?;
        let id = Uuid::new_v4().to_string();
        let endpoint = match options.transport {
            Transport::WebSocket => &self.websocket_endpoint,
            Transport::Sse => &self.sse_endpoint,
        };
        let wire = wire::Wire::open(
            options.transport,
            endpoint,
            self.credentials.clone(),
            &id,
            self.timeouts.connect,
            self.observation.clone(),
        )
        .await?;
        Ok(session::spawn(id, wire, options, self.timeouts))
    }
}

#[cfg(test)]
mod tests;
