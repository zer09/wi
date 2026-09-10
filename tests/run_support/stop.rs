use super::*;
use async_trait::async_trait;
use serde_json::Value;
use std::{
    future::pending,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::Notify;
use wi::tools::Tool;

#[tokio::test(start_paused = true)]
async fn run_cancel_open_generate_receipt_and_drop_cleanup() {
    for phase in ["open", "generate", "receipt"] {
        for drop_future in [false, true] {
            let step = if phase == "generate" {
                Step::PendingGenerate
            } else {
                Step::PendingOutput
            };
            let mut script = Script::new(vec![step]);
            script.pending_open = phase == "open";
            let records = script.records.clone();
            let mut gateway = Gateway::new();
            gateway.register(Arc::new(script)).unwrap();
            let tools = ToolRegistry::new();
            let token = CancellationToken::new();
            let mut events = Vec::new();
            let mut future = Box::pin(run(&gateway, request(), &tools, token.clone(), |event| {
                events.push(event.clone());
                Ok(())
            }));
            let entered = match phase {
                "open" => &records.open_entered,
                "generate" => &records.generate_entered,
                _ => &records.stream_entered,
            };
            assert!(futures_util::poll!(&mut future).is_pending());
            entered.notified().await;
            if drop_future {
                drop(future);
                assert_eq!(count(&records.closes), if phase == "open" { 0 } else { 1 });
                assert!(!trace(&events).contains(&"run_finished"));
            } else {
                token.cancel();
                let result = future.await.unwrap();
                assert_eq!(result.outcome, RunOutcome::CancelledLocally);
                assert_eq!(
                    result.summary.last_upstream_outcome,
                    if phase == "open" {
                        None
                    } else {
                        Some(UpstreamOutcome::Unknown)
                    }
                );
                assert_eq!(
                    result.summary.model_requests_attempted,
                    if phase == "open" { 0 } else { 1 }
                );
                assert_eq!(
                    result.summary.model_requests_admitted,
                    if phase == "receipt" { 1 } else { 0 }
                );
                assert_eq!(result.summary.turns_started, result.summary.turns_finished);
                assert_eq!(trace(&events).last(), Some(&"run_finished"));
                assert_eq!(count(&records.closes), if phase == "open" { 0 } else { 1 });
            }
            assert_eq!(count(&records.opens), 1);
            assert_eq!(
                count(&records.attempts),
                if phase == "open" { 0 } else { 1 }
            );
        }
    }
}

#[derive(Default)]
struct ReleasedTool {
    calls: AtomicUsize,
    dropped: Arc<AtomicUsize>,
    entered: Notify,
    release: Notify,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleasedArguments {
    timeout_seconds: Option<u64>,
}
#[async_trait]
impl Tool for ReleasedTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "wait_for_release".into(),
            description: "Synthetic cooperative tool with its own optional timeout.".into(),
            parameters: json!({"type":"object","properties":{"timeout_seconds":{"type":"integer","minimum":0}},"required":[],"additionalProperties":false}),
            strict: false,
        }
    }
    fn validate(&self, args: &Value) -> wi::Result<()> {
        let _: ReleasedArguments =
            serde_json::from_value(args.clone()).map_err(|_| GatewayError::InvalidToolArguments)?;
        Ok(())
    }
    async fn execute(&self, args: Value) -> wi::Result<Value> {
        let args: ReleasedArguments =
            serde_json::from_value(args).map_err(|_| GatewayError::InvalidToolArguments)?;
        self.calls.fetch_add(1, Ordering::SeqCst);
        let _drop = DropProbe(self.dropped.clone());
        self.entered.notify_one();
        if let Some(seconds) = args.timeout_seconds {
            tokio::time::timeout(
                std::time::Duration::from_secs(seconds),
                self.release.notified(),
            )
            .await
            .map_err(|_| GatewayError::ToolFailed)?;
        } else {
            self.release.notified().await;
        }
        Ok(json!({"released":true}))
    }
}
fn released_call(args: Value) -> OutputItem {
    let mut item = call("pending-call", 0, 0);
    let call = item.function_call.as_mut().unwrap();
    call.name = "wait_for_release".into();
    call.arguments = args.to_string();
    item
}

#[tokio::test(start_paused = true)]
async fn run_pending_tool_survives_120_600_3600_seconds_then_release_or_cancel() {
    for cancel in [false, true] {
        let (gateway, script, _) = setup(vec![
            Step::Response(response("pending", vec![released_call(json!({}))], "")),
            Step::Response(response("final", vec![], "consumed")),
        ]);
        let tool = Arc::new(ReleasedTool::default());
        let mut tools = ToolRegistry::new();
        tools.register(tool.clone()).unwrap();
        let token = CancellationToken::new();
        let mut events = Vec::new();
        let mut future = Box::pin(run(&gateway, request(), &tools, token.clone(), |event| {
            events.push(event.clone());
            Ok(())
        }));
        let start = tokio::time::Instant::now();
        assert!(futures_util::poll!(&mut future).is_pending());
        tool.entered.notified().await;
        for seconds in [121, 601, 3601] {
            let elapsed = std::time::Duration::from_secs(seconds);
            tokio::time::advance(elapsed - start.elapsed()).await;
            assert!(
                futures_util::poll!(&mut future).is_pending(),
                "stopped at {seconds}s"
            );
            assert!(start.elapsed() >= elapsed);
            assert_eq!(count(&tool.calls), 1);
            assert_eq!(count(&tool.dropped), 0);
            assert_eq!(count(&script.records.attempts), 1);
            assert_eq!(count(&script.records.closes), 0);
        }
        if cancel {
            token.cancel();
        } else {
            tool.release.notify_one();
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), future)
            .await
            .unwrap()
            .unwrap();
        assert!(result.events_complete);
        assert_eq!(result.sink_error, None);
        assert_eq!(result.summary.new_tool_dispatches, 1);
        assert_eq!(result.summary.reused_results, 0);
        assert_eq!(count(&script.records.opens), 1);
        assert_eq!(count(&script.records.closes), 1);
        assert_eq!(count(&tool.dropped), 1);
        assert_eq!(Arc::strong_count(&tool), 2, "no detached tool owner");
        let finished: Vec<_> = events
            .iter()
            .filter_map(|e| match &e.event {
                RunEvent::ToolEvent {
                    event:
                        ToolExecutionEvent::ToolExecutionFinished {
                            call_id,
                            tool_name,
                            is_error,
                        },
                } => Some((call_id.as_str(), tool_name.as_str(), *is_error)),
                _ => None,
            })
            .collect();
        if cancel {
            assert_eq!(result.outcome, RunOutcome::CancelledLocally);
            assert_eq!(result.summary.model_requests_attempted, 1);
            assert_eq!(result.summary.tool_results_prepared, 0);
            assert_eq!(
                result.summary.last_upstream_outcome,
                Some(UpstreamOutcome::TerminalReceived)
            );
            assert!(finished.is_empty());
            assert_eq!(script.records.inputs.lock().unwrap().len(), 1);
        } else {
            assert_eq!(result.outcome, RunOutcome::Completed);
            assert_eq!(result.summary.model_requests_attempted, 2);
            assert_eq!(result.summary.tool_results_prepared, 1);
            assert_eq!(result.last_response.as_ref().unwrap().text, "consumed");
            assert_eq!(finished, [("pending-call", "wait_for_release", false)]);
            assert_eq!(
                value(&script.records.inputs.lock().unwrap()[1]),
                json!([
                    {"kind":"tool_result","call_id":"pending-call","output":"{\"released\":true}"}
                ])
            );
        }
        tool.release.notify_one();
        tokio::task::yield_now().await;
        assert_eq!(count(&tool.calls), 1);
        assert_eq!(count(&tool.dropped), 1);
        assert_eq!(trace(&events).last(), Some(&"run_finished"));
    }
}

#[tokio::test(start_paused = true)]
async fn run_tool_owned_optional_timeout_is_an_ordinary_correlated_result() {
    for release_before_timeout in [false, true] {
        let (gateway, script, _) = setup(vec![
            Step::Response(response(
                "pending",
                vec![released_call(json!({"timeout_seconds":7}))],
                "",
            )),
            Step::Response(response("final", vec![], "consumed")),
        ]);
        let tool = Arc::new(ReleasedTool::default());
        let mut tools = ToolRegistry::new();
        tools.register(tool.clone()).unwrap();
        let mut events = Vec::new();
        let mut future = Box::pin(run(
            &gateway,
            request(),
            &tools,
            CancellationToken::new(),
            |event| {
                events.push(event.clone());
                Ok(())
            },
        ));
        assert!(futures_util::poll!(&mut future).is_pending());
        tool.entered.notified().await;
        tokio::time::advance(std::time::Duration::from_secs(6)).await;
        assert!(futures_util::poll!(&mut future).is_pending());
        assert_eq!(count(&tool.dropped), 0);
        if release_before_timeout {
            tool.release.notify_one();
        } else {
            tokio::time::advance(std::time::Duration::from_secs(1)).await;
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), future)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.outcome, RunOutcome::Completed);
        assert!(result.events_complete);
        assert_eq!(result.summary.model_requests_attempted, 2);
        assert_eq!(result.summary.new_tool_dispatches, 1);
        assert_eq!(result.summary.tool_results_prepared, 1);
        assert_eq!(result.last_response.as_ref().unwrap().text, "consumed");
        let output = if release_before_timeout {
            json!({"released":true})
        } else {
            json!({"error":{"code":"gateway_error"}})
        };
        assert_eq!(
            value(&script.records.inputs.lock().unwrap()[1]),
            json!([
                {"kind":"tool_result","call_id":"pending-call","output":output.to_string()}
            ])
        );
        let tool_events: Vec<_> = events
            .iter()
            .filter(|e| matches!(e.event, RunEvent::ToolEvent { .. }))
            .collect();
        assert_eq!(tool_events.len(), 2);
        assert!(matches!(&tool_events[0].event, RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted { call_id, tool_name }
        } if call_id == "pending-call" && tool_name == "wait_for_release"));
        assert!(matches!(&tool_events[1].event, RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionFinished { call_id, tool_name, is_error }
        } if call_id == "pending-call" && tool_name == "wait_for_release" && *is_error == !release_before_timeout));
        assert_eq!(tool_events[0].request_id, tool_events[1].request_id);
        assert_eq!(tool_events[0].turn_id, tool_events[1].turn_id);
        assert_eq!(count(&tool.calls), 1);
        assert_eq!(count(&tool.dropped), 1);
        assert_eq!(count(&script.records.opens), 1);
        assert_eq!(count(&script.records.closes), 1);
        assert_eq!(Arc::strong_count(&tool), 2);
    }
}

struct ProbeTool {
    calls: AtomicUsize,
    dropped: Arc<AtomicUsize>,
    entered: Notify,
    mode: Mode,
    definitions: AtomicUsize,
}
enum Mode {
    Pending,
    PendingAfterFirst,
    Large,
    InvalidDefinition,
}
struct DropProbe(Arc<AtomicUsize>);
impl Drop for DropProbe {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
impl ProbeTool {
    fn new(mode: Mode) -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            dropped: Arc::new(AtomicUsize::new(0)),
            entered: Notify::new(),
            mode,
            definitions: AtomicUsize::new(0),
        })
    }
}
#[async_trait]
impl Tool for ProbeTool {
    fn definition(&self) -> ToolDefinition {
        let n = self.definitions.fetch_add(1, Ordering::SeqCst);
        let mut definition = wi::tools::add_numbers_definition();
        if matches!(self.mode, Mode::InvalidDefinition) && n > 0 {
            definition.parameters = Value::Null;
        }
        definition
    }
    fn validate(&self, args: &Value) -> wi::Result<()> {
        wi::tools::AddNumbers.validate(args)
    }
    async fn execute(&self, args: Value) -> wi::Result<Value> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        let _drop = DropProbe(self.dropped.clone());
        self.entered.notify_one();
        match self.mode {
            Mode::Pending => pending().await,
            Mode::PendingAfterFirst => {
                if n == 0 {
                    wi::tools::AddNumbers.execute(args).await
                } else {
                    pending().await
                }
            }
            Mode::Large => Ok(json!({"value":"x".repeat(70*1024)})),
            Mode::InvalidDefinition => panic!("invalid definition admitted"),
        }
    }
}

#[tokio::test]
async fn run_invalid_snapshot_definition_is_checked_once_before_open() {
    let (gateway, script, _) = setup(vec![]);
    let tool = ProbeTool::new(Mode::InvalidDefinition);
    let mut tools = ToolRegistry::new();
    tools.register(tool.clone()).unwrap();
    assert!(
        run(
            &gateway,
            request(),
            &tools,
            CancellationToken::new(),
            |_| panic!("no event")
        )
        .await
        .is_err()
    );
    assert_eq!(count(&tool.definitions), 2);
    assert_eq!(count(&tool.calls), 0);
    assert_eq!(count(&script.records.opens), 0);
}

#[tokio::test(start_paused = true)]
async fn run_pending_tool_cancel_and_future_drop_no_fabricated_finish() {
    for stop in ["cancel", "drop"] {
        let (gateway, script, _) = setup(vec![Step::Response(response(
            "r1",
            vec![call("c1", 17, 25), call("c2", 42, 8)],
            "",
        ))]);
        let tool = ProbeTool::new(Mode::Pending);
        let mut tools = ToolRegistry::new();
        tools.register(tool.clone()).unwrap();
        let token = CancellationToken::new();
        let mut events = Vec::new();
        let mut future = Box::pin(run(&gateway, request(), &tools, token.clone(), |event| {
            events.push(event.clone());
            Ok(())
        }));
        assert!(futures_util::poll!(&mut future).is_pending());
        tool.entered.notified().await;
        if stop == "drop" {
            drop(future);
        } else {
            token.cancel();
            let result = future.await.unwrap();
            assert_eq!(result.outcome, RunOutcome::CancelledLocally);
            assert_eq!(result.summary.new_tool_dispatches, 1);
            assert_eq!(result.summary.tool_results_prepared, 0);
            assert_eq!(
                result.summary.last_upstream_outcome,
                Some(UpstreamOutcome::TerminalReceived)
            );
        }
        assert_eq!(count(&tool.calls), 1);
        assert_eq!(count(&tool.dropped), 1);
        assert_eq!(count(&script.records.closes), 1);
        assert_eq!(count(&script.records.attempts), 1);
        assert!(!events.iter().any(|e| matches!(
            e.event,
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionFinished { .. }
            }
        )));
    }
}

#[tokio::test]
async fn run_cancel_after_completed_turn_preserves_results_and_drops_later_tool() {
    let (gateway, script, _) = setup(vec![
        Step::Response(response("r1", vec![call("c1", 17, 25)], "")),
        Step::Response(response("r2", vec![call("c2", 42, 8)], "")),
    ]);
    let tool = ProbeTool::new(Mode::PendingAfterFirst);
    let mut tools = ToolRegistry::new();
    tools.register(tool.clone()).unwrap();
    let token = CancellationToken::new();
    let mut events = Vec::new();
    let mut future = Box::pin(run(&gateway, request(), &tools, token.clone(), |event| {
        events.push(event.clone());
        Ok(())
    }));
    assert!(futures_util::poll!(&mut future).is_pending());
    assert_eq!(count(&tool.calls), 2);
    token.cancel();
    let result = future.await.unwrap();
    assert_eq!(result.outcome, RunOutcome::CancelledLocally);
    assert_eq!(result.summary.model_requests_attempted, 2);
    assert_eq!(result.summary.tool_results_prepared, 1);
    assert_eq!(result.summary.new_tool_dispatches, 2);
    assert_eq!(result.summary.turns_finished, 2);
    assert_eq!(
        result.summary.last_upstream_outcome,
        Some(UpstreamOutcome::TerminalReceived)
    );
    assert_eq!(count(&tool.dropped), 2);
    assert_eq!(count(&script.records.closes), 1);
    let inputs = script.records.inputs.lock().unwrap();
    assert_eq!(inputs.len(), 2);
    assert_eq!(
        value(&inputs[1]),
        json!([{"kind":"tool_result","call_id":"c1","output":"{\"sum\":42}"}])
    );
    let finished: Vec<_> = events
        .iter()
        .filter_map(|event| match &event.event {
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionFinished { call_id, .. },
            } => Some(call_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(finished, ["c1"]);
}

#[tokio::test]
async fn run_cancel_boundaries_never_submit_partial_batch_or_rewrite_terminal() {
    for boundary in [
        "run_started",
        "turn_started",
        "provider_terminal",
        "tool_start",
        "tool_finish",
        "turn_finish",
        "run_finish",
    ] {
        let (gateway, script, tools) = setup(vec![
            Step::Response(response(
                "r1",
                vec![call("c1", 17, 25), call("c2", 42, 8)],
                "",
            )),
            Step::Response(response("r2", vec![], "50")),
        ]);
        let token = CancellationToken::new();
        let mut events = Vec::new();
        let result = run(&gateway, request(), &tools, token.clone(), |event| {
            let matched = match boundary {
                "run_started" => matches!(event.event, RunEvent::RunStarted),
                "turn_started" => matches!(event.event, RunEvent::TurnStarted { .. }),
                "provider_terminal" => matches!(
                    &event.event,
                    RunEvent::ProviderEvent { event }
                        if matches!(event.event, ProviderEvent::ResponseFinished { .. })
                ),
                "tool_start" => matches!(
                    event.event,
                    RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolExecutionStarted { .. }
                    }
                ),
                "tool_finish" => matches!(
                    event.event,
                    RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolExecutionFinished { .. }
                    }
                ),
                "turn_finish" => matches!(
                    event.event,
                    RunEvent::TurnFinished {
                        outcome: TurnOutcome::ModelCompleted,
                        ..
                    }
                ),
                _ => matches!(event.event, RunEvent::RunFinished { .. }),
            };
            if matched {
                token.cancel();
            }
            events.push(event.clone());
            Ok(())
        })
        .await
        .unwrap();
        if boundary == "turn_finish" || boundary == "run_finish" {
            assert_eq!(result.outcome, RunOutcome::Completed);
        } else {
            assert_eq!(result.outcome, RunOutcome::CancelledLocally);
        }
        match boundary {
            "run_started" => {
                assert_eq!(count(&script.records.opens), 0);
                assert_eq!(result.summary.last_upstream_outcome, None);
            }
            "turn_started" => {
                assert_eq!(count(&script.records.attempts), 0);
                assert_eq!(
                    result.summary.last_upstream_outcome,
                    Some(UpstreamOutcome::NotSubmitted)
                );
            }
            "provider_terminal" => {
                assert_eq!(count(&script.records.attempts), 1);
                assert_eq!(count(&script.records.tool_calls), 0);
                assert_eq!(result.summary.new_tool_dispatches, 0);
                assert_eq!(result.summary.tool_results_prepared, 0);
                assert_eq!(
                    result.summary.last_upstream_outcome,
                    Some(UpstreamOutcome::TerminalReceived)
                );
            }
            "tool_start" => {
                assert_eq!(count(&script.records.tool_calls), 0);
                assert_eq!(result.summary.new_tool_dispatches, 1);
                assert_eq!(result.summary.tool_results_prepared, 0);
            }
            "tool_finish" => {
                assert_eq!(count(&script.records.tool_calls), 1);
                assert_eq!(result.summary.tool_results_prepared, 1);
                assert_eq!(count(&script.records.attempts), 1);
            }
            _ => {}
        }
        assert_eq!(result.summary.turns_started, result.summary.turns_finished);
        assert_eq!(trace(&events).last(), Some(&"run_finished"));
    }
}

#[tokio::test]
async fn run_cancel_on_completed_no_call_provider_terminal_preserves_completion() {
    let mut terminal = response("r1", vec![], "hello");
    terminal.output_provenance = OutputProvenance::ValidatedOutputItemDone;
    let expected = serde_json::to_value(&terminal).unwrap();
    let (gateway, script, tools) = setup(vec![Step::Response(terminal)]);
    let token = CancellationToken::new();
    let mut events = Vec::new();
    let result = run(&gateway, request(), &tools, token.clone(), |event| {
        if let RunEvent::ProviderEvent { event: nested } = &event.event
            && let ProviderEvent::ResponseFinished { response } = &nested.event
            && response.outcome == ResponseOutcome::Completed
            && !response
                .output
                .iter()
                .any(|item| item.kind == ItemKind::FunctionCall)
        {
            token.cancel();
        }
        events.push(event.clone());
        Ok(())
    })
    .await
    .unwrap();

    assert!(token.is_cancelled());
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(
        serde_json::to_value(result.last_response.as_ref().unwrap()).unwrap(),
        expected
    );
    assert_eq!(
        result.summary.last_upstream_outcome,
        Some(UpstreamOutcome::TerminalReceived)
    );
    assert_eq!(result.summary.model_requests_attempted, 1);
    assert_eq!(result.summary.model_requests_admitted, 1);
    assert_eq!(result.summary.new_tool_dispatches, 0);
    assert_eq!(result.summary.tool_results_prepared, 0);
    assert_eq!(result.summary.reused_results, 0);
    assert_eq!(result.summary.turns_started, 1);
    assert_eq!(result.summary.turns_finished, 1);
    let inputs = script.records.inputs.lock().unwrap();
    assert_eq!(inputs.len(), 1);
    assert_eq!(
        value(&inputs[0]),
        value(&[InputItem::user(request().prompt)])
    );
    assert_eq!(
        trace(&events),
        [
            "run_started",
            "turn_started",
            "provider_event",
            "provider_event",
            "turn_finished",
            "run_finished"
        ]
    );
    assert!(matches!(
        &events[4].event,
        RunEvent::TurnFinished {
            number: 1,
            response_id: Some(id),
            outcome: TurnOutcome::ModelCompleted,
            upstream_outcome: Some(UpstreamOutcome::TerminalReceived),
        } if id == "r1"
    ));
    assert!(matches!(
        events[5].event,
        RunEvent::RunFinished {
            outcome: RunOutcome::Completed,
            ..
        }
    ));
    healthy(&result, &events, &script.records);
}

#[tokio::test]
async fn run_ordinary_tool_errors_and_output_bounds_are_correlated_results() {
    for oversized in [false, true] {
        let (gateway, script, mut tools) = setup(vec![
            Step::Response(response("r1", vec![call("c1", i64::MAX, 1)], "")),
            Step::Response(response("r2", vec![], "handled")),
        ]);
        if oversized {
            tools = ToolRegistry::new();
            tools.register(ProbeTool::new(Mode::Large)).unwrap();
        }
        let (result, events) = observed(&gateway, request(), &tools).await;
        assert_eq!(result.outcome, RunOutcome::Completed);
        assert_eq!(result.summary.tool_results_prepared, 1);
        let inputs = script.records.inputs.lock().unwrap();
        let InputItem::ToolResult { call_id, output } = &inputs[1][0] else {
            panic!("expected result")
        };
        assert_eq!(call_id, "c1");
        assert!(output.len() < 64 * 1024);
        assert_eq!(
            serde_json::from_str::<Value>(output).unwrap()["error"]["code"],
            if oversized {
                "tool_output_limit"
            } else {
                "gateway_error"
            }
        );
        assert!(events.iter().any(|e| matches!(
            e.event,
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionFinished { is_error: true, .. }
            }
        )));
    }
}

#[tokio::test]
async fn run_sink_finish_and_reuse_failures_stop_without_prepared_results() {
    for reuse in [false, true] {
        let (gateway, script, tools) = setup(vec![
            Step::Response(response(
                "r1",
                if reuse {
                    vec![call("c1", 17, 25)]
                } else {
                    vec![call("c1", 17, 25), call("unused", 1, 2)]
                },
                "",
            )),
            Step::Response(response(
                "r2",
                vec![call("c1", 17, 25), call("c2", 42, 8)],
                "",
            )),
        ]);
        let seen = Mutex::new(false);
        let result = run(
            &gateway,
            request(),
            &tools,
            CancellationToken::new(),
            |event| {
                assert!(!*seen.lock().unwrap());
                let matched = if reuse {
                    matches!(
                        event.event,
                        RunEvent::ToolEvent {
                            event: ToolExecutionEvent::ToolResultReused { .. }
                        }
                    )
                } else {
                    matches!(
                        event.event,
                        RunEvent::ToolEvent {
                            event: ToolExecutionEvent::ToolExecutionFinished { .. }
                        }
                    )
                };
                if matched {
                    *seen.lock().unwrap() = true;
                    Err(RunSinkError::Closed)
                } else {
                    Ok(())
                }
            },
        )
        .await
        .unwrap();
        failed_as(&result, "event_sink");
        assert_eq!(count(&script.records.tool_calls), 1);
        assert_eq!(
            result.summary.tool_results_prepared,
            if reuse { 1 } else { 0 }
        );
        assert_eq!(count(&script.records.attempts), if reuse { 2 } else { 1 });
    }
}
