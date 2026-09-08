//! Experimental Pi-compatible renewal of Wi-owned profiles only.
use super::{
    browser_login::{CLIENT_ID, TOKEN, token_profile},
    managed_auth::Exchange,
    managed_store::Profile,
};
use crate::{GatewayError, Result};
use async_trait::async_trait;
use std::time::Duration;
use zeroize::Zeroizing;

const IO_TIMEOUT: Duration = Duration::from_secs(10);
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE: usize = 65536;

#[derive(Default)]
pub(super) struct RefreshExchange {
    #[cfg(test)]
    endpoint: Option<String>,
    #[cfg(test)]
    timeouts: Option<(Duration, Duration)>,
}

fn failed(stage: &'static str) -> GatewayError {
    GatewayError::InvalidAuth(stage)
}

impl RefreshExchange {
    async fn exchange(&self, refresh: &str) -> Result<Profile> {
        let endpoint = TOKEN;
        let (io_timeout, exchange_timeout) = (IO_TIMEOUT, EXCHANGE_TIMEOUT);
        #[cfg(test)]
        let (endpoint, io_timeout, exchange_timeout) = {
            let endpoint = self.endpoint.as_deref().unwrap_or(endpoint);
            if endpoint != TOKEN {
                let url = reqwest::Url::parse(endpoint)
                    .map_err(|_| failed("renewal endpoint rejected"))?;
                if url.scheme() != "http"
                    || !url
                        .host_str()
                        .and_then(|h| h.parse::<std::net::IpAddr>().ok())
                        .is_some_and(|ip| ip.is_loopback())
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.fragment().is_some()
                {
                    return Err(failed("renewal endpoint rejected"));
                }
            }
            let (io, total) = self.timeouts.unwrap_or((io_timeout, exchange_timeout));
            (endpoint, io.min(IO_TIMEOUT), total.min(EXCHANGE_TIMEOUT))
        };
        tokio::time::timeout(exchange_timeout, async {
            let _ = rustls::crypto::ring::default_provider().install_default();
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(io_timeout)
                .read_timeout(io_timeout)
                .timeout(exchange_timeout)
                .user_agent(concat!("wi/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|_| failed("renewal client setup failed; login required"))?;
            let form = reqwest::Url::parse_with_params(
                "http://localhost/",
                [
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh),
                    ("client_id", CLIENT_ID),
                ],
            )
            .map_err(|_| failed("renewal request encoding failed; login required"))?;
            let encoded = Zeroizing::new(
                form.query()
                    .ok_or_else(|| failed("renewal request encoding failed; login required"))?
                    .to_string(),
            );
            let mut response = client
                .post(endpoint)
                .header("content-type", "application/x-www-form-urlencoded")
                .body(encoded.to_string())
                .send()
                .await
                .map_err(|_| failed("renewal transport failed; login required"))?;
            // Never read or expose an OAuth error body, even when it echoes credentials.
            if !response.status().is_success() {
                return Err(failed("renewal endpoint rejected request; login required"));
            }
            if response
                .content_length()
                .is_some_and(|n| n > MAX_RESPONSE as u64)
            {
                return Err(failed("renewal response too large; login required"));
            }
            let mut body = Zeroizing::new(Vec::new());
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| failed("renewal response read failed; login required"))?
            {
                if chunk.len() > MAX_RESPONSE - body.len() {
                    return Err(failed("renewal response too large; login required"));
                }
                body.extend_from_slice(&chunk);
            }
            // Only this fixed TLS response attests identity; decoding is not signature verification.
            token_profile(&body)
                .map_err(|_| failed("renewal token validation failed; login required"))
        })
        .await
        .map_err(|_| failed("renewal timed out; login required"))?
    }
}

#[async_trait]
impl Exchange for RefreshExchange {
    fn configured(&self) -> Result<()> {
        Ok(())
    }
    async fn refresh(&self, refresh: &str) -> Result<Profile> {
        self.exchange(refresh).await
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "refresh_tests.rs"]
mod tests;
