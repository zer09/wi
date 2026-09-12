use std::io::ErrorKind;

pub type Result<T> = std::result::Result<T, GatewayError>;

/// Safe diagnostics: never contain credentials, raw HTTP error bodies, prompts,
/// model-generated arguments, arbitrary server messages, or response headers.
#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    #[error("invalid request: {0}")]
    InvalidRequest(&'static str),
    #[error("provider not registered")]
    UnknownProvider,
    #[error("provider already registered")]
    DuplicateProvider,
    #[error("feature not implemented by this adapter: {0}")]
    UnsupportedFeature(&'static str),
    #[error("session already has an accepted request; finish it before submitting another")]
    Busy,
    #[error("session is closed; create a new session explicitly")]
    SessionClosed,
    #[error("home directory unavailable; pass --auth-file")]
    HomeUnavailable,
    #[error(
        "cannot read credential file ({0:?}); sign in with Codex/Pi; keyring-only storage is not supported by the file reader"
    )]
    AuthRead(ErrorKind),
    #[error("credentials must be in a regular, non-symlink file")]
    AuthFileType,
    #[error("credential file exceeds 1 MiB")]
    AuthFileTooLarge,
    #[error("credential file allows group/other access; restrict to your user (chmod 600 on Unix)")]
    AuthPermissions,
    #[error("invalid subscription credentials: {0}")]
    InvalidAuth(&'static str),
    #[error(
        "login expired or expires within 30 seconds; renew Wi-managed credentials through Wi, or external credentials through Codex/Pi; then open a new provider session; established WebSockets cannot renew in place"
    )]
    AuthExpired,
    #[error("credential account changed during this session; open a new session explicitly")]
    AuthAccountChanged,
    #[error("clock is before the Unix epoch")]
    Clock,
    #[error("could not configure the HTTP/TLS client")]
    ClientConfiguration,
    #[error("provider transport timed out; no automatic retry")]
    Timeout,
    #[error("provider transport failed; no automatic retry")]
    Transport,
    #[error("OpenAI rejected the login (401); refresh in the originating client")]
    Unauthorized,
    #[error("OpenAI denied access (403); check the account and model entitlement")]
    Forbidden,
    #[error("provider rate/usage limit (429); retry-after seconds: {retry_after_seconds:?}")]
    RateLimited { retry_after_seconds: Option<u64> },
    #[error("provider returned HTTP {status}; body withheld")]
    Http { status: u16 },
    #[error("expected text/event-stream")]
    UnexpectedContentType,
    #[error("invalid provider protocol: {0}")]
    Protocol(&'static str),
    #[error("provider rejected the request; error details withheld")]
    ProviderFailed,
    #[error("provider stream ended without a terminal response")]
    UnexpectedEnd,
    #[error("provider output exceeds the configured safety limit")]
    StreamTooLarge,
    #[error("event consumer is too slow; session closed without retry")]
    SlowConsumer,
    #[error("locally interrupted; upstream execution may still be running")]
    Cancelled,
    #[error("unsupported output; no unknown tool/program is executed")]
    UnsupportedOutput,
    #[error("response is not completed; tools must not execute")]
    NotCompleted,
    #[error("tool is not in the explicitly registered allowlist")]
    UnknownTool,
    #[error("tool arguments failed local validation")]
    InvalidToolArguments,
    #[error("tool failed; details withheld")]
    ToolFailed,
    #[error("demo expected a tool call but the model did not request one")]
    NoToolCall,
    #[error("demo exceeded its bounded tool-round-trip limit")]
    TurnLimit,
    #[error("local I/O failed ({0:?})")]
    Io(ErrorKind),
    #[error("could not serialize data")]
    Serialization,
}

impl From<reqwest::Error> for GatewayError {
    fn from(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::Timeout
        } else {
            Self::Transport
        }
    }
}

impl GatewayError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::RateLimited { .. } => "rate_limited",
            Self::AuthExpired => "auth_expired",
            Self::AuthAccountChanged => "auth_account_changed",
            Self::Timeout => "timeout",
            Self::Transport => "transport_error",
            Self::UnexpectedContentType => "unexpected_content_type",
            Self::Cancelled => "locally_cancelled",
            Self::SlowConsumer => "slow_consumer",
            Self::UnexpectedEnd => "unexpected_end",
            Self::Protocol(_) => "protocol_error",
            Self::ProviderFailed => "provider_error",
            Self::InvalidRequest(_) => "invalid_request",
            Self::StreamTooLarge => "output_limit",
            Self::UnsupportedOutput => "unsupported_output",
            Self::UnsupportedFeature(_) => "unsupported_feature",
            Self::Http { .. } => "http_error",
            _ => "gateway_error",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::openai_codex::auth::SubscriptionCredentials;

    #[test]
    fn r1_a04_synthetic_freshness_error_has_owner_specific_display() {
        let error = SubscriptionCredentials::from_access_token(
            "synthetic-oauth-token".into(),
            Some("synthetic-account".into()),
            Some(1),
        )
        .unwrap_err();
        assert!(matches!(error, GatewayError::AuthExpired));
        assert_eq!(error.code(), "auth_expired");
        assert_eq!(
            format!("{error}"),
            "login expired or expires within 30 seconds; renew Wi-managed credentials through Wi, or external credentials through Codex/Pi; then open a new provider session; established WebSockets cannot renew in place"
        );
    }

    #[test]
    fn r1_a04_error_codes_remain_compatible() {
        assert_eq!(GatewayError::AuthExpired.code(), "auth_expired");
        assert_eq!(GatewayError::ToolFailed.code(), "gateway_error");
        assert_eq!(GatewayError::Protocol("synthetic").code(), "protocol_error");
    }
}
