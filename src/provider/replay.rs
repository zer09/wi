use std::{collections::HashSet, fmt};

use serde::{Deserialize, Serialize};

use crate::{
    CallOrigin, GatewayError, InputItem, ItemKind, ModelResponse, ResponseOutcome, Result,
};

/// A private equality marker, not an authenticated or encrypted account identity.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "IdentityFields")]
pub struct ReplayIdentity {
    provider_id: String,
    format: String,
    principal_digest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentityFields {
    provider_id: String,
    format: String,
    principal_digest: String,
}

impl TryFrom<IdentityFields> for ReplayIdentity {
    type Error = GatewayError;

    fn try_from(value: IdentityFields) -> Result<Self> {
        Self::new(value.provider_id, value.format, value.principal_digest)
    }
}

impl ReplayIdentity {
    pub fn new(provider_id: String, format: String, principal_digest: String) -> Result<Self> {
        if provider_id.trim().is_empty()
            || format.trim().is_empty()
            || !valid_digest(&principal_digest)
        {
            return Err(GatewayError::InvalidRequest("invalid replay identity"));
        }
        Ok(Self {
            provider_id,
            format,
            principal_digest,
        })
    }

    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }
    pub fn format(&self) -> &str {
        &self.format
    }
    pub fn principal_digest(&self) -> &str {
        &self.principal_digest
    }
}

pub(crate) fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl fmt::Debug for ReplayIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ReplayIdentity([redacted])")
    }
}

/// Stored conversation only. The next explicit user input is supplied separately.
#[derive(Clone, Serialize, Deserialize)]
#[serde(try_from = "ConversationFields")]
pub struct ConversationReplay {
    version: u32,
    provider_id: String,
    requested_model: String,
    expected_identity: Option<ReplayIdentity>,
    runs: Vec<ReplayRun>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConversationFields {
    version: u32,
    provider_id: String,
    requested_model: String,
    expected_identity: Option<ReplayIdentity>,
    runs: Vec<ReplayRun>,
}

impl TryFrom<ConversationFields> for ConversationReplay {
    type Error = GatewayError;

    fn try_from(value: ConversationFields) -> Result<Self> {
        if value.version != 1 {
            return Err(invalid());
        }
        Self::new(
            value.provider_id,
            value.requested_model,
            value.expected_identity,
            value.runs,
        )
    }
}

impl ConversationReplay {
    pub fn new(
        provider_id: String,
        requested_model: String,
        expected_identity: Option<ReplayIdentity>,
        runs: Vec<ReplayRun>,
    ) -> Result<Self> {
        let mut ids = HashSet::new();
        if provider_id.trim().is_empty()
            || requested_model.trim().is_empty()
            || requested_model.len() > 256
            || expected_identity
                .as_ref()
                .is_some_and(|identity| identity.provider_id() != provider_id)
            || (!runs.is_empty() && expected_identity.is_none())
            || runs.iter().any(|run| !ids.insert(run.source_run_id()))
        {
            return Err(invalid());
        }
        Ok(Self {
            version: 1,
            provider_id,
            requested_model,
            expected_identity,
            runs,
        })
    }

    pub fn version(&self) -> u32 {
        self.version
    }
    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }
    pub fn requested_model(&self) -> &str {
        &self.requested_model
    }
    pub fn expected_identity(&self) -> Option<&ReplayIdentity> {
        self.expected_identity.as_ref()
    }
    pub fn runs(&self) -> &[ReplayRun] {
        &self.runs
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(try_from = "RunFields")]
pub struct ReplayRun {
    source_run_id: String,
    prepared_prompt: String,
    exchanges: Vec<ReplayExchange>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunFields {
    source_run_id: String,
    prepared_prompt: String,
    exchanges: Vec<ReplayExchange>,
}

impl TryFrom<RunFields> for ReplayRun {
    type Error = GatewayError;

    fn try_from(value: RunFields) -> Result<Self> {
        Self::new(value.source_run_id, value.prepared_prompt, value.exchanges)
    }
}

impl ReplayRun {
    pub fn new(
        source_run_id: String,
        prepared_prompt: String,
        exchanges: Vec<ReplayExchange>,
    ) -> Result<Self> {
        if source_run_id.trim().is_empty()
            || prepared_prompt.trim().is_empty()
            || exchanges.is_empty()
            || exchanges
                .iter()
                .take(exchanges.len() - 1)
                .any(|exchange| exchange.tool_results.is_empty())
        {
            return Err(invalid());
        }
        Ok(Self {
            source_run_id,
            prepared_prompt,
            exchanges,
        })
    }

    pub fn source_run_id(&self) -> &str {
        &self.source_run_id
    }
    pub fn prepared_prompt(&self) -> &str {
        &self.prepared_prompt
    }
    pub fn exchanges(&self) -> &[ReplayExchange] {
        &self.exchanges
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(try_from = "ExchangeFields")]
pub struct ReplayExchange {
    response: ModelResponse,
    tool_results: Vec<InputItem>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExchangeFields {
    response: ModelResponse,
    tool_results: Vec<InputItem>,
}

impl TryFrom<ExchangeFields> for ReplayExchange {
    type Error = GatewayError;

    fn try_from(value: ExchangeFields) -> Result<Self> {
        Self::new(value.response, value.tool_results)
    }
}

impl ReplayExchange {
    pub fn new(response: ModelResponse, tool_results: Vec<InputItem>) -> Result<Self> {
        validate_response(&response)?;
        let mut results = tool_results.iter();
        for call in response
            .output
            .iter()
            .filter_map(|item| item.function_call.as_ref())
        {
            if !matches!(results.next(), Some(InputItem::ToolResult { call_id, .. }) if *call_id == call.call_id)
            {
                return Err(invalid());
            }
        }
        if results.next().is_some() {
            return Err(invalid());
        }
        Ok(Self {
            response,
            tool_results,
        })
    }

    pub fn response(&self) -> &ModelResponse {
        &self.response
    }
    pub fn tool_results(&self) -> &[InputItem] {
        &self.tool_results
    }
}

// Native objects stay opaque here. Adapter validation checks its own native codec;
// this boundary checks only the shared ordinary-call execution contract.
pub(crate) fn validate_response(response: &ModelResponse) -> Result<()> {
    if response.id.is_empty() || response.outcome != ResponseOutcome::Completed {
        return Err(invalid());
    }
    let mut ids = HashSet::new();
    for item in &response.output {
        match item.kind {
            ItemKind::Message | ItemKind::Reasoning if item.function_call.is_none() => {}
            ItemKind::FunctionCall => {
                let call = item.function_call.as_ref().ok_or_else(invalid)?;
                if !call.complete
                    || call.origin != CallOrigin::Direct
                    || call.namespace.is_some()
                    || item
                        .native
                        .get("namespace")
                        .is_some_and(|value| !value.is_null())
                    || call.call_id.is_empty()
                    || call.call_id.len() > 512
                    || call.name.is_empty()
                    || !ids.insert(&call.call_id)
                    || call.arguments.len() > 64 * 1024
                    || !serde_json::from_str::<serde_json::Value>(&call.arguments)
                        .is_ok_and(|value| value.is_object())
                {
                    return Err(invalid());
                }
            }
            _ => return Err(invalid()),
        }
    }
    Ok(())
}

fn invalid() -> GatewayError {
    GatewayError::InvalidRequest("invalid conversation replay")
}

impl fmt::Debug for ConversationReplay {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ConversationReplay([redacted])")
    }
}
impl fmt::Debug for ReplayRun {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ReplayRun([redacted])")
    }
}
impl fmt::Debug for ReplayExchange {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ReplayExchange([redacted])")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_identity_validates_owned_values_and_redacts_debug() {
        let identity =
            ReplayIdentity::new("fixture".into(), "native-v1".into(), "a1".repeat(32)).unwrap();
        assert_eq!(identity.provider_id(), "fixture");
        assert_eq!(identity.format(), "native-v1");
        assert_eq!(identity.principal_digest(), "a1".repeat(32));
        assert_eq!(format!("{identity:?}"), "ReplayIdentity([redacted])");
        let json = serde_json::to_value(&identity).unwrap();
        assert_eq!(
            serde_json::from_value::<ReplayIdentity>(json.clone()).unwrap(),
            identity
        );
        for (key, value) in [
            ("provider_id", ""),
            ("format", " "),
            ("principal_digest", "ABC"),
            ("principal_digest", &"A".repeat(64)),
            ("principal_digest", &"0".repeat(63)),
        ] {
            let mut bad = json.clone();
            bad[key] = value.into();
            assert!(serde_json::from_value::<ReplayIdentity>(bad).is_err());
        }
    }
}
