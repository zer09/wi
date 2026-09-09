use super::*;

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
