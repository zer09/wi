//! New-controller transport proofs. Every credential and native field is synthetic.
#[path = "../context_integration/context_loopback_tests.rs"]
mod context_loopback;

use super::*;
use crate::{
    Gateway, OutputProvenance,
    run::{RunEvent, RunOutcome, RunRequest, RunResult},
};
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;

#[path = "../harness/run.rs"]
mod harness;
use harness::*;

#[tokio::test]
async fn run_websocket_a_native_and_recovered_one_socket_exact_linkage() {
    for recovered in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut socket = accept_ws(&listener).await;
            let first = incoming(&mut socket).await;
            assert_first(&first, Transport::WebSocket);
            for event in first_events(recovered) {
                send(&mut socket, event).await;
            }
            let second = incoming(&mut socket).await;
            assert_second(&first, &second, Transport::WebSocket);
            for event in final_events() {
                send(&mut socket, event).await;
            }
            while let Some(Ok(frame)) = socket.next().await {
                assert!(!frame.is_text(), "third generation");
            }
            no_extra(listener, stopped).await;
        });
        let (gateway, auth, opens) = setup(address, Transport::WebSocket);
        let (result, responses) = drive(&gateway, Transport::WebSocket).await;
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
async fn run_sse_a_mime_and_missing_prolog_replay_exact_effective_native_history() {
    for mime in [Some("text/event-stream"), None] {
        for recovered in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (stop, stopped) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut tcp, _) = listener.accept().await.unwrap();
                let (first, session) = http_request(&mut tcp).await;
                assert_first(&first, Transport::Sse);
                reply(&mut tcp, "200 OK", mime, &frames(first_events(recovered))).await;
                let (mut tcp, _) = listener.accept().await.unwrap();
                let (second, next_session) = http_request(&mut tcp).await;
                assert_eq!(session, next_session);
                assert_second(&first, &second, Transport::Sse);
                // Exercise terminal framing at EOF after the strict prolog admits the start.
                reply(&mut tcp, "200 OK", mime, frames(final_events()).trim_end()).await;
                no_extra(listener, stopped).await;
            });
            let (gateway, auth, opens) = setup(address, Transport::Sse);
            let (result, responses) = drive(&gateway, Transport::Sse).await;
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
async fn run_websocket_nine_cycles_keep_one_socket_and_exact_linkage() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut socket = accept_ws(&listener).await;
        let first = incoming(&mut socket).await;
        assert_first(&first, Transport::WebSocket);
        for event in trace_events(0) {
            send(&mut socket, event).await;
        }
        for turn in 1..=9 {
            let next = incoming(&mut socket).await;
            assert_eq!(next["type"], "response.create");
            assert_eq!(next["prompt_cache_key"], first["prompt_cache_key"]);
            assert_eq!(next["previous_response_id"], format!("trace-{}", turn - 1));
            assert_eq!(next["input"], json!([trace_result(turn - 1)]));
            for event in trace_events(turn) {
                send(&mut socket, event).await;
            }
        }
        while let Some(Ok(frame)) = socket.next().await {
            assert!(!frame.is_text(), "unexpected eleventh generation");
        }
        no_extra(listener, stopped).await;
    });
    let (gateway, auth, opens) = setup(address, Transport::WebSocket);
    let (result, responses) = drive(&gateway, Transport::WebSocket).await;
    assert_trace_success(&result, &responses);
    assert_auth(&auth, &opens, 1);
    stop.send(()).unwrap();
    timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn run_sse_nine_cycles_replay_all_effective_native_history() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        let (first, session) = http_request(&mut tcp).await;
        assert_first(&first, Transport::Sse);
        reply(
            &mut tcp,
            "200 OK",
            Some("text/event-stream"),
            &frames(trace_events(0)),
        )
        .await;
        let mut expected = first["input"].as_array().unwrap().clone();
        for turn in 1..=9 {
            // Replay recovered effective output, not the empty native terminal array.
            expected.extend(trace_output(turn - 1));
            expected.push(trace_result(turn - 1));
            let (mut tcp, _) = listener.accept().await.unwrap();
            let (next, next_session) = http_request(&mut tcp).await;
            assert_eq!(session, next_session);
            assert_eq!(next["prompt_cache_key"], first["prompt_cache_key"]);
            assert!(next.get("previous_response_id").is_none());
            assert_eq!(next["input"], json!(expected));
            reply(
                &mut tcp,
                "200 OK",
                Some("text/event-stream"),
                &frames(trace_events(turn)),
            )
            .await;
        }
        no_extra(listener, stopped).await;
    });
    let (gateway, auth, opens) = setup(address, Transport::Sse);
    let (result, responses) = drive(&gateway, Transport::Sse).await;
    assert_trace_success(&result, &responses);
    assert_auth(&auth, &opens, 11);
    stop.send(()).unwrap();
    timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn run_websocket_disconnect_and_error_stop_one_attempt_without_reopen() {
    for provider_error in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut socket = accept_ws(&listener).await;
            assert_first(&incoming(&mut socket).await, Transport::WebSocket);
            if provider_error {
                send(
                    &mut socket,
                    json!({"type":"error","error":{"message":"synthetic failure"}}),
                )
                .await;
            }
            drop(socket);
            no_extra(listener, stopped).await;
        });
        let (gateway, auth, opens) = setup(address, Transport::WebSocket);
        let (result, responses) = drive(&gateway, Transport::WebSocket).await;
        assert!(matches!(result.outcome, RunOutcome::Failed { .. }));
        assert_eq!(result.summary.model_requests_attempted, 1);
        assert_eq!(result.summary.new_tool_dispatches, 0);
        assert_eq!(
            result.summary.last_upstream_outcome,
            Some(UpstreamOutcome::Unknown)
        );
        assert!(responses.is_empty());
        assert_auth(&auth, &opens, 1);
        stop.send(()).unwrap();
        timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn run_sse_wrong_mime_missing_invalid_prolog_and_http_errors_never_retry() {
    let valid_body = frames(first_events(false));
    for (status, mime, body) in [
        ("200 OK", Some("application/json"), valid_body.as_str()),
        ("200 OK", None, "<html>not an event stream</html>"),
        (
            "200 OK",
            None,
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\"}}",
        ),
        ("401 Unauthorized", Some("text/event-stream"), ""),
        ("403 Forbidden", Some("text/event-stream"), ""),
        ("429 Too Many Requests", Some("text/event-stream"), ""),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let body = body.to_owned();
        let server = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let (request, _) = http_request(&mut tcp).await;
            assert_first(&request, Transport::Sse);
            reply(&mut tcp, status, mime, &body).await;
            no_extra(listener, stopped).await;
        });
        let (gateway, auth, opens) = setup(address, Transport::Sse);
        let (result, responses) = drive(&gateway, Transport::Sse).await;
        assert!(matches!(result.outcome, RunOutcome::Failed { .. }));
        assert_eq!(result.summary.model_requests_attempted, 1);
        assert_eq!(result.summary.new_tool_dispatches, 0);
        assert_eq!(
            result.summary.last_upstream_outcome,
            Some(UpstreamOutcome::Unknown)
        );
        assert!(responses.is_empty());
        assert_auth(&auth, &opens, 2);
        stop.send(()).unwrap();
        timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }
}
