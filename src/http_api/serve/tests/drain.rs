use super::*;
use crate::{
    execution::{
        PersistentRunResult,
        tests::{
            Barrier,
            in_session::fixture::{Fixture, Plan},
        },
    },
    run::RunOutcome,
    service::{RunCompletion, RunHostError},
    storage::test_hooks::{Pause, Record},
};

#[tokio::test]
async fn shutdown_awaits_run_sql_before_storage_close() {
    for record in [Record::Acceptance, Record::FinalResult] {
        let fixture = Fixture::new().await;
        let model = Arc::new(Barrier::default());
        let task = fixture.task(
            "serve shutdown drain",
            Plan {
                response_pause: Some(model.clone()),
                ..Default::default()
            },
        );
        let host = RunHost::new(fixture.store, task.gateway.clone()).unwrap();
        let mut server = Server::start(fixture.temp, host).await;
        let independent = session(&server.host).await;
        let sql = Arc::new(Pause::default());
        fixture.session.test_hooks().arm_record(
            record,
            Point::BeforeCommit,
            Action::Pause(sql.clone()),
        );
        let ticket = server
            .host
            .client()
            .submit(
                fixture.session.session_id().clone(),
                task.request(),
                task.tools.fresh_scope(),
            )
            .unwrap();
        if record == Record::Acceptance {
            watchdog(sql.reached.notified()).await;
            assert!(futures_util::poll!(Box::pin(ticket.accepted())).is_pending());
            assert_eq!(task.observed.records.opens.load(Ordering::SeqCst), 0);
        } else {
            watchdog(model.reached.notified()).await;
            assert!(ticket.accepted().await.is_ok());
        }
        let mut idle = TcpStream::connect(server.address).await.unwrap();
        watchdog(server.hooks.accepted.notified()).await;
        server.stop.cancel();
        if record == Record::FinalResult {
            watchdog(sql.reached.notified()).await;
        }
        watchdog(async {
            while server
                .host
                .client()
                .cancel(ticket.session_id(), ticket.run_id())
                != CancelDisposition::Closed
            {
                tokio::task::yield_now().await;
            }
        })
        .await;
        let original = server.host.begin_shutdown();
        let mut bytes = Vec::new();
        let _ = watchdog(idle.read_to_end(&mut bytes)).await;
        assert!(bytes.is_empty());
        // Network waiters have ended, but the real host and SQL still own their work.
        assert!(futures_util::poll!(&mut server.task).is_pending());
        assert!(futures_util::poll!(Box::pin(original.wait())).is_pending());
        assert!(futures_util::poll!(Box::pin(ticket.completion())).is_pending());
        assert_eq!(
            server
                .host
                .client()
                .submit(
                    independent.session_id().clone(),
                    task.request(),
                    task.tools.fresh_scope(),
                )
                .unwrap_err(),
            RunHostError::Closed
        );
        watchdog(independent.rename(OperationId::new(), "writable during run drain".into()))
            .await
            .unwrap();
        sql.release.notify_one();
        let completion = watchdog(ticket.completion()).await;
        let RunCompletion::Execution(Ok(PersistentRunResult::Executed { result, .. })) =
            &*completion
        else {
            panic!("expected a drained run: {completion:?}")
        };
        assert_eq!(result.outcome, RunOutcome::CancelledLocally);
        assert!(result.events_complete && result.sink_error.is_none());
        let acceptance = ticket.accepted().await.unwrap();
        let (outcome, temp) = server.finish().await;
        closed(&outcome);
        assert!(Arc::ptr_eq(&outcome.shutdown, &original.wait().await));
        assert_eq!(
            task.observed.records.closes.load(Ordering::SeqCst),
            usize::from(record == Record::FinalResult)
        );
        let reopened = SessionStore::open(temp.path().join("root")).await.unwrap();
        let saved = reopened
            .open_session(ticket.session_id().clone())
            .await
            .unwrap();
        assert_eq!(
            saved
                .lookup_receipt(ticket.operation_id().clone())
                .await
                .unwrap()
                .as_ref(),
            Some(acceptance.receipt())
        );
        assert_eq!(
            saved
                .run_record(ticket.run_id().clone())
                .await
                .unwrap()
                .unwrap()
                .result()
                .unwrap()
                .outcome,
            RunOutcome::CancelledLocally
        );
        reopened.close().await.unwrap();
    }
}

#[tokio::test]
async fn shutdown_awaits_admitted_sql_after_http_waiter_closes() {
    let mut server = Server::new().await;
    let session = session(&server.host).await;
    let operation = OperationId::new();
    let opening = Arc::new(Pause::default());
    let sql = Arc::new(Pause::default());
    session
        .test_hooks()
        .arm(Point::BeforeCommit, Action::Pause(opening.clone()));
    let body =
        serde_json::json!({"operation_id": operation, "title": "committed after HTTP close"})
            .to_string();
    let mut socket = server.wire(&format!(
        "POST /v1/sessions/{}/rename HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: {}",
        session.session_id(), body.len(),
    )).await;
    socket.write_all(body.as_bytes()).await.unwrap();
    // Session-open maintenance commits before rename; pause the command, not that read.
    watchdog(opening.reached.notified()).await;
    session
        .test_hooks()
        .arm(Point::BeforeCommit, Action::Pause(sql.clone()));
    opening.release.notify_one();
    watchdog(sql.reached.notified()).await;
    server.stop.cancel();
    let mut bytes = Vec::new();
    let _ = watchdog(socket.read_to_end(&mut bytes)).await;
    assert!(futures_util::poll!(&mut server.task).is_pending());
    let original = server.host.begin_shutdown();
    assert!(futures_util::poll!(Box::pin(original.wait())).is_pending());
    sql.release.notify_one();
    let (outcome, temp) = server.finish().await;
    closed(&outcome);
    assert!(Arc::ptr_eq(&outcome.shutdown, &original.wait().await));
    let reopened = SessionStore::open(temp.path().join("root")).await.unwrap();
    let saved = reopened
        .open_session(session.session_id().clone())
        .await
        .unwrap();
    let receipt = saved.lookup_receipt(operation).await.unwrap().unwrap();
    assert_eq!((receipt.first_sequence(), receipt.last_sequence()), (2, 2));
    assert_eq!(
        saved.manifest().await.unwrap().title(),
        "committed after HTTP close"
    );
    reopened.close().await.unwrap();
}
