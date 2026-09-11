use super::run_support::*;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use wi::{
    run::*,
    tools::{Tool, ToolExecutionEvent, ToolRegistry},
    *,
};

#[tokio::test]
async fn run_a_b_c_exact_inputs_order_and_lifecycle() {
    for cycles in [1, 2] {
        let mut steps = vec![Step::Response(response("r1", vec![call("c1", 17, 25)], ""))];
        if cycles == 2 {
            steps.push(Step::Response(response("r2", vec![call("c2", 42, 8)], "")));
        }
        steps.push(Step::Response(response(
            "final",
            vec![],
            if cycles == 1 { "42" } else { "50" },
        )));
        let (gateway, script, tools) = setup(steps);
        let (result, events) = observed(&gateway, request(), &tools).await;
        assert_eq!(result.outcome, RunOutcome::Completed);
        assert_eq!(result.summary.new_tool_dispatches, cycles);
        assert_eq!(result.summary.tool_results_prepared, cycles);
        assert_eq!(result.summary.turns_started, cycles + 1);
        let inputs = script.records.inputs.lock().unwrap();
        assert_eq!(
            value(&inputs[0]),
            json!([{"kind":"user","text":"add the numbers"}])
        );
        assert_eq!(
            value(&inputs[1]),
            json!([{"kind":"tool_result","call_id":"c1","output":"{\"sum\":42}"}])
        );
        if cycles == 2 {
            assert_eq!(
                value(&inputs[2]),
                json!([{"kind":"tool_result","call_id":"c2","output":"{\"sum\":50}"}])
            );
        }
        for window in trace(&events).windows(5).filter(|w| w[0] == "tool_event") {
            if window[1] == "tool_event" {
                assert_eq!(window[2], "turn_finished");
                assert_eq!(window[3], "turn_started");
            }
        }
        healthy(&result, &events, &script.records);
    }
    let (gateway, script, tools) = setup(vec![
        Step::Response(response(
            "r1",
            vec![call("c1", 17, 25), call("c2", 42, 8)],
            "",
        )),
        Step::Response(response("r2", vec![], "50")),
    ]);
    let (result, events) = observed(&gateway, request(), &tools).await;
    assert_eq!(result.summary.new_tool_dispatches, 2);
    assert_eq!(
        value(&script.records.inputs.lock().unwrap()[1]),
        json!([{"kind":"tool_result","call_id":"c1","output":"{\"sum\":42}"},{"kind":"tool_result","call_id":"c2","output":"{\"sum\":50}"}])
    );
    let calls: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.event {
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionStarted { call_id, .. },
            } => Some(call_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(calls, ["c1", "c2"]);
    healthy(&result, &events, &script.records);
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
