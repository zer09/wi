use super::*;

#[tokio::test]
async fn b1_strict_queries_methods_bodies_media_ids_and_encoded_entry_segments_before_open() {
    let server = Server::new().await;
    let session = server.session().await;
    let writer = Writer::accept(&session, "anchor").await;
    let page = session
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    let entry = page.block().unwrap().human().entry_id();
    let address = addressed(&session, &writer.run, entry);
    let paths = [
        base(&session),
        address.clone(),
        format!("{}/content", base(&session)),
    ];
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    for query in [
        "before=x&before=y",
        "within=x&within=y",
        "before=x&within=y",
        "limit=1",
        "after=1",
        "through=1",
        "cursor=x",
        "extra=x",
        "before=x&%62efore=y",
        "before",
        "before=%GG",
    ] {
        error(
            server.get(&format!("{}?{query}", paths[0])),
            400,
            "api.invalid_request",
        )
        .await;
    }
    for query in ["before=", "within=x", "before=g11c.bad", "within=g11l.bad"] {
        error(
            server.get(&format!("{}?{query}", paths[0])),
            400,
            "api.conversation_cursor_invalid",
        )
        .await;
    }
    for query in ["", "?before=x", "?cursor=x&cursor=y", "?cursor=x&extra=y"] {
        error(
            server.get(&format!("{}{query}", paths[2])),
            400,
            "api.invalid_request",
        )
        .await;
    }
    error(
        server.get(&format!("{}?cursor=", paths[2])),
        400,
        "api.conversation_cursor_invalid",
    )
    .await;
    error(
        server.get(&format!("{}?limit=1", paths[1])),
        400,
        "api.invalid_request",
    )
    .await;
    for id in [
        "e%3A02%3A0",
        "e%3A2%3A0%2F..",
        "%2Fe%3A2%3A0",
        "e%253A2%253A0",
        "e%3A2%3A0%00",
        "e%3A2%3A0+",
        "%ff",
        "%",
        "e%3A2%3A0%5Cpath",
    ] {
        error(
            server.get(&format!("{}/entries/{}/{id}", base(&session), writer.run)),
            400,
            "api.conversation_cursor_invalid",
        )
        .await;
    }
    for path in [
        "/v1/sessions/not-uuid/conversation".to_owned(),
        format!("{}/entries/not-uuid/e%3A2%3A0", base(&session)),
    ] {
        error(server.get(&path), 400, "api.invalid_request").await;
    }
    for path in &paths {
        let reply = server
            .http
            .post(server.url(path))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(reply.headers()[header::ALLOW], "GET, OPTIONS");
        assert_eq!(reply.headers()[header::CACHE_CONTROL], "no-store");
        let head = server
            .http
            .head(server.url(path))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(head.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert!(head.bytes().await.unwrap().is_empty());
        let preflight = server
            .http
            .request(Method::OPTIONS, server.url(path))
            .header(header::ORIGIN, ORIGIN)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
            .header(
                header::ACCESS_CONTROL_REQUEST_HEADERS,
                "authorization, content-type",
            )
            .send()
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            ORIGIN
        );
    }
    for path in [&paths[0], &paths[1]] {
        error(server.get(path).body(" "), 400, "api.invalid_request").await;
        error(
            server.get(path).header(header::CONTENT_ENCODING, "gzip"),
            415,
            "api.unsupported_media",
        )
        .await;
        error(
            server
                .get(path)
                .body(vec![b'x'; crate::MAX_INPUT_BYTES + 1]),
            413,
            "api.body_too_large",
        )
        .await;
    }
    error(server.get(&paths[0]), 503, "storage.io").await;
    for encoded in [
        entry.to_string(),
        entry.to_string().replace(':', "%3a"),
        entry.to_string().replace('e', "%65").replace(':', "%3A"),
    ] {
        let path = format!("{}/entries/{}/{encoded}", base(&session), writer.run);
        let expected = session
            .conversation_entry(writer.run.clone(), *entry)
            .await
            .unwrap();
        exact(server.get(&path), DisplayJson::EntryPage(&expected)).await;
    }
    error(
        server.get(&format!("{}/events", base(&session))),
        400,
        "api.invalid_request",
    )
    .await;
    for tail in ["changes", "entries", "content/extra"] {
        error(
            server.get(&format!("{}/{tail}", base(&session))),
            404,
            "api.not_found",
        )
        .await;
    }
    server.finish().await;
}

#[tokio::test]
async fn b1_every_route_retains_bearer_host_origin_and_common_headers_before_storage() {
    let server = Server::new().await;
    let session = server.session().await;
    let writer = Writer::accept(&session, &"雪".repeat(20000)).await;
    let page = session
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    let human = page.block().unwrap().human();
    let paths = [
        base(&session),
        addressed(&session, &writer.run, human.entry_id()),
        format!(
            "{}/content?cursor={}",
            base(&session),
            human.earlier_content().unwrap()
        ),
    ];
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    for path in paths {
        let reply = server.http.get(server.url(&path)).send().await.unwrap();
        assert_eq!(reply.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(reply.headers()[header::WWW_AUTHENTICATE], "Bearer");
        assert_eq!(reply.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(reply.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        error(
            server
                .get(&path)
                .header(header::ORIGIN, "http://127.0.0.1:1"),
            403,
            "api.origin_forbidden",
        )
        .await;
        error(
            server.get(&path).header(header::HOST, "wrong.example.test"),
            421,
            "api.authority_invalid",
        )
        .await;
        let (status, _, body) = server.raw(format!("GET {path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {TOKEN}\r\nAuthorization: Bearer {TOKEN}\r\n\r\n", server.address)).await;
        assert_eq!(status, 401);
        assert_eq!(body["code"], "api.unauthorized");
    }
    error(server.get(&base(&session)), 503, "storage.io").await;
    let expected = session
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    exact(server.get(&base(&session)), DisplayJson::Page(&expected)).await;
    server.finish().await;
}

#[tokio::test]
async fn b1_literal_loopback_http_origin_works_without_tls_proxy_or_another_auth_mode() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join("workspace")).unwrap();
    let store = SessionStore::open(temp.path().join("private-data-canary"))
        .await
        .unwrap();
    let host = Arc::new(RunHost::new(store, Arc::new(Gateway::new())).unwrap());
    let server = Server::start_origin(temp, host, false, false, true).await;
    let session = server.session().await;
    let writer = Writer::accept(&session, &"雪".repeat(20000)).await;
    let page = session
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    let human = page.block().unwrap().human();
    let origin = format!("http://{}", server.address);
    for path in [
        base(&session),
        addressed(&session, &writer.run, human.entry_id()),
        format!(
            "{}/content?cursor={}",
            base(&session),
            human.earlier_content().unwrap()
        ),
    ] {
        let reply = server
            .get(&path)
            .header(header::ORIGIN, &origin)
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), StatusCode::OK);
        assert_eq!(reply.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], origin);
        assert!(
            reply
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
                .is_none()
        );
        assert!(reply.headers().get(header::SET_COOKIE).is_none());
        let denied = server
            .http
            .get(server.url(&path))
            .header(header::ORIGIN, &origin)
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    }
    error(
        server.get(&base(&session)).header(header::ORIGIN, ORIGIN),
        403,
        "api.origin_forbidden",
    )
    .await;
    server.finish().await;
}
