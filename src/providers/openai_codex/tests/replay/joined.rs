//! B2MR-01/02: canonical SQLite history reaches the real adapter through run_in_session.
use super::*;
use crate::{
    Gateway, ToolDefinition,
    execution::{
        PersistentRunRequest, PersistentRunResult, prepare_session_replay, run_in_session,
    },
    run::{RunEvent, RunOutcome, RunRequest, RunResult},
    storage::{
        CreateSession, OperationId, RecordedRunInput, RecordedRunState, RunId, SessionHandle,
        SessionStore, StoredEvent, StoredEventPayload, StoredHistorySelection,
    },
    tools::Tool,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

#[path = "joined_gates.rs"]
mod gates;
#[path = "joined_host.rs"]
mod host;

const MODEL: &str = "requested-alias";
const PROMPT_A: &str = "Add 17 and 25. Keep the result for the next task. 雪\r\n";
const PROMPT_B: &str = "Add 8 to the previous task's result. 雪\r\n";
const PROMPT_OTHER: &str = "An isolated conversation, without the arithmetic history.";

#[derive(Default)]
struct Work {
    connections: AtomicUsize,
    requests: AtomicUsize,
    validations: AtomicUsize,
    effects: AtomicUsize,
}
impl Work {
    fn snapshot(&self) -> [usize; 4] {
        [
            self.connections.load(Ordering::SeqCst),
            self.requests.load(Ordering::SeqCst),
            self.validations.load(Ordering::SeqCst),
            self.effects.load(Ordering::SeqCst),
        ]
    }
}

struct CountedAdd(Arc<Work>);
#[async_trait]
impl Tool for CountedAdd {
    fn definition(&self) -> ToolDefinition {
        crate::tools::add_numbers_definition()
    }
    fn validate(&self, arguments: &Value) -> Result<()> {
        self.0.validations.fetch_add(1, Ordering::SeqCst);
        AddNumbers.validate(arguments)
    }
    async fn execute(&self, arguments: Value) -> Result<Value> {
        self.0.effects.fetch_add(1, Ordering::SeqCst);
        AddNumbers.execute(arguments).await
    }
}

fn value(value: &(impl serde::Serialize + ?Sized)) -> Value {
    serde_json::to_value(value).unwrap()
}

fn final_items(text: &str) -> Vec<Value> {
    let mut output = old_final_items();
    output.push(
        json!({"type":"message","id":"final-message","role":"assistant",
        "status":"completed","content":[{"type":"output_text","text":text}]}),
    );
    output
}

async fn history(session: &SessionHandle) -> Vec<StoredEvent> {
    let mut page = session.history_page(0, None, 7).await.unwrap();
    let head = page.through_sequence();
    let mut records = Vec::new();
    loop {
        records.extend_from_slice(page.records());
        if !page.has_more() {
            break;
        }
        page = session
            .history_page(page.next_after(), Some(head), 7)
            .await
            .unwrap();
    }
    assert_eq!(records.len() as u64, head);
    for (index, record) in records.iter().enumerate() {
        assert_eq!(record.sequence(), index as u64 + 1);
        assert_eq!(record.application_session_id(), session.session_id());
    }
    records
}

async fn create_session(store: &SessionStore) -> SessionHandle {
    let created = store
        .create_session(
            CreateSession::new(OperationId::new(), "synthetic joined replay".into(), None).unwrap(),
        )
        .await
        .unwrap();
    store
        .open_session(created.session_id().clone())
        .await
        .unwrap()
}

#[derive(Clone)]
struct Task {
    session: SessionHandle,
    request: Arc<PersistentRunRequest>,
    selection: StoredHistorySelection,
    // This is a wire oracle only. It is never given to the gateway or execution API.
    prior: Vec<Value>,
    exchanges: Vec<(&'static str, Vec<Value>)>,
    sum: Option<u64>,
}
impl Task {
    async fn new(
        session: &SessionHandle,
        tools: &ToolRegistry,
        transport: Transport,
        prompt: &str,
        prior: Vec<Value>,
        exchanges: Vec<(&'static str, Vec<Value>)>,
        sum: Option<u64>,
    ) -> Self {
        let mut options = SessionOptions::new(MODEL);
        options.transport = transport;
        options.instructions = format!("Current instructions for {prompt}");
        let input = RecordedRunInput::new(
            format!("Original user text: {prompt}"),
            RunRequest {
                provider_id: PROVIDER_ID.into(),
                options,
                prompt: prompt.into(),
            },
            tools.definitions(),
            vec![],
            vec![],
            None,
        )
        .unwrap();
        let prepared = prepare_session_replay(session, PROVIDER_ID, MODEL)
            .await
            .unwrap();
        assert_eq!(
            prepared.included_run_count(),
            usize::from(!prior.is_empty())
        );
        assert!(prepared.excluded_runs().is_empty());
        Self {
            session: session.clone(),
            request: Arc::new(PersistentRunRequest {
                operation_id: OperationId::new(),
                run_id: RunId::new(),
                input,
            }),
            selection: prepared.selection(),
            prior,
            exchanges,
            sum,
        }
    }

    async fn stored_result(&self, records: &[StoredEvent]) -> Value {
        let saved = self
            .session
            .tool_result(self.request.run_id.clone(), "reused-call-id".into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.run_id(), &self.request.run_id);
        assert_eq!(saved.call_id(), "reused-call-id");
        assert_eq!(saved.tool_name(), "add_numbers");
        let output = format!("{{\"sum\":{}}}", self.sum.unwrap());
        assert_eq!(saved.output(), Some(output.as_str()));
        assert_eq!(saved.is_error(), Some(false));
        let results: Vec<_> = records
            .iter()
            .filter(|record| {
                record.run_id() == Some(&self.request.run_id)
                    && matches!(record.payload(), StoredEventPayload::ToolResultRecorded(_))
            })
            .collect();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].sequence(), saved.result_sequence().unwrap());
        let StoredEventPayload::ToolResultRecorded(actual) = results[0].payload() else {
            unreachable!()
        };
        assert_eq!(actual.output(), output);
        assert_eq!(actual.call_id(), saved.call_id());
        assert_eq!(actual.request_id(), saved.request_id());
        assert!(!actual.is_error());
        let response = records
            .iter()
            .find(|record| {
                record.run_id() == Some(&self.request.run_id)
                    && matches!(record.payload(), StoredEventPayload::RuntimeObserved(envelope)
                        if matches!(&envelope.event, RunEvent::ProviderEvent { event }
                            if matches!(&event.event, ProviderEvent::ResponseFinished { response }
                                if response.id == self.exchanges[0].0)))
            })
            .unwrap();
        let StoredEventPayload::RuntimeObserved(envelope) = response.payload() else {
            unreachable!()
        };
        assert!(saved.request_id().is_some());
        assert_eq!(saved.request_id(), envelope.request_id.as_deref());
        assert!(response.sequence() < saved.started_sequence());
        assert!(saved.started_sequence() < saved.result_sequence().unwrap());
        assert!(saved.result_sequence().unwrap() < saved.finished_sequence().unwrap());
        let continuation = records
            .iter()
            .find(|record| {
                record.run_id() == Some(&self.request.run_id)
                    && record.sequence() > saved.finished_sequence().unwrap()
                    && matches!(record.payload(), StoredEventPayload::RuntimeObserved(envelope)
                    if matches!(envelope.event, RunEvent::TurnStarted { .. }))
            })
            .unwrap();
        assert!(saved.finished_sequence().unwrap() < continuation.sequence());
        json!({"type":"function_call_output","call_id":actual.call_id(),"output":actual.output()})
    }

    async fn observe_request(&self, index: usize, body: &Value, transport: Transport) {
        // The server withholds its reply until separate SQLite reads see these commits.
        let records = history(&self.session).await;
        let run = self
            .session
            .run_record(self.request.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(run.state(), RecordedRunState::Running);
        assert!(run.result().is_none());
        assert_eq!(value(run.input()), value(&self.request.input));
        let selected = self
            .session
            .history_selection(self.request.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(selected, self.selection);
        assert_eq!(selected.policy(), "closed-exchanges-v1");
        assert_eq!(selected.provider_id(), PROVIDER_ID);
        assert_eq!(selected.requested_model(), MODEL);
        assert_eq!(selected.through_sequence() + 1, run.accepted_sequence());
        let receipt = self
            .session
            .lookup_receipt(self.request.operation_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(receipt.first_sequence(), run.accepted_sequence());
        assert_eq!(receipt.last_sequence(), run.accepted_sequence() + 1);
        assert!(
            matches!(records[run.accepted_sequence() as usize - 1].payload(),
            StoredEventPayload::RunAccepted(actual)
                if actual.run_id() == &self.request.run_id && value(actual.input()) == value(&self.request.input))
        );
        assert!(
            matches!(records[run.accepted_sequence() as usize].payload(),
            StoredEventPayload::RunHistorySelected(actual)
                if actual.run_id() == &self.request.run_id && actual.selection() == &selected)
        );
        let binding = self
            .session
            .provider_binding(self.request.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(binding.run_id(), &self.request.run_id);
        assert_eq!(
            binding.provider_session_id(),
            run.provider_session_id().unwrap()
        );
        assert_eq!(binding.requested_model(), MODEL);
        assert_eq!(binding.identity().provider_id(), PROVIDER_ID);
        assert_eq!(binding.identity().format(), replay::FORMAT);
        let bytes = [
            b"wi.openai-codex.account.v1\0".as_slice(),
            ACCOUNT.as_bytes(),
        ]
        .concat();
        let digest: String = ring::digest::digest(&ring::digest::SHA256, &bytes)
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert!(binding.identity().principal_digest() == digest);
        if self.prior.is_empty() {
            assert!(selected.expected_identity().is_none());
        } else {
            assert_eq!(selected.expected_identity(), Some(binding.identity()));
        }
        let start = run.accepted_sequence() as usize + 1;
        assert!(
            matches!(records[start].payload(), StoredEventPayload::RuntimeObserved(envelope)
            if matches!(envelope.event, RunEvent::RunStarted))
        );
        assert!(
            matches!(records[start + 1].payload(), StoredEventPayload::RunProviderBound(actual)
            if actual == &binding)
        );
        assert!(
            matches!(records[start + 2].payload(), StoredEventPayload::RuntimeObserved(envelope)
            if matches!(envelope.event, RunEvent::TurnStarted { .. }))
        );

        let mut expected = self.prior.clone();
        expected.push(user(&run.input().prepared_request().prompt));
        if index == 0 {
            assert!(
                self.session
                    .tool_result(self.request.run_id.clone(), "reused-call-id".into())
                    .await
                    .unwrap()
                    .is_none()
            );
        } else {
            assert_eq!(index, 1, "unexpected continuation");
            let result = self.stored_result(&records).await;
            if transport == Transport::WebSocket {
                expected.clear();
            } else {
                expected.extend(self.exchanges[0].1.clone());
            }
            expected.push(result);
        }
        assert_eq!(body["input"], json!(expected));
        assert_eq!(body["model"], MODEL);
        assert_eq!(
            body["instructions"],
            run.input().prepared_request().options.instructions
        );
        assert_eq!(body["prompt_cache_key"], binding.provider_session_id());
        assert_eq!(body["store"], false);
        let definition = &self.request.input.tool_definitions()[0];
        assert_eq!(
            body["tools"],
            json!([{"type":"function","name":definition.name,
            "description":definition.description,"parameters":definition.parameters,"strict":definition.strict}])
        );
        if transport == Transport::WebSocket {
            assert_eq!(body["type"], "response.create");
            assert!(body.get("stream").is_none());
        } else {
            assert_eq!(body["stream"], true);
            assert!(body.get("type").is_none());
        }
        if transport == Transport::WebSocket && index == 1 {
            assert_eq!(body["previous_response_id"], self.exchanges[0].0);
        } else {
            assert!(body.get("previous_response_id").is_none());
        }
    }

    async fn completed_context(&self, result: &RunResult, recovered: bool) -> Vec<Value> {
        assert_eq!(result.outcome, RunOutcome::Completed);
        assert!(result.events_complete);
        assert_eq!(result.sink_error, None);
        assert_eq!(result.run_id, self.request.run_id.as_str());
        assert_eq!(
            result.summary.model_requests_attempted,
            self.exchanges.len() as u64
        );
        assert_eq!(
            result.summary.model_requests_admitted,
            self.exchanges.len() as u64
        );
        assert_eq!(
            result.summary.new_tool_dispatches,
            u64::from(self.sum.is_some())
        );
        assert_eq!(result.summary.reused_results, 0);
        let records = history(&self.session).await;
        let run = self
            .session
            .run_record(self.request.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(run.state(), RecordedRunState::Completed);
        assert_eq!(value(run.result().unwrap()), value(result));
        assert_eq!(run.provider_session_id(), result.session_id.as_deref());
        assert!(
            matches!(records.last().unwrap().payload(), StoredEventPayload::RunResultRecorded(saved)
            if value(saved) == value(result))
        );
        assert!(
            matches!(run.terminal().unwrap().payload(), StoredEventPayload::RuntimeObserved(envelope)
            if matches!(&envelope.event, RunEvent::RunFinished { outcome, .. } if outcome == &result.outcome))
        );
        let responses: Vec<_> = records
            .iter()
            .filter_map(|record| {
                if record.run_id() == Some(&self.request.run_id)
                    && let StoredEventPayload::RuntimeObserved(envelope) = record.payload()
                    && let RunEvent::ProviderEvent { event } = &envelope.event
                    && let ProviderEvent::ResponseFinished { response } = &event.event
                {
                    return Some(response);
                }
                None
            })
            .collect();
        assert_eq!(responses.len(), self.exchanges.len());
        let mut context = vec![user(&run.input().prepared_request().prompt)];
        for (index, (response, (id, output))) in responses.iter().zip(&self.exchanges).enumerate() {
            assert_eq!(response.id, *id);
            assert_eq!(
                response.native,
                events(id, output.clone(), recovered).last().unwrap()["response"]
            );
            let provenance = if recovered {
                OutputProvenance::ValidatedOutputItemDone
            } else {
                OutputProvenance::NativeTerminal
            };
            assert_eq!(response.output_provenance, provenance);
            let effective: Vec<_> = response
                .output
                .iter()
                .map(|item| item.native.clone())
                .collect();
            assert_eq!(&effective, output);
            context.extend(effective);
            if index == 0 && self.sum.is_some() {
                context.push(self.stored_result(&records).await);
            }
        }
        assert_eq!(
            value(result.last_response.as_ref().unwrap()),
            value(responses.last().unwrap())
        );
        context
    }
}

struct Loopback {
    gateway: Arc<Gateway>,
    auth: Arc<CountedAuth>,
    tasks: mpsc::Sender<(Task, oneshot::Sender<()>)>,
    stop: oneshot::Sender<()>,
    server: tokio::task::JoinHandle<()>,
}
impl Loopback {
    async fn new(transport: Transport, mime: bool, recovered: bool, work: Arc<Work>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (tasks, mut submitted) = mpsc::channel::<(Task, oneshot::Sender<()>)>(1);
        let (stop, mut stopped) = oneshot::channel();
        let server = tokio::spawn(async move {
            let mut sessions = Vec::new();
            loop {
                let (task, done) = tokio::select! { biased;
                    task = submitted.recv() => task.unwrap(),
                    _ = listener.accept() => panic!("connection without an explicit task"),
                    _ = &mut stopped => break,
                };
                let mut socket = if transport == Transport::WebSocket {
                    let socket = accept_counted(&listener, TOKEN_A, ACCOUNT).await;
                    work.connections.fetch_add(1, Ordering::SeqCst);
                    Some(socket)
                } else {
                    None
                };
                for (index, (id, output)) in task.exchanges.iter().enumerate() {
                    let reply = events(id, output.clone(), recovered);
                    let body;
                    let mut http = None;
                    if let Some(socket) = &mut socket {
                        body = incoming(socket).await;
                    } else {
                        let (mut tcp, peer) = listener.accept().await.unwrap();
                        assert!(peer.ip().is_loopback());
                        work.connections.fetch_add(1, Ordering::SeqCst);
                        body = read_counted_http(&mut tcp, TOKEN_A, ACCOUNT).await;
                        http = Some(tcp);
                    }
                    work.requests.fetch_add(1, Ordering::SeqCst);
                    if index == 0 {
                        let session = body["prompt_cache_key"].as_str().unwrap().to_owned();
                        assert!(!sessions.contains(&session), "old provider session reused");
                        sessions.push(session);
                    }
                    task.observe_request(index, &body, transport).await;
                    if let Some(socket) = &mut socket {
                        for event in reply {
                            send(socket, event).await;
                        }
                    } else {
                        send_events_http(http.as_mut().unwrap(), reply, mime).await;
                    }
                }
                if let Some(socket) = &mut socket {
                    drain_close(socket).await;
                }
                done.send(()).unwrap();
            }
        });
        let auth = Arc::new(CountedAuth::new(TOKEN_A, ACCOUNT));
        let mut gateway = Gateway::new();
        gateway
            .register(Arc::new(OpenAiCodexProvider::loopback(
                auth.clone(),
                transport,
                address,
            )))
            .unwrap();
        Self {
            gateway: Arc::new(gateway),
            auth,
            tasks,
            stop,
            server,
        }
    }

    async fn enqueue(&self, task: &Task) -> oneshot::Receiver<()> {
        let (done, closed) = oneshot::channel();
        self.tasks.send((task.clone(), done)).await.unwrap();
        closed
    }

    async fn execute(&self, task: &Task, tools: &ToolRegistry) -> RunResult {
        let closed = self.enqueue(task).await;
        // Only current input crosses this boundary. Stored replay has no test-side install path.
        let execution = run_in_session(
            &self.gateway,
            &task.session,
            PersistentRunRequest {
                operation_id: task.request.operation_id.clone(),
                run_id: task.request.run_id.clone(),
                input: task.request.input.clone(),
            },
            tools,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        timeout(Duration::from_secs(5), closed)
            .await
            .unwrap()
            .unwrap();
        let PersistentRunResult::Executed {
            acceptance,
            final_record,
            result,
        } = execution
        else {
            panic!("new task was not executed")
        };
        for commit in [&acceptance, &final_record] {
            assert!(!commit.duplicate());
            assert_eq!(commit.cleanup_warning(), None);
            assert_eq!(commit.receipt().run_id(), Some(&task.request.run_id));
        }
        *result
    }

    async fn finish(self) {
        self.stop.send(()).unwrap();
        timeout(Duration::from_secs(5), self.server)
            .await
            .unwrap()
            .unwrap();
    }
}

async fn joined_roundtrip(transport: Transport, mime: bool, recovered: bool) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("store");
    let store = SessionStore::open(root.clone()).await.unwrap();
    let session = create_session(&store).await;
    let session_id = session.session_id().clone();
    let work = Arc::new(Work::default());
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(CountedAdd(work.clone()))).unwrap();
    let fixture = Loopback::new(transport, mime, recovered, work.clone()).await;
    let empty = prepare_session_replay(&session, PROVIDER_ID, MODEL)
        .await
        .unwrap();
    assert!(empty.replay().runs().is_empty());
    assert_eq!(empty.selection().through_sequence(), 1);
    let a = Task::new(
        &session,
        &tools,
        transport,
        PROMPT_A,
        vec![],
        vec![
            ("a-parent", call_items(17, 25)),
            ("a-final", final_items("42 雪\r\n")),
        ],
        Some(42),
    )
    .await;
    fixture.auth.assert_loads(0);
    assert_eq!(work.snapshot(), [0; 4]);
    let result_a = fixture.execute(&a, &tools).await;
    assert_eq!(result_a.last_response.as_ref().unwrap().text, "42 雪\r\n");
    let context_a = a.completed_context(&result_a, recovered).await;
    let history_a = value(&history(&session).await);
    let binding_a = session
        .provider_binding(a.request.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    let before = work.snapshot();
    assert_eq!(
        before,
        [
            if transport == Transport::WebSocket {
                1
            } else {
                2
            },
            2,
            1,
            1
        ]
    );
    let loads_a = if transport == Transport::WebSocket {
        1
    } else {
        3
    };
    fixture.auth.assert_loads(loads_a);

    store.close().await.unwrap();
    drop(a.session);
    drop(session);
    drop(store);
    let store = SessionStore::open(root).await.unwrap();
    let session = store.open_session(session_id).await.unwrap();
    assert_eq!(value(&history(&session).await), history_a);
    let reopened_a = session
        .run_record(a.request.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reopened_a.state(), RecordedRunState::Completed);
    assert_eq!(value(reopened_a.result().unwrap()), value(&result_a));
    let prepared = prepare_session_replay(&session, PROVIDER_ID, MODEL)
        .await
        .unwrap();
    assert_eq!(prepared.included_run_count(), 1);
    assert_eq!(prepared.included_exchange_count(), 2);
    assert_eq!(
        prepared.replay().runs()[0].source_run_id(),
        a.request.run_id.as_str()
    );
    assert_eq!(
        prepared.selection().expected_identity(),
        Some(binding_a.identity())
    );
    assert_eq!(work.snapshot(), before);
    fixture.auth.assert_loads(loads_a);

    let other = create_session(&store).await;
    let c = Task::new(
        &other,
        &tools,
        transport,
        PROMPT_OTHER,
        vec![],
        vec![(
            "other-final",
            final_items("Only the other conversation sees this."),
        )],
        None,
    )
    .await;
    assert_eq!(c.selection.through_sequence(), 1);
    assert_eq!(work.snapshot(), before);
    fixture.auth.assert_loads(loads_a);
    let result_c = fixture.execute(&c, &tools).await;
    c.completed_context(&result_c, recovered).await;
    let before_b = work.snapshot();
    let loads_c = loads_a
        + if transport == Transport::WebSocket {
            1
        } else {
            2
        };
    let b = Task::new(
        &session,
        &tools,
        transport,
        PROMPT_B,
        context_a,
        vec![
            ("b-parent", call_items(42, 8)),
            ("b-final", final_items("50 雪\r\n")),
        ],
        Some(50),
    )
    .await;
    assert_eq!(b.selection, prepared.selection());
    assert_eq!(work.snapshot(), before_b);
    fixture.auth.assert_loads(loads_c);
    let result_b = fixture.execute(&b, &tools).await;
    assert_eq!(result_b.last_response.as_ref().unwrap().text, "50 雪\r\n");
    b.completed_context(&result_b, recovered).await;
    assert_ne!(result_a.session_id, result_b.session_id);
    let after = history(&session).await;
    assert_eq!(
        value(&after[..history_a.as_array().unwrap().len()].to_vec()),
        history_a
    );
    let saved_a = session
        .tool_result(a.request.run_id.clone(), "reused-call-id".into())
        .await
        .unwrap()
        .unwrap();
    let saved_b = session
        .tool_result(b.request.run_id.clone(), "reused-call-id".into())
        .await
        .unwrap()
        .unwrap();
    assert_ne!(saved_a.request_id(), saved_b.request_id());
    assert_eq!(saved_a.output(), Some("{\"sum\":42}"));
    assert_eq!(saved_b.output(), Some("{\"sum\":50}"));
    let restored = prepare_session_replay(&session, PROVIDER_ID, MODEL)
        .await
        .unwrap();
    let run_ids: Vec<_> = restored
        .replay()
        .runs()
        .iter()
        .map(|run| run.source_run_id().to_owned())
        .collect();
    assert_eq!(
        run_ids,
        [a.request.run_id.to_string(), b.request.run_id.to_string()]
    );
    let isolated = prepare_session_replay(&other, PROVIDER_ID, MODEL)
        .await
        .unwrap();
    assert_eq!(isolated.included_run_count(), 1);
    assert_eq!(
        isolated.replay().runs()[0].source_run_id(),
        c.request.run_id.as_str()
    );
    store.close().await.unwrap();
    fixture.auth.assert_loads(loads_c + loads_a);
    assert_eq!(
        work.snapshot(),
        [
            if transport == Transport::WebSocket {
                3
            } else {
                5
            },
            5,
            2,
            2
        ]
    );
    fixture.finish().await;
}

#[tokio::test]
async fn b2mr_01_public_session_websocket_native_and_recovered_history() {
    for recovered in [false, true] {
        joined_roundtrip(Transport::WebSocket, true, recovered).await;
    }
}

#[tokio::test]
async fn b2mr_02_public_session_labelled_sse_native_and_recovered_history() {
    for recovered in [false, true] {
        joined_roundtrip(Transport::Sse, true, recovered).await;
    }
}

#[tokio::test]
async fn b2mr_02_public_session_missing_mime_sse_native_and_recovered_history() {
    for recovered in [false, true] {
        joined_roundtrip(Transport::Sse, false, recovered).await;
    }
}
