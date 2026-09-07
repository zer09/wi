//! Provider-neutral contracts. Plugins implement Provider and SessionControl;
//! they do not emit agent/run/turn or local tool-execution events.
use std::{pin::Pin, sync::Arc};

use async_trait::async_trait;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{GatewayError, Result};

pub const MAX_INPUT_BYTES: usize = 1024 * 1024;
pub const MAX_HISTORY_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_TOOLS: usize = 32;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    WebSocket,
    Sse,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Feature {
    NativeSteering,
    ToolSearch,
    ProgrammaticTools,
    AsyncTools,
    HostedSkills,
}
impl Feature {
    pub fn name(self) -> &'static str {
        match self {
            Self::NativeSteering => "native_steering",
            Self::ToolSearch => "tool_search",
            Self::ProgrammaticTools => "programmatic_tools",
            Self::AsyncTools => "async_tools",
            Self::HostedSkills => "hosted_skills",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Capability {
    pub implemented: bool,
    /// A statement about evidence, NOT an account entitlement guarantee.
    pub verification: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderCapabilities {
    pub websocket: Capability,
    pub sse: Capability,
    pub continuation: Capability,
    pub function_tools: Capability,
    pub advanced: Vec<FeatureCapability>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FeatureCapability {
    pub feature: Feature,
    pub capability: Capability,
}
impl ProviderCapabilities {
    pub fn require(&self, features: &[Feature]) -> Result<()> {
        for feature in features {
            if !self
                .advanced
                .iter()
                .any(|c| c.feature == *feature && c.capability.implemented)
            {
                return Err(GatewayError::UnsupportedFeature(feature.name()));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub strict: bool,
}
impl ToolDefinition {
    pub fn validate(&self) -> Result<()> {
        if self.name.is_empty()
            || self.name.len() > 64
            || !self
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(GatewayError::InvalidRequest("invalid tool name"));
        }
        if self.description.len() > 8192
            || self.parameters.get("type").and_then(Value::as_str) != Some("object")
        {
            return Err(GatewayError::InvalidRequest(
                "tool requires an object parameter schema and bounded description",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionOptions {
    pub model: String,
    pub instructions: String,
    pub tools: Vec<ToolDefinition>,
    pub transport: Transport,
    /// Fail before authentication/networking rather than silently downgrade.
    pub required_features: Vec<Feature>,
}
impl SessionOptions {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            instructions: "You are a helpful assistant.".into(),
            tools: vec![],
            transport: Transport::WebSocket,
            required_features: vec![],
        }
    }
    pub fn validate(&self) -> Result<()> {
        if self.model.trim().is_empty()
            || self.model.len() > 256
            || self.instructions.trim().is_empty()
        {
            return Err(GatewayError::InvalidRequest(
                "model and instructions are required",
            ));
        }
        if self.tools.len() > MAX_TOOLS {
            return Err(GatewayError::InvalidRequest("too many tools"));
        }
        let mut names = std::collections::HashSet::new();
        for tool in &self.tools {
            tool.validate()?;
            if !names.insert(&tool.name) {
                return Err(GatewayError::InvalidRequest("duplicate tool name"));
            }
        }
        if serde_json::to_vec(self)
            .map_err(|_| GatewayError::Serialization)?
            .len()
            > MAX_INPUT_BYTES
        {
            return Err(GatewayError::InvalidRequest(
                "session configuration exceeds 1 MiB",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InputItem {
    User { text: String },
    ToolResult { call_id: String, output: String },
}
impl InputItem {
    pub fn user(text: impl Into<String>) -> Self {
        Self::User { text: text.into() }
    }
}
pub fn validate_input(input: &[InputItem]) -> Result<()> {
    if input.is_empty() || input.len() > 128 {
        return Err(GatewayError::InvalidRequest(
            "input must contain 1..128 items",
        ));
    }
    for item in input {
        match item {
            InputItem::User { text } if text.trim().is_empty() => {
                return Err(GatewayError::InvalidRequest("empty user input"));
            }
            InputItem::ToolResult { call_id, .. } if call_id.is_empty() || call_id.len() > 512 => {
                return Err(GatewayError::InvalidRequest("invalid tool call identifier"));
            }
            _ => {}
        }
    }
    if serde_json::to_vec(input)
        .map_err(|_| GatewayError::Serialization)?
        .len()
        > MAX_INPUT_BYTES
    {
        return Err(GatewayError::InvalidRequest("input exceeds 1 MiB"));
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Message,
    Reasoning,
    FunctionCall,
    CustomToolCall,
    ToolSearchCall,
    ToolSearchOutput,
    Program,
    ProgramOutput,
    Unknown,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CallOrigin {
    Direct,
    Programmatic,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FunctionCall {
    pub call_id: String,
    pub name: String,
    /// Kept as encoded JSON until the execution boundary validates it.
    pub arguments: String,
    pub origin: CallOrigin,
    pub namespace: Option<String>,
    pub complete: bool,
}

/// Native items are sensitive state. Do not put them in ordinary production logs.
/// Classification does not grant permission to execute an item.
#[derive(Clone, Serialize, Deserialize)]
pub struct OutputItem {
    pub id: Option<String>,
    pub kind: ItemKind,
    pub native_type: String,
    pub function_call: Option<FunctionCall>,
    pub native: Value,
}
impl std::fmt::Debug for OutputItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutputItem")
            .field("kind", &self.kind)
            .field("native", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ResponseOutcome {
    Completed,
    Incomplete { reason: Option<String> },
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cached_input_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ModelResponse {
    pub id: String,
    pub model: Option<String>,
    pub outcome: ResponseOutcome,
    pub output: Vec<OutputItem>,
    pub text: String,
    pub usage: Option<Usage>,
    pub native: Value,
}
impl std::fmt::Debug for ModelResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModelResponse")
            .field("outcome", &self.outcome)
            .field("output_items", &self.output.len())
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeltaKind {
    Text,
    Refusal,
    ReasoningSummary,
    ReasoningText,
    FunctionArguments,
    CustomToolInput,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpstreamOutcome {
    NotSubmitted,
    Unknown,
    TerminalReceived,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProviderEvent {
    SessionClosed {
        reason: String,
    },
    ResponseStarted {
        response_id: String,
    },
    ResponseStatus {
        response_id: String,
        status: String,
    },
    OutputItemStarted {
        response_id: String,
        output_index: u64,
        item: OutputItem,
    },
    OutputItemUpdated {
        response_id: String,
        item_id: String,
        output_index: u64,
        content_index: Option<u64>,
        summary_index: Option<u64>,
        kind: DeltaKind,
        delta: String,
    },
    OutputItemFinished {
        response_id: String,
        output_index: u64,
        item: OutputItem,
    },
    ResponseFinished {
        response: ModelResponse,
    },
    /// Includes local failures with explicit upstream uncertainty; not a fabricated
    /// OpenAI response.failed event.
    RequestFailed {
        code: String,
        message: String,
        upstream_outcome: UpstreamOutcome,
    },
    /// Preserve unknown/progress/annotation/part events without executing them.
    ProviderExtension {
        event_type: String,
        payload: Value,
    },
}

#[derive(Clone, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub schema_version: u32,
    /// Locally generated ordering, independent of OpenAI sequence_number.
    pub sequence: u64,
    pub event_id: String,
    pub session_id: String,
    pub request_id: Option<String>,
    pub provider: String,
    pub provider_sequence: Option<u64>,
    #[serde(flatten)]
    pub event: ProviderEvent,
}

/// One process-local admission. This is not a durable receipt or provider ACK.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RequestReceipt {
    pub request_id: String,
}

pub type ProviderStream = Pin<Box<dyn Stream<Item = EventEnvelope> + Send>>;

pub struct ProviderSession {
    pub id: String,
    pub control: Arc<dyn SessionControl>,
    pub events: ProviderStream,
}

/// Control and event reception are independent. Exactly one request is active
/// per session in this milestone. There is no implicit retry or reconnection.
#[async_trait]
pub trait SessionControl: Send + Sync {
    async fn generate(&self, input: Vec<InputItem>) -> Result<RequestReceipt>;
    /// Local interruption closes the entire session. It is not an upstream
    /// cancellation guarantee. Open a new session explicitly afterward.
    fn close(&self);
    async fn steer(&self, _text: String) -> Result<()> {
        Err(GatewayError::UnsupportedFeature("native_steering"))
    }
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;
    fn capabilities(&self) -> ProviderCapabilities;
    async fn open_session(&self, options: SessionOptions) -> Result<ProviderSession>;
}
