use super::*;
use crate::{
    run::{RunEventEnvelope, RunResult, RunSummary, TurnOutcome},
    storage::{AppendRunRecord, RecordedProviderBinding, StoredEventId},
    tools::ToolExecutionEvent,
};

async fn fixture() -> (tempfile::TempDir, SessionStore, Database, CommitReceipt) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("private-data-canary");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "private-project-browser\r\n").unwrap();
    let store = SessionStore::open(root.clone()).await.unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "task audit".into(), None).unwrap())
        .await
        .unwrap();
    let sid = created.session_id().clone();
    let session = store.open_session(sid.clone()).await.unwrap();
    let db = Database {
        root,
        session: Arc::default(),
        read_failure: Arc::default(),
        reader: Arc::default(),
    };
    db.open(sid).await;
    let catalog = crate::context::discover(crate::context::ContextRoots {
        workspace,
        global_skills: temp.path().join("skills"),
    })
    .unwrap();
    let mut tools = crate::tools::ToolRegistry::new();
    tools.register(Arc::new(crate::tools::AddNumbers)).unwrap();
    let prepared = crate::context::prepare_run(
        crate::run::RunRequest {
            provider_id: PROVIDER_ID.into(),
            options: SessionOptions::new(MODEL),
            prompt: TASKS[0].into(),
        },
        &catalog,
        &[],
        &tools,
    )
    .unwrap();
    let input = RecordedRunInput::capture(TASKS[0].into(), &prepared, &tools).unwrap();
    let selection = crate::execution::prepare_session_replay(&session, PROVIDER_ID, MODEL)
        .await
        .unwrap()
        .selection();
    let commit = session
        .accept_history_run(OperationId::new(), RunId::new(), input, selection)
        .await
        .unwrap();
    (temp, store, db, commit.receipt().clone())
}

async fn complete(store: &SessionStore, db: &Database, receipt: &CommitReceipt) {
    let run = receipt.run_id().unwrap();
    let session = store
        .open_session(receipt.session_id().clone())
        .await
        .unwrap();
    let runtime = |sequence, event| {
        AppendRunRecord::Runtime(RunEventEnvelope {
            schema_version: 2,
            sequence,
            event_id: StoredEventId::new().to_string(),
            run_id: run.to_string(),
            turn_id: if matches!(event, RunEvent::RunStarted | RunEvent::RunFinished { .. }) {
                None
            } else {
                Some("private-turn-canary".into())
            },
            session_id: if matches!(event, RunEvent::RunStarted) {
                None
            } else {
                Some("private-provider-session-canary".into())
            },
            request_id: if matches!(event, RunEvent::RunStarted | RunEvent::TurnStarted { .. }) {
                None
            } else {
                Some("private-request-canary".into())
            },
            event,
        })
    };
    let binding = RecordedProviderBinding::new(
        run.clone(),
        "private-provider-session-canary".into(),
        MODEL.into(),
        crate::ReplayIdentity::new(PROVIDER_ID.into(), "native-v1".into(), "a".repeat(64)).unwrap(),
    )
    .unwrap();
    let summary = RunSummary {
        turns_started: 1,
        turns_finished: 1,
        new_tool_dispatches: 1,
        tool_results_prepared: 1,
        last_request_id: Some("private-request-canary".into()),
        ..RunSummary::default()
    };
    // Actual storage appends supply all four record types and multi-record batch timestamps.
    let batches = [
        vec![
            runtime(1, RunEvent::RunStarted),
            AppendRunRecord::ProviderBinding(binding),
        ],
        vec![
            runtime(2, RunEvent::TurnStarted { number: 1 }),
            runtime(
                3,
                RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolExecutionStarted {
                        call_id: "private-call-canary".into(),
                        tool_name: "add_numbers".into(),
                    },
                },
            ),
        ],
        vec![
            AppendRunRecord::ToolResult {
                request_id: Some("private-request-canary".into()),
                call_id: "private-call-canary".into(),
                output: OUTPUTS[0].into(),
                is_error: false,
            },
            runtime(
                4,
                RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolExecutionFinished {
                        call_id: "private-call-canary".into(),
                        tool_name: "add_numbers".into(),
                        is_error: false,
                    },
                },
            ),
            runtime(
                5,
                RunEvent::TurnFinished {
                    number: 1,
                    response_id: None,
                    outcome: TurnOutcome::ToolsPrepared,
                    upstream_outcome: None,
                },
            ),
        ],
    ];
    for batch in batches {
        session
            .append_run_records(OperationId::new(), run.clone(), batch)
            .await
            .unwrap();
        let snapshot = inspect(db, 1).await;
        assert!(snapshot["exact"] == true && snapshot["run_state"] == "running");
    }
    session
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![runtime(
                6,
                RunEvent::RunFinished {
                    outcome: RunOutcome::Completed,
                    summary: summary.clone(),
                },
            )],
        )
        .await
        .unwrap();
    session
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![AppendRunRecord::Result(RunResult {
                run_id: run.to_string(),
                session_id: Some("private-provider-session-canary".into()),
                outcome: RunOutcome::Completed,
                summary,
                last_response: None,
                events_complete: true,
                sink_error: None,
            })],
        )
        .await
        .unwrap();
    let snapshot = inspect(db, 1).await;
    assert!(
        snapshot["exact"] == true
            && snapshot["run_state"] == "completed"
            && snapshot["sequence_count"] == "12"
    );
    let bytes = snapshot.to_string();
    assert!(bytes.len() < LIMIT as usize);
    for private in [
        "private-",
        "terminal_json",
        "payload_hash",
        "source_event_id",
        "prepared_request",
    ] {
        assert!(!bytes.contains(private), "audit leaked private evidence");
    }
}

async fn corruption_writer(db: &Database) -> SqliteConnection {
    let sid = db.session.lock().unwrap().clone().unwrap();
    let mut writer = SqliteConnectOptions::new()
        .filename(
            db.root
                .join("sessions")
                .join(&sid.as_str()[..2])
                .join(sid.as_str())
                .join("session.sqlite3"),
        )
        .disable_statement_logging()
        .connect()
        .await
        .unwrap();
    // Only disposable unit fixtures lose guards; joined audits always use read-only SQLite.
    sqlx::raw_sql("DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete; DROP TRIGGER commands_no_update; DROP TRIGGER commands_no_delete; PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON;")
        .execute(&mut writer).await.unwrap();
    writer
}

async fn close(temp: tempfile::TempDir, store: SessionStore, db: Database) {
    store.close().await.unwrap();
    db.reader
        .lock()
        .await
        .take()
        .unwrap()
        .close()
        .await
        .unwrap();
    temp.close().unwrap();
}

#[tokio::test]
async fn task_audit_proves_acceptance_without_exporting_payloads() {
    let (temp, store, db, receipt) = fixture().await;
    let evidence = inspect(&db, 1).await;
    assert!(
        evidence["receipt"]
            == serde_json::to_value(crate::http_api::dto::ReceiptView::from(&receipt)).unwrap()
    );
    assert!(
        evidence["exact"] == true
            && evidence["sequence_count"] == "3"
            && evidence["run_state"] == "accepted"
    );
    assert!(
        evidence["deltas"] == 0 && evidence["tool_starts"] == 0 && evidence["tool_finishes"] == 0
    );
    let bytes = evidence.to_string();
    for private in [
        TASKS[0],
        temp.path().to_str().unwrap(),
        "prepared_request",
        "history_digest",
        "payload_hash",
        "owner_instance_id",
    ] {
        assert!(
            !bytes.contains(private) && !bytes.contains(&serde_json::to_string(private).unwrap()),
            "audit leaked private evidence"
        );
    }
    // Unknown input fields cannot turn the read-only control into a payload channel.
    assert!(serde_json::from_value::<Control>(json!({"command":"inspect_task","id":1})).is_ok());
    assert!(
        serde_json::from_value::<Control>(
            json!({"command":"inspect_task","id":1,"text":"private-canary"})
        )
        .is_err()
    );
    close(temp, store, db).await;
}

#[tokio::test]
async fn task_audit_rejects_corrupt_command_receipt_acceptance_and_checkpoint() {
    let cases = [
        ("method", "UPDATE commands SET method='private-canary'"),
        ("hash", "UPDATE commands SET payload_hash=zeroblob(32)"),
        (
            "operation",
            "UPDATE commands SET operation_id='ab123456-789a-4bcd-8abc-0123456789b1'",
        ),
        ("first", "UPDATE commands SET first_sequence=1"),
        ("last", "UPDATE commands SET last_sequence=4"),
        (
            "receipt_operation",
            "UPDATE commands SET receipt_json=json_set(receipt_json,'$.operation_id','ab123456-789a-4bcd-8abc-0123456789b1')",
        ),
        (
            "receipt_session",
            "UPDATE commands SET receipt_json=json_set(receipt_json,'$.session_id','ab123456-789a-4bcd-8abc-0123456789b1')",
        ),
        (
            "receipt_run",
            "UPDATE commands SET receipt_json=json_set(receipt_json,'$.run_id','ab123456-789a-4bcd-8abc-0123456789b1')",
        ),
        (
            "receipt_range",
            "UPDATE commands SET receipt_json=json_set(receipt_json,'$.last_sequence',4)",
        ),
        ("missing_command", "DELETE FROM commands"),
        (
            "extra_command",
            "INSERT INTO commands SELECT 'ab123456-789a-4bcd-8abc-0123456789b1',method,payload_hash,first_sequence,last_sequence,receipt_json FROM commands",
        ),
        (
            "premature_tool",
            "INSERT INTO tool_results(run_id,call_id,tool_name,started_sequence) SELECT run_id,'private-canary','add_numbers',2 FROM runs",
        ),
        ("premature_completed", "UPDATE runs SET state='completed'"),
        ("premature_running", "UPDATE runs SET state='running'"),
        (
            "premature_terminal",
            "UPDATE runs SET terminal_sequence=2,terminal_json='{}'",
        ),
        ("premature_result", "UPDATE runs SET result_sequence=3"),
        ("run_sequence", "UPDATE runs SET accepted_sequence=3"),
        (
            "run_owner",
            "UPDATE runs SET owner_instance_id='ab123456-789a-4bcd-8abc-0123456789b1'",
        ),
        (
            "extra_run",
            "INSERT INTO runs (run_id,accepted_sequence,state,last_runtime_sequence,owner_instance_id) SELECT 'ab123456-789a-4bcd-8abc-0123456789b1',3,'completed',last_runtime_sequence,owner_instance_id FROM runs",
        ),
        (
            "event_sequence",
            "UPDATE events SET sequence=4 WHERE sequence=3",
        ),
        (
            "event_id",
            "UPDATE events SET event_id='private-canary' WHERE sequence=2",
        ),
        (
            "event_type",
            "UPDATE events SET event_type='session.renamed' WHERE sequence=3",
        ),
        (
            "event_version",
            "UPDATE events SET event_version=2 WHERE sequence=2",
        ),
        (
            "event_timestamp",
            "UPDATE events SET created_at_ms=created_at_ms+1 WHERE sequence=3",
        ),
        (
            "event_run",
            "UPDATE events SET run_id='ab123456-789a-4bcd-8abc-0123456789b1' WHERE sequence=2",
        ),
        (
            "source_event",
            "UPDATE events SET source_event_id='private-canary' WHERE sequence=3",
        ),
        (
            "source_sequence",
            "UPDATE events SET source_sequence=1 WHERE sequence=2",
        ),
        (
            "user_text",
            "UPDATE events SET payload_json=json_set(payload_json,'$.input.user_text','private-canary') WHERE sequence=2",
        ),
        (
            "accepted_owner",
            "UPDATE events SET payload_json=json_set(payload_json,'$.owner_instance_id','ab123456-789a-4bcd-8abc-0123456789b1') WHERE sequence=2",
        ),
        (
            "checkpoint_run",
            "UPDATE events SET payload_json=json_set(payload_json,'$.run_id','ab123456-789a-4bcd-8abc-0123456789b1') WHERE sequence=3",
        ),
        (
            "checkpoint_head",
            "UPDATE events SET payload_json=json_set(payload_json,'$.selection.through_sequence',2) WHERE sequence=3",
        ),
        (
            "checkpoint_digest",
            "UPDATE events SET payload_json=json_set(payload_json,'$.selection.history_digest',printf('%064d',0)) WHERE sequence=3",
        ),
        (
            "checkpoint_extra",
            "UPDATE events SET payload_json=json_set(payload_json,'$.private','private-canary') WHERE sequence=3",
        ),
        ("missing_checkpoint", "DELETE FROM events WHERE sequence=3"),
        ("head", "UPDATE manifest SET head_sequence=4"),
    ];
    assert_corruptions(&cases, false).await;
}

#[tokio::test]
async fn task_audit_rejects_corrupt_completed_metadata_projection_and_appends() {
    let cases = [
        (
            "runtime_source_id_null",
            "UPDATE events SET source_event_id=NULL WHERE sequence=11",
        ),
        (
            "runtime_source_id_mismatch",
            "UPDATE events SET source_event_id='private-source-canary' WHERE sequence=11",
        ),
        (
            "runtime_source_sequence_null",
            "UPDATE events SET source_sequence=NULL WHERE sequence=11",
        ),
        (
            "runtime_source_sequence_mismatch",
            "UPDATE events SET source_sequence=99 WHERE sequence=11",
        ),
        (
            "binding_source_id",
            "UPDATE events SET source_event_id='private-source-canary' WHERE sequence=5",
        ),
        (
            "result_source_sequence",
            "UPDATE events SET source_sequence=99 WHERE sequence=12",
        ),
        (
            "later_event_version",
            "UPDATE events SET event_version=2 WHERE sequence=11",
        ),
        (
            "later_event_time",
            "UPDATE events SET created_at_ms=-1 WHERE sequence=11",
        ),
        (
            "later_event_run",
            "UPDATE events SET run_id='ab123456-789a-4bcd-8abc-0123456789b1' WHERE sequence=11",
        ),
        (
            "last_runtime_sequence",
            "UPDATE runs SET last_runtime_sequence=99",
        ),
        ("provider_null", "UPDATE runs SET provider_session_id=NULL"),
        (
            "provider_mismatch",
            "UPDATE runs SET provider_session_id='private-provider-canary'",
        ),
        ("state_accepted", "UPDATE runs SET state='accepted'"),
        ("state_running", "UPDATE runs SET state='running'"),
        (
            "terminal_sequence_null",
            "UPDATE runs SET terminal_sequence=NULL",
        ),
        (
            "terminal_sequence_mismatch",
            "UPDATE runs SET terminal_sequence=10",
        ),
        ("terminal_json_null", "UPDATE runs SET terminal_json=NULL"),
        (
            "terminal_json_mismatch",
            "UPDATE runs SET terminal_json=json_set(terminal_json,'$.session_id','private-provider-canary')",
        ),
        (
            "terminal_json_malformed",
            "UPDATE runs SET terminal_json='private-native-canary'",
        ),
        (
            "terminal_both_missing",
            "UPDATE runs SET terminal_sequence=NULL,terminal_json=NULL",
        ),
        (
            "result_sequence_null",
            "UPDATE runs SET result_sequence=NULL",
        ),
        (
            "result_sequence_mismatch",
            "UPDATE runs SET result_sequence=11",
        ),
        (
            "coherent_accepted_projection",
            "UPDATE runs SET state='accepted',last_runtime_sequence=0,provider_session_id=NULL,terminal_sequence=NULL,terminal_json=NULL,result_sequence=NULL",
        ),
        (
            "append_hash",
            "UPDATE commands SET payload_hash=zeroblob(32) WHERE first_sequence=4",
        ),
        (
            "tool_batch_hash",
            "UPDATE commands SET payload_hash=zeroblob(32) WHERE first_sequence=8",
        ),
        (
            "result_hash",
            "UPDATE commands SET payload_hash=zeroblob(32) WHERE first_sequence=12",
        ),
        (
            "append_method",
            "UPDATE commands SET method='private-method-canary' WHERE first_sequence=4",
        ),
        (
            "append_receipt_identity",
            "UPDATE commands SET receipt_json=json_set(receipt_json,'$.operation_id','ab123456-789a-4bcd-8abc-0123456789b1') WHERE first_sequence=4",
        ),
        (
            "append_receipt_session",
            "UPDATE commands SET receipt_json=json_set(receipt_json,'$.session_id','ab123456-789a-4bcd-8abc-0123456789b1') WHERE first_sequence=4",
        ),
        (
            "append_receipt_run",
            "UPDATE commands SET receipt_json=json_set(receipt_json,'$.run_id','ab123456-789a-4bcd-8abc-0123456789b1') WHERE first_sequence=4",
        ),
        // Keep altered receipts and timestamps coherent so the range hash must detect these edits.
        (
            "append_range_repartitioned",
            "UPDATE events SET created_at_ms=(SELECT created_at_ms FROM events WHERE sequence=4) WHERE sequence=6; UPDATE commands SET last_sequence=6,receipt_json=json_set(receipt_json,'$.last_sequence',6) WHERE first_sequence=4; UPDATE commands SET first_sequence=7,receipt_json=json_set(receipt_json,'$.first_sequence',7) WHERE first_sequence=6;",
        ),
        (
            "append_range_merged",
            "UPDATE events SET created_at_ms=(SELECT created_at_ms FROM events WHERE sequence=4) WHERE sequence BETWEEN 4 AND 7; DELETE FROM commands WHERE first_sequence=6; UPDATE commands SET last_sequence=7,receipt_json=json_set(receipt_json,'$.last_sequence',7) WHERE first_sequence=4;",
        ),
        (
            "append_range_deleted",
            "DELETE FROM commands WHERE first_sequence=6",
        ),
        (
            "result_deleted_coherently",
            "DELETE FROM commands WHERE first_sequence=12; DELETE FROM events WHERE sequence=12; UPDATE runs SET result_sequence=NULL; UPDATE manifest SET head_sequence=11,updated_at_ms=(SELECT created_at_ms FROM events WHERE sequence=11);",
        ),
        (
            "manifest_timestamp",
            "UPDATE manifest SET updated_at_ms=updated_at_ms+1",
        ),
        (
            "append_batch_timestamp",
            "UPDATE events SET created_at_ms=created_at_ms+1 WHERE sequence=5",
        ),
        (
            "projection_invalid_utf8",
            "UPDATE runs SET terminal_json=CAST(x'80' AS TEXT)",
        ),
    ];
    assert_corruptions(&cases, true).await;
}

#[tokio::test]
async fn task_audit_allows_wall_clock_regression_between_append_batches() {
    let (temp, store, db, receipt) = fixture().await;
    complete(&store, &db, &receipt).await;
    let mut writer = corruption_writer(&db).await;
    sqlx::query("UPDATE events SET created_at_ms=0 WHERE sequence BETWEEN 6 AND 7")
        .execute(&mut writer)
        .await
        .unwrap();
    writer.close().await.unwrap();
    assert!(inspect(&db, 1).await["exact"] == true);
    close(temp, store, db).await;
}

async fn assert_corruptions(cases: &[(&str, &'static str)], completed: bool) {
    let mut missed = vec![];
    for &(case, change) in cases {
        let (temp, store, db, receipt) = fixture().await;
        if completed {
            complete(&store, &db, &receipt).await;
        }
        assert!(inspect(&db, 1).await["exact"] == true);
        let mut writer = corruption_writer(&db).await;
        sqlx::raw_sql(change).execute(&mut writer).await.unwrap();
        writer.close().await.unwrap();
        match AssertUnwindSafe(inspect(&db, 2)).catch_unwind().await {
            Ok(_) => missed.push(case),
            Err(error) => {
                let message = error
                    .downcast_ref::<String>()
                    .map(String::as_str)
                    .or_else(|| error.downcast_ref::<&str>().copied())
                    .unwrap();
                assert!(
                    message == "task evidence mismatch",
                    "audit diagnostic was not static"
                );
            }
        }
        close(temp, store, db).await;
    }
    assert!(
        missed.is_empty(),
        "audit accepted corrupt invariants: {missed:?}"
    );
}
