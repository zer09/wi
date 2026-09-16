use std::fmt;

use crate::{
    GatewayError,
    run::RunResult,
    storage::{
        CleanupWarning, CommitReceipt, CommitResult, OperationId, RecordedRun, RecordedRunInput,
        RunId, StorageError,
    },
};

pub struct PersistentRunRequest {
    pub operation_id: OperationId,
    pub run_id: RunId,
    pub input: RecordedRunInput,
}

pub enum PersistentRunResult {
    Executed {
        acceptance: CommitResult,
        final_record: CommitResult,
        result: Box<RunResult>,
    },
    Duplicate {
        acceptance: CommitResult,
        run: Box<RecordedRun>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PersistentRunStage {
    Lookup,
    Preflight,
    History,
    Acceptance,
    ProviderBinding,
    RuntimeEvent,
    ToolResult,
    FinalResult,
}

impl PersistentRunStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lookup => "lookup",
            Self::Preflight => "preflight",
            Self::History => "history",
            Self::Acceptance => "acceptance",
            Self::ProviderBinding => "provider_binding",
            Self::RuntimeEvent => "runtime_event",
            Self::ToolResult => "tool_result",
            Self::FinalResult => "final_result",
        }
    }
}

pub enum PersistentRunCause {
    Gateway(GatewayError),
    Storage(StorageError),
    Cleanup {
        warning: CleanupWarning,
        commit: CommitResult,
    },
}

impl PersistentRunCause {
    fn category(&self) -> &'static str {
        match self {
            Self::Gateway(_) => "gateway",
            Self::Storage(_) => "storage",
            Self::Cleanup { .. } => "committed_cleanup_warning",
        }
    }
}

pub struct PersistentRunFailure(Box<FailureDetails>);

struct FailureDetails {
    stage: PersistentRunStage,
    cause: PersistentRunCause,
    operation_id: Option<OperationId>,
    acceptance: Option<CommitReceipt>,
    observed_result: Option<RunResult>,
}

impl PersistentRunFailure {
    pub fn stage(&self) -> PersistentRunStage {
        self.0.stage
    }
    pub fn cause(&self) -> &PersistentRunCause {
        &self.0.cause
    }
    pub fn operation_id(&self) -> Option<&OperationId> {
        self.0.operation_id.as_ref()
    }
    pub fn acceptance(&self) -> Option<&CommitReceipt> {
        self.0.acceptance.as_ref()
    }
    pub fn observed_result(&self) -> Option<&RunResult> {
        self.0.observed_result.as_ref()
    }

    pub(super) fn storage(
        stage: PersistentRunStage,
        operation_id: OperationId,
        error: StorageError,
    ) -> Self {
        Self::new(
            stage,
            Some(operation_id),
            PersistentRunCause::Storage(error),
        )
    }

    pub(super) fn preflight(error: GatewayError) -> Self {
        Self::new(
            PersistentRunStage::Preflight,
            None,
            PersistentRunCause::Gateway(error),
        )
    }

    pub(super) fn history(cause: PersistentRunCause) -> Self {
        Self::new(PersistentRunStage::History, None, cause)
    }

    fn new(
        stage: PersistentRunStage,
        operation_id: Option<OperationId>,
        cause: PersistentRunCause,
    ) -> Self {
        Self(Box::new(FailureDetails {
            stage,
            cause,
            operation_id,
            acceptance: None,
            observed_result: None,
        }))
    }

    pub(super) fn with_acceptance(mut self, acceptance: &CommitResult) -> Self {
        self.0.acceptance = Some(acceptance.receipt().clone());
        self
    }

    pub(super) fn with_execution(mut self, acceptance: &CommitResult, result: RunResult) -> Self {
        self.0.observed_result = Some(result);
        self.with_acceptance(acceptance)
    }
}

pub(super) fn check_commit(
    stage: PersistentRunStage,
    operation_id: OperationId,
    result: Result<CommitResult, StorageError>,
) -> Result<CommitResult, PersistentRunFailure> {
    let commit = result
        .map_err(|error| PersistentRunFailure::storage(stage, operation_id.clone(), error))?;
    // No work follows a committed final result. Return its warning with the receipt.
    if stage == PersistentRunStage::FinalResult {
        return Ok(commit);
    }
    if let Some(warning) = commit.cleanup_warning() {
        let acceptance = if stage == PersistentRunStage::Acceptance {
            Some(commit.receipt().clone())
        } else {
            None
        };
        let mut failure = PersistentRunFailure::new(
            stage,
            Some(operation_id),
            PersistentRunCause::Cleanup { warning, commit },
        );
        failure.0.acceptance = acceptance;
        return Err(failure);
    }
    Ok(commit)
}

impl fmt::Debug for PersistentRunRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PersistentRunRequest([redacted])")
    }
}
impl fmt::Debug for PersistentRunResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Executed { .. } => f.write_str("PersistentRunResult::Executed([redacted])"),
            Self::Duplicate { .. } => f.write_str("PersistentRunResult::Duplicate([redacted])"),
        }
    }
}
impl fmt::Debug for PersistentRunCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.category())
    }
}
impl fmt::Display for PersistentRunCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.category())
    }
}
impl fmt::Display for PersistentRunFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "persistent run {}: {}",
            self.stage().as_str(),
            self.cause().category()
        )
    }
}
impl fmt::Debug for PersistentRunFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}
// Concrete causes are available explicitly, not through diagnostic source chains.
impl std::error::Error for PersistentRunFailure {}
