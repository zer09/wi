use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

struct Fixture {
    temp: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("project")).unwrap();
        Self { temp }
    }
    fn file(&self, path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) {
        let path = self.temp.path().join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    fn command(&self, xdg: bool) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_wi"));
        cmd.current_dir(self.temp.path())
            .env("HOME", self.temp.path().join("home"))
            .env("CODEX_HOME", self.temp.path().join("absent-codex"));
        if xdg {
            cmd.env("XDG_CONFIG_HOME", self.temp.path().join("config"));
        } else {
            cmd.env_remove("XDG_CONFIG_HOME");
        }
        cmd
    }
    #[cfg(unix)]
    fn command_with_deleted_cwd(&self, xdg: bool) -> Command {
        use std::os::unix::{ffi::OsStrExt, process::CommandExt};

        let cwd = self.temp.path().join("deleted-cwd");
        fs::create_dir(&cwd).unwrap();
        let mut cmd = self.command(xdg);
        cmd.current_dir(&cwd);
        let cwd = std::ffi::CString::new(cwd.as_os_str().as_bytes()).unwrap();
        // Remove only the child's synthetic cwd after chdir, without changing the test process cwd.
        // SAFETY: rmdir is async-signal-safe; the path is allocated before fork.
        unsafe {
            cmd.pre_exec(move || {
                if libc::rmdir(cwd.as_ptr()) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        cmd
    }
    fn global(&self, xdg: bool) -> &'static str {
        if xdg {
            "config/wi/skills"
        } else {
            "home/.config/wi/skills"
        }
    }
    fn files(&self) -> Vec<PathBuf> {
        let mut queue = vec![self.temp.path().to_owned()];
        let mut files = Vec::new();
        while let Some(path) = queue.pop() {
            for entry in fs::read_dir(path).unwrap() {
                let entry = entry.unwrap();
                files.push(
                    entry
                        .path()
                        .strip_prefix(self.temp.path())
                        .unwrap()
                        .to_owned(),
                );
                if entry.file_type().unwrap().is_dir() {
                    queue.push(entry.path());
                }
            }
        }
        files.sort();
        files
    }
    fn assert_safe(&self, out: &Output) {
        for bytes in [&out.stdout, &out.stderr] {
            let text = String::from_utf8_lossy(bytes);
            assert!(
                !text.contains(&self.temp.path().display().to_string()),
                "host path leaked"
            );
            assert!(!text.contains("BODY_CANARY"));
            assert!(!text.contains("YAML_CANARY"));
        }
        // JSON retains metadata exactly; only plain output and diagnostics filter controls.
        assert!(
            !String::from_utf8_lossy(&out.stderr)
                .chars()
                .any(|ch| ch.is_control() && ch != '\n')
        );
    }
}

#[test]
fn skills_binary_both_global_routes_project_addition_and_metadata_only_output() {
    for xdg in [false, true] {
        let f = Fixture::new();
        let global = PathBuf::from(f.global(xdg));
        f.file(global.join("review/SKILL.md"), b"---\nname: review\ndescription: \"GLOBAL_METADATA\\ncontrol\\u001b\\u009b\"\nextra: {enabled: true, labels: [one, two]}\n---\nBODY_CANARY\xff");
        f.file(
            "project/.agents/skills/review/SKILL.md",
            "---\nname: review\ndescription: PROJECT_METADATA\n---\nPROJECT_BODY_CANARY",
        );
        f.file("project/AGENTS.md", [0xff]);
        f.file("AGENTS.md", [0xff]);
        f.file(global.join("review/scripts/inert"), "RESOURCE_BODY_CANARY");
        let before = f.files();
        for project in [false, true] {
            let mut command = f.command(xdg);
            command.args(["skills", "list", "--json"]);
            if project {
                command.args(["--workspace", "project"]);
            }
            let out = command.output().unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            f.assert_safe(&out);
            assert!(out.stderr.is_empty());
            let value: Value = serde_json::from_slice(&out.stdout).unwrap();
            assert_eq!(value.as_object().unwrap().len(), 2);
            assert_eq!(value["diagnostics"], json!([]));
            let entries = value["entries"].as_array().unwrap();
            assert_eq!(entries.len(), if project { 2 } else { 1 });
            assert_eq!(entries[0]["id"], "global:review");
            assert_eq!(entries[0]["source"], "global:review/SKILL.md");
            assert_eq!(
                entries[0]["frontmatter"]["extra"],
                json!({"enabled":true,"labels":["one","two"]})
            );
            assert_eq!(
                entries[0]["frontmatter"]["description"],
                "GLOBAL_METADATA\ncontrol\x1b\u{009b}"
            );
            assert_eq!(entries[0].as_object().unwrap().len(), 3);
            if project {
                assert_eq!(entries[1]["id"], "project:review");
            }
        }
        let out = f
            .command(xdg)
            .args(["skills", "list", "--workspace", "project"])
            .output()
            .unwrap();
        assert!(out.status.success());
        f.assert_safe(&out);
        assert_eq!(
            String::from_utf8(out.stdout).unwrap(),
            "global:review\tGLOBAL_METADATAcontrol\nproject:review\tPROJECT_METADATA\n"
        );
        assert_eq!(before, f.files());
    }
}

#[test]
fn skills_binary_missing_scopes_are_empty_without_creating_config_or_auth_paths() {
    for xdg in [false, true] {
        let f = Fixture::new();
        let before = f.files();
        let out = f
            .command(xdg)
            .args(["skills", "list", "--workspace", "project", "--json"])
            .output()
            .unwrap();
        assert!(out.status.success());
        assert_eq!(
            serde_json::from_slice::<Value>(&out.stdout).unwrap(),
            json!({"entries":[],"diagnostics":[]})
        );
        assert!(out.stderr.is_empty());
        assert_eq!(before, f.files());
        assert!(!f.temp.path().join("home").exists());
        assert!(!f.temp.path().join("config").exists());
        assert!(!f.temp.path().join("absent-codex").exists());
    }
}

#[cfg(unix)]
#[test]
fn skills_binary_absolute_workspace_with_deleted_cwd_lists_metadata_without_creation() {
    for xdg in [false, true] {
        for populated in [false, true] {
            let f = Fixture::new();
            if populated {
                f.file(
                    PathBuf::from(f.global(xdg)).join("review/SKILL.md"),
                    "---\nname: review\ndescription: GLOBAL_METADATA\n---\nBODY_CANARY",
                );
                f.file(
                    "project/.agents/skills/review/SKILL.md",
                    "---\nname: review\ndescription: PROJECT_METADATA\n---\nBODY_CANARY",
                );
            }
            f.file("project/AGENTS.md", [0xff]);
            let before = f.files();
            let out = f
                .command_with_deleted_cwd(xdg)
                .args(["skills", "list", "--json", "--workspace"])
                .arg(f.temp.path().join("project"))
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            assert!(out.stderr.is_empty());
            let value: Value = serde_json::from_slice(&out.stdout).unwrap();
            assert_eq!(value["diagnostics"], json!([]));
            if populated {
                assert_eq!(value["entries"].as_array().unwrap().len(), 2);
                assert_eq!(value["entries"][0]["id"], "global:review");
                assert_eq!(value["entries"][1]["id"], "project:review");
                assert_eq!(
                    value["entries"][0]["frontmatter"]["description"],
                    "GLOBAL_METADATA"
                );
                assert_eq!(
                    value["entries"][1]["frontmatter"]["description"],
                    "PROJECT_METADATA"
                );
            } else {
                assert_eq!(value["entries"], json!([]));
            }
            f.assert_safe(&out);
            assert_eq!(before, f.files());
        }
    }
}

#[cfg(unix)]
#[test]
fn skills_and_run_binary_deleted_cwd_still_rejects_omitted_or_relative_workspace() {
    for command in [
        vec!["skills", "list", "--json"],
        vec!["run", "--model", "synthetic", "--prompt", "hello", "--json"],
    ] {
        for workspace in [None, Some("project")] {
            let f = Fixture::new();
            let before = f.files();
            let mut cmd = f.command_with_deleted_cwd(true);
            cmd.args(&command);
            if let Some(workspace) = workspace {
                cmd.args(["--workspace", workspace]);
            }
            let out = cmd.output().unwrap();
            assert_eq!(out.status.code(), Some(1));
            assert!(out.stdout.is_empty());
            assert_eq!(
                String::from_utf8_lossy(&out.stderr),
                "error: read_failed: cannot resolve CLI working directory (project:.)\n"
            );
            f.assert_safe(&out);
            assert_eq!(before, f.files());
        }
    }
}

#[cfg(unix)]
#[test]
fn run_binary_absolute_workspace_with_deleted_cwd_reaches_context_failure_before_auth() {
    for xdg in [false, true] {
        for source in ["codex", "pi", "gateway"] {
            let f = Fixture::new();
            f.file("project/AGENTS.md", [0xff]);
            let before = f.files();
            let out = f
                .command_with_deleted_cwd(xdg)
                .args([
                    "run",
                    "--model",
                    "synthetic",
                    "--prompt",
                    "hello",
                    "--json",
                    "--auth-source",
                    source,
                    "--workspace",
                ])
                .arg(f.temp.path().join("project"))
                .output()
                .unwrap();
            assert_eq!(out.status.code(), Some(1));
            assert!(out.stdout.is_empty());
            let text = String::from_utf8_lossy(&out.stderr);
            assert!(text.contains("read_failed:"), "{text}");
            assert!(text.contains("project:AGENTS.md"), "{text}");
            assert!(!text.contains("cannot resolve CLI working directory"));
            f.assert_safe(&out);
            assert_eq!(before, f.files());
        }
    }
}

#[test]
fn skills_binary_visible_diagnostics_keep_valid_entries_and_filter_controls() {
    let f = Fixture::new();
    f.file(
        "config/wi/skills/mismatch/SKILL.md",
        "---\nname: valid\ndescription: Metadata\nallowed-tools: shell\n---\nBODY_CANARY",
    );
    f.file(
        "project/.agents/skills/bad/SKILL.md",
        "---\nname: bad\ndescription: [YAML_CANARY]\n---\nBODY_CANARY",
    );
    #[cfg(unix)]
    f.file(
        "config/wi/skills/bad\x1b/SKILL.md",
        "---\nname: false\n---\nBODY_CANARY",
    );
    for json in [false, true] {
        let mut command = f.command(true);
        command.args(["skills", "list", "--workspace", "project"]);
        if json {
            command.arg("--json");
        }
        let out = command.output().unwrap();
        assert!(out.status.success());
        f.assert_safe(&out);
        let diagnostics = String::from_utf8_lossy(&out.stderr);
        for label in [
            "invalid_frontmatter",
            "project:.agents/skills/bad/SKILL.md",
            "directory_name_mismatch",
            "unsupported_behavioral_metadata",
        ] {
            assert!(diagnostics.contains(label));
        }
        if json {
            let value: Value = serde_json::from_slice(&out.stdout).unwrap();
            assert_eq!(value["entries"].as_array().unwrap().len(), 1);
            assert_eq!(value["entries"][0]["id"], "global:valid");
            let diagnostic = value["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .find(|d| d["source"] == "project:.agents/skills/bad/SKILL.md")
                .unwrap();
            assert_eq!(diagnostic["scope"], "project");
            assert_eq!(diagnostic["category"], "invalid_frontmatter");
        } else {
            assert_eq!(out.stdout, b"global:valid\tMetadata\n");
        }
    }
}

#[test]
fn skills_and_run_binary_invalid_environment_precedes_auth_and_creates_nothing() {
    for command in [
        vec!["skills", "list", "--json"],
        vec![
            "run",
            "--model",
            "synthetic",
            "--prompt",
            "hello",
            "--json",
            "--auth-source",
            "gateway",
        ],
    ] {
        for (xdg, home) in [
            (Some("relative-private\x1b"), None),
            (None, None),
            (Some(""), None),
            (None, Some("")),
            (None, Some("relative-private\x1b")),
        ] {
            let f = Fixture::new();
            let before = f.files();
            let mut cmd = f.command(true);
            cmd.args(&command)
                .env_remove("XDG_CONFIG_HOME")
                .env_remove("HOME");
            if let Some(value) = xdg {
                cmd.env("XDG_CONFIG_HOME", value);
            }
            if let Some(value) = home {
                cmd.env("HOME", value);
            }
            let out = cmd.output().unwrap();
            assert_eq!(out.status.code(), Some(1));
            assert!(out.stdout.is_empty());
            f.assert_safe(&out);
            let text = String::from_utf8_lossy(&out.stderr);
            assert!(text.contains("invalid_root:"));
            assert!(text.contains("(global:.)"));
            assert!(!text.contains("private"));
            assert_eq!(before, f.files());
        }
    }
    let f = Fixture::new();
    let out = f
        .command(true)
        .env_remove("HOME")
        .args(["skills", "list", "--json"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let out = f
        .command(false)
        .env("XDG_CONFIG_HOME", "")
        .args(["skills", "list", "--json"])
        .output()
        .unwrap();
    assert!(out.status.success());
}

#[test]
fn skills_binary_fatal_roots_and_duplicates_exit_nonzero_with_relative_labels() {
    for case in 0..4 {
        let f = Fixture::new();
        let (workspace, category, label) = match case {
            0 => ("missing", "invalid_root", "project:."),
            1 => {
                f.file("config/wi/skills", "PRIVATE");
                ("project", "invalid_root", "global:.")
            }
            2 => {
                f.file("project/.agents/skills", "PRIVATE");
                ("project", "invalid_root", "project:.agents/skills")
            }
            3 => {
                for folder in ["one", "two"] {
                    f.file(
                        format!("config/wi/skills/{folder}/SKILL.md"),
                        "---\nname: review\ndescription: Metadata\n---\nBODY_CANARY",
                    );
                }
                ("project", "duplicate_skill", "global:two/SKILL.md")
            }
            _ => unreachable!(),
        };
        let out = f
            .command(true)
            .args(["skills", "list", "--workspace", workspace, "--json"])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
        f.assert_safe(&out);
        let text = String::from_utf8_lossy(&out.stderr);
        assert!(text.contains(category), "{text}");
        assert!(text.contains(label), "{text}");
    }
}

#[test]
fn run_binary_context_failures_precede_each_auth_source_and_preserve_relative_labels() {
    for source in ["codex", "pi", "gateway"] {
        let f = Fixture::new();
        f.file("project/AGENTS.md", [0xff]);
        let before = f.files();
        let out = f
            .command(true)
            .args([
                "run",
                "--model",
                "synthetic",
                "--prompt",
                "hello",
                "--workspace",
                "project",
                "--json",
                "--auth-source",
                source,
            ])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
        let text = String::from_utf8_lossy(&out.stderr);
        assert!(text.contains("read_failed:"));
        assert!(text.contains("project:AGENTS.md"));
        f.assert_safe(&out);
        assert_eq!(before, f.files());
    }
}

#[cfg(unix)]
#[test]
fn skills_binary_explicit_workspace_link_selects_boundary_but_agents_link_is_not_read() {
    let f = Fixture::new();
    f.file(
        "project/.agents/skills/review/SKILL.md",
        "---\nname: review\ndescription: Metadata\n---\nBODY_CANARY",
    );
    std::os::unix::fs::symlink(f.temp.path().join("project"), f.temp.path().join("alias")).unwrap();
    std::os::unix::fs::symlink("missing-private", f.temp.path().join("project/AGENTS.md")).unwrap();
    let out = f
        .command(true)
        .args(["skills", "list", "--workspace", "alias", "--json"])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&out.stdout).unwrap()["entries"][0]["id"],
        "project:review"
    );
    f.assert_safe(&out);
    let out = f
        .command(true)
        .args([
            "run",
            "--model",
            "synthetic",
            "--prompt",
            "hello",
            "--workspace",
            "alias",
        ])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("read_failed:"));
    f.assert_safe(&out);
}

#[test]
fn skills_binary_help_parser_is_metadata_only_and_capabilities_exclude_hosted() {
    let f = Fixture::new();
    let out = f
        .command(true)
        .args(["skills", "list", "--help"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("--workspace"));
    assert!(text.contains("--json"));
    for flag in ["--use-skill", "--auth-source", "--model", "--tool"] {
        assert!(!text.contains(flag));
    }
    for extra in [
        "--use-skill",
        "--auth-source",
        "--model",
        "--tool",
        "--no-global",
    ] {
        let out = f
            .command(true)
            .args(["skills", "list", extra, "value"])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2));
    }
    let out = f.command(true).arg("capabilities").output().unwrap();
    assert!(out.status.success());
    assert!(!String::from_utf8_lossy(&out.stdout).contains("hosted_skills"));
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["advanced"].as_array().unwrap().len(), 4);
    for (entry, name) in value["advanced"].as_array().unwrap().iter().zip([
        "native_steering",
        "tool_search",
        "programmatic_tools",
        "async_tools",
    ]) {
        assert_eq!(entry["feature"], name);
        assert_eq!(entry["capability"]["implemented"], false);
    }
}
