//! Read-only conversation values and the shared, private display interpretation.
//! Storage owns persistence; these types do not execute or replay provider work.
mod cursors;
mod ids;
pub(crate) mod interpretation;
pub(crate) mod primitives;
pub(crate) mod projection;
mod safe_code;
mod values;
pub(crate) mod wire;

pub use cursors::{ActivityCursor, BlockCursor, ContentCursor, CursorError, LiveCursor};
pub use ids::{EntryId, EntryIdError, EntryPosition};
pub use safe_code::{SafeCode, safe_code};
pub use values::{
    BlockView, ConversationChanges, ConversationPage, DisplayChange, EntryChange, EntryKind,
    EntryPage, EntryReference, EntryView, FieldFragment, FieldKind, OutcomeView, RecordedState,
    SummaryView,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("conversation.construction_invalid")]
pub(crate) struct ConstructionError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConversationQuery {
    Latest,
    Before(BlockCursor),
    Within(ActivityCursor),
}

fn valid_field_id(value: &str) -> bool {
    // This checks spelling only. Storage still checks that the field belongs to the entry.
    value == "text"
        || (value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

fn decimal(value: &str) -> Option<u64> {
    if value.is_empty()
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return None;
    }
    value.parse().ok()
}
