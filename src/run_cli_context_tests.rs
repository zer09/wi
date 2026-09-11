use super::*;
use std::fs;

struct Fixture {
    temp: tempfile::TempDir,
    roots: ContextRoots,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let roots = ContextRoots {
            workspace: temp.path().join("workspace"),
            global_skills: temp.path().join("global"),
        };
        fs::create_dir(&roots.workspace).unwrap();
        Self { temp, roots }
    }
    fn file(&self, relative: &str, bytes: impl AsRef<[u8]>) {
        let path = self.temp.path().join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    fn skills(&self, project: bool) {
        self.file(
            "global/review/SKILL.md",
            "---\nname: review\ndescription: GLOBAL_METADATA\n---\nGLOBAL_BODY",
        );
        if project {
            self.file(
                "workspace/.agents/skills/review/SKILL.md",
                "---\nname: review\ndescription: PROJECT_METADATA\n---\nPROJECT_BODY",
            );
        }
    }
}

#[test]
fn run_cli_parser_requires_qualified_ids_and_keeps_selection_order() {
    let parsed = args(&[
        "--workspace",
        "relative",
        "--use-skill",
        "project:review",
        "--use-skill",
        "global:review",
        "--use-skill",
        "project:review",
    ]);
    assert_eq!(parsed.workspace.unwrap(), PathBuf::from("relative"));
    assert_eq!(
        parsed
            .use_skill
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        ["project:review", "global:review", "project:review"]
    );
    for value in [
        "review",
        "./review",
        "global:../review",
        "other:review",
        "global:Review",
        "project:",
    ] {
        assert!(
            crate::Cli::try_parse_from([
                "wi",
                "run",
                "--model",
                "synthetic",
                "--prompt",
                "hello",
                "--use-skill",
                value
            ])
            .is_err()
        );
    }
    for command in ["generate", "tool-demo", "smoke"] {
        for flag in ["--workspace", "--use-skill"] {
            assert!(
                crate::Cli::try_parse_from([
                    "wi",
                    command,
                    "--model",
                    "synthetic",
                    flag,
                    "global:review"
                ])
                .is_err()
            );
        }
    }
}

#[tokio::test]
async fn run_cli_prepared_catalog_and_explicit_bodies_reach_existing_controller() {
    for (project, selected, stdin) in [
        (false, false, false),
        (true, false, true),
        (true, true, false),
    ] {
        let f = Fixture::new();
        f.skills(project);
        f.file("workspace/AGENTS.md", "PROJECT_INSTRUCTIONS");
        let mut a = args(&[
            "--json",
            "--tool",
            "add_numbers",
            "--transport",
            "sse",
            "--auth-source",
            "gateway",
            "--account",
            "synthetic",
        ]);
        a.instructions = "CALLER_PREFIX".into();
        a.workspace = Some("relative".into());
        let task = " \nhello\t ";
        a.prompt = Some(task.into());
        if stdin {
            a.stdin = true;
            a.prompt = None;
        }
        if selected {
            a.use_skill = ["project:review", "global:review", "project:review"]
                .map(|id| id.parse().unwrap())
                .to_vec();
        }
        let (gateway, records) = setup(response(), false);
        let mut out = Vec::new();
        let mut diagnostics = Vec::new();
        let roots = f.roots.clone();
        let resolves = Arc::new(AtomicUsize::new(0));
        let counted = resolves.clone();
        // Invalid stdin bytes are ignored when --prompt supplies the task.
        let input = if stdin { task.as_bytes() } else { &b"\xff"[..] };
        let result = super::super::handle(
            a,
            input,
            |auth| {
                assert!(matches!(auth.auth_source, crate::SourceArg::Gateway));
                assert_eq!(auth.account.as_deref(), Some("synthetic"));
                Ok(gateway)
            },
            &mut out,
            pending(),
            move |workspace| {
                counted.fetch_add(1, Ordering::SeqCst);
                assert_eq!(workspace.unwrap(), PathBuf::from("relative"));
                Ok(roots)
            },
            &mut diagnostics,
        )
        .await
        .unwrap();
        assert_eq!(exit_code(&result), 0);
        assert_eq!(count(&resolves), 1);
        assert!(diagnostics.is_empty());
        assert_eq!(count(&records.opens), 1);
        assert_eq!(count(&records.generates), 1);
        assert_eq!(count(&records.closes), 1);
        let inputs = records.inputs.lock().unwrap();
        let [InputItem::User { text }] = &inputs[0][..] else {
            panic!()
        };
        let payload: Value = serde_json::from_str(text).unwrap();
        assert_eq!(payload["task"], task);
        assert_eq!(
            payload["project_instructions"],
            json!({"source":"project:AGENTS.md", "text":"PROJECT_INSTRUCTIONS"})
        );
        assert_eq!(
            payload["available_skills"].as_array().unwrap().len(),
            if project { 2 } else { 1 }
        );
        assert_eq!(payload["available_skills"][0]["id"], "global:review");
        assert_eq!(
            payload["available_skills"][0]["frontmatter"]["description"],
            "GLOBAL_METADATA"
        );
        if project {
            assert_eq!(payload["available_skills"][1]["id"], "project:review");
            assert_eq!(
                payload["available_skills"][1]["frontmatter"]["description"],
                "PROJECT_METADATA"
            );
        }
        if selected {
            assert_eq!(payload["active_skills"].as_array().unwrap().len(), 2);
            assert_eq!(payload["active_skills"][0]["id"], "project:review");
            assert_eq!(payload["active_skills"][0]["body"], "PROJECT_BODY");
            assert_eq!(payload["active_skills"][1]["id"], "global:review");
            assert_eq!(payload["active_skills"][1]["body"], "GLOBAL_BODY");
        } else {
            assert_eq!(payload["active_skills"], json!([]));
            assert!(!text.contains("_BODY"));
        }
        assert!(!text.contains(&f.temp.path().display().to_string()));
        let options = records.options.lock().unwrap();
        assert!(options[0].instructions.starts_with("CALLER_PREFIX"));
        assert!(!options[0].instructions.contains("PROJECT_INSTRUCTIONS"));
        assert!(!options[0].instructions.contains("_BODY"));
        assert_eq!(options[0].model, "synthetic");
        assert_eq!(options[0].transport, Transport::Sse);
        assert!(options[0].required_features.is_empty());
        assert_eq!(options[0].tools.len(), 1);
        assert_eq!(options[0].tools[0].name, "add_numbers");
        for line in String::from_utf8(out).unwrap().lines() {
            let event: Value = serde_json::from_str(line).unwrap();
            assert_eq!(event["schema_version"], 2);
            if event["type"] == "provider_event" {
                assert_eq!(event["event"]["schema_version"], 1);
            }
        }
    }
}

#[tokio::test]
async fn run_cli_context_errors_and_final_validation_precede_all_constructors() {
    for case in 0..7 {
        let f = Fixture::new();
        f.skills(false);
        f.file(
            "global/bad/SKILL.md",
            "---\nname: bad\ndescription: [PRIVATE_BAD_YAML]\n---\nPRIVATE_BODY",
        );
        let mut a = args(&["--json"]);
        let (category, label) = match case {
            0 => {
                a.use_skill = vec!["global:absent".parse().unwrap()];
                ("unknown_skill", "global:absent")
            }
            1 => {
                f.file("workspace/AGENTS.md", [0xff]);
                ("read_failed", "project:AGENTS.md")
            }
            2 => {
                fs::create_dir(f.roots.workspace.join("AGENTS.md")).unwrap();
                ("read_failed", "project:AGENTS.md")
            }
            3 => {
                f.file("workspace/AGENTS.md", "x".repeat(MAX_INPUT_BYTES));
                ("input_too_large", "")
            }
            4 => {
                let options = crate::options(&a.base);
                let overhead =
                    serde_json::to_vec(&options).unwrap().len() - options.instructions.len();
                a.instructions = "x".repeat(MAX_INPUT_BYTES - overhead);
                ("input_too_large", "")
            }
            5 => {
                f.file(
                    "global/review/SKILL.md",
                    "---\nname: review\ndescription: GLOBAL_METADATA\n---\n \t",
                );
                a.use_skill = vec!["global:review".parse().unwrap()];
                ("invalid_body", "global:review/SKILL.md")
            }
            6 => {
                f.file(
                    "global/duplicate/SKILL.md",
                    "---\nname: review\ndescription: duplicate\n---\nBODY",
                );
                ("duplicate_skill", "global:review/SKILL.md")
            }
            _ => unreachable!(),
        };
        let roots = f.roots.clone();
        let mut out = Vec::new();
        let mut diagnostics = Vec::new();
        let result = super::super::handle(
            a,
            &b""[..],
            |_| panic!("provider/auth constructed: {case}"),
            &mut out,
            pending(),
            move |_| Ok(roots),
            &mut diagnostics,
        )
        .await;
        let error = result.err().unwrap();
        let text = error.to_string();
        assert!(text.starts_with(category), "case {case}: {text}");
        assert!(text.contains(label), "case {case}: {text}");
        assert!(!text.contains("PRIVATE"));
        assert!(!text.contains(&f.temp.path().display().to_string()));
        assert!(out.is_empty());
        if case != 6 {
            let text = String::from_utf8(diagnostics).unwrap();
            assert!(text.contains("invalid_frontmatter"));
            assert!(text.contains("global:bad/SKILL.md"));
            assert!(!text.contains("PRIVATE"));
        }
    }
}

struct Notices(Arc<Mutex<Vec<u8>>>);
impl Write for Notices {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn run_cli_diagnostics_are_delivered_before_construction_and_not_to_ndjson() {
    let f = Fixture::new();
    f.file(
        "global/bad/SKILL.md",
        "---\nname: bad\ndescription: false\n---\nPRIVATE_BODY",
    );
    let notices = Arc::new(Mutex::new(Vec::new()));
    let mut diagnostics = Notices(notices.clone());
    let (gateway, _) = setup(response(), false);
    let roots = f.roots.clone();
    let mut out = Vec::new();
    super::super::handle(
        args(&["--json"]),
        &b""[..],
        |_| {
            assert!(
                String::from_utf8_lossy(&notices.lock().unwrap()).contains("invalid_frontmatter")
            );
            Ok(gateway)
        },
        &mut out,
        pending(),
        move |_| Ok(roots),
        &mut diagnostics,
    )
    .await
    .unwrap();
    assert!(!String::from_utf8_lossy(&out).contains("invalid_frontmatter"));
    for line in String::from_utf8(out).unwrap().lines() {
        serde_json::from_str::<RunEventEnvelope>(line).unwrap();
    }
}
