use super::*;
use wi::{GatewayError, context::prepare_run_with_skill_loading};

#[tokio::test]
async fn registered_definition_and_lazy_success_are_exact_and_correlated() {
    let f = Fixture::new();
    let body = " \r\n# Main\r\n\tπ \"quoted\" \\ text\n  ";
    f.skill(
        Scope::Global,
        "review",
        "name: review\ndescription: Metadata\ncustom: {z: [two, one], a: {z: 3, a: 1}}",
        body,
    );
    let (prepared, mut registry) =
        prepare_run_with_skill_loading(request(), f.catalog(), &[], &tools()).unwrap();
    assert!(!prepared.request().prompt.contains("# Main"));
    let definition = registry
        .definitions()
        .into_iter()
        .find(|d| d.name == "load_skill")
        .unwrap();
    definition.validate().unwrap();
    assert_eq!(
        serde_json::to_value(definition).unwrap(),
        json!({
            "name":"load_skill", "strict":true,
            "description":"Load the main instructions for one advertised qualified skill ID. Supporting files and scripts are not read or executed.",
            "parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}
        })
    );
    let (output, events) = execute(&mut registry, "load-1", "global:review").await;
    let expected = json!({"id":"global:review", "frontmatter":{
        "name":"review","description":"Metadata","custom":{"z":["two","one"],"a":{"z":3,"a":1}}
    },"body":body});
    assert_eq!(serde_json::from_str::<Value>(&output).unwrap(), expected);
    assert_eq!(output, expected.to_string());
    assert!(output.contains("\"a\":{\"a\":1,\"z\":3},\"z\":[\"two\",\"one\"]"));
    assert_eq!(events, finished_events("load-1", false));
}

#[tokio::test]
async fn invalid_load_or_unsupported_authority_rejects_whole_batch_without_execution() {
    let f = Fixture::new();
    let file = f.skill(
        Scope::Global,
        "review",
        "name: review\ndescription: Metadata",
        "BODY",
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let mut template = ToolRegistry::new();
    template
        .register(Arc::new(RecordingTool {
            name: "add_numbers".into(),
            calls: calls.clone(),
        }))
        .unwrap();
    let (_, mut registry) =
        prepare_run_with_skill_loading(request(), f.catalog(), &[], &template).unwrap();
    fs::remove_file(file).unwrap();
    for arguments in [
        Value::Null,
        json!({}),
        json!({"id":null}),
        json!({"id":1}),
        json!({"id":[]}),
        json!({"id":"global:review","path":"SKILL.md"}),
        json!({"id":"review"}),
        json!({"id":"global:unknown"}),
        json!({"id":"project:review"}),
        json!({"id":"global:../review"}),
        json!({"id":"https://example.invalid/review"}),
    ] {
        let batch = response(&[
            ("first", "add_numbers", json!({"a":2,"b":3})),
            ("load", "load_skill", arguments),
        ]);
        let error = registry
            .execute_response(&batch, |_| panic!("preflight must emit nothing"))
            .await
            .unwrap_err();
        assert!(matches!(error, GatewayError::InvalidToolArguments));
    }
    let valid = response(&[
        ("first", "add_numbers", json!({"a":2,"b":3})),
        ("load", "load_skill", json!({"id":"global:review"})),
    ]);
    for mode in [
        "origin",
        "namespace",
        "native-namespace",
        "incomplete-call",
        "incomplete-response",
        "duplicate",
        "unknown-output",
        "unknown-tool",
    ] {
        let mut batch = valid.clone();
        let item = &mut batch.output[1];
        let call = item.function_call.as_mut().unwrap();
        match mode {
            "origin" => call.origin = CallOrigin::Programmatic,
            "namespace" => call.namespace = Some("namespace".into()),
            "native-namespace" => item.native = json!({"namespace":42}),
            "incomplete-call" => call.complete = false,
            "incomplete-response" => batch.outcome = ResponseOutcome::Incomplete { reason: None },
            "duplicate" => call.call_id = "first".into(),
            "unknown-output" => item.kind = ItemKind::Unknown,
            "unknown-tool" => call.name = "not_registered".into(),
            _ => unreachable!(),
        }
        assert!(
            registry
                .execute_response(&batch, |_| panic!("preflight must emit nothing"))
                .await
                .is_err()
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let mut events = Vec::new();
    let result = registry
        .execute_response(&valid, |event| {
            events.push(serde_json::to_value(event).unwrap())
        })
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(events.len(), 4);
    assert!(events.iter().all(|e| e["type"] != "tool_result_reused"));
    let InputItem::ToolResult { call_id, output } = &result[1] else {
        panic!()
    };
    assert_eq!(call_id, "load");
    assert_eq!(
        serde_json::from_str::<Value>(output).unwrap(),
        json!({"error":{"code":"gateway_error"}})
    );
    assert_eq!(&events[2..], finished_events("load", true));
}

#[tokio::test]
async fn new_calls_reread_bodies_cached_calls_reuse_and_fresh_scopes_stay_independent() {
    let f = Fixture::new();
    let yaml = "name: review\ndescription: Metadata";
    let file = f.skill(Scope::Project, "review", yaml, "FIRST");
    f.skill(Scope::Global, "review", yaml, "OTHER_SCOPE");
    let catalog = f.catalog();
    let (_, mut template) =
        prepare_run_with_skill_loading(request(), catalog.clone(), &[], &tools()).unwrap();
    let (first, _) = execute(&mut template, "same", "project:review").await;
    f.skill(Scope::Project, "review", yaml, "SECOND");
    let (reused, events) = execute(&mut template, "same", "project:review").await;
    assert_eq!(reused, first);
    assert_eq!(
        events,
        vec![json!({"type":"tool_result_reused","call_id":"same","tool_name":"load_skill"})]
    );
    let (second, events) = execute(&mut template, "new", "project:review").await;
    assert_eq!(
        serde_json::from_str::<Value>(&second).unwrap()["body"],
        "SECOND"
    );
    assert_eq!(events, finished_events("new", false));
    fs::remove_file(&file).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&first).unwrap()["body"],
        "FIRST"
    );
    assert_eq!(
        execute(&mut template, "same", "project:review").await.0,
        first
    );

    // The helper cannot carry the template's cache into a new scope.
    // A nonempty catalog would collide with the existing built-in registration.
    let empty = Fixture::new();
    let (_, mut fresh) =
        prepare_run_with_skill_loading(request(), empty.catalog(), &[], &template).unwrap();
    let (failed, events) = execute(&mut fresh, "same", "project:review").await;
    assert_eq!(
        serde_json::from_str::<Value>(&failed).unwrap(),
        json!({"error":{"code":"gateway_error"}})
    );
    assert_eq!(events, finished_events("same", true));
    f.skill(Scope::Project, "review", yaml, "THIRD");
    let (saved_error, events) = execute(&mut fresh, "same", "project:review").await;
    assert_eq!(saved_error, failed);
    assert_eq!(events[0]["type"], "tool_result_reused");
    assert_eq!(events.len(), 1);
    assert!(events[0].get("is_error").is_none());
    let mut another = template.fresh_scope();
    let (third, events) = execute(&mut another, "same", "project:review").await;
    assert_eq!(
        serde_json::from_str::<Value>(&third).unwrap()["body"],
        "THIRD"
    );
    assert_eq!(events, finished_events("same", false));
    assert_eq!(
        execute(&mut template, "same", "project:review").await.0,
        first
    );

    for (name, arguments) in [
        ("add_numbers", json!({"a":1,"b":2})),
        ("load_skill", json!({"id":"global:review"})),
    ] {
        let conflict = response(&[("same", name, arguments)]);
        assert!(matches!(
            template.execute_response(&conflict, |_| panic!()).await,
            Err(GatewayError::Protocol(_))
        ));
    }
    f.skill(
        Scope::Project,
        "new-entry",
        "name: new-entry\ndescription: Later",
        "UNAVAILABLE",
    );
    let unknown = response(&[("added", "load_skill", json!({"id":"project:new-entry"}))]);
    assert!(matches!(
        template.execute_response(&unknown, |_| panic!()).await,
        Err(GatewayError::InvalidToolArguments)
    ));
}

#[tokio::test]
async fn helper_retains_ordinary_definitions_without_sharing_template_results() {
    let f = Fixture::new();
    f.skill(
        Scope::Global,
        "review",
        "name: review\ndescription: Metadata",
        "BODY",
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let mut template = ToolRegistry::new();
    template
        .register(Arc::new(RecordingTool {
            name: "add_numbers".into(),
            calls: calls.clone(),
        }))
        .unwrap();
    let batch = response(&[("ordinary", "add_numbers", json!({"a":2,"b":3}))]);
    template.execute_response(&batch, |_| {}).await.unwrap();
    let (_, mut registry) =
        prepare_run_with_skill_loading(request(), f.catalog(), &[], &template).unwrap();
    registry
        .execute_response(&batch, |event| {
            assert!(!matches!(
                event,
                wi::tools::ToolExecutionEvent::ToolResultReused { .. }
            ))
        })
        .await
        .unwrap();
    template
        .execute_response(&batch, |event| {
            assert!(matches!(
                event,
                wi::tools::ToolExecutionEvent::ToolResultReused { .. }
            ))
        })
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(template.definitions().len(), 1);
}
