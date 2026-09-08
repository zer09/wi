use super::*;
use crate::providers::openai_codex::{
    auth::CredentialSource,
    managed_auth::AuthManager,
    managed_store::{Profile, Store},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};

const SENTINEL: &str = "synthetic-private-sentinel";
const OLD_REFRESH: &str = "synthetic +/&= ?%#é";
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn tokens(account: &str, exp: u64) -> serde_json::Value {
    let claims = serde_json::json!({"exp": exp, "https://api.openai.com/auth": {"chatgpt_account_id": account}});
    serde_json::json!({
        "access_token": format!("header.{}.signature", URL_SAFE_NO_PAD.encode(claims.to_string())),
        "refresh_token": "synthetic-rotated",
        "expires_in": 3600,
        "token_type": "Bearer"
    })
}
fn response(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}
fn adapter(endpoint: String) -> RefreshExchange {
    RefreshExchange {
        endpoint: Some(endpoint),
        timeouts: None,
    }
}
async fn request(socket: &mut TcpStream) -> String {
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut bytes = Vec::new();
        loop {
            let mut buf = [0; 1024];
            let n = socket.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buf[..n]);
            assert!(bytes.len() < 16384);
            if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                let head = std::str::from_utf8(&bytes[..end]).unwrap();
                let length: usize = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        String::from_utf8(bytes).unwrap()
    })
    .await
    .unwrap()
}
async fn server(
    reply: String,
    delay: Duration,
) -> (
    String,
    tokio::task::JoinHandle<Vec<String>>,
    oneshot::Receiver<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/oauth/token", listener.local_addr().unwrap());
    let (sent, received) = oneshot::channel();
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        if let Ok(Ok((mut socket, _))) =
            tokio::time::timeout(Duration::from_millis(500), listener.accept()).await
        {
            requests.push(request(&mut socket).await);
            let _ = sent.send(());
            tokio::time::sleep(delay).await;
            let _ = socket.write_all(reply.as_bytes()).await;
            let _ = socket.shutdown().await;
            // Keep accepting so a retry or followed redirect is observable, not hidden by refusal.
            while let Ok(Ok((mut socket, _))) =
                tokio::time::timeout(Duration::from_millis(100), listener.accept()).await
            {
                requests.push(request(&mut socket).await);
                let _ = socket
                    .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
                    .await;
                let _ = socket.shutdown().await;
            }
        }
        requests
    });
    (endpoint, task, received)
}
fn manager(endpoint: String, expires: u64) -> (tempfile::TempDir, Store, AuthManager) {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::synthetic(temp.path().join("wi/auth"));
    let manager = AuthManager::synthetic(store.clone(), Arc::new(adapter(endpoint)));
    for (name, account) in [("a", "synthetic-account"), ("b", "other-account")] {
        manager
            .login(
                name,
                Profile {
                    incarnation: "replaced-by-login".into(),
                    account: account.into(),
                    access: "synthetic-old-access".into(),
                    refresh: OLD_REFRESH.into(),
                    expires,
                    enabled: true,
                    reauth: false,
                },
                false,
            )
            .unwrap();
    }
    (temp, store, manager)
}
fn sanitized(error: GatewayError) {
    let display = error.to_string();
    let debug = format!("{error:?}");
    for text in [display, debug] {
        assert!(text.contains("renewal"));
        for secret in [
            SENTINEL,
            OLD_REFRESH,
            "http://",
            "access_token",
            "synthetic-rotated",
        ] {
            assert!(!text.contains(secret));
        }
        assert!(!text.contains("browser login"));
    }
}

#[tokio::test]
async fn refresh_http_explicit_fresh_rotation_form_and_metadata() {
    let jwt_expiry = now() + 1800;
    let body = tokens("synthetic-account", jwt_expiry);
    let (endpoint, server, _) = server(response(&body.to_string()), Duration::ZERO).await;
    let (_temp, store, manager) = manager(endpoint, now() + 3600);
    let before = serde_json::to_value(store.read().unwrap()).unwrap();
    let selected = manager.select(Some("a")).unwrap();
    manager.refresh("a").await.unwrap();
    selected.load().await.unwrap();
    let after = serde_json::to_value(store.read().unwrap()).unwrap();
    assert_eq!(after["profiles"]["b"], before["profiles"]["b"]);
    let a = &after["profiles"]["a"];
    assert_eq!(a["account"], before["profiles"]["a"]["account"]);
    assert_eq!(a["incarnation"], before["profiles"]["a"]["incarnation"]);
    assert_eq!(a["access"], body["access_token"]);
    assert_eq!(a["refresh"], body["refresh_token"]);
    assert_eq!(a["expires"], jwt_expiry); // JWT expiry bounds expires_in.
    let metadata = serde_json::to_value(manager.status("a").unwrap()).unwrap();
    assert_eq!(
        metadata
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        [
            "enabled",
            "expires_at_unix",
            "logged_in",
            "name",
            "requires_reauthentication"
        ]
    );
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 1);
    let (head, form) = requests[0].split_once("\r\n\r\n").unwrap();
    assert!(head.starts_with("POST /oauth/token HTTP/1.1\r\n"));
    let headers = head.to_ascii_lowercase();
    assert!(headers.contains(concat!(
        "user-agent: wi/",
        env!("CARGO_PKG_VERSION"),
        "\r\n"
    )));
    assert!(headers.contains("content-type: application/x-www-form-urlencoded\r\n"));
    assert!(!headers.contains("authorization:"));
    assert!(!headers.contains("cookie:"));
    let parsed = reqwest::Url::parse(&format!("http://localhost/?{form}")).unwrap();
    let fields: BTreeMap<_, _> = parsed.query_pairs().into_owned().collect();
    assert_eq!(parsed.query_pairs().count(), 3);
    assert_eq!(
        fields,
        BTreeMap::from([
            ("grant_type".into(), "refresh_token".into()),
            ("refresh_token".into(), OLD_REFRESH.into()),
            ("client_id".into(), CLIENT_ID.into()),
        ])
    );
}

#[tokio::test]
async fn refresh_http_fresh_prepare_and_read_operations_make_no_request() {
    let (endpoint, server, _) = server(String::new(), Duration::ZERO).await;
    let (_temp, store, manager) = manager(endpoint, now() + 3600);
    let before = serde_json::to_value(store.read().unwrap()).unwrap();
    assert_eq!(manager.list().unwrap().len(), 2);
    manager.status("a").unwrap();
    let source = manager.select(Some("a")).unwrap();
    source.load().await.unwrap();
    source.prepare_submission().await.unwrap();
    assert_eq!(serde_json::to_value(store.read().unwrap()).unwrap(), before);
    assert!(server.await.unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refresh_http_expired_concurrent_preparation_exchanges_once() {
    let (endpoint, server, _) = server(
        response(&tokens("synthetic-account", now() + 3600).to_string()),
        Duration::from_millis(50),
    )
    .await;
    let (_temp, store, manager) = manager(endpoint, 1);
    let a = manager.select(Some("a")).unwrap();
    let b = manager.select(Some("a")).unwrap();
    let (a, b) = tokio::join!(a.prepare_submission(), b.prepare_submission());
    a.unwrap();
    b.unwrap();
    assert_eq!(
        store.read().unwrap().profiles["a"].refresh,
        "synthetic-rotated"
    );
    assert_eq!(server.await.unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refresh_http_cancelled_waiter_still_persists_rotation() {
    let (endpoint, server, received) = server(
        response(&tokens("synthetic-account", now() + 3600).to_string()),
        Duration::from_millis(100),
    )
    .await;
    let (_temp, store, manager) = manager(endpoint, 1);
    let source = manager.select(Some("a")).unwrap();
    let waiter = tokio::spawn(async move { source.prepare_submission().await });
    received.await.unwrap();
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    let doc = tokio::task::spawn_blocking(move || store.read().unwrap())
        .await
        .unwrap();
    assert_eq!(doc.profiles["a"].refresh, "synthetic-rotated");
    assert!(!doc.profiles["a"].reauth);
    manager.select(Some("a")).unwrap().load().await.unwrap();
    assert_eq!(server.await.unwrap().len(), 1);
}

#[tokio::test]
async fn refresh_http_mismatch_and_rejection_leave_restart_guard() {
    for reply in [
        response(&tokens("other-account", now() + 3600).to_string()),
        format!(
            "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\n\r\n{SENTINEL}",
            SENTINEL.len()
        ),
    ] {
        let (endpoint, server, _) = server(reply, Duration::ZERO).await;
        let (_temp, store, manager) = manager(endpoint.clone(), now() + 3600);
        let selected = manager.select(Some("a")).unwrap();
        let before = serde_json::to_value(store.read().unwrap()).unwrap();
        sanitized(manager.refresh("a").await.unwrap_err());
        let fresh = AuthManager::synthetic(store.clone(), Arc::new(adapter(endpoint)));
        assert!(fresh.status("a").unwrap().requires_reauthentication);
        assert!(fresh.select(Some("a")).is_err());
        assert!(selected.load().await.is_err());
        assert!(selected.prepare_submission().await.is_err());
        assert!(fresh.refresh("a").await.is_err());
        let after = serde_json::to_value(store.read().unwrap()).unwrap();
        assert_eq!(
            after["profiles"]["a"]["refresh"],
            before["profiles"]["a"]["refresh"]
        );
        assert_eq!(after["profiles"]["b"], before["profiles"]["b"]);
        assert_eq!(server.await.unwrap().len(), 1);
    }
}

#[tokio::test]
async fn refresh_http_rejects_bounded_malformed_and_secret_error_responses_once() {
    let huge = "x".repeat(65537);
    for reply in [
        response(SENTINEL),
        format!(
            "HTTP/1.1 401 Unauthorized\r\nX-Secret: {SENTINEL}\r\nContent-Length: {}\r\n\r\n{SENTINEL}",
            SENTINEL.len()
        ),
        format!(
            "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 0\r\nContent-Length: {}\r\n\r\n{SENTINEL}",
            SENTINEL.len()
        ),
        String::new(),
        response(&huge),
        format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10001\r\n{huge}\r\n0\r\n\r\n"
        ),
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n10001\r\n{huge}\r\n0\r\n\r\n"
        ),
        format!("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{huge}"),
        "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort".into(),
    ] {
        let (endpoint, server, _) = server(reply, Duration::ZERO).await;
        sanitized(adapter(endpoint).refresh(OLD_REFRESH).await.err().unwrap());
        assert_eq!(server.await.unwrap().len(), 1);
    }
}

#[tokio::test]
async fn refresh_http_never_follows_redirect() {
    let (destination, target, _) = server(String::new(), Duration::ZERO).await;
    let reply = format!(
        "HTTP/1.1 307 Temporary Redirect\r\nLocation: {destination}/{SENTINEL}\r\nContent-Length: 0\r\n\r\n"
    );
    let (endpoint, server, _) = server(reply, Duration::ZERO).await;
    sanitized(adapter(endpoint).refresh(OLD_REFRESH).await.err().unwrap());
    assert_eq!(server.await.unwrap().len(), 1);
    assert!(target.await.unwrap().is_empty());
}

#[tokio::test]
async fn refresh_http_io_and_total_timeouts_are_bounded() {
    for (io, total, partial) in [(30, 500, false), (500, 30, false), (30, 500, true)] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut exchange = adapter(format!(
            "http://{}/oauth/token",
            listener.local_addr().unwrap()
        ));
        exchange.timeouts = Some((Duration::from_millis(io), Duration::from_millis(total)));
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            request(&mut socket).await;
            if partial {
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{")
                    .await
                    .unwrap();
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(
                tokio::time::timeout(Duration::from_millis(50), listener.accept())
                    .await
                    .is_err()
            );
        });
        let result =
            tokio::time::timeout(Duration::from_millis(300), exchange.refresh(OLD_REFRESH))
                .await
                .unwrap();
        sanitized(result.err().unwrap());
        server.await.unwrap();
    }
}

#[tokio::test]
async fn refresh_http_token_validation_requires_pair_account_and_checked_fresh_expiry() {
    let valid = tokens("synthetic-account", now() + 3600);
    let mut invalid = Vec::new();
    for key in ["access_token", "refresh_token", "expires_in"] {
        let mut body = valid.clone();
        body.as_object_mut().unwrap().remove(key);
        invalid.push(body);
    }
    for (key, value) in [
        ("access_token", serde_json::json!("")),
        ("access_token", serde_json::json!(SENTINEL)),
        ("refresh_token", serde_json::json!("")),
        ("refresh_token", serde_json::json!(" ")),
        ("expires_in", serde_json::json!(0)),
        ("expires_in", serde_json::json!(-1)),
        ("expires_in", serde_json::json!(1.5)),
        ("expires_in", serde_json::json!(u64::MAX)),
        ("expires_in", serde_json::json!(30)),
        ("token_type", serde_json::json!(" Bearer")),
        ("token_type", serde_json::json!("Bearer ")),
    ] {
        let mut body = valid.clone();
        body[key] = value;
        invalid.push(body);
    }
    invalid.push(tokens("", now() + 3600));
    invalid.push(tokens("bad\r\naccount", now() + 3600));
    invalid.push(tokens("synthetic-account", now() + 30));
    for claims in [
        serde_json::json!({"exp": now() + 3600}),
        serde_json::json!({"https://api.openai.com/auth": {"chatgpt_account_id": "synthetic-account"}}),
    ] {
        let mut body = valid.clone();
        body["access_token"] = serde_json::json!(format!(
            "h.{}.s",
            URL_SAFE_NO_PAD.encode(claims.to_string())
        ));
        invalid.push(body);
    }
    for body in invalid {
        let (endpoint, server, _) = server(response(&body.to_string()), Duration::ZERO).await;
        sanitized(adapter(endpoint).refresh(OLD_REFRESH).await.err().unwrap());
        assert_eq!(server.await.unwrap().len(), 1);
    }
    for token_type in [Some("bEaReR"), None] {
        let exp = now() + 200000;
        let mut body = tokens("synthetic-account", exp);
        body["expires_in"] = serde_json::json!(100000);
        if let Some(value) = token_type {
            body["token_type"] = serde_json::json!(value);
        } else {
            body.as_object_mut().unwrap().remove("token_type");
        }
        let (endpoint, server, _) = server(response(&body.to_string()), Duration::ZERO).await;
        let start = now();
        let p = adapter(endpoint).refresh(OLD_REFRESH).await.unwrap();
        assert!((start + 100000..=now() + 100000).contains(&p.expires));
        assert_eq!(server.await.unwrap().len(), 1);
    }
}

#[tokio::test]
async fn refresh_http_test_endpoints_reject_nonliteral_loopback_and_url_secrets() {
    for endpoint in [
        "http://localhost:9/",
        "https://127.0.0.1:9/",
        "http://192.0.2.1/",
        "http://user@127.0.0.1:9/",
        "http://127.0.0.1:9/#private",
    ] {
        let error = adapter(endpoint.into())
            .refresh(OLD_REFRESH)
            .await
            .err()
            .unwrap();
        assert_eq!(
            error.to_string(),
            failed("renewal endpoint rejected").to_string()
        );
    }
}
