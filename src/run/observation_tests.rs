use super::*;
use crate::{
    CallOrigin, Capability, EventEnvelope, FunctionCall, OutputItem, Provider,
    ProviderCapabilities, RequestReceipt, ToolDefinition,
    tools::{AddNumbers, Tool, add_numbers_definition},
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::VecDeque,
    rc::Rc,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{mpsc, oneshot};

#[derive(Default)]
struct Records {
    opens: AtomicUsize,
    closes: AtomicUsize,
    calls: AtomicUsize,
    inputs: Mutex<Vec<Vec<InputItem>>>,
    events: Mutex<Vec<EventEnvelope>>,
}
struct Script {
    records: Arc<Records>,
    responses: Mutex<VecDeque<ModelResponse>>,
}
struct Control {
    records: Arc<Records>,
    responses: Mutex<VecDeque<ModelResponse>>,
    sender: mpsc::UnboundedSender<EventEnvelope>,
}
#[async_trait]
impl Provider for Script {
    fn id(&self) -> &'static str {
        "observation-script"
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let yes = Capability {
            implemented: true,
            verification: "synthetic".into(),
        };
        ProviderCapabilities {
            websocket: yes.clone(),
            sse: yes.clone(),
            continuation: yes.clone(),
            function_tools: yes,
            advanced: vec![],
        }
    }
    async fn open_session(&self, _: SessionOptions) -> crate::Result<ProviderSession> {
        self.records.opens.fetch_add(1, Ordering::SeqCst);
        let (sender, mut receiver) = mpsc::unbounded_channel();
        Ok(ProviderSession {
            id: "provider-session".into(),
            control: Arc::new(Control {
                records: self.records.clone(),
                responses: Mutex::new(std::mem::take(&mut *self.responses.lock().unwrap())),
                sender,
            }),
            events: Box::pin(async_stream::stream! {
                while let Some(event) = receiver.recv().await { yield event; }
            }),
        })
    }
}
#[async_trait]
impl SessionControl for Control {
    async fn generate(&self, input: Vec<InputItem>) -> crate::Result<RequestReceipt> {
        let request_id = {
            let mut inputs = self.records.inputs.lock().unwrap();
            inputs.push(input);
            format!("q{}", inputs.len())
        };
        let response = self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("extra request");
        for event in [
            ProviderEvent::ResponseStarted {
                response_id: response.id.clone(),
            },
            ProviderEvent::ResponseFinished { response },
        ] {
            let mut events = self.records.events.lock().unwrap();
            let sequence = (events.len() as u64 + 1) * 3;
            let envelope = EventEnvelope {
                schema_version: 1,
                sequence,
                event_id: format!("source-{sequence}"),
                session_id: "provider-session".into(),
                request_id: Some(request_id.clone()),
                provider: "observation-script".into(),
                provider_sequence: Some(999),
                event,
            };
            events.push(envelope.clone());
            self.sender.send(envelope).unwrap();
        }
        Ok(RequestReceipt { request_id })
    }
    fn close(&self) {
        self.records.closes.fetch_add(1, Ordering::SeqCst);
    }
}
struct CountingTool(Arc<Records>);
#[async_trait]
impl Tool for CountingTool {
    fn definition(&self) -> ToolDefinition {
        add_numbers_definition()
    }
    fn validate(&self, arguments: &Value) -> crate::Result<()> {
        AddNumbers.validate(arguments)
    }
    async fn execute(&self, arguments: Value) -> crate::Result<Value> {
        self.0.calls.fetch_add(1, Ordering::SeqCst);
        AddNumbers.execute(arguments).await
    }
}
fn setup(responses: Vec<ModelResponse>) -> (Gateway, Arc<Records>, ToolRegistry) {
    let records = Arc::new(Records::default());
    let mut gateway = Gateway::new();
    gateway
        .register(Arc::new(Script {
            records: records.clone(),
            responses: Mutex::new(responses.into()),
        }))
        .unwrap();
    let mut tools = ToolRegistry::new();
    tools
        .register(Arc::new(CountingTool(records.clone())))
        .unwrap();
    (gateway, records, tools)
}
fn request() -> RunRequest {
    RunRequest {
        provider_id: "observation-script".into(),
        options: SessionOptions::new("synthetic"),
        prompt: "λ\nprepared input".into(),
    }
}
fn response(id: &str, calls: &[&str]) -> ModelResponse {
    ModelResponse {
        id: id.into(),
        model: None,
        outcome: ResponseOutcome::Completed,
        output: calls
            .iter()
            .map(|call_id| OutputItem {
                id: Some(format!("item-{call_id}")),
                kind: ItemKind::FunctionCall,
                native_type: "function_call".into(),
                function_call: Some(FunctionCall {
                    call_id: (*call_id).into(),
                    name: "add_numbers".into(),
                    arguments: "{\"a\":17,\"b\":25}".into(),
                    origin: CallOrigin::Direct,
                    namespace: None,
                    complete: true,
                }),
                native: json!({"opaque_call":"λ\n"}),
            })
            .collect(),
        text: "synthetic text".into(),
        usage: None,
        native: json!({"opaque_terminal":[1,"λ\n"]}),
        output_provenance: Default::default(),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Boundary {
    Started,
    Terminal,
    Intent,
    Result,
    Finished,
}
enum Observed {
    Event(Box<RunEventEnvelope>),
    Result {
        request_id: String,
        call_id: String,
        output: String,
        is_error: bool,
    },
}
#[derive(Default)]
struct Observer {
    observed: Arc<Mutex<Vec<Observed>>>,
    hold_at: Option<Boundary>,
    release: Option<oneshot::Receiver<()>>,
    fail_at: Option<Boundary>,
}
impl Observer {
    async fn acknowledge(&mut self, boundary: Option<Boundary>) -> Result<(), RunSinkError> {
        if let Some(boundary) = boundary {
            if self.hold_at == Some(boundary) {
                self.hold_at = None;
                self.release.take().unwrap().await.unwrap();
            }
            if self.fail_at == Some(boundary) {
                return Err(RunSinkError::Failed);
            }
        }
        Ok(())
    }
}
impl RunObserver for Observer {
    async fn event(&mut self, event: &RunEventEnvelope) -> Result<(), RunSinkError> {
        self.observed
            .lock()
            .unwrap()
            .push(Observed::Event(Box::new(event.clone())));
        let boundary = match event.event {
            RunEvent::RunStarted => Some(Boundary::Started),
            RunEvent::ProviderEvent { ref event }
                if matches!(event.event, ProviderEvent::ResponseFinished { .. }) =>
            {
                Some(Boundary::Terminal)
            }
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionStarted { .. },
            } => Some(Boundary::Intent),
            RunEvent::RunFinished { .. } => Some(Boundary::Finished),
            _ => None,
        };
        self.acknowledge(boundary).await
    }
    async fn tool_result(
        &mut self,
        request_id: &str,
        call_id: &str,
        output: &str,
        is_error: bool,
    ) -> Result<(), RunSinkError> {
        self.observed.lock().unwrap().push(Observed::Result {
            request_id: request_id.into(),
            call_id: call_id.into(),
            output: output.into(),
            is_error,
        });
        self.acknowledge(Some(Boundary::Result)).await
    }
}
fn assert_send<T: Send>(_: &T) {}

#[tokio::test]
async fn non_send_legacy_callback_and_admitted_engine_share_event_trace() {
    let events = Rc::new(RefCell::new(Vec::new()));
    let captured = events.clone();
    let mut adapter = SyncObserver(move |event: &RunEventEnvelope| {
        captured.borrow_mut().push(event.clone());
        Ok(())
    });
    let envelope = RunEventEnvelope {
        schema_version: 2,
        sequence: 1,
        event_id: "synthetic".into(),
        run_id: "synthetic".into(),
        turn_id: None,
        session_id: None,
        request_id: None,
        event: RunEvent::RunStarted,
    };
    let ready = adapter.event(&envelope);
    assert_send(&ready);
    ready.await.unwrap();
    events.borrow_mut().clear();

    let (gateway, _, tools) = setup(vec![response("r1", &["one"]), response("r2", &[])]);
    let result = run(
        &gateway,
        request(),
        &tools,
        CancellationToken::new(),
        adapter.0,
    )
    .await
    .unwrap();
    assert_eq!(result.outcome, RunOutcome::Completed);
    let (gateway, _, tools) = setup(vec![response("r1", &["one"]), response("r2", &[])]);
    let cancel = CancellationToken::new();
    let admitted = admit(&gateway, request(), &tools, &cancel).unwrap();
    let mut observer = Observer::default();
    let result = run_admitted(&gateway, admitted, Uuid::new_v4(), cancel, &mut observer).await;
    assert_eq!(result.outcome, RunOutcome::Completed);
    let normalize = |event: &RunEventEnvelope| {
        let mut value = serde_json::to_value(event).unwrap();
        for field in ["run_id", "turn_id", "event_id"] {
            value.as_object_mut().unwrap().remove(field);
        }
        value
    };
    let legacy: Vec<_> = events.borrow().iter().map(normalize).collect();
    let admitted: Vec<_> = observer
        .observed
        .lock()
        .unwrap()
        .iter()
        .filter_map(|item| {
            if let Observed::Event(event) = item {
                Some(normalize(event))
            } else {
                None
            }
        })
        .collect();
    assert_eq!(legacy, admitted);
}

#[tokio::test]
async fn supplied_id_send_engine_preserves_exact_provider_events_and_result_correlation() {
    let (gateway, records, tools) = setup(vec![
        response("r1", &["one"]),
        response("r2", &["one"]),
        response("r3", &[]),
    ]);
    let run_id = Uuid::new_v4();
    let task = tokio::spawn(async move {
        let cancel = CancellationToken::new();
        let admitted = admit(&gateway, request(), &tools, &cancel).unwrap();
        let mut observer = Observer::default();
        let future = run_admitted(&gateway, admitted, run_id, cancel, &mut observer);
        assert_send(&future);
        let result = future.await;
        (result, observer)
    });
    let (result, observer) = task.await.unwrap();
    assert_eq!(result.run_id, run_id.to_string());
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(records.opens.load(Ordering::SeqCst), 1);
    assert_eq!(records.closes.load(Ordering::SeqCst), 1);
    assert_eq!(records.calls.load(Ordering::SeqCst), 1);
    let inputs = records.inputs.lock().unwrap();
    assert_eq!(inputs.len(), 3);
    assert!(matches!(&inputs[0][0], InputItem::User { text } if text == &request().prompt));
    assert_eq!(
        serde_json::to_value(&inputs[1]).unwrap(),
        serde_json::to_value(&inputs[2]).unwrap()
    );
    let observed = observer.observed.lock().unwrap();
    let events: Vec<_> = observed
        .iter()
        .filter_map(|item| {
            if let Observed::Event(event) = item {
                Some(event.as_ref())
            } else {
                None
            }
        })
        .collect();
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event.run_id, result.run_id);
        assert_eq!(event.schema_version, 2);
        assert_eq!(event.sequence, index as u64 + 1);
    }
    let provider: Vec<_> = events
        .iter()
        .filter_map(|event| {
            if let RunEvent::ProviderEvent { event } = &event.event {
                Some(event.as_ref())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        serde_json::to_value(provider).unwrap(),
        serde_json::to_value(&*records.events.lock().unwrap()).unwrap()
    );
    let result_positions: Vec<_> = observed
        .iter()
        .enumerate()
        .filter(|(_, item)| matches!(item, Observed::Result { .. }))
        .collect();
    assert_eq!(result_positions.len(), 1);
    let (index, item) = result_positions[0];
    assert!(
        matches!(item, Observed::Result { request_id, call_id, output, is_error } if request_id == "q1" && call_id == "one" && output == "{\"sum\":42}" && !is_error)
    );
    assert!(
        matches!(&observed[index - 1], Observed::Event(event) if matches!(event.event, RunEvent::ToolEvent { event: ToolExecutionEvent::ToolExecutionStarted { .. } }))
    );
    assert!(
        matches!(&observed[index + 1], Observed::Event(event) if matches!(event.event, RunEvent::ToolEvent { event: ToolExecutionEvent::ToolExecutionFinished { is_error: false, .. } }))
    );
    assert!(
        events
            .iter()
            .any(|event| event.request_id.as_deref() == Some("q2")
                && matches!(
                    event.event,
                    RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolResultReused { .. }
                    }
                ))
    );
}

#[test]
fn pure_admission_preserves_input_options_provider_and_cancellation_order() {
    let (gateway, records, tools) = setup(vec![]);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let mut request = request();
    request.options.tools = tools.definitions();
    request.prompt.clear();
    request.options.model.clear();
    request.provider_id = "missing".into();
    assert!(matches!(
        admit(&gateway, request.clone(), &tools, &cancel),
        Err(GatewayError::InvalidRequest("caller tools must be empty"))
    ));
    request.options.tools.clear();
    assert!(matches!(
        admit(&gateway, request.clone(), &tools, &cancel),
        Err(GatewayError::InvalidRequest("empty user input"))
    ));
    request.prompt = "prepared".into();
    assert!(matches!(
        admit(&gateway, request.clone(), &tools, &cancel),
        Err(GatewayError::InvalidRequest(
            "model and instructions are required"
        ))
    ));
    request.options.model = "synthetic".into();
    assert!(matches!(
        admit(&gateway, request.clone(), &tools, &cancel),
        Err(GatewayError::UnknownProvider)
    ));
    request.provider_id = "observation-script".into();
    assert!(matches!(
        admit(&gateway, request.clone(), &tools, &cancel),
        Err(GatewayError::InvalidRequest("run pre-cancelled"))
    ));
    let admitted = admit(&gateway, request, &tools, &CancellationToken::new()).unwrap();
    assert_eq!(admitted.input.len(), 1);
    assert_eq!(
        serde_json::to_value(&admitted.options.tools).unwrap(),
        serde_json::to_value(tools.definitions()).unwrap()
    );
    assert_eq!(records.opens.load(Ordering::SeqCst), 0);
    assert_eq!(records.calls.load(Ordering::SeqCst), 0);
    assert!(records.inputs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancellation_after_admission_reports_run_without_opening_provider() {
    let (gateway, records, tools) = setup(vec![]);
    let cancel = CancellationToken::new();
    let admitted = admit(&gateway, request(), &tools, &cancel).unwrap();
    cancel.cancel();
    let mut observer = Observer::default();
    let result = run_admitted(&gateway, admitted, Uuid::new_v4(), cancel, &mut observer).await;
    assert_eq!(result.outcome, RunOutcome::CancelledLocally);
    assert!(result.events_complete);
    assert_eq!(records.opens.load(Ordering::SeqCst), 0);
    let observed = observer.observed.lock().unwrap();
    assert_eq!(observed.len(), 2);
    assert!(
        matches!(&observed[0], Observed::Event(event) if matches!(event.event, RunEvent::RunStarted))
    );
    assert!(
        matches!(&observed[1], Observed::Event(event) if matches!(event.event, RunEvent::RunFinished { outcome: RunOutcome::CancelledLocally, .. }))
    );
}

#[tokio::test]
async fn cancellation_awaits_observation_then_stops_at_next_effect_boundary() {
    for boundary in [
        Boundary::Started,
        Boundary::Terminal,
        Boundary::Intent,
        Boundary::Result,
    ] {
        let (gateway, records, tools) = setup(vec![response("r1", &["one", "later"])]);
        let cancel = CancellationToken::new();
        let admitted = admit(&gateway, request(), &tools, &cancel).unwrap();
        let (release, receiver) = oneshot::channel();
        let mut observer = Observer {
            hold_at: Some(boundary),
            release: Some(receiver),
            ..Observer::default()
        };
        let observed = observer.observed.clone();
        let mut future = Box::pin(run_admitted(
            &gateway,
            admitted,
            Uuid::new_v4(),
            cancel.clone(),
            &mut observer,
        ));
        assert!(futures_util::poll!(future.as_mut()).is_pending());
        let calls = usize::from(boundary == Boundary::Result);
        assert_eq!(records.calls.load(Ordering::SeqCst), calls);
        assert!(!observed.lock().unwrap().iter().any(|item| matches!(item, Observed::Event(event) if matches!(event.event, RunEvent::ToolEvent { event: ToolExecutionEvent::ToolExecutionFinished { .. } }))));
        cancel.cancel();
        assert!(futures_util::poll!(future.as_mut()).is_pending());
        release.send(()).unwrap();
        let result = future.await;
        assert_eq!(result.outcome, RunOutcome::CancelledLocally);
        assert!(result.events_complete);
        assert_eq!(records.calls.load(Ordering::SeqCst), calls);
        assert_eq!(
            records.inputs.lock().unwrap().len(),
            usize::from(boundary != Boundary::Started)
        );
        let observed = observed.lock().unwrap();
        let finished = observed.iter().filter(|item| matches!(item, Observed::Event(event) if matches!(event.event, RunEvent::ToolEvent { event: ToolExecutionEvent::ToolExecutionFinished { .. } }))).count();
        assert_eq!(finished, calls);
    }
}

#[tokio::test]
async fn observer_failure_is_sticky_for_events_and_completed_results() {
    for boundary in [
        Boundary::Started,
        Boundary::Terminal,
        Boundary::Intent,
        Boundary::Result,
        Boundary::Finished,
    ] {
        let responses = if boundary == Boundary::Finished {
            vec![response("r1", &[])]
        } else {
            vec![response("r1", &["one", "later"])]
        };
        let (gateway, records, tools) = setup(responses);
        let cancel = CancellationToken::new();
        let admitted = admit(&gateway, request(), &tools, &cancel).unwrap();
        let mut observer = Observer {
            fail_at: Some(boundary),
            ..Observer::default()
        };
        let result = run_admitted(&gateway, admitted, Uuid::new_v4(), cancel, &mut observer).await;
        assert_eq!(result.sink_error, Some(RunSinkError::Failed));
        assert!(!result.events_complete);
        let expected = if boundary == Boundary::Finished {
            RunOutcome::Completed
        } else {
            failed("event_sink")
        };
        assert_eq!(result.outcome, expected);
        assert_eq!(
            records.opens.load(Ordering::SeqCst),
            usize::from(boundary != Boundary::Started)
        );
        assert_eq!(
            records.closes.load(Ordering::SeqCst),
            usize::from(boundary != Boundary::Started)
        );
        assert_eq!(
            records.inputs.lock().unwrap().len(),
            usize::from(boundary != Boundary::Started)
        );
        assert_eq!(
            records.calls.load(Ordering::SeqCst),
            usize::from(boundary == Boundary::Result)
        );
        let observed = observer.observed.lock().unwrap();
        assert!(!observed.iter().any(|item| matches!(item, Observed::Event(event) if matches!(event.event, RunEvent::ToolEvent { event: ToolExecutionEvent::ToolExecutionFinished { .. } }))));
        let finals = observed.iter().filter(|item| matches!(item, Observed::Event(event) if matches!(event.event, RunEvent::RunFinished { .. }))).count();
        assert_eq!(finals, usize::from(boundary == Boundary::Finished));
        if boundary == Boundary::Result {
            assert!(matches!(observed.last(), Some(Observed::Result { .. })));
        }
    }
}

#[tokio::test]
async fn whole_batch_preflight_precedes_awaitable_tool_intent_and_result() {
    let mut invalid = response("r1", &["one", "bad"]);
    invalid.output[1].function_call.as_mut().unwrap().name = "unknown".into();
    let (gateway, records, tools) = setup(vec![invalid]);
    let cancel = CancellationToken::new();
    let admitted = admit(&gateway, request(), &tools, &cancel).unwrap();
    let mut observer = Observer::default();
    let result = run_admitted(&gateway, admitted, Uuid::new_v4(), cancel, &mut observer).await;
    assert_eq!(result.outcome, failed("tool_preflight"));
    assert_eq!(records.calls.load(Ordering::SeqCst), 0);
    assert_eq!(records.inputs.lock().unwrap().len(), 1);
    assert!(observer.observed.lock().unwrap().iter().all(|item| matches!(item, Observed::Event(event) if !matches!(event.event, RunEvent::ToolEvent { .. }))));
}
