use serde::Serialize;

use super::{ApiVersion, ReceiptView};
use crate::{
    GatewayError,
    context::{ContextDiagnostic, ContextError, ContextErrorKind, DiagnosticKind, Scope},
    execution::PersistentRunStage,
    storage::{CommitCertainty, CommitReceipt, StorageError, StorageErrorKind},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct SafeCode(&'static str);

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

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CertaintyView {
    NotApplicable,
    NotCommitted,
    Unknown,
}
impl From<CommitCertainty> for CertaintyView {
    fn from(value: CommitCertainty) -> Self {
        match value {
            CommitCertainty::NotApplicable => Self::NotApplicable,
            CommitCertainty::NotCommitted => Self::NotCommitted,
            CommitCertainty::Unknown => Self::Unknown,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct NoticeView {
    scope: &'static str,
    source_label: String,
    kind: String,
}
impl From<&ContextDiagnostic> for NoticeView {
    fn from(value: &ContextDiagnostic) -> Self {
        Self {
            scope: match value.scope() {
                Scope::Global => "global",
                Scope::Project => "project",
            },
            source_label: value.source_label().to_owned(),
            kind: match value.kind() {
                DiagnosticKind::Excluded(kind) => format!("excluded.{}", kind.category()),
                DiagnosticKind::SkippedSymlink => "skipped_symlink".into(),
                DiagnosticKind::DirectoryNameMismatch => "directory_name_mismatch".into(),
                DiagnosticKind::UnsupportedBehavioralMetadata => {
                    "unsupported_behavioral_metadata".into()
                }
            },
        }
    }
}

#[derive(Clone, Copy)]
pub enum ApiError {
    Unauthorized,
    OriginForbidden,
    WorkspaceForbidden,
    AuthorityInvalid,
    InvalidRequest,
    CursorInvalid,
    BodyTooLarge,
    UnsupportedMedia,
    NotFound,
    MethodNotAllowed,
    WorkerLost,
    Closed,
}
impl ApiError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unauthorized => "api.unauthorized",
            Self::OriginForbidden => "api.origin_forbidden",
            Self::WorkspaceForbidden => "api.workspace_forbidden",
            Self::AuthorityInvalid => "api.authority_invalid",
            Self::InvalidRequest => "api.invalid_request",
            Self::CursorInvalid => "api.cursor_invalid",
            Self::BodyTooLarge => "api.body_too_large",
            Self::UnsupportedMedia => "api.unsupported_media",
            Self::NotFound => "api.not_found",
            Self::MethodNotAllowed => "api.method_not_allowed",
            Self::WorkerLost => "api.worker_lost",
            Self::Closed => "api.closed",
        }
    }
    pub fn status(self) -> u16 {
        match self {
            Self::Unauthorized => 401,
            Self::OriginForbidden | Self::WorkspaceForbidden => 403,
            Self::AuthorityInvalid => 421,
            Self::InvalidRequest | Self::CursorInvalid => 400,
            Self::BodyTooLarge => 413,
            Self::UnsupportedMedia => 415,
            Self::NotFound => 404,
            Self::MethodNotAllowed => 405,
            Self::WorkerLost | Self::Closed => 503,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct ErrorView {
    api_version: ApiVersion,
    code: &'static str,
    stage: Option<&'static str>,
    certainty: CertaintyView,
    acceptance: Option<ReceiptView>,
    notices: Vec<NoticeView>,
    #[serde(skip)]
    status: u16,
}
impl ErrorView {
    fn new(code: &'static str, status: u16, certainty: CommitCertainty) -> Self {
        Self {
            api_version: ApiVersion,
            code,
            stage: None,
            certainty: certainty.into(),
            acceptance: None,
            notices: Vec::new(),
            status,
        }
    }
    pub fn api(error: ApiError) -> Self {
        Self::new(error.code(), error.status(), CommitCertainty::NotApplicable)
    }
    pub fn storage(error: &StorageError) -> Self {
        use StorageErrorKind::*;
        let status = match error.kind() {
            InvalidInput => 400,
            CommandConflict | ActiveRunExists | StaleHistory | InvalidTransition => 409,
            NotFound => 404,
            Busy
            | Closed
            | Unavailable
            | CatalogRepairRequired
            | CreationIncomplete
            | Io
            | CommitUnknown => 503,
            Integrity | UnsupportedVersion => 500,
        };
        Self::new(error.code(), status, error.certainty())
    }
    pub(in crate::http_api) fn command_conflict() -> Self {
        Self::new(
            "storage.command_conflict",
            409,
            CommitCertainty::NotApplicable,
        )
    }
    pub(in crate::http_api) fn integrity() -> Self {
        Self::new("storage.integrity", 500, CommitCertainty::NotApplicable)
    }
    pub fn gateway(error: &GatewayError) -> Self {
        Self::new(error.code(), 422, CommitCertainty::NotApplicable)
    }
    pub fn context(error: &ContextError, notices: Vec<NoticeView>) -> Self {
        use ContextErrorKind::*;
        let code = match error.kind() {
            InvalidRoot => "context.invalid_root",
            ReadFailed => "context.read_failed",
            InvalidFrontmatter => "context.invalid_frontmatter",
            DuplicateSkill => "context.duplicate_skill",
            InvalidSkillId => "context.invalid_skill_id",
            UnknownSkill => "context.unknown_skill",
            ContextChanged => "context.context_changed",
            InvalidBody => "context.invalid_body",
            InvalidRequest => "context.invalid_request",
            InputTooLarge => "context.input_too_large",
        };
        let status = if error.kind() == InputTooLarge {
            413
        } else {
            422
        };
        Self::new(code, status, CommitCertainty::NotApplicable).with_notices(notices)
    }
    pub fn with_stage(mut self, stage: PersistentRunStage) -> Self {
        self.stage = Some(stage.as_str());
        self
    }
    pub fn with_acceptance(mut self, receipt: &CommitReceipt) -> Self {
        self.acceptance = Some(receipt.into());
        self
    }
    pub fn with_certainty(mut self, certainty: CommitCertainty) -> Self {
        self.certainty = certainty.into();
        self
    }
    pub fn with_notices(mut self, notices: Vec<NoticeView>) -> Self {
        self.notices = notices;
        self
    }
    pub fn status(&self) -> u16 {
        self.status
    }
    pub fn code(&self) -> &'static str {
        self.code
    }
}
