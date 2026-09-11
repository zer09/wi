use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

fn invoke(args: &[&str], input: &[u8]) -> Output {
    let temp = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_wi"))
        .args(args)
        .current_dir(temp.path())
        .env_remove("HOME")
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("CODEX_HOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(input).unwrap();
    drop(stdin);
    child.wait_with_output().unwrap()
}

#[test]
fn run_binary_help_and_clap_conflicts_do_not_need_auth_locations() {
    let help = invoke(&["run", "--help"], b"");
    assert_eq!(help.status.code(), Some(0));
    assert!(help.stderr.is_empty());
    let help = String::from_utf8(help.stdout).unwrap();
    for flag in [
        "--prompt",
        "--stdin",
        "--instructions",
        "--tool",
        "--workspace",
        "--use-skill",
        "--auth-source",
        "--account",
        "--auth-file",
        "--model",
        "--transport",
        "--json",
    ] {
        assert!(help.contains(flag), "{flag}");
    }
    for flag in [
        "--follow-up",
        "--resume",
        "--steer",
        "--max-model-requests",
        "--max-tool-executions",
        "--deadline-seconds",
    ] {
        assert!(!help.contains(flag));
    }
    let cases = vec![
        vec![],
        vec!["--prompt"],
        vec!["--prompt", "hello", "--unknown"],
        vec!["--prompt", "hello", "unexpected"],
        vec!["--prompt", "hello", "--prompt", "again"],
        vec!["--stdin", "--prompt", "hello"],
        vec!["--prompt", "hello", "--tool", "unknown"],
        vec!["--prompt", "hello", "--use-skill", "unqualified"],
        vec!["--prompt", "hello", "--use-skill", "project:../private\x1b"],
        vec!["--prompt", "hello", "--transport", "automatic"],
        vec!["--prompt", "hello", "--auth-source", "automatic"],
        vec![
            "--prompt",
            "hello",
            "--account",
            "test",
            "--auth-file",
            "absent",
        ],
        vec!["--prompt", "hello", "--follow-up", "later"],
        vec!["--prompt", "hello", "--resume", "id"],
        vec!["--prompt", "hello", "--steer", "later"],
    ];
    for case in cases {
        let argv: Vec<_> = ["run", "--model", "synthetic"]
            .into_iter()
            .chain(case)
            .collect();
        let output = invoke(&argv, b"");
        assert_eq!(output.status.code(), Some(1), "{argv:?}");
        assert!(output.stdout.is_empty(), "{argv:?}");
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        assert_eq!(
            diagnostic.matches("error:").count(),
            1,
            "{argv:?}: {diagnostic}"
        );
        assert!(!diagnostic.contains("home directory"));
        assert!(!diagnostic.chars().any(|c| c.is_control() && c != '\n'));
    }
    let output = invoke(&["run", "--prompt", "hello"], b"");
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let diagnostic = String::from_utf8_lossy(&output.stderr);
    assert_eq!(diagnostic.matches("error:").count(), 1);
    assert!(diagnostic.contains("--model"));
}

#[test]
fn removed_run_flags_are_unknown_before_auth_setup() {
    for source in ["codex", "pi", "gateway"] {
        for flag in [
            "--max-model-requests",
            "--max-tool-executions",
            "--deadline-seconds",
        ] {
            for suffix in [
                vec![flag.to_string(), "1".into()],
                vec![format!("{flag}=1")],
            ] {
                let mut args = vec![
                    "run",
                    "--model",
                    "synthetic",
                    "--prompt",
                    "hello",
                    "--auth-source",
                    source,
                ];
                args.extend(suffix.iter().map(String::as_str));
                let output = invoke(&args, b"");
                assert_eq!(output.status.code(), Some(1));
                assert!(output.stdout.is_empty());
                let diagnostic = String::from_utf8_lossy(&output.stderr);
                assert!(
                    diagnostic.contains(&format!("unexpected argument '{flag}")),
                    "{diagnostic}"
                );
                assert_eq!(diagnostic.matches("error:").count(), 1);
                assert!(!diagnostic.contains("home directory"));
            }
        }
    }
}

#[test]
fn legacy_parse_errors_and_help_keep_clap_exit_behavior() {
    for args in [
        vec![],
        vec!["unknown"],
        vec!["--unknown", "run"],
        vec!["generate", "--prompt", "run"],
        vec!["auth-check", "--unknown"],
        vec!["capabilities", "run"],
        vec!["tool-demo"],
        vec!["smoke", "--unknown"],
        vec!["auth", "--unknown"],
    ] {
        let output = invoke(&args, b"");
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        assert!(!output.stderr.is_empty(), "{args:?}");
    }
    for args in [
        vec!["--help"],
        vec!["--version"],
        vec!["run", "-h"],
        vec!["help", "run"],
        vec!["generate", "--help"],
    ] {
        let output = invoke(&args, b"");
        assert_eq!(output.status.code(), Some(0), "{args:?}");
        assert!(!output.stdout.is_empty(), "{args:?}");
        assert!(output.stderr.is_empty(), "{args:?}");
    }
}

#[test]
fn run_binary_prevalidation_precedes_external_and_managed_auth_location() {
    for source in ["codex", "pi", "gateway"] {
        for (extra, expected) in [
            (vec!["--prompt", " "], "empty user input"),
            (
                vec!["--prompt", "hello", "--instructions", " "],
                "model and instructions are required",
            ),
            (
                vec![
                    "--prompt",
                    "hello",
                    "--tool",
                    "add_numbers",
                    "--tool",
                    "add_numbers",
                ],
                "duplicate tool selection",
            ),
        ] {
            let argv: Vec<_> = [
                "run",
                "--model",
                "synthetic",
                "--auth-source",
                source,
                "--json",
            ]
            .into_iter()
            .chain(extra)
            .collect();
            let output = invoke(&argv, b"");
            assert_eq!(output.status.code(), Some(1));
            assert!(output.stdout.is_empty());
            assert!(String::from_utf8_lossy(&output.stderr).contains(expected));
        }
        for (input, expected) in [
            (vec![0xff], "stdin is not UTF-8"),
            (vec![b'x'; wi::MAX_INPUT_BYTES + 1], "stdin exceeds 1 MiB"),
            (vec![b'x'; wi::MAX_INPUT_BYTES], "input exceeds 1 MiB"),
            (vec![], "empty user input"),
        ] {
            let output = invoke(
                &[
                    "run",
                    "--model",
                    "synthetic",
                    "--auth-source",
                    source,
                    "--stdin",
                    "--json",
                ],
                &input,
            );
            assert_eq!(output.status.code(), Some(1));
            assert!(output.stdout.is_empty());
            assert!(String::from_utf8_lossy(&output.stderr).contains(expected));
        }
    }
    for (extra, expected) in [
        (
            vec!["--account", "test"],
            "--account requires --auth-source gateway",
        ),
        (
            vec!["--auth-source", "gateway", "--auth-file", "absent"],
            "managed auth does not accept --auth-file",
        ),
        (
            vec!["--auth-source", "gateway", "--account", "../invalid"],
            "invalid local profile name",
        ),
        (vec!["--model", ""], "model and instructions are required"),
    ] {
        let mut argv = vec!["run", "--prompt", "hello"];
        if extra[0] != "--model" {
            argv.extend(["--model", "synthetic"]);
        }
        argv.extend(extra);
        let output = invoke(&argv, b"");
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains(expected));
    }
}
