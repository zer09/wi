//! Synthetic OAuth contract only. No production configuration or browser integration.
//! Identity below is attested by the injected synthetic server, not decoded JWT hints.
use super::managed_store::Profile;
use crate::{GatewayError, Result};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
};
use std::{net::SocketAddr, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use zeroize::Zeroizing;

fn invalid() -> GatewayError {
    GatewayError::InvalidAuth("synthetic OAuth exchange failed")
}
struct PendingLogin {
    listener: TcpListener,
    state: Zeroizing<String>,
    verifier: Zeroizing<String>,
    challenge: String,
}
impl PendingLogin {
    async fn bind(address: SocketAddr) -> Result<Self> {
        if !address.ip().is_loopback() {
            return Err(invalid());
        }
        let listener = TcpListener::bind(address).await.map_err(|_| invalid())?;
        let mut bytes = [0; 32];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| invalid())?;
        let state = Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes));
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| invalid())?;
        let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes));
        let challenge =
            URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, verifier.as_bytes()));
        Ok(Self {
            listener,
            state,
            verifier,
            challenge,
        })
    }
    fn redirect(&self) -> Result<String> {
        Ok(format!(
            "http://{}/callback",
            self.listener.local_addr().map_err(|_| invalid())?
        ))
    }
    fn authorization_url(&self, endpoint: &str) -> Result<reqwest::Url> {
        let mut url = loopback_url(endpoint)?;
        url.query_pairs_mut().extend_pairs([
            ("client_id", "synthetic-wi-client"),
            ("response_type", "code"),
            ("redirect_uri", self.redirect()?.as_str()),
            ("scope", "synthetic"),
            ("state", &self.state),
            ("code_challenge", &self.challenge),
            ("code_challenge_method", "S256"),
        ]);
        Ok(url)
    }
    async fn complete(
        self,
        token_endpoint: &str,
        account: &str,
        deadline: Duration,
    ) -> Result<Profile> {
        let endpoint = loopback_url(token_endpoint)?;
        tokio::time::timeout(deadline, async {
            let (mut socket, peer) = self.listener.accept().await.map_err(|_| invalid())?;
            if !peer.ip().is_loopback() {
                return Err(invalid());
            }
            let mut bytes = Zeroizing::new(Vec::new());
            loop {
                let byte = socket.read_u8().await.map_err(|_| invalid())?;
                bytes.push(byte);
                if bytes.len() > 8192 {
                    return Err(invalid());
                }
                if bytes.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let request = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
            let line = request.lines().next().ok_or_else(invalid)?;
            let mut parts = line.split(' ');
            if parts.next() != Some("GET") {
                return Err(invalid());
            }
            let target = parts.next().ok_or_else(invalid)?;
            if !target.starts_with("/callback?")
                || parts.next() != Some("HTTP/1.1")
                || parts.next().is_some()
            {
                return Err(invalid());
            }
            let expected_host = self
                .listener
                .local_addr()
                .map_err(|_| invalid())?
                .to_string();
            let hosts: Vec<_> = request
                .lines()
                .skip(1)
                .filter_map(|line| line.split_once(':'))
                .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
                .collect();
            if hosts.len() != 1 || hosts[0].1.trim() != expected_host {
                return Err(invalid());
            }
            let url = reqwest::Url::parse(&format!("http://{expected_host}{target}"))
                .map_err(|_| invalid())?;
            let pairs: Vec<_> = url.query_pairs().collect();
            if pairs.len() != 2 {
                return Err(invalid());
            }
            let states: Vec<_> = pairs.iter().filter(|(name, _)| name == "state").collect();
            let codes: Vec<_> = pairs.iter().filter(|(name, _)| name == "code").collect();
            if states.len() != 1
                || codes.len() != 1
                || states[0].1 != self.state.as_str()
                || codes[0].1.is_empty()
            {
                return Err(invalid());
            }
            let _ = rustls::crypto::ring::default_provider().install_default();
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .timeout(deadline)
                .build()
                .map_err(|_| invalid())?;
            let form = reqwest::Url::parse_with_params(
                "http://127.0.0.1/",
                [
                    ("grant_type", "authorization_code"),
                    ("client_id", "synthetic-wi-client"),
                    ("redirect_uri", self.redirect()?.as_str()),
                    ("code", codes[0].1.as_ref()),
                    ("code_verifier", self.verifier.as_str()),
                ],
            )
            .map_err(|_| invalid())?;
            let mut response = client
                .post(endpoint)
                .header("content-type", "application/x-www-form-urlencoded")
                .body(form.query().ok_or_else(invalid)?.to_string())
                .send()
                .await
                .map_err(|_| invalid())?;
            if !response.status().is_success() {
                return Err(invalid());
            }
            let mut body = Zeroizing::new(Vec::new());
            while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
                if body.len() + chunk.len() > 65536 {
                    return Err(invalid());
                }
                body.extend_from_slice(&chunk);
            }
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Tokens {
                access_token: String,
                refresh_token: String,
                token_type: String,
                expires_in: u64,
                synthetic_attested_account: String,
            }
            let tokens: Tokens = serde_json::from_slice(&body).map_err(|_| invalid())?;
            if tokens.token_type != "Bearer"
                || tokens.access_token.is_empty()
                || tokens.refresh_token.is_empty()
                || tokens.expires_in <= 30
                || tokens.expires_in > 86400
                || tokens.synthetic_attested_account != account
            {
                return Err(invalid());
            }
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| invalid())?
                .as_secs();
            super::auth::SubscriptionCredentials::from_access_token(
                tokens.access_token.clone(),
                Some(account.into()),
                Some(now + tokens.expires_in),
            )?;
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nComplete",
                )
                .await
                .map_err(|_| invalid())?;
            Ok(Profile {
                incarnation: uuid::Uuid::new_v4().to_string(),
                account: account.into(),
                access: tokens.access_token,
                refresh: tokens.refresh_token,
                expires: now + tokens.expires_in,
                enabled: true,
                reauth: false,
            })
        })
        .await
        .map_err(|_| invalid())?
    }
}
fn loopback_url(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value).map_err(|_| invalid())?;
    let ip: std::net::IpAddr = url
        .host_str()
        .ok_or_else(invalid)?
        .parse()
        .map_err(|_| invalid())?;
    if url.scheme() != "http"
        || !ip.is_loopback()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(url)
}
#[tokio::test]
async fn offline_oauth_pkce_state_timeout_and_port_conflict() {
    let login = PendingLogin::bind("127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let url = login
        .authorization_url("http://127.0.0.1:9/authorize")
        .unwrap();
    assert!(
        url.query_pairs()
            .any(|(k, v)| k == "code_challenge_method" && v == "S256")
    );
    assert_eq!(
        login.challenge,
        URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, login.verifier.as_bytes()))
    );
    assert!(
        PendingLogin::bind(login.listener.local_addr().unwrap())
            .await
            .is_err()
    );
    assert!(
        login
            .complete(
                "http://127.0.0.1:9/token",
                "synthetic",
                Duration::from_millis(10)
            )
            .await
            .is_err()
    );
    assert!(loopback_url("https://example.com/token").is_err());
}
#[tokio::test]
async fn offline_oauth_wrong_duplicate_callback_and_redaction() {
    for query in [
        "state=wrong&code=private-code",
        "state=wrong&state=wrong&code=private-code",
    ] {
        let login = PendingLogin::bind("127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let address = login.listener.local_addr().unwrap();
        let request = format!("GET /callback?{query} HTTP/1.1\r\nHost: {address}\r\n\r\n");
        let send = tokio::spawn(async move {
            let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
            stream.write_all(request.as_bytes()).await.unwrap();
        });
        let error = login
            .complete(
                "http://127.0.0.1:9/token",
                "synthetic",
                Duration::from_secs(1),
            )
            .await
            .err()
            .unwrap();
        assert!(!error.to_string().contains("private-code"));
        send.await.unwrap();
    }
}
#[cfg(target_os = "linux")]
#[tokio::test]
async fn offline_oauth_two_valid_callbacks_exchange_and_persist_once() {
    tokio::time::timeout(Duration::from_secs(4), async {
        let login = PendingLogin::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let address = login.listener.local_addr().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/token", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut requests = 0;
            while let Ok(Ok((mut socket, _))) = tokio::time::timeout(Duration::from_millis(300), listener.accept()).await {
                requests += 1;
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    headers.push(socket.read_u8().await.unwrap());
                }
                let length: usize = std::str::from_utf8(&headers).unwrap().lines()
                    .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length: ").map(|v| v.parse().unwrap())).unwrap();
                let mut body = vec![0; length];
                socket.read_exact(&mut body).await.unwrap();
                let body = r#"{"access_token":"synthetic-access","refresh_token":"synthetic-refresh","token_type":"Bearer","expires_in":3600,"synthetic_attested_account":"synthetic"}"#;
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
            requests
        });
        // Queue both complete valid requests before consuming the single-use boundary.
        let mut callbacks = Vec::new();
        let mut submitted = 0;
        for _ in 0..2 {
            let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
            socket.write_all(format!("GET /callback?state={}&code=synthetic-private-code HTTP/1.1\r\nHost: {address}\r\n\r\n", login.state.as_str()).as_bytes()).await.unwrap();
            submitted += 1;
            callbacks.push(socket);
        }
        assert_eq!(submitted, 2);
        let results = [login.complete(&endpoint, "synthetic", Duration::from_secs(2)).await];
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        struct NoRefresh;
        #[async_trait::async_trait]
        impl super::managed_auth::Exchange for NoRefresh {
            fn configured(&self) -> Result<()> { Err(invalid()) }
            async fn refresh(&self, _: &str) -> Result<Profile> { Err(invalid()) }
        }
        let temp = tempfile::tempdir().unwrap();
        let store = super::managed_store::Store::synthetic(temp.path().join("wi/auth"));
        let manager = super::managed_auth::AuthManager::synthetic(store.clone(), std::sync::Arc::new(NoRefresh));
        let mut persisted = 0;
        for result in results {
            manager.login("selected", result.unwrap(), false).unwrap();
            persisted += 1;
        }
        assert_eq!(persisted, 1);
        assert_eq!(store.read().unwrap().profiles.len(), 1);
        assert_eq!(server.await.unwrap(), 1);
        drop(callbacks); // No assertion about which callback wins or the losing socket's error.
    }).await.unwrap();
}
#[tokio::test]
async fn offline_oauth_success_and_malformed_token() {
    for valid in [true, false] {
        let login = PendingLogin::bind("127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let address = login.listener.local_addr().unwrap();
        let state = login.state.to_string();
        let challenge = login.challenge.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/token", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut data = Vec::new();
            loop {
                data.push(socket.read_u8().await.unwrap());
                if data.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let headers = String::from_utf8(data).unwrap();
            let length: usize = headers
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(|v| v.parse().unwrap())
                })
                .unwrap();
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            let form = reqwest::Url::parse(&format!(
                "http://127.0.0.1/?{}",
                String::from_utf8(body).unwrap()
            ))
            .unwrap();
            let verifier = form
                .query_pairs()
                .find(|(k, _)| k == "code_verifier")
                .unwrap()
                .1
                .into_owned();
            assert_eq!(
                challenge,
                URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, verifier.as_bytes()))
            );
            let body = if valid {
                r#"{"access_token":"synthetic-access","refresh_token":"synthetic-refresh","token_type":"Bearer","expires_in":3600,"synthetic_attested_account":"synthetic"}"#
            } else {
                r#"{"access_token":"secret-malformed"}"#
            };
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let callback = tokio::spawn(async move {
            let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
            socket.write_all(format!("GET /callback?state={state}&code=synthetic-code HTTP/1.1\r\nHost: {address}\r\n\r\n").as_bytes()).await.unwrap();
            let mut bytes = Vec::new();
            let _ = socket.read_to_end(&mut bytes).await;
        });
        let result = login
            .complete(&endpoint, "synthetic", Duration::from_secs(2))
            .await;
        assert_eq!(result.is_ok(), valid);
        match result {
            Err(error) => assert!(!error.to_string().contains("secret-malformed")),
            Ok(profile) => {
                assert_eq!(profile.account, "synthetic");
                #[cfg(target_os = "linux")]
                {
                    struct NoRefresh;
                    #[async_trait::async_trait]
                    impl super::managed_auth::Exchange for NoRefresh {
                        fn configured(&self) -> Result<()> {
                            Err(invalid())
                        }
                        async fn refresh(&self, _: &str) -> Result<Profile> {
                            Err(invalid())
                        }
                    }
                    let temp = tempfile::tempdir().unwrap();
                    let store = super::managed_store::Store::synthetic(temp.path().join("wi/auth"));
                    let manager = super::managed_auth::AuthManager::synthetic(
                        store.clone(),
                        std::sync::Arc::new(NoRefresh),
                    );
                    manager
                        .login(
                            "other",
                            Profile {
                                incarnation: uuid::Uuid::new_v4().to_string(),
                                account: "independent-account".into(),
                                access: "independent-access".into(),
                                refresh: "independent-refresh".into(),
                                expires: u64::MAX,
                                enabled: true,
                                reauth: false,
                            },
                            false,
                        )
                        .unwrap();
                    manager.login("selected", profile, false).unwrap();
                    assert_eq!(manager.list().unwrap().len(), 2);
                    assert_eq!(
                        store.read().unwrap().profiles["other"].refresh,
                        "independent-refresh"
                    );
                }
            }
        }
        server.await.unwrap();
        callback.await.unwrap();
    }
}
