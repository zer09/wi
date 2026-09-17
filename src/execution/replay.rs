//! Storage-only preparation. No provider, tool registry or context source is consulted.
mod reconstruct;
#[cfg(test)]
mod tests;

use std::{collections::HashMap, fmt};

use super::{PersistentRunCause, PersistentRunFailure};
use crate::{
    ConversationReplay, GatewayError, ReplayIdentity, ReplayRun,
    run::{RunEvent, RunResult},
    storage::{
        InterruptionReason, RunId, SessionHandle, StoredEvent, StoredEventPayload,
        StoredHistorySelection,
    },
};
use reconstruct::{ActiveRun, ClosedRun};

type Result<T> = std::result::Result<T, PersistentRunFailure>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplayExclusionDisposition {
    DefinitelyUnsubmitted,
}

#[derive(Clone)]
pub struct ExcludedReplayRun {
    run_id: RunId,
    disposition: ReplayExclusionDisposition,
}
impl ExcludedReplayRun {
    pub fn run_id(&self) -> RunId {
        self.run_id.clone()
    }
    pub fn disposition(&self) -> ReplayExclusionDisposition {
        self.disposition
    }
}
impl fmt::Debug for ExcludedReplayRun {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ExcludedReplayRun([redacted])")
    }
}

#[derive(Clone)]
pub struct PreparedSessionReplay {
    selection: StoredHistorySelection,
    replay: ConversationReplay,
    included_exchange_count: usize,
    excluded_runs: Vec<ExcludedReplayRun>,
}
impl PreparedSessionReplay {
    pub fn selection(&self) -> StoredHistorySelection {
        self.selection.clone()
    }
    pub fn replay(&self) -> ConversationReplay {
        self.replay.clone()
    }
    pub fn included_run_count(&self) -> usize {
        self.replay.runs().len()
    }
    pub fn included_exchange_count(&self) -> usize {
        self.included_exchange_count
    }
    pub fn excluded_runs(&self) -> Vec<ExcludedReplayRun> {
        self.excluded_runs.clone()
    }
}
impl fmt::Debug for PreparedSessionReplay {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PreparedSessionReplay([redacted])")
    }
}

/// Compile closed exchanges at one captured head. Later appends cannot complete this prefix.
pub async fn prepare_session_replay(
    session: &SessionHandle,
    provider_id: &str,
    requested_model: &str,
) -> Result<PreparedSessionReplay> {
    ConversationReplay::new(provider_id.into(), requested_model.into(), None, vec![])
        .map_err(|_| incompatible())?;
    let mut page = session.history_page(0, None, 128).await.map_err(storage)?;
    let through = page.through_sequence();
    #[cfg(test)]
    crate::storage::test_hooks::hit(crate::storage::test_hooks::Point::ReplayHeadCaptured)
        .await
        .map_err(storage)?;
    let mut builder = Builder::default();
    let mut sequence = 0;
    loop {
        for event in page.records() {
            if event.sequence() != sequence + 1 || event.sequence() > through {
                return Err(metadata());
            }
            builder.observe(event)?;
            sequence = event.sequence();
        }
        if !page.has_more() {
            break;
        }
        if page.next_after() != sequence {
            return Err(metadata());
        }
        page = session
            .history_page(sequence, Some(through), 128)
            .await
            .map_err(storage)?;
    }
    if sequence != through {
        return Err(metadata());
    }
    if let Some(active) = &builder.active {
        active.require_selection()?;
        return Err(incomplete());
    }
    // Hash original raw payloads, including unknown fields discarded by typed reads.
    // All historical selections are checked together in this one streaming pass.
    let digest = session
        .history_prefix_digest(through, builder.checkpoints)
        .await
        .map_err(storage)?;
    let mut identity: Option<ReplayIdentity> = None;
    let mut runs = Vec::new();
    let mut excluded_runs = Vec::new();
    let mut exchanges = 0;
    for closed in builder.closed {
        let selected = &closed.selection;
        if selected.expected_identity() != identity.as_ref() {
            return Err(metadata());
        }
        closed.require_result()?;
        if closed.exchanges.is_empty() {
            excluded_runs.push(ExcludedReplayRun {
                run_id: closed.run_id,
                disposition: ReplayExclusionDisposition::DefinitelyUnsubmitted,
            });
            continue;
        }
        let binding = closed.binding.as_ref().ok_or_else(provenance)?;
        if selected.provider_id() != provider_id
            || selected.requested_model() != requested_model
            || binding.identity().provider_id() != provider_id
            || binding.requested_model() != requested_model
            || identity
                .as_ref()
                .is_some_and(|old| old.format() != binding.identity().format())
        {
            return Err(incompatible());
        }
        if identity
            .as_ref()
            .is_some_and(|old| old != binding.identity())
        {
            return Err(metadata());
        }
        identity = Some(binding.identity().clone());
        exchanges += closed.exchanges.len();
        runs.push(
            ReplayRun::new(closed.run_id.to_string(), closed.prompt, closed.exchanges)
                .map_err(|_| incomplete())?,
        );
    }
    let selection = StoredHistorySelection::new(
        through,
        digest,
        provider_id.into(),
        requested_model.into(),
        identity.clone(),
    )
    .map_err(storage)?;
    let replay =
        ConversationReplay::new(provider_id.into(), requested_model.into(), identity, runs)
            .map_err(|_| metadata())?;
    Ok(PreparedSessionReplay {
        selection,
        replay,
        included_exchange_count: exchanges,
        excluded_runs,
    })
}

#[derive(Default)]
struct Builder {
    active: Option<ActiveRun>,
    closed: Vec<ClosedRun>,
    // A RunFinished can precede a later acceptance and its own final result append.
    // Retain only compact terminal evidence and compiled replay for those runs.
    closed_ids: HashMap<String, usize>,
    checkpoints: Vec<(u64, String)>,
}
impl Builder {
    fn observe(&mut self, event: &StoredEvent) -> Result<()> {
        if let Some(active) = &self.active
            && event.sequence() != active.accepted_sequence + 1
        {
            active.require_selection()?;
        }
        match event.payload() {
            StoredEventPayload::SessionCreated(_) | StoredEventPayload::SessionRenamed { .. } => {
                Ok(())
            }
            StoredEventPayload::RunAccepted(accepted) => {
                if self.active.is_some() || self.closed_ids.contains_key(accepted.run_id().as_str())
                {
                    return Err(incomplete());
                }
                self.active = Some(ActiveRun::new(event.sequence(), accepted));
                Ok(())
            }
            StoredEventPayload::RunResultRecorded(result) => self.result(result),
            _ => {
                let active = self.active.as_mut().ok_or_else(metadata)?;
                if event.run_id() != Some(&active.run_id) {
                    return Err(metadata());
                }
                match event.payload() {
                    StoredEventPayload::RunHistorySelected(payload) => {
                        active.select(event.sequence(), payload.selection())?;
                        self.checkpoints.push((
                            payload.selection().through_sequence(),
                            payload.selection().history_digest().into(),
                        ));
                    }
                    StoredEventPayload::RunProviderBound(binding) => active.bind(binding)?,
                    StoredEventPayload::RuntimeObserved(runtime) => {
                        active.runtime(runtime)?;
                        if matches!(runtime.event, RunEvent::RunFinished { .. }) {
                            self.close_active(false)?;
                        }
                    }
                    StoredEventPayload::ToolResultRecorded(result) => active.tool_result(result)?,
                    StoredEventPayload::RunInterrupted(interruption) => match interruption.reason()
                    {
                        InterruptionReason::ProcessRestart => self.close_active(true)?,
                    },
                    _ => return Err(metadata()),
                }
                Ok(())
            }
        }
    }

    fn close_active(&mut self, interrupted: bool) -> Result<()> {
        let closed = self
            .active
            .take()
            .ok_or_else(metadata)?
            .close(interrupted)?;
        self.closed_ids
            .insert(closed.run_id.to_string(), self.closed.len());
        self.closed.push(closed);
        Ok(())
    }

    fn result(&mut self, result: &RunResult) -> Result<()> {
        if self
            .active
            .as_ref()
            .is_some_and(|run| run.run_id.as_str() == result.run_id)
        {
            if result.events_complete {
                return Err(incomplete());
            }
            self.close_active(false)?;
        }
        let index = self.closed_ids.get(&result.run_id).ok_or_else(metadata)?;
        self.closed[*index].result(result)
    }
}

fn storage(error: crate::storage::StorageError) -> PersistentRunFailure {
    PersistentRunFailure::history(PersistentRunCause::Storage(error))
}
fn history(message: &'static str) -> PersistentRunFailure {
    PersistentRunFailure::history(PersistentRunCause::Gateway(GatewayError::InvalidRequest(
        message,
    )))
}
fn incomplete() -> PersistentRunFailure {
    history("stored history is incomplete for native replay")
}
fn provenance() -> PersistentRunFailure {
    history("stored history has no replay provenance")
}
fn metadata() -> PersistentRunFailure {
    history("stored history replay metadata is inconsistent")
}
fn incompatible() -> PersistentRunFailure {
    history("stored history provider or model is incompatible")
}
