use super::super::auth::{CredentialSource, SubscriptionCredentials};
use super::*;
use crate::{SessionOptions, Transport};
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct FakeAuth;
#[async_trait::async_trait]
impl CredentialSource for FakeAuth {
    async fn load(&self) -> Result<SubscriptionCredentials> {
        SubscriptionCredentials::from_access_token(
            "synthetic-token".into(),
            Some("synthetic-account".into()),
            None,
        )
    }
}

#[tokio::test]
async fn consistency_drive_failure_leaves_conversation_unsettled() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut byte = [0];
        while !request.ends_with(b"\r\n\r\n") {
            tcp.read_exact(&mut byte).await.unwrap();
            request.push(byte[0]);
        }
        let headers = String::from_utf8(request).unwrap();
        let length: usize = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse().unwrap())
            })
            .unwrap();
        tcp.read_exact(&mut vec![0; length]).await.unwrap();
        let events = [
            json!({"type":"response.created","response":{"id":"r1"}}),
            json!({"type":"response.output_text.delta","item_id":"m","output_index":0,"content_index":0,"delta":"visible"}),
            json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[
                {"type":"message","id":"m","content":[{"type":"output_text","text":"changed"}]},
                {"type":"function_call","id":"item","call_id":"call","name":"add_numbers","arguments":"{\"a\":17,\"b\":25}"}
            ]}}),
        ];
        let body = events
            .iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect::<String>();
        tcp.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    });
    let mut wire = Wire::open(
        Transport::Sse,
        &format!("http://{address}"),
        Arc::new(FakeAuth),
        "synthetic",
        Duration::from_secs(3),
        None,
    )
    .await
    .unwrap();
    let mut options = SessionOptions::new("synthetic");
    options.transport = Transport::Sse;
    let input = vec![InputItem::user("first")];
    let mut state = Conversation::default();
    let (body, full_input) = state.prepare(&options, &input).unwrap();
    let expected = (body.clone(), full_input.clone());
    let (tx, mut rx) = mpsc::channel(16);
    let mut sink = EventSink {
        tx,
        final_slot: Arc::new(Mutex::new(None)),
        session_id: "synthetic".into(),
        sequence: 0,
        consumer_timeout: Duration::from_secs(3),
    };
    let mut upstream = UpstreamOutcome::NotSubmitted;
    let result = drive(
        &mut wire,
        &mut state,
        body,
        full_input,
        "request",
        &mut sink,
        &CancellationToken::new(),
        &mut upstream,
        Duration::from_secs(3),
    )
    .await;
    assert!(matches!(
        result,
        Err(GatewayError::Protocol(
            "streamed output is inconsistent with terminal output or exceeds tracking limits"
        ))
    ));
    assert_eq!(upstream, UpstreamOutcome::TerminalReceived);
    // Settlement would add history and require the pending call's result here.
    assert_eq!(state.prepare(&options, &input).unwrap(), expected);
    let mut ws_options = options;
    ws_options.transport = Transport::WebSocket;
    assert!(
        state
            .prepare(&ws_options, &input)
            .unwrap()
            .0
            .get("previous_response_id")
            .is_none()
    );
    while let Ok(event) = rx.try_recv() {
        assert!(!matches!(
            event.event,
            ProviderEvent::ResponseFinished { .. }
        ));
    }
    wire.close().await;
    server.await.unwrap();
}
