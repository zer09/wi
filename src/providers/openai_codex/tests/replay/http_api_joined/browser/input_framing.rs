//! Bounded setup evidence for rejection by the second provider-input validation.
use super::*;
use crate::{
    context::{ContextErrorKind, ContextRoots, discover, prepare_run_with_skill_loading},
    provider::{InputItem, MAX_INPUT_BYTES, validate_input},
    run::RunRequest,
    tools::{AddNumbers, ToolRegistry},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Parts {
    start: String,
    end: String,
}

pub(super) fn seed(workspace: &std::path::Path, global_skills: PathBuf, id: u32) -> Value {
    assert!(id > 0);
    let parts: Parts = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/web/test-support/task-input-framing.json"
    )))
    .unwrap();
    assert!(parts.start.chars().count() <= 64 && parts.end.chars().count() <= 64);
    let task_bytes = MAX_INPUT_BYTES * 3 / 4;
    let text = format!(
        "{}{}{}",
        parts.start,
        "x".repeat(task_bytes - parts.start.len() - parts.end.len()),
        parts.end
    );
    let unframed = [InputItem::user(text.clone())];
    validate_input(&unframed).unwrap();
    let unframed_bytes = serde_json::to_vec(&unframed).unwrap().len();
    assert!(text.len() == task_bytes && unframed_bytes <= MAX_INPUT_BYTES);

    let prefix = "private-project-browser\r\n";
    let project = format!("{prefix}{}", "p".repeat(MAX_INPUT_BYTES / 2 - prefix.len()));
    std::fs::write(workspace.join("AGENTS.md"), &project).unwrap();
    let project_bytes = std::fs::read(workspace.join("AGENTS.md")).unwrap().len();
    let skill_bytes = std::fs::read(workspace.join(".agents/skills/synthetic/SKILL.md"))
        .unwrap()
        .len();
    assert!(
        project_bytes == MAX_INPUT_BYTES / 2 && skill_bytes > 0 && skill_bytes < MAX_INPUT_BYTES
    );
    let catalog = Arc::new(
        discover(ContextRoots {
            workspace: workspace.to_owned(),
            global_skills,
        })
        .unwrap(),
    );
    assert!(catalog.entries().len() == 1 && catalog.diagnostics().is_empty());
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(AddNumbers)).unwrap();
    let mut options = SessionOptions::new(MODEL);
    options.instructions = INSTRUCTIONS.into();
    let request = RunRequest {
        provider_id: PROVIDER_ID.into(),
        options,
        prompt: "framing size witness".into(),
    };
    // Obtain the real framing and validate its options without dispatching any task.
    let (small, _) =
        prepare_run_with_skill_loading(request.clone(), catalog.clone(), &[], &tools).unwrap();
    let mut payload: Value = serde_json::from_str(&small.request().prompt).unwrap();
    assert!(payload["project_instructions"]["text"] == project);
    assert!(payload["available_skills"].as_array().unwrap().len() == 1);
    payload["task"] = json!(text);
    let framed = [InputItem::user(payload.to_string())];
    let framed_bytes = serde_json::to_vec(&framed).unwrap().len();
    assert!(framed_bytes > MAX_INPUT_BYTES && framed_bytes < 2 * MAX_INPUT_BYTES);
    assert!(matches!(
        validate_input(&framed),
        Err(crate::GatewayError::InvalidRequest("input exceeds 1 MiB"))
    ));
    let error = prepare_run_with_skill_loading(
        RunRequest {
            prompt: text,
            ..request
        },
        catalog,
        &[],
        &tools,
    )
    .err()
    .expect("framed input must reject");
    assert!(error.kind() == ContextErrorKind::InputTooLarge && error.source_label().is_none());
    json!({"id":id,"event":"input_framing_seeded","max_input_bytes":MAX_INPUT_BYTES,
        "task_bytes":task_bytes,"unframed_bytes":unframed_bytes,"project_bytes":project_bytes,
        "skill_bytes":skill_bytes,"framed_bytes":framed_bytes,"catalog_entries":1,
        "unframed_valid":true,"framing_overflow":true})
}

#[test]
fn input_framing_control_is_closed_and_bounded() {
    assert!(matches!(
        serde_json::from_str::<Control>(r#"{"command":"seed_input_framing","id":1}"#).unwrap(),
        Control::SeedInputFraming { id: 1 }
    ));
    for raw in [
        r#"{"command":"seed_input_framing"}"#,
        r#"{"command":"seed_input_framing","id":-1}"#,
        r#"{"command":"seed_input_framing","id":4294967296}"#,
        r#"{"command":"seed_input_framing","id":"1"}"#,
        r#"{"command":"seed_input_framing","id":1.5}"#,
        r#"{"command":"seed_input_framing","id":1,"id":2}"#,
        r#"{"command":"seed_input_framing","id":1,"text":"private-canary"}"#,
    ] {
        assert!(serde_json::from_str::<Control>(raw).is_err());
    }
}

#[test]
fn input_framing_seed_proves_valid_sources_and_unframed_input() {
    let temp = tempfile::tempdir().unwrap();
    skill(
        &temp.path().join(".agents/skills/synthetic"),
        "synthetic",
        "private-skill-browser\r\n",
    );
    let evidence = seed(temp.path(), temp.path().join("missing-global"), 1);
    assert!(evidence["unframed_valid"] == true && evidence["framing_overflow"] == true);
    assert!(evidence.as_object().unwrap().len() == 11);
    assert!(serde_json::to_vec(&evidence).unwrap().len() < LIMIT as usize);
    temp.close().unwrap();
}
