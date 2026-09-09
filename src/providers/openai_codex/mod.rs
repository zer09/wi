//! Compatibility adapter for the Codex SUBSCRIPTION backend, not the public
//! API-key endpoint. Platform feature documentation is not a guarantee of
//! subscription endpoint entitlement. No credentials leave the fixed endpoint.
pub mod auth;
pub mod browser_login;
mod codec;
mod consistency;
#[cfg(test)]
mod consistency_tests;
mod finalized;
pub mod managed_auth;
mod managed_store;
#[cfg(all(test, target_os = "linux"))]
mod managed_store_tests;
#[cfg(test)]
mod oauth_offline;
pub mod observation;
pub mod profile_selection;
mod refresh;
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

enum ProviderAuth {
    External(Arc<dyn CredentialSource>),
    Managed(managed_auth::AuthManager, Option<String>),
}
pub struct OpenAiCodexProvider {
    credentials: ProviderAuth,
    profile_observer: Option<fn(&str)>,
    websocket_endpoint: String,
    sse_endpoint: String,
    timeouts: Timeouts,
    observation: Option<(observation::SmokeObserver, observation::SmokeCase)>,
}
impl OpenAiCodexProvider {
    pub fn new(credentials: Arc<dyn CredentialSource>) -> Self {
        Self {
            credentials: ProviderAuth::External(credentials),
            profile_observer: None,
            websocket_endpoint: WS_ENDPOINT.into(),
            sse_endpoint: SSE_ENDPOINT.into(),
            timeouts: Timeouts::default(),
            observation: None,
        }
    }
    /// Selection occurs at each session open, not when the provider is constructed.
    pub fn managed(manager: managed_auth::AuthManager, account: Option<String>) -> Self {
        Self {
            credentials: ProviderAuth::Managed(manager, account),
            profile_observer: None,
            websocket_endpoint: WS_ENDPOINT.into(),
            sse_endpoint: SSE_ENDPOINT.into(),
            timeouts: Timeouts::default(),
            observation: None,
        }
    }
    /// Observe only the validated local alias, never provider identity or tokens.
    pub fn with_profile_observer(mut self, observer: fn(&str)) -> Self {
        self.profile_observer = Some(observer);
        self
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
        let credentials: Arc<dyn CredentialSource> = match &self.credentials {
            ProviderAuth::External(source) => source.clone(),
            ProviderAuth::Managed(manager, account) => {
                let manager = manager.clone();
                let account = account.clone();
                let selected =
                    tokio::task::spawn_blocking(move || manager.select(account.as_deref()))
                        .await
                        .map_err(|_| {
                            crate::GatewayError::InvalidAuth("profile selection worker failed")
                        })??;
                if let Some(observer) = self.profile_observer {
                    observer(selected.selected_profile());
                }
                Arc::new(selected)
            }
        };
        let wire = wire::Wire::open(
            options.transport,
            endpoint,
            credentials,
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
