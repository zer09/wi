//! Per-store, test-only timing. Numeric rows never contain storage or provider data.
use std::{
    collections::{BTreeMap, VecDeque},
    future::Future,
    sync::{Arc, Mutex},
    time::Instant,
};

const STAGES: usize = 25;
const INTERVALS: usize = 256;
const ACTIVE_LIMIT: usize = 128;
const OPERATIONS: usize = 512;
const MAX_US: u64 = 600_000_000;

// Enclosing stages are not leaves and must never be added to their child totals.
#[derive(Clone, Copy)]
#[repr(usize)]
pub(crate) enum Stage {
    Operation,
    Reader,
    SessionHeld,
    DisplayHeld,
    DeltaObservation,
    Admission,
    SpawnWait,
    MaintenanceWait,
    SessionWait,
    DisplayWait,
    CatalogWait,
    CatalogWork,
    SessionSetup,
    ReadOnlyOpen,
    ConnectionValidation,
    ReadOnlyRetirement,
    WritableOpen,
    Begin,
    TransactionValidation,
    Correlation,
    CanonicalInsert,
    ProjectionReceipt,
    Commit,
    WritableRetirement,
    // Reader leaf labels are represented separately below to keep labels numeric.
    ReaderLock,
}
// These IDs extend the closed enum without exporting strings or Rust internals.
pub(crate) const FETCH: usize = 25;
pub(crate) const RECONSTRUCT: usize = 26;
pub(crate) const COUNT: usize = 27;
pub(crate) const SEND: usize = 28;
pub(crate) const PACE: usize = 29;
const ALL_STAGES: usize = STAGES + 5;
pub(crate) const FETCHED_ROWS: usize = 0;
pub(crate) const DECODED_ROWS: usize = 1;
pub(crate) const BARRIERS: usize = 2;
pub(crate) const COMPLETED_READS: usize = 3;
const fn leaf(stage: usize) -> bool {
    stage >= 5 && stage != Stage::SessionSetup as usize
}

#[derive(Clone)]
pub(crate) struct Context {
    collector: Arc<Collector>,
    operation: u64,
    read: u64,
    delta: u64,
}
tokio::task_local! { static CURRENT: Context; }

#[derive(Clone, Default)]
struct Total {
    count: u64,
    elapsed: u64,
    union: u64,
    active: u64,
    since: u64,
    pending: u64,
}
#[derive(Clone)]
struct Interval {
    stage: usize,
    operation: u64,
    read: u64,
    delta: u64,
    start: u64,
}
#[derive(Clone)]
struct State {
    opening: Option<u64>,
    frozen: Option<Vec<Vec<u64>>>,
    serial: u64,
    operation: u64,
    read: u64,
    delta: u64,
    operations: BTreeMap<u64, (u64, u64)>,
    active: BTreeMap<u64, Interval>,
    intervals: VecDeque<Vec<u64>>,
    totals: [Total; ALL_STAGES],
    union: Total,
    truncated: bool,
    failed: bool,
    pre_window: u64,
    work: [u64; 4],
}
impl Default for State {
    fn default() -> Self {
        Self {
            opening: None,
            frozen: None,
            serial: 0,
            operation: 0,
            read: 0,
            delta: 0,
            operations: BTreeMap::new(),
            active: BTreeMap::new(),
            intervals: VecDeque::new(),
            totals: std::array::from_fn(|_| Total::default()),
            union: Total::default(),
            truncated: false,
            failed: false,
            pre_window: 0,
            work: [0; 4],
        }
    }
}
pub(crate) struct Collector {
    origin: Instant,
    state: Mutex<State>,
    // A deterministic clock exists only in controls, never in a fixture.
    clock: Option<Arc<std::sync::atomic::AtomicU64>>,
}
pub(crate) struct Span {
    collector: Arc<Collector>,
    token: Option<u64>,
}
fn enter(total: &mut Total, now: u64) {
    total.count += 1;
    if total.active == 0 {
        total.since = now;
    }
    total.active += 1;
}
fn exit(total: &mut Total, now: u64) {
    total.active -= 1;
    if total.active == 0 {
        total.union += now.saturating_sub(total.since);
    }
}
impl Collector {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            origin: Instant::now(),
            state: Mutex::new(State::default()),
            clock: None,
        })
    }
    fn now(&self) -> u64 {
        if let Some(clock) = &self.clock {
            return clock.load(std::sync::atomic::Ordering::SeqCst);
        }
        self.origin.elapsed().as_micros().min(u64::MAX as u128) as u64
    }
    pub(crate) fn operation(self: &Arc<Self>, mutation: bool) -> Context {
        let Ok(mut s) = self.state.lock() else {
            return self.fixture(0);
        };
        s.operation += 1;
        let operation = s.operation;
        if s.operations.len() == OPERATIONS {
            // Keep active writers and recent metadata, not an old prefix of reads.
            let retired = s
                .operations
                .keys()
                .find(|op| !s.active.values().any(|v| v.operation == **op))
                .copied();
            if let Some(retired) = retired {
                s.operations.remove(&retired);
            }
            s.truncated = true;
        }
        s.operations.insert(operation, (u64::from(mutation), 0));
        Context {
            collector: self.clone(),
            operation,
            read: 0,
            delta: 0,
        }
    }
    pub(crate) fn reader(self: &Arc<Self>, delta: u64) -> Context {
        let Ok(mut s) = self.state.lock() else {
            return self.fixture(delta);
        };
        s.read += 1;
        Context {
            collector: self.clone(),
            operation: 0,
            read: s.read,
            delta,
        }
    }
    pub(crate) fn fixture(self: &Arc<Self>, delta: u64) -> Context {
        Context {
            collector: self.clone(),
            operation: 0,
            read: 0,
            delta,
        }
    }
    pub(crate) fn open(&self) {
        let Ok(mut s) = self.state.lock() else {
            return;
        };
        let now = self.now();
        if s.opening.is_some() || now > MAX_US {
            s.failed = true;
            return;
        }
        s.opening = Some(now);
        let in_flight: Vec<_> = s.active.values().map(|v| v.operation).collect();
        s.operations.retain(|op, _| in_flight.contains(op));
        s.truncated = false;
        let stages: Vec<_> = s.active.values().map(|v| v.stage).collect();
        s.pre_window = stages.len() as u64;
        for stage in stages {
            enter(&mut s.totals[stage], now);
            if leaf(stage) {
                enter(&mut s.union, now);
            }
        }
    }
    pub(crate) fn freeze(&self) {
        let Ok(mut s) = self.state.lock() else {
            return;
        };
        let now = self.now();
        if s.frozen.is_some() {
            return;
        }
        let Some(opening) = s.opening else {
            return;
        };
        s.failed |= now > MAX_US || now < opening;
        let end = now.min(MAX_US).max(opening);
        let active: Vec<_> = s.active.values().cloned().collect();
        for v in active {
            s.totals[v.stage].pending += 1;
            complete(&mut s, &v, opening, end, true);
        }
        let measured = s.union.union;
        let elapsed = end - opening;
        let sum = s
            .totals
            .iter()
            .enumerate()
            .filter(|(i, _)| leaf(*i))
            .map(|(_, t)| t.elapsed)
            .sum::<u64>();
        let mut rows = vec![vec![
            0,
            opening,
            end,
            measured,
            elapsed.saturating_sub(measured),
            sum.saturating_sub(measured),
            u64::from(s.truncated),
            u64::from(s.failed),
            s.pre_window,
        ]];
        rows.extend(
            s.totals
                .iter()
                .enumerate()
                .map(|(i, t)| vec![1, i as u64, t.count, t.elapsed, t.union, t.pending]),
        );
        // Completed work up to freeze only. Pending fetches have no knowable row count.
        rows.push(vec![4, s.work[0], s.work[1], s.work[2], s.work[3]]);
        rows.extend(
            s.operations
                .iter()
                .map(|(op, (kind, delta))| vec![3, *op, *kind, *delta]),
        );
        rows.extend(s.intervals.iter().cloned());
        s.frozen = Some(rows);
    }
    pub(crate) fn capture_state(&self) -> &'static str {
        let Ok(s) = self.state.lock() else {
            return "capture_failed";
        };
        if s.frozen.is_some() {
            "captured"
        } else if s.failed {
            "capture_failed"
        } else {
            "unavailable"
        }
    }
    // Pages always come from the same frozen window. Export performs no reads or awaits.
    pub(crate) fn page(&self, page: usize) -> Option<(usize, Vec<Vec<u64>>)> {
        let s = self.state.lock().ok()?;
        let rows = s.frozen.as_ref()?;
        let pages = rows.len().div_ceil(24);
        if page >= pages {
            return None;
        }
        Some((
            pages,
            rows.iter().skip(page * 24).take(24).cloned().collect(),
        ))
    }
}
fn complete(s: &mut State, v: &Interval, opening: u64, end: u64, pending: bool) {
    let start = v.start.max(opening).min(end);
    s.totals[v.stage].elapsed += end - start;
    exit(&mut s.totals[v.stage], end);
    if leaf(v.stage) {
        exit(&mut s.union, end);
    }
    let delta = s
        .operations
        .get(&v.operation)
        .map(|(_, d)| *d)
        .unwrap_or(v.delta);
    if s.intervals.len() == INTERVALS {
        s.intervals.pop_front();
        s.truncated = true;
    }
    s.intervals.push_back(vec![
        2,
        v.stage as u64,
        v.operation,
        v.read,
        delta,
        start - opening,
        end - opening,
        u64::from(pending),
        u64::from(v.start < opening),
    ]);
}
impl Context {
    fn matches_store(&self) -> bool {
        // A nested disabled store must not borrow another store's timing context.
        super::ACTIVE
            .try_with(|hooks| {
                hooks
                    .latency()
                    .is_some_and(|c| Arc::ptr_eq(c, &self.collector))
            })
            .unwrap_or(true)
    }
    pub(crate) async fn scope<T>(&self, future: impl Future<Output = T>) -> T {
        CURRENT.scope(self.clone(), future).await
    }
    pub(crate) fn span(&self, stage: Stage) -> Option<Span> {
        self.marker(stage as usize)
    }
    pub(crate) fn marker(&self, stage: usize) -> Option<Span> {
        let Ok(mut s) = self.collector.state.lock() else {
            return None;
        };
        // Sample under the lock so concurrent spans cannot reorder union timestamps.
        let now = self.collector.now();
        if s.frozen.is_some() {
            return None;
        }
        if stage >= ALL_STAGES || now > MAX_US {
            s.failed = true;
            return None;
        }
        if s.active.len() == ACTIVE_LIMIT {
            s.failed = true;
            return None;
        }
        s.serial += 1;
        let token = s.serial;
        s.active.insert(
            token,
            Interval {
                stage,
                operation: self.operation,
                read: self.read,
                delta: self.delta,
                start: now,
            },
        );
        if s.opening.is_some() {
            enter(&mut s.totals[stage], now);
            if leaf(stage) {
                enter(&mut s.union, now);
            }
        }
        Some(Span {
            collector: self.collector.clone(),
            token: Some(token),
        })
    }
    pub(crate) fn work(&self, counter: usize, amount: u64) {
        if let Ok(mut s) = self.collector.state.lock() {
            if s.opening.is_none() || s.frozen.is_some() {
                return;
            }
            let next = s.work.get(counter).and_then(|n| n.checked_add(amount));
            let limit = if counter == BARRIERS { 70 } else { MAX_US };
            if let Some(next) = next.filter(|n| *n <= limit) {
                s.work[counter] = next;
            } else {
                s.failed = true;
            }
        }
    }

    pub(crate) fn fail(&self) {
        if let Ok(mut s) = self.collector.state.lock()
            && s.opening.is_some()
            && s.frozen.is_none()
        {
            s.failed = true;
        }
    }

    pub(crate) fn display(&self) {
        if let Ok(mut s) = self.collector.state.lock()
            && let Some(v) = s.operations.get_mut(&self.operation)
        {
            v.0 = 2;
        }
    }
    pub(crate) fn final_delta(&self) {
        if let Ok(mut s) = self.collector.state.lock() {
            s.delta += 1;
            let delta = s.delta;
            if let Some(v) = s.operations.get_mut(&self.operation) {
                v.1 = delta;
            }
        }
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        let Some(token) = self.token.take() else {
            return;
        };
        let Ok(mut s) = self.collector.state.lock() else {
            return;
        };
        let now = self.collector.now();
        let Some(v) = s.active.remove(&token) else {
            return;
        };
        if s.frozen.is_some() {
            return;
        }
        if let Some(opening) = s.opening {
            s.failed |= now > MAX_US || now < v.start;
            complete(
                &mut s,
                &v,
                opening,
                now.min(MAX_US).max(opening).max(v.start.min(MAX_US)),
                false,
            );
        }
    }
}
pub(crate) fn span(stage: Stage) -> Option<Span> {
    CURRENT
        .try_with(|c| {
            if c.matches_store() {
                c.span(stage)
            } else {
                None
            }
        })
        .ok()
        .flatten()
}
pub(crate) fn marker(stage: usize) -> Option<Span> {
    CURRENT
        .try_with(|c| {
            if c.matches_store() {
                c.marker(stage)
            } else {
                None
            }
        })
        .ok()
        .flatten()
}
pub(crate) fn work(counter: usize, amount: u64) {
    let _ = CURRENT.try_with(|c| {
        if c.matches_store() {
            c.work(counter, amount);
        }
    });
}
pub(crate) fn fail() {
    let _ = CURRENT.try_with(|c| {
        if c.matches_store() {
            c.fail();
        }
    });
}
pub(crate) fn display() {
    let _ = CURRENT.try_with(|c| {
        if c.matches_store() {
            c.display();
        }
    });
}
pub(crate) fn final_delta() {
    let _ = CURRENT.try_with(|c| {
        if c.matches_store() {
            c.final_delta();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    fn controlled() -> (Arc<Collector>, Arc<AtomicU64>) {
        let clock = Arc::new(AtomicU64::new(0));
        (
            Arc::new(Collector {
                origin: Instant::now(),
                state: Mutex::new(State::default()),
                clock: Some(clock.clone()),
            }),
            clock,
        )
    }
    fn rows(c: &Collector) -> Vec<Vec<u64>> {
        let pages = c.page(0).unwrap().0;
        (0..pages).flat_map(|p| c.page(p).unwrap().1).collect()
    }
    #[tokio::test]
    async fn latency_disabled_has_no_collector_or_clock() {
        let hooks = Arc::new(super::super::Hooks::default());
        assert!(hooks.latency().is_none());
        hooks
            .scope(async {
                assert!(span(Stage::Commit).is_none());
                assert!(marker(FETCH).is_none());
            })
            .await;
        assert!(hooks.latency().is_none());
        let enabled = Arc::new(super::super::Hooks::default());
        let c = enabled.enable_latency();
        c.open();
        c.operation(true)
            .scope(hooks.scope(async {
                assert!(span(Stage::Commit).is_none());
                assert!(marker(FETCH).is_none());
                display();
                final_delta();
            }))
            .await;
        assert!(hooks.latency().is_none());
        c.freeze();
        assert!(rows(&c).iter().any(|r| r == &vec![3, 1, 1, 0]));
        assert_eq!(rows(&c)[1 + Stage::Commit as usize][2], 0);
    }
    #[test]
    fn latency_totals_overlap_nesting_pre_window_pending_and_freeze() {
        let (c, clock) = controlled();
        let op = c.operation(true);
        let r = c.reader(1);
        let outer = op.span(Stage::Operation);
        let wait = op.span(Stage::SessionWait);
        clock.store(10, Ordering::SeqCst);
        c.open();
        clock.store(20, Ordering::SeqCst);
        let fetch = r.marker(FETCH);
        clock.store(30, Ordering::SeqCst);
        drop(wait);
        clock.store(40, Ordering::SeqCst);
        drop(fetch);
        clock.store(50, Ordering::SeqCst);
        c.freeze();
        let frozen = rows(&c);
        assert_eq!(frozen[0], vec![0, 10, 50, 30, 10, 10, 0, 0, 2]);
        assert_eq!(frozen[1], vec![1, 0, 1, 40, 40, 1]);
        assert!(
            frozen
                .iter()
                .any(|r| r[0] == 2 && r[1] == Stage::SessionWait as u64 && r[8] == 1)
        );
        drop(outer);
        clock.store(90, Ordering::SeqCst);
        c.freeze();
        assert_eq!(rows(&c), frozen);
        assert!(c.page(c.page(0).unwrap().0).is_none());
    }
    #[tokio::test]
    async fn latency_selector_counts_only_task_b_final_text_without_payloads() {
        use crate::{
            DeltaKind, EventEnvelope, ProviderEvent,
            run::{RunEvent, RunEventEnvelope},
            storage::{AppendRunRecord, OperationId, run_store::Mutation},
        };
        let hooks = Arc::new(super::super::Hooks::default());
        let c = hooks.enable_latency();
        c.open();
        for (response, kind) in [
            ("task-0-final", DeltaKind::Text),
            ("task-1-tools", DeltaKind::Text),
            ("task-1-final", DeltaKind::ReasoningText),
            ("task-1-final", DeltaKind::Text),
        ] {
            let mutation = Mutation::Append {
                records: vec![AppendRunRecord::Runtime(RunEventEnvelope {
                    schema_version: 2,
                    sequence: 1,
                    event_id: "synthetic".into(),
                    run_id: "synthetic".into(),
                    session_id: None,
                    turn_id: None,
                    request_id: None,
                    event: RunEvent::ProviderEvent {
                        event: Box::new(EventEnvelope {
                            schema_version: 1,
                            sequence: 1,
                            event_id: "synthetic".into(),
                            session_id: "synthetic".into(),
                            request_id: None,
                            provider: "synthetic".into(),
                            provider_sequence: None,
                            event: ProviderEvent::OutputItemUpdated {
                                response_id: response.into(),
                                item_id: "private-canary".into(),
                                output_index: 0,
                                content_index: None,
                                summary_index: None,
                                kind,
                                delta: "private-payload".into(),
                            },
                        }),
                    },
                })],
            };
            c.operation(true)
                .scope(hooks.scope(async {
                    super::super::select_record(&OperationId::new(), &mutation);
                }))
                .await;
        }
        c.freeze();
        let rows = rows(&c);
        assert_eq!(rows.iter().filter(|r| r[0] == 3 && r[3] == 1).count(), 1);
        let text = serde_json::to_string(&rows).unwrap();
        assert!(!text.contains("private") && !text.contains("task-"));
    }
    #[tokio::test]
    async fn latency_real_store_default_off_and_display_identity() {
        use crate::storage::{CreateSession, OperationId, SessionStore};
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("store")).await.unwrap();
        let created = store
            .create_session(
                CreateSession::new(OperationId::new(), "synthetic".into(), None).unwrap(),
            )
            .await
            .unwrap();
        let handle = store
            .open_session(created.session_id().clone())
            .await
            .unwrap();
        let hooks = handle.test_hooks();
        handle
            .rename(OperationId::new(), "off".into())
            .await
            .unwrap();
        assert!(hooks.latency().is_none());
        let c = hooks.enable_latency();
        c.open();
        handle
            .rename(OperationId::new(), "on".into())
            .await
            .unwrap();
        let after =
            crate::conversation::LiveCursor::new(handle.session_id().clone(), 1, 3, None, None)
                .unwrap();
        handle.conversation_changes(after).await.unwrap();
        c.freeze();
        let rows = rows(&c);
        assert!(rows.iter().any(|r| r[0] == 3 && r[2] == 2));
        assert_eq!(rows[1 + Stage::Commit as usize][2], 1);
        assert_eq!(rows[1 + Stage::DisplayHeld as usize][2], 1);
        assert!(rows[1 + Stage::WritableRetirement as usize][3] > 0);
        store.close().await.unwrap();
        temp.close().unwrap();
    }
    #[test]
    fn latency_work_counts_freeze_pending_reads_bounds_and_partial_detail() {
        let (c, clock) = controlled();
        let read = c.reader(1);
        read.work(FETCHED_ROWS, 99);
        clock.store(10, Ordering::SeqCst);
        c.open();
        let pending = read.span(Stage::Reader);
        let fetch = read.marker(FETCH);
        read.work(FETCHED_ROWS, 8);
        read.work(DECODED_ROWS, 8);
        read.work(COMPLETED_READS, 1);
        read.work(BARRIERS, 1);
        for _ in 0..300 {
            drop(read.marker(COUNT));
        }
        clock.store(20, Ordering::SeqCst);
        c.freeze();
        let frozen = rows(&c);
        assert_eq!(frozen[31], vec![4, 8, 8, 1, 1]);
        assert_eq!(frozen[0][6], 1);
        assert_eq!(frozen[0][7], 0);
        assert_eq!(frozen[1 + Stage::Reader as usize][5], 1);
        assert_eq!(frozen[1 + FETCH][5], 1);
        assert_eq!(frozen[1 + COUNT][2], 300);
        read.work(FETCHED_ROWS, 1000);
        read.fail();
        drop(fetch);
        drop(pending);
        assert_eq!(rows(&c), frozen);
        assert!(serde_json::to_vec(&frozen).unwrap().len() < 48 * 1024);
        for (counter, amount) in [(FETCHED_ROWS, MAX_US + 1), (BARRIERS, 71), (4, 1)] {
            let (c, _) = controlled();
            c.open();
            c.reader(1).work(counter, amount);
            c.freeze();
            assert_eq!(rows(&c)[0][7], 1);
        }
    }

    #[test]
    fn latency_correlations_bounds_failed_capture_and_numeric_privacy() {
        let (c, clock) = controlled();
        c.open();
        let op = c.operation(true);
        op.final_delta();
        for n in 1..=600 {
            clock.store(n, Ordering::SeqCst);
            drop(op.span(Stage::Commit));
        }
        let r = c.reader(1);
        for stage in [Stage::Reader, Stage::DeltaObservation, Stage::ReaderLock] {
            drop(r.span(stage));
        }
        for stage in [FETCH, RECONSTRUCT, COUNT, SEND, PACE] {
            drop(r.marker(stage));
        }
        c.freeze();
        let rows = rows(&c);
        assert_eq!(rows[0][6], 1);
        assert_eq!(rows[1 + Stage::Commit as usize][2], 600);
        assert!(rows.iter().any(|r| r == &vec![3, 1, 1, 1]));
        assert!(rows.iter().any(|r| r[0] == 2 && r[3] == 1 && r[4] == 1));
        assert!(serde_json::to_vec(&rows).unwrap().len() < 50_000);
        assert!(rows.iter().filter(|r| r[0] == 2).count() <= INTERVALS);
        let (c, clock) = controlled();
        assert!(c.page(0).is_none());
        c.open();
        clock.store(MAX_US + 1, Ordering::SeqCst);
        c.freeze();
        assert_eq!(self::rows(&c)[0][7], 1);
        let (c, clock) = controlled();
        clock.store(MAX_US + 1, Ordering::SeqCst);
        c.open();
        assert_eq!(c.capture_state(), "capture_failed");
        assert!(c.page(0).is_none());
        let (c, _) = controlled();
        c.open();
        let old = c.operation(true);
        let pending = old.span(Stage::Operation);
        for _ in 0..600 {
            drop(c.operation(false).span(Stage::Commit));
        }
        old.final_delta();
        let recent = c.operation(true);
        recent.final_delta();
        drop(pending);
        c.freeze();
        let rows = self::rows(&c);
        assert_eq!(rows.iter().filter(|r| r[0] == 3).count(), OPERATIONS);
        assert!(rows.iter().any(|r| r == &vec![3, old.operation, 1, 1]));
        assert!(rows.iter().any(|r| r == &vec![3, recent.operation, 1, 2]));
        let (c, _) = controlled();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = c.state.lock().unwrap();
            panic!("synthetic capture fault");
        }));
        assert!(c.operation(true).span(Stage::Commit).is_none());
        assert!(c.reader(1).marker(COUNT).is_none());
        c.freeze();
        assert_eq!(c.capture_state(), "capture_failed");
        assert!(c.page(0).is_none());
    }
}
