use super::*;
use crate::storage::AppendRunRecord;

#[tokio::test]
async fn b3_exact_text_run_and_session_command_conflicts_preserve_all_rows() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let body = command();
    public_accept(&session, &body).await;
    let before = snapshot(&server, &session).await;
    for text in [
        RAW.trim().to_owned(),
        RAW.replace('雪', "雪\u{301}"),
        RAW.replace("\r\n", "\n"),
        format!("{RAW} "),
    ] {
        let mut changed = body.clone();
        changed["text"] = json!(text);
        let reply = error(
            server.post(&reconcile_path(&session), &changed),
            409,
            "storage.command_conflict",
        )
        .await;
        assert_eq!(reply["certainty"], "not_applicable");
    }
    let mut changed = body.clone();
    changed["run_id"] = json!(RunId::new());
    error(
        server.post(&reconcile_path(&session), &changed),
        409,
        "storage.command_conflict",
    )
    .await;
    assert_eq!(snapshot(&server, &session).await, before);
    for method in ["rename", "direct", "append"] {
        let session = server.session().await;
        let body = command();
        match method {
            "rename" => {
                session
                    .rename(operation(&body), "rename".into())
                    .await
                    .unwrap();
            }
            "direct" => {
                session
                    .accept_run(
                        operation(&body),
                        run(&body),
                        super::super::receipts::captured(RAW),
                    )
                    .await
                    .unwrap();
            }
            "append" => {
                session
                    .accept_run(
                        OperationId::new(),
                        run(&body),
                        super::super::receipts::captured(RAW),
                    )
                    .await
                    .unwrap();
                session
                    .append_run_records(
                        operation(&body),
                        run(&body),
                        vec![AppendRunRecord::Runtime(crate::run::RunEventEnvelope {
                            schema_version: 2,
                            sequence: 1,
                            event_id: uuid::Uuid::new_v4().to_string(),
                            run_id: run(&body).to_string(),
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
        let before = snapshot(&server, &session).await;
        error(
            server.post(&reconcile_path(&session), &body),
            409,
            "storage.command_conflict",
        )
        .await;
        assert_eq!(snapshot(&server, &session).await, before);
    }
    assert_eq!(effects(&server, &script), [0; 7]);
    server.finish().await;
}

#[tokio::test]
async fn b3_corrupted_method_hash_input_text_and_source_are_integrity_not_absence() {
    for mutation in [
        "UPDATE commands SET method='append_run_records' WHERE first_sequence=2",
        "UPDATE commands SET payload_hash=zeroblob(32) WHERE first_sequence=2",
        "UPDATE commands SET last_sequence=2 WHERE first_sequence=2",
        "UPDATE events SET payload_json=json_set(payload_json,'$.input.prepared_request.prompt','changed') WHERE sequence=2",
        "UPDATE events SET payload_json=json_set(payload_json,'$.input.user_text','changed') WHERE sequence=2",
        "UPDATE events SET payload_json=json_set(payload_json,'$.run_id','11111111-1111-4111-8111-111111111111') WHERE sequence=2",
        "DELETE FROM runs",
        "DELETE FROM events WHERE sequence=3",
        "UPDATE runs SET accepted_sequence=3",
    ] {
        let (server, script) = Script::server().await;
        let session = server.session().await;
        let body = command();
        public_accept(&session, &body).await;
        let mut db = sql(&server, &session, false).await;
        // Only this synthetic database loses its guards, and all guards return before HTTP.
        sqlx::query("PRAGMA foreign_keys=OFF")
            .execute(&mut db)
            .await
            .unwrap();
        let triggers: Vec<(String, String)> =
            sqlx::query_as("SELECT name,sql FROM sqlite_schema WHERE type='trigger'")
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
        assert_eq!(
            sqlx::query(mutation)
                .execute(&mut *transaction)
                .await
                .unwrap()
                .rows_affected(),
            1
        );
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
        let before = snapshot(&server, &session).await;
        let reply = error(
            server.post(&reconcile_path(&session), &body),
            500,
            "storage.integrity",
        )
        .await;
        assert_eq!(reply["certainty"], "not_applicable");
        assert_eq!(snapshot(&server, &session).await, before);
        assert_eq!(effects(&server, &script), [0; 7]);
        server.finish().await;
    }
}

#[tokio::test]
async fn b3_unknown_session_and_read_errors_keep_safe_codes_and_certainty() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let body = command();
    let before = snapshot(&server, &session).await;
    let reply = error(
        server.post(
            &format!(
                "/v1/sessions/{}/runs/reconcile",
                ApplicationSessionId::new()
            ),
            &body,
        ),
        404,
        "storage.not_found",
    )
    .await;
    assert_eq!(reply["certainty"], "not_applicable");
    for point in [Point::Open, Point::ReceiptLookupComplete] {
        for (kind, status, code, certainty) in [
            (StorageErrorKind::Io, 503, "storage.io", "not_applicable"),
            (
                StorageErrorKind::Busy,
                503,
                "storage.busy",
                "not_applicable",
            ),
            (
                StorageErrorKind::Integrity,
                500,
                "storage.integrity",
                "not_applicable",
            ),
            (
                StorageErrorKind::CommitUnknown,
                503,
                "storage.commit_unknown",
                "unknown",
            ),
        ] {
            session.test_hooks().arm(point, Action::Fail(kind));
            assert_eq!(
                error(server.post(&reconcile_path(&session), &body), status, code).await["certainty"],
                certainty
            );
            assert_eq!(snapshot(&server, &session).await, before);
        }
    }
    assert_eq!(effects(&server, &script), [0; 7]);
    assert!(matches!(
        &*watchdog(server.host.begin_shutdown().wait()).await,
        crate::service::ShutdownOutcome::Closed
    ));
    error(
        server.post(&reconcile_path(&session), &body),
        503,
        "storage.closed",
    )
    .await;
    server.finish().await;
}

#[tokio::test]
async fn b3_failed_terminal_results_remain_safe_and_do_not_redispatch() {
    for mode in [Mode::Open, Mode::Identity, Mode::Install, Mode::Model] {
        let (gateway, script) = Script::new(mode, vec![model("final")]);
        let server = Server::gateway(gateway).await;
        let session = server.session().await;
        let body = command();
        response(server.post(&path(&session), &body), 202).await;
        finished(&session, &body).await;
        let before = snapshot(&server, &session).await;
        let counters = effects(&server, &script);
        let reply = accepted(&server, &session, &body).await;
        assert_eq!(reply["run"]["state"], "failed");
        assert_eq!(reply["run"]["result_recorded"], true);
        assert_eq!(snapshot(&server, &session).await, before);
        assert_eq!(effects(&server, &script), counters);
        server.finish().await;
    }
}

#[tokio::test]
async fn b3_explicit_reopen_interrupts_once_then_warm_reconciliation_is_read_only() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let body = command();
    public_accept(&session, &body).await;
    assert_eq!(
        accepted(&server, &session, &body).await["run"]["state"],
        "accepted"
    );
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
    let server = Server::start(temp, host, false).await;
    let sid = session.session_id();
    // The first explicit open may interrupt old work. This is not a warm-read mutation.
    let first = response(
        server.post(&format!("/v1/sessions/{sid}/runs/reconcile"), &body),
        200,
    )
    .await;
    assert_eq!(first["state"], "accepted");
    assert_eq!(first["run"]["state"], "interrupted");
    assert_eq!(first["run"]["result_recorded"], false);
    let session = server
        .host
        .storage()
        .open_session(sid.clone())
        .await
        .unwrap();
    let before = snapshot(&server, &session).await;
    assert_eq!(accepted(&server, &session, &body).await, first);
    assert_eq!(snapshot(&server, &session).await, before);
    assert_eq!(effects(&server, &script), [0; 7]);
    server.finish().await;
}

#[tokio::test]
async fn b3_controlled_absence_can_precede_an_already_accepted_http_task() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let body = command();
    let pause = Arc::new(Pause::default());
    session
        .test_hooks()
        .arm(Point::ReceiptLookupComplete, Action::Pause(pause.clone()));
    let request = server.post(&reconcile_path(&session), &body);
    let delayed = tokio::spawn(async move { response(request, 200).await });
    watchdog(pause.reached.notified()).await;
    response(server.post(&path(&session), &body), 202).await;
    watchdog(script.control.waiting.notified()).await;
    let counters = effects(&server, &script);
    let before = snapshot(&server, &session).await;
    pause.release.notify_one();
    assert_eq!(watchdog(delayed).await.unwrap(), absent());
    assert_eq!(
        accepted(&server, &session, &body).await["run"]["state"],
        "running"
    );
    assert_eq!(snapshot(&server, &session).await, before);
    assert_eq!(effects(&server, &script), counters);
    script.control.release.notify_one();
    finished(&session, &body).await;
    server.finish().await;
}

#[tokio::test]
async fn b3_unknown_commit_and_cleanup_warnings_keep_actual_acceptance_truth() {
    for (point, kind, status, has_receipt) in [
        (Point::BeforeCommit, StorageErrorKind::Io, 503, false),
        (
            Point::CommitStart,
            StorageErrorKind::CommitUnknown,
            503,
            false,
        ),
        (
            Point::AfterCommit,
            StorageErrorKind::CommitUnknown,
            202,
            true,
        ),
        (Point::WriteClosed, StorageErrorKind::Io, 202, true),
    ] {
        let (server, script) = Script::server().await;
        let session = server.session().await;
        let body = command();
        session
            .test_hooks()
            .arm_record(Record::Acceptance, point, Action::Fail(kind));
        let initial = response(server.post(&path(&session), &body), status).await;
        if point == Point::CommitStart {
            assert_eq!(initial["certainty"], "unknown");
        }
        if point == Point::BeforeCommit {
            assert_eq!(initial["certainty"], "not_committed");
        }
        if point == Point::WriteClosed {
            assert_eq!(initial["warning_code"], "storage.connection_cleanup_failed");
        }
        let before = snapshot(&server, &session).await;
        let counters = effects(&server, &script);
        if has_receipt {
            assert_eq!(
                accepted(&server, &session, &body).await["acceptance"],
                initial["receipt"]
            );
        } else {
            assert_eq!(
                response(server.post(&reconcile_path(&session), &body), 200).await,
                absent()
            );
        }
        assert_eq!(snapshot(&server, &session).await, before);
        assert_eq!(effects(&server, &script), counters);
        assert_eq!(count(&script.opens), 0);
        server.finish().await;
    }
}

#[tokio::test]
async fn b3_explicit_cancel_retains_accepted_receipt_and_current_cancelled_state() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let body = command();
    response(server.post(&path(&session), &body), 202).await;
    watchdog(script.control.waiting.notified()).await;
    response(
        server.post(
            &format!("{}/{}/cancel", path(&session), run(&body)),
            &json!({}),
        ),
        202,
    )
    .await;
    finished(&session, &body).await;
    let before = snapshot(&server, &session).await;
    let counters = effects(&server, &script);
    let reply = accepted(&server, &session, &body).await;
    assert_eq!(reply["run"]["state"], "cancelled_locally");
    assert_eq!(reply["run"]["result_recorded"], true);
    assert_eq!(snapshot(&server, &session).await, before);
    assert_eq!(effects(&server, &script), counters);
    server.finish().await;
}

#[tokio::test]
async fn b3_dropped_http_read_keeps_sql_owned_until_host_storage_drain() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let before = snapshot(&server, &session).await;
    let body = command().to_string();
    let pause = Arc::new(Pause::default());
    session
        .test_hooks()
        .arm(Point::Open, Action::Pause(pause.clone()));
    let mut socket = TcpStream::connect(server.address).await.unwrap();
    socket.write_all(format!("POST {} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", reconcile_path(&session), server.address, body.len()).as_bytes()).await.unwrap();
    watchdog(pause.reached.notified()).await;
    drop(socket);
    server.stop.cancel();
    let closing = server.host.begin_shutdown();
    let waiting = closing.wait();
    tokio::pin!(waiting);
    // Dropping the network waiter cannot abandon an already admitted storage operation.
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut waiting)
            .await
            .is_err()
    );
    pause.release.notify_one();
    assert!(matches!(
        &*watchdog(waiting).await,
        crate::service::ShutdownOutcome::Closed
    ));
    assert_eq!(snapshot(&server, &session).await, before);
    assert_eq!(effects(&server, &script), [0; 7]);
    server.finish().await;
}
