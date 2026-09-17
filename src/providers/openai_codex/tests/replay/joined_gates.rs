//! Joined durability and rejection checks use only public execution and stored A history.
use super::*;
use crate::{
    execution::ReplayExclusionDisposition,
    run::{RunEventEnvelope, TurnOutcome},
    storage::test_hooks::{Action, Pause, Point, Record},
};
use sqlx::{ConnectOptions, Connection, SqliteConnection, sqlite::SqliteConnectOptions};

struct StoredA {
    temp: tempfile::TempDir,
    store: SessionStore,
    session: SessionHandle,
    tools: ToolRegistry,
    work: Arc<Work>,
    loopback: Loopback,
    task: Task,
    context: Vec<Value>,
    prefix: Vec<StoredEvent>,
}
impl StoredA {
    async fn new(transport: Transport) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("store")).await.unwrap();
        let session = create_session(&store).await;
        let work = Arc::new(Work::default());
        let mut tools = ToolRegistry::new();
        tools.register(Arc::new(CountedAdd(work.clone()))).unwrap();
        let loopback = Loopback::new(transport, true, false, work.clone()).await;
        let task = Task::new(
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
        let result = loopback.execute(&task, &tools).await;
        let context = task.completed_context(&result, false).await;
        let prefix = history(&session).await;
        Self {
            temp,
            store,
            session,
            tools,
            work,
            loopback,
            task,
            context,
            prefix,
        }
    }

    async fn unchanged(&self) {
        let after = history(&self.session).await;
        assert_eq!(
            value(&after[..self.prefix.len()].to_vec()),
            value(&self.prefix)
        );
        let saved = self
            .session
            .run_record(self.task.request.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.state(), RecordedRunState::Completed);
        let StoredEventPayload::RunResultRecorded(result) = self.prefix.last().unwrap().payload()
        else {
            panic!("A has no actual final result")
        };
        assert_eq!(value(saved.result().unwrap()), value(result));
        self.task.stored_result(&after).await;
    }

    async fn finish(self) {
        self.unchanged().await;
        self.store.close().await.unwrap();
        self.loopback.finish().await;
    }
}

fn pause(task: &Task, record: Record, point: Point) -> Arc<Pause> {
    let pause = Arc::new(Pause::default());
    task.session
        .test_hooks()
        .arm_record(record, point, Action::Pause(pause.clone()));
    pause
}

async fn reader(fixture: &StoredA) -> SqliteConnection {
    let id = fixture.session.session_id().as_str();
    let path = fixture
        .temp
        .path()
        .join("store/sessions")
        .join(&id[..2])
        .join(id)
        .join("session.sqlite3");
    // A public read would wait behind the paused writer. Read committed WAL data independently.
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .busy_timeout(Duration::ZERO)
            .disable_statement_logging(),
    )
    .await
    .unwrap()
}

async fn paused_records(
    reader: &mut SqliteConnection,
    pause: &Pause,
    task: &Task,
    committed: bool,
) -> Vec<(String, String)> {
    let operation = pause.operation_id.lock().unwrap().clone().unwrap();
    let receipts: i64 = sqlx::query_scalar("SELECT count(*) FROM commands WHERE operation_id=?")
        .bind(operation.as_str())
        .fetch_one(&mut *reader)
        .await
        .unwrap();
    assert_eq!(receipts, i64::from(committed));
    sqlx::query_as("SELECT event_type, payload_json FROM events WHERE run_id=? ORDER BY sequence")
        .bind(task.request.run_id.as_str())
        .fetch_all(reader)
        .await
        .unwrap()
}

async fn durability(transport: Transport) {
    let fixture = StoredA::new(transport).await;
    let b = Task::new(
        &fixture.session,
        &fixture.tools,
        transport,
        PROMPT_B,
        fixture.context.clone(),
        vec![
            ("b-parent", call_items(42, 8)),
            ("b-final", final_items("50 雪\r\n")),
        ],
        Some(50),
    )
    .await;
    let before = fixture.work.snapshot();
    let loads = if transport == Transport::WebSocket {
        1
    } else {
        3
    };
    fixture.loopback.auth.assert_loads(loads);
    let mut reader = reader(&fixture).await;
    let acceptance = pause(&b, Record::Acceptance, Point::BeforeCommit);
    let gates = async {
        acceptance.reached.notified().await;
        assert!(
            paused_records(&mut reader, &acceptance, &b, false)
                .await
                .is_empty()
        );
        assert_eq!(fixture.work.snapshot(), before);
        fixture.loopback.auth.assert_loads(loads);

        let binding = pause(&b, Record::ProviderBinding, Point::BeforeCommit);
        acceptance.release.notify_one();
        binding.reached.notified().await;
        let rows = paused_records(&mut reader, &binding, &b, false).await;
        assert_eq!(
            rows.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
            ["run.accepted", "run.history.selected", "runtime.observed"]
        );
        let start: crate::run::RunEventEnvelope = serde_json::from_str(&rows[2].1).unwrap();
        assert!(matches!(start.event, RunEvent::RunStarted));
        fixture.loopback.auth.assert_loads(loads + 1);
        let opened_connections = before[0] + usize::from(transport == Transport::WebSocket);
        // A WS handshake is allowed here, but neither transport may send a model request.
        assert_eq!(fixture.work.snapshot(), [opened_connections, 2, 1, 1]);

        let result = pause(&b, Record::ToolResult, Point::BeforeCommit);
        binding.release.notify_one();
        result.reached.notified().await;
        let rows = paused_records(&mut reader, &result, &b, false).await;
        assert_eq!(
            rows.iter()
                .filter(|row| row.0 == "run.provider.bound")
                .count(),
            1
        );
        assert!(!rows.iter().any(|row| row.0 == "tool.result.recorded"));
        let connections = before[0] + 1;
        assert_eq!(fixture.work.snapshot(), [connections, 3, 2, 2]);
        fixture
            .loopback
            .auth
            .assert_loads(loads + 1 + usize::from(transport == Transport::Sse));

        // Hold the same write after COMMIT too, so durable output is visible before continuation.
        let committed = pause(&b, Record::ToolResult, Point::AfterCommit);
        result.release.notify_one();
        committed.reached.notified().await;
        let rows = paused_records(&mut reader, &committed, &b, true).await;
        assert_eq!(
            result.operation_id.lock().unwrap().as_ref(),
            committed.operation_id.lock().unwrap().as_ref()
        );
        let outputs: Vec<_> = rows
            .iter()
            .filter(|row| row.0 == "tool.result.recorded")
            .collect();
        assert_eq!(outputs.len(), 1);
        let output: Value = serde_json::from_str(&outputs[0].1).unwrap();
        assert_eq!(output["output"], "{\"sum\":50}");
        assert_eq!(output["call_id"], "reused-call-id");
        assert_eq!(output["is_error"], false);
        assert_eq!(fixture.work.snapshot(), [connections, 3, 2, 2]);
        committed.release.notify_one();
    };
    let (result, ()) = timeout(Duration::from_secs(20), async {
        tokio::join!(fixture.loopback.execute(&b, &fixture.tools), gates)
    })
    .await
    .expect("joined commit barriers stalled");
    reader.close().await.unwrap();
    b.completed_context(&result, false).await;
    let connections = if transport == Transport::WebSocket {
        2
    } else {
        4
    };
    assert_eq!(fixture.work.snapshot(), [connections, 4, 2, 2]);
    fixture.loopback.auth.assert_loads(loads * 2);
    fixture.finish().await;
}

#[tokio::test]
async fn b2mr_03_public_session_websocket_awaits_acceptance_binding_and_result_commits() {
    durability(Transport::WebSocket).await;
}

#[tokio::test]
async fn b2mr_03_public_session_sse_awaits_acceptance_binding_and_result_commits() {
    durability(Transport::Sse).await;
}

fn negative_gateway(
    auth: Arc<CountedAuth>,
    transport: Transport,
    address: std::net::SocketAddr,
) -> Gateway {
    let mut adapter = OpenAiCodexProvider::loopback(auth, transport, address);
    // A fallback regression must remain observable on loopback, never reach a live endpoint.
    adapter.websocket_endpoint = format!("ws://{address}/codex/responses");
    adapter.sse_endpoint = format!("http://{address}/codex/responses");
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(adapter)).unwrap();
    gateway
}

async fn failed_execution(
    gateway: &Gateway,
    task: &Task,
    tools: &ToolRegistry,
    code: &str,
) -> (RunResult, Vec<RunEventEnvelope>) {
    let execution = timeout(
        Duration::from_secs(20),
        run_in_session(
            gateway,
            &task.session,
            PersistentRunRequest {
                operation_id: task.request.operation_id.clone(),
                run_id: task.request.run_id.clone(),
                input: task.request.input.clone(),
            },
            tools,
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    let PersistentRunResult::Executed {
        acceptance,
        final_record,
        result,
    } = execution
    else {
        panic!("a rejected new task must record its actual execution")
    };
    for commit in [&acceptance, &final_record] {
        assert!(!commit.duplicate());
        assert_eq!(commit.cleanup_warning(), None);
        assert_eq!(commit.receipt().run_id(), Some(&task.request.run_id));
        assert_eq!(
            task.session
                .lookup_receipt(commit.receipt().operation_id().clone())
                .await
                .unwrap()
                .as_ref(),
            Some(commit.receipt())
        );
    }
    assert_eq!(result.outcome, RunOutcome::Failed { code: code.into() });
    assert_eq!(result.run_id, task.request.run_id.as_str());
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    assert!(result.last_response.is_none());
    assert_eq!(result.summary.new_tool_dispatches, 0);
    assert_eq!(result.summary.tool_results_prepared, 0);
    assert_eq!(result.summary.reused_results, 0);
    let saved = task
        .session
        .run_record(task.request.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.state(), RecordedRunState::Failed);
    assert_eq!(value(saved.result().unwrap()), value(&result));
    assert_eq!(value(saved.input()), value(&task.request.input));
    assert_eq!(saved.provider_session_id(), result.session_id.as_deref());
    assert_eq!(
        task.session
            .history_selection(task.request.run_id.clone())
            .await
            .unwrap(),
        Some(task.selection.clone())
    );
    assert!(
        task.session
            .tool_result(task.request.run_id.clone(), "reused-call-id".into())
            .await
            .unwrap()
            .is_none()
    );
    let records = history(&task.session).await;
    let mut runtime = Vec::new();
    for record in records
        .iter()
        .filter(|record| record.run_id() == Some(&task.request.run_id))
    {
        assert!(!matches!(
            record.payload(),
            StoredEventPayload::ToolResultRecorded(_)
        ));
        if let StoredEventPayload::RuntimeObserved(event) = record.payload() {
            assert_eq!(event.sequence, runtime.len() as u64 + 1);
            assert_eq!(event.run_id, result.run_id);
            assert!(!matches!(event.event, RunEvent::ToolEvent { .. }));
            runtime.push(event.clone());
        }
    }
    assert!(matches!(
        runtime.first().unwrap().event,
        RunEvent::RunStarted
    ));
    assert!(
        matches!(&runtime.last().unwrap().event, RunEvent::RunFinished { outcome, summary }
        if outcome == &result.outcome && value(summary) == value(&result.summary))
    );
    assert!(
        matches!(records.last().unwrap().payload(), StoredEventPayload::RunResultRecorded(actual)
        if value(actual) == value(&result))
    );
    (*result, runtime)
}

async fn identity_guard(transport: Transport) {
    const ACCOUNT_Y: &str = "synthetic-joined-account-y";
    let fixture = StoredA::new(transport).await;
    let b = Task::new(
        &fixture.session,
        &fixture.tools,
        transport,
        "Account Y must not receive A or this failed task.",
        fixture.context.clone(),
        vec![],
        None,
    )
    .await;
    let before = fixture.work.snapshot();
    let loads = if transport == Transport::WebSocket {
        1
    } else {
        3
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let (closed, observed_close) = oneshot::channel();
    let work = fixture.work.clone();
    let server = tokio::spawn(async move {
        if transport == Transport::WebSocket {
            let mut socket = accept_counted(&listener, TOKEN_B, ACCOUNT_Y).await;
            work.connections.fetch_add(1, Ordering::SeqCst);
            // Any text frame fails, including either historical or current prompt bytes.
            drain_close(&mut socket).await;
        }
        closed.send(()).unwrap();
        tokio::select! { biased;
            _ = listener.accept() => panic!("identity rejection retried, fell back, or sent SSE input"),
            _ = stopped => {}
        }
    });
    let auth_y = Arc::new(CountedAuth::new(TOKEN_B, ACCOUNT_Y));
    let gateway = negative_gateway(auth_y.clone(), transport, address);
    let (result, runtime) =
        failed_execution(&gateway, &b, &fixture.tools, "history_identity").await;
    timeout(Duration::from_secs(5), observed_close)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runtime.len(), 2);
    assert_eq!(result.summary.model_requests_attempted, 0);
    assert_eq!(result.summary.model_requests_admitted, 0);
    assert_eq!(result.summary.turns_started, 0);
    assert_eq!(result.summary.turns_finished, 0);
    assert_eq!(result.summary.last_request_id, None);
    assert_eq!(result.summary.last_upstream_outcome, None);
    assert_eq!(
        fixture.work.snapshot(),
        [
            before[0] + usize::from(transport == Transport::WebSocket),
            2,
            1,
            1
        ]
    );
    auth_y.assert_loads(1);
    fixture.loopback.auth.assert_loads(loads);

    let actual = fixture
        .session
        .provider_binding(b.request.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    let expected = b.selection.expected_identity().unwrap();
    assert_ne!(actual.identity(), expected);
    assert_eq!(actual.run_id(), &b.request.run_id);
    assert_eq!(
        Some(actual.provider_session_id()),
        result.session_id.as_deref()
    );
    assert_eq!(actual.requested_model(), MODEL);
    assert_eq!(actual.identity().provider_id(), PROVIDER_ID);
    assert_eq!(actual.identity().format(), replay::FORMAT);
    let bytes = [
        b"wi.openai-codex.account.v1\0".as_slice(),
        ACCOUNT_Y.as_bytes(),
    ]
    .concat();
    let digest: String = ring::digest::digest(&ring::digest::SHA256, &bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert!(actual.identity().principal_digest() == digest);
    let after_b = history(&fixture.session).await;
    let b_rows = &after_b[fixture.prefix.len()..];
    assert_eq!(b_rows.len(), 6);
    assert!(
        matches!(b_rows[3].payload(), StoredEventPayload::RunProviderBound(binding) if binding == &actual)
    );
    let prepared = prepare_session_replay(&fixture.session, PROVIDER_ID, MODEL)
        .await
        .unwrap();
    assert_eq!(prepared.included_run_count(), 1);
    assert_eq!(prepared.included_exchange_count(), 2);
    assert_eq!(
        prepared.replay().runs()[0].source_run_id(),
        fixture.task.request.run_id.as_str()
    );
    assert_eq!(prepared.selection().expected_identity(), Some(expected));
    assert_eq!(prepared.excluded_runs().len(), 1);
    assert_eq!(prepared.excluded_runs()[0].run_id(), b.request.run_id);
    assert_eq!(
        prepared.excluded_runs()[0].disposition(),
        ReplayExclusionDisposition::DefinitelyUnsubmitted
    );

    // This task supplies only new input. The public path must independently exclude B.
    let prompt = "Back under account X, add 8 to A's saved result.";
    let mut request = b.request.input.prepared_request().clone();
    request.prompt = prompt.into();
    request.options.instructions = "Current matching-account instructions".into();
    let c = Task {
        session: fixture.session.clone(),
        request: Arc::new(PersistentRunRequest {
            operation_id: OperationId::new(),
            run_id: RunId::new(),
            input: RecordedRunInput::new(
                prompt.into(),
                request,
                fixture.tools.definitions(),
                vec![],
                vec![],
                None,
            )
            .unwrap(),
        }),
        selection: prepared.selection(),
        prior: fixture.context.clone(),
        exchanges: vec![
            ("c-parent", call_items(42, 8)),
            ("c-final", final_items("50")),
        ],
        sum: Some(50),
    };
    let result_c = fixture.loopback.execute(&c, &fixture.tools).await;
    c.completed_context(&result_c, false).await;
    assert_ne!(result.session_id, result_c.session_id);
    let after_c = history(&fixture.session).await;
    assert_eq!(value(&after_c[..after_b.len()].to_vec()), value(&after_b));
    let prepared = prepare_session_replay(&fixture.session, PROVIDER_ID, MODEL)
        .await
        .unwrap();
    let ids: Vec<_> = prepared
        .replay()
        .runs()
        .iter()
        .map(|run| run.source_run_id().to_owned())
        .collect();
    assert_eq!(
        ids,
        [
            fixture.task.request.run_id.to_string(),
            c.request.run_id.to_string()
        ]
    );
    assert_eq!(prepared.excluded_runs().len(), 1);
    assert_eq!(prepared.excluded_runs()[0].run_id(), b.request.run_id);
    let connections = if transport == Transport::WebSocket {
        3
    } else {
        4
    };
    assert_eq!(fixture.work.snapshot(), [connections, 4, 2, 2]);
    fixture.loopback.auth.assert_loads(loads * 2);
    auth_y.assert_loads(1);
    stop.send(()).unwrap();
    timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    fixture.finish().await;
}

#[tokio::test]
async fn b2mr_04_public_session_websocket_records_actual_mismatch_and_later_matching_task() {
    identity_guard(Transport::WebSocket).await;
}

#[tokio::test]
async fn b2mr_04_public_session_sse_records_actual_mismatch_and_later_matching_task() {
    identity_guard(Transport::Sse).await;
}

async fn sse_failure(
    mime: Option<&'static str>,
    replies: Vec<Value>,
    started: Option<&str>,
    code: &str,
) {
    let fixture = StoredA::new(Transport::Sse).await;
    let b = Task::new(
        &fixture.session,
        &fixture.tools,
        Transport::Sse,
        PROMPT_B,
        fixture.context.clone(),
        vec![],
        None,
    )
    .await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let work = fixture.work.clone();
    let task = b.clone();
    let server = tokio::spawn(async move {
        let (mut tcp, peer) = listener.accept().await.unwrap();
        assert!(peer.ip().is_loopback());
        work.connections.fetch_add(1, Ordering::SeqCst);
        let body = read_counted_http(&mut tcp, TOKEN_A, ACCOUNT).await;
        work.requests.fetch_add(1, Ordering::SeqCst);
        task.observe_request(0, &body, Transport::Sse).await;
        send_events_http_mime(&mut tcp, replies, mime).await;
        tokio::select! { biased;
            _ = listener.accept() => panic!("SSE rejection continued, retried, or fell back"),
            _ = stopped => {}
        }
    });
    let auth = Arc::new(CountedAuth::new(TOKEN_A, ACCOUNT));
    let gateway = negative_gateway(auth.clone(), Transport::Sse, address);
    let (result, runtime) =
        failed_execution(&gateway, &b, &fixture.tools, "provider_request_failed").await;
    assert_eq!(result.summary.model_requests_attempted, 1);
    assert_eq!(result.summary.model_requests_admitted, 1);
    assert_eq!(result.summary.turns_started, 1);
    assert_eq!(result.summary.turns_finished, 1);
    assert_eq!(
        result.summary.last_upstream_outcome,
        Some(UpstreamOutcome::Unknown)
    );
    assert!(result.summary.last_request_id.is_some());
    let provider: Vec<_> = runtime
        .iter()
        .filter_map(|envelope| {
            if let RunEvent::ProviderEvent { event } = &envelope.event {
                assert_eq!(event.schema_version, 1);
                assert_eq!(event.provider, PROVIDER_ID);
                assert_eq!(Some(&event.session_id), result.session_id.as_ref());
                assert_eq!(event.request_id, result.summary.last_request_id);
                assert_eq!(envelope.request_id, event.request_id);
                assert_eq!(envelope.session_id.as_ref(), Some(&event.session_id));
                return Some(event.as_ref());
            }
            None
        })
        .collect();
    assert_eq!(
        provider
            .iter()
            .filter(|event| matches!(event.event, ProviderEvent::RequestFailed { .. }))
            .count(),
        1
    );
    assert!(
        provider
            .windows(2)
            .all(|pair| pair[0].sequence < pair[1].sequence)
    );
    if started.is_none() {
        assert_eq!(provider.len(), 1);
    }
    let starts: Vec<_> = provider
        .iter()
        .filter_map(|event| {
            if let ProviderEvent::ResponseStarted { response_id } = &event.event {
                Some(response_id.as_str())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(starts, started.into_iter().collect::<Vec<_>>());
    assert!(!provider.iter().any(|event| matches!(
        event.event,
        ProviderEvent::ResponseFinished { .. } | ProviderEvent::SessionClosed { .. }
    )));
    let ProviderEvent::RequestFailed {
        code: actual,
        message,
        upstream_outcome,
    } = &provider.last().unwrap().event
    else {
        panic!("missing actual provider failure")
    };
    assert_eq!(actual, code);
    assert_eq!(*upstream_outcome, UpstreamOutcome::Unknown);
    let expected_message = if code == "protocol_error" {
        "invalid provider protocol: empty response identity"
    } else {
        "expected text/event-stream"
    };
    assert_eq!(message, expected_message);
    assert_eq!(
        runtime
            .iter()
            .filter(|event| matches!(event.event, RunEvent::TurnFinished { .. }))
            .count(),
        1
    );
    assert!(runtime.iter().any(|event| matches!(&event.event, RunEvent::TurnFinished {
        response_id, outcome: TurnOutcome::Stopped { reason }, upstream_outcome: Some(UpstreamOutcome::Unknown), ..
    } if response_id.as_deref() == started && reason == &result.outcome)));
    assert_eq!(fixture.work.snapshot(), [3, 3, 1, 1]);
    fixture.loopback.auth.assert_loads(3);
    auth.assert_loads(2);
    stop.send(()).unwrap();
    timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    fixture.finish().await;
}

#[tokio::test]
async fn b2mr_05_public_session_sse_wrong_explicit_mime_preserves_uncertainty() {
    sse_failure(
        Some("application/json"),
        events("b-rejected", call_items(42, 8), false),
        None,
        "unexpected_content_type",
    )
    .await;
}

#[tokio::test]
async fn b2mr_05_public_session_labelled_sse_empty_identity_is_protocol_error() {
    sse_failure(
        Some("text/event-stream"),
        events("", call_items(42, 8), false),
        None,
        "protocol_error",
    )
    .await;
    let mut replies = events("b-rejected", call_items(42, 8), true);
    replies.last_mut().unwrap()["response"]["id"] = json!("");
    sse_failure(
        Some("text/event-stream"),
        replies,
        Some("b-rejected"),
        "protocol_error",
    )
    .await;
}

#[tokio::test]
async fn b2mr_05_public_session_missing_mime_sse_malformed_admission_is_content_type_error() {
    let replies = events("", call_items(42, 8), false);
    for values in [replies.clone(), vec![replies.last().unwrap().clone()]] {
        sse_failure(None, values, None, "unexpected_content_type").await;
    }
}
