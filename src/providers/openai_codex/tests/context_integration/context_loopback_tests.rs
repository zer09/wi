use super::*;
use crate::context::{ContextRoots, discover, prepare_run, prepare_run_with_skill_loading};
use std::fs;

#[path = "../harness/context.rs"]
mod harness;
use harness::*;

#[tokio::test]
async fn context_prepare_websocket_exact_initial_context_then_same_session_parent_delta() {
    for recovered in [false, true] {
        let (request, tools) = prepared_request(Transport::WebSocket);
        let expected = request.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut socket = accept_ws(&listener).await;
            let first = incoming(&mut socket).await;
            assert_prepared_first(&first, &expected, Transport::WebSocket);
            for event in first_events(recovered) {
                send(&mut socket, event).await;
            }
            let second = incoming(&mut socket).await;
            assert_second(&first, &second, Transport::WebSocket);
            assert_eq!(second["instructions"], expected.options.instructions);
            assert_eq!(second["tools"], first["tools"]);
            for event in final_events() {
                send(&mut socket, event).await;
            }
            while let Some(Ok(frame)) = socket.next().await {
                assert!(
                    !frame.is_text(),
                    "unexpected skill-load or third generation"
                );
            }
            no_extra(listener, stopped).await;
        });
        let (gateway, auth, opens) = setup(address, Transport::WebSocket);
        let (result, responses) = drive_prepared(&gateway, request, &tools).await;
        assert_success(&result, &responses, recovered);
        assert_auth(&auth, &opens, 1);
        stop.send(()).unwrap();
        timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn context_prepare_sse_replays_exact_initial_context_once_with_native_history() {
    for mime in [Some("text/event-stream"), None] {
        for recovered in [false, true] {
            let (request, tools) = prepared_request(Transport::Sse);
            let expected = request.clone();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (stop, stopped) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut tcp, _) = listener.accept().await.unwrap();
                let (first, session) = http_request(&mut tcp).await;
                assert_prepared_first(&first, &expected, Transport::Sse);
                reply(&mut tcp, "200 OK", mime, &frames(first_events(recovered))).await;
                let (mut tcp, _) = listener.accept().await.unwrap();
                let (second, next_session) = http_request(&mut tcp).await;
                assert_eq!(session, next_session);
                assert_second(&first, &second, Transport::Sse);
                assert_eq!(second["instructions"], expected.options.instructions);
                assert_eq!(second["tools"], first["tools"]);
                reply(&mut tcp, "200 OK", mime, frames(final_events()).trim_end()).await;
                no_extra(listener, stopped).await;
            });
            let (gateway, auth, opens) = setup(address, Transport::Sse);
            let (result, responses) = drive_prepared(&gateway, request, &tools).await;
            assert_success(&result, &responses, recovered);
            assert_auth(&auth, &opens, 3);
            stop.send(()).unwrap();
            timeout(Duration::from_secs(5), server)
                .await
                .unwrap()
                .unwrap();
        }
    }
}

#[tokio::test]
async fn skill_loading_websocket_uses_one_session_parent_and_only_correlated_result() {
    for recovered in [false, true] {
        let (_temp, request, tools) = prepared_skill_loading_request(Transport::WebSocket);
        let expected = request.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut socket = accept_ws(&listener).await;
            let first = incoming(&mut socket).await;
            assert_skill_first(&first, &expected, Transport::WebSocket);
            for event in skill_events(recovered) {
                send(&mut socket, event).await;
            }
            let second = incoming(&mut socket).await;
            assert_skill_second(&first, &second, Transport::WebSocket);
            for event in final_events() {
                send(&mut socket, event).await;
            }
            while let Some(Ok(frame)) = socket.next().await {
                assert!(!frame.is_text(), "unexpected third generation");
            }
            no_extra(listener, stopped).await;
        });
        let (gateway, auth, opens) = setup(address, Transport::WebSocket);
        let (result, responses) = drive_prepared(&gateway, request, &tools).await;
        assert_skill_success(&result, &responses, recovered);
        assert_auth(&auth, &opens, 1);
        stop.send(()).unwrap();
        timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn skill_loading_sse_replays_exact_prepared_context_native_call_and_result() {
    for mime in [Some("text/event-stream"), None] {
        for recovered in [false, true] {
            let (_temp, request, tools) = prepared_skill_loading_request(Transport::Sse);
            let expected = request.clone();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (stop, stopped) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut tcp, _) = listener.accept().await.unwrap();
                let (first, session) = http_request(&mut tcp).await;
                assert_skill_first(&first, &expected, Transport::Sse);
                reply(&mut tcp, "200 OK", mime, &frames(skill_events(recovered))).await;
                let (mut tcp, _) = listener.accept().await.unwrap();
                let (second, next_session) = http_request(&mut tcp).await;
                assert_eq!(session, next_session);
                assert_skill_second(&first, &second, Transport::Sse);
                reply(&mut tcp, "200 OK", mime, frames(final_events()).trim_end()).await;
                no_extra(listener, stopped).await;
            });
            let (gateway, auth, opens) = setup(address, Transport::Sse);
            let (result, responses) = drive_prepared(&gateway, request, &tools).await;
            assert_skill_success(&result, &responses, recovered);
            assert_auth(&auth, &opens, 3);
            stop.send(()).unwrap();
            timeout(Duration::from_secs(5), server)
                .await
                .unwrap()
                .unwrap();
        }
    }
}
