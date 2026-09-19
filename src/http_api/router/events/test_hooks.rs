use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use tokio::sync::Notify;

use crate::storage::{HistoryPage, test_hooks::Pause};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::http_api::router) struct Read {
    pub after: u64,
    pub through: Option<u64>,
    pub head: u64,
    pub count: usize,
}

#[derive(Default)]
pub(in crate::http_api::router) struct Hooks {
    pub reads: Mutex<Vec<Read>>,
    pause: Mutex<Option<(usize, Arc<Pause>)>>,
    changed: Notify,
    active: AtomicUsize,
    activity: Notify,
}
pub(in crate::http_api::router) struct Reader(Arc<Hooks>);
impl Drop for Reader {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
        self.0.activity.notify_one();
    }
}
impl Hooks {
    pub fn enter(self: &Arc<Self>) -> Reader {
        self.active.fetch_add(1, Ordering::SeqCst);
        self.activity.notify_one();
        Reader(self.clone())
    }
    pub async fn wait_active(&self, count: usize) {
        loop {
            let changed = self.activity.notified();
            if self.active.load(Ordering::SeqCst) == count {
                return;
            }
            changed.await;
        }
    }
    pub fn arm(&self, number: usize) -> Arc<Pause> {
        let pause = Arc::new(Pause::default());
        assert!(
            self.pause
                .lock()
                .unwrap()
                .replace((number, pause.clone()))
                .is_none()
        );
        pause
    }
    pub async fn page(&self, after: u64, through: Option<u64>, page: &HistoryPage) {
        let number = {
            let mut reads = self.reads.lock().unwrap();
            reads.push(Read {
                after,
                through,
                head: page.through_sequence(),
                count: page.records().len(),
            });
            reads.len()
        };
        self.changed.notify_one();
        let pause = {
            let mut pause = self.pause.lock().unwrap();
            if pause.as_ref().is_some_and(|(at, _)| *at == number) {
                pause.take().map(|(_, pause)| pause)
            } else {
                None
            }
        };
        if let Some(pause) = pause {
            pause.reached.notify_one();
            pause.release.notified().await;
        }
    }
    pub async fn wait(&self, number: usize) {
        loop {
            let changed = self.changed.notified();
            if self.reads.lock().unwrap().len() >= number {
                return;
            }
            changed.await;
        }
    }
}
