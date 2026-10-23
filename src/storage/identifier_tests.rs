use super::*;
use crate::{
    EventEnvelope, ProviderEvent, SessionOptions, UpstreamOutcome,
    run::{RunEvent, RunEventEnvelope, RunOutcome, RunRequest, RunResult, RunSummary, TurnOutcome},
    tools::ToolExecutionEvent,
};
use serde_json::json;
use sqlx::{ConnectOptions, Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::path::{Path, PathBuf};

// Version 1 UUIDs pin that admission is canonical spelling, not v4-only.
const TURN: &str = "01234567-89ab-1cde-8fab-0123456789ab";
const REQUEST: &str = "01234567-89ab-5cde-8fab-0123456789ab";
const EVENT: &str = "01234567-89ab-7cde-8fab-0123456789ab";

pub(super) fn input() -> RecordedRunInput {
    RecordedRunInput::new(
        "synthetic".into(),
        RunRequest {
            provider_id: "synthetic".into(),
            options: SessionOptions::new("synthetic"),
            prompt: "synthetic".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap()
}

pub(super) async fn setup() -> (
    tempfile::TempDir,
    SessionStore,
    SessionHandle,
    RunId,
    PathBuf,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("synthetic-store");
    let store = SessionStore::open(root.clone()).await.unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "synthetic".into(), None).unwrap())
        .await
        .unwrap();
    let handle = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let run: RunId = "01234567-89ab-1cde-8fab-1123456789ab".parse().unwrap();
    handle
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    let path = filesystem::session_path(&root, handle.session_id(), false).unwrap();
    (temp, store, handle, run, path)
}

async fn sql(path: &Path) -> SqliteConnection {
    SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap()
}

pub(super) async fn snapshot(path: &Path) -> Vec<String> {
    let mut sql = sql(path).await;
    let mut values = Vec::new();
    for query in [
        "SELECT json_group_array(json_array(sequence,event_id,event_type,event_version,created_at_ms,run_id,source_event_id,source_sequence,payload_json)) FROM (SELECT * FROM events ORDER BY sequence)",
        "SELECT json_group_array(json_array(singleton,session_id,schema_version,format_version,title,workspace_json,created_at_ms,updated_at_ms,head_sequence,creation_provenance_json)) FROM manifest",
        "SELECT json_group_array(json_array(operation_id,method,hex(payload_hash),first_sequence,last_sequence,receipt_json)) FROM (SELECT * FROM commands ORDER BY operation_id)",
        "SELECT json_group_array(json_array(run_id,accepted_sequence,state,last_runtime_sequence,owner_instance_id,provider_session_id,terminal_sequence,terminal_json,result_sequence)) FROM (SELECT * FROM runs ORDER BY run_id)",
        "SELECT json_group_array(json_array(run_id,call_id,tool_name,request_id,started_sequence,finished_sequence,result_sequence,is_error,output)) FROM (SELECT * FROM tool_results ORDER BY run_id,call_id)",
        "SELECT json_group_array(json_array(singleton,format_version,applied_sequence,metadata_sequence)) FROM conversation_projection",
        "SELECT json_group_array(json_array(run_id,accepted_sequence,changed_sequence,header_json)) FROM (SELECT * FROM conversation_blocks ORDER BY run_id)",
        "SELECT json_group_array(json_array(run_id,entry_id,hex(source_key),first_sequence,position_slot,changed_sequence,content_epoch,kind,metadata_json)) FROM (SELECT * FROM conversation_entries ORDER BY run_id,entry_id)",
        "SELECT json_group_array(json_array(run_id,entry_id,field_id,order_key,generation,byte_length,kind,metadata_json)) FROM (SELECT * FROM conversation_fields ORDER BY run_id,entry_id,field_id)",
        "SELECT json_group_array(json_array(run_id,entry_id,field_id,start_byte,hex(bytes))) FROM (SELECT * FROM conversation_chunks ORDER BY run_id,entry_id,field_id,start_byte)",
    ] {
        values.push(sqlx::query_scalar(query).fetch_one(&mut sql).await.unwrap());
    }
    sql.close().await.unwrap();
    values
}

pub(super) fn runtime(run: &RunId, sequence: u64, event: RunEvent) -> AppendRunRecord {
    let started = matches!(event, RunEvent::RunStarted);
    let no_turn = started || matches!(event, RunEvent::RunFinished { .. });
    let no_request = started || matches!(event, RunEvent::TurnStarted { .. });
    // Unique canonical event UUID per sequence, retaining a non-v4 version.
    AppendRunRecord::Runtime(RunEventEnvelope {
        schema_version: 2,
        sequence,
        event_id: format!("01234567-89ab-7cde-8fab-{sequence:012x}"),
        run_id: run.as_str().into(),
        turn_id: (!no_turn).then(|| TURN.into()),
        session_id: (!started).then(|| "opaque-local-session".into()),
        request_id: (!no_request).then(|| REQUEST.into()),
        event,
    })
}

fn prefix(run: &RunId) -> Vec<AppendRunRecord> {
    vec![
        runtime(run, 1, RunEvent::RunStarted),
        runtime(run, 2, RunEvent::TurnStarted { number: 1 }),
    ]
}

fn provider(run: &RunId) -> AppendRunRecord {
    runtime(
        run,
        3,
        RunEvent::ProviderEvent {
            event: Box::new(EventEnvelope {
                schema_version: 1,
                sequence: 19,
                event_id: "opaque-native-envelope".into(),
                session_id: "opaque-local-session".into(),
                request_id: Some(REQUEST.into()),
                provider: "synthetic".into(),
                provider_sequence: None,
                event: ProviderEvent::ResponseStarted {
                    response_id: "native-response".into(),
                },
            }),
        },
    )
}

pub(super) fn result(run: &RunId, summary: RunSummary) -> AppendRunRecord {
    AppendRunRecord::Result(RunResult {
        run_id: run.as_str().into(),
        session_id: None,
        outcome: RunOutcome::Failed {
            code: "event_sink".into(),
        },
        summary,
        last_response: None,
        events_complete: false,
        sink_error: None,
    })
}

pub(super) async fn rejected(
    handle: &SessionHandle,
    run: &RunId,
    path: &Path,
    records: Vec<AppendRunRecord>,
    code: &str,
) {
    let before = snapshot(path).await;
    let operation = OperationId::new();
    let error = handle
        .append_run_records(operation.clone(), run.clone(), records)
        .await
        .unwrap_err();
    assert_eq!(error.code(), code);
    assert_eq!(error.to_string(), code);
    assert_eq!(
        format!("{error:?}"),
        format!("StorageError {{ code: \"{code}\", certainty: NotCommitted }}")
    );
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    assert!(handle.lookup_receipt(operation).await.unwrap().is_none());
    assert_eq!(snapshot(path).await, before);
}

#[tokio::test]
async fn id2a_every_malformed_wi_uuid_path_rejects_without_any_committed_change() {
    let (_temp, store, handle, run, path) = setup().await;
    let invalid = crate::identifiers::invalid_uuid_spellings();
    assert_eq!(invalid.len(), 13);
    for malformed in invalid {
        let mut nested_mismatch = provider(&run);
        let AppendRunRecord::Runtime(event) = &mut nested_mismatch else {
            unreachable!()
        };
        let RunEvent::ProviderEvent { event } = &mut event.event else {
            unreachable!()
        };
        event.request_id = Some(malformed.clone());
        // A broken mirror keeps its structural correlation error, not a new grammar error.
        rejected(
            &handle,
            &run,
            &path,
            vec![nested_mismatch],
            "storage.invalid_transition",
        )
        .await;
        for field in [
            "run",
            "event",
            "turn",
            "outer_request",
            "provider_mirror",
            "runtime_summary",
            "result_run",
            "result_summary",
            "tool_request",
        ] {
            let mut records = prefix(&run);
            match field {
                "run" | "event" | "turn" | "outer_request" => {
                    let index = if field == "turn" { 1 } else { 0 };
                    if field == "outer_request" {
                        records.push(runtime(
                            &run,
                            3,
                            RunEvent::TurnFinished {
                                number: 1,
                                response_id: None,
                                outcome: TurnOutcome::ModelCompleted,
                                upstream_outcome: None,
                            },
                        ));
                    }
                    let index = if field == "outer_request" { 2 } else { index };
                    let AppendRunRecord::Runtime(event) = &mut records[index] else {
                        unreachable!()
                    };
                    match field {
                        "run" => event.run_id = malformed.clone(),
                        "event" => event.event_id = malformed.clone(),
                        "turn" => event.turn_id = Some(malformed.clone()),
                        _ => event.request_id = Some(malformed.clone()),
                    }
                }
                "provider_mirror" => {
                    let mut record = provider(&run);
                    let AppendRunRecord::Runtime(event) = &mut record else {
                        unreachable!()
                    };
                    event.request_id = Some(malformed.clone());
                    let RunEvent::ProviderEvent { event } = &mut event.event else {
                        unreachable!()
                    };
                    event.request_id = Some(malformed.clone());
                    records.push(record);
                }
                "runtime_summary" => {
                    records = vec![runtime(&run, 1, RunEvent::RunStarted)];
                    let mut record = runtime(
                        &run,
                        2,
                        RunEvent::RunFinished {
                            outcome: RunOutcome::Completed,
                            summary: RunSummary {
                                last_request_id: Some(malformed.clone()),
                                ..Default::default()
                            },
                        },
                    );
                    let AppendRunRecord::Runtime(event) = &mut record else {
                        unreachable!()
                    };
                    event.request_id = None;
                    records.push(record);
                }
                "result_run" | "result_summary" => {
                    let mut record = result(&run, RunSummary::default());
                    let AppendRunRecord::Result(result) = &mut record else {
                        unreachable!()
                    };
                    if field == "result_run" {
                        result.run_id = malformed.clone();
                    } else {
                        result.summary.last_request_id = Some(malformed.clone());
                    }
                    records.push(record);
                }
                "tool_request" => records.push(AppendRunRecord::ToolResult {
                    request_id: Some(malformed.clone()),
                    call_id: "native-call".into(),
                    output: "exact".into(),
                    is_error: false,
                }),
                _ => unreachable!(),
            }
            rejected(&handle, &run, &path, records, "storage.invalid_input").await;
        }
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn id2a_valid_non_v4_runtime_mirrors_summary_and_result_preserve_exact_ids() {
    let (_temp, store, handle, run, _path) = setup().await;
    let mut records = prefix(&run);
    records.push(provider(&run));
    records.push(runtime(
        &run,
        4,
        RunEvent::TurnFinished {
            number: 1,
            response_id: Some("native-response".into()),
            outcome: TurnOutcome::ModelCompleted,
            upstream_outcome: Some(UpstreamOutcome::TerminalReceived),
        },
    ));
    let summary = RunSummary {
        last_request_id: Some(REQUEST.into()),
        ..Default::default()
    };
    records.push(runtime(
        &run,
        5,
        RunEvent::RunFinished {
            outcome: RunOutcome::Completed,
            summary: summary.clone(),
        },
    ));
    records.push(AppendRunRecord::Result(RunResult {
        run_id: run.as_str().into(),
        session_id: Some("opaque-local-session".into()),
        outcome: RunOutcome::Completed,
        summary: summary.clone(),
        last_response: None,
        events_complete: true,
        sink_error: None,
    }));
    handle
        .append_run_records(OperationId::new(), run.clone(), records.clone())
        .await
        .unwrap();
    let saved = handle.run_record(run.clone()).await.unwrap().unwrap();
    assert_eq!(
        saved.result().unwrap().summary.last_request_id.as_deref(),
        Some(REQUEST)
    );
    let page = handle.history_page(2, None, 20).await.unwrap();
    let AppendRunRecord::Runtime(expected) = &records[2] else {
        unreachable!()
    };
    let StoredEventPayload::RuntimeObserved(actual) = page.records()[2].payload() else {
        unreachable!()
    };
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn id2a_optional_absence_and_existing_structural_errors_are_unchanged() {
    let (_temp, store, handle, run, path) = setup().await;
    let mut unsupported = runtime(&run, 1, RunEvent::RunStarted);
    let AppendRunRecord::Runtime(event) = &mut unsupported else {
        unreachable!()
    };
    event.schema_version = 3;
    rejected(
        &handle,
        &run,
        &path,
        vec![unsupported],
        "storage.unsupported_version",
    )
    .await;
    let mut mismatch = provider(&run);
    let AppendRunRecord::Runtime(event) = &mut mismatch else {
        unreachable!()
    };
    let RunEvent::ProviderEvent { event } = &mut event.event else {
        unreachable!()
    };
    event.request_id = Some(EVENT.into());
    rejected(
        &handle,
        &run,
        &path,
        vec![mismatch],
        "storage.invalid_transition",
    )
    .await;
    let mut missing = runtime(&run, 2, RunEvent::TurnStarted { number: 1 });
    let AppendRunRecord::Runtime(event) = &mut missing else {
        unreachable!()
    };
    event.turn_id = None;
    rejected(
        &handle,
        &run,
        &path,
        vec![missing],
        "storage.invalid_transition",
    )
    .await;
    // Optional ToolResult absence passes admission, but still requires a matching intent.
    let absent = AppendRunRecord::ToolResult {
        request_id: None,
        call_id: "native-call".into(),
        output: "exact".into(),
        is_error: false,
    };
    absent.validate_admission().unwrap();
    rejected(
        &handle,
        &run,
        &path,
        vec![absent],
        "storage.invalid_transition",
    )
    .await;
    let mut records = prefix(&run);
    let mut finished = runtime(
        &run,
        3,
        RunEvent::TurnFinished {
            number: 1,
            response_id: None,
            outcome: TurnOutcome::ModelCompleted,
            upstream_outcome: None,
        },
    );
    let AppendRunRecord::Runtime(event) = &mut finished else {
        unreachable!()
    };
    event.request_id = None;
    records.push(finished);
    let mut terminal = runtime(
        &run,
        4,
        RunEvent::RunFinished {
            outcome: RunOutcome::Completed,
            summary: RunSummary::default(),
        },
    );
    let AppendRunRecord::Runtime(event) = &mut terminal else {
        unreachable!()
    };
    event.request_id = None;
    records.push(terminal);
    records.push(AppendRunRecord::Result(RunResult {
        run_id: run.as_str().into(),
        session_id: Some("opaque-local-session".into()),
        outcome: RunOutcome::Completed,
        summary: RunSummary::default(),
        last_response: None,
        events_complete: true,
        sink_error: None,
    }));
    handle
        .append_run_records(OperationId::new(), run, records)
        .await
        .unwrap();
    store.close().await.unwrap();
}

#[tokio::test]
async fn id2a_execution_and_result_call_ids_are_bounded_utf8_not_observation_ids() {
    let (_temp, store, handle, run, path) = setup().await;
    for call_id in [String::new(), "x".repeat(513), "雪".repeat(171)] {
        for kind in 0..4 {
            let mut records = prefix(&run);
            let tool_name = "synthetic".into();
            let event = match kind {
                0 => Some(ToolExecutionEvent::ToolExecutionStarted {
                    call_id: call_id.clone(),
                    tool_name,
                }),
                1 => Some(ToolExecutionEvent::ToolExecutionFinished {
                    call_id: call_id.clone(),
                    tool_name,
                    is_error: false,
                }),
                2 => Some(ToolExecutionEvent::ToolResultReused {
                    call_id: call_id.clone(),
                    tool_name,
                }),
                _ => None,
            };
            if let Some(event) = event {
                records.push(runtime(&run, 3, RunEvent::ToolEvent { event }));
            } else {
                records.push(AppendRunRecord::ToolResult {
                    request_id: Some(REQUEST.into()),
                    call_id: call_id.clone(),
                    output: "exact".into(),
                    is_error: false,
                });
            }
            rejected(&handle, &run, &path, records, "storage.invalid_input").await;
        }
    }
    let call_id = format!("{}ab", "雪".repeat(170));
    assert_eq!(call_id.len(), 512);
    let mut records = prefix(&run);
    records.push(runtime(
        &run,
        3,
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted {
                call_id: call_id.clone(),
                tool_name: "synthetic".into(),
            },
        },
    ));
    records.push(AppendRunRecord::ToolResult {
        request_id: Some(REQUEST.into()),
        call_id: call_id.clone(),
        output: "exact\0雪".into(),
        is_error: false,
    });
    records.push(runtime(
        &run,
        4,
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionFinished {
                call_id: call_id.clone(),
                tool_name: "synthetic".into(),
                is_error: false,
            },
        },
    ));
    records.push(runtime(
        &run,
        5,
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolResultReused {
                call_id: call_id.clone(),
                tool_name: "synthetic".into(),
            },
        },
    ));
    handle
        .append_run_records(OperationId::new(), run.clone(), records)
        .await
        .unwrap();
    let saved = handle
        .tool_result(run, call_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.call_id(), call_id);
    assert_eq!(saved.output(), Some("exact\0雪"));
    store.close().await.unwrap();
}

#[tokio::test]
async fn id2a_provisional_provider_items_keep_untrusted_call_ids_recordable() {
    for call_id in [String::new(), "x".repeat(513)] {
        let (_temp, store, handle, run, _path) = setup().await;
        let item = crate::OutputItem {
            id: Some("native-item".into()),
            kind: crate::ItemKind::FunctionCall,
            native_type: "function_call".into(),
            function_call: Some(crate::FunctionCall {
                call_id: call_id.clone(),
                name: "synthetic".into(),
                arguments: "{}".into(),
                origin: crate::CallOrigin::Direct,
                namespace: None,
                complete: true,
            }),
            native: json!({"type":"function_call", "call_id":call_id, "name":"synthetic", "arguments":"{}"}),
        };
        let mut records = prefix(&run);
        for (index, event) in [
            ProviderEvent::OutputItemStarted {
                response_id: "native-response".into(),
                output_index: 0,
                item: item.clone(),
            },
            ProviderEvent::OutputItemFinished {
                response_id: "native-response".into(),
                output_index: 0,
                item: item.clone(),
            },
        ]
        .into_iter()
        .enumerate()
        {
            let mut record = provider(&run);
            let AppendRunRecord::Runtime(runtime) = &mut record else {
                unreachable!()
            };
            runtime.sequence = index as u64 + 3;
            runtime.event_id = format!("01234567-89ab-7cde-8fab-{:012x}", runtime.sequence);
            let RunEvent::ProviderEvent { event: nested } = &mut runtime.event else {
                unreachable!()
            };
            nested.sequence += index as u64;
            nested.event = event;
            records.push(record);
        }
        handle
            .append_run_records(OperationId::new(), run, records.clone())
            .await
            .unwrap();
        let page = handle.history_page(4, None, 20).await.unwrap();
        for (stored, expected) in page.records().iter().zip(&records[2..]) {
            let StoredEventPayload::RuntimeObserved(actual) = stored.payload() else {
                unreachable!()
            };
            let AppendRunRecord::Runtime(expected) = expected else {
                unreachable!()
            };
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                serde_json::to_value(expected).unwrap()
            );
        }
        assert_eq!(page.records().len(), 2);
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn id2a_later_invalid_record_preflights_before_any_canonical_insert() {
    let (_temp, store, handle, run, path) = setup().await;
    store.inner.hooks.arm(
        test_hooks::Point::CanonicalInserted,
        test_hooks::Action::Fail(StorageErrorKind::Io),
    );
    let mut records = prefix(&run);
    records.push(result(
        &run,
        RunSummary {
            last_request_id: Some("x".repeat(36)),
            ..Default::default()
        },
    ));
    // If the valid prefix reached an insert, the armed fault would return storage.io.
    rejected(&handle, &run, &path, records, "storage.invalid_input").await;
    let error = handle
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![runtime(&run, 1, RunEvent::RunStarted)],
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "storage.io");
    store.close().await.unwrap();
}

mod historical;
mod local;
