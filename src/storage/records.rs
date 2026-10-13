use std::{collections::HashSet, fmt};

use serde::{Deserialize, Serialize};

use crate::{
    InputItem, ToolDefinition,
    context::{PreparedRun, SkillId},
    identifiers::is_canonical_uuid,
    run::{RunEvent, RunEventEnvelope, RunRequest, RunResult},
    tools::{ToolExecutionEvent, ToolRegistry},
    validate_input,
};

use super::{RecordedProviderBinding, RunId, StorageError, StorageErrorKind};

type Result<T> = std::result::Result<T, StorageError>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(try_from = "InputFields")]
pub struct RecordedRunInput {
    user_text: String,
    prepared_request: RunRequest,
    tool_definitions: Vec<ToolDefinition>,
    available_skills: Vec<String>,
    active_skills: Vec<String>,
    project_instructions_source: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InputFields {
    user_text: String,
    prepared_request: RunRequest,
    tool_definitions: Vec<ToolDefinition>,
    available_skills: Vec<String>,
    active_skills: Vec<String>,
    project_instructions_source: Option<String>,
}

impl TryFrom<InputFields> for RecordedRunInput {
    type Error = StorageError;

    fn try_from(value: InputFields) -> Result<Self> {
        Self::new(
            value.user_text,
            value.prepared_request,
            value.tool_definitions,
            value.available_skills,
            value.active_skills,
            value.project_instructions_source,
        )
    }
}

impl RecordedRunInput {
    pub fn new(
        user_text: String,
        prepared_request: RunRequest,
        tool_definitions: Vec<ToolDefinition>,
        available_skills: Vec<String>,
        active_skills: Vec<String>,
        project_instructions_source: Option<String>,
    ) -> Result<Self> {
        if !prepared_request.options.tools.is_empty() {
            return Err(invalid());
        }
        validate_input(&[InputItem::user(user_text.clone())]).map_err(|_| invalid())?;
        validate_input(&[InputItem::user(prepared_request.prompt.clone())])
            .map_err(|_| invalid())?;
        // Validate the execution options without changing the captured prepared request.
        let mut options = prepared_request.options.clone();
        options.tools = tool_definitions.clone();
        options.validate().map_err(|_| invalid())?;
        let mut available = HashSet::new();
        for id in &available_skills {
            id.parse::<SkillId>().map_err(|_| invalid())?;
            if !available.insert(id) {
                return Err(invalid());
            }
        }
        let mut active = HashSet::new();
        for id in &active_skills {
            if !available.contains(id) || !active.insert(id) {
                return Err(invalid());
            }
        }
        if project_instructions_source
            .as_deref()
            .is_some_and(|s| s != "project:AGENTS.md")
        {
            return Err(invalid());
        }
        Ok(Self {
            user_text,
            prepared_request,
            tool_definitions,
            available_skills,
            active_skills,
            project_instructions_source,
        })
    }

    /// Copy a prepared snapshot and its matching registry; do not reload context or execute tools.
    pub fn capture(
        user_text: String,
        prepared: &PreparedRun,
        tools: &ToolRegistry,
    ) -> Result<Self> {
        let manifest = prepared.manifest();
        Self::new(
            user_text,
            prepared.request().clone(),
            tools.definitions(),
            manifest
                .available_skills()
                .iter()
                .map(ToString::to_string)
                .collect(),
            manifest
                .active_skills()
                .iter()
                .map(ToString::to_string)
                .collect(),
            manifest.project_instructions_source().map(str::to_owned),
        )
    }

    pub fn user_text(&self) -> &str {
        &self.user_text
    }
    pub fn prepared_request(&self) -> &RunRequest {
        &self.prepared_request
    }
    pub fn tool_definitions(&self) -> &[ToolDefinition] {
        &self.tool_definitions
    }
    pub fn available_skills(&self) -> &[String] {
        &self.available_skills
    }
    pub fn active_skills(&self) -> &[String] {
        &self.active_skills
    }
    pub fn project_instructions_source(&self) -> Option<&str> {
        self.project_instructions_source.as_deref()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    try_from = "AppendFields",
    tag = "type",
    content = "payload",
    rename_all = "snake_case"
)]
pub enum AppendRunRecord {
    ProviderBinding(RecordedProviderBinding),
    Runtime(RunEventEnvelope),
    ToolResult {
        request_id: Option<String>,
        call_id: String,
        output: String,
        is_error: bool,
    },
    Result(RunResult),
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "snake_case",
    deny_unknown_fields
)]
enum AppendFields {
    ProviderBinding(RecordedProviderBinding),
    Runtime(RunEventEnvelope),
    ToolResult {
        request_id: Option<String>,
        call_id: String,
        output: String,
        is_error: bool,
    },
    Result(RunResult),
}

impl TryFrom<AppendFields> for AppendRunRecord {
    type Error = StorageError;

    fn try_from(value: AppendFields) -> Result<Self> {
        let record = match value {
            AppendFields::ProviderBinding(binding) => Self::ProviderBinding(binding),
            AppendFields::Runtime(event) => Self::Runtime(event),
            AppendFields::ToolResult {
                request_id,
                call_id,
                output,
                is_error,
            } => Self::ToolResult {
                request_id,
                call_id,
                output,
                is_error,
            },
            AppendFields::Result(result) => Self::Result(result),
        };
        record.validate()?;
        Ok(record)
    }
}

impl AppendRunRecord {
    // Receipt lookup and historical decoding use the old structural rules. Only
    // a novel append applies these stricter Wi identity and execution bounds.
    pub(super) fn validate_admission(&self) -> Result<()> {
        self.validate()?;
        let optional_uuid = |value: &Option<String>| value.as_deref().is_none_or(is_canonical_uuid);
        let call_valid = |value: &str| !value.is_empty() && value.len() <= 512;
        let valid = match self {
            Self::Runtime(event) => {
                let nested_valid = match &event.event {
                    RunEvent::ProviderEvent { event } => optional_uuid(&event.request_id),
                    RunEvent::RunFinished { summary, .. } => {
                        optional_uuid(&summary.last_request_id)
                    }
                    RunEvent::ToolEvent { event } => {
                        let (ToolExecutionEvent::ToolExecutionStarted { call_id, .. }
                        | ToolExecutionEvent::ToolExecutionFinished { call_id, .. }
                        | ToolExecutionEvent::ToolResultReused { call_id, .. }) = event;
                        call_valid(call_id)
                    }
                    _ => true,
                };
                is_canonical_uuid(&event.run_id)
                    && is_canonical_uuid(&event.event_id)
                    && optional_uuid(&event.turn_id)
                    && optional_uuid(&event.request_id)
                    && nested_valid
            }
            Self::ToolResult {
                request_id,
                call_id,
                ..
            } => optional_uuid(request_id) && call_valid(call_id),
            Self::Result(result) => {
                is_canonical_uuid(&result.run_id) && optional_uuid(&result.summary.last_request_id)
            }
            Self::ProviderBinding(_) => true,
        };
        if !valid {
            return Err(invalid());
        }
        Ok(())
    }

    // Use the accepted run, not an untrusted nested provider label. Historical
    // decoding and binding reads deliberately do not call this admission check.
    pub(super) fn validate_provider_admission(&self, provider: &str) -> Result<()> {
        if provider != crate::providers::openai_codex::PROVIDER_ID {
            return Ok(());
        }
        let optional_uuid = |value: &Option<String>| value.as_deref().is_none_or(is_canonical_uuid);
        let valid = match self {
            Self::Runtime(event) => {
                if let RunEvent::ProviderEvent { event: nested } = &event.event {
                    if nested.provider != provider {
                        return Err(StorageError::new(StorageErrorKind::InvalidTransition));
                    }
                    if !crate::identifiers::is_local_event_id(
                        &nested.event_id,
                        &nested.session_id,
                        nested.sequence,
                    ) {
                        return Err(invalid());
                    }
                }
                optional_uuid(&event.session_id)
            }
            Self::Result(result) => optional_uuid(&result.session_id),
            Self::ProviderBinding(binding) => is_canonical_uuid(binding.provider_session_id()),
            Self::ToolResult { .. } => true,
        };
        if !valid {
            return Err(invalid());
        }
        Ok(())
    }

    pub(super) fn validate(&self) -> Result<()> {
        match self {
            Self::Runtime(event) => validate_runtime(event),
            Self::Result(result) => result.run_id.parse::<RunId>().map(|_| ()),
            Self::ToolResult { .. } | Self::ProviderBinding(_) => Ok(()),
        }
    }
}

pub(super) fn validate_runtime(event: &RunEventEnvelope) -> Result<()> {
    if event.schema_version != 2
        || matches!(&event.event, RunEvent::ProviderEvent { event } if event.schema_version != 1)
    {
        return Err(StorageError::new(StorageErrorKind::UnsupportedVersion));
    }
    event.run_id.parse::<RunId>()?;
    if event.sequence == 0 || event.sequence > i64::MAX as u64 || event.event_id.is_empty() {
        return Err(invalid());
    }
    let identities_valid = match &event.event {
        RunEvent::RunStarted => {
            event.turn_id.is_none() && event.session_id.is_none() && event.request_id.is_none()
        }
        RunEvent::TurnStarted { .. } => {
            event.turn_id.is_some() && event.session_id.is_some() && event.request_id.is_none()
        }
        RunEvent::ProviderEvent { event: provider } => {
            event.turn_id.is_some()
                && event.session_id.as_deref() == Some(provider.session_id.as_str())
                && event.request_id.is_some()
                && event.request_id == provider.request_id
        }
        RunEvent::ToolEvent { .. } => {
            event.turn_id.is_some() && event.session_id.is_some() && event.request_id.is_some()
        }
        RunEvent::TurnFinished { .. } => event.turn_id.is_some() && event.session_id.is_some(),
        RunEvent::RunFinished { .. } => event.turn_id.is_none(),
    };
    if !identities_valid {
        return Err(StorageError::new(StorageErrorKind::InvalidTransition));
    }
    Ok(())
}

pub(super) fn invalid() -> StorageError {
    StorageError::new(StorageErrorKind::InvalidInput)
}

impl fmt::Debug for RecordedRunInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecordedRunInput([redacted])")
    }
}
impl fmt::Debug for AppendRunRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AppendRunRecord([redacted])")
    }
}
