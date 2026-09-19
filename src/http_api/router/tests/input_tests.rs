use super::*;
use crate::{
    MAX_INPUT_BYTES,
    storage::test_hooks::{Action, Point},
};

#[tokio::test]
async fn strict_query_and_ids_reject_before_storage() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    for query in [
        "unknown=1",
        "limit=1&limit=2",
        "limit=1&%6cimit=2",
        "limit",
        "limit=",
        "limit=0",
        "limit=129",
        "limit=01",
        "limit=+1",
        "limit=%2B1",
        "limit=1.0",
        "limit=1e2",
        "limit=18446744073709551616",
        "limit=%FF",
        "limit=%",
        "limit=%GG",
        "limit=1&",
        "&limit=1",
        "after_id=bad",
        "after_id=null",
    ] {
        error(
            server.get(&format!("/v1/sessions?{query}")),
            400,
            "api.invalid_request",
        )
        .await;
    }
    for path in [
        "/v1/settings?limit=1".to_owned(),
        format!("/v1/sessions/{sid}?after=0"),
        "/v1/sessions/not-uuid".to_owned(),
        "/v1/sessions/00000000-0000-0000-0000-000000000000".to_owned(),
        format!("/v1/sessions/{sid}/runs/not-uuid"),
        format!("/v1/sessions/{sid}/operations/not-uuid"),
    ] {
        error(server.get(&path), 400, "api.invalid_request").await;
    }
    for query in [
        "after=0".to_owned(),
        format!("after={sid}:01"),
        format!("after={sid}:-1"),
        format!("after={sid}:9223372036854775808"),
        format!("after={sid}:0:1"),
        format!("after={}:0", ApplicationSessionId::new()),
        "through=01".to_owned(),
        "through=9223372036854775808".to_owned(),
        format!("after={sid}:2&through=1"),
    ] {
        error(
            server.get(&format!("/v1/sessions/{sid}/history?{query}")),
            400,
            "api.cursor_invalid",
        )
        .await;
    }
    error(
        server.get(&format!("/v1/sessions/{sid}")),
        503,
        "storage.io",
    )
    .await;
    for query in [format!("after={sid}:2"), "through=2".to_owned()] {
        error(
            server.get(&format!("/v1/sessions/{sid}/history?{query}")),
            400,
            "api.cursor_invalid",
        )
        .await;
    }
    response(server.get("/v1/sessions?%6cimit=1"), 200).await;
    for path in [
        "/unknown",
        "/v1/settings/",
        "/v1//settings",
        "/v1/sessions/extra/path",
    ] {
        error(server.get(path), 404, "api.not_found").await;
    }
    server.finish().await;
}

#[tokio::test]
async fn strict_command_objects_reject_before_storage() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    let oid = OperationId::new();
    let workspace = serde_json::to_string(&server.workspace()).unwrap();
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    let create = "/v1/sessions".to_owned();
    let rename = format!("/v1/sessions/{sid}/rename");
    for (path, bodies) in [
        (
            create,
            vec![
                format!(
                    r#"{{"operation_id":"{oid}","title":"x","workspace":{workspace},"tools":[]}}"#
                ),
                format!(
                    r#"{{"operation_id":"{oid}","title":"x","title":"x","workspace":{workspace}}}"#
                ),
                format!(
                    r#"{{"operation_id":"{oid}","operation_id":"{oid}","title":"x","workspace":{workspace}}}"#
                ),
                format!(
                    r#"{{"operation_id":"{oid}","title":"x","workspace":{workspace},"workspace":{workspace}}}"#
                ),
                format!(r#"{{"operation_id":"{oid}","title":null,"workspace":{workspace}}}"#),
                format!(r#"{{"operation_id":"{oid}","title":"x","workspace":null}}"#),
                format!(r#"{{"title":"x","workspace":{workspace}}}"#),
                format!(r#"{{"operation_id":"{oid}","workspace":{workspace}}}"#),
                format!(r#"{{"operation_id":"{oid}","title":"x"}}"#),
                format!(r#"["{oid}","x",{workspace}]"#),
                r#"{"operation_id":"bad","title":"x","workspace":"x"}"#.into(),
            ],
        ),
        (
            rename,
            vec![
                format!(r#"{{"operation_id":"{oid}","title":"a","ti\u0074le":"b"}}"#),
                format!(r#"{{"operation_id":"{oid}","title":false}}"#),
                format!(r#"{{"operation_id":"{oid}","title":"x","workspace":{workspace}}}"#),
                r#"{"operation_id":null,"title":"x"}"#.into(),
                r#"{"title":"x"}"#.into(),
            ],
        ),
    ] {
        for body in bodies {
            error(
                server
                    .http
                    .post(server.url(&path))
                    .bearer_auth(TOKEN)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(body),
                400,
                "api.invalid_request",
            )
            .await;
        }
    }
    for path in [
        format!("/v1/sessions/{sid}/refresh"),
        format!("/v1/sessions/{sid}/runs/{}/cancel", RunId::new()),
    ] {
        for body in [
            "",
            "null",
            "[]",
            "[{}]",
            "true",
            "{}{}",
            "{",
            "{\"extra\":1}",
            "{\"extra\":1,\"extra\":1}",
        ] {
            error(
                server
                    .http
                    .post(server.url(&path))
                    .bearer_auth(TOKEN)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(body),
                400,
                "api.invalid_request",
            )
            .await;
        }
    }
    error(
        server
            .http
            .post(server.url(&format!("/v1/sessions/{sid}/refresh")))
            .bearer_auth(TOKEN)
            .header(header::CONTENT_TYPE, "application/json")
            .body(vec![b'{', 0xff, b'}']),
        400,
        "api.invalid_request",
    )
    .await;
    error(
        server.get(&format!("/v1/sessions/{sid}")),
        503,
        "storage.io",
    )
    .await;
    assert_eq!(session.manifest().await.unwrap().head_sequence(), 1);
    server.finish().await;
}

#[tokio::test]
async fn mime_encoding_streamed_size_and_body_failures_precede_storage() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    let path = format!("/v1/sessions/{sid}/refresh");
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    error(
        server
            .http
            .post(server.url(&path))
            .bearer_auth(TOKEN)
            .body("{}"),
        415,
        "api.unsupported_media",
    )
    .await;
    for mime in [
        "text/plain",
        "application/x-www-form-urlencoded",
        "application/jsonp",
        "application/json; charset=ascii",
        "application/json; charset=utf-8; charset=utf-8",
        "application/json; other=utf-8",
        "application/json;",
        "application/json,application/json",
    ] {
        error(
            server
                .http
                .post(server.url(&path))
                .bearer_auth(TOKEN)
                .header(header::CONTENT_TYPE, mime)
                .body("{}"),
            415,
            "api.unsupported_media",
        )
        .await;
    }
    error(
        server
            .post(&path, &json!({}))
            .header(header::CONTENT_TYPE, "application/json"),
        415,
        "api.unsupported_media",
    )
    .await;
    for encoding in ["gzip", "br", "identity,identity", ""] {
        error(
            server
                .post(&path, &json!({}))
                .header(header::CONTENT_ENCODING, encoding),
            415,
            "api.unsupported_media",
        )
        .await;
    }
    error(
        server
            .post(&path, &json!({}))
            .header(header::CONTENT_ENCODING, "identity")
            .header(header::CONTENT_ENCODING, "identity"),
        415,
        "api.unsupported_media",
    )
    .await;
    error(
        server.get(&format!("/v1/sessions/{sid}")).body("x"),
        400,
        "api.invalid_request",
    )
    .await;
    let (status, _, body) = server.raw(format!("POST {path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", server.address, MAX_INPUT_BYTES + 1)).await;
    assert_eq!(status, 413);
    assert_eq!(body["code"], "api.body_too_large");
    let chunks = futures_util::stream::iter(vec![
        Ok::<_, std::io::Error>(vec![b' '; MAX_INPUT_BYTES / 2]),
        Ok(vec![b' '; MAX_INPUT_BYTES / 2 + 1]),
    ]);
    error(
        server
            .http
            .post(server.url(&path))
            .bearer_auth(TOKEN)
            .header(header::CONTENT_TYPE, "application/json")
            .body(reqwest::Body::wrap_stream(chunks)),
        413,
        "api.body_too_large",
    )
    .await;
    let (status, _, body) = server.raw(format!("POST {path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n1\r\n{{\r\nZ\r\n", server.address)).await;
    assert_eq!(status, 400);
    assert_eq!(body["code"], "api.invalid_request");
    error(
        server.get(&format!("/v1/sessions/{sid}")),
        503,
        "storage.io",
    )
    .await;
    for mime in [
        "application/json",
        "Application/JSON; Charset=UTF-8",
        "application/json; charset=\"utf-8\"",
    ] {
        response(
            server
                .http
                .post(server.url(&path))
                .bearer_auth(TOKEN)
                .header(header::CONTENT_TYPE, mime)
                .header(header::CONTENT_ENCODING, "IDENTITY")
                .body("{}"),
            200,
        )
        .await;
    }
    response(
        server
            .http
            .post(server.url(&path))
            .bearer_auth(TOKEN)
            .header(header::CONTENT_TYPE, "application/json")
            .body(format!("{{}}{}", " ".repeat(MAX_INPUT_BYTES - 2))),
        200,
    )
    .await;
    assert_eq!(session.manifest().await.unwrap().head_sequence(), 1);
    server.finish().await;
}

#[tokio::test]
async fn preflight_accepts_route_query_keys_without_opening_storage() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    for path in [
        format!("/v1/sessions?limit=1&after_id={sid}"),
        format!("/v1/sessions/{sid}/history?after={sid}:0&through=1&limit=1"),
        format!("/v1/sessions/{sid}/events?after={sid}:0"),
    ] {
        let reply = server
            .http
            .request(Method::OPTIONS, server.url(&path))
            .header(header::ORIGIN, ORIGIN)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), 204);
        assert_eq!(reply.headers()[header::ACCESS_CONTROL_ALLOW_METHODS], "GET");
    }
    for (path, method) in [
        ("/v1/sessions?limit=1", "POST"),
        ("/v1/sessions?token=x", "GET"),
        ("/v1/sessions?limit=1&limit=1", "GET"),
    ] {
        error(
            server
                .http
                .request(Method::OPTIONS, server.url(path))
                .header(header::ORIGIN, ORIGIN)
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, method),
            400,
            "api.invalid_request",
        )
        .await;
    }
    error(
        server.get(&format!("/v1/sessions/{sid}")),
        503,
        "storage.io",
    )
    .await;
    server.finish().await;
}
