use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
};

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::storage::ApplicationSessionId;

mod tests;

// A fixture bound, not a limit on production events or unselected frames.
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FaultMode {
    PrefixThenError,
    WholeThenError,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub session_id: ApplicationSessionId,
    pub subscription: u64,
    pub sequence: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Subscription {
    pub session_id: ApplicationSessionId,
    pub ordinal: u64,
    pub last_sequence: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    Armed,
    Reached,
    Released,
    Completed,
    Aborted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Hit {
    pub target: Target,
    pub mode: FaultMode,
    pub frame_bytes: usize,
    pub yielded_bytes: usize,
}

#[derive(Clone, Debug)]
struct Status {
    phase: Phase,
    hit: Option<Hit>,
}

// Tokens cannot be constructed or reused by callers. Retained tokens contain only safe metadata.
pub(crate) struct FaultPlan {
    generation: u64,
    target: Target,
    mode: FaultMode,
    status: watch::Sender<Status>,
}

impl FaultPlan {
    pub(crate) fn phase(&self) -> Phase {
        self.status.borrow().phase
    }

    pub(crate) async fn reached(&self) -> Option<Hit> {
        let mut status = self.status.subscribe();
        loop {
            let current = status.borrow_and_update().clone();
            if current.hit.is_some() || current.phase == Phase::Aborted {
                return current.hit;
            }
            status
                .changed()
                .await
                .expect("fault status sender retained");
        }
    }

    pub(crate) async fn retired(&self) -> Phase {
        let mut status = self.status.subscribe();
        loop {
            let phase = status.borrow_and_update().phase;
            if matches!(phase, Phase::Completed | Phase::Aborted) {
                return phase;
            }
            status
                .changed()
                .await
                .expect("fault status sender retained");
        }
    }

    async fn released(&self) -> bool {
        let mut status = self.status.subscribe();
        loop {
            match status.borrow_and_update().phase {
                Phase::Released => return true,
                Phase::Aborted | Phase::Completed => return false,
                _ => {}
            }
            status
                .changed()
                .await
                .expect("fault status sender retained");
        }
    }

    fn transition(&self, phase: Phase) {
        self.status.send_modify(|status| status.phase = phase);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ControlError {
    Active,
    InvalidTarget,
    Stale,
    NotReached,
    InvalidFrame,
}

#[derive(Default)]
struct State {
    ordinal: u64,
    generation: u64,
    subscriptions: BTreeMap<u64, Subscription>,
    active: Option<Arc<FaultPlan>>,
}

pub(crate) struct FaultHook {
    state: Mutex<State>,
    changed: watch::Sender<()>,
    closed: CancellationToken,
}

impl Default for FaultHook {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            changed: watch::channel(()).0,
            closed: CancellationToken::new(),
        }
    }
}

impl FaultHook {
    pub(crate) fn subscriptions(&self) -> Vec<Subscription> {
        self.state
            .lock()
            .unwrap()
            .subscriptions
            .values()
            .cloned()
            .collect()
    }

    pub(crate) async fn wait_subscriptions(&self, count: usize) {
        let mut changed = self.changed.subscribe();
        loop {
            if self.state.lock().unwrap().subscriptions.len() == count {
                return;
            }
            changed
                .changed()
                .await
                .expect("subscription sender retained");
        }
    }

    pub(crate) fn arm(
        &self,
        target: Target,
        mode: FaultMode,
    ) -> Result<Arc<FaultPlan>, ControlError> {
        let mut state = self.state.lock().unwrap();
        if state.active.is_some() {
            return Err(ControlError::Active);
        }
        let subscription = state
            .subscriptions
            .get(&target.subscription)
            .ok_or(ControlError::InvalidTarget)?;
        if subscription.session_id != target.session_id
            || target.sequence == 0
            || target.sequence > i64::MAX as u64
            || target.sequence <= subscription.last_sequence
        {
            return Err(ControlError::InvalidTarget);
        }
        state.generation = state
            .generation
            .checked_add(1)
            .expect("fault generation overflow");
        let plan = Arc::new(FaultPlan {
            generation: state.generation,
            target,
            mode,
            status: watch::channel(Status {
                phase: Phase::Armed,
                hit: None,
            })
            .0,
        });
        state.active = Some(plan.clone());
        Ok(plan)
    }

    pub(crate) fn release(&self, plan: &Arc<FaultPlan>) -> Result<(), ControlError> {
        let state = self.state.lock().unwrap();
        let active = state.active.as_ref().ok_or(ControlError::Stale)?;
        if !Arc::ptr_eq(active, plan) || active.generation != plan.generation {
            return Err(ControlError::Stale);
        }
        if active.phase() != Phase::Reached {
            return Err(ControlError::NotReached);
        }
        active.transition(Phase::Released);
        Ok(())
    }

    pub(super) fn subscribe(
        self: &Arc<Self>,
        session_id: ApplicationSessionId,
        after: u64,
    ) -> Guard {
        let mut state = self.state.lock().unwrap();
        state.ordinal = state
            .ordinal
            .checked_add(1)
            .expect("subscription ordinal overflow");
        let ordinal = state.ordinal;
        state.subscriptions.insert(
            ordinal,
            Subscription {
                session_id,
                ordinal,
                last_sequence: after,
            },
        );
        self.changed.send_replace(());
        Guard {
            hook: Arc::downgrade(self),
            ordinal,
            closed: self.closed.clone(),
        }
    }
}

impl Drop for FaultHook {
    fn drop(&mut self) {
        let state = self.state.get_mut().unwrap();
        state.subscriptions.clear();
        if let Some(plan) = state.active.take() {
            plan.transition(Phase::Aborted);
        }
        self.closed.cancel();
    }
}

pub(super) struct Guard {
    hook: Weak<FaultHook>,
    ordinal: u64,
    pub(super) closed: CancellationToken,
}

impl Guard {
    pub(super) fn frame(
        &self,
        bytes: &[u8],
    ) -> Result<Option<(Arc<FaultPlan>, usize)>, ControlError> {
        let Some(hook) = self.hook.upgrade() else {
            return Ok(None);
        };
        let mut state = hook.state.lock().unwrap();
        let Some(subscription) = state.subscriptions.get_mut(&self.ordinal) else {
            return Ok(None);
        };
        // Axum 0.8.9 emits one finalized event per data frame. Inspect only its ID line,
        // never JSON or a copy of the payload. Comments and no-ID events pass unchanged.
        let prefix = format!("event: wi.event\nid: {}:", subscription.session_id);
        let Some(rest) = bytes.strip_prefix(prefix.as_bytes()) else {
            return Ok(None);
        };
        let Some(end) = rest.iter().position(|b| *b == b'\n') else {
            return Ok(None);
        };
        let Some(sequence) = std::str::from_utf8(&rest[..end])
            .ok()
            .and_then(|s| crate::http_api::wire::parse_sequence(s).ok())
        else {
            return Ok(None);
        };
        subscription.last_sequence = sequence;
        let Some(plan) = state.active.as_ref() else {
            return Ok(None);
        };
        if plan.target.subscription != self.ordinal || plan.target.sequence != sequence {
            return Ok(None);
        }
        if plan.phase() != Phase::Armed {
            return Err(ControlError::NotReached);
        }
        if bytes.len() > MAX_FRAME_BYTES || bytes.len() < 4 || !bytes.ends_with(b"\n\n") {
            return Err(ControlError::InvalidFrame);
        }
        let yielded_bytes = match plan.mode {
            FaultMode::PrefixThenError => (bytes.len() - 2) / 2,
            FaultMode::WholeThenError => bytes.len(),
        };
        plan.status.send_replace(Status {
            phase: Phase::Reached,
            hit: Some(Hit {
                target: plan.target.clone(),
                mode: plan.mode,
                frame_bytes: bytes.len(),
                yielded_bytes,
            }),
        });
        Ok(Some((plan.clone(), yielded_bytes)))
    }

    pub(super) async fn released(&self, plan: &FaultPlan, shutdown: &CancellationToken) -> bool {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => false,
            _ = self.closed.cancelled() => false,
            released = plan.released() => released,
        }
    }

    pub(super) fn finish(&self, completed: bool) {
        let Some(hook) = self.hook.upgrade() else {
            return;
        };
        let mut state = hook.state.lock().unwrap();
        state.subscriptions.remove(&self.ordinal);
        if state
            .active
            .as_ref()
            .is_some_and(|plan| plan.target.subscription == self.ordinal)
        {
            let plan = state.active.take().unwrap();
            plan.transition(if completed {
                Phase::Completed
            } else {
                Phase::Aborted
            });
        }
        hook.changed.send_replace(());
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.finish(false);
    }
}
