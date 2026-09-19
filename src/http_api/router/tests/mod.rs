use super::*;
use crate::{
    Gateway, SessionOptions,
    storage::{SessionHandle, SessionStore},
};
use serde_json::{Value, json};
use std::{future::Future, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;

mod authority_tests;
mod boundary_tests;
mod events_tests;
mod input_tests;
mod metadata_tests;
mod observation_tests;
mod run_tests;

// Synthetic verifier material only. Never use a user's configuration or HOME.
const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ORIGIN: &str = "https://wi.example.test";

async fn watchdog<T>(future: impl Future<Output = T>) -> T {
    // Hosted runners can delay disk-backed completion; this bounds tests, not runs.
    tokio::time::timeout(Duration::from_secs(60), future)
        .await
        .expect("HTTP test watchdog")
}

#[tokio::test(start_paused = true)]
async fn watchdog_tolerates_slow_progress_but_still_bounds_stalls() {
    watchdog(tokio::time::sleep(Duration::from_secs(30))).await;

    let started = tokio::time::Instant::now();
    let stalled = tokio::spawn(watchdog(std::future::pending::<()>()))
        .await
        .unwrap_err();
    assert!(stalled.is_panic());
    assert_eq!(started.elapsed(), Duration::from_secs(60));
}

struct Server {
    temp: tempfile::TempDir,
    host: Arc<RunHost>,
    address: SocketAddr,
    http: reqwest::Client,
    run_hooks: Arc<runs::test_hooks::Hooks>,
    event_hooks: Arc<events::test_hooks::Hooks>,
    stop: CancellationToken,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Server {
    async fn new() -> Self {
        Self::gateway(Arc::new(Gateway::new())).await
    }

    async fn gateway(gateway: Arc<Gateway>) -> Self {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("workspace")).unwrap();
        let store = SessionStore::open(temp.path().join("private-data-canary"))
            .await
            .unwrap();
        let host = Arc::new(RunHost::new(store, gateway).unwrap());
        Self::start(temp, host, false).await
    }

    async fn start(temp: tempfile::TempDir, host: Arc<RunHost>, retired: bool) -> Self {
        Self::start_tools(temp, host, retired, false).await
    }

    async fn start_tools(
        temp: tempfile::TempDir,
        host: Arc<RunHost>,
        retired: bool,
        add: bool,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let workspace = if retired {
            temp.path().join("other-workspace")
        } else {
            temp.path().join("workspace")
        };
        if retired {
            std::fs::create_dir(&workspace).unwrap();
        }
        let mut options = SessionOptions::new("synthetic-model");
        options.instructions = "private-instructions-canary".into();
        let settings = crate::http_api::ApiSettings::new(
            ORIGIN,
            vec![workspace],
            temp.path().join("private-skills-canary"),
            "http-test".into(),
            options,
            add,
        )
        .unwrap();
        let token_path = temp.path().join("private-token-path-canary");
        std::fs::write(&token_path, TOKEN).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let token = crate::http_api::OwnerToken::load(&token_path).unwrap();
        let run_hooks = Arc::new(runs::test_hooks::Hooks::default());
        let event_hooks = Arc::new(events::test_hooks::Hooks::default());
        let stop = CancellationToken::new();
        let app = router_inner(
            host.clone(),
            ApiConfig::new(settings, token),
            address,
            stop.clone(),
            run_hooks.clone(),
            event_hooks.clone(),
        )
        .unwrap();
        let stopping = stop.clone();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(stopping.cancelled_owned())
                .await
        });
        let _ = rustls::crypto::ring::default_provider().install_default();
        Self {
            temp,
            host,
            address,
            run_hooks,
            event_hooks,
            http: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap(),
            stop,
            task,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.address)
    }
    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.http.get(self.url(path)).bearer_auth(TOKEN)
    }
    fn post(&self, path: &str, body: &Value) -> reqwest::RequestBuilder {
        self.http.post(self.url(path)).bearer_auth(TOKEN).json(body)
    }
    fn workspace(&self) -> String {
        std::fs::canonicalize(self.temp.path().join("workspace"))
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned()
    }
    async fn session(&self) -> SessionHandle {
        let created = self
            .host
            .storage()
            .create_session(
                CreateSession::new(
                    OperationId::new(),
                    "original".into(),
                    Some(self.workspace()),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        self.host
            .storage()
            .open_session(created.session_id().clone())
            .await
            .unwrap()
    }
    async fn raw(&self, request: String) -> (u16, String, Value) {
        let mut socket = TcpStream::connect(self.address).await.unwrap();
        socket.write_all(request.as_bytes()).await.unwrap();
        watchdog(async {
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                headers.push(socket.read_u8().await.unwrap());
                assert!(headers.len() < 16_384);
            }
            let headers = String::from_utf8(headers).unwrap();
            let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap_or(0);
            let mut bytes = vec![0; length];
            socket.read_exact(&mut bytes).await.unwrap();
            let body = if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes).unwrap()
            };
            (status, headers, body)
        })
        .await
    }
    async fn stop_http(self) -> (tempfile::TempDir, Arc<RunHost>) {
        self.stop.cancel();
        watchdog(self.task).await.unwrap().unwrap();
        (self.temp, self.host)
    }
    async fn finish(self) {
        let (_temp, host) = self.stop_http().await;
        assert!(matches!(
            &*watchdog(host.begin_shutdown().wait()).await,
            crate::service::ShutdownOutcome::Closed
        ));
    }
}

async fn response(request: reqwest::RequestBuilder, status: u16) -> Value {
    let response = request.send().await.unwrap();
    assert_eq!(response.status().as_u16(), status);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        response.headers()[header::X_CONTENT_TYPE_OPTIONS],
        "nosniff"
    );
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    let text = response.text().await.unwrap();
    for private in [
        TOKEN,
        "private-data-canary",
        "private-instructions-canary",
        "private-skills-canary",
        "private-token-path-canary",
        "private-prepared-prompt-canary",
        "private-provider-session-canary",
        "private-native-canary",
        "private-format-canary",
    ] {
        assert!(!text.contains(private));
    }
    let body: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(body["api_version"], 1);
    body
}

async fn error(request: reqwest::RequestBuilder, status: u16, code: &str) -> Value {
    let body = response(request, status).await;
    assert_eq!(body["code"], code);
    if code.starts_with("api.") {
        assert_eq!(body["certainty"], "not_applicable");
    }
    assert_eq!(body["stage"], Value::Null);
    assert_eq!(body["acceptance"], Value::Null);
    assert_eq!(body["notices"], json!([]));
    body
}
