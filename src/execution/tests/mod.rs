use super::*;
use crate::{
    CallOrigin, Capability, DeltaKind, EventEnvelope, Feature, FunctionCall, GatewayError,
    InputItem, ItemKind, ModelResponse, OutputItem, Provider, ProviderCapabilities, ProviderEvent,
    ProviderSession, RequestReceipt, ResponseOutcome, SessionControl, SessionOptions,
    ToolDefinition, Transport, UpstreamOutcome,
    context::{ContextRoots, discover, prepare_run},
    run::{RunEvent, RunOutcome, RunRequest, RunResult, RunSinkError},
    storage::{
        CreateSession, RecordedRunInput, RecordedRunState, SessionStore, StoredEvent,
        StoredEventPayload,
    },
    tools::{AddNumbers, Tool, ToolExecutionEvent, add_numbers_definition},
};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    future::pending,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{Notify, mpsc};

mod admission;
mod commit_boundaries;
mod faults;
pub(crate) mod in_session;
mod independent;
mod lifecycle;
pub(crate) mod process;
mod recording;
mod remediation;
mod sql_failures;

const ID: &str = "execution-script";
const PARTIAL: &str = "partial 雪\n\0";

#[derive(Default)]
pub(crate) struct Barrier {
    pub reached: Notify,
    pub release: Notify,
}
impl Barrier {
    pub async fn wait(&self) {
        self.reached.notify_one();
        self.release.notified().await;
    }
}

#[derive(Default)]
pub(crate) struct Records {
    pub opens: AtomicUsize,
    pub closes: AtomicUsize,
    calls: AtomicUsize,
    pub capabilities: AtomicUsize,
    pub inputs: Mutex<Vec<Vec<InputItem>>>,
    options: Mutex<Vec<SessionOptions>>,
    pub events: Mutex<Vec<EventEnvelope>>,
    waiting: Notify,
    tool_entered: Notify,
}

#[derive(Clone)]
struct Binding {
    session: SessionHandle,
    operation_id: OperationId,
    run_id: RunId,
}

enum Step {
    Response(ModelResponse),
    Partial {
        response: ModelResponse,
        before: Arc<Barrier>,
        after: Arc<Barrier>,
    },
    Wait,
    Reject,
    Failure(UpstreamOutcome),
}

enum StreamItem {
    Event(Box<EventEnvelope>),
    Barrier(Arc<Barrier>),
    Waiting,
}

#[derive(Clone, Copy)]
struct SourceIds {
    session: &'static str,
    request_prefix: &'static str,
    event_prefix: &'static str,
}

struct Script {
    source: SourceIds,
    binding: Binding,
    input: RecordedRunInput,
    records: Arc<Records>,
    capabilities: Mutex<ProviderCapabilities>,
    steps: Mutex<VecDeque<Step>>,
    fail_open: bool,
}

fn capabilities() -> ProviderCapabilities {
    let yes = Capability {
        implemented: true,
        verification: "scripted only".into(),
    };
    ProviderCapabilities {
        websocket: yes.clone(),
        sse: yes.clone(),
        continuation: yes.clone(),
        function_tools: yes,
        advanced: vec![],
    }
}

#[async_trait]
impl Provider for Script {
    fn id(&self) -> &'static str {
        ID
    }
    fn capabilities(&self) -> ProviderCapabilities {
        self.records.capabilities.fetch_add(1, Ordering::SeqCst);
        self.capabilities.lock().unwrap().clone()
    }
    async fn open_session(&self, options: SessionOptions) -> crate::Result<ProviderSession> {
        self.records.opens.fetch_add(1, Ordering::SeqCst);
        let acceptance = self
            .binding
            .session
            .lookup_receipt(self.binding.operation_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(acceptance.run_id(), Some(&self.binding.run_id));
        assert_eq!(acceptance.first_sequence(), 2);
        let run = self
            .binding
            .session
            .run_record(self.binding.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(run.state(), RecordedRunState::Running);
        assert_eq!(run.last_runtime_sequence(), 1);
        assert!(
            value(run.input()) == value(&self.input),
            "accepted input differs"
        );
        let history = history(&self.binding.session).await;
        assert!(matches!(
            history[1].payload(),
            StoredEventPayload::RunAccepted(_)
        ));
        assert!(
            matches!(history[2].payload(), StoredEventPayload::RuntimeObserved(event) if matches!(event.event, RunEvent::RunStarted))
        );
        let mut expected = self.input.prepared_request().options.clone();
        expected.tools = self.input.tool_definitions().to_vec();
        assert!(
            value(&options) == value(&expected),
            "provider options differ"
        );
        self.records.options.lock().unwrap().push(options);
        if self.fail_open {
            return Err(GatewayError::Protocol("synthetic private open detail"));
        }
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let records = self.records.clone();
        Ok(ProviderSession {
            id: self.source.session.into(),
            control: Arc::new(Control {
                source: self.source,
                binding: self.binding.clone(),
                input: self.input.clone(),
                records: records.clone(),
                steps: Mutex::new(std::mem::take(&mut *self.steps.lock().unwrap())),
                sender,
            }),
            events: Box::pin(async_stream::stream! {
                while let Some(item) = receiver.recv().await {
                    match item {
                        StreamItem::Event(event) => yield *event,
                        StreamItem::Barrier(barrier) => barrier.wait().await,
                        StreamItem::Waiting => { records.waiting.notify_one(); pending::<()>().await; }
                    }
                }
            }),
        })
    }
}

struct Control {
    source: SourceIds,
    binding: Binding,
    input: RecordedRunInput,
    records: Arc<Records>,
    steps: Mutex<VecDeque<Step>>,
    sender: mpsc::UnboundedSender<StreamItem>,
}
impl Control {
    fn emit(&self, request_id: &str, event: ProviderEvent) {
        let mut events = self.records.events.lock().unwrap();
        let sequence = (events.len() as u64 + 1) * 3;
        let envelope = EventEnvelope {
            schema_version: 1,
            sequence,
            event_id: format!("{}{sequence}", self.source.event_prefix),
            session_id: self.source.session.into(),
            request_id: Some(request_id.into()),
            provider: ID.into(),
            provider_sequence: Some(sequence + 1000),
            event,
        };
        events.push(envelope.clone());
        self.sender
            .send(StreamItem::Event(Box::new(envelope)))
            .unwrap();
    }
}
#[async_trait]
impl SessionControl for Control {
    async fn generate(&self, input: Vec<InputItem>) -> crate::Result<RequestReceipt> {
        let number = self.records.inputs.lock().unwrap().len() + 1;
        if number == 1 {
            assert!(
                value(&input)
                    == value(&vec![InputItem::user(
                        self.input.prepared_request().prompt.clone()
                    )]),
                "submitted input differs"
            );
        } else {
            for item in &input {
                let InputItem::ToolResult { call_id, output } = item else {
                    panic!("expected tool result")
                };
                let saved = self
                    .binding
                    .session
                    .tool_result(self.binding.run_id.clone(), call_id.clone())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(saved.output(), Some(output.as_str()));
                assert!(saved.started_sequence() < saved.result_sequence().unwrap());
                assert!(saved.result_sequence().unwrap() < saved.finished_sequence().unwrap());
            }
        }
        self.records.inputs.lock().unwrap().push(input);
        let request_id = format!("{}{number}", self.source.request_prefix);
        let step = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .expect("extra provider request");
        match step {
            Step::Reject => return Err(GatewayError::Protocol("synthetic private rejection")),
            Step::Wait => self.sender.send(StreamItem::Waiting).unwrap(),
            Step::Failure(upstream_outcome) => self.emit(
                &request_id,
                ProviderEvent::RequestFailed {
                    code: "synthetic_failure".into(),
                    message: "private failure detail".into(),
                    upstream_outcome,
                },
            ),
            Step::Response(response) => {
                self.emit(
                    &request_id,
                    ProviderEvent::ResponseStarted {
                        response_id: response.id.clone(),
                    },
                );
                self.emit(&request_id, ProviderEvent::ResponseFinished { response });
            }
            Step::Partial {
                response,
                before,
                after,
            } => {
                self.emit(
                    &request_id,
                    ProviderEvent::ResponseStarted {
                        response_id: response.id.clone(),
                    },
                );
                self.sender.send(StreamItem::Barrier(before)).unwrap();
                self.emit(
                    &request_id,
                    ProviderEvent::OutputItemUpdated {
                        response_id: response.id.clone(),
                        item_id: "message".into(),
                        output_index: 0,
                        content_index: Some(0),
                        summary_index: None,
                        kind: DeltaKind::Text,
                        delta: PARTIAL.into(),
                    },
                );
                self.sender.send(StreamItem::Barrier(after)).unwrap();
                self.emit(&request_id, ProviderEvent::ResponseFinished { response });
            }
        }
        Ok(RequestReceipt { request_id })
    }
    fn close(&self) {
        self.records.closes.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Clone, Copy)]
enum ToolMode {
    Add,
    Failed,
    Large,
    ErrorShaped,
    Pending,
}
struct CountingTool {
    binding: Binding,
    records: Arc<Records>,
    mode: ToolMode,
}
#[async_trait]
impl Tool for CountingTool {
    fn definition(&self) -> ToolDefinition {
        add_numbers_definition()
    }
    fn validate(&self, arguments: &Value) -> crate::Result<()> {
        AddNumbers.validate(arguments)
    }
    async fn execute(&self, arguments: Value) -> crate::Result<Value> {
        self.records.calls.fetch_add(1, Ordering::SeqCst);
        let history = history(&self.binding.session).await;
        let StoredEventPayload::RuntimeObserved(event) = history.last().unwrap().payload() else {
            panic!("missing intent")
        };
        let RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted { call_id, .. },
        } = &event.event
        else {
            panic!("missing intent")
        };
        let row = self
            .binding
            .session
            .tool_result(self.binding.run_id.clone(), call_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.started_sequence(), history.last().unwrap().sequence());
        assert!(row.output().is_none());
        assert!(row.finished_sequence().is_none());
        assert!(history.iter().rev().skip(1).any(|record| matches!(record.payload(), StoredEventPayload::RuntimeObserved(event) if matches!(&event.event, RunEvent::ProviderEvent { event } if matches!(event.event, ProviderEvent::ResponseFinished { .. })))));
        self.records.tool_entered.notify_one();
        match self.mode {
            ToolMode::Add => AddNumbers.execute(arguments).await,
            ToolMode::Failed => Err(GatewayError::ToolFailed),
            ToolMode::Large => Ok(json!({"large": "x".repeat(70 * 1024)})),
            ToolMode::ErrorShaped => {
                Ok(json!({"error":{"code":"not_an_error","text":"雪\n\0\\\""}}))
            }
            ToolMode::Pending => pending().await,
        }
    }
}

struct Rig {
    temp: Arc<tempfile::TempDir>,
    store: Arc<SessionStore>,
    session: SessionHandle,
    gateway: Arc<Gateway>,
    script: Arc<Script>,
    tools: Arc<ToolRegistry>,
    input: RecordedRunInput,
    run_id: RunId,
    operation_id: OperationId,
}
impl Rig {
    async fn new(steps: Vec<Step>, mode: ToolMode) -> Self {
        Self::configured(steps, mode, false).await
    }
    async fn configured(steps: Vec<Step>, mode: ToolMode, fail_open: bool) -> Self {
        let temp = Arc::new(tempfile::tempdir().unwrap());
        let store = Arc::new(SessionStore::open(temp.path().join("root")).await.unwrap());
        let created = store
            .create_session(
                CreateSession::new(OperationId::new(), "synthetic session".into(), None).unwrap(),
            )
            .await
            .unwrap();
        let session = store
            .open_session(created.session_id().clone())
            .await
            .unwrap();
        let run_id = RunId::new();
        let operation_id = OperationId::new();
        let binding = Binding {
            session: session.clone(),
            run_id: run_id.clone(),
            operation_id: operation_id.clone(),
        };
        let records = Arc::new(Records::default());
        let mut tools = ToolRegistry::new();
        tools
            .register(Arc::new(CountingTool {
                binding: binding.clone(),
                records: records.clone(),
                mode,
            }))
            .unwrap();
        let roots = ContextRoots {
            workspace: temp.path().join("workspace"),
            global_skills: temp.path().join("global"),
        };
        std::fs::create_dir_all(roots.workspace.join(".agents/skills/local")).unwrap();
        std::fs::create_dir_all(&roots.global_skills).unwrap();
        std::fs::write(
            roots.workspace.join("AGENTS.md"),
            "synthetic project instructions\n",
        )
        .unwrap();
        std::fs::write(
            roots.workspace.join(".agents/skills/local/SKILL.md"),
            "---\nname: local\ndescription: synthetic local skill\n---\nsynthetic skill body\n",
        )
        .unwrap();
        let catalog = discover(roots).unwrap();
        let original = "original task λ\n\0";
        let request = RunRequest {
            provider_id: ID.into(),
            options: SessionOptions::new("synthetic"),
            prompt: original.into(),
        };
        let prepared = prepare_run(
            request,
            &catalog,
            &["project:local".parse().unwrap()],
            &tools,
        )
        .unwrap();
        let input = RecordedRunInput::capture(original.into(), &prepared, &tools).unwrap();
        let script = Arc::new(Script {
            source: SourceIds {
                session: "provider-session",
                request_prefix: "q",
                event_prefix: "source-",
            },
            binding,
            input: input.clone(),
            records,
            capabilities: Mutex::new(capabilities()),
            steps: Mutex::new(steps.into()),
            fail_open,
        });
        let mut gateway = Gateway::new();
        gateway.register(script.clone()).unwrap();
        Self {
            temp,
            store,
            session,
            gateway: Arc::new(gateway),
            script,
            tools: Arc::new(tools),
            input,
            run_id,
            operation_id,
        }
    }
    fn request(&self) -> PersistentRunRequest {
        PersistentRunRequest {
            operation_id: self.operation_id.clone(),
            run_id: self.run_id.clone(),
            input: self.input.clone(),
        }
    }
    fn start(
        &self,
        cancel: CancellationToken,
    ) -> tokio::task::JoinHandle<Result<PersistentRunResult, PersistentRunFailure>> {
        let gateway = self.gateway.clone();
        let session = self.session.clone();
        let tools = self.tools.clone();
        let request = self.request();
        fn send<T: Send>(future: T) -> T {
            future
        }
        tokio::spawn(send(async move {
            run_persisted(&gateway, &session, request, &tools, cancel).await
        }))
    }
    async fn close(&self) {
        self.store.close().await.unwrap();
        let reopened = SessionStore::open(self.temp.path().join("root"))
            .await
            .unwrap();
        reopened.close().await.unwrap();
    }
}

pub(crate) fn response(id: &str, calls: Vec<OutputItem>, text: &str) -> ModelResponse {
    ModelResponse {
        id: id.into(),
        model: Some("synthetic".into()),
        outcome: ResponseOutcome::Completed,
        output: calls,
        text: text.into(),
        usage: None,
        native: json!({"opaque": ["雪\n\0", 9]}),
        output_provenance: Default::default(),
    }
}
pub(crate) fn call(id: &str, a: i64, b: i64) -> OutputItem {
    OutputItem {
        id: Some(format!("item-{id}")),
        kind: ItemKind::FunctionCall,
        native_type: "function_call".into(),
        function_call: Some(FunctionCall {
            call_id: id.into(),
            name: "add_numbers".into(),
            arguments: json!({"a": a, "b": b}).to_string(),
            origin: CallOrigin::Direct,
            namespace: None,
            complete: true,
        }),
        native: json!({"opaque_call": [a, b]}),
    }
}
pub(crate) fn value(value: &impl Serialize) -> Value {
    serde_json::to_value(value).unwrap()
}
fn count(value: &AtomicUsize) -> usize {
    value.load(Ordering::SeqCst)
}
pub(crate) async fn history(session: &SessionHandle) -> Vec<StoredEvent> {
    let page = session.history_page(0, None, 200).await.unwrap();
    assert!(!page.has_more());
    page.records().to_vec()
}
fn executed(result: PersistentRunResult) -> (CommitResult, CommitResult, RunResult) {
    let PersistentRunResult::Executed {
        acceptance,
        final_record,
        result,
    } = result
    else {
        panic!("expected execution")
    };
    (acceptance, final_record, *result)
}
