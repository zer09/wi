use super::*;
use crate::storage::test_hooks::{Action, Point};
use axum::http::HeaderMap;
use std::{path::Path, sync::atomic::Ordering};

const ASSETS: &[(&str, &str, &str)] = &[
    ("/", "web/index.html", "text/html; charset=utf-8"),
    ("/index.html", "web/index.html", "text/html; charset=utf-8"),
    ("/assets/wi.css", "web/style.css", "text/css; charset=utf-8"),
    (
        "/assets/api.js",
        "web/dist/api.js",
        "text/javascript; charset=utf-8",
    ),
    (
        "/assets/app.js",
        "web/dist/app.js",
        "text/javascript; charset=utf-8",
    ),
    (
        "/assets/client.js",
        "web/dist/client.js",
        "text/javascript; charset=utf-8",
    ),
    (
        "/assets/sse.js",
        "web/dist/sse.js",
        "text/javascript; charset=utf-8",
    ),
    (
        "/assets/state.js",
        "web/dist/state.js",
        "text/javascript; charset=utf-8",
    ),
    (
        "/assets/view.js",
        "web/dist/view.js",
        "text/javascript; charset=utf-8",
    ),
];
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

async fn exchange(server: &Server, request: String) -> (u16, HeaderMap, Vec<u8>) {
    let mut socket = TcpStream::connect(server.address).await.unwrap();
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    watchdog(socket.read_to_end(&mut bytes)).await.unwrap();
    let split = bytes
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .unwrap();
    let head = std::str::from_utf8(&bytes[..split]).unwrap();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let mut headers = HeaderMap::new();
    for line in lines {
        let (name, value) = line.split_once(':').unwrap();
        headers.append(
            name.parse::<axum::http::HeaderName>().unwrap(),
            value.trim().parse().unwrap(),
        );
    }
    (status, headers, bytes[split + 4..].to_vec())
}

fn security(headers: &HeaderMap) {
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
    assert_eq!(headers[header::VARY], "Origin");
    for absent in [
        header::SET_COOKIE,
        header::WWW_AUTHENTICATE,
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        header::LOCATION,
    ] {
        assert!(!headers.contains_key(absent));
    }
}

#[tokio::test]
async fn public_get_and_head_equal_checked_in_bytes_and_security_headers() {
    let server = Server::new().await;
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut modules: Vec<_> = std::fs::read_dir(root.join("web/dist"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    modules.sort();
    assert_eq!(
        modules,
        [
            "api.js",
            "app.js",
            "client.js",
            "sse.js",
            "state.js",
            "view.js"
        ]
    );
    for &(path, file, mime) in ASSETS {
        let expected = std::fs::read(root.join(file)).unwrap();
        let mut get_headers = None;
        for method in ["GET", "HEAD"] {
            let (status, headers, body) = exchange(
                &server,
                format!(
                    "{method} {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
                    server.address,
                ),
            )
            .await;
            assert_eq!(status, 200, "{method} {path}");
            security(&headers);
            assert_eq!(headers[header::CONTENT_TYPE], mime);
            assert_eq!(headers[header::CONTENT_LENGTH], expected.len().to_string());
            assert!(!headers.contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
            if file.ends_with(".html") {
                assert_eq!(headers[header::CONTENT_SECURITY_POLICY], CSP);
            } else {
                assert!(!headers.contains_key(header::CONTENT_SECURITY_POLICY));
            }
            if method == "GET" {
                assert_eq!(body, expected, "{path}");
                get_headers = Some(headers);
            } else {
                assert!(body.is_empty(), "HEAD sent bytes: {path}");
                for (name, value) in get_headers.as_ref().unwrap() {
                    if name != header::DATE {
                        assert_eq!(&headers[name], value);
                    }
                }
            }
        }
    }
    server.finish().await;
}

fn rejected(reply: (u16, HeaderMap, Vec<u8>), status: u16, code: &str, method: &str) {
    let (actual, headers, bytes) = reply;
    assert_eq!(actual, status);
    assert_eq!(headers[header::CONTENT_TYPE], "application/json");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert!(!headers.contains_key(header::CONTENT_SECURITY_POLICY));
    assert!(!headers.contains_key(header::SET_COOKIE));
    if status == 401 {
        assert_eq!(headers[header::WWW_AUTHENTICATE], "Bearer");
    }
    if method == "HEAD" {
        assert!(bytes.is_empty());
    } else {
        assert_eq!(headers[header::CONTENT_LENGTH], bytes.len().to_string());
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body,
            json!({
                "api_version": 1, "code": code, "stage": null,
                "certainty": "not_applicable", "acceptance": null, "notices": [],
            })
        );
    }
}

#[tokio::test]
async fn public_assets_ignore_credentials_and_touch_no_storage_or_run_work() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    session
        .rename(OperationId::new(), "private-title-canary".into())
        .await
        .unwrap();
    let hooks = session.test_hooks();
    hooks.arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    let before = hooks.measurements();
    for &(path, _, _) in ASSETS {
        for method in ["GET", "HEAD"] {
            for auth in [
                String::new(),
                "Authorization: private-provider-token-canary\r\n".into(),
                format!("Authorization: Bearer {}\r\n", "f".repeat(64)),
                format!("Authorization: Bearer {TOKEN}\r\n"),
                format!("Authorization: Bearer {TOKEN}\r\nAuthorization: malformed\r\n"),
            ] {
                let (status, headers, body) = exchange(&server, format!(
                    "{method} {path} HTTP/1.1\r\nHost: {}\r\n{auth}Cookie: private-cookie-canary\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", server.address,
                )).await;
                assert_eq!(status, 200);
                security(&headers);
                let text = std::str::from_utf8(&body).unwrap();
                for private in [
                    TOKEN,
                    ORIGIN,
                    "private-provider-token-canary",
                    "private-cookie-canary",
                    "private-data-canary",
                    "private-skills-canary",
                    "private-token-path-canary",
                    "private-instructions-canary",
                    "private-prepared-prompt-canary",
                    "private-provider-session-canary",
                    "private-native-canary",
                    "private-format-canary",
                    "private-title-canary",
                    "synthetic-model",
                    "http-test",
                    "sourceMappingURL",
                    ".js.map",
                    &sid.to_string(),
                    &server.workspace(),
                    &server.temp.path().to_string_lossy(),
                ] {
                    assert!(!text.contains(private), "private value in asset");
                    assert!(
                        !format!("{headers:?}").contains(private),
                        "private value in headers"
                    );
                }
            }
        }
    }
    assert_eq!(hooks.measurements(), before);
    assert_eq!(server.run_hooks.readers.load(Ordering::SeqCst), 0);
    assert_eq!(server.run_hooks.dispatched.load(Ordering::SeqCst), 0);
    assert!(server.run_hooks.thread.lock().unwrap().is_none());
    // The first protected open must still consume the hook, not any asset request.
    error(
        server.get(&format!("/v1/sessions/{sid}")),
        503,
        "storage.io",
    )
    .await;
    response(server.get(&format!("/v1/sessions/{sid}")), 200).await;
    server.finish().await;
}

#[tokio::test]
async fn public_assets_reject_queries_and_bodies_without_waiting_or_work() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    let hooks = session.test_hooks();
    hooks.arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    let before = hooks.measurements();
    for &(path, _, _) in ASSETS {
        for method in ["GET", "HEAD"] {
            for (query, framing, body) in [
                ("?", "", ""),
                ("?private-query-canary", "", ""),
                ("?token=private-query-canary", "", ""),
                ("", "Content-Length: 20\r\n", "private-body-canary!"),
                ("", "Content-Length: 100\r\n", ""),
                ("", "Content-Length: 100\r\nExpect: 100-continue\r\n", ""),
                ("", "Transfer-Encoding: chunked\r\n", "0\r\n\r\n"),
                ("", "Transfer-Encoding: chunked\r\n", "1\r\nx\r\n0\r\n\r\n"),
                ("", "Transfer-Encoding: chunked\r\n", ""),
            ] {
                let reply = exchange(&server, format!(
                    "{method} {path}{query} HTTP/1.1\r\nHost: {}\r\nAuthorization: malformed\r\n{framing}Connection: close\r\n\r\n{body}", server.address,
                )).await;
                rejected(reply, 400, "api.invalid_request", method);
            }
        }
    }
    assert_eq!(hooks.measurements(), before);
    assert_eq!(server.run_hooks.readers.load(Ordering::SeqCst), 0);
    assert_eq!(server.run_hooks.dispatched.load(Ordering::SeqCst), 0);
    error(
        server.get(&format!("/v1/sessions/{sid}")),
        503,
        "storage.io",
    )
    .await;
    server.finish().await;
}

#[tokio::test]
async fn public_assets_preserve_authority_origin_and_cors_boundaries() {
    let server = Server::new().await;
    for &(path, _, _) in ASSETS {
        for method in ["GET", "HEAD"] {
            for (target, host) in [
                (path.to_owned(), server.address.to_string()),
                (path.to_owned(), "Wi.Example.Test:443".into()),
                (
                    format!("https://WI.example.test:443{path}"),
                    "wi.example.test".into(),
                ),
                (
                    format!("http://{}{path}", server.address),
                    server.address.to_string(),
                ),
            ] {
                let (status, headers, _) = exchange(&server, format!(
                    "{method} {target} HTTP/1.1\r\nHost: {host}\r\nOrigin: https://WI.example.test:443\r\nConnection: close\r\n\r\n",
                )).await;
                assert_eq!(status, 200);
                security(&headers);
                assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], ORIGIN);
            }
            for (target, host) in [
                (path.to_owned(), "foreign.example".into()),
                (path.to_owned(), "wi.example.test:80".into()),
                (path.to_owned(), "wi.example.test,wi.example.test".into()),
                (
                    format!("https://foreign.example{path}"),
                    "wi.example.test".into(),
                ),
                (
                    format!("http://wi.example.test{path}"),
                    "wi.example.test".into(),
                ),
                (
                    format!("https://wi.example.test{path}"),
                    server.address.to_string(),
                ),
            ] {
                let reply = exchange(&server, format!(
                    "{method} {target} HTTP/1.1\r\nHost: {host}\r\nOrigin: {ORIGIN}\r\nConnection: close\r\n\r\n",
                )).await;
                assert!(!reply.1.contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
                rejected(reply, 421, "api.authority_invalid", method);
            }
            for origin in [
                "null",
                "https://foreign.example",
                "https://wi.example.test.evil",
                "http://wi.example.test",
                "https://wi.example.test:444",
                "https://wi.example.test/",
                "https://wi.example.test,https://wi.example.test",
                "https://wi.example.test\r\nOrigin: https://wi.example.test",
            ] {
                let reply = exchange(&server, format!(
                    "{method} {path} HTTP/1.1\r\nHost: {}\r\nOrigin: {origin}\r\nAuthorization: Bearer {TOKEN}\r\nConnection: close\r\n\r\n", server.address,
                )).await;
                assert!(!reply.1.contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
                rejected(reply, 403, "api.origin_forbidden", method);
            }
        }
    }
    rejected(
        exchange(
            &server,
            "GET / HTTP/1.0\r\nConnection: close\r\n\r\n".into(),
        )
        .await,
        421,
        "api.authority_invalid",
        "GET",
    );
    // Even a malformed static request must pass Host and Origin checks first.
    for (host, origin, status, code) in [
        ("foreign.example", "null", 421, "api.authority_invalid"),
        ("wi.example.test", "null", 403, "api.origin_forbidden"),
    ] {
        rejected(exchange(&server, format!(
            "GET /?private-query-canary HTTP/1.1\r\nHost: {host}\r\nOrigin: {origin}\r\nContent-Length: 100\r\nConnection: close\r\n\r\n",
        )).await, status, code, "GET");
    }
    server.finish().await;
}

#[tokio::test]
async fn unknown_encoded_traversal_source_and_method_paths_stay_protected() {
    let server = Server::new().await;
    for path in [
        "/unknown",
        "/assets",
        "/assets/",
        "/assets/unknown.js",
        "/assets/app.js/extra",
        "/assets/app.js.map",
        "/assets/api.js.map",
        "/assets/state.js.map",
        "/assets/sse.js.map",
        "/assets/client.js.map",
        "/assets/client.ts",
        "/assets/client.js/extra",
        "/assets/view.js.map",
        "/assets/view.ts",
        "/assets/view.js/extra",
        "/web/src/view.ts",
        "/assets/app.ts",
        "/src/app.ts",
        "/web/src/app.ts",
        "/web/dist/app.js",
        "/web/index.html",
        "/web/style.css",
        "/web/package.json",
        "/web/package-lock.json",
        "/config.json",
        "/private-skills-canary",
        "/Cargo.toml",
        "/../index.html",
        "/assets/../index.html",
        "/./index.html",
        "/%69ndex.html",
        "/assets/%61pp.js",
        "/assets/%2e%2e/index.html",
        "/assets%2fapp.js",
        "/assets%5capp.js",
        "/INDEX.html",
        "//index.html",
        "/assets/app.js;extra",
        "/v1",
        "/v1/assets/app.js",
    ] {
        for method in ["GET", "HEAD"] {
            for (auth, status, code) in [
                (String::new(), 401, "api.unauthorized"),
                (
                    format!("Authorization: Bearer {TOKEN}\r\n"),
                    404,
                    "api.not_found",
                ),
            ] {
                let reply = exchange(
                    &server,
                    format!(
                        "{method} {path} HTTP/1.1\r\nHost: {}\r\n{auth}Connection: close\r\n\r\n",
                        server.address,
                    ),
                )
                .await;
                rejected(reply, status, code, method);
            }
        }
    }
    for &(path, _, _) in ASSETS {
        for method in ["POST", "PUT", "PATCH", "DELETE", "TRACE"] {
            for (auth, status, code) in [
                (String::new(), 401, "api.unauthorized"),
                (
                    format!("Authorization: Bearer {TOKEN}\r\n"),
                    404,
                    "api.not_found",
                ),
            ] {
                // Unsupported methods retain the old router error, before body collection.
                rejected(exchange(&server, format!(
                    "{method} {path} HTTP/1.1\r\nHost: {}\r\n{auth}Content-Length: 100\r\nConnection: close\r\n\r\n", server.address,
                )).await, status, code, method);
            }
        }
    }
    server.finish().await;
}

#[tokio::test]
async fn public_page_does_not_authorize_api_routes_or_extend_preflight() {
    let server = Server::new().await;
    assert_eq!(
        server
            .http
            .get(server.url("/"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let sid = ApplicationSessionId::new();
    let rid = RunId::new();
    let oid = OperationId::new();
    for (method, path) in [
        ("GET", "/v1/settings".to_owned()),
        ("HEAD", "/v1/settings".to_owned()),
        ("GET", "/v1/sessions".to_owned()),
        ("POST", "/v1/sessions".to_owned()),
        ("GET", format!("/v1/sessions/{sid}")),
        ("POST", format!("/v1/sessions/{sid}/rename")),
        ("POST", format!("/v1/sessions/{sid}/refresh")),
        ("GET", format!("/v1/sessions/{sid}/history")),
        ("GET", format!("/v1/sessions/{sid}/events")),
        ("POST", format!("/v1/sessions/{sid}/runs")),
        ("GET", format!("/v1/sessions/{sid}/runs/{rid}")),
        ("POST", format!("/v1/sessions/{sid}/runs/{rid}/cancel")),
        ("GET", format!("/v1/sessions/{sid}/operations/{oid}")),
    ] {
        rejected(exchange(&server, format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nOrigin: {ORIGIN}\r\nContent-Length: 100\r\nConnection: close\r\n\r\n", server.address,
        )).await, 401, "api.unauthorized", method);
    }
    for &(path, _, _) in ASSETS {
        rejected(exchange(&server, format!(
            "OPTIONS {path} HTTP/1.1\r\nHost: {}\r\nOrigin: {ORIGIN}\r\nAccess-Control-Request-Method: GET\r\nConnection: close\r\n\r\n", server.address,
        )).await, 404, "api.not_found", "OPTIONS");
    }
    let (status, headers, body) = exchange(&server, format!(
        "OPTIONS /v1/settings HTTP/1.1\r\nHost: {}\r\nOrigin: {ORIGIN}\r\nAccess-Control-Request-Method: GET\r\nAccess-Control-Request-Headers: Authorization, Content-Type, Last-Event-ID\r\nConnection: close\r\n\r\n", server.address,
    )).await;
    assert_eq!(status, 204);
    assert!(body.is_empty());
    assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], ORIGIN);
    assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_METHODS], "GET");
    assert_eq!(
        headers[header::ACCESS_CONTROL_ALLOW_HEADERS],
        "Authorization, Content-Type, Last-Event-ID"
    );
    assert!(!headers.contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS));
    response(server.get("/v1/settings"), 200).await;
    server.finish().await;
}
