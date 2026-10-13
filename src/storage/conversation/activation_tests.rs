use crate::{
    DeltaKind, EventEnvelope, ModelResponse, OutputProvenance, ProviderEvent, ReplayIdentity,
    ResponseOutcome, SessionOptions, UpstreamOutcome,
    run::{RunEvent, RunEventEnvelope, RunOutcome, RunRequest, RunResult, RunSummary, TurnOutcome},
    storage::{
        self,
        test_hooks::{Action, Pause, Point},
        *,
    },
    tools::ToolExecutionEvent,
};
use serde_json::{Value, json};
use sqlx::{ConnectOptions, Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{path::Path, sync::Arc};

fn input() -> RecordedRunInput {
    RecordedRunInput::new(
        " exact\0用户\n ".into(),
        RunRequest {
            provider_id: "synthetic".into(),
            options: SessionOptions::new("model"),
            prompt: "PRIVATE_PREPARED_CANARY".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap()
}
async fn setup() -> (
    tempfile::TempDir,
    SessionStore,
    SessionHandle,
    std::path::PathBuf,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let store = SessionStore::open(root.clone()).await.unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "synthetic".into(), None).unwrap())
        .await
        .unwrap();
    let handle = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let path = storage::filesystem::session_path(&root, handle.session_id(), false).unwrap();
    (temp, store, handle, path)
}
async fn sql(path: &Path) -> SqliteConnection {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .foreign_keys(true)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap()
}
async fn dump(connection: &mut SqliteConnection) -> Vec<String> {
    let mut values = Vec::new();
    for query in [
        "SELECT json_group_array(json_array(sequence,event_id,event_type,event_version,created_at_ms,run_id,source_event_id,source_sequence,payload_json)) FROM (SELECT * FROM events ORDER BY sequence)",
        "SELECT json_group_array(json_array(singleton,session_id,schema_version,format_version,title,workspace_json,created_at_ms,updated_at_ms,head_sequence,creation_provenance_json)) FROM manifest",
        "SELECT json_group_array(json_array(operation_id,method,hex(payload_hash),first_sequence,last_sequence,receipt_json)) FROM (SELECT * FROM commands ORDER BY operation_id)",
        "SELECT json_group_array(json_array(run_id,accepted_sequence,state,last_runtime_sequence,owner_instance_id,provider_session_id,terminal_sequence,terminal_json,result_sequence)) FROM (SELECT * FROM runs ORDER BY run_id)",
        "SELECT json_group_array(json_array(run_id,call_id,tool_name,request_id,started_sequence,finished_sequence,result_sequence,is_error,output)) FROM tool_results",
        "SELECT json_group_array(json_array(singleton,format_version,applied_sequence,metadata_sequence)) FROM conversation_projection",
        "SELECT json_group_array(json_array(run_id,accepted_sequence,changed_sequence,header_json)) FROM (SELECT * FROM conversation_blocks ORDER BY run_id)",
        "SELECT json_group_array(json_array(run_id,entry_id,hex(source_key),first_sequence,position_slot,changed_sequence,content_epoch,kind,metadata_json)) FROM (SELECT * FROM conversation_entries ORDER BY run_id,entry_id)",
        "SELECT json_group_array(json_array(run_id,entry_id,field_id,order_key,generation,byte_length,kind,metadata_json)) FROM (SELECT * FROM conversation_fields ORDER BY run_id,entry_id,field_id)",
        "SELECT json_group_array(json_array(run_id,entry_id,field_id,start_byte,hex(bytes))) FROM (SELECT * FROM conversation_chunks ORDER BY run_id,entry_id,field_id,start_byte)",
    ] {
        values.push(
            sqlx::query_scalar(query)
                .fetch_one(&mut *connection)
                .await
                .unwrap(),
        );
    }
    values
}
async fn watermark(path: &Path, expected: u64, metadata: u64) {
    let mut sql = sql(path).await;
    let heads:(i64,i64,i64,i64,i64)=sqlx::query_as("SELECT (SELECT user_version FROM pragma_user_version),schema_version,head_sequence,applied_sequence,metadata_sequence FROM manifest,conversation_projection")
        .fetch_one(&mut sql).await.unwrap();
    assert_eq!(
        heads,
        (3, 3, expected as i64, expected as i64, metadata as i64)
    );
    assert!(
        sqlx::query("SELECT 1 FROM pragma_foreign_key_check")
            .fetch_optional(&mut sql)
            .await
            .unwrap()
            .is_none()
    );
    sql.close().await.unwrap();
}
fn runtime(run: &RunId, sequence: u64, event: RunEvent) -> AppendRunRecord {
    let started = matches!(event, RunEvent::RunStarted);
    let no_request = started || matches!(event, RunEvent::TurnStarted { .. });
    let no_turn = started || matches!(event, RunEvent::RunFinished { .. });
    AppendRunRecord::Runtime(RunEventEnvelope {
        schema_version: 2,
        sequence,
        event_id: StoredEventId::new().as_str().into(),
        run_id: run.as_str().into(),
        session_id: if started {
            None
        } else {
            Some("session".into())
        },
        turn_id: if no_turn {
            None
        } else {
            Some("00000000-0000-4000-8000-000000000002".into())
        },
        request_id: if no_request {
            None
        } else {
            Some("00000000-0000-4000-8000-000000000001".into())
        },
        event,
    })
}
fn provider(run: &RunId, sequence: u64, event: ProviderEvent) -> AppendRunRecord {
    runtime(
        run,
        sequence,
        RunEvent::ProviderEvent {
            event: Box::new(EventEnvelope {
                schema_version: 1,
                sequence,
                event_id: StoredEventId::new().as_str().into(),
                session_id: "session".into(),
                request_id: Some("00000000-0000-4000-8000-000000000001".into()),
                provider: "synthetic".into(),
                provider_sequence: None,
                event,
            }),
        },
    )
}
fn delta(text: &str, kind: DeltaKind) -> ProviderEvent {
    ProviderEvent::OutputItemUpdated {
        response_id: "provisional".into(),
        item_id: "item".into(),
        output_index: 0,
        content_index: Some(0),
        summary_index: None,
        kind,
        delta: text.into(),
    }
}
fn files(path: &Path) -> Vec<Option<Vec<u8>>> {
    [
        path.to_path_buf(),
        path.with_file_name("session.sqlite3-wal"),
    ]
    .iter()
    .map(|p| std::fs::read(p).ok().filter(|bytes| !bytes.is_empty()))
    .collect()
}

#[tokio::test]
async fn a4_all_canonical_writers_apply_borrowed_events_and_duplicates_write_zero_bytes() {
    let (_temp, store, handle, path) = setup().await;
    watermark(&path, 1, 1).await;
    handle
        .rename(OperationId::new(), "renamed".into())
        .await
        .unwrap();
    watermark(&path, 2, 2).await;
    let mut raw = sql(&path).await;
    let selection = StoredHistorySelection::new(
        2,
        storage::history_prefix::digest(&mut raw, 2, &[])
            .await
            .unwrap(),
        "synthetic".into(),
        "model".into(),
        None,
    )
    .unwrap();
    raw.close().await.unwrap();
    let run = RunId::new();
    let op = OperationId::new();
    let receipt = handle
        .accept_history_run(op.clone(), run.clone(), input(), selection.clone())
        .await
        .unwrap();
    assert_eq!(
        (
            receipt.receipt().first_sequence(),
            receipt.receipt().last_sequence()
        ),
        (3, 4)
    );
    watermark(&path, 4, 2).await;
    let mut raw = sql(&path).await;
    let before = dump(&mut raw).await;
    let bytes = files(&path);
    let duplicate = handle
        .accept_history_run(op, run.clone(), input(), selection)
        .await
        .unwrap();
    assert!(duplicate.duplicate());
    assert_eq!(dump(&mut raw).await, before);
    assert_eq!(files(&path), bytes);
    let human: Vec<u8> =
        sqlx::query_scalar("SELECT bytes FROM conversation_chunks WHERE field_id='text'")
            .fetch_one(&mut raw)
            .await
            .unwrap();
    assert_eq!(human, input().user_text().as_bytes());
    raw.close().await.unwrap();
    let summary = RunSummary::default();
    let response = ModelResponse {
        id: "authoritative-different-id".into(),
        model: None,
        outcome: ResponseOutcome::Completed,
        text: "final\0雪".into(),
        output: vec![],
        output_provenance: OutputProvenance::NativeTerminal,
        native: json!({"output":[]}),
        usage: None,
    };
    let records = vec![
        runtime(&run, 1, RunEvent::RunStarted),
        AppendRunRecord::ProviderBinding(
            RecordedProviderBinding::new(
                run.clone(),
                "session".into(),
                "model".into(),
                ReplayIdentity::new("synthetic".into(), "native-v1".into(), "a".repeat(64))
                    .unwrap(),
            )
            .unwrap(),
        ),
        runtime(&run, 2, RunEvent::TurnStarted { number: 1 }),
        provider(&run, 3, delta("partial", DeltaKind::Text)),
        provider(&run, 4, delta("refusal", DeltaKind::Refusal)),
        provider(
            &run,
            5,
            ProviderEvent::ResponseFinished {
                response: response.clone(),
            },
        ),
        runtime(
            &run,
            6,
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionStarted {
                    call_id: "call".into(),
                    tool_name: "synthetic".into(),
                },
            },
        ),
        AppendRunRecord::ToolResult {
            request_id: Some("00000000-0000-4000-8000-000000000001".into()),
            call_id: "call".into(),
            output: " {\"error\":\"still success\"} \n雪\0".into(),
            is_error: false,
        },
        runtime(
            &run,
            7,
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionFinished {
                    call_id: "call".into(),
                    tool_name: "synthetic".into(),
                    is_error: false,
                },
            },
        ),
        runtime(
            &run,
            8,
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolResultReused {
                    call_id: "call".into(),
                    tool_name: "synthetic".into(),
                },
            },
        ),
        runtime(
            &run,
            9,
            RunEvent::TurnFinished {
                number: 1,
                response_id: Some(response.id.clone()),
                outcome: TurnOutcome::ModelCompleted,
                upstream_outcome: Some(UpstreamOutcome::TerminalReceived),
            },
        ),
        runtime(
            &run,
            10,
            RunEvent::RunFinished {
                outcome: RunOutcome::Completed,
                summary: summary.clone(),
            },
        ),
        AppendRunRecord::Result(RunResult {
            run_id: run.as_str().into(),
            session_id: Some("session".into()),
            outcome: RunOutcome::Completed,
            summary,
            last_response: Some(response),
            events_complete: true,
            sink_error: None,
        }),
    ];
    for (index, record) in records.iter().enumerate() {
        let op = OperationId::new();
        handle
            .append_run_records(op.clone(), run.clone(), vec![record.clone()])
            .await
            .unwrap();
        watermark(&path, 5 + index as u64, 2).await;
        let mut raw = sql(&path).await;
        let before = dump(&mut raw).await;
        let bytes = files(&path);
        assert!(
            handle
                .append_run_records(op, run.clone(), vec![record.clone()])
                .await
                .unwrap()
                .duplicate()
        );
        assert_eq!(dump(&mut raw).await, before);
        assert_eq!(files(&path), bytes);
        raw.close().await.unwrap();
    }
    let mut raw = sql(&path).await;
    let header: String = sqlx::query_scalar("SELECT header_json FROM conversation_blocks")
        .fetch_one(&mut raw)
        .await
        .unwrap();
    let header: Value = serde_json::from_str(&header).unwrap();
    assert_eq!(header["state"], "completed");
    assert_eq!(header["result_recorded"], true);
    assert_eq!(header["events_complete"], true);
    let entries: Vec<(String, String)> = sqlx::query_as(
        "SELECT kind,metadata_json FROM conversation_entries ORDER BY first_sequence,position_slot",
    )
    .fetch_all(&mut raw)
    .await
    .unwrap();
    assert_eq!(
        entries.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(),
        ["human", "assistant", "tool", "reuse"]
    );
    let tool: Value = serde_json::from_str(&entries[2].1).unwrap();
    assert_eq!(tool["result_recorded"], true);
    assert_eq!(tool["finish_recorded"], true);
    assert_eq!(tool["is_error"], false);
    let chunks:Vec<(String,Vec<u8>)>=sqlx::query_as("SELECT f.kind,c.bytes FROM conversation_fields f JOIN conversation_chunks c USING(run_id,entry_id,field_id) ORDER BY f.order_key,c.start_byte").fetch_all(&mut raw).await.unwrap();
    assert!(chunks.contains(&("authoritative_text".into(), "final\0雪".as_bytes().to_vec())));
    assert!(chunks.contains(&(
        "tool_result".into(),
        " {\"error\":\"still success\"} \n雪\0".as_bytes().to_vec()
    )));
    assert!(
        !dump(&mut raw).await[5..]
            .join("")
            .contains("PRIVATE_PREPARED_CANARY")
    );
    raw.close().await.unwrap();
    let run2 = RunId::new();
    let acceptance = OperationId::new();
    handle
        .accept_run(acceptance.clone(), run2.clone(), input())
        .await
        .unwrap();
    let mut raw = sql(&path).await;
    let before = dump(&mut raw).await;
    let bytes = files(&path);
    assert!(
        handle
            .accept_run(acceptance, run2.clone(), input())
            .await
            .unwrap()
            .duplicate()
    );
    assert_eq!(dump(&mut raw).await, before);
    assert_eq!(files(&path), bytes);
    raw.close().await.unwrap();
    handle
        .append_run_records(
            OperationId::new(),
            run2.clone(),
            vec![
                runtime(&run2, 1, RunEvent::RunStarted),
                runtime(&run2, 2, RunEvent::TurnStarted { number: 1 }),
                provider(&run2, 3, delta("partial retained", DeltaKind::Text)),
                runtime(
                    &run2,
                    4,
                    RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolExecutionStarted {
                            call_id: "pending".into(),
                            tool_name: "synthetic".into(),
                        },
                    },
                ),
            ],
        )
        .await
        .unwrap();
    let head = handle.manifest().await.unwrap().head_sequence();
    watermark(&path, head, 2).await;
    store.close().await.unwrap();
    let reopened = SessionStore::open(_temp.path().join("root")).await.unwrap();
    reopened
        .open_session(handle.session_id().clone())
        .await
        .unwrap();
    watermark(&path, head + 1, 2).await;
    let mut raw = sql(&path).await;
    let header: String =
        sqlx::query_scalar("SELECT header_json FROM conversation_blocks WHERE run_id=?")
            .bind(run2.as_str())
            .fetch_one(&mut raw)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&header).unwrap()["state"],
        "interrupted"
    );
    let bytes:Vec<u8>=sqlx::query_scalar("SELECT c.bytes FROM conversation_chunks c JOIN conversation_fields f USING(run_id,entry_id,field_id) WHERE c.run_id=? AND f.kind='text' AND c.field_id<>'text'").bind(run2.as_str()).fetch_one(&mut raw).await.unwrap();
    assert_eq!(bytes, b"partial retained");
    let pending: String = sqlx::query_scalar(
        "SELECT metadata_json FROM conversation_entries WHERE run_id=? AND kind='tool'",
    )
    .bind(run2.as_str())
    .fetch_one(&mut raw)
    .await
    .unwrap();
    let pending: Value = serde_json::from_str(&pending).unwrap();
    assert_eq!(pending["state"], "unknown");
    assert_eq!(pending["result_recorded"], false);
    assert_eq!(pending["finish_recorded"], false);
    assert!(pending["is_error"].is_null());
    raw.close().await.unwrap();
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn a4_canonical_active_turn_permits_repeated_terminal_and_later_content_without_new_entry() {
    let (_temp, store, handle, path) = setup().await;
    let run = RunId::new();
    handle
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    let response = |id: &str, text: &str| ModelResponse {
        id: id.into(),
        model: None,
        outcome: ResponseOutcome::Completed,
        text: text.into(),
        output: vec![],
        output_provenance: OutputProvenance::NativeTerminal,
        native: json!({"output": []}),
        usage: None,
    };
    handle
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![
                runtime(&run, 1, RunEvent::RunStarted),
                runtime(&run, 2, RunEvent::TurnStarted { number: 1 }),
                provider(
                    &run,
                    3,
                    ProviderEvent::ResponseFinished {
                        response: response("first", "first"),
                    },
                ),
                provider(
                    &run,
                    4,
                    ProviderEvent::ResponseFinished {
                        response: response("second", "replacement"),
                    },
                ),
                provider(&run, 5, delta("later", DeltaKind::Text)),
            ],
        )
        .await
        .unwrap();
    watermark(&path, 7, 1).await;
    let mut raw = sql(&path).await;
    storage::run_store::validate_run(&mut raw, handle.session_id(), &run)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM conversation_entries WHERE kind='assistant'"
        )
        .fetch_one(&mut raw)
        .await
        .unwrap(),
        1
    );
    let metadata: String =
        sqlx::query_scalar("SELECT metadata_json FROM conversation_entries WHERE kind='assistant'")
            .fetch_one(&mut raw)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&metadata).unwrap()["provisional"],
        true
    );
    raw.close().await.unwrap();
    store.close().await.unwrap();
}

#[tokio::test]
async fn a4_owned_atomicity_pause_rollback_batch_and_real_projection_constraint() {
    for accepted in [false, true] {
        for point in [Point::CanonicalInserted, Point::DisplayApplied] {
            let (_temp, store, handle, path) = setup().await;
            let run = RunId::new();
            if accepted {
                handle
                    .accept_run(OperationId::new(), run.clone(), input())
                    .await
                    .unwrap();
                handle
                    .append_run_records(
                        OperationId::new(),
                        run.clone(),
                        vec![
                            runtime(&run, 1, RunEvent::RunStarted),
                            runtime(&run, 2, RunEvent::TurnStarted { number: 1 }),
                            provider(&run, 3, delta("prior", DeltaKind::Text)),
                        ],
                    )
                    .await
                    .unwrap();
            }
            let mut reader = sql(&path).await;
            let before = dump(&mut reader).await;
            let pause = Arc::new(Pause {
                rollback: true,
                ..Pause::default()
            });
            store.inner.hooks.arm(point, Action::Pause(pause.clone()));
            let operation = OperationId::new();
            let waiter = tokio::spawn({
                let handle = handle.clone();
                let run = run.clone();
                let operation = operation.clone();
                async move {
                    if accepted {
                        let record = provider(&run, 4, delta("not published", DeltaKind::Text));
                        handle
                            .append_run_records(operation, run, vec![record])
                            .await
                    } else {
                        handle.accept_run(operation, run, input()).await
                    }
                }
            });
            tokio::time::timeout(std::time::Duration::from_secs(10), pause.reached.notified())
                .await
                .unwrap();
            let mut transaction = reader.begin().await.unwrap();
            assert_eq!(dump(&mut transaction).await, before);
            transaction.rollback().await.unwrap();
            pause.release.notify_one();
            let error = waiter.await.unwrap().unwrap_err();
            assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
            assert_eq!(dump(&mut reader).await, before);
            assert!(handle.lookup_receipt(operation).await.unwrap().is_none());
            reader.close().await.unwrap();
            store.close().await.unwrap();
        }
    }
}

#[tokio::test]
async fn a4_declared_three_corruption_and_future_four_fail_without_overwrite() {
    for (mutation, code) in [
        ("DROP TABLE conversation_chunks", "storage.integrity"),
        (
            "DROP INDEX conversation_entries_changed",
            "storage.integrity",
        ),
        (
            "UPDATE conversation_projection SET applied_sequence=2",
            "storage.integrity",
        ),
        (
            "UPDATE conversation_projection SET metadata_sequence=2",
            "storage.integrity",
        ),
        ("DELETE FROM conversation_projection", "storage.integrity"),
        (
            "PRAGMA user_version=4; UPDATE manifest SET schema_version=4",
            "storage.unsupported_version",
        ),
    ] {
        let (_temp, store, handle, path) = setup().await;
        let healthy = store
            .create_session(CreateSession::new(OperationId::new(), "healthy".into(), None).unwrap())
            .await
            .unwrap();
        let mut raw = sql(&path).await;
        sqlx::raw_sql(mutation).execute(&mut raw).await.unwrap();
        raw.close().await.unwrap();
        let before = files(&path);
        let error = store
            .open_session(handle.session_id().clone())
            .await
            .unwrap_err();
        assert_eq!(error.code(), code, "{mutation}");
        assert!(
            files(&path) == before,
            "physical session bytes changed: {mutation}; before_lengths={:?} after_lengths={:?}",
            before
                .iter()
                .map(|b| b.as_ref().map(Vec::len))
                .collect::<Vec<_>>(),
            files(&path)
                .iter()
                .map(|b| b.as_ref().map(Vec::len))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            store
                .open_session(healthy.session_id().clone())
                .await
                .unwrap()
                .manifest()
                .await
                .unwrap()
                .head_sequence(),
            1
        );
        store.close().await.unwrap();
        assert!(
            files(&path) == before,
            "physical session bytes changed at close: {mutation}"
        );
    }
}

async fn stale_metadata_open(stale: i64, identical_titles: bool, later_run_events: bool) {
    let (_temp, store, handle, path) = setup().await;
    for title in ["first rename", "latest rename"] {
        let title = if identical_titles { "synthetic" } else { title };
        handle
            .rename(OperationId::new(), title.into())
            .await
            .unwrap();
    }
    if later_run_events {
        let run = RunId::new();
        handle
            .accept_run(OperationId::new(), run.clone(), input())
            .await
            .unwrap();
        handle
            .append_run_records(
                OperationId::new(),
                run.clone(),
                vec![
                    runtime(&run, 1, RunEvent::RunStarted),
                    runtime(&run, 2, RunEvent::TurnStarted { number: 1 }),
                    provider(&run, 3, delta("later run text", DeltaKind::Text)),
                ],
            )
            .await
            .unwrap();
    }
    let head = handle.manifest().await.unwrap().head_sequence();
    watermark(&path, head, 3).await;
    let opened = store
        .open_session(handle.session_id().clone())
        .await
        .unwrap();
    assert_eq!(opened.manifest().await.unwrap().head_sequence(), head);

    let mut raw = sql(&path).await;
    sqlx::query("UPDATE conversation_projection SET metadata_sequence=?")
        .bind(stale)
        .execute(&mut raw)
        .await
        .unwrap();
    let before = dump(&mut raw).await;
    // Keep this connection open so failed activation also has a real WAL to preserve.
    let bytes = files(&path);
    assert!(bytes[1].is_some());
    let error = store
        .open_session(handle.session_id().clone())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "storage.integrity", "stale revision {stale}");
    assert_eq!(dump(&mut raw).await, before);
    assert_eq!(
        files(&path),
        bytes,
        "failed open changed database/WAL bytes"
    );
    store.close().await.unwrap();
    assert_eq!(
        files(&path),
        bytes,
        "store close changed database/WAL bytes"
    );
    raw.close().await.unwrap();
}

#[tokio::test]
async fn a4_latest_metadata_rejects_stale_rename() {
    stale_metadata_open(2, false, false).await;
}

#[tokio::test]
async fn a4_latest_metadata_rejects_stale_creation() {
    stale_metadata_open(1, false, false).await;
}

#[tokio::test]
async fn a4_latest_metadata_identical_titles_do_not_hide_stale_revisions() {
    for stale in [2, 1] {
        stale_metadata_open(stale, true, false).await;
    }
}

#[tokio::test]
async fn a4_latest_metadata_later_run_events_keep_correct_revision_but_reject_stale() {
    for stale in [2, 1] {
        stale_metadata_open(stale, false, true).await;
    }
}

#[tokio::test]
async fn a4_latest_metadata_does_not_skip_unexpected_runless_event() {
    let (_temp, store, handle, path) = setup().await;
    handle
        .rename(OperationId::new(), "renamed".into())
        .await
        .unwrap();
    let mut raw = sql(&path).await;
    // This deliberately corrupt row must not be filtered out in favor of the valid rename.
    sqlx::query("INSERT INTO events(sequence,event_id,event_type,event_version,created_at_ms,payload_json) SELECT 3,?,'run.interrupted',1,updated_at_ms,'{}' FROM manifest")
        .bind(StoredEventId::new().as_str()).execute(&mut raw).await.unwrap();
    sqlx::raw_sql("UPDATE manifest SET head_sequence=3; UPDATE conversation_projection SET applied_sequence=3")
        .execute(&mut raw).await.unwrap();
    let before = dump(&mut raw).await;
    let bytes = files(&path);
    assert!(bytes[1].is_some());
    assert_eq!(
        store
            .open_session(handle.session_id().clone())
            .await
            .unwrap_err()
            .code(),
        "storage.integrity"
    );
    assert_eq!(dump(&mut raw).await, before);
    assert_eq!(files(&path), bytes);
    store.close().await.unwrap();
    assert_eq!(files(&path), bytes);
    raw.close().await.unwrap();
}

#[tokio::test]
async fn a4_latest_metadata_lookup_uses_existing_index_without_payload_or_history_scan() {
    let mut raw = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(storage::session_schema::V2)
        .execute(&mut raw)
        .await
        .unwrap();
    let ddl: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='events_run_sequence'")
            .fetch_one(&mut raw)
            .await
            .unwrap();
    assert_eq!(
        ddl,
        "CREATE INDEX events_run_sequence ON events(run_id, sequence)"
    );
    for (sequence, kind) in [
        (1, "session.created"),
        (2, "session.renamed"),
        (3, "session.renamed"),
    ] {
        sqlx::query("INSERT INTO events(sequence,event_id,event_type,event_version,created_at_ms,payload_json) VALUES(?,?,?,1,0,?)")
            .bind(sequence).bind(format!("metadata-{sequence}")).bind(kind)
            .bind("PRIVATE_SYNTHETIC_PAYLOAD".repeat(1000)).execute(&mut raw).await.unwrap();
    }
    let run = RunId::new();
    let mut previous_count = 0;
    let mut previous_program = None;
    for count in [100, 10_000] {
        // Seed run-associated rows directly. These are not actual tool executions.
        sqlx::query("WITH RECURSIVE rows(n) AS (VALUES(?) UNION ALL SELECT n+1 FROM rows WHERE n<?) INSERT INTO events(sequence,event_id,event_type,event_version,created_at_ms,run_id,payload_json) SELECT n+3,'run-event-'||n,'run.interrupted',1,0,?,'PRIVATE_SYNTHETIC_PAYLOAD' FROM rows")
            .bind(previous_count + 1).bind(count).bind(run.as_str()).execute(&mut raw).await.unwrap();
        previous_count = count;
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM events WHERE run_id IS NOT NULL")
                .fetch_one(&mut raw)
                .await
                .unwrap(),
            count
        );
        let query = storage::session_schema::LATEST_METADATA_EVENT;
        // Only the fixed production SQL is appended; no user input becomes SQL text.
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(sqlx::AssertSqlSafe(format!("EXPLAIN QUERY PLAN {query}")))
                .bind(count + 3)
                .fetch_all(&mut raw)
                .await
                .unwrap();
        assert_eq!(plan.len(), 1);
        let detail = &plan[0].3;
        assert!(
            detail.contains("SEARCH events USING INDEX events_run_sequence"),
            "{detail}"
        );
        assert!(
            !detail.contains("SCAN") && !detail.contains("TEMP"),
            "{detail}"
        );
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!("EXPLAIN {query}")))
            .bind(count + 3)
            .fetch_all(&mut raw)
            .await
            .unwrap();
        let program: Vec<(String, i64)> = rows
            .iter()
            .map(|row| (row.get("opcode"), row.get("p2")))
            .collect();
        assert!(program.iter().any(|(opcode, _)| opcode == "SeekLE"));
        assert!(
            !program.iter().any(|(opcode, column)| {
                matches!(opcode.as_str(), "Rewind" | "Sort" | "SorterOpen")
                    || (opcode == "Column" && *column == 8)
            }),
            "no full scan, sort, or payload_json column read: {program:?}"
        );
        if let Some(previous) = previous_program.as_ref() {
            assert_eq!(&program, previous);
        }
        println!(
            "a4 latest_metadata later_run_rows={count} plan={detail} vm_instructions={} payload_column_reads=0",
            program.len()
        );
        previous_program = Some(program);
        let latest: (i64, String, Option<String>) = sqlx::query_as(query)
            .bind(count + 3)
            .fetch_one(&mut raw)
            .await
            .unwrap();
        assert_eq!(latest, (3, "session.renamed".into(), None));
        for (head, expected) in [(1, "session.created"), (2, "session.renamed")] {
            let at_head: (i64, String, Option<String>) = sqlx::query_as(query)
                .bind(head)
                .fetch_one(&mut raw)
                .await
                .unwrap();
            assert_eq!(at_head, (head, expected.into(), None));
        }
    }
    raw.close().await.unwrap();
}

#[tokio::test]
async fn a4_shared_validation_avoids_huge_unrelated_payload_but_keeps_metadata_identity_and_title()
{
    let (_temp, store, handle, path) = setup().await;
    let large = "雪\\\"\0".repeat(70_000);
    let input = RecordedRunInput::new(
        large.clone(),
        RunRequest {
            provider_id: "synthetic".into(),
            options: SessionOptions::new("model"),
            prompt: large,
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap();
    handle
        .accept_run(OperationId::new(), RunId::new(), input)
        .await
        .unwrap();
    let mut raw = sql(&path).await;
    let last_bytes: i64 = sqlx::query_scalar(
        "SELECT length(CAST(payload_json AS BLOB)) FROM events WHERE sequence=2",
    )
    .fetch_one(&mut raw)
    .await
    .unwrap();
    assert!(last_bytes > 1_000_000);
    let before = store.inner.hooks.measurements().validation_payload_bytes;
    assert_eq!(handle.manifest().await.unwrap().head_sequence(), 2);
    let loaded = store.inner.hooks.measurements().validation_payload_bytes - before;
    assert!(
        loaded < 16_384,
        "only bounded creation identity may be decoded"
    );
    handle
        .rename(OperationId::new(), "title check".into())
        .await
        .unwrap();
    assert_eq!(handle.manifest().await.unwrap().title(), "title check");
    sqlx::query("UPDATE manifest SET title='wrong'")
        .execute(&mut raw)
        .await
        .unwrap();
    assert_eq!(
        handle.manifest().await.unwrap_err().code(),
        "storage.integrity"
    );
    sqlx::query("UPDATE manifest SET title='title check'")
        .execute(&mut raw)
        .await
        .unwrap();
    sqlx::query("UPDATE manifest SET updated_at_ms=0")
        .execute(&mut raw)
        .await
        .unwrap();
    assert_eq!(
        handle.manifest().await.unwrap_err().code(),
        "storage.integrity"
    );
    raw.close().await.unwrap();
    store.close().await.unwrap();
    println!("a4 canonical_head_payload_bytes={last_bytes} validation_payload_bytes={loaded}");
}

#[tokio::test]
async fn a4_later_invalid_batch_and_actual_chunk_constraint_roll_back_every_table() {
    for constraint in [false, true] {
        let (_temp, store, handle, path) = setup().await;
        let run = RunId::new();
        let mut raw = sql(&path).await;
        if constraint {
            sqlx::query("CREATE TRIGGER synthetic_chunk_failure BEFORE INSERT ON conversation_chunks BEGIN SELECT RAISE(ABORT,'synthetic projection constraint'); END")
                .execute(&mut raw).await.unwrap();
        } else {
            handle
                .accept_run(OperationId::new(), run.clone(), input())
                .await
                .unwrap();
        }
        let before = dump(&mut raw).await;
        let op = OperationId::new();
        let error = if constraint {
            handle
                .accept_run(op.clone(), run.clone(), input())
                .await
                .unwrap_err()
        } else {
            handle
                .append_run_records(
                    op.clone(),
                    run.clone(),
                    vec![
                        runtime(&run, 1, RunEvent::RunStarted),
                        runtime(&run, 2, RunEvent::RunStarted),
                    ],
                )
                .await
                .unwrap_err()
        };
        assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
        assert_eq!(
            error.code(),
            if constraint {
                "storage.integrity"
            } else {
                "storage.invalid_transition"
            }
        );
        assert_eq!(dump(&mut raw).await, before);
        assert!(handle.lookup_receipt(op).await.unwrap().is_none());
        raw.close().await.unwrap();
        store.close().await.unwrap();
    }
}
