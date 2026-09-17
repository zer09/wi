//! Two explicit tasks, stored native history, and real tools. No credentials or network.
use async_trait::async_trait;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    error::Error,
    fs,
    future::Future,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wi::{
    context::{ContextRoots, discover, prepare_run_with_skill_loading},
    execution::{
        PersistentRunRequest, PersistentRunResult, prepare_session_replay, run_in_session,
    },
    run::{RunOutcome, RunRequest},
    storage::{
        CreateSession, OperationId, RecordedProviderBinding, RecordedRun, RecordedRunInput,
        RecordedRunState, RecordedToolResult, RunId, SessionHandle, SessionStore,
        StoredHistorySelection,
    },
    tools::{AddNumbers, Tool, ToolRegistry},
    *,
};

type ExampleResult<T> = std::result::Result<T, Box<dyn Error>>;
const PROVIDER: &str = "conversation-script";
const MODEL: &str = "offline-requested-model";
const BODY: &str = "  HISTORICAL_SKILL_BODY 雪\r\nUse add_numbers for exact arithmetic.\r\n";
const DESCRIPTION: &str = "Project arithmetic metadata";
const RESOURCE: &str = "INERT_RESOURCE_CANARY";
const OPAQUE: &str = "SYNTHETIC_OPAQUE_CANARY 雪\r\n";
const SUM_CALL: &str = "same-sum-call";

fn identity() -> ReplayIdentity {
    // A fixed synthetic marker, not a token, account identifier, or credential lookup.
    ReplayIdentity::new(PROVIDER.into(), "script-native-v1".into(), "a".repeat(64)).unwrap()
}

fn exact(actual: &(impl Serialize + ?Sized), expected: &(impl Serialize + ?Sized)) {
    // Do not leak prompts, native values, or identity markers on an assertion failure.
    assert!(
        serde_json::to_value(actual).unwrap() == serde_json::to_value(expected).unwrap(),
        "offline fixture mismatch (values redacted)"
    );
}

#[derive(Default)]
struct Counts {
    constructed: AtomicUsize,
    validated: AtomicUsize,
    opened: AtomicUsize,
    installed: AtomicUsize,
    generated: AtomicUsize,
    closed: AtomicUsize,
    tool_validated: AtomicUsize,
    tool_executed: AtomicUsize,
}
impl Counts {
    fn snapshot(&self) -> [usize; 8] {
        [
            &self.constructed,
            &self.validated,
            &self.opened,
            &self.installed,
            &self.generated,
            &self.closed,
            &self.tool_validated,
            &self.tool_executed,
        ]
        .map(|count| count.load(Ordering::SeqCst))
    }
}

struct CountedAdd(Arc<Counts>);
#[async_trait]
impl Tool for CountedAdd {
    fn definition(&self) -> ToolDefinition {
        AddNumbers.definition()
    }
    fn validate(&self, arguments: &Value) -> Result<()> {
        self.0.tool_validated.fetch_add(1, Ordering::SeqCst);
        AddNumbers.validate(arguments)
    }
    async fn execute(&self, arguments: Value) -> Result<Value> {
        self.0.tool_executed.fetch_add(1, Ordering::SeqCst);
        AddNumbers.execute(arguments).await
    }
}

fn native_input(input: &InputItem) -> Value {
    match input {
        InputItem::User { text } => json!({"role":"user","content":text}),
        InputItem::ToolResult { call_id, output } => {
            json!({"type":"function_call_output","call_id":call_id,"output":output})
        }
    }
}

struct Script {
    label: &'static str,
    session_id: &'static str,
    run_id: RunId,
    input: RecordedRunInput,
    expected_replay: ConversationReplay,
    expected_prefix: Vec<Value>,
    inputs: Vec<Vec<InputItem>>,
    responses: Vec<ModelResponse>,
    counts: Arc<Counts>,
}
impl Script {
    fn restore(&self, replay: &ConversationReplay) -> Result<Vec<Value>> {
        if replay.provider_id() != PROVIDER
            || replay.requested_model() != MODEL
            || replay
                .expected_identity()
                .is_some_and(|id| id != &identity())
        {
            return Err(GatewayError::InvalidRequest("script replay incompatible"));
        }
        // This finite provider supports only its declared script, including native envelopes.
        exact(replay, &self.expected_replay);
        let mut history = vec![];
        for run in replay.runs() {
            history.push(native_input(&InputItem::user(run.prepared_prompt())));
            for exchange in run.exchanges() {
                let response = exchange.response();
                let effective: Vec<_> = response
                    .output
                    .iter()
                    .map(|item| item.native.clone())
                    .collect();
                match response.output_provenance {
                    OutputProvenance::NativeTerminal => {
                        exact(&response.native["output"], &effective)
                    }
                    OutputProvenance::ValidatedOutputItemDone => {
                        exact(&response.native["output"], &json!([]));
                    }
                }
                // Recovery keeps the saved empty terminal and installs its effective items.
                history.extend(effective);
                history.extend(exchange.tool_results().iter().map(native_input));
            }
        }
        exact(&history, &self.expected_prefix);
        Ok(history)
    }

    fn options(&self) -> SessionOptions {
        let mut options = self.input.prepared_request().options.clone();
        options.tools = self.input.tool_definitions().to_vec();
        options
    }
}

struct OfflineProvider(Arc<Script>);
#[async_trait]
impl Provider for OfflineProvider {
    fn id(&self) -> &'static str {
        PROVIDER
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let yes = Capability {
            implemented: true,
            verification: "finite in-process script only; no transport".into(),
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
    ) -> Result<()> {
        options.validate()?;
        validate_input(new_input)?;
        exact(options, &self.0.options());
        exact(new_input, &self.0.inputs[0]);
        self.0.restore(replay)?;
        self.0.counts.validated.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn open_session(&self, options: SessionOptions) -> Result<ProviderSession> {
        exact(&options, &self.0.options());
        self.0.counts.opened.fetch_add(1, Ordering::SeqCst);
        let (sender, mut receiver) = mpsc::unbounded_channel();
        Ok(ProviderSession {
            id: self.0.session_id.into(),
            control: Arc::new(Control {
                script: self.0.clone(),
                state: Mutex::new(State::default()),
                sender,
            }),
            events: Box::pin(async_stream::stream! {
                while let Some(event) = receiver.recv().await { yield event; }
            }),
        })
    }
}

#[derive(Default)]
struct State {
    history: Option<Vec<Value>>,
    turn: usize,
    sequence: u64,
    closed: bool,
}
struct Control {
    script: Arc<Script>,
    state: Mutex<State>,
    sender: mpsc::UnboundedSender<EventEnvelope>,
}
#[async_trait]
impl SessionControl for Control {
    fn replay_identity(&self) -> Option<ReplayIdentity> {
        Some(identity())
    }
    async fn install_replay(&self, replay: ConversationReplay) -> Result<()> {
        let start = Instant::now();
        let mut state = self.state.lock().unwrap();
        if state.closed || state.history.is_some() || state.turn != 0 {
            return Err(GatewayError::InvalidRequest("script control is not fresh"));
        }
        state.history = Some(self.script.restore(&replay)?);
        self.script.counts.installed.fetch_add(1, Ordering::SeqCst);
        println!(
            "local_sample {}_replay_install_ms={:.3}",
            self.script.label,
            start.elapsed().as_secs_f64() * 1000.0
        );
        Ok(())
    }
    async fn generate(&self, input: Vec<InputItem>) -> Result<RequestReceipt> {
        let mut state = self.state.lock().unwrap();
        assert!(!state.closed);
        let turn = state.turn;
        assert!(turn < self.script.responses.len());
        exact(&input, &self.script.inputs[turn]);
        let history = state.history.as_mut().expect("replay must be installed");
        history.extend(input.iter().map(native_input));
        let mut expected = self.script.expected_prefix.clone();
        for prior in 0..turn {
            expected.extend(self.script.inputs[prior].iter().map(native_input));
            expected.extend(
                self.script.responses[prior]
                    .output
                    .iter()
                    .map(|item| item.native.clone()),
            );
        }
        expected.extend(self.script.inputs[turn].iter().map(native_input));
        exact(history, &expected);
        let response = self.script.responses[turn].clone();
        history.extend(response.output.iter().map(|item| item.native.clone()));
        state.turn += 1;
        self.script.counts.generated.fetch_add(1, Ordering::SeqCst);
        let request_id = format!("{}-request-{}", self.script.label, turn + 1);
        let mut events = vec![ProviderEvent::ResponseStarted {
            response_id: response.id.clone(),
        }];
        for (index, item) in response.output.iter().enumerate() {
            events.push(ProviderEvent::OutputItemFinished {
                response_id: response.id.clone(),
                output_index: index as u64,
                item: item.clone(),
            });
        }
        events.push(ProviderEvent::ResponseFinished { response });
        for event in events {
            state.sequence += 1;
            self.sender
                .send(EventEnvelope {
                    schema_version: 1,
                    sequence: state.sequence,
                    event_id: format!("{}-event-{}", self.script.label, state.sequence),
                    session_id: self.script.session_id.into(),
                    request_id: Some(request_id.clone()),
                    provider: PROVIDER.into(),
                    provider_sequence: None,
                    event,
                })
                .unwrap();
        }
        Ok(RequestReceipt { request_id })
    }
    fn close(&self) {
        let mut state = self.state.lock().unwrap();
        assert!(!state.closed);
        state.closed = true;
        self.script.counts.closed.fetch_add(1, Ordering::SeqCst);
    }
}

fn call(id: &str, name: &str, arguments: &str) -> OutputItem {
    OutputItem {
        id: Some(format!("item-{id}")),
        kind: ItemKind::FunctionCall,
        native_type: "function_call".into(),
        function_call: Some(FunctionCall {
            call_id: id.into(),
            name: name.into(),
            arguments: arguments.into(),
            origin: CallOrigin::Direct,
            namespace: None,
            complete: true,
        }),
        native: json!({"id":format!("item-{id}"),"type":"function_call","call_id":id,"name":name,"arguments":arguments,"status":"completed"}),
    }
}
fn response(id: &str, output: Vec<OutputItem>, text: &str, recovered: bool) -> ModelResponse {
    let native_output: Vec<_> = output.iter().map(|item| item.native.clone()).collect();
    let mut native = json!({"id":id,"model":"offline-observed-model","status":"completed","output":native_output});
    let mut provenance = OutputProvenance::NativeTerminal;
    if recovered {
        native["output"] = json!([]);
        provenance = OutputProvenance::ValidatedOutputItemDone;
    }
    ModelResponse {
        id: id.into(),
        model: Some("offline-observed-model".into()),
        outcome: ResponseOutcome::Completed,
        output,
        text: text.into(),
        usage: None,
        native,
        output_provenance: provenance,
    }
}
fn answer(id: &str, text: &str) -> ModelResponse {
    response(
        id,
        vec![OutputItem {
            id: Some(format!("item-{id}")),
            kind: ItemKind::Message,
            native_type: "message".into(),
            function_call: None,
            native: json!({"id":format!("item-{id}"),"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}),
        }],
        text,
        false,
    )
}
fn tool_input(call_id: &str, output: &str) -> InputItem {
    InputItem::ToolResult {
        call_id: call_id.into(),
        output: output.into(),
    }
}

fn prepare(
    roots: &ContextRoots,
    counts: Arc<Counts>,
    task: &str,
    instructions: &str,
) -> ExampleResult<(RecordedRunInput, ToolRegistry)> {
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(CountedAdd(counts)))?;
    let catalog = Arc::new(discover(roots.clone())?);
    assert!(catalog.diagnostics().is_empty());
    let mut options = SessionOptions::new(MODEL);
    options.instructions = instructions.into();
    let (prepared, tools) = prepare_run_with_skill_loading(
        RunRequest {
            provider_id: PROVIDER.into(),
            options,
            prompt: task.into(),
        },
        catalog,
        &[],
        &tools,
    )?;
    let input = RecordedRunInput::capture(task.into(), &prepared, &tools)?;
    assert!(input.active_skills().is_empty());
    assert_eq!(
        input.project_instructions_source(),
        Some("project:AGENTS.md")
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
    assert!(!input.prepared_request().prompt.contains(RESOURCE));
    Ok((input, tools))
}

async fn measured<T, E>(
    label: &str,
    future: impl Future<Output = std::result::Result<T, E>>,
) -> std::result::Result<T, E> {
    let start = Instant::now();
    let result = future.await?;
    println!(
        "local_sample {label}_ms={:.3}",
        start.elapsed().as_secs_f64() * 1000.0
    );
    Ok(result)
}

#[derive(Serialize)]
struct SavedTask {
    run: RecordedRun,
    selection: StoredHistorySelection,
    binding: RecordedProviderBinding,
}
async fn read_task(session: &SessionHandle, run_id: &RunId) -> ExampleResult<SavedTask> {
    let run = session.run_record(run_id.clone()).await?.unwrap();
    let selection = session.history_selection(run_id.clone()).await?.unwrap();
    let binding = session.provider_binding(run_id.clone()).await?.unwrap();
    assert_eq!(run.state(), RecordedRunState::Completed);
    assert!(run.terminal().is_some());
    assert_eq!(run.result().unwrap().outcome, RunOutcome::Completed);
    assert_eq!(selection.policy(), "closed-exchanges-v1");
    assert_eq!(selection.provider_id(), PROVIDER);
    assert_eq!(selection.requested_model(), MODEL);
    assert_eq!(selection.through_sequence() + 1, run.accepted_sequence());
    exact(binding.run_id(), run_id);
    exact(binding.identity(), &identity());
    exact(
        &run.provider_session_id(),
        &Some(binding.provider_session_id()),
    );
    assert_eq!(binding.requested_model(), MODEL);
    Ok(SavedTask {
        run,
        selection,
        binding,
    })
}
async fn submit(
    session: &SessionHandle,
    tools: &ToolRegistry,
    script: Script,
) -> ExampleResult<SavedTask> {
    let script = Arc::new(script);
    script.counts.constructed.fetch_add(1, Ordering::SeqCst);
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(OfflineProvider(script.clone())))?;
    let start = Instant::now();
    let PersistentRunResult::Executed {
        acceptance,
        final_record,
        result,
    } = run_in_session(
        &gateway,
        session,
        PersistentRunRequest {
            operation_id: OperationId::new(),
            run_id: script.run_id.clone(),
            input: script.input.clone(),
        },
        tools,
        CancellationToken::new(),
    )
    .await?
    else {
        panic!("new task must execute");
    };
    println!(
        "local_sample {}_end_to_end_ms={:.3}",
        script.label,
        start.elapsed().as_secs_f64() * 1000.0
    );
    assert!(!acceptance.duplicate() && !final_record.duplicate());
    assert!(acceptance.cleanup_warning().is_none() && final_record.cleanup_warning().is_none());
    assert_eq!(
        acceptance.receipt().last_sequence(),
        acceptance.receipt().first_sequence() + 1
    );
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(result.events_complete && result.sink_error.is_none());
    assert_eq!(
        result.summary.model_requests_attempted,
        script.responses.len() as u64
    );
    assert_eq!(
        result.summary.model_requests_admitted,
        script.responses.len() as u64
    );
    assert_eq!(
        result.summary.new_tool_dispatches,
        (script.responses.len() - 1) as u64
    );
    assert_eq!(
        result.summary.tool_results_prepared,
        (script.responses.len() - 1) as u64
    );
    assert_eq!(result.summary.reused_results, 0);
    exact(
        result.last_response.as_ref().unwrap(),
        script.responses.last().unwrap(),
    );
    let saved = read_task(session, &script.run_id).await?;
    exact(saved.run.result().unwrap(), result.as_ref());
    exact(saved.run.input(), &script.input);
    Ok(saved)
}
async fn saved_tool(
    session: &SessionHandle,
    run: &RunId,
    call: &str,
    tool: &str,
    request: &str,
    output: &str,
) -> ExampleResult<RecordedToolResult> {
    let result = session
        .tool_result(run.clone(), call.into())
        .await?
        .unwrap();
    exact(result.run_id(), run);
    assert_eq!(result.call_id(), call);
    assert_eq!(result.tool_name(), tool);
    assert_eq!(result.request_id(), Some(request));
    assert_eq!(result.is_error(), Some(false));
    exact(&result.output(), &Some(output));
    assert!(result.started_sequence() < result.result_sequence().unwrap());
    assert!(result.result_sequence().unwrap() < result.finished_sequence().unwrap());
    Ok(result)
}
fn sizes(root: &Path, id: &str) -> ExampleResult<()> {
    let session = root
        .join("sessions")
        .join(&id[..2])
        .join(id)
        .join("session.sqlite3");
    for (label, path) in [
        ("catalog", root.join("catalog.sqlite3")),
        ("session", session),
    ] {
        let wal = path.with_file_name(format!("{label}.sqlite3-wal"));
        let wal_bytes = match fs::metadata(wal) {
            Ok(meta) => meta.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error.into()),
        };
        println!(
            "local_sample stored_after_close_{label}_bytes={} {label}_wal_bytes={wal_bytes}",
            fs::metadata(path)?.len()
        );
    }
    Ok(())
}

#[tokio::main]
async fn main() -> ExampleResult<()> {
    println!(
        "Finite local samples only, not an SLA or fastest claim; install is in-process, timings include public API overhead."
    );
    let start = Instant::now();
    let temp = tempfile::tempdir()?;
    let roots = ContextRoots {
        workspace: temp.path().join("workspace"),
        global_skills: temp.path().join("global"),
    };
    let project = roots.workspace.join(".agents/skills/arithmetic");
    let global = roots.global_skills.join("arithmetic");
    fs::create_dir_all(project.join("scripts"))?;
    fs::create_dir_all(project.join("resources"))?;
    fs::create_dir_all(&global)?;
    fs::write(
        roots.workspace.join("AGENTS.md"),
        "Task A project instructions.\n",
    )?;
    fs::write(
        project.join("SKILL.md"),
        format!("---\nname: arithmetic\ndescription: {DESCRIPTION}\n---\n{BODY}"),
    )?;
    fs::write(
        global.join("SKILL.md"),
        "---\nname: arithmetic\ndescription: Global arithmetic metadata\n---\nUNSELECTED_GLOBAL_BODY\n",
    )?;
    let marker = temp.path().join("script-ran");
    let inert_script = format!("#!/bin/sh\nprintf inert > '{}'\n", marker.display());
    fs::write(project.join("scripts/inert.sh"), &inert_script)?;
    fs::write(project.join("resources/note.txt"), RESOURCE)?;

    let root = temp.path().join("data");
    let store = SessionStore::open(root.clone()).await?;
    let created = store
        .create_session(CreateSession::new(
            OperationId::new(),
            "Offline conversation".into(),
            None,
        )?)
        .await?;
    let id = created.session_id().clone();
    let session = store.open_session(id.clone()).await?;
    let counts = Arc::new(Counts::default());
    let (input_a, tools_a) = prepare(
        &roots,
        counts.clone(),
        "Load the project arithmetic skill, then add 17 and 25.",
        "Current A instructions.",
    )?;
    assert_eq!(
        input_a.available_skills(),
        ["global:arithmetic", "project:arithmetic"]
    );
    let load_output = json!({"id":"project:arithmetic","frontmatter":{"name":"arithmetic","description":DESCRIPTION},"body":BODY}).to_string();
    let a_responses = vec![
        response(
            "a-load",
            vec![call(
                "load-project",
                "load_skill",
                "{\"id\":\"project:arithmetic\"}",
            )],
            "",
            false,
        ),
        response(
            "a-add",
            vec![
                OutputItem {
                    id: Some("opaque-reasoning".into()),
                    kind: ItemKind::Reasoning,
                    native_type: "reasoning".into(),
                    function_call: None,
                    native: json!({"id":"opaque-reasoning","type":"reasoning","encrypted_content":OPAQUE,"summary":[],"nonexecuting_extra":"preserved"}),
                },
                call(SUM_CALL, "add_numbers", "{\"a\":17,\"b\":25}"),
            ],
            "",
            true,
        ),
        answer("a-final", "42"),
    ];
    let a_run = RunId::new();
    let saved_a = submit(
        &session,
        &tools_a,
        Script {
            label: "a",
            session_id: "offline-session-a",
            run_id: a_run.clone(),
            input: input_a.clone(),
            expected_replay: ConversationReplay::new(PROVIDER.into(), MODEL.into(), None, vec![])?,
            expected_prefix: vec![],
            inputs: vec![
                vec![InputItem::user(&input_a.prepared_request().prompt)],
                vec![tool_input("load-project", &load_output)],
                vec![tool_input(SUM_CALL, "{\"sum\":42}")],
            ],
            responses: a_responses.clone(),
            counts: counts.clone(),
        },
    )
    .await?;
    assert!(saved_a.selection.expected_identity().is_none());
    assert_eq!(saved_a.selection.through_sequence(), 1);
    let loaded = saved_tool(
        &session,
        &a_run,
        "load-project",
        "load_skill",
        "a-request-1",
        &load_output,
    )
    .await?;
    let sum_a = saved_tool(
        &session,
        &a_run,
        SUM_CALL,
        "add_numbers",
        "a-request-2",
        "{\"sum\":42}",
    )
    .await?;
    let history_a = session.history_page(0, None, 128).await?;
    assert!(!history_a.has_more());
    assert_eq!(counts.snapshot(), [1, 1, 1, 1, 3, 1, 1, 1]);
    store.close().await?;
    drop(tools_a);
    drop(session);
    drop(store);
    assert_eq!(Arc::strong_count(&counts), 1);

    // Nothing retains the old catalog or provider. Missing main files cannot supply old bodies.
    fs::remove_file(project.join("SKILL.md"))?;
    fs::remove_file(global.join("SKILL.md"))?;
    let before = counts.snapshot();
    let store = SessionStore::open(root.clone()).await?;
    let session = store.open_session(id.clone()).await?;
    let read_a = measured("history_read_after_a", session.history_page(0, None, 128)).await?;
    exact(&read_a, &history_a);
    exact(&read_task(&session, &a_run).await?, &saved_a);
    let prepared = measured(
        "replay_prepare_after_a",
        prepare_session_replay(&session, PROVIDER, MODEL),
    )
    .await?;
    assert_eq!(prepared.included_run_count(), 1);
    assert_eq!(prepared.included_exchange_count(), 3);
    assert!(prepared.excluded_runs().is_empty());
    assert_eq!(counts.snapshot(), before);
    assert_eq!(
        session.manifest().await?.head_sequence(),
        history_a.through_sequence()
    );
    let expected_replay = ConversationReplay::new(
        PROVIDER.into(),
        MODEL.into(),
        Some(identity()),
        vec![ReplayRun::new(
            a_run.to_string(),
            input_a.prepared_request().prompt.clone(),
            vec![
                ReplayExchange::new(
                    a_responses[0].clone(),
                    vec![tool_input("load-project", &load_output)],
                )?,
                ReplayExchange::new(
                    a_responses[1].clone(),
                    vec![tool_input(SUM_CALL, "{\"sum\":42}")],
                )?,
                ReplayExchange::new(a_responses[2].clone(), vec![])?,
            ],
        )?],
    )?;
    exact(&prepared.replay(), &expected_replay);
    let prefix = vec![
        native_input(&InputItem::user(&input_a.prepared_request().prompt)),
        a_responses[0].output[0].native.clone(),
        native_input(&tool_input("load-project", &load_output)),
        a_responses[1].output[0].native.clone(),
        a_responses[1].output[1].native.clone(),
        native_input(&tool_input(SUM_CALL, "{\"sum\":42}")),
        a_responses[2].output[0].native.clone(),
    ];

    // B discovers current context and a fresh registry; historical skill metadata grants no tools.
    fs::write(
        roots.workspace.join("AGENTS.md"),
        "Task B current project instructions.\n",
    )?;
    let current = roots.workspace.join(".agents/skills/current");
    fs::create_dir_all(&current)?;
    fs::write(
        current.join("SKILL.md"),
        "---\nname: current\ndescription: Current metadata only\n---\nCURRENT_UNLOADED_BODY\n",
    )?;
    let (input_b, tools_b) = prepare(
        &roots,
        counts.clone(),
        "Add one to task A's saved answer.",
        "Current B instructions.",
    )?;
    assert_eq!(input_b.available_skills(), ["project:current"]);
    assert!(
        input_b
            .prepared_request()
            .prompt
            .contains("Task B current project instructions.")
    );
    assert!(
        !input_b
            .prepared_request()
            .prompt
            .contains("project:arithmetic")
    );
    assert!(
        !input_b
            .prepared_request()
            .prompt
            .contains("CURRENT_UNLOADED_BODY")
    );
    assert!(
        input_b
            .prepared_request()
            .options
            .instructions
            .starts_with("Current B instructions.")
    );
    let b_run = RunId::new();
    assert_ne!(a_run, b_run);
    let saved_b = submit(
        &session,
        &tools_b,
        Script {
            label: "b",
            session_id: "offline-session-b",
            run_id: b_run.clone(),
            input: input_b.clone(),
            expected_replay,
            expected_prefix: prefix,
            inputs: vec![
                vec![InputItem::user(&input_b.prepared_request().prompt)],
                vec![tool_input(SUM_CALL, "{\"sum\":43}")],
            ],
            responses: vec![
                response(
                    "b-add",
                    vec![call(SUM_CALL, "add_numbers", "{\"a\":42,\"b\":1}")],
                    "",
                    false,
                ),
                answer("b-final", "43"),
            ],
            counts: counts.clone(),
        },
    )
    .await?;
    exact(&saved_b.selection, &prepared.selection());
    assert_ne!(
        saved_a.binding.provider_session_id(),
        saved_b.binding.provider_session_id()
    );
    let sum_b = saved_tool(
        &session,
        &b_run,
        SUM_CALL,
        "add_numbers",
        "b-request-1",
        "{\"sum\":43}",
    )
    .await?;
    assert_ne!(sum_a.request_id(), sum_b.request_id());
    assert!(
        session
            .tool_result(b_run.clone(), "load-project".into())
            .await?
            .is_none()
    );
    assert_eq!(counts.snapshot(), [2, 2, 2, 2, 5, 2, 2, 2]);
    assert!(!marker.exists());
    exact(
        &fs::read_to_string(project.join("scripts/inert.sh"))?,
        &inert_script,
    );
    exact(
        &fs::read_to_string(project.join("resources/note.txt"))?,
        RESOURCE,
    );
    let history_b = session.history_page(0, None, 128).await?;
    assert!(!history_b.has_more());
    exact(
        history_a.records(),
        &history_b.records()[..history_a.records().len()],
    );
    store.close().await?;
    drop(tools_b);
    drop(session);
    drop(store);
    assert_eq!(Arc::strong_count(&counts), 1);
    sizes(&root, id.as_str())?;

    let before = counts.snapshot();
    let store = SessionStore::open(root).await?;
    let session = store.open_session(id).await?;
    exact(
        &measured("history_read_after_b", session.history_page(0, None, 128)).await?,
        &history_b,
    );
    exact(&read_task(&session, &a_run).await?, &saved_a);
    exact(&read_task(&session, &b_run).await?, &saved_b);
    exact(
        &session
            .tool_result(a_run.clone(), "load-project".into())
            .await?
            .unwrap(),
        &loaded,
    );
    exact(
        &session.tool_result(a_run, SUM_CALL.into()).await?.unwrap(),
        &sum_a,
    );
    exact(
        &session.tool_result(b_run, SUM_CALL.into()).await?.unwrap(),
        &sum_b,
    );
    let replay = measured(
        "replay_prepare_after_b",
        prepare_session_replay(&session, PROVIDER, MODEL),
    )
    .await?;
    assert_eq!(replay.included_run_count(), 2);
    assert_eq!(replay.included_exchange_count(), 5);
    assert!(replay.excluded_runs().is_empty());
    exact(
        &replay.replay().runs()[0].exchanges()[2].response().text,
        "42",
    );
    exact(
        &replay.replay().runs()[1].exchanges()[1].response().text,
        "43",
    );
    assert_eq!(
        session.manifest().await?.head_sequence(),
        history_b.through_sequence()
    );
    store.close().await?;
    assert_eq!(counts.snapshot(), before);
    println!(
        "local_sample history_records={} replay_runs=2 replay_exchanges=5 replay_json_bytes={}",
        history_b.records().len(),
        serde_json::to_vec(&replay.replay())?.len()
    );
    println!(
        "Completed offline: 2 runs, 2 provider sessions, 5 requests, 1 load_skill and 2 add_numbers dispatches; reopen/read work=0."
    );
    println!(
        "local_sample example_end_to_end_ms={:.3}",
        start.elapsed().as_secs_f64() * 1000.0
    );
    Ok(())
}
