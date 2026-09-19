//! Explicit browser data. No native objects, prepared requests or provider identities are serialized.
mod errors;
mod events;
mod provider;

pub use errors::{ApiError, CertaintyView, ErrorView, NoticeView, SafeCode, safe_code};
pub use events::{EventData, EventView};
pub use provider::{
    FunctionCallView, IncompleteReason, ItemView, ResponseOutcomeView, ResponseStatus,
    ResponseView, TextBlockKind, TextBlockView, UsageView,
};

use super::{
    ApiSettings,
    wire::{Cursor, CursorError, Decimal},
};
use crate::{
    Transport, UpstreamOutcome,
    run::{RunOutcome, RunResult, RunSinkError, RunSummary, TurnOutcome},
    storage::{
        ApplicationSessionId, CommitReceipt, CommitResult, CreateResult, HistoryPage, OperationId,
        RecordedRun, RecordedRunState, RefreshResult, RunId, SessionAvailability, SessionManifest,
        SessionPage, SessionSummary,
    },
};
use serde::{Serialize, Serializer};

#[derive(Clone, Copy)]
struct ApiVersion;
impl Serialize for ApiVersion {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(1)
    }
}

#[derive(Clone, Serialize)]
pub struct SettingsView {
    api_version: ApiVersion,
    workspaces: Vec<String>,
    provider_id: String,
    model: String,
    provider_transport: &'static str,
    enable_add_numbers: bool,
}
impl From<&ApiSettings> for SettingsView {
    fn from(value: &ApiSettings) -> Self {
        Self {
            api_version: ApiVersion,
            workspaces: value.workspaces().to_vec(),
            provider_id: value.provider_id().to_owned(),
            model: value.options().model.clone(),
            provider_transport: match value.options().transport {
                Transport::WebSocket => "websocket",
                Transport::Sse => "sse",
            },
            enable_add_numbers: value.enable_add_numbers(),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct ReceiptView {
    operation_id: OperationId,
    session_id: ApplicationSessionId,
    run_id: Option<RunId>,
    first_sequence: Decimal,
    last_sequence: Decimal,
}
impl From<&CommitReceipt> for ReceiptView {
    fn from(value: &CommitReceipt) -> Self {
        Self {
            operation_id: value.operation_id().clone(),
            session_id: value.session_id().clone(),
            run_id: value.run_id().cloned(),
            first_sequence: value.first_sequence().into(),
            last_sequence: value.last_sequence().into(),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct OperationView {
    api_version: ApiVersion,
    #[serde(flatten)]
    receipt: ReceiptView,
}
impl From<&CommitReceipt> for OperationView {
    fn from(value: &CommitReceipt) -> Self {
        Self {
            api_version: ApiVersion,
            receipt: value.into(),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct MutationView {
    api_version: ApiVersion,
    receipt: ReceiptView,
    duplicate: bool,
    warning_code: Option<&'static str>,
}
impl From<&CommitResult> for MutationView {
    fn from(value: &CommitResult) -> Self {
        Self {
            api_version: ApiVersion,
            receipt: value.receipt().into(),
            duplicate: value.duplicate(),
            warning_code: value.cleanup_warning().map(|warning| warning.code()),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct CreateView {
    #[serde(flatten)]
    commit: MutationView,
    session_id: ApplicationSessionId,
}
impl From<&CreateResult> for CreateView {
    fn from(value: &CreateResult) -> Self {
        Self {
            commit: value.commit().into(),
            session_id: value.session_id().clone(),
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RefreshDisposition {
    Updated,
    Unchanged,
}
impl From<RefreshResult> for RefreshDisposition {
    fn from(value: RefreshResult) -> Self {
        match value {
            RefreshResult::Updated => Self::Updated,
            RefreshResult::Unchanged => Self::Unchanged,
        }
    }
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogRefresh {
    Updated,
    Unchanged,
    NotAttempted,
    Failed,
}
impl From<RefreshResult> for CatalogRefresh {
    fn from(value: RefreshResult) -> Self {
        match value {
            RefreshResult::Updated => Self::Updated,
            RefreshResult::Unchanged => Self::Unchanged,
        }
    }
}
#[derive(Clone, Serialize)]
pub struct RenameView {
    #[serde(flatten)]
    commit: MutationView,
    catalog_refresh: CatalogRefresh,
}
impl RenameView {
    pub fn new(commit: &CommitResult, catalog_refresh: CatalogRefresh) -> Self {
        Self {
            commit: commit.into(),
            catalog_refresh,
        }
    }
}
#[derive(Clone, Serialize)]
pub struct RefreshView {
    api_version: ApiVersion,
    session_id: ApplicationSessionId,
    disposition: RefreshDisposition,
}
impl RefreshView {
    pub fn new(session_id: ApplicationSessionId, result: RefreshResult) -> Self {
        Self {
            api_version: ApiVersion,
            session_id,
            disposition: result.into(),
        }
    }
}
#[derive(Clone, Serialize)]
pub struct TaskAcceptedView {
    #[serde(flatten)]
    commit: MutationView,
    notices: Vec<NoticeView>,
}
impl TaskAcceptedView {
    pub(in crate::http_api) fn receipt(
        receipt: &CommitReceipt,
        duplicate: bool,
        warning_code: Option<&'static str>,
        notices: Vec<NoticeView>,
    ) -> Self {
        Self {
            commit: MutationView {
                api_version: ApiVersion,
                receipt: receipt.into(),
                duplicate,
                warning_code,
            },
            notices,
        }
    }

    pub fn new(commit: &CommitResult, notices: Vec<NoticeView>) -> Self {
        Self {
            commit: commit.into(),
            notices,
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelDisposition {
    Requested,
    NotTracked,
}
#[derive(Clone, Serialize)]
pub struct CancelView {
    api_version: ApiVersion,
    session_id: ApplicationSessionId,
    run_id: RunId,
    disposition: CancelDisposition,
}
impl CancelView {
    pub fn new(
        session_id: ApplicationSessionId,
        run_id: RunId,
        disposition: CancelDisposition,
    ) -> Self {
        Self {
            api_version: ApiVersion,
            session_id,
            run_id,
            disposition,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct SessionView {
    api_version: ApiVersion,
    session_id: ApplicationSessionId,
    title: String,
    workspace: Option<String>,
    created_at_ms: Decimal,
    updated_at_ms: Decimal,
    head_sequence: Decimal,
    view: &'static str,
}
impl From<&SessionManifest> for SessionView {
    fn from(value: &SessionManifest) -> Self {
        Self {
            api_version: ApiVersion,
            session_id: value.session_id().clone(),
            title: value.title().to_owned(),
            workspace: value.workspace().map(str::to_owned),
            created_at_ms: (value.created_at_ms() as u64).into(),
            updated_at_ms: (value.updated_at_ms() as u64).into(),
            head_sequence: value.head_sequence().into(),
            view: "canonical",
        }
    }
}

#[derive(Clone, Serialize)]
pub struct CatalogEntryView {
    session_id: ApplicationSessionId,
    title: String,
    workspace: Option<String>,
    created_at_ms: Decimal,
    updated_at_ms: Decimal,
    observed_head_sequence: Decimal,
    view: &'static str,
    availability: SessionAvailability,
    fault_code: Option<&'static str>,
    last_run_id: Option<RunId>,
    last_run_state: Option<RecordedRunState>,
}
impl From<&SessionSummary> for CatalogEntryView {
    fn from(value: &SessionSummary) -> Self {
        let manifest = value.observed_manifest();
        Self {
            session_id: manifest.session_id().clone(),
            title: manifest.title().to_owned(),
            workspace: manifest.workspace().map(str::to_owned),
            created_at_ms: (manifest.created_at_ms() as u64).into(),
            updated_at_ms: (manifest.updated_at_ms() as u64).into(),
            observed_head_sequence: value.observed_head_sequence().into(),
            view: "catalog",
            availability: value.availability(),
            fault_code: value.fault_code(),
            last_run_id: value.last_run_id().cloned(),
            last_run_state: value.last_run_state(),
        }
    }
}
#[derive(Clone, Serialize)]
pub struct CatalogView {
    api_version: ApiVersion,
    entries: Vec<CatalogEntryView>,
    next_after_id: Option<ApplicationSessionId>,
    has_more: bool,
}
impl From<&SessionPage> for CatalogView {
    fn from(value: &SessionPage) -> Self {
        Self {
            api_version: ApiVersion,
            entries: value.sessions().iter().map(Into::into).collect(),
            next_after_id: value.next_after().cloned(),
            has_more: value.has_more(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutcomeView {
    Completed,
    CancelledLocally,
    Failed { code: SafeCode },
}
impl From<&RunOutcome> for OutcomeView {
    fn from(value: &RunOutcome) -> Self {
        match value {
            RunOutcome::Completed => Self::Completed,
            RunOutcome::CancelledLocally => Self::CancelledLocally,
            RunOutcome::Failed { code } => Self::Failed {
                code: safe_code(code),
            },
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TurnOutcomeView {
    ModelCompleted,
    ToolsPrepared,
    Stopped { reason: OutcomeView },
}
impl From<&TurnOutcome> for TurnOutcomeView {
    fn from(value: &TurnOutcome) -> Self {
        match value {
            TurnOutcome::ModelCompleted => Self::ModelCompleted,
            TurnOutcome::ToolsPrepared => Self::ToolsPrepared,
            TurnOutcome::Stopped { reason } => Self::Stopped {
                reason: reason.into(),
            },
        }
    }
}
#[derive(Clone, Serialize)]
pub struct SummaryView {
    turns_started: Decimal,
    turns_finished: Decimal,
    model_requests_attempted: Decimal,
    model_requests_admitted: Decimal,
    new_tool_dispatches: Decimal,
    tool_results_prepared: Decimal,
    reused_results: Decimal,
    last_request_id: Option<String>,
    last_upstream_outcome: Option<UpstreamOutcome>,
}
impl From<&RunSummary> for SummaryView {
    fn from(value: &RunSummary) -> Self {
        Self {
            turns_started: value.turns_started.into(),
            turns_finished: value.turns_finished.into(),
            model_requests_attempted: value.model_requests_attempted.into(),
            model_requests_admitted: value.model_requests_admitted.into(),
            new_tool_dispatches: value.new_tool_dispatches.into(),
            tool_results_prepared: value.tool_results_prepared.into(),
            reused_results: value.reused_results.into(),
            last_request_id: value.last_request_id.clone(),
            last_upstream_outcome: value.last_upstream_outcome,
        }
    }
}
#[derive(Clone, Serialize)]
pub struct ResultView {
    outcome: OutcomeView,
    summary: SummaryView,
    events_complete: bool,
    sink_error: Option<RunSinkError>,
}
impl From<&RunResult> for ResultView {
    fn from(value: &RunResult) -> Self {
        Self {
            outcome: (&value.outcome).into(),
            summary: (&value.summary).into(),
            events_complete: value.events_complete,
            sink_error: value.sink_error,
        }
    }
}
#[derive(Clone, Serialize)]
pub struct RunView {
    api_version: ApiVersion,
    run_id: RunId,
    state: RecordedRunState,
    user_text: String,
    accepted_sequence: Decimal,
    terminal_sequence: Option<Decimal>,
    result_sequence: Option<Decimal>,
    result_recorded: bool,
    result: Option<ResultView>,
}
impl From<&RecordedRun> for RunView {
    fn from(value: &RecordedRun) -> Self {
        Self {
            api_version: ApiVersion,
            run_id: value.run_id().clone(),
            state: value.state(),
            user_text: value.input().user_text().to_owned(),
            accepted_sequence: value.accepted_sequence().into(),
            terminal_sequence: value.terminal_sequence().map(Into::into),
            result_sequence: value.result_sequence().map(Into::into),
            result_recorded: value.result().is_some(),
            result: value.result().map(Into::into),
        }
    }
}
#[derive(Clone, Serialize)]
pub struct HistoryView {
    api_version: ApiVersion,
    session_id: ApplicationSessionId,
    through_sequence: Decimal,
    next_after: Cursor,
    has_more: bool,
    events: Vec<EventView>,
}
impl HistoryView {
    pub fn new(session_id: ApplicationSessionId, page: &HistoryPage) -> Result<Self, CursorError> {
        let next_after = Cursor::new(session_id.clone(), page.next_after())?;
        Ok(Self {
            api_version: ApiVersion,
            session_id,
            through_sequence: page.through_sequence().into(),
            next_after,
            has_more: page.has_more(),
            events: page.records().iter().map(Into::into).collect(),
        })
    }
}

#[cfg(test)]
mod tests;
