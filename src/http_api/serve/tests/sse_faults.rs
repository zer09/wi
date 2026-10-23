use super::*;
use crate::http_api::{
    event_test_hooks::{FaultHook, FaultMode, Phase, Target},
    serve_with_event_faults,
};

async fn open(
    address: SocketAddr,
    sid: &crate::storage::ApplicationSessionId,
) -> reqwest::Response {
    let response = watchdog(
        http()
            .get(format!("http://{address}/v1/sessions/{sid}/events"))
            .bearer_auth(TOKEN)
            .send(),
    )
    .await
    .unwrap_or_else(|_| panic!("SSE request failed"));
    assert!(response.status() == 200);
    assert!(response.headers()["content-type"] == "text/event-stream");
    assert!(response.headers()["cache-control"] == "no-store");
    assert!(response.headers()["x-content-type-options"] == "nosniff");
    response
}

async fn receive(response: &mut reqwest::Response, length: Option<usize>) -> Vec<u8> {
    watchdog(async {
        let mut bytes = Vec::new();
        loop {
            let chunk = response
                .chunk()
                .await
                .unwrap_or_else(|_| panic!("SSE read failed"))
                .expect("SSE ended before selected frame");
            bytes.extend_from_slice(&chunk);
            if length.is_some_and(|n| bytes.len() >= n)
                || (length.is_none() && bytes.ends_with(b"\n\n"))
            {
                return bytes;
            }
        }
    })
    .await
}

#[tokio::test]
async fn injected_faults_use_real_http_late_arm_and_leave_other_subscription_intact() {
    for mode in [FaultMode::PrefixThenError, FaultMode::WholeThenError] {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("root")).await.unwrap();
        let host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
        let session = session(&host).await;
        let sid = session.session_id().clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let stop = CancellationToken::new();
        let hook = Arc::new(FaultHook::default());
        let task = tokio::spawn(serve_with_event_faults(
            listener,
            host,
            config(&temp),
            stop.clone(),
            hook.clone(),
        ));
        let mut selected = open(address, &sid).await;
        let first = receive(&mut selected, None).await;
        let subscriptions = hook.subscriptions();
        assert_eq!(subscriptions.len(), 1);
        let ordinal = subscriptions[0].ordinal;
        let mut other = open(address, &sid).await;
        assert!(receive(&mut other, None).await == first);
        let plan = hook
            .arm(
                Target {
                    session_id: sid,
                    subscription: ordinal,
                    sequence: 2,
                },
                mode,
            )
            .unwrap();
        watchdog(session.rename(OperationId::new(), "synthetic 雪\nline".into()))
            .await
            .unwrap();
        let hit = watchdog(plan.reached()).await.unwrap();
        let actual = receive(&mut selected, Some(hit.yielded_bytes)).await;
        let expected = receive(&mut other, None).await;
        assert_eq!(actual.len(), hit.yielded_bytes);
        assert_eq!(expected.len(), hit.frame_bytes);
        match mode {
            FaultMode::PrefixThenError => {
                assert!(!actual.is_empty() && actual.len() < expected.len() - 2);
                assert!(expected.starts_with(&actual));
                assert!(!actual.windows(2).any(|s| s == b"\n\n"));
            }
            FaultMode::WholeThenError => assert!(actual == expected),
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(50), selected.chunk())
                .await
                .is_err()
        );
        assert_eq!(plan.phase(), Phase::Reached);
        hook.release(&plan).unwrap();
        assert!(watchdog(selected.chunk()).await.is_err());
        assert_eq!(watchdog(plan.retired()).await, Phase::Completed);
        watchdog(hook.wait_subscriptions(1)).await;
        // The second subscription keeps receiving actual committed output after the fault.
        watchdog(session.rename(OperationId::new(), "still writable".into()))
            .await
            .unwrap();
        assert!(!receive(&mut other, None).await.is_empty());
        drop(selected);
        drop(other);
        stop.cancel();
        closed(&watchdog(task).await.unwrap());
        watchdog(hook.wait_subscriptions(0)).await;
    }
}

#[tokio::test]
async fn injected_paused_body_retires_on_client_loss_or_owner_shutdown_without_release() {
    for shutdown in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("root")).await.unwrap();
        let host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
        let session = session(&host).await;
        let sid = session.session_id().clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let stop = CancellationToken::new();
        let hook = Arc::new(FaultHook::default());
        let task = tokio::spawn(serve_with_event_faults(
            listener,
            host,
            config(&temp),
            stop.clone(),
            hook.clone(),
        ));
        let mut response = open(address, &sid).await;
        receive(&mut response, None).await;
        let ordinal = hook.subscriptions()[0].ordinal;
        let plan = hook
            .arm(
                Target {
                    session_id: sid,
                    subscription: ordinal,
                    sequence: 2,
                },
                FaultMode::WholeThenError,
            )
            .unwrap();
        session
            .rename(OperationId::new(), "pause".into())
            .await
            .unwrap();
        watchdog(plan.reached()).await.unwrap();
        receive(&mut response, None).await;
        if shutdown {
            stop.cancel();
            // Keep the client body alive. The wrapper must wake from OwnerGuard's network token.
            closed(&watchdog(task).await.unwrap());
            assert_eq!(watchdog(plan.retired()).await, Phase::Aborted);
            drop(response);
        } else {
            drop(response);
            assert_eq!(watchdog(plan.retired()).await, Phase::Aborted);
            assert!(session.history_page(0, None, 32).await.is_ok());
            stop.cancel();
            closed(&watchdog(task).await.unwrap());
        }
        watchdog(hook.wait_subscriptions(0)).await;
        assert!(hook.release(&plan).is_err());
    }
}

#[tokio::test]
async fn injected_unpolled_serve_keeps_owner_drop_lifecycle() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
    let client = host.client();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let future = serve_with_event_faults(
        listener,
        host,
        config(&temp),
        CancellationToken::new(),
        Arc::default(),
    );
    drop(future);
    assert_eq!(
        client.cancel(&crate::storage::ApplicationSessionId::new(), &RunId::new()),
        CancelDisposition::Closed
    );
    watchdog(async {
        loop {
            match SessionStore::open(temp.path().join("root")).await {
                Ok(store) => {
                    store.close().await.unwrap();
                    break;
                }
                Err(error) => {
                    assert_eq!(error.kind(), StorageErrorKind::Busy);
                    tokio::task::yield_now().await;
                }
            }
        }
    })
    .await;
}
