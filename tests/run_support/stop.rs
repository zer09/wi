use super::*;
use async_trait::async_trait;
use serde_json::Value;
use std::{
    future::pending,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::Notify,
    time::{Instant, advance},
};
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

#[tokio::test(start_paused = true)]
async fn run_deadline_open_generate_receipt_and_cancel_priority() {
    for phase in ["open", "generate", "receipt"] {
        for cancel_too in [false, true] {
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
            let mut req = request();
            req.limits.deadline = Duration::from_secs(10);
            let mut future = Box::pin(run(&gateway, req, &tools, token.clone(), |_| Ok(())));
            assert!(futures_util::poll!(&mut future).is_pending());
            advance(Duration::from_secs(10)).await;
            if cancel_too {
                token.cancel();
            }
            let result = future.await.unwrap();
            assert_eq!(
                result.outcome,
                if cancel_too {
                    RunOutcome::CancelledLocally
                } else {
                    RunOutcome::LimitReached {
                        limit: LimitKind::Deadline,
                    }
                }
            );
            assert_eq!(count(&records.opens), 1);
            assert_eq!(
                count(&records.attempts),
                if phase == "open" { 0 } else { 1 }
            );
            assert_eq!(count(&records.closes), if phase == "open" { 0 } else { 1 });
        }
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
    Large,
    Delay,
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
            Mode::Large => Ok(json!({"value":"x".repeat(70*1024)})),
            Mode::Delay => {
                if n == 0 {
                    tokio::time::sleep(Duration::from_secs(6)).await;
                } else {
                    pending::<()>().await;
                }
                wi::tools::AddNumbers.execute(args).await
            }
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
async fn run_pending_tool_cancel_deadline_and_future_drop_no_fabricated_finish() {
    for stop in ["cancel", "deadline", "both", "drop"] {
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
        let mut req = request();
        req.limits.deadline = Duration::from_secs(10);
        let mut future = Box::pin(run(&gateway, req, &tools, token.clone(), |event| {
            events.push(event.clone());
            Ok(())
        }));
        assert!(futures_util::poll!(&mut future).is_pending());
        tool.entered.notified().await;
        if stop == "drop" {
            drop(future);
        } else {
            if stop == "deadline" || stop == "both" {
                advance(Duration::from_secs(10)).await;
            }
            if stop == "cancel" || stop == "both" {
                token.cancel();
            }
            let result = future.await.unwrap();
            assert_eq!(
                result.outcome,
                if stop == "deadline" {
                    RunOutcome::LimitReached {
                        limit: LimitKind::Deadline,
                    }
                } else {
                    RunOutcome::CancelledLocally
                }
            );
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

#[tokio::test(start_paused = true)]
async fn run_absolute_deadline_includes_completed_turn_and_later_tool() {
    let (gateway, script, _) = setup(vec![
        Step::Response(response("r1", vec![call("c1", 17, 25)], "")),
        Step::Response(response("r2", vec![call("c2", 42, 8)], "")),
    ]);
    let tool = ProbeTool::new(Mode::Delay);
    let mut tools = ToolRegistry::new();
    tools.register(tool.clone()).unwrap();
    let mut req = request();
    req.limits.deadline = Duration::from_secs(10);
    let start = Instant::now();
    let result = run(&gateway, req, &tools, CancellationToken::new(), |_| Ok(()))
        .await
        .unwrap();
    assert_eq!(Instant::now() - start, Duration::from_secs(10));
    assert_eq!(
        result.outcome,
        RunOutcome::LimitReached {
            limit: LimitKind::Deadline
        }
    );
    assert_eq!(result.summary.model_requests_attempted, 2);
    assert_eq!(result.summary.tool_results_prepared, 1);
    assert_eq!(result.summary.new_tool_dispatches, 2);
    assert_eq!(count(&tool.calls), 2);
    assert_eq!(count(&tool.dropped), 2);
    assert_eq!(count(&script.records.closes), 1);
}

#[tokio::test]
async fn run_cancel_boundaries_never_submit_partial_batch_or_rewrite_terminal() {
    for boundary in [
        "run_started",
        "turn_started",
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
                "run_started" => matches!(event.event, RunEvent::RunStarted { .. }),
                "turn_started" => matches!(event.event, RunEvent::TurnStarted { .. }),
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
