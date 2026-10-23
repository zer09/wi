use std::fmt;

use crate::storage::StorageError;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ConversationError {
    Storage(StorageError),
    CursorInvalid,
    CursorStale,
    DisplayUnavailable,
}

impl From<StorageError> for ConversationError {
    fn from(error: StorageError) -> Self {
        Self::Storage(error)
    }
}

impl fmt::Display for ConversationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage(error) => error.fmt(f),
            Self::CursorInvalid => f.write_str("conversation.cursor_invalid"),
            Self::CursorStale => f.write_str("conversation.cursor_stale"),
            Self::DisplayUnavailable => f.write_str("conversation.display_unavailable"),
        }
    }
}

impl fmt::Debug for ConversationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage(error) => f.debug_tuple("Storage").field(error).finish(),
            _ => fmt::Display::fmt(self, f),
        }
    }
}

impl std::error::Error for ConversationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Storage(error) => Some(error),
            _ => None,
        }
    }
}
