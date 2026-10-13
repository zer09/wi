use super::*;
use crate::execution::prepare_session_replay;

// This fixture uses released DDL and SQL, never today's append boundary. Only
// local provider identities are old opaque values; Wi request UUIDs stay valid.
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
    let root = temp.path().join("synthetic-old-native");
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
    let mut raw = SqliteConnectOptions::new()
        .filename(&path)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap();
    sqlx::raw_sql(if version == 1 {
        include_str!("../../../../tests/storage/session_v1.sql")
    } else {
        session_schema::V2
    })
    .execute(&mut raw)
    .await
    .unwrap();
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
        .execute(&mut raw)
        .await
        .unwrap();
    sqlx::query("INSERT INTO events VALUES (1,?,'session.created',1,42,NULL,NULL,NULL,?)")
        .bind(creation_event.as_str())
        .bind(
            json!({"title":"synthetic","workspace":null,"creation_provenance":provenance})
                .to_string(),
        )
        .execute(&mut raw)
        .await
        .unwrap();
    let digest = history_prefix::digest(&mut raw, 1, &[]).await.unwrap();
    let owner = StoredEventId::new();
    let selected =
        StoredHistorySelection::new(1, digest, PROVIDER_ID.into(), "synthetic".into(), None)
            .unwrap();
    sqlx::query("INSERT INTO events VALUES (2,?,'run.accepted',1,42,?,NULL,NULL,?)")
        .bind(StoredEventId::new().as_str())
        .bind(run.as_str())
        .bind(json!({"run_id":run,"input":native_input(),"owner_instance_id":owner}).to_string())
        .execute(&mut raw)
        .await
        .unwrap();
    if version == 2 {
        sqlx::query("INSERT INTO events VALUES (3,?,'run.history.selected',1,42,?,NULL,NULL,?)")
            .bind(StoredEventId::new().as_str())
            .bind(run.as_str())
            .bind(json!({"run_id":run,"selection":selected}).to_string())
            .execute(&mut raw)
            .await
            .unwrap();
        let accepted = OperationId::new();
        let acceptance =
            CommitReceipt::run_batch(accepted.clone(), id.clone(), run.clone(), 2, 3).unwrap();
        let hash = dto::hash(&dto::canonical_json(&json!({"session_id":id,"run_id":run,"method":"accept_history_run","input":native_input(),"selection":selected})).unwrap());
        sqlx::query("INSERT INTO commands VALUES (?,'accept_history_run',?,2,3,?)")
            .bind(accepted.as_str())
            .bind(hash.as_slice())
            .bind(dto::canonical_json(&acceptance).unwrap())
            .execute(&mut raw)
            .await
            .unwrap();
    }
    let response = crate::execution::tests::response("native-response", vec![], "exact old 雪\0");
    let summary = RunSummary {
        turns_started: 1,
        turns_finished: 1,
        model_requests_attempted: 1,
        model_requests_admitted: 1,
        last_request_id: Some(REQUEST.into()),
        last_upstream_outcome: Some(UpstreamOutcome::TerminalReceived),
        ..Default::default()
    };
    let mut records = vec![
        native_runtime(&run, 1, RunEvent::RunStarted),
        binding(&run, "old-opaque-session", PROVIDER_ID),
        native_runtime(&run, 2, RunEvent::TurnStarted { number: 1 }),
        native_runtime(
            &run,
            3,
            RunEvent::ProviderEvent {
                event: Box::new(EventEnvelope {
                    schema_version: 1,
                    sequence: 19,
                    event_id: "old-opaque-provider-event".into(),
                    session_id: "old-opaque-session".into(),
                    request_id: Some(REQUEST.into()),
                    provider: PROVIDER_ID.into(),
                    provider_sequence: Some(u64::MAX),
                    event: ProviderEvent::ResponseFinished {
                        response: response.clone(),
                    },
                }),
            },
        ),
        native_runtime(
            &run,
            4,
            RunEvent::TurnFinished {
                number: 1,
                response_id: Some(response.id.clone()),
                outcome: TurnOutcome::ModelCompleted,
                upstream_outcome: Some(UpstreamOutcome::TerminalReceived),
            },
        ),
        native_runtime(
            &run,
            5,
            RunEvent::RunFinished {
                outcome: RunOutcome::Completed,
                summary: summary.clone(),
            },
        ),
        AppendRunRecord::Result(RunResult {
            run_id: run.as_str().into(),
            session_id: Some("old-opaque-session".into()),
            outcome: RunOutcome::Completed,
            summary,
            last_response: Some(response),
            events_complete: true,
            sink_error: None,
        }),
    ];
    if version == 1 {
        records.remove(1);
    }
    for record in &mut records {
        if let AppendRunRecord::Runtime(event) = record
            && event.session_id.is_some()
        {
            event.session_id = Some("old-opaque-session".into());
        }
    }
    let operation = OperationId::new();
    let first = if version == 1 { 3 } else { 4 };
    let last = first + records.len() as i64 - 1;
    let receipt =
        CommitReceipt::run_batch(operation.clone(), id.clone(), run.clone(), first, last).unwrap();
    let command_hash = dto::hash(
        &dto::canonical_json(
            &json!({"session_id":id,"run_id":run,"method":"append_run_records","records":records}),
        )
        .unwrap(),
    );
    for (index, record) in records.iter().enumerate() {
        let (kind, payload, source, sequence) = match record {
            AppendRunRecord::Runtime(event) => (
                "runtime.observed",
                serde_json::to_value(event).unwrap(),
                Some(event.event_id.as_str()),
                Some(event.sequence as i64),
            ),
            AppendRunRecord::ProviderBinding(binding) => (
                "run.provider.bound",
                serde_json::to_value(binding).unwrap(),
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
            .bind(index as i64 + first)
            .bind(StoredEventId::new().as_str())
            .bind(kind)
            .bind(run.as_str())
            .bind(source)
            .bind(sequence)
            .bind(format!(
                " \n{}\n ",
                serde_json::to_string_pretty(&payload).unwrap()
            ))
            .execute(&mut raw)
            .await
            .unwrap();
    }
    let AppendRunRecord::Runtime(terminal) = &records[records.len() - 2] else {
        unreachable!()
    };
    sqlx::query("INSERT INTO runs VALUES (?,2,'completed',5,?,'old-opaque-session',?,?,?)")
        .bind(run.as_str())
        .bind(owner.as_str())
        .bind(last - 1)
        .bind(serde_json::to_string(terminal).unwrap())
        .bind(last)
        .execute(&mut raw)
        .await
        .unwrap();
    sqlx::query("INSERT INTO commands VALUES (?,'append_run_records',?,?,?,?)")
        .bind(operation.as_str())
        .bind(command_hash.as_slice())
        .bind(first)
        .bind(last)
        .bind(format!("\n {} ", serde_json::to_string(&receipt).unwrap()))
        .execute(&mut raw)
        .await
        .unwrap();
    sqlx::query("UPDATE manifest SET head_sequence=?")
        .bind(last)
        .execute(&mut raw)
        .await
        .unwrap();
    raw.close().await.unwrap();
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

async fn canonical(path: &Path) -> Vec<String> {
    let mut raw = sql(path).await;
    let mut rows = Vec::new();
    for query in [
        "SELECT json_group_array(json_array(sequence,event_id,event_type,event_version,created_at_ms,run_id,source_event_id,source_sequence,payload_json)) FROM (SELECT * FROM events ORDER BY sequence)",
        "SELECT json_group_array(json_array(operation_id,method,hex(payload_hash),first_sequence,last_sequence,receipt_json)) FROM (SELECT * FROM commands ORDER BY operation_id)",
        "SELECT json_group_array(json_array(run_id,accepted_sequence,state,last_runtime_sequence,owner_instance_id,provider_session_id,terminal_sequence,terminal_json,result_sequence)) FROM runs",
    ] {
        rows.push(sqlx::query_scalar(query).fetch_one(&mut raw).await.unwrap());
    }
    let head: i64 = sqlx::query_scalar("SELECT head_sequence FROM manifest")
        .fetch_one(&mut raw)
        .await
        .unwrap();
    rows.push(
        history_prefix::digest(&mut raw, head as u64, &[])
            .await
            .unwrap(),
    );
    raw.close().await.unwrap();
    rows
}

#[tokio::test]
async fn id2b_historical_supported_opaque_local_ids_survive_raw_migration_binding_b2_repair_and_retries()
 {
    for version in [1, 2] {
        let (_temp, root, id, run, operation, records, receipt) = legacy(version).await;
        let path = filesystem::session_path(&root, &id, false).unwrap();
        let old = canonical(&path).await;
        let store = SessionStore::open(root).await.unwrap();
        let handle = store.open_session(id).await.unwrap();
        assert_eq!(canonical(&path).await, old);
        let before = snapshot(&path).await;
        for deserialized in [false, true] {
            let retry = if deserialized {
                serde_json::from_value(serde_json::to_value(&records).unwrap()).unwrap()
            } else {
                records.clone()
            };
            let duplicate = handle
                .append_run_records(operation.clone(), run.clone(), retry)
                .await
                .unwrap();
            assert!(duplicate.duplicate());
            assert_eq!(duplicate.receipt(), &receipt);
            assert_eq!(snapshot(&path).await, before);
            let mut changed = records.clone();
            let AppendRunRecord::Result(result) = changed.last_mut().unwrap() else {
                unreachable!()
            };
            result.session_id = Some("different-old-session".into());
            assert_eq!(
                handle
                    .append_run_records(operation.clone(), run.clone(), changed)
                    .await
                    .unwrap_err()
                    .code(),
                "storage.command_conflict"
            );
            assert_eq!(snapshot(&path).await, before);
        }
        rejected(
            &handle,
            &run,
            &path,
            records.clone(),
            "storage.invalid_input",
        )
        .await;
        let page = handle.history_page(0, None, 20).await.unwrap();
        assert_eq!(page.records().len() as u64, receipt.last_sequence());
        assert!(page.records().iter().any(|record| matches!(record.payload(), StoredEventPayload::RuntimeObserved(event) if matches!(&event.event, RunEvent::ProviderEvent { event } if event.event_id == "old-opaque-provider-event" && event.session_id == "old-opaque-session"))));
        let bound = handle.provider_binding(run.clone()).await.unwrap();
        if version == 1 {
            assert!(bound.is_none());
        } else {
            assert_eq!(bound.unwrap().provider_session_id(), "old-opaque-session");
        }
        assert_eq!(
            handle
                .run_record(run)
                .await
                .unwrap()
                .unwrap()
                .result()
                .unwrap()
                .session_id
                .as_deref(),
            Some("old-opaque-session")
        );
        let replay = prepare_session_replay(&handle, PROVIDER_ID, "synthetic").await;
        if version == 1 {
            assert!(replay.is_err()); // Released schema1 lacks replay provenance.
        } else {
            let replay = replay.unwrap();
            assert_eq!(replay.included_run_count(), 1);
            assert_eq!(replay.included_exchange_count(), 1);
            let AppendRunRecord::Result(result) = records.last().unwrap() else {
                unreachable!()
            };
            assert_eq!(
                serde_json::to_value(replay.replay().runs()[0].exchanges()[0].response()).unwrap(),
                serde_json::to_value(result.last_response.as_ref().unwrap()).unwrap()
            );
        }
        assert_eq!(store.repair_catalog().await.unwrap().ready_sessions(), 1);
        assert_eq!(canonical(&path).await, old);
        assert_eq!(snapshot(&path).await, before);
        store.close().await.unwrap();
    }
}
