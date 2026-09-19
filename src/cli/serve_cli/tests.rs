use super::*;
use serde_json::{Value, json};
use std::{fs, path::Path, time::Duration};
use wi::http_api::ServeError;

mod process;
#[path = "../../../tests/cli/serve_process.rs"]
mod process_support;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

struct Fixture {
    temp: tempfile::TempDir,
    config: Value,
    path: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let token = temp.path().join("private-token-canary");
        fs::write(&token, TOKEN).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&token, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let config = json!({
            "schema_version":1, "listen":"127.0.0.1:0",
            "public_origin":"https://wi.example.test", "data_root":temp.path().join("private-data-canary"),
            "client_token_file":token, "global_skills_root":temp.path().join("missing-skills"),
            "workspaces":[workspace], "model":"synthetic-model", "instructions":"private-instructions-canary",
            "provider_transport":"sse", "account":null, "enable_add_numbers":true
        });
        let path = temp.path().join("private-config-canary.json");
        let fixture = Self { temp, config, path };
        fixture.save();
        fixture
    }
    fn save(&self) {
        fs::write(&self.path, serde_json::to_vec(&self.config).unwrap()).unwrap();
    }
    fn args(&self) -> ServeArgs {
        ServeArgs {
            config: self.path.clone(),
        }
    }
    fn root(&self) -> &Path {
        Path::new(self.config["data_root"].as_str().unwrap())
    }
}

async fn watchdog<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .expect("test watchdog")
}

fn no_gateway(_: Option<String>) -> Result<Gateway, StartError> {
    panic!("invalid startup must not construct a gateway or auth manager")
}

#[tokio::test]
async fn startup_validation_and_token_precede_bind_and_gateway() {
    let mut f = Fixture::new();
    let error = start(
        ServeArgs {
            config: "relative-secret-canary".into(),
        },
        no_gateway,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.to_string(), "api.path_invalid");
    for content in [
        b"{\"private-canary\":true}".to_vec(),
        vec![0xff],
        vec![b' '; wi::MAX_INPUT_BYTES + 1],
        format!("{{\"schema_version\":1,{}", &f.config.to_string()[1..]).into_bytes(),
    ] {
        fs::write(&f.path, content).unwrap();
        assert!(matches!(
            start(f.args(), no_gateway).await,
            Err(StartError::Config(_))
        ));
        assert!(!f.root().exists());
    }
    for (key, value) in [
        ("listen", json!("0.0.0.0:0")),
        ("account", json!("../private-canary")),
        ("model", json!("")),
        ("data_root", json!("relative")),
    ] {
        let old = f.config[key].clone();
        f.config[key] = value;
        f.save();
        assert!(matches!(
            start(f.args(), no_gateway).await,
            Err(StartError::Config(_))
        ));
        f.config[key] = old;
    }
    // A bad token wins even when the requested port is already occupied.
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    f.config["listen"] = json!(occupied.local_addr().unwrap().to_string());
    f.save();
    let token = f.config["client_token_file"].as_str().unwrap();
    fs::write(token, "private-secret-canary").unwrap();
    assert!(matches!(
        start(f.args(), no_gateway).await,
        Err(StartError::Token(_))
    ));
    fs::write(token, TOKEN).unwrap();
    assert!(matches!(
        start(f.args(), no_gateway).await,
        Err(StartError::Bind)
    ));
    assert!(!f.root().exists());
}

#[tokio::test]
async fn injected_start_preserves_operator_settings_account_and_storage_order() {
    for account in [None, Some("synthetic-account")] {
        let mut f = Fixture::new();
        f.config["account"] = json!(account);
        f.save();
        let started = start(f.args(), |selected| {
            assert_eq!(selected.as_deref(), account);
            assert!(!f.root().exists());
            Ok(Gateway::new())
        })
        .await
        .unwrap();
        assert!(started.address.ip().is_loopback());
        assert_ne!(started.address.port(), 0);
        let settings = started.config.settings();
        assert_eq!(
            settings.provider_id(),
            wi::providers::openai_codex::PROVIDER_ID
        );
        assert_eq!(settings.options().model, "synthetic-model");
        assert_eq!(
            settings.options().instructions,
            "private-instructions-canary"
        );
        assert_eq!(settings.options().transport, wi::Transport::Sse);
        assert!(settings.options().tools.is_empty());
        assert!(settings.enable_add_numbers());
        assert_eq!(
            settings.global_skills_root(),
            f.temp.path().join("missing-skills")
        );
        assert!(started.config.owner_token().verify(TOKEN.as_bytes()));
        assert!(matches!(
            &*started.host.begin_shutdown().wait().await,
            ShutdownOutcome::Closed
        ));
    }
}

#[tokio::test]
async fn manager_and_storage_failures_are_static_and_listener_is_released() {
    let f = Fixture::new();
    let error = start(f.args(), |account| {
        managed_gateway(account, || {
            assert!(!f.root().exists());
            Err(wi::GatewayError::InvalidAuth("private-provider-canary"))
        })
    })
    .await
    .err()
    .unwrap();
    assert_eq!(error.to_string(), "api.auth_manager_failed");
    assert!(!f.root().exists());
    fs::write(f.root(), "private-storage-canary").unwrap();
    let error = start(f.args(), |_| Ok(Gateway::new())).await.err().unwrap();
    assert_eq!(error.to_string(), "api.storage_open_failed");
}

#[tokio::test]
async fn handler_signal_success_and_failure_drain_before_return_with_safe_notice() {
    for signal_error in [false, true] {
        let f = Fixture::new();
        let mut output = Vec::new();
        let result = watchdog(handle(
            f.args(),
            |_| Ok(Gateway::new()),
            || {
                Ok(async move {
                    if signal_error {
                        Err(io::Error::other("private-signal-canary"))
                    } else {
                        Ok(())
                    }
                })
            },
            &mut output,
        ))
        .await;
        if signal_error {
            assert!(matches!(result, Err(StartError::Signal)));
        } else {
            assert_eq!(result.unwrap(), 0);
        }
        let output = String::from_utf8(output).unwrap();
        let lines: Vec<_> = output.lines().collect();
        assert_eq!(lines.len(), 2);
        let address: SocketAddr = lines[0]
            .strip_prefix("api.listening ")
            .unwrap()
            .parse()
            .unwrap();
        assert_ne!(address.port(), 0);
        assert_eq!(lines[1], "api.shutdown_closed");
        assert!(!output.contains("canary"));
        assert!(!output.contains(TOKEN));
        assert!(!output.contains(f.temp.path().to_str().unwrap()));
        let store = SessionStore::open(f.root().to_path_buf()).await.unwrap();
        store.close().await.unwrap();
        let _listener = TcpListener::bind(address).await.unwrap();
    }
}

#[tokio::test]
async fn signal_registration_and_notice_failure_still_close_storage() {
    let f = Fixture::new();
    let mut out = Vec::new();
    let error = watchdog(handle(
        f.args(),
        |_| Ok(Gateway::new()),
        || Err::<std::future::Ready<io::Result<()>>, _>(io::Error::other("private-signal-canary")),
        &mut out,
    ))
    .await
    .unwrap_err();
    assert!(matches!(error, StartError::Signal));
    assert_eq!(out, b"api.shutdown_closed\n");
    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("private-output-canary"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    assert!(matches!(
        watchdog(handle(
            f.args(),
            |_| Ok(Gateway::new()),
            || Ok(std::future::pending()),
            &mut Broken
        ))
        .await,
        Err(StartError::Output)
    ));
    let store = SessionStore::open(f.root().to_path_buf()).await.unwrap();
    store.close().await.unwrap();
}

#[test]
fn result_mapping_requires_both_http_success_and_host_closed() {
    for error in [
        None,
        Some(ServeError::ListenerAddress),
        Some(ServeError::NonLoopbackListener),
        Some(ServeError::Configuration),
        Some(ServeError::Accept),
        Some(ServeError::Http),
        Some(ServeError::Panicked),
    ] {
        for incomplete in [false, true] {
            let shutdown = if incomplete {
                ShutdownOutcome::Incomplete {
                    worker_lost: true,
                    storage_error: None,
                }
            } else {
                ShutdownOutcome::Closed
            };
            let outcome = ServeOutcome {
                local_addr: None,
                http: error.map_or(Ok(()), Err),
                shutdown: Arc::new(shutdown),
            };
            let mut out = Vec::new();
            assert_eq!(
                report(&outcome, &mut out).unwrap(),
                i32::from(error.is_some() || incomplete)
            );
            let out = String::from_utf8(out).unwrap();
            assert!(out.ends_with(if incomplete {
                "api.shutdown_incomplete\n"
            } else {
                "api.shutdown_closed\n"
            }));
        }
    }
}
