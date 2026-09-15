use super::{
    capture::input,
    fixtures::{Fixture, connect},
    history::provider,
    recording::{append, runtime, session, turn_finished, value},
};
use serde_json::{Value, json};
use sqlx::{Connection, Row};
use wi::{
    ProviderEvent,
    run::{RunEvent, RunEventEnvelope, RunOutcome, RunSummary},
    storage::{AppendRunRecord, CommitCertainty, OperationId, RunId, SessionHandle},
    tools::ToolExecutionEvent,
};

fn extension(sequence: u64) -> RunEvent {
    provider(
        ProviderEvent::ProviderExtension {
            event_type: "unknown.future.event".into(),
            payload: json!({"opaque":"\0雪\n", "not_authenticated":true}),
        },
        sequence,
    )
}

fn trace(run: &RunId) -> Vec<RunEventEnvelope> {
    vec![
        runtime(run, 1, RunEvent::RunStarted),
        runtime(run, 2, RunEvent::TurnStarted { number: 1 }),
        runtime(run, 3, extension(0)),
        runtime(
            run,
            4,
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionStarted {
                    call_id: "call".into(),
                    tool_name: "synthetic".into(),
                },
            },
        ),
        runtime(
            run,
            5,
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionFinished {
                    call_id: "call".into(),
                    tool_name: "synthetic".into(),
                    is_error: false,
                },
            },
        ),
        runtime(run, 6, turn_finished(1)),
        runtime(
            run,
            7,
            RunEvent::RunFinished {
                outcome: RunOutcome::Failed {
                    code: "synthetic".into(),
                },
                summary: RunSummary::default(),
            },
        ),
    ]
}

async fn snapshot(fixture: &Fixture, handle: &SessionHandle, run: &RunId) -> Value {
    let id = handle.session_id().as_str();
    let path = fixture
        .root
        .join("sessions")
        .join(&id[..2])
        .join(id)
        .join("session.sqlite3");
    let mut connection = connect(&path).await;
    // Count physical rows as well, so a hidden append beyond the head cannot pass.
    let row = sqlx::query("SELECT (SELECT count(*) FROM events), (SELECT count(*) FROM commands), (SELECT count(*) FROM tool_results)")
        .fetch_one(&mut connection).await.unwrap();
    let counts: Vec<i64> = (0..3).map(|i| row.try_get(i).unwrap()).collect();
    connection.close().await.unwrap();
    json!({
        "manifest":value(&handle.manifest().await.unwrap()),
        "history":value(&handle.history_page(0, None, 100).await.unwrap()),
        "run":value(&handle.run_record(run.clone()).await.unwrap()),
        "tool":value(&handle.tool_result(run.clone(), "call".into()).await.unwrap()),
        "counts":counts,
    })
}

async fn rejected(
    fixture: &Fixture,
    handle: &SessionHandle,
    run: &RunId,
    records: Vec<AppendRunRecord>,
    label: &str,
) {
    let before = snapshot(fixture, handle, run).await;
    let operation = OperationId::new();
    let error = handle
        .append_run_records(operation.clone(), run.clone(), records)
        .await
        .expect_err(label);
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted, "{label}");
    assert!(
        handle.lookup_receipt(operation).await.unwrap().is_none(),
        "{label}"
    );
    assert_eq!(snapshot(fixture, handle, run).await, before, "{label}");
}

#[tokio::test]
async fn p1a11_correlation_outer_identities_and_batch_rollback() {
    let (fixture, store, handle, run) = session().await;
    handle
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    let good = trace(&run);
    for index in 0..good.len() {
        for field in ["turn_id", "session_id", "request_id"] {
            let original = value(&good[index]);
            let invalids = if original[field].is_null() {
                vec![json!("unexpected")]
            } else {
                vec![Value::Null, json!("changed")]
            };
            for invalid in invalids {
                // TurnStarted establishes these identities; the first provider event admits a request.
                if (index == 1 && field != "request_id" || index == 2 && field == "request_id")
                    && !invalid.is_null()
                {
                    continue;
                }
                let mut records: Vec<_> = good[..=index]
                    .iter()
                    .cloned()
                    .map(AppendRunRecord::Runtime)
                    .collect();
                let mut bad = original.clone();
                bad[field] = invalid;
                *records.last_mut().unwrap() =
                    AppendRunRecord::Runtime(serde_json::from_value(bad).unwrap());
                rejected(
                    &fixture,
                    &handle,
                    &run,
                    records,
                    &format!("event {index} {field}"),
                )
                .await;
            }
        }
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1a11_correlation_nested_identities_provider_and_sequences() {
    let (fixture, store, handle, run) = session().await;
    handle
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    let good = trace(&run);
    append(
        &handle,
        &run,
        good[..3]
            .iter()
            .cloned()
            .map(AppendRunRecord::Runtime)
            .collect(),
    )
    .await;
    for (field, invalid) in [
        ("session_id", json!("changed")),
        ("request_id", Value::Null),
        ("request_id", json!("changed")),
        ("provider", json!("wrong-provider")),
        ("schema_version", json!(2)),
        ("sequence", json!(0)),
    ] {
        let mut bad = value(&runtime(&run, 4, extension(7)));
        bad["event"][field] = invalid;
        rejected(
            &fixture,
            &handle,
            &run,
            vec![AppendRunRecord::Runtime(
                serde_json::from_value(bad).unwrap(),
            )],
            field,
        )
        .await;
    }
    for field in ["session_id", "request_id"] {
        let mut bad = value(&runtime(&run, 4, extension(7)));
        bad[field] = json!("changed");
        bad["event"][field] = json!("changed");
        rejected(
            &fixture,
            &handle,
            &run,
            vec![AppendRunRecord::Runtime(
                serde_json::from_value(bad).unwrap(),
            )],
            "aligned but changed identity",
        )
        .await;
    }
    // The normalized provider sequence permits gaps and a first value of zero.
    // The optional native provider_sequence has no ordering contract.
    for (outer, nested, native) in [(4, 7, Some(u64::MAX)), (5, 20, Some(0)), (6, 21, None)] {
        let mut event = runtime(&run, outer, extension(nested));
        if let RunEvent::ProviderEvent { event } = &mut event.event {
            event.provider_sequence = native;
        }
        append(&handle, &run, vec![AppendRunRecord::Runtime(event)]).await;
    }
    for sequence in [21, 20] {
        rejected(
            &fixture,
            &handle,
            &run,
            vec![AppendRunRecord::Runtime(runtime(
                &run,
                7,
                extension(sequence),
            ))],
            "equal/decreasing nested sequence",
        )
        .await;
    }
    let page = handle.history_page(4, None, 10).await.unwrap();
    assert_eq!(page.records().len(), 4);
    for stored in page.records() {
        assert_eq!(
            value(stored)["payload"]["event"]["payload"],
            json!({"opaque":"\0雪\n", "not_authenticated":true})
        );
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1a14_correlation_active_turn_request_and_reuse_original_request() {
    let (fixture, store, handle, run) = session().await;
    handle
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    let good = trace(&run);
    append(
        &handle,
        &run,
        vec![AppendRunRecord::Runtime(good[0].clone())],
    )
    .await;
    for event in &good[2..5] {
        rejected(
            &fixture,
            &handle,
            &run,
            vec![AppendRunRecord::Runtime(event.clone())],
            "outside turn",
        )
        .await;
    }
    append(
        &handle,
        &run,
        good[1..4]
            .iter()
            .cloned()
            .map(AppendRunRecord::Runtime)
            .collect(),
    )
    .await;
    for mut event in [good[1].clone(), good[6].clone()] {
        event.sequence = 5;
        rejected(
            &fixture,
            &handle,
            &run,
            vec![AppendRunRecord::Runtime(event)],
            "active turn boundary",
        )
        .await;
    }
    let mut changed_request = runtime(&run, 5, extension(1));
    changed_request.request_id = Some("changed".into());
    if let RunEvent::ProviderEvent { event } = &mut changed_request.event {
        event.request_id = Some("changed".into());
    }
    rejected(
        &fixture,
        &handle,
        &run,
        vec![AppendRunRecord::Runtime(changed_request)],
        "changed admitted request",
    )
    .await;
    append(
        &handle,
        &run,
        vec![
            AppendRunRecord::ToolResult {
                request_id: Some("original request".into()),
                call_id: "call".into(),
                output: "exact\0雪".into(),
                is_error: false,
            },
            AppendRunRecord::Runtime(good[4].clone()),
            AppendRunRecord::Runtime(good[5].clone()),
        ],
    )
    .await;
    let saved = value(
        &handle
            .tool_result(run.clone(), "call".into())
            .await
            .unwrap(),
    );
    for mut event in good[2..5].iter().cloned() {
        event.sequence = 7;
        rejected(
            &fixture,
            &handle,
            &run,
            vec![AppendRunRecord::Runtime(event)],
            "after turn finish",
        )
        .await;
    }
    let outside_reuse = runtime(
        &run,
        7,
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolResultReused {
                call_id: "call".into(),
                tool_name: "synthetic".into(),
            },
        },
    );
    rejected(
        &fixture,
        &handle,
        &run,
        vec![AppendRunRecord::Runtime(outside_reuse)],
        "reuse outside turn",
    )
    .await;
    let mut stale = good[1].clone();
    stale.sequence = 7;
    rejected(
        &fixture,
        &handle,
        &run,
        vec![AppendRunRecord::Runtime(stale)],
        "turn identity reused",
    )
    .await;
    let next = runtime(&run, 7, RunEvent::TurnStarted { number: 2 });
    for session_id in [None, Some("changed".into())] {
        let mut bad = next.clone();
        bad.session_id = session_id;
        rejected(
            &fixture,
            &handle,
            &run,
            vec![AppendRunRecord::Runtime(bad)],
            "changed session on next turn",
        )
        .await;
    }
    append(&handle, &run, vec![AppendRunRecord::Runtime(next)]).await;
    let mut admitted = runtime(&run, 8, extension(10));
    admitted.turn_id = Some("turn-2".into());
    admitted.request_id = Some("reuse request".into());
    if let RunEvent::ProviderEvent { event } = &mut admitted.event {
        event.request_id = Some("reuse request".into());
    }
    let mut backwards = admitted.clone();
    if let RunEvent::ProviderEvent { event } = &mut backwards.event {
        event.sequence = 0;
    }
    rejected(
        &fixture,
        &handle,
        &run,
        vec![AppendRunRecord::Runtime(backwards)],
        "nested sequence across turns",
    )
    .await;
    append(&handle, &run, vec![AppendRunRecord::Runtime(admitted)]).await;
    let mut reuse = runtime(
        &run,
        9,
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolResultReused {
                call_id: "call".into(),
                tool_name: "synthetic".into(),
            },
        },
    );
    reuse.turn_id = Some("turn-2".into());
    reuse.request_id = Some("reuse request".into());
    for field in ["turn_id", "session_id", "request_id"] {
        for invalid in [Value::Null, json!("changed")] {
            let mut bad = value(&reuse);
            bad[field] = invalid;
            rejected(
                &fixture,
                &handle,
                &run,
                vec![AppendRunRecord::Runtime(
                    serde_json::from_value(bad).unwrap(),
                )],
                field,
            )
            .await;
        }
    }
    let mut old = reuse.clone();
    old.request_id = Some("original request".into());
    rejected(
        &fixture,
        &handle,
        &run,
        vec![AppendRunRecord::Runtime(old)],
        "reuse must use active request",
    )
    .await;
    append(&handle, &run, vec![AppendRunRecord::Runtime(reuse)]).await;
    assert_eq!(
        value(
            &handle
                .tool_result(run.clone(), "call".into())
                .await
                .unwrap()
        ),
        saved
    );
    let mut finished = runtime(&run, 10, turn_finished(2));
    finished.turn_id = Some("turn-2".into());
    finished.request_id = Some("reuse request".into());
    append(&handle, &run, vec![AppendRunRecord::Runtime(finished)]).await;
    let mut stale = good[1].clone();
    stale.sequence = 11;
    rejected(
        &fixture,
        &handle,
        &run,
        vec![AppendRunRecord::Runtime(stale)],
        "older turn identity reused",
    )
    .await;
    let mut final_event = good[6].clone();
    final_event.sequence = 11;
    final_event.request_id = Some("reuse request".into());
    append(&handle, &run, vec![AppendRunRecord::Runtime(final_event)]).await;
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1a14_correlation_finish_and_result_keep_start_identity() {
    let (fixture, store, handle, run) = session().await;
    handle
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    let good = trace(&run);
    append(
        &handle,
        &run,
        good[..4]
            .iter()
            .cloned()
            .map(AppendRunRecord::Runtime)
            .collect(),
    )
    .await;
    append(
        &handle,
        &run,
        vec![AppendRunRecord::Runtime(good[5].clone())],
    )
    .await;
    append(
        &handle,
        &run,
        vec![AppendRunRecord::Runtime(runtime(
            &run,
            7,
            RunEvent::TurnStarted { number: 2 },
        ))],
    )
    .await;
    let mut finish = good[4].clone();
    finish.sequence = 8;
    finish.turn_id = Some("turn-2".into());
    rejected(
        &fixture,
        &handle,
        &run,
        vec![AppendRunRecord::Runtime(finish)],
        "finish in new turn with original request",
    )
    .await;
    let mut provider = runtime(&run, 8, extension(1));
    provider.turn_id = Some("turn-2".into());
    provider.request_id = Some("next request".into());
    if let RunEvent::ProviderEvent { event } = &mut provider.event {
        event.request_id = Some("next request".into());
    }
    append(&handle, &run, vec![AppendRunRecord::Runtime(provider)]).await;
    for request_id in [None, Some("next request".into())] {
        rejected(
            &fixture,
            &handle,
            &run,
            vec![AppendRunRecord::ToolResult {
                request_id,
                call_id: "call".into(),
                output: "saved".into(),
                is_error: false,
            }],
            "result must keep original request",
        )
        .await;
    }
    append(
        &handle,
        &run,
        vec![AppendRunRecord::ToolResult {
            request_id: Some("original request".into()),
            call_id: "call".into(),
            output: "saved".into(),
            is_error: false,
        }],
    )
    .await;
    let saved = handle
        .tool_result(run, "call".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.request_id(), Some("original request"));
    assert_eq!(saved.output(), Some("saved"));
    assert!(saved.finished_sequence().is_none());
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1a11_correlation_unadmitted_and_early_final_identities() {
    for session_opened in [false, true] {
        let (_fixture, store, handle, run) = session().await;
        handle
            .accept_run(OperationId::new(), run.clone(), input())
            .await
            .unwrap();
        let mut events = vec![runtime(&run, 1, RunEvent::RunStarted)];
        if session_opened {
            events.push(runtime(&run, 2, RunEvent::TurnStarted { number: 1 }));
            let mut finish = runtime(&run, 3, turn_finished(1));
            finish.request_id = None;
            events.push(finish);
        }
        let mut final_event = runtime(
            &run,
            4,
            RunEvent::RunFinished {
                outcome: RunOutcome::CancelledLocally,
                summary: RunSummary::default(),
            },
        );
        final_event.request_id = None;
        if !session_opened {
            final_event.session_id = None;
        }
        events.push(final_event);
        for event in events {
            append(&handle, &run, vec![AppendRunRecord::Runtime(event)]).await;
        }
        store.close().await.unwrap();
    }
}
