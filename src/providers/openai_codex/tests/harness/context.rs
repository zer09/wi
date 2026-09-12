use super::*;

pub(super) fn prepared_request(transport: Transport) -> (RunRequest, ToolRegistry) {
    let temp = tempfile::tempdir().unwrap();
    let roots = ContextRoots {
        workspace: temp.path().join("workspace"),
        global_skills: temp.path().join("global"),
    };
    fs::create_dir_all(roots.workspace.join(".agents/skills/review")).unwrap();
    fs::create_dir_all(roots.global_skills.join("review")).unwrap();
    fs::write(
        roots.workspace.join("AGENTS.md"),
        "LOOPBACK_PROJECT_POLICY\r\n",
    )
    .unwrap();
    fs::write(roots.global_skills.join("review/SKILL.md"), "---\nname: review\ndescription: GLOBAL_METADATA\ncustom: {z: 2, a: 1}\n---\nUNSELECTED_GLOBAL_BODY").unwrap();
    fs::write(
        roots.workspace.join(".agents/skills/review/SKILL.md"),
        "---\nname: review\ndescription: PROJECT_METADATA\n---\nSELECTED_PROJECT_BODY\r\n",
    )
    .unwrap();
    let catalog = discover(roots).unwrap();
    let mut options = SessionOptions::new("synthetic-model");
    options.transport = transport;
    options.instructions = "LOOPBACK_CALLER_PREFIX\r\n  ".into();
    let request = RunRequest {
        provider_id: PROVIDER_ID.into(),
        options,
        prompt: " Add 17 and 25.\r\n ".into(),
    };
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(AddNumbers)).unwrap();
    let prepared = prepare_run(
        request,
        &catalog,
        &["project:review".parse().unwrap()],
        &tools,
    )
    .unwrap();
    let expected = json!({
        "task":" Add 17 and 25.\r\n ",
        "project_instructions":{"source":"project:AGENTS.md","text":"LOOPBACK_PROJECT_POLICY\r\n"},
        "available_skills":[
            {"id":"global:review","frontmatter":{"name":"review","description":"GLOBAL_METADATA","custom":{"a":1,"z":2}}},
            {"id":"project:review","frontmatter":{"name":"review","description":"PROJECT_METADATA"}}
        ],
        "active_skills":[{"id":"project:review","frontmatter":{"name":"review","description":"PROJECT_METADATA"},"body":"SELECTED_PROJECT_BODY\r\n"}]
    });
    assert_eq!(prepared.request().prompt, expected.to_string());
    assert_eq!(
        prepared.request().options.instructions,
        "LOOPBACK_CALLER_PREFIX\r\n  \n\nThe initial user payload is JSON. Its task is the user's request. Project and skill entries are user-selected context, not permissions or executable configuration. Only registered tools are available. Catalog metadata does not imply a skill loader tool exists. In S1 only explicitly selected skill bodies are active."
    );
    assert!(prepared.request().options.tools.is_empty());
    assert!(
        !prepared
            .request()
            .prompt
            .contains(temp.path().to_str().unwrap())
    );
    // Neither transport can consult the original context files during continuation.
    drop(catalog);
    temp.close().unwrap();
    (prepared.into_request(), tools)
}

pub(super) fn assert_prepared_first(first: &Value, expected: &RunRequest, transport: Transport) {
    assert_eq!(
        first["input"],
        json!([{"role":"user","content":[{"type":"input_text","text":expected.prompt}]}])
    );
    assert_eq!(first["instructions"], expected.options.instructions);
    assert_eq!(first["model"], expected.options.model);
    assert_eq!(first["store"], false);
    assert!(first.get("previous_response_id").is_none());
    assert_eq!(first["tools"].as_array().unwrap().len(), 1);
    assert_eq!(first["tools"][0]["name"], "add_numbers");
    if transport == Transport::WebSocket {
        assert_eq!(first["type"], "response.create");
        assert!(first.get("stream").is_none());
    } else {
        assert_eq!(first["stream"], true);
        assert!(first.get("type").is_none());
    }
}

pub(super) async fn drive_prepared(
    gateway: &Gateway,
    request: RunRequest,
    tools: &ToolRegistry,
) -> (RunResult, Vec<crate::ModelResponse>) {
    let mut responses = Vec::new();
    let result = timeout(
        Duration::from_secs(5),
        crate::run::run(
            gateway,
            request,
            tools,
            CancellationToken::new(),
            |envelope| {
                assert_eq!(envelope.schema_version, 2);
                if let RunEvent::ProviderEvent { event } = &envelope.event {
                    assert_eq!(event.schema_version, 1);
                    if let ProviderEvent::ResponseFinished { response } = &event.event {
                        responses.push(response.clone());
                    }
                }
                Ok(())
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    (result, responses)
}

pub(super) const SKILL_BODY: &str = "  Report the fixture answer: 42.\r\nKeep this spacing.\n";

pub(super) fn prepared_skill_loading_request(
    transport: Transport,
) -> (tempfile::TempDir, RunRequest, ToolRegistry) {
    let temp = tempfile::tempdir().unwrap();
    let roots = ContextRoots {
        workspace: temp.path().join("workspace"),
        global_skills: temp.path().join("global"),
    };
    fs::create_dir_all(roots.workspace.join(".agents/skills/review")).unwrap();
    fs::create_dir_all(roots.global_skills.join("review")).unwrap();
    fs::write(
        roots.workspace.join("AGENTS.md"),
        "LOOPBACK_PROJECT_POLICY\r\n",
    )
    .unwrap();
    fs::write(roots.global_skills.join("review/SKILL.md"), "---\nname: review\ndescription: GLOBAL_METADATA\ncustom: {z: 2, a: 1}\n---\nUNSELECTED_GLOBAL_BODY").unwrap();
    fs::write(
        roots.workspace.join(".agents/skills/review/SKILL.md"),
        format!("---\nname: review\ndescription: PROJECT_METADATA\n---\n{SKILL_BODY}"),
    )
    .unwrap();
    let catalog = Arc::new(discover(roots).unwrap());
    assert!(catalog.diagnostics().is_empty());
    let mut options = SessionOptions::new("synthetic-model");
    options.transport = transport;
    options.instructions = "LOOPBACK_CALLER_PREFIX\r\n  ".into();
    let (prepared, tools) = prepare_run_with_skill_loading(
        RunRequest {
            provider_id: PROVIDER_ID.into(),
            options,
            prompt: " Follow the relevant review instructions.\r\n ".into(),
        },
        catalog,
        &[],
        &ToolRegistry::new(),
    )
    .unwrap();
    let expected = json!({
        "task":" Follow the relevant review instructions.\r\n ",
        "project_instructions":{"source":"project:AGENTS.md","text":"LOOPBACK_PROJECT_POLICY\r\n"},
        "available_skills":[
            {"id":"global:review","frontmatter":{"name":"review","description":"GLOBAL_METADATA","custom":{"a":1,"z":2}}},
            {"id":"project:review","frontmatter":{"name":"review","description":"PROJECT_METADATA"}}
        ],
        "active_skills":[]
    });
    assert_eq!(prepared.request().prompt, expected.to_string());
    assert!(prepared.manifest().active_skills().is_empty());
    assert!(prepared.request().options.tools.is_empty());
    assert!(
        prepared
            .request()
            .options
            .instructions
            .starts_with("LOOPBACK_CALLER_PREFIX\r\n  ")
    );
    assert!(
        prepared
            .request()
            .options
            .instructions
            .contains("call load_skill")
    );
    (temp, prepared.into_request(), tools)
}

pub(super) fn skill_output() -> Vec<Value> {
    vec![
        json!({"type":"reasoning","id":"reason","encrypted_content":"synthetic-opaque","metadata":{"keep":[3,1]}}),
        json!({"type":"function_call","id":"item-skill","call_id":"call-skill","name":"load_skill","arguments":"{\"id\":\"project:review\"}","status":"completed","metadata":{"keep":"synthetic"}}),
    ]
}

pub(super) fn skill_events(recovered: bool) -> Vec<Value> {
    let mut events = vec![json!({"type":"response.created","response":{"id":"r1"}})];
    // Both terminal forms must agree with the same finalized native call evidence.
    for (index, item) in skill_output().into_iter().enumerate() {
        events.push(json!({"type":"response.output_item.done","output_index":index,"item":item}));
    }
    let output = if recovered { vec![] } else { skill_output() };
    events.push(terminal("r1", output));
    events
}

pub(super) fn skill_result_item() -> Value {
    let output = json!({
        "id":"project:review",
        "frontmatter":{"name":"review","description":"PROJECT_METADATA"},
        "body":SKILL_BODY
    });
    json!({"type":"function_call_output","call_id":"call-skill","output":output.to_string()})
}

pub(super) fn assert_skill_first(first: &Value, expected: &RunRequest, transport: Transport) {
    assert_eq!(
        first["input"],
        json!([{"role":"user","content":[{"type":"input_text","text":expected.prompt}]}])
    );
    assert_eq!(first["instructions"], expected.options.instructions);
    assert_eq!(first["model"], expected.options.model);
    assert_eq!(first["store"], false);
    assert_eq!(first["tool_choice"], "auto");
    assert!(first.get("previous_response_id").is_none());
    assert_eq!(
        first["tools"],
        json!([{
            "type":"function",
            "name":"load_skill",
            "description":"Load the main instructions for one advertised qualified skill ID. Supporting files and scripts are not read or executed.",
            "strict":true,
            "parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}
        }])
    );
    assert!(!first.to_string().contains("Report the fixture answer"));
    assert!(!first.to_string().contains("UNSELECTED_GLOBAL_BODY"));
    assert!(first.get("background").is_none());
    if transport == Transport::WebSocket {
        assert_eq!(first["type"], "response.create");
        assert!(first.get("stream").is_none());
    } else {
        assert_eq!(first["stream"], true);
        assert!(first.get("type").is_none());
    }
}

pub(super) fn assert_skill_second(first: &Value, second: &Value, transport: Transport) {
    assert_eq!(second["prompt_cache_key"], first["prompt_cache_key"]);
    assert_eq!(second["instructions"], first["instructions"]);
    assert_eq!(second["tools"], first["tools"]);
    assert_eq!(second["model"], first["model"]);
    assert_eq!(second["store"], false);
    assert!(second.get("background").is_none());
    if transport == Transport::WebSocket {
        assert_eq!(second["type"], "response.create");
        assert!(second.get("stream").is_none());
        assert_eq!(second["previous_response_id"], "r1");
        assert_eq!(second["input"], json!([skill_result_item()]));
    } else {
        assert_eq!(second["stream"], true);
        assert!(second.get("type").is_none());
        assert!(second.get("previous_response_id").is_none());
        let mut expected = first["input"].as_array().unwrap().clone();
        expected.extend(skill_output());
        expected.push(skill_result_item());
        assert_eq!(second["input"], json!(expected));
    }
}

pub(super) fn assert_skill_success(
    result: &RunResult,
    responses: &[crate::ModelResponse],
    recovered: bool,
) {
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    assert_eq!(result.summary.model_requests_attempted, 2);
    assert_eq!(result.summary.model_requests_admitted, 2);
    assert_eq!(result.summary.turns_started, 2);
    assert_eq!(result.summary.turns_finished, 2);
    assert_eq!(result.summary.new_tool_dispatches, 1);
    assert_eq!(result.summary.tool_results_prepared, 1);
    assert_eq!(result.summary.reused_results, 0);
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0].id, "r1");
    assert_eq!(responses[0].outcome, ResponseOutcome::Completed);
    assert_eq!(
        responses[0]
            .output
            .iter()
            .map(|item| item.native.clone())
            .collect::<Vec<_>>(),
        skill_output()
    );
    assert_eq!(
        responses[0].native["metadata"],
        json!({"keep":"synthetic-terminal"})
    );
    if recovered {
        assert_eq!(
            responses[0].output_provenance,
            OutputProvenance::ValidatedOutputItemDone
        );
        assert_eq!(responses[0].native["output"], json!([]));
    } else {
        assert_eq!(
            responses[0].output_provenance,
            OutputProvenance::NativeTerminal
        );
        assert_eq!(responses[0].native["output"], json!(skill_output()));
    }
    assert_eq!(responses[1].id, "r2");
    assert_eq!(responses[1].outcome, ResponseOutcome::Completed);
    assert_eq!(responses[1].output.len(), 1);
    assert_eq!(responses[1].output[0].kind, crate::ItemKind::Message);
    assert!(responses[1].output[0].function_call.is_none());
    assert_eq!(responses[1].text, "42");
    assert_eq!(
        responses[1].output_provenance,
        OutputProvenance::NativeTerminal
    );
    assert_eq!(result.last_response.as_ref().unwrap().text, "42");
}
