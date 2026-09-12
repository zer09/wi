use super::*;
use crate::{
    EventEnvelope, ToolDefinition,
    run::{RunEventEnvelope, TurnOutcome},
    tools::Tool,
};
use tokio::sync::oneshot;

struct IdentityLoopback {
    gateway: Gateway,
    auth: Arc<AuthRecords>,
    opens: Arc<AtomicUsize>,
    transport: Transport,
    stop: oneshot::Sender<()>,
    server: tokio::task::JoinHandle<Vec<Value>>,
}

impl IdentityLoopback {
    async fn new(transport: Transport, mime: Option<&'static str>, turns: Vec<Vec<Value>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = oneshot::channel();
        let server = tokio::spawn(async move {
            let mut requests = vec![];
            if transport == Transport::WebSocket {
                let mut socket = accept_ws(&listener).await;
                for events in turns {
                    requests.push(incoming(&mut socket).await);
                    for event in events {
                        send(&mut socket, event).await;
                    }
                }
                // The client must close, not submit another request on this socket.
                assert!(matches!(socket.next().await, Some(Ok(Message::Close(_)))));
            } else {
                let mut session_id = None;
                for events in turns {
                    let (mut tcp, _) = listener.accept().await.unwrap();
                    let (request, session) = http_request(&mut tcp).await;
                    if let Some(previous) = &session_id {
                        assert_eq!(previous, &session);
                    }
                    session_id = Some(session);
                    requests.push(request);
                    reply(&mut tcp, "200 OK", mime, &frames(events)).await;
                }
            }
            // Keep accepting until the caller has checked closure or completed the run.
            no_extra(listener, stopped).await;
            requests
        });
        let (gateway, auth, opens) = setup(address, transport);
        Self {
            gateway,
            auth,
            opens,
            transport,
            stop,
            server,
        }
    }

    async fn finish(self, expected_requests: usize) -> Vec<Value> {
        self.stop.send(()).unwrap();
        let requests = timeout(Duration::from_secs(5), self.server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(requests.len(), expected_requests);
        let preparations = if self.transport == Transport::WebSocket {
            1
        } else {
            expected_requests + 1
        };
        assert_auth(&self.auth, &self.opens, preparations);
        requests
    }
}

fn empty_identity_cases() -> Vec<(Vec<Value>, Option<&'static str>)> {
    vec![
        (
            vec![json!({"type":"response.created","response":{"id":""}})],
            None,
        ),
        (vec![terminal("", output())], None),
        (
            vec![
                json!({"type":"response.created","response":{"id":"r1"}}),
                terminal("", output()),
            ],
            Some("r1"),
        ),
    ]
}

fn assert_correlated(events: &[EventEnvelope], session: &str, request: &str) {
    for (index, envelope) in events.iter().enumerate() {
        assert_eq!(envelope.schema_version, 1);
        assert_eq!(envelope.provider, PROVIDER_ID);
        assert_eq!(envelope.session_id, session);
        assert_eq!(envelope.request_id.as_deref(), Some(request));
        if index > 0 {
            assert!(envelope.sequence > events[index - 1].sequence);
        }
    }
}

fn assert_identity_failure(events: &[EventEnvelope], started: Option<&str>, code: &str) {
    let starts: Vec<_> = events
        .iter()
        .filter_map(|envelope| match &envelope.event {
            ProviderEvent::ResponseStarted { response_id } => Some(response_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(starts, started.into_iter().collect::<Vec<_>>());
    assert!(!events.iter().any(|envelope| matches!(
        envelope.event,
        ProviderEvent::ResponseFinished { .. } | ProviderEvent::SessionClosed { .. }
    )));
    let failures: Vec<_> = events
        .iter()
        .filter(|envelope| matches!(envelope.event, ProviderEvent::RequestFailed { .. }))
        .collect();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].sequence, events.last().unwrap().sequence);
    let ProviderEvent::RequestFailed {
        code: actual_code,
        message,
        upstream_outcome,
    } = &failures[0].event
    else {
        unreachable!()
    };
    assert_eq!(actual_code, code);
    assert_eq!(*upstream_outcome, UpstreamOutcome::Unknown);
    let expected_message = if code == "protocol_error" {
        "invalid provider protocol: empty response identity"
    } else {
        "expected text/event-stream"
    };
    assert_eq!(message, expected_message);
}

async fn rejected_session(
    transport: Transport,
    mime: Option<&'static str>,
    values: Vec<Value>,
    started: Option<&str>,
    code: &str,
) {
    let fixture = IdentityLoopback::new(transport, mime, vec![values]).await;
    let mut options = SessionOptions::new("synthetic-model");
    options.transport = transport;
    options.tools = vec![crate::tools::add_numbers_definition()];
    let mut session = fixture
        .gateway
        .open_session(PROVIDER_ID, options)
        .await
        .unwrap();
    let receipt = session
        .control
        .generate(vec![InputItem::user("add 17 and 25")])
        .await
        .unwrap();
    // EOF is the actor-completion barrier, not an assumed period without events.
    let events: Vec<_> = timeout(Duration::from_secs(5), session.events.by_ref().collect())
        .await
        .unwrap();
    assert_correlated(&events, &session.id, &receipt.request_id);
    assert_identity_failure(&events, started, code);
    assert_eq!(events.len(), if started.is_some() { 2 } else { 1 });
    // Check both ordinary follow-up and a would-be tool settlement without closing locally.
    for input in [
        vec![InputItem::user("second")],
        vec![InputItem::ToolResult {
            call_id: "call-add".into(),
            output: "{\"sum\":42}".into(),
        }],
    ] {
        assert!(matches!(
            session.control.generate(input).await,
            Err(GatewayError::SessionClosed)
        ));
    }
    let requests = fixture.finish(1).await;
    assert_first(&requests[0], transport);
}

struct CountingAdd(Arc<AtomicUsize>);

#[async_trait]
impl Tool for CountingAdd {
    fn definition(&self) -> ToolDefinition {
        crate::tools::add_numbers_definition()
    }
    fn validate(&self, arguments: &Value) -> Result<()> {
        AddNumbers.validate(arguments)
    }
    async fn execute(&self, arguments: Value) -> Result<Value> {
        self.0.fetch_add(1, Ordering::SeqCst);
        AddNumbers.execute(arguments).await
    }
}

async fn observed_run(fixture: &IdentityLoopback) -> (RunResult, Vec<RunEventEnvelope>, usize) {
    let mut options = SessionOptions::new("synthetic-model");
    options.transport = fixture.transport;
    let request = RunRequest {
        provider_id: PROVIDER_ID.into(),
        options,
        prompt: "add 17 and 25".into(),
    };
    let executions = Arc::new(AtomicUsize::new(0));
    let mut tools = ToolRegistry::new();
    tools
        .register(Arc::new(CountingAdd(executions.clone())))
        .unwrap();
    let mut events = vec![];
    let result = timeout(
        Duration::from_secs(5),
        crate::run::run(
            &fixture.gateway,
            request,
            &tools,
            CancellationToken::new(),
            |event| {
                events.push(event.clone());
                Ok(())
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    for (index, envelope) in events.iter().enumerate() {
        assert_eq!(envelope.schema_version, 2);
        assert_eq!(envelope.sequence, index as u64 + 1);
        assert_eq!(envelope.run_id, result.run_id);
        if let RunEvent::ProviderEvent { event } = &envelope.event {
            assert_eq!(
                envelope.session_id.as_deref(),
                Some(event.session_id.as_str())
            );
            assert_eq!(envelope.request_id, event.request_id);
        }
    }
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    assert!(matches!(
        events.first().unwrap().event,
        RunEvent::RunStarted
    ));
    assert!(matches!(
        &events.last().unwrap().event,
        RunEvent::RunFinished { outcome, .. } if outcome == &result.outcome
    ));
    (result, events, executions.load(Ordering::SeqCst))
}

#[tokio::test]
async fn r1_a05_public_run_adapter_failure_stops_before_tools_or_second_send() {
    for transport in [Transport::WebSocket, Transport::Sse] {
        let mut cases = empty_identity_cases();
        let mut recovered = first_events(true);
        recovered.last_mut().unwrap()["response"]["id"] = json!("");
        cases.push((recovered, Some("r1")));
        for (values, started) in cases {
            let fixture =
                IdentityLoopback::new(transport, Some("text/event-stream"), vec![values]).await;
            let (result, events, executions) = observed_run(&fixture).await;
            assert_eq!(
                result.outcome,
                RunOutcome::Failed {
                    code: "provider_request_failed".into()
                }
            );
            assert_eq!(result.summary.model_requests_attempted, 1);
            assert_eq!(result.summary.model_requests_admitted, 1);
            assert_eq!(result.summary.turns_started, 1);
            assert_eq!(result.summary.turns_finished, 1);
            assert_eq!(result.summary.new_tool_dispatches, 0);
            assert_eq!(result.summary.tool_results_prepared, 0);
            assert_eq!(result.summary.reused_results, 0);
            assert_eq!(
                result.summary.last_upstream_outcome,
                Some(UpstreamOutcome::Unknown)
            );
            assert!(result.last_response.is_none());
            assert_eq!(executions, 0);
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event.event, RunEvent::ToolEvent { .. }))
            );
            let provider_events: Vec<_> = events
                .iter()
                .filter_map(|envelope| match &envelope.event {
                    RunEvent::ProviderEvent { event } => Some(*event.clone()),
                    _ => None,
                })
                .collect();
            assert_correlated(
                &provider_events,
                result.session_id.as_deref().unwrap(),
                result.summary.last_request_id.as_deref().unwrap(),
            );
            assert_identity_failure(&provider_events, started, "protocol_error");
            assert!(events.iter().any(|event| matches!(
                &event.event,
                RunEvent::TurnFinished {
                    response_id,
                    outcome: TurnOutcome::Stopped { reason },
                    upstream_outcome: Some(UpstreamOutcome::Unknown),
                    ..
                } if response_id.as_deref() == started && reason == &result.outcome
            )));
            let requests = fixture.finish(1).await;
            assert_first(&requests[0], transport);
        }
    }
}

#[tokio::test]
async fn r1_a05_public_run_valid_terminal_only_matching_ids_and_empty_content() {
    for transport in [Transport::WebSocket, Transport::Sse] {
        for id in [" ", " \t非ASCII/opaque "] {
            for started in [false, true] {
                let mut values = vec![];
                let extension = json!({"type":"response.future_metadata","opaque":{"id":""}});
                if started {
                    values.push(json!({"type":"response.created","response":{"id":id}}));
                    values.push(json!({"type":"response.output_text.delta","response_id":id,"item_id":"m","output_index":0,"content_index":0,"delta":""}));
                    values.push(json!({"type":"response.refusal.delta","response_id":id,"item_id":"m","output_index":0,"content_index":1,"delta":""}));
                    values.push(extension.clone());
                }
                let terminal = terminal(
                    id,
                    vec![
                        json!({"type":"message","id":"m","content":[{"type":"output_text","text":""},{"type":"refusal","refusal":""}]}),
                    ],
                );
                let native = terminal["response"].clone();
                values.push(terminal);
                let fixture =
                    IdentityLoopback::new(transport, Some("text/event-stream"), vec![values]).await;
                let (result, events, executions) = observed_run(&fixture).await;
                assert_eq!(result.outcome, RunOutcome::Completed);
                assert_eq!(result.summary.model_requests_attempted, 1);
                assert_eq!(result.summary.model_requests_admitted, 1);
                assert_eq!(result.summary.new_tool_dispatches, 0);
                assert_eq!(result.summary.tool_results_prepared, 0);
                assert_eq!(
                    result.summary.last_upstream_outcome,
                    Some(UpstreamOutcome::TerminalReceived)
                );
                assert_eq!(executions, 0);
                let response = result.last_response.as_ref().unwrap();
                assert_eq!(response.id, id);
                assert_eq!(response.text, "");
                assert_eq!(response.native, native);
                assert_eq!(response.output_provenance, OutputProvenance::NativeTerminal);
                let provider_events: Vec<_> = events
                    .iter()
                    .filter_map(|envelope| match &envelope.event {
                        RunEvent::ProviderEvent { event } => Some(*event.clone()),
                        _ => None,
                    })
                    .collect();
                assert_correlated(
                    &provider_events,
                    result.session_id.as_deref().unwrap(),
                    result.summary.last_request_id.as_deref().unwrap(),
                );
                assert!(
                    matches!(&provider_events[0].event, ProviderEvent::ResponseStarted { response_id } if response_id == id)
                );
                assert!(
                    matches!(&provider_events.last().unwrap().event, ProviderEvent::ResponseFinished { response } if response.id == id)
                );
                assert_eq!(provider_events.len(), if started { 5 } else { 2 });
                if started {
                    for (index, kind) in
                        [(1, crate::DeltaKind::Text), (2, crate::DeltaKind::Refusal)]
                    {
                        assert!(
                            matches!(&provider_events[index].event, ProviderEvent::OutputItemUpdated { response_id, delta, kind: actual, .. } if response_id == id && delta.is_empty() && *actual == kind)
                        );
                    }
                    assert!(
                        matches!(&provider_events[3].event, ProviderEvent::ProviderExtension { payload, .. } if payload == &extension)
                    );
                }
                let requests = fixture.finish(1).await;
                assert_first(&requests[0], transport);
            }
        }
    }
}

#[tokio::test]
async fn r1_a05_public_run_valid_native_and_recovered_tool_continuations() {
    for transport in [Transport::WebSocket, Transport::Sse] {
        for recovered in [false, true] {
            let fixture = IdentityLoopback::new(
                transport,
                Some("text/event-stream"),
                vec![first_events(recovered), final_events()],
            )
            .await;
            let (result, events, executions) = observed_run(&fixture).await;
            let responses: Vec<_> = events
                .iter()
                .filter_map(|envelope| match &envelope.event {
                    RunEvent::ProviderEvent { event } => match &event.event {
                        ProviderEvent::ResponseFinished { response } => Some(response.clone()),
                        ProviderEvent::RequestFailed { .. } => panic!("valid continuation failed"),
                        _ => None,
                    },
                    _ => None,
                })
                .collect();
            assert_success(&result, &responses, recovered);
            assert_eq!(responses[0].id, "r1");
            assert_eq!(responses[1].id, "r2");
            assert_eq!(executions, 1);
            assert_eq!(result.summary.turns_started, 2);
            assert_eq!(result.summary.turns_finished, 2);
            assert_eq!(
                result.summary.last_upstream_outcome,
                Some(UpstreamOutcome::TerminalReceived)
            );
            let requests = fixture.finish(2).await;
            assert_first(&requests[0], transport);
            assert_second(&requests[0], &requests[1], transport);
        }
    }
}

#[tokio::test]
async fn r1_a05_public_run_valid_terminal_failures_keep_terminal_received() {
    for transport in [Transport::WebSocket, Transport::Sse] {
        for (status, outcome, code) in [
            (
                "incomplete",
                ResponseOutcome::Incomplete { reason: None },
                "model_incomplete",
            ),
            ("failed", ResponseOutcome::Failed, "model_failed"),
            ("cancelled", ResponseOutcome::Cancelled, "model_cancelled"),
        ] {
            let terminal = json!({"type":format!("response.{status}"),"response":{"id":"r1","status":status,"output":output()}});
            let native = terminal["response"].clone();
            let fixture =
                IdentityLoopback::new(transport, Some("text/event-stream"), vec![vec![terminal]])
                    .await;
            let (result, events, executions) = observed_run(&fixture).await;
            assert_eq!(result.outcome, RunOutcome::Failed { code: code.into() });
            assert_eq!(result.summary.model_requests_attempted, 1);
            assert_eq!(result.summary.model_requests_admitted, 1);
            assert_eq!(result.summary.new_tool_dispatches, 0);
            assert_eq!(result.summary.tool_results_prepared, 0);
            assert_eq!(
                result.summary.last_upstream_outcome,
                Some(UpstreamOutcome::TerminalReceived)
            );
            assert_eq!(executions, 0);
            let response = result.last_response.as_ref().unwrap();
            assert_eq!(response.id, "r1");
            assert_eq!(response.outcome, outcome);
            assert_eq!(response.native, native);
            let provider_events: Vec<_> = events
                .iter()
                .filter_map(|envelope| match &envelope.event {
                    RunEvent::ProviderEvent { event } => Some(*event.clone()),
                    _ => None,
                })
                .collect();
            assert_correlated(
                &provider_events,
                result.session_id.as_deref().unwrap(),
                result.summary.last_request_id.as_deref().unwrap(),
            );
            assert!(
                matches!(provider_events.as_slice(), [EventEnvelope { event: ProviderEvent::ResponseStarted { response_id }, .. }, EventEnvelope { event: ProviderEvent::ResponseFinished { response }, .. }] if response_id == "r1" && response.id == "r1" && response.outcome == outcome)
            );
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event.event, RunEvent::ToolEvent { .. }))
            );
            let requests = fixture.finish(1).await;
            assert_first(&requests[0], transport);
        }
    }
}

#[tokio::test]
async fn r1_a05_websocket_empty_identities_close_without_finish_or_continuation() {
    for (events, started) in empty_identity_cases() {
        rejected_session(
            Transport::WebSocket,
            None,
            events,
            started,
            "protocol_error",
        )
        .await;
    }
}

#[tokio::test]
async fn r1_a05_labelled_sse_empty_identities_close_without_finish_or_continuation() {
    for (events, started) in empty_identity_cases() {
        rejected_session(
            Transport::Sse,
            Some("text/event-stream"),
            events,
            started,
            "protocol_error",
        )
        .await;
    }
}

#[tokio::test]
async fn r1_a05_missing_mime_empty_first_identity_keeps_prolog_category() {
    for (events, started) in empty_identity_cases().into_iter().take(2) {
        rejected_session(
            Transport::Sse,
            None,
            events,
            started,
            "unexpected_content_type",
        )
        .await;
    }
}
