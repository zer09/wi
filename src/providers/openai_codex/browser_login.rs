//! Opt-in compatibility experiment, not an officially supported OAuth integration.
use super::{
    auth::SubscriptionCredentials, managed_auth::AuthManager, managed_store::Profile,
    profile_selection::validate_name,
};
use crate::{GatewayError, Result};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    process::{Child, Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::Instant,
};
use zeroize::{Zeroize, Zeroizing};

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE: &str = "https://auth.openai.com/oauth/authorize";
const TOKEN: &str = "https://auth.openai.com/oauth/token";
const REDIRECT: &str = "http://localhost:1455/auth/callback";
const HOST: &str = "localhost:1455";
const TOTAL: Duration = Duration::from_secs(180);
const EXCHANGE: Duration = Duration::from_secs(30);

fn failed() -> GatewayError {
    GatewayError::InvalidAuth("experimental browser login failed; no retry was attempted")
}
fn expired() -> GatewayError {
    GatewayError::InvalidAuth("experimental browser login timed out")
}

#[derive(Serialize)]
pub struct LoginMetadata {
    pub account: String,
    pub expires_at_unix: u64,
    pub persisted: bool,
    pub eligible: bool,
}

/// The opt-in check precedes even default path resolution.
pub async fn login(account: String, experimental: bool, replace: bool) -> Result<LoginMetadata> {
    if !experimental {
        return Err(GatewayError::InvalidAuth(
            "browser login requires --experimental; provider support is unconfirmed",
        ));
    }
    validate_name(&account)?;
    let runtime = tokio::runtime::Handle::current();
    // The worker owns exchange and commit even if the caller stops waiting.
    tokio::task::spawn_blocking(move || {
        let result = run(
            &AuthManager::default_location()?,
            &account,
            replace,
            Settings::default(),
            &runtime,
        );
        if result.is_ok() {
            eprintln!("Wi login complete.");
        } else {
            eprintln!("Wi login failed.");
        }
        result
    })
    .await
    .map_err(|_| failed())?
}

#[derive(Default)]
struct Settings {
    #[cfg(test)]
    address: Option<SocketAddr>,
    #[cfg(test)]
    token: Option<String>,
    #[cfg(test)]
    launcher: Option<&'static str>,
    #[cfg(test)]
    total: Option<Duration>,
    #[cfg(test)]
    ready: Option<std::sync::mpsc::Sender<(SocketAddr, String)>>,
}
impl Settings {
    fn address(&self) -> SocketAddr {
        #[cfg(test)]
        if let Some(address) = self.address {
            return address;
        }
        SocketAddr::from(([127, 0, 0, 1], 1455))
    }
    fn token(&self) -> &str {
        #[cfg(test)]
        if let Some(token) = &self.token {
            return token;
        }
        TOKEN
    }
    fn launcher(&self) -> &str {
        #[cfg(test)]
        if let Some(launcher) = self.launcher {
            return launcher;
        }
        "/usr/bin/xdg-open"
    }
    fn total(&self) -> Duration {
        #[cfg(test)]
        if let Some(total) = self.total {
            return total;
        }
        TOTAL
    }
}

fn run(
    manager: &AuthManager,
    account: &str,
    replace: bool,
    settings: Settings,
    runtime: &tokio::runtime::Handle,
) -> Result<LoginMetadata> {
    let deadline = Instant::now() + settings.total();
    manager.preflight_login(account, replace)?;
    let (mut socket, profile) = runtime.block_on(async {
        tokio::time::timeout_at(deadline, async {
            let pending = Pending::bind(settings.address()).await?;
            let url = pending.authorization_url()?;
            #[cfg(test)]
            if let Some(ready) = &settings.ready {
                ready
                    .send((
                        pending.listener.local_addr().map_err(|_| failed())?,
                        url.to_string(),
                    ))
                    .map_err(|_| failed())?;
            }
            launch(settings.launcher(), &url).await?;
            eprintln!("Wi login waiting for browser authorization.");
            pending.receive(settings.token()).await
        })
        .await
        .map_err(|_| expired())?
    })?;
    if Instant::now() >= deadline {
        return Err(expired());
    }
    let expires_at_unix = profile.expires;
    // Guard cleanup can conservatively leave a committed profile ineligible.
    let eligible = manager.login_before(account, profile, replace, deadline.into_std())?;
    // A closed browser must not turn a durable commit into a reported failed login.
    runtime.block_on(async {
        let _ = tokio::time::timeout_at(deadline, socket.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 18\r\nConnection: close\r\nCache-Control: no-store\r\n\r\nWi login complete."
        )).await;
    });
    Ok(LoginMetadata {
        account: account.into(),
        expires_at_unix,
        persisted: true,
        eligible,
    })
}

struct Launcher(Child);
impl Drop for Launcher {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
async fn launch(program: &str, url: &Zeroizing<String>) -> Result<()> {
    let child = Command::new(program)
        .arg(url.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| GatewayError::InvalidAuth("browser launcher could not start"))?;
    let mut child = Launcher(child);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match child.0.try_wait().map_err(|_| failed())? {
                Some(status) if status.success() => return Ok(()),
                Some(_) => return Err(GatewayError::InvalidAuth("browser launcher failed")),
                None => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
    })
    .await
    .map_err(|_| GatewayError::InvalidAuth("browser launcher timed out"))?
}

struct Pending {
    listener: TcpListener,
    state: Zeroizing<String>,
    verifier: Zeroizing<String>,
}
impl Pending {
    async fn bind(address: SocketAddr) -> Result<Self> {
        if !address.ip().is_loopback() {
            return Err(failed());
        }
        let listener = TcpListener::bind(address).await.map_err(|_| GatewayError::InvalidAuth(
            "login callback port unavailable; no listener was cancelled and no alternate port was tried"
        ))?;
        let mut bytes = Zeroizing::new([0; 32]);
        SystemRandom::new()
            .fill(bytes.as_mut())
            .map_err(|_| failed())?;
        let state = Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes.as_ref()));
        SystemRandom::new()
            .fill(bytes.as_mut())
            .map_err(|_| failed())?;
        let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes.as_ref()));
        Ok(Self {
            listener,
            state,
            verifier,
        })
    }
    fn authorization_url(&self) -> Result<Zeroizing<String>> {
        let challenge =
            URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, self.verifier.as_bytes()));
        let mut url = reqwest::Url::parse(AUTHORIZE).map_err(|_| failed())?;
        url.query_pairs_mut().extend_pairs([
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", REDIRECT),
            ("scope", "openid profile email offline_access"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &self.state),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
            ("originator", "wi"),
        ]);
        Ok(Zeroizing::new(url.into()))
    }
    async fn receive(self, endpoint: &str) -> Result<(TcpStream, Profile)> {
        // Consume the listener after the first callback. Queued callbacks cannot exchange again.
        let (mut socket, peer) = self.listener.accept().await.map_err(|_| failed())?;
        drop(self.listener);
        if !peer.ip().is_loopback() {
            return Err(failed());
        }
        let mut bytes = Zeroizing::new(Vec::new());
        loop {
            bytes.push(socket.read_u8().await.map_err(|_| failed())?);
            if bytes.len() > 8192 {
                return Err(failed());
            }
            if bytes.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let code = callback(&bytes, &self.state)?;
        let profile = tokio::time::timeout(EXCHANGE, exchange(endpoint, &code, &self.verifier))
            .await
            .map_err(|_| expired())??;
        Ok((socket, profile))
    }
}

fn callback(bytes: &[u8], expected_state: &str) -> Result<Zeroizing<String>> {
    let request = std::str::from_utf8(bytes).map_err(|_| failed())?;
    if bytes.len() > 8192 || !request.ends_with("\r\n\r\n") {
        return Err(failed());
    }
    let mut lines = request[..request.len() - 4].split("\r\n");
    let mut parts = lines.next().ok_or_else(failed)?.split(' ');
    if parts.next() != Some("GET") {
        return Err(failed());
    }
    let target = parts.next().ok_or_else(failed)?;
    if !target.starts_with("/auth/callback?")
        || parts.next() != Some("HTTP/1.1")
        || parts.next().is_some()
        || target.contains('#')
        || !target.is_ascii()
        || target.bytes().any(|b| b.is_ascii_control())
    {
        return Err(failed());
    }
    let mut hosts = 0;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or_else(failed)?;
        if name.is_empty()
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || value.bytes().any(|b| b.is_ascii_control() && b != b'\t')
        {
            return Err(failed());
        }
        if name.eq_ignore_ascii_case("host") {
            hosts += 1;
            if value.trim() != HOST {
                return Err(failed());
            }
        }
        if name.eq_ignore_ascii_case("transfer-encoding")
            || (name.eq_ignore_ascii_case("content-length") && value.trim() != "0")
        {
            return Err(failed());
        }
    }
    if hosts != 1 {
        return Err(failed());
    }
    let query = target.strip_prefix("/auth/callback?").ok_or_else(failed)?;
    let mut state = None;
    let mut code = None;
    let mut error = None;
    let mut issuer = None;
    let mut description = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').ok_or_else(failed)?;
        let key = decode(key)?;
        let value = decode(value)?;
        let slot = match key.as_str() {
            "state" => &mut state,
            "code" => &mut code,
            "error" => &mut error,
            "iss" => &mut issuer,
            "error_description" => &mut description,
            _ => continue,
        };
        if slot.replace(value).is_some() {
            return Err(failed());
        }
    }
    if state.as_deref().map(|s| s.as_str()) != Some(expected_state)
        || issuer.as_deref().is_some_and(|s| s.as_str() != ISSUER)
    {
        return Err(failed());
    }
    if error.is_some() {
        if code.is_some() {
            return Err(failed());
        }
        return Err(GatewayError::InvalidAuth(
            "browser authorization was denied; no token exchange was attempted",
        ));
    }
    if description.is_some() {
        return Err(failed());
    }
    code.filter(|v| !v.trim().is_empty()).ok_or_else(failed)
}
fn decode(value: &str) -> Result<Zeroizing<String>> {
    let mut bytes = Zeroizing::new(Vec::new());
    let mut input = value.bytes();
    while let Some(byte) = input.next() {
        bytes.push(match byte {
            b'%' => {
                let a = (input.next().ok_or_else(failed)? as char)
                    .to_digit(16)
                    .ok_or_else(failed)?;
                let b = (input.next().ok_or_else(failed)? as char)
                    .to_digit(16)
                    .ok_or_else(failed)?;
                (a * 16 + b) as u8
            }
            b'+' => b' ',
            byte => byte,
        });
    }
    let decoded = std::str::from_utf8(&bytes).map_err(|_| failed())?;
    if decoded.chars().any(char::is_control) {
        return Err(failed());
    }
    Ok(Zeroizing::new(decoded.into()))
}

#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    #[serde(default = "bearer_type")]
    token_type: String,
    expires_in: u64,
}
fn bearer_type() -> String {
    "Bearer".into()
}
impl Drop for Tokens {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}
#[derive(Deserialize)]
struct Claims {
    #[serde(rename = "https://api.openai.com/auth")]
    auth: AccountClaim,
    exp: u64,
}
#[derive(Deserialize)]
struct AccountClaim {
    chatgpt_account_id: String,
}

// Only call with bytes obtained directly from the fixed, certificate-checked token endpoint.
// TLS authenticates the source. Decoding these claims is not JWT signature verification.
fn token_profile(body: &[u8]) -> Result<Profile> {
    if body.len() > 65536 {
        return Err(failed());
    }
    let mut tokens: Tokens = serde_json::from_slice(body).map_err(|_| failed())?;
    if tokens.access_token.trim().is_empty()
        || tokens.refresh_token.trim().is_empty()
        || !tokens.token_type.eq_ignore_ascii_case("Bearer")
        || tokens.expires_in == 0
    {
        return Err(failed());
    }
    let pieces: Vec<_> = tokens.access_token.split('.').collect();
    if pieces.len() != 3 || pieces.iter().any(|p| p.is_empty()) {
        return Err(failed());
    }
    let decoded = Zeroizing::new(URL_SAFE_NO_PAD.decode(pieces[1]).map_err(|_| failed())?);
    let claims: Claims = serde_json::from_slice(&decoded).map_err(|_| failed())?;
    if claims.auth.chatgpt_account_id.trim().is_empty() {
        return Err(failed());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| failed())?
        .as_secs();
    let expires = now
        .checked_add(tokens.expires_in)
        .ok_or_else(failed)?
        .min(claims.exp);
    SubscriptionCredentials::from_access_token(
        tokens.access_token.clone(),
        Some(claims.auth.chatgpt_account_id.clone()),
        Some(expires),
    )
    .map_err(|_| failed())?;
    Ok(Profile {
        incarnation: uuid::Uuid::new_v4().to_string(),
        account: claims.auth.chatgpt_account_id,
        access: std::mem::take(&mut tokens.access_token),
        refresh: std::mem::take(&mut tokens.refresh_token),
        expires,
        enabled: true,
        reauth: false,
    })
}
async fn exchange(endpoint: &str, code: &str, verifier: &str) -> Result<Profile> {
    // Production callers cannot supply endpoints. Test overrides must be literal loopback HTTP.
    if endpoint != TOKEN {
        #[cfg(not(test))]
        return Err(failed());
        #[cfg(test)]
        {
            let url = reqwest::Url::parse(endpoint).map_err(|_| failed())?;
            if url.scheme() != "http"
                || !url
                    .host_str()
                    .and_then(|h| h.parse::<std::net::IpAddr>().ok())
                    .is_some_and(|ip| ip.is_loopback())
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
            {
                return Err(failed());
            }
        }
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(10))
        .timeout(EXCHANGE)
        .user_agent(concat!("wi/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| failed())?;
    let form = reqwest::Url::parse_with_params(
        "http://localhost/",
        [
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", REDIRECT),
        ],
    )
    .map_err(|_| failed())?;
    let mut response = client
        .post(endpoint)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(form.query().ok_or_else(failed)?.to_string())
        .send()
        .await
        .map_err(|_| failed())?;
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > 65536) {
        return Err(failed());
    }
    let mut body = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| failed())? {
        if body.len() + chunk.len() > 65536 {
            return Err(failed());
        }
        body.extend_from_slice(&chunk);
    }
    token_profile(&body)
}

#[cfg(all(test, target_os = "linux"))]
#[path = "browser_login_tests.rs"]
mod tests;
