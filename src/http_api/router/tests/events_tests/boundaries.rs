use super::*;
use crate::storage::test_hooks::{Action, Point};

#[tokio::test]
async fn sse_commits_at_fixed_page_attach_and_caught_up_boundaries_have_no_gaps() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    for index in 0..69 {
        session
            .rename(OperationId::new(), format!("before {index}"))
            .await
            .unwrap();
    }
    let first = server.event_hooks.arm(1);
    let request = tokio::spawn(Reader::new(
        server.get(&format!("/v1/sessions/{sid}/events")),
    ));
    watchdog(first.reached.notified()).await;
    assert!(
        !request.is_finished(),
        "initial page validation precedes 200"
    );
    watchdog(session.rename(OperationId::new(), "after first page".into()))
        .await
        .unwrap();
    let second = server.event_hooks.arm(2);
    first.release.notify_one();
    let mut reader = watchdog(request).await.unwrap();
    watchdog(second.reached.notified()).await;
    watchdog(session.rename(OperationId::new(), "after later page".into()))
        .await
        .unwrap();
    let third = server.event_hooks.arm(3);
    second.release.notify_one();
    watchdog(third.reached.notified()).await;
    session
        .rename(OperationId::new(), "at attach".into())
        .await
        .unwrap();
    let live = server.event_hooks.arm(4);
    third.release.notify_one();
    watchdog(live.reached.notified()).await;
    session
        .rename(OperationId::new(), "after live page".into())
        .await
        .unwrap();
    let later = server.event_hooks.arm(5);
    live.release.notify_one();
    watchdog(later.reached.notified()).await;
    let empty = server.event_hooks.arm(6);
    later.release.notify_one();
    watchdog(empty.reached.notified()).await;
    session
        .rename(OperationId::new(), "after caught up".into())
        .await
        .unwrap();
    empty.release.notify_one();
    let stored = session.history_page(0, None, 128).await.unwrap();
    assert_eq!(stored.through_sequence(), 75);
    for record in stored.records() {
        assert_eq!(
            reader.event(sid, record.sequence()).await,
            serde_json::to_value(dto::EventView::from(record)).unwrap()
        );
    }
    let reads = server.event_hooks.reads.lock().unwrap().clone();
    assert_eq!(
        reads[..6]
            .iter()
            .map(|r| (r.after, r.through, r.head, r.count))
            .collect::<Vec<_>>(),
        vec![
            (0, None, 70, 32),
            (32, Some(70), 70, 32),
            (64, Some(70), 70, 6),
            (70, None, 73, 3),
            (73, None, 74, 1),
            (74, None, 74, 0),
        ]
    );
    assert!(reads.iter().all(|r| r.count <= 32));
    drop(reader);
    server.finish().await;
}

#[tokio::test]
async fn sse_reconnect_after_applied_cursor_deduplicates_and_detects_conflict() {
    // A pure reference deduplicator, not a browser or a server-side event cache.
    fn apply(
        seen: &mut std::collections::HashMap<(String, String), Value>,
        view: Value,
    ) -> Result<bool, ()> {
        let key = (
            view["session_id"].as_str().unwrap().to_owned(),
            view["sequence"].as_str().unwrap().to_owned(),
        );
        if let Some(prior) = seen.get(&key) {
            if prior != &view {
                return Err(());
            }
            return Ok(false);
        }
        seen.insert(key, view);
        Ok(true)
    }
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    let path = format!("/v1/sessions/{sid}/events");
    let history = response(server.get(&format!("/v1/sessions/{sid}/history")), 200).await;
    let mut seen = std::collections::HashMap::new();
    assert_eq!(apply(&mut seen, history["events"][0].clone()), Ok(true));
    session
        .rename(OperationId::new(), "between history and SSE".into())
        .await
        .unwrap();
    let mut first = Reader::new(
        server
            .get(&path)
            .header("Last-Event-ID", history["next_after"].as_str().unwrap()),
    )
    .await;
    let second = first.event(sid, 2).await;
    assert_eq!(apply(&mut seen, second.clone()), Ok(true));
    // Lost acknowledgment: reconnect from an older cursor and replay an applied event.
    drop(first);
    session
        .rename(OperationId::new(), "during disconnect".into())
        .await
        .unwrap();
    let mut replay = Reader::new(server.get(&format!("{path}?after={sid}:1"))).await;
    assert_eq!(apply(&mut seen, replay.event(sid, 2).await), Ok(false));
    assert_eq!(apply(&mut seen, replay.event(sid, 3).await), Ok(true));
    let mut conflict = second;
    conflict["data"]["title"] = json!("conflicting same sequence");
    assert_eq!(apply(&mut seen, conflict), Err(()));
    assert_eq!(seen.len(), 3);
    drop(replay);
    server.finish().await;
}

#[tokio::test]
async fn sse_later_storage_error_has_no_id_closes_and_reconnect_keeps_cursor() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    let pause = server.event_hooks.arm(2);
    let path = format!("/v1/sessions/{sid}/events");
    let mut reader = Reader::new(server.get(&path)).await;
    reader.event(sid, 1).await;
    watchdog(pause.reached.notified()).await;
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    pause.release.notify_one();
    let frame = reader.frame().await.unwrap();
    let expected = json!({"api_version":1,"code":"storage.io","stage":null,"certainty":"not_applicable","acceptance":null,"notices":[]});
    let lines: Vec<_> = frame.lines().collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0], "event: wi.error");
    assert_eq!(
        serde_json::from_str::<Value>(lines[1].strip_prefix("data: ").unwrap()).unwrap(),
        expected
    );
    assert_eq!(lines[2], "");
    assert!(reader.frame().await.is_none());
    drop(reader);
    session
        .rename(OperationId::new(), "after error".into())
        .await
        .unwrap();
    let mut reader = Reader::new(
        server
            .get(&path)
            .header("Last-Event-ID", format!("{sid}:1")),
    )
    .await;
    assert_eq!(reader.event(sid, 2).await["data"]["title"], "after error");
    drop(reader);
    server.finish().await;
}

#[tokio::test]
async fn sse_http_heartbeat_is_a_comment_without_an_id() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    let caught_up = server.event_hooks.arm(2);
    let mut reader = Reader::new(
        server
            .get(&format!("/v1/sessions/{sid}/events"))
            .timeout(Duration::from_secs(60)),
    )
    .await;
    reader.event(sid, 1).await;
    watchdog(caught_up.reached.notified()).await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(15)).await;
    tokio::time::resume();
    caught_up.release.notify_one();
    assert_eq!(reader.frame().await.unwrap(), ": keep-alive\n\n");
    assert_eq!(session.manifest().await.unwrap().head_sequence(), 1);
    drop(reader);
    server.finish().await;
}

#[tokio::test]
async fn sse_network_close_has_no_cursor_or_run_finished_event() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    let mut reader = Reader::new(server.get(&format!("/v1/sessions/{sid}/events"))).await;
    reader.event(sid, 1).await;
    watchdog(server.event_hooks.wait(2)).await;
    server.stop.cancel();
    if let Some(frame) = reader.frame().await {
        assert_eq!(
            frame,
            "event: wi.closed\ndata: {\"api_version\":1,\"reason\":\"shutdown\"}\n\n"
        );
        assert!(reader.frame().await.is_none());
    }
    assert_eq!(session.manifest().await.unwrap().head_sequence(), 1);
    drop(reader);
    server.finish().await;
}
