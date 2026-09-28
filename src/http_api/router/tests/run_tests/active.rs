use super::*;
use crate::{execution::PersistentRunRequest, tools::ToolRegistry};

fn active_error(reply: &Value) {
    assert_eq!(
        reply,
        &json!({
            "api_version": 1,
            "code": "storage.active_run_exists",
            "stage": null,
            "certainty": "not_committed",
            "acceptance": null,
            "notices": [],
        })
    );
}

async fn no_command(server: &Server, session: &SessionHandle, body: &Value) {
    let mut db = sql(server, session, true).await;
    let counts: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM commands WHERE operation_id=?), \
         (SELECT count(*) FROM events WHERE run_id=?), \
         (SELECT count(*) FROM runs WHERE run_id=?)",
    )
    .bind(operation(body).as_str())
    .bind(run(body).as_str())
    .bind(run(body).as_str())
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(counts, (0, 0, 0));
    db.close().await.unwrap();
}

#[tokio::test]
async fn known_active_rejects_before_preparation_and_keeps_retry_conflicts_canonical() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let first = command();
    let accepted = response(server.post(&path(&session), &first), 202).await;
    watchdog(script.control.waiting.notified()).await;
    let head = session.manifest().await.unwrap().head_sequence();
    let second = command();
    active_error(&response(server.post(&path(&session), &second), 409).await);
    no_command(&server, &session, &second).await;
    // Run identity does not replace operation identity in the active guard.
    let mut shared_run = second.clone();
    shared_run["run_id"] = first["run_id"].clone();
    active_error(&response(server.post(&path(&session), &shared_run), 409).await);
    let duplicate = response(server.post(&path(&session), &first), 202).await;
    assert_eq!(duplicate["receipt"], accepted["receipt"]);
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(duplicate["notices"], json!([]));
    for field in ["text", "run_id"] {
        let mut changed = first.clone();
        changed[field] = if field == "text" {
            json!("changed")
        } else {
            json!(RunId::new())
        };
        let reply = response(server.post(&path(&session), &changed), 409).await;
        assert_eq!(reply["code"], "storage.command_conflict");
        assert_eq!(reply["stage"], Value::Null);
        assert_eq!(reply["certainty"], "not_applicable");
    }
    assert_eq!(session.manifest().await.unwrap().head_sequence(), head);
    assert_eq!(count(&server.run_hooks.readers), 1);
    assert_eq!(count(&server.run_hooks.dispatched), 1);
    assert_eq!(count(&script.validations), 1);
    assert_eq!(count(&script.opens), 1);
    assert_eq!(script.control.inputs.lock().unwrap().len(), 1);
    assert_eq!(count(&script.control.closes), 0);
    script.control.release.notify_one();
    finished(&session, &first).await;
    no_command(&server, &session, &second).await;
    server.finish().await;
}

#[tokio::test]
async fn simultaneous_distinct_http_operations_admit_one_and_reject_one_without_notices() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    // Both preparations collect a real notice. Neither rejection may expose it.
    let bad = server.temp.path().join("workspace/.agents/skills/bad");
    std::fs::create_dir_all(&bad).unwrap();
    std::fs::write(bad.join("SKILL.md"), "---\nname: [invalid\n---\n").unwrap();
    let first = command();
    let second = command();
    let a = Arc::new(runs::test_hooks::Pause::default());
    let b = Arc::new(runs::test_hooks::Pause::default());
    *server.run_hooks.after.lock().unwrap() = Some(a.clone());
    let request = server.post(&path(&session), &first);
    let left = tokio::spawn(async move { request.send().await.unwrap() });
    watchdog(a.reached.notified()).await;
    *server.run_hooks.after.lock().unwrap() = Some(b.clone());
    let request = server.post(&path(&session), &second);
    let right = tokio::spawn(async move { request.send().await.unwrap() });
    watchdog(b.reached.notified()).await;
    assert_eq!(count(&server.run_hooks.dispatched), 0);
    assert_eq!(count(&script.opens), 0);
    a.release();
    b.release();
    let left = watchdog(left).await.unwrap();
    let right = watchdog(right).await.unwrap();
    let (winner, loser, winner_body, loser_body) = if left.status() == 202 {
        (left, right, &first, &second)
    } else {
        (right, left, &second, &first)
    };
    assert_eq!(winner.status(), 202);
    assert_eq!(loser.status(), 409);
    let winner: Value = winner.json().await.unwrap();
    active_error(&loser.json().await.unwrap());
    assert_eq!(winner["duplicate"], false);
    assert_eq!(
        winner["receipt"]["operation_id"],
        winner_body["operation_id"]
    );
    assert_eq!(winner["notices"].as_array().unwrap().len(), 1);
    watchdog(script.control.waiting.notified()).await;
    assert_eq!(count(&server.run_hooks.readers), 2);
    assert_eq!(count(&server.run_hooks.dispatched), 2);
    assert_eq!(count(&script.validations), 1);
    assert_eq!(count(&script.opens), 1);
    assert_eq!(script.control.inputs.lock().unwrap().len(), 1);
    no_command(&server, &session, loser_body).await;
    let mut db = sql(&server, &session, true).await;
    let accepted: i64 =
        sqlx::query_scalar("SELECT count(*) FROM events WHERE event_type='run.accepted'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(accepted, 1);
    db.close().await.unwrap();
    script.control.release.notify_one();
    finished(&session, winner_body).await;
    no_command(&server, &session, loser_body).await;
    server.finish().await;
}

#[tokio::test]
async fn delayed_absent_receipt_reconciles_advisory_and_exclusive_rejections_to_duplicate() {
    for advisory in [true, false] {
        let (server, script) = Script::server().await;
        let session = server.session().await;
        let body = command();
        let receipt_pause = Arc::new(Pause::default());
        let prepared_pause = Arc::new(runs::test_hooks::Pause::default());
        if advisory {
            session.test_hooks().arm(
                Point::ReceiptLookupComplete,
                Action::Pause(receipt_pause.clone()),
            );
        } else {
            *server.run_hooks.after.lock().unwrap() = Some(prepared_pause.clone());
        }
        let request = server.post(&path(&session), &body);
        let delayed = tokio::spawn(async move { request.send().await.unwrap() });
        if advisory {
            watchdog(receipt_pause.reached.notified()).await;
        } else {
            watchdog(prepared_pause.reached.notified()).await;
        }
        assert!(
            session
                .lookup_receipt(operation(&body))
                .await
                .unwrap()
                .is_none()
        );
        let winner = response(server.post(&path(&session), &body), 202).await;
        watchdog(script.control.waiting.notified()).await;
        script.control.release.notify_one();
        let recorded = finished(&session, &body).await;
        let other = command();
        let client = server.host.client();
        watchdog(async {
            while client.has_other_active_operation(session.session_id(), &operation(&other)) {
                tokio::task::yield_now().await;
            }
        })
        .await;
        // Hold another registered operation before replay. It owns precommit work but
        // does not need to accept or transmit any history to trigger either guard.
        let live_pause = Arc::new(Pause::default());
        session.test_hooks().arm(
            Point::ReceiptLookupComplete,
            Action::Pause(live_pause.clone()),
        );
        let live = client
            .submit_exclusive(
                session.session_id().clone(),
                PersistentRunRequest {
                    operation_id: operation(&other),
                    run_id: run(&other),
                    input: recorded.input().clone(),
                },
                ToolRegistry::new(),
            )
            .unwrap();
        watchdog(live_pause.reached.notified()).await;
        assert!(client.has_other_active_operation(session.session_id(), &operation(&body)));
        if advisory {
            receipt_pause.release.notify_one();
        } else {
            prepared_pause.release();
        }
        let delayed = watchdog(delayed).await.unwrap();
        assert_eq!(delayed.status(), 202);
        let duplicate: Value = delayed.json().await.unwrap();
        assert_eq!(duplicate["receipt"], winner["receipt"]);
        assert_eq!(duplicate["duplicate"], true);
        assert_eq!(duplicate["warning_code"], Value::Null);
        assert_eq!(duplicate["notices"], json!([]));
        assert_eq!(
            count(&server.run_hooks.readers),
            if advisory { 1 } else { 2 }
        );
        assert_eq!(
            count(&server.run_hooks.dispatched),
            if advisory { 1 } else { 2 }
        );
        assert_eq!(count(&script.opens), 1);
        assert_eq!(count(&script.validations), 1);
        assert_eq!(script.control.inputs.lock().unwrap().len(), 1);
        no_command(&server, &session, &other).await;
        // Cancel only as explicit fixture shutdown, after observing the race outcome.
        let shutdown = server.host.begin_shutdown();
        live_pause.release.notify_one();
        watchdog(live.completion()).await;
        assert!(matches!(
            &*watchdog(shutdown.wait()).await,
            crate::service::ShutdownOutcome::Closed
        ));
        server.finish().await;
    }
}

#[tokio::test]
async fn no_live_entry_unfinished_and_restarted_history_keep_history_error() {
    for reopen in [false, true] {
        let (mut server, script) = Script::server().await;
        let session = server.session().await;
        let old = command();
        let selection =
            crate::execution::prepare_session_replay(&session, "http-test", "synthetic-model")
                .await
                .unwrap()
                .selection();
        session
            .accept_history_run(
                operation(&old),
                run(&old),
                super::receipts::captured(RAW),
                selection,
            )
            .await
            .unwrap();
        if reopen {
            let (temp, host) = server.stop_http().await;
            assert!(matches!(
                &*watchdog(host.begin_shutdown().wait()).await,
                crate::service::ShutdownOutcome::Closed
            ));
            drop(host);
            let store = SessionStore::open(temp.path().join("private-data-canary"))
                .await
                .unwrap();
            let host = Arc::new(RunHost::new(store, Arc::new(Gateway::new())).unwrap());
            server = Server::start(temp, host, false).await;
        }
        let next = command();
        assert!(
            !server
                .host
                .client()
                .has_other_active_operation(session.session_id(), &operation(&next))
        );
        let reply = response(server.post(&path(&session), &next), 422).await;
        assert_eq!(
            reply,
            json!({
                "api_version": 1, "code": "invalid_request", "stage": "history",
                "certainty": "not_applicable", "acceptance": null, "notices": [],
            })
        );
        no_command(&server, &session, &next).await;
        assert_eq!(count(&server.run_hooks.readers), 1);
        assert_eq!(count(&server.run_hooks.dispatched), 1);
        assert_eq!(count(&script.opens), 0);
        assert_eq!(count(&script.validations), 0);
        server.finish().await;
    }
}
