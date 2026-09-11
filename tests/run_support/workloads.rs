use super::run_support::*;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use wi::{run::*, tools::ToolExecutionEvent, *};

#[tokio::test]
async fn run_l_160_distinct_calls_then_final_uses_161_requests() {
    let mut steps: Vec<_> = (0..160)
        .map(|i| {
            Step::Response(response(
                &format!("r{i}"),
                vec![call(&format!("c{i}"), i, 1)],
                "",
            ))
        })
        .collect();
    steps.push(Step::Response(response("final", vec![], "160")));
    let (gateway, script, tools) = setup(steps);
    let owners = Arc::strong_count(&script.records);
    let (result, events) = tokio::time::timeout(
        Duration::from_secs(5),
        observed(&gateway, request(), &tools),
    )
    .await
    .unwrap();
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(result.summary.model_requests_attempted, 161);
    assert_eq!(result.summary.model_requests_admitted, 161);
    assert_eq!(result.summary.turns_started, 161);
    assert_eq!(result.summary.turns_finished, 161);
    assert_eq!(result.summary.new_tool_dispatches, 160);
    assert_eq!(result.summary.tool_results_prepared, 160);
    assert_eq!(result.summary.reused_results, 0);
    assert_eq!(result.last_response.as_ref().unwrap().text, "160");
    {
        let inputs = script.records.inputs.lock().unwrap();
        assert_eq!(inputs.len(), 161);
        assert_eq!(
            value(&inputs[0]),
            value(&[InputItem::user(request().prompt)])
        );
        let tool_events: Vec<_> = events
            .iter()
            .filter(|e| matches!(e.event, RunEvent::ToolEvent { .. }))
            .collect();
        assert_eq!(tool_events.len(), 320);
        for i in 0..160 {
            assert_eq!(
                value(&inputs[i + 1]),
                json!([{"kind":"tool_result","call_id":format!("c{i}"),"output":json!({"sum":i+1}).to_string()}])
            );
            let start = tool_events[i * 2];
            let finish = tool_events[i * 2 + 1];
            assert!(matches!(&start.event, RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionStarted { call_id, tool_name },
            } if call_id == &format!("c{i}") && tool_name == "add_numbers"));
            assert!(matches!(&finish.event, RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionFinished { call_id, tool_name, is_error: false },
            } if call_id == &format!("c{i}") && tool_name == "add_numbers"));
            assert_eq!(
                start.request_id.as_deref(),
                Some(format!("q{}", i + 1).as_str())
            );
            assert_eq!(start.request_id, finish.request_id);
            assert_eq!(start.turn_id, finish.turn_id);
            assert_eq!(start.session_id, result.session_id);
            assert_eq!(start.sequence + 1, finish.sequence);
        }
    }
    healthy(&result, &events, &script.records);
    for _ in 0..3 {
        tokio::task::yield_now().await;
    }
    assert_eq!(count(&script.records.tool_calls), 160);
    assert_eq!(count(&script.records.attempts), 161);
    assert_eq!(count(&script.records.closes), 1);
    assert_eq!(
        Arc::strong_count(&script.records),
        owners,
        "no retained session or tool work"
    );
}

#[tokio::test]
async fn run_c_nine_calls_execute_and_submit_in_order() {
    let (gateway, script, tools) = setup(vec![
        Step::Response(response(
            "batch",
            (0..9).map(|i| call(&format!("c{i}"), i, 1)).collect(),
            "",
        )),
        Step::Response(response("final", vec![], "9")),
    ]);
    let (result, events) = observed(&gateway, request(), &tools).await;
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(result.summary.model_requests_admitted, 2);
    assert_eq!(result.summary.new_tool_dispatches, 9);
    assert_eq!(result.summary.tool_results_prepared, 9);
    assert_eq!(result.summary.reused_results, 0);
    let expected: Vec<_> = (0..9).map(|i| json!({"kind":"tool_result","call_id":format!("c{i}"),"output":json!({"sum":i+1}).to_string()})).collect();
    assert_eq!(
        value(&script.records.inputs.lock().unwrap()[1]),
        json!(expected)
    );
    let tool_events: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.event {
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionStarted { call_id, .. },
            } => Some(("start", call_id.clone())),
            RunEvent::ToolEvent {
                event:
                    ToolExecutionEvent::ToolExecutionFinished {
                        call_id,
                        is_error: false,
                        ..
                    },
            } => Some(("finish", call_id.clone())),
            RunEvent::ToolEvent { .. } => panic!("unexpected tool event"),
            _ => None,
        })
        .collect();
    let expected: Vec<_> = (0..9)
        .flat_map(|i| [("start", format!("c{i}")), ("finish", format!("c{i}"))])
        .collect();
    assert_eq!(tool_events, expected);
    healthy(&result, &events, &script.records);
}
