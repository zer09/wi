use super::*;
mod atomicity;
mod boundaries;
mod content;
mod cursors;
pub(super) mod fixture;
mod integrity_tests;
mod legacy;
mod lifecycle_tests;
mod remediation;
use crate::{
    conversation::EntryKind,
    run::RunEvent,
    storage::{AppendRunRecord, OperationId},
    tools::ToolExecutionEvent,
};
use fixture::*;

#[test]
fn a5b1_static_errors() {
    for error in [
        ConversationError::CursorInvalid,
        ConversationError::CursorStale,
        ConversationError::DisplayUnavailable,
    ] {
        assert_eq!(error.to_string(), format!("{error:?}"));
        assert!(std::error::Error::source(&error).is_none());
    }
}
