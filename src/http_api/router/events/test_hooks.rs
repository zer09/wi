use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicUsize, Ordering},
};

use axum::{body::Body, response::Response};
use futures_util::StreamExt;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::storage::{ApplicationSessionId, HistoryPage, test_hooks::Pause};

mod fault;
pub(crate) use fault::{ControlError, FaultHook, FaultMode, FaultPlan, Phase, Target};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::http_api::router) struct Read {
    pub after: u64,
    pub through: Option<u64>,
    pub head: u64,
    pub count: usize,
}

#[derive(Default)]
pub(in crate::http_api) struct Hooks {
    faults: Weak<FaultHook>,
    pub(in crate::http_api::router) reads: Mutex<Vec<Read>>,
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
    pub(in crate::http_api) fn with_faults(faults: &Arc<FaultHook>) -> Self {
        Self {
            faults: Arc::downgrade(faults),
            ..Self::default()
        }
    }

    pub(super) fn wrap(
        self: &Arc<Self>,
        response: Response,
        sid: ApplicationSessionId,
        after: u64,
        closing: CancellationToken,
    ) -> Response {
        let reader = self.enter();
        let subscription = self.faults.upgrade().map(|hook| hook.subscribe(sid, after));
        let dropped = subscription
            .as_ref()
            .map(|s| s.closed.clone())
            .unwrap_or_default();
        let (parts, body) = response.into_parts();
        let mut source = body.into_data_stream();
        let stream = async_stream::stream! {
            // Capture guards even before the first poll, so dropping an unopened body retires it.
            let reader = reader;
            let subscription = subscription;
            loop {
                let next = tokio::select! {
                    biased;
                    _ = dropped.cancelled() => break,
                    next = source.next() => next,
                };
                let Some(next) = next else { break };
                let bytes = match next {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        drop(source);
                        drop(subscription);
                        drop(reader);
                        yield Err(error);
                        return;
                    }
                };
                let selected = if let Some(guard) = &subscription {
                    guard.frame(&bytes)
                } else {
                    Ok(None)
                };
                match selected {
                    Ok(Some((plan, length))) => {
                        // Reached means this body poll yields these bytes, not TCP/browser delivery.
                        yield Ok(bytes.slice(..length));
                        let guard = subscription.as_ref().unwrap();
                        let completed = guard.released(&plan, &closing).await;
                        guard.finish(completed);
                        drop(source);
                        drop(subscription);
                        drop(reader);
                        yield Err(axum::Error::new(std::io::Error::other("test SSE fault")));
                        return;
                    }
                    Err(_) => {
                        drop(source);
                        drop(subscription);
                        drop(reader);
                        yield Err(axum::Error::new(std::io::Error::other("test SSE frame rejected")));
                        return;
                    }
                    Ok(None) => yield Ok(bytes),
                }
            }
            drop(source);
            drop(subscription);
            drop(reader);
        };
        Response::from_parts(parts, Body::from_stream(stream))
    }

    fn enter(self: &Arc<Self>) -> Reader {
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
