use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct SafeCode(&'static str);
impl SafeCode {
    pub fn as_str(&self) -> &'static str {
        self.0
    }
}

pub fn safe_code(code: &str) -> SafeCode {
    // The returned value is always a literal, never the provider's diagnostic string.
    SafeCode(match code {
        "unauthorized" => "unauthorized",
        "forbidden" => "forbidden",
        "rate_limited" => "rate_limited",
        "auth_expired" => "auth_expired",
        "auth_account_changed" => "auth_account_changed",
        "timeout" => "timeout",
        "transport_error" => "transport_error",
        "unexpected_content_type" => "unexpected_content_type",
        "locally_cancelled" => "locally_cancelled",
        "slow_consumer" => "slow_consumer",
        "unexpected_end" => "unexpected_end",
        "protocol_error" => "protocol_error",
        "provider_error" => "provider_error",
        "invalid_request" => "invalid_request",
        "output_limit" => "output_limit",
        "unsupported_output" => "unsupported_output",
        "unsupported_feature" => "unsupported_feature",
        "http_error" => "http_error",
        "gateway_error" => "gateway_error",
        "event_sink" => "event_sink",
        "counter_overflow" => "counter_overflow",
        "tool_execution" => "tool_execution",
        "provider_open" => "provider_open",
        "provider_request_failed" => "provider_request_failed",
        "provider_correlation" => "provider_correlation",
        "history_identity" => "history_identity",
        "history_restore" => "history_restore",
        _ => "upstream_error",
    })
}
