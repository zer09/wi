use super::*;
use crate::storage::test_hooks::{Action, Point};

#[tokio::test]
async fn settings_headers_and_exact_normalized_origin() {
    let server = Server::new().await;
    let settings = response(server.get("/v1/settings"), 200).await;
    assert_eq!(
        settings,
        json!({"api_version":1,"workspaces":[server.workspace()],
        "provider_id":"http-test","model":"synthetic-model","provider_transport":"websocket","enable_add_numbers":false})
    );
    for origin in [ORIGIN, "https://WI.Example.Test:443"] {
        let reply = server
            .get("/v1/settings")
            .header(header::ORIGIN, origin)
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), StatusCode::OK);
        assert_eq!(reply.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], ORIGIN);
        assert_eq!(reply.headers()[header::VARY], "Origin");
        assert!(
            !reply
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
        );
    }
    for origin in [
        "null",
        "https://other.example.test",
        "https://wi.example.test.evil",
        "https://wi.example.test/",
        "https://wi.example.test?x",
        "https://wi.example.test:444",
        "http://wi.example.test",
        "https://wi.example.test,https://wi.example.test",
    ] {
        error(
            server.get("/v1/settings").header(header::ORIGIN, origin),
            403,
            "api.origin_forbidden",
        )
        .await;
    }
    error(
        server
            .get("/v1/settings")
            .header(header::ORIGIN, ORIGIN)
            .header(header::ORIGIN, ORIGIN),
        403,
        "api.origin_forbidden",
    )
    .await;
    let native = server.get("/v1/settings").send().await.unwrap();
    assert!(
        !native
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
    );
    server.finish().await;
}

#[tokio::test]
async fn authority_and_absolute_form_agreement_over_tcp() {
    let server = Server::new().await;
    for host in [
        "wi.example.test",
        "Wi.Example.Test:443",
        &server.address.to_string(),
    ] {
        response(server.get("/v1/settings").header(header::HOST, host), 200).await;
    }
    for host in [
        "foreign.example",
        "wi.example.test:80",
        "wi.example.test:444",
        "wi.example.test,wi.example.test",
        "wi.example.test:",
        "user@wi.example.test",
        "127.1",
    ] {
        error(
            server.get("/v1/settings").header(header::HOST, host),
            421,
            "api.authority_invalid",
        )
        .await;
    }
    for (target, host, expected) in [
        (
            "https://WI.example.test:443/v1/settings".to_owned(),
            "wi.example.test".to_owned(),
            200,
        ),
        (
            format!("http://{}/v1/settings", server.address),
            server.address.to_string(),
            200,
        ),
        (
            "https://foreign.example/v1/settings".to_owned(),
            "wi.example.test".to_owned(),
            421,
        ),
        (
            "http://wi.example.test/v1/settings".to_owned(),
            "wi.example.test".to_owned(),
            421,
        ),
        (
            "https://wi.example.test/v1/settings".to_owned(),
            server.address.to_string(),
            421,
        ),
    ] {
        let (status, headers, body) = server.raw(format!("GET {target} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {TOKEN}\r\nConnection: close\r\n\r\n")).await;
        assert_eq!(status, expected);
        assert!(headers.contains("cache-control: no-store"));
        if status == 421 {
            assert_eq!(body["code"], "api.authority_invalid");
        }
    }
    let (status, _, body) = server
        .raw(format!(
            "GET /v1/settings HTTP/1.0\r\nAuthorization: Bearer {TOKEN}\r\n\r\n"
        ))
        .await;
    assert_eq!(status, 421);
    assert_eq!(body["code"], "api.authority_invalid");
    // Hyper rejects duplicate Host framing before the application. Test the same boundary directly too.
    let mut headers = axum::http::HeaderMap::new();
    headers.append(header::HOST, HeaderValue::from_static("wi.example.test"));
    headers.append(header::HOST, HeaderValue::from_static("wi.example.test"));
    assert!(boundary::single(&headers, "host").is_err());
    server.finish().await;
}

#[tokio::test]
async fn gates_precede_every_storage_open_and_stalled_body() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    let rid = RunId::new();
    let oid = OperationId::new();
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    let paths = vec![
        ("GET", "/v1/settings".to_owned()),
        ("GET", "/v1/sessions".to_owned()),
        ("POST", "/v1/sessions".to_owned()),
        ("GET", format!("/v1/sessions/{sid}")),
        ("POST", format!("/v1/sessions/{sid}/rename")),
        ("POST", format!("/v1/sessions/{sid}/refresh")),
        ("GET", format!("/v1/sessions/{sid}/history")),
        ("GET", format!("/v1/sessions/{sid}/runs/{rid}")),
        ("POST", format!("/v1/sessions/{sid}/runs/{rid}/cancel")),
        ("GET", format!("/v1/sessions/{sid}/operations/{oid}")),
        ("POST", format!("/v1/sessions/{sid}/runs")),
        ("GET", format!("/v1/sessions/{sid}/events")),
        ("PATCH", "/unknown".to_owned()),
    ];
    let mut first = None;
    for (method, path) in paths {
        let (status, headers, body) = server.raw(format!("{method} {path} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nCookie: owner={TOKEN}\r\nX-Forwarded-User: owner\r\nConnection: close\r\n\r\n", server.address)).await;
        assert_eq!(status, 401);
        assert!(headers.contains("www-authenticate: Bearer"));
        if let Some(first) = &first {
            assert_eq!(first, &body);
        } else {
            first = Some(body);
        }
    }
    for value in [
        "bad".to_owned(),
        format!("Bearer {}", "f".repeat(64)),
        format!("Basic {TOKEN}"),
        format!("Bearer  {TOKEN}"),
        format!("Bearer\t{TOKEN}"),
        format!("Bearer {TOKEN}, Bearer {TOKEN}"),
    ] {
        let reply = error(
            server
                .http
                .get(server.url("/v1/settings"))
                .header(header::AUTHORIZATION, value),
            401,
            "api.unauthorized",
        )
        .await;
        assert_eq!(reply, first.clone().unwrap());
    }
    error(
        server.get("/v1/settings").bearer_auth(TOKEN),
        401,
        "api.unauthorized",
    )
    .await;
    error(
        server
            .http
            .get(server.url(&format!("/v1/settings?token={TOKEN}"))),
        401,
        "api.unauthorized",
    )
    .await;
    for (extra, status, code) in [
        (
            "Origin: https://foreign.example\r\n".to_owned(),
            403,
            "api.origin_forbidden",
        ),
        ("".to_owned(), 421, "api.authority_invalid"),
    ] {
        let host = if status == 421 {
            "foreign.example".to_owned()
        } else {
            server.address.to_string()
        };
        let (actual, _, body) = server.raw(format!("POST /v1/sessions/{sid}/rename HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {TOKEN}\r\n{extra}Content-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n")).await;
        assert_eq!(actual, status);
        assert_eq!(body["code"], code);
    }
    // The fail-on-open hook survives all rejected requests and fires on the first authorized read.
    error(
        server.get(&format!("/v1/sessions/{sid}")),
        503,
        "storage.io",
    )
    .await;
    response(server.get(&format!("/v1/sessions/{sid}")), 200).await;
    assert_eq!(session.manifest().await.unwrap().head_sequence(), 1);
    response(
        server
            .http
            .get(server.url("/v1/settings"))
            .header(header::AUTHORIZATION, format!("bEaReR {TOKEN}")),
        200,
    )
    .await;
    server.finish().await;
}

#[tokio::test]
async fn route_aware_preflight_and_method_path_errors_do_not_open_storage() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    for (path, method) in [
        ("/v1/settings".to_owned(), "GET"),
        ("/v1/sessions".to_owned(), "POST"),
        (format!("/v1/sessions/{sid}/rename"), "POST"),
        (format!("/v1/sessions/{sid}/history"), "GET"),
        (format!("/v1/sessions/{sid}/events"), "GET"),
        (format!("/v1/sessions/{sid}/runs"), "POST"),
    ] {
        let reply = server
            .http
            .request(Method::OPTIONS, server.url(&path))
            .header(header::ORIGIN, ORIGIN)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, method)
            .header(
                header::ACCESS_CONTROL_REQUEST_HEADERS,
                "authorization, CONTENT-TYPE, Last-Event-ID",
            )
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), 204);
        assert_eq!(reply.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], ORIGIN);
        assert_eq!(
            reply.headers()[header::ACCESS_CONTROL_ALLOW_METHODS],
            method
        );
        assert_eq!(
            reply.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS],
            "Authorization, Content-Type, Last-Event-ID"
        );
        assert_eq!(reply.headers()[header::CACHE_CONTROL], "no-store");
        assert!(
            !reply
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
        );
    }
    for (path, method, headers, status, code) in [
        ("/unknown", "GET", "Authorization", 404, "api.not_found"),
        (
            "/v1/settings",
            "POST",
            "Authorization",
            405,
            "api.method_not_allowed",
        ),
        (
            "/v1/settings",
            "DELETE",
            "Authorization",
            405,
            "api.method_not_allowed",
        ),
        (
            "/v1/settings",
            "GET",
            "X-Canary",
            400,
            "api.invalid_request",
        ),
        (
            "/v1/settings",
            "GET",
            "Authorization, Authorization",
            400,
            "api.invalid_request",
        ),
    ] {
        error(
            server
                .http
                .request(Method::OPTIONS, server.url(path))
                .header(header::ORIGIN, ORIGIN)
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, method)
                .header(header::ACCESS_CONTROL_REQUEST_HEADERS, headers),
            status,
            code,
        )
        .await;
    }
    error(
        server
            .http
            .request(Method::OPTIONS, server.url("/v1/settings"))
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET"),
        403,
        "api.origin_forbidden",
    )
    .await;
    error(
        server
            .http
            .request(Method::OPTIONS, server.url("/v1/settings"))
            .header(header::ORIGIN, ORIGIN),
        400,
        "api.invalid_request",
    )
    .await;
    error(server.get("/unknown"), 404, "api.not_found").await;
    for method in [Method::PUT, Method::PATCH, Method::DELETE] {
        let reply = server
            .http
            .request(method, server.url("/v1/settings"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), 405);
        assert_eq!(reply.headers()[header::ALLOW], "GET, OPTIONS");
    }
    let head = server
        .http
        .head(server.url("/v1/settings"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(head.status(), 405);
    error(
        server.post(&format!("/v1/sessions/{sid}/events"), &json!({})),
        405,
        "api.method_not_allowed",
    )
    .await;
    error(
        server.post(&format!("/v1/sessions/{sid}/runs"), &json!({})),
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
    server.finish().await;
}
