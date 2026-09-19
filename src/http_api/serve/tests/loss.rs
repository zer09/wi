use super::*;
use crate::{
    execution::tests::{
        in_session::fixture::{Fixture, Plan},
        process::harness::Process,
    },
    service::RunCompletion,
};
use sqlx::{ConnectOptions, Connection, SqliteConnection, sqlite::SqliteConnectOptions};

#[tokio::test]
async fn dropping_polled_owner_closes_network_and_host_despite_handler_clone() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let hooks = Arc::new(Hooks::default());
    let mut future = Box::pin(serve_inner(
        listener,
        host,
        config(&temp),
        CancellationToken::new(),
        hooks.clone(),
    ));
    let handler = hooks.host.lock().unwrap().upgrade().unwrap();
    let mut socket = TcpStream::connect(address).await.unwrap();
    watchdog(async {
        tokio::select! {
            _ = &mut future => panic!("owner returned before shutdown"),
            _ = hooks.accepted.notified() => (),
        }
    })
    .await;
    drop(future);
    assert_eq!(
        handler
            .client()
            .cancel(&crate::storage::ApplicationSessionId::new(), &RunId::new()),
        CancelDisposition::Closed
    );
    let mut bytes = Vec::new();
    let _ = watchdog(socket.read_to_end(&mut bytes)).await;
    assert!(bytes.is_empty());
    // Drop proves initiation. Await the host separately; no ServeOutcome was observed.
    assert!(matches!(
        &*watchdog(handler.begin_shutdown().wait()).await,
        ShutdownOutcome::Closed
    ));
}

#[test]
fn worker_loss_preserves_incomplete_outcome_and_quarantine() {
    // The quarantined lease survives until process exit, including on Windows.
    let sandbox = tempfile::tempdir().unwrap();
    Process::start_test(
        sandbox.path(),
        &(),
        "http_api::serve::tests::loss::incomplete_child",
    )
    .finish(0);
}

#[test]
#[ignore = "isolated quarantine helper; invoked by worker_loss_preserves_incomplete_outcome_and_quarantine"]
fn incomplete_child() {
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).unwrap();
    serde_json::from_str::<()>(&input).unwrap();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let fixture = Fixture::new().await;
        let task = fixture.task("synthetic worker loss", Plan { panic_open: true, ..Default::default() });
        let host = RunHost::new(fixture.store, task.gateway.clone()).unwrap();
        let server = Server::start(fixture.temp, host).await;
        let mut stream = server.wire(&format!("GET /v1/sessions/{}/events HTTP/1.1", fixture.session.session_id())).await;
        assert!(headers(&mut stream).await.starts_with("HTTP/1.1 200"));
        let ticket = server.host.client().submit(
            fixture.session.session_id().clone(), task.request(), task.tools.fresh_scope(),
        ).unwrap();
        assert!(matches!(&*watchdog(ticket.completion()).await, RunCompletion::WorkerLost));
        let acceptance = ticket.accepted().await.unwrap();
        let original = server.host.begin_shutdown();
        let expected = watchdog(original.wait()).await;
        let (outcome, temp) = server.finish().await;
        assert_eq!(outcome.http, Ok(()));
        assert!(Arc::ptr_eq(&outcome.shutdown, &expected));
        assert!(matches!(&*outcome.shutdown, ShutdownOutcome::Incomplete {
            worker_lost: true, storage_error: Some(error),
        } if error.kind() == StorageErrorKind::Io));
        assert_eq!(ticket.accepted().await.unwrap(), acceptance);
        let mut bytes = Vec::new();
        let _ = watchdog(stream.read_to_end(&mut bytes)).await;
        let id = ticket.session_id().as_str();
        let root = temp.path().join("root");
        let mut reader = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(root.join("sessions").join(&id[..2]).join(id).join("session.sqlite3"))
                .read_only(true)
                .disable_statement_logging(),
        ).await.unwrap();
        let unterminated: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM runs WHERE run_id=? AND terminal_sequence IS NULL AND result_sequence IS NULL",
        ).bind(ticket.run_id().as_str()).fetch_one(&mut reader).await.unwrap();
        assert_eq!(unterminated, 1);
        reader.close().await.unwrap();
        assert_eq!(SessionStore::open(root).await.err().unwrap().kind(), StorageErrorKind::Busy);
        println!("PROOF serve_worker_loss original_outcome=1 incomplete=1 fabricated_terminal=0 quarantine=1");
    });
}
