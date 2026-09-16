//! Pure native replay compilation. No credential source or transport is consulted.
use super::{
    OpenAiCodexProvider, PROVIDER_ID,
    codec::parse_response,
    finalized,
    state::{check_history, native_input},
};
use crate::{
    ConversationReplay, GatewayError, InputItem, ModelResponse, OutputProvenance, ReplayIdentity,
    Result, SessionOptions,
};
use serde_json::Value;
use std::collections::HashSet;

pub(super) const FORMAT: &str = "responses-input-v1";

pub(super) fn identity(auth: &super::auth::SubscriptionCredentials) -> Result<ReplayIdentity> {
    let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
    digest.update(b"wi.openai-codex.account.v1\0");
    digest.update(auth.account_id().as_bytes());
    let digest = digest
        .finish()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    ReplayIdentity::new(PROVIDER_ID.into(), FORMAT.into(), digest)
}

pub(super) fn compile(options: &SessionOptions, replay: &ConversationReplay) -> Result<Vec<Value>> {
    options.validate()?;
    OpenAiCodexProvider::capability_report().require(&options.required_features)?;
    if replay.version() != 1
        || replay.provider_id() != PROVIDER_ID
        || replay.requested_model() != options.model
        || replay.expected_identity().is_some_and(|identity| {
            identity.provider_id() != PROVIDER_ID || identity.format() != FORMAT
        })
    {
        return Err(GatewayError::InvalidRequest(
            "incompatible conversation replay",
        ));
    }
    let mut history = Vec::new();
    for run in replay.runs() {
        history.push(native_input(&InputItem::user(run.prepared_prompt())));
        let mut response_ids = HashSet::new();
        for exchange in run.exchanges() {
            let response = exchange.response();
            if !response_ids.insert(&response.id) {
                return Err(GatewayError::Protocol("response ID reused"));
            }
            validate_response(response)?;
            history.extend(response.output.iter().map(|item| item.native.clone()));
            history.extend(exchange.tool_results().iter().map(native_input));
        }
    }
    check_history(&history)?;
    Ok(history)
}

fn invalid() -> GatewayError {
    GatewayError::Protocol("inconsistent native replay response")
}

fn validate_response(response: &ModelResponse) -> Result<()> {
    let mut parsed = parse_response(response.native.clone())?;
    if response.output_provenance == OutputProvenance::ValidatedOutputItemDone {
        if !parsed.output.is_empty() || response.output.is_empty() {
            return Err(invalid());
        }
        for item in &response.output {
            finalized::complete(&item.native).ok_or_else(invalid)?;
        }
        // Reparse the effective output, but retain the original empty terminal.
        let mut effective = response.native.clone();
        effective["output"] = Value::Array(
            response
                .output
                .iter()
                .map(|item| item.native.clone())
                .collect(),
        );
        parsed = parse_response(effective)?;
        parsed.native = response.native.clone();
        parsed.output_provenance = OutputProvenance::ValidatedOutputItemDone;
    }
    let mut item_ids = HashSet::new();
    for item in &parsed.output {
        finalized::ordinary_item(&item.native).ok_or_else(invalid)?;
        if let Some(id) = item.native.get("id") {
            let id = id
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(invalid)?;
            if !item_ids.insert(id) {
                return Err(invalid());
            }
        }
    }
    crate::provider::replay::validate_response(&parsed)?;
    // Compare every normalized field, not just rendered text or function arguments.
    if serde_json::to_value(&parsed).map_err(|_| GatewayError::Serialization)?
        != serde_json::to_value(response).map_err(|_| GatewayError::Serialization)?
    {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
#[path = "tests/replay/validation.rs"]
mod tests;
