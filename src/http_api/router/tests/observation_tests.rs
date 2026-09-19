use super::*;
use crate::{
    Capability, ConversationReplay, InputItem, ModelResponse, Provider, ProviderCapabilities,
    ProviderSession, ReplayIdentity, ResponseOutcome,
    execution::{PersistentRunRequest, PersistentRunResult},
    run::{RunEvent, RunEventEnvelope, RunOutcome, RunRequest, RunResult, RunSummary},
    service::{RunCompletion, ShutdownOutcome},
    storage::{
        AppendRunRecord, RecordedProviderBinding, RecordedRunInput,
        test_hooks::{Action, Pause, Point, Record},
    },
    tools::ToolRegistry,
};
use async_trait::async_trait;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;

fn input() -> RecordedRunInput {
    let mut options = SessionOptions::new("synthetic-model");
    options.instructions = "private-instructions-canary".into();
    RecordedRunInput::new(
        "  raw 雪\r\ntext\n".into(),
        RunRequest {
            provider_id: "http-test".into(),
            options,
            prompt: "private-prepared-prompt-canary".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap()
}

fn runtime(run: &RunId, sequence: u64, event: RunEvent) -> AppendRunRecord {
    AppendRunRecord::Runtime(RunEventEnvelope {
        schema_version: 2,
        sequence,
        event_id: uuid::Uuid::new_v4().to_string(),
        run_id: run.to_string(),
        turn_id: None,
        session_id: if matches!(event, RunEvent::RunFinished { .. }) {
            Some("private-provider-session-canary".into())
        } else {
            None
        },
        request_id: None,
        event,
    })
}

#[tokio::test]
async fn history_captures_fixed_head_and_projects_one_view_per_record() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    for index in 0..34 {
        session
            .rename(OperationId::new(), format!("title {index}\r\n雪"))
            .await
            .unwrap();
    }
    let run = RunId::new();
    let selection =
        crate::execution::prepare_session_replay(&session, "http-test", "synthetic-model")
            .await
            .unwrap()
            .selection();
    session
        .accept_history_run(OperationId::new(), run.clone(), input(), selection)
        .await
        .unwrap();
    session
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![
                runtime(&run, 1, RunEvent::RunStarted),
                AppendRunRecord::ProviderBinding(
                    RecordedProviderBinding::new(
                        run.clone(),
                        "private-provider-session-canary".into(),
                        "synthetic-model".into(),
                        ReplayIdentity::new(
                            "http-test".into(),
                            "private-format-canary".into(),
                            "a".repeat(64),
                        )
                        .unwrap(),
                    )
                    .unwrap(),
                ),
            ],
        )
        .await
        .unwrap();
    let default_page = response(server.get(&format!("/v1/sessions/{sid}/history")), 200).await;
    assert_eq!(default_page["events"].as_array().unwrap().len(), 32);
    assert_eq!(default_page["has_more"], true);
    let head = session.manifest().await.unwrap().head_sequence();
    let stored = session.history_page(0, Some(head), 128).await.unwrap();
    assert_eq!(head, 39);
    let mut page = response(
        server.get(&format!("/v1/sessions/{sid}/history?limit=7")),
        200,
    )
    .await;
    assert_eq!(page["through_sequence"], head.to_string());
    let new_title = "after snapshot\r\n雪";
    response(
        server.post(
            &format!("/v1/sessions/{sid}/rename"),
            &json!({"operation_id":OperationId::new(),"title":new_title}),
        ),
        200,
    )
    .await;
    let mut events = Vec::new();
    loop {
        assert_eq!(page["through_sequence"], head.to_string());
        assert!(page["events"].as_array().unwrap().len() <= 7);
        events.extend(page["events"].as_array().unwrap().iter().cloned());
        if page["has_more"] == false {
            break;
        }
        page = response(
            server.get(&format!(
                "/v1/sessions/{sid}/history?after={}&through={head}&limit=7",
                page["next_after"].as_str().unwrap()
            )),
            200,
        )
        .await;
    }
    assert_eq!(page["next_after"], format!("{sid}:{head}"));
    assert_eq!(events.len(), stored.records().len());
    for (index, (view, record)) in events.iter().zip(stored.records()).enumerate() {
        assert_eq!(view["api_version"], 1);
        assert_eq!(view["session_id"], sid.as_str());
        assert_eq!(view["sequence"], (index + 1).to_string());
        assert_eq!(view["event_id"], record.event_id().as_str());
        assert_eq!(view["created_at_ms"], record.created_at_ms().to_string());
    }
    assert_eq!(events[35]["kind"], "run.accepted");
    assert_eq!(events[35]["data"]["user_text"], input().user_text());
    for index in [36, 38] {
        assert_eq!(events[index]["kind"], "checkpoint");
        assert_eq!(events[index]["data"], json!({}));
    }
    let tail = response(
        server.get(&format!("/v1/sessions/{sid}/history?after={sid}:{head}")),
        200,
    )
    .await;
    assert_eq!(tail["events"].as_array().unwrap().len(), 1);
    assert_eq!(tail["events"][0]["kind"], "session.renamed");
    assert_eq!(tail["events"][0]["data"]["title"], new_title);
    let empty = response(
        server.get(&format!(
            "/v1/sessions/{sid}/history?after={sid}:{head}&through={head}"
        )),
        200,
    )
    .await;
    assert_eq!(empty["events"], json!([]));
    assert_eq!(empty["has_more"], false);
    assert_eq!(empty["next_after"], format!("{sid}:{head}"));
    let still_stored = session.history_page(0, Some(head), 128).await.unwrap();
    assert_eq!(
        serde_json::to_value(&still_stored).unwrap(),
        serde_json::to_value(&stored).unwrap()
    );
    server.finish().await;
}

#[tokio::test]
async fn run_and_operation_reads_distinguish_acceptance_terminal_and_final_result() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    let run = RunId::new();
    let op = OperationId::new();
    let path = format!("/v1/sessions/{sid}/runs/{run}");
    error(server.get(&path), 404, "api.not_found").await;
    error(
        server.get(&format!("/v1/sessions/{sid}/operations/{op}")),
        404,
        "api.not_found",
    )
    .await;
    let acceptance = session
        .accept_run(op.clone(), run.clone(), input())
        .await
        .unwrap();
    let accepted = response(server.get(&path), 200).await;
    assert_eq!(
        accepted,
        json!({"api_version":1,"run_id":run,"state":"accepted","user_text":input().user_text(),
        "accepted_sequence":"2","terminal_sequence":null,"result_sequence":null,"result_recorded":false,"result":null})
    );
    let operation = response(
        server.get(&format!("/v1/sessions/{sid}/operations/{op}")),
        200,
    )
    .await;
    assert_eq!(
        operation,
        json!({"api_version":1,"operation_id":op,"session_id":sid,"run_id":run,
        "first_sequence":acceptance.receipt().first_sequence().to_string(),"last_sequence":acceptance.receipt().last_sequence().to_string()})
    );
    let other = server.session().await;
    error(
        server.get(&format!("/v1/sessions/{}/runs/{run}", other.session_id())),
        404,
        "api.not_found",
    )
    .await;
    error(
        server.get(&format!(
            "/v1/sessions/{}/operations/{op}",
            other.session_id()
        )),
        404,
        "api.not_found",
    )
    .await;
    session
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![runtime(&run, 1, RunEvent::RunStarted)],
        )
        .await
        .unwrap();
    assert_eq!(response(server.get(&path), 200).await["state"], "running");
    session
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![runtime(
                &run,
                2,
                RunEvent::RunFinished {
                    outcome: RunOutcome::Completed,
                    summary: RunSummary::default(),
                },
            )],
        )
        .await
        .unwrap();
    let terminal = response(server.get(&path), 200).await;
    assert_eq!(terminal["state"], "completed");
    assert_eq!(terminal["terminal_sequence"], "4");
    assert_eq!(terminal["result_sequence"], Value::Null);
    assert_eq!(terminal["result_recorded"], false);
    assert_eq!(terminal["result"], Value::Null);
    session
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![AppendRunRecord::Result(RunResult {
                run_id: run.to_string(),
                session_id: Some("private-provider-session-canary".into()),
                outcome: RunOutcome::Completed,
                summary: RunSummary::default(),
                events_complete: true,
                sink_error: None,
                last_response: Some(ModelResponse {
                    id: "response".into(),
                    model: None,
                    outcome: ResponseOutcome::Completed,
                    output: vec![],
                    text: "answer only in response event".into(),
                    usage: None,
                    native: json!({"opaque":"private-native-canary"}),
                    output_provenance: Default::default(),
                }),
            })],
        )
        .await
        .unwrap();
    let final_result = response(server.get(&path), 200).await;
    assert_eq!(final_result["state"], "completed");
    assert_eq!(final_result["terminal_sequence"], "4");
    assert_eq!(final_result["result_sequence"], "5");
    assert_eq!(final_result["result_recorded"], true);
    assert_eq!(
        final_result["result"]["outcome"],
        json!({"type":"completed"})
    );
    assert_eq!(final_result["result"]["events_complete"], true);
    assert!(
        !final_result
            .to_string()
            .contains("answer only in response event")
    );
    assert!(final_result["result"].get("last_response").is_none());
    server.finish().await;
}

#[derive(Default)]
struct PendingProvider {
    opened: Notify,
    opens: AtomicUsize,
}

#[async_trait]
impl Provider for PendingProvider {
    fn id(&self) -> &'static str {
        "http-test"
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let yes = Capability {
            implemented: true,
            verification: "synthetic pending open only".into(),
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
        _: &SessionOptions,
        replay: &ConversationReplay,
        _: &[InputItem],
    ) -> crate::Result<()> {
        assert!(replay.runs().is_empty());
        Ok(())
    }
    async fn open_session(&self, _: SessionOptions) -> crate::Result<ProviderSession> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        self.opened.notify_one();
        std::future::pending().await
    }
}

#[tokio::test]
async fn cancellation_is_addressed_signal_only_and_rename_works_while_pending() {
    let provider = Arc::new(PendingProvider::default());
    let mut gateway = Gateway::new();
    gateway.register(provider.clone()).unwrap();
    let server = Server::gateway(Arc::new(gateway)).await;
    let first = server.session().await;
    let second = server.session().await;
    let rid = RunId::new();
    let client = server.host.client();
    // Fixture submissions are library calls, not implementation of HTTP POST /runs.
    let a = client
        .submit(
            first.session_id().clone(),
            PersistentRunRequest {
                operation_id: OperationId::new(),
                run_id: rid.clone(),
                input: input(),
            },
            ToolRegistry::new(),
        )
        .unwrap();
    watchdog(provider.opened.notified()).await;
    let b = client
        .submit(
            second.session_id().clone(),
            PersistentRunRequest {
                operation_id: OperationId::new(),
                run_id: rid.clone(),
                input: input(),
            },
            ToolRegistry::new(),
        )
        .unwrap();
    watchdog(provider.opened.notified()).await;
    assert_eq!(provider.opens.load(Ordering::SeqCst), 2);
    let receipt = watchdog(a.accepted()).await.unwrap();
    let sid = first.session_id();
    let operation = response(
        server.get(&format!(
            "/v1/sessions/{sid}/operations/{}",
            a.operation_id()
        )),
        200,
    )
    .await;
    assert_eq!(
        operation["first_sequence"],
        receipt.receipt().first_sequence().to_string()
    );
    assert_eq!(operation["last_sequence"], "3");
    let renamed = response(
        server.post(
            &format!("/v1/sessions/{sid}/rename"),
            &json!({"operation_id":OperationId::new(),"title":"pending 雪\r\n"}),
        ),
        200,
    )
    .await;
    assert_eq!(renamed["catalog_refresh"], "updated");
    for (sid, rid) in [
        (ApplicationSessionId::new(), rid.clone()),
        (sid.clone(), RunId::new()),
    ] {
        let reply = response(
            server.post(&format!("/v1/sessions/{sid}/runs/{rid}/cancel"), &json!({})),
            200,
        )
        .await;
        assert_eq!(
            reply,
            json!({"api_version":1,"session_id":sid,"run_id":rid,"disposition":"not_tracked"})
        );
    }
    let pause = Arc::new(Pause::default());
    first.test_hooks().arm_record(
        Record::RunFinished,
        Point::BeforeCommit,
        Action::Pause(pause.clone()),
    );
    let cancelled = response(
        server.post(&format!("/v1/sessions/{sid}/runs/{rid}/cancel"), &json!({})),
        202,
    )
    .await;
    assert_eq!(
        cancelled,
        json!({"api_version":1,"session_id":sid,"run_id":rid,"disposition":"requested"})
    );
    watchdog(pause.reached.notified()).await;
    assert!(futures_util::poll!(Box::pin(a.completion())).is_pending());
    assert!(futures_util::poll!(Box::pin(b.completion())).is_pending());
    assert_eq!(
        response(
            server.get(&format!("/v1/sessions/{}/runs/{rid}", second.session_id())),
            200
        )
        .await["state"],
        "running"
    );
    pause.release.notify_one();
    let completion = watchdog(a.completion()).await;
    let RunCompletion::Execution(Ok(PersistentRunResult::Executed { result, .. })) = &*completion
    else {
        panic!("expected cancelled execution")
    };
    assert_eq!(result.outcome, RunOutcome::CancelledLocally);
    let saved = response(server.get(&format!("/v1/sessions/{sid}/runs/{rid}")), 200).await;
    assert_eq!(saved["state"], "cancelled_locally");
    assert_eq!(saved["result_recorded"], true);
    assert_eq!(
        response(
            server.post(&format!("/v1/sessions/{sid}/runs/{rid}/cancel"), &json!({})),
            200
        )
        .await["disposition"],
        "not_tracked"
    );
    assert!(futures_util::poll!(Box::pin(b.completion())).is_pending());
    let closing = server.host.begin_shutdown();
    error(
        server.post(
            &format!("/v1/sessions/{}/runs/{rid}/cancel", second.session_id()),
            &json!({}),
        ),
        503,
        "api.closed",
    )
    .await;
    assert!(matches!(
        &*watchdog(closing.wait()).await,
        ShutdownOutcome::Closed
    ));
    error(
        server.get(&format!("/v1/sessions/{sid}")),
        503,
        "storage.closed",
    )
    .await;
    server.finish().await;
}

#[tokio::test]
async fn authenticated_open_reconciles_interruption_once_without_provider_work() {
    let provider = Arc::new(PendingProvider::default());
    let mut gateway = Gateway::new();
    gateway.register(provider.clone()).unwrap();
    let gateway = Arc::new(gateway);
    let server = Server::gateway(gateway.clone()).await;
    let session = server.session().await;
    let sid = session.session_id().clone();
    let rid = RunId::new();
    session
        .accept_run(OperationId::new(), rid.clone(), input())
        .await
        .unwrap();
    let (temp, host) = server.stop_http().await;
    assert!(matches!(
        &*watchdog(host.begin_shutdown().wait()).await,
        ShutdownOutcome::Closed
    ));
    let store = SessionStore::open(temp.path().join("private-data-canary"))
        .await
        .unwrap();
    let host = Arc::new(RunHost::new(store, gateway).unwrap());
    let server = Server::start(temp, host, false).await;
    let listed = response(server.get("/v1/sessions"), 200).await;
    assert_eq!(listed["entries"][0]["observed_head_sequence"], "1");
    error(
        server.http.get(server.url(&format!("/v1/sessions/{sid}"))),
        401,
        "api.unauthorized",
    )
    .await;
    for _ in 0..2 {
        let run = response(server.get(&format!("/v1/sessions/{sid}/runs/{rid}")), 200).await;
        assert_eq!(run["state"], "interrupted");
        assert_eq!(run["terminal_sequence"], "3");
        assert_eq!(run["result_recorded"], false);
        assert_eq!(
            response(server.get(&format!("/v1/sessions/{sid}")), 200).await["head_sequence"],
            "3"
        );
    }
    assert_eq!(provider.opens.load(Ordering::SeqCst), 0);
    server.finish().await;
}
