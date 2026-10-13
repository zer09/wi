//! Native producer death uses the existing private child, never browser fixture startup.
use super::*;
use crate::tools::{AddNumbers, Tool};
use crate::{Provider, ProviderCapabilities, ProviderSession, RequestReceipt, SessionControl};
use ring::digest::{SHA256, digest};
use serde::{Serialize, de::DeserializeOwned};
use sqlx::Executor;
use std::{
    collections::HashSet,
    io::{BufRead, Read},
    os::unix::{fs::PermissionsExt, process::ExitStatusExt},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc as channel,
    },
    thread,
    time::Instant,
};

const MODE: &str = "WI_NATIVE_RESTART_CHILD";
const CHILD: &str =
    "providers::openai_codex::tests::replay_loopback_tests::http_api_joined::browser::child";

pub(super) fn selected() -> bool {
    match std::env::var_os(MODE) {
        None => false,
        Some(value) => {
            assert!(value == "1", "restart mode rejected");
            true
        }
    }
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Produce,
    Observe,
}
impl Phase {
    fn directory(self) -> &'static str {
        match self {
            Self::Produce => "produce",
            Self::Observe => "observe",
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    root: PathBuf,
    phase: Phase,
}
impl Start {
    fn validate(&self, cwd: &Path) -> bool {
        self.root.is_absolute()
            && self
                .root
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("wi-restart-"))
            && cwd == self.root.join(self.phase.directory())
            && std::fs::canonicalize(&self.root).is_ok_and(|root| root == self.root)
            && std::fs::symlink_metadata(cwd).is_ok_and(|m| m.is_dir())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
enum Control {
    Select {
        id: NonZeroU32,
        session_id: ApplicationSessionId,
    },
    Drive {
        id: NonZeroU32,
        gate: usize,
    },
    Sample {
        id: NonZeroU32,
    },
    Stop {
        id: NonZeroU32,
    },
}
impl Control {
    fn id(&self) -> u32 {
        match self {
            Self::Select { id, .. }
            | Self::Drive { id, .. }
            | Self::Sample { id }
            | Self::Stop { id } => id.get(),
        }
    }
    fn follows(&self, last: u32) -> bool {
        self.id() > last
    }
}
#[derive(Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Work {
    auth_loads: usize,
    auth_prepares: usize,
    provider_opens: usize,
    model_requests: usize,
    connections: usize,
    wire_requests: usize,
    prepared_exact: usize,
    tool_validations: usize,
    tool_executions: usize,
    completed: usize,
    fresh_empty: bool,
}
impl Work {
    fn valid(&self, phase: Phase) -> bool {
        if phase == Phase::Observe {
            return self == &Self::default();
        }
        self.auth_loads == 1
            && self.auth_prepares == 1
            && self.provider_opens == 1
            && self.model_requests == 1
            && self.connections == 1
            && self.wire_requests == 1
            && self.prepared_exact == 1
            && self.tool_validations == 0
            && self.tool_executions == 0
            && self.completed == 0
            && self.fresh_empty
    }
}
#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "snake_case", deny_unknown_fields)]
enum Message {
    Ready {
        protocol: u8,
        phase: Phase,
        pid: u32,
        origin: String,
    },
    Selected {
        protocol: u8,
        id: NonZeroU32,
    },
    Driven {
        protocol: u8,
        id: NonZeroU32,
    },
    ModelPaused {
        protocol: u8,
        gate: usize,
    },
    Sample {
        protocol: u8,
        id: NonZeroU32,
        work: Work,
    },
    Stopped {
        protocol: u8,
        id: NonZeroU32,
        work: Work,
        drained: bool,
    },
}
impl Message {
    fn protocol(&self) -> u8 {
        match self {
            Self::Ready { protocol, .. }
            | Self::Selected { protocol, .. }
            | Self::Driven { protocol, .. }
            | Self::ModelPaused { protocol, .. }
            | Self::Sample { protocol, .. }
            | Self::Stopped { protocol, .. } => *protocol,
        }
    }
}
fn decode<T: DeserializeOwned>(bytes: &[u8]) -> std::result::Result<T, ()> {
    if bytes.len() > LIMIT as usize || bytes.last() != Some(&b'\n') {
        return Err(());
    }
    serde_json::from_slice(bytes).map_err(|_| ())
}

#[derive(Default)]
struct Counters {
    opens: AtomicUsize,
    models: AtomicUsize,
    connections: AtomicUsize,
    validates: AtomicUsize,
    executes: AtomicUsize,
}
struct CountedProvider {
    adapter: OpenAiCodexProvider,
    counts: Arc<Counters>,
}
#[async_trait]
impl Provider for CountedProvider {
    fn id(&self) -> &'static str {
        self.adapter.id()
    }
    fn capabilities(&self) -> ProviderCapabilities {
        self.adapter.capabilities()
    }
    fn validate_replay(
        &self,
        options: &SessionOptions,
        replay: &ConversationReplay,
        input: &[InputItem],
    ) -> Result<()> {
        self.adapter.validate_replay(options, replay, input)
    }
    async fn open_session(&self, options: SessionOptions) -> Result<ProviderSession> {
        self.counts.opens.fetch_add(1, Ordering::SeqCst);
        let mut session = self.adapter.open_session(options).await?;
        session.control = Arc::new(CountedControl {
            inner: session.control,
            counts: self.counts.clone(),
        });
        Ok(session)
    }
}
struct CountedControl {
    inner: Arc<dyn SessionControl>,
    counts: Arc<Counters>,
}
#[async_trait]
impl SessionControl for CountedControl {
    fn replay_identity(&self) -> Option<ReplayIdentity> {
        self.inner.replay_identity()
    }
    async fn install_replay(&self, replay: ConversationReplay) -> Result<()> {
        self.inner.install_replay(replay).await
    }
    async fn generate(&self, input: Vec<InputItem>) -> Result<RequestReceipt> {
        self.counts.models.fetch_add(1, Ordering::SeqCst);
        self.inner.generate(input).await
    }
    fn close(&self) {
        self.inner.close();
    }
    async fn steer(&self, text: String) -> Result<()> {
        self.inner.steer(text).await
    }
}
struct CountedAdd {
    counts: Arc<Counters>,
}
#[async_trait]
impl Tool for CountedAdd {
    fn definition(&self) -> crate::ToolDefinition {
        AddNumbers.definition()
    }
    fn validate(&self, arguments: &Value) -> Result<()> {
        self.counts.validates.fetch_add(1, Ordering::SeqCst);
        AddNumbers.validate(arguments)
    }
    async fn execute(&self, arguments: Value) -> Result<Value> {
        self.counts.executes.fetch_add(1, Ordering::SeqCst);
        AddNumbers.execute(arguments).await
    }
}
fn work(counts: &Counters, auth: &CountedAuth, proof: &Mutex<Proof>) -> Work {
    let p = proof.lock().unwrap();
    Work {
        auth_loads: auth.loads.load(Ordering::SeqCst),
        auth_prepares: auth.prepares.load(Ordering::SeqCst),
        provider_opens: counts.opens.load(Ordering::SeqCst),
        model_requests: counts.models.load(Ordering::SeqCst),
        connections: p.connections + counts.connections.load(Ordering::SeqCst),
        wire_requests: p.requests,
        prepared_exact: p.prepared_exact,
        tool_validations: counts.validates.load(Ordering::SeqCst),
        tool_executions: counts.executes.load(Ordering::SeqCst),
        completed: p.completed,
        fresh_empty: p.fresh_empty,
    }
}

pub(super) async fn child(input: &mut tokio::io::BufReader<tokio::io::Stdin>) {
    let start: Start = control(input).await;
    let cwd = std::env::current_dir().unwrap();
    assert!(start.validate(&cwd), "restart root rejected");
    for (key, name) in [
        ("HOME", "home"),
        ("XDG_CONFIG_HOME", "xdg"),
        ("CODEX_HOME", "codex"),
        ("TMPDIR", "tmp"),
        ("TMP", "tmp"),
        ("TEMP", "tmp"),
    ] {
        assert!(
            std::env::var_os(key) == Some(cwd.join(name).into_os_string()),
            "restart isolation rejected"
        );
    }
    let workspace = start.root.join("workspace");
    let counts = Arc::new(Counters::default());
    let auth = Arc::new(CountedAuth::new(TOKEN_A, ACCOUNT));
    let wire = Wire::new(Transport::WebSocket).await;
    let address = wire.listener.local_addr().unwrap();
    let mut adapter = OpenAiCodexProvider::loopback(auth.clone(), Transport::WebSocket, address);
    adapter.websocket_endpoint = format!("ws://{address}/codex/responses");
    adapter.sse_endpoint = format!("http://{address}/codex/responses");
    adapter.timeouts.idle = Duration::from_secs(30);
    adapter.timeouts.total = Duration::from_secs(60);
    let mut gateway = Gateway::new();
    gateway
        .register(Arc::new(CountedProvider {
            adapter,
            counts: counts.clone(),
        }))
        .unwrap();
    let root = start.root.join("private-data");
    let store = SessionStore::open(root.clone()).await.unwrap();
    // Opening the store is not opening the selected session. Public Latest must recover it.
    let host = RunHost::new(store, Arc::new(gateway)).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let mut options = SessionOptions::new(MODEL);
    options.transport = Transport::WebSocket;
    options.instructions = INSTRUCTIONS.into();
    let mut settings = ApiSettings::new(
        &origin,
        vec![workspace],
        start.root.join("private-skills"),
        PROVIDER_ID.into(),
        options,
        false,
    )
    .unwrap();
    // Register the same AddNumbers implementation through the existing private seam to count work.
    // Automatic load_skill preparation and the real ToolRegistry remain unchanged.
    settings.set_test_tool(Arc::new(CountedAdd {
        counts: counts.clone(),
    }));
    let stop = CancellationToken::new();
    let server = tokio::spawn(serve(
        listener,
        host,
        ApiConfig::new(
            settings,
            OwnerToken::load(&start.root.join("owner")).unwrap(),
        ),
        stop.clone(),
    ));
    let db = Database {
        root,
        session: Arc::default(),
        read_failure: Arc::default(),
        reader: Arc::default(),
    };
    let proof = Arc::new(Mutex::new(Proof::default()));
    let (drive, driven) = mpsc::channel(1);
    let probe_stop = CancellationToken::new();
    let provider_db = db.clone();
    let provider_proof = proof.clone();
    let provider_counts = counts.clone();
    let probe_done = probe_stop.clone();
    let provider = tokio::spawn(async move {
        if start.phase == Phase::Produce {
            super::provider(
                wire,
                provider_db,
                provider_proof,
                driven,
                false,
                true,
                (true, false, false),
            )
            .await;
        } else {
            // Keep a real socket probe alive through shutdown, including connections before headers.
            loop {
                tokio::select! {
                    biased;
                    accepted = wire.listener.accept() => {
                        let (socket, peer) = accepted.unwrap();
                        assert!(peer.ip().is_loopback());
                        provider_counts.connections.fetch_add(1, Ordering::SeqCst);
                        drop(socket);
                    }
                    _ = probe_done.cancelled() => break,
                }
            }
        }
    });
    emit(json!({"event":"ready","phase":start.phase,"pid":std::process::id(),"origin":origin}));
    let result = AssertUnwindSafe(async {
        let mut last = 0;
        let mut selected = false;
        let mut driven_once = false;
        loop {
            let command: Control = control(input).await;
            assert!(command.follows(last), "restart control order rejected");
            last = command.id();
            assert!(!provider.is_finished(), "restart provider stopped early");
            match command {
                Control::Select { id, session_id } => {
                    assert!(!selected, "restart selection rejected");
                    if start.phase == Phase::Produce {
                        db.open(session_id).await;
                    } else {
                        let reader = reader(&start.root, &session_id).await;
                        *db.reader.lock().await = Some(reader);
                        *db.session.lock().unwrap() = Some(session_id);
                    }
                    selected = true;
                    emit(json!({"event":"selected","id":id}));
                }
                Control::Drive { id, gate } => {
                    assert!(
                        start.phase == Phase::Produce && selected && !driven_once && gate == 1,
                        "restart drive rejected"
                    );
                    assert_eq!(proof.lock().unwrap().gate.take(), Some(1));
                    driven_once = true;
                    drive.send(1).await.unwrap();
                    emit(json!({"event":"driven","id":id}));
                }
                Control::Sample { id } => {
                    if start.phase == Phase::Produce {
                        assert!(
                            selected && driven_once && proof.lock().unwrap().gate == Some(2),
                            "restart gate rejected"
                        );
                    }
                    let work = work(&counts, &auth, &proof);
                    assert!(work.valid(start.phase), "restart work rejected");
                    emit(json!({"event":"sample","id":id,"work":work}));
                }
                Control::Stop { id } => {
                    assert!(
                        start.phase == Phase::Observe && selected,
                        "restart stop rejected"
                    );
                    break id;
                }
            }
        }
    })
    .catch_unwind()
    .await;
    stop.cancel();
    let outcome = watch(server).await.unwrap();
    assert!(
        outcome.http.is_ok() && matches!(&*outcome.shutdown, ShutdownOutcome::Closed),
        "restart drain rejected"
    );
    probe_stop.cancel();
    if start.phase == Phase::Observe {
        watch(provider).await.unwrap();
    } else {
        provider.abort();
        let _ = provider.await;
    }
    if let Some(reader) = db.reader.lock().await.take() {
        reader.close().await.unwrap();
    }
    let work = work(&counts, &auth, &proof);
    assert!(work.valid(start.phase), "restart shutdown work rejected");
    match result {
        Ok(id) => emit(json!({"event":"stopped","id":id,"work":work,"drained":true})),
        Err(_) => panic!("restart child failed"),
    }
}

struct Process {
    child: Child,
    messages: channel::Receiver<std::result::Result<Message, ()>>,
    stdout: Option<thread::JoinHandle<()>>,
    stderr: Option<thread::JoinHandle<Vec<u8>>>,
    reaped: bool,
    origin: String,
}
impl Process {
    fn start(root: &Path, phase: Phase) -> Self {
        let cwd = root.join(phase.directory());
        for name in ["home", "xdg", "codex", "tmp"] {
            std::fs::create_dir(cwd.join(name)).unwrap();
        }
        let exe = std::env::current_exe().unwrap();
        let mut child = Command::new(&exe)
            .args(["--exact", CHILD, "--ignored", "--nocapture"])
            .current_dir(&cwd)
            .env_clear()
            .env(MODE, "1")
            .env("HOME", cwd.join("home"))
            .env("XDG_CONFIG_HOME", cwd.join("xdg"))
            .env("CODEX_HOME", cwd.join("codex"))
            .env("TMPDIR", cwd.join("tmp"))
            .env("TMP", cwd.join("tmp"))
            .env("TEMP", cwd.join("tmp"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let pipe = child.stdout.take().unwrap();
        let (send, messages) = channel::channel();
        let stdout = thread::spawn(move || {
            let mut reader = std::io::BufReader::new(pipe);
            loop {
                let mut line = vec![];
                let length = reader
                    .by_ref()
                    .take(LIMIT + 1)
                    .read_until(b'\n', &mut line)
                    .unwrap();
                if length == 0 {
                    break;
                }
                assert!(
                    length <= LIMIT as usize && line.last() == Some(&b'\n'),
                    "restart output framing rejected"
                );
                if line.first() == Some(&b'{') {
                    let _ = send.send(decode::<Message>(&line));
                }
            }
        });
        let mut pipe = child.stderr.take().unwrap();
        let stderr = thread::spawn(move || {
            let mut bytes = vec![];
            pipe.read_to_end(&mut bytes).unwrap();
            bytes
        });
        let mut process = Self {
            child,
            messages,
            stdout: Some(stdout),
            stderr: Some(stderr),
            reaped: false,
            origin: String::new(),
        };
        process.send(&Start {
            root: root.to_owned(),
            phase,
        });
        let Message::Ready {
            phase: actual,
            pid,
            origin,
            ..
        } = process.next()
        else {
            panic!("restart ready rejected")
        };
        assert!(
            actual == phase && pid == process.child.id(),
            "restart child identity rejected"
        );
        let url = reqwest::Url::parse(&origin).unwrap();
        assert!(
            url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port().is_some(),
            "restart origin rejected"
        );
        process.origin = origin;
        emit(
            json!({"event":"restart_child_bound","phase":phase,"pid":pid,"executable":exe,"cwd":cwd,"root":root}),
        );
        process
    }
    fn send(&mut self, command: &impl Serialize) {
        let bytes = serde_json::to_vec(command).unwrap();
        assert!(bytes.len() < LIMIT as usize);
        let stdin = self.child.stdin.as_mut().unwrap();
        stdin.write_all(&bytes).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
    }
    fn next(&self) -> Message {
        let value = self
            .messages
            .recv_timeout(Duration::from_secs(30))
            .expect("restart message watchdog")
            .unwrap_or_else(|_| panic!("restart message rejected"));
        assert_eq!(value.protocol(), 1);
        value
    }
    fn select(&mut self, sid: &ApplicationSessionId) {
        self.send(&Control::Select {
            id: NonZeroU32::new(1).unwrap(),
            session_id: sid.clone(),
        });
        assert!(matches!(self.next(), Message::Selected { id, .. } if id.get() == 1));
    }
    fn sample(&mut self, id: u32, phase: Phase) {
        self.send(&Control::Sample {
            id: NonZeroU32::new(id).unwrap(),
        });
        let Message::Sample {
            id: actual, work, ..
        } = self.next()
        else {
            panic!("restart sample rejected")
        };
        assert!(
            actual.get() == id && work.valid(phase),
            "restart sample facts rejected"
        );
        emit(json!({"event":"restart_sample","phase":phase,"id":id,"work":work}));
    }
    fn get(&self, suffix: &str) -> reqwest::RequestBuilder {
        http()
            .get(format!("{}{suffix}", self.origin))
            .bearer_auth(OWNER)
    }
    fn post(&self, suffix: &str, body: &Value) -> reqwest::RequestBuilder {
        http()
            .post(format!("{}{suffix}", self.origin))
            .bearer_auth(OWNER)
            .json(body)
    }
    fn finish(&mut self, killed: bool) {
        self.child.stdin.take();
        let start = Instant::now();
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                self.reaped = true;
                break status;
            }
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "restart exit watchdog"
            );
            thread::sleep(Duration::from_millis(5));
        };
        self.stdout.take().unwrap().join().unwrap();
        let stderr = self.stderr.take().unwrap().join().unwrap();
        assert!(stderr.is_empty(), "restart child diagnostics rejected");
        assert!(
            self.messages.try_recv().is_err(),
            "restart extra evidence rejected"
        );
        if killed {
            assert_eq!(status.signal(), Some(9));
            assert!(status.code().is_none());
        } else {
            assert_eq!(status.code(), Some(0));
            assert!(status.signal().is_none());
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        if !self.reaped {
            // Failure cleanup is not the scenario's expected SIGKILL or a passing shutdown.
            let _ = self.child.kill();
            let _ = self.child.wait();
            emit(json!({"event":"restart_fallback_cleanup","pid":self.child.id()}));
        }
        if let Some(stdout) = self.stdout.take() {
            let _ = stdout.join();
        }
        if let Some(stderr) = self.stderr.take() {
            let _ = stderr.join();
        }
    }
}

async fn reader(root: &Path, sid: &ApplicationSessionId) -> SqliteConnection {
    let id = sid.as_str();
    SqliteConnectOptions::new()
        .filename(
            root.join("private-data/sessions")
                .join(&id[..2])
                .join(id)
                .join("session.sqlite3"),
        )
        .read_only(true)
        .busy_timeout(Duration::ZERO)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap()
}
#[derive(Clone, PartialEq, Eq)]
struct Native {
    head: i64,
    events: Vec<String>,
    commands: Vec<String>,
    identity: String,
    run_identity: Vec<String>,
    fields: Vec<String>,
    chunks: Vec<String>,
    entry_identity: Vec<String>,
    display: Vec<String>,
    runs: Vec<String>,
    tools: Vec<String>,
    mode: u32,
}
async fn rows(sql: &mut SqliteConnection, query: &'static str) -> Vec<String> {
    sqlx::query_scalar(query)
        .fetch_all(sql)
        .await
        .unwrap_or_else(|_| panic!("restart native audit failed"))
}
impl Native {
    async fn read(root: &Path, sid: &ApplicationSessionId) -> Self {
        let mut sql = reader(root, sid).await;
        sql.execute("BEGIN").await.unwrap();
        let head = sqlx::query_scalar("SELECT head_sequence FROM manifest")
            .fetch_one(&mut sql)
            .await
            .unwrap();
        let events = rows(&mut sql, "SELECT json_array(sequence,event_id,event_type,event_version,created_at_ms,run_id,source_event_id,source_sequence,payload_json) FROM events ORDER BY sequence").await;
        let commands = rows(&mut sql, "SELECT json_array(operation_id,method,hex(payload_hash),first_sequence,last_sequence,receipt_json) FROM commands ORDER BY first_sequence,operation_id").await;
        let identity = rows(&mut sql, "SELECT json_array(session_id,schema_version,format_version,title,workspace_json,created_at_ms,creation_provenance_json) FROM manifest").await.remove(0);
        let run_identity = rows(&mut sql, "SELECT json_array(run_id,accepted_sequence,last_runtime_sequence,owner_instance_id,provider_session_id) FROM runs ORDER BY accepted_sequence").await;
        let runs = rows(&mut sql, "SELECT json_array(run_id,accepted_sequence,state,last_runtime_sequence,owner_instance_id,provider_session_id,terminal_sequence,terminal_json,result_sequence) FROM runs ORDER BY accepted_sequence").await;
        let fields = rows(&mut sql, "SELECT json_array(run_id,entry_id,field_id,order_key,generation,byte_length,kind,metadata_json) FROM conversation_fields ORDER BY run_id,entry_id,order_key").await;
        let chunks = rows(&mut sql, "SELECT json_array(run_id,entry_id,field_id,start_byte,hex(bytes)) FROM conversation_chunks ORDER BY run_id,entry_id,field_id,start_byte").await;
        let entry_identity = rows(&mut sql, "SELECT json_array(run_id,entry_id,hex(source_key),first_sequence,position_slot,content_epoch,kind) FROM conversation_entries ORDER BY run_id,first_sequence,position_slot").await;
        let mut display = rows(&mut sql, "SELECT json_array(singleton,format_version,applied_sequence,metadata_sequence) FROM conversation_projection").await;
        display.extend(rows(&mut sql, "SELECT json_array(run_id,accepted_sequence,changed_sequence,header_json) FROM conversation_blocks ORDER BY accepted_sequence").await);
        display.extend(rows(&mut sql, "SELECT json_array(run_id,entry_id,changed_sequence,metadata_json) FROM conversation_entries ORDER BY run_id,first_sequence,position_slot").await);
        let tools = rows(&mut sql, "SELECT json_array(run_id,call_id,tool_name,request_id,started_sequence,finished_sequence,result_sequence,is_error,output) FROM tool_results ORDER BY run_id,call_id").await;
        sql.execute("COMMIT").await.unwrap();
        sql.close().await.unwrap();
        let id = sid.as_str();
        let mode = std::fs::metadata(
            root.join("private-data/sessions")
                .join(&id[..2])
                .join(id)
                .join("session.sqlite3"),
        )
        .unwrap()
        .permissions()
        .mode();
        Self {
            head,
            events,
            commands,
            identity,
            run_identity,
            fields,
            chunks,
            entry_identity,
            display,
            runs,
            tools,
            mode,
        }
    }
    fn partial_valid(&self, sid: &ApplicationSessionId, run: &RunId, body: &Value) -> bool {
        if self.events.len() != self.head as usize || self.runs.len() != 1 || !self.tools.is_empty()
        {
            return false;
        }
        let saved: Value = serde_json::from_str(&self.runs[0]).unwrap();
        if saved[0] != run.as_str()
            || saved[1] != 2
            || saved[2] != "running"
            || !saved[6].is_null()
            || !saved[7].is_null()
            || !saved[8].is_null()
        {
            return false;
        }
        let mut accepted = 0;
        let mut selected = 0;
        let mut bound = 0;
        let mut deltas = 0;
        for row in &self.events {
            let row: Value = serde_json::from_str(row).unwrap();
            let payload: Value = serde_json::from_str(row[8].as_str().unwrap()).unwrap();
            let record: StoredEvent = serde_json::from_value(json!({"schema_version":1,"application_session_id":sid,
                "sequence":row[0],"event_id":row[1],"event_type":row[2],"event_version":row[3],"created_at_ms":row[4],"run_id":row[5],"payload":payload})).unwrap();
            match record.payload() {
                StoredEventPayload::SessionCreated(_) if record.sequence() == 1 => (),
                StoredEventPayload::RunAccepted(value)
                    if value.run_id() == run
                        && record.sequence() == 2
                        && value.input().user_text() == body["text"] =>
                {
                    accepted += 1
                }
                StoredEventPayload::RunHistorySelected(value)
                    if value.run_id() == run && record.sequence() == 3 =>
                {
                    selected += 1
                }
                StoredEventPayload::RunProviderBound(value) if value.run_id() == run => bound += 1,
                StoredEventPayload::RuntimeObserved(event) if record.run_id() == Some(run) => {
                    match &event.event {
                        RunEvent::RunStarted | RunEvent::TurnStarted { .. } => (),
                        RunEvent::ProviderEvent { event } => match event.event {
                            ProviderEvent::OutputItemUpdated { .. } => deltas += 1,
                            ProviderEvent::ResponseStarted { .. }
                            | ProviderEvent::ResponseStatus { .. }
                            | ProviderEvent::OutputItemStarted { .. } => (),
                            _ => return false,
                        },
                        _ => return false,
                    }
                }
                _ => return false,
            }
        }
        accepted == 1 && selected == 1 && bound == 1 && deltas == 10
    }
    fn interrupted_once(&self, before: &Self, run: &RunId) -> bool {
        if self.head != before.head + 1
            || self.events.len() != before.events.len() + 1
            || !self.events.starts_with(&before.events)
            || self.commands != before.commands
            || self.identity != before.identity
            || self.run_identity != before.run_identity
            || self.fields != before.fields
            || self.chunks != before.chunks
            || self.entry_identity != before.entry_identity
            || self.mode != before.mode
            || self.tools != before.tools
            || !self.tools.is_empty()
        {
            return false;
        }
        let event: Value = serde_json::from_str(self.events.last().unwrap()).unwrap();
        let payload: Value = serde_json::from_str(event[8].as_str().unwrap()).unwrap();
        event[0] == self.head
            && event[2] == "run.interrupted"
            && event[5] == run.as_str()
            && payload == json!({"run_id":run,"reason":"process_restart"})
            && self
                .events
                .iter()
                .filter(|row| serde_json::from_str::<Value>(row).unwrap()[2] == "run.interrupted")
                .count()
                == 1
            && self.runs.len() == 1
            && serde_json::from_str::<Value>(&self.runs[0]).unwrap()[2] == "interrupted"
            && serde_json::from_str::<Value>(&self.runs[0]).unwrap()[8].is_null()
    }
    fn hashes(&self) -> Value {
        let hash = |rows: &[String]| {
            digest(&SHA256, &serde_json::to_vec(rows).unwrap())
                .as_ref()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        };
        json!({"canonical":hash(&self.events),"commands":hash(&self.commands),"fields":hash(&self.fields),"chunks":hash(&self.chunks)})
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Field {
    field_id: String,
    order_key: String,
    kind: String,
    generation: String,
    total_bytes: String,
    from_byte: String,
    to_byte: String,
    text: String,
    has_earlier: bool,
    has_later: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Position {
    sequence: String,
    slot: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    run_id: RunId,
    entry_id: String,
    position: Position,
    revision: String,
    content_epoch: String,
    kind: String,
    recorded_state: String,
    provisional: bool,
    reference: Value,
    result_recorded: Value,
    finish_recorded: Value,
    is_error: Value,
    fields: Vec<Field>,
    earlier_content: Value,
    content_complete: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Block {
    run_id: RunId,
    accepted_sequence: String,
    revision: String,
    state: String,
    result_recorded: bool,
    outcome: Value,
    summary: Value,
    events_complete: Value,
    sink_error: Value,
    human: Entry,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Session {
    api_version: u8,
    session_id: ApplicationSessionId,
    title: String,
    workspace: String,
    created_at_ms: String,
    updated_at_ms: String,
    head_sequence: String,
    view: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    api_version: u8,
    conversation_version: u8,
    session_id: ApplicationSessionId,
    snapshot_head: String,
    session: Session,
    block: Block,
    entries: Vec<Entry>,
    earlier_activity: Value,
    previous_block: Value,
    live_after: String,
}
fn decimal(value: &str) -> Option<u64> {
    let number: u64 = value.parse().ok()?;
    (number.to_string() == value).then_some(number)
}
fn facts() -> Vec<(&'static str, String)> {
    vec![
        ("reasoning_summary", presentation::text("summary")),
        ("reasoning_text", presentation::text("reasoning")),
        ("text", presentation::text("text")),
        ("refusal", presentation::text("refusal")),
        ("function_name", "add_numbers".into()),
        ("function_arguments", presentation::text("arguments")),
        ("function_name", "load_skill".into()),
        (
            "function_arguments",
            "{\"id\":\"project:presentation\"}".into(),
        ),
        ("function_name", "add_numbers".into()),
        (
            "function_arguments",
            "{\"a\":9223372036854775807,\"b\":1}".into(),
        ),
        ("unsupported", "Unsupported content".into()),
    ]
}
impl Page {
    fn valid(
        &self,
        sid: &ApplicationSessionId,
        run: &RunId,
        workspace: &Path,
        head: u64,
        state: &str,
    ) -> bool {
        let b = &self.block;
        if self.api_version != 1
            || self.conversation_version != 1
            || &self.session_id != sid
            || self.snapshot_head != head.to_string()
            || self.session.api_version != 1
            || &self.session.session_id != sid
            || self.session.head_sequence != self.snapshot_head
            || self.session.view != "canonical"
            || self.session.title != "restart fixture"
            || Path::new(&self.session.workspace) != workspace
            || decimal(&self.session.created_at_ms).is_none()
            || decimal(&self.session.updated_at_ms).is_none()
            || &b.run_id != run
            || b.accepted_sequence != "2"
            || b.state != state
            || b.revision != head.to_string()
            || b.result_recorded
            || !b.outcome.is_null()
            || !b.summary.is_null()
            || !b.events_complete.is_null()
            || !b.sink_error.is_null()
            || self.entries.len() != 1
            || !self.earlier_activity.is_null()
            || !self.previous_block.is_null()
        {
            return false;
        }
        let Ok(cursor) = self.live_after.parse::<crate::conversation::LiveCursor>() else {
            return false;
        };
        if cursor != crate::conversation::LiveCursor::new(sid.clone(), head, 3, None, None).unwrap()
        {
            return false;
        }
        for (entry, expected, kind, recorded, provisional) in [
            (
                &b.human,
                vec![("text", presentation::text("user"))],
                "human",
                "accepted",
                false,
            ),
            (
                &self.entries[0],
                facts(),
                "assistant",
                if state == "running" {
                    "in_progress"
                } else {
                    "interrupted"
                },
                true,
            ),
        ] {
            let Some(sequence) = decimal(&entry.position.sequence) else {
                return false;
            };
            let Some(revision) = decimal(&entry.revision) else {
                return false;
            };
            let Some(epoch) = decimal(&entry.content_epoch) else {
                return false;
            };
            if &entry.run_id != run
                || entry.entry_id != format!("e:{sequence}:0")
                || entry.position.slot != "0"
                || sequence < 2
                || sequence > head
                || revision < sequence
                || revision > head
                || epoch < sequence
                || epoch > head
                || entry.kind != kind
                || entry.recorded_state != recorded
                || entry.provisional != provisional
                || !entry.reference.is_null()
                || !entry.result_recorded.is_null()
                || !entry.finish_recorded.is_null()
                || !entry.is_error.is_null()
                || !entry.earlier_content.is_null()
                || !entry.content_complete
                || entry.fields.len() != expected.len()
            {
                return false;
            }
            let mut identities = HashSet::new();
            let mut prior = "";
            for (field, (kind, text)) in entry.fields.iter().zip(expected) {
                let Some(generation) = decimal(&field.generation) else {
                    return false;
                };
                if !identities.insert(&field.field_id)
                    || field.field_id.is_empty()
                    || field.order_key.as_str() <= prior
                    || field.kind != kind
                    || field.text != text
                    || text.is_empty()
                    || generation < sequence
                    || generation > head
                    || field.from_byte != "0"
                    || field.to_byte != text.len().to_string()
                    || field.total_bytes != field.to_byte
                    || field.has_earlier
                    || field.has_later
                {
                    return false;
                }
                prior = &field.order_key;
            }
        }
        b.human.entry_id == "e:2:0"
            && b.human.position.sequence == "2"
            && self.entries[0].position.sequence != "2"
    }
    fn content(&self) -> Value {
        // Interruption changes recorded state/revision, not content identity, layout or bytes.
        let entry = &self.entries[0];
        json!({"human":self.block.human,"run_id":entry.run_id,"entry_id":entry.entry_id,"position":entry.position,
            "content_epoch":entry.content_epoch,"fields":entry.fields,"kind":entry.kind,"provisional":entry.provisional,
            "content_complete":entry.content_complete,"earlier_content":entry.earlier_content})
    }
}
struct Public {
    page: Page,
    bytes: Vec<u8>,
}
async fn latest(
    process: &Process,
    sid: &ApplicationSessionId,
    run: &RunId,
    workspace: &Path,
    head: u64,
    state: &str,
) -> Public {
    let response = watch(
        process
            .get(&format!("/v1/sessions/{sid}/conversation"))
            .send(),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert_eq!(response.headers()["content-type"], "application/json");
    let bytes = watch(response.bytes()).await.unwrap().to_vec();
    assert!(bytes.len() <= 512 * 1024);
    let page: Page =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| panic!("restart public schema rejected"));
    private(&serde_json::from_slice::<Value>(&bytes).unwrap());
    assert!(
        page.valid(sid, run, workspace, head, state),
        "restart public facts rejected"
    );
    Public { page, bytes }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    operation_id: OperationId,
    session_id: ApplicationSessionId,
    run_id: RunId,
    first_sequence: String,
    last_sequence: String,
}
impl Receipt {
    fn valid(&self, sid: &ApplicationSessionId, body: &Value) -> bool {
        &self.session_id == sid
            && self.operation_id.as_str() == body["operation_id"]
            && self.run_id.as_str() == body["run_id"]
            && self.first_sequence == "2"
            && self.last_sequence == "3"
    }
}

fn keys(value: &Value, expected: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
    })
}
fn assert_rejected_pages(
    bytes: &[u8],
    sid: &ApplicationSessionId,
    run: &RunId,
    workspace: &Path,
    head: u64,
    state: &str,
) {
    let original: Value = serde_json::from_slice(bytes).unwrap();
    for mutation in 0..14 {
        let mut value = original.clone();
        match mutation {
            0 => value["unknown"] = json!(true),
            1 => value["block"]["run_id"] = json!(RunId::new()),
            2 => value["session_id"] = json!(ApplicationSessionId::new()),
            3 => value["snapshot_head"] = json!("01"),
            4 => value["block"]["result_recorded"] = json!(true),
            5 => value["entries"][0]["fields"][0]["text"] = json!("lost content"),
            6 => value["entries"][0]["fields"]
                .as_array_mut()
                .unwrap()
                .swap(0, 1),
            7 => {
                value["entries"][0]["fields"][1]["field_id"] =
                    value["entries"][0]["fields"][0]["field_id"].clone()
            }
            8 => value["entries"][0]["fields"][0]["generation"] = json!("0"),
            9 => value["entries"][0]["fields"][0]["to_byte"] = json!("1"),
            10 => value["entries"][0]["recorded_state"] = json!("completed"),
            11 => value["block"]["human"]["entry_id"] = value["entries"][0]["entry_id"].clone(),
            12 => value["live_after"] = json!("wrong cursor"),
            13 => value["entries"].as_array_mut().unwrap().clear(),
            _ => unreachable!(),
        }
        let valid = serde_json::from_value::<Page>(value)
            .is_ok_and(|page| page.valid(sid, run, workspace, head, state));
        assert!(!valid, "restart changed public facts accepted");
    }
}
fn assert_rejected_native(after: &Native, before: &Native, run: &RunId) {
    for mutation in 0..10 {
        let mut changed = after.clone();
        match mutation {
            0 => changed.events.swap(0, 1),
            1 => changed.events.push(changed.events.last().unwrap().clone()),
            2 => changed.commands[0].push(' '),
            3 => changed.identity.push(' '),
            4 => changed.fields[0].push(' '),
            5 => changed.chunks[0].push(' '),
            6 => changed.entry_identity[0].push(' '),
            7 => changed.tools.push("unexpected tool work".into()),
            8 => changed.mode ^= 0o040,
            9 => changed.run_identity.push("second run".into()),
            _ => unreachable!(),
        }
        assert!(
            !changed.interrupted_once(before, run),
            "restart changed native facts accepted"
        );
    }
}

#[test]
fn closed_restart_protocol_rejects_unknown_duplicate_and_invalid_controls() {
    for bytes in [
        b"{}\n".as_slice(),
        b"{\"command\":\"sample\",\"id\":0}\n",
        b"{\"command\":\"sample\",\"id\":1,\"id\":2}\n",
        b"{\"command\":\"sample\",\"id\":1,\"extra\":false}\n",
        b"{\"command\":\"cancel\",\"id\":1}\n",
        b"{\"command\":\"select\",\"id\":1,\"session_id\":\"not a uuid\"}\n",
        b"{\"command\":\"sample\",\"id\":1}",
    ] {
        assert!(decode::<Control>(bytes).is_err());
    }
    assert!(decode::<Control>(&vec![b' '; LIMIT as usize + 1]).is_err());
    let control: Control = decode(b"{\"command\":\"sample\",\"id\":2}\n").unwrap();
    assert!(control.follows(1) && !control.follows(2) && !control.follows(3));
    for bytes in [
        b"{\"root\":\"/synthetic\",\"phase\":\"resume\"}\n".as_slice(),
        b"{\"root\":\"/synthetic\",\"phase\":\"observe\",\"phase\":\"produce\"}\n",
        b"{\"root\":\"/synthetic\",\"phase\":\"observe\",\"owner\":\"forbidden\"}\n",
    ] {
        assert!(decode::<Start>(bytes).is_err());
    }
    for bytes in [
        b"{\"event\":\"sample\",\"protocol\":1,\"id\":1,\"work\":{}}\n".as_slice(),
        b"{\"event\":\"selected\",\"protocol\":1,\"id\":1,\"id\":2}\n",
        b"{\"event\":\"selected\",\"protocol\":1,\"id\":1,\"root\":\"unknown\"}\n",
    ] {
        assert!(decode::<Message>(bytes).is_err());
    }
    let message: Message = decode(b"{\"event\":\"selected\",\"protocol\":2,\"id\":1}\n").unwrap();
    assert_ne!(message.protocol(), 1);
    let temp = tempfile::Builder::new()
        .prefix("wi-restart-")
        .tempdir()
        .unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    std::fs::create_dir(root.join("observe")).unwrap();
    let mut start = Start {
        root: root.clone(),
        phase: Phase::Observe,
    };
    assert!(start.validate(&root.join("observe")));
    assert!(!start.validate(&root.join("produce")));
    start.phase = Phase::Produce;
    assert!(!start.validate(&root.join("observe")));
    start.root = PathBuf::from("relative");
    assert!(!start.validate(&root.join("observe")));
    temp.close().unwrap();
}

#[test]
fn closed_restart_work_and_receipt_reject_nonzero_resume_or_changed_identity() {
    let original = serde_json::to_value(Work::default()).unwrap();
    assert!(Work::default().valid(Phase::Observe));
    for key in original.as_object().unwrap().keys() {
        let mut changed = original.clone();
        changed[key] = if key == "fresh_empty" {
            json!(true)
        } else {
            json!(1)
        };
        let work: Work = serde_json::from_value(changed).unwrap();
        assert!(!work.valid(Phase::Observe));
    }
    let sid = ApplicationSessionId::new();
    let body = command(&presentation::text("user"));
    let original = json!({"operation_id":body["operation_id"],"session_id":sid,"run_id":body["run_id"],"first_sequence":"2","last_sequence":"3"});
    let receipt: Receipt = serde_json::from_value(original.clone()).unwrap();
    assert!(receipt.valid(&sid, &body));
    for key in [
        "operation_id",
        "session_id",
        "run_id",
        "first_sequence",
        "last_sequence",
    ] {
        let mut changed = original.clone();
        changed[key] = if key.ends_with("sequence") {
            json!("4")
        } else {
            json!(RunId::new())
        };
        let receipt: Receipt = serde_json::from_value(changed).unwrap();
        assert!(!receipt.valid(&sid, &body));
    }
    for value in [
        json!({"operation_id":body["operation_id"],"session_id":sid,"run_id":null,"first_sequence":"2","last_sequence":"3"}),
        json!({"operation_id":"invalid","session_id":sid,"run_id":body["run_id"],"first_sequence":"2","last_sequence":"3"}),
    ] {
        assert!(serde_json::from_value::<Receipt>(value).is_err());
    }
    assert!(!keys(&json!({"id":1,"extra":true}), &["id"]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_partial_producer_sigkill_public_latest_interrupts_once_without_resume() {
    let temp = tempfile::Builder::new()
        .prefix("wi-restart-")
        .tempdir()
        .unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let workspace = root.join("workspace");
    for name in ["workspace", "private-skills", "produce", "observe"] {
        std::fs::create_dir(root.join(name)).unwrap();
    }
    std::fs::write(workspace.join("AGENTS.md"), "private-project-browser\r\n").unwrap();
    presentation::setup(&workspace);
    std::fs::write(root.join("owner"), OWNER).unwrap();
    std::fs::set_permissions(root.join("owner"), std::fs::Permissions::from_mode(0o600)).unwrap();
    let source = std::fs::read(workspace.join("AGENTS.md")).unwrap();
    let mut producer = Process::start(&root, Phase::Produce);
    let create =
        json!({"operation_id":OperationId::new(),"title":"restart fixture","workspace":workspace});
    let created = json_response(producer.post("/v1/sessions", &create), 201).await;
    let sid: ApplicationSessionId = created["session_id"].as_str().unwrap().parse().unwrap();
    producer.select(&sid);
    let body = command(&presentation::text("user"));
    let run = rid(&body);
    let acceptance = json_response(
        producer.post(&format!("/v1/sessions/{sid}/runs"), &body),
        202,
    )
    .await;
    assert!(
        keys(&body, &["operation_id", "run_id", "text"])
            && keys(
                &acceptance,
                &[
                    "api_version",
                    "receipt",
                    "duplicate",
                    "warning_code",
                    "notices"
                ]
            )
            && acceptance["notices"] == json!([]),
        "restart accepted command schema rejected"
    );
    let receipt: Receipt = serde_json::from_value(acceptance["receipt"].clone()).unwrap();
    assert!(
        receipt.valid(&sid, &body)
            && acceptance["duplicate"] == false
            && acceptance["warning_code"].is_null()
    );
    assert!(matches!(
        producer.next(),
        Message::ModelPaused { gate: 1, .. }
    ));
    producer.send(&Control::Drive {
        id: NonZeroU32::new(2).unwrap(),
        gate: 1,
    });
    assert!(matches!(producer.next(), Message::Driven { id, .. } if id.get() == 2));
    assert!(matches!(
        producer.next(),
        Message::ModelPaused { gate: 2, .. }
    ));
    producer.sample(3, Phase::Produce);
    let before = Native::read(&root, &sid).await;
    assert!(
        before.partial_valid(&sid, &run, &body),
        "restart actual partial producer facts rejected"
    );
    let live = latest(
        &producer,
        &sid,
        &run,
        &workspace,
        before.head as u64,
        "running",
    )
    .await;
    assert_rejected_pages(
        &live.bytes,
        &sid,
        &run,
        &workspace,
        before.head as u64,
        "running",
    );
    assert!(
        Native::read(&root, &sid).await == before,
        "restart live observation changed bytes"
    );
    let producer_pid = producer.child.id();
    emit(
        json!({"event":"restart_before_sigkill","pid":producer_pid,"head":before.head,"rows":before.events.len(),"hashes":before.hashes()}),
    );
    // This SIGKILL is the scenario action. Drop's kill is failure-only cleanup.
    producer.child.kill().unwrap();
    producer.finish(true);
    drop(producer);
    assert!(root.exists());
    let mut observer = Process::start(&root, Phase::Observe);
    let observer_pid = observer.child.id();
    assert_ne!(producer_pid, observer_pid);
    assert!(
        Native::read(&root, &sid).await == before,
        "restart startup eagerly changed session"
    );
    observer.select(&sid);
    observer.sample(2, Phase::Observe);
    let reopened = latest(
        &observer,
        &sid,
        &run,
        &workspace,
        (before.head + 1) as u64,
        "interrupted",
    )
    .await;
    assert!(
        reopened.page.content() == live.page.content(),
        "restart lost public content"
    );
    let after = Native::read(&root, &sid).await;
    assert!(
        after.interrupted_once(&before, &run),
        "restart immutable prefix or interruption rejected"
    );
    assert_rejected_native(&after, &before, &run);
    assert_rejected_pages(
        &reopened.bytes,
        &sid,
        &run,
        &workspace,
        after.head as u64,
        "interrupted",
    );
    let reopened_head = after.head.to_string();
    for id in [3, 4] {
        let warm = latest(
            &observer,
            &sid,
            &run,
            &workspace,
            after.head as u64,
            "interrupted",
        )
        .await;
        assert!(
            warm.bytes == reopened.bytes,
            "restart warm page changed bytes"
        );
        for entry in [&warm.page.block.human, &warm.page.entries[0]] {
            let addressed = json_response(
                observer.get(&format!(
                    "/v1/sessions/{sid}/conversation/entries/{run}/{}",
                    entry.entry_id
                )),
                200,
            )
            .await;
            assert!(
                keys(
                    &addressed,
                    &[
                        "api_version",
                        "conversation_version",
                        "session_id",
                        "snapshot_head",
                        "block",
                        "entry"
                    ]
                ) && addressed["conversation_version"] == 1
                    && addressed["session_id"] == sid.as_str()
                    && addressed["snapshot_head"] == reopened_head
                    && addressed["block"] == serde_json::to_value(&warm.page.block).unwrap()
                    && addressed["entry"] == serde_json::to_value(entry).unwrap(),
                "restart addressed content changed"
            );
        }
        let reconciled = json_response(
            observer.post(&format!("/v1/sessions/{sid}/runs/reconcile"), &body),
            200,
        )
        .await;
        let saved: Receipt = serde_json::from_value(reconciled["acceptance"].clone()).unwrap();
        assert!(
            keys(&reconciled, &["api_version", "state", "acceptance", "run"])
                && keys(
                    &reconciled["run"],
                    &[
                        "api_version",
                        "run_id",
                        "state",
                        "user_text",
                        "accepted_sequence",
                        "terminal_sequence",
                        "result_sequence",
                        "result_recorded",
                        "result"
                    ]
                )
                && reconciled["run"]["api_version"] == 1
                && reconciled["run"]["accepted_sequence"] == "2"
                && reconciled["run"]["terminal_sequence"] == reopened_head
                && reconciled["run"]["result_sequence"].is_null()
                && saved.valid(&sid, &body)
                && reconciled["state"] == "accepted"
                && reconciled["acceptance"] == acceptance["receipt"]
                && reconciled["run"]["run_id"] == run.as_str()
                && reconciled["run"]["state"] == "interrupted"
                && reconciled["run"]["user_text"] == body["text"]
                && reconciled["run"]["result_recorded"] == false
                && reconciled["run"]["result"].is_null(),
            "restart reconciliation changed receipt or result"
        );
        observer.sample(id, Phase::Observe);
        assert!(
            Native::read(&root, &sid).await == after,
            "restart warm observations wrote bytes"
        );
    }
    observer.send(&Control::Stop {
        id: NonZeroU32::new(5).unwrap(),
    });
    assert!(
        matches!(observer.next(), Message::Stopped { id, work, drained: true, .. } if id.get() == 5 && work.valid(Phase::Observe))
    );
    observer.finish(false);
    drop(observer);
    assert!(
        Native::read(&root, &sid).await == after,
        "restart shutdown wrote bytes"
    );
    let store = SessionStore::open(root.join("private-data")).await.unwrap();
    let session = store.open_session(sid.clone()).await.unwrap();
    let fresh = session
        .conversation_page(crate::conversation::ConversationQuery::Latest)
        .await
        .unwrap();
    let bytes = crate::conversation::wire::DisplayJson::Page(&fresh)
        .encode()
        .unwrap();
    assert!(bytes == reopened.bytes, "restart fresh handle changed page");
    store.close().await.unwrap();
    assert!(
        Native::read(&root, &sid).await == after,
        "restart repeated fresh open wrote bytes"
    );
    assert!(std::fs::read(workspace.join("AGENTS.md")).unwrap() == source);
    let hashes = after.hashes();
    temp.close().unwrap();
    assert!(!root.exists(), "restart owned root remained");
    emit(
        json!({"event":"restart_verified","producer_pid":producer_pid,"observer_pid":observer_pid,"before_head":before.head,
        "reopened_head":after.head,"expected_signal":9,"producer_reaped":true,"observer_exit":0,"observer_reaped":true,
        "warm_observations":2,"interruption_records":1,"automatic_work":0,"result_records":0,"hashes":hashes,
        "drained":true,"root_cleaned":true}),
    );
}
