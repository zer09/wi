use super::*;
use crate::{ConversationReplay, ReplayExchange, ReplayIdentity, ReplayRun};
use futures_util::{FutureExt, poll};
use tokio::sync::oneshot;

fn seed(identity: ReplayIdentity) -> ConversationReplay {
    let response = super::super::codec::parse_response(json!({
        "id":"historical-parent", "status":"completed", "output":[
            {"type":"message","content":[{"type":"output_text","text":"old reply"}]}
        ]
    }))
    .unwrap();
    ConversationReplay::new(
        PROVIDER_ID.into(),
        "test".into(),
        Some(identity),
        vec![
            ReplayRun::new(
                "old-run".into(),
                "old prompt".into(),
                vec![ReplayExchange::new(response, vec![]).unwrap()],
            )
            .unwrap(),
        ],
    )
    .unwrap()
}
async fn closed_without_request(socket: &mut WebSocketStream<TcpStream>) {
    while let Some(frame) = socket.next().await {
        match frame {
            Ok(Message::Text(_)) => panic!("installation sent a provider request"),
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(Message::Ping(_)) => socket.flush().await.unwrap(),
            _ => {}
        }
    }
}

#[tokio::test]
async fn install_is_atomic_once_only_and_serializes_with_generate_without_events() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (ping, start_ping) = oneshot::channel();
    let (pong, got_pong) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        start_ping.await.unwrap();
        socket
            .send(Message::Ping(vec![1, 2, 3].into()))
            .await
            .unwrap();
        assert!(matches!(
            socket.next().await.unwrap().unwrap(),
            Message::Pong(_)
        ));
        pong.send(()).unwrap();
        let body = incoming(&mut socket).await;
        assert!(body.get("previous_response_id").is_none());
        assert_eq!(
            body["input"],
            json!([
                {"role":"user","content":[{"type":"input_text","text":"old prompt"}]},
                {"type":"message","content":[{"type":"output_text","text":"old reply"}]},
                {"role":"user","content":[{"type":"input_text","text":"new prompt"}]}
            ])
        );
        text_response(&mut socket, "new-parent", "new reply").await;
        closed_without_request(&mut socket).await;
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    let mut session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    let replay = seed(session.control.replay_identity().unwrap());
    let mut invalid = serde_json::to_value(&replay).unwrap();
    invalid["runs"][0]["exchanges"][0]["response"]["text"] = json!("contradiction");
    let invalid: ConversationReplay = serde_json::from_value(invalid).unwrap();
    assert!(matches!(
        session.control.install_replay(invalid).await,
        Err(GatewayError::Protocol(_))
    ));
    let mut install = Box::pin(session.control.install_replay(replay.clone()));
    assert!(poll!(install.as_mut()).is_pending());
    assert!(matches!(
        session.control.install_replay(replay.clone()).await,
        Err(GatewayError::Busy)
    ));
    assert!(matches!(
        session
            .control
            .generate(vec![InputItem::user("too soon")])
            .await,
        Err(GatewayError::Busy)
    ));
    install.await.unwrap();
    assert!(session.events.next().now_or_never().is_none());
    assert!(matches!(
        session.control.install_replay(replay.clone()).await,
        Err(GatewayError::InvalidRequest(_))
    ));
    ping.send(()).unwrap();
    timeout(Duration::from_secs(3), got_pong)
        .await
        .unwrap()
        .unwrap();
    assert!(session.events.next().now_or_never().is_none());
    let receipt = session
        .control
        .generate(vec![InputItem::user("new prompt")])
        .await
        .unwrap();
    response(&mut session, &receipt.request_id).await;
    session.control.close();
    assert!(matches!(
        session.control.install_replay(replay).await,
        Err(GatewayError::SessionClosed)
    ));
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn direct_mismatched_identity_rejects_without_network_or_semantic_events_on_both_transports()
{
    for transport in [Transport::WebSocket, Transport::Sse] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (closed, done) = oneshot::channel();
        let server = tokio::spawn(async move {
            if transport == Transport::WebSocket {
                let mut socket = accept(listener).await;
                closed_without_request(&mut socket).await;
            } else {
                tokio::select! {
                    biased;
                    _ = listener.accept() => panic!("install opened HTTP connection"),
                    _ = done => {}
                }
            }
        });
        let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), transport, address);
        let mut options = SessionOptions::new("test");
        options.transport = transport;
        let mut session = provider.open_session(options).await.unwrap();
        let actual = session.control.replay_identity().unwrap();
        let wrong = ReplayIdentity::new(PROVIDER_ID.into(), replay::FORMAT.into(), "01".repeat(32))
            .unwrap();
        assert_ne!(actual, wrong);
        let error = session
            .control
            .install_replay(seed(wrong))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            GatewayError::InvalidRequest("replay identity mismatch")
        ));
        let diagnostic = format!("{error:?} {error} {actual:?}");
        for secret in [
            "synthetic-account",
            "synthetic-oauth-token",
            actual.principal_digest(),
        ] {
            assert!(!diagnostic.contains(secret));
        }
        assert!(session.events.next().now_or_never().is_none());
        session.control.install_replay(seed(actual)).await.unwrap();
        session.control.close();
        let _ = closed.send(());
        assert!(
            timeout(Duration::from_secs(3), session.events.next())
                .await
                .unwrap()
                .is_none()
        );
        timeout(Duration::from_secs(3), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn generate_wins_reservation_and_install_rejects_busy_then_used() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (sent, got_request) = oneshot::channel();
    let (finish, release) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut socket = accept(listener).await;
        let body = incoming(&mut socket).await;
        assert_eq!(body["input"].as_array().unwrap().len(), 1);
        sent.send(()).unwrap();
        release.await.unwrap();
        text_response(&mut socket, "new-parent", "done").await;
        closed_without_request(&mut socket).await;
    });
    let provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
    let mut session = provider
        .open_session(SessionOptions::new("test"))
        .await
        .unwrap();
    let replay = seed(session.control.replay_identity().unwrap());
    let mut generate = Box::pin(session.control.generate(vec![InputItem::user("fresh")]));
    assert!(poll!(generate.as_mut()).is_pending());
    assert!(matches!(
        session.control.install_replay(replay.clone()).await,
        Err(GatewayError::Busy)
    ));
    let receipt = generate.await.unwrap();
    got_request.await.unwrap();
    assert!(matches!(
        session.control.install_replay(replay.clone()).await,
        Err(GatewayError::Busy)
    ));
    finish.send(()).unwrap();
    response(&mut session, &receipt.request_id).await;
    assert!(matches!(
        session.control.install_replay(replay).await,
        Err(GatewayError::InvalidRequest(_))
    ));
    session.control.close();
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn cancelled_install_and_lost_ack_close_ownership_without_request_or_retry() {
    for after_ack in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (ping, start_ping) = oneshot::channel();
        let (pong, got_pong) = oneshot::channel();
        let server = tokio::spawn(async move {
            let mut socket = accept(listener).await;
            if after_ack {
                start_ping.await.unwrap();
                socket.send(Message::Ping(vec![9].into())).await.unwrap();
                assert!(matches!(
                    socket.next().await.unwrap().unwrap(),
                    Message::Pong(_)
                ));
                pong.send(()).unwrap();
            }
            closed_without_request(&mut socket).await;
        });
        let provider =
            OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address);
        let mut session = provider
            .open_session(SessionOptions::new("test"))
            .await
            .unwrap();
        let replay = seed(session.control.replay_identity().unwrap());
        let mut install = Box::pin(session.control.install_replay(replay.clone()));
        assert!(poll!(install.as_mut()).is_pending());
        if after_ack {
            ping.send(()).unwrap();
            // The actor handles the queued command before servicing this idle ping.
            timeout(Duration::from_secs(3), got_pong)
                .await
                .unwrap()
                .unwrap();
        }
        drop(install);
        assert!(matches!(
            session.control.install_replay(replay).await,
            Err(GatewayError::SessionClosed)
        ));
        assert!(matches!(
            session
                .control
                .generate(vec![InputItem::user("retry")])
                .await,
            Err(GatewayError::SessionClosed)
        ));
        assert!(
            timeout(Duration::from_secs(3), session.events.next())
                .await
                .unwrap()
                .is_none()
        );
        timeout(Duration::from_secs(3), server)
            .await
            .unwrap()
            .unwrap();
    }
}
