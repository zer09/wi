use std::{fs, process::Command};

#[test]
fn p1a28_process_normal_cli_help_and_noop_create_no_storage() {
    let temp = tempfile::tempdir().unwrap();
    for directory in ["home", "xdg", "codex", "tmp", "workspace"] {
        super::fixtures::directory(&temp.path().join(directory));
    }
    for (args, exit) in [
        (vec!["--help"], 0),
        (vec!["run", "--help"], 0),
        (vec!["--version"], 0),
        (vec![], 2),
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_wi"));
        command
            .args(args)
            .env_clear()
            .current_dir(temp.path().join("workspace"))
            .env("HOME", temp.path().join("home"))
            .env("XDG_CONFIG_HOME", temp.path().join("xdg"))
            .env("CODEX_HOME", temp.path().join("codex"))
            .env("TMPDIR", temp.path().join("tmp"))
            .env("TEMP", temp.path().join("tmp"))
            .env("TMP", temp.path().join("tmp"));
        let output = command.output().unwrap();
        assert_eq!(output.status.code(), Some(exit));
        for directory in ["home", "xdg", "codex", "tmp", "workspace"] {
            assert_eq!(
                fs::read_dir(temp.path().join(directory)).unwrap().count(),
                0
            );
        }
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 5);
    }
}
