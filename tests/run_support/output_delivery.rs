use super::run_support::*;
use serde_json::json;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;
use wi::{run::*, tools::ToolExecutionEvent, *};

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
async fn run_nonblocking_channel_observer_full_and_closed_stop_work() {
    for closed in [false, true] {
        let (gateway, script, tools) = setup(vec![Step::Response(response(
            "r1",
            vec![call("c1", 17, 25)],
            "",
        ))]);
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        if closed {
            drop(receiver);
        } else {
            sender.try_send(0u64).unwrap();
        }
        let result = run(
            &gateway,
            request(),
            &tools,
            CancellationToken::new(),
            |event| {
                sender
                    .try_send(event.sequence)
                    .map_err(|error| match error {
                        tokio::sync::mpsc::error::TrySendError::Full(_) => RunSinkError::Full,
                        tokio::sync::mpsc::error::TrySendError::Closed(_) => RunSinkError::Closed,
                    })
            },
        )
        .await
        .unwrap();
        failed_as(&result, "event_sink");
        assert_eq!(
            result.sink_error,
            Some(if closed {
                RunSinkError::Closed
            } else {
                RunSinkError::Full
            })
        );
        assert_eq!(count(&script.records.opens), 0);
    }
}

#[tokio::test]
async fn run_extension_envelope_is_opaque_and_turn_sink_failures_stop() {
    let extension = envelope(
        1,
        ProviderEvent::ProviderExtension {
            event_type: "independent-extension".into(),
            payload: json!({"independent_progress":[2,3]}),
        },
    );
    let terminal = envelope(
        9,
        ProviderEvent::ResponseFinished {
            response: response("r1", vec![], "hello"),
        },
    );
    let (gateway, script, tools) = setup(vec![Step::Events(vec![extension, terminal])]);
    let (result, events) = observed(&gateway, request(), &tools).await;
    assert_eq!(result.outcome, RunOutcome::Completed);
    healthy(&result, &events, &script.records);
    for target in ["turn_started", "turn_finished"] {
        let (gateway, script, tools) = setup(vec![Step::Response(response("r1", vec![], "hello"))]);
        let mut failed = false;
        let result = run(
            &gateway,
            request(),
            &tools,
            CancellationToken::new(),
            |event| {
                assert!(!failed);
                if trace(std::slice::from_ref(event))[0] == target {
                    failed = true;
                    Err(RunSinkError::Failed)
                } else {
                    Ok(())
                }
            },
        )
        .await
        .unwrap();
        failed_as(&result, "event_sink");
        assert_eq!(
            result.summary.model_requests_attempted,
            if target == "turn_started" { 0 } else { 1 }
        );
        assert_eq!(
            result.summary.last_upstream_outcome,
            Some(if target == "turn_started" {
                UpstreamOutcome::NotSubmitted
            } else {
                UpstreamOutcome::TerminalReceived
            })
        );
        assert_eq!(count(&script.records.closes), 1);
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
