use super::*;
use crate::storage::{
    CleanupWarning, CommitCertainty, StorageErrorKind,
    test_hooks::{Action, Pause, Point, Record},
};
use sqlx::{ConnectOptions, Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{future::Future, time::Duration};

pub(super) async fn watchdog<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(20), future)
        .await
        .expect("test watchdog, not evidence of rollback")
}

pub(super) fn pause_record(rig: &Rig, record: Record, point: Point) -> Arc<Pause> {
    let pause = Arc::new(Pause::default());
    rig.session
        .test_hooks()
        .arm_record(record, point, Action::Pause(pause.clone()));
    pause
}

pub(super) fn attempted(pause: &Pause) -> OperationId {
    pause.operation_id.lock().unwrap().clone().unwrap()
}

pub(super) async fn connection(rig: &Rig, read_only: bool) -> SqliteConnection {
    let id = rig.session.session_id().as_str();
    let path = rig
        .temp
        .path()
        .join("root/sessions")
        .join(&id[..2])
        .join(id)
        .join("session.sqlite3");
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .read_only(read_only)
            .busy_timeout(Duration::ZERO)
            .disable_statement_logging(),
    )
    .await
    .unwrap()
}

pub(super) async fn rows(connection: &mut SqliteConnection) -> Vec<(i64, String)> {
    sqlx::query_as("SELECT sequence, payload_json FROM events ORDER BY sequence")
        .fetch_all(connection)
        .await
        .unwrap()
}

pub(super) fn one_request(rig: &Rig, calls: usize) {
    assert_eq!(count(&rig.script.records.opens), 1);
    assert_eq!(count(&rig.script.records.closes), 1);
    assert_eq!(count(&rig.script.records.calls), calls);
    assert_eq!(rig.script.records.inputs.lock().unwrap().len(), 1);
}

async fn operations(connection: &mut SqliteConnection) -> Vec<(String, i64, i64)> {
    sqlx::query_as(
        "SELECT operation_id, first_sequence, last_sequence FROM commands ORDER BY first_sequence",
    )
    .fetch_all(connection)
    .await
    .unwrap()
}

#[derive(Clone, Copy)]
enum Fault {
    Rollback,
    UnknownBeforeCommit,
    UnknownAfterCommit,
    Cleanup,
}

impl Fault {
    fn committed(self) -> bool {
        matches!(self, Self::UnknownAfterCommit | Self::Cleanup)
    }
}

fn static_failure(failure: &PersistentRunFailure, stage: PersistentRunStage, category: &str) {
    assert_eq!(failure.stage(), stage);
    let expected = format!("persistent run {}: {category}", stage.as_str());
    assert_eq!(format!("{failure:?}"), expected);
    assert_eq!(failure.to_string(), expected);
    assert_eq!(format!("{:?}", failure.cause()), category);
    assert_eq!(failure.cause().to_string(), category);
    assert!(std::error::Error::source(failure).is_none());
}

async fn fail_record(rig: &Rig, record: Record, fault: Fault) -> PersistentRunFailure {
    let pause = Arc::new(Pause {
        rollback: matches!(fault, Fault::Rollback),
        ..Pause::default()
    });
    let hooks = rig.session.test_hooks();
    hooks.arm_record(record, Point::BeforeCommit, Action::Pause(pause.clone()));
    let task = rig.start(CancellationToken::new());
    watchdog(pause.reached.notified()).await;
    let operation = attempted(&pause);
    let mut reader = connection(rig, true).await;
    let prefix = rows(&mut reader).await;
    let commands = operations(&mut reader).await;
    assert!(!commands.iter().any(|(id, _, _)| id == operation.as_str()));
    match fault {
        Fault::Rollback => {}
        Fault::UnknownBeforeCommit => hooks.arm_record(
            record,
            Point::CommitStart,
            Action::Fail(StorageErrorKind::CommitUnknown),
        ),
        Fault::UnknownAfterCommit => hooks.arm_record(
            record,
            Point::AfterCommit,
            Action::Fail(StorageErrorKind::CommitUnknown),
        ),
        Fault::Cleanup => hooks.arm_record(
            record,
            Point::WriteClosed,
            Action::Fail(StorageErrorKind::Io),
        ),
    }
    pause.release.notify_one();
    let failure = watchdog(task).await.unwrap().unwrap_err();
    assert_eq!(failure.operation_id(), Some(&operation));
    let stage = match record {
        Record::Acceptance => PersistentRunStage::Acceptance,
        Record::ToolResult => PersistentRunStage::ToolResult,
        Record::FinalResult => PersistentRunStage::FinalResult,
        _ => PersistentRunStage::RuntimeEvent,
    };
    let category = if matches!(fault, Fault::Cleanup) {
        "committed_cleanup_warning"
    } else {
        "storage"
    };
    static_failure(&failure, stage, category);
    match failure.cause() {
        PersistentRunCause::Storage(error) => {
            let (kind, certainty) = if matches!(fault, Fault::Rollback) {
                (StorageErrorKind::Io, CommitCertainty::NotCommitted)
            } else {
                (StorageErrorKind::CommitUnknown, CommitCertainty::Unknown)
            };
            assert_eq!(error.kind(), kind);
            assert_eq!(error.certainty(), certainty);
        }
        PersistentRunCause::Cleanup { warning, commit } => {
            assert_eq!(*warning, CleanupWarning::ConnectionCloseFailed);
            assert_eq!(commit.cleanup_warning(), Some(*warning));
            assert!(!commit.duplicate());
            assert_eq!(commit.receipt().operation_id(), &operation);
        }
        PersistentRunCause::Gateway(_) => panic!("storage failure must retain its concrete cause"),
    }
    // Reconcile only by reads. No retry, restart, replacement operation, or second writer.
    let receipt = rig.session.lookup_receipt(operation.clone()).await.unwrap();
    assert_eq!(receipt.is_some(), fault.committed());
    let after = rows(&mut reader).await;
    assert_eq!(&after[..prefix.len()], prefix);
    assert_eq!(after.len(), prefix.len() + usize::from(fault.committed()));
    let after_commands = operations(&mut reader).await;
    assert_eq!(&after_commands[..commands.len()], commands);
    assert_eq!(
        after_commands.len(),
        commands.len() + usize::from(fault.committed())
    );
    if let Some(receipt) = receipt {
        assert_eq!(receipt.operation_id(), &operation);
        assert_eq!(receipt.session_id(), rig.session.session_id());
        assert_eq!(receipt.run_id(), Some(&rig.run_id));
        assert_eq!(
            (receipt.first_sequence(), receipt.last_sequence()),
            (after.len() as u64, after.len() as u64)
        );
        assert_eq!(
            after_commands.last().unwrap(),
            &(
                operation.as_str().to_owned(),
                after.len() as i64,
                after.len() as i64
            )
        );
        if let PersistentRunCause::Cleanup { commit, .. } = failure.cause() {
            assert_eq!(commit.receipt(), &receipt);
        }
    }
    let acceptance = rig
        .session
        .lookup_receipt(rig.operation_id.clone())
        .await
        .unwrap();
    if record == Record::Acceptance {
        assert!(failure.observed_result().is_none());
        if matches!(fault, Fault::Cleanup) {
            assert_eq!(failure.acceptance(), acceptance.as_ref());
            assert!(failure.acceptance().is_some());
        } else {
            // An ambiguous write is not a received acceptance acknowledgment.
            assert!(failure.acceptance().is_none());
        }
    } else {
        assert_eq!(failure.acceptance(), acceptance.as_ref());
        assert!(failure.acceptance().is_some());
        assert!(failure.observed_result().is_some());
        assert_ne!(failure.operation_id(), Some(&rig.operation_id));
    }
    reader.close().await.unwrap();
    failure
}

fn observed_sink_failure(failure: &PersistentRunFailure, outcome: RunOutcome) {
    let observed = failure.observed_result().unwrap();
    assert_eq!(observed.outcome, outcome);
    assert!(!observed.events_complete);
    assert_eq!(observed.sink_error, Some(RunSinkError::Failed));
}

fn completed_response(failure: &PersistentRunFailure, rig: &Rig, model: &ModelResponse) {
    let observed = failure.observed_result().unwrap();
    assert_eq!(observed.run_id, rig.run_id.as_str());
    assert_eq!(observed.session_id.as_deref(), Some("provider-session"));
    assert_eq!(observed.outcome, RunOutcome::Completed);
    assert_eq!(
        value(observed.last_response.as_ref().unwrap()),
        value(model)
    );
    assert_eq!(
        observed.summary.last_upstream_outcome,
        Some(UpstreamOutcome::TerminalReceived)
    );
    assert_eq!(observed.summary.model_requests_attempted, 1);
    assert_eq!(observed.summary.model_requests_admitted, 1);
    assert_eq!(observed.summary.turns_started, 1);
    assert_eq!(observed.summary.turns_finished, 1);
    assert_eq!(observed.summary.new_tool_dispatches, 0);
    assert_eq!(observed.summary.tool_results_prepared, 0);
    one_request(rig, 0);
}

#[tokio::test]
async fn first_run_finished_failure_preserves_completed_execution_without_durable_terminal() {
    let model = response("final", vec![], "private completed result λ\n\0");
    let rig = Rig::new(vec![Step::Response(model.clone())], ToolMode::Add).await;
    let failure = fail_record(&rig, Record::RunFinished, Fault::Rollback).await;
    completed_response(&failure, &rig, &model);
    observed_sink_failure(&failure, RunOutcome::Completed);
    let saved = rig
        .session
        .run_record(rig.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.state(), RecordedRunState::Running);
    assert_eq!(saved.last_runtime_sequence(), 5);
    assert!(saved.terminal().is_none());
    assert!(saved.terminal_sequence().is_none());
    assert!(saved.result_sequence().is_none());
    assert!(saved.result().is_none());
    let records = history(&rig.session).await;
    assert_eq!(records.len(), 7);
    assert!(
        matches!(records.last().unwrap().payload(), StoredEventPayload::RuntimeObserved(event) if matches!(event.event, RunEvent::TurnFinished { outcome: run::TurnOutcome::ModelCompleted, .. }))
    );
    rig.close().await;
}

#[tokio::test]
async fn final_result_failure_retains_attempted_identity_and_already_completed_run() {
    let model = response("final", vec![], "private final-result canary");
    let rig = Rig::new(vec![Step::Response(model.clone())], ToolMode::Add).await;
    let failure = fail_record(&rig, Record::FinalResult, Fault::Rollback).await;
    completed_response(&failure, &rig, &model);
    let observed = failure.observed_result().unwrap();
    assert!(observed.events_complete);
    assert_eq!(observed.sink_error, None);
    let saved = rig
        .session
        .run_record(rig.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.state(), RecordedRunState::Completed);
    assert_eq!(saved.terminal_sequence(), Some(8));
    assert!(saved.result_sequence().is_none());
    assert!(saved.result().is_none());
    let StoredEventPayload::RuntimeObserved(terminal) = saved.terminal().unwrap().payload() else {
        panic!("real terminal required")
    };
    let RunEvent::RunFinished { outcome, summary } = &terminal.event else {
        panic!("real RunFinished required")
    };
    assert_eq!(outcome, &observed.outcome);
    assert_eq!(value(summary), value(&observed.summary));
    assert_eq!(history(&rig.session).await.len(), 8);
    rig.close().await;
}

#[tokio::test]
async fn lookup_acceptance_runtime_and_tool_result_failures_keep_exact_stage_and_prefix() {
    let rig = Rig::new(vec![], ToolMode::Add).await;
    rig.session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    let failure = watchdog(rig.start(CancellationToken::new()))
        .await
        .unwrap()
        .unwrap_err();
    static_failure(&failure, PersistentRunStage::Lookup, "storage");
    assert_eq!(failure.operation_id(), Some(&rig.operation_id));
    assert!(failure.acceptance().is_none());
    assert!(failure.observed_result().is_none());
    assert!(
        matches!(failure.cause(), PersistentRunCause::Storage(error) if error.kind() == StorageErrorKind::Io && error.certainty() == CommitCertainty::NotApplicable)
    );
    assert!(
        rig.session
            .lookup_receipt(rig.operation_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(history(&rig.session).await.len(), 1);
    assert_eq!(count(&rig.script.records.opens), 0);
    assert_eq!(count(&rig.script.records.calls), 0);
    assert!(rig.script.records.inputs.lock().unwrap().is_empty());
    rig.close().await;

    for record in [Record::Acceptance, Record::RunStarted, Record::ToolResult] {
        let rig = Rig::new(
            vec![Step::Response(response(
                "r1",
                vec![call("one", 17, 25), call("later", 1, 2)],
                "",
            ))],
            ToolMode::Add,
        )
        .await;
        let failure = fail_record(&rig, record, Fault::Rollback).await;
        let saved = rig.session.run_record(rig.run_id.clone()).await.unwrap();
        if record == Record::Acceptance {
            assert!(saved.is_none());
            assert_eq!(count(&rig.script.records.opens), 0);
        } else {
            observed_sink_failure(
                &failure,
                RunOutcome::Failed {
                    code: "event_sink".into(),
                },
            );
            let saved = saved.unwrap();
            assert!(saved.terminal().is_none());
            assert!(saved.result().is_none());
            if record == Record::RunStarted {
                assert_eq!(saved.state(), RecordedRunState::Accepted);
                assert_eq!(count(&rig.script.records.opens), 0);
            } else {
                assert_eq!(saved.state(), RecordedRunState::Running);
                one_request(&rig, 1);
                let tool = rig
                    .session
                    .tool_result(rig.run_id.clone(), "one".into())
                    .await
                    .unwrap()
                    .unwrap();
                assert!(tool.output().is_none());
                assert!(tool.result_sequence().is_none());
                assert!(tool.finished_sequence().is_none());
                assert!(
                    rig.session
                        .tool_result(rig.run_id.clone(), "later".into())
                        .await
                        .unwrap()
                        .is_none()
                );
            }
        }
        if record != Record::ToolResult {
            assert_eq!(count(&rig.script.records.calls), 0);
            assert_eq!(count(&rig.script.records.closes), 0);
            assert!(rig.script.records.inputs.lock().unwrap().is_empty());
        }
        rig.close().await;
    }
}

#[tokio::test]
async fn labelled_unknown_commits_reconcile_both_outcomes_by_read_only_receipt_lookup() {
    for record in [
        Record::Acceptance,
        Record::RunStarted,
        Record::ToolResult,
        Record::RunFinished,
        Record::FinalResult,
    ] {
        for fault in [Fault::UnknownBeforeCommit, Fault::UnknownAfterCommit] {
            let calls = if record == Record::ToolResult {
                vec![call("one", 17, 25), call("later", 1, 2)]
            } else {
                vec![]
            };
            let model = response("r1", calls, "private unknown-commit result");
            let rig = Rig::new(vec![Step::Response(model.clone())], ToolMode::ErrorShaped).await;
            let failure = fail_record(&rig, record, fault).await;
            let saved = rig.session.run_record(rig.run_id.clone()).await.unwrap();
            if record == Record::Acceptance {
                assert_eq!(saved.is_some(), fault.committed());
                if let Some(saved) = saved {
                    assert_eq!(saved.state(), RecordedRunState::Accepted);
                }
            } else {
                let saved = saved.unwrap();
                assert_eq!(
                    saved.result_sequence().is_some(),
                    record == Record::FinalResult && fault.committed()
                );
                if record == Record::RunStarted {
                    observed_sink_failure(
                        &failure,
                        RunOutcome::Failed {
                            code: "event_sink".into(),
                        },
                    );
                    assert_eq!(
                        saved.state(),
                        if fault.committed() {
                            RecordedRunState::Running
                        } else {
                            RecordedRunState::Accepted
                        }
                    );
                } else if record == Record::ToolResult {
                    observed_sink_failure(
                        &failure,
                        RunOutcome::Failed {
                            code: "event_sink".into(),
                        },
                    );
                    assert_eq!(saved.state(), RecordedRunState::Running);
                    let tool = rig
                        .session
                        .tool_result(rig.run_id.clone(), "one".into())
                        .await
                        .unwrap()
                        .unwrap();
                    let expected =
                        json!({"error":{"code":"not_an_error","text":"雪\n\0\\\""}}).to_string();
                    assert_eq!(
                        tool.output(),
                        fault.committed().then_some(expected.as_str())
                    );
                    assert_eq!(tool.is_error(), fault.committed().then_some(false));
                    assert!(tool.finished_sequence().is_none());
                    assert!(
                        rig.session
                            .tool_result(rig.run_id.clone(), "later".into())
                            .await
                            .unwrap()
                            .is_none()
                    );
                    one_request(&rig, 1);
                } else {
                    completed_response(&failure, &rig, &model);
                    if record == Record::RunFinished {
                        observed_sink_failure(&failure, RunOutcome::Completed);
                        assert_eq!(
                            saved.state(),
                            if fault.committed() {
                                RecordedRunState::Completed
                            } else {
                                RecordedRunState::Running
                            }
                        );
                        assert_eq!(saved.terminal_sequence().is_some(), fault.committed());
                    } else {
                        assert_eq!(saved.state(), RecordedRunState::Completed);
                        assert_eq!(saved.terminal_sequence(), Some(8));
                        assert!(failure.observed_result().unwrap().events_complete);
                        assert_eq!(failure.observed_result().unwrap().sink_error, None);
                        if fault.committed() {
                            assert_eq!(
                                value(saved.result().unwrap()),
                                value(failure.observed_result().unwrap())
                            );
                        }
                    }
                }
            }
            if matches!(record, Record::Acceptance | Record::RunStarted) {
                assert_eq!(count(&rig.script.records.opens), 0);
                assert_eq!(count(&rig.script.records.calls), 0);
                assert_eq!(count(&rig.script.records.closes), 0);
                assert!(rig.script.records.inputs.lock().unwrap().is_empty());
            }
            rig.close().await;
        }
    }
}

#[tokio::test]
async fn failure_diagnostics_hide_input_output_native_paths_and_receipt_identities() {
    let mut model = response("final", vec![], "private-output-canary λ\n\0");
    model.native = json!({"private-native-canary": "native secret canary"});
    let rig = Rig::new(
        vec![
            Step::Response(response("r1", vec![call("one", 17, 25)], "")),
            Step::Response(model.clone()),
        ],
        ToolMode::ErrorShaped,
    )
    .await;
    let failure = fail_record(&rig, Record::FinalResult, Fault::Rollback).await;
    let observed = failure.observed_result().unwrap();
    assert_eq!(
        value(observed.last_response.as_ref().unwrap()),
        value(&model)
    );
    let output = rig
        .session
        .tool_result(rig.run_id.clone(), "one".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        output.output(),
        Some(
            json!({"error":{"code":"not_an_error","text":"雪\n\0\\\""}})
                .to_string()
                .as_str()
        )
    );
    assert_eq!(output.is_error(), Some(false));
    let diagnostics = format!(
        "{failure:?} {failure} {:?} {} {:?}",
        failure.cause(),
        failure.cause(),
        rig.request()
    );
    for canary in [
        "private-output-canary",
        "private-native-canary",
        "native secret canary",
        "not_an_error",
        rig.input.user_text(),
        rig.input.prepared_request().prompt.as_str(),
        rig.temp.path().to_str().unwrap(),
        rig.run_id.as_str(),
        rig.operation_id.as_str(),
        failure.operation_id().unwrap().as_str(),
        output.output().unwrap(),
    ] {
        assert!(!diagnostics.contains(canary));
    }
    assert!(observed.events_complete);
    assert_eq!(observed.sink_error, None);
    assert_eq!(count(&rig.script.records.calls), 1);
    assert_eq!(rig.script.records.inputs.lock().unwrap().len(), 2);
    rig.close().await;

    let rig = Rig::new(vec![], ToolMode::Add).await;
    let failure = run_persisted(
        &Gateway::new(),
        &rig.session,
        rig.request(),
        &rig.tools,
        CancellationToken::new(),
    )
    .await
    .unwrap_err();
    static_failure(&failure, PersistentRunStage::Preflight, "gateway");
    assert!(matches!(
        failure.cause(),
        PersistentRunCause::Gateway(GatewayError::UnknownProvider)
    ));
    assert!(failure.operation_id().is_none());
    assert!(failure.acceptance().is_none());
    assert!(failure.observed_result().is_none());
    assert_eq!(history(&rig.session).await.len(), 1);
    assert_eq!(count(&rig.script.records.opens), 0);
    rig.close().await;
}

#[tokio::test]
async fn returned_receipts_stay_at_two_and_intermediate_single_record_receipts_remain_queryable() {
    for cycles in [0, 3] {
        let mut steps = Vec::new();
        for cycle in 0..cycles {
            steps.push(Step::Response(response(
                &format!("r{cycle}"),
                vec![call(&format!("call-{cycle}"), 17, 25)],
                "",
            )));
        }
        steps.push(Step::Response(response(
            "final",
            vec![],
            "receipt-bound canary",
        )));
        let rig = Rig::new(steps, ToolMode::Add).await;
        let returned = watchdog(rig.start(CancellationToken::new()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            format!("{returned:?}"),
            "PersistentRunResult::Executed([redacted])"
        );
        let (acceptance, final_record, result) = executed(returned);
        assert_eq!(result.outcome, RunOutcome::Completed);
        assert_eq!(count(&rig.script.records.calls), cycles);
        let returned_ids = [
            acceptance.receipt().operation_id(),
            final_record.receipt().operation_id(),
        ];
        assert_ne!(returned_ids[0], returned_ids[1]);
        let mut reader = connection(&rig, true).await;
        let commands = operations(&mut reader).await;
        let records = rows(&mut reader).await;
        assert_eq!(commands.len(), records.len() - 1);
        assert_eq!(commands.len(), 8 + cycles * 7);
        let ids = commands
            .iter()
            .map(|(id, _, _)| id)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), commands.len());
        assert_eq!(
            commands
                .iter()
                .filter(|(id, _, _)| returned_ids.iter().any(|returned| returned.as_str() == id))
                .count(),
            2
        );
        for (index, (id, first, last)) in commands.iter().enumerate() {
            assert_eq!(first, last);
            assert_eq!(*first, index as i64 + 2);
            let operation: OperationId = id.parse().unwrap();
            let receipt = rig
                .session
                .lookup_receipt(operation.clone())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(receipt.operation_id(), &operation);
            assert_eq!(receipt.run_id(), Some(&rig.run_id));
            assert_eq!(
                (receipt.first_sequence(), receipt.last_sequence()),
                (*first as u64, *last as u64)
            );
        }
        assert_eq!(rig.script.records.inputs.lock().unwrap().len(), cycles + 1);
        assert_eq!(count(&rig.script.records.closes), 1);
        reader.close().await.unwrap();
        rig.close().await;
    }
}

#[tokio::test]
async fn committed_cleanup_warnings_stop_at_acceptance_intent_result_and_run_finished() {
    for record in [
        Record::Acceptance,
        Record::ToolIntent,
        Record::ToolResult,
        Record::RunFinished,
    ] {
        let calls = if record == Record::RunFinished {
            vec![]
        } else {
            vec![call("one", 17, 25), call("later", 1, 2)]
        };
        let model = response("r1", calls, "private cleanup-warning result");
        let rig = Rig::new(vec![Step::Response(model.clone())], ToolMode::ErrorShaped).await;
        let failure = fail_record(&rig, record, Fault::Cleanup).await;
        let saved = rig
            .session
            .run_record(rig.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert!(saved.result_sequence().is_none());
        assert!(saved.result().is_none());
        if record == Record::Acceptance {
            assert_eq!(saved.state(), RecordedRunState::Accepted);
            assert_eq!(count(&rig.script.records.opens), 0);
            assert_eq!(count(&rig.script.records.closes), 0);
            assert_eq!(count(&rig.script.records.calls), 0);
            assert!(rig.script.records.inputs.lock().unwrap().is_empty());
        } else if record == Record::RunFinished {
            completed_response(&failure, &rig, &model);
            observed_sink_failure(&failure, RunOutcome::Completed);
            assert_eq!(saved.state(), RecordedRunState::Completed);
        } else {
            observed_sink_failure(
                &failure,
                RunOutcome::Failed {
                    code: "event_sink".into(),
                },
            );
            assert_eq!(saved.state(), RecordedRunState::Running);
            let tool = rig
                .session
                .tool_result(rig.run_id.clone(), "one".into())
                .await
                .unwrap()
                .unwrap();
            assert!(tool.finished_sequence().is_none());
            if record == Record::ToolResult {
                assert_eq!(
                    tool.output(),
                    Some(
                        json!({"error":{"code":"not_an_error","text":"雪\n\0\\\""}})
                            .to_string()
                            .as_str()
                    )
                );
                assert_eq!(tool.is_error(), Some(false));
                one_request(&rig, 1);
            } else {
                assert!(tool.output().is_none());
                one_request(&rig, 0);
            }
            assert!(
                rig.session
                    .tool_result(rig.run_id.clone(), "later".into())
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        rig.close().await;
    }
}
