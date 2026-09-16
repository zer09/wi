// Actual public B1 composition, synthetic context and SQLite. No credentials or network.
use async_trait::async_trait;
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
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;
use wi::{
    context::{ContextRoots, discover, prepare_run},
    execution::{PersistentRunRequest, PersistentRunResult, run_persisted},
    run::{RunEvent, RunOutcome, RunRequest},
    storage::{
        CommitReceipt, CreateSession, HistoryPage, OperationId, RecordedRunInput, RecordedRunState,
        RunId, SessionHandle, SessionStore, StoredEventPayload,
    },
    tools::{AddNumbers, Tool, ToolExecutionEvent, ToolRegistry},
    *,
};

type ExampleResult<T> = std::result::Result<T, Box<dyn Error>>;
const PROVIDER: &str = "persisted-offline-script";
const PROVIDER_SESSION: &str = "provider-session";
const CALL: &str = "addition";
const OUTPUT: &str = "{\"sum\":42}";
const HEAD: u64 = 16;

#[derive(Default)]
struct Counts {
    constructed: AtomicUsize,
    opens: AtomicUsize,
    requests: AtomicUsize,
    effects: AtomicUsize,
    closes: AtomicUsize,
}
impl Counts {
    fn snapshot(&self) -> [usize; 5] {
        [
            &self.constructed,
            &self.opens,
            &self.requests,
            &self.effects,
            &self.closes,
        ]
        .map(|counter| counter.load(Ordering::SeqCst))
    }
}
#[derive(Default)]
struct Barrier {
    reached: Notify,
    release: Notify,
}
struct Script {
    session: SessionHandle,
    input: RecordedRunInput,
    counts: Arc<Counts>,
    partial: Barrier,
    continuation: Barrier,
    emitted: Mutex<Vec<EventEnvelope>>,
    samples: Mutex<Vec<(&'static str, f64)>>,
}
impl Script {
    fn event(&self, sequence: u64, request: &str, event: ProviderEvent) -> EventEnvelope {
        let event = EventEnvelope {
            schema_version: 1,
            sequence,
            event_id: format!("provider-event-{sequence}"),
            session_id: PROVIDER_SESSION.into(),
            request_id: Some(request.into()),
            provider: PROVIDER.into(),
            provider_sequence: Some(100 + sequence),
            event,
        };
        self.emitted.lock().unwrap().push(event.clone());
        event
    }
    fn sample(&self, label: &'static str, start: Instant) {
        self.samples
            .lock()
            .unwrap()
            .push((label, start.elapsed().as_secs_f64() * 1000.0));
    }
}
struct CountedAdd {
    session: SessionHandle,
    counts: Arc<Counts>,
}
#[async_trait]
impl Tool for CountedAdd {
    fn definition(&self) -> ToolDefinition {
        AddNumbers.definition()
    }
    fn validate(&self, arguments: &Value) -> Result<()> {
        AddNumbers.validate(arguments)
    }
    async fn execute(&self, arguments: Value) -> Result<Value> {
        // Inspect committed dispatch intent before counting the real effect, not the start event.
        let history = self.session.history_page(0, None, 32).await.unwrap();
        assert_eq!(history.through_sequence(), 8);
        assert!(
            matches!(history.records()[6].payload(), StoredEventPayload::RuntimeObserved(event)
            if matches!(&event.event, RunEvent::ProviderEvent { event }
                if matches!(event.event, ProviderEvent::ResponseFinished { .. })))
        );
        assert!(
            matches!(history.records()[7].payload(), StoredEventPayload::RuntimeObserved(event)
            if matches!(&event.event, RunEvent::ToolEvent { event: ToolExecutionEvent::ToolExecutionStarted { call_id, .. } } if call_id == CALL))
        );
        assert_eq!(self.counts.effects.fetch_add(1, Ordering::SeqCst), 0);
        AddNumbers.execute(arguments).await
    }
}
struct Control {
    script: Arc<Script>,
    sender: mpsc::UnboundedSender<usize>,
}
#[async_trait]
impl SessionControl for Control {
    async fn generate(&self, input: Vec<InputItem>) -> Result<RequestReceipt> {
        let turn = self.script.counts.requests.load(Ordering::SeqCst) + 1;
        if turn == 2 {
            // Let the independent reader verify committed bytes before admitting continuation.
            self.script.continuation.reached.notify_one();
            self.script.continuation.release.notified().await;
        }
        let expected = match turn {
            1 => json!([{"kind":"user", "text":self.script.input.prepared_request().prompt}]),
            2 => json!([{"kind":"tool_result", "call_id":CALL, "output":OUTPUT}]),
            _ => panic!("unexpected request or retry"),
        };
        assert_eq!(serde_json::to_value(input).unwrap(), expected);
        assert_eq!(
            self.script.counts.requests.fetch_add(1, Ordering::SeqCst),
            turn - 1
        );
        self.sender.send(turn).unwrap();
        Ok(RequestReceipt {
            request_id: format!("request-{turn}"),
        })
    }
    fn close(&self) {
        self.script.counts.closes.fetch_add(1, Ordering::SeqCst);
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
            verification: "finite in-process script only".into(),
        };
        ProviderCapabilities {
            websocket: yes.clone(),
            sse: yes.clone(),
            continuation: yes.clone(),
            function_tools: yes,
            advanced: vec![],
        }
    }
    async fn open_session(&self, options: SessionOptions) -> Result<ProviderSession> {
        // The real acceptance and RunStarted must already be committed before provider opening.
        let history = self.0.session.history_page(0, None, 32).await.unwrap();
        assert_eq!(history.through_sequence(), 3);
        assert!(
            matches!(history.records()[1].payload(), StoredEventPayload::RunAccepted(accepted)
            if serde_json::to_value(accepted.input()).unwrap() == serde_json::to_value(&self.0.input).unwrap())
        );
        assert!(
            matches!(history.records()[2].payload(), StoredEventPayload::RuntimeObserved(event)
            if matches!(event.event, RunEvent::RunStarted))
        );
        let mut expected = self.0.input.prepared_request().options.clone();
        expected.tools = self.0.input.tool_definitions().to_vec();
        assert_eq!(
            serde_json::to_value(options).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        assert_eq!(self.0.counts.opens.fetch_add(1, Ordering::SeqCst), 0);
        let script = self.0.clone();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        Ok(ProviderSession {
            id: PROVIDER_SESSION.into(),
            control: Arc::new(Control {
                script: script.clone(),
                sender,
            }),
            events: Box::pin(async_stream::stream! {
                assert_eq!(receiver.recv().await, Some(1));
                for (sequence, delta, label) in [(1, "Adding ", "partial_1_ack"), (2, "17 and 25.", "partial_2_ack")] {
                    let event = script.event(sequence, "request-1", ProviderEvent::OutputItemUpdated {
                        response_id: "response-1".into(), item_id: "partial-message".into(),
                        output_index: 0, content_index: Some(0), summary_index: None,
                        kind: DeltaKind::Text, delta: delta.into(),
                    });
                    let start = Instant::now();
                    yield event;
                    // The next poll follows the awaited recording acknowledgment for this delta.
                    script.sample(label, start);
                }
                script.partial.reached.notify_one();
                script.partial.release.notified().await;
                let start = Instant::now();
                yield script.event(3, "request-1", ProviderEvent::ResponseFinished { response: response(true) });
                assert_eq!(receiver.recv().await, Some(2));
                // A terminal yield resumes only after tools and the next request, not just its commit.
                // This includes the independent reads at the pre-admission generate barrier.
                script.sample("tool_cycle_to_continuation", start);
                yield script.event(4, "request-2", ProviderEvent::ResponseFinished { response: response(false) });
            }),
        })
    }
}
fn response(tool: bool) -> ModelResponse {
    let (id, output, text) = if tool {
        (
            "response-1",
            vec![OutputItem {
                id: Some("call-item".into()),
                kind: ItemKind::FunctionCall,
                native_type: "script-add".into(),
                function_call: Some(FunctionCall {
                    call_id: CALL.into(),
                    name: "add_numbers".into(),
                    arguments: "{\"a\":17,\"b\":25}".into(),
                    origin: CallOrigin::Direct,
                    namespace: None,
                    complete: true,
                }),
                native: json!({"operands":[17,25]}),
            }],
            "",
        )
    } else {
        (
            "response-2",
            vec![OutputItem {
                id: Some("final-message".into()),
                kind: ItemKind::Message,
                native_type: "script-message".into(),
                function_call: None,
                native: json!({"answer":"42"}),
            }],
            "42",
        )
    };
    ModelResponse {
        id: id.into(),
        model: Some("offline-model".into()),
        outcome: ResponseOutcome::Completed,
        output,
        text: text.into(),
        usage: None,
        native: json!({"script_response":id}),
        output_provenance: OutputProvenance::NativeTerminal,
    }
}

pub struct Fixture {
    temp: tempfile::TempDir,
    roots: ContextRoots,
    pub store: SessionStore,
    session: SessionHandle,
    operation: OperationId,
    run: RunId,
    input: RecordedRunInput,
    tools: Arc<ToolRegistry>,
    gateway: Arc<Gateway>,
    script: Arc<Script>,
}
pub async fn fixture() -> ExampleResult<Fixture> {
    let temp = tempfile::tempdir()?;
    let roots = ContextRoots {
        workspace: temp.path().join("workspace"),
        global_skills: temp.path().join("global"),
    };
    fs::create_dir_all(roots.workspace.join(".agents/skills/arithmetic"))?;
    fs::create_dir_all(&roots.global_skills)?;
    fs::write(roots.workspace.join("AGENTS.md"), "Use exact arithmetic.\n")?;
    fs::write(
        roots.workspace.join(".agents/skills/arithmetic/SKILL.md"),
        "---\nname: arithmetic\ndescription: Synthetic arithmetic\n---\nUse add_numbers for the sum.\n",
    )?;
    let store = SessionStore::open(temp.path().join("data")).await?;
    let created = store
        .create_session(CreateSession::new(
            OperationId::new(),
            "Offline persisted arithmetic".into(),
            None,
        )?)
        .await?;
    let session = store.open_session(created.session_id().clone()).await?;
    let counts = Arc::new(Counts::default());
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(CountedAdd {
        session: session.clone(),
        counts: counts.clone(),
    }))?;
    let catalog = discover(roots.clone())?;
    assert!(catalog.diagnostics().is_empty());
    let task = "Add 17 and 25.\n";
    let prepared = prepare_run(
        RunRequest {
            provider_id: PROVIDER.into(),
            options: SessionOptions::new("offline-model"),
            prompt: task.into(),
        },
        &catalog,
        &["project:arithmetic".parse()?],
        &tools,
    )?;
    let input = RecordedRunInput::capture(task.into(), &prepared, &tools)?;
    assert_eq!(input.user_text(), task);
    assert_eq!(input.active_skills(), ["project:arithmetic"]);
    assert_eq!(input.available_skills(), ["project:arithmetic"]);
    assert_eq!(
        input.project_instructions_source(),
        Some("project:AGENTS.md")
    );
    assert_eq!(
        serde_json::to_value(input.prepared_request())?,
        serde_json::to_value(prepared.request())?
    );
    let script = Arc::new(Script {
        session: session.clone(),
        input: input.clone(),
        counts,
        partial: Barrier::default(),
        continuation: Barrier::default(),
        emitted: Mutex::new(vec![]),
        samples: Mutex::new(vec![]),
    });
    let mut gateway = Gateway::new();
    script.counts.constructed.fetch_add(1, Ordering::SeqCst);
    gateway.register(Arc::new(OfflineProvider(script.clone())))?;
    Ok(Fixture {
        temp,
        roots,
        store,
        session,
        operation: "11111111-1111-4111-8111-111111111111".parse()?,
        run: "22222222-2222-4222-8222-222222222222".parse()?,
        input,
        tools: Arc::new(tools),
        gateway: Arc::new(gateway),
        script,
    })
}
async fn measured<T, E>(
    label: &str,
    future: impl Future<Output = std::result::Result<T, E>>,
) -> std::result::Result<T, E> {
    let start = Instant::now();
    let value = future.await?;
    println!(
        "local_sample {label}_ms={:.3}",
        start.elapsed().as_secs_f64() * 1000.0
    );
    Ok(value)
}
fn exact(actual: &(impl serde::Serialize + ?Sized), expected: &(impl serde::Serialize + ?Sized)) {
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
}
fn prefix(prefix: &HistoryPage, history: &HistoryPage) {
    exact(
        &prefix.records(),
        &history.records()[..prefix.records().len()],
    );
}
pub struct Saved {
    history: HistoryPage,
    run: wi::storage::RecordedRun,
    tool: wi::storage::RecordedToolResult,
    manifest: wi::storage::SessionManifest,
    acceptance: CommitReceipt,
    final_receipt: CommitReceipt,
}

// This exact window is also run by storage::measurement_tests using private test-only counters.
pub async fn record_trace(f: &Fixture) -> ExampleResult<Saved> {
    let start = Instant::now();
    let gateway = f.gateway.clone();
    let tools = f.tools.clone();
    let session = f.session.clone();
    let request = PersistentRunRequest {
        operation_id: f.operation.clone(),
        run_id: f.run.clone(),
        input: f.input.clone(),
    };
    // Retain and await the task. A history reader is not the execution owner.
    let task = tokio::spawn(async move {
        run_persisted(
            &gateway,
            &session,
            request,
            &tools,
            CancellationToken::new(),
        )
        .await
    });
    f.script.partial.reached.notified().await;
    let partial = measured("partial_read", f.session.history_page(0, None, 32)).await?;
    assert_eq!(partial.through_sequence(), 6);
    assert!(!partial.has_more());
    for (record, expected_delta) in partial.records()[4..].iter().zip(["Adding ", "17 and 25."]) {
        assert!(
            matches!(record.payload(), StoredEventPayload::RuntimeObserved(event)
            if matches!(&event.event, RunEvent::ProviderEvent { event }
                if matches!(&event.event, ProviderEvent::OutputItemUpdated { delta, .. } if delta == expected_delta)))
        );
    }
    let acceptance = f
        .session
        .lookup_receipt(f.operation.clone())
        .await?
        .unwrap();
    assert_eq!(acceptance.first_sequence(), 2);
    assert_eq!(acceptance.last_sequence(), 2);
    assert_eq!(acceptance.run_id(), Some(&f.run));
    assert!(!task.is_finished());
    assert_eq!(f.script.counts.snapshot(), [1, 1, 1, 0, 0]);
    println!(
        "local_sample acceptance_to_partial_visible_ms={:.3} (starts before receipt lookup/acceptance)",
        start.elapsed().as_secs_f64() * 1000.0
    );
    f.script.partial.release.notify_one();

    f.script.continuation.reached.notified().await;
    let continuation = measured("continuation_read", f.session.history_page(0, None, 32)).await?;
    assert_eq!(continuation.through_sequence(), 12);
    assert_eq!(continuation.records().len(), 12);
    assert!(!continuation.has_more());
    for (index, record) in continuation.records().iter().enumerate() {
        assert_eq!(record.sequence(), index as u64 + 1);
    }
    prefix(&partial, &continuation);
    let tool = measured(
        "tool_projection_read",
        f.session.tool_result(f.run.clone(), CALL.into()),
    )
    .await?
    .unwrap();
    assert_eq!(tool.run_id(), &f.run);
    assert_eq!(tool.call_id(), CALL);
    assert_eq!(tool.tool_name(), "add_numbers");
    assert_eq!(tool.request_id(), Some("request-1"));
    assert_eq!(tool.started_sequence(), 8);
    assert_eq!(tool.result_sequence(), Some(9));
    assert_eq!(tool.finished_sequence(), Some(10));
    assert_eq!(tool.is_error(), Some(false));
    assert_eq!(tool.output().unwrap().as_bytes(), OUTPUT.as_bytes());
    assert!(
        matches!(continuation.records()[8].payload(), StoredEventPayload::ToolResultRecorded(result)
        if result.request_id() == Some("request-1") && result.call_id() == CALL && !result.is_error() && result.output().as_bytes() == OUTPUT.as_bytes())
    );
    assert!(!task.is_finished());
    assert_eq!(f.script.counts.snapshot(), [1, 1, 1, 1, 0]);
    let final_start = Instant::now();
    f.script.continuation.release.notify_one();
    let PersistentRunResult::Executed {
        acceptance: committed,
        final_record,
        result,
    } = task.await??
    else {
        return Err("new operation unexpectedly duplicated".into());
    };
    println!(
        "local_sample final_release_to_recorded_result_ms={:.3}",
        final_start.elapsed().as_secs_f64() * 1000.0
    );
    println!(
        "local_sample execution_end_to_end_ms={:.3} (includes barrier reads)",
        start.elapsed().as_secs_f64() * 1000.0
    );
    assert!(!committed.duplicate() && !final_record.duplicate());
    assert!(committed.cleanup_warning().is_none() && final_record.cleanup_warning().is_none());
    exact(committed.receipt(), &acceptance);
    assert_eq!(final_record.receipt().first_sequence(), HEAD);
    assert_eq!(final_record.receipt().last_sequence(), HEAD);
    assert_eq!(result.run_id, f.run.as_str());
    assert_eq!(result.session_id.as_deref(), Some(PROVIDER_SESSION));
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(result.events_complete && result.sink_error.is_none());
    exact(result.last_response.as_ref().unwrap(), &response(false));
    assert_eq!(result.summary.model_requests_attempted, 2);
    assert_eq!(result.summary.model_requests_admitted, 2);
    assert_eq!(result.summary.new_tool_dispatches, 1);
    assert_eq!(result.summary.tool_results_prepared, 1);
    assert_eq!(result.summary.reused_results, 0);
    assert_eq!(f.script.counts.snapshot(), [1, 1, 2, 1, 1]);

    let history = measured("final_history_read", f.session.history_page(0, None, 32)).await?;
    assert_eq!(history.through_sequence(), HEAD);
    assert_eq!(history.records().len(), HEAD as usize);
    assert!(!history.has_more());
    prefix(&continuation, &history);
    let mut runtime = 0;
    let mut providers = Vec::new();
    for (index, record) in history.records().iter().enumerate() {
        assert_eq!(record.sequence(), index as u64 + 1);
        assert_eq!(record.application_session_id(), f.session.session_id());
        if index > 0 {
            assert_eq!(record.run_id(), Some(&f.run));
        }
        if let StoredEventPayload::RuntimeObserved(event) = record.payload() {
            runtime += 1;
            assert_eq!(event.sequence, runtime);
            assert_eq!(event.schema_version, 2);
            assert_eq!(event.run_id, f.run.as_str());
            if runtime > 1 {
                assert_eq!(event.session_id.as_deref(), Some(PROVIDER_SESSION));
            }
            if let RunEvent::ProviderEvent { event: provider } = &event.event {
                assert_eq!(event.request_id, provider.request_id);
                providers.push(provider.as_ref().clone());
            }
        }
    }
    assert_eq!(runtime, 12);
    exact(&providers, &*f.script.emitted.lock().unwrap());
    assert_eq!(providers.len(), 4);
    let run = f.session.run_record(f.run.clone()).await?.unwrap();
    exact(run.input(), &f.input);
    exact(run.result().unwrap(), result.as_ref());
    assert_eq!(run.state(), RecordedRunState::Completed);
    assert_eq!(run.accepted_sequence(), 2);
    assert_eq!(run.last_runtime_sequence(), 12);
    assert_eq!(run.provider_session_id(), Some(PROVIDER_SESSION));
    assert_eq!(run.terminal_sequence(), Some(15));
    assert_eq!(run.result_sequence(), Some(HEAD));
    assert!(
        matches!(history.records()[15].payload(), StoredEventPayload::RunResultRecorded(saved) if serde_json::to_value(saved)? == serde_json::to_value(result.as_ref())?)
    );
    let manifest = f.session.manifest().await?;
    assert_eq!(manifest.head_sequence(), HEAD);
    exact(
        &f.session
            .lookup_receipt(f.operation.clone())
            .await?
            .unwrap(),
        &acceptance,
    );
    let final_receipt = final_record.receipt().clone();
    exact(
        &f.session
            .lookup_receipt(final_receipt.operation_id().clone())
            .await?
            .unwrap(),
        &final_receipt,
    );
    measured("refresh_catalog", f.session.refresh_catalog()).await?;
    let listed = f.store.list_sessions(None, 10).await?;
    assert_eq!(listed.sessions().len(), 1);
    exact(listed.sessions()[0].observed_manifest(), &manifest);
    assert_eq!(listed.sessions()[0].last_run_id(), Some(&f.run));
    assert_eq!(
        listed.sessions()[0].last_run_state(),
        Some(RecordedRunState::Completed)
    );
    for (label, ms) in f.script.samples.lock().unwrap().iter() {
        println!("local_sample {label}_ms={ms:.3}");
    }
    println!(
        "local_sample recording_window_ms={:.3} (after setup through refresh/list; includes all reads)",
        start.elapsed().as_secs_f64() * 1000.0
    );
    Ok(Saved {
        history,
        run,
        tool,
        manifest,
        acceptance,
        final_receipt,
    })
}
fn sizes(root: &Path, id: &str) -> ExampleResult<()> {
    let session = root
        .join("sessions")
        .join(&id[..2])
        .join(id)
        .join("session.sqlite3");
    for (name, path) in [
        ("catalog", root.join("catalog.sqlite3")),
        ("session", session),
    ] {
        println!(
            "stored_after_close {name}_bytes={}",
            fs::metadata(&path)?.len()
        );
        let wal = path.with_file_name(format!("{name}.sqlite3-wal"));
        match fs::metadata(wal) {
            Ok(metadata) => println!("stored_after_close {name}_wal_bytes={}", metadata.len()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                println!("stored_after_close {name}_wal=absent (transient bytes not measured)")
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
pub async fn reopen(f: Fixture, saved: Saved) -> ExampleResult<()> {
    let root = f.temp.path().join("data");
    let id = f.session.session_id().clone();
    let counts = f.script.counts.clone();
    let before = counts.snapshot();
    measured("close", f.store.close()).await?;
    sizes(&root, id.as_str())?;
    // Remove only this fixture's context. No provider, registry or prepared-context owner survives.
    fs::remove_dir_all(&f.roots.workspace)?;
    fs::remove_dir_all(&f.roots.global_skills)?;
    drop(f.gateway);
    drop(f.tools);
    drop(f.script);
    drop(f.input);
    drop(f.session);
    drop(f.store);
    assert_eq!(Arc::strong_count(&counts), 1);
    let store = measured("reopen_store", SessionStore::open(root)).await?;
    let session = measured("reopen_session", store.open_session(id)).await?;
    exact(&session.history_page(0, None, 32).await?, &saved.history);
    exact(
        &session.run_record(f.run.clone()).await?.unwrap(),
        &saved.run,
    );
    exact(
        &session.tool_result(f.run, CALL.into()).await?.unwrap(),
        &saved.tool,
    );
    exact(&session.manifest().await?, &saved.manifest);
    exact(
        &session.lookup_receipt(f.operation).await?.unwrap(),
        &saved.acceptance,
    );
    exact(
        &session
            .lookup_receipt(saved.final_receipt.operation_id().clone())
            .await?
            .unwrap(),
        &saved.final_receipt,
    );
    store.close().await?;
    assert_eq!(counts.snapshot(), before);
    println!(
        "Completed: 42; 16 stored records; 1 provider open, 2 requests, 1 AddNumbers execution, 0 retries; reopen exact with 0 new provider constructions/opens/requests/tool executions."
    );
    Ok(())
}
#[tokio::main]
async fn main() -> ExampleResult<()> {
    println!(
        "Finite local samples, not benchmarks/SLA; delta acknowledgment includes scheduling and operation-scoped open/validation/commit/close. No separate SQL-only latency is exposed."
    );
    let start = Instant::now();
    let f = fixture().await?;
    let saved = record_trace(&f).await?;
    reopen(f, saved).await?;
    println!(
        "local_sample example_end_to_end_ms={:.3} (setup, trace, close/reopen checks)",
        start.elapsed().as_secs_f64() * 1000.0
    );
    Ok(())
}
