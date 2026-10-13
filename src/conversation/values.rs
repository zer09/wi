// Storage will consume these construction seams in the next increment.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::BTreeSet;

use super::{
    ActivityCursor, BlockCursor, ConstructionError, ContentCursor, ConversationQuery, EntryId,
    EntryPosition, LiveCursor, SafeCode, primitives::OrderKey, safe_code,
};
use crate::{
    UpstreamOutcome,
    run::{RunOutcome, RunSinkError, RunSummary},
    storage::{ApplicationSessionId, RecordedRunState, RunId, SessionManifest},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Human,
    Assistant,
    Tool,
    Reuse,
    Notice,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordedState {
    Accepted,
    InProgress,
    Completed,
    Incomplete,
    Failed,
    Cancelled,
    Interrupted,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldKind {
    Text,
    Refusal,
    ReasoningSummary,
    ReasoningText,
    FunctionName,
    FunctionArguments,
    ToolName,
    ToolResult,
    AuthoritativeText,
    Unsupported,
    Notice,
}

#[derive(Clone)]
pub struct FieldFragment {
    field_id: String,
    order_key: String,
    kind: FieldKind,
    generation: u64,
    total_bytes: u64,
    from_byte: u64,
    to_byte: u64,
    text: String,
}
impl FieldFragment {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        field_id: String,
        order_key: String,
        kind: FieldKind,
        generation: u64,
        total_bytes: u64,
        from_byte: u64,
        to_byte: u64,
        text: String,
    ) -> Result<Self, ConstructionError> {
        if !super::valid_field_id(&field_id)
            || (order_key != "0" && order_key.parse::<OrderKey>().is_err())
            || generation == 0
            || from_byte > to_byte
            || to_byte > total_bytes
            || u64::try_from(text.len()).ok() != Some(to_byte - from_byte)
        {
            return Err(ConstructionError);
        }
        Ok(Self {
            field_id,
            order_key,
            kind,
            generation,
            total_bytes,
            from_byte,
            to_byte,
            text,
        })
    }

    pub fn field_id(&self) -> &str {
        &self.field_id
    }
    pub fn order_key(&self) -> &str {
        &self.order_key
    }
    pub fn kind(&self) -> FieldKind {
        self.kind
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn total_bytes(&self) -> u64 {
        self.total_bytes
    }
    pub fn from_byte(&self) -> u64 {
        self.from_byte
    }
    pub fn to_byte(&self) -> u64 {
        self.to_byte
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn has_earlier(&self) -> bool {
        self.from_byte > 0
    }
    pub fn has_later(&self) -> bool {
        self.to_byte < self.total_bytes
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryReference {
    run_id: RunId,
    entry_id: EntryId,
}
impl EntryReference {
    pub(crate) fn new(run_id: RunId, entry_id: EntryId) -> Self {
        Self { run_id, entry_id }
    }

    pub fn run_id(&self) -> &RunId {
        &self.run_id
    }
    pub fn entry_id(&self) -> &EntryId {
        &self.entry_id
    }
}

#[derive(Clone)]
pub struct EntryView {
    run_id: RunId,
    entry_id: EntryId,
    revision: u64,
    content_epoch: u64,
    kind: EntryKind,
    recorded_state: RecordedState,
    provisional: bool,
    reference: Option<EntryReference>,
    result_recorded: Option<bool>,
    finish_recorded: Option<bool>,
    is_error: Option<bool>,
    fields: Vec<FieldFragment>,
    earlier_content: Option<ContentCursor>,
    content_complete: bool,
}
impl EntryView {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        run_id: RunId,
        entry_id: EntryId,
        revision: u64,
        content_epoch: u64,
        kind: EntryKind,
        recorded_state: RecordedState,
        provisional: bool,
        reference: Option<EntryReference>,
        result_recorded: Option<bool>,
        finish_recorded: Option<bool>,
        is_error: Option<bool>,
        fields: Vec<FieldFragment>,
        earlier_content: Option<ContentCursor>,
        content_complete: bool,
    ) -> Result<Self, ConstructionError> {
        if kind == EntryKind::Human
            && !matches!(fields.as_slice(), [field]
                if field.field_id == "text"
                    && field.order_key == "0"
                    && field.kind == FieldKind::Text)
        {
            return Err(ConstructionError);
        }
        let mut field_ids = BTreeSet::new();
        if content_epoch < entry_id.first_sequence()
            || revision < content_epoch
            || (kind == EntryKind::Reuse) != reference.is_some()
            || reference.as_ref().is_some_and(|reference| {
                reference.run_id != run_id || reference.entry_id >= entry_id
            })
            || (!matches!(kind, EntryKind::Tool | EntryKind::Reuse)
                && (result_recorded.is_some() || finish_recorded.is_some() || is_error.is_some()))
            || fields.iter().any(|field| {
                field.generation < entry_id.first_sequence()
                    || field.generation > revision
                    || (kind != EntryKind::Human && field.order_key == "0")
                    || !field_ids.insert(field.field_id.as_str())
                    || (content_complete && (field.has_earlier() || field.has_later()))
            })
            || fields
                .windows(2)
                .any(|pair| pair[0].order_key >= pair[1].order_key)
            || (content_complete && earlier_content.is_some())
            || earlier_content.as_ref().is_some_and(|cursor| {
                cursor.run_id() != &run_id
                    || cursor.entry_id() != &entry_id
                    || cursor.content_epoch() != content_epoch
                    || cursor.upper_generation() > revision
                    || fields.iter().any(|field| {
                        field.field_id == cursor.upper_field_id()
                            && (field.generation != cursor.upper_generation()
                                || cursor.exclusive_upper_byte() > field.total_bytes)
                    })
            })
        {
            return Err(ConstructionError);
        }
        Ok(Self {
            run_id,
            entry_id,
            revision,
            content_epoch,
            kind,
            recorded_state,
            provisional,
            reference,
            result_recorded,
            finish_recorded,
            is_error,
            fields,
            earlier_content,
            content_complete,
        })
    }

    fn matches_block(&self, block: &BlockView) -> bool {
        self.run_id == block.run_id
            && if self.kind == EntryKind::Human {
                self.entry_id == block.human.entry_id
                    && self.revision == block.human.revision
                    && self.content_epoch == block.human.content_epoch
            } else {
                self.position() > block.human.position()
            }
    }

    fn matches_snapshot(&self, session_id: &ApplicationSessionId, head: u64) -> bool {
        self.revision <= head
            && self
                .earlier_content
                .as_ref()
                .is_none_or(|cursor| cursor.session_id() == session_id)
    }

    pub fn run_id(&self) -> &RunId {
        &self.run_id
    }
    pub fn entry_id(&self) -> &EntryId {
        &self.entry_id
    }
    pub fn position(&self) -> &EntryPosition {
        self.entry_id.position()
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn content_epoch(&self) -> u64 {
        self.content_epoch
    }
    pub fn kind(&self) -> EntryKind {
        self.kind
    }
    pub fn recorded_state(&self) -> RecordedState {
        self.recorded_state
    }
    pub fn provisional(&self) -> bool {
        self.provisional
    }
    pub fn reference(&self) -> Option<&EntryReference> {
        self.reference.as_ref()
    }
    pub fn result_recorded(&self) -> Option<bool> {
        self.result_recorded
    }
    pub fn finish_recorded(&self) -> Option<bool> {
        self.finish_recorded
    }
    pub fn is_error(&self) -> Option<bool> {
        self.is_error
    }
    pub fn fields(&self) -> &[FieldFragment] {
        &self.fields
    }
    pub fn earlier_content(&self) -> Option<&ContentCursor> {
        self.earlier_content.as_ref()
    }
    pub fn content_complete(&self) -> bool {
        self.content_complete
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

#[derive(Clone)]
pub struct SummaryView {
    turns_started: u64,
    turns_finished: u64,
    model_requests_attempted: u64,
    model_requests_admitted: u64,
    new_tool_dispatches: u64,
    tool_results_prepared: u64,
    reused_results: u64,
    last_request_id: Option<String>,
    last_upstream_outcome: Option<UpstreamOutcome>,
}
impl From<&RunSummary> for SummaryView {
    fn from(value: &RunSummary) -> Self {
        Self {
            turns_started: value.turns_started,
            turns_finished: value.turns_finished,
            model_requests_attempted: value.model_requests_attempted,
            model_requests_admitted: value.model_requests_admitted,
            new_tool_dispatches: value.new_tool_dispatches,
            tool_results_prepared: value.tool_results_prepared,
            reused_results: value.reused_results,
            last_request_id: value.last_request_id.clone(),
            last_upstream_outcome: value.last_upstream_outcome,
        }
    }
}
impl SummaryView {
    pub fn turns_started(&self) -> u64 {
        self.turns_started
    }
    pub fn turns_finished(&self) -> u64 {
        self.turns_finished
    }
    pub fn model_requests_attempted(&self) -> u64 {
        self.model_requests_attempted
    }
    pub fn model_requests_admitted(&self) -> u64 {
        self.model_requests_admitted
    }
    pub fn new_tool_dispatches(&self) -> u64 {
        self.new_tool_dispatches
    }
    pub fn tool_results_prepared(&self) -> u64 {
        self.tool_results_prepared
    }
    pub fn reused_results(&self) -> u64 {
        self.reused_results
    }
    pub fn last_request_id(&self) -> Option<&str> {
        self.last_request_id.as_deref()
    }
    pub fn last_upstream_outcome(&self) -> Option<UpstreamOutcome> {
        self.last_upstream_outcome
    }
}

#[derive(Clone)]
pub struct BlockView {
    run_id: RunId,
    accepted_sequence: u64,
    revision: u64,
    state: RecordedRunState,
    result_recorded: bool,
    outcome: Option<OutcomeView>,
    summary: Option<SummaryView>,
    events_complete: Option<bool>,
    sink_error: Option<RunSinkError>,
    human: EntryView,
}
impl BlockView {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        run_id: RunId,
        accepted_sequence: u64,
        revision: u64,
        state: RecordedRunState,
        result_recorded: bool,
        outcome: Option<OutcomeView>,
        summary: Option<SummaryView>,
        events_complete: Option<bool>,
        sink_error: Option<RunSinkError>,
        human: EntryView,
    ) -> Result<Self, ConstructionError> {
        if accepted_sequence == 0
            || revision < accepted_sequence
            || human.kind != EntryKind::Human
            || human.run_id != run_id
            || human.entry_id.first_sequence() != accepted_sequence
            || human.entry_id.position_slot() != 0
            || human.revision > revision
        {
            return Err(ConstructionError);
        }
        Ok(Self {
            run_id,
            accepted_sequence,
            revision,
            state,
            result_recorded,
            outcome,
            summary,
            events_complete,
            sink_error,
            human,
        })
    }

    fn matches_snapshot(&self, session_id: &ApplicationSessionId, head: u64) -> bool {
        self.revision <= head && self.human.matches_snapshot(session_id, head)
    }

    pub fn run_id(&self) -> &RunId {
        &self.run_id
    }
    pub fn accepted_sequence(&self) -> u64 {
        self.accepted_sequence
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn state(&self) -> RecordedRunState {
        self.state
    }
    pub fn result_recorded(&self) -> bool {
        self.result_recorded
    }
    pub fn outcome(&self) -> Option<OutcomeView> {
        self.outcome
    }
    pub fn summary(&self) -> Option<&SummaryView> {
        self.summary.as_ref()
    }
    pub fn events_complete(&self) -> Option<bool> {
        self.events_complete
    }
    pub fn sink_error(&self) -> Option<RunSinkError> {
        self.sink_error
    }
    pub fn human(&self) -> &EntryView {
        &self.human
    }
}

#[derive(Clone)]
pub struct ConversationPage {
    snapshot_head: u64,
    session: SessionManifest,
    block: Option<BlockView>,
    entries: Vec<EntryView>,
    earlier_activity: Option<ActivityCursor>,
    previous_block: Option<BlockCursor>,
    live_after: Option<LiveCursor>,
}
impl ConversationPage {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        query: &ConversationQuery,
        snapshot_head: u64,
        session: SessionManifest,
        block: Option<BlockView>,
        entries: Vec<EntryView>,
        earlier_activity: Option<ActivityCursor>,
        previous_block: Option<BlockCursor>,
        live_after: Option<LiveCursor>,
    ) -> Result<Self, ConstructionError> {
        let sid = session.session_id();
        if snapshot_head == 0
            || snapshot_head != session.head_sequence()
            || matches!(query, ConversationQuery::Latest) != live_after.is_some()
            || live_after.as_ref().is_some_and(|cursor| {
                cursor.session_id() != sid
                    || cursor.rank() != 3
                    || cursor.sequence() != snapshot_head
            })
        {
            return Err(ConstructionError);
        }
        match query {
            ConversationQuery::Latest => {}
            ConversationQuery::Before(cursor) => {
                if cursor.session_id() != sid
                    || block.as_ref().is_some_and(|block| {
                        block.accepted_sequence >= cursor.before_accepted_sequence()
                    })
                {
                    return Err(ConstructionError);
                }
            }
            ConversationQuery::Within(cursor) => {
                if cursor.session_id() != sid
                    || block
                        .as_ref()
                        .is_none_or(|block| &block.run_id != cursor.run_id())
                    || entries.iter().any(|entry| {
                        (
                            entry.entry_id.first_sequence(),
                            entry.entry_id.position_slot(),
                        ) >= (cursor.before_entry_sequence(), cursor.before_slot())
                    })
                {
                    return Err(ConstructionError);
                }
            }
        }
        if let Some(block) = &block {
            if !block.matches_snapshot(sid, snapshot_head)
                || entries.iter().any(|entry| {
                    entry.kind == EntryKind::Human
                        || !entry.matches_block(block)
                        || !entry.matches_snapshot(sid, snapshot_head)
                })
                || entries
                    .windows(2)
                    .any(|pair| pair[0].position() >= pair[1].position())
                || previous_block.as_ref().is_some_and(|cursor| {
                    cursor.session_id() != sid
                        || cursor.before_accepted_sequence() != block.accepted_sequence
                })
                || earlier_activity.as_ref().is_some_and(|cursor| {
                    cursor.session_id() != sid
                        || cursor.run_id() != &block.run_id
                        || entries.first().is_none_or(|entry| {
                            cursor.before_entry_sequence() != entry.entry_id.first_sequence()
                                || cursor.before_slot() != entry.entry_id.position_slot()
                        })
                })
            {
                return Err(ConstructionError);
            }
        } else if !entries.is_empty() || earlier_activity.is_some() || previous_block.is_some() {
            return Err(ConstructionError);
        }
        Ok(Self {
            snapshot_head,
            session,
            block,
            entries,
            earlier_activity,
            previous_block,
            live_after,
        })
    }

    pub fn session_id(&self) -> &ApplicationSessionId {
        self.session.session_id()
    }
    pub fn snapshot_head(&self) -> u64 {
        self.snapshot_head
    }
    pub fn session(&self) -> &SessionManifest {
        &self.session
    }
    pub fn block(&self) -> Option<&BlockView> {
        self.block.as_ref()
    }
    pub fn entries(&self) -> &[EntryView] {
        &self.entries
    }
    pub fn earlier_activity(&self) -> Option<&ActivityCursor> {
        self.earlier_activity.as_ref()
    }
    pub fn previous_block(&self) -> Option<&BlockCursor> {
        self.previous_block.as_ref()
    }
    pub fn live_after(&self) -> Option<&LiveCursor> {
        self.live_after.as_ref()
    }
}

#[derive(Clone)]
pub struct EntryPage {
    session_id: ApplicationSessionId,
    snapshot_head: u64,
    block: BlockView,
    entry: EntryView,
}
impl EntryPage {
    pub(crate) fn new(
        session_id: ApplicationSessionId,
        snapshot_head: u64,
        block: BlockView,
        entry: EntryView,
    ) -> Result<Self, ConstructionError> {
        if snapshot_head == 0
            || !entry.matches_block(&block)
            || !block.matches_snapshot(&session_id, snapshot_head)
            || !entry.matches_snapshot(&session_id, snapshot_head)
        {
            return Err(ConstructionError);
        }
        Ok(Self {
            session_id,
            snapshot_head,
            block,
            entry,
        })
    }

    pub fn session_id(&self) -> &ApplicationSessionId {
        &self.session_id
    }
    pub fn snapshot_head(&self) -> u64 {
        self.snapshot_head
    }
    pub fn block(&self) -> &BlockView {
        &self.block
    }
    pub fn entry(&self) -> &EntryView {
        &self.entry
    }
}

#[derive(Clone)]
pub struct EntryChange {
    block: BlockView,
    entry: EntryView,
}
impl EntryChange {
    pub(crate) fn new(block: BlockView, entry: EntryView) -> Result<Self, ConstructionError> {
        if !entry.matches_block(&block)
            || block
                .human
                .earlier_content
                .as_ref()
                .zip(entry.earlier_content.as_ref())
                .is_some_and(|(human, entry)| human.session_id() != entry.session_id())
        {
            return Err(ConstructionError);
        }
        Ok(Self { block, entry })
    }

    pub fn block(&self) -> &BlockView {
        &self.block
    }
    pub fn entry(&self) -> &EntryView {
        &self.entry
    }
}
#[derive(Clone)]
pub enum DisplayChange {
    SessionUpsert(SessionManifest),
    BlockUpsert(Box<BlockView>),
    EntryUpsert(Box<EntryChange>),
}
#[derive(Clone)]
pub struct ConversationChanges {
    session_id: ApplicationSessionId,
    observed_head: u64,
    changes: Vec<DisplayChange>,
    next_after: LiveCursor,
    has_more: bool,
}
impl ConversationChanges {
    pub(crate) fn new(
        session_id: ApplicationSessionId,
        observed_head: u64,
        changes: Vec<DisplayChange>,
        next_after: LiveCursor,
        has_more: bool,
    ) -> Result<Self, ConstructionError> {
        if observed_head == 0
            || next_after.session_id() != &session_id
            || next_after.sequence() > observed_head
            || changes.iter().any(|change| match change {
                DisplayChange::SessionUpsert(session) => {
                    session.session_id() != &session_id || session.head_sequence() != observed_head
                }
                DisplayChange::BlockUpsert(block) => {
                    !block.matches_snapshot(&session_id, observed_head)
                }
                DisplayChange::EntryUpsert(change) => {
                    !change.block.matches_snapshot(&session_id, observed_head)
                        || !change.entry.matches_snapshot(&session_id, observed_head)
                }
            })
        {
            return Err(ConstructionError);
        }
        if has_more {
            // A partial batch stops at its last entity, never at a watermark.
            let matches_last = match changes.last() {
                Some(DisplayChange::SessionUpsert(_)) => next_after.rank() == 0,
                Some(DisplayChange::BlockUpsert(block)) => {
                    next_after.rank() == 1
                        && next_after.sequence() == block.revision
                        && next_after.run_id() == Some(&block.run_id)
                }
                Some(DisplayChange::EntryUpsert(change)) => {
                    next_after.rank() == 2
                        && next_after.sequence() == change.entry.revision
                        && next_after.run_id() == Some(&change.entry.run_id)
                        && next_after.entry_id() == Some(&change.entry.entry_id)
                }
                None => false,
            };
            if !matches_last {
                return Err(ConstructionError);
            }
        } else if next_after.rank() != 3 || next_after.sequence() != observed_head {
            return Err(ConstructionError);
        }
        Ok(Self {
            session_id,
            observed_head,
            changes,
            next_after,
            has_more,
        })
    }

    pub fn session_id(&self) -> &ApplicationSessionId {
        &self.session_id
    }
    pub fn observed_head(&self) -> u64 {
        self.observed_head
    }
    pub fn changes(&self) -> &[DisplayChange] {
        &self.changes
    }
    pub fn next_after(&self) -> &LiveCursor {
        &self.next_after
    }
    pub fn has_more(&self) -> bool {
        self.has_more
    }
}

#[cfg(test)]
mod tests;
