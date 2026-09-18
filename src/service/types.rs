use std::fmt;

use crate::{
    execution::{PersistentRunFailure, PersistentRunResult},
    storage::StorageError,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunHostError {
    RuntimeUnavailable,
    Closed,
}

impl RunHostError {
    pub fn code(self) -> &'static str {
        match self {
            Self::RuntimeUnavailable => "host.runtime_unavailable",
            Self::Closed => "host.closed",
        }
    }
}

impl fmt::Display for RunHostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for RunHostError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelDisposition {
    Requested,
    NotTracked,
    Closed,
}

pub enum RunCompletion {
    Execution(Result<PersistentRunResult, PersistentRunFailure>),
    SessionOpenFailed(StorageError),
    WorkerLost,
}

impl fmt::Debug for RunCompletion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Execution(_) => f.write_str("RunCompletion::Execution([redacted])"),
            Self::SessionOpenFailed(_) => {
                f.write_str("RunCompletion::SessionOpenFailed([redacted])")
            }
            Self::WorkerLost => f.write_str("RunCompletion::WorkerLost"),
        }
    }
}

pub enum ShutdownOutcome {
    Closed,
    Incomplete {
        worker_lost: bool,
        storage_error: Option<StorageError>,
    },
}

impl fmt::Debug for ShutdownOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => f.write_str("ShutdownOutcome::Closed"),
            Self::Incomplete { .. } => f.write_str("ShutdownOutcome::Incomplete([redacted])"),
        }
    }
}
