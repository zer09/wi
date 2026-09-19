use super::*;
use crate::{
    ConversationReplay, ModelResponse, OutputProvenance, ReplayExchange, ReplayIdentity, ReplayRun,
};
use futures_util::FutureExt;
#[path = "boundary.rs"]
mod boundary;
#[path = "http_api_joined.rs"]
mod http_api_joined;
#[path = "joined.rs"]
mod joined;

use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};

const ACCOUNT: &str = "synthetic-replay-account";
const TOKEN_A: &str = "synthetic-replay-token-a";
const TOKEN_B: &str = "synthetic-replay-token-b";
const TOKEN_C: &str = "synthetic-replay-token-c";
const OLD_PROMPT: &str = "prepared old skill 雪\r\nkeep these bytes";
const NEW_PROMPT: &str = "new explicit task 雪\r\n";

struct CountedAuth {
    current: Mutex<(&'static str, &'static str)>,
    loads: AtomicUsize,
    prepares: AtomicUsize,
}
impl CountedAuth {
    fn new(token: &'static str, account: &'static str) -> Self {
        Self {
            current: Mutex::new((token, account)),
            loads: AtomicUsize::new(0),
            prepares: AtomicUsize::new(0),
        }
    }
    fn rotate(&self, token: &'static str, account: &'static str) {
        *self.current.lock().unwrap() = (token, account);
    }
    fn assert_loads(&self, expected: usize) {
        assert_eq!(self.loads.load(Ordering::SeqCst), expected);
        assert_eq!(self.prepares.load(Ordering::SeqCst), expected);
    }
}
#[async_trait]
impl CredentialSource for CountedAuth {
    async fn prepare_submission(&self) -> Result<()> {
        self.prepares.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn load(&self) -> Result<SubscriptionCredentials> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        let (token, account) = *self.current.lock().unwrap();
        SubscriptionCredentials::from_access_token(token.into(), Some(account.into()), None)
    }
}

// Header comparisons deliberately do not print credential values on failure.
#[allow(clippy::result_large_err)]
async fn accept_counted(
    listener: &TcpListener,
    token: &str,
    account: &str,
) -> WebSocketStream<TcpStream> {
    let (tcp, peer) = listener.accept().await.unwrap();
    assert!(peer.ip().is_loopback());
    accept_hdr_async(tcp, |req: &Request, response: Response| {
        assert!(req.headers()["authorization"] == format!("Bearer {token}"));
        assert!(req.headers()["chatgpt-account-id"] == account);
        Ok(response)
    })
    .await
    .unwrap()
}
async fn read_counted_http(stream: &mut TcpStream, token: &str, account: &str) -> Value {
    let mut raw = Vec::new();
    while !raw.ends_with(b"\r\n\r\n") {
        assert!(raw.len() < 16 * 1024);
        raw.push(stream.read_u8().await.unwrap());
    }
    let headers = String::from_utf8(raw).unwrap();
    let fields: Vec<_> = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .collect();
    assert!(
        fields
            .iter()
            .any(|(name, value)| name.eq_ignore_ascii_case("authorization")
                && value.trim() == format!("Bearer {token}"))
    );
    assert!(fields.iter().any(
        |(name, value)| name.eq_ignore_ascii_case("chatgpt-account-id") && value.trim() == account
    ));
    let length = fields
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .unwrap()
        .1
        .trim()
        .parse::<usize>()
        .unwrap();
    let mut body = vec![0; length];
    stream.read_exact(&mut body).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}
fn user(text: &str) -> Value {
    json!({"role":"user","content":[{"type":"input_text","text":text}]})
}
fn call_items(a: u64, b: u64) -> Vec<Value> {
    vec![
        json!({"type":"reasoning","id":"opaque-item","encrypted_content":"opaque 雪\r\n\\\"",
            "summary":[],"content":[],"future":{"nonexecutable":[null,true,"bytes"]}}),
        json!({"type":"message","id":"message-item","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":""},{"type":"refusal","refusal":"refusal 雪\r\n","annotations":[],"future":42}]}),
        json!({"type":"function_call","id":"call-item","call_id":"reused-call-id","name":"add_numbers",
            "arguments":format!("{{\"a\":{a}, \"b\":{b}}}"),"status":"completed","caller":{"type":"direct","future":true},"namespace":null}),
    ]
}
fn old_final_items() -> Vec<Value> {
    vec![
        json!({"type":"reasoning","id":"final-reason","summary":[],"encrypted_content":"opaque final 雪"}),
    ]
}
fn result(sum: u64) -> Value {
    json!({"type":"function_call_output","call_id":"reused-call-id","output":format!("{{\"sum\":{sum}}}")})
}
fn events(id: &str, output: Vec<Value>, recovered: bool) -> Vec<Value> {
    let mut events = vec![json!({"type":"response.created","response":{"id":id}})];
    if recovered {
        for (index, item) in output.iter().enumerate() {
            events.push(json!({"type":"response.output_item.done","response_id":id,"output_index":index,"item":item}));
        }
    }
    events.push(json!({"type":"response.completed","response":{"id":id,"status":"completed",
        "model":"observed-model-not-request-alias","output":if recovered {vec![]} else {output},
        "usage":{"input_tokens":7,"output_tokens":4,"total_tokens":11,
            "input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":3}},
        "opaque_response":{"preserve":true}}}));
    events
}
async fn send_events_http(stream: &mut TcpStream, events: Vec<Value>, mime: bool) {
    send_events_http_mime(stream, events, mime.then_some("text/event-stream")).await;
}
async fn send_events_http_mime(stream: &mut TcpStream, events: Vec<Value>, mime: Option<&str>) {
    let body = events
        .iter()
        .map(|event| format!("data: {event}\r\n\r\n"))
        .collect::<String>();
    let content_type = mime
        .map(|mime| format!("Content-Type: {mime}\r\n"))
        .unwrap_or_default();
    let headers = format!(
        "HTTP/1.1 200 OK\r\n{content_type}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(headers.as_bytes()).await.unwrap();
    stream.write_all(body.as_bytes()).await.unwrap();
    stream.shutdown().await.unwrap();
}
async fn drain_close(socket: &mut WebSocketStream<TcpStream>) {
    while let Some(frame) = socket.next().await {
        match frame {
            Ok(Message::Text(_)) => panic!("unexpected provider request"),
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(Message::Ping(_)) => socket.flush().await.unwrap(),
            _ => {}
        }
    }
}
fn assert_body(body: &Value, ordinal: usize, transport: Transport) {
    let mut old_history = vec![user(OLD_PROMPT)];
    old_history.extend(call_items(17, 25));
    old_history.push(result(42));
    let mut restored = old_history.clone();
    restored.extend(old_final_items());
    restored.push(user(NEW_PROMPT));
    let expected = match ordinal {
        0 => vec![user(OLD_PROMPT)],
        1 if transport == Transport::WebSocket => vec![result(42)],
        1 => old_history,
        2 => restored,
        3 if transport == Transport::WebSocket => vec![result(50)],
        3 => {
            restored.extend(call_items(42, 8));
            restored.push(result(50));
            restored
        }
        _ => unreachable!(),
    };
    assert_eq!(body["input"], json!(expected));
    assert_eq!(body["model"], "requested-alias");
    assert_eq!(body["instructions"], "current instructions only");
    assert_eq!(body["tools"][0]["name"], "add_numbers");
    assert_eq!(body["store"], false);
    if transport == Transport::WebSocket && matches!(ordinal, 1 | 3) {
        let parent = if ordinal == 1 {
            "old-parent"
        } else {
            "new-parent"
        };
        assert_eq!(body["previous_response_id"], parent);
    } else {
        assert!(body.get("previous_response_id").is_none());
    }
}
fn replay_from_actual(
    identity: ReplayIdentity,
    first: ModelResponse,
    results: Vec<InputItem>,
    final_response: ModelResponse,
) -> ConversationReplay {
    ConversationReplay::new(
        PROVIDER_ID.into(),
        "requested-alias".into(),
        Some(identity),
        vec![
            ReplayRun::new(
                "run-a".into(),
                OLD_PROMPT.into(),
                vec![
                    ReplayExchange::new(first, results).unwrap(),
                    ReplayExchange::new(final_response, vec![]).unwrap(),
                ],
            )
            .unwrap(),
        ],
    )
    .unwrap()
}
async fn restored_roundtrip(transport: Transport, mime: bool, recovered: bool) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let replies = [
            events("old-parent", call_items(17, 25), recovered),
            events("old-final", old_final_items(), recovered),
            events("new-parent", call_items(42, 8), recovered),
            events("new-final", vec![], false),
        ];
        if transport == Transport::WebSocket {
            for connection in 0..2 {
                let token = if connection == 0 { TOKEN_A } else { TOKEN_B };
                let mut socket = accept_counted(&listener, token, ACCOUNT).await;
                for turn in 0..2 {
                    let ordinal = connection * 2 + turn;
                    let body = incoming(&mut socket).await;
                    assert_body(&body, ordinal, transport);
                    for event in &replies[ordinal] {
                        send(&mut socket, event.clone()).await;
                    }
                }
                drain_close(&mut socket).await;
            }
        } else {
            for (ordinal, reply) in replies.into_iter().enumerate() {
                let (mut socket, peer) = listener.accept().await.unwrap();
                assert!(peer.ip().is_loopback());
                let token = match ordinal {
                    0 | 1 => TOKEN_A,
                    2 => TOKEN_B,
                    _ => TOKEN_C,
                };
                let body = read_counted_http(&mut socket, token, ACCOUNT).await;
                assert_body(&body, ordinal, transport);
                send_events_http(&mut socket, reply, mime).await;
            }
        }
        assert!(listener.accept().now_or_never().is_none());
    });
    let auth = Arc::new(CountedAuth::new(TOKEN_A, ACCOUNT));
    let observer = observation::SmokeObserver::default();
    let provider = OpenAiCodexProvider::loopback(auth.clone(), transport, address)
        .with_smoke_observer(observer.clone(), observation::SmokeCase::Tool);
    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(AddNumbers)).unwrap();
    let mut options = SessionOptions::new("requested-alias");
    options.instructions = "current instructions only".into();
    options.transport = transport;
    options.tools = registry.definitions();
    let mut a = provider.open_session(options.clone()).await.unwrap();
    auth.assert_loads(1);
    let identity_a = a.control.replay_identity().unwrap();
    assert_eq!(identity_a.provider_id(), PROVIDER_ID);
    assert_eq!(identity_a.format(), replay::FORMAT);
    let bytes = [
        b"wi.openai-codex.account.v1\0".as_slice(),
        ACCOUNT.as_bytes(),
    ]
    .concat();
    let digest: String = ring::digest::digest(&ring::digest::SHA256, &bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert!(identity_a.principal_digest() == digest);
    auth.assert_loads(1);
    let receipt = a
        .control
        .generate(vec![InputItem::user(OLD_PROMPT)])
        .await
        .unwrap();
    let first = response(&mut a, &receipt.request_id).await;
    let results = registry.execute_response(&first, |_| {}).await.unwrap();
    let receipt = a.control.generate(results.clone()).await.unwrap();
    let final_response = response(&mut a, &receipt.request_id).await;
    let replay = replay_from_actual(identity_a.clone(), first.clone(), results, final_response);
    let stored_before = serde_json::to_value(&replay).unwrap();
    if recovered {
        assert_eq!(
            first.output_provenance,
            OutputProvenance::ValidatedOutputItemDone
        );
        assert_eq!(first.native["output"], json!([]));
    }
    a.control.close();
    while a.events.next().await.is_some() {}
    let mut loads = if transport == Transport::WebSocket {
        1
    } else {
        3
    };
    auth.assert_loads(loads);
    auth.rotate(TOKEN_B, ACCOUNT);
    provider
        .validate_replay(&options, &replay, &[InputItem::user(NEW_PROMPT)])
        .unwrap();
    auth.assert_loads(loads);
    let mut b = provider.open_session(options).await.unwrap();
    loads += 1;
    auth.assert_loads(loads);
    assert_eq!(b.control.replay_identity(), Some(identity_a.clone()));
    b.control.install_replay(replay.clone()).await.unwrap();
    assert!(b.events.next().now_or_never().is_none());
    auth.assert_loads(loads);
    let receipt = b
        .control
        .generate(vec![InputItem::user(NEW_PROMPT)])
        .await
        .unwrap();
    let response_b = response(&mut b, &receipt.request_id).await;
    // The legacy helper owns a cache; each explicit task needs a fresh cache.
    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(AddNumbers)).unwrap();
    let results_b = registry
        .execute_response(&response_b, |_| {})
        .await
        .unwrap();
    auth.rotate(TOKEN_C, ACCOUNT);
    assert_eq!(b.control.replay_identity(), Some(identity_a.clone()));
    let receipt = b.control.generate(results_b).await.unwrap();
    assert!(
        response(&mut b, &receipt.request_id)
            .await
            .output
            .is_empty()
    );
    if transport == Transport::Sse {
        loads += 2;
    }
    auth.assert_loads(loads);
    assert_eq!(serde_json::to_value(&replay).unwrap(), stored_before);
    let diagnostics = format!(
        "{identity_a:?} {first:?} {replay:?} {}",
        serde_json::to_string(&observer.snapshot()).unwrap()
    );
    for secret in [
        ACCOUNT,
        TOKEN_A,
        TOKEN_B,
        TOKEN_C,
        identity_a.principal_digest(),
        OLD_PROMPT,
        "opaque final 雪",
    ] {
        assert!(!diagnostics.contains(secret));
    }
    b.control.close();
    while b.events.next().await.is_some() {}
    timeout(Duration::from_secs(4), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn websocket_restores_actual_native_and_recovered_history_on_a_fresh_connection() {
    for recovered in [false, true] {
        restored_roundtrip(Transport::WebSocket, true, recovered).await;
    }
}
#[tokio::test]
async fn labelled_sse_restores_actual_native_and_recovered_history_on_every_request() {
    for recovered in [false, true] {
        restored_roundtrip(Transport::Sse, true, recovered).await;
    }
}
#[tokio::test]
async fn missing_mime_sse_restores_actual_native_and_recovered_history_on_every_request() {
    for recovered in [false, true] {
        restored_roundtrip(Transport::Sse, false, recovered).await;
    }
}

#[tokio::test]
async fn opened_identity_uses_one_load_is_token_independent_and_account_exact_for_both_transports()
{
    for transport in [Transport::WebSocket, Transport::Sse] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (closed, done) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            if transport == Transport::WebSocket {
                for (token, account) in [
                    (TOKEN_A, ACCOUNT),
                    (TOKEN_B, ACCOUNT),
                    (TOKEN_B, "synthetic-account-y"),
                ] {
                    let mut socket = accept_counted(&listener, token, account).await;
                    drain_close(&mut socket).await;
                }
            } else {
                tokio::select! { biased;
                    _ = listener.accept() => panic!("opening SSE or reading identity sent a request"),
                    _ = done => {}
                }
            }
        });
        let auth = Arc::new(CountedAuth::new(TOKEN_A, ACCOUNT));
        let provider = OpenAiCodexProvider::loopback(auth.clone(), transport, address);
        let mut options = SessionOptions::new("test");
        options.transport = transport;
        let mut identities = Vec::new();
        for (index, (token, account)) in [
            (TOKEN_A, ACCOUNT),
            (TOKEN_B, ACCOUNT),
            (TOKEN_B, "synthetic-account-y"),
        ]
        .into_iter()
        .enumerate()
        {
            auth.rotate(token, account);
            let mut session = provider.open_session(options.clone()).await.unwrap();
            let identity = session.control.replay_identity().unwrap();
            assert_eq!(session.control.replay_identity(), Some(identity.clone()));
            auth.assert_loads(index + 1);
            identities.push(identity);
            session.control.close();
            while session.events.next().await.is_some() {}
        }
        assert_eq!(identities[0], identities[1]);
        assert_ne!(identities[0], identities[2]);
        let _ = closed.send(());
        timeout(Duration::from_secs(4), server)
            .await
            .unwrap()
            .unwrap();
    }
}
