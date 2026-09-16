use super::*;

#[tokio::test]
async fn owned_send_task_records_real_text_and_arithmetic_loops() {
    for cycles in 0..=2 {
        let mut steps = Vec::new();
        if cycles > 0 {
            steps.push(Step::Response(response(
                "r1",
                vec![call("one", 17, 25)],
                "",
            )));
        }
        if cycles > 1 {
            steps.push(Step::Response(response("r2", vec![call("two", 42, 8)], "")));
        }
        let text = if cycles == 2 { "50" } else { "42" };
        steps.push(Step::Response(response("final", vec![], text)));
        let rig = Rig::new(steps, ToolMode::Add).await;
        let input = value(&rig.input);
        let (acceptance, final_record, result) =
            executed(rig.start(CancellationToken::new()).await.unwrap().unwrap());
        assert!(!acceptance.duplicate());
        assert!(acceptance.cleanup_warning().is_none());
        assert!(!final_record.duplicate());
        assert!(final_record.cleanup_warning().is_none());
        assert_eq!(acceptance.receipt().operation_id(), &rig.operation_id);
        assert_eq!(acceptance.receipt().run_id(), Some(&rig.run_id));
        assert_eq!(result.run_id, rig.run_id.as_str());
        assert_eq!(result.outcome, RunOutcome::Completed);
        assert!(result.events_complete);
        assert_eq!(result.sink_error, None);
        assert_eq!(result.last_response.as_ref().unwrap().text, text);
        assert_eq!(result.summary.turns_started, cycles + 1);
        assert_eq!(result.summary.turns_finished, cycles + 1);
        assert_eq!(result.summary.model_requests_admitted, cycles + 1);
        assert_eq!(result.summary.new_tool_dispatches, cycles);
        assert_eq!(result.summary.tool_results_prepared, cycles);
        assert_eq!(count(&rig.script.records.opens), 1);
        assert_eq!(count(&rig.script.records.closes), 1);
        assert_eq!(count(&rig.script.records.calls), cycles as usize);
        assert_eq!(
            rig.script.records.inputs.lock().unwrap().len(),
            cycles as usize + 1
        );

        let history = history(&rig.session).await;
        assert_eq!(history.len(), 9 + 7 * cycles as usize);
        let StoredEventPayload::RunAccepted(saved) = history[1].payload() else {
            panic!("acceptance")
        };
        assert_eq!(value(saved.input()), input);
        let mut runtime = Vec::new();
        let mut provider = Vec::new();
        let mut outputs = Vec::new();
        for (index, record) in history.iter().enumerate() {
            assert_eq!(record.sequence(), index as u64 + 1);
            assert_eq!(record.application_session_id(), rig.session.session_id());
            match record.payload() {
                StoredEventPayload::RuntimeObserved(event) => {
                    assert_eq!(record.run_id(), Some(&rig.run_id));
                    assert_eq!(event.run_id, rig.run_id.as_str());
                    assert_eq!(event.schema_version, 2);
                    assert_eq!(event.sequence, runtime.len() as u64 + 1);
                    assert!(Uuid::parse_str(&event.event_id).is_ok());
                    if let Some(session) = &event.session_id {
                        assert_eq!(session, "provider-session");
                    }
                    if let RunEvent::ProviderEvent { event } = &event.event {
                        assert_eq!(event.schema_version, 1);
                        provider.push(value(event));
                    }
                    runtime.push(event);
                }
                StoredEventPayload::ToolResultRecorded(output) => {
                    outputs.push((output.call_id(), output.output(), output.is_error()));
                }
                _ => {}
            }
        }
        assert_eq!(runtime.len(), 6 + 6 * cycles as usize);
        assert_eq!(
            provider,
            rig.script
                .records
                .events
                .lock()
                .unwrap()
                .iter()
                .map(value)
                .collect::<Vec<_>>()
        );
        assert_eq!(outputs.len(), cycles as usize);
        if cycles > 0 {
            assert_eq!(outputs[0], ("one", "{\"sum\":42}", false));
        }
        if cycles > 1 {
            assert_eq!(outputs[1], ("two", "{\"sum\":50}", false));
        }
        let StoredEventPayload::RunResultRecorded(saved) = history.last().unwrap().payload() else {
            panic!("final result")
        };
        assert_eq!(value(saved), value(&result));
        assert_eq!(
            final_record.receipt().first_sequence(),
            history.len() as u64
        );
        assert_eq!(
            final_record.receipt().first_sequence(),
            final_record.receipt().last_sequence()
        );
        let run = rig
            .session
            .run_record(rig.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(value(run.result().unwrap()), value(&result));
        assert_eq!(
            run.result_sequence(),
            Some(final_record.receipt().last_sequence())
        );
        assert_eq!(
            rig.session
                .lookup_receipt(final_record.receipt().operation_id().clone())
                .await
                .unwrap()
                .unwrap(),
            *final_record.receipt()
        );
        rig.close().await;
    }
}

#[tokio::test]
async fn saved_snapshot_does_not_reread_preparation_files() {
    let rig = Rig::new(
        vec![Step::Response(response("final", vec![], "done"))],
        ToolMode::Add,
    )
    .await;
    assert_eq!(rig.input.active_skills(), ["project:local"]);
    assert_eq!(
        rig.input.project_instructions_source(),
        Some("project:AGENTS.md")
    );
    assert!(
        rig.input
            .prepared_request()
            .prompt
            .contains("synthetic skill body")
    );
    std::fs::remove_dir_all(rig.temp.path().join("workspace")).unwrap();
    let (_, _, result) = executed(rig.start(CancellationToken::new()).await.unwrap().unwrap());
    assert_eq!(result.outcome, RunOutcome::Completed);
    rig.close().await;
}

#[tokio::test]
async fn actual_serialized_error_flags_and_result_before_finish_are_preserved() {
    for (mode, expected, is_error) in [
        (
            ToolMode::Failed,
            "{\"error\":{\"code\":\"gateway_error\"}}".to_owned(),
            true,
        ),
        (
            ToolMode::Large,
            "{\"error\":{\"code\":\"tool_output_limit\"}}".to_owned(),
            true,
        ),
        (
            ToolMode::ErrorShaped,
            json!({"error":{"code":"not_an_error","text":"雪\n\0\\\""}}).to_string(),
            false,
        ),
    ] {
        let rig = Rig::new(
            vec![
                Step::Response(response("r1", vec![call("one", 17, 25)], "")),
                Step::Response(response("final", vec![], "done")),
            ],
            mode,
        )
        .await;
        let (_, _, result) = executed(rig.start(CancellationToken::new()).await.unwrap().unwrap());
        assert_eq!(result.outcome, RunOutcome::Completed);
        assert_eq!(count(&rig.script.records.calls), 1);
        let saved = rig
            .session
            .tool_result(rig.run_id.clone(), "one".into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.output(), Some(expected.as_str()));
        assert_eq!(saved.is_error(), Some(is_error));
        assert_eq!(saved.request_id(), Some("q1"));
        assert!(saved.started_sequence() < saved.result_sequence().unwrap());
        assert!(saved.result_sequence().unwrap() < saved.finished_sequence().unwrap());
        let history = history(&rig.session).await;
        let StoredEventPayload::RuntimeObserved(event) =
            history[(saved.finished_sequence().unwrap() - 1) as usize].payload()
        else {
            panic!("finish")
        };
        assert!(
            matches!(&event.event, RunEvent::ToolEvent { event: ToolExecutionEvent::ToolExecutionFinished { is_error: flag, .. } } if *flag == is_error)
        );
        let inputs = rig.script.records.inputs.lock().unwrap().clone();
        assert_eq!(
            value(&inputs[1]),
            value(&vec![InputItem::ToolResult {
                call_id: "one".into(),
                output: expected
            }])
        );
        rig.close().await;
    }
}

#[tokio::test]
async fn reused_call_has_one_effect_and_one_result_with_original_request() {
    let rig = Rig::new(
        vec![
            Step::Response(response("r1", vec![call("one", 17, 25)], "")),
            Step::Response(response("r2", vec![call("one", 17, 25)], "")),
            Step::Response(response("final", vec![], "42")),
        ],
        ToolMode::Add,
    )
    .await;
    let (_, _, result) = executed(rig.start(CancellationToken::new()).await.unwrap().unwrap());
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(result.summary.reused_results, 1);
    assert_eq!(count(&rig.script.records.calls), 1);
    let history = history(&rig.session).await;
    assert_eq!(
        history
            .iter()
            .filter(|r| matches!(r.payload(), StoredEventPayload::ToolResultRecorded(_)))
            .count(),
        1
    );
    let reuse = history
        .iter()
        .find_map(|r| match r.payload() {
            StoredEventPayload::RuntimeObserved(event)
                if matches!(
                    &event.event,
                    RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolResultReused { .. }
                    }
                ) =>
            {
                Some(event)
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(reuse.request_id.as_deref(), Some("q2"));
    let saved = rig
        .session
        .tool_result(rig.run_id.clone(), "one".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.request_id(), Some("q1"));
    let inputs = rig.script.records.inputs.lock().unwrap().clone();
    assert_eq!(value(&inputs[1]), value(&inputs[2]));
    rig.close().await;
}

#[tokio::test]
async fn invalid_whole_batch_persists_no_tool_intent_result_or_effect() {
    for invalid in ["unknown", "arguments", "partial", "duplicate"] {
        let first = call("one", 17, 25);
        let mut bad = call("bad", 1, 2);
        let function = bad.function_call.as_mut().unwrap();
        match invalid {
            "unknown" => function.name = "unknown".into(),
            "arguments" => function.arguments = "{\"a\":1}".into(),
            "partial" => function.complete = false,
            "duplicate" => function.call_id = "one".into(),
            _ => unreachable!(),
        }
        let rig = Rig::new(
            vec![Step::Response(response("r1", vec![first, bad], ""))],
            ToolMode::Add,
        )
        .await;
        let (_, _, result) = executed(rig.start(CancellationToken::new()).await.unwrap().unwrap());
        assert_eq!(
            result.outcome,
            RunOutcome::Failed {
                code: "tool_preflight".into()
            }
        );
        assert_eq!(count(&rig.script.records.calls), 0);
        let history = history(&rig.session).await;
        assert!(!history.iter().any(|r| matches!(r.payload(), StoredEventPayload::ToolResultRecorded(_)) || matches!(r.payload(), StoredEventPayload::RuntimeObserved(event) if matches!(event.event, RunEvent::ToolEvent { .. }))));
        assert_eq!(rig.script.records.inputs.lock().unwrap().len(), 1);
        rig.close().await;
    }
}
