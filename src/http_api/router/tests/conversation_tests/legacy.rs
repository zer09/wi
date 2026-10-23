use super::*;
use crate::storage::StoredEventId;

// Reuse the independently populated schema2 recipe from the shared legacy reader tests.
// Legacy bytes bypass new admission only in this synthetic historical fixture.
async fn seed(
    server: &Server,
    summary: &str,
    human: &str,
) -> (ApplicationSessionId, RunId, RunId, std::path::PathBuf) {
    let root = server.temp.path().join("private-data-canary");
    let id = ApplicationSessionId::new();
    let relative_path = format!("sessions/{}/{id}/session.sqlite3", &id.as_str()[..2]);
    let path = root.join(&relative_path);
    let mut directories = std::fs::DirBuilder::new();
    directories.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directories.mode(0o700);
    }
    directories.create(path.parent().unwrap()).unwrap();
    let mut file = std::fs::OpenOptions::new();
    file.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        file.mode(0o600);
    }
    drop(file.open(&path).unwrap());
    let mut sql = SqliteConnectOptions::new()
        .filename(&path)
        .foreign_keys(true)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("../../../../storage/session_v2.sql"))
        .execute(&mut sql)
        .await
        .unwrap();
    let create = CreateSession::new(OperationId::new(), "synthetic".into(), None).unwrap();
    let creation_event = StoredEventId::new();
    let request =
        json!({"method":"create_session","title":create.title(),"workspace":create.workspace()})
            .to_string();
    let hash: [u8; 32] = ring::digest::digest(&ring::digest::SHA256, request.as_bytes())
        .as_ref()
        .try_into()
        .unwrap();
    let creation_receipt = json!({"operation_id":create.operation_id(),"session_id":id,"run_id":null,"first_sequence":1,"last_sequence":1});
    let provenance = json!({"operation_id":create.operation_id(),"method":"create_session","session_id":id,"creation_event_id":creation_event,"created_at_ms":42,"request_json":request,"payload_hash":hash,"receipt":creation_receipt});
    sqlx::query("INSERT INTO manifest VALUES (1,?,2,1,'synthetic',NULL,42,42,5,?)")
        .bind(id.as_str())
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
    let run = RunId::new();
    let healthy = RunId::new();
    for (run, sequence, text, last_request_id) in [
        (&run, 2_i64, human, Some(summary.to_owned())),
        (&healthy, 4_i64, "healthy block", None),
    ] {
        let owner = StoredEventId::new();
        let record = AppendRunRecord::Result(RunResult {
            run_id: run.to_string(),
            session_id: None,
            outcome: RunOutcome::Failed {
                code: "event_sink".into(),
            },
            summary: RunSummary {
                last_request_id,
                ..Default::default()
            },
            last_response: None,
            events_complete: false,
            sink_error: None,
        });
        let AppendRunRecord::Result(result) = &record else {
            unreachable!()
        };
        let payload = format!(" \n{}\n ", serde_json::to_string_pretty(result).unwrap());
        sqlx::query("INSERT INTO events VALUES (?,?,'run.accepted',1,42,?,NULL,NULL,?)")
            .bind(sequence)
            .bind(StoredEventId::new().as_str())
            .bind(run.as_str())
            .bind(json!({"run_id":run,"input":input(text),"owner_instance_id":owner}).to_string())
            .execute(&mut sql)
            .await
            .unwrap();
        sqlx::query("INSERT INTO events VALUES (?,?,'run.result.recorded',1,42,?,NULL,NULL,?)")
            .bind(sequence + 1)
            .bind(StoredEventId::new().as_str())
            .bind(run.as_str())
            .bind(&payload)
            .execute(&mut sql)
            .await
            .unwrap();
        sqlx::query("INSERT INTO runs VALUES (?,?,'failed',0,?,NULL,?,?,?)")
            .bind(run.as_str())
            .bind(sequence)
            .bind(owner.as_str())
            .bind(sequence + 1)
            .bind(&payload)
            .bind(sequence + 1)
            .execute(&mut sql)
            .await
            .unwrap();
        let op = OperationId::new();
        let receipt = json!({"operation_id":op,"session_id":id,"run_id":run,"first_sequence":sequence+1,"last_sequence":sequence+1});
        let command =
            json!({"session_id":id,"run_id":run,"method":"append_run_records","records":[record]});
        let digest = ring::digest::digest(&ring::digest::SHA256, command.to_string().as_bytes());
        sqlx::query("INSERT INTO commands VALUES (?,'append_run_records',?,?,?,?)")
            .bind(op.as_str())
            .bind(digest.as_ref())
            .bind(sequence + 1)
            .bind(sequence + 1)
            .bind(format!("\n {} ", serde_json::to_string(&receipt).unwrap()))
            .execute(&mut sql)
            .await
            .unwrap();
    }
    sql.close().await.unwrap();
    let mut catalog = SqliteConnectOptions::new()
        .filename(root.join("catalog.sqlite3"))
        .disable_statement_logging()
        .connect()
        .await
        .unwrap();
    sqlx::query("INSERT INTO sessions (session_id,relative_path,title,created_at_ms,updated_at_ms,head_sequence,schema_version,availability) VALUES (?,?,'synthetic',42,42,1,2,'ready')").bind(id.as_str()).bind(relative_path).execute(&mut catalog).await.unwrap();
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
    (id, run, healthy, path)
}

async fn canonical(path: &std::path::Path) -> Vec<String> {
    let mut sql = SqliteConnectOptions::new()
        .filename(path)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap();
    let mut values = Vec::new();
    for query in [
        "SELECT json_group_array(json_array(sequence,event_id,event_type,event_version,created_at_ms,run_id,source_event_id,source_sequence,payload_json)) FROM (SELECT * FROM events ORDER BY sequence)",
        "SELECT json_group_array(json_array(operation_id,method,hex(payload_hash),first_sequence,last_sequence,receipt_json)) FROM (SELECT * FROM commands ORDER BY operation_id)",
        "SELECT json_group_array(json_array(run_id,accepted_sequence,state,last_runtime_sequence,owner_instance_id,provider_session_id,terminal_sequence,terminal_json,result_sequence)) FROM (SELECT * FROM runs ORDER BY run_id)",
    ] {
        values.push(sqlx::query_scalar(query).fetch_one(&mut sql).await.unwrap());
    }
    sql.close().await.unwrap();
    values
}

#[tokio::test]
async fn b1_historical_oversized_header_http_422_preserves_canonical_raw_and_healthy_blocks() {
    let server = Server::new().await;
    let summary = "LEGACY_PRIVATE_SUMMARY".repeat(PAGE_BYTES / 21 + 1);
    let human = "雪\0".repeat(20000);
    let (id, run, healthy, path) = seed(&server, &summary, &human).await;
    let before = canonical(&path).await;
    // The first HTTP open performs the normal one-time schema2 -> schema3 migration.
    let latest = response(server.get(&format!("/v1/sessions/{id}/conversation")), 200).await;
    assert_eq!(latest["block"]["run_id"], healthy.as_str());
    let session = server
        .host
        .storage()
        .open_session(id.clone())
        .await
        .unwrap();
    assert_eq!(canonical(&path).await, before);
    let warm = snapshot(&server, &session).await;
    let content = ContentCursor::new(
        id.clone(),
        run.clone(),
        "e:2:0".parse().unwrap(),
        2,
        "text".into(),
        2,
        human.len() as u64,
    )
    .unwrap();
    for url in [
        format!(
            "{}?before={}",
            base(&session),
            latest["previous_block"].as_str().unwrap()
        ),
        addressed(&session, &run, "e:2:0"),
        format!("{}/content?cursor={content}", base(&session)),
    ] {
        let body = error(
            server.get(&url),
            422,
            "api.conversation_display_unavailable",
        )
        .await;
        assert_eq!(body.as_object().unwrap().len(), 6);
        assert!(!body.to_string().contains("LEGACY_PRIVATE_SUMMARY"));
    }
    let raw = response(server.get(&format!("/v1/sessions/{id}/runs/{run}")), 200).await;
    assert_eq!(raw["result"]["summary"]["last_request_id"], summary);
    let history = response(server.get(&format!("/v1/sessions/{id}/history")), 200).await;
    assert_eq!(history["events"].as_array().unwrap().len(), 5);
    let page = session
        .conversation_entry(healthy.clone(), "e:4:0".parse().unwrap())
        .await
        .unwrap();
    exact(
        server.get(&addressed(&session, &healthy, "e:4:0")),
        DisplayJson::EntryPage(&page),
    )
    .await;
    assert_eq!(canonical(&path).await, before);
    assert_eq!(snapshot(&server, &session).await, warm);
    server.finish().await;
}

#[tokio::test]
async fn b2_initial_legacy_unrepresentable_batch_is_422_before_sse_and_never_mutates() {
    let server = Server::new().await;
    let summary = "LEGACY_PRIVATE_SUMMARY".repeat(PAGE_BYTES / 21 + 1);
    let (id, run, healthy, file) = seed(&server, &summary, "anchor").await;
    let before = canonical(&file).await;
    let after = crate::conversation::LiveCursor::new(id.clone(), 1, 3, None, None).unwrap();
    let body = error(
        server.get(&format!(
            "/v1/sessions/{id}/conversation/events?after={after}"
        )),
        422,
        "api.conversation_display_unavailable",
    )
    .await;
    assert!(!body.to_string().contains("LEGACY_PRIVATE_SUMMARY"));
    let session = server
        .host
        .storage()
        .open_session(id.clone())
        .await
        .unwrap();
    let warm = snapshot(&server, &session).await;
    error(
        server.get(&format!("{}/events?after={after}", base(&session))),
        422,
        "api.conversation_display_unavailable",
    )
    .await;
    let raw = response(server.get(&format!("/v1/sessions/{id}/runs/{run}")), 200).await;
    assert_eq!(raw["result"]["summary"]["last_request_id"], summary);
    let page = response(server.get(&base(&session)), 200).await;
    assert_eq!(page["block"]["run_id"], healthy.as_str());
    assert_eq!(canonical(&file).await, before);
    assert_eq!(snapshot(&server, &session).await, warm);
    server.finish().await;
}
