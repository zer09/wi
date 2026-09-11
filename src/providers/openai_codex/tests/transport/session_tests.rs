use super::*;

#[tokio::test]
async fn busy_and_close_work_while_output_is_being_read() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let _ = incoming(&mut socket).await;
        send(
            &mut socket,
            json!({"type":"response.created","response":{"id":"r1"}}),
        )
        .await;
        let _ = socket.next().await;
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    let mut session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    let _ = session
        .control
        .generate(vec![InputItem::user("run")])
        .await
        .unwrap();
    let _ = session.events.next().await.unwrap();
    assert!(matches!(
        session
            .control
            .generate(vec![InputItem::user("another")])
            .await,
        Err(GatewayError::Busy)
    ));
    assert!(matches!(
        session.control.steer("change".into()).await,
        Err(GatewayError::UnsupportedFeature(_))
    ));
    session.control.close();
    let event = timeout(Duration::from_secs(2), session.events.next())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        event.event,
        ProviderEvent::RequestFailed {
            upstream_outcome: UpstreamOutcome::Unknown,
            ..
        }
    ));
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn disconnected_partial_response_is_failure_not_completed_and_is_not_retried() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let _ = incoming(&mut socket).await;
        send(
            &mut socket,
            json!({"type":"response.created","response":{"id":"r1"}}),
        )
        .await;
        send(&mut socket, json!({"type":"response.output_text.delta","item_id":"m1","output_index":0,"delta":"partial"})).await;
        socket.close(None).await.unwrap();
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    let mut session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    session
        .control
        .generate(vec![InputItem::user("run")])
        .await
        .unwrap();
    let mut failed = false;
    while let Some(e) = timeout(Duration::from_secs(3), session.events.next())
        .await
        .unwrap()
    {
        assert!(!matches!(e.event, ProviderEvent::ResponseFinished { .. }));
        if matches!(
            e.event,
            ProviderEvent::RequestFailed {
                upstream_outcome: UpstreamOutcome::Unknown,
                ..
            }
        ) {
            failed = true;
        }
    }
    assert!(failed);
    assert!(matches!(
        session
            .control
            .generate(vec![InputItem::user("retry")])
            .await,
        Err(GatewayError::SessionClosed)
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn dropping_unpolled_events_releases_session() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let _ = socket.next().await;
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    let session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    let control = session.control.clone();
    drop(session);
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        control.generate(vec![InputItem::user("x")]).await,
        Err(GatewayError::SessionClosed)
    ));
}

#[tokio::test]
async fn slow_event_consumer_gets_terminal_failure_without_unbounded_buffering() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let _ = incoming(&mut socket).await;
        send(
            &mut socket,
            json!({"type":"response.created","response":{"id":"r1"}}),
        )
        .await;
        for _ in 0..100 {
            let frame = json!({"type":"response.output_text.delta","item_id":"m1","output_index":0,"content_index":0,"delta":"x"});
            if socket
                .send(Message::Text(frame.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = socket.next().await;
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    let mut session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    session
        .control
        .generate(vec![InputItem::user("run")])
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut failure = false;
    let mut count = 0;
    while let Some(e) = timeout(Duration::from_secs(3), session.events.next())
        .await
        .unwrap()
    {
        count += 1;
        if matches!(&e.event, ProviderEvent::RequestFailed { code, .. } if code == "slow_consumer")
        {
            failure = true;
        }
    }
    assert!(failure);
    assert!(count <= 65);
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn sse_redirect_is_not_followed_and_no_secret_body_is_exposed() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        let _ = read_http(&mut tcp).await;
        tcp.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://example.invalid/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::Sse, address);
    let mut opts = SessionOptions::new("test");
    opts.transport = Transport::Sse;
    let mut session = provider.open_session(opts).await.unwrap();
    session
        .control
        .generate(vec![InputItem::user("hello")])
        .await
        .unwrap();
    let event = session.events.next().await.unwrap();
    assert!(
        matches!(&event.event, ProviderEvent::RequestFailed { code, message, .. } if code == "http_error" && !message.contains("synthetic-oauth-token"))
    );
    server.await.unwrap();
}

#[tokio::test]
async fn idle_timeout_is_explicit_and_does_not_replay_request() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let _ = incoming(&mut socket).await;
        let _ = socket.next().await;
    });
    let mut provider =
        OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    provider.timeouts.idle = Duration::from_millis(50);
    let mut session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    session
        .control
        .generate(vec![InputItem::user("run")])
        .await
        .unwrap();
    let event = timeout(Duration::from_secs(2), session.events.next())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(&event.event, ProviderEvent::RequestFailed { code, upstream_outcome:UpstreamOutcome::Unknown, .. } if code == "timeout")
    );
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn websocket_responds_to_ping_while_idle() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (pong_tx, pong_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        socket
            .send(Message::Ping(vec![1, 2, 3].into()))
            .await
            .unwrap();
        let frame = timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(frame, Message::Pong(_)));
        let _ = pong_tx.send(());
        let _ = socket.next().await;
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    let session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    timeout(Duration::from_secs(2), pong_rx)
        .await
        .unwrap()
        .unwrap();
    session.control.close();
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}
