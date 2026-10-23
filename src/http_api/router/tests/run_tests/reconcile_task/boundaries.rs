use super::*;
use crate::MAX_INPUT_BYTES;

#[tokio::test]
async fn b3_auth_authority_and_origin_precede_open_and_body_collection() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let path = reconcile_path(&session);
    let body = command();
    let before = snapshot(&server, &session).await;
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    for token in [None, Some("wrong")] {
        let mut request = server.http.post(server.url(&path)).json(&body);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let reply = request.send().await.unwrap();
        assert_eq!(reply.status(), 401);
        assert_eq!(reply.headers()[header::WWW_AUTHENTICATE], "Bearer");
        assert_eq!(reply.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            reply.json::<Value>().await.unwrap()["code"],
            "api.unauthorized"
        );
    }
    error(
        server.post(&path, &body).bearer_auth(TOKEN),
        401,
        "api.unauthorized",
    )
    .await;
    for origin in [
        "null",
        "https://foreign.example",
        "https://wi.example.test.evil",
    ] {
        error(
            server.post(&path, &body).header(header::ORIGIN, origin),
            403,
            "api.origin_forbidden",
        )
        .await;
    }
    error(
        server
            .post(&path, &body)
            .header(header::ORIGIN, ORIGIN)
            .header(header::ORIGIN, ORIGIN),
        403,
        "api.origin_forbidden",
    )
    .await;
    for host in [
        "foreign.example",
        "wi.example.test:80",
        "user@wi.example.test",
        "127.1",
    ] {
        error(
            server.post(&path, &body).header(header::HOST, host),
            421,
            "api.authority_invalid",
        )
        .await;
    }
    let (status, headers, reply) = server.raw(format!("POST {path} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nCookie: owner={TOKEN}\r\nX-Forwarded-User: owner\r\nConnection: close\r\n\r\n", server.address)).await;
    assert_eq!(status, 401);
    assert!(headers.contains("www-authenticate: Bearer"));
    assert_eq!(reply["code"], "api.unauthorized");
    let (status, _, reply) = server.raw(format!("POST https://foreign.example{path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: 100\r\nConnection: close\r\n\r\n", server.address)).await;
    assert_eq!(status, 421);
    assert_eq!(reply["code"], "api.authority_invalid");
    // All rejected requests left the open hook untouched.
    error(server.post(&path, &body), 503, "storage.io").await;
    assert_eq!(snapshot(&server, &session).await, before);
    assert_eq!(effects(&server, &script), [0; 7]);
    server.finish().await;
}

#[tokio::test]
async fn b3_strict_ids_queries_objects_media_and_size_precede_storage() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let path = reconcile_path(&session);
    let body = command();
    let oid = operation(&body);
    let rid = run(&body);
    let before = snapshot(&server, &session).await;
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    for query in [
        "limit=1",
        "after=1",
        "before=x",
        "text=x",
        "token=x",
        "x=1&x=2",
        "limit=1&%6cimit=1",
        "x",
        "x=%ff",
        "x=%GG",
    ] {
        error(
            server.post(&format!("{path}?{query}"), &body),
            400,
            "api.invalid_request",
        )
        .await;
    }
    for sid in [
        "bad",
        "00000000-0000-0000-0000-000000000000",
        "11111111111141118111111111111111",
    ] {
        error(
            server.post(&format!("/v1/sessions/{sid}/runs/reconcile"), &body),
            400,
            "api.invalid_request",
        )
        .await;
    }
    for text in [
        "".into(),
        "{}".into(),
        "null".into(),
        "[]".into(),
        "true".into(),
        "{".into(),
        "{}{}".into(),
        format!(r#"["{oid}","{rid}","x"]"#),
        format!(r#"{{"operation_id":"{oid}","run_id":"{rid}"}}"#),
        format!(r#"{{"operation_id":"{oid}","run_id":"{rid}","text":null}}"#),
        format!(r#"{{"operation_id":"{oid}","run_id":"{rid}","text":1}}"#),
        format!(r#"{{"operation_id":"{oid}","run_id":"{rid}","text":"x","tools":[]}}"#),
        format!(r#"{{"operation_id":"{oid}","run_id":"{rid}","text":"x","text":"x"}}"#),
        format!(r#"{{"operation_id":"{oid}","run_id":"{rid}","text":"x","te\u0078t":"x"}}"#),
        format!(r#"{{"operation_id":"{oid}","operation_id":"{oid}","run_id":"{rid}","text":"x"}}"#),
        format!(r#"{{"operation_id":"{oid}","run_id":"{rid}","run_id":"{rid}","text":"x"}}"#),
        format!(r#"{{"operation_id":"bad","run_id":"{rid}","text":"x"}}"#),
        format!(
            r#"{{"operation_id":"{oid}","run_id":"00000000-0000-0000-0000-000000000000","text":"x"}}"#
        ),
    ] {
        error(
            server
                .http
                .post(server.url(&path))
                .bearer_auth(TOKEN)
                .header(header::CONTENT_TYPE, "application/json")
                .body(text),
            400,
            "api.invalid_request",
        )
        .await;
    }
    error(
        server
            .http
            .post(server.url(&path))
            .bearer_auth(TOKEN)
            .header(header::CONTENT_TYPE, "application/json")
            .body(vec![b'{', 0xff, b'}']),
        400,
        "api.invalid_request",
    )
    .await;
    error(
        server
            .http
            .post(server.url(&path))
            .bearer_auth(TOKEN)
            .body(body.to_string()),
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
    ] {
        error(
            server
                .http
                .post(server.url(&path))
                .bearer_auth(TOKEN)
                .header(header::CONTENT_TYPE, mime)
                .body(body.to_string()),
            415,
            "api.unsupported_media",
        )
        .await;
    }
    error(
        server
            .post(&path, &body)
            .header(header::CONTENT_TYPE, "application/json"),
        415,
        "api.unsupported_media",
    )
    .await;
    for encoding in ["gzip", "br", "identity,identity"] {
        error(
            server
                .post(&path, &body)
                .header(header::CONTENT_ENCODING, encoding),
            415,
            "api.unsupported_media",
        )
        .await;
    }
    error(
        server
            .post(&path, &body)
            .header(header::CONTENT_ENCODING, "identity")
            .header(header::CONTENT_ENCODING, "identity"),
        415,
        "api.unsupported_media",
    )
    .await;
    let (status, _, reply) = server.raw(format!("POST {path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", server.address, MAX_INPUT_BYTES + 1)).await;
    assert_eq!(status, 413);
    assert_eq!(reply["code"], "api.body_too_large");
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
    error(server.post(&path, &body), 503, "storage.io").await;
    let text = body.to_string();
    assert_eq!(
        response(
            server
                .http
                .post(server.url(&path))
                .bearer_auth(TOKEN)
                .header(header::CONTENT_TYPE, "Application/JSON; Charset=\"UTF-8\"")
                .header(header::CONTENT_ENCODING, "IDENTITY")
                .body(format!(
                    "{text}{}",
                    " ".repeat(MAX_INPUT_BYTES - text.len())
                )),
            200
        )
        .await,
        absent()
    );
    assert_eq!(snapshot(&server, &session).await, before);
    assert_eq!(effects(&server, &script), [0; 7]);
    server.finish().await;
}

#[tokio::test]
async fn b3_static_route_methods_preflight_and_literal_loopback_keep_common_headers() {
    let (server, script) = Script::server().await;
    let (temp, host) = server.stop_http().await;
    let server = Server::start_origin(temp, host, false, false, true).await;
    let session = server.session().await;
    let path = reconcile_path(&session);
    let before = snapshot(&server, &session).await;
    let origin = format!("http://{}", server.address);
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    for method in [
        Method::GET,
        Method::HEAD,
        Method::PUT,
        Method::PATCH,
        Method::DELETE,
    ] {
        let reply = server
            .http
            .request(method.clone(), server.url(&path))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), 405);
        assert_eq!(reply.headers()[header::ALLOW], "POST, OPTIONS");
        assert_eq!(reply.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(reply.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        if method == Method::HEAD {
            assert!(reply.bytes().await.unwrap().is_empty());
        } else {
            assert_eq!(
                reply.json::<Value>().await.unwrap()["code"],
                "api.method_not_allowed"
            );
        }
    }
    let request = || {
        server
            .http
            .request(Method::OPTIONS, server.url(&path))
            .header(header::ORIGIN, &origin)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
    };
    let reply = request()
        .header(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            "authorization, content-type, last-event-id",
        )
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 204);
    assert_eq!(
        reply.headers()[header::ACCESS_CONTROL_ALLOW_METHODS],
        "POST"
    );
    assert_eq!(reply.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], origin);
    assert_eq!(reply.headers()[header::VARY], "Origin");
    assert!(
        !reply
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
    );
    error(
        request().header(header::ACCESS_CONTROL_REQUEST_HEADERS, "x-secret"),
        400,
        "api.invalid_request",
    )
    .await;
    error(
        server
            .http
            .request(Method::OPTIONS, server.url(&path))
            .header(header::ORIGIN, &origin)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET"),
        405,
        "api.method_not_allowed",
    )
    .await;
    error(
        server
            .http
            .request(Method::OPTIONS, server.url(&path))
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST"),
        403,
        "api.origin_forbidden",
    )
    .await;
    error(
        server
            .http
            .request(Method::OPTIONS, server.url(&format!("{path}?text=x")))
            .header(header::ORIGIN, &origin)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST"),
        400,
        "api.invalid_request",
    )
    .await;
    error(
        server.post(&format!("{path}/"), &command()),
        404,
        "api.not_found",
    )
    .await;
    error(server.post(&path, &command()), 503, "storage.io").await;
    let reply = server
        .post(&path, &command())
        .header(header::ORIGIN, &origin)
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 200);
    assert_eq!(reply.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], origin);
    assert_eq!(reply.headers()[header::VARY], "Origin");
    assert_eq!(reply.json::<Value>().await.unwrap(), absent());
    assert_eq!(snapshot(&server, &session).await, before);
    assert_eq!(effects(&server, &script), [0; 7]);
    server.finish().await;
}
