use super::{
    auth::{CredentialSource, SubscriptionCredentials},
    observation::{
        BodyClass, HttpEvidence, MediaClass, Observation, SampleState, SmokeCase, SmokeObserver,
    },
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

#[cfg(test)]
#[path = "sse_prolog_unit_tests.rs"]
mod sse_prolog_unit_tests;

const MAX_FRAME: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const USER_AGENT: &str = concat!("harness-gateway/", env!("CARGO_PKG_VERSION"));
pub(super) const WS_BETA: &str = "responses_websockets=2026-02-06";

fn media_class(header: Option<&HeaderValue>) -> MediaClass {
    let Some(header) = header else {
        return MediaClass::Missing;
    };
    let Ok(value) = header.to_str() else {
        return MediaClass::Invalid;
    };
    let mime = value.split(';').next().unwrap_or("").trim();
    if mime.eq_ignore_ascii_case("text/event-stream") {
        MediaClass::EventStream
    } else if mime.eq_ignore_ascii_case("application/json") {
        MediaClass::Json
    } else if mime.eq_ignore_ascii_case("text/html") {
        MediaClass::Html
    } else if mime.eq_ignore_ascii_case("text/plain") {
        MediaClass::PlainText
    } else if mime.split_once('/').is_some_and(|(a, b)| {
        !a.is_empty() && !b.is_empty() && !mime.bytes().any(|b| b.is_ascii_whitespace())
    }) {
        MediaClass::Other
    } else {
        MediaClass::Invalid
    }
}

const MAX_BODY_SAMPLE: usize = 4096;
fn body_class(bytes: &[u8]) -> BodyClass {
    if bytes.is_empty() {
        return BodyClass::Empty;
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return BodyClass::BinaryOrNonUtf8;
    };
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
    {
        return BodyClass::BinaryOrNonUtf8;
    }
    let text = text.trim_start();
    if text.starts_with('{') || text.starts_with('[') {
        BodyClass::JsonLike
    } else if text.starts_with('<') {
        BodyClass::HtmlLike
    } else {
        BodyClass::TextOrOther
    }
}

async fn sample_rejection(response: reqwest::Response) -> (SampleState, Option<BodyClass>) {
    // Only a bounded prefix is retained. No body content leaves this function.
    let mut prefix = Vec::new();
    let sample = async {
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else {
                return SampleState::ReadError;
            };
            let count = chunk.len().min(MAX_BODY_SAMPLE - prefix.len());
            prefix.extend_from_slice(&chunk[..count]);
            if prefix.len() == MAX_BODY_SAMPLE {
                return SampleState::Truncated;
            }
        }
        SampleState::Complete
    };
    let state = tokio::time::timeout(Duration::from_secs(1), sample)
        .await
        .unwrap_or(SampleState::Timeout);
    // A timeout is not EOF. Only a nonempty partial prefix has a useful class.
    let class = if state == SampleState::Complete || !prefix.is_empty() {
        Some(body_class(&prefix))
    } else {
        None
    };
    (state, class)
}

type ByteStream = Pin<Box<dyn Stream<Item = Result<Vec<u8>>> + Send>>;
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const MAX_SSE_PROLOG: usize = 65536;
const SSE_PROLOG_TIMEOUT: Duration = Duration::from_secs(10);

fn response_stream(mut response: reqwest::Response) -> ByteStream {
    Box::pin(async_stream::try_stream! {
        let mut fetched = 0usize;
        while let Some(chunk) = response.chunk().await? {
            fetched = fetched.saturating_add(chunk.len());
            // Check before allocating the Vec required by the existing byte stream.
            if fetched > MAX_RESPONSE_BYTES {
                Err(GatewayError::StreamTooLarge)?;
            }
            yield chunk.to_vec();
        }
    })
}

fn qualifies_sse_prolog(data: &str, label: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return false;
    };
    let Some(kind) = value.get("type").and_then(Value::as_str) else {
        return false;
    };
    if !label.is_empty() && label != kind {
        return false;
    }
    if !value
        .pointer("/response/id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty() && id.len() <= 512)
    {
        return false;
    }
    let created = kind == "response.created";
    if !created
        && !matches!(
            kind,
            "response.completed"
                | "response.done"
                | "response.incomplete"
                | "response.failed"
                | "response.cancelled"
        )
    {
        return false;
    }
    // Trial events stay private. The real decoder sees the original bytes later.
    super::codec::ResponseDecoder::default()
        .apply(value)
        .is_ok_and(|events| {
            events.iter().any(|event| {
                if created {
                    matches!(event, crate::ProviderEvent::ResponseStarted { .. })
                } else {
                    matches!(event, crate::ProviderEvent::ResponseFinished { .. })
                }
            })
        })
}

async fn admit_sse_prolog(
    mut stream: ByteStream,
) -> (Result<ByteStream>, SampleState, Option<BodyClass>) {
    let mut prefix = Vec::new();
    let mut replay = VecDeque::new();
    let mut inspected = 0usize;
    let mut fetched = 0usize;
    let mut decoder = SseDecoder::strict_prolog();
    let mut empty_eof = false;
    let deadline = tokio::time::Instant::now() + SSE_PROLOG_TIMEOUT;
    let probe = async {
        while let Some(chunk) = stream.next().await {
            if tokio::time::Instant::now() >= deadline {
                return (SampleState::SsePrologTimeout, false);
            }
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(GatewayError::StreamTooLarge) => {
                    return (SampleState::SsePrologTruncated, true);
                }
                Err(_) => return (SampleState::SsePrologReadError, false),
            };
            fetched = fetched.saturating_add(chunk.len());
            if fetched > MAX_RESPONSE_BYTES {
                return (SampleState::SsePrologTruncated, true);
            }
            for &byte in &chunk {
                inspected += 1;
                if prefix.len() < MAX_BODY_SAMPLE {
                    prefix.push(byte);
                }
                let frames = match decoder.feed(&[byte]) {
                    Ok(frames) => frames,
                    Err(_) => return (SampleState::SsePrologRejected, false),
                };
                if let Some(data) = frames.first() {
                    // The first data frame is decisive, even if it is empty.
                    if !qualifies_sse_prolog(data, decoder.dispatched_label()) {
                        return (SampleState::SsePrologRejected, false);
                    }
                    if tokio::time::Instant::now() >= deadline {
                        return (SampleState::SsePrologTimeout, false);
                    }
                    replay.push_back(chunk);
                    return (SampleState::SsePrologAdmitted, false);
                }
                if inspected == MAX_SSE_PROLOG {
                    return (SampleState::SsePrologTruncated, false);
                }
            }
            replay.push_back(chunk);
        }
        // Do not use finish(): admission requires a dispatched blank-line frame.
        empty_eof = inspected == 0;
        (SampleState::SsePrologRejected, false)
    };
    let (state, too_large) = tokio::time::timeout_at(deadline, probe)
        .await
        .unwrap_or((SampleState::SsePrologTimeout, false));
    let class = if !prefix.is_empty() || empty_eof {
        Some(body_class(&prefix))
    } else {
        None
    };
    let result = if state == SampleState::SsePrologAdmitted {
        // Move every fetched chunk, including the uninspected suffix, in order.
        let replay = futures_util::stream::iter(replay.into_iter().map(Ok));
        Ok(Box::pin(replay.chain(stream)) as ByteStream)
    } else if too_large {
        Err(GatewayError::StreamTooLarge)
    } else {
        Err(GatewayError::UnexpectedContentType)
    };
    (result, state, class)
}

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
                let media = media_class(response.headers().get(CONTENT_TYPE));
                let rejection = if !status.is_success() {
                    Some(http_error(
                        status.as_u16(),
                        response
                            .headers()
                            .get("retry-after")
                            .and_then(|v| v.to_str().ok())
                            .and_then(|s| s.parse().ok()),
                    ))
                } else if !matches!(media, MediaClass::EventStream | MediaClass::Missing) {
                    Some(GatewayError::UnexpectedContentType)
                } else {
                    None
                };
                if let Some(observation) = observation {
                    observation.http(HttpEvidence {
                        status: status.as_u16(),
                        media,
                        body_class: None,
                        sample_state: if rejection.is_some() {
                            SampleState::Unavailable
                        } else if media == MediaClass::Missing {
                            SampleState::SsePrologPending
                        } else {
                            SampleState::NotSampled
                        },
                    });
                }
                if let Some(error) = rejection {
                    if let Some(observation) = observation {
                        let (sample_state, body_class) = sample_rejection(response).await;
                        observation.http(HttpEvidence {
                            status: status.as_u16(),
                            media,
                            body_class,
                            sample_state,
                        });
                    }
                    // Diagnostics never replace the original rejection category.
                    return Err(error);
                }
                let body_stream = response_stream(response);
                *stream = Some(if media == MediaClass::Missing {
                    let (admitted, sample_state, body_class) = admit_sse_prolog(body_stream).await;
                    if let Some(observation) = observation {
                        observation.http(HttpEvidence {
                            status: status.as_u16(),
                            media,
                            body_class,
                            sample_state,
                        });
                    }
                    admitted?
                } else {
                    body_stream
                });
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
