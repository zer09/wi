use super::*;

// Independently populate released DDL. Do not pass these old records through
// today's append admission or change the existing migration fixture bytes.
async fn legacy(
    version: u64,
) -> (
    tempfile::TempDir,
    PathBuf,
    ApplicationSessionId,
    RunId,
    OperationId,
    Vec<AppendRunRecord>,
    CommitReceipt,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("synthetic-old-store");
    SessionStore::open(root.clone())
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    let id = ApplicationSessionId::new();
    let run = RunId::new();
    let path = filesystem::session_path(&root, &id, true).unwrap();
    drop(filesystem::open_file(&path, true).unwrap());
    let mut sql = SqliteConnectOptions::new()
        .filename(&path)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap();
    let ddl = if version == 1 {
        include_str!("../../../tests/storage/session_v1.sql")
    } else {
        session_schema::V2
    };
    sqlx::raw_sql(ddl).execute(&mut sql).await.unwrap();
    let create = CreateSession::new(OperationId::new(), "synthetic".into(), None).unwrap();
    let creation_event = StoredEventId::new();
    let request = dto::canonical_json(&create.request()).unwrap();
    let hash = dto::hash(&request);
    let creation_receipt = json!({"operation_id":create.operation_id(),"session_id":id,"run_id":null,"first_sequence":1,"last_sequence":1});
    let provenance = json!({"operation_id":create.operation_id(),"method":"create_session","session_id":id,"creation_event_id":creation_event,"created_at_ms":42,"request_json":request,"payload_hash":hash,"receipt":creation_receipt});
    sqlx::query("INSERT INTO manifest VALUES (1,?,?,1,'synthetic',NULL,42,42,1,?)")
        .bind(id.as_str())
        .bind(version as i64)
        .bind(provenance.to_string())
        .execute(&mut sql)
        .await
        .unwrap();
    sqlx::query("INSERT INTO events VALUES (1,?,'session.created',1,42,NULL,NULL,NULL,?)")
        .bind(creation_event.as_str())
        .bind(
            json!({"title":"synthetic","workspace":null,"creation_provenance":provenance})
                .to_string(),
        )
        .execute(&mut sql)
        .await
        .unwrap();
    let owner = StoredEventId::new();
    sqlx::query("INSERT INTO events VALUES (2,?,'run.accepted',1,42,?,NULL,NULL,?)")
        .bind(StoredEventId::new().as_str())
        .bind(run.as_str())
        .bind(json!({"run_id":run,"input":input(),"owner_instance_id":owner}).to_string())
        .execute(&mut sql)
        .await
        .unwrap();
    let old_call = "c".repeat(513);
    let mut records = prefix(&run);
    records.push(provider(&run));
    records.push(runtime(
        &run,
        4,
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted {
                call_id: old_call.clone(),
                tool_name: "synthetic".into(),
            },
        },
    ));
    records.push(AppendRunRecord::ToolResult {
        request_id: Some("old-request".into()),
        call_id: old_call.clone(),
        output: "old exact\0雪".into(),
        is_error: false,
    });
    records.push(runtime(
        &run,
        5,
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionFinished {
                call_id: old_call.clone(),
                tool_name: "synthetic".into(),
                is_error: false,
            },
        },
    ));
    records.push(runtime(
        &run,
        6,
        RunEvent::TurnFinished {
            number: 1,
            response_id: Some("native-response".into()),
            outcome: TurnOutcome::ToolsPrepared,
            upstream_outcome: Some(UpstreamOutcome::TerminalReceived),
        },
    ));
    let summary = RunSummary {
        last_request_id: Some("old-summary-request".into()),
        ..Default::default()
    };
    records.push(runtime(
        &run,
        7,
        RunEvent::RunFinished {
            outcome: RunOutcome::Completed,
            summary: summary.clone(),
        },
    ));
    records.push(AppendRunRecord::Result(RunResult {
        run_id: run.as_str().into(),
        session_id: Some("opaque-local-session".into()),
        outcome: RunOutcome::Completed,
        summary,
        last_response: None,
        events_complete: true,
        sink_error: None,
    }));
    for record in &mut records {
        if let AppendRunRecord::Runtime(event) = record {
            event.event_id = format!("old-event-{}", event.sequence);
            if event.turn_id.is_some() {
                event.turn_id = Some("old-turn".into());
            }
            if event.request_id.is_some() {
                event.request_id = Some("old-request".into());
            }
            if let RunEvent::ProviderEvent { event } = &mut event.event {
                event.request_id = Some("old-request".into());
            }
        }
    }
    let operation = OperationId::new();
    let receipt =
        CommitReceipt::run_batch(operation.clone(), id.clone(), run.clone(), 3, 11).unwrap();
    // Hash the historical serialized command independently of run_store::mutate.
    let command =
        json!({"session_id":id,"run_id":run,"method":"append_run_records","records":records});
    let command_hash = dto::hash(&dto::canonical_json(&command).unwrap());
    for (index, record) in records.iter().enumerate() {
        let (kind, payload, event_id, source) = match record {
            AppendRunRecord::Runtime(event) => (
                "runtime.observed",
                serde_json::to_value(event).unwrap(),
                Some(event.event_id.as_str()),
                Some(event.sequence as i64),
            ),
            AppendRunRecord::ToolResult {
                request_id,
                call_id,
                output,
                is_error,
            } => (
                "tool.result.recorded",
                json!({"request_id":request_id,"call_id":call_id,"output":output,"is_error":is_error}),
                None,
                None,
            ),
            AppendRunRecord::Result(result) => (
                "run.result.recorded",
                serde_json::to_value(result).unwrap(),
                None,
                None,
            ),
            _ => unreachable!(),
        };
        sqlx::query("INSERT INTO events VALUES (?,?,?,1,42,?,?,?,?)")
            .bind(index as i64 + 3)
            .bind(StoredEventId::new().as_str())
            .bind(kind)
            .bind(run.as_str())
            .bind(event_id)
            .bind(source)
            .bind(format!(
                " \n{}\n ",
                serde_json::to_string_pretty(&payload).unwrap()
            ))
            .execute(&mut sql)
            .await
            .unwrap();
    }
    let AppendRunRecord::Runtime(terminal) = &records[7] else {
        unreachable!()
    };
    sqlx::query("INSERT INTO runs VALUES (?,2,'completed',7,?,'opaque-local-session',10,?,11)")
        .bind(run.as_str())
        .bind(owner.as_str())
        .bind(serde_json::to_string(terminal).unwrap())
        .execute(&mut sql)
        .await
        .unwrap();
    sqlx::query("INSERT INTO tool_results VALUES (?,?,'synthetic','old-request',6,8,7,0,?)")
        .bind(run.as_str())
        .bind(&old_call)
        .bind("old exact\0雪")
        .execute(&mut sql)
        .await
        .unwrap();
    sqlx::query("INSERT INTO commands VALUES (?,'append_run_records',?,3,11,?)")
        .bind(operation.as_str())
        .bind(command_hash.as_slice())
        .bind(format!("\n {} ", serde_json::to_string(&receipt).unwrap()))
        .execute(&mut sql)
        .await
        .unwrap();
    sqlx::query("UPDATE manifest SET head_sequence=11")
        .execute(&mut sql)
        .await
        .unwrap();
    sql.close().await.unwrap();
    let mut catalog = SqliteConnectOptions::new()
        .filename(root.join("catalog.sqlite3"))
        .disable_statement_logging()
        .connect()
        .await
        .unwrap();
    sqlx::query("INSERT INTO sessions (session_id,relative_path,title,created_at_ms,updated_at_ms,head_sequence,schema_version,availability) VALUES (?,?,'synthetic',42,42,1,?,'ready')").bind(id.as_str()).bind(filesystem::session_relative_path(&id)).bind(version as i64).execute(&mut catalog).await.unwrap();
    sqlx::query("INSERT INTO creation_commands VALUES (?,?,?,?,?,42,'accepted',?,NULL)")
        .bind(create.operation_id().as_str())
        .bind(hash.as_slice())
        .bind(request)
        .bind(id.as_str())
        .bind(creation_event.as_str())
        .bind(creation_receipt.to_string())
        .execute(&mut catalog)
        .await
        .unwrap();
    catalog.close().await.unwrap();
    (temp, root, id, run, operation, records, receipt)
}

#[tokio::test]
async fn id2a_old_opaque_ids_exact_retry_and_changed_payload_conflict_precede_admission() {
    for version in [1, 2] {
        let (_temp, root, id, run, operation, records, receipt) = legacy(version).await;
        let path = filesystem::session_path(&root, &id, false).unwrap();
        let mut raw = sql(&path).await;
        let old_bytes: Vec<String> =
            sqlx::query_scalar("SELECT payload_json FROM events ORDER BY sequence")
                .fetch_all(&mut raw)
                .await
                .unwrap();
        let digest = history_prefix::digest(&mut raw, 11, &[]).await.unwrap();
        raw.close().await.unwrap();
        let store = SessionStore::open(root).await.unwrap();
        let handle = store.open_session(id.clone()).await.unwrap();
        let before = snapshot(&path).await;
        for deserialized in [false, true] {
            let retry: Vec<AppendRunRecord> = if deserialized {
                serde_json::from_value(serde_json::to_value(&records).unwrap()).unwrap()
            } else {
                records.clone()
            };
            let duplicate = handle
                .append_run_records(operation.clone(), run.clone(), retry.clone())
                .await
                .unwrap();
            assert!(duplicate.duplicate());
            assert_eq!(duplicate.receipt(), &receipt);
            assert_eq!(snapshot(&path).await, before);
            let mut changed = retry;
            let AppendRunRecord::Result(result) = changed.last_mut().unwrap() else {
                unreachable!()
            };
            result.summary.last_request_id = Some("different-old-opaque-id".into());
            let error = handle
                .append_run_records(operation.clone(), run.clone(), changed)
                .await
                .unwrap_err();
            assert_eq!(error.code(), "storage.command_conflict");
            assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
            assert_eq!(snapshot(&path).await, before);
            rejected(
                &handle,
                &run,
                &path,
                records.clone(),
                "storage.invalid_input",
            )
            .await;
        }
        let page = handle.history_page(0, None, 20).await.unwrap();
        assert_eq!(page.records().len(), 11);
        assert!(
            matches!(page.records()[4].payload(), StoredEventPayload::RuntimeObserved(event) if event.turn_id.as_deref() == Some("old-turn") && event.request_id.as_deref() == Some("old-request"))
        );
        assert!(
            matches!(page.records().last().unwrap().payload(), StoredEventPayload::RunResultRecorded(result) if result.summary.last_request_id.as_deref() == Some("old-summary-request"))
        );
        assert_eq!(
            handle
                .tool_result(run, "c".repeat(513))
                .await
                .unwrap()
                .unwrap()
                .output(),
            Some("old exact\0雪")
        );
        assert_eq!(store.repair_catalog().await.unwrap().ready_sessions(), 1);
        let mut raw = sql(&path).await;
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT payload_json FROM events ORDER BY sequence")
                .fetch_all(&mut raw)
                .await
                .unwrap(),
            old_bytes
        );
        assert_eq!(
            history_prefix::digest(&mut raw, 11, &[]).await.unwrap(),
            digest
        );
        raw.close().await.unwrap();
        store.close().await.unwrap();
    }
}
