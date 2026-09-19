use super::*;

#[tokio::test]
async fn shutdown_drains_stalled_body_idle_sse_and_idle_socket() {
    let server = Server::new().await;
    let session = session(&server.host).await;
    let sid = session.session_id().clone();
    let mut body = server.wire("POST /v1/sessions HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue").await;
    // Receiving 100 proves the authenticated handler actually polled this unfinished body.
    assert!(headers(&mut body).await.starts_with("HTTP/1.1 100"));
    let mut sse = server
        .wire(&format!(
            "GET /v1/sessions/{sid}/events?after={sid}:1 HTTP/1.1"
        ))
        .await;
    assert!(headers(&mut sse).await.starts_with("HTTP/1.1 200"));
    // Clear earlier accepted notifications before checking the entirely idle connection.
    let _ = server.hooks.accepted.notified().now_or_never();
    let mut idle = TcpStream::connect(server.address).await.unwrap();
    watchdog(server.hooks.accepted.notified()).await;
    let root = server.temp.path().join("root");
    let (outcome, _temp) = server.finish().await;
    closed(&outcome);
    for socket in [&mut body, &mut sse, &mut idle] {
        let mut bytes = Vec::new();
        let _ = watchdog(socket.read_to_end(&mut bytes)).await;
    }
    let reopened = SessionStore::open(root).await.unwrap();
    assert_eq!(
        reopened
            .list_sessions(None, 10)
            .await
            .unwrap()
            .sessions()
            .len(),
        1
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn shutdown_wakes_nonreading_large_response_without_client_drop() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
    // Small socket buffers force backpressure without a large database fixture.
    let listener = tokio::net::TcpSocket::new_v4().unwrap();
    listener.set_send_buffer_size(4096).unwrap();
    listener.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let server = Server::start_on(temp, host, listener.listen(8).unwrap()).await;
    let session = session(&server.host).await;
    let title = "x".repeat(256 * 1024);
    session
        .rename(OperationId::new(), title.clone())
        .await
        .unwrap();
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(4096).unwrap();
    let mut slow = socket.connect(server.address).await.unwrap();
    slow.write_all(format!("GET /v1/sessions/{}/history?limit=128 HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {TOKEN}\r\n\r\n", session.session_id(), server.address).as_bytes()).await.unwrap();
    assert!(headers(&mut slow).await.starts_with("HTTP/1.1 200"));
    assert!(
        tokio::time::timeout(
            Duration::from_secs(20),
            server.hooks.write_pending.notified()
        )
        .await
        .is_ok(),
        "pending response write was not reported after {} bytes",
        server.hooks.written.load(Ordering::SeqCst)
    );
    let written = server.hooks.written.load(Ordering::SeqCst);
    assert!(written > 0 && written < title.len());
    let (outcome, _temp) = server.finish().await;
    closed(&outcome);
    // The server returned without waiting for the client to read or close its TCP socket.
    drop(slow);
}

#[tokio::test]
async fn serving_error_and_unwind_initiate_shutdown_with_live_handler_clones() {
    for (fault, expected) in [
        (Fault::Accept, ServeError::Accept),
        (Fault::Panic, ServeError::Panicked),
    ] {
        let server = Server::new().await;
        let session = session(&server.host).await;
        let mut stream = server
            .wire(&format!(
                "GET /v1/sessions/{}/events HTTP/1.1",
                session.session_id()
            ))
            .await;
        assert!(headers(&mut stream).await.starts_with("HTTP/1.1 200"));
        let handler_clone = server.host.clone();
        let client = handler_clone.client();
        server.hooks.fail(fault);
        let outcome = watchdog(server.task).await.unwrap();
        assert_eq!(outcome.http, Err(expected));
        assert_eq!(outcome.local_addr, Some(server.address));
        assert!(matches!(&*outcome.shutdown, ShutdownOutcome::Closed));
        assert!(Arc::ptr_eq(
            &outcome.shutdown,
            &handler_clone.begin_shutdown().wait().await
        ));
        assert_eq!(
            client.cancel(session.session_id(), &RunId::new()),
            CancelDisposition::Closed
        );
        let mut bytes = Vec::new();
        let _ = watchdog(stream.read_to_end(&mut bytes)).await;
    }
}

#[tokio::test]
async fn dropping_unpolled_public_future_initiates_shutdown() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
    let client = host.client();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let future = serve(listener, host, config(&temp), CancellationToken::new());
    drop(future);
    assert_eq!(
        client.cancel(&crate::storage::ApplicationSessionId::new(), &RunId::new()),
        CancelDisposition::Closed
    );
    // This assertion proves initiation only. No clean-drain claim follows from Drop.
}
