use super::{
    auth::{CredentialSource, SubscriptionCredentials},
    observation::{Observation, SmokeCase, SmokeObserver},
    sse::SseDecoder,
};
use crate::{GatewayError, Result, Transport, UpstreamOutcome};
use futures_util::{SinkExt, Stream, StreamExt};
use reqwest::{
    Client,
    header::{ACCEPT, CONTENT_TYPE, HeaderValue},
};
use serde_json::Value;
use std::{collections::VecDeque, pin::Pin, sync::Arc, time::Duration};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{self, Message, client::IntoClientRequest, protocol::WebSocketConfig},
};

const MAX_FRAME: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const USER_AGENT: &str = concat!("harness-gateway/", env!("CARGO_PKG_VERSION"));
pub(super) const WS_BETA: &str = "responses_websockets=2026-02-06";

type ByteStream = Pin<Box<dyn Stream<Item = Result<Vec<u8>>> + Send>>;
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub(super) enum Wire {
    WebSocket {
        socket: Box<Socket>,
        auth: SubscriptionCredentials,
        received: usize,
        observation: Option<Observation>,
    },
    Sse {
        client: Client,
        endpoint: String,
        credentials: Arc<dyn CredentialSource>,
        account_id: String,
        session_id: String,
        stream: Option<ByteStream>,
        decoder: SseDecoder,
        frames: VecDeque<String>,
        eof: bool,
        received: usize,
        observation: Option<Observation>,
    },
}

impl Wire {
    pub async fn open(
        transport: Transport,
        endpoint: &str,
        credentials: Arc<dyn CredentialSource>,
        session_id: &str,
        connect_timeout: Duration,
        observer: Option<(SmokeObserver, SmokeCase)>,
    ) -> Result<Self> {
        // Install one explicit crypto provider. Respect an embedding application's
        // existing choice if it has already installed a provider.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let auth = credentials.load().await?;
        let observation =
            observer.map(|(observer, case)| Observation::new(observer, case, transport));
        match transport {
            Transport::WebSocket => {
                let mut request = endpoint
                    .into_client_request()
                    .map_err(|_| GatewayError::ClientConfiguration)?;
                request.headers_mut().extend(auth.headers()?);
                request
                    .headers_mut()
                    .insert("originator", HeaderValue::from_static("harness_gateway"));
                request
                    .headers_mut()
                    .insert("user-agent", HeaderValue::from_static(USER_AGENT));
                request
                    .headers_mut()
                    .insert("openai-beta", HeaderValue::from_static(WS_BETA));
                let id = HeaderValue::from_str(session_id)
                    .map_err(|_| GatewayError::ClientConfiguration)?;
                request.headers_mut().insert("session-id", id.clone());
                request.headers_mut().insert("x-client-request-id", id);
                let config = WebSocketConfig::default()
                    .max_message_size(Some(MAX_FRAME))
                    .max_frame_size(Some(MAX_FRAME));
                // No redirect-following connection helper and no retry. Never send
                // subscription credentials to an arbitrary redirected destination.
                let (socket, _) = tokio::time::timeout(
                    connect_timeout,
                    connect_async_with_config(request, Some(config), true),
                )
                .await
                .map_err(|_| GatewayError::Timeout)?
                .map_err(ws_error)?;
                Ok(Self::WebSocket {
                    socket: Box::new(socket),
                    auth,
                    received: 0,
                    observation,
                })
            }
            Transport::Sse => {
                let client = Client::builder()
                    .no_proxy()
                    .https_only(endpoint.starts_with("https://"))
                    .redirect(reqwest::redirect::Policy::none())
                    .retry(reqwest::retry::never())
                    .connect_timeout(connect_timeout)
                    .read_timeout(Duration::from_secs(90))
                    .timeout(Duration::from_secs(600))
                    .user_agent(USER_AGENT)
                    .build()
                    .map_err(|_| GatewayError::ClientConfiguration)?;
                Ok(Self::Sse {
                    client,
                    endpoint: endpoint.into(),
                    credentials,
                    account_id: auth.account_id().into(),
                    session_id: session_id.into(),
                    stream: None,
                    decoder: SseDecoder::default(),
                    frames: VecDeque::new(),
                    eof: false,
                    received: 0,
                    observation,
                })
            }
        }
    }

    pub async fn send(
        &mut self,
        body: Value,
        request_id: &str,
        upstream: &mut UpstreamOutcome,
    ) -> Result<()> {
        match self {
            Self::WebSocket {
                socket,
                auth,
                received,
                observation,
            } => {
                // A WS session is bound to its original account and handshake.
                // Expiry requires an explicit new session; do not switch tokens
                // underneath connection-local previous_response_id state.
                auth.ensure_fresh()?;
                *received = 0;
                let text = serde_json::to_string(&body).map_err(|_| GatewayError::Serialization)?;
                if let Some(observation) = observation {
                    observation.send(
                        &serde_json::from_str(&text).map_err(|_| GatewayError::Serialization)?,
                    );
                }
                // Local preflight is complete. Polling send can write even if it fails.
                *upstream = UpstreamOutcome::Unknown;
                socket
                    .send(Message::Text(text.into()))
                    .await
                    .map_err(ws_error)
            }
            Self::Sse {
                client,
                endpoint,
                credentials,
                account_id,
                session_id,
                stream,
                decoder,
                frames,
                eof,
                received,
                observation,
            } => {
                let auth = credentials.load().await?;
                if auth.account_id() != account_id {
                    return Err(GatewayError::AuthAccountChanged);
                }
                let request = client
                    .post(endpoint.as_str())
                    .headers(auth.headers()?)
                    .header(ACCEPT, "text/event-stream")
                    .header("OpenAI-Beta", "responses=experimental")
                    .header("originator", "harness_gateway")
                    .header("session-id", session_id.as_str())
                    .header("x-client-request-id", request_id)
                    .json(&body)
                    .build()?;
                if let Some(observation) = observation {
                    let bytes = request
                        .body()
                        .and_then(reqwest::Body::as_bytes)
                        .ok_or(GatewayError::Serialization)?;
                    observation.send(
                        &serde_json::from_slice(bytes).map_err(|_| GatewayError::Serialization)?,
                    );
                }
                *upstream = UpstreamOutcome::Unknown;
                let response = client.execute(request).await?;
                let status = response.status();
                if !status.is_success() {
                    return Err(http_error(
                        status.as_u16(),
                        response
                            .headers()
                            .get("retry-after")
                            .and_then(|v| v.to_str().ok())
                            .and_then(|s| s.parse().ok()),
                    ));
                }
                let content_type = response
                    .headers()
                    .get(CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("");
                if !content_type
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case("text/event-stream")
                {
                    return Err(GatewayError::UnexpectedContentType);
                }
                *stream = Some(Box::pin(
                    response
                        .bytes_stream()
                        .map(|r| r.map(|b| b.to_vec()).map_err(GatewayError::from)),
                ));
                *decoder = SseDecoder::default();
                frames.clear();
                *eof = false;
                *received = 0;
                Ok(())
            }
        }
    }

    /// Ping/pong frames are handled internally. Polling while idle keeps the WS
    /// connection serviced. SSE waits until a request has installed its stream.
    pub async fn receive(&mut self) -> Result<Option<Value>> {
        match self {
            Self::WebSocket {
                socket, received, ..
            } => loop {
                match socket.next().await {
                    Some(Ok(Message::Text(text))) => {
                        *received = received.saturating_add(text.len());
                        if *received > MAX_RESPONSE_BYTES {
                            return Err(GatewayError::StreamTooLarge);
                        }
                        return serde_json::from_str(text.as_str()).map(Some).map_err(|_| {
                            GatewayError::Protocol("WebSocket event is not valid JSON")
                        });
                    }
                    Some(Ok(Message::Ping(_))) => {
                        socket.flush().await.map_err(ws_error)?;
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | None => return Ok(None),
                    Some(Ok(Message::Binary(_))) => {
                        return Err(GatewayError::Protocol("unexpected binary WebSocket event"));
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(ws_error(e)),
                }
            },
            Self::Sse {
                stream,
                decoder,
                frames,
                eof,
                received,
                ..
            } => loop {
                if let Some(frame) = frames.pop_front() {
                    if frame.trim().is_empty() || frame.trim() == "[DONE]" {
                        continue;
                    }
                    return serde_json::from_str(&frame)
                        .map(Some)
                        .map_err(|_| GatewayError::Protocol("SSE data is not valid JSON"));
                }
                if *eof {
                    return Ok(None);
                }
                let Some(bytes) = stream.as_mut() else {
                    return std::future::pending().await;
                };
                match bytes.next().await {
                    Some(Ok(chunk)) => {
                        *received = received.saturating_add(chunk.len());
                        if *received > MAX_RESPONSE_BYTES {
                            return Err(GatewayError::StreamTooLarge);
                        }
                        frames.extend(decoder.feed(&chunk)?);
                    }
                    Some(Err(e)) => return Err(e),
                    None => {
                        frames.extend(decoder.finish()?);
                        *eof = true;
                    }
                }
            },
        }
    }

    pub fn observe_native(&self, value: &Value) {
        let observation = match self {
            Self::WebSocket { observation, .. } | Self::Sse { observation, .. } => observation,
        };
        if let Some(observation) = observation {
            observation.native(value);
        }
    }
    pub fn observe_terminal(&mut self, response: &crate::ModelResponse) {
        let observation = match self {
            Self::WebSocket { observation, .. } | Self::Sse { observation, .. } => observation,
        };
        if let Some(observation) = observation {
            observation.terminal(response);
        }
    }
    pub fn end_response(&mut self) {
        if let Self::Sse {
            stream,
            decoder,
            frames,
            eof,
            ..
        } = self
        {
            *stream = None;
            *decoder = SseDecoder::default();
            frames.clear();
            *eof = false;
        }
    }
    pub async fn close(&mut self) {
        if let Self::WebSocket { socket, .. } = self {
            let _ = tokio::time::timeout(Duration::from_secs(1), socket.as_mut().close(None)).await;
        }
    }
}

fn http_error(status: u16, retry_after_seconds: Option<u64>) -> GatewayError {
    match status {
        401 => GatewayError::Unauthorized,
        403 => GatewayError::Forbidden,
        429 => GatewayError::RateLimited {
            retry_after_seconds,
        },
        _ => GatewayError::Http { status },
    }
}
fn ws_error(error: tungstenite::Error) -> GatewayError {
    match error {
        tungstenite::Error::Http(response) => http_error(response.status().as_u16(), None),
        tungstenite::Error::Capacity(_) => GatewayError::StreamTooLarge,
        _ => GatewayError::Transport,
    }
}
