use super::*;

mod boundaries;
mod live;

struct Reader {
    response: reqwest::Response,
    pending: Vec<u8>,
}
impl Reader {
    async fn new(request: reqwest::RequestBuilder) -> Self {
        let response = watchdog(request.send()).await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/event-stream"
        );
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        Self {
            response,
            pending: Vec::new(),
        }
    }
    async fn frame(&mut self) -> Option<String> {
        watchdog(async {
            loop {
                if let Some(end) = self.pending.windows(2).position(|s| s == b"\n\n") {
                    let bytes: Vec<_> = self.pending.drain(..end + 2).collect();
                    return Some(String::from_utf8(bytes).unwrap());
                }
                match self.response.chunk().await.unwrap() {
                    Some(chunk) => self.pending.extend_from_slice(&chunk),
                    None => {
                        assert!(self.pending.is_empty());
                        return None;
                    }
                }
            }
        })
        .await
    }
    async fn event(&mut self, sid: &ApplicationSessionId, sequence: u64) -> Value {
        let frame = self.frame().await.unwrap();
        let fields: Vec<_> = frame.lines().collect();
        assert_eq!(
            fields.len(),
            4,
            "one JSON data line and one blank terminator"
        );
        assert_eq!(fields[0], "event: wi.event");
        assert_eq!(fields[1], format!("id: {sid}:{sequence}"));
        assert!(fields[2].starts_with("data: "));
        assert_eq!(fields[3], "");
        assert!(!frame.contains("private-"));
        assert!(!frame.contains(TOKEN));
        let event: Value = serde_json::from_str(&fields[2][6..]).unwrap();
        assert_eq!(event["api_version"], 1);
        assert_eq!(event["session_id"], sid.as_str());
        assert_eq!(event["sequence"], sequence.to_string());
        event
    }
}

#[tokio::test]
async fn sse_wire_cursor_equality_and_unicode_newline_safety() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    let text = "雪\r\n\nid: forged\nevent: wi.closed\ndata: injected\n\0λ";
    session
        .rename(OperationId::new(), text.into())
        .await
        .unwrap();
    let path = format!("/v1/sessions/{sid}/events");
    let mut stream = Reader::new(server.get(&path).header(header::ORIGIN, ORIGIN)).await;
    assert_eq!(
        stream.response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        ORIGIN
    );
    assert_eq!(stream.event(sid, 1).await["kind"], "session.created");
    assert_eq!(stream.event(sid, 2).await["data"]["title"], text);
    drop(stream);
    for request in [
        server.get(&format!("{path}?after={sid}:1")),
        server
            .get(&path)
            .header("Last-Event-ID", format!("{sid}:1")),
        server
            .get(&format!("{path}?after={sid}:1"))
            .header("Last-Event-ID", format!("{sid}:1")),
    ] {
        let mut stream = Reader::new(request).await;
        assert_eq!(stream.event(sid, 2).await["data"]["title"], text);
    }
    server.finish().await;
}

#[tokio::test]
async fn sse_initial_validation_failures_are_http_errors() {
    use crate::storage::test_hooks::{Action, Point};
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    let path = format!("/v1/sessions/{sid}/events");
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    error(server.http.get(server.url(&path)), 401, "api.unauthorized").await;
    error(
        server.get(&path).header(header::HOST, "foreign.example"),
        421,
        "api.authority_invalid",
    )
    .await;
    error(
        server
            .get(&path)
            .header(header::ORIGIN, "https://foreign.example"),
        403,
        "api.origin_forbidden",
    )
    .await;
    for query in [
        "limit=32",
        "through=1",
        "after=x&after=x",
        "token=synthetic",
    ] {
        error(
            server.get(&format!("{path}?{query}")),
            400,
            "api.invalid_request",
        )
        .await;
    }
    for cursor in [
        "".to_owned(),
        "bad:0".to_owned(),
        format!("{}:0", ApplicationSessionId::new()),
        format!("{sid}:01"),
        format!("{sid}:-1"),
        format!("{sid}:1:2"),
        format!("{sid}:9223372036854775808"),
        format!("{sid}:1,{sid}:1"),
    ] {
        let mut url = reqwest::Url::parse(&server.url(&path)).unwrap();
        url.query_pairs_mut().append_pair("after", &cursor);
        error(
            server.http.get(url).bearer_auth(TOKEN),
            400,
            "api.cursor_invalid",
        )
        .await;
        error(
            server.get(&path).header("Last-Event-ID", cursor),
            400,
            "api.cursor_invalid",
        )
        .await;
    }
    error(
        server
            .get(&format!("{path}?after={sid}:0"))
            .header("Last-Event-ID", format!("{sid}:1")),
        400,
        "api.cursor_invalid",
    )
    .await;
    error(
        server
            .get(&path)
            .header("Last-Event-ID", format!("{sid}:0"))
            .header("Last-Event-ID", format!("{sid}:0")),
        400,
        "api.cursor_invalid",
    )
    .await;
    error(
        server.get("/v1/sessions/not-a-session/events"),
        400,
        "api.invalid_request",
    )
    .await;
    // The gate failures above did not consume the armed storage open fault.
    error(server.get(&path), 503, "storage.io").await;
    error(
        server.get(&format!(
            "/v1/sessions/{}/events",
            ApplicationSessionId::new()
        )),
        404,
        "storage.not_found",
    )
    .await;
    error(
        server.get(&format!("{path}?after={sid}:2")),
        400,
        "api.cursor_invalid",
    )
    .await;
    error(
        server
            .get(&path)
            .header("Last-Event-ID", format!("{sid}:2")),
        400,
        "api.cursor_invalid",
    )
    .await;
    server.finish().await;
}
