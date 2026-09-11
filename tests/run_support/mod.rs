use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    future::pending,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use wi::{
    run::*,
    tools::{Tool, ToolRegistry},
    *,
};

pub const ID: &str = "independent-script";
#[derive(Default)]
pub struct Records {
    pub eof: AtomicBool,
    pub tool_calls: AtomicUsize,
    pub definitions: AtomicUsize,
    pub opens: AtomicUsize,
    pub attempts: AtomicUsize,
    pub receipts: AtomicUsize,
    pub closes: AtomicUsize,
    pub inputs: Mutex<Vec<Vec<InputItem>>>,
    pub options: Mutex<Vec<SessionOptions>>,
    pub events: Mutex<Vec<EventEnvelope>>,
    pub open_entered: Notify,
    pub generate_entered: Notify,
    pub stream_entered: Notify,
}
pub enum Step {
    Response(ModelResponse),
    Events(Vec<EventEnvelope>),
    Reject,
    PendingGenerate,
    PendingOutput,
    Eof,
}
pub struct Script {
    pub records: Arc<Records>,
    pub steps: Mutex<VecDeque<Step>>,
    pub capabilities: ProviderCapabilities,
    pub pending_open: bool,
    pub fail_open: bool,
}
pub fn capabilities() -> ProviderCapabilities {
    let yes = Capability {
        implemented: true,
        verification: "synthetic offline".into(),
    };
    ProviderCapabilities {
        websocket: yes.clone(),
        sse: yes.clone(),
        continuation: yes.clone(),
        function_tools: yes,
        advanced: vec![],
    }
}
impl Script {
    pub fn new(steps: Vec<Step>) -> Self {
        Self {
            records: Arc::new(Records::default()),
            steps: Mutex::new(steps.into()),
            capabilities: capabilities(),
            pending_open: false,
            fail_open: false,
        }
    }
}
struct Control {
    records: Arc<Records>,
    steps: Mutex<VecDeque<Step>>,
    session: String,
    sequence: AtomicUsize,
    sender: tokio::sync::mpsc::UnboundedSender<EventEnvelope>,
}
#[async_trait]
impl SessionControl for Control {
    async fn generate(&self, input: Vec<InputItem>) -> Result<RequestReceipt> {
        self.records.attempts.fetch_add(1, Ordering::SeqCst);
        self.records.inputs.lock().unwrap().push(input);
        self.records.generate_entered.notify_one();
        let step = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected extra generation");
        let request = format!("q{}", self.records.receipts.load(Ordering::SeqCst) + 1);
        let events = match step {
            Step::Reject => {
                return Err(GatewayError::Protocol("synthetic private provider detail"));
            }
            Step::PendingGenerate => return pending().await,
            Step::PendingOutput => vec![],
            Step::Eof => {
                self.records.eof.store(true, Ordering::SeqCst);
                vec![]
            }
            Step::Response(response) => vec![
                ProviderEvent::ResponseStarted {
                    response_id: response.id.clone(),
                },
                ProviderEvent::ResponseFinished { response },
            ]
            .into_iter()
            .map(|event| EventEnvelope {
                schema_version: 1,
                sequence: self.sequence.fetch_add(3, Ordering::SeqCst) as u64,
                event_id: "opaque-event".into(),
                session_id: self.session.clone(),
                request_id: Some(request.clone()),
                provider: ID.into(),
                provider_sequence: Some(999),
                event,
            })
            .collect(),
            Step::Events(events) => events,
        };
        for event in events {
            self.records.events.lock().unwrap().push(event.clone());
            self.sender.send(event).unwrap();
        }
        self.records.receipts.fetch_add(1, Ordering::SeqCst);
        Ok(RequestReceipt {
            request_id: request,
        })
    }
    fn close(&self) {
        self.records.closes.fetch_add(1, Ordering::SeqCst);
    }
}
#[async_trait]
impl Provider for Script {
    fn id(&self) -> &'static str {
        ID
    }
    fn capabilities(&self) -> ProviderCapabilities {
        self.capabilities.clone()
    }
    async fn open_session(&self, options: SessionOptions) -> Result<ProviderSession> {
        let n = self.records.opens.fetch_add(1, Ordering::SeqCst) + 1;
        self.records.options.lock().unwrap().push(options);
        self.records.open_entered.notify_one();
        if self.pending_open {
            return pending().await;
        }
        if self.fail_open {
            return Err(GatewayError::Protocol("private open detail"));
        }
        let id = format!("s{n}");
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let control = Arc::new(Control {
            records: self.records.clone(),
            steps: Mutex::new(std::mem::take(&mut *self.steps.lock().unwrap())),
            session: id.clone(),
            sequence: AtomicUsize::new(1),
            sender,
        });
        let records = self.records.clone();
        let events = Box::pin(async_stream::stream! {
            records.stream_entered.notify_one();
            while !records.eof.load(Ordering::SeqCst) {
                let Some(event) = receiver.recv().await else { break };
                yield event;
            }
        });
        Ok(ProviderSession {
            id,
            control,
            events,
        })
    }
}
pub fn setup(steps: Vec<Step>) -> (Gateway, Arc<Script>, wi::tools::ToolRegistry) {
    let script = Arc::new(Script::new(steps));
    let mut gateway = Gateway::new();
    gateway.register(script.clone()).unwrap();
    let mut tools = wi::tools::ToolRegistry::new();
    tools
        .register(Arc::new(CountingAdd(script.records.clone())))
        .unwrap();
    (gateway, script, tools)
}
struct CountingAdd(Arc<Records>);
#[async_trait]
impl wi::tools::Tool for CountingAdd {
    fn definition(&self) -> ToolDefinition {
        self.0.definitions.fetch_add(1, Ordering::SeqCst);
        wi::tools::add_numbers_definition()
    }
    fn validate(&self, arguments: &Value) -> Result<()> {
        wi::tools::Tool::validate(&wi::tools::AddNumbers, arguments)
    }
    async fn execute(&self, arguments: Value) -> Result<Value> {
        self.0.tool_calls.fetch_add(1, Ordering::SeqCst);
        wi::tools::Tool::execute(&wi::tools::AddNumbers, arguments).await
    }
}
pub fn request() -> wi::run::RunRequest {
    wi::run::RunRequest {
        provider_id: ID.into(),
        options: SessionOptions::new("opaque-model"),
        prompt: "add the numbers".into(),
    }
}
pub fn response(id: &str, output: Vec<OutputItem>, text: &str) -> ModelResponse {
    ModelResponse {
        id: id.into(),
        model: Some("opaque-model".into()),
        outcome: ResponseOutcome::Completed,
        output,
        text: text.into(),
        usage: None,
        native: json!({"independent_final_token": [9, "keep"]}),
        output_provenance: Default::default(),
    }
}
pub fn call(id: &str, a: i64, b: i64) -> OutputItem {
    OutputItem {
        id: Some(format!("item-{id}")),
        kind: ItemKind::FunctionCall,
        native_type: "opaque-invocation".into(),
        function_call: Some(FunctionCall {
            call_id: id.into(),
            name: "add_numbers".into(),
            arguments: json!({"a":a,"b":b}).to_string(),
            origin: CallOrigin::Direct,
            namespace: None,
            complete: true,
        }),
        native: json!({"independent_instruction": [a,b]}),
    }
}
pub fn value(input: &[InputItem]) -> Value {
    serde_json::to_value(input).unwrap()
}
pub fn count(n: &AtomicUsize) -> usize {
    n.load(Ordering::SeqCst)
}
pub fn envelope(sequence: u64, event: ProviderEvent) -> EventEnvelope {
    EventEnvelope {
        schema_version: 1,
        sequence,
        event_id: format!("e{sequence}"),
        session_id: "s1".into(),
        request_id: Some("q1".into()),
        provider: ID.into(),
        provider_sequence: None,
        event,
    }
}

pub(super) struct ProbeTool {
    pub(super) calls: AtomicUsize,
    pub(super) dropped: Arc<AtomicUsize>,
    pub(super) entered: Notify,
    mode: Mode,
    pub(super) definitions: AtomicUsize,
}
pub(super) enum Mode {
    Pending,
    PendingAfterFirst,
    Large,
    InvalidDefinition,
}
pub(super) struct DropProbe(pub(super) Arc<AtomicUsize>);
impl Drop for DropProbe {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
impl ProbeTool {
    pub(super) fn new(mode: Mode) -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            dropped: Arc::new(AtomicUsize::new(0)),
            entered: Notify::new(),
            mode,
            definitions: AtomicUsize::new(0),
        })
    }
}
#[async_trait]
impl Tool for ProbeTool {
    fn definition(&self) -> ToolDefinition {
        let n = self.definitions.fetch_add(1, Ordering::SeqCst);
        let mut definition = wi::tools::add_numbers_definition();
        if matches!(self.mode, Mode::InvalidDefinition) && n > 0 {
            definition.parameters = Value::Null;
        }
        definition
    }
    fn validate(&self, args: &Value) -> wi::Result<()> {
        wi::tools::AddNumbers.validate(args)
    }
    async fn execute(&self, args: Value) -> wi::Result<Value> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        let _drop = DropProbe(self.dropped.clone());
        self.entered.notify_one();
        match self.mode {
            Mode::Pending => pending().await,
            Mode::PendingAfterFirst => {
                if n == 0 {
                    wi::tools::AddNumbers.execute(args).await
                } else {
                    pending().await
                }
            }
            Mode::Large => Ok(json!({"value":"x".repeat(70*1024)})),
            Mode::InvalidDefinition => panic!("invalid definition admitted"),
        }
    }
}

pub(super) async fn observed(
    gateway: &Gateway,
    req: RunRequest,
    tools: &ToolRegistry,
) -> (RunResult, Vec<RunEventEnvelope>) {
    let mut events = Vec::new();
    let result = run(gateway, req, tools, CancellationToken::new(), |event| {
        events.push(event.clone());
        Ok(())
    })
    .await
    .unwrap();
    (result, events)
}
pub(super) fn trace(events: &[RunEventEnvelope]) -> Vec<&str> {
    events
        .iter()
        .map(|e| match e.event {
            RunEvent::RunStarted => "run_started",
            RunEvent::TurnStarted { .. } => "turn_started",
            RunEvent::ProviderEvent { .. } => "provider_event",
            RunEvent::ToolEvent { .. } => "tool_event",
            RunEvent::TurnFinished { .. } => "turn_finished",
            RunEvent::RunFinished { .. } => "run_finished",
        })
        .collect()
}
pub(super) fn failed_as(result: &RunResult, code: &str) {
    assert_eq!(result.outcome, RunOutcome::Failed { code: code.into() });
}
pub(super) fn healthy(result: &RunResult, events: &[RunEventEnvelope], records: &Records) {
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    assert_eq!(count(&records.opens), 1);
    assert_eq!(count(&records.closes), 1);
    assert_eq!(
        result.summary.model_requests_attempted as usize,
        count(&records.attempts)
    );
    assert_eq!(
        result.summary.model_requests_admitted as usize,
        count(&records.receipts)
    );
    assert_eq!(
        result.summary.new_tool_dispatches as usize,
        count(&records.tool_calls)
    );
    assert_eq!(count(&records.definitions), 2);
    assert_eq!(result.summary.turns_started, result.summary.turns_finished);
    assert_eq!(trace(events).first(), Some(&"run_started"));
    assert_eq!(trace(events).last(), Some(&"run_finished"));
    let mut ids = std::collections::HashSet::new();
    let mut turns = std::collections::HashSet::new();
    for (i, event) in events.iter().enumerate() {
        assert_eq!(event.schema_version, 2);
        assert_eq!(event.sequence, i as u64 + 1);
        assert_eq!(event.run_id, result.run_id);
        assert!(uuid::Uuid::parse_str(&event.event_id).is_ok());
        assert!(ids.insert(&event.event_id));
        match &event.event {
            RunEvent::RunStarted => {
                assert!(
                    event.session_id.is_none()
                        && event.turn_id.is_none()
                        && event.request_id.is_none()
                );
            }
            RunEvent::RunFinished { summary, .. } => {
                assert!(event.turn_id.is_none());
                assert_eq!(
                    serde_json::to_value(summary).unwrap(),
                    serde_json::to_value(&result.summary).unwrap()
                );
            }
            RunEvent::TurnStarted { number } => {
                assert!(event.request_id.is_none());
                assert!(turns.insert(event.turn_id.clone().unwrap()));
                assert_eq!(*number as usize, turns.len());
            }
            RunEvent::ProviderEvent { event: nested } => {
                assert_eq!(nested.schema_version, 1);
                assert_eq!(event.request_id, nested.request_id);
                assert_eq!(event.session_id.as_ref(), Some(&nested.session_id));
                assert!(
                    records
                        .events
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|record| serde_json::to_value(record).unwrap()
                            == serde_json::to_value(nested).unwrap())
                );
            }
            _ => {}
        }
    }
}
