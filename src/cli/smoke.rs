//! Explicit live entry point. It never prints native events or dynamic provider errors.
#[cfg(test)]
#[path = "smoke_tests.rs"]
mod tests;
use crate::cli::{TransportArg, demo, line_json};
use clap::{Args, ValueEnum};
use futures_util::StreamExt;
use serde::Serialize;
use std::sync::Arc;
use wi::providers::openai_codex::{
    PROVIDER_ID,
    observation::{FOLLOW_UP, SmokeCase, SmokeObserver, required_proof},
};
use wi::tools::{AddNumbers, ToolExecutionEvent, ToolRegistry};
use wi::{
    Gateway, GatewayError, InputItem, ModelResponse, ProviderEvent, ProviderSession, Result,
    SessionOptions, Transport, UpstreamOutcome,
};

#[derive(Clone, Copy, ValueEnum)]
enum SmokeAuthSource {
    Gateway,
    Pi,
    Codex,
}
#[derive(Clone, Copy, ValueEnum)]
enum CaseArg {
    Text,
    Continuation,
    Tool,
}
#[derive(Args)]
pub struct SmokeArgs {
    /// Required explicit OAuth source. No fallback.
    #[arg(long, value_enum)]
    auth_source: SmokeAuthSource,
    #[arg(long)]
    account: Option<String>,
    #[arg(long)]
    model: String,
    #[arg(long, value_enum)]
    transport: TransportArg,
    /// Fixed synthetic requests: text=1, continuation=2, tool=2. No retries.
    #[arg(long, value_enum)]
    case: CaseArg,
}
#[derive(Default, Serialize)]
struct Acceptance {
    normalized_started_counts: Vec<usize>,
    answers_equal: Vec<bool>,
    tool_call_valid: bool,
    executor_correlated: bool,
    tool_result_valid: bool,
    request_failure: Option<RequestFailure>,
}
#[derive(Serialize)]
struct RequestFailure {
    code: &'static str,
    http_status: Option<u16>,
    upstream_outcome: UpstreamOutcome,
}
impl RequestFailure {
    fn new(code: &str, upstream_outcome: UpstreamOutcome) -> Self {
        // Never copy a provider-owned string into the public summary.
        let code = match code {
            "unauthorized" => "unauthorized",
            "forbidden" => "forbidden",
            "rate_limited" => "rate_limited",
            "protocol_error" => "protocol_error",
            "transport_error" => "transport_error",
            "unexpected_content_type" => "unexpected_content_type",
            "timeout" => "timeout",
            "unexpected_end" => "unexpected_end",
            "auth_expired" => "auth_expired",
            "auth_account_changed" => "auth_account_changed",
            "locally_cancelled" => "locally_cancelled",
            "slow_consumer" => "slow_consumer",
            "output_limit" => "output_limit",
            "unsupported_output" => "unsupported_output",
            "http_error" => "http_error",
            "provider_error" => "provider_error",
            _ => "unclassified",
        };
        let http_status = match code {
            "unauthorized" => Some(401),
            "forbidden" => Some(403),
            "rate_limited" => Some(429),
            _ => None,
        };
        Self {
            code,
            http_status,
            upstream_outcome,
        }
    }
}
async fn collect(
    session: &mut ProviderSession,
    request_id: &str,
    acceptance: &mut Acceptance,
) -> Result<ModelResponse> {
    acceptance.normalized_started_counts.push(0);
    while let Some(envelope) = session.events.next().await {
        if envelope.request_id.as_deref() != Some(request_id) {
            return Err(GatewayError::Protocol("smoke request identity mismatch"));
        }
        match envelope.event {
            ProviderEvent::ResponseStarted { .. } => {
                *acceptance.normalized_started_counts.last_mut().unwrap() += 1
            }
            ProviderEvent::ResponseFinished { response } => return Ok(response),
            ProviderEvent::RequestFailed {
                code,
                upstream_outcome,
                ..
            } => {
                acceptance.request_failure = Some(RequestFailure::new(&code, upstream_outcome));
                return Err(GatewayError::ProviderFailed);
            }
            ProviderEvent::SessionClosed { .. } => return Err(GatewayError::SessionClosed),
            _ => {}
        }
    }
    Err(GatewayError::UnexpectedEnd)
}

pub async fn run(args: SmokeArgs) -> Result<()> {
    if args.model != "gpt-6-astra" {
        return Err(GatewayError::Protocol("smoke requires gpt-6-astra"));
    }
    let case = match args.case {
        CaseArg::Text => SmokeCase::Text,
        CaseArg::Continuation => SmokeCase::Continuation,
        CaseArg::Tool => SmokeCase::Tool,
    };
    let transport = match args.transport {
        TransportArg::Websocket => Transport::WebSocket,
        TransportArg::Sse => Transport::Sse,
    };
    let observer = SmokeObserver::default();
    let mut acceptance = Acceptance::default();
    let mut stage = "setup";
    let task = async {
        let source = match args.auth_source {
            SmokeAuthSource::Gateway => crate::cli::SourceArg::Gateway,
            SmokeAuthSource::Pi => crate::cli::SourceArg::Pi,
            SmokeAuthSource::Codex => crate::cli::SourceArg::Codex,
        };
        let provider = crate::cli::provider(&crate::cli::AuthArgs {
            auth_source: source,
            auth_file: None,
            account: args.account,
        })?
        .with_smoke_observer(observer.clone(), case);
        let mut gateway = Gateway::new();
        gateway.register(Arc::new(provider))?;
        let mut registry = ToolRegistry::new();
        let mut options = SessionOptions::new(args.model);
        options.transport = transport;
        if case == SmokeCase::Tool {
            registry.register(Arc::new(AddNumbers))?;
            options.tools = registry.definitions();
            options.instructions = demo::TOOL_INSTRUCTIONS.into();
        }
        let mut session = gateway.open_session(PROVIDER_ID, options).await?;
        let control = session.control.clone();
        let sequence = async {
            stage = "first_generation";
            let receipt = control
                .generate(vec![InputItem::user(case.first_prompt())])
                .await?;
            let first = collect(&mut session, &receipt.request_id, &mut acceptance).await?;
            stage = "first_acceptance";
            if !required_proof(&observer.snapshot(), SmokeCase::Text, transport) {
                return Err(GatewayError::Protocol("required smoke lifecycle absent"));
            }
            if case == SmokeCase::Tool {
                let call = demo::validate_call(&first)?;
                acceptance.tool_call_valid = true;
                let mut starts = 0;
                let mut finishes = 0;
                let mut correlated = true;
                let results = registry
                    .execute_response(&first, |event| match event {
                        ToolExecutionEvent::ToolExecutionStarted { call_id, tool_name } => {
                            starts += 1;
                            correlated &= call_id == call.call_id && tool_name == "add_numbers";
                        }
                        ToolExecutionEvent::ToolExecutionFinished {
                            call_id,
                            tool_name,
                            is_error,
                        } => {
                            finishes += 1;
                            correlated &=
                                call_id == call.call_id && tool_name == "add_numbers" && !is_error;
                        }
                        ToolExecutionEvent::ToolResultReused { .. } => correlated = false,
                    })
                    .await?;
                acceptance.executor_correlated = correlated && starts == 1 && finishes == 1;
                if !acceptance.executor_correlated {
                    return Err(GatewayError::ToolFailed);
                }
                demo::validate_result(&results, &call.call_id)?;
                acceptance.tool_result_valid = true;
                stage = "second_generation";
                let receipt = control.generate(results).await?;
                let response = collect(&mut session, &receipt.request_id, &mut acceptance).await?;
                stage = "final_acceptance";
                let valid = demo::validate_answer(&response, "42");
                acceptance.answers_equal.push(valid.is_ok());
                valid?;
            } else {
                let expected = if case == SmokeCase::Text {
                    "gateway connected"
                } else {
                    "remembered"
                };
                let valid = demo::validate_answer(&first, expected);
                acceptance.answers_equal.push(valid.is_ok());
                valid?;
                if case == SmokeCase::Continuation {
                    stage = "second_generation";
                    let receipt = control.generate(vec![InputItem::user(FOLLOW_UP)]).await?;
                    let response =
                        collect(&mut session, &receipt.request_id, &mut acceptance).await?;
                    stage = "final_acceptance";
                    let valid = demo::validate_answer(&response, "lantern");
                    acceptance.answers_equal.push(valid.is_ok());
                    valid?;
                }
            }
            if !required_proof(&observer.snapshot(), case, transport)
                || acceptance
                    .normalized_started_counts
                    .iter()
                    .any(|count| *count != 1)
            {
                return Err(GatewayError::Protocol("required smoke proof absent"));
            }
            Ok(())
        }
        .await;
        control.close();
        sequence
    };
    let result = tokio::select! { result = task => result, _ = tokio::signal::ctrl_c() => Err(GatewayError::Cancelled) };
    // Only static categories and already-sanitized data can reach this output.
    line_json(
        &serde_json::json!({"schema_version":1,"case":case,"transport":transport,"stage":stage,
        "passed":result.is_ok(),"error_code":result.as_ref().err().map(GatewayError::code),
        "submissions":observer.snapshot(),"acceptance":acceptance}),
    )?;
    result
}
