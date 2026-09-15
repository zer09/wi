use serde_json::{Value, json};
use std::{fs, sync::Arc};
use wi::{
    SessionOptions,
    context::{ContextRoots, discover, prepare_run, prepare_run_with_skill_loading},
    run::RunRequest,
    storage::{AppendRunRecord, RecordedRunInput},
    tools::{AddNumbers, ToolRegistry},
};

pub(super) fn input() -> RecordedRunInput {
    RecordedRunInput::new(
        "original canary\r\n雪".into(),
        request(),
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap()
}

fn request() -> RunRequest {
    RunRequest {
        provider_id: "synthetic-unregistered-provider".into(),
        options: SessionOptions::new("synthetic-model"),
        prompt: "prepared canary\n".into(),
    }
}

#[test]
fn p1a09_capture_real_s1_and_s2_snapshots_without_reread() {
    let temp = tempfile::tempdir().unwrap();
    let roots = ContextRoots {
        workspace: temp.path().join("workspace"),
        global_skills: temp.path().join("global"),
    };
    fs::create_dir_all(roots.workspace.join(".agents/skills/local")).unwrap();
    fs::create_dir_all(roots.global_skills.join("shared")).unwrap();
    fs::write(roots.workspace.join("AGENTS.md"), "project canary\n").unwrap();
    fs::write(
        roots.workspace.join(".agents/skills/local/SKILL.md"),
        "---\nname: local\ndescription: local skill\n---\nlocal body\n",
    )
    .unwrap();
    fs::write(
        roots.global_skills.join("shared/SKILL.md"),
        "---\nname: shared\ndescription: shared skill\n---\nglobal body\n",
    )
    .unwrap();
    let catalog = discover(roots.clone()).unwrap();
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(AddNumbers)).unwrap();
    let selected = ["project:local".parse().unwrap()];
    let s1 = prepare_run(request(), &catalog, &selected, &tools).unwrap();
    let (s2, loader) =
        prepare_run_with_skill_loading(request(), Arc::new(catalog), &selected, &tools).unwrap();
    // Removing only this synthetic fixture proves capture uses owned preparation data.
    fs::remove_dir_all(&roots.workspace).unwrap();
    fs::remove_dir_all(&roots.global_skills).unwrap();
    for (prepared, registry, count) in [(&s1, &tools, 1), (&s2, &loader, 2)] {
        let captured =
            RecordedRunInput::capture("original task\n雪".into(), prepared, registry).unwrap();
        assert_eq!(captured.user_text(), "original task\n雪");
        assert_eq!(
            serde_json::to_value(captured.prepared_request()).unwrap(),
            serde_json::to_value(prepared.request()).unwrap()
        );
        assert!(captured.prepared_request().options.tools.is_empty());
        assert_eq!(captured.tool_definitions().len(), count);
        assert_eq!(
            serde_json::to_value(captured.tool_definitions()).unwrap(),
            serde_json::to_value(registry.definitions()).unwrap()
        );
        assert_eq!(captured.active_skills(), ["project:local"]);
        assert_eq!(
            captured.available_skills(),
            ["global:shared", "project:local"]
        );
        assert_eq!(
            captured.project_instructions_source(),
            Some("project:AGENTS.md")
        );
        assert!(!format!("{captured:?}").contains("canary"));
        let encoded = serde_json::to_value(&captured).unwrap();
        let restored: RecordedRunInput = serde_json::from_value(encoded.clone()).unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap(), encoded);
    }
}

#[test]
fn p1a09_strict_input_and_closed_append_deserialization() {
    let value = serde_json::to_value(input()).unwrap();
    for (field, bad) in [
        ("user_text", json!(" \n")),
        ("available_skills", json!(["/tmp/skill"])),
        (
            "available_skills",
            json!(["project:valid", "project:valid"]),
        ),
        ("available_skills", json!(["project:../escape"])),
        ("active_skills", json!(["project:absent"])),
        ("project_instructions_source", json!("/tmp/AGENTS.md")),
        ("extra", json!(true)),
    ] {
        let mut invalid = value.clone();
        invalid[field] = bad;
        assert!(serde_json::from_value::<RecordedRunInput>(invalid).is_err());
    }
    for (field, bad) in [
        ("prompt", json!("\t")),
        (
            "options",
            json!({"model":"", "instructions":"x", "tools":[], "transport":"web_socket", "required_features":[]}),
        ),
    ] {
        let mut invalid = value.clone();
        invalid["prepared_request"][field] = bad;
        assert!(serde_json::from_value::<RecordedRunInput>(invalid).is_err());
    }
    let definition = serde_json::to_value(wi::tools::add_numbers_definition()).unwrap();
    let mut invalid = value.clone();
    invalid["prepared_request"]["options"]["tools"] = json!([definition.clone()]);
    assert!(serde_json::from_value::<RecordedRunInput>(invalid).is_err());
    let mut invalid = value;
    invalid["tool_definitions"] = json!([definition.clone(), definition]);
    assert!(serde_json::from_value::<RecordedRunInput>(invalid).is_err());
    for invalid in [
        json!({"type":"session_created","payload":{}}),
        json!({"type":"tool_result","payload":{"call_id":"x","output":"x","is_error":false,"extra":1}}),
    ] {
        assert!(serde_json::from_value::<AppendRunRecord>(invalid).is_err());
    }
    let record = AppendRunRecord::ToolResult {
        request_id: None,
        call_id: "opaque".into(),
        output: "canary\n".into(),
        is_error: true,
    };
    let encoded: Value = serde_json::to_value(&record).unwrap();
    assert_eq!(
        serde_json::to_value(serde_json::from_value::<AppendRunRecord>(encoded.clone()).unwrap())
            .unwrap(),
        encoded
    );
    assert!(!format!("{record:?}").contains("canary"));
}

#[tokio::test]
async fn p1a09_original_prepared_and_tools_validation_precedes_mutation() {
    let (_fixture, store, handle, _run) = super::recording::session().await;
    for fault in 0..8 {
        let mut user_text = "original".to_owned();
        let mut request = request();
        let mut definition = wi::tools::add_numbers_definition();
        match fault {
            0 => user_text = " \n\t".into(),
            1 => request.prompt = " \n\t".into(),
            2 => user_text = "x".repeat(1024 * 1024),
            3 => request.prompt = "x".repeat(1024 * 1024),
            4 => request.options.instructions.clear(),
            5 => request.options.model.clear(),
            6 => definition.parameters = json!({"type":"array"}),
            7 => request.options.tools.push(definition.clone()),
            _ => unreachable!(),
        }
        let error =
            RecordedRunInput::new(user_text, request, vec![definition], vec![], vec![], None)
                .unwrap_err();
        assert_eq!(error.code(), "storage.invalid_input");
        assert_eq!(handle.manifest().await.unwrap().head_sequence(), 1);
    }
    store.close().await.unwrap();
}
