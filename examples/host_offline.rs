//! Public host ownership, real S2/tools/SQLite, and explicit replay. No network or credentials.
use async_trait::async_trait;
use futures_util::FutureExt;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Notify, mpsc};
use wi::{
    context::{ContextRoots, DiagnosticKind, Scope, discover, prepare_run_with_skill_loading},
    execution::{PersistentRunRequest, PersistentRunResult},
    run::{RunEvent, RunOutcome, RunRequest, RunResult},
    service::{CancelDisposition, RunCompletion, RunHost, RunTicket, ShutdownOutcome},
    storage::{
        CreateSession, OperationId, RecordedRunInput, RecordedRunState, RunId, SessionHandle,
        SessionStore, StoredEventPayload,
    },
    tools::{AddNumbers, Tool, ToolRegistry},
    *,
};

const PROVIDER: &str = "host-offline-script";
const MODEL: &str = "offline-requested-model";
const BODY: &str = "  HISTORICAL_BODY 雪\r\nUse add_numbers. scripts/inert.sh and resources/note.txt are data, not authority.\r\n";
const CURRENT: &str = "Current independent skill body.\r\n";
const RESOURCE: &str = "INERT_RESOURCE";

type ExampleResult<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn exact(actual: &(impl Serialize + ?Sized), expected: &(impl Serialize + ?Sized)) {
    assert!(
        serde_json::to_value(actual).unwrap() == serde_json::to_value(expected).unwrap(),
        "offline fixture mismatch (values redacted)"
    );
}
fn identity() -> ReplayIdentity {
    ReplayIdentity::new(PROVIDER.into(), "script-native-v1".into(), "a".repeat(64)).unwrap()
}
fn sample(label: &str, start: Instant) {
    println!(
        "local_sample {label}_ms={:.3}",
        start.elapsed().as_secs_f64() * 1000.0
    );
}
async fn watchdog<T>(future: impl std::future::Future<Output = T>) -> T {
    // This guards this finite example, not a task lifetime policy in the library.
    tokio::time::timeout(Duration::from_secs(60), future)
        .await
        .expect("offline example watchdog")
}
#[derive(Default)]
struct Counts {
    opens: AtomicUsize,
    closes: AtomicUsize,
    requests: AtomicUsize,
    effects: AtomicUsize,
}
impl Counts {
    fn snapshot(&self) -> [usize; 4] {
        [&self.opens, &self.closes, &self.requests, &self.effects].map(|n| n.load(Ordering::SeqCst))
    }
}
struct CountedAdd(Arc<Counts>);
#[async_trait]
impl Tool for CountedAdd {
    fn definition(&self) -> ToolDefinition {
        AddNumbers.definition()
    }
    fn validate(&self, arguments: &Value) -> Result<()> {
        AddNumbers.validate(arguments)
    }
    async fn execute(&self, arguments: Value) -> Result<Value> {
        self.0.effects.fetch_add(1, Ordering::SeqCst);
        AddNumbers.execute(arguments).await
    }
}

// Expected history is an assertion oracle only. Only B2 supplies replay to the provider.
#[derive(Clone)]
struct Saved {
    run: RunId,
    input: RecordedRunInput,
    responses: Vec<ModelResponse>,
    results: Vec<Vec<InputItem>>,
}
struct Plan {
    label: &'static str,
    input: RecordedRunInput,
    prior: Vec<Saved>,
    inputs: Vec<Vec<InputItem>>,
    responses: Vec<ModelResponse>,
    waiting: Notify,
    release: Notify,
}
impl Plan {
    fn options(&self) -> SessionOptions {
        let mut options = self.input.prepared_request().options.clone();
        options.tools = self.input.tool_definitions().to_vec();
        options
    }
    fn replay(&self, replay: &ConversationReplay) {
        assert_eq!(replay.provider_id(), PROVIDER);
        assert_eq!(replay.requested_model(), MODEL);
        assert_eq!(replay.runs().len(), self.prior.len());
        if self.prior.is_empty() {
            assert!(replay.expected_identity().is_none());
        } else {
            exact(&replay.expected_identity(), &Some(identity()));
        }
        for (actual, saved) in replay.runs().iter().zip(&self.prior) {
            exact(&actual.source_run_id(), &saved.run.as_str());
            exact(
                &actual.prepared_prompt(),
                &saved.input.prepared_request().prompt,
            );
            assert_eq!(actual.exchanges().len(), saved.responses.len());
            for (index, exchange) in actual.exchanges().iter().enumerate() {
                exact(exchange.response(), &saved.responses[index]);
                exact(exchange.tool_results(), &saved.results[index]);
            }
        }
    }
}
struct Script {
    plans: Mutex<VecDeque<Arc<Plan>>>,
    counts: Arc<Counts>,
}
fn gateway(plans: Vec<Arc<Plan>>, counts: Arc<Counts>) -> (Arc<Gateway>, Arc<Script>) {
    let mut gateway = Gateway::new();
    let script = Arc::new(Script {
        plans: Mutex::new(plans.into()),
        counts,
    });
    gateway.register(script.clone()).unwrap();
    (Arc::new(gateway), script)
}
#[async_trait]
impl Provider for Script {
    fn id(&self) -> &'static str {
        PROVIDER
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let yes = Capability {
            implemented: true,
            verification: "finite offline script, no transport".into(),
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
        let plans = self.plans.lock().unwrap();
        let plan = plans.front().expect("unexpected validation");
        exact(options, &plan.options());
        exact(input, &plan.inputs[0]);
        plan.replay(replay);
        Ok(())
    }
    async fn open_session(&self, options: SessionOptions) -> Result<ProviderSession> {
        let plan = self
            .plans
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected open");
        exact(&options, &plan.options());
        self.counts.opens.fetch_add(1, Ordering::SeqCst);
        let (sender, mut receiver) = mpsc::channel::<(EventEnvelope, bool)>(8);
        let events = plan.clone();
        Ok(ProviderSession {
            id: plan.label.into(),
            control: Arc::new(Control {
                plan,
                counts: self.counts.clone(),
                state: Mutex::new((0, 0)),
                sender,
            }),
            events: Box::pin(async_stream::stream! {
                while let Some((event, held)) = receiver.recv().await {
                    if held {
                        events.waiting.notify_one();
                        events.release.notified().await;
                    }
                    yield event;
                }
            }),
        })
    }
}
struct Control {
    plan: Arc<Plan>,
    counts: Arc<Counts>,
    state: Mutex<(usize, u64)>,
    sender: mpsc::Sender<(EventEnvelope, bool)>,
}
#[async_trait]
impl SessionControl for Control {
    fn replay_identity(&self) -> Option<ReplayIdentity> {
        Some(identity())
    }
    async fn install_replay(&self, replay: ConversationReplay) -> Result<()> {
        self.plan.replay(&replay);
        Ok(())
    }
    async fn generate(&self, input: Vec<InputItem>) -> Result<RequestReceipt> {
        let mut state = self.state.lock().unwrap();
        let turn = state.0;
        exact(&input, &self.plan.inputs[turn]);
        let response = self.plan.responses[turn].clone();
        let request_id = format!("{}-request-{turn}", self.plan.label);
        let held = turn + 1 == self.plan.responses.len();
        for (index, event) in [
            ProviderEvent::ResponseStarted {
                response_id: response.id.clone(),
            },
            ProviderEvent::ResponseFinished { response },
        ]
        .into_iter()
        .enumerate()
        {
            state.1 += 1;
            self.sender
                .try_send((
                    EventEnvelope {
                        schema_version: 1,
                        sequence: state.1,
                        event_id: format!("{}-event-{}", self.plan.label, state.1),
                        session_id: self.plan.label.into(),
                        request_id: Some(request_id.clone()),
                        provider: PROVIDER.into(),
                        provider_sequence: None,
                        event,
                    },
                    held && index == 0,
                ))
                .expect("finite scripted event capacity");
        }
        state.0 += 1;
        self.counts.requests.fetch_add(1, Ordering::SeqCst);
        Ok(RequestReceipt { request_id })
    }
    fn close(&self) {
        self.counts.closes.fetch_add(1, Ordering::SeqCst);
    }
}
fn call(id: &str, name: &str, arguments: Value) -> OutputItem {
    let arguments = arguments.to_string();
    OutputItem {
        id: Some(id.into()),
        kind: ItemKind::FunctionCall,
        native_type: "function_call".into(),
        function_call: Some(FunctionCall {
            call_id: id.into(),
            name: name.into(),
            arguments: arguments.clone(),
            origin: CallOrigin::Direct,
            namespace: None,
            complete: true,
        }),
        native: json!({"type":"function_call","id":id,"call_id":id,"name":name,"arguments":arguments,"status":"completed","future":{"inert":true}}),
    }
}
fn response(id: &str, output: Vec<OutputItem>, text: &str) -> ModelResponse {
    let native: Vec<_> = output.iter().map(|item| item.native.clone()).collect();
    ModelResponse {
        id: id.into(),
        model: Some("offline-observed-model".into()),
        outcome: ResponseOutcome::Completed,
        output,
        text: text.into(),
        usage: None,
        output_provenance: OutputProvenance::NativeTerminal,
        native: json!({"id":id,"model":"offline-observed-model","output":native,"status":"completed","opaque":"inert 雪\r\n"}),
    }
}
fn answer(label: &str) -> ModelResponse {
    response(
        label,
        vec![OutputItem {
            id: Some(label.into()),
            kind: ItemKind::Message,
            native_type: "message".into(),
            function_call: None,
            native: json!({"type":"message","id":label,"role":"assistant","content":[{"type":"output_text","text":"Done offline."}]}),
        }],
        "Done offline.",
    )
}
fn tool_input(call_id: &str, output: String) -> InputItem {
    InputItem::ToolResult {
        call_id: call_id.into(),
        output,
    }
}
fn load_output(id: &str, body: &str) -> String {
    json!({"id":format!("project:{id}"),"frontmatter":{"name":id,"description":"Arithmetic metadata","allowed-tools":"run_script read_resource"},"body":body}).to_string()
}
fn plan(
    label: &'static str,
    input: RecordedRunInput,
    prior: Vec<Saved>,
    skill: &str,
    body: &str,
    a: u64,
    b: u64,
) -> Arc<Plan> {
    let prompt = input.prepared_request().prompt.clone();
    Arc::new(Plan {
        label,
        input,
        prior,
        inputs: vec![
            vec![InputItem::user(prompt)],
            vec![tool_input("load", load_output(skill, body))],
            vec![tool_input("sum", json!({"sum":a + b}).to_string())],
        ],
        responses: vec![
            response(
                "load-parent",
                vec![call(
                    "load",
                    "load_skill",
                    json!({"id":format!("project:{skill}")}),
                )],
                "",
            ),
            response(
                "add-parent",
                vec![call("sum", "add_numbers", json!({"a":a,"b":b}))],
                "",
            ),
            answer(label),
        ],
        waiting: Notify::new(),
        release: Notify::new(),
    })
}
fn prepare(
    roots: &ContextRoots,
    counts: Arc<Counts>,
    task: &str,
) -> (RecordedRunInput, ToolRegistry) {
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(CountedAdd(counts))).unwrap();
    let catalog = Arc::new(discover(roots.clone()).unwrap());
    // Historical permission metadata stays visible as data, but grants no tool authority.
    assert_eq!(catalog.diagnostics().len(), 1);
    let diagnostic = &catalog.diagnostics()[0];
    assert_eq!(
        diagnostic.kind(),
        DiagnosticKind::UnsupportedBehavioralMetadata
    );
    assert_eq!(diagnostic.scope(), Scope::Project);
    assert_eq!(catalog.entries().len(), 1);
    let (prepared, tools) = prepare_run_with_skill_loading(
        RunRequest {
            provider_id: PROVIDER.into(),
            options: SessionOptions::new(MODEL),
            prompt: task.into(),
        },
        catalog,
        &[],
        &tools,
    )
    .unwrap();
    let input = RecordedRunInput::capture(task.into(), &prepared, &tools).unwrap();
    assert!(input.active_skills().is_empty());
    assert!(
        input
            .prepared_request()
            .options
            .required_features
            .is_empty()
    );
    exact(
        &input
            .tool_definitions()
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        &["add_numbers", "load_skill"],
    );
    assert!(!input.prepared_request().prompt.contains(BODY));
    assert!(!input.prepared_request().prompt.contains(CURRENT));
    assert!(!input.prepared_request().prompt.contains(RESOURCE));
    (input, tools)
}
fn request(input: RecordedRunInput) -> PersistentRunRequest {
    PersistentRunRequest {
        operation_id: OperationId::new(),
        run_id: RunId::new(),
        input,
    }
}
async fn session(host: &RunHost) -> SessionHandle {
    let created = host
        .storage()
        .create_session(
            CreateSession::new(OperationId::new(), "Offline host".into(), None).unwrap(),
        )
        .await
        .unwrap();
    host.storage()
        .open_session(created.session_id().clone())
        .await
        .unwrap()
}
async fn terminal(session: &SessionHandle, run: &RunId) -> RunResult {
    watchdog(async {
        loop {
            let saved = session.run_record(run.clone()).await.unwrap().unwrap();
            if let Some(result) = saved.result() {
                return result.clone();
            }
            tokio::task::yield_now().await;
        }
    })
    .await
}
async fn completed(ticket: &RunTicket) -> RunResult {
    let receipt = watchdog(ticket.accepted()).await.unwrap();
    let completion = watchdog(ticket.completion()).await;
    let RunCompletion::Execution(Ok(PersistentRunResult::Executed {
        acceptance,
        final_record,
        result,
    })) = completion.as_ref()
    else {
        panic!("offline task did not execute: {completion:?}")
    };
    assert_eq!(acceptance, &receipt);
    assert!(final_record.cleanup_warning().is_none());
    assert!(result.events_complete && result.sink_error.is_none());
    result.as_ref().clone()
}
async fn shutdown(host: &RunHost) {
    let start = Instant::now();
    assert!(matches!(
        &*watchdog(host.begin_shutdown().wait()).await,
        ShutdownOutcome::Closed
    ));
    sample("shutdown", start);
}
fn skill(roots: &ContextRoots, name: &str, body: &str) {
    let directory = roots.workspace.join(".agents/skills").join(name);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("SKILL.md"), format!("---\nname: {name}\ndescription: Arithmetic metadata\nallowed-tools: run_script read_resource\n---\n{body}")).unwrap();
}

async fn demonstrate(delete_source: bool, forbidden: &str) -> ExampleResult<()> {
    println!("Finite offline samples; fixture sizes are not limits. No SLA or network claim.");
    let temp = tempfile::tempdir()?;
    let roots = ContextRoots {
        workspace: temp.path().join("old-workspace"),
        global_skills: temp.path().join("absent-global"),
    };
    skill(&roots, "arithmetic", BODY);
    fs::write(
        roots.workspace.join("AGENTS.md"),
        "Old project instructions.\r\n",
    )?;
    let directory = roots.workspace.join(".agents/skills/arithmetic");
    fs::create_dir(directory.join("scripts"))?;
    fs::create_dir(directory.join("resources"))?;
    let marker = temp.path().join("script-ran");
    let script = format!("#!/bin/sh\nprintf inert > '{}'\n", marker.display());
    fs::write(directory.join("scripts/inert.sh"), &script)?;
    fs::write(directory.join("resources/note.txt"), RESOURCE)?;
    let counts = Arc::new(Counts::default());
    let (input_a, tools_a) = prepare(
        &roots,
        counts.clone(),
        "Load arithmetic, then add 17 and 25.",
    );
    let a = plan("a", input_a.clone(), vec![], "arithmetic", BODY, 17, 25);
    let root = temp.path().join("store");
    let host = RunHost::new(
        SessionStore::open(root.clone()).await?,
        gateway(vec![a.clone()], counts.clone()).0,
    )?;
    let session_a = session(&host).await;
    assert_eq!(counts.snapshot(), [0; 4]);
    let client = host.client();
    let start = Instant::now();
    let ticket = client.submit(
        session_a.session_id().clone(),
        request(input_a.clone()),
        tools_a,
    )?;
    let run_a = ticket.run_id().clone();
    let receipt = watchdog(ticket.accepted()).await.unwrap();
    sample("a_dispatch_to_receipt", start);
    let accepted_at = Instant::now();
    assert!(!receipt.duplicate() && receipt.cleanup_warning().is_none());
    assert_eq!(receipt.receipt().first_sequence(), 2);
    assert_eq!(receipt.receipt().last_sequence(), 3);
    assert!(ticket.completion().now_or_never().is_none());
    drop(ticket);
    drop(client);
    watchdog(a.waiting.notified()).await;
    let independent = host
        .storage()
        .open_session(session_a.session_id().clone())
        .await?;
    let sum = independent
        .tool_result(run_a.clone(), "sum".into())
        .await?
        .unwrap();
    exact(&sum.output(), &Some("{\"sum\":42}"));
    let loaded = independent
        .tool_result(run_a.clone(), "load".into())
        .await?
        .unwrap();
    exact(
        &loaded.output(),
        &Some(load_output("arithmetic", BODY).as_str()),
    );
    assert_eq!(loaded.is_error(), Some(false));
    assert_eq!(
        independent
            .run_record(run_a.clone())
            .await?
            .unwrap()
            .state(),
        RecordedRunState::Running
    );
    assert_eq!(counts.snapshot(), [1, 0, 3, 1]);
    println!("local_sample a_provider_connections_active=1 saved_outputs_before_completion=2");
    a.release.notify_one();
    let result_a = terminal(&independent, &run_a).await;
    sample("a_receipt_to_completion_observed", accepted_at);
    assert_eq!(result_a.outcome, RunOutcome::Completed);
    assert!(result_a.events_complete && result_a.sink_error.is_none());
    assert_eq!(result_a.summary.new_tool_dispatches, 2);
    assert_eq!(result_a.summary.reused_results, 0);
    let saved = independent.run_record(run_a.clone()).await?.unwrap();
    assert_eq!(saved.state(), RecordedRunState::Completed);
    exact(saved.input(), &input_a);
    // Obtain the response oracle from committed history, not a caller-created Replay DTO.
    let page = independent.history_page(0, None, 128).await?;
    assert!(!page.has_more());
    let prefix = serde_json::to_value(page.records())?;
    let responses = page
        .records()
        .iter()
        .filter_map(|record| {
            if let StoredEventPayload::RuntimeObserved(envelope) = record.payload()
                && let RunEvent::ProviderEvent { event } = &envelope.event
                && let ProviderEvent::ResponseFinished { response } = &event.event
            {
                return Some(response.clone());
            }
            None
        })
        .collect::<Vec<_>>();
    exact(&responses, &a.responses);
    let prior = Saved {
        run: run_a.clone(),
        input: input_a,
        responses,
        results: vec![
            vec![tool_input("load", loaded.output().unwrap().into())],
            vec![tool_input("sum", sum.output().unwrap().into())],
            vec![],
        ],
    };
    shutdown(&host).await;
    assert_eq!(counts.snapshot(), [1, 1, 3, 1]);
    let id = session_a.session_id().clone();
    drop(independent);
    drop(session_a);
    drop(host);
    if delete_source {
        fs::remove_file(directory.join("SKILL.md"))?;
    } else {
        skill(
            &roots,
            "arithmetic",
            "Changed old body must never replace saved bytes.",
        );
    }
    fs::remove_file(roots.workspace.join("AGENTS.md"))?;
    let current = ContextRoots {
        workspace: temp.path().join("current-workspace"),
        global_skills: temp.path().join("absent-global"),
    };
    skill(&current, "current", CURRENT);
    fs::write(
        current.workspace.join("AGENTS.md"),
        "Independent current project instructions.\r\n",
    )?;
    let (input_b, tools_b) = prepare(
        &current,
        counts.clone(),
        "Load current, then add 8 to the saved result.",
    );
    assert_eq!(input_b.available_skills(), ["project:current"]);
    assert!(
        !input_b
            .prepared_request()
            .prompt
            .contains("Old project instructions")
    );
    assert!(
        input_b
            .prepared_request()
            .prompt
            .contains("Independent current project instructions")
    );
    let b = plan("b", input_b.clone(), vec![prior], "current", CURRENT, 42, 8);
    let cancel_input = RecordedRunInput::new(
        "Cancellation fixture".into(),
        RunRequest {
            provider_id: PROVIDER.into(),
            options: SessionOptions::new(MODEL),
            prompt: "Wait for explicit cancellation.".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )?;
    let cancel = Arc::new(Plan {
        label: "cancel",
        input: cancel_input.clone(),
        prior: vec![],
        inputs: vec![vec![InputItem::user(
            cancel_input.prepared_request().prompt.clone(),
        )]],
        responses: vec![answer("cancel")],
        waiting: Notify::new(),
        release: Notify::new(),
    });
    let (gateway, script_provider) = gateway(vec![b.clone(), cancel.clone()], counts.clone());
    let host = RunHost::new(SessionStore::open(root).await?, gateway)?;
    let session_b = host.storage().open_session(id).await?;
    exact(
        session_b.history_page(0, None, 128).await?.records(),
        &prefix,
    );
    assert_eq!(
        counts.snapshot(),
        [1, 1, 3, 1],
        "reopen and reads do no work"
    );
    let start = Instant::now();
    let ticket = host.client().submit(
        session_b.session_id().clone(),
        request(input_b.clone()),
        tools_b.fresh_scope(),
    )?;
    watchdog(ticket.accepted()).await.unwrap();
    sample("b_dispatch_to_receipt", start);
    let accepted_at = Instant::now();
    watchdog(b.waiting.notified()).await;
    assert_eq!(counts.snapshot(), [2, 1, 6, 2]);
    b.release.notify_one();
    let result_b = completed(&ticket).await;
    sample("b_receipt_to_completion", accepted_at);
    assert_eq!(result_b.outcome, RunOutcome::Completed);
    assert_eq!(result_b.summary.new_tool_dispatches, 2);
    assert_eq!(result_b.summary.reused_results, 0);
    assert_ne!(result_a.session_id, result_b.session_id);
    exact(
        &session_b
            .tool_result(ticket.run_id().clone(), "sum".into())
            .await?
            .unwrap()
            .output(),
        &Some("{\"sum\":50}"),
    );
    let page = session_b.history_page(0, None, 128).await?;
    exact(&page.records()[..prefix.as_array().unwrap().len()], &prefix);
    assert!(!marker.exists());
    assert!(fs::read_to_string(directory.join("scripts/inert.sh"))? == script);
    assert!(fs::read_to_string(directory.join("resources/note.txt"))? == RESOURCE);
    // These model proposals must fail in the host's real tool admission, not a private helper.
    let item = match forbidden {
        "resource" => call(
            "inert",
            "load_skill",
            json!({"id":"project:arithmetic/resources/note.txt"}),
        ),
        "script" => call(
            "inert",
            "load_skill",
            json!({"id":"project:arithmetic/scripts/inert.sh"}),
        ),
        "permission" => call("inert", "run_script", json!({"path":"scripts/inert.sh"})),
        _ => unreachable!(),
    };
    let mut prior = b.prior.clone();
    prior.push(Saved {
        run: ticket.run_id().clone(),
        input: input_b.clone(),
        responses: b.responses.clone(),
        results: vec![b.inputs[1].clone(), b.inputs[2].clone(), vec![]],
    });
    let inert = Arc::new(Plan {
        label: "inert",
        input: input_b.clone(),
        prior,
        inputs: vec![vec![InputItem::user(
            input_b.prepared_request().prompt.clone(),
        )]],
        responses: vec![response("inert", vec![item], "")],
        waiting: Notify::new(),
        release: Notify::new(),
    });
    inert.release.notify_one();
    script_provider.plans.lock().unwrap().push_front(inert);
    let inert_ticket =
        host.client()
            .submit(session_b.session_id().clone(), request(input_b), tools_b)?;
    let inert_result = completed(&inert_ticket).await;
    assert_eq!(
        inert_result.outcome,
        RunOutcome::Failed {
            code: "tool_preflight".into()
        }
    );
    assert_eq!(inert_result.summary.new_tool_dispatches, 0);
    assert!(
        session_b
            .tool_result(inert_ticket.run_id().clone(), "inert".into())
            .await?
            .is_none()
    );
    assert_eq!(
        session_b
            .run_record(inert_ticket.run_id().clone())
            .await?
            .unwrap()
            .state(),
        RecordedRunState::Failed
    );
    assert!(!marker.exists());
    let cancel_session = session(&host).await;
    let client = host.client();
    let cancelled = client.submit(
        cancel_session.session_id().clone(),
        request(cancel_input),
        ToolRegistry::new(),
    )?;
    watchdog(cancelled.accepted()).await.unwrap();
    watchdog(cancel.waiting.notified()).await;
    let start = Instant::now();
    assert_eq!(
        client.cancel(cancelled.session_id(), cancelled.run_id()),
        CancelDisposition::Requested
    );
    assert_eq!(
        completed(&cancelled).await.outcome,
        RunOutcome::CancelledLocally
    );
    // NotTracked observes retirement, not merely publication of the completion value.
    watchdog(async {
        while client.cancel(cancelled.session_id(), cancelled.run_id())
            != CancelDisposition::NotTracked
        {
            tokio::task::yield_now().await;
        }
    })
    .await;
    sample("cancellation_to_drain", start);
    println!("local_sample cancelled_run_tracking=NotTracked");
    shutdown(&host).await;
    assert_eq!(counts.snapshot(), [4, 4, 8, 2]);
    println!(
        "local_sample provider_connections_opened=4 provider_connections_closed=4 active_after_shutdown=0"
    );
    println!(
        "Completed offline: dropped A observers, saved S2/add output, explicit B, cancellation and orderly shutdown."
    );
    Ok(())
}

#[tokio::main]
async fn main() -> ExampleResult<()> {
    demonstrate(true, "permission").await
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn v1a_24_host_s2_saved_bytes_survive_mutated_and_deleted_sources() {
        for delete_source in [false, true] {
            for forbidden in ["resource", "script", "permission"] {
                super::demonstrate(delete_source, forbidden).await.unwrap();
            }
        }
    }
}
