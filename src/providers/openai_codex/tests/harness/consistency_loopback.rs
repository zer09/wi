use super::*;

pub(super) async fn http_events(tcp: &mut TcpStream, events: Vec<Value>) {
    let body = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    // Early consistency rejection can close the client during an oversized stream.
    let _ = tcp.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
    let _ = tcp.shutdown().await;
}
