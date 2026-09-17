use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitCertainty {
    NotApplicable,
    NotCommitted,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageErrorKind {
    InvalidInput,
    Busy,
    Closed,
    NotFound,
    Unavailable,
    UnsupportedVersion,
    Integrity,
    CommandConflict,
    InvalidTransition,
    ActiveRunExists,
    StaleHistory,
    CatalogRepairRequired,
    CreationIncomplete,
    Io,
    CommitUnknown,
}

/// Diagnostics contain only fixed codes and certainty, never underlying error text.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct StorageError {
    kind: StorageErrorKind,
    certainty: CommitCertainty,
}

impl StorageError {
    pub(super) const fn new(kind: StorageErrorKind) -> Self {
        let certainty = match kind {
            StorageErrorKind::CommitUnknown => CommitCertainty::Unknown,
            _ => CommitCertainty::NotApplicable,
        };
        Self { kind, certainty }
    }

    pub(super) fn not_committed(mut self) -> Self {
        self.certainty = CommitCertainty::NotCommitted;
        self
    }

    pub(super) fn unknown(mut self) -> Self {
        self.certainty = CommitCertainty::Unknown;
        self
    }

    pub(super) fn from_code(code: &str) -> Option<Self> {
        use StorageErrorKind::*;
        [
            InvalidInput,
            Busy,
            Closed,
            NotFound,
            Unavailable,
            UnsupportedVersion,
            Integrity,
            CommandConflict,
            InvalidTransition,
            ActiveRunExists,
            CatalogRepairRequired,
            CreationIncomplete,
            Io,
            CommitUnknown,
            StaleHistory,
        ]
        .into_iter()
        .map(Self::new)
        .find(|error| error.code() == code)
    }

    pub const fn kind(&self) -> StorageErrorKind {
        self.kind
    }

    pub const fn certainty(&self) -> CommitCertainty {
        self.certainty
    }

    pub const fn code(&self) -> &'static str {
        match self.kind {
            StorageErrorKind::InvalidInput => "storage.invalid_input",
            StorageErrorKind::Busy => "storage.busy",
            StorageErrorKind::Closed => "storage.closed",
            StorageErrorKind::NotFound => "storage.not_found",
            StorageErrorKind::Unavailable => "storage.unavailable",
            StorageErrorKind::UnsupportedVersion => "storage.unsupported_version",
            StorageErrorKind::Integrity => "storage.integrity",
            StorageErrorKind::CommandConflict => "storage.command_conflict",
            StorageErrorKind::InvalidTransition => "storage.invalid_transition",
            StorageErrorKind::ActiveRunExists => "storage.active_run_exists",
            StorageErrorKind::StaleHistory => "storage.stale_history",
            StorageErrorKind::CatalogRepairRequired => "storage.catalog_repair_required",
            StorageErrorKind::CreationIncomplete => "storage.creation_incomplete",
            StorageErrorKind::Io => "storage.io",
            StorageErrorKind::CommitUnknown => "storage.commit_unknown",
        }
    }
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl fmt::Debug for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StorageError")
            .field("code", &self.code())
            .field("certainty", &self.certainty)
            .finish()
    }
}

impl std::error::Error for StorageError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_error_namespace_and_certainty_are_static() {
        use StorageErrorKind::*;
        let kinds = [
            InvalidInput,
            Busy,
            Closed,
            NotFound,
            Unavailable,
            UnsupportedVersion,
            Integrity,
            CommandConflict,
            InvalidTransition,
            ActiveRunExists,
            CatalogRepairRequired,
            CreationIncomplete,
            Io,
            CommitUnknown,
            StaleHistory,
        ];
        let codes = [
            "invalid_input",
            "busy",
            "closed",
            "not_found",
            "unavailable",
            "unsupported_version",
            "integrity",
            "command_conflict",
            "invalid_transition",
            "active_run_exists",
            "catalog_repair_required",
            "creation_incomplete",
            "io",
            "commit_unknown",
            "stale_history",
        ];
        for (kind, code) in kinds.into_iter().zip(codes) {
            let error = StorageError::new(kind);
            assert_eq!(error.kind(), kind);
            assert_eq!(error.to_string(), format!("storage.{code}"));
            assert_eq!(
                format!("{error:?}"),
                format!(
                    "StorageError {{ code: \"storage.{code}\", certainty: {:?} }}",
                    error.certainty()
                )
            );
            assert!(std::error::Error::source(&error).is_none());
        }
        assert_eq!(
            StorageError::new(Io).certainty(),
            CommitCertainty::NotApplicable
        );
        assert_eq!(
            StorageError::new(Io).not_committed().certainty(),
            CommitCertainty::NotCommitted
        );
        assert_eq!(
            StorageError::new(CommitUnknown).certainty(),
            CommitCertainty::Unknown
        );
    }
}
