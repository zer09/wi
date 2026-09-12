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
    assert!(help.contains("A nonempty catalog exposes load_skill"));
    assert!(help.contains("supporting files and scripts are not read or executed"));
    assert!(help.contains("Use --use-skill to include selected instructions initially"));
    for flag in [
        "--auto-skills",
        "--enable-loader",
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
        vec!["--prompt", "hello", "--tool", "load_skill"],
        vec!["--prompt", "hello", "--auto-skills"],
        vec!["--prompt", "hello", "--enable-loader"],
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
fn run_binary_explicit_selections_and_tools_preserve_preparation_diagnostics() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    for (path, bytes) in [
        (
            config.join("wi/skills/review/SKILL.md"),
            &b"---\nname: review\ndescription: GLOBAL_METADATA\n---\n \t"[..],
        ),
        (
            workspace.join(".agents/skills/review/SKILL.md"),
            &b"---\nname: review\ndescription: PROJECT_METADATA\n---\n\xff"[..],
        ),
        (
            config.join("wi/skills/bad/SKILL.md"),
            &b"---\nname: bad\ndescription: false\n---\nPRIVATE_BODY"[..],
        ),
    ] {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    for source in ["codex", "pi", "gateway"] {
        for (first, second, expected, label) in [
            (
                "global:review",
                "project:review",
                "invalid_body",
                "global:review/SKILL.md",
            ),
            (
                "project:review",
                "global:review",
                "read_failed",
                "project:.agents/skills/review/SKILL.md",
            ),
        ] {
            let out = Command::new(env!("CARGO_BIN_EXE_wi"))
                .current_dir(&workspace)
                .env("XDG_CONFIG_HOME", &config)
                .env_remove("HOME")
                .env_remove("CODEX_HOME")
                .args([
                    "run",
                    "--model",
                    "synthetic",
                    "--prompt",
                    "hello",
                    "--json",
                    "--auth-source",
                    source,
                    "--tool",
                    "add_numbers",
                    "--use-skill",
                    first,
                    "--use-skill",
                    first,
                    "--use-skill",
                    second,
                ])
                .output()
                .unwrap();
            assert_eq!(out.status.code(), Some(1));
            assert!(out.stdout.is_empty());
            let diagnostic = String::from_utf8(out.stderr).unwrap();
            let lines: Vec<_> = diagnostic.lines().collect();
            assert_eq!(lines.len(), 2, "{diagnostic}");
            assert!(lines[0].starts_with("context: invalid_frontmatter:"));
            assert!(lines[0].contains("global:bad/SKILL.md"));
            assert!(lines[1].starts_with(&format!("error: {expected}:")));
            assert!(lines[1].contains(label), "{diagnostic}");
            assert!(!diagnostic.contains("PRIVATE"));
            assert!(!diagnostic.contains(temp.path().to_str().unwrap()));
            assert!(!diagnostic.contains("home directory"));
        }
    }
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
fn r1_a03_generate_binary_runtime_and_parse_exit_codes_before_auth() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let config = temp.path().join("config");
    let codex = temp.path().join("codex");
    // Auth reads would fail because each synthetic root is a file, not a directory.
    for root in [&home, &config, &codex] {
        std::fs::write(root, b"not a directory").unwrap();
    }
    for json in [false, true] {
        for (extra, code, expected) in [
            (
                vec!["--prompt", ""],
                1,
                "error: invalid request: empty user input\n",
            ),
            (
                vec!["--prompt", "initial", "--instructions", " "],
                1,
                "error: invalid request: model and instructions are required\n",
            ),
            (
                vec!["--prompt"],
                2,
                "error: a value is required for '--prompt <PROMPT>' but none was supplied",
            ),
        ] {
            let mut command = Command::new(env!("CARGO_BIN_EXE_wi"));
            command
                .env_clear()
                .env("HOME", &home)
                .env("XDG_CONFIG_HOME", &config)
                .env("CODEX_HOME", &codex)
                .current_dir(temp.path())
                .args(["generate", "--model", "synthetic"]);
            if json {
                command.arg("--json");
            }
            let output = command.args(&extra).output().unwrap();
            assert_eq!(output.status.code(), Some(code), "{extra:?}, json={json}");
            assert!(output.stdout.is_empty(), "{extra:?}, json={json}");
            let diagnostic = String::from_utf8(output.stderr).unwrap();
            if code == 1 {
                assert_eq!(diagnostic, expected, "{extra:?}, json={json}");
            } else {
                assert!(diagnostic.starts_with(expected), "{diagnostic}");
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
