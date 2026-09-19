use super::*;
use crate::{
    Capability, ConversationReplay, EventEnvelope, GatewayError, InputItem, ModelResponse,
    Provider, ProviderCapabilities, ProviderEvent, ProviderSession, ReplayIdentity, RequestReceipt,
    ResponseOutcome, SessionControl,
    storage::{
        RecordedRun,
        test_hooks::{Action, Pause, Point, Record},
    },
};
use async_trait::async_trait;
use sqlx::{ConnectOptions, Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;

mod failures;
mod preparation;
mod races;
mod receipts;
mod reducer;

const RAW: &str = "  raw task 雪\r\ntext\n";

#[derive(Clone, Copy, Default)]
enum Mode {
    #[default]
    Good,
    Preflight,
    Open,
    Identity,
    Install,
    Model,
}

#[derive(Default)]
struct Control {
    mode: Mode,
    waiting: Notify,
    release: Notify,
    generated: Notify,
    inputs: Mutex<Vec<Vec<InputItem>>>,
    installed: Mutex<Vec<ConversationReplay>>,
    closes: AtomicUsize,
}
struct Script {
    mode: Mode,
    opens: AtomicUsize,
    validations: AtomicUsize,
    options: Mutex<Vec<SessionOptions>>,
    control: Arc<Control>,
    responses: Vec<ModelResponse>,
}
impl Script {
    fn new(mode: Mode, responses: Vec<ModelResponse>) -> (Arc<Gateway>, Arc<Self>) {
        let script = Arc::new(Self {
            mode,
            opens: AtomicUsize::new(0),
            validations: AtomicUsize::new(0),
            options: Mutex::new(vec![]),
            control: Arc::new(Control {
                mode,
                ..Default::default()
            }),
            responses,
        });
        let mut gateway = Gateway::new();
        gateway.register(script.clone()).unwrap();
        (Arc::new(gateway), script)
    }
    async fn server() -> (Server, Arc<Self>) {
        let (gateway, script) = Self::new(Mode::Good, vec![model("final")]);
        (Server::gateway(gateway).await, script)
    }
}
fn count(value: &AtomicUsize) -> usize {
    value.load(Ordering::SeqCst)
}
fn model(id: &str) -> ModelResponse {
    ModelResponse {
        id: id.into(),
        model: Some("synthetic-model".into()),
        outcome: ResponseOutcome::Completed,
        output: vec![],
        text: "answer 雪\r\n".into(),
        usage: None,
        native: json!({"private":"private-native-canary"}),
        output_provenance: Default::default(),
    }
}
#[async_trait]
impl Provider for Script {
    fn id(&self) -> &'static str {
        "http-test"
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let yes = Capability {
            implemented: true,
            verification: "synthetic HTTP tests".into(),
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
        _: &SessionOptions,
        replay: &ConversationReplay,
        _: &[InputItem],
    ) -> crate::Result<()> {
        self.validations.fetch_add(1, Ordering::SeqCst);
        assert!(replay.runs().is_empty());
        if matches!(self.mode, Mode::Preflight) {
            return Err(GatewayError::UnsupportedFeature("private-format-canary"));
        }
        Ok(())
    }
    async fn open_session(&self, options: SessionOptions) -> crate::Result<ProviderSession> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        self.options.lock().unwrap().push(options);
        if matches!(self.mode, Mode::Open) {
            return Err(GatewayError::AuthExpired);
        }
        let control = self.control.clone();
        let responses = self.responses.clone();
        Ok(ProviderSession {
            id: "private-provider-session-canary".into(),
            control: control.clone(),
            events: Box::pin(async_stream::stream! {
                for (index, response) in responses.into_iter().enumerate() {
                    control.generated.notified().await;
                    control.waiting.notify_one();
                    control.release.notified().await;
                    for (offset, event) in [
                        ProviderEvent::ResponseStarted { response_id: response.id.clone() },
                        ProviderEvent::ResponseFinished { response },
                    ].into_iter().enumerate() {
                        yield EventEnvelope {
                            schema_version: 1, sequence: (index * 2 + offset + 1) as u64,
                            event_id: format!("event-{index}-{offset}"), session_id: "private-provider-session-canary".into(),
                            request_id: Some(format!("request-{index}")), provider: "http-test".into(), provider_sequence: None, event,
                        };
                    }
                }
            }),
        })
    }
}
#[async_trait]
impl SessionControl for Control {
    fn replay_identity(&self) -> Option<ReplayIdentity> {
        if matches!(self.mode, Mode::Identity) {
            return None;
        }
        Some(
            ReplayIdentity::new(
                "http-test".into(),
                "private-format-canary".into(),
                "a".repeat(64),
            )
            .unwrap(),
        )
    }
    async fn install_replay(&self, replay: ConversationReplay) -> crate::Result<()> {
        self.installed.lock().unwrap().push(replay);
        if matches!(self.mode, Mode::Install) {
            return Err(GatewayError::Protocol("private-format-canary"));
        }
        Ok(())
    }
    async fn generate(&self, input: Vec<InputItem>) -> crate::Result<RequestReceipt> {
        let mut inputs = self.inputs.lock().unwrap();
        let request_id = format!("request-{}", inputs.len());
        inputs.push(input);
        if matches!(self.mode, Mode::Model) {
            return Err(GatewayError::Protocol("private-format-canary"));
        }
        self.generated.notify_one();
        Ok(RequestReceipt { request_id })
    }
    fn close(&self) {
        self.closes.fetch_add(1, Ordering::SeqCst);
    }
}
fn command() -> Value {
    json!({"operation_id":OperationId::new(),"run_id":RunId::new(),"text":RAW})
}
fn run(body: &Value) -> RunId {
    body["run_id"].as_str().unwrap().parse().unwrap()
}
fn operation(body: &Value) -> OperationId {
    body["operation_id"].as_str().unwrap().parse().unwrap()
}
fn path(session: &SessionHandle) -> String {
    format!("/v1/sessions/{}/runs", session.session_id())
}
async fn finished(session: &SessionHandle, body: &Value) -> RecordedRun {
    watchdog(async {
        loop {
            let record = session.run_record(run(body)).await.unwrap().unwrap();
            if record.result().is_some() {
                return record;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
}
async fn sql(server: &Server, session: &SessionHandle, read_only: bool) -> SqliteConnection {
    let id = session.session_id().as_str();
    let file = server
        .temp
        .path()
        .join("private-data-canary/sessions")
        .join(&id[..2])
        .join(id)
        .join("session.sqlite3");
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(file)
            .read_only(read_only)
            .busy_timeout(Duration::ZERO)
            .disable_statement_logging(),
    )
    .await
    .unwrap()
}
async fn wire(server: &Server, session: &SessionHandle, body: &Value) -> TcpStream {
    let body = body.to_string();
    let mut socket = TcpStream::connect(server.address).await.unwrap();
    socket.write_all(format!("POST {} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", path(session), server.address, body.len()).as_bytes()).await.unwrap();
    socket
}
