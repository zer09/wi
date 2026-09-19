use std::sync::{
    Arc, Condvar, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;

#[derive(Default)]
pub(in crate::http_api::router) struct Pause {
    pub reached: Notify,
    released: Mutex<bool>,
    wake: Condvar,
}
impl Pause {
    fn wait(&self) {
        self.reached.notify_one();
        let guard = self.released.lock().unwrap();
        drop(self.wake.wait_while(guard, |released| !*released).unwrap());
    }
    pub fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.wake.notify_all();
    }
}

#[derive(Default)]
pub(in crate::http_api::router) struct Hooks {
    pub before: Mutex<Option<Arc<Pause>>>,
    pub after: Mutex<Option<Arc<Pause>>>,
    pub readers: AtomicUsize,
    pub dispatched: AtomicUsize,
    pub thread: Mutex<Option<std::thread::ThreadId>>,
    pub reader_left: Notify,
    pub waiter_left: Notify,
}
impl Hooks {
    pub fn enter(self: &Arc<Self>) -> Reader {
        self.readers.fetch_add(1, Ordering::SeqCst);
        *self.thread.lock().unwrap() = Some(std::thread::current().id());
        let reader = Reader(self.clone());
        let pause = self.before.lock().unwrap().take();
        if let Some(pause) = pause {
            pause.wait();
        }
        reader
    }
    pub fn after(&self) {
        let pause = self.after.lock().unwrap().take();
        if let Some(pause) = pause {
            pause.wait();
        }
    }
}
pub(in crate::http_api::router) struct Reader(Arc<Hooks>);
impl Drop for Reader {
    fn drop(&mut self) {
        self.0.reader_left.notify_one();
    }
}
pub(in crate::http_api::router) struct Waiter(pub Arc<Hooks>);
impl Drop for Waiter {
    fn drop(&mut self) {
        self.0.waiter_left.notify_one();
    }
}
