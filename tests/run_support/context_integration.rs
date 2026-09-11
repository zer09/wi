use super::run_support::*;
use serde_json::json;
use std::{fs, sync::Arc};
use wi::{
    context::{ContextRoots, discover, prepare_run},
    run::*,
    tools::ToolRegistry,
    *,
};

#[tokio::test]
async fn context_prepare_external_provider_receives_snapshot_and_only_ordinary_tool_continuation() {
    let temp = tempfile::tempdir().unwrap();
    let roots = ContextRoots {
        workspace: temp.path().join("workspace"),
        global_skills: temp.path().join("global"),
    };
    fs::create_dir_all(roots.workspace.join(".agents/skills/review")).unwrap();
    fs::create_dir_all(roots.global_skills.join("review")).unwrap();
    fs::create_dir_all(roots.global_skills.join("format")).unwrap();
    fs::write(
        roots.workspace.join("AGENTS.md"),
        "SYNTHETIC_PROJECT_POLICY\r\n",
    )
    .unwrap();
    fs::write(roots.workspace.join(".agents/skills/review/SKILL.md"), "---\nname: review\ndescription: PROJECT_DESCRIPTION\ncustom: {z: 2, a: 1}\n---\nPROJECT_BODY\r\n").unwrap();
    fs::write(
        roots.global_skills.join("review/SKILL.md"),
        "---\nname: review\ndescription: GLOBAL_DESCRIPTION\n---\nGLOBAL_BODY\n",
    )
    .unwrap();
    fs::write(
        roots.global_skills.join("format/SKILL.md"),
        "---\nname: format\ndescription: FORMAT_DESCRIPTION\n---\nUNSELECTED_BODY",
    )
    .unwrap();
    let catalog = discover(roots).unwrap();
    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(wi::tools::AddNumbers)).unwrap();
    let mut original = request();
    original.prompt = " Add 17 and 25.\r\n ".into();
    original.options.instructions = "CALLER_PREFIX\r\n  ".into();
    let prepared = prepare_run(
        original.clone(),
        &catalog,
        &[
            "project:review".parse().unwrap(),
            "global:review".parse().unwrap(),
        ],
        &registry,
    )
    .unwrap();
    let expected_input = prepared.request().prompt.clone();
    let mut expected_options = prepared.request().options.clone();
    assert!(
        expected_options
            .instructions
            .starts_with(&original.options.instructions)
    );
    assert!(!expected_options.instructions.contains("PROJECT_BODY"));
    assert!(!expected_options.instructions.contains("GLOBAL_BODY"));
    expected_options.tools = registry.definitions();
    let expected_payload = json!({
        "task": original.prompt,
        "project_instructions":{"source":"project:AGENTS.md", "text":"SYNTHETIC_PROJECT_POLICY\r\n"},
        "available_skills":[
            {"id":"global:format","frontmatter":{"name":"format","description":"FORMAT_DESCRIPTION"}},
            {"id":"global:review","frontmatter":{"name":"review","description":"GLOBAL_DESCRIPTION"}},
            {"id":"project:review","frontmatter":{"name":"review","description":"PROJECT_DESCRIPTION","custom":{"a":1,"z":2}}}
        ],
        "active_skills":[
            {"id":"project:review","frontmatter":{"name":"review","description":"PROJECT_DESCRIPTION","custom":{"a":1,"z":2}},"body":"PROJECT_BODY\r\n"},
            {"id":"global:review","frontmatter":{"name":"review","description":"GLOBAL_DESCRIPTION"},"body":"GLOBAL_BODY\n"}
        ]
    });
    assert_eq!(expected_input, expected_payload.to_string());
    assert!(!expected_input.contains(temp.path().to_str().unwrap()));
    drop(catalog);
    temp.close().unwrap();

    // This external Provider is constructed only after successful local validation.
    // Its native fields are opaque, non-OpenAI data from the existing run fixtures.
    let script = Arc::new(Script::new(vec![
        Step::Response(response("first", vec![call("addition", 17, 25)], "")),
        Step::Response(response("final", vec![], "42")),
    ]));
    let mut gateway = Gateway::new();
    gateway.register(script.clone()).unwrap();
    let (result, events) = observed(&gateway, prepared.into_request(), &registry).await;
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    assert_eq!(result.summary.model_requests_attempted, 2);
    assert_eq!(result.summary.model_requests_admitted, 2);
    assert_eq!(result.summary.new_tool_dispatches, 1);
    assert_eq!(result.summary.tool_results_prepared, 1);
    assert_eq!(result.last_response.as_ref().unwrap().text, "42");
    assert_eq!(count(&script.records.opens), 1);
    assert_eq!(count(&script.records.closes), 1);
    assert_eq!(count(&script.records.attempts), 2);
    assert!(script.steps.lock().unwrap().is_empty());
    let options = script.records.options.lock().unwrap();
    assert_eq!(options.len(), 1);
    assert_eq!(
        serde_json::to_value(&options[0]).unwrap(),
        serde_json::to_value(expected_options).unwrap()
    );
    let inputs = script.records.inputs.lock().unwrap();
    assert_eq!(inputs.len(), 2);
    assert_eq!(
        value(&inputs[0]),
        json!([{"kind":"user","text":expected_input}])
    );
    assert_eq!(
        value(&inputs[1]),
        json!([{"kind":"tool_result","call_id":"addition","output":"{\"sum\":42}"}])
    );
    let responses: Vec<_> = events
        .iter()
        .filter_map(|e| {
            assert_eq!(e.schema_version, 2);
            if let RunEvent::ProviderEvent { event } = &e.event {
                assert_eq!(event.schema_version, 1);
                assert_eq!(event.provider, ID);
                if let ProviderEvent::ResponseFinished { response } = &event.event {
                    return Some(response);
                }
            }
            None
        })
        .collect();
    assert_eq!(responses.len(), 2);
    assert_eq!(
        responses[0].native,
        json!({"independent_final_token": [9, "keep"]})
    );
    assert_eq!(
        responses[0].output[0].native,
        json!({"independent_instruction": [17,25]})
    );
    assert_eq!(responses[0].output[0].native_type, "opaque-invocation");
}
