use super::*;
use crate::{
    SessionOptions,
    run::RunRequest,
    storage::{CreateSession, OperationId, RecordedRunInput, SessionHandle},
};
use std::time::Duration;

mod admission;
mod b2;
mod boundaries;
mod execution;
mod fixture;
mod loss;
mod replay;
mod storage;

async fn watchdog<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(20), future)
        .await
        .expect("service test watchdog")
}

fn request() -> PersistentRunRequest {
    PersistentRunRequest {
        operation_id: OperationId::new(),
        run_id: RunId::new(),
        input: RecordedRunInput::new(
            "synthetic host input".into(),
            RunRequest {
                provider_id: "host-script".into(),
                options: SessionOptions::new("synthetic"),
                prompt: "synthetic prepared input".into(),
            },
            vec![],
            vec![],
            vec![],
            None,
        )
        .unwrap(),
    }
}

async fn store() -> (tempfile::TempDir, SessionStore) {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    (temp, store)
}

async fn session(store: &SessionStore) -> SessionHandle {
    let created = store
        .create_session(
            CreateSession::new(OperationId::new(), "synthetic host session".into(), None).unwrap(),
        )
        .await
        .unwrap();
    store
        .open_session(created.session_id().clone())
        .await
        .unwrap()
}

#[test]
fn public_types_and_static_errors() {
    fn send_sync<T: Send + Sync>() {}
    fn clone<T: Clone>() {}
    send_sync::<RunHost>();
    send_sync::<RunClient>();
    send_sync::<RunTicket>();
    send_sync::<ShutdownTicket>();
    send_sync::<RunCompletion>();
    send_sync::<ShutdownOutcome>();
    clone::<RunClient>();
    clone::<RunTicket>();
    clone::<ShutdownTicket>();
    for (error, code) in [
        (RunHostError::RuntimeUnavailable, "host.runtime_unavailable"),
        (RunHostError::Closed, "host.closed"),
    ] {
        assert_eq!(error.code(), code);
        assert_eq!(error.to_string(), code);
        assert!(std::error::Error::source(&error).is_none());
    }
    assert_eq!(
        format!("{:?}", RunCompletion::WorkerLost),
        "RunCompletion::WorkerLost"
    );
    assert_eq!(
        format!("{:?}", ShutdownOutcome::Closed),
        "ShutdownOutcome::Closed"
    );
    assert_eq!(
        format!(
            "{:?}",
            ShutdownOutcome::Incomplete {
                worker_lost: true,
                storage_error: None
            }
        ),
        "ShutdownOutcome::Incomplete([redacted])",
    );
}

#[test]
fn construction_outside_runtime_is_unavailable() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (temp, store) = runtime.block_on(store());
    assert_eq!(
        RunHost::new(store, Arc::new(Gateway::new())).unwrap_err(),
        RunHostError::RuntimeUnavailable
    );
    runtime.block_on(async {
        SessionStore::open(temp.path().join("root"))
            .await
            .unwrap()
            .close()
            .await
            .unwrap();
    });
}

#[tokio::test]
async fn ticket_state_is_retained_write_once_and_waiters_are_send() {
    fn send<T: Send>(_: T) {}
    let (_temp, store) = store().await;
    let session = session(&store).await;
    let request = request();
    let ticket = RunTicket::new(
        session.session_id().clone(),
        request.operation_id.clone(),
        request.run_id.clone(),
    );
    let receipt = session
        .accept_run(request.operation_id, request.run_id, request.input)
        .await
        .unwrap();
    send(ticket.accepted());
    send(ticket.completion());
    assert!(futures_util::poll!(Box::pin(ticket.accepted())).is_pending());
    // No receivers survive these writes.
    ticket.publish_acceptance(receipt.clone());
    ticket.publish_completion(RunCompletion::WorkerLost);
    let final_result = ticket.completion().await;
    ticket.publish_completion(RunCompletion::WorkerLost);
    assert!(Arc::ptr_eq(
        &final_result,
        &ticket.clone().completion().await
    ));
    assert_eq!(ticket.accepted().await.unwrap(), receipt);
    let second_receipt = session
        .rename(OperationId::new(), "other receipt".into())
        .await
        .unwrap();
    ticket.publish_acceptance(second_receipt);
    assert_eq!(ticket.accepted().await.unwrap(), receipt);
    assert_eq!(format!("{ticket:?}"), "RunTicket([redacted])");
    store.close().await.unwrap();
}

#[tokio::test]
async fn completion_without_receipt_is_shared_and_cannot_be_reconstructed() {
    let (_temp, store) = store().await;
    let session = session(&store).await;
    let request = request();
    let ticket = RunTicket::new(
        session.session_id().clone(),
        request.operation_id.clone(),
        request.run_id.clone(),
    );
    ticket.publish_completion(RunCompletion::WorkerLost);
    let receipt = session
        .accept_run(request.operation_id, request.run_id, request.input)
        .await
        .unwrap();
    ticket.publish_acceptance(receipt);
    assert!(Arc::ptr_eq(
        &ticket.accepted().await.unwrap_err(),
        &ticket.completion().await
    ));
    store.close().await.unwrap();
}

#[tokio::test]
async fn registered_before_spawn_is_cancelled_and_drained_by_shutdown() {
    let (_temp, store) = store().await;
    let session = session(&store).await;
    let host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
    let client = host.client();
    let (ticket, worker) = host
        .inner
        .register(session.session_id().clone(), request(), ToolRegistry::new())
        .unwrap();
    assert_eq!(host.inner.tracker.len(), 1);
    assert!(futures_util::poll!(Box::pin(ticket.accepted())).is_pending());
    let shutdown = host.begin_shutdown();
    assert!(
        host.inner
            .gate()
            .entries
            .values()
            .all(|entry| entry.cancel.is_cancelled())
    );
    assert_eq!(
        client
            .submit(session.session_id().clone(), request(), ToolRegistry::new())
            .unwrap_err(),
        RunHostError::Closed
    );
    assert_eq!(host.inner.tracker.len(), 1);
    assert!(futures_util::poll!(Box::pin(shutdown.wait())).is_pending());
    // Storage must remain open until this already-registered future has retired.
    session.manifest().await.unwrap();
    host.inner.runtime.spawn(worker);
    assert!(matches!(
        &*watchdog(ticket.completion()).await,
        RunCompletion::Execution(Err(_))
    ));
    assert!(matches!(
        &*watchdog(shutdown.wait()).await,
        ShutdownOutcome::Closed
    ));
    assert!(host.inner.gate().entries.is_empty());
    assert_eq!(host.inner.tracker.len(), 0);
}

#[tokio::test]
async fn dropped_unpolled_worker_fails_closed_and_cancels_siblings() {
    let (_temp, store) = store().await;
    let host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
    let client = host.client();
    let (lost, worker) = host
        .inner
        .register(ApplicationSessionId::new(), request(), ToolRegistry::new())
        .unwrap();
    let (sibling, sibling_worker) = host
        .inner
        .register(ApplicationSessionId::new(), request(), ToolRegistry::new())
        .unwrap();
    drop(worker);
    assert!(matches!(
        &*watchdog(lost.completion()).await,
        RunCompletion::WorkerLost
    ));
    assert!(Arc::ptr_eq(
        &lost.accepted().await.unwrap_err(),
        &lost.completion().await
    ));
    assert_eq!(
        client.cancel(sibling.session_id(), sibling.run_id()),
        CancelDisposition::Closed
    );
    assert!(
        host.inner
            .gate()
            .entries
            .values()
            .all(|entry| entry.cancel.is_cancelled())
    );
    assert_eq!(
        client
            .submit(ApplicationSessionId::new(), request(), ToolRegistry::new())
            .unwrap_err(),
        RunHostError::Closed
    );
    let shutdown = host.begin_shutdown();
    assert!(futures_util::poll!(Box::pin(shutdown.wait())).is_pending());
    drop(sibling_worker);
    assert!(matches!(
        &*watchdog(sibling.completion()).await,
        RunCompletion::WorkerLost
    ));
    assert!(matches!(
        &*watchdog(shutdown.wait()).await,
        ShutdownOutcome::Incomplete {
            worker_lost: true,
            storage_error: None
        }
    ));
    assert!(host.inner.gate().entries.is_empty());
}

#[test]
fn stopped_runtime_drops_unpolled_worker_and_shutdown_without_hanging() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (_temp, host) = runtime.block_on(async {
        let (temp, store) = store().await;
        (temp, RunHost::new(store, Arc::new(Gateway::new())).unwrap())
    });
    let ticket = host
        .client()
        .submit(ApplicationSessionId::new(), request(), ToolRegistry::new())
        .unwrap();
    drop(runtime);
    let shutdown = host.begin_shutdown();
    let observer = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    observer.block_on(async {
        assert!(matches!(
            &*watchdog(ticket.completion()).await,
            RunCompletion::WorkerLost
        ));
        assert!(matches!(
            &*watchdog(shutdown.wait()).await,
            ShutdownOutcome::Incomplete {
                worker_lost: true,
                storage_error: None
            }
        ));
    });
}
