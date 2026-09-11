//! Synthetic run setup and transport assertions shared with context integration tests.
use super::*;

#[derive(Default)]
pub(super) struct AuthRecords(Mutex<Vec<&'static str>>);
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
pub(super) fn setup(
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
pub(super) fn output() -> Vec<Value> {
    vec![
        json!({"type":"reasoning","id":"reason","encrypted_content":"synthetic-opaque","metadata":{"keep":[3,1]}}),
        json!({"type":"function_call","id":"item-add","call_id":"call-add","name":"add_numbers","arguments":"{\"a\":17,\"b\":25}","status":"completed","metadata":{"keep":"synthetic"}}),
    ]
}
pub(super) fn terminal(id: &str, output: Vec<Value>) -> Value {
    json!({"type":"response.completed","response":{"id":id,"status":"completed","output":output,"metadata":{"keep":"synthetic-terminal"}}})
}
pub(super) fn first_events(recovered: bool) -> Vec<Value> {
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
pub(super) fn final_events() -> Vec<Value> {
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
pub(super) fn result_item() -> Value {
    json!({"type":"function_call_output","call_id":"call-add","output":"{\"sum\":42}"})
}
pub(super) fn assert_first(first: &Value, transport: Transport) {
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
pub(super) fn assert_second(first: &Value, second: &Value, transport: Transport) {
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
pub(super) async fn drive(
    gateway: &Gateway,
    transport: Transport,
) -> (RunResult, Vec<crate::ModelResponse>) {
    let mut options = SessionOptions::new("synthetic-model");
    options.transport = transport;
    let request = RunRequest {
        provider_id: PROVIDER_ID.into(),
        options,
        prompt: "add 17 and 25".into(),
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
                assert_eq!(envelope.schema_version, 2);
                if let RunEvent::ProviderEvent { event } = &envelope.event {
                    assert_eq!(event.schema_version, 1);
                    if let ProviderEvent::ResponseFinished { response } = &event.event {
                        responses.push(response.clone());
                    }
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
pub(super) fn assert_success(
    result: &RunResult,
    responses: &[crate::ModelResponse],
    recovered: bool,
) {
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
pub(super) fn assert_auth(auth: &AuthRecords, opens: &AtomicUsize, preparations: usize) {
    assert_eq!(opens.load(Ordering::SeqCst), 1);
    assert_eq!(
        *auth.0.lock().unwrap(),
        ["prepare", "load"].repeat(preparations)
    );
}

// Keep the listener alive until controlled completion so an extra connection fails the test.
pub(super) async fn no_extra(listener: TcpListener, stopped: tokio::sync::oneshot::Receiver<()>) {
    tokio::select! { biased;
        _ = listener.accept() => panic!("unexpected reopen/retry/fallback"),
        _ = stopped => {}
    }
}
#[allow(clippy::result_large_err)]
pub(super) async fn accept_ws(listener: &TcpListener) -> WebSocketStream<TcpStream> {
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

pub(super) async fn http_request(tcp: &mut TcpStream) -> (Value, String) {
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
pub(super) fn frames(events: Vec<Value>) -> String {
    events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect()
}
pub(super) async fn reply(tcp: &mut TcpStream, status: &str, mime: Option<&str>, body: &str) {
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

pub(super) fn trace_output(turn: usize) -> Vec<Value> {
    vec![
        json!({"type":"reasoning","id":format!("reason-{turn}"),"encrypted_content":format!("synthetic-opaque-{turn}"),"metadata":{"keep":[3,1]}}),
        json!({"type":"function_call","id":format!("item-{turn}"),"call_id":format!("call-{turn}"),"name":"add_numbers","arguments":json!({"a":turn,"b":1}).to_string(),"status":"completed","metadata":{"keep":"synthetic"}}),
    ]
}
pub(super) fn trace_events(turn: usize) -> Vec<Value> {
    let id = format!("trace-{turn}");
    let mut events = vec![json!({"type":"response.created","response":{"id":id}})];
    if turn == 9 {
        events.push(terminal(&id, vec![json!({"type":"message","id":"answer","content":[{"type":"output_text","text":"9"}]} )]));
    } else if turn.is_multiple_of(2) {
        for (index, item) in trace_output(turn).into_iter().enumerate() {
            events
                .push(json!({"type":"response.output_item.done","output_index":index,"item":item}));
        }
        events.push(terminal(&id, vec![]));
    } else {
        events.push(terminal(&id, trace_output(turn)));
    }
    events
}
pub(super) fn trace_result(turn: usize) -> Value {
    json!({"type":"function_call_output","call_id":format!("call-{turn}"),"output":json!({"sum":turn+1}).to_string()})
}
pub(super) fn assert_trace_success(result: &RunResult, responses: &[crate::ModelResponse]) {
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    assert_eq!(result.summary.model_requests_attempted, 10);
    assert_eq!(result.summary.model_requests_admitted, 10);
    assert_eq!(result.summary.turns_started, 10);
    assert_eq!(result.summary.turns_finished, 10);
    assert_eq!(result.summary.new_tool_dispatches, 9);
    assert_eq!(result.summary.tool_results_prepared, 9);
    assert_eq!(result.summary.reused_results, 0);
    assert_eq!(responses.len(), 10);
    for (turn, response) in responses.iter().take(9).enumerate() {
        assert_eq!(response.id, format!("trace-{turn}"));
        assert_eq!(
            response
                .output
                .iter()
                .map(|item| item.native.clone())
                .collect::<Vec<_>>(),
            trace_output(turn)
        );
        if turn.is_multiple_of(2) {
            assert_eq!(
                response.output_provenance,
                OutputProvenance::ValidatedOutputItemDone
            );
            assert_eq!(response.native["output"], json!([]));
        } else {
            assert_eq!(response.output_provenance, OutputProvenance::NativeTerminal);
            assert_eq!(response.native["output"], json!(trace_output(turn)));
        }
    }
    assert_eq!(result.last_response.as_ref().unwrap().text, "9");
}
