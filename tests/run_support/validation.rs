use super::run_support::*;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{Arc, atomic::Ordering};
use wi::{
    run::*,
    tools::{Tool, ToolExecutionEvent, ToolRegistry},
    *,
};

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
async fn run_cross_turn_sequence_failure_keeps_prior_validated_response() {
    let mut end = envelope(
        1,
        ProviderEvent::ResponseFinished {
            response: response("r2", vec![], "must not retain"),
        },
    );
    end.request_id = Some("q2".into());
    for rejected_generate in [false, true] {
        let first = response("r1", vec![call("c1", 17, 25)], "");
        let (gateway, script, tools) = setup(vec![
            Step::Response(first.clone()),
            if rejected_generate {
                Step::Reject
            } else {
                Step::Events(vec![end.clone()])
            },
        ]);
        let (result, events) = observed(&gateway, request(), &tools).await;
        failed_as(
            &result,
            if rejected_generate {
                "generate_rejected"
            } else {
                "provider_correlation"
            },
        );
        assert_eq!(
            serde_json::to_value(result.last_response.as_ref().unwrap()).unwrap(),
            serde_json::to_value(first).unwrap()
        );
        assert_eq!(
            result.summary.last_upstream_outcome,
            Some(if rejected_generate {
                UpstreamOutcome::NotSubmitted
            } else {
                UpstreamOutcome::Unknown
            })
        );
        assert_eq!(result.summary.model_requests_attempted, 2);
        assert_eq!(result.summary.new_tool_dispatches, 1);
        healthy(&result, &events, &script.records);
    }
}

#[tokio::test]
async fn run_result_item_capacity_fails_before_new_execution() {
    let (gateway, script, tools) = setup(vec![Step::Response(response(
        "too-many-results",
        (0..=MAX_INPUT_ITEMS)
            .map(|i| call(&format!("c{i}"), i as i64, 1))
            .collect(),
        "",
    ))]);
    let (result, events) = observed(&gateway, request(), &tools).await;
    failed_as(&result, "tool_preflight");
    assert_eq!(result.summary.model_requests_attempted, 1);
    assert_eq!(result.summary.new_tool_dispatches, 0);
    assert_eq!(result.summary.tool_results_prepared, 0);
    assert_eq!(script.records.inputs.lock().unwrap().len(), 1);
    assert!(
        !events
            .iter()
            .any(|e| matches!(e.event, RunEvent::ToolEvent { .. }))
    );
    healthy(&result, &events, &script.records);
}

struct InputSizedTool(Arc<Records>);
#[async_trait]
impl Tool for InputSizedTool {
    fn definition(&self) -> ToolDefinition {
        self.0.definitions.fetch_add(1, Ordering::SeqCst);
        wi::tools::add_numbers_definition()
    }
    fn validate(&self, args: &Value) -> wi::Result<()> {
        wi::tools::AddNumbers.validate(args)
    }
    async fn execute(&self, _: Value) -> wi::Result<Value> {
        self.0.tool_calls.fetch_add(1, Ordering::SeqCst);
        // Each serialized output fits the tool guard; the whole vector may not fit an input.
        Ok(json!("x".repeat(64 * 1024 - 2)))
    }
}

#[tokio::test]
async fn run_validates_complete_actual_result_bytes_before_submission() {
    for size in [15, 16] {
        let (gateway, script, _) = setup(vec![
            Step::Response(response(
                "batch",
                (0..size).map(|i| call(&format!("c{i}"), i, 1)).collect(),
                "",
            )),
            Step::Response(response("final", vec![], "consumed")),
        ]);
        // Ignore the discarded setup tool's registration observation.
        script.records.definitions.store(0, Ordering::SeqCst);
        let mut tools = ToolRegistry::new();
        tools
            .register(Arc::new(InputSizedTool(script.records.clone())))
            .unwrap();
        let (result, events) = observed(&gateway, request(), &tools).await;
        let expected: Vec<_> = (0..size)
            .map(|i| InputItem::ToolResult {
                call_id: format!("c{i}"),
                output: json!("x".repeat(64 * 1024 - 2)).to_string(),
            })
            .collect();
        assert_eq!(result.summary.new_tool_dispatches, size as u64);
        assert_eq!(result.summary.tool_results_prepared, size as u64);
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(
                    e.event,
                    RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolExecutionFinished {
                            is_error: false,
                            ..
                        }
                    }
                ))
                .count(),
            size as usize
        );
        if size == 15 {
            validate_input(&expected).unwrap();
            assert_eq!(result.outcome, RunOutcome::Completed);
            assert_eq!(result.summary.model_requests_attempted, 2);
            assert_eq!(
                value(&script.records.inputs.lock().unwrap()[1]),
                value(&expected)
            );
        } else {
            assert!(matches!(
                validate_input(&expected),
                Err(GatewayError::InvalidRequest("input exceeds 1 MiB"))
            ));
            failed_as(&result, "tool_result_input");
            assert_eq!(result.summary.model_requests_attempted, 1);
            assert_eq!(
                script.records.inputs.lock().unwrap().len(),
                1,
                "no subset submitted"
            );
            assert!(!events.iter().any(|e| matches!(
                e.event,
                RunEvent::TurnFinished {
                    outcome: TurnOutcome::ToolsPrepared,
                    ..
                }
            )));
        }
        // A rejected submission does not undo the completed tool executions.
        healthy(&result, &events, &script.records);
    }
}
