//! New-controller transport proofs. Every credential and native field is synthetic.
use super::*;
use crate::{
    Gateway, OutputProvenance,
    run::{RunEvent, RunLimits, RunOutcome, RunRequest, RunResult},
};
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct AuthRecords(Mutex<Vec<&'static str>>);
#[async_trait]
impl CredentialSource for AuthRecords {
    async fn prepare_submission(&self) -> Result<()> {
        self.0.lock().unwrap().push("prepare");
        Ok(())
    }
    async fn load(&self) -> Result<SubscriptionCredentials> {
        self.0.lock().unwrap().push("load");
        FakeAuth.load().await
    }
}
struct CountedProvider {
    adapter: OpenAiCodexProvider,
    opens: Arc<AtomicUsize>,
}
#[async_trait]
impl Provider for CountedProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }
    fn capabilities(&self) -> ProviderCapabilities {
        self.adapter.capabilities()
    }
    async fn open_session(&self, options: SessionOptions) -> Result<ProviderSession> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        self.adapter.open_session(options).await
    }
}
fn setup(
    address: std::net::SocketAddr,
    transport: Transport,
) -> (Gateway, Arc<AuthRecords>, Arc<AtomicUsize>) {
    let auth = Arc::new(AuthRecords::default());
    let opens = Arc::new(AtomicUsize::new(0));
    let mut adapter = OpenAiCodexProvider::loopback(auth.clone(), transport, address);
    // A fallback regression must stay on loopback, never reach a production endpoint.
    adapter.websocket_endpoint = format!("ws://{address}/codex/responses");
    adapter.sse_endpoint = format!("http://{address}/codex/responses");
    let mut gateway = Gateway::new();
    gateway
        .register(Arc::new(CountedProvider {
            adapter,
            opens: opens.clone(),
        }))
        .unwrap();
    (gateway, auth, opens)
}
fn output() -> Vec<Value> {
    vec![
        json!({"type":"reasoning","id":"reason","encrypted_content":"synthetic-opaque","metadata":{"keep":[3,1]}}),
        json!({"type":"function_call","id":"item-add","call_id":"call-add","name":"add_numbers","arguments":"{\"a\":17,\"b\":25}","status":"completed","metadata":{"keep":"synthetic"}}),
    ]
}
fn terminal(id: &str, output: Vec<Value>) -> Value {
    json!({"type":"response.completed","response":{"id":id,"status":"completed","output":output,"metadata":{"keep":"synthetic-terminal"}}})
}
fn first_events(recovered: bool) -> Vec<Value> {
    let mut events = vec![json!({"type":"response.created","response":{"id":"r1"}})];
    if recovered {
        for (index, item) in output().into_iter().enumerate() {
            events
                .push(json!({"type":"response.output_item.done","output_index":index,"item":item}));
        }
        events.push(terminal("r1", vec![]));
    } else {
        events.push(terminal("r1", output()));
    }
    events
}
fn final_events() -> Vec<Value> {
    vec![
        json!({"type":"response.created","response":{"id":"r2"}}),
        terminal(
            "r2",
            vec![
                json!({"type":"message","id":"answer","content":[{"type":"output_text","text":"42"}]}),
            ],
        ),
    ]
}
fn result_item() -> Value {
    json!({"type":"function_call_output","call_id":"call-add","output":"{\"sum\":42}"})
}
fn assert_first(first: &Value, transport: Transport) {
    assert_eq!(
        first["input"],
        json!([{"role":"user","content":[{"type":"input_text","text":"add 17 and 25"}]}])
    );
    assert!(first.get("previous_response_id").is_none());
    assert_eq!(first["tools"].as_array().unwrap().len(), 1);
    assert_eq!(first["tools"][0]["name"], "add_numbers");
    if transport == Transport::WebSocket {
        assert_eq!(first["type"], "response.create");
    } else {
        assert_eq!(first["stream"], true);
        assert!(first.get("type").is_none());
    }
}
fn assert_second(first: &Value, second: &Value, transport: Transport) {
    assert_eq!(first["prompt_cache_key"], second["prompt_cache_key"]);
    if transport == Transport::WebSocket {
        assert_eq!(second["type"], "response.create");
        assert_eq!(second["previous_response_id"], "r1");
        assert_eq!(second["input"], json!([result_item()]));
    } else {
        assert!(second.get("previous_response_id").is_none());
        let mut expected = first["input"].as_array().unwrap().clone();
        expected.extend(output());
        expected.push(result_item());
        assert_eq!(second["input"], json!(expected));
    }
}
async fn drive(gateway: &Gateway, transport: Transport) -> (RunResult, Vec<crate::ModelResponse>) {
    let mut options = SessionOptions::new("synthetic-model");
    options.transport = transport;
    let request = RunRequest {
        provider_id: PROVIDER_ID.into(),
        options,
        prompt: "add 17 and 25".into(),
        limits: RunLimits::default(),
    };
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(AddNumbers)).unwrap();
    let mut responses = vec![];
    let result = timeout(
        Duration::from_secs(5),
        crate::run::run(
            gateway,
            request,
            &tools,
            CancellationToken::new(),
            |envelope| {
                if let RunEvent::ProviderEvent { event } = &envelope.event
                    && let ProviderEvent::ResponseFinished { response } = &event.event
                {
                    responses.push(response.clone());
                }
                Ok(())
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    (result, responses)
}
fn assert_success(result: &RunResult, responses: &[crate::ModelResponse], recovered: bool) {
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(result.summary.model_requests_attempted, 2);
    assert_eq!(result.summary.model_requests_admitted, 2);
    assert_eq!(result.summary.new_tool_dispatches, 1);
    assert_eq!(result.summary.tool_results_prepared, 1);
    assert!(result.events_complete);
    assert_eq!(responses.len(), 2);
    assert_eq!(
        responses[0].output_provenance,
        if recovered {
            OutputProvenance::ValidatedOutputItemDone
        } else {
            OutputProvenance::NativeTerminal
        }
    );
    assert_eq!(
        responses[0].native["metadata"],
        json!({"keep":"synthetic-terminal"})
    );
    assert_eq!(
        responses[0]
            .output
            .iter()
            .map(|i| i.native.clone())
            .collect::<Vec<_>>(),
        output()
    );
    assert_eq!(
        responses[0].native["output"],
        if recovered {
            json!([])
        } else {
            json!(output())
        }
    );
    assert_eq!(result.last_response.as_ref().unwrap().text, "42");
}
fn assert_auth(auth: &AuthRecords, opens: &AtomicUsize, preparations: usize) {
    assert_eq!(opens.load(Ordering::SeqCst), 1);
    assert_eq!(
        *auth.0.lock().unwrap(),
        ["prepare", "load"].repeat(preparations)
    );
}

// Keep the listener alive until controlled completion so an extra connection fails the test.
async fn no_extra(listener: TcpListener, stopped: tokio::sync::oneshot::Receiver<()>) {
    tokio::select! { biased;
        _ = listener.accept() => panic!("unexpected reopen/retry/fallback"),
        _ = stopped => {}
    }
}
#[allow(clippy::result_large_err)]
async fn accept_ws(listener: &TcpListener) -> WebSocketStream<TcpStream> {
    let (tcp, _) = listener.accept().await.unwrap();
    accept_hdr_async(tcp, |request: &Request, response: Response| {
        assert_eq!(
            request.headers()["authorization"],
            "Bearer synthetic-oauth-token"
        );
        assert_eq!(request.headers()["chatgpt-account-id"], "synthetic-account");
        assert_eq!(request.headers()["originator"], "wi");
        assert_eq!(request.headers()["openai-beta"], wire::WS_BETA);
        assert_eq!(
            request.headers()["session-id"],
            request.headers()["x-client-request-id"]
        );
        Ok(response)
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn run_websocket_a_native_and_recovered_one_socket_exact_linkage() {
    for recovered in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut socket = accept_ws(&listener).await;
            let first = incoming(&mut socket).await;
            assert_first(&first, Transport::WebSocket);
            for event in first_events(recovered) {
                send(&mut socket, event).await;
            }
            let second = incoming(&mut socket).await;
            assert_second(&first, &second, Transport::WebSocket);
            for event in final_events() {
                send(&mut socket, event).await;
            }
            while let Some(Ok(frame)) = socket.next().await {
                assert!(!frame.is_text(), "third generation");
            }
            no_extra(listener, stopped).await;
        });
        let (gateway, auth, opens) = setup(address, Transport::WebSocket);
        let (result, responses) = drive(&gateway, Transport::WebSocket).await;
        assert_success(&result, &responses, recovered);
        assert_auth(&auth, &opens, 1);
        stop.send(()).unwrap();
        timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }
}

async fn http_request(tcp: &mut TcpStream) -> (Value, String) {
    let mut raw = Vec::new();
    while !raw.ends_with(b"\r\n\r\n") {
        assert!(raw.len() < 16 * 1024);
        raw.push(tcp.read_u8().await.unwrap());
    }
    let headers = String::from_utf8(raw).unwrap();
    assert!(headers.starts_with("POST /codex/responses HTTP/1.1\r\n"));
    let header = |name: &str| {
        headers
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case(name)
                    .then(|| value.trim().to_owned())
            })
            .unwrap()
    };
    assert_eq!(header("authorization"), "Bearer synthetic-oauth-token");
    assert_eq!(header("chatgpt-account-id"), "synthetic-account");
    assert_eq!(header("originator"), "wi");
    assert_eq!(header("accept"), "text/event-stream");
    assert!(!headers.to_ascii_lowercase().contains("upgrade: websocket"));
    let session = header("session-id");
    let mut body = vec![0; header("content-length").parse().unwrap()];
    tcp.read_exact(&mut body).await.unwrap();
    (serde_json::from_slice(&body).unwrap(), session)
}
fn frames(events: Vec<Value>) -> String {
    events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect()
}
async fn reply(tcp: &mut TcpStream, status: &str, mime: Option<&str>, body: &str) {
    let mime = mime
        .map(|m| format!("Content-Type: {m}\r\n"))
        .unwrap_or_default();
    tcp.write_all(
        format!(
            "HTTP/1.1 {status}\r\n{mime}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    tcp.shutdown().await.unwrap();
}

#[tokio::test]
async fn run_sse_a_mime_and_missing_prolog_replay_exact_effective_native_history() {
    for mime in [Some("text/event-stream"), None] {
        for recovered in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (stop, stopped) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut tcp, _) = listener.accept().await.unwrap();
                let (first, session) = http_request(&mut tcp).await;
                assert_first(&first, Transport::Sse);
                reply(&mut tcp, "200 OK", mime, &frames(first_events(recovered))).await;
                let (mut tcp, _) = listener.accept().await.unwrap();
                let (second, next_session) = http_request(&mut tcp).await;
                assert_eq!(session, next_session);
                assert_second(&first, &second, Transport::Sse);
                // Exercise terminal framing at EOF after the strict prolog admits the start.
                reply(&mut tcp, "200 OK", mime, frames(final_events()).trim_end()).await;
                no_extra(listener, stopped).await;
            });
            let (gateway, auth, opens) = setup(address, Transport::Sse);
            let (result, responses) = drive(&gateway, Transport::Sse).await;
            assert_success(&result, &responses, recovered);
            assert_auth(&auth, &opens, 3);
            stop.send(()).unwrap();
            timeout(Duration::from_secs(5), server)
                .await
                .unwrap()
                .unwrap();
        }
    }
}

#[tokio::test]
async fn run_websocket_disconnect_and_error_stop_one_attempt_without_reopen() {
    for provider_error in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut socket = accept_ws(&listener).await;
            assert_first(&incoming(&mut socket).await, Transport::WebSocket);
            if provider_error {
                send(
                    &mut socket,
                    json!({"type":"error","error":{"message":"synthetic failure"}}),
                )
                .await;
            }
            drop(socket);
            no_extra(listener, stopped).await;
        });
        let (gateway, auth, opens) = setup(address, Transport::WebSocket);
        let (result, responses) = drive(&gateway, Transport::WebSocket).await;
        assert!(matches!(result.outcome, RunOutcome::Failed { .. }));
        assert_eq!(result.summary.model_requests_attempted, 1);
        assert_eq!(result.summary.new_tool_dispatches, 0);
        assert_eq!(
            result.summary.last_upstream_outcome,
            Some(UpstreamOutcome::Unknown)
        );
        assert!(responses.is_empty());
        assert_auth(&auth, &opens, 1);
        stop.send(()).unwrap();
        timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn run_sse_wrong_mime_missing_invalid_prolog_and_http_errors_never_retry() {
    let valid_body = frames(first_events(false));
    for (status, mime, body) in [
        ("200 OK", Some("application/json"), valid_body.as_str()),
        ("200 OK", None, "<html>not an event stream</html>"),
        (
            "200 OK",
            None,
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\"}}",
        ),
        ("401 Unauthorized", Some("text/event-stream"), ""),
        ("403 Forbidden", Some("text/event-stream"), ""),
        ("429 Too Many Requests", Some("text/event-stream"), ""),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let body = body.to_owned();
        let server = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let (request, _) = http_request(&mut tcp).await;
            assert_first(&request, Transport::Sse);
            reply(&mut tcp, status, mime, &body).await;
            no_extra(listener, stopped).await;
        });
        let (gateway, auth, opens) = setup(address, Transport::Sse);
        let (result, responses) = drive(&gateway, Transport::Sse).await;
        assert!(matches!(result.outcome, RunOutcome::Failed { .. }));
        assert_eq!(result.summary.model_requests_attempted, 1);
        assert_eq!(result.summary.new_tool_dispatches, 0);
        assert_eq!(
            result.summary.last_upstream_outcome,
            Some(UpstreamOutcome::Unknown)
        );
        assert!(responses.is_empty());
        assert_auth(&auth, &opens, 2);
        stop.send(()).unwrap();
        timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }
}
