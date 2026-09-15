use super::{capture::input, fixtures::Fixture};
use serde_json::Value;
use wi::{
    run::{RunEvent, RunEventEnvelope, RunOutcome, RunResult, RunSinkError, RunSummary},
    storage::{
        AppendRunRecord, CommitCertainty, CreateSession, OperationId, RecordedRunState, RunId,
        SessionHandle, SessionStore, StoredEventPayload,
    },
};

pub(super) async fn session() -> (Fixture, SessionStore, SessionHandle, RunId) {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "title".into(), None).unwrap())
        .await
        .unwrap();
    let handle = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    (fixture, store, handle, RunId::new())
}

pub(super) fn runtime(run: &RunId, sequence: u64, event: RunEvent) -> RunEventEnvelope {
    RunEventEnvelope {
        schema_version: 2,
        sequence,
        event_id: uuid::Uuid::new_v4().to_string(),
        run_id: run.as_str().into(),
        turn_id: match &event {
            RunEvent::RunStarted | RunEvent::RunFinished { .. } => None,
            RunEvent::TurnStarted { number } => Some(format!("turn-{number}")),
            _ => Some("turn-1".into()),
        },
        session_id: if matches!(event, RunEvent::RunStarted) {
            None
        } else {
            Some("opaque provider session".into())
        },
        request_id: if matches!(event, RunEvent::RunStarted | RunEvent::TurnStarted { .. }) {
            None
        } else {
            Some("original request".into())
        },
        event,
    }
}
pub(super) fn turn_finished(number: u64) -> RunEvent {
    RunEvent::TurnFinished {
        number,
        response_id: None,
        outcome: wi::run::TurnOutcome::ModelCompleted,
        upstream_outcome: Some(wi::UpstreamOutcome::TerminalReceived),
    }
}

pub(super) fn result(run: &RunId, outcome: RunOutcome) -> RunResult {
    RunResult {
        run_id: run.as_str().into(),
        session_id: Some("opaque provider session".into()),
        outcome,
        summary: RunSummary::default(),
        last_response: None,
        events_complete: false,
        sink_error: Some(RunSinkError::Closed),
    }
}
pub(super) async fn append(handle: &SessionHandle, run: &RunId, records: Vec<AppendRunRecord>) {
    handle
        .append_run_records(OperationId::new(), run.clone(), records)
        .await
        .unwrap();
}
pub(super) fn value(v: &impl serde::Serialize) -> Value {
    serde_json::to_value(v).unwrap()
}

#[tokio::test]
async fn p1a10_acceptance_receipt_first_active_session_scope_and_restart() {
    let (fixture, store, handle, run) = session().await;
    let op = OperationId::new();
    let accepted = handle
        .accept_run(op.clone(), run.clone(), input())
        .await
        .unwrap();
    assert_eq!(accepted.receipt().run_id(), Some(&run));
    assert_eq!(accepted.receipt().first_sequence(), 2);
    assert_eq!(accepted.receipt().last_sequence(), 2);
    let recorded = handle.run_record(run.clone()).await.unwrap().unwrap();
    assert_eq!(recorded.state(), RecordedRunState::Accepted);
    assert_eq!(value(recorded.input()), value(&input()));
    assert_eq!(recorded.provider_session_id(), None);
    assert_eq!(recorded.terminal_sequence(), None);
    assert!(!format!("{recorded:?}").contains("canary"));
    let error = handle
        .accept_run(OperationId::new(), RunId::new(), input())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "storage.active_run_exists");
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    handle
        .rename(OperationId::new(), "active rename".into())
        .await
        .unwrap();
    let other = store
        .create_session(CreateSession::new(OperationId::new(), "other".into(), None).unwrap())
        .await
        .unwrap();
    store
        .open_session(other.session_id().clone())
        .await
        .unwrap()
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    append(
        &handle,
        &run,
        vec![AppendRunRecord::Result(result(&run, RunOutcome::Completed))],
    )
    .await;
    assert_eq!(
        handle
            .run_record(run.clone())
            .await
            .unwrap()
            .unwrap()
            .state(),
        RecordedRunState::Completed
    );
    for error in [
        handle
            .accept_run(op.clone(), RunId::new(), input())
            .await
            .unwrap_err(),
        handle
            .rename(op.clone(), "conflict".into())
            .await
            .unwrap_err(),
        handle
            .append_run_records(op.clone(), run.clone(), vec![])
            .await
            .unwrap_err(),
    ] {
        assert_eq!(error.code(), "storage.command_conflict");
    }
    for restarted in [false, true] {
        if !restarted {
            assert_eq!(
                handle
                    .accept_run(op.clone(), run.clone(), input())
                    .await
                    .unwrap()
                    .receipt(),
                accepted.receipt()
            );
        } else {
            store.close().await.unwrap();
            let reopened = SessionStore::open(fixture.root.clone()).await.unwrap();
            let handle = reopened
                .open_session(handle.session_id().clone())
                .await
                .unwrap();
            let duplicate = handle
                .accept_run(op.clone(), run.clone(), input())
                .await
                .unwrap();
            assert!(duplicate.duplicate());
            assert_eq!(duplicate.receipt(), accepted.receipt());
            assert_eq!(
                handle.lookup_receipt(op.clone()).await.unwrap().as_ref(),
                Some(accepted.receipt())
            );
            reopened.close().await.unwrap();
        }
    }
}

#[tokio::test]
async fn p1a11_atomic_mixed_batch_and_unsupported_envelopes() {
    let (_fixture, store, handle, run) = session().await;
    handle
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    let started = runtime(&run, 1, RunEvent::RunStarted);
    let mut invalids = vec![
        runtime(&RunId::new(), 2, RunEvent::TurnStarted { number: 1 }),
        runtime(&run, 2, RunEvent::RunStarted),
    ];
    let mut wrong_version = runtime(&run, 2, RunEvent::TurnStarted { number: 1 });
    wrong_version.schema_version = 3;
    invalids.push(wrong_version);
    let mut zero = runtime(&run, 0, RunEvent::TurnStarted { number: 1 });
    invalids.push(zero.clone());
    zero.sequence = u64::MAX;
    invalids.push(zero);
    invalids.push(runtime(
        &run,
        2,
        RunEvent::ProviderEvent {
            event: Box::new(wi::EventEnvelope {
                schema_version: 2,
                sequence: 1,
                event_id: "opaque".into(),
                session_id: "opaque provider session".into(),
                request_id: None,
                provider: "synthetic".into(),
                provider_sequence: None,
                event: wi::ProviderEvent::ProviderExtension {
                    event_type: "unknown".into(),
                    payload: Value::Null,
                },
            }),
        },
    ));
    for invalid in invalids {
        let op = OperationId::new();
        let error = handle
            .append_run_records(
                op.clone(),
                run.clone(),
                vec![
                    AppendRunRecord::Runtime(started.clone()),
                    AppendRunRecord::Runtime(invalid),
                ],
            )
            .await
            .unwrap_err();
        assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
        assert_eq!(handle.manifest().await.unwrap().head_sequence(), 2);
        assert!(handle.lookup_receipt(op).await.unwrap().is_none());
        let projected = handle.run_record(run.clone()).await.unwrap().unwrap();
        assert_eq!(projected.state(), RecordedRunState::Accepted);
        assert_eq!(projected.last_runtime_sequence(), 0);
    }
    let op = OperationId::new();
    let records = vec![
        AppendRunRecord::Runtime(started),
        AppendRunRecord::Runtime(runtime(&run, 4, RunEvent::TurnStarted { number: 1 })),
    ];
    let committed = handle
        .append_run_records(op.clone(), run.clone(), records.clone())
        .await
        .unwrap();
    assert_eq!(
        (
            committed.receipt().first_sequence(),
            committed.receipt().last_sequence()
        ),
        (3, 4)
    );
    assert_eq!(
        handle
            .append_run_records(op, run.clone(), records)
            .await
            .unwrap()
            .receipt(),
        committed.receipt()
    );
    assert_eq!(
        handle
            .run_record(run)
            .await
            .unwrap()
            .unwrap()
            .last_runtime_sequence(),
        4
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1a12_source_gaps_duplicates_and_multiple_runs() {
    let (_fixture, store, handle, run) = session().await;
    handle
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    let started = runtime(&run, 7, RunEvent::RunStarted);
    let op = OperationId::new();
    let records = vec![AppendRunRecord::Runtime(started.clone())];
    let first = handle
        .append_run_records(op.clone(), run.clone(), records.clone())
        .await
        .unwrap();
    assert!(
        handle
            .append_run_records(op, run.clone(), records.clone())
            .await
            .unwrap()
            .duplicate()
    );
    let error = handle
        .append_run_records(OperationId::new(), run.clone(), records)
        .await
        .unwrap_err();
    assert_eq!(error.code(), "storage.command_conflict");
    let mut duplicated = runtime(&run, 8, RunEvent::TurnStarted { number: 1 });
    duplicated.event_id = started.event_id.clone();
    assert_eq!(
        handle
            .append_run_records(
                OperationId::new(),
                run.clone(),
                vec![AppendRunRecord::Runtime(duplicated)]
            )
            .await
            .unwrap_err()
            .code(),
        "storage.command_conflict"
    );
    let mut finished = runtime(
        &run,
        99,
        RunEvent::RunFinished {
            outcome: RunOutcome::CancelledLocally,
            summary: RunSummary::default(),
        },
    );
    finished.request_id = None;
    append(&handle, &run, vec![AppendRunRecord::Runtime(finished)]).await;
    let next = RunId::new();
    handle
        .rename(OperationId::new(), "between runs".into())
        .await
        .unwrap();
    handle
        .accept_run(OperationId::new(), next.clone(), input())
        .await
        .unwrap();
    let mut duplicate_id = runtime(&next, 1, RunEvent::RunStarted);
    duplicate_id.event_id = started.event_id;
    assert_eq!(
        handle
            .append_run_records(
                OperationId::new(),
                next.clone(),
                vec![AppendRunRecord::Runtime(duplicate_id)]
            )
            .await
            .unwrap_err()
            .code(),
        "storage.command_conflict"
    );
    append(
        &handle,
        &next,
        vec![AppendRunRecord::Runtime(runtime(
            &next,
            1,
            RunEvent::RunStarted,
        ))],
    )
    .await;
    assert_eq!(first.receipt().first_sequence(), 3);
    assert_eq!(handle.manifest().await.unwrap().head_sequence(), 7);
    let page = handle.history_page(0, None, 20).await.unwrap();
    assert_eq!(
        page.records()
            .iter()
            .map(|e| e.sequence())
            .collect::<Vec<_>>(),
        (1..=7).collect::<Vec<_>>()
    );
    assert_eq!(page.records()[2].event_type(), "runtime.observed");
    match page.records()[2].payload() {
        StoredEventPayload::RuntimeObserved(e) => assert_eq!(e.sequence, 7),
        _ => panic!("wrong payload"),
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1a16_all_outcomes_terminal_delivery_and_no_resurrection() {
    for outcome in [
        RunOutcome::Completed,
        RunOutcome::Failed {
            code: "gateway_error".into(),
        },
        RunOutcome::CancelledLocally,
    ] {
        for terminal_event in [false, true] {
            let (_fixture, store, handle, run) = session().await;
            handle
                .accept_run(OperationId::new(), run.clone(), input())
                .await
                .unwrap();
            if terminal_event {
                append(
                    &handle,
                    &run,
                    vec![
                        AppendRunRecord::Runtime(runtime(&run, 1, RunEvent::RunStarted)),
                        AppendRunRecord::Runtime(runtime(
                            &run,
                            2,
                            RunEvent::TurnStarted { number: 1 },
                        )),
                        AppendRunRecord::Runtime(runtime(&run, 3, turn_finished(1))),
                        AppendRunRecord::Runtime(runtime(
                            &run,
                            4,
                            RunEvent::RunFinished {
                                outcome: outcome.clone(),
                                summary: RunSummary::default(),
                            },
                        )),
                    ],
                )
                .await;
            }
            let mut result = result(&run, outcome.clone());
            if terminal_event {
                result.events_complete = true;
                result.sink_error = None;
            }
            let operation = OperationId::new();
            let records = vec![AppendRunRecord::Result(result.clone())];
            let receipt = handle
                .append_run_records(operation.clone(), run.clone(), records.clone())
                .await
                .unwrap();
            let recorded = handle.run_record(run.clone()).await.unwrap().unwrap();
            assert_eq!(value(recorded.result().unwrap()), value(&result));
            assert_eq!(
                recorded.terminal_sequence(),
                Some(if terminal_event { 6 } else { 3 })
            );
            assert_eq!(
                recorded.result_sequence(),
                Some(receipt.receipt().last_sequence())
            );
            assert_eq!(
                recorded.provider_session_id(),
                Some("opaque provider session")
            );
            assert_eq!(recorded.result().unwrap().events_complete, terminal_event);
            let expected = match outcome {
                RunOutcome::Completed => RecordedRunState::Completed,
                RunOutcome::Failed { .. } => RecordedRunState::Failed,
                RunOutcome::CancelledLocally => RecordedRunState::CancelledLocally,
            };
            assert_eq!(recorded.state(), expected);
            assert_eq!(
                handle
                    .append_run_records(operation, run.clone(), records.clone())
                    .await
                    .unwrap()
                    .receipt(),
                receipt.receipt()
            );
            assert_eq!(
                handle
                    .append_run_records(OperationId::new(), run.clone(), records)
                    .await
                    .unwrap_err()
                    .code(),
                "storage.invalid_transition"
            );
            assert_eq!(
                handle
                    .append_run_records(
                        OperationId::new(),
                        run.clone(),
                        vec![AppendRunRecord::Runtime(runtime(
                            &run,
                            5,
                            RunEvent::TurnStarted { number: 2 }
                        ))]
                    )
                    .await
                    .unwrap_err()
                    .code(),
                "storage.invalid_transition"
            );
            assert!(
                handle
                    .accept_run(OperationId::new(), run, input())
                    .await
                    .is_err()
            );
            handle
                .accept_run(OperationId::new(), RunId::new(), input())
                .await
                .unwrap();
            store.close().await.unwrap();
        }
    }
}

#[tokio::test]
async fn p1a11_mixed_records_rollback_and_receipt_replay_after_terminal() {
    use wi::tools::ToolExecutionEvent;

    let (fixture, store, handle, run) = session().await;
    let accepted_op = OperationId::new();
    handle
        .accept_run(accepted_op.clone(), run.clone(), input())
        .await
        .unwrap();
    let mut changed_input = value(&input());
    changed_input["user_text"] = "different original text".into();
    let changed_input = serde_json::from_value(changed_input).unwrap();
    assert_eq!(
        handle
            .accept_run(accepted_op, run.clone(), changed_input)
            .await
            .unwrap_err()
            .code(),
        "storage.command_conflict"
    );

    let output = "opaque output\r\n雪\0  {not JSON} \\n";
    let tool_start = RunEvent::ToolEvent {
        event: ToolExecutionEvent::ToolExecutionStarted {
            call_id: "call".into(),
            tool_name: "synthetic".into(),
        },
    };
    let tool_finish = RunEvent::ToolEvent {
        event: ToolExecutionEvent::ToolExecutionFinished {
            call_id: "call".into(),
            tool_name: "synthetic".into(),
            is_error: true,
        },
    };
    let mut records = vec![
        AppendRunRecord::Runtime(runtime(&run, 1, RunEvent::RunStarted)),
        AppendRunRecord::Runtime(runtime(&run, 2, RunEvent::TurnStarted { number: 1 })),
        AppendRunRecord::Runtime(runtime(&run, 3, tool_start)),
        AppendRunRecord::ToolResult {
            request_id: Some("original request".into()),
            call_id: "call".into(),
            output: output.into(),
            is_error: true,
        },
        AppendRunRecord::Runtime(runtime(&run, 4, tool_finish)),
        AppendRunRecord::Runtime(runtime(&run, 5, turn_finished(1))),
        AppendRunRecord::Runtime(runtime(
            &run,
            6,
            RunEvent::RunFinished {
                outcome: RunOutcome::Completed,
                summary: RunSummary::default(),
            },
        )),
        AppendRunRecord::Result(result(
            &run,
            RunOutcome::Failed {
                code: "conflicting".into(),
            },
        )),
    ];
    let operation = OperationId::new();
    let error = handle
        .append_run_records(operation.clone(), run.clone(), records.clone())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "storage.invalid_transition");
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    assert_eq!(handle.manifest().await.unwrap().head_sequence(), 2);
    assert!(
        handle
            .lookup_receipt(operation.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        handle
            .tool_result(run.clone(), "call".into())
            .await
            .unwrap()
            .is_none()
    );
    let recorded = handle.run_record(run.clone()).await.unwrap().unwrap();
    assert_eq!(recorded.state(), RecordedRunState::Accepted);
    assert_eq!(recorded.last_runtime_sequence(), 0);
    assert!(recorded.terminal_sequence().is_none());
    assert!(recorded.result_sequence().is_none());
    assert_eq!(
        handle
            .history_page(0, None, 10)
            .await
            .unwrap()
            .records()
            .len(),
        2
    );

    *records.last_mut().unwrap() = AppendRunRecord::Result(result(&run, RunOutcome::Completed));
    let committed = handle
        .append_run_records(operation.clone(), run.clone(), records.clone())
        .await
        .unwrap();
    assert_eq!(
        (
            committed.receipt().first_sequence(),
            committed.receipt().last_sequence()
        ),
        (3, 10)
    );
    let tool = handle
        .tool_result(run.clone(), "call".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tool.output(), Some(output));
    assert_eq!(tool.is_error(), Some(true));
    assert_eq!(tool.result_sequence(), Some(6));
    assert_eq!(tool.finished_sequence(), Some(7));
    handle
        .rename(OperationId::new(), "after terminal".into())
        .await
        .unwrap();
    store.close().await.unwrap();

    let reopened = SessionStore::open(fixture.root.clone()).await.unwrap();
    let handle = reopened
        .open_session(handle.session_id().clone())
        .await
        .unwrap();
    let duplicate = handle
        .append_run_records(operation.clone(), run.clone(), records.clone())
        .await
        .unwrap();
    assert!(duplicate.duplicate());
    assert_eq!(duplicate.receipt(), committed.receipt());
    let AppendRunRecord::Result(last) = records.last_mut().unwrap() else {
        unreachable!()
    };
    last.summary.last_request_id = Some("changed summary".into());
    assert_eq!(
        handle
            .append_run_records(operation, run.clone(), records)
            .await
            .unwrap_err()
            .code(),
        "storage.command_conflict"
    );
    assert_eq!(handle.manifest().await.unwrap().head_sequence(), 11);
    assert_eq!(
        value(&tool),
        value(
            &handle
                .tool_result(run, "call".into())
                .await
                .unwrap()
                .unwrap()
        )
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn p1a16_conflicting_terminal_outcome_identity_and_delivery_reject() {
    let (_fixture, store, handle, run) = session().await;
    handle
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    let mut complete_delivery = result(&run, RunOutcome::Completed);
    complete_delivery.events_complete = true;
    complete_delivery.sink_error = None;
    assert!(
        handle
            .append_run_records(
                OperationId::new(),
                run.clone(),
                vec![AppendRunRecord::Result(complete_delivery)]
            )
            .await
            .is_err()
    );
    let outcome = RunOutcome::Failed {
        code: "original".into(),
    };
    append(
        &handle,
        &run,
        vec![
            AppendRunRecord::Runtime(runtime(&run, 1, RunEvent::RunStarted)),
            AppendRunRecord::Runtime(runtime(&run, 2, RunEvent::TurnStarted { number: 1 })),
            AppendRunRecord::Runtime(runtime(&run, 3, turn_finished(1))),
            AppendRunRecord::Runtime(runtime(
                &run,
                4,
                RunEvent::RunFinished {
                    outcome: outcome.clone(),
                    summary: RunSummary::default(),
                },
            )),
        ],
    )
    .await;
    let mut wrong_provider = result(&run, outcome.clone());
    wrong_provider.session_id = Some("wrong".into());
    let mut wrong_run = result(&run, outcome);
    wrong_run.run_id = RunId::new().as_str().into();
    for bad in [
        result(
            &run,
            RunOutcome::Failed {
                code: "different".into(),
            },
        ),
        result(&run, RunOutcome::Completed),
        wrong_provider,
        wrong_run,
    ] {
        assert!(
            handle
                .append_run_records(
                    OperationId::new(),
                    run.clone(),
                    vec![AppendRunRecord::Result(bad)]
                )
                .await
                .is_err()
        );
        assert_eq!(handle.manifest().await.unwrap().head_sequence(), 6);
        assert!(
            handle
                .run_record(run.clone())
                .await
                .unwrap()
                .unwrap()
                .result()
                .is_none()
        );
    }
    store.close().await.unwrap();
}
