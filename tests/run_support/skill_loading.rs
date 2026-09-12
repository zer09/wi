use super::run_support::*;
use serde_json::{Value, json};
use std::{fs, sync::Arc};
use tokio_util::sync::CancellationToken;
use wi::{
    context::{
        ContextRoots, PreparedRun, SkillCatalog, SkillId, discover, prepare_run_with_skill_loading,
    },
    run::*,
    tools::{ToolExecutionEvent, ToolRegistry},
    *,
};

const GLOBAL_BODY: &str = "GLOBAL_MAIN_INSTRUCTIONS\n";
const WORKFLOW: &str = "Call add_numbers with a=17 and b=25. Return the sum.\r\n";

struct Fixture {
    temp: tempfile::TempDir,
    catalog: Arc<SkillCatalog>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let roots = ContextRoots {
            workspace: temp.path().join("workspace"),
            global_skills: temp.path().join("global"),
        };
        for (path, header, body) in [
            (
                roots.global_skills.join("review/SKILL.md"),
                "---\nname: review\ndescription: GLOBAL_METADATA\n---\n",
                GLOBAL_BODY,
            ),
            (
                roots.workspace.join(".agents/skills/review/SKILL.md"),
                "---\nname: review\ndescription: PROJECT_METADATA\ncustom: {z: 2, a: 1}\n---\n",
                WORKFLOW,
            ),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, format!("{header}{body}")).unwrap();
        }
        let catalog = Arc::new(discover(roots).unwrap());
        Self { temp, catalog }
    }

    fn prepare(&self, selected: &[SkillId], tools: &ToolRegistry) -> (PreparedRun, ToolRegistry) {
        let mut original = request();
        original.prompt = "TASK\r\n".into();
        original.options.instructions = "CALLER_PREFIX\n".into();
        prepare_run_with_skill_loading(original, self.catalog.clone(), selected, tools).unwrap()
    }
}

fn load_call(call_id: &str, id: &str) -> OutputItem {
    OutputItem {
        id: Some(format!("item-{call_id}")),
        kind: ItemKind::FunctionCall,
        native_type: "opaque-invocation".into(),
        function_call: Some(FunctionCall {
            call_id: call_id.into(),
            name: "load_skill".into(),
            arguments: json!({"id": id}).to_string(),
            origin: CallOrigin::Direct,
            namespace: None,
            complete: true,
        }),
        native: json!({"independent_instruction": id}),
    }
}

fn expected_load(id: &str) -> Value {
    if id == "global:review" {
        json!({
            "id": id,
            "frontmatter": {"name": "review", "description": "GLOBAL_METADATA"},
            "body": GLOBAL_BODY,
        })
    } else {
        assert_eq!(id, "project:review");
        json!({
            "id": id,
            "frontmatter": {"name": "review", "description": "PROJECT_METADATA", "custom": {"a": 1, "z": 2}},
            "body": WORKFLOW,
        })
    }
}

fn assert_initial(prepared: &PreparedRun, selected: &[SkillId]) {
    let request = prepared.request();
    let payload: Value = serde_json::from_str(&request.prompt).unwrap();
    assert_eq!(payload.as_object().unwrap().len(), 4);
    assert_eq!(payload["task"], "TASK\r\n");
    assert_eq!(payload["project_instructions"], Value::Null);
    assert_eq!(
        payload["available_skills"],
        json!([
            {"id": "global:review", "frontmatter": {"name": "review", "description": "GLOBAL_METADATA"}},
            {"id": "project:review", "frontmatter": {"name": "review", "description": "PROJECT_METADATA", "custom": {"a": 1, "z": 2}}},
        ])
    );
    let active: Vec<_> = selected
        .iter()
        .map(|id| expected_load(&id.to_string()))
        .collect();
    assert_eq!(payload["active_skills"], json!(active));
    assert_eq!(prepared.manifest().active_skills(), selected);
    assert!(request.options.tools.is_empty());
    assert!(request.options.instructions.starts_with("CALLER_PREFIX\n"));
    assert!(request.options.instructions.contains("call load_skill"));
    assert!(!request.options.instructions.contains(GLOBAL_BODY));
    assert!(!request.options.instructions.contains(WORKFLOW.trim()));
    if selected.is_empty() {
        assert!(!request.prompt.contains("GLOBAL_MAIN_INSTRUCTIONS"));
        assert!(!request.prompt.contains("Call add_numbers"));
    }
}

fn assert_completed_session(
    result: &RunResult,
    events: &[RunEventEnvelope],
    script: &Script,
    requests: u64,
) {
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    assert_eq!(result.summary.model_requests_attempted, requests);
    assert_eq!(result.summary.model_requests_admitted, requests);
    assert_eq!(result.summary.turns_started, requests);
    assert_eq!(result.summary.turns_finished, requests);
    assert_eq!(count(&script.records.opens), 1);
    assert_eq!(count(&script.records.closes), 1);
    assert_eq!(count(&script.records.attempts), requests as usize);
    assert_eq!(count(&script.records.receipts), requests as usize);
    assert_eq!(
        script.records.inputs.lock().unwrap().len(),
        requests as usize
    );
    assert_eq!(trace(events).first(), Some(&"run_started"));
    assert_eq!(trace(events).last(), Some(&"run_finished"));
    for (i, event) in events.iter().enumerate() {
        assert_eq!(event.schema_version, 2);
        assert_eq!(event.sequence, i as u64 + 1);
        assert_eq!(event.run_id, result.run_id);
        if i > 0 {
            assert_eq!(event.session_id.as_deref(), Some("s1"));
        }
        if let RunEvent::ProviderEvent { event: nested } = &event.event {
            assert_eq!(nested.schema_version, 1);
            assert_eq!(nested.provider, ID);
            assert_eq!(nested.session_id, "s1");
            assert_eq!(event.request_id, nested.request_id);
        }
    }
}

fn tool_trace(events: &[RunEventEnvelope]) -> Vec<Value> {
    events
        .iter()
        .filter_map(|envelope| {
            if let RunEvent::ToolEvent { event } = &envelope.event {
                Some(json!({"request_id": envelope.request_id, "event": event}))
            } else {
                None
            }
        })
        .collect()
}

#[tokio::test]
async fn skill_loading_public_run_delivers_real_body_with_explicit_selections_or_without() {
    for selected in [vec![], vec!["global:review"], vec!["project:review"]] {
        let f = Fixture::new();
        let selected: Vec<SkillId> = selected.iter().map(|id| id.parse().unwrap()).collect();
        let (prepared, registry) = f.prepare(&selected, &ToolRegistry::new());
        assert_initial(&prepared, &selected);
        let initial_input = prepared.request().prompt.clone();
        let mut expected_options = prepared.request().options.clone();
        expected_options.tools = registry.definitions();
        assert_eq!(expected_options.tools.len(), 1);
        let loader = &expected_options.tools[0];
        assert_eq!(loader.name, "load_skill");
        assert!(loader.strict);
        assert_eq!(
            loader.parameters,
            json!({
                "type": "object", "properties": {"id": {"type": "string"}},
                "required": ["id"], "additionalProperties": false,
            })
        );
        let script = Arc::new(Script::new(vec![
            Step::Response(response(
                "load-response",
                vec![load_call("load-main", "project:review")],
                "",
            )),
            Step::Response(response("final", vec![], "fixture complete")),
        ]));
        let mut gateway = Gateway::new();
        gateway.register(script.clone()).unwrap();
        let (result, events) = observed(&gateway, prepared.request().clone(), &registry).await;
        assert_completed_session(&result, &events, &script, 2);
        assert_eq!(result.summary.new_tool_dispatches, 1);
        assert_eq!(result.summary.tool_results_prepared, 1);
        assert_eq!(result.summary.reused_results, 0);
        assert_eq!(
            result.last_response.as_ref().unwrap().text,
            "fixture complete"
        );
        // The manifest describes initial bodies, not later model-selected delivery.
        assert_eq!(prepared.manifest().active_skills(), selected);
        let options = script.records.options.lock().unwrap();
        assert_eq!(options.len(), 1);
        assert_eq!(
            serde_json::to_value(&options[0]).unwrap(),
            serde_json::to_value(expected_options).unwrap()
        );
        let inputs = script.records.inputs.lock().unwrap();
        assert_eq!(value(&inputs[0]), value(&[InputItem::user(initial_input)]));
        assert_eq!(
            value(&inputs[1]),
            json!([
                {"kind": "tool_result", "call_id": "load-main", "output": expected_load("project:review").to_string()},
            ])
        );
        assert_eq!(
            tool_trace(&events),
            vec![
                json!({"request_id": "q1", "event": {"type": "tool_execution_started", "call_id": "load-main", "tool_name": "load_skill"}}),
                json!({"request_id": "q1", "event": {"type": "tool_execution_finished", "call_id": "load-main", "tool_name": "load_skill", "is_error": false}}),
            ]
        );
    }
}

#[tokio::test]
async fn skill_loading_public_run_loads_workflow_then_adds_in_three_requests() {
    let f = Fixture::new();
    let (gateway, script, template) = setup(vec![
        Step::Response(response(
            "workflow",
            vec![load_call("load-workflow", "project:review")],
            "",
        )),
        Step::Response(response("addition", vec![call("add-result", 17, 25)], "")),
        Step::Response(response("final", vec![], "42")),
    ]);
    let (prepared, registry) = f.prepare(&[], &template);
    assert_initial(&prepared, &[]);
    let initial_input = prepared.request().prompt.clone();
    let mut expected_options = prepared.request().options.clone();
    expected_options.tools = registry.definitions();
    let names: Vec<_> = expected_options
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect();
    assert_eq!(names, ["add_numbers", "load_skill"]);
    let (result, events) = observed(&gateway, prepared.into_request(), &registry).await;
    assert_completed_session(&result, &events, &script, 3);
    assert_eq!(result.summary.new_tool_dispatches, 2);
    assert_eq!(result.summary.tool_results_prepared, 2);
    assert_eq!(result.summary.reused_results, 0);
    assert_eq!(count(&script.records.tool_calls), 1);
    assert_eq!(result.last_response.as_ref().unwrap().text, "42");
    let options = script.records.options.lock().unwrap();
    assert_eq!(options.len(), 1);
    assert_eq!(
        serde_json::to_value(&options[0]).unwrap(),
        serde_json::to_value(expected_options).unwrap()
    );
    let inputs = script.records.inputs.lock().unwrap();
    assert_eq!(value(&inputs[0]), value(&[InputItem::user(initial_input)]));
    assert_eq!(
        value(&inputs[1]),
        json!([
            {"kind": "tool_result", "call_id": "load-workflow", "output": expected_load("project:review").to_string()},
        ])
    );
    assert_eq!(
        value(&inputs[2]),
        json!([
            {"kind": "tool_result", "call_id": "add-result", "output": "{\"sum\":42}"},
        ])
    );
    assert_eq!(
        tool_trace(&events),
        vec![
            json!({"request_id": "q1", "event": {"type": "tool_execution_started", "call_id": "load-workflow", "tool_name": "load_skill"}}),
            json!({"request_id": "q1", "event": {"type": "tool_execution_finished", "call_id": "load-workflow", "tool_name": "load_skill", "is_error": false}}),
            json!({"request_id": "q2", "event": {"type": "tool_execution_started", "call_id": "add-result", "tool_name": "add_numbers"}}),
            json!({"request_id": "q2", "event": {"type": "tool_execution_finished", "call_id": "add-result", "tool_name": "add_numbers", "is_error": false}}),
        ]
    );
}

#[tokio::test]
async fn skill_loading_public_run_can_complete_without_loading() {
    let f = Fixture::new();
    let (gateway, script, template) = setup(vec![Step::Response(response(
        "final",
        vec![],
        "no skill needed",
    ))]);
    let (prepared, registry) = f.prepare(&[], &template);
    assert_initial(&prepared, &[]);
    let initial_input = prepared.request().prompt.clone();
    fs::remove_file(f.temp.path().join("global/review/SKILL.md")).unwrap();
    fs::remove_file(
        f.temp
            .path()
            .join("workspace/.agents/skills/review/SKILL.md"),
    )
    .unwrap();
    let (result, events) = observed(&gateway, prepared.into_request(), &registry).await;
    assert_completed_session(&result, &events, &script, 1);
    assert_eq!(result.summary.new_tool_dispatches, 0);
    assert_eq!(result.summary.tool_results_prepared, 0);
    assert_eq!(count(&script.records.tool_calls), 0);
    assert_eq!(
        result.last_response.as_ref().unwrap().text,
        "no skill needed"
    );
    assert!(tool_trace(&events).is_empty());
    assert_eq!(
        value(&script.records.inputs.lock().unwrap()[0]),
        value(&[InputItem::user(initial_input)])
    );
    assert_eq!(
        script.records.options.lock().unwrap()[0].tools[1].name,
        "load_skill"
    );
}

#[tokio::test]
async fn skill_loading_public_run_cancels_before_dispatch_or_before_later_call() {
    for boundary in ["before", "start", "finish"] {
        let f = Fixture::new();
        let (gateway, script, template) = setup(vec![Step::Response(response(
            "batch",
            vec![
                load_call("load-main", "project:review"),
                call("later", 17, 25),
            ],
            "",
        ))]);
        let (prepared, registry) = f.prepare(&[], &template);
        let token = CancellationToken::new();
        let mut events = Vec::new();
        let result = run(
            &gateway,
            prepared.into_request(),
            &registry,
            token.clone(),
            |event| {
                let matched = match &event.event {
                    RunEvent::ProviderEvent { event } => {
                        boundary == "before"
                            && matches!(event.event, ProviderEvent::ResponseFinished { .. })
                    }
                    RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolExecutionStarted { .. },
                    } => boundary == "start",
                    RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolExecutionFinished { .. },
                    } => boundary == "finish",
                    _ => false,
                };
                if matched {
                    token.cancel();
                }
                events.push(event.clone());
                Ok(())
            },
        )
        .await
        .unwrap();
        assert!(token.is_cancelled());
        assert_eq!(result.outcome, RunOutcome::CancelledLocally);
        assert!(result.events_complete);
        assert_eq!(result.sink_error, None);
        assert_eq!(result.summary.model_requests_attempted, 1);
        assert_eq!(result.summary.model_requests_admitted, 1);
        assert_eq!(
            result.summary.new_tool_dispatches,
            u64::from(boundary != "before")
        );
        assert_eq!(
            result.summary.tool_results_prepared,
            u64::from(boundary == "finish")
        );
        assert_eq!(result.summary.reused_results, 0);
        assert_eq!(result.summary.turns_started, 1);
        assert_eq!(result.summary.turns_finished, 1);
        assert_eq!(
            result.summary.last_upstream_outcome,
            Some(UpstreamOutcome::TerminalReceived)
        );
        assert_eq!(count(&script.records.opens), 1);
        assert_eq!(count(&script.records.closes), 1);
        assert_eq!(count(&script.records.attempts), 1);
        assert_eq!(count(&script.records.tool_calls), 0);
        assert_eq!(script.records.inputs.lock().unwrap().len(), 1);
        let mut expected = Vec::new();
        if boundary != "before" {
            expected.push(json!({"request_id": "q1", "event": {"type": "tool_execution_started", "call_id": "load-main", "tool_name": "load_skill"}}));
        }
        if boundary == "finish" {
            expected.push(json!({"request_id": "q1", "event": {"type": "tool_execution_finished", "call_id": "load-main", "tool_name": "load_skill", "is_error": false}}));
        }
        assert_eq!(tool_trace(&events), expected);
        assert_eq!(
            &trace(&events)[events.len() - 2..],
            ["turn_finished", "run_finished"]
        );
        assert!(matches!(
            &events[events.len() - 2].event,
            RunEvent::TurnFinished {
                outcome: TurnOutcome::Stopped {
                    reason: RunOutcome::CancelledLocally
                },
                ..
            }
        ));
        assert!(matches!(
            &events.last().unwrap().event,
            RunEvent::RunFinished {
                outcome: RunOutcome::CancelledLocally,
                ..
            }
        ));
    }
}

#[tokio::test]
async fn skill_loading_public_run_observer_failure_stops_later_work_and_delivery() {
    for at_finish in [false, true] {
        for error in [
            RunSinkError::Full,
            RunSinkError::Closed,
            RunSinkError::Failed,
        ] {
            let f = Fixture::new();
            let (gateway, script, template) = setup(vec![Step::Response(response(
                "batch",
                vec![
                    load_call("load-main", "project:review"),
                    call("later", 17, 25),
                ],
                "",
            ))]);
            let (prepared, registry) = f.prepare(&[], &template);
            let mut failed = false;
            let mut events = Vec::new();
            let result = run(
                &gateway,
                prepared.into_request(),
                &registry,
                CancellationToken::new(),
                |event| {
                    assert!(!failed, "observer called after failure");
                    events.push(event.clone());
                    if let RunEvent::ToolEvent { event } = &event.event {
                        let finished =
                            matches!(event, ToolExecutionEvent::ToolExecutionFinished { .. });
                        if finished == at_finish {
                            failed = true;
                            return Err(error);
                        }
                    }
                    Ok(())
                },
            )
            .await
            .unwrap();
            assert!(failed);
            failed_as(&result, "event_sink");
            assert!(!result.events_complete);
            assert_eq!(result.sink_error, Some(error));
            assert_eq!(result.summary.new_tool_dispatches, 1);
            // A failed finish observer prevents delivery, not the earlier cache insertion.
            // Increment-1 registry tests inspect that cache; run owns its own fresh scope.
            assert_eq!(result.summary.tool_results_prepared, 0);
            assert_eq!(result.summary.reused_results, 0);
            assert_eq!(result.summary.model_requests_attempted, 1);
            assert_eq!(result.summary.model_requests_admitted, 1);
            assert_eq!(result.summary.turns_started, 1);
            assert_eq!(result.summary.turns_finished, 0);
            assert_eq!(count(&script.records.opens), 1);
            assert_eq!(count(&script.records.closes), 1);
            assert_eq!(count(&script.records.attempts), 1);
            assert_eq!(count(&script.records.tool_calls), 0);
            assert_eq!(script.records.inputs.lock().unwrap().len(), 1);
            let mut expected = vec![
                json!({"request_id": "q1", "event": {"type": "tool_execution_started", "call_id": "load-main", "tool_name": "load_skill"}}),
            ];
            if at_finish {
                expected.push(json!({"request_id": "q1", "event": {"type": "tool_execution_finished", "call_id": "load-main", "tool_name": "load_skill", "is_error": false}}));
            }
            assert_eq!(tool_trace(&events), expected);
            assert_eq!(trace(&events).last(), Some(&"tool_event"));
        }
    }
}
