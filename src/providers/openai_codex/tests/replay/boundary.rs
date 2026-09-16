use super::*;

fn many_runs(identity: ReplayIdentity, count: usize, prompt: &str) -> ConversationReplay {
    let response = super::super::super::codec::parse_response(json!({
        "id":"historical-response", "status":"completed", "output":[]
    }))
    .unwrap();
    ConversationReplay::new(
        PROVIDER_ID.into(),
        "test".into(),
        Some(identity),
        (0..count)
            .map(|index| {
                ReplayRun::new(
                    format!("run-{index}"),
                    prompt.into(),
                    vec![ReplayExchange::new(response.clone(), vec![]).unwrap()],
                )
                .unwrap()
            })
            .collect(),
    )
    .unwrap()
}

#[tokio::test]
async fn install_and_actual_generate_recheck_capacity_without_sending_or_replacing_context() {
    for transport in [Transport::WebSocket, Transport::Sse] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (closed, done) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            if transport == Transport::WebSocket {
                let mut socket = accept_counted(&listener, TOKEN_A, ACCOUNT).await;
                drain_close(&mut socket).await;
            } else {
                tokio::select! {biased;
                    _ = listener.accept() => panic!("capacity rejection sent history"),
                    _ = done => {}
                }
            }
        });
        let auth = Arc::new(CountedAuth::new(TOKEN_A, ACCOUNT));
        let provider = OpenAiCodexProvider::loopback(auth.clone(), transport, address);
        let mut options = SessionOptions::new("test");
        options.transport = transport;
        let mut session = provider.open_session(options.clone()).await.unwrap();
        let identity = session.control.replay_identity().unwrap();
        let oversized = many_runs(identity.clone(), 2049, "old");
        assert!(matches!(
            session.control.install_replay(oversized).await,
            Err(GatewayError::InvalidRequest(_))
        ));
        let escaped = many_runs(
            identity.clone(),
            1,
            &"\0".repeat(crate::MAX_HISTORY_BYTES / 6),
        );
        assert!(matches!(
            session.control.install_replay(escaped).await,
            Err(GatewayError::InvalidRequest(_))
        ));
        let at_capacity = many_runs(identity, 2048, "old");
        assert!(
            provider
                .validate_replay(&options, &at_capacity, &[InputItem::user("new")])
                .is_err()
        );
        session.control.install_replay(at_capacity).await.unwrap();
        assert!(matches!(
            session.control.generate(vec![InputItem::user("new")]).await,
            Err(GatewayError::InvalidRequest(_))
        ));
        assert!(session.events.next().now_or_never().is_none());
        auth.assert_loads(1);
        session.control.close();
        while session.events.next().await.is_some() {}
        let _ = closed.send(());
        timeout(Duration::from_secs(4), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn native_history_over_128_items_and_one_mib_is_sent_and_old_response_ids_are_not_imported() {
    for transport in [Transport::WebSocket, Transport::Sse] {
        let prompt = "prepared 雪\r\n".repeat(700);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut expected = vec![user(&prompt); 129];
        expected.push(user("new task"));
        let server = tokio::spawn(async move {
            let reply = events("historical-response", vec![], false);
            let body;
            if transport == Transport::WebSocket {
                let mut socket = accept_counted(&listener, TOKEN_A, ACCOUNT).await;
                body = incoming(&mut socket).await;
                for event in reply {
                    send(&mut socket, event).await;
                }
                drain_close(&mut socket).await;
            } else {
                let (mut socket, _) = listener.accept().await.unwrap();
                body = read_counted_http(&mut socket, TOKEN_A, ACCOUNT).await;
                send_events_http(&mut socket, reply, false).await;
            }
            assert_eq!(body["input"], json!(expected));
            assert!(body.get("previous_response_id").is_none());
            assert!(serde_json::to_vec(&body["input"]).unwrap().len() > crate::MAX_INPUT_BYTES);
        });
        let auth = Arc::new(CountedAuth::new(TOKEN_A, ACCOUNT));
        let provider = OpenAiCodexProvider::loopback(auth.clone(), transport, address);
        let mut options = SessionOptions::new("test");
        options.transport = transport;
        let mut session = provider.open_session(options.clone()).await.unwrap();
        let replay = many_runs(session.control.replay_identity().unwrap(), 129, &prompt);
        provider
            .validate_replay(&options, &replay, &[InputItem::user("new task")])
            .unwrap();
        session.control.install_replay(replay).await.unwrap();
        assert!(session.events.next().now_or_never().is_none());
        auth.assert_loads(1);
        let receipt = session
            .control
            .generate(vec![InputItem::user("new task")])
            .await
            .unwrap();
        let response = response(&mut session, &receipt.request_id).await;
        assert_eq!(response.id, "historical-response");
        assert_eq!(response.outcome, ResponseOutcome::Completed);
        auth.assert_loads(if transport == Transport::WebSocket {
            1
        } else {
            2
        });
        session.control.close();
        while session.events.next().await.is_some() {}
        timeout(Duration::from_secs(4), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn installed_sse_identity_stays_immutable_and_changed_account_is_not_submitted() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (closed, done) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        tokio::select! {biased;
            _ = listener.accept() => panic!("changed account sent restored history"),
            _ = done => {}
        }
    });
    let auth = Arc::new(CountedAuth::new(TOKEN_A, ACCOUNT));
    let provider = OpenAiCodexProvider::loopback(auth.clone(), Transport::Sse, address);
    let mut options = SessionOptions::new("test");
    options.transport = Transport::Sse;
    let mut session = provider.open_session(options).await.unwrap();
    let identity = session.control.replay_identity().unwrap();
    session
        .control
        .install_replay(many_runs(identity.clone(), 1, "old"))
        .await
        .unwrap();
    auth.assert_loads(1);
    auth.rotate(TOKEN_B, "synthetic-account-y");
    let receipt = session
        .control
        .generate(vec![InputItem::user("new")])
        .await
        .unwrap();
    let event = timeout(Duration::from_secs(4), session.events.next())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.request_id, Some(receipt.request_id));
    assert!(
        matches!(event.event,ProviderEvent::RequestFailed {code,upstream_outcome:UpstreamOutcome::NotSubmitted,..} if code == GatewayError::AuthAccountChanged.code())
    );
    assert_eq!(session.control.replay_identity(), Some(identity));
    auth.assert_loads(2);
    assert!(session.events.next().await.is_none());
    let _ = closed.send(());
    timeout(Duration::from_secs(4), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn invalid_late_exchange_install_leaves_plain_generation_context_untouched() {
    for transport in [Transport::WebSocket, Transport::Sse] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let body;
            let reply = events("new-response", vec![], false);
            if transport == Transport::WebSocket {
                let mut socket = accept_counted(&listener, TOKEN_A, ACCOUNT).await;
                body = incoming(&mut socket).await;
                for event in reply {
                    send(&mut socket, event).await;
                }
                drain_close(&mut socket).await;
            } else {
                let (mut socket, _) = listener.accept().await.unwrap();
                body = read_counted_http(&mut socket, TOKEN_A, ACCOUNT).await;
                send_events_http(&mut socket, reply, true).await;
            }
            assert_eq!(body["input"], json!([user("only new input")]));
            assert!(body.get("previous_response_id").is_none());
        });
        let auth = Arc::new(CountedAuth::new(TOKEN_A, ACCOUNT));
        let provider = OpenAiCodexProvider::loopback(auth.clone(), transport, address);
        let mut options = SessionOptions::new("test");
        options.transport = transport;
        let mut session = provider.open_session(options).await.unwrap();
        let replay = many_runs(session.control.replay_identity().unwrap(), 2, "never sent");
        let mut invalid = serde_json::to_value(replay).unwrap();
        invalid["runs"][1]["exchanges"][0]["response"]["text"] = json!("not native text");
        let invalid = serde_json::from_value(invalid).unwrap();
        assert!(matches!(
            session.control.install_replay(invalid).await,
            Err(GatewayError::Protocol(_))
        ));
        auth.assert_loads(1);
        assert!(session.events.next().now_or_never().is_none());
        let receipt = session
            .control
            .generate(vec![InputItem::user("only new input")])
            .await
            .unwrap();
        response(&mut session, &receipt.request_id).await;
        session.control.close();
        while session.events.next().await.is_some() {}
        timeout(Duration::from_secs(4), server)
            .await
            .unwrap()
            .unwrap();
    }
}
