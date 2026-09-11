use super::*;

struct NoRenewal;
#[async_trait::async_trait]
impl Exchange for NoRenewal {
    fn configured(&self) -> Result<()> {
        Err(failed())
    }
    async fn refresh(&self, _: &str) -> Result<Profile> {
        panic!("renewal must not run")
    }
}
pub(super) fn manager() -> (tempfile::TempDir, Store, AuthManager) {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::synthetic(temp.path().join("wi/auth"));
    let manager = AuthManager::synthetic(store.clone(), Arc::new(NoRenewal));
    (temp, store, manager)
}
pub(super) fn body() -> String {
    let exp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;
    let claims = serde_json::json!({"exp": exp, "https://api.openai.com/auth": {"chatgpt_account_id": "synthetic-account"}});
    let access = format!(
        "header.{}.signature",
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    serde_json::json!({"access_token": access, "refresh_token": "synthetic-refresh", "expires_in": 3600, "token_type": "Bearer", "id_token": "ignored-synthetic", "extra": {"ordinary": true}}).to_string()
}
pub(super) fn request(query: &str) -> String {
    format!("GET /auth/callback?{query} HTTP/1.1\r\nHost: localhost:1455\r\n\r\n")
}

pub(super) async fn server(
    response: String,
) -> (String, tokio::task::JoinHandle<(usize, String, String)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/oauth/token", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut count = 0;
        let mut headers = String::new();
        let mut form = String::new();
        while let Ok(Ok((mut socket, _))) =
            tokio::time::timeout(Duration::from_millis(500), listener.accept()).await
        {
            count += 1;
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                bytes.push(socket.read_u8().await.unwrap());
            }
            headers = String::from_utf8(bytes).unwrap();
            let length: usize = headers
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(|s| s.parse().unwrap())
                })
                .unwrap();
            let mut bytes = vec![0; length];
            socket.read_exact(&mut bytes).await.unwrap();
            form = String::from_utf8(bytes).unwrap();
            let _ = socket.write_all(response.as_bytes()).await;
        }
        (count, headers, form)
    });
    (endpoint, task)
}
pub(super) fn response(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}
