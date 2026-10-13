use super::*;
use crate::{execution::prepare_session_replay, http_api::dto::RunView, storage::RecordedRunInput};

mod boundaries;
mod proof;

fn reconcile_path(session: &SessionHandle) -> String {
    format!("{}/reconcile", path(session))
}
fn absent() -> Value {
    json!({"api_version":1,"state":"not_found","acceptance":null,"run":null})
}
fn effects(server: &Server, script: &Script) -> [usize; 7] {
    [
        count(&server.run_hooks.readers),
        count(&server.run_hooks.dispatched),
        count(&script.validations),
        count(&script.opens),
        script.control.inputs.lock().unwrap().len(),
        script.control.installed.lock().unwrap().len(),
        count(&script.control.closes),
    ]
}

// Compare every logical session table, including receipts and all display rows/chunks.
async fn snapshot(server: &Server, session: &SessionHandle) -> Vec<Vec<String>> {
    let mut db = sql(server, session, true).await;
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .fetch_all(&mut db)
    .await
    .unwrap();
    let mut rows = Vec::new();
    for table in tables {
        let columns: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info(?) ORDER BY cid")
                .bind(&table)
                .fetch_all(&mut db)
                .await
                .unwrap();
        let columns: Vec<_> = columns
            .iter()
            .map(|name| format!("\"{}\"", name.replace('"', "\"\"")))
            .collect();
        let quoted = columns
            .iter()
            .map(|name| format!("quote({name})"))
            .collect::<Vec<_>>()
            .join(",");
        let query = format!(
            "SELECT json_array({quoted}) FROM \"{}\" ORDER BY {}",
            table.replace('"', "\"\""),
            columns.join(",")
        );
        rows.push(
            sqlx::query_scalar(sqlx::AssertSqlSafe(query))
                .fetch_all(&mut db)
                .await
                .unwrap(),
        );
    }
    db.close().await.unwrap();
    rows
}

async fn accepted(server: &Server, session: &SessionHandle, body: &Value) -> Value {
    let receipt = session
        .lookup_receipt(operation(body))
        .await
        .unwrap()
        .unwrap();
    let record = session.run_record(run(body)).await.unwrap().unwrap();
    let expected = json!({
        "api_version":1,"state":"accepted",
        "acceptance":dto::ReceiptView::from(&receipt),"run":RunView::from(&record)
    });
    let reply = response(server.post(&reconcile_path(session), body), 200).await;
    assert_eq!(reply, expected);
    assert_eq!(
        reply["acceptance"]["session_id"],
        json!(session.session_id())
    );
    assert_eq!(reply["acceptance"]["operation_id"], body["operation_id"]);
    assert_eq!(reply["acceptance"]["run_id"], body["run_id"]);
    assert_eq!(reply["run"]["user_text"], body["text"]);
    assert!(reply["acceptance"].get("api_version").is_none());
    for value in [
        &reply["acceptance"]["first_sequence"],
        &reply["acceptance"]["last_sequence"],
        &reply["run"]["accepted_sequence"],
        &reply["run"]["terminal_sequence"],
        &reply["run"]["result_sequence"],
    ] {
        if let Some(value) = value.as_str() {
            assert_eq!(value.parse::<u64>().unwrap().to_string(), value);
        } else {
            assert!(value.is_null());
        }
    }
    reply
}

async fn public_accept(session: &SessionHandle, body: &Value) {
    let selection = prepare_session_replay(session, "http-test", "synthetic-model")
        .await
        .unwrap()
        .selection();
    let input = RecordedRunInput::new(
        body["text"].as_str().unwrap().into(),
        crate::run::RunRequest {
            provider_id: "http-test".into(),
            options: SessionOptions::new("synthetic-model"),
            prompt: "private-prepared-prompt-canary".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap();
    session
        .accept_history_run(operation(body), run(body), input, selection)
        .await
        .unwrap();
}

#[tokio::test]
async fn b3_real_active_tool_terminal_and_offscreen_acceptance_is_read_only() {
    use crate::{CallOrigin, FunctionCall, ItemKind, OutputItem};
    let mut tool = model("tool");
    tool.output.push(OutputItem {
        id: Some("tool-item".into()),
        kind: ItemKind::FunctionCall,
        native_type: "function_call".into(),
        function_call: Some(FunctionCall {
            call_id: "add".into(),
            name: "add_numbers".into(),
            arguments: r#"{"a":19,"b":23}"#.into(),
            origin: CallOrigin::Direct,
            namespace: None,
            complete: true,
        }),
        native: json!({"private":"private-native-canary"}),
    });
    let (gateway, script) = Script::new(Mode::Good, vec![tool, model("final")]);
    let server = Server::gateway(gateway).await;
    let (temp, host) = server.stop_http().await;
    let server = Server::start_tools(temp, host, false, true).await;
    let session = server.session().await;
    let body = command();
    let receipt = response(server.post(&path(&session), &body), 202).await;
    watchdog(script.control.waiting.notified()).await;
    let before = snapshot(&server, &session).await;
    let counters = effects(&server, &script);
    let running = accepted(&server, &session, &body).await;
    assert_eq!(running["run"]["state"], "running");
    assert_eq!(running["run"]["result"], Value::Null);
    assert_eq!(running["acceptance"], receipt["receipt"]);
    assert_eq!(snapshot(&server, &session).await, before);
    assert_eq!(effects(&server, &script), counters);
    script.control.release.notify_one();
    watchdog(script.control.waiting.notified()).await;
    let result = session
        .tool_result(run(&body), "add".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.output(), Some("{\"sum\":42}"));
    assert_eq!(result.is_error(), Some(false));
    let before = snapshot(&server, &session).await;
    let counters = effects(&server, &script);
    accepted(&server, &session, &body).await;
    assert_eq!(snapshot(&server, &session).await, before);
    assert_eq!(effects(&server, &script), counters);
    script.control.release.notify_one();
    finished(&session, &body).await;
    let terminal = accepted(&server, &session, &body).await;
    assert_eq!(terminal["run"]["state"], "completed");
    assert_eq!(terminal["run"]["result_recorded"], true);
    assert_eq!(
        terminal["run"]["result"]["summary"]["new_tool_dispatches"],
        "1"
    );
    assert_eq!(
        terminal["run"]["result"]["summary"]["model_requests_admitted"],
        "2"
    );
    assert!(terminal["run"]["result"].get("last_response").is_none());
    let newer = command();
    public_accept(&session, &newer).await;
    let latest = response(
        server.get(&format!(
            "/v1/sessions/{}/conversation",
            session.session_id()
        )),
        200,
    )
    .await;
    assert_eq!(latest["block"]["run_id"], newer["run_id"]);
    assert_ne!(latest["block"]["run_id"], body["run_id"]);
    let before = snapshot(&server, &session).await;
    let counters = effects(&server, &script);
    assert_eq!(accepted(&server, &session, &body).await, terminal);
    assert_eq!(snapshot(&server, &session).await, before);
    assert_eq!(effects(&server, &script), counters);
    let raw = response(
        server.get(&format!("{}/{}", path(&session), run(&body))),
        200,
    )
    .await;
    assert_eq!(raw, terminal["run"]);
    assert_eq!(count(&script.opens), 1);
    assert_eq!(script.control.inputs.lock().unwrap().len(), 2);
    server.finish().await;
}

#[tokio::test]
async fn b3_large_original_http_task_resolves_in_one_request_without_preparation() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let mut body = command();
    body["text"] = json!("雪\r\n\"".repeat(12_000));
    assert!(body.to_string().len() < crate::MAX_INPUT_BYTES);
    response(server.post(&path(&session), &body), 202).await;
    watchdog(script.control.waiting.notified()).await;
    let counters = effects(&server, &script);
    let before = snapshot(&server, &session).await;
    accepted(&server, &session, &body).await;
    assert_eq!(snapshot(&server, &session).await, before);
    assert_eq!(effects(&server, &script), counters);
    script.control.release.notify_one();
    finished(&session, &body).await;
    server.finish().await;
}

#[tokio::test]
async fn b3_absence_with_an_active_task_and_later_acceptance_is_point_in_time() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let first = command();
    response(server.post(&path(&session), &first), 202).await;
    watchdog(script.control.waiting.notified()).await;
    let missing = command();
    let counters = effects(&server, &script);
    let before = snapshot(&server, &session).await;
    assert_eq!(
        response(server.post(&reconcile_path(&session), &missing), 200).await,
        absent()
    );
    assert_eq!(snapshot(&server, &session).await, before);
    assert_eq!(effects(&server, &script), counters);
    script.control.release.notify_one();
    finished(&session, &first).await;
    public_accept(&session, &missing).await;
    let later = accepted(&server, &session, &missing).await;
    assert_eq!(later["run"]["state"], "accepted");
    assert_eq!(later["run"]["result_recorded"], false);
    server.finish().await;
}

#[tokio::test]
async fn b3_receipt_proof_ignores_changed_configuration_and_missing_sources() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let body = command();
    response(server.post(&path(&session), &body), 202).await;
    watchdog(script.control.waiting.notified()).await;
    script.control.release.notify_one();
    finished(&session, &body).await;
    let sid = session.session_id().clone();
    let (temp, host) = server.stop_http().await;
    assert!(matches!(
        &*watchdog(host.begin_shutdown().wait()).await,
        crate::service::ShutdownOutcome::Closed
    ));
    drop(host);
    std::fs::remove_dir(temp.path().join("workspace")).unwrap();
    std::fs::create_dir(temp.path().join("private-skills-canary")).unwrap();
    std::fs::write(
        temp.path().join("private-skills-canary/SKILL.md"),
        "invalid private-format-canary",
    )
    .unwrap();
    let store = SessionStore::open(temp.path().join("private-data-canary"))
        .await
        .unwrap();
    let host = Arc::new(RunHost::new(store, Arc::new(Gateway::new())).unwrap());
    let server = Server::start_tools(temp, host, true, true).await;
    let session = server.host.storage().open_session(sid).await.unwrap();
    let before = snapshot(&server, &session).await;
    let counters = effects(&server, &script);
    accepted(&server, &session, &body).await;
    assert_eq!(
        response(server.post(&reconcile_path(&session), &command()), 200).await,
        absent()
    );
    assert_eq!(snapshot(&server, &session).await, before);
    assert_eq!(effects(&server, &script), counters);
    assert_eq!(count(&server.run_hooks.readers), 0);
    assert_eq!(count(&server.run_hooks.dispatched), 0);
    server.finish().await;
}

#[tokio::test]
async fn b3_catalog_creation_operation_is_session_receipt_absence() {
    let (server, script) = Script::server().await;
    let operation_id = OperationId::new();
    let created = response(
        server.post(
            "/v1/sessions",
            &json!({"operation_id":operation_id,"title":"synthetic","workspace":server.workspace()}),
        ),
        201,
    )
    .await;
    assert_eq!(created["receipt"]["operation_id"], json!(operation_id));
    let sid: ApplicationSessionId = created["session_id"].as_str().unwrap().parse().unwrap();
    let session = server
        .host
        .storage()
        .open_session(sid.clone())
        .await
        .unwrap();
    // Creation has a catalog receipt but no receipt in the session command table.
    assert!(
        session
            .lookup_receipt(operation_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    let before = session.history_page(0, None, 128).await.unwrap();
    let before = serde_json::to_value(before.records()).unwrap();
    let reply = server
        .post(
            &format!("/v1/sessions/{sid}/runs/reconcile"),
            &json!({"operation_id":operation_id,"run_id":RunId::new(),"text":RAW}),
        )
        .send()
        .await
        .unwrap();
    let status = reply.status().as_u16();
    assert_eq!(reply.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(reply.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    let body: Value = reply.json().await.unwrap();
    let after = session.history_page(0, None, 128).await.unwrap();
    assert_eq!(serde_json::to_value(after.records()).unwrap(), before);
    assert_eq!(count(&server.run_hooks.readers), 0);
    assert_eq!(count(&server.run_hooks.dispatched), 0);
    assert_eq!(count(&script.opens), 0);
    assert_eq!(count(&script.validations), 0);
    assert!(script.control.inputs.lock().unwrap().is_empty());
    server.finish().await;
    // Catalog creation receipts are outside this unchanged session-receipt proof.
    assert_eq!(status, 200);
    assert_eq!(
        body,
        json!({"api_version":1,"state":"not_found","acceptance":null,"run":null})
    );
}
