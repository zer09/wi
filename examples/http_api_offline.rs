//! Actual loopback HTTP, owner authentication, RunHost, SQLite and AddNumbers.
//! Run normally for `dev`, with --release for `release`, or with `-- --loaded`
//! for `loaded` (the build profile is also printed). No HOME/config/auth discovery.
//! All sizes/counts/waits here describe a finite fixture, not service policies.
use async_trait::async_trait;
use futures_util::FutureExt;
use ring::digest::{Context, Digest, SHA256};
use serde_json::{Value, json};
use sqlx::{ConnectOptions, Connection, sqlite::SqliteConnectOptions};
use std::{
    fs,
    io::Write,
    net::SocketAddr,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpSocket, TcpStream},
    sync::{Notify, mpsc},
};
use tokio_util::sync::CancellationToken;
use wi::{
    http_api::{ApiConfig, ApiSettings, OwnerToken, serve},
    run::RunOutcome,
    service::{CancelDisposition, RunHost, ShutdownOutcome},
    storage::{ApplicationSessionId, OperationId, RunId, SessionStore},
    tools::{AddNumbers, Tool},
    *,
};

type ExampleResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
// Synthetic fixture credential only. Never print it or use an operator credential.
const TOKEN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const PRIVATE: &str = "HTTP_OFFLINE_PRIVATE_CANARY";
const PROVIDER: &str = "http-offline-script";
const PROMPT: &str = "Add 17 and 25.\r\n";
const ANSWER: &str = "42 雪\r\n";
const TOOL_OUTPUT: &str = "{\"sum\":42}";
const PAGE: usize = 4;

fn exact(actual: &Value, expected: &Value) {
    assert!(
        actual == expected,
        "offline fixture mismatch (values redacted)"
    );
}
fn private(value: &Value) {
    let text = value.to_string();
    assert!(
        !text.contains(TOKEN) && !text.contains(PRIVATE),
        "private projection"
    );
}
fn elapsed(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
fn timing(label: &str, start: Instant) {
    println!("local_sample {label}_ms={:.3}", elapsed(start));
}
async fn watchdog<T>(future: impl std::future::Future<Output = T>) -> T {
    // An example watchdog only. No task deadline is passed into Wi.
    tokio::time::timeout(Duration::from_secs(60), future)
        .await
        .unwrap_or_else(|_| panic!("offline example watchdog expired"))
}
#[derive(Default)]
struct Gate {
    reached: Notify,
    release: Notify,
}
#[derive(Default)]
struct Script {
    preaccept: Gate,
    answer: Gate,
    drain: Gate,
    validations: AtomicUsize,
    opens: AtomicUsize,
    closes: AtomicUsize,
    requests: AtomicUsize,
}
fn identity() -> ReplayIdentity {
    ReplayIdentity::new(PROVIDER.into(), "offline-native-v1".into(), "a".repeat(64)).unwrap()
}
struct Offline(Arc<Script>);
#[async_trait]
impl Provider for Offline {
    fn id(&self) -> &'static str {
        PROVIDER
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let yes = Capability {
            implemented: true,
            verification: "finite offline script".into(),
        };
        ProviderCapabilities {
            websocket: yes.clone(),
            sse: yes.clone(),
            continuation: yes.clone(),
            function_tools: yes,
            advanced: vec![],
        }
    }
    fn validate_replay(
        &self,
        options: &SessionOptions,
        replay: &ConversationReplay,
        input: &[InputItem],
    ) -> Result<()> {
        options.validate()?;
        validate_input(input)?;
        assert!(replay.runs().is_empty() && replay.expected_identity().is_none());
        exact(&json!(options.tools), &json!([AddNumbers.definition()]));
        if self.0.validations.fetch_add(1, Ordering::SeqCst) == 0 {
            // Public pure validation precedes acceptance SQL. This fixture gate holds
            // no writer lock, so the independent absence reads below cannot wait on it.
            tokio::task::block_in_place(|| {
                self.0.preaccept.reached.notify_one();
                tokio::runtime::Handle::current()
                    .block_on(watchdog(self.0.preaccept.release.notified()));
            });
        }
        Ok(())
    }
    async fn open_session(&self, _options: SessionOptions) -> Result<ProviderSession> {
        let connection = self.0.opens.fetch_add(1, Ordering::SeqCst);
        assert!(connection < 2, "unexpected provider connection");
        let (sender, mut receiver) = mpsc::channel::<(EventEnvelope, bool)>(4);
        let script = self.0.clone();
        Ok(ProviderSession {
            id: "offline-provider-session".into(),
            control: Arc::new(Control {
                script: script.clone(),
                sender,
                turn: AtomicUsize::new(0),
                connection,
            }),
            events: Box::pin(async_stream::stream! {
                while let Some((event, held)) = receiver.recv().await {
                    if held {
                        let gate = if connection == 0 { &script.answer } else { &script.drain };
                        gate.reached.notify_one();
                        gate.release.notified().await;
                    }
                    yield event;
                }
            }),
        })
    }
}
struct Control {
    script: Arc<Script>,
    sender: mpsc::Sender<(EventEnvelope, bool)>,
    turn: AtomicUsize,
    connection: usize,
}
#[async_trait]
impl SessionControl for Control {
    fn replay_identity(&self) -> Option<ReplayIdentity> {
        Some(identity())
    }
    async fn install_replay(&self, replay: ConversationReplay) -> Result<()> {
        assert!(replay.runs().is_empty());
        Ok(())
    }
    async fn generate(&self, input: Vec<InputItem>) -> Result<RequestReceipt> {
        let turn = self.turn.fetch_add(1, Ordering::SeqCst);
        self.script.requests.fetch_add(1, Ordering::SeqCst);
        assert!(turn < 2, "unexpected generation");
        let (output, text) = if turn == 0 {
            let arguments = r#"{"a":17,"b":25}"#;
            (
                vec![OutputItem {
                    id: Some("addition".into()),
                    kind: ItemKind::FunctionCall,
                    native_type: "function_call".into(),
                    function_call: Some(FunctionCall {
                        call_id: "addition".into(),
                        name: "add_numbers".into(),
                        arguments: arguments.into(),
                        origin: CallOrigin::Direct,
                        namespace: None,
                        complete: true,
                    }),
                    native: json!({"type":"function_call","call_id":"addition","name":"add_numbers","arguments":arguments,"opaque":PRIVATE}),
                }],
                "",
            )
        } else {
            exact(
                &json!(input),
                &json!([InputItem::ToolResult {
                    call_id: "addition".into(),
                    output: TOOL_OUTPUT.into(),
                }]),
            );
            (
                vec![OutputItem {
                    id: Some("answer".into()),
                    kind: ItemKind::Message,
                    native_type: "message".into(),
                    function_call: None,
                    native: json!({"type":"message","content":[{"type":"output_text","text":ANSWER}],"opaque":PRIVATE}),
                }],
                ANSWER,
            )
        };
        let request_id = format!("request-{turn}");
        let response_id = format!("response-{turn}");
        let events = [
            ProviderEvent::ResponseStarted {
                response_id: response_id.clone(),
            },
            ProviderEvent::ResponseFinished {
                response: ModelResponse {
                    id: response_id,
                    model: Some("offline-model".into()),
                    outcome: ResponseOutcome::Completed,
                    output,
                    text: text.into(),
                    usage: None,
                    output_provenance: OutputProvenance::NativeTerminal,
                    native: json!({"opaque":PRIVATE}),
                },
            },
        ];
        for (index, event) in events.into_iter().enumerate() {
            let sequence = (turn * 2 + index + 1) as u64;
            self.sender
                .try_send((
                    EventEnvelope {
                        schema_version: 1,
                        sequence,
                        event_id: format!("event-{sequence}"),
                        session_id: "offline-provider-session".into(),
                        request_id: Some(request_id.clone()),
                        provider: PROVIDER.into(),
                        provider_sequence: None,
                        event,
                    },
                    index == 1 && (turn == 1 || self.connection == 1),
                ))
                .unwrap_or_else(|_| panic!("finite script channel failed"));
        }
        Ok(RequestReceipt { request_id })
    }
    fn close(&self) {
        self.script.closes.fetch_add(1, Ordering::SeqCst);
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_else(|_| panic!("HTTP client creation failed"))
}
async fn json_response(request: reqwest::RequestBuilder, status: u16) -> Value {
    let response = watchdog(request.send())
        .await
        .unwrap_or_else(|_| panic!("HTTP send failed (details redacted)"));
    assert_eq!(response.status().as_u16(), status, "HTTP status mismatch");
    assert_eq!(response.headers()["cache-control"], "no-store");
    let value = watchdog(response.json())
        .await
        .unwrap_or_else(|_| panic!("HTTP JSON failed (details redacted)"));
    private(&value);
    value
}
async fn get(client: &reqwest::Client, url: &str) -> Value {
    json_response(client.get(url).bearer_auth(TOKEN), 200).await
}
async fn create(client: &reqwest::Client, base: &str, workspace: &Path) -> String {
    let value = json_response(client.post(format!("{base}/v1/sessions")).bearer_auth(TOKEN)
        .json(&json!({"operation_id":OperationId::new(),"title":"Offline HTTP","workspace":workspace})), 201).await;
    value["session_id"].as_str().unwrap().to_owned()
}
fn task() -> (RunId, OperationId, Value) {
    let run = RunId::new();
    let operation = OperationId::new();
    let body = json!({"operation_id":operation,"run_id":run,"text":PROMPT});
    (run, operation, body)
}

struct Events {
    response: reqwest::Response,
    buffer: Vec<u8>,
    peak_bytes: usize,
    session: String,
}
impl Events {
    async fn open(client: &reqwest::Client, base: &str, session: &str, after: u64) -> Self {
        let response = watchdog(
            client
                .get(format!("{base}/v1/sessions/{session}/events"))
                .bearer_auth(TOKEN)
                .header("Last-Event-ID", format!("{session}:{after}"))
                .send(),
        )
        .await
        .unwrap_or_else(|_| panic!("SSE open failed (details redacted)"));
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        Self {
            response,
            buffer: vec![],
            peak_bytes: 0,
            session: session.into(),
        }
    }
    async fn next(&mut self) -> Value {
        watchdog(async {
            loop {
                if let Some(end) = self.buffer.windows(2).position(|part| part == b"\n\n") {
                    let frame = self.buffer.drain(..end + 2).collect::<Vec<_>>();
                    let frame = std::str::from_utf8(&frame).unwrap();
                    if frame.starts_with(':') {
                        continue;
                    }
                    assert!(
                        frame.lines().any(|line| line == "event: wi.event"),
                        "unexpected SSE event"
                    );
                    let data = frame
                        .lines()
                        .find_map(|line| line.strip_prefix("data: "))
                        .unwrap();
                    let event: Value = serde_json::from_str(data).unwrap();
                    private(&event);
                    let id = format!(
                        "id: {}:{}",
                        self.session,
                        event["sequence"].as_str().unwrap()
                    );
                    assert!(frame.lines().any(|line| line == id), "SSE cursor mismatch");
                    return event;
                }
                let chunk = self
                    .response
                    .chunk()
                    .await
                    .unwrap_or_else(|_| panic!("SSE read failed (details redacted)"))
                    .expect("SSE EOF is not completion");
                self.buffer.extend_from_slice(&chunk);
                self.peak_bytes = self.peak_bytes.max(self.buffer.len());
            }
        })
        .await
    }
}
// Keep one applied record for the deliberately repeated reconnect cursor, not a
// retained transcript. Conflicting duplicates fail instead of silently replacing data.
struct Applied {
    last: u64,
    record: Value,
    hash: Context,
    tools: usize,
    answers: usize,
    done: bool,
    duplicates: usize,
}
impl Applied {
    fn new() -> Self {
        Self {
            last: 1,
            record: Value::Null,
            hash: Context::new(&SHA256),
            tools: 0,
            answers: 0,
            done: false,
            duplicates: 0,
        }
    }
    fn apply(&mut self, event: Value) {
        let sequence: u64 = event["sequence"].as_str().unwrap().parse().unwrap();
        if sequence == self.last {
            exact(&event, &self.record);
            self.duplicates += 1;
            return;
        }
        assert_eq!(sequence, self.last + 1, "canonical sequence gap");
        match event["kind"].as_str().unwrap() {
            "run.accepted" => exact(&event["data"]["user_text"], &json!(PROMPT)),
            "tool.result" => {
                exact(&event["data"]["output"], &json!(TOOL_OUTPUT));
                exact(&event["data"]["is_error"], &json!(false));
                self.tools += 1;
            }
            "response.finished" if event["data"]["text"] != "" => {
                exact(&event["data"]["text"], &json!(ANSWER));
                self.answers += 1;
            }
            "run.result" => {
                exact(&event["data"]["outcome"], &json!({"type":"completed"}));
                exact(
                    &event["data"]["summary"]["new_tool_dispatches"],
                    &json!("1"),
                );
                exact(&event["data"]["events_complete"], &json!(true));
                self.done = true;
            }
            _ => (),
        }
        self.hash.update(&serde_json::to_vec(&event).unwrap());
        self.last = sequence;
        self.record = event;
    }
    fn finish(self) -> Digest {
        assert!(
            self.done && self.tools == 1 && self.answers == 1,
            "exact final result missing"
        );
        self.hash.finish()
    }
}
async fn history(client: &reqwest::Client, url: &str, through: u64) -> (Applied, usize, usize) {
    let mut applied = Applied::new();
    let mut peak = 0;
    let mut pages = 0;
    loop {
        let mut page = get(
            client,
            &format!(
                "{url}/history?after={}:{}&through={through}&limit={PAGE}",
                url.rsplit('/').next().unwrap(),
                applied.last
            ),
        )
        .await;
        exact(&page["through_sequence"], &json!(through.to_string()));
        let events = page["events"].as_array_mut().unwrap();
        peak = peak.max(events.len() + 1); // One previously applied record plus this page.
        for event in events.iter_mut() {
            applied.apply(event.take());
        }
        pages += 1;
        if page["has_more"] == false {
            break;
        }
    }
    assert_eq!(applied.last, through);
    (applied, peak, pages)
}

async fn raw(address: SocketAddr, request: &str, status: &str) -> ExampleResult<TcpStream> {
    let socket = TcpSocket::new_v4()?;
    socket.set_recv_buffer_size(4096)?;
    let mut stream = socket.connect(address).await?;
    stream
        .write_all(
            format!("{request}\r\nHost: {address}\r\nAuthorization: Bearer {TOKEN}\r\n\r\n")
                .as_bytes(),
        )
        .await?;
    let headers = watchdog(async {
        let mut headers = Vec::new();
        while !headers.ends_with(b"\r\n\r\n") {
            headers.push(stream.read_u8().await?);
        }
        Ok::<_, std::io::Error>(headers)
    })
    .await?;
    assert!(
        headers.starts_with(status.as_bytes()),
        "raw HTTP status mismatch"
    );
    Ok(stream)
}
async fn closed(stream: &mut TcpStream) -> ExampleResult<u64> {
    // Drain bytes only after serve returned. Never retain a large slow-client body.
    watchdog(async {
        let mut bytes = 0;
        let mut buffer = [0; 8192];
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) => return Ok(bytes),
                Ok(count) => bytes += count as u64,
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {
                    return Ok(bytes);
                }
                Err(error) => return Err(error.into()),
            }
        }
    })
    .await
}
#[derive(Default)]
struct Sizes {
    catalog: u64,
    sessions: u64,
    catalog_wal: u64,
    session_wal: u64,
}
impl Sizes {
    fn read(root: &Path) -> ExampleResult<Self> {
        let mut sizes = Self::default();
        let mut directories = vec![root.to_owned()];
        while let Some(directory) = directories.pop() {
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                let metadata = entry.metadata()?;
                if metadata.is_dir() {
                    directories.push(entry.path());
                    continue;
                }
                let target = match entry.file_name().to_str() {
                    Some("catalog.sqlite3") => &mut sizes.catalog,
                    Some("session.sqlite3") => &mut sizes.sessions,
                    Some("catalog.sqlite3-wal") => &mut sizes.catalog_wal,
                    Some("session.sqlite3-wal") => &mut sizes.session_wal,
                    _ => continue,
                };
                *target += metadata.len();
            }
        }
        Ok(sizes)
    }
    fn print(&self, phase: &str) {
        println!(
            "local_sample db_phase={phase} catalog_bytes={} session_bytes={} catalog_wal_bytes={} session_wal_bytes={}",
            self.catalog, self.sessions, self.catalog_wal, self.session_wal
        );
    }
}

async fn demonstrate(loaded: bool) -> ExampleResult<()> {
    let profile = if cfg!(debug_assertions) {
        "dev"
    } else {
        "release"
    };
    let label = if loaded { "loaded" } else { profile };
    println!("local_sample label={label} build_profile={profile}");
    println!(
        "Finite loopback observations, not an SLA, constant-RSS claim or benchmark comparison."
    );
    println!(
        "Timing boundaries are client observations; acceptance includes the labelled fixture gate."
    );
    let temp = tempfile::tempdir()?;
    let workspace = temp.path().join("workspace");
    fs::create_dir(&workspace)?;
    let workspace = workspace.canonicalize()?;
    let root = temp.path().join("store");
    let token_path = temp.path().join(PRIVATE);
    let mut file = fs::OpenOptions::new();
    file.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        file.mode(0o600);
    }
    file.open(&token_path)?.write_all(TOKEN.as_bytes())?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let base = format!("http://{address}");
    let mut options = SessionOptions::new("offline-model");
    options.instructions = PRIVATE.into();
    let settings = ApiSettings::new(
        &base,
        vec![workspace.clone()],
        temp.path().join("absent-skills"),
        PROVIDER.into(),
        options,
        true,
    )?;
    let config = ApiConfig::new(settings, OwnerToken::load(&token_path)?);
    let script = Arc::new(Script::default());
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(Offline(script.clone())))?;
    let host = RunHost::new(SessionStore::open(root.clone()).await?, Arc::new(gateway))?;
    let weak = host.client();
    let stop = CancellationToken::new();
    let serving = tokio::spawn(serve(listener, host, config, stop.clone()));
    let client = http();
    let session = create(&client, &base, &workspace).await;
    let url = format!("{base}/v1/sessions/{session}");

    // A separate metadata-only session supplies finite backlog without polluting replay.
    let noise = create(&client, &base, &workspace).await;
    let renames = if loaded { 40 } else { 4 };
    let title_bytes = if loaded { 256 * 1024 } else { 64 * 1024 };
    let start = Instant::now();
    for _ in 0..renames {
        json_response(
            client
                .post(format!("{base}/v1/sessions/{noise}/rename"))
                .bearer_auth(TOKEN)
                .json(&json!({"operation_id":OperationId::new(),"title":"x".repeat(title_bytes)})),
            200,
        )
        .await;
    }
    timing("finite_backlog_setup", start);
    println!(
        "local_sample backlog_records={renames} backlog_text_bytes={}",
        renames * title_bytes
    );
    let mut slow_sse = raw(
        address,
        &format!("GET /v1/sessions/{noise}/events HTTP/1.1"),
        "HTTP/1.1 200",
    )
    .await?;
    let mut slow_http = raw(
        address,
        &format!("GET /v1/sessions/{noise}/history?limit=128 HTTP/1.1"),
        "HTTP/1.1 200",
    )
    .await?;
    let mut stalled = raw(address, "POST /v1/sessions HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue", "HTTP/1.1 100").await?;
    let slow_start = Instant::now();

    let workers = if loaded { 4 } else { 1 };
    let rounds = if loaded { 16 } else { 4 };
    let mut load = tokio::task::JoinSet::new();
    let load_start = Instant::now();
    for _ in 0..workers {
        let client = http();
        let base = base.clone();
        let poll_url = format!(
            "{base}/v1/sessions/{noise}/history?after={noise}:{}&through={}&limit=32",
            renames + 1,
            renames + 1
        );
        load.spawn(async move {
            let mut rejects = 0.0;
            let mut polls = 0.0;
            for _ in 0..rounds {
                let start = Instant::now();
                json_response(client.get(format!("{base}/v1/settings")), 401).await;
                rejects += elapsed(start);
                let start = Instant::now();
                let page = get(&client, &poll_url).await;
                assert!(page["events"].as_array().unwrap().is_empty());
                polls += elapsed(start);
            }
            (rejects, polls)
        });
    }

    let (run, operation, body) = task();
    let observer = http();
    let mut events = Events::open(&observer, &base, &session, 1).await;
    let start = Instant::now();
    let request_client = http();
    let request = request_client
        .post(format!("{url}/runs"))
        .bearer_auth(TOKEN)
        .json(&body);
    let mut accepted = tokio::spawn(json_response(request, 202));
    watchdog(script.preaccept.reached.notified()).await;
    assert!(
        (&mut accepted).now_or_never().is_none(),
        "202 before acceptance"
    );
    json_response(
        client
            .get(format!("{url}/operations/{operation}"))
            .bearer_auth(TOKEN),
        404,
    )
    .await;
    json_response(
        client.get(format!("{url}/runs/{run}")).bearer_auth(TOKEN),
        404,
    )
    .await;
    exact(&get(&client, &url).await["head_sequence"], &json!("1"));
    assert_eq!(script.opens.load(Ordering::SeqCst), 0);
    timing("preaccept_validation_gate", start);
    let released = Instant::now();
    script.preaccept.release.notify_one();
    let acceptance = watchdog(accepted).await?;
    timing("acceptance_including_gate", start);
    timing("gate_release_to_202", released);
    exact(&acceptance["receipt"]["first_sequence"], &json!("2"));
    exact(&acceptance["receipt"]["last_sequence"], &json!("3"));
    exact(&acceptance["receipt"]["run_id"], &json!(run));
    let mut receipt = get(&client, &format!("{url}/operations/{operation}")).await;
    exact(
        &receipt
            .as_object_mut()
            .unwrap()
            .remove("api_version")
            .unwrap(),
        &json!(1),
    );
    exact(&acceptance["receipt"], &receipt);
    drop(request_client); // Losing the command client is not a cancellation signal.
    watchdog(script.answer.reached.notified()).await;
    let status = get(&client, &format!("{url}/runs/{run}")).await;
    exact(&status["result_recorded"], &json!(false));
    let mut applied = Applied::new();
    while applied.tools == 0 {
        applied.apply(events.next().await);
    }
    let peak_sse_bytes = events.peak_bytes;
    let resume = applied.last - 1; // Deliberately replay one already applied record.
    drop(events);
    drop(observer);

    let snapshot = get(&client, &format!("{url}/history?limit={PAGE}")).await;
    let head: u64 = snapshot["through_sequence"].as_str().unwrap().parse()?;
    drop(snapshot);
    json_response(
        client
            .post(format!("{url}/rename"))
            .bearer_auth(TOKEN)
            .json(&json!({"operation_id":OperationId::new(),"title":"Committed marker"})),
        200,
    )
    .await;
    let committed = Instant::now();
    let reader = http();
    let mut events = Events::open(&reader, &base, &session, resume).await;
    while applied.last < head + 1 {
        applied.apply(events.next().await);
    }
    timing("commit_ack_to_sse", committed);
    assert_eq!(applied.duplicates, 1);
    let start = Instant::now();
    let (fixed, peak, pages) = history(&client, &url, head).await;
    assert!(!fixed.done && fixed.tools == 1);
    drop(fixed);
    timing("fixed_head_pages", start);
    println!("local_sample fixed_head_pages={pages} fixed_head_excludes_later_commit=true");
    script.answer.release.notify_one();
    while !applied.done {
        applied.apply(events.next().await);
    }
    timing("unread_clients_to_exact_completion", slow_start);
    let final_head = applied.last;
    let expected = applied.finish();
    let peak_sse_bytes = peak_sse_bytes.max(events.peak_bytes);
    drop(events);
    drop(reader);
    let start = Instant::now();
    let (canonical, final_peak, _) = history(&client, &url, final_head).await;
    assert!(
        canonical.finish().as_ref() == expected.as_ref(),
        "history/SSE mismatch"
    );
    timing("final_committed_history", start);
    println!(
        "local_sample final_sequence={final_head} exact_tool_results=1 exact_answers=1 duplicate_reconnect_records=1"
    );
    // During the fixed-head scan the SSE reducer also retains its last record.
    println!(
        "local_sample client_held_records_peak={} sse_retained_records=1 sse_buffer_peak_bytes={peak_sse_bytes} unread_client_records=0",
        (peak + 1).max(final_peak)
    );

    let mut rejects = 0.0;
    let mut polls = 0.0;
    while let Some(result) = load.join_next().await {
        let (reject, poll) = result?;
        rejects += reject;
        polls += poll;
    }
    timing("finite_reader_window", load_start);
    let count = workers * rounds;
    println!(
        "local_sample reader_workers={workers} auth_reject_requests={count} auth_reject_mean_ms={:.3} empty_http_polls={count} empty_http_poll_mean_ms={:.3}",
        rejects / count as f64,
        polls / count as f64
    );
    // This isolates SQL connection/setup/query/close cost from the HTTP polling path.
    // It is not an internal count of the server's operation-scoped SQL connections.
    let database = root
        .join("sessions")
        .join(&session[..2])
        .join(&session)
        .join("session.sqlite3");
    let start = Instant::now();
    for _ in 0..rounds {
        let mut connection = SqliteConnectOptions::new()
            .filename(&database)
            .read_only(true)
            .shared_cache(false)
            .disable_statement_logging()
            .connect()
            .await?;
        sqlx::query("SELECT 1").execute(&mut connection).await?;
        connection.close().await?;
    }
    println!(
        "local_sample sqlite_probe_opened={rounds} sqlite_probe_closed={rounds} sqlite_open_query_close_mean_ms={:.3}",
        elapsed(start) / rounds as f64
    );
    Sizes::read(&root)?.print("before_shutdown");

    // A second independent run stays in its model stream until owner shutdown.
    let draining = create(&client, &base, &workspace).await;
    let (drain_run, _, body) = task();
    json_response(
        client
            .post(format!("{base}/v1/sessions/{draining}/runs"))
            .bearer_auth(TOKEN)
            .json(&body),
        202,
    )
    .await;
    watchdog(script.drain.reached.notified()).await;
    let start = Instant::now();
    stop.cancel();
    let outcome = watchdog(serving).await?;
    timing("shutdown_host_and_http_drain", start);
    assert!(outcome.http.is_ok() && matches!(&*outcome.shutdown, ShutdownOutcome::Closed));
    assert_eq!(
        weak.cancel(&draining.parse::<ApplicationSessionId>()?, &drain_run),
        CancelDisposition::Closed
    );
    let mut drained_bytes = 0;
    for socket in [&mut slow_sse, &mut slow_http, &mut stalled] {
        drained_bytes += closed(socket).await?;
    }
    assert!(TcpStream::connect(address).await.is_err());
    assert_eq!(script.opens.load(Ordering::SeqCst), 2);
    assert_eq!(script.closes.load(Ordering::SeqCst), 2);
    assert_eq!(script.requests.load(Ordering::SeqCst), 3);
    println!(
        "local_sample tracked_tcp_connections_closed=3 server_http_drained=true provider_connections_opened=2 provider_connections_closed=2 post_shutdown_discarded_bytes={drained_bytes}"
    );
    Sizes::read(&root)?.print("after_shutdown");
    let reopened = SessionStore::open(root).await?;
    let saved = reopened.open_session(draining.parse()?).await?;
    assert_eq!(
        saved
            .run_record(drain_run)
            .await?
            .unwrap()
            .result()
            .unwrap()
            .outcome,
        RunOutcome::CancelledLocally
    );
    reopened.close().await?;
    println!(
        "Completed offline: durable acceptance, exact AddNumbers, canonical history/SSE reconnect, unread-client isolation and awaited shutdown."
    );
    println!(
        "Record counts exclude encoded/network buffers. WAL sizes are point-in-time observations. No RSS or server SQL-connection count is claimed."
    );
    Ok(())
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> std::process::ExitCode {
    // No failure may dump a URL, workspace, request, native payload or credential.
    std::panic::set_hook(Box::new(|info| {
        let line = info.location().map_or(0, |location| location.line());
        eprintln!("offline example assertion failed at source line {line} (details redacted)")
    }));
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args: Vec<_> = std::env::args().skip(1).collect();
    let loaded = match args.as_slice() {
        [] => false,
        [flag] if flag == "--loaded" => true,
        [flag] if flag == "--help" => {
            println!(
                "cargo run --locked --offline [--release] --example http_api_offline [-- --loaded]"
            );
            println!(
                "Default labels: dev/release from debug_assertions. --loaded labels a finite 40-record backlog and 4 readers, not a service quota."
            );
            return std::process::ExitCode::SUCCESS;
        }
        _ => {
            eprintln!("offline example: expected --loaded or --help");
            return std::process::ExitCode::FAILURE;
        }
    };
    match demonstrate(loaded).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("offline example failed (details redacted)");
            std::process::ExitCode::FAILURE
        }
    }
}
