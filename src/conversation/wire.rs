//! Closed display JSON shared by storage sizing and HTTP output.
// Indexed storage reads and the HTTP conversation adapter use these encoders.
#![cfg_attr(not(test), allow(dead_code))]

use std::io::{self, Write};

use serde::{Serialize, Serializer, ser::SerializeStruct};

use super::*;
use crate::{
    UpstreamOutcome,
    run::RunSinkError,
    storage::{RecordedRunState, SessionManifest},
};

pub(crate) const ENTRY_BYTES: usize = 32_768;
pub(crate) const PAGE_BYTES: usize = 524_288;
pub(crate) const ACTIVITY_LIMIT: usize = 64;
pub(crate) const FIELD_LIMIT: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("conversation.encoding_invalid")]
pub(crate) struct EncodingError;

/// Each variant selects a closed adapter and its transfer bounds.
pub(crate) enum DisplayJson<'a> {
    Entry(&'a EntryView),
    Block(&'a BlockView),
    Page(&'a ConversationPage),
    EntryPage(&'a EntryPage),
    Changes(&'a ConversationChanges),
}
impl DisplayJson<'_> {
    pub(crate) fn json_size(&self) -> Result<usize, EncodingError> {
        match self {
            Self::Entry(entry) => entry_size(entry),
            Self::Block(block) => {
                entry_size(block.human())?;
                count(&Block(block), PAGE_BYTES)
            }
            Self::Page(page) => {
                if page.entries().len() > ACTIVITY_LIMIT {
                    return Err(EncodingError);
                }
                if let Some(block) = page.block() {
                    entry_size(block.human())?;
                }
                for entry in page.entries() {
                    entry_size(entry)?;
                }
                count(&Page(page), PAGE_BYTES)
            }
            Self::EntryPage(page) => {
                entry_size(page.block().human())?;
                entry_size(page.entry())?;
                count(&Addressed(page), PAGE_BYTES)
            }
            Self::Changes(batch) => {
                if batch.changes().len() > ACTIVITY_LIMIT {
                    return Err(EncodingError);
                }
                for change in batch.changes() {
                    match change {
                        DisplayChange::SessionUpsert(_) => {}
                        DisplayChange::BlockUpsert(block) => {
                            entry_size(block.human())?;
                        }
                        DisplayChange::EntryUpsert(change) => {
                            entry_size(change.block().human())?;
                            entry_size(change.entry())?;
                        }
                    }
                }
                count(&Changes(batch), PAGE_BYTES)
            }
        }
    }

    pub(crate) fn encode(&self) -> Result<Vec<u8>, EncodingError> {
        // Count first: an oversized borrowed value never allocates an output buffer.
        let size = self.json_size()?;
        let mut writer = CappedWriter {
            count: 0,
            limit: size,
            output: Some(Vec::with_capacity(size)),
        };
        let result = match self {
            Self::Entry(value) => serde_json::to_writer(&mut writer, &Entry(value)),
            Self::Block(value) => serde_json::to_writer(&mut writer, &Block(value)),
            Self::Page(value) => serde_json::to_writer(&mut writer, &Page(value)),
            Self::EntryPage(value) => serde_json::to_writer(&mut writer, &Addressed(value)),
            Self::Changes(value) => serde_json::to_writer(&mut writer, &Changes(value)),
        };
        result.map_err(|_| EncodingError)?;
        if writer.count != size {
            return Err(EncodingError);
        }
        writer.output.ok_or(EncodingError)
    }
}

fn entry_size(entry: &EntryView) -> Result<usize, EncodingError> {
    if entry.fields().len() > FIELD_LIMIT {
        return Err(EncodingError);
    }
    count(&Entry(entry), ENTRY_BYTES)
}

fn count(value: &impl Serialize, limit: usize) -> Result<usize, EncodingError> {
    let mut writer = CappedWriter {
        count: 0,
        limit,
        output: None,
    };
    serde_json::to_writer(&mut writer, value).map_err(|_| EncodingError)?;
    Ok(writer.count)
}

struct CappedWriter {
    count: usize,
    limit: usize,
    output: Option<Vec<u8>>,
}
impl Write for CappedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let next = self
            .count
            .checked_add(bytes.len())
            .filter(|next| *next <= self.limit)
            .ok_or_else(|| io::Error::other("conversation.encoding_invalid"))?;
        if let Some(output) = &mut self.output {
            output.extend_from_slice(bytes);
        }
        self.count = next;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct Decimal<T>(T);
impl<T: std::fmt::Display> Serialize for Decimal<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0)
    }
}
struct Spelling<'a, T>(&'a T);
impl<T: std::fmt::Display> Serialize for Spelling<'_, T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self.0)
    }
}

// Only literal keys and explicitly selected scalars can cross this boundary.
macro_rules! object {
    ($serializer:expr, $name:literal, { $($key:literal : $value:expr),* $(,)? }) => {{
        let mut state = $serializer.serialize_struct($name, [$(stringify!($key)),*].len())?;
        $(state.serialize_field($key, &$value)?;)*
        state.end()
    }};
}

struct Field<'a>(&'a FieldFragment);
impl Serialize for Field<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let f = self.0;
        object!(s, "FieldFragment", {
            "field_id": f.field_id(), "order_key": f.order_key(), "kind": field_kind(f.kind()),
            "generation": Decimal(f.generation()), "total_bytes": Decimal(f.total_bytes()),
            "from_byte": Decimal(f.from_byte()), "to_byte": Decimal(f.to_byte()),
            "text": f.text(), "has_earlier": f.has_earlier(), "has_later": f.has_later(),
        })
    }
}
struct Position<'a>(&'a EntryPosition);
impl Serialize for Position<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        object!(s, "Position", { "sequence": Decimal(self.0.sequence()), "slot": Decimal(self.0.slot()) })
    }
}
struct Reference<'a>(&'a EntryReference);
impl Serialize for Reference<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        object!(s, "Reference", { "run_id": self.0.run_id(), "entry_id": Spelling(self.0.entry_id()) })
    }
}
struct Fields<'a>(&'a [FieldFragment]);
impl Serialize for Fields<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(self.0.iter().map(Field))
    }
}
struct Entry<'a>(&'a EntryView);
impl Serialize for Entry<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let e = self.0;
        object!(s, "EntryView", {
            "run_id": e.run_id(), "entry_id": Spelling(e.entry_id()), "position": Position(e.position()),
            "revision": Decimal(e.revision()), "content_epoch": Decimal(e.content_epoch()),
            "kind": entry_kind(e.kind()), "recorded_state": recorded_state(e.recorded_state()),
            "provisional": e.provisional(), "reference": e.reference().map(Reference),
            "result_recorded": e.result_recorded(), "finish_recorded": e.finish_recorded(), "is_error": e.is_error(),
            "fields": Fields(e.fields()), "earlier_content": e.earlier_content().map(Spelling),
            "content_complete": e.content_complete(),
        })
    }
}
struct Outcome(OutcomeView);
impl Serialize for Outcome {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            OutcomeView::Completed => object!(s, "Outcome", { "type": "completed" }),
            OutcomeView::CancelledLocally => object!(s, "Outcome", { "type": "cancelled_locally" }),
            OutcomeView::Failed { code } => {
                object!(s, "Outcome", { "type": "failed", "code": code.as_str() })
            }
        }
    }
}
struct Summary<'a>(&'a SummaryView);
impl Serialize for Summary<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let v = self.0;
        object!(s, "Summary", {
            "turns_started": Decimal(v.turns_started()), "turns_finished": Decimal(v.turns_finished()),
            "model_requests_attempted": Decimal(v.model_requests_attempted()), "model_requests_admitted": Decimal(v.model_requests_admitted()),
            "new_tool_dispatches": Decimal(v.new_tool_dispatches()), "tool_results_prepared": Decimal(v.tool_results_prepared()),
            "reused_results": Decimal(v.reused_results()), "last_request_id": v.last_request_id(),
            "last_upstream_outcome": v.last_upstream_outcome().map(upstream),
        })
    }
}
struct Session<'a>(&'a SessionManifest);
impl Serialize for Session<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let v = self.0;
        object!(s, "SessionView", {
            "api_version": 1_u32, "session_id": v.session_id(), "title": v.title(), "workspace": v.workspace(),
            "created_at_ms": Decimal(v.created_at_ms()), "updated_at_ms": Decimal(v.updated_at_ms()),
            "head_sequence": Decimal(v.head_sequence()), "view": "canonical",
        })
    }
}
struct Block<'a>(&'a BlockView);
impl Serialize for Block<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let v = self.0;
        object!(s, "BlockView", {
            "run_id": v.run_id(), "accepted_sequence": Decimal(v.accepted_sequence()), "revision": Decimal(v.revision()),
            "state": run_state(v.state()), "result_recorded": v.result_recorded(), "outcome": v.outcome().map(Outcome),
            "summary": v.summary().map(Summary), "events_complete": v.events_complete(), "sink_error": v.sink_error().map(sink),
            "human": Entry(v.human()),
        })
    }
}
struct Entries<'a>(&'a [EntryView]);
impl Serialize for Entries<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(self.0.iter().map(Entry))
    }
}
struct Page<'a>(&'a ConversationPage);
impl Serialize for Page<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let p = self.0;
        object!(s, "ConversationPage", {
            "api_version": 1_u32, "conversation_version": 1_u32, "session_id": p.session_id(),
            "snapshot_head": Decimal(p.snapshot_head()), "session": Session(p.session()), "block": p.block().map(Block),
            "entries": Entries(p.entries()), "earlier_activity": p.earlier_activity().map(Spelling),
            "previous_block": p.previous_block().map(Spelling), "live_after": p.live_after().map(Spelling),
        })
    }
}
struct Addressed<'a>(&'a EntryPage);
impl Serialize for Addressed<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let p = self.0;
        object!(s, "EntryPage", {
            "api_version": 1_u32, "conversation_version": 1_u32, "session_id": p.session_id(),
            "snapshot_head": Decimal(p.snapshot_head()), "block": Block(p.block()), "entry": Entry(p.entry()),
        })
    }
}
struct Change<'a>(&'a DisplayChange);
impl Serialize for Change<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            DisplayChange::SessionUpsert(v) => {
                object!(s, "Change", { "kind": "session.upsert", "session": Session(v) })
            }
            DisplayChange::BlockUpsert(v) => {
                object!(s, "Change", { "kind": "block.upsert", "block": Block(v) })
            }
            DisplayChange::EntryUpsert(v) => {
                object!(s, "Change", { "kind": "entry.upsert", "block": Block(v.block()), "entry": Entry(v.entry()) })
            }
        }
    }
}
struct ChangeList<'a>(&'a [DisplayChange]);
impl Serialize for ChangeList<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(self.0.iter().map(Change))
    }
}
struct Changes<'a>(&'a ConversationChanges);
impl Serialize for Changes<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let p = self.0;
        object!(s, "ConversationChanges", {
            "api_version": 1_u32, "conversation_version": 1_u32, "session_id": p.session_id(),
            "observed_head": Decimal(p.observed_head()), "changes": ChangeList(p.changes()), "next_after": Spelling(p.next_after()),
        })
    }
}

fn entry_kind(v: EntryKind) -> &'static str {
    match v {
        EntryKind::Human => "human",
        EntryKind::Assistant => "assistant",
        EntryKind::Tool => "tool",
        EntryKind::Reuse => "reuse",
        EntryKind::Notice => "notice",
    }
}
fn recorded_state(v: RecordedState) -> &'static str {
    match v {
        RecordedState::Accepted => "accepted",
        RecordedState::InProgress => "in_progress",
        RecordedState::Completed => "completed",
        RecordedState::Incomplete => "incomplete",
        RecordedState::Failed => "failed",
        RecordedState::Cancelled => "cancelled",
        RecordedState::Interrupted => "interrupted",
        RecordedState::Unknown => "unknown",
    }
}
fn field_kind(v: FieldKind) -> &'static str {
    match v {
        FieldKind::Text => "text",
        FieldKind::Refusal => "refusal",
        FieldKind::ReasoningSummary => "reasoning_summary",
        FieldKind::ReasoningText => "reasoning_text",
        FieldKind::FunctionName => "function_name",
        FieldKind::FunctionArguments => "function_arguments",
        FieldKind::ToolName => "tool_name",
        FieldKind::ToolResult => "tool_result",
        FieldKind::AuthoritativeText => "authoritative_text",
        FieldKind::Unsupported => "unsupported",
        FieldKind::Notice => "notice",
    }
}
fn run_state(v: RecordedRunState) -> &'static str {
    match v {
        RecordedRunState::Accepted => "accepted",
        RecordedRunState::Running => "running",
        RecordedRunState::Completed => "completed",
        RecordedRunState::Failed => "failed",
        RecordedRunState::CancelledLocally => "cancelled_locally",
        RecordedRunState::Interrupted => "interrupted",
    }
}
fn upstream(v: UpstreamOutcome) -> &'static str {
    match v {
        UpstreamOutcome::NotSubmitted => "not_submitted",
        UpstreamOutcome::Unknown => "unknown",
        UpstreamOutcome::TerminalReceived => "terminal_received",
    }
}
fn sink(v: RunSinkError) -> &'static str {
    match v {
        RunSinkError::Full => "full",
        RunSinkError::Closed => "closed",
        RunSinkError::Failed => "failed",
    }
}

#[cfg(test)]
mod tests;
