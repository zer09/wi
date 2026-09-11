use super::*;

pub(super) async fn http_events(tcp: &mut TcpStream, events: Vec<Value>) {
    let body = events
        .iter()
        .map(|v| format!("data: {v}\n\n"))
        .collect::<String>();
    tcp.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    tcp.shutdown().await.unwrap();
}
