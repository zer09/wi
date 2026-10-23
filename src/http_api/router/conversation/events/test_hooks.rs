//! Typed retired-read controls. These never intercept raw frames or browser readers.
use crate::{
    conversation::{ConversationChanges, LiveCursor},
    storage::test_hooks::Pause,
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

#[derive(Default)]
pub(crate) struct Hooks {
    pub reads: AtomicUsize,
    pub active: AtomicUsize,
    pub last: Mutex<Option<(LiveCursor, LiveCursor, u64)>>,
    pause: Mutex<Option<(usize, Arc<Pause>)>>,
    heartbeat: Mutex<Option<Duration>>,
}
impl Hooks {
    pub fn arm(&self, read: usize, pause: Arc<Pause>) {
        assert!(self.pause.lock().unwrap().replace((read, pause)).is_none());
    }
    pub async fn retired(&self, after: &LiveCursor, batch: &ConversationChanges) {
        *self.last.lock().unwrap() = Some((
            after.clone(),
            batch.next_after().clone(),
            batch.observed_head(),
        ));
        let count = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
        let pause = {
            let mut armed = self.pause.lock().unwrap();
            if armed.as_ref().is_some_and(|(read, _)| *read == count) {
                armed.take().map(|(_, pause)| pause)
            } else {
                None
            }
        };
        if let Some(pause) = pause {
            pause.reached.notify_one();
            pause.release.notified().await;
        }
    }
    pub fn set_heartbeat(&self, interval: Duration) {
        *self.heartbeat.lock().unwrap() = Some(interval);
    }
    pub fn heartbeat_interval(&self) -> Option<Duration> {
        *self.heartbeat.lock().unwrap()
    }
    pub fn observer(self: &Arc<Self>) -> Guard {
        self.active.fetch_add(1, Ordering::SeqCst);
        Guard(self.clone())
    }
}
pub(crate) struct Guard(Arc<Hooks>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

#[test]
fn display_poll_and_heartbeat_defaults_are_contract_intervals() {
    assert_eq!(super::POLL_INTERVAL, Duration::from_millis(250));
    assert_eq!(super::HEARTBEAT_INTERVAL, Duration::from_secs(15));
}
