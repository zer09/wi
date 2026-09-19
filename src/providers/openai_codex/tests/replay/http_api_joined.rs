//! V1B-26..29: public HTTP commands drive the real adapter, tools and SQLite.
use super::*;
use crate::{
    Gateway,
    http_api::{ApiConfig, ApiSettings, OwnerToken, ServeOutcome, serve},
    run::{RunEvent, RunOutcome},
    service::{RunHost, ShutdownOutcome},
    storage::{
        ApplicationSessionId, CreateSession, OperationId, RecordedRunInput, RunId, SessionStore,
        StoredEvent, StoredEventPayload,
        test_hooks::{Action, Hooks, Pause, Point, Record},
    },
};
use sqlx::{ConnectOptions, Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{future::Future, path::Path};
use tokio_util::sync::CancellationToken;

#[path = "http_api_joined/failures.rs"]
mod failures;
#[path = "http_api_joined/fidelity.rs"]
mod fidelity;
#[path = "http_api_joined/identity.rs"]
mod identity;
#[path = "http_api_joined/ownership.rs"]
mod ownership;

// These credentials are synthetic and are used only on literal loopback listeners.
const OWNER: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MODEL: &str = "requested-alias";
const RAW: &str = "  load the skill and add numbers 雪\r\nline\n";
const BODY: &str = "{\"error\":\"this is successful skill content, not an error flag\"} 雪\r\n";
const INSTRUCTIONS: &str = "private-operator-instructions";

async fn watch<T>(future: impl Future<Output = T>) -> T {
    timeout(Duration::from_secs(30), future)
        .await
        .expect("joined HTTP test watchdog")
}
fn http() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder().no_proxy().build().unwrap()
}
fn private(value: &Value) {
    let text = value.to_string();
    for canary in [
        OWNER,
        TOKEN_A,
        TOKEN_B,
        ACCOUNT,
        "synthetic-account-y",
        INSTRUCTIONS,
        "private-project-",
        "private-global-body",
        "private-native",
        "private-support",
        "private-data",
        "private-skills",
        "principal_digest",
        "encrypted_content",
        "opaque_response",
        "provider_session_id",
        "prepared_request",
    ] {
        assert!(!text.contains(canary), "private field leaked: {canary}");
    }
}
async fn json_response(request: reqwest::RequestBuilder, status: u16) -> Value {
    let response = watch(request.send()).await.unwrap();
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    let value: Value = response.json().await.unwrap();
    assert_eq!(value["api_version"], 1);
    private(&value);
    value
}
fn command(text: &str) -> Value {
    json!({"operation_id":OperationId::new(),"run_id":RunId::new(),"text":text})
}
fn rid(command: &Value) -> RunId {
    command["run_id"].as_str().unwrap().parse().unwrap()
}
fn skill(path: &Path, name: &str, body: &str) {
    std::fs::create_dir_all(path).unwrap();
    std::fs::write(
        path.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: synthetic metadata\n---\n{body}"),
    )
    .unwrap();
}

struct Fixture {
    temp: tempfile::TempDir,
    address: std::net::SocketAddr,
    stop: CancellationToken,
    server: tokio::task::JoinHandle<ServeOutcome>,
    hooks: Arc<Hooks>,
    auth: Arc<CountedAuth>,
    wire: Wire,
}
impl Fixture {
    async fn new(transport: Transport) -> Self {
        let auth = Arc::new(CountedAuth::new(TOKEN_A, ACCOUNT));
        Self::with_auth(transport, auth.clone(), auth).await
    }
    async fn with_auth(
        transport: Transport,
        auth: Arc<CountedAuth>,
        source: Arc<dyn CredentialSource>,
    ) -> Self {
        let temp = tempfile::tempdir().unwrap();
        for (name, body) in [("a", BODY), ("b", "workspace B skill\n")] {
            let workspace = temp.path().join(name);
            std::fs::create_dir_all(&workspace).unwrap();
            std::fs::write(
                workspace.join("AGENTS.md"),
                format!("private-project-{name}\r\n"),
            )
            .unwrap();
            skill(&workspace.join(".agents/skills/same"), "same", body);
            skill(
                &workspace.join(".agents/skills/vanish"),
                "vanish",
                "will be removed\n",
            );
            std::fs::write(
                workspace.join(".agents/skills/same/script.sh"),
                "private-support-script",
            )
            .unwrap();
            std::fs::write(
                workspace.join(".agents/skills/same/resource.txt"),
                "private-support-resource",
            )
            .unwrap();
        }
        skill(
            &temp.path().join("private-skills/same"),
            "same",
            "private-global-body",
        );
        let bad = temp.path().join("a/.agents/skills/bad");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("SKILL.md"), "---\nname: [private-invalid\n---\n").unwrap();
        let token = temp.path().join("owner");
        std::fs::write(&token, OWNER).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let wire = Wire::new(transport).await;
        let mut gateway = Gateway::new();
        gateway
            .register(Arc::new(OpenAiCodexProvider::loopback(
                source,
                transport,
                wire.listener.local_addr().unwrap(),
            )))
            .unwrap();
        let store = SessionStore::open(temp.path().join("private-data"))
            .await
            .unwrap();
        // This unrelated seed exposes existing store-wide test barriers, not replay input.
        // Every session under test is created through HTTP below.
        let seed = store
            .create_session(
                CreateSession::new(OperationId::new(), "barriers".into(), None).unwrap(),
            )
            .await
            .unwrap();
        let hooks = store
            .open_session(seed.session_id().clone())
            .await
            .unwrap()
            .test_hooks();
        let host = RunHost::new(store, Arc::new(gateway)).unwrap();
        let mut options = SessionOptions::new(MODEL);
        options.transport = transport;
        options.instructions = INSTRUCTIONS.into();
        let settings = ApiSettings::new(
            "https://wi.example.test",
            vec![temp.path().join("a"), temp.path().join("b")],
            temp.path().join("private-skills"),
            PROVIDER_ID.into(),
            options,
            true,
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let stop = CancellationToken::new();
        let server = tokio::spawn(serve(
            listener,
            host,
            ApiConfig::new(settings, OwnerToken::load(&token).unwrap()),
            stop.clone(),
        ));
        Self {
            temp,
            address,
            stop,
            server,
            hooks,
            auth,
            wire,
        }
    }
    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        http()
            .get(format!("http://{}{path}", self.address))
            .bearer_auth(OWNER)
    }
    fn post(&self, path: &str, body: &Value) -> reqwest::RequestBuilder {
        http()
            .post(format!("http://{}{path}", self.address))
            .bearer_auth(OWNER)
            .json(body)
    }
    async fn create(&self, workspace: &str) -> ApplicationSessionId {
        let body = json!({"operation_id":OperationId::new(),"title":"joined 雪\r\n", "workspace":std::fs::canonicalize(self.temp.path().join(workspace)).unwrap()});
        let response = json_response(self.post("/v1/sessions", &body), 201).await;
        response["session_id"].as_str().unwrap().parse().unwrap()
    }
    async fn submit(&self, sid: &ApplicationSessionId, body: &Value) -> Value {
        json_response(self.post(&format!("/v1/sessions/{sid}/runs"), body), 202).await
    }
    async fn run(&self, sid: &ApplicationSessionId, body: &Value) -> Value {
        json_response(
            self.get(&format!("/v1/sessions/{sid}/runs/{}", rid(body))),
            200,
        )
        .await
    }
    async fn finished(&self, sid: &ApplicationSessionId, body: &Value) -> Value {
        watch(async {
            loop {
                let run = self.run(sid, body).await;
                if run["result_recorded"] == true {
                    return run;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
    }
    async fn reader(&self, sid: &ApplicationSessionId) -> SqliteConnection {
        let id = sid.as_str();
        SqliteConnectOptions::new()
            .filename(
                self.temp
                    .path()
                    .join("private-data/sessions")
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
    async fn records(&self, sid: &ApplicationSessionId) -> Vec<StoredEvent> {
        let mut reader = self.reader(sid).await;
        let rows = sqlx::query("SELECT sequence,event_id,event_type,event_version,created_at_ms,run_id,payload_json FROM events ORDER BY sequence").fetch_all(&mut reader).await.unwrap();
        reader.close().await.unwrap();
        rows.into_iter().map(|row| {
            let payload: Value = serde_json::from_str(row.get::<&str,_>("payload_json")).unwrap();
            serde_json::from_value(json!({"schema_version":1,"application_session_id":sid,
                "sequence":row.get::<i64,_>("sequence"),"event_id":row.get::<String,_>("event_id"),
                "event_type":row.get::<String,_>("event_type"),"event_version":row.get::<i64,_>("event_version"),
                "created_at_ms":row.get::<i64,_>("created_at_ms"),"run_id":row.get::<Option<String>,_>("run_id"),"payload":payload})).unwrap()
        }).collect()
    }
    async fn input(&self, sid: &ApplicationSessionId, body: &Value) -> RecordedRunInput {
        self.records(sid)
            .await
            .into_iter()
            .find_map(|event| {
                if event.run_id() == Some(&rid(body))
                    && let StoredEventPayload::RunAccepted(accepted) = event.payload()
                {
                    Some(accepted.input().clone())
                } else {
                    None
                }
            })
            .unwrap()
    }
    async fn history(&self, sid: &ApplicationSessionId) -> Vec<Value> {
        let page = json_response(
            self.get(&format!("/v1/sessions/{sid}/history?limit=7")),
            200,
        )
        .await;
        self.pages(sid, page).await
    }
    async fn pages(&self, sid: &ApplicationSessionId, mut page: Value) -> Vec<Value> {
        let head = page["through_sequence"].as_str().unwrap().to_owned();
        let mut events = vec![];
        loop {
            assert_eq!(page["through_sequence"], head);
            events.extend(page["events"].as_array().unwrap().iter().cloned());
            if page["has_more"] == false {
                break;
            }
            page = json_response(
                self.get(&format!(
                    "/v1/sessions/{sid}/history?limit=7&through={head}&after={}",
                    page["next_after"].as_str().unwrap()
                )),
                200,
            )
            .await;
        }
        events
    }
    fn pause(&self, record: Record, point: Point) -> Arc<Pause> {
        let pause = Arc::new(Pause::default());
        self.hooks
            .arm_record(record, point, Action::Pause(pause.clone()));
        pause
    }
    async fn finish(mut self) {
        self.wire.closed().await;
        self.wire.no_request();
        self.stop.cancel();
        let outcome = watch(self.server).await.unwrap();
        assert_eq!(outcome.http, Ok(()));
        assert!(matches!(&*outcome.shutdown, ShutdownOutcome::Closed));
    }
}

struct Wire {
    transport: Transport,
    listener: TcpListener,
    websocket: Option<WebSocketStream<TcpStream>>,
    sse: Option<TcpStream>,
    requests: usize,
}
impl Wire {
    async fn new(transport: Transport) -> Self {
        Self {
            transport,
            listener: TcpListener::bind("127.0.0.1:0").await.unwrap(),
            websocket: None,
            sse: None,
            requests: 0,
        }
    }
    async fn receive(&mut self) -> Value {
        let body = watch(async {
            if self.transport == Transport::WebSocket {
                if self.websocket.is_none() {
                    self.websocket = Some(accept_counted(&self.listener, TOKEN_A, ACCOUNT).await);
                }
                incoming(self.websocket.as_mut().unwrap()).await
            } else {
                let (mut socket, peer) = self.listener.accept().await.unwrap();
                assert!(peer.ip().is_loopback());
                let body = read_counted_http(&mut socket, TOKEN_A, ACCOUNT).await;
                self.sse = Some(socket);
                body
            }
        })
        .await;
        self.requests += 1;
        body
    }
    async fn reply(&mut self, reply: Vec<Value>, mime: Option<&str>) {
        if let Some(socket) = &mut self.websocket {
            for event in reply {
                send(socket, event).await;
            }
        } else {
            send_events_http_mime(self.sse.as_mut().unwrap(), reply, mime).await;
            self.sse = None;
        }
    }
    async fn closed(&mut self) {
        if let Some(mut socket) = self.websocket.take() {
            watch(drain_close(&mut socket)).await;
        }
        assert!(self.sse.is_none());
    }
    fn no_request(&self) {
        assert!(
            self.listener.accept().now_or_never().is_none(),
            "unexpected retry/fallback/connection"
        );
    }
}

struct Browser {
    response: reqwest::Response,
    pending: Vec<u8>,
}
impl Browser {
    async fn open(fixture: &Fixture, sid: &ApplicationSessionId, after: u64) -> Self {
        let response = watch(
            fixture
                .get(&format!("/v1/sessions/{sid}/events"))
                .header("Last-Event-ID", format!("{sid}:{after}"))
                .send(),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        Self {
            response,
            pending: vec![],
        }
    }
    async fn event(&mut self, sid: &ApplicationSessionId, sequence: u64) -> Value {
        watch(async {
            loop {
                if let Some(end) = self.pending.windows(2).position(|w| w == b"\n\n") {
                    let frame = String::from_utf8(self.pending.drain(..end + 2).collect()).unwrap();
                    let lines: Vec<_> = frame.lines().collect();
                    assert_eq!(lines.len(), 4);
                    assert_eq!(lines[0], "event: wi.event");
                    assert_eq!(lines[1], format!("id: {sid}:{sequence}"));
                    let event: Value =
                        serde_json::from_str(lines[2].strip_prefix("data: ").unwrap()).unwrap();
                    assert_eq!(event["session_id"], sid.as_str());
                    assert_eq!(event["sequence"], sequence.to_string());
                    private(&event);
                    return event;
                }
                self.pending.extend_from_slice(
                    &self
                        .response
                        .chunk()
                        .await
                        .unwrap()
                        .expect("premature browser SSE EOF"),
                );
            }
        })
        .await
    }
}

async fn complete_add(f: &mut Fixture, sid: &ApplicationSessionId) -> (Value, Vec<Value>) {
    let command = command(RAW);
    f.submit(sid, &command).await;
    let body = f.wire.receive().await;
    let input = f.input(sid, &command).await;
    let mut context = vec![user(&input.prepared_request().prompt)];
    assert_request(&body, &context, None, &input);
    let calls = vec![call("add", "add_numbers", "{\"a\":17, \"b\":25}")];
    f.wire
        .reply(
            events("first-tools", calls.clone(), false),
            Some("text/event-stream"),
        )
        .await;
    let body = f.wire.receive().await;
    context.extend(calls);
    context.push(output("add", "{\"sum\":42}"));
    let expected = if f.wire.transport == Transport::WebSocket {
        vec![output("add", "{\"sum\":42}")]
    } else {
        context.clone()
    };
    assert_request(
        &body,
        &expected,
        (f.wire.transport == Transport::WebSocket).then_some("first-tools"),
        &input,
    );
    f.wire
        .reply(
            events("first-final", final_items(), false),
            Some("text/event-stream"),
        )
        .await;
    assert_eq!(f.finished(sid, &command).await["state"], "completed");
    context.extend(final_items());
    f.wire.closed().await;
    (command, context)
}

fn call(id: &str, name: &str, arguments: &str) -> Value {
    json!({"type":"function_call","id":format!("item-{id}"),"call_id":id,"name":name,"arguments":arguments,"status":"completed"})
}
fn final_items() -> Vec<Value> {
    vec![
        json!({"type":"message","id":"final","role":"assistant","status":"completed", "content":[{"type":"output_text","text":"answer 雪\r\nline\n","annotations":[{"private-native":"secret"}]}]}),
    ]
}
fn output(call_id: &str, text: &str) -> Value {
    json!({"type":"function_call_output","call_id":call_id,"output":text})
}
fn assert_request(
    body: &Value,
    input: &[Value],
    parent: Option<&str>,
    prepared: &RecordedRunInput,
) {
    assert_eq!(body["input"], json!(input));
    assert_eq!(body["previous_response_id"], json!(parent));
    assert_eq!(body["model"], MODEL);
    assert_eq!(body["store"], false);
    assert_eq!(
        body["instructions"],
        prepared.prepared_request().options.instructions
    );
    let tools: Vec<_> = prepared.tool_definitions().iter().map(|d| json!({"type":"function","name":d.name,"description":d.description,"parameters":d.parameters,"strict":d.strict})).collect();
    assert_eq!(body["tools"], json!(tools));
    if prepared.prepared_request().options.transport == Transport::WebSocket {
        assert_eq!(body["type"], "response.create");
        assert!(body.get("stream").is_none());
    } else {
        assert_eq!(body["stream"], true);
        assert!(body.get("type").is_none());
    }
}
