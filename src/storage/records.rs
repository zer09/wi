use std::{collections::HashSet, fmt};

use serde::{Deserialize, Serialize};

use crate::{
    InputItem, ToolDefinition,
    context::{PreparedRun, SkillId},
    run::{RunEvent, RunEventEnvelope, RunRequest, RunResult},
    tools::ToolRegistry,
    validate_input,
};

use super::{RunId, StorageError, StorageErrorKind};

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
    pub(super) fn validate(&self) -> Result<()> {
        match self {
            Self::Runtime(event) => validate_runtime(event),
            Self::Result(result) => result.run_id.parse::<RunId>().map(|_| ()),
            Self::ToolResult { .. } => Ok(()),
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
