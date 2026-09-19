use super::*;
use crate::{
    execution::prepare_session_replay,
    run::RunRequest,
    storage::{AppendRunRecord, RecordedRunInput},
};

fn captured(text: &str) -> RecordedRunInput {
    RecordedRunInput::new(
        text.into(),
        RunRequest {
            provider_id: "http-test".into(),
            options: SessionOptions::new("synthetic-model"),
            prompt: text.into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap()
}

#[tokio::test]
async fn raw_retry_precedes_changed_sources_settings_retirement_and_reopen() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let body = command();
    let accepted = response(server.post(&path(&session), &body), 202).await;
    watchdog(script.control.waiting.notified()).await;
    let stored = session.run_record(run(&body)).await.unwrap().unwrap();
    assert!(stored.input().tool_definitions().is_empty());
    assert_eq!(stored.input().prepared_request().prompt, RAW);
    script.control.release.notify_one();
    finished(&session, &body).await;
    let (temp, host) = server.stop_http().await;
    assert!(matches!(
        &*watchdog(host.begin_shutdown().wait()).await,
        crate::service::ShutdownOutcome::Closed
    ));
    drop(host);
    // New settings, no registered provider, missing original workspace and changed global source.
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
    let sid = session.session_id();
    let retry = response(server.post(&path(&session), &body), 202).await;
    assert_eq!(retry["receipt"], accepted["receipt"]);
    assert_eq!(retry["duplicate"], true);
    assert_eq!(retry["notices"], json!([]));
    let mut changed = body.clone();
    changed["text"] = json!(RAW.trim());
    error(
        server.post(&path(&session), &changed),
        409,
        "storage.command_conflict",
    )
    .await;
    changed = body.clone();
    changed["run_id"] = json!(RunId::new());
    error(
        server.post(&path(&session), &changed),
        409,
        "storage.command_conflict",
    )
    .await;
    error(
        server.post(&path(&session), &command()),
        403,
        "api.workspace_forbidden",
    )
    .await;
    response(server.get(&format!("/v1/sessions/{sid}")), 200).await;
    assert_eq!(count(&server.run_hooks.readers), 0);
    assert_eq!(count(&server.run_hooks.dispatched), 0);
    assert_eq!(count(&script.opens), 1);
    server.finish().await;
}

#[tokio::test]
async fn rename_b1_and_append_receipts_are_not_b2_acceptances() {
    let (server, script) = Script::server().await;
    for method in ["rename", "b1", "append"] {
        let session = server.session().await;
        let body = command();
        let op = operation(&body);
        let rid = run(&body);
        match method {
            "rename" => {
                session.rename(op, "rename".into()).await.unwrap();
            }
            "b1" => {
                session.accept_run(op, rid, captured(RAW)).await.unwrap();
            }
            "append" => {
                session
                    .accept_run(OperationId::new(), rid.clone(), captured(RAW))
                    .await
                    .unwrap();
                session
                    .append_run_records(
                        op,
                        rid.clone(),
                        vec![AppendRunRecord::Runtime(crate::run::RunEventEnvelope {
                            schema_version: 2,
                            sequence: 1,
                            event_id: uuid::Uuid::new_v4().to_string(),
                            run_id: rid.to_string(),
                            turn_id: None,
                            session_id: None,
                            request_id: None,
                            event: crate::run::RunEvent::RunStarted,
                        })],
                    )
                    .await
                    .unwrap();
            }
            _ => unreachable!(),
        }
        error(
            server.post(&path(&session), &body),
            409,
            "storage.command_conflict",
        )
        .await;
    }
    assert_eq!(count(&server.run_hooks.readers), 0);
    assert_eq!(count(&server.run_hooks.dispatched), 0);
    assert_eq!(count(&script.opens), 0);
    server.finish().await;
}

#[tokio::test]
async fn typed_evidence_rejects_forged_method_range_and_missing_projections() {
    for corruption in ["method", "range", "run", "selection", "accepted_sequence"] {
        let (server, script) = Script::server().await;
        let session = server.session().await;
        let body = command();
        let selection = prepare_session_replay(&session, "http-test", "synthetic-model")
            .await
            .unwrap()
            .selection();
        session
            .accept_history_run(operation(&body), run(&body), captured(RAW), selection)
            .await
            .unwrap();
        let mut db = sql(&server, &session, false).await;
        let mutation = match corruption {
            "method" => "UPDATE commands SET method='append_run_records' WHERE first_sequence=2",
            "range" => "UPDATE commands SET last_sequence=2 WHERE first_sequence=2",
            "run" => "DELETE FROM runs",
            "selection" => "DELETE FROM events WHERE sequence=3",
            "accepted_sequence" => "UPDATE runs SET accepted_sequence=3",
            _ => unreachable!(),
        };
        // This missing event leaves an intentional dangling command reference. SQLite only
        // changes foreign-key enforcement outside a transaction on this fixture connection.
        if corruption == "selection" {
            sqlx::query("PRAGMA foreign_keys=OFF")
                .execute(&mut db)
                .await
                .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
                    .fetch_one(&mut db)
                    .await
                    .unwrap(),
                0
            );
        }
        // Deliberate corruption in this synthetic database only. Restore every guard before HTTP.
        let triggers: Vec<(String, String)> =
            sqlx::query_as("SELECT name, sql FROM sqlite_schema WHERE type='trigger'")
                .fetch_all(&mut db)
                .await
                .unwrap();
        let mut transaction = db.begin().await.unwrap();
        for (name, _) in &triggers {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "DROP TRIGGER \"{}\"",
                name.replace('"', "\"\"")
            )))
            .execute(&mut *transaction)
            .await
            .unwrap();
        }
        sqlx::query(mutation)
            .execute(&mut *transaction)
            .await
            .unwrap();
        for (_, definition) in &triggers {
            sqlx::query(sqlx::AssertSqlSafe(definition.as_str()))
                .execute(&mut *transaction)
                .await
                .unwrap();
        }
        transaction.commit().await.unwrap();
        sqlx::query("PRAGMA foreign_keys=ON")
            .execute(&mut db)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            1
        );
        db.close().await.unwrap();
        if corruption == "method" {
            assert!(
                session
                    .lookup_receipt(operation(&body))
                    .await
                    .unwrap()
                    .is_some()
            );
            assert!(session.run_record(run(&body)).await.unwrap().is_some());
        }
        let result = server.post(&path(&session), &body).send().await.unwrap();
        assert!(matches!(result.status().as_u16(), 409 | 500));
        let error: Value = result.json().await.unwrap();
        assert!(matches!(
            error["code"].as_str().unwrap(),
            "storage.command_conflict" | "storage.integrity"
        ));
        assert_eq!(count(&server.run_hooks.readers), 0);
        assert_eq!(count(&server.run_hooks.dispatched), 0);
        assert_eq!(count(&script.opens), 0);
        server.finish().await;
    }
}
