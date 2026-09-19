use super::*;

#[tokio::test]
async fn acceptance_waits_for_real_commit_and_observer_loss_never_cancels() {
    for drop_before_commit in [false, true] {
        let (server, script) = Script::server().await;
        let session = server.session().await;
        let body = command();
        let pause = Arc::new(Pause::default());
        session.test_hooks().arm_record(
            Record::Acceptance,
            Point::BeforeCommit,
            Action::Pause(pause.clone()),
        );
        let mut reader = sql(&server, &session, true).await;
        let mut socket = wire(&server, &session, &body).await;
        watchdog(pause.reached.notified()).await;
        // This connection reads the WAL directly, not the lock held by the paused writer.
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE run_id=?")
            .bind(run(&body).as_str())
            .fetch_one(&mut reader)
            .await
            .unwrap();
        let receipts: i64 =
            sqlx::query_scalar("SELECT count(*) FROM commands WHERE operation_id=?")
                .bind(operation(&body).as_str())
                .fetch_one(&mut reader)
                .await
                .unwrap();
        assert_eq!((rows, receipts, count(&script.opens)), (0, 0, 0));
        assert!(
            matches!(socket.try_read(&mut [0; 1]), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
        if drop_before_commit {
            drop(socket);
            watchdog(server.run_hooks.waiter_left.notified()).await;
            pause.release.notify_one();
        } else {
            pause.release.notify_one();
            let mut headers = vec![];
            watchdog(async {
                while !headers.ends_with(b"\r\n\r\n") {
                    headers.push(socket.read_u8().await.unwrap());
                }
            })
            .await;
            assert!(
                String::from_utf8(headers)
                    .unwrap()
                    .starts_with("HTTP/1.1 202")
            );
            drop(socket);
        }
        watchdog(script.control.waiting.notified()).await;
        let receipt = session
            .lookup_receipt(operation(&body))
            .await
            .unwrap()
            .unwrap();
        assert_eq!((receipt.first_sequence(), receipt.last_sequence()), (2, 3));
        assert_eq!(receipt.run_id(), Some(&run(&body)));
        let retry = response(server.post(&path(&session), &body), 202).await;
        assert_eq!(
            retry["receipt"],
            serde_json::to_value(dto::ReceiptView::from(&receipt)).unwrap()
        );
        let pending = response(
            server.get(&format!("{}/{}", path(&session), run(&body))),
            200,
        )
        .await;
        assert_eq!(pending["result_recorded"], false);
        assert_eq!(pending["state"], "running");
        assert_eq!(count(&script.opens), 1);
        assert_eq!(count(&script.control.closes), 0);
        script.control.release.notify_one();
        let run = finished(&session, &body).await;
        assert_eq!(
            run.result().unwrap().outcome,
            crate::run::RunOutcome::Completed
        );
        assert_eq!(count(&script.opens), 1);
        reader.close().await.unwrap();
        server.finish().await;
    }
}

#[tokio::test]
async fn absent_racers_with_different_snapshots_reconcile_once_without_redispatch() {
    for failure in ["snapshot", "preparation", "different_text"] {
        let (server, script) = Script::server().await;
        let session = server.session().await;
        let body = command();
        let pause = Arc::new(runs::test_hooks::Pause::default());
        let before = failure == "preparation";
        if before {
            *server.run_hooks.before.lock().unwrap() = Some(pause.clone());
        } else {
            *server.run_hooks.after.lock().unwrap() = Some(pause.clone());
        }
        let request = server.post(&path(&session), &body);
        let loser = tokio::spawn(async move { request.send().await.unwrap() });
        watchdog(pause.reached.notified()).await;
        assert!(
            session
                .lookup_receipt(operation(&body))
                .await
                .unwrap()
                .is_none()
        );
        std::fs::write(
            server.temp.path().join("workspace/AGENTS.md"),
            "changed snapshot",
        )
        .unwrap();
        let mut winner_body = body.clone();
        if failure == "different_text" {
            winner_body["text"] = json!("different raw bytes");
        }
        let winner = response(server.post(&path(&session), &winner_body), 202).await;
        watchdog(script.control.waiting.notified()).await;
        if before {
            std::fs::write(server.temp.path().join("workspace/AGENTS.md"), [0xff]).unwrap();
        }
        pause.release();
        let loser = watchdog(loser).await.unwrap();
        if failure == "different_text" {
            assert_eq!(loser.status(), 409);
            assert_eq!(
                loser.json::<Value>().await.unwrap()["code"],
                "storage.command_conflict"
            );
        } else {
            assert_eq!(loser.status(), 202);
            let loser: Value = loser.json().await.unwrap();
            assert_eq!(loser["receipt"], winner["receipt"]);
            assert_eq!(loser["duplicate"], true);
            assert_eq!(loser["notices"], json!([]));
        }
        assert_eq!(count(&server.run_hooks.readers), 2);
        assert_eq!(
            count(&server.run_hooks.dispatched),
            if before { 1 } else { 2 }
        );
        assert_eq!(count(&script.opens), 1);
        assert_eq!(script.control.inputs.lock().unwrap().len(), 1);
        script.control.release.notify_one();
        finished(&session, &body).await;
        let mut db = sql(&server, &session, true).await;
        let acceptances: i64 =
            sqlx::query_scalar("SELECT count(*) FROM events WHERE event_type='run.accepted'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(acceptances, 1);
        db.close().await.unwrap();
        server.finish().await;
    }
}

#[tokio::test]
async fn stale_replay_snapshot_is_reported_without_rebuild_or_dispatch_retry() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let body = command();
    let pause = Arc::new(Pause::default());
    session
        .test_hooks()
        .arm(Point::ReplayHeadCaptured, Action::Pause(pause.clone()));
    let request = server.post(&path(&session), &body);
    let task = tokio::spawn(async move { response(request, 409).await });
    watchdog(pause.reached.notified()).await;
    session
        .rename(OperationId::new(), "racing rename".into())
        .await
        .unwrap();
    pause.release.notify_one();
    let error = watchdog(task).await.unwrap();
    assert_eq!(error["code"], "storage.stale_history");
    assert_eq!(error["certainty"], "not_committed");
    assert_eq!(error["stage"], "acceptance");
    assert!(
        session
            .lookup_receipt(operation(&body))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(count(&server.run_hooks.dispatched), 1);
    assert_eq!(count(&script.opens), 0);
    server.finish().await;
}
