#![cfg(target_os = "linux")]
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[test]
fn managed_absent_cli_is_actionable_and_never_creates_store() {
    for case in ["xdg", "home", "empty", "unsafe", "unlocked-document"] {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let xdg = temp.path().join("xdg");
        let base = if case == "home" {
            home.join(".config")
        } else {
            xdg.clone()
        };
        let root = base.join("wi/auth");
        if matches!(case, "empty" | "unsafe" | "unlocked-document") {
            fs::create_dir_all(&root).unwrap();
            fs::set_permissions(base.join("wi"), fs::Permissions::from_mode(0o700)).unwrap();
            fs::set_permissions(
                &root,
                fs::Permissions::from_mode(if case == "unsafe" { 0o755 } else { 0o700 }),
            )
            .unwrap();
            if case == "unlocked-document" {
                fs::write(
                    root.join("openai-codex.json"),
                    b"{\"version\":1,\"profiles\":{}}",
                )
                .unwrap();
            }
        }
        for args in [
            vec!["auth", "list", "--provider", "openai-codex"],
            vec![
                "auth",
                "status",
                "--provider",
                "openai-codex",
                "--account",
                "missing",
            ],
            vec![
                "auth",
                "logout",
                "--provider",
                "openai-codex",
                "--account",
                "missing",
            ],
            vec![
                "generate",
                "--auth-source",
                "gateway",
                "--model",
                "synthetic",
                "--prompt",
                "synthetic",
            ],
        ] {
            let mut command = Command::new(env!("CARGO_BIN_EXE_wi"));
            command
                .env_clear()
                .env("HOME", &home)
                .args(&args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if case != "home" {
                command.env("XDG_CONFIG_HOME", &xdg);
            }
            let mut child = command.spawn().unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while child.try_wait().unwrap().is_none() {
                if Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("synthetic CLI deadline");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let output = child.wait_with_output().unwrap();
            let error = String::from_utf8(output.stderr).unwrap();
            if matches!(case, "unsafe" | "unlocked-document") {
                assert_eq!(output.status.code(), Some(1));
                assert!(error.contains("Wi auth store unavailable or unsafe"));
            } else if args[1] == "list" {
                assert_eq!(output.status.code(), Some(0));
                assert_eq!(output.stdout, b"[]\n");
                assert!(error.is_empty());
            } else {
                assert_eq!(output.status.code(), Some(1));
                assert!(error.contains(if matches!(args[1], "status" | "logout") {
                    "Wi profile does not exist"
                } else {
                    "no eligible Wi profiles; login first"
                }));
                assert!(output.stdout.is_empty());
            }
        }
        if matches!(case, "xdg" | "home") {
            assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
        } else {
            assert!(!root.join("update.lock").exists());
            assert_eq!(
                fs::read_dir(&root).unwrap().count(),
                usize::from(case == "unlocked-document")
            );
            if case == "unsafe" {
                assert_eq!(
                    fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                    0o755
                );
            }
            if case == "unlocked-document" {
                assert_eq!(
                    fs::read(root.join("openai-codex.json")).unwrap(),
                    b"{\"version\":1,\"profiles\":{}}"
                );
            }
        }
    }
}
