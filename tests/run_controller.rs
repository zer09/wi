#[path = "run_support/boundaries.rs"]
mod boundaries;
#[path = "run_support/context.rs"]
mod context;
mod run_support;
#[path = "run_support/stop.rs"]
mod stop;
#[path = "run_support/workloads.rs"]
mod workloads;
use run_support::*;
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use wi::{
    run::*,
    tools::{ToolExecutionEvent, ToolRegistry},
    *,
};

async fn observed(
    gateway: &Gateway,
    req: RunRequest,
    tools: &ToolRegistry,
) -> (RunResult, Vec<RunEventEnvelope>) {
    let mut events = Vec::new();
    let result = run(gateway, req, tools, CancellationToken::new(), |event| {
        events.push(event.clone());
        Ok(())
    })
    .await
    .unwrap();
    (result, events)
}
fn trace(events: &[RunEventEnvelope]) -> Vec<&str> {
    events
        .iter()
        .map(|e| match e.event {
            RunEvent::RunStarted => "run_started",
            RunEvent::TurnStarted { .. } => "turn_started",
            RunEvent::ProviderEvent { .. } => "provider_event",
            RunEvent::ToolEvent { .. } => "tool_event",
            RunEvent::TurnFinished { .. } => "turn_finished",
            RunEvent::RunFinished { .. } => "run_finished",
        })
        .collect()
}
fn failed_as(result: &RunResult, code: &str) {
    assert_eq!(result.outcome, RunOutcome::Failed { code: code.into() });
}
fn healthy(result: &RunResult, events: &[RunEventEnvelope], records: &Records) {
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    assert_eq!(count(&records.opens), 1);
    assert_eq!(count(&records.closes), 1);
    assert_eq!(
        result.summary.model_requests_attempted as usize,
        count(&records.attempts)
    );
    assert_eq!(
        result.summary.model_requests_admitted as usize,
        count(&records.receipts)
    );
    assert_eq!(
        result.summary.new_tool_dispatches as usize,
        count(&records.tool_calls)
    );
    assert_eq!(count(&records.definitions), 2);
    assert_eq!(result.summary.turns_started, result.summary.turns_finished);
    assert_eq!(trace(events).first(), Some(&"run_started"));
    assert_eq!(trace(events).last(), Some(&"run_finished"));
    let mut ids = std::collections::HashSet::new();
    let mut turns = std::collections::HashSet::new();
    for (i, event) in events.iter().enumerate() {
        assert_eq!(event.schema_version, 2);
        assert_eq!(event.sequence, i as u64 + 1);
        assert_eq!(event.run_id, result.run_id);
        assert!(uuid::Uuid::parse_str(&event.event_id).is_ok());
        assert!(ids.insert(&event.event_id));
        match &event.event {
            RunEvent::RunStarted => {
                assert!(
                    event.session_id.is_none()
                        && event.turn_id.is_none()
                        && event.request_id.is_none()
                );
            }
            RunEvent::RunFinished { summary, .. } => {
                assert!(event.turn_id.is_none());
                assert_eq!(
                    serde_json::to_value(summary).unwrap(),
                    serde_json::to_value(&result.summary).unwrap()
                );
            }
            RunEvent::TurnStarted { number } => {
                assert!(event.request_id.is_none());
                assert!(turns.insert(event.turn_id.clone().unwrap()));
                assert_eq!(*number as usize, turns.len());
            }
            RunEvent::ProviderEvent { event: nested } => {
                assert_eq!(nested.schema_version, 1);
                assert_eq!(event.request_id, nested.request_id);
                assert_eq!(event.session_id.as_ref(), Some(&nested.session_id));
                assert!(
                    records
                        .events
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|record| serde_json::to_value(record).unwrap()
                            == serde_json::to_value(nested).unwrap())
                );
            }
            _ => {}
        }
    }
}

#[test]
fn run_request_contains_only_task_fields_and_rejects_obsolete_configuration() {
    let expected = json!({
        "provider_id": ID,
        "options": SessionOptions::new("opaque-model"),
        "prompt": "add the numbers",
    });
    assert_eq!(serde_json::to_value(request()).unwrap(), expected);
    let decoded: RunRequest = serde_json::from_value(expected.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), expected);
    for (field, value) in [
        ("limits", serde_json::Value::Null),
        (
            "limits",
            json!({"max_model_requests":4,"max_tool_executions":8,"deadline":{"secs":120,"nanos":0}}),
        ),
        ("unexpected", serde_json::Value::Null),
    ] {
        let mut obsolete = expected.clone();
        obsolete[field] = value;
        let error = serde_json::from_value::<RunRequest>(obsolete)
            .err()
            .unwrap();
        assert!(error.to_string().contains("unknown field"), "{error}");
    }
}

#[test]
fn run_outcome_accepts_only_execution_outcomes() {
    for outcome in [
        RunOutcome::Completed,
        RunOutcome::Failed {
            code: "synthetic".into(),
        },
        RunOutcome::CancelledLocally,
    ] {
        let encoded = serde_json::to_value(&outcome).unwrap();
        assert_eq!(
            serde_json::from_value::<RunOutcome>(encoded).unwrap(),
            outcome
        );
    }
    for limit in ["model_requests", "tool_executions", "deadline"] {
        assert!(
            serde_json::from_value::<RunOutcome>(json!({
                "type": "limit_reached", "limit": limit,
            }))
            .is_err()
        );
    }
}

#[tokio::test]
async fn run_started_is_payload_free_in_schema_two() {
    let (gateway, script, tools) = setup(vec![Step::Response(response("r1", vec![], "hello"))]);
    let (result, events) = observed(&gateway, request(), &tools).await;
    let started = &events[0];
    assert_eq!(
        serde_json::to_value(started).unwrap(),
        json!({
            "schema_version": 2,
            "sequence": 1,
            "event_id": started.event_id,
            "run_id": result.run_id,
            "turn_id": null,
            "session_id": null,
            "request_id": null,
            "type": "run_started",
        })
    );
    healthy(&result, &events, &script.records);
}

#[tokio::test]
async fn run_t_empty_reasoning_refusal_and_provenance_are_terminal() {
    for kind in [None, Some(ItemKind::Message), Some(ItemKind::Reasoning)] {
        for provenance in [
            OutputProvenance::NativeTerminal,
            OutputProvenance::ValidatedOutputItemDone,
        ] {
            let output = kind
                .clone()
                .map(|kind| OutputItem {
                    id: Some("opaque".into()),
                    kind,
                    native_type: "refusal-or-reasoning".into(),
                    function_call: None,
                    native: json!({"independent_content":"refusal"}),
                })
                .into_iter()
                .collect();
            let mut final_response =
                response("r1", output, if kind.is_none() { "" } else { "hello" });
            final_response.output_provenance = provenance;
            let expected = serde_json::to_value(&final_response).unwrap();
            let (gateway, script, tools) = setup(vec![Step::Response(final_response)]);
            let (result, events) = observed(&gateway, request(), &tools).await;
            assert_eq!(result.outcome, RunOutcome::Completed);
            assert_eq!(
                serde_json::to_value(result.last_response.as_ref().unwrap()).unwrap(),
                expected
            );
            assert_eq!(result.summary.new_tool_dispatches, 0);
            assert_eq!(
                result.summary.last_upstream_outcome,
                Some(UpstreamOutcome::TerminalReceived)
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
            healthy(&result, &events, &script.records);
        }
    }
}

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

#[tokio::test]
async fn run_preadmission_rejects_without_observation_or_work() {
    for case in 0..14 {
        let mut script = Script::new(vec![]);
        let mut req = request();
        let token = CancellationToken::new();
        let mut tools = ToolRegistry::new();
        tools.register(Arc::new(wi::tools::AddNumbers)).unwrap();
        match case {
            0 => req.prompt.clear(),
            1 => req.prompt = "x".repeat(MAX_INPUT_BYTES),
            2 => req.options.tools = tools.definitions(),
            3 => req.provider_id = "absent".into(),
            4 => script.capabilities.websocket.implemented = false,
            5 => {
                req.options.transport = Transport::Sse;
                script.capabilities.sse.implemented = false;
            }
            6 => script.capabilities.function_tools.implemented = false,
            7 => token.cancel(),
            8 => req.options.model.clear(),
            9 => req.options.instructions = "x".repeat(MAX_INPUT_BYTES),
            10..=13 => {
                req.options.required_features = vec![
                    [
                        Feature::NativeSteering,
                        Feature::ToolSearch,
                        Feature::ProgrammaticTools,
                        Feature::AsyncTools,
                    ][case - 10],
                ]
            }
            _ => unreachable!(),
        }
        let records = script.records.clone();
        let mut gateway = Gateway::new();
        gateway.register(Arc::new(script)).unwrap();
        assert!(
            run(&gateway, req, &tools, token, |_| panic!(
                "preadmission event case {case}"
            ))
            .await
            .is_err()
        );
        assert_eq!(count(&records.opens), 0);
        assert_eq!(count(&records.attempts), 0);
    }
    let (gateway, script, _) = setup(vec![Step::Response(response("r1", vec![], "hello"))]);
    let (result, _) = observed(&gateway, request(), &ToolRegistry::new()).await;
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(script.records.options.lock().unwrap()[0].tools.is_empty());
}

#[tokio::test]
async fn run_preadmission_requires_continuation_for_tools_in_check_order() {
    for (transport, function_tools, expected) in [
        (false, false, "transport"),
        (true, false, "function_tools"),
        (true, true, "continuation"),
    ] {
        let (gateway, mut script, tools) = setup(vec![
            Step::Response(response("r1", vec![call("c1", 17, 25)], "")),
            Step::Response(response("r2", vec![], "42")),
        ]);
        drop(gateway);
        let capabilities = &mut Arc::get_mut(&mut script).unwrap().capabilities;
        capabilities.websocket.implemented = transport;
        capabilities.function_tools.implemented = function_tools;
        capabilities.continuation.implemented = false;
        let records = script.records.clone();
        let mut gateway = Gateway::new();
        gateway.register(script).unwrap();
        let mut events = Vec::new();
        let result = run(
            &gateway,
            request(),
            &tools,
            CancellationToken::new(),
            |event| {
                events.push(event.clone());
                Ok(())
            },
        )
        .await;
        assert!(
            matches!(result, Err(GatewayError::UnsupportedFeature(feature)) if feature == expected)
        );
        assert!(events.is_empty());
        assert_eq!(count(&records.opens), 0);
        assert_eq!(count(&records.attempts), 0);
        assert_eq!(count(&records.tool_calls), 0);
    }
}

#[tokio::test]
async fn run_text_only_does_not_require_continuation_or_function_tools() {
    let mut script = Script::new(vec![Step::Response(response("r1", vec![], "hello"))]);
    script.capabilities.continuation.implemented = false;
    script.capabilities.function_tools.implemented = false;
    let records = script.records.clone();
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(script)).unwrap();
    let (result, events) = observed(&gateway, request(), &ToolRegistry::new()).await;
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(result.last_response.as_ref().unwrap().text, "hello");
    assert_eq!(count(&records.attempts), 1);
    assert_eq!(count(&records.tool_calls), 0);
    assert!(records.options.lock().unwrap()[0].tools.is_empty());
    assert_eq!(count(&records.opens), 1);
    assert_eq!(count(&records.closes), 1);
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    assert_eq!(trace(&events).first(), Some(&"run_started"));
    assert_eq!(trace(&events).last(), Some(&"run_finished"));
}

#[tokio::test]
async fn run_whole_batch_invalid_authority_has_no_dispatch() {
    for case in 0..16 {
        let first = call("c1", 17, 25);
        let mut second = call("c2", 42, 8);
        let fc = second.function_call.as_mut().unwrap();
        match case {
            0 => fc.arguments = "{\"a\":".into(),
            1 => fc.arguments = "{\"a\":1,\"b\":2,\"extra\":3}".into(),
            2 => fc.arguments = "{\"a\":1.5,\"b\":2}".into(),
            3 => fc.name = "unknown".into(),
            4 => fc.call_id = "c1".into(),
            5 => fc.complete = false,
            6 => fc.namespace = Some("namespace".into()),
            7 => second.native = json!({"namespace":{"x":1}}),
            8 => second.native = json!({"namespace":7}),
            9 => second.native = json!({"namespace":"x"}),
            10 => fc.origin = CallOrigin::Programmatic,
            11 => fc.origin = CallOrigin::Unknown,
            12 => second.kind = ItemKind::Unknown,
            13 => second.function_call = None,
            14 => fc.call_id = "x".repeat(513),
            15 => fc.call_id.clear(),
            _ => unreachable!(),
        }
        let (gateway, script, tools) = setup(vec![Step::Response(response(
            "r1",
            vec![first, second],
            "",
        ))]);
        let (result, events) = observed(&gateway, request(), &tools).await;
        assert!(
            matches!(result.outcome, RunOutcome::Failed { .. }),
            "case {case}"
        );
        assert_eq!(result.summary.new_tool_dispatches, 0);
        assert_eq!(result.summary.tool_results_prepared, 0);
        assert_eq!(count(&script.records.attempts), 1);
        assert_eq!(count(&script.records.tool_calls), 0);
        assert!(!trace(&events).contains(&"tool_event"));
        healthy(&result, &events, &script.records);
    }
}

#[tokio::test]
async fn run_outcomes_unsupported_output_and_exact_upstream_assessment() {
    for (outcome, code) in [
        (
            ResponseOutcome::Incomplete {
                reason: Some("private reason".into()),
            },
            "model_incomplete",
        ),
        (ResponseOutcome::Failed, "model_failed"),
        (ResponseOutcome::Cancelled, "model_cancelled"),
    ] {
        let mut r = response("r1", vec![call("c1", 17, 25)], "");
        r.outcome = outcome.clone();
        let (gateway, script, tools) = setup(vec![Step::Response(r)]);
        let (result, events) = observed(&gateway, request(), &tools).await;
        failed_as(&result, code);
        assert_eq!(result.last_response.as_ref().unwrap().outcome, outcome);
        assert_eq!(result.summary.new_tool_dispatches, 0);
        healthy(&result, &events, &script.records);
    }
    for kind in [
        ItemKind::Unknown,
        ItemKind::CustomToolCall,
        ItemKind::ToolSearchCall,
        ItemKind::ToolSearchOutput,
        ItemKind::Program,
        ItemKind::ProgramOutput,
    ] {
        let mut item = call("c1", 17, 25);
        item.kind = kind.clone();
        let (gateway, _, tools) = setup(vec![Step::Response(response("r1", vec![item], ""))]);
        let (result, _) = observed(&gateway, request(), &tools).await;
        failed_as(&result, "unsupported_output");
        assert_eq!(result.last_response.as_ref().unwrap().output[0].kind, kind);
        assert_eq!(
            result.summary.last_upstream_outcome,
            Some(UpstreamOutcome::TerminalReceived)
        );
        assert_eq!(result.summary.new_tool_dispatches, 0);
    }
    for upstream in [
        UpstreamOutcome::NotSubmitted,
        UpstreamOutcome::Unknown,
        UpstreamOutcome::TerminalReceived,
    ] {
        for code in ["401", "403", "429", "disconnect", "invalid_recovery"] {
            let event = envelope(
                1,
                ProviderEvent::RequestFailed {
                    code: code.into(),
                    message: "private provider text".into(),
                    upstream_outcome: upstream,
                },
            );
            let (gateway, script, tools) = setup(vec![Step::Events(vec![event])]);
            let (result, events) = observed(&gateway, request(), &tools).await;
            failed_as(&result, "provider_request_failed");
            assert_eq!(result.summary.last_upstream_outcome, Some(upstream));
            assert_eq!(result.summary.new_tool_dispatches, 0);
            assert!(result.last_response.is_none());
            healthy(&result, &events, &script.records);
        }
    }
    let (gateway, script, tools) = setup(vec![Step::Reject]);
    let (result, events) = observed(&gateway, request(), &tools).await;
    failed_as(&result, "generate_rejected");
    assert_eq!(
        result.summary.last_upstream_outcome,
        Some(UpstreamOutcome::NotSubmitted)
    );
    assert_eq!(result.summary.model_requests_admitted, 0);
    healthy(&result, &events, &script.records);
}

#[tokio::test]
async fn run_collector_rejects_identity_order_idle_close_eof_and_accepts_gaps() {
    for case in 0..9 {
        let start = envelope(
            2,
            ProviderEvent::ResponseStarted {
                response_id: "r1".into(),
            },
        );
        let mut end = envelope(
            5,
            ProviderEvent::ResponseFinished {
                response: response("r1", vec![], "hello"),
            },
        );
        match case {
            0 => end.session_id = "wrong".into(),
            1 => end.provider = "wrong".into(),
            2 => end.request_id = Some("wrong".into()),
            3 => end.sequence = 2,
            4 => end.sequence = 1,
            5 => {
                end.event = ProviderEvent::ResponseFinished {
                    response: response("wrong", vec![], ""),
                }
            }
            6 => {
                end.request_id = None;
                end.event = ProviderEvent::SessionClosed {
                    reason: "private close reason".into(),
                };
            }
            7 => {
                end.event = ProviderEvent::ResponseStarted {
                    response_id: "r1".into(),
                }
            }
            8 => {}
            _ => unreachable!(),
        }
        let (gateway, script, tools) = setup(vec![Step::Events(vec![start, end])]);
        let (result, events) = observed(&gateway, request(), &tools).await;
        if case == 8 {
            assert_eq!(result.outcome, RunOutcome::Completed);
        } else {
            assert!(matches!(result.outcome, RunOutcome::Failed { .. }));
        }
        assert_eq!(count(&script.records.attempts), 1);
        healthy(&result, &events, &script.records);
    }
    let (gateway, script, tools) = setup(vec![Step::Eof]);
    let (result, events) = observed(&gateway, request(), &tools).await;
    failed_as(&result, "provider_eof");
    assert_eq!(
        result.summary.last_upstream_outcome,
        Some(UpstreamOutcome::Unknown)
    );
    healthy(&result, &events, &script.records);
    let terminal = envelope(
        1,
        ProviderEvent::ResponseFinished {
            response: response("r1", vec![], ""),
        },
    );
    let (gateway, _, tools) = setup(vec![Step::Events(vec![terminal])]);
    let (result, _) = observed(&gateway, request(), &tools).await;
    assert_eq!(result.outcome, RunOutcome::Completed);
}

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

#[tokio::test]
async fn run_sink_variants_stop_once_and_final_failure_preserves_outcome() {
    for error in [
        RunSinkError::Full,
        RunSinkError::Closed,
        RunSinkError::Failed,
    ] {
        for target in [
            "run_started",
            "provider_event",
            "tool_event",
            "run_finished",
        ] {
            let (gateway, script, tools) = setup(vec![
                Step::Response(response("r1", vec![call("c1", 17, 25)], "")),
                Step::Response(response("r2", vec![], "42")),
            ]);
            let mut failed = false;
            let mut attempts = 0;
            let result = run(
                &gateway,
                request(),
                &tools,
                CancellationToken::new(),
                |event| {
                    assert!(!failed, "sink called after failure");
                    attempts += 1;
                    if trace(std::slice::from_ref(event))[0] == target {
                        if target == "run_finished" {
                            assert_eq!(count(&script.records.closes), 1);
                        }
                        failed = true;
                        Err(error)
                    } else {
                        Ok(())
                    }
                },
            )
            .await
            .unwrap();
            assert!(failed && attempts > 0);
            assert!(!result.events_complete);
            assert_eq!(result.sink_error, Some(error));
            if target == "run_finished" {
                assert_eq!(result.outcome, RunOutcome::Completed);
            } else {
                failed_as(&result, "event_sink");
            }
            assert_eq!(
                count(&script.records.opens),
                if target == "run_started" { 0 } else { 1 }
            );
            assert_eq!(
                count(&script.records.closes),
                if target == "run_started" { 0 } else { 1 }
            );
            assert_eq!(
                result.summary.tool_results_prepared,
                if target == "run_finished" { 1 } else { 0 }
            );
            assert_eq!(
                count(&script.records.tool_calls),
                if target == "run_finished" { 1 } else { 0 }
            );
            assert_eq!(
                count(&script.records.attempts),
                if target == "run_started" {
                    0
                } else if target == "run_finished" {
                    2
                } else {
                    1
                }
            );
        }
    }
}

#[tokio::test]
async fn run_open_failure_has_no_turn_or_upstream_and_closes_before_final() {
    let mut script = Script::new(vec![]);
    script.fail_open = true;
    let records = script.records.clone();
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(script)).unwrap();
    let (result, events) = observed(&gateway, request(), &ToolRegistry::new()).await;
    failed_as(&result, "session_open");
    assert_eq!(trace(&events), ["run_started", "run_finished"]);
    assert_eq!(result.summary.last_upstream_outcome, None);
    assert_eq!(result.summary.turns_started, 0);
    assert_eq!(count(&records.closes), 0);
}
