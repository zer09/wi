use super::*;

pub(super) fn start(id: &str) -> Value {
    json!({"type":"response.created","response":{"id":id}})
}
pub(super) fn terminal(id: &str, output: Value) -> Value {
    json!({"type":"response.completed","response":{"id":id,"status":"completed","output":output}})
}
pub(super) fn message(text: &str) -> Value {
    json!({"type":"message","id":"m","content":[{"type":"output_text","text":text}]})
}
pub(super) fn frames(values: &[Value]) -> Vec<u8> {
    values
        .iter()
        .map(|value| format!("data: {value}\n\n"))
        .collect::<String>()
        .into_bytes()
}
pub(super) async fn reply(tcp: &mut TcpStream, body: &[u8]) {
    tcp.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    tcp.write_all(body).await.unwrap();
    tcp.shutdown().await.unwrap();
}
pub(super) async fn open_wire(
    address: std::net::SocketAddr,
    observer: Option<SmokeObserver>,
) -> wire::Wire {
    wire::Wire::open(
        Transport::Sse,
        &format!("http://{address}"),
        Arc::new(FakeAuth),
        "synthetic",
        Duration::from_secs(2),
        observer.map(|o| (o, SmokeCase::Text)),
    )
    .await
    .unwrap()
}
