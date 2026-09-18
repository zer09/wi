use super::*;
use crate::tools::{Tool, add_numbers_definition};
use std::sync::atomic::{AtomicUsize, Ordering};

struct DropProbe {
    host: Weak<HostInner>,
    definitions: Arc<AtomicUsize>,
    drops: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl Tool for DropProbe {
    fn definition(&self) -> crate::ToolDefinition {
        self.definitions.fetch_add(1, Ordering::SeqCst);
        add_numbers_definition()
    }

    fn validate(&self, _: &serde_json::Value) -> crate::Result<()> {
        panic!("rejected dispatch must not validate tools")
    }

    async fn execute(&self, _: serde_json::Value) -> crate::Result<serde_json::Value> {
        panic!("rejected dispatch must not execute tools")
    }
}

impl Drop for DropProbe {
    fn drop(&mut self) {
        let host = self.host.upgrade().unwrap();
        assert!(
            host.gate.try_lock().is_ok(),
            "tool dropped under admission gate"
        );
        self.drops.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn rejection_drops_prepared_tools_outside_gate_and_is_not_worker_loss() {
    let (_temp, store) = store().await;
    let host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
    let definitions = Arc::new(AtomicUsize::new(0));
    let drops = Arc::new(AtomicUsize::new(0));
    let mut tools = ToolRegistry::new();
    tools
        .register(Arc::new(DropProbe {
            host: Arc::downgrade(&host.inner),
            definitions: definitions.clone(),
            drops: drops.clone(),
        }))
        .unwrap();
    assert_eq!(definitions.load(Ordering::SeqCst), 1);
    let shutdown = host.begin_shutdown();
    assert_eq!(
        host.client()
            .submit(ApplicationSessionId::new(), request(), tools)
            .unwrap_err(),
        RunHostError::Closed
    );
    assert_eq!(definitions.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    assert!(host.inner.gate().entries.is_empty());
    assert!(host.inner.tracker.is_empty());
    assert!(matches!(
        &*watchdog(shutdown.wait()).await,
        ShutdownOutcome::Closed
    ));
}

#[tokio::test]
async fn submit_uses_captured_runtime_from_a_thread_without_runtime_context() {
    let (_temp, store) = store().await;
    let host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
    let client = host.client();
    let ticket = std::thread::spawn(move || {
        assert!(Handle::try_current().is_err());
        client
            .submit(ApplicationSessionId::new(), request(), ToolRegistry::new())
            .unwrap()
    })
    .join()
    .unwrap();
    assert!(matches!(
        &*watchdog(ticket.completion()).await,
        RunCompletion::SessionOpenFailed(_)
    ));
    assert!(matches!(
        &*watchdog(host.begin_shutdown().wait()).await,
        ShutdownOutcome::Closed
    ));
}

#[tokio::test]
async fn concurrent_dispatch_and_shutdown_share_one_registration_gate() {
    let (_temp, store) = store().await;
    let host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
    let client = host.client();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let (submission, shutdown) = std::thread::scope(|scope| {
        let start = barrier.clone();
        let submitter = scope.spawn(move || {
            start.wait();
            client.submit(ApplicationSessionId::new(), request(), ToolRegistry::new())
        });
        barrier.wait();
        let shutdown = host.begin_shutdown();
        (submitter.join().unwrap(), shutdown)
    });
    match submission {
        Ok(ticket) => {
            assert!(matches!(
                &*watchdog(ticket.completion()).await,
                RunCompletion::SessionOpenFailed(_)
            ));
        }
        Err(error) => assert_eq!(error, RunHostError::Closed),
    }
    assert!(matches!(
        &*watchdog(shutdown.wait()).await,
        ShutdownOutcome::Closed
    ));
    assert!(host.inner.gate().entries.is_empty());
    assert!(host.inner.tracker.is_empty());
}
