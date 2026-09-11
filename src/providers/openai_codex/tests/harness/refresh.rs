use super::*;

pub(super) const SENTINEL: &str = "synthetic-private-sentinel";
pub(super) const OLD_REFRESH: &str = "synthetic +/&= ?%#é";
pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
pub(super) fn tokens(account: &str, exp: u64) -> serde_json::Value {
    let claims = serde_json::json!({"exp": exp, "https://api.openai.com/auth": {"chatgpt_account_id": account}});
    serde_json::json!({
        "access_token": format!("header.{}.signature", URL_SAFE_NO_PAD.encode(claims.to_string())),
        "refresh_token": "synthetic-rotated",
        "expires_in": 3600,
        "token_type": "Bearer"
    })
}
pub(super) fn response(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}
pub(super) fn adapter(endpoint: String) -> RefreshExchange {
    RefreshExchange {
        endpoint: Some(endpoint),
        timeouts: None,
    }
}
pub(super) async fn request(socket: &mut TcpStream) -> String {
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
pub(super) async fn server(
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
pub(super) fn manager(endpoint: String, expires: u64) -> (tempfile::TempDir, Store, AuthManager) {
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
pub(super) fn sanitized(error: GatewayError) {
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
