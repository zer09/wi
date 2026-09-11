//! Shared synthetic credentials, loopback transports, and response collection.
use super::*;

pub(super) struct FakeAuth;
#[async_trait]
impl CredentialSource for FakeAuth {
    async fn load(&self) -> Result<SubscriptionCredentials> {
        SubscriptionCredentials::from_access_token(
            "synthetic-oauth-token".into(),
            Some("synthetic-account".into()),
            None,
        )
    }
}
pub(super) struct ExplodingAuth;
#[async_trait]
impl CredentialSource for ExplodingAuth {
    async fn load(&self) -> Result<SubscriptionCredentials> {
        panic!("feature guard must run before auth")
    }
}
// Tungstenite fixes the callback error type; the test cannot box it.
#[allow(clippy::result_large_err)]
pub(super) async fn accept(listener: TcpListener) -> WebSocketStream<TcpStream> {
    let (tcp, _) = listener.accept().await.unwrap();
    accept_hdr_async(tcp, |req: &Request, response: Response| {
        assert_eq!(req.uri().path(), "/codex/responses");
        assert_eq!(
            req.headers()["authorization"],
            "Bearer synthetic-oauth-token"
        );
        assert_eq!(req.headers()["chatgpt-account-id"], "synthetic-account");
        assert_eq!(req.headers()["originator"], "wi");
        assert_eq!(req.headers()["openai-beta"], wire::WS_BETA);
        Ok(response)
    })
    .await
    .unwrap()
}
pub(super) async fn incoming(socket: &mut WebSocketStream<TcpStream>) -> Value {
    loop {
        match socket.next().await.unwrap().unwrap() {
            Message::Text(text) => return serde_json::from_str(text.as_str()).unwrap(),
            Message::Ping(_) => {
                socket.flush().await.unwrap();
            }
            _ => {}
        }
    }
}
pub(super) async fn send(socket: &mut WebSocketStream<TcpStream>, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
pub(super) async fn text_response(socket: &mut WebSocketStream<TcpStream>, id: &str, text: &str) {
    send(
        socket,
        json!({"type":"response.created","sequence_number":0,"response":{"id":id}}),
    )
    .await;
    send(socket, json!({"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"m1","content":[]}})).await;
    send(socket, json!({"type":"response.output_text.delta","item_id":"m1","output_index":0,"content_index":0,"delta":text})).await;
    send(socket, json!({"type":"response.completed","response":{"id":id,"status":"completed","model":"synthetic-model","output":[{"type":"message","id":"m1","content":[{"type":"output_text","text":text}]}]}})).await;
}
pub(super) async fn response(
    session: &mut ProviderSession,
    request_id: &str,
) -> crate::ModelResponse {
    loop {
        let event = timeout(Duration::from_secs(4), session.events.next())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.request_id.as_deref(), Some(request_id));
        match event.event {
            ProviderEvent::ResponseFinished { response } => return response,
            ProviderEvent::RequestFailed { code, .. } => panic!("request failed: {code}"),
            _ => {}
        }
    }
}

pub(super) async fn read_http(stream: &mut TcpStream) -> Value {
    let mut raw = Vec::new();
    let mut byte = [0u8; 1];
    while !raw.ends_with(b"\r\n\r\n") {
        assert!(raw.len() < 16 * 1024);
        stream.read_exact(&mut byte).await.unwrap();
        raw.push(byte[0]);
    }
    let headers = String::from_utf8(raw).unwrap();
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("authorization: bearer synthetic-oauth-token")
    );
    let len: usize = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    let mut body = vec![0; len];
    stream.read_exact(&mut body).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}
pub(super) async fn send_sse(stream: &mut TcpStream, id: &str, text: &str) {
    // Terminal frame deliberately has NO final newline; codec closes it at EOF.
    let body = format!(
        "data: {}\r\n\r\ndata: {}",
        json!({"type":"response.created","response":{"id":id}}),
        json!({"type":"response.completed","response":{"id":id,"status":"completed","output":[{"type":"reasoning","id":"opaque1","encrypted_content":"opaque-test-data"},{"type":"message","id":"m1","content":[{"type":"output_text","text":text}]}]}})
    );
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await.unwrap();
    stream.write_all(body.as_bytes()).await.unwrap();
    stream.shutdown().await.unwrap();
}
