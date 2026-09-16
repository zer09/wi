use super::*;
use crate::run::RunOutcome;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn p1b2_19_closed_stopped_results_need_no_finish_or_old_continuation() {
    for stop in [Stop::Finish, Stop::Result, Stop::SecondTurn] {
        let rig = Rig::new().await;
        let mut plan = Plan::new(
            rig.input("old task"),
            vec![response("closed", vec![call("x", json!({"a":17,"b":25}))])],
        );
        plan.stop = stop;
        let (run, actual) = rig.record(plan).await;
        assert_ne!(actual.outcome, RunOutcome::Completed);
        assert_eq!(actual.summary.model_requests_attempted, 1);
        let saved = rig
            .session
            .tool_result(run.clone(), "x".into())
            .await
            .unwrap()
            .unwrap();
        let before = history(&rig.session).await;
        let work = rig.counters.work();
        if stop == Stop::Result {
            assert!(saved.finished_sequence().is_none());
            assert!(!actual.events_complete);
            assert_incomplete(
                prepare_session_replay(&rig.session, ID, MODEL)
                    .await
                    .unwrap_err(),
            );
        } else {
            assert!(saved.finished_sequence().is_some());
            let prepared = rig.prepare().await;
            assert_eq!(prepared.included_exchange_count(), 1);
            assert_eq!(prepared.included_run_count(), 1);
            assert_eq!(
                prepared.replay().runs()[0].exchanges()[0]
                    .tool_results()
                    .len(),
                1
            );
        }
        assert_eq!(value(&before), value(&history(&rig.session).await));
        assert_eq!(work, rig.counters.work());
        assert_eq!(rig.counters.executes.load(Ordering::SeqCst), 1);
        assert_eq!(
            rig.session
                .run_record(run)
                .await
                .unwrap()
                .unwrap()
                .result()
                .unwrap()
                .outcome,
            actual.outcome
        );
        rig.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1b2_19_no_call_response_with_actual_result_survives_lost_terminal_delivery() {
    let rig = Rig::new().await;
    let mut plan = Plan::new(
        rig.input("closed no call"),
        vec![response("complete", vec![])],
    );
    plan.stop = Stop::ResponseSink;
    let (_, result) = rig.record(plan).await;
    assert!(!result.events_complete);
    assert_eq!(result.summary.model_requests_attempted, 1);
    assert_eq!(rig.prepare().await.included_exchange_count(), 1);
    rig.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_20_missing_finish_after_closed_turn_rejects_each_run_closure() {
    use crate::{run::RunEvent, tools::ToolExecutionEvent};

    let rig = Rig::new().await;
    let mut plan = Plan::new(
        rig.input("closed turn"),
        vec![response("call", vec![call("x", json!({"a":17,"b":25}))])],
    );
    plan.stop = Stop::Finish;
    let (_, actual) = rig.record(plan).await;
    let before = history(&rig.session).await;
    let work = rig.counters.work();
    for closure in ["terminal", "result", "restart"] {
        let mut builder = Builder::default();
        let mut runtime_sequence = 0;
        let mut rejected = false;
        for record in &before {
            // Remove the finish only from an in-memory replay copy, not stored history.
            let mut copy = value(record);
            if let StoredEventPayload::RuntimeObserved(runtime) = record.payload() {
                if matches!(
                    runtime.event,
                    RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolExecutionFinished { .. }
                    }
                ) {
                    continue;
                }
                runtime_sequence += 1;
                copy["payload"]["sequence"] = json!(runtime_sequence);
                if matches!(runtime.event, RunEvent::RunFinished { .. }) {
                    let result = match closure {
                        "terminal" => builder.observe(&serde_json::from_value(copy).unwrap()),
                        "result" => {
                            let mut result = actual.clone();
                            result.events_complete = false;
                            builder.result(&result)
                        }
                        _ => builder.close_active(true),
                    };
                    assert_incomplete(result.unwrap_err());
                    rejected = true;
                    break;
                }
            }
            builder
                .observe(&serde_json::from_value(copy).unwrap())
                .unwrap();
        }
        assert!(rejected, "closure not exercised: {closure}");
    }
    assert_eq!(value(&before), value(&history(&rig.session).await));
    assert_eq!(work, rig.counters.work());
    rig.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_20_partial_response_intent_partial_batch_and_uncertain_later_request_reject() {
    for case in ["response", "intent", "batch", "partial", "later_rejected"] {
        let rig = Rig::new().await;
        let mut plan = Plan::new(
            rig.input("task"),
            vec![response("calls", vec![call("x", json!({"a":1,"b":2}))])],
        );
        match case {
            "response" => plan.stop = Stop::Response,
            "intent" => plan.stop = Stop::Intent,
            "batch" => {
                plan.steps = vec![Step::Response(response(
                    "batch",
                    vec![
                        call("x", json!({"a":1,"b":2})),
                        call("y", json!({"a":3,"b":4})),
                    ],
                ))];
                plan.stop = Stop::Finish;
            }
            "partial" => {
                plan.steps = vec![Step::Partial];
                plan.stop = Stop::Partial;
            }
            _ => plan.steps.push(Step::Reject),
        }
        rig.record(plan).await;
        let before = history(&rig.session).await;
        let work = rig.counters.work();
        assert_incomplete(
            prepare_session_replay(&rig.session, ID, MODEL)
                .await
                .unwrap_err(),
        );
        assert_eq!(value(&before), value(&history(&rig.session).await));
        assert_eq!(work, rig.counters.work());
        rig.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1b2_20_incomplete_cancelled_failed_and_unsupported_outputs_reject() {
    for case in [
        "incomplete",
        "cancelled",
        "failed",
        "custom",
        "indirect",
        "namespace",
        "unknown",
    ] {
        let rig = Rig::new().await;
        let mut original = response("bad", vec![]);
        match case {
            "incomplete" => original.outcome = crate::ResponseOutcome::Incomplete { reason: None },
            "cancelled" => original.outcome = crate::ResponseOutcome::Cancelled,
            "failed" => original.outcome = crate::ResponseOutcome::Failed,
            _ => {
                let mut item = call("x", json!({"a":1,"b":2}));
                match case {
                    "custom" => item.kind = crate::ItemKind::CustomToolCall,
                    "indirect" => {
                        item.function_call.as_mut().unwrap().origin =
                            crate::CallOrigin::Programmatic
                    }
                    "namespace" => item.native["namespace"] = json!({"not":"ordinary"}),
                    _ => item.kind = crate::ItemKind::Unknown,
                }
                original.output.push(item);
            }
        }
        rig.record(Plan::new(rig.input("task"), vec![original]))
            .await;
        assert_incomplete(
            prepare_session_replay(&rig.session, ID, MODEL)
                .await
                .unwrap_err(),
        );
        assert_eq!(rig.counters.executes.load(Ordering::SeqCst), 0);
        rig.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1b2_21_zero_attempt_failures_excluded_even_with_mismatched_actual_binding() {
    let rig = Rig::new().await;
    rig.record(Plan::new(rig.input("valid A"), vec![response("a", vec![])]))
        .await;
    let mut excluded = Vec::new();
    for stop in [Stop::OpenFail, Stop::Opened] {
        let mut plan = Plan::new(rig.input("not submitted"), vec![]);
        plan.stop = stop;
        plan.identity = identity('b');
        let (run, result) = rig.record(plan).await;
        assert_eq!(result.summary.model_requests_attempted, 0);
        assert_eq!(result.summary.model_requests_admitted, 0);
        assert!(result.last_response.is_none());
        excluded.push(run);
        let prepared = rig.prepare().await;
        assert_eq!(prepared.replay().expected_identity(), Some(&identity('a')));
    }
    let prepared = rig.prepare().await;
    assert_eq!(prepared.included_run_count(), 1);
    assert_eq!(
        prepared
            .excluded_runs()
            .iter()
            .map(ExcludedReplayRun::run_id)
            .collect::<Vec<_>>(),
        excluded
    );
    for excluded in prepared.excluded_runs() {
        assert_eq!(
            excluded.disposition(),
            ReplayExclusionDisposition::DefinitelyUnsubmitted
        );
        assert_eq!(format!("{excluded:?}"), "ExcludedReplayRun([redacted])");
    }
    rig.record(Plan::new(rig.input("valid B"), vec![response("b", vec![])]))
        .await;
    assert_eq!(rig.prepare().await.included_run_count(), 2);
    rig.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_19_21_missing_final_result_and_restart_are_not_no_submission_proof() {
    for stop in [
        Stop::Never,
        Stop::OpenFail,
        Stop::Result,
        Stop::ResponseSink,
    ] {
        let rig = Rig::new().await;
        let original = if stop == Stop::Result {
            response("call", vec![call("x", json!({"a":1,"b":2}))])
        } else {
            response("done", vec![])
        };
        let mut plan = Plan::new(rig.input("no final record"), vec![original.clone()]);
        plan.stop = stop;
        plan.final_result = false;
        let (run, _) = rig.record(plan).await;
        assert_incomplete(
            prepare_session_replay(&rig.session, ID, MODEL)
                .await
                .unwrap_err(),
        );
        let id = rig.session.session_id().clone();
        let prefix = history(&rig.session).await;
        let before = rig.counters.work();
        rig.store.close().await.unwrap();
        let reopened = SessionStore::open(rig.temp.path().join("store"))
            .await
            .unwrap();
        let session = reopened.open_session(id).await.unwrap();
        let reopened_history = history(&session).await;
        assert_eq!(
            value(&prefix),
            value(&reopened_history[..prefix.len()].to_vec())
        );
        let recorded = session.run_record(run.clone()).await.unwrap().unwrap();
        assert!(recorded.result().is_none());
        if matches!(stop, Stop::Result | Stop::ResponseSink) {
            assert_eq!(
                recorded.state(),
                crate::storage::RecordedRunState::Interrupted
            );
            assert_eq!(reopened_history.len(), prefix.len() + 1);
            let prepared = prepare_session_replay(&session, ID, MODEL).await.unwrap();
            assert_eq!(prepared.included_run_count(), 1);
            assert_eq!(prepared.included_exchange_count(), 1);
            assert!(prepared.excluded_runs().is_empty());
            assert_eq!(prepared.replay().runs()[0].source_run_id(), run.as_str());
            assert_eq!(
                value(prepared.replay().runs()[0].exchanges()[0].response()),
                value(&original)
            );
        } else {
            // An ordinary terminal still needs its actual RunResult, even after reopen.
            assert_ne!(
                recorded.state(),
                crate::storage::RecordedRunState::Interrupted
            );
            assert_incomplete(
                prepare_session_replay(&session, ID, MODEL)
                    .await
                    .unwrap_err(),
            );
        }
        assert_eq!(value(&reopened_history), value(&history(&session).await));
        assert_eq!(rig.counters.work(), before);
        reopened.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1b2_22_legacy_actual_b1_history_remains_readable_but_unbound() {
    let rig = Rig::new().await;
    let mut plan = Plan::new(rig.input("legacy"), vec![response("done", vec![])]);
    plan.selected = false;
    let (run, result) = rig.record(plan).await;
    assert_eq!(result.outcome, RunOutcome::Completed);
    let error = prepare_session_replay(&rig.session, ID, MODEL)
        .await
        .unwrap_err();
    assert!(matches!(
        error.cause(),
        PersistentRunCause::Gateway(GatewayError::InvalidRequest(
            "stored history has no replay provenance"
        ))
    ));
    assert!(
        rig.session
            .history_selection(run.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        rig.session
            .run_record(run)
            .await
            .unwrap()
            .unwrap()
            .result()
            .unwrap()
            .outcome,
        RunOutcome::Completed
    );
    rig.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_17_provider_model_format_and_principal_boundaries() {
    let rig = Rig::new().await;
    rig.record(Plan::new(rig.input("bound"), vec![response("a", vec![])]))
        .await;
    for (provider, model) in [
        ("different", MODEL),
        (ID, "different-model"),
        ("", MODEL),
        (ID, ""),
    ] {
        let work = rig.counters.work();
        let error = prepare_session_replay(&rig.session, provider, model)
            .await
            .unwrap_err();
        assert!(matches!(
            error.cause(),
            PersistentRunCause::Gateway(GatewayError::InvalidRequest(
                "stored history provider or model is incompatible"
            ))
        ));
        assert_eq!(rig.counters.work(), work);
    }
    rig.store.close().await.unwrap();
    for format_change in [false, true] {
        let rig = Rig::new().await;
        rig.record(Plan::new(rig.input("bound A"), vec![response("a", vec![])]))
            .await;
        let mut plan = Plan::new(rig.input("wrong binding B"), vec![response("b", vec![])]);
        plan.identity = if format_change {
            ReplayIdentity::new(ID.into(), "other".into(), "a".repeat(64)).unwrap()
        } else {
            identity('b')
        };
        rig.record(plan).await;
        let error = prepare_session_replay(&rig.session, ID, MODEL)
            .await
            .unwrap_err();
        let expected = if format_change {
            "stored history provider or model is incompatible"
        } else {
            "stored history replay metadata is inconsistent"
        };
        assert!(
            matches!(error.cause(), PersistentRunCause::Gateway(GatewayError::InvalidRequest(message)) if *message == expected)
        );
        rig.store.close().await.unwrap();
    }
}
