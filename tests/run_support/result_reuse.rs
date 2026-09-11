use super::run_support::*;
use wi::{run::*, tools::ToolExecutionEvent, *};

#[tokio::test]
async fn run_cached_batches_reuse_results_without_new_dispatch() {
    let (gateway, script, tools) = setup(vec![
        Step::Response(response("r1", vec![call("c1", 17, 25)], "")),
        Step::Response(response("r2", vec![call("c1", 17, 25)], "")),
        Step::Response(response("r3", vec![], "42")),
    ]);
    let (result, events) = observed(&gateway, request(), &tools).await;
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(result.summary.new_tool_dispatches, 1);
    assert_eq!(result.summary.reused_results, 1);
    assert_eq!(result.summary.tool_results_prepared, 2);
    assert_eq!(result.summary.model_requests_attempted, 3);
    let inputs = script.records.inputs.lock().unwrap();
    assert_eq!(value(&inputs[1]), value(&inputs[2]));
    healthy(&result, &events, &script.records);
}

#[tokio::test]
async fn run_scope_isolation_conflicts_mixed_cache_and_capacity() {
    let (gateway, script, mut tools) = setup(vec![]);
    let first = response("r1", vec![call("same", 17, 25)], "");
    tools.execute_response(&first, |_| {}).await.unwrap();
    let mut run_ids = Vec::new();
    for _ in 0..2 {
        *script.steps.lock().unwrap() = vec![
            Step::Response(first.clone()),
            Step::Response(response("final", vec![], "42")),
        ]
        .into();
        let (result, _) = observed(&gateway, request(), &tools).await;
        assert_eq!(result.outcome, RunOutcome::Completed);
        assert_eq!(result.summary.new_tool_dispatches, 1);
        assert_eq!(result.summary.reused_results, 0);
        run_ids.push((result.run_id, result.session_id));
    }
    assert_ne!(run_ids[0], run_ids[1]);
    assert_eq!(count(&script.records.opens), 2);
    assert_eq!(count(&script.records.closes), 2);
    let mut reused = false;
    tools
        .execute_response(&first, |event| {
            reused = matches!(event, ToolExecutionEvent::ToolResultReused { .. })
        })
        .await
        .unwrap();
    assert!(reused);
    for changed in [false, true] {
        let mut next = call("same", 17, 25);
        if changed {
            next.function_call.as_mut().unwrap().arguments = "{\"a\":1,\"b\":2}".into();
        }
        let (gateway, _, tools) = setup(vec![
            Step::Response(first.clone()),
            Step::Response(response("r2", vec![next, call("new", 42, 8)], "")),
            Step::Response(response("r3", vec![], "50")),
        ]);
        let (result, _) = observed(&gateway, request(), &tools).await;
        if changed {
            failed_as(&result, "tool_preflight");
            assert_eq!(result.summary.new_tool_dispatches, 1);
            assert_eq!(result.summary.reused_results, 0);
        } else {
            assert_eq!(result.outcome, RunOutcome::Completed);
            assert_eq!(result.summary.new_tool_dispatches, 2);
            assert_eq!(result.summary.reused_results, 1);
        }
    }
    for new_after_160 in [false, true] {
        let mut steps = Vec::new();
        for batch in 0..20 {
            steps.push(Step::Response(response(
                &format!("r{batch}"),
                (0..8)
                    .map(|i| call(&format!("c{}", batch * 8 + i), 1, 2))
                    .collect(),
                "",
            )));
        }
        steps.push(Step::Response(response(
            "after-160",
            vec![call(if new_after_160 { "new" } else { "c0" }, 1, 2)],
            "",
        )));
        steps.push(Step::Response(response("final", vec![], "3")));
        let (gateway, _, tools) = setup(steps);
        let (result, _) = observed(&gateway, request(), &tools).await;
        assert_eq!(result.outcome, RunOutcome::Completed);
        assert_eq!(
            result.summary.new_tool_dispatches,
            if new_after_160 { 161 } else { 160 }
        );
        assert_eq!(
            result.summary.reused_results,
            if new_after_160 { 0 } else { 1 }
        );
    }
    let (gateway, _, tools) = setup(vec![Step::Response(response(
        "r1",
        (0..=MAX_INPUT_ITEMS)
            .map(|i| call(&format!("c{i}"), 1, 2))
            .collect(),
        "",
    ))]);
    let (result, _) = observed(&gateway, request(), &tools).await;
    failed_as(&result, "tool_preflight");
    assert_eq!(result.summary.new_tool_dispatches, 0);
}
