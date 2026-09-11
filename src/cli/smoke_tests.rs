use super::*;
use wi::{EventEnvelope, RequestReceipt, SessionControl};

#[tokio::test]
async fn smoke_explicit_sources_parse_without_auth_and_wrong_model_fails_early() {
    use clap::Parser;
    for source in ["pi", "codex", "gateway"] {
        let cli = crate::cli::Cli::try_parse_from([
            "wi",
            "smoke",
            "--auth-source",
            source,
            "--model",
            "wrong",
            "--transport",
            "websocket",
            "--case",
            "text",
        ])
        .unwrap();
        let crate::cli::Command::Smoke(args) = cli.command else {
            panic!("smoke")
        };
        assert!(matches!(
            run(args).await,
            Err(GatewayError::Protocol("smoke requires gpt-6-astra"))
        ));
    }
    assert!(
        crate::cli::Cli::try_parse_from([
            "wi",
            "smoke",
            "--model",
            "gpt-6-astra",
            "--transport",
            "websocket",
            "--case",
            "text"
        ])
        .is_err()
    );
}

struct NoNetwork;
#[async_trait::async_trait]
impl SessionControl for NoNetwork {
    async fn generate(&self, _: Vec<InputItem>) -> Result<RequestReceipt> {
        panic!("collector must not submit or retry")
    }
    fn close(&self) {}
}

#[tokio::test]
async fn smoke_failure_summary_preserves_only_allowlisted_categories_and_outcomes() {
    for (error, expected, status) in [
        (GatewayError::Unauthorized, "unauthorized", Some(401)),
        (GatewayError::Forbidden, "forbidden", Some(403)),
        (
            GatewayError::RateLimited {
                retry_after_seconds: Some(123),
            },
            "rate_limited",
            Some(429),
        ),
        (
            GatewayError::Protocol("private-message"),
            "protocol_error",
            None,
        ),
        (GatewayError::Transport, "transport_error", None),
        (
            GatewayError::UnexpectedContentType,
            "unexpected_content_type",
            None,
        ),
        (GatewayError::Timeout, "timeout", None),
        (
            GatewayError::AuthAccountChanged,
            "auth_account_changed",
            None,
        ),
        (GatewayError::Cancelled, "locally_cancelled", None),
    ] {
        for outcome in [
            UpstreamOutcome::NotSubmitted,
            UpstreamOutcome::Unknown,
            UpstreamOutcome::TerminalReceived,
        ] {
            let envelope = EventEnvelope {
                schema_version: 1,
                sequence: 1,
                event_id: "private-event".into(),
                session_id: "private-session".into(),
                request_id: Some("private-request".into()),
                provider: "private-provider".into(),
                provider_sequence: None,
                event: ProviderEvent::RequestFailed {
                    code: error.code().into(),
                    message: "private-message-token-native-body".into(),
                    upstream_outcome: outcome,
                },
            };
            let mut session = ProviderSession {
                id: "private-session".into(),
                control: Arc::new(NoNetwork),
                events: Box::pin(futures_util::stream::iter([envelope])),
            };
            let mut acceptance = Acceptance::default();
            assert!(matches!(
                collect(&mut session, "private-request", &mut acceptance).await,
                Err(GatewayError::ProviderFailed)
            ));
            let failure = acceptance.request_failure.as_ref().unwrap();
            assert_eq!(failure.code, expected);
            assert_eq!(failure.http_status, status);
            assert_eq!(failure.upstream_outcome, outcome);
            let value = serde_json::to_value(&acceptance).unwrap();
            assert_eq!(value["request_failure"].as_object().unwrap().len(), 3);
            assert!(!value.to_string().contains("private"));
            assert_eq!(acceptance.normalized_started_counts, [0]);
        }
    }
}

#[test]
fn smoke_failure_unknown_codes_never_escape_allowlist() {
    for code in [
        "private-token",
        "unauthorized\nprivate-token",
        "401",
        "Forbidden",
        "",
    ] {
        let failure = RequestFailure::new(code, UpstreamOutcome::Unknown);
        assert_eq!(
            serde_json::to_value(failure).unwrap(),
            serde_json::json!({
                "code":"unclassified", "http_status":null, "upstream_outcome":"unknown"
            })
        );
    }
}
