#[path = "cli/serve_process.rs"]
mod process;

use process::Process;
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Command};

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
            "schema_version":1,"listen":"127.0.0.1:0","public_origin":"https://wi.example.test",
            "data_root":temp.path().join("private-data-canary"),"client_token_file":token,
            "global_skills_root":temp.path().join("missing-skills"),"workspaces":[workspace],
            "model":"synthetic-model","instructions":"private-instructions-canary",
            "provider_transport":"websocket","account":null,"enable_add_numbers":false
        });
        let path = temp.path().join("private-config-canary.json");
        let f = Self { temp, config, path };
        f.save();
        f
    }
    fn save(&self) {
        fs::write(&self.path, serde_json::to_vec(&self.config).unwrap()).unwrap();
    }
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_wi"));
        command.arg("serve").arg("--config").arg(&self.path);
        command
    }
    fn failure(&self, expected: &str) {
        let process = Process::start(self.command(), self.temp.path());
        let (stdout, stderr) = process.finish(1);
        assert!(stdout.is_empty());
        assert_eq!(stderr, format!("error: {expected}\n"));
        assert!(!stderr.contains(TOKEN));
        assert!(!stderr.contains("canary"));
    }
}

#[test]
fn real_serve_help_and_parse_errors_are_static_without_auth() {
    let temp = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_wi"));
    command.args(["serve", "--help"]);
    let process = Process::start(command, temp.path());
    assert_eq!(
        process.line("Usage: "),
        "wi serve --config <ABSOLUTE_JSON_FILE>"
    );
    let (stdout, stderr) = process.finish(0);
    assert!(stderr.is_empty());
    assert!(stdout.contains("--config <ABSOLUTE_JSON_FILE>"));
    for excluded in [
        "--account",
        "--auth-file",
        "--token",
        "--resume",
        "--model",
        "--json",
    ] {
        assert!(!stdout.contains(excluded));
    }
    for args in [
        vec!["serve"],
        vec!["serve", "--config"],
        vec![
            "serve",
            "--config",
            "private-path-canary",
            "--config",
            "other-secret-canary",
        ],
        vec!["serve", "--token", TOKEN],
        vec!["serve", "private-argument-canary\u{1b}[31m"],
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_wi"));
        command.args(args);
        let (stdout, stderr) = Process::start(command, temp.path()).finish(2);
        assert!(stdout.is_empty());
        assert_eq!(stderr, "error: api.invalid_arguments\n");
    }
}

#[test]
fn real_serve_config_and_token_errors_never_print_paths_or_contents() {
    let mut f = Fixture::new();
    let path = f.path.clone();
    f.path = PathBuf::from("relative-private-canary.json");
    f.failure("api.path_invalid");
    f.path = f.temp.path().join("missing-private-canary");
    f.failure("api.config_file_invalid");
    f.path = f.temp.path().to_path_buf();
    f.failure("api.config_file_invalid");
    f.path = path;
    fs::write(&f.path, b"private-content-canary").unwrap();
    f.failure("api.config_invalid");
    fs::write(&f.path, [0xff]).unwrap();
    f.failure("api.config_invalid");
    fs::write(&f.path, vec![b' '; wi::MAX_INPUT_BYTES + 1]).unwrap();
    f.failure("api.config_too_large");
    f.save();
    fs::write(
        f.config["client_token_file"].as_str().unwrap(),
        "private-token-canary",
    )
    .unwrap();
    f.failure("api.token_format_invalid");
    assert!(!std::path::Path::new(f.config["data_root"].as_str().unwrap()).exists());
}

#[test]
fn real_serve_bind_and_storage_errors_are_static() {
    let mut f = Fixture::new();
    let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    f.config["listen"] = json!(occupied.local_addr().unwrap().to_string());
    f.save();
    f.failure("api.bind_failed");
    f.config["listen"] = json!("127.0.0.1:0");
    f.save();
    fs::write(
        f.config["data_root"].as_str().unwrap(),
        "private-storage-canary",
    )
    .unwrap();
    f.failure("api.storage_open_failed");
}

#[cfg(unix)]
#[tokio::test]
async fn real_serve_port_zero_sigint_sigterm_close_without_profile_or_browser_work() {
    use std::{net::SocketAddr, time::Duration};
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .build()
        .unwrap();
    for (signal, account) in [
        (libc::SIGINT, None),
        (libc::SIGTERM, Some("synthetic-account")),
    ] {
        let mut f = Fixture::new();
        f.config["account"] = json!(account);
        f.save();
        let process = Process::start(f.command(), f.temp.path());
        let address: SocketAddr = process.line("api.listening ").parse().unwrap();
        assert!(address.ip().is_loopback());
        assert_ne!(address.port(), 0);
        let response = tokio::time::timeout(
            Duration::from_secs(30),
            client
                .get(format!("http://{address}/v1/settings"))
                .bearer_auth(TOKEN)
                .send(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.status(), 200);
        let settings: Value = response.json().await.unwrap();
        assert_eq!(
            settings["provider_id"],
            wi::providers::openai_codex::PROVIDER_ID
        );
        assert_eq!(settings["model"], "synthetic-model");
        assert_eq!(settings["provider_transport"], "websocket");
        assert!(settings.get("account").is_none());
        // Signal only this owned child. Readiness means its signal handlers are registered.
        assert_eq!(
            unsafe { libc::kill(process.child.id() as libc::pid_t, signal) },
            0
        );
        let (stdout, stderr) = process.finish(0);
        assert!(stdout.is_empty());
        assert_eq!(
            stderr,
            format!("api.listening {address}\napi.shutdown_closed\n")
        );
        for name in ["home", "xdg", "codex"] {
            assert_eq!(
                fs::read_to_string(f.temp.path().join(name)).unwrap(),
                "private-auth-canary"
            );
        }
        // Successful startup with unusable auth roots does not require listing/selecting a profile.
        let store =
            wi::storage::SessionStore::open(PathBuf::from(f.config["data_root"].as_str().unwrap()))
                .await
                .unwrap();
        store.close().await.unwrap();
        let _listener = std::net::TcpListener::bind(address).unwrap();
    }
}
