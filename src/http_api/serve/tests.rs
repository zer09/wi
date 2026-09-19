use super::*;
use crate::{
    Gateway, SessionOptions,
    http_api::{ApiSettings, OwnerToken},
    service::CancelDisposition,
    storage::{
        CreateSession, OperationId, RunId, SessionHandle, SessionStore, StorageErrorKind,
        test_hooks::{Action, Point},
    },
};
use serde_json::Value;
use std::{
    sync::{
        Mutex, Weak,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::Notify,
};

// Synthetic, local-only test credential.
const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[derive(Clone, Copy)]
pub(super) enum Fault {
    Accept,
    Panic,
}

#[derive(Default)]
pub(super) struct Hooks {
    pub host: Mutex<Weak<RunHost>>,
    pub accepted: Notify,
    pub write_pending: Notify,
    pub written: AtomicUsize,
    fault_ready: Notify,
    fault: Mutex<Option<Fault>>,
}

impl Hooks {
    fn fail(&self, fault: Fault) {
        *self.fault.lock().unwrap() = Some(fault);
        self.fault_ready.notify_one();
    }

    pub async fn fault(&self) -> Fault {
        self.fault_ready.notified().await;
        self.fault.lock().unwrap().take().unwrap()
    }
}

async fn watchdog<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(20), future)
        .await
        .expect("serve test watchdog")
}

fn config(temp: &tempfile::TempDir) -> ApiConfig {
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let mut options = SessionOptions::new("synthetic");
    options.instructions = "private-serve-instructions-canary".into();
    let settings = ApiSettings::new(
        "https://wi.example.test",
        vec![workspace],
        temp.path().join("private-skills-canary"),
        "execution-script".into(),
        options,
        false,
    )
    .unwrap();
    let path = temp.path().join("private-token-canary");
    std::fs::write(&path, TOKEN).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    ApiConfig::new(settings, OwnerToken::load(&path).unwrap())
}

fn http() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder().no_proxy().build().unwrap()
}

async fn session(host: &RunHost) -> SessionHandle {
    let created = host
        .storage()
        .create_session(CreateSession::new(OperationId::new(), "synthetic".into(), None).unwrap())
        .await
        .unwrap();
    host.storage()
        .open_session(created.session_id().clone())
        .await
        .unwrap()
}

struct Server {
    temp: tempfile::TempDir,
    host: Arc<RunHost>,
    address: SocketAddr,
    stop: CancellationToken,
    hooks: Arc<Hooks>,
    task: tokio::task::JoinHandle<ServeOutcome>,
}

impl Server {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("root")).await.unwrap();
        let host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
        Self::start(temp, host).await
    }

    async fn start(temp: tempfile::TempDir, host: RunHost) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let config = config(&temp);
        let stop = CancellationToken::new();
        let hooks = Arc::new(Hooks::default());
        let future = serve_inner(listener, host, config, stop.clone(), hooks.clone());
        // Retain a handler-like clone. It must never postpone owner shutdown initiation.
        let host = hooks.host.lock().unwrap().upgrade().unwrap();
        let task = tokio::spawn(future);
        Self {
            temp,
            host,
            address,
            stop,
            hooks,
            task,
        }
    }

    async fn wire(&self, request: &str) -> TcpStream {
        let mut socket = TcpStream::connect(self.address).await.unwrap();
        socket
            .write_all(
                format!(
                    "{request}\r\nHost: {}\r\nAuthorization: Bearer {TOKEN}\r\n\r\n",
                    self.address
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        socket
    }

    async fn finish(self) -> (ServeOutcome, tempfile::TempDir) {
        self.stop.cancel();
        let result = watchdog(self.task).await.unwrap();
        assert_eq!(result.local_addr, Some(self.address));
        assert!(Arc::ptr_eq(
            &result.shutdown,
            &self.host.begin_shutdown().wait().await
        ));
        // Keep persisted fixtures alive for assertions after the service has drained.
        (result, self.temp)
    }
}

async fn headers(socket: &mut TcpStream) -> String {
    watchdog(async {
        let mut bytes = vec![];
        while !bytes.ends_with(b"\r\n\r\n") {
            bytes.push(socket.read_u8().await.unwrap());
            assert!(bytes.len() < 16_384);
        }
        String::from_utf8(bytes).unwrap()
    })
    .await
}

fn closed(outcome: &ServeOutcome) {
    assert_eq!(outcome.http, Ok(()));
    assert!(matches!(&*outcome.shutdown, ShutdownOutcome::Closed));
}

#[tokio::test]
async fn public_serve_is_send_reports_actual_address_and_closes_storage() {
    let temp = tempfile::tempdir().unwrap();
    let config = config(&temp);
    assert_eq!(format!("{config:?}"), "ApiConfig([redacted])");
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
    let client = host.client();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let task = tokio::spawn(crate::http_api::serve(listener, host, config, stop.clone()));
    let response = watchdog(
        http()
            .get(format!("http://{address}/v1/settings"))
            .bearer_auth(TOKEN)
            .send(),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    let settings: Value = response.json().await.unwrap();
    assert_eq!(settings["api_version"], 1);
    stop.cancel();
    let outcome = watchdog(task).await.unwrap();
    closed(&outcome);
    assert_eq!(outcome.local_addr, Some(address));
    assert_eq!(
        client.cancel(&crate::storage::ApplicationSessionId::new(), &RunId::new()),
        CancelDisposition::Closed
    );
    let debug = format!("{outcome:?}");
    assert!(debug.contains(&address.to_string()));
    for private in [
        TOKEN,
        "private-serve-instructions-canary",
        "private-token-canary",
        "private-skills-canary",
    ] {
        assert!(!debug.contains(private));
    }
    SessionStore::open(temp.path().join("root"))
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
}

#[tokio::test]
async fn non_loopback_listener_rejects_queued_request_before_service_work() {
    let temp = tempfile::tempdir().unwrap();
    let config = config(&temp);
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let host = RunHost::new(store, Arc::new(Gateway::new())).unwrap();
    let session = session(&host).await;
    // Any protected storage open would consume this panic hook.
    session.test_hooks().arm(Point::Open, Action::Panic);
    let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let actual = listener.local_addr().unwrap();
    let mut socket = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, actual.port()))
        .await
        .unwrap();
    socket
        .write_all(
            format!(
                "GET /v1/sessions/{} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {TOKEN}\r\n\r\n",
                session.session_id(),
                actual
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let outcome = watchdog(serve(listener, host, config, CancellationToken::new())).await;
    assert_eq!(outcome.local_addr, Some(actual));
    assert_eq!(outcome.http, Err(ServeError::NonLoopbackListener));
    assert!(matches!(&*outcome.shutdown, ShutdownOutcome::Closed));
    let mut bytes = vec![];
    let _ = watchdog(socket.read_to_end(&mut bytes)).await;
    assert!(bytes.is_empty());
}

#[tokio::test]
async fn repeated_shutdown_and_handler_clones_preserve_original_outcome() {
    let server = Server::new().await;
    let clone = server.host.clone();
    let original = clone.begin_shutdown();
    let (result, _temp) = server.finish().await;
    closed(&result);
    assert!(Arc::ptr_eq(&result.shutdown, &original.wait().await));
    assert_eq!(
        clone
            .storage()
            .list_sessions(None, 1)
            .await
            .unwrap_err()
            .kind(),
        StorageErrorKind::Closed
    );
}

mod drain;
mod loss;
mod network;

#[test]
fn serving_errors_are_static_and_have_no_sources() {
    for (error, code) in [
        (ServeError::ListenerAddress, "api.listener_address_failed"),
        (ServeError::NonLoopbackListener, "api.listener_invalid"),
        (ServeError::Configuration, "api.config_invalid"),
        (ServeError::Accept, "api.accept_failed"),
        (ServeError::Http, "api.serve_failed"),
        (ServeError::Panicked, "api.serve_panicked"),
    ] {
        assert_eq!(error.to_string(), code);
        assert!(std::error::Error::source(&error).is_none());
    }
}
