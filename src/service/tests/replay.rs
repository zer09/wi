use super::b2::*;
use super::fixture::count;
use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn independent_reader_and_rename_see_partial_text_and_real_tool_output() {
    let fixture = Fixture::new().await;
    let model_gate = Arc::new(Barrier::default());
    let tool_gate = Arc::new(Barrier::default());
    let tool = Arc::new(ToolProbe {
        pause: Some(tool_gate.clone()),
        ..Default::default()
    });
    let task = Task::new(
        &fixture.session,
        tool.registry(),
        "independent reader",
        Plan {
            response_pause: Some(model_gate.clone()),
            responses: vec![
                response("call", vec![call("one", 17, 25), call("later", 1, 2)], ""),
                response("final", vec![], "45"),
            ],
            ..Plan::default()
        },
    );
    let host = RunHost::new(fixture.store, task.gateway.clone()).unwrap();
    let client = host.client();
    let ticket = client
        .submit(
            task.session.session_id().clone(),
            task.request(),
            task.tools.fresh_scope(),
        )
        .unwrap();
    watchdog(model_gate.reached.notified()).await;
    let receipt = ticket.accepted().await.unwrap();
    let reader = watchdog(
        host.storage()
            .open_session(task.session.session_id().clone()),
    )
    .await
    .unwrap();
    let page = watchdog(reader.history_page(0, None, 200)).await.unwrap();
    assert!(page.records().iter().any(|record| matches!(record.payload(), StoredEventPayload::RuntimeObserved(event)
        if matches!(&event.event, RunEvent::ProviderEvent { event } if matches!(&event.event, crate::ProviderEvent::OutputItemUpdated { delta, .. } if delta == "partial 雪\n\0")))));
    let run = watchdog(reader.run_record(task.run_id.clone()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.state(), RecordedRunState::Running);
    assert!(run.result().is_none());
    let rename = watchdog(reader.rename(OperationId::new(), "renamed during model wait".into()))
        .await
        .unwrap();
    assert!(rename.receipt().first_sequence() > receipt.receipt().last_sequence());
    assert_eq!(
        reader.manifest().await.unwrap().title(),
        "renamed during model wait"
    );
    model_gate.release.notify_one();
    watchdog(tool_gate.reached.notified()).await;
    let mut waiter = Box::pin(ticket.completion());
    assert!(futures_util::poll!(&mut waiter).is_pending());
    drop(waiter);
    drop(ticket);
    drop(client);
    tool_gate.release.notify_one();
    watchdog(tool_gate.reached.notified()).await;
    // The second tool is still pending, so no continuation can have been submitted.
    let saved = watchdog(reader.tool_result(task.run_id.clone(), "one".into()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.output(), Some("{\"sum\":42}"));
    assert_eq!(saved.is_error(), Some(false));
    assert!(saved.result_sequence().unwrap() < saved.finished_sequence().unwrap());
    let page = watchdog(reader.history_page(rename.receipt().last_sequence(), None, 200))
        .await
        .unwrap();
    assert!(page.records().iter().any(|event| matches!(event.payload(), StoredEventPayload::ToolResultRecorded(result) if result.output() == "{\"sum\":42}")));
    assert_eq!(task.observed.records.inputs.lock().unwrap().len(), 1);
    assert_eq!(count(&tool.effects), 1);
    drop(reader);
    tool_gate.release.notify_one();
    watchdog(model_gate.reached.notified()).await;
    assert_eq!(count(&tool.effects), 2);
    model_gate.release.notify_one();
    retired(&host).await;
    let saved = fixture
        .session
        .run_record(task.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.result().unwrap().outcome, RunOutcome::Completed);
    assert!(saved.result().unwrap().events_complete);
    assert!(saved.result().unwrap().sink_error.is_none());
    assert_eq!(count(&task.observed.records.closes), 1);
    closed(&host).await;
}

#[tokio::test]
async fn explicit_b_after_host_shutdown_and_reopen_restores_only_saved_a() {
    let fixture = Fixture::new().await;
    let first_response = response("a-call", vec![call("same-call", 17, 25)], "");
    let final_response = response("a-final", vec![], "42 雪\r\n");
    let a = fixture.task(
        "add 17 and 25",
        Plan {
            responses: vec![first_response.clone(), final_response.clone()],
            ..Plan::default()
        },
    );
    let host = RunHost::new(fixture.store, a.gateway.clone()).unwrap();
    let ticket = submit(&host, &a);
    let completed = watchdog(ticket.completion()).await;
    assert_eq!(executed(&completed).2.outcome, RunOutcome::Completed);
    assert_eq!(count(&fixture.counts.effects), 1);
    assert!(a.observed.installed.lock().unwrap()[0].runs().is_empty());
    let saved = history(&a.session).await;
    let saved_tool = a
        .session
        .tool_result(a.run_id.clone(), "same-call".into())
        .await
        .unwrap()
        .unwrap();
    closed(&host).await;
    drop(host);
    let store = SessionStore::open(fixture.temp.path().join("root"))
        .await
        .unwrap();
    let session = store
        .open_session(a.session.session_id().clone())
        .await
        .unwrap();
    let (tools, counts) = replay_tools(&session);
    let b = Task::new(
        &session,
        tools,
        "add one to prior answer",
        Plan {
            responses: vec![
                response("b-call", vec![call("same-call", 42, 1)], ""),
                response("b-final", vec![], "43"),
            ],
            ..Plan::default()
        },
    );
    counts.definitions.store(0, Ordering::SeqCst);
    let host = RunHost::new(store, b.gateway.clone()).unwrap();
    assert_eq!(value(&history(&session).await), value(&saved));
    assert_eq!(
        session
            .run_record(a.run_id.clone())
            .await
            .unwrap()
            .unwrap()
            .state(),
        RecordedRunState::Completed
    );
    no_work(&b);
    assert_eq!(count(&counts.definitions), 0);
    assert_eq!(count(&counts.effects), 0);
    let old = host
        .client()
        .submit(
            session.session_id().clone(),
            a.request(),
            ToolRegistry::new(),
        )
        .unwrap();
    assert!(old.accepted().await.unwrap().duplicate());
    assert!(matches!(
        &*old.completion().await,
        RunCompletion::Execution(Ok(PersistentRunResult::Duplicate { .. }))
    ));
    no_work(&b);
    let ticket = submit(&host, &b);
    let completion = watchdog(ticket.completion()).await;
    let (accepted, _, result) = executed(&completion);
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(
        accepted.receipt().first_sequence(),
        saved.last().unwrap().sequence() + 1
    );
    assert_eq!(count(&counts.effects), 1);
    assert_eq!(count(&counts.validations), 1);
    assert_eq!(count(&b.observed.records.opens), 1);
    assert_eq!(count(&b.observed.installs), 1);
    let replay = b.observed.installed.lock().unwrap()[0].clone();
    assert_eq!(replay.expected_identity(), Some(&identity('a')));
    assert_eq!(replay.runs().len(), 1);
    let old = &replay.runs()[0];
    assert_eq!(old.source_run_id(), a.run_id.as_str());
    assert_eq!(old.prepared_prompt(), "prepared add 17 and 25");
    assert_eq!(old.exchanges().len(), 2);
    assert_eq!(value(old.exchanges()[0].response()), value(&first_response));
    assert_eq!(value(old.exchanges()[1].response()), value(&final_response));
    assert_eq!(
        value(&old.exchanges()[0].tool_results()),
        value(&vec![InputItem::ToolResult {
            call_id: "same-call".into(),
            output: saved_tool.output().unwrap().into()
        }])
    );
    assert_eq!(
        value(&*b.observed.records.inputs.lock().unwrap()),
        value(&vec![
            vec![InputItem::user("prepared add one to prior answer")],
            vec![InputItem::ToolResult {
                call_id: "same-call".into(),
                output: "{\"sum\":43}".into()
            }]
        ])
    );
    assert_eq!(
        value(
            &session
                .history_page(0, Some(saved.last().unwrap().sequence()), 200)
                .await
                .unwrap()
                .records()
        ),
        value(&saved)
    );
    assert_eq!(
        value(
            &session
                .tool_result(a.run_id.clone(), "same-call".into())
                .await
                .unwrap()
                .unwrap()
        ),
        value(&saved_tool)
    );
    assert_eq!(
        session
            .tool_result(b.run_id.clone(), "same-call".into())
            .await
            .unwrap()
            .unwrap()
            .output(),
        Some("{\"sum\":43}")
    );
    closed(&host).await;
}

#[tokio::test]
async fn incomplete_and_legacy_unbound_histories_remain_readable_without_repair() {
    for legacy in [false, true] {
        let fixture = Fixture::new().await;
        let gate = Arc::new(Barrier::default());
        let a = fixture.task(
            "old history",
            Plan {
                response_pause: Some(gate.clone()),
                ..Plan::default()
            },
        );
        if legacy {
            // Seed an existing B1 storage record, not a replay DTO or a replacement host execution.
            fixture
                .session
                .accept_run(a.operation_id.clone(), a.run_id.clone(), a.input.clone())
                .await
                .unwrap();
        }
        let host = RunHost::new(fixture.store, a.gateway.clone()).unwrap();
        if !legacy {
            let ticket = submit(&host, &a);
            watchdog(gate.reached.notified()).await;
            host.client().cancel(ticket.session_id(), ticket.run_id());
            assert_eq!(
                executed(&watchdog(ticket.completion()).await).2.outcome,
                RunOutcome::CancelledLocally
            );
        }
        closed(&host).await;
        let store = SessionStore::open(fixture.temp.path().join("root"))
            .await
            .unwrap();
        let session = store
            .open_session(a.session.session_id().clone())
            .await
            .unwrap();
        let (tools, counts) = replay_tools(&session);
        let b = Task::new(
            &session,
            tools,
            "must fail before current checks",
            Plan::default(),
        );
        counts.definitions.store(0, Ordering::SeqCst);
        let host = RunHost::new(store, b.gateway.clone()).unwrap();
        let before = history(&session).await;
        assert!(!before.is_empty());
        assert!(
            session
                .run_record(a.run_id.clone())
                .await
                .unwrap()
                .is_some()
        );
        no_work(&b);
        let ticket = submit(&host, &b);
        let completion = watchdog(ticket.accepted()).await.unwrap_err();
        assert!(Arc::ptr_eq(&completion, &ticket.completion().await));
        assert_eq!(failure(&completion).stage(), PersistentRunStage::History);
        let expected = if legacy {
            "stored history has no replay provenance"
        } else {
            "stored history is incomplete for native replay"
        };
        assert!(
            matches!(failure(&completion).cause(), PersistentRunCause::Gateway(GatewayError::InvalidRequest(message)) if *message == expected)
        );
        assert_eq!(value(&history(&session).await), value(&before));
        assert!(
            session
                .lookup_receipt(b.operation_id.clone())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(count(&counts.definitions), 0);
        assert_eq!(count(&counts.effects), 0);
        no_work(&b);
        closed(&host).await;
    }
}
