//! V1A-21/22/23: the accepted B2 wire oracle, driven by public host dispatch.
use super::*;
use crate::{
    execution::{PersistentRunCause, PersistentRunStage, ReplayExclusionDisposition},
    run::TurnOutcome,
    service::{RunCompletion, RunHost, RunTicket, ShutdownOutcome},
    storage::test_hooks::{Point, Record},
};
use gates::{negative_gateway, observe_failure, pause, paused_records, reader};
use sqlx::Connection;

struct Fixture {
    temp: tempfile::TempDir,
    host: RunHost,
    session: SessionHandle,
    tools: ToolRegistry,
    work: Arc<Work>,
    loopback: Loopback,
}
impl Fixture {
    async fn new(transport: Transport, mime: bool, recovered: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("store")).await.unwrap();
        let work = Arc::new(Work::default());
        let mut tools = ToolRegistry::new();
        tools.register(Arc::new(CountedAdd(work.clone()))).unwrap();
        let loopback = Loopback::new(transport, mime, recovered, work.clone()).await;
        let host = RunHost::new(store, loopback.gateway.clone()).unwrap();
        let session = create_session(host.storage()).await;
        assert_eq!(work.snapshot(), [0; 4]);
        loopback.auth.assert_loads(0);
        Self {
            temp,
            host,
            session,
            tools,
            work,
            loopback,
        }
    }

    async fn task(&self, transport: Transport, prior: Vec<Value>) -> Task {
        let (prompt, exchanges, sum) = if prior.is_empty() {
            (
                PROMPT_A,
                vec![
                    ("a-parent", call_items(17, 25)),
                    ("a-final", final_items("42 雪\r\n")),
                ],
                42,
            )
        } else {
            (
                PROMPT_B,
                vec![
                    ("b-parent", call_items(42, 8)),
                    ("b-final", final_items("50 雪\r\n")),
                ],
                50,
            )
        };
        Task::new(
            &self.session,
            &self.tools,
            transport,
            prompt,
            prior,
            exchanges,
            Some(sum),
        )
        .await
    }

    async fn reopen(&mut self, gateway: Arc<Gateway>) {
        let before = self.work.snapshot();
        closed(&self.host).await;
        let store = SessionStore::open(self.temp.path().join("store"))
            .await
            .unwrap();
        self.host = RunHost::new(store, gateway).unwrap();
        self.session = self
            .host
            .storage()
            .open_session(self.session.session_id().clone())
            .await
            .unwrap();
        history(&self.session).await;
        assert_eq!(self.work.snapshot(), before, "reopen must not start work");
    }

    async fn finish(self) {
        closed(&self.host).await;
        self.loopback.finish().await;
    }
}

async fn watchdog<T>(future: impl std::future::Future<Output = T>) -> T {
    timeout(Duration::from_secs(60), future)
        .await
        .expect("joined host watchdog")
}
async fn closed(host: &RunHost) {
    assert!(matches!(
        &*watchdog(host.begin_shutdown().wait()).await,
        ShutdownOutcome::Closed
    ));
}
fn submit(host: &RunHost, task: &Task, tools: &ToolRegistry) -> RunTicket {
    host.client()
        .submit(
            task.session.session_id().clone(),
            PersistentRunRequest {
                operation_id: task.request.operation_id.clone(),
                run_id: task.request.run_id.clone(),
                input: task.request.input.clone(),
            },
            tools.fresh_scope(),
        )
        .unwrap()
}
fn executed(completion: &RunCompletion) -> &PersistentRunResult {
    let RunCompletion::Execution(Ok(execution)) = completion else {
        panic!("expected concrete execution: {completion:?}")
    };
    execution
}
async fn completed(ticket: &RunTicket) -> RunResult {
    let receipt = watchdog(ticket.accepted()).await.unwrap();
    let completion = watchdog(ticket.completion()).await;
    let PersistentRunResult::Executed {
        acceptance,
        final_record,
        result,
    } = executed(&completion)
    else {
        panic!("new host task was not executed")
    };
    assert_eq!(&receipt, acceptance);
    for commit in [acceptance, final_record] {
        assert!(!commit.duplicate());
        assert!(commit.cleanup_warning().is_none());
        assert_eq!(commit.receipt().run_id(), Some(ticket.run_id()));
    }
    result.as_ref().clone()
}

async fn abandoned_a(fixture: &Fixture, task: &Task) -> RunResult {
    let closed = fixture.loopback.enqueue(task).await;
    let binding = pause(task, Record::ProviderBinding, Point::BeforeCommit);
    let client = fixture.host.client();
    let ticket = client
        .submit(
            task.session.session_id().clone(),
            PersistentRunRequest {
                operation_id: task.request.operation_id.clone(),
                run_id: task.request.run_id.clone(),
                input: task.request.input.clone(),
            },
            fixture.tools.fresh_scope(),
        )
        .unwrap();
    watchdog(binding.reached.notified()).await;
    let receipt = watchdog(ticket.accepted()).await.unwrap();
    assert!(!receipt.duplicate());
    assert_eq!(receipt.receipt().first_sequence(), 2);
    assert_eq!(receipt.receipt().last_sequence(), 3);
    assert!(ticket.completion().now_or_never().is_none());
    assert_eq!(fixture.work.requests.load(Ordering::SeqCst), 0);
    // No ticket, client, or waiter remains when the provider receives A's first payload.
    drop(ticket);
    drop(client);
    binding.release.notify_one();
    let independent = fixture
        .host
        .storage()
        .open_session(task.session.session_id().clone())
        .await
        .unwrap();
    let result = watchdog(async {
        loop {
            let run = independent
                .run_record(task.request.run_id.clone())
                .await
                .unwrap()
                .unwrap();
            if let Some(result) = run.result() {
                break result.clone();
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    watchdog(closed).await.unwrap();
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(result.events_complete && result.sink_error.is_none());
    result
}

async fn roundtrip(transport: Transport, mime: bool, recovered: bool) {
    let fixture = Fixture::new(transport, mime, recovered).await;
    let a = fixture.task(transport, vec![]).await;
    assert_eq!(a.selection.through_sequence(), 1);
    assert!(a.selection.expected_identity().is_none());
    let result_a = abandoned_a(&fixture, &a).await;
    let context = a.completed_context(&result_a, recovered).await;
    let prefix = history(&fixture.session).await;
    let b = fixture.task(transport, context).await;
    let done = fixture.loopback.enqueue(&b).await;
    let result_b = completed(&submit(&fixture.host, &b, &fixture.tools)).await;
    watchdog(done).await.unwrap();
    b.completed_context(&result_b, recovered).await;
    assert_ne!(result_a.session_id, result_b.session_id);
    assert_eq!(
        value(&history(&fixture.session).await[..prefix.len()]),
        value(&prefix)
    );
    let connections = if transport == Transport::WebSocket {
        2
    } else {
        4
    };
    let loads = if transport == Transport::WebSocket {
        2
    } else {
        6
    };
    assert_eq!(fixture.work.snapshot(), [connections, 4, 2, 2]);
    fixture.loopback.auth.assert_loads(loads);
    fixture.finish().await;
}

#[tokio::test]
async fn v1a_21_host_websocket_native_and_recovered_history_after_ticket_drop() {
    for recovered in [false, true] {
        roundtrip(Transport::WebSocket, true, recovered).await;
    }
}
#[tokio::test]
async fn v1a_22_host_labelled_sse_native_and_recovered_history_after_ticket_drop() {
    for recovered in [false, true] {
        roundtrip(Transport::Sse, true, recovered).await;
    }
}
#[tokio::test]
async fn v1a_22_host_missing_mime_sse_native_and_recovered_history_after_ticket_drop() {
    for recovered in [false, true] {
        roundtrip(Transport::Sse, false, recovered).await;
    }
}

async fn durability(transport: Transport) {
    let fixture = Fixture::new(transport, true, false).await;
    let a = fixture.task(transport, vec![]).await;
    let result_a = abandoned_a(&fixture, &a).await;
    let context = a.completed_context(&result_a, false).await;
    let b = fixture.task(transport, context).await;
    let before = fixture.work.snapshot();
    let loads = if transport == Transport::WebSocket {
        1
    } else {
        3
    };
    let mut sql = reader(&fixture.temp.path().join("store"), &fixture.session).await;
    let accepted = pause(&b, Record::Acceptance, Point::BeforeCommit);
    let done = fixture.loopback.enqueue(&b).await;
    let ticket = submit(&fixture.host, &b, &fixture.tools);
    watchdog(async {
        accepted.reached.notified().await;
        assert!(ticket.accepted().now_or_never().is_none());
        assert!(
            paused_records(&mut sql, &accepted, &b, false)
                .await
                .is_empty()
        );
        assert_eq!(fixture.work.snapshot(), before);
        fixture.loopback.auth.assert_loads(loads);
        let binding = pause(&b, Record::ProviderBinding, Point::BeforeCommit);
        accepted.release.notify_one();
        binding.reached.notified().await;
        let receipt = ticket.accepted().await.unwrap();
        assert_eq!(
            receipt.receipt().first_sequence(),
            b.selection.through_sequence() + 1
        );
        assert_eq!(
            receipt.receipt().last_sequence(),
            b.selection.through_sequence() + 2
        );
        assert!(ticket.completion().now_or_never().is_none());
        let rows = paused_records(&mut sql, &binding, &b, false).await;
        assert_eq!(
            rows.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
            ["run.accepted", "run.history.selected", "runtime.observed"]
        );
        let opened = before[0] + usize::from(transport == Transport::WebSocket);
        assert_eq!(fixture.work.snapshot(), [opened, 2, 1, 1]);
        fixture.loopback.auth.assert_loads(loads + 1);
        let result = pause(&b, Record::ToolResult, Point::BeforeCommit);
        binding.release.notify_one();
        result.reached.notified().await;
        let rows = paused_records(&mut sql, &result, &b, false).await;
        assert_eq!(
            rows.iter()
                .filter(|row| row.0 == "run.provider.bound")
                .count(),
            1
        );
        assert!(!rows.iter().any(|row| row.0 == "tool.result.recorded"));
        assert_eq!(fixture.work.snapshot(), [before[0] + 1, 3, 2, 2]);
        let committed = pause(&b, Record::ToolResult, Point::AfterCommit);
        result.release.notify_one();
        committed.reached.notified().await;
        let rows = paused_records(&mut sql, &committed, &b, true).await;
        assert_eq!(
            *result.operation_id.lock().unwrap(),
            *committed.operation_id.lock().unwrap()
        );
        let outputs: Vec<_> = rows
            .iter()
            .filter(|row| row.0 == "tool.result.recorded")
            .collect();
        assert_eq!(outputs.len(), 1);
        let output: Value = serde_json::from_str(&outputs[0].1).unwrap();
        assert_eq!(output["output"], "{\"sum\":50}");
        assert_eq!(output["is_error"], false);
        assert_eq!(fixture.work.snapshot(), [before[0] + 1, 3, 2, 2]);
        assert!(ticket.completion().now_or_never().is_none());
        committed.release.notify_one();
    })
    .await;
    sql.close().await.unwrap();
    b.completed_context(&completed(&ticket).await, false).await;
    watchdog(done).await.unwrap();
    fixture.loopback.auth.assert_loads(loads * 2);
    fixture.finish().await;
}
#[tokio::test]
async fn v1a_21_host_websocket_awaits_acceptance_binding_and_result_commits() {
    durability(Transport::WebSocket).await;
}
#[tokio::test]
async fn v1a_22_host_sse_awaits_acceptance_binding_and_result_commits() {
    durability(Transport::Sse).await;
}

async fn identity_guard(transport: Transport) {
    const ACCOUNT_Y: &str = "synthetic-host-account-y";
    let mut fixture = Fixture::new(transport, true, false).await;
    let a = fixture.task(transport, vec![]).await;
    let result_a = abandoned_a(&fixture, &a).await;
    let context = a.completed_context(&result_a, false).await;
    let prefix = history(&fixture.session).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let work = fixture.work.clone();
    let server = tokio::spawn(async move {
        if transport == Transport::WebSocket {
            let mut socket = accept_counted(&listener, TOKEN_B, ACCOUNT_Y).await;
            work.connections.fetch_add(1, Ordering::SeqCst);
            drain_close(&mut socket).await; // Any conversation payload fails here.
        }
        tokio::select! { biased;
            _ = listener.accept() => panic!("identity rejection sent input, retried, or fell back"),
            _ = stopped => {}
        }
    });
    let auth_y = Arc::new(CountedAuth::new(TOKEN_B, ACCOUNT_Y));
    fixture
        .reopen(Arc::new(negative_gateway(
            auth_y.clone(),
            transport,
            address,
        )))
        .await;
    let mut b = fixture.task(transport, context.clone()).await;
    b.exchanges.clear();
    b.sum = None;
    let ticket = submit(&fixture.host, &b, &fixture.tools);
    ticket.accepted().await.unwrap();
    let completion = watchdog(ticket.completion()).await;
    let (result, runtime) = observe_failure(&b, executed(&completion), "history_identity").await;
    assert_eq!(runtime.len(), 2);
    assert_eq!(result.summary.model_requests_attempted, 0);
    assert_eq!(result.summary.model_requests_admitted, 0);
    assert_eq!(result.summary.last_upstream_outcome, None);
    auth_y.assert_loads(1);
    let actual = fixture
        .session
        .provider_binding(b.request.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_ne!(Some(actual.identity()), b.selection.expected_identity());
    assert_eq!(actual.requested_model(), MODEL);
    let digest: String = ring::digest::digest(
        &ring::digest::SHA256,
        &[
            b"wi.openai-codex.account.v1\0".as_slice(),
            ACCOUNT_Y.as_bytes(),
        ]
        .concat(),
    )
    .as_ref()
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect();
    assert!(actual.identity().principal_digest() == digest);
    let prepared = prepare_session_replay(&fixture.session, PROVIDER_ID, MODEL)
        .await
        .unwrap();
    assert_eq!(prepared.included_exchange_count(), 2);
    assert_eq!(prepared.excluded_runs().len(), 1);
    assert_eq!(prepared.excluded_runs()[0].run_id(), b.request.run_id);
    assert_eq!(
        prepared.excluded_runs()[0].disposition(),
        ReplayExclusionDisposition::DefinitelyUnsubmitted
    );
    let after_b = history(&fixture.session).await;
    assert_eq!(value(&after_b[..prefix.len()]), value(&prefix));
    fixture.reopen(fixture.loopback.gateway.clone()).await;
    // The observed provider model is not a requested-model alias or fallback permission.
    let mut changed = b.request.input.prepared_request().clone();
    changed.options.model = "observed-model-not-request-alias".into();
    let changed = PersistentRunRequest {
        operation_id: OperationId::new(),
        run_id: RunId::new(),
        input: RecordedRunInput::new(
            "wrong requested model".into(),
            changed,
            fixture.tools.definitions(),
            vec![],
            vec![],
            None,
        )
        .unwrap(),
    };
    let rejected = fixture
        .host
        .client()
        .submit(
            fixture.session.session_id().clone(),
            changed,
            fixture.tools.fresh_scope(),
        )
        .unwrap();
    let completion = watchdog(rejected.completion()).await;
    let RunCompletion::Execution(Err(failure)) = completion.as_ref() else {
        panic!("model mismatch accepted")
    };
    assert_eq!(failure.stage(), PersistentRunStage::History);
    assert!(matches!(failure.cause(),
        PersistentRunCause::Gateway(crate::GatewayError::InvalidRequest(message))
        if *message == "stored history provider or model is incompatible"));
    assert!(Arc::ptr_eq(
        &rejected.accepted().await.unwrap_err(),
        &completion
    ));
    assert_eq!(value(&history(&fixture.session).await), value(&after_b));
    let mut c = b.clone();
    c.session = fixture.session.clone();
    c.selection = prepared.selection();
    c.exchanges = vec![
        ("c-parent", call_items(42, 8)),
        ("c-final", final_items("50")),
    ];
    c.sum = Some(50);
    c.request = Arc::new(PersistentRunRequest {
        operation_id: OperationId::new(),
        run_id: RunId::new(),
        input: b.request.input.clone(),
    });
    let done = fixture.loopback.enqueue(&c).await;
    let result_c = completed(&submit(&fixture.host, &c, &fixture.tools)).await;
    c.completed_context(&result_c, false).await;
    watchdog(done).await.unwrap();
    assert_eq!(
        value(&history(&fixture.session).await[..after_b.len()]),
        value(&after_b)
    );
    assert_eq!(
        fixture.work.snapshot(),
        [
            if transport == Transport::WebSocket {
                3
            } else {
                4
            },
            4,
            2,
            2
        ]
    );
    fixture
        .loopback
        .auth
        .assert_loads(if transport == Transport::WebSocket {
            2
        } else {
            6
        });
    auth_y.assert_loads(1);
    stop.send(()).unwrap();
    watchdog(server).await.unwrap();
    fixture.finish().await;
}
#[tokio::test]
async fn v1a_23_host_websocket_account_x_y_x_and_exact_model_boundary() {
    identity_guard(Transport::WebSocket).await;
}
#[tokio::test]
async fn v1a_23_host_sse_account_x_y_x_and_exact_model_boundary() {
    identity_guard(Transport::Sse).await;
}

#[tokio::test]
async fn v1a_22_host_sse_failed_admission_and_identity_keep_uncertainty_without_retry() {
    for (mime, code) in [
        (None, "unexpected_content_type"),
        (Some("text/event-stream"), "protocol_error"),
        (Some("application/json"), "unexpected_content_type"),
    ] {
        let mut fixture = Fixture::new(Transport::Sse, true, false).await;
        let a = fixture.task(Transport::Sse, vec![]).await;
        let result = abandoned_a(&fixture, &a).await;
        let context = a.completed_context(&result, false).await;
        let prefix = history(&fixture.session).await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let auth = Arc::new(CountedAuth::new(TOKEN_A, ACCOUNT));
        fixture
            .reopen(Arc::new(negative_gateway(
                auth.clone(),
                Transport::Sse,
                address,
            )))
            .await;
        let mut b = fixture.task(Transport::Sse, context).await;
        b.exchanges.clear();
        b.sum = None;
        let task = b.clone();
        let work = fixture.work.clone();
        let (stop, stopped) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut tcp, peer) = listener.accept().await.unwrap();
            assert!(peer.ip().is_loopback());
            work.connections.fetch_add(1, Ordering::SeqCst);
            let body = read_counted_http(&mut tcp, TOKEN_A, ACCOUNT).await;
            work.requests.fetch_add(1, Ordering::SeqCst);
            task.observe_request(0, &body, Transport::Sse).await;
            send_events_http_mime(&mut tcp, events("", call_items(42, 8), false), mime).await;
            tokio::select! { biased;
                _ = listener.accept() => panic!("SSE failure retried or fell back"),
                _ = stopped => {}
            }
        });
        let ticket = submit(&fixture.host, &b, &fixture.tools);
        ticket.accepted().await.unwrap();
        let completion = watchdog(ticket.completion()).await;
        let (result, runtime) =
            observe_failure(&b, executed(&completion), "provider_request_failed").await;
        assert_eq!(result.summary.model_requests_attempted, 1);
        assert_eq!(result.summary.model_requests_admitted, 1);
        assert_eq!(
            result.summary.last_upstream_outcome,
            Some(UpstreamOutcome::Unknown)
        );
        let failures: Vec<_> = runtime
            .iter()
            .filter_map(|envelope| {
                if let RunEvent::ProviderEvent { event } = &envelope.event
                    && let ProviderEvent::RequestFailed {
                        code,
                        upstream_outcome,
                        ..
                    } = &event.event
                {
                    return Some((code.as_str(), *upstream_outcome));
                }
                None
            })
            .collect();
        assert_eq!(failures, [(code, UpstreamOutcome::Unknown)]);
        assert!(runtime.iter().any(|envelope| matches!(&envelope.event,
            RunEvent::TurnFinished { outcome: TurnOutcome::Stopped { reason }, upstream_outcome: Some(UpstreamOutcome::Unknown), .. }
            if reason == &result.outcome)));
        assert_eq!(
            value(&history(&fixture.session).await[..prefix.len()]),
            value(&prefix)
        );
        assert_eq!(fixture.work.snapshot(), [3, 3, 1, 1]);
        auth.assert_loads(2);
        fixture.loopback.auth.assert_loads(3);
        stop.send(()).unwrap();
        watchdog(server).await.unwrap();
        fixture.finish().await;
    }
}
