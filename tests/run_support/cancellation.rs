use super::run_support::*;
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use wi::{
    run::*,
    tools::{ToolExecutionEvent, ToolRegistry},
    *,
};

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
