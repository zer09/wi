use super::*;
use crate::storage::SessionStore;
use futures_util::StreamExt;

async fn fixture() -> (tempfile::TempDir, SessionStore, SessionHandle) {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("data")).await.unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "title".into(), None).unwrap())
        .await
        .unwrap();
    let session = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    (temp, store, session)
}
async fn wait<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .expect("SSE test watchdog")
}

#[tokio::test]
async fn body_backpressure_holds_only_one_page_and_no_storage_lock() {
    let (_temp, store, session) = fixture().await;
    for index in 0..70 {
        session
            .rename(OperationId::new(), format!("title {index}"))
            .await
            .unwrap();
    }
    let page = session.history_page(0, None, PAGE_SIZE).await.unwrap();
    let hooks = Arc::new(test_hooks::Hooks::default());
    hooks.page(0, None, &page).await;
    let mut body = stream_response(
        session.clone(),
        page,
        0,
        CancellationToken::new(),
        hooks.clone(),
    )
    .into_body()
    .into_data_stream();
    assert!(body.next().await.unwrap().is_ok());
    // No body demand means no next page, even after more than a polling interval.
    tokio::time::sleep(POLL_INTERVAL + Duration::from_millis(25)).await;
    wait(session.rename(OperationId::new(), "writer still progresses".into()))
        .await
        .unwrap();
    assert_eq!(hooks.reads.lock().unwrap().len(), 1);
    for _ in 1..32 {
        assert!(body.next().await.unwrap().is_ok());
    }
    assert_eq!(hooks.reads.lock().unwrap().len(), 1);
    assert!(body.next().await.unwrap().is_ok());
    assert_eq!(
        hooks.reads.lock().unwrap()[1],
        test_hooks::Read {
            after: 32,
            through: Some(71),
            head: 71,
            count: 32
        }
    );
    drop(body);
    wait(store.close()).await.unwrap();
}

#[tokio::test]
async fn caught_up_poll_waits_250ms_and_heartbeat_has_no_id() {
    let (_temp, store, session) = fixture().await;
    let page = session.history_page(1, None, PAGE_SIZE).await.unwrap();
    let hooks = Arc::new(test_hooks::Hooks::default());
    hooks.page(1, None, &page).await;
    let caught_up = hooks.arm(2);
    let mut body = stream_response(
        session.clone(),
        page,
        1,
        CancellationToken::new(),
        hooks.clone(),
    )
    .into_body()
    .into_data_stream();
    let task = tokio::spawn(async move {
        let frame = body.next().await.unwrap().unwrap();
        (body, frame)
    });
    wait(caught_up.reached.notified()).await;
    let next = hooks.arm(3);
    tokio::time::pause();
    caught_up.release.notify_one();
    tokio::task::yield_now().await;
    tokio::time::advance(POLL_INTERVAL - Duration::from_millis(1)).await;
    assert_eq!(hooks.reads.lock().unwrap().len(), 2);
    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::time::resume();
    wait(next.reached.notified()).await;
    assert!(!task.is_finished());
    // Advance the heartbeat clock only after the real read has released its connection.
    tokio::time::pause();
    tokio::time::advance(HEARTBEAT_INTERVAL).await;
    next.release.notify_one();
    let (body, frame) = wait(task).await.unwrap();
    assert_eq!(frame.as_ref(), b": keep-alive\n\n");
    tokio::time::resume();
    drop(body);
    wait(store.close()).await.unwrap();
}
