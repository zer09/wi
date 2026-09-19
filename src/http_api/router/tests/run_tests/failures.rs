use super::*;

#[tokio::test]
async fn preacceptance_gateway_failure_is_safe_and_never_opens() {
    let (gateway, script) = Script::new(Mode::Preflight, vec![]);
    let server = Server::gateway(gateway).await;
    let session = server.session().await;
    let body = command();
    let error = response(server.post(&path(&session), &body), 422).await;
    assert_eq!(error["code"], "unsupported_feature");
    assert_eq!(error["stage"], "preflight");
    assert_eq!(error["certainty"], "not_applicable");
    assert_eq!(error["acceptance"], Value::Null);
    assert!(
        session
            .lookup_receipt(operation(&body))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(count(&script.opens), 0);
    assert_eq!(count(&server.run_hooks.dispatched), 1);
    server.finish().await;
}

#[tokio::test]
async fn accepted_open_identity_install_and_model_failures_are_still_202() {
    for mode in [Mode::Open, Mode::Identity, Mode::Install, Mode::Model] {
        let (gateway, script) = Script::new(mode, vec![model("final")]);
        let server = Server::gateway(gateway).await;
        let session = server.session().await;
        let body = command();
        let accepted = response(server.post(&path(&session), &body), 202).await;
        assert_eq!(accepted["duplicate"], false);
        let stored = finished(&session, &body).await;
        assert!(matches!(
            stored.result().unwrap().outcome,
            crate::run::RunOutcome::Failed { .. }
        ));
        let observed = response(
            server.get(&format!("{}/{}", path(&session), run(&body))),
            200,
        )
        .await;
        assert_eq!(observed["state"], "failed");
        assert_eq!(observed["result_recorded"], true);
        assert_eq!(accepted["receipt"]["operation_id"], body["operation_id"]);
        assert_eq!(accepted["receipt"]["run_id"], body["run_id"]);
        assert_eq!(accepted["receipt"]["last_sequence"], "3");
        assert_eq!(count(&script.opens), 1);
        server.finish().await;
    }
}

#[tokio::test]
async fn commit_failures_preserve_actual_certainty_and_known_cleanup_acceptance() {
    for (point, kind, status, certainty) in [
        (
            Point::BeforeCommit,
            StorageErrorKind::Io,
            503,
            "not_committed",
        ),
        (
            Point::CommitStart,
            StorageErrorKind::CommitUnknown,
            503,
            "unknown",
        ),
        (Point::AfterCommit, StorageErrorKind::CommitUnknown, 202, ""),
        (Point::WriteClosed, StorageErrorKind::Io, 202, ""),
    ] {
        let (server, script) = Script::server().await;
        let session = server.session().await;
        let body = command();
        session
            .test_hooks()
            .arm_record(Record::Acceptance, point, Action::Fail(kind));
        let reply = response(server.post(&path(&session), &body), status).await;
        let receipt = session.lookup_receipt(operation(&body)).await.unwrap();
        if status == 202 {
            assert_eq!(
                reply["receipt"],
                serde_json::to_value(dto::ReceiptView::from(receipt.as_ref().unwrap())).unwrap()
            );
            if point == Point::AfterCommit {
                assert_eq!(reply["duplicate"], true);
                assert_eq!(reply["notices"], json!([]));
            } else {
                assert_eq!(reply["duplicate"], false);
                assert_eq!(reply["warning_code"], "storage.connection_cleanup_failed");
            }
        } else {
            assert!(receipt.is_none());
            assert_eq!(reply["certainty"], certainty);
            assert_eq!(reply["stage"], "acceptance");
            assert_eq!(reply["acceptance"], Value::Null);
        }
        assert_eq!(count(&script.opens), 0);
        assert_eq!(count(&server.run_hooks.dispatched), 1);
        server.finish().await;
    }
}

#[tokio::test]
async fn accepted_recording_failure_does_not_revoke_receipt_or_fabricate_result() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let body = command();
    session.test_hooks().arm_record(
        Record::RunStarted,
        Point::BeforeCommit,
        Action::Fail(StorageErrorKind::Io),
    );
    let accepted = response(server.post(&path(&session), &body), 202).await;
    assert_eq!(accepted["receipt"]["last_sequence"], "3");
    let duplicate = response(server.post(&path(&session), &body), 202).await;
    assert_eq!(accepted["receipt"], duplicate["receipt"]);
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(count(&script.opens), 0);
    let observed = response(
        server.get(&format!("{}/{}", path(&session), run(&body))),
        200,
    )
    .await;
    assert_eq!(observed["result_recorded"], false);
    server.finish().await;
}

#[tokio::test]
async fn closed_owner_during_preparation_is_reported_without_dispatch() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let pause = Arc::new(runs::test_hooks::Pause::default());
    *server.run_hooks.after.lock().unwrap() = Some(pause.clone());
    let request = server.post(&path(&session), &command());
    let task = tokio::spawn(async move { response(request, 503).await });
    watchdog(pause.reached.notified()).await;
    assert!(matches!(
        &*watchdog(server.host.begin_shutdown().wait()).await,
        crate::service::ShutdownOutcome::Closed
    ));
    pause.release();
    let reply = watchdog(task).await.unwrap();
    assert_eq!(reply["code"], "api.closed");
    assert_eq!(count(&script.opens), 0);
    server.finish().await;
}

#[tokio::test]
async fn worker_loss_before_acceptance_is_unknown_and_never_a_terminal_result() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let body = command();
    let pause = Arc::new(runs::test_hooks::Pause::default());
    *server.run_hooks.after.lock().unwrap() = Some(pause.clone());
    let request = server.post(&path(&session), &body);
    let task = tokio::spawn(async move { response(request, 503).await });
    watchdog(pause.reached.notified()).await;
    // The handler's receipt read is complete. The next lookup is inside the host worker.
    session
        .test_hooks()
        .arm(Point::ReceiptLookupComplete, Action::Panic);
    pause.release();
    let reply = watchdog(task).await.unwrap();
    assert_eq!(reply["code"], "api.worker_lost");
    assert_eq!(reply["certainty"], "unknown");
    assert_eq!(reply["acceptance"], Value::Null);
    assert_eq!(count(&script.opens), 0);
    let mut reader = sql(&server, &session, true).await;
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE run_id=?")
        .bind(run(&body).as_str())
        .fetch_one(&mut reader)
        .await
        .unwrap();
    assert_eq!(rows, 0);
    reader.close().await.unwrap();
    let (_temp, host) = server.stop_http().await;
    assert!(matches!(
        &*watchdog(host.begin_shutdown().wait()).await,
        crate::service::ShutdownOutcome::Incomplete {
            worker_lost: true,
            ..
        }
    ));
}
