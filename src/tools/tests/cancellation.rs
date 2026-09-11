use super::*;
use std::{
    cell::Cell,
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[derive(Debug, PartialEq, Eq)]
enum Stop {
    Sink(&'static str),
    Cancelled,
    Gateway,
}
impl From<GatewayError> for Stop {
    fn from(_: GatewayError) -> Self {
        Self::Gateway
    }
}

struct DropProbe(Arc<AtomicUsize>);
impl Drop for DropProbe {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
struct PendingTool {
    started: Mutex<Option<oneshot::Sender<()>>>,
    release: Mutex<Option<oneshot::Receiver<()>>>,
    invoked: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
}
#[async_trait]
impl Tool for PendingTool {
    fn definition(&self) -> ToolDefinition {
        add_numbers_definition()
    }
    fn validate(&self, arguments: &Value) -> Result<()> {
        AddNumbers.validate(arguments)
    }
    async fn execute(&self, _: Value) -> Result<Value> {
        self.invoked.fetch_add(1, Ordering::SeqCst);
        let _probe = DropProbe(self.dropped.clone());
        let release = self.release.lock().unwrap().take().unwrap();
        self.started
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .send(())
            .unwrap();
        release.await.unwrap();
        Ok(json!({"sum":5}))
    }
}

#[tokio::test]
async fn dropping_prepared_batch_does_not_execute_or_cache() {
    let (mut registry, calls) = registry();
    for ids in [vec![], vec!["one"], vec!["one", "two"]] {
        let batch = registry.preflight(&response(&ids)).unwrap();
        assert_eq!(batch.calls.len(), ids.len());
        drop(batch);
        assert!(registry.results.is_empty());
        assert!(calls.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn observer_failure_at_each_start_finish_and_reuse_stops_remaining_batch() {
    for sink in ["full", "closed", "failed"] {
        for fail_at in 0..5 {
            let (mut registry, calls) = registry();
            registry
                .execute_response(&response(&["saved"]), |_| {})
                .await
                .unwrap();
            let mut batch = registry
                .preflight(&response(&["first", "saved", "last", "later"]))
                .unwrap();
            let mut observed = 0;
            loop {
                let result = batch
                    .execute_next(
                        || Ok(()),
                        pending::<Stop>(),
                        |_| {
                            let index = observed;
                            observed += 1;
                            if index == fail_at {
                                Err(Stop::Sink(sink))
                            } else {
                                Ok(())
                            }
                        },
                    )
                    .await;
                if let Err(error) = result {
                    assert_eq!(error, Stop::Sink(sink));
                    break;
                }
                assert!(result.unwrap().is_some());
            }
            assert_eq!(observed, fail_at + 1);
            assert!(
                batch
                    .execute_next(|| panic!(), pending::<Stop>(), |_| panic!())
                    .await
                    .unwrap()
                    .is_none()
            );
            drop(batch);
            let executed = match fail_at {
                0 => 0,
                1..=3 => 1,
                4 => 2,
                _ => unreachable!(),
            };
            assert_eq!(calls.lock().unwrap().len(), 1 + executed);
            // A failed finish observer does not erase an actual completed result.
            assert_eq!(registry.results.len(), 1 + executed);
            assert!(!registry.results.contains_key("later"));
        }
    }
}

#[tokio::test]
async fn checkpoint_failure_before_new_or_reused_call_emits_nothing() {
    for reuse in [false, true] {
        for reason in [Stop::Sink("failed"), Stop::Cancelled] {
            let (mut registry, calls) = registry();
            registry
                .execute_response(&response(&["saved"]), |_| {})
                .await
                .unwrap();
            let first = if reuse { "saved" } else { "new" };
            let mut batch = registry.preflight(&response(&[first, "later"])).unwrap();
            let mut reason = Some(reason);
            let error = batch
                .execute_next(
                    || Err(reason.take().unwrap()),
                    pending::<Stop>(),
                    |_| panic!(),
                )
                .await;
            assert!(error.is_err());
            assert!(
                batch
                    .execute_next(|| panic!(), pending::<Stop>(), |_| panic!())
                    .await
                    .unwrap()
                    .is_none()
            );
            drop(batch);
            assert_eq!(calls.lock().unwrap().len(), 1);
            assert_eq!(registry.results.len(), 1);
        }
    }
}

#[tokio::test]
async fn cancellation_after_start_or_between_calls_prevents_later_work() {
    for cancel_at_start in [true, false] {
        for reuse_next in [true, false] {
            let (mut registry, calls) = registry();
            registry
                .execute_response(&response(&["saved"]), |_| {})
                .await
                .unwrap();
            let next = if reuse_next { "saved" } else { "next" };
            let mut batch = registry.preflight(&response(&["first", next])).unwrap();
            let cancelled = Cell::new(false);
            let checkpoint = || {
                if cancelled.get() {
                    Err(Stop::Cancelled)
                } else {
                    Ok(())
                }
            };
            let mut observed = 0;
            let result = batch
                .execute_next(checkpoint, pending::<Stop>(), |event| {
                    observed += 1;
                    if cancel_at_start
                        || matches!(event, ToolExecutionEvent::ToolExecutionFinished { .. })
                    {
                        cancelled.set(true);
                    }
                    Ok(())
                })
                .await;
            if cancel_at_start {
                assert_eq!(result.unwrap_err(), Stop::Cancelled);
                assert_eq!(observed, 1);
            } else {
                assert!(result.unwrap().is_some());
                assert_eq!(observed, 2);
                assert_eq!(
                    batch
                        .execute_next(checkpoint, pending::<Stop>(), |_| panic!())
                        .await
                        .unwrap_err(),
                    Stop::Cancelled
                );
            }
            drop(batch);
            let completed = usize::from(!cancel_at_start);
            assert_eq!(calls.lock().unwrap().len(), 1 + completed);
            assert_eq!(registry.results.len(), 1 + completed);
        }
    }
}

#[tokio::test]
async fn cooperative_pending_tool_is_dropped_on_cancel_or_future_drop() {
    for mode in ["cancel", "drop"] {
        let (started_tx, mut started_rx) = oneshot::channel();
        let (_release_tx, release_rx) = oneshot::channel();
        let invoked = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(PendingTool {
                started: Mutex::new(Some(started_tx)),
                release: Mutex::new(Some(release_rx)),
                invoked: invoked.clone(),
                dropped: dropped.clone(),
            }))
            .unwrap();
        let mut batch = registry
            .preflight(&response(&["pending", "later"]))
            .unwrap();
        let mut events = Vec::new();
        if mode == "drop" {
            let mut future = Box::pin(batch.execute_next(
                || Ok(()),
                pending::<Stop>(),
                |event| {
                    events.push(event);
                    Ok(())
                },
            ));
            assert!(futures_util::poll!(future.as_mut()).is_pending());
            started_rx.try_recv().unwrap();
            drop(future);
        } else {
            let stop = async {
                started_rx.await.unwrap();
                let cancel = CancellationToken::new();
                cancel.cancel();
                cancel.cancelled().await;
                Stop::Cancelled
            };
            let error = batch
                .execute_next(
                    || Ok(()),
                    stop,
                    |event| {
                        events.push(event);
                        Ok(())
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(error, Stop::Cancelled);
            assert!(
                batch
                    .execute_next(|| panic!(), pending::<Stop>(), |_| panic!())
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        drop(batch);
        assert_eq!(invoked.load(Ordering::SeqCst), 1);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert!(registry.results.is_empty());
        assert_eq!(events.len(), 1);
        assert!(matches!(
            events[0],
            ToolExecutionEvent::ToolExecutionStarted { .. }
        ));
    }
}

#[tokio::test]
async fn ready_stop_wins_over_ready_tool_without_fabricating_finish() {
    let (mut registry, calls) = registry();
    let mut batch = registry.preflight(&response(&["first", "later"])).unwrap();
    let mut events = Vec::new();
    let result = batch
        .execute_next(
            || Ok(()),
            std::future::ready(Stop::Cancelled),
            |event| {
                events.push(event);
                Ok(())
            },
        )
        .await;
    assert_eq!(result.unwrap_err(), Stop::Cancelled);
    drop(batch);
    assert!(calls.lock().unwrap().is_empty());
    assert!(registry.results.is_empty());
    assert_eq!(events.len(), 1);
}
