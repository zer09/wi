use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;

#[tokio::test]
async fn cancellation_after_sse_dispatch_is_unknown_without_retry() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let dispatched = Arc::new(Notify::new());
    let received = dispatched.clone();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        let _ = read_http(&mut tcp).await;
        received.notify_one();
        let mut byte = [0];
        assert_eq!(tcp.read(&mut byte).await.unwrap(), 0);
        assert!(
            timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::Sse, address);
    let mut opts = SessionOptions::new("test");
    opts.transport = Transport::Sse;
    let mut session = provider.open_session(opts).await.unwrap();
    session
        .control
        .generate(vec![InputItem::user("synthetic")])
        .await
        .unwrap();
    timeout(Duration::from_secs(2), dispatched.notified())
        .await
        .unwrap();
    session.control.close();
    let event = timeout(Duration::from_secs(2), session.events.next())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(event.event, ProviderEvent::RequestFailed {
        code, upstream_outcome: UpstreamOutcome::Unknown, ..
    } if code == "locally_cancelled"));
    timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn sse_admitted_http_failures_preserve_safe_status_categories() {
    for (status, expected) in [
        (401, "unauthorized"),
        (403, "forbidden"),
        (429, "rate_limited"),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let _ = read_http(&mut tcp).await;
            let body = "private-native-error-token";
            tcp.write_all(format!("HTTP/1.1 {status} Rejected\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::Sse, address);
        let mut opts = SessionOptions::new("test");
        opts.transport = Transport::Sse;
        let mut session = provider.open_session(opts).await.unwrap();
        session
            .control
            .generate(vec![InputItem::user("synthetic")])
            .await
            .unwrap();
        let event = timeout(Duration::from_secs(2), session.events.next())
            .await
            .unwrap()
            .unwrap();
        match event.event {
            ProviderEvent::RequestFailed {
                code,
                message,
                upstream_outcome,
            } => {
                assert_eq!(code, expected);
                assert_eq!(upstream_outcome, UpstreamOutcome::Unknown);
                assert!(!message.contains("private"));
            }
            _ => panic!("expected a request failure"),
        }
        timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }
}

struct ReloadAuth {
    loads: AtomicUsize,
    mode: u8,
    entered: Notify,
}
#[async_trait]
impl CredentialSource for ReloadAuth {
    async fn load(&self) -> Result<SubscriptionCredentials> {
        if self.loads.fetch_add(1, Ordering::SeqCst) == 0 {
            return FakeAuth.load().await;
        }
        self.entered.notify_one();
        match self.mode {
            0 => Err(GatewayError::AuthExpired),
            1 => SubscriptionCredentials::from_access_token(
                "synthetic".into(),
                Some("other-account".into()),
                None,
            ),
            _ => std::future::pending().await,
        }
    }
}
#[tokio::test]
async fn sse_preflight_reload_and_account_failure_are_not_submitted() {
    for mode in [0, 1] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let auth = Arc::new(ReloadAuth {
            loads: AtomicUsize::new(0),
            mode,
            entered: Notify::new(),
        });
        let provider =
            OpenAiCodexProvider::loopback(auth, Transport::Sse, listener.local_addr().unwrap());
        let mut opts = SessionOptions::new("test");
        opts.transport = Transport::Sse;
        let mut session = provider.open_session(opts).await.unwrap();
        session
            .control
            .generate(vec![InputItem::user("synthetic")])
            .await
            .unwrap();
        let event = timeout(Duration::from_secs(2), session.events.next())
            .await
            .unwrap()
            .unwrap();
        let expected = if mode == 0 {
            "auth_expired"
        } else {
            "auth_account_changed"
        };
        assert!(
            matches!(event.event,ProviderEvent::RequestFailed { upstream_outcome:UpstreamOutcome::NotSubmitted, code, .. } if code == expected)
        );
        assert!(
            timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
    }
}
#[tokio::test]
async fn cancellation_during_sse_reload_is_deterministically_before_dispatch() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let auth = Arc::new(ReloadAuth {
        loads: AtomicUsize::new(0),
        mode: 2,
        entered: Notify::new(),
    });
    let provider =
        OpenAiCodexProvider::loopback(auth.clone(), Transport::Sse, listener.local_addr().unwrap());
    let mut opts = SessionOptions::new("test");
    opts.transport = Transport::Sse;
    let mut session = provider.open_session(opts).await.unwrap();
    session
        .control
        .generate(vec![InputItem::user("synthetic")])
        .await
        .unwrap();
    timeout(Duration::from_secs(2), auth.entered.notified())
        .await
        .unwrap();
    session.control.close();
    let event = timeout(Duration::from_secs(2), session.events.next())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        event.event,
        ProviderEvent::RequestFailed {
            upstream_outcome: UpstreamOutcome::NotSubmitted,
            ..
        }
    ));
    assert!(
        timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn expired_websocket_preflight_does_not_write_generation() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        assert!(matches!(
            socket.next().await,
            Some(Ok(Message::Close(_))) | None
        ));
    });
    let mut wire = wire::Wire::open(
        Transport::WebSocket,
        &format!("ws://{address}/codex/responses"),
        Arc::new(FakeAuth),
        "synthetic",
        Duration::from_secs(2),
        None,
    )
    .await
    .unwrap();
    if let wire::Wire::WebSocket { auth, .. } = &mut wire {
        auth.expire_for_test();
    }
    let mut session = session::spawn(
        "synthetic".into(),
        wire,
        SessionOptions::new("test"),
        session::Timeouts::default(),
    );
    session
        .control
        .generate(vec![InputItem::user("synthetic")])
        .await
        .unwrap();
    let event = timeout(Duration::from_secs(2), session.events.next())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(event.event,ProviderEvent::RequestFailed { upstream_outcome:UpstreamOutcome::NotSubmitted, code, .. } if code == "auth_expired")
    );
    timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}
#[tokio::test]
async fn sse_disconnect_after_request_is_ambiguous_without_retry() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        let _ = read_http(&mut tcp).await;
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::Sse, address);
    let mut opts = SessionOptions::new("test");
    opts.transport = Transport::Sse;
    let mut session = provider.open_session(opts).await.unwrap();
    session
        .control
        .generate(vec![InputItem::user("synthetic")])
        .await
        .unwrap();
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
    assert!(matches!(
        session
            .control
            .generate(vec![InputItem::user("again")])
            .await,
        Err(GatewayError::SessionClosed)
    ));
    server.await.unwrap();
}
#[tokio::test]
async fn terminal_type_alone_is_not_a_validated_terminal() {
    for valid in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut socket = accept(listener).await;
            let _ = incoming(&mut socket).await;
            let call = json!({"type":"function_call","call_id":"duplicate","name":"add_numbers","arguments":"{}"});
            let value = if valid {
                json!({"type":"response.completed","response":{"id":"synthetic","status":"completed","output":[call.clone(),call]}})
            } else {
                json!({"type":"response.completed","response":{"id":"synthetic","status":"in_progress","output":[]}})
            };
            send(&mut socket, value).await;
            let _ = socket.next().await;
        });
        let provider =
            OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
        let mut session = provider
            .open_session(SessionOptions::new("test"))
            .await
            .unwrap();
        session
            .control
            .generate(vec![InputItem::user("synthetic")])
            .await
            .unwrap();
        loop {
            let event = timeout(Duration::from_secs(2), session.events.next())
                .await
                .unwrap()
                .unwrap();
            if let ProviderEvent::RequestFailed {
                upstream_outcome, ..
            } = event.event
            {
                assert_eq!(
                    upstream_outcome,
                    if valid {
                        UpstreamOutcome::TerminalReceived
                    } else {
                        UpstreamOutcome::Unknown
                    }
                );
                break;
            }
        }
        timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }
}
