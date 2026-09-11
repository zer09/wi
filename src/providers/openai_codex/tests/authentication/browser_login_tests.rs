use super::super::{
    auth::CredentialSource,
    managed_auth::Exchange,
    managed_store::{Store, fail_next},
};
use super::*;
use std::sync::{Arc, mpsc};

#[path = "../harness/browser_login.rs"]
mod harness;
use harness::*;

#[tokio::test]
async fn browser_opt_in_precedes_invalid_alias_and_paths() {
    let error = login("../invalid".into(), false, false)
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("requires --experimental"));
    assert!(login("../invalid".into(), true, false).await.is_err());
}

#[test]
fn browser_callback_strict_validation_and_sanitized_denial() {
    assert_eq!(
        callback(
            request("state=expected&code=a%2Bb&iss=https%3A%2F%2Fauth.openai.com").as_bytes(),
            "expected"
        )
        .unwrap()
        .as_str(),
        "a+b"
    );
    for query in [
        "code=secret",
        "state=expected",
        "state=wrong&code=secret",
        "state=expected&state=expected&code=secret",
        "state=expected&code=a&code=b",
        "state=expected&code=",
        "state=expected&code=%",
        "state=expected&code=%ff",
        "state=expected&code=%0A",
        "state=expected&code=a#fragment",
        "state=expected&code=a&other=%",
        "state=expected&code=a&other=%ff",
        "state=expected&code=a&other=%0A",
        "state=expected&code=a&%=x",
        "state=expected&code=a&%ff=x",
        "state=expected&code=a&%0A=x",
        "state=expected&code=a&iss=https://elsewhere.invalid",
        "state=expected&code=a&iss=https://auth.openai.com&iss=https://auth.openai.com",
        "state=expected&code=a&error=secret",
        "state=expected&code=a&error_description=secret",
        "state=expected&error=secret&error=secret",
        "state=expected&code=a&&",
        "state=expected&code=a&bad",
    ] {
        assert!(
            callback(request(query).as_bytes(), "expected").is_err(),
            "invalid callback accepted"
        );
    }
    let denied = callback(
        request("state=expected&error=access_denied&error_description=private-description")
            .as_bytes(),
        "expected",
    )
    .err()
    .unwrap()
    .to_string();
    assert!(denied.contains("denied"));
    assert!(!denied.contains("private-description"));
    assert_eq!(
        callback(
            request("state=expected&code=a&other=x").as_bytes(),
            "expected"
        )
        .unwrap()
        .as_str(),
        "a"
    );
    let valid = request("state=expected&code=secret");
    for bad in [
        valid.replace("GET", "POST"),
        valid.replace("/auth/callback", "/other"),
        valid.replace("HTTP/1.1", "HTTP/1.0"),
        valid.replace("Host: localhost:1455\r\n", ""),
        valid.replace("localhost:1455", "127.0.0.1:1455"),
        valid.replace("Host:", " Host:"),
        valid.replace(
            "Host: localhost:1455",
            "Host: localhost:1455\r\nhOsT: localhost:1455",
        ),
        valid.replace("Host: localhost:1455", "Host: localhost:1455\r\nMalformed"),
        valid.replace(
            "Host: localhost:1455",
            "Host: localhost:1455\r\nContent-Length: 1",
        ),
        valid.replace(
            "Host: localhost:1455",
            "Host: localhost:1455\r\nTransfer-Encoding: chunked",
        ),
        valid.replace("\r\n", "\n"),
        request(&format!("state=expected&code={}", "a".repeat(8192))),
    ] {
        assert!(callback(bad.as_bytes(), "expected").is_err());
    }
}

#[test]
fn browser_tokens_bounded_and_identity_from_response_only() {
    let valid = body();
    let p = token_profile(valid.as_bytes()).unwrap();
    assert_eq!(p.account, "synthetic-account");
    assert!(!p.access.contains("ignored-synthetic"));
    let mut no_type: serde_json::Value = serde_json::from_str(&valid).unwrap();
    no_type.as_object_mut().unwrap().remove("token_type");
    assert!(token_profile(no_type.to_string().as_bytes()).is_ok());
    for (key, value) in [
        ("access_token", serde_json::json!("")),
        ("refresh_token", serde_json::json!(" ")),
        ("token_type", serde_json::json!("Basic")),
        ("token_type", serde_json::json!(" Bearer")),
        ("token_type", serde_json::json!("Bearer ")),
        ("token_type", serde_json::json!("BearerSuffix")),
        ("token_type", serde_json::Value::Null),
        ("expires_in", serde_json::json!(0)),
        ("expires_in", serde_json::json!(-1)),
        ("expires_in", serde_json::json!(u64::MAX)),
        ("access_token", serde_json::json!("not-a-jwt")),
    ] {
        let mut bad: serde_json::Value = serde_json::from_str(&valid).unwrap();
        bad[key] = value;
        assert!(token_profile(bad.to_string().as_bytes()).is_err());
    }
    for claims in [
        serde_json::json!({}),
        serde_json::json!({"exp": 1, "https://api.openai.com/auth": {"chatgpt_account_id": "synthetic"}}),
        serde_json::json!({"exp": "wrong", "https://api.openai.com/auth": {"chatgpt_account_id": "synthetic"}}),
        serde_json::json!({"exp": u64::MAX, "https://api.openai.com/auth": {"chatgpt_account_id": ""}}),
    ] {
        let mut bad: serde_json::Value = serde_json::from_str(&valid).unwrap();
        bad["access_token"] = serde_json::json!(format!(
            "h.{}.s",
            URL_SAFE_NO_PAD.encode(claims.to_string())
        ));
        assert!(token_profile(bad.to_string().as_bytes()).is_err());
    }
    assert!(token_profile(b"not-json").is_err());
    assert!(token_profile(&vec![b' '; 65537]).is_err());
    assert!(
        token_profile(
            valid
                .replace(
                    "\"expires_in\":3600",
                    "\"expires_in\":3600,\"expires_in\":3600"
                )
                .as_bytes()
        )
        .is_err()
    );
}

#[test]
fn browser_token_type_is_case_insensitive() {
    for token_type in ["bearer", "BEARER"] {
        let mut tokens: serde_json::Value = serde_json::from_str(&body()).unwrap();
        tokens["token_type"] = serde_json::json!(token_type);
        assert!(token_profile(tokens.to_string().as_bytes()).is_ok());
    }
}

#[test]
fn browser_long_expiry_keeps_earlier_jwt_limit() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    for exp in [now + 864000, now + 3600] {
        let mut tokens: serde_json::Value = serde_json::from_str(&body()).unwrap();
        tokens["expires_in"] = serde_json::json!(864000);
        let claims = serde_json::json!({
            "exp": exp,
            "https://api.openai.com/auth": {"chatgpt_account_id": "synthetic-account"}
        });
        tokens["access_token"] = serde_json::json!(format!(
            "h.{}.s",
            URL_SAFE_NO_PAD.encode(claims.to_string())
        ));
        assert_eq!(
            token_profile(tokens.to_string().as_bytes())
                .unwrap()
                .expires,
            exp
        );
    }
}

#[tokio::test]
async fn browser_pkce_authorize_shape_port_and_launcher_failures() {
    let pending = Pending::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let other = Pending::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    assert_ne!(pending.state.as_str(), other.state.as_str());
    assert_ne!(pending.verifier.as_str(), other.verifier.as_str());
    let url = reqwest::Url::parse(&pending.authorization_url().unwrap()).unwrap();
    assert_eq!(url.origin().ascii_serialization(), ISSUER);
    assert_eq!(url.path(), "/oauth/authorize");
    let pairs: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(pairs.len(), 10);
    for (k, v) in [
        ("client_id", CLIENT_ID),
        ("response_type", "code"),
        ("redirect_uri", REDIRECT),
        ("scope", "openid profile email offline_access"),
        ("code_challenge_method", "S256"),
        ("id_token_add_organizations", "true"),
        ("codex_cli_simplified_flow", "true"),
        ("originator", "wi"),
    ] {
        assert_eq!(pairs[k], v);
    }
    assert_eq!(pairs["state"], pending.state.as_str());
    assert_eq!(
        pairs["code_challenge"],
        URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, pending.verifier.as_bytes()))
    );
    assert!(
        Pending::bind(pending.listener.local_addr().unwrap())
            .await
            .is_err()
    );
    let url = Zeroizing::new("http://127.0.0.1/synthetic-secret".into());
    assert!(launch("/usr/bin/true", &url).await.is_ok());
    assert!(launch("/usr/bin/false", &url).await.is_err());
    assert!(
        launch("/nonexistent-wi-synthetic-launcher", &url)
            .await
            .is_err()
    );
    // /usr/bin/yes is harmless, ignores the argument, and blocks when its output is suppressed.
    assert!(
        tokio::time::timeout(Duration::from_millis(30), launch("/usr/bin/yes", &url))
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn browser_actual_store_login_and_two_callbacks_exchange_once() {
    let (_temp, store, manager) = manager();
    let (endpoint, server) = server(response(&body())).await;
    let pending = Pending::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let address = pending.listener.local_addr().unwrap();
    let verifier = pending.verifier.to_string();
    let mut callbacks = Vec::new();
    for _ in 0..2 {
        let mut socket = TcpStream::connect(address).await.unwrap();
        socket
            .write_all(
                request(&format!(
                    "state={}&code=synthetic%2Bcode&other=x",
                    pending.state.as_str()
                ))
                .as_bytes(),
            )
            .await
            .unwrap();
        callbacks.push(socket);
    }
    let (_socket, profile) = pending.receive(&endpoint).await.unwrap();
    assert!(manager.login("selected", profile, false).unwrap());
    let source = manager.select(Some("selected")).unwrap();
    let before = std::fs::read(_temp.path().join("wi/auth/openai-codex.json")).unwrap();
    assert_eq!(
        source.load().await.unwrap().account_id(),
        "synthetic-account"
    );
    assert_eq!(
        before,
        std::fs::read(_temp.path().join("wi/auth/openai-codex.json")).unwrap()
    );
    assert_eq!(store.read().unwrap().profiles.len(), 1);
    let (count, headers, form) = server.await.unwrap();
    assert_eq!(count, 1);
    assert!(headers.starts_with("POST /oauth/token HTTP/1.1\r\n"));
    let headers = headers.to_ascii_lowercase();
    assert!(headers.contains("content-type: application/x-www-form-urlencoded"));
    assert!(headers.contains(concat!("user-agent: wi/", env!("CARGO_PKG_VERSION"))));
    assert!(!headers.contains("authorization:"));
    assert!(!headers.contains("chatgpt-account-id"));
    let form = reqwest::Url::parse(&format!("http://localhost/?{form}")).unwrap();
    let pairs: std::collections::BTreeMap<_, _> = form.query_pairs().into_owned().collect();
    assert_eq!(pairs.len(), 5);
    for (key, value) in [
        ("grant_type", "authorization_code"),
        ("client_id", CLIENT_ID),
        ("code", "synthetic+code"),
        ("code_verifier", &verifier),
        ("redirect_uri", REDIRECT),
    ] {
        assert_eq!(pairs[key], value);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn browser_worker_persists_before_success_and_survives_waiter_cancellation() {
    let (_temp, store, manager) = manager();
    let (endpoint, server) = server(response(&body())).await;
    let (tx, rx) = mpsc::channel();
    let runtime = tokio::runtime::Handle::current();
    let worker = tokio::task::spawn_blocking(move || {
        run(
            &manager,
            "selected",
            false,
            Settings {
                address: Some("127.0.0.1:0".parse().unwrap()),
                token: Some(endpoint),
                launcher: Some("/usr/bin/true"),
                total: Some(Duration::from_secs(3)),
                ready: Some(tx),
            },
            &runtime,
        )
    });
    let (address, url) =
        tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(2)).unwrap())
            .await
            .unwrap();
    worker.abort(); // Blocking ownership has started; cancellation cannot discard the candidate.
    let url = reqwest::Url::parse(&url).unwrap();
    let state = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let mut socket = TcpStream::connect(address).await.unwrap();
    socket
        .write_all(request(&format!("state={state}&code=synthetic-code")).as_bytes())
        .await
        .unwrap();
    let mut reply = String::new();
    socket.read_to_string(&mut reply).await.unwrap();
    assert!(reply.ends_with("Wi login complete."));
    assert!(!store.read().unwrap().profiles["selected"].reauth);
    let result = worker.await.unwrap().unwrap();
    assert!(result.persisted && result.eligible);
    let metadata = serde_json::to_string(&result).unwrap();
    assert!(!metadata.contains("synthetic-account"));
    assert!(!metadata.contains("synthetic-refresh"));
    assert_eq!(server.await.unwrap().0, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn browser_worker_preflight_and_deadline_no_usable_login() {
    for launcher in ["/usr/bin/true", "/usr/bin/false"] {
        let (_temp, store, manager) = manager();
        let runtime = tokio::runtime::Handle::current();
        let result = tokio::task::spawn_blocking(move || {
            run(
                &manager,
                "selected",
                false,
                Settings {
                    address: Some("127.0.0.1:0".parse().unwrap()),
                    token: Some("http://127.0.0.1:9/token".into()),
                    launcher: Some(launcher),
                    total: Some(Duration::from_millis(80)),
                    ready: None,
                },
                &runtime,
            )
        })
        .await
        .unwrap();
        assert!(result.is_err());
        assert!(store.read().unwrap().profiles.is_empty());
    }
    let (temp, _store, manager) = manager();
    std::fs::create_dir(temp.path().join("wi")).unwrap();
    assert!(manager.preflight_login("selected", false).is_err());
}

#[tokio::test]
async fn browser_failed_denial_and_exchange_never_create_profile() {
    for (query, reply) in [
        ("error=access_denied&error_description=secret", response(&body())),
        ("code=synthetic", "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n".into()),
        ("code=synthetic", response("malformed")),
        ("code=synthetic", response(&"x".repeat(65537))),
        ("code=synthetic", "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/forbidden\r\nContent-Length: 0\r\n\r\n".into()),
        ("code=synthetic", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10001\r\n".to_string() + &"x".repeat(65537) + "\r\n0\r\n\r\n"),
    ] {
        let (_temp, store, _manager) = manager();
        let (endpoint, server) = server(reply).await;
        let pending = Pending::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let mut socket = TcpStream::connect(pending.listener.local_addr().unwrap()).await.unwrap();
        socket.write_all(request(&format!("state={}&{query}", pending.state.as_str())).as_bytes()).await.unwrap();
        assert!(pending.receive(&endpoint).await.is_err());
        assert!(store.read().unwrap().profiles.is_empty());
        assert_eq!(server.await.unwrap().0, usize::from(!query.starts_with("error=")));
    }
}

#[tokio::test]
async fn browser_edge_actual_callback_bounds_and_stalled_exchange() {
    for oversized in [false, true] {
        let pending = Pending::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let (endpoint, server) = server(response(&body())).await;
        let mut socket = TcpStream::connect(pending.listener.local_addr().unwrap())
            .await
            .unwrap();
        let bytes = if oversized {
            vec![b'x'; 8193]
        } else {
            b"GET /auth/callback?state=%zz&code=x HTTP/1.1\r\nHost: localhost:1455\r\n\r\n".to_vec()
        };
        socket.write_all(&bytes).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), pending.receive(&endpoint))
                .await
                .unwrap()
                .is_err()
        );
        assert_eq!(server.await.unwrap().0, 0);
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/token", listener.local_addr().unwrap());
    let pending = Pending::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let mut socket = TcpStream::connect(pending.listener.local_addr().unwrap())
        .await
        .unwrap();
    socket
        .write_all(request(&format!("state={}&code=synthetic", pending.state.as_str())).as_bytes())
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), pending.receive(&endpoint))
            .await
            .is_err()
    );
}

#[test]
fn browser_edge_preflight_rejects_document_without_lock_and_expired_commit() {
    use std::os::unix::fs::PermissionsExt;
    let (temp, store, manager) = manager();
    manager.preflight_login("new", false).unwrap();
    let root = temp.path().join("wi/auth");
    std::fs::remove_file(root.join("update.lock")).unwrap();
    std::fs::write(root.join("openai-codex.json"), b"{}").unwrap();
    std::fs::set_permissions(
        root.join("openai-codex.json"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(manager.preflight_login("new", false).is_err());
    assert!(!root.join("update.lock").exists());
    drop(store);
    let (_temp, store, manager) = self::manager();
    assert!(
        manager
            .login_before(
                "new",
                token_profile(body().as_bytes()).unwrap(),
                false,
                std::time::Instant::now()
            )
            .is_err()
    );
    assert!(store.read().unwrap().profiles.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn browser_edge_occupied_port_precedes_launcher() {
    let (_temp, store, manager) = manager();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let runtime = tokio::runtime::Handle::current();
    let error = tokio::task::spawn_blocking(move || {
        run(
            &manager,
            "selected",
            false,
            Settings {
                address: Some(address),
                token: Some("http://127.0.0.1:9/token".into()),
                launcher: Some("/nonexistent-wi-synthetic-launcher"),
                total: Some(Duration::from_secs(1)),
                ready: None,
            },
            &runtime,
        )
    })
    .await
    .unwrap()
    .err()
    .unwrap();
    assert!(error.to_string().contains("callback port unavailable"));
    assert!(store.read().unwrap().profiles.is_empty());
}

#[test]
fn browser_replacement_intent_and_post_rename_failure_guards_candidate_only() {
    for phase in ["write", "file-sync", "rename", "directory-sync"] {
        let (_temp, store, manager) = manager();
        manager
            .login("selected", token_profile(body().as_bytes()).unwrap(), false)
            .unwrap();
        manager
            .login(
                "unrelated",
                token_profile(body().as_bytes()).unwrap(),
                false,
            )
            .unwrap();
        let before = store.read().unwrap();
        assert!(manager.preflight_login("selected", false).is_err());
        assert!(
            manager
                .login("selected", token_profile(body().as_bytes()).unwrap(), false)
                .is_err()
        );
        fail_next(phase);
        assert!(
            manager
                .login("selected", token_profile(body().as_bytes()).unwrap(), true)
                .is_err()
        );
        let after = store.read().unwrap();
        assert_eq!(
            after.profiles["unrelated"].incarnation,
            before.profiles["unrelated"].incarnation
        );
        if phase == "directory-sync" {
            assert!(after.profiles["selected"].reauth);
            assert!(manager.select(Some("selected")).is_err());
        } else {
            assert_eq!(
                after.profiles["selected"].incarnation,
                before.profiles["selected"].incarnation
            );
            assert!(!after.profiles["selected"].reauth);
        }
        manager
            .login("selected", token_profile(body().as_bytes()).unwrap(), true)
            .unwrap();
        assert_ne!(
            store.read().unwrap().profiles["selected"].incarnation,
            before.profiles["selected"].incarnation
        );
        assert!(manager.select(Some("selected")).is_ok());
    }
    let (_temp, store, manager) = manager();
    fail_next("directory-sync");
    assert!(
        manager
            .login("new", token_profile(body().as_bytes()).unwrap(), false)
            .is_err()
    );
    assert!(store.read().unwrap().profiles["new"].reauth);
    assert!(manager.select(Some("new")).is_err());
}
