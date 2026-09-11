use super::run_support::*;
use serde_json::json;
use std::sync::Arc;
use wi::{run::*, tools::ToolRegistry, *};

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
