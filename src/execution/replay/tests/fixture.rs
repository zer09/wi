use super::*;
use crate::execution::observer::PersistentObserver;
use crate::{
    Capability, EventEnvelope, Gateway, Provider, ProviderCapabilities, ProviderSession,
    RequestReceipt, SessionControl, SessionOptions, ToolDefinition,
    run::{self, RunEvent, RunEventEnvelope, RunObserver, RunRequest, RunResult, RunSinkError},
    storage::{AppendRunRecord, RecordedProviderBinding, RecordedRunInput},
    tools::{AddNumbers, Tool, ToolExecutionEvent, ToolRegistry, add_numbers_definition},
};
use async_trait::async_trait;
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

pub const ID: &str = "replay-script";
pub const MODEL: &str = "requested-alias";

#[derive(Default)]
pub struct Counters {
    pub opens: AtomicUsize,
    pub closes: AtomicUsize,
    pub validates: AtomicUsize,
    pub executes: AtomicUsize,
    pub replay_checks: AtomicUsize,
    pub inputs: Mutex<Vec<Vec<InputItem>>>,
    pub waiting: Notify,
    pub release_tool: Notify,
}
impl Counters {
    pub fn work(&self) -> (usize, usize, usize, usize, usize) {
        (
            self.opens.load(Ordering::SeqCst),
            self.closes.load(Ordering::SeqCst),
            self.validates.load(Ordering::SeqCst),
            self.executes.load(Ordering::SeqCst),
            self.inputs.lock().unwrap().len(),
        )
    }
}

pub fn identity(principal: char) -> ReplayIdentity {
    ReplayIdentity::new(
        ID.into(),
        "script-native-v1".into(),
        principal.to_string().repeat(64),
    )
    .unwrap()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    Never,
    Response,
    ResponseSink,
    Intent,
    Result,
    Finish,
    ToolsPrepared,
    Partial,
    SecondTurn,
    OpenFail,
    Opened,
    Exit(ExitAt),
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ExitAt {
    Opened,
    Response,
    Partial,
    Intent,
    Result(&'static str),
    Finish(&'static str),
    Turn(u64),
}
pub enum Step {
    Response(ModelResponse),
    Deltas(ModelResponse, usize),
    Partial,
    Reject,
    Wait,
    Exit,
}
pub struct Plan {
    pub input: RecordedRunInput,
    pub identity: ReplayIdentity,
    pub steps: Vec<Step>,
    pub stop: Stop,
    pub final_result: bool,
    pub selected: bool,
}
impl Plan {
    pub fn new(input: RecordedRunInput, responses: Vec<ModelResponse>) -> Self {
        Self {
            input,
            identity: identity('a'),
            steps: responses.into_iter().map(Step::Response).collect(),
            stop: Stop::Never,
            final_result: true,
            selected: true,
        }
    }
}

// This provider uses only the shared API. It imports no OpenAI codec or auth source.
pub struct Script {
    pub counters: Arc<Counters>,
    pub session: SessionHandle,
    pub run_id: RunId,
    pub identity: ReplayIdentity,
    pub steps: Mutex<VecDeque<Step>>,
    pub cancel: CancellationToken,
    pub stop: Stop,
    pub selected: bool,
}
#[async_trait]
impl Provider for Script {
    fn id(&self) -> &'static str {
        ID
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let yes = Capability {
            implemented: true,
            verification: "offline scripted".into(),
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
        new_input: &[InputItem],
    ) -> crate::Result<()> {
        self.counters.replay_checks.fetch_add(1, Ordering::SeqCst);
        options.validate()?;
        crate::validate_input(new_input)?;
        if replay.provider_id() != ID
            || replay.requested_model() != options.model
            || replay
                .expected_identity()
                .is_some_and(|identity| identity.format() != "script-native-v1")
        {
            return Err(GatewayError::InvalidRequest("script replay incompatible"));
        }
        Ok(())
    }
    async fn open_session(&self, options: SessionOptions) -> crate::Result<ProviderSession> {
        self.counters.opens.fetch_add(1, Ordering::SeqCst);
        if self.stop == Stop::OpenFail {
            return Err(GatewayError::SessionClosed);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let control = Arc::new(Control {
            id: id.clone(),
            identity: self.identity.clone(),
            counters: self.counters.clone(),
            sender,
            steps: Mutex::new(std::mem::take(&mut *self.steps.lock().unwrap())),
            sequence: AtomicUsize::new(0),
            request: AtomicUsize::new(0),
        });
        // Test-only opening records the actual returned control identity. Production
        // binding and replay installation remain a later increment.
        if self.selected {
            let binding = RecordedProviderBinding::new(
                self.run_id.clone(),
                id.clone(),
                options.model,
                control.replay_identity().unwrap(),
            )
            .unwrap();
            self.session
                .append_run_records(
                    OperationId::new(),
                    self.run_id.clone(),
                    vec![AppendRunRecord::ProviderBinding(binding)],
                )
                .await
                .unwrap();
        }
        if self.stop == Stop::Exit(ExitAt::Opened) {
            std::process::exit(73);
        }
        if self.stop == Stop::Opened {
            self.cancel.cancel();
        }
        Ok(ProviderSession {
            id,
            control,
            events: Box::pin(
                async_stream::stream! { while let Some(event) = receiver.recv().await { yield event; } },
            ),
        })
    }
}
struct Control {
    id: String,
    identity: ReplayIdentity,
    counters: Arc<Counters>,
    sender: mpsc::UnboundedSender<EventEnvelope>,
    steps: Mutex<VecDeque<Step>>,
    sequence: AtomicUsize,
    request: AtomicUsize,
}
impl Control {
    fn emit(&self, request: &str, event: ProviderEvent) {
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) as u64 + 1;
        self.sender
            .send(EventEnvelope {
                schema_version: 1,
                sequence,
                event_id: uuid::Uuid::new_v4().to_string(),
                session_id: self.id.clone(),
                request_id: Some(request.into()),
                provider: ID.into(),
                provider_sequence: None,
                event,
            })
            .unwrap();
    }
    fn response(&self, request: &str, response: ModelResponse, deltas: usize) {
        self.emit(
            request,
            ProviderEvent::ResponseStarted {
                response_id: response.id.clone(),
            },
        );
        for _ in 0..deltas {
            self.emit(
                request,
                ProviderEvent::OutputItemUpdated {
                    response_id: response.id.clone(),
                    item_id: "message".into(),
                    output_index: 0,
                    content_index: Some(0),
                    summary_index: None,
                    kind: crate::DeltaKind::Text,
                    delta: "not an extra message 雪".into(),
                },
            );
        }
        for (index, item) in response.output.iter().enumerate() {
            self.emit(
                request,
                ProviderEvent::OutputItemFinished {
                    response_id: response.id.clone(),
                    output_index: index as u64,
                    item: item.clone(),
                },
            );
        }
        self.emit(request, ProviderEvent::ResponseFinished { response });
    }
}
#[async_trait]
impl SessionControl for Control {
    fn replay_identity(&self) -> Option<ReplayIdentity> {
        Some(self.identity.clone())
    }
    async fn generate(&self, input: Vec<InputItem>) -> crate::Result<RequestReceipt> {
        self.counters.inputs.lock().unwrap().push(input);
        let request_id = format!("request-{}", self.request.fetch_add(1, Ordering::SeqCst));
        match self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected request")
        {
            Step::Response(response) => self.response(&request_id, response, 0),
            Step::Deltas(response, deltas) => self.response(&request_id, response, deltas),
            Step::Partial => {
                self.emit(
                    &request_id,
                    ProviderEvent::OutputItemUpdated {
                        response_id: "partial".into(),
                        item_id: "message".into(),
                        output_index: 0,
                        content_index: Some(0),
                        summary_index: None,
                        kind: crate::DeltaKind::Text,
                        delta: "partial only".into(),
                    },
                );
            }
            Step::Reject => return Err(GatewayError::InvalidRequest("script rejected")),
            Step::Wait => self.counters.waiting.notify_one(),
            Step::Exit => std::process::exit(73),
        }
        Ok(RequestReceipt { request_id })
    }
    fn close(&self) {
        self.counters.closes.fetch_add(1, Ordering::SeqCst);
    }
}

struct Recorder<'a> {
    persistent: PersistentObserver<'a>,
    stop: Stop,
    cancel: CancellationToken,
}
impl RunObserver for Recorder<'_> {
    async fn event(&mut self, event: &RunEventEnvelope) -> std::result::Result<(), RunSinkError> {
        self.persistent.event(event).await?;
        let exit = match (&event.event, self.stop) {
            (RunEvent::ProviderEvent { event }, Stop::Exit(point)) => matches!(
                (&event.event, point),
                (ProviderEvent::ResponseFinished { .. }, ExitAt::Response)
                    | (ProviderEvent::OutputItemUpdated { .. }, ExitAt::Partial)
            ),
            (
                RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolExecutionStarted { .. },
                },
                Stop::Exit(ExitAt::Intent),
            ) => true,
            (
                RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolExecutionFinished { call_id, .. },
                },
                Stop::Exit(ExitAt::Finish(call)),
            ) => call_id == call,
            (RunEvent::TurnStarted { number }, Stop::Exit(ExitAt::Turn(turn))) => *number == turn,
            _ => false,
        };
        if exit {
            // Exit only after the real observer has committed this boundary.
            std::process::exit(73);
        }
        if self.stop == Stop::ResponseSink
            && matches!(&event.event, RunEvent::ProviderEvent { event } if matches!(event.event, ProviderEvent::ResponseFinished { .. }))
        {
            return Err(RunSinkError::Failed);
        }
        let stop = match &event.event {
            RunEvent::ProviderEvent { event } => matches!(
                (&event.event, self.stop),
                (ProviderEvent::ResponseFinished { .. }, Stop::Response)
                    | (ProviderEvent::OutputItemUpdated { .. }, Stop::Partial)
            ),
            RunEvent::ToolEvent { event } => matches!(
                (event, self.stop),
                (
                    ToolExecutionEvent::ToolExecutionStarted { .. },
                    Stop::Intent
                ) | (
                    ToolExecutionEvent::ToolExecutionFinished { .. },
                    Stop::Finish
                )
            ),
            RunEvent::TurnStarted { number: 2 } => self.stop == Stop::SecondTurn,
            RunEvent::TurnFinished {
                outcome: run::TurnOutcome::ToolsPrepared,
                ..
            } => self.stop == Stop::ToolsPrepared,
            _ => false,
        };
        if stop {
            self.cancel.cancel();
        }
        Ok(())
    }
    async fn tool_result(
        &mut self,
        request: &str,
        call: &str,
        output: &str,
        is_error: bool,
    ) -> std::result::Result<(), RunSinkError> {
        self.persistent
            .tool_result(request, call, output, is_error)
            .await?;
        if matches!(self.stop, Stop::Exit(ExitAt::Result(expected)) if expected == call) {
            std::process::exit(73);
        }
        if self.stop == Stop::Result {
            return Err(RunSinkError::Failed);
        }
        Ok(())
    }
}

pub struct CountingTool(pub Arc<Counters>);
#[async_trait]
impl Tool for CountingTool {
    fn definition(&self) -> ToolDefinition {
        add_numbers_definition()
    }
    fn validate(&self, _: &Value) -> crate::Result<()> {
        self.0.validates.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn execute(&self, arguments: Value) -> crate::Result<Value> {
        self.0.executes.fetch_add(1, Ordering::SeqCst);
        match arguments.get("mode").and_then(Value::as_str) {
            Some("wait") => {
                self.0.waiting.notify_one();
                self.0.release_tool.notified().await;
                Ok(json!({"sum":42}))
            }
            Some("failed") => Err(GatewayError::ToolFailed),
            Some("large") => Ok(json!("x".repeat(65537))),
            Some("error_shaped") => Ok(json!({"error":{"code":"not_error","text":"雪\r\n\u{0}"}})),
            _ => AddNumbers.execute(arguments).await,
        }
    }
}

pub struct Rig {
    pub temp: tempfile::TempDir,
    pub store: SessionStore,
    pub session: SessionHandle,
    pub counters: Arc<Counters>,
    pub tools: ToolRegistry,
}
impl Rig {
    pub async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("store")).await.unwrap();
        let session = create(&store).await;
        let counters = Arc::new(Counters::default());
        let mut tools = ToolRegistry::new();
        tools
            .register(Arc::new(CountingTool(counters.clone())))
            .unwrap();
        Self {
            temp,
            store,
            session,
            counters,
            tools,
        }
    }
    pub fn input(&self, prompt: &str) -> RecordedRunInput {
        RecordedRunInput::new(
            "original user text".into(),
            RunRequest {
                provider_id: ID.into(),
                options: SessionOptions::new(MODEL),
                prompt: prompt.into(),
            },
            self.tools.definitions(),
            vec![],
            vec![],
            None,
        )
        .unwrap()
    }
    pub async fn record(&self, plan: Plan) -> (RunId, RunResult) {
        produce(
            &self.session,
            &self.tools,
            self.counters.clone(),
            plan,
            CancellationToken::new(),
        )
        .await
    }
    pub async fn prepare(&self) -> PreparedSessionReplay {
        let before = self.counters.work();
        let head = self.session.manifest().await.unwrap().head_sequence();
        let prepared = prepare_session_replay(&self.session, ID, MODEL)
            .await
            .unwrap();
        assert_eq!(self.counters.work(), before, "preparation performed work");
        assert_eq!(self.session.manifest().await.unwrap().head_sequence(), head);
        prepared
    }
}
pub async fn create(store: &SessionStore) -> SessionHandle {
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "title".into(), None).unwrap())
        .await
        .unwrap();
    store
        .open_session(created.session_id().clone())
        .await
        .unwrap()
}
pub async fn produce(
    session: &SessionHandle,
    tools: &ToolRegistry,
    counters: Arc<Counters>,
    plan: Plan,
    cancel: CancellationToken,
) -> (RunId, RunResult) {
    let run_id = RunId::new();
    let selection = prepare_session_replay(session, ID, MODEL)
        .await
        .unwrap()
        .selection();
    if plan.selected {
        session
            .accept_history_run(
                OperationId::new(),
                run_id.clone(),
                plan.input.clone(),
                selection,
            )
            .await
            .unwrap();
    } else {
        session
            .accept_run(OperationId::new(), run_id.clone(), plan.input.clone())
            .await
            .unwrap();
    }
    let mut gateway = Gateway::new();
    gateway
        .register(Arc::new(Script {
            session: session.clone(),
            counters,
            run_id: run_id.clone(),
            identity: plan.identity,
            steps: Mutex::new(plan.steps.into()),
            cancel: cancel.clone(),
            stop: plan.stop,
            selected: plan.selected,
        }))
        .unwrap();
    let admitted = run::admit(
        &gateway,
        plan.input.prepared_request().clone(),
        tools,
        &cancel,
    )
    .unwrap();
    let mut observer = Recorder {
        persistent: PersistentObserver::new(session, run_id.clone()),
        stop: plan.stop,
        cancel: cancel.clone(),
    };
    let result = run::run_admitted(
        &gateway,
        admitted,
        uuid::Uuid::parse_str(run_id.as_str()).unwrap(),
        cancel,
        &mut observer,
    )
    .await;
    assert!(
        observer.persistent.failure.is_none(),
        "producer recording failed"
    );
    if plan.final_result {
        session
            .append_run_records(
                OperationId::new(),
                run_id.clone(),
                vec![AppendRunRecord::Result(result.clone())],
            )
            .await
            .unwrap();
    }
    (run_id, result)
}
pub fn response(id: &str, output: Vec<OutputItem>) -> ModelResponse {
    let native = json!({"id":id,"model":"observed-model-version","status":"completed", "output":output.iter().map(|item| &item.native).collect::<Vec<_>>(), "opaque":{"雪":"\r\n"}});
    ModelResponse {
        id: id.into(),
        model: Some("observed-model-version".into()),
        outcome: crate::ResponseOutcome::Completed,
        output_provenance: crate::OutputProvenance::NativeTerminal,
        output,
        text: String::new(),
        usage: None,
        native,
    }
}
pub fn call(id: &str, arguments: Value) -> OutputItem {
    let arguments = arguments.to_string();
    OutputItem {
        id: Some(format!("item-{id}")),
        kind: crate::ItemKind::FunctionCall,
        native_type: "function_call".into(),
        function_call: Some(crate::FunctionCall {
            call_id: id.into(),
            name: "add_numbers".into(),
            arguments: arguments.clone(),
            origin: crate::CallOrigin::Direct,
            namespace: None,
            complete: true,
        }),
        native: json!({"type":"function_call", "id":format!("item-{id}"), "call_id":id,"name":"add_numbers","arguments":arguments,"status":"completed"}),
    }
}
pub fn value(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap()
}
pub async fn history(session: &SessionHandle) -> Vec<StoredEvent> {
    let mut all = Vec::new();
    let mut after = 0;
    let mut through = None;
    loop {
        let page = session.history_page(after, through, 128).await.unwrap();
        through = Some(page.through_sequence());
        after = page.next_after();
        all.extend_from_slice(page.records());
        if !page.has_more() {
            return all;
        }
    }
}
pub fn assert_incomplete(error: PersistentRunFailure) {
    assert_eq!(error.stage(), crate::execution::PersistentRunStage::History);
    assert!(matches!(
        error.cause(),
        PersistentRunCause::Gateway(GatewayError::InvalidRequest(
            "stored history is incomplete for native replay"
        ))
    ));
}
