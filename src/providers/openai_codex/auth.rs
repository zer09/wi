//! Read-only reuse of the caller's own Codex/Pi subscription credentials.
//! Refresh/id tokens and other providers' credentials are ignored on parsing.

use std::{
    fmt,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use base64::{
    Engine as _,
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
};
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use zeroize::Zeroizing;

use crate::{GatewayError, Result};

const MAX_AUTH_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthSource {
    Codex,
    Pi,
}

/// Deliberately neither Serialize nor Clone. Debug never shows secret values.
pub struct SubscriptionCredentials {
    access_token: Zeroizing<String>,
    account_id: String,
    expires_at: Option<u64>,
}

impl fmt::Debug for SubscriptionCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SubscriptionCredentials")
            .field("access_token", &"[REDACTED]")
            .field("account_id", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl SubscriptionCredentials {
    /// OAuth identity validation is performed by OpenAI. Local JWT decoding only
    /// supplies expiry/account hints; it is NOT cryptographic JWT verification.
    pub fn from_access_token(
        access_token: String,
        account_id: Option<String>,
        expires_at: Option<u64>,
    ) -> Result<Self> {
        let access_token = Zeroizing::new(access_token);
        if access_token.trim().is_empty() {
            return Err(GatewayError::InvalidAuth("missing OAuth access token"));
        }
        let (claim_account, claim_expiry) = jwt_hints(&access_token);
        let account_id = account_id
            .filter(|s| !s.trim().is_empty())
            .or(claim_account)
            .ok_or(GatewayError::InvalidAuth(
                "missing ChatGPT account identifier",
            ))?;
        let expires_at = match (expires_at, claim_expiry) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        let credentials = Self {
            access_token,
            account_id,
            expires_at,
        };
        // Reject CR/LF or other invalid header bytes before building a request.
        credentials.headers()?;
        credentials.ensure_fresh()?;
        Ok(credentials)
    }

    #[cfg(test)]
    pub(super) fn expire_for_test(&mut self) {
        self.expires_at = Some(1);
    }

    pub fn expires_at_unix(&self) -> Option<u64> {
        self.expires_at
    }

    pub(crate) fn account_id(&self) -> &str {
        &self.account_id
    }

    pub(crate) fn ensure_fresh(&self) -> Result<()> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| GatewayError::Clock)?
            .as_secs();
        if self
            .expires_at
            .is_some_and(|expiry| expiry <= now.saturating_add(30))
        {
            return Err(GatewayError::AuthExpired);
        }
        Ok(())
    }

    pub(crate) fn headers(&self) -> Result<HeaderMap> {
        let mut headers = HeaderMap::new();
        let bearer = Zeroizing::new(format!("Bearer {}", self.access_token.as_str()));
        let mut authorization = HeaderValue::try_from(bearer.as_str())
            .map_err(|_| GatewayError::InvalidAuth("access token is not a valid header value"))?;
        authorization.set_sensitive(true);
        let mut account = HeaderValue::try_from(self.account_id.as_str()).map_err(|_| {
            GatewayError::InvalidAuth("account identifier is not a valid header value")
        })?;
        account.set_sensitive(true);
        headers.insert(AUTHORIZATION, authorization);
        headers.insert("chatgpt-account-id", account);
        Ok(headers)
    }
}

/// Separate from Provider: a future first-party login/keyring reader can replace
/// this credential source without touching response parsing or gateway routing.
#[async_trait]
pub trait CredentialSource: Send + Sync {
    /// Separate preparation; external read-only sources remain no-ops.
    async fn prepare_submission(&self) -> Result<()> {
        Ok(())
    }
    async fn load(&self) -> Result<SubscriptionCredentials>;
}

#[derive(Clone, Debug)]
pub struct LocalAuthFile {
    source: AuthSource,
    path: PathBuf,
}

impl LocalAuthFile {
    pub fn new(source: AuthSource, path: impl Into<PathBuf>) -> Self {
        Self {
            source,
            path: path.into(),
        }
    }

    pub fn default_for(source: AuthSource) -> Result<Self> {
        let home = || {
            std::env::var_os("HOME")
                .filter(|s| !s.is_empty())
                .or_else(|| std::env::var_os("USERPROFILE").filter(|s| !s.is_empty()))
                .map(PathBuf::from)
                .ok_or(GatewayError::HomeUnavailable)
        };
        let path = match source {
            AuthSource::Codex => {
                let directory = match std::env::var_os("CODEX_HOME").filter(|s| !s.is_empty()) {
                    Some(path) => PathBuf::from(path),
                    None => home()?.join(".codex"),
                };
                directory.join("auth.json")
            }
            AuthSource::Pi => home()?.join(".pi/agent/auth.json"),
        };
        Ok(Self::new(source, path))
    }
}

#[async_trait]
impl CredentialSource for LocalAuthFile {
    async fn load(&self) -> Result<SubscriptionCredentials> {
        // This path is selected by a trusted local caller, never from a remote API.
        let metadata = tokio::fs::symlink_metadata(&self.path)
            .await
            .map_err(|e| GatewayError::AuthRead(e.kind()))?;
        check_file(&metadata)?;
        let mut options = tokio::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_NOFOLLOW);
        let file = options
            .open(&self.path)
            .await
            .map_err(|e| GatewayError::AuthRead(e.kind()))?;
        check_file(
            &file
                .metadata()
                .await
                .map_err(|e| GatewayError::AuthRead(e.kind()))?,
        )?;
        let mut bytes = Zeroizing::new(Vec::new());
        file.take((MAX_AUTH_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| GatewayError::AuthRead(e.kind()))?;
        if bytes.len() > MAX_AUTH_BYTES {
            return Err(GatewayError::AuthFileTooLarge);
        }
        let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        parse_credentials(self.source, bytes)
    }
}

fn check_file(metadata: &std::fs::Metadata) -> Result<()> {
    if !metadata.is_file() {
        return Err(GatewayError::AuthFileType);
    }
    if metadata.len() > MAX_AUTH_BYTES as u64 {
        return Err(GatewayError::AuthFileTooLarge);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(GatewayError::AuthPermissions);
        }
    }
    Ok(())
}

// Only needed access-token fields are deserialized. No Debug derives on DTOs.
#[derive(Deserialize)]
struct CodexFile {
    auth_mode: Option<String>,
    #[serde(rename = "OPENAI_API_KEY")]
    api_key: Option<serde::de::IgnoredAny>,
    tokens: Option<CodexTokens>,
}
#[derive(Deserialize)]
struct CodexTokens {
    access_token: String,
    account_id: Option<String>,
}
#[derive(Deserialize)]
struct PiFile {
    #[serde(rename = "openai-codex")]
    codex: Option<PiTokens>,
}
#[derive(Deserialize)]
struct PiTokens {
    #[serde(rename = "type")]
    kind: String,
    access: String,
    expires: u64, // Pi stores Unix milliseconds, not seconds.
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

fn parse_credentials(source: AuthSource, bytes: &[u8]) -> Result<SubscriptionCredentials> {
    match source {
        AuthSource::Codex => {
            let file: CodexFile = serde_json::from_slice(bytes)
                .map_err(|_| GatewayError::InvalidAuth("unrecognized Codex auth.json shape"))?;
            if file
                .auth_mode
                .as_deref()
                .is_some_and(|mode| mode != "chatgpt")
                || file.api_key.is_some()
            {
                return Err(GatewayError::InvalidAuth(
                    "expected ChatGPT subscription login, not API-key or another auth mode",
                ));
            }
            let tokens = file
                .tokens
                .ok_or(GatewayError::InvalidAuth("Codex OAuth tokens are absent"))?;
            SubscriptionCredentials::from_access_token(tokens.access_token, tokens.account_id, None)
        }
        AuthSource::Pi => {
            let file: PiFile = serde_json::from_slice(bytes)
                .map_err(|_| GatewayError::InvalidAuth("unrecognized Pi auth.json shape"))?;
            let tokens = file.codex.ok_or(GatewayError::InvalidAuth(
                "Pi openai-codex credential is absent",
            ))?;
            if tokens.kind != "oauth" {
                return Err(GatewayError::InvalidAuth(
                    "Pi openai-codex credential must be OAuth",
                ));
            }
            SubscriptionCredentials::from_access_token(
                tokens.access,
                tokens.account_id,
                Some(tokens.expires / 1000),
            )
        }
    }
}

fn jwt_hints(token: &str) -> (Option<String>, Option<u64>) {
    let mut pieces = token.split('.');
    let _header = pieces.next();
    let Some(payload) = pieces.next() else {
        return (None, None);
    };
    if pieces.next().is_none() || pieces.next().is_some() {
        return (None, None);
    }
    let Ok(decoded) = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| URL_SAFE.decode(payload))
    else {
        return (None, None);
    };
    let decoded = Zeroizing::new(decoded);
    #[derive(Deserialize)]
    struct Claims {
        exp: Option<u64>,
        #[serde(rename = "https://api.openai.com/auth")]
        auth: Option<AccountClaim>,
    }
    #[derive(Deserialize)]
    struct AccountClaim {
        chatgpt_account_id: Option<String>,
    }
    match serde_json::from_slice::<Claims>(&decoded) {
        Ok(claims) => (claims.auth.and_then(|a| a.chatgpt_account_id), claims.exp),
        Err(_) => (None, None),
    }
}

#[cfg(test)]
#[path = "tests/authentication/auth_edge_tests.rs"]
mod edge_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(super) fn jwt(exp: u64) -> String {
        let payload = json!({"exp": exp, "https://api.openai.com/auth": {"chatgpt_account_id": "test-account"}});
        format!(
            "e30.{}.not-a-real-signature",
            URL_SAFE_NO_PAD.encode(payload.to_string())
        )
    }
    const FUTURE: u64 = 4_102_444_800;

    #[test]
    fn codex_oauth_shape_and_secret_redaction() {
        let token = jwt(FUTURE);
        let file = json!({"auth_mode":"chatgpt", "OPENAI_API_KEY":null,
            "tokens":{"access_token":token,"refresh_token":"ignored-refresh","id_token":"ignored-id"}});
        let credentials =
            parse_credentials(AuthSource::Codex, file.to_string().as_bytes()).unwrap();
        assert_eq!(credentials.expires_at_unix(), Some(FUTURE));
        assert_eq!(credentials.account_id, "test-account");
        assert!(!format!("{credentials:?}").contains(&token));
        assert!(!format!("{:?}", credentials.headers().unwrap()).contains(&token));
    }

    #[test]
    fn pi_oauth_uses_milliseconds_and_ignores_other_providers() {
        let file = json!({"openai-codex":{"type":"oauth","access":jwt(FUTURE),"expires":FUTURE*1000,
            "refresh":"ignored"},"other-provider":{"key":"must-not-be-used"}});
        assert_eq!(
            parse_credentials(AuthSource::Pi, file.to_string().as_bytes())
                .unwrap()
                .expires_at_unix(),
            Some(FUTURE)
        );
    }

    #[test]
    fn api_key_auth_is_not_a_subscription() {
        let file = json!({"auth_mode":"apikey","OPENAI_API_KEY":"not-a-real-key"});
        assert!(matches!(
            parse_credentials(AuthSource::Codex, file.to_string().as_bytes()),
            Err(GatewayError::InvalidAuth(_))
        ));
    }

    #[test]
    fn expired_access_token_is_rejected() {
        assert!(matches!(
            SubscriptionCredentials::from_access_token(jwt(1), None, None),
            Err(GatewayError::AuthExpired)
        ));
    }

    #[test]
    fn credential_parse_errors_do_not_echo_secrets() {
        let file = br#"{"openai-codex":{"type":"oauth","access":"secret-access","expires":"secret-refresh"}}"#;
        let error = parse_credentials(AuthSource::Pi, file).unwrap_err();
        assert!(!format!("{error:?} {error}").contains("secret-access"));
        assert!(!format!("{error:?} {error}").contains("secret-refresh"));
    }

    #[test]
    fn header_injection_is_rejected() {
        assert!(
            SubscriptionCredentials::from_access_token(
                "fake\r\ninjected: yes".into(),
                Some("test".into()),
                None
            )
            .is_err()
        );
        assert!(
            SubscriptionCredentials::from_access_token(
                "fake".into(),
                Some("test\nunsafe".into()),
                None
            )
            .is_err()
        );
    }

    #[test]
    fn no_account_is_rejected() {
        assert!(SubscriptionCredentials::from_access_token("opaque".into(), None, None).is_err());
    }

    #[tokio::test]
    async fn reads_owner_updates_without_rewriting_the_file() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let source = LocalAuthFile::new(AuthSource::Codex, temp.path());
        let document = |access: &str| {
            json!({"auth_mode":"chatgpt", "tokens":{"access_token":access,"account_id":"test"}})
                .to_string()
        };
        let first = document("fake-first");
        std::fs::write(temp.path(), &first).unwrap();
        assert_eq!(
            source.load().await.unwrap().access_token.as_str(),
            "fake-first"
        );
        assert_eq!(std::fs::read_to_string(temp.path()).unwrap(), first);
        std::fs::write(temp.path(), document("fake-second")).unwrap();
        assert_eq!(
            source.load().await.unwrap().access_token.as_str(),
            "fake-second"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_world_readable_credentials() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::NamedTempFile::new().unwrap();
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(
            LocalAuthFile::new(AuthSource::Codex, temp.path())
                .load()
                .await,
            Err(GatewayError::AuthPermissions)
        ));
    }
}
