//! Explicit live example: selects Codex credentials, not Pi, only when run.
//! Output includes response text and IDs; use `gateway smoke` for sanitized evidence.
//! Usage: cargo run --example two_turns -- EXACT_ENABLED_MODEL_ID
use futures_util::StreamExt;
use harness_gateway::providers::openai_codex::{
    OpenAiCodexProvider, PROVIDER_ID,
    auth::{AuthSource, LocalAuthFile},
};
use harness_gateway::{Gateway, InputItem, ProviderEvent, SessionOptions};
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let model = std::env::args()
        .nth(1)
        .ok_or("pass your enabled Codex model ID")?;
    let provider =
        OpenAiCodexProvider::new(Arc::new(LocalAuthFile::default_for(AuthSource::Codex)?));
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(provider))?;
    let mut session = gateway
        .open_session(PROVIDER_ID, SessionOptions::new(model))
        .await?;
    for prompt in [
        "Remember the word lantern and acknowledge.",
        "What word did I ask you to remember?",
    ] {
        let receipt = session
            .control
            .generate(vec![InputItem::user(prompt)])
            .await?;
        loop {
            let event = session
                .events
                .next()
                .await
                .ok_or(harness_gateway::GatewayError::UnexpectedEnd)?;
            if event.request_id.as_deref() != Some(receipt.request_id.as_str()) {
                return Err("unexpected request identity or closed session".into());
            }
            match event.event {
                ProviderEvent::ResponseFinished { response } => {
                    println!("{}: {}", receipt.request_id, response.text);
                    if response.outcome != harness_gateway::ResponseOutcome::Completed {
                        return Err("incomplete response".into());
                    }
                    break;
                }
                ProviderEvent::RequestFailed { message, .. } => return Err(message.into()),
                ProviderEvent::SessionClosed { reason } => return Err(reason.into()),
                _ => {}
            }
        }
    }
    session.control.close();
    Ok(())
}
