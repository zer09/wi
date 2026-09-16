use super::*;
use crate::storage::test_hooks::{Action, Pause, Point};

fn input_with(
    rig: &Rig,
    request: RunRequest,
    definitions: Vec<ToolDefinition>,
) -> RecordedRunInput {
    RecordedRunInput::new(
        rig.input.user_text().into(),
        request,
        definitions,
        vec![],
        vec![],
        None,
    )
    .unwrap()
}

async fn no_acceptance(rig: &Rig) {
    assert_eq!(rig.session.manifest().await.unwrap().head_sequence(), 1);
    assert!(
        rig.session
            .lookup_receipt(rig.operation_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        rig.session
            .run_record(rig.run_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(count(&rig.script.records.opens), 0);
    assert_eq!(count(&rig.script.records.calls), 0);
}

#[tokio::test]
async fn registry_mismatch_checks_all_fields_and_array_order_before_acceptance() {
    let rig = Rig::new(vec![], ToolMode::Add).await;
    for field in ["name", "description", "strict", "parameters"] {
        let mut definitions = rig.tools.definitions();
        let definition = &mut definitions[0];
        match field {
            "name" => definition.name = "other".into(),
            "description" => definition.description = "sensitive description canary".into(),
            "strict" => definition.strict = false,
            "parameters" => definition.parameters["additionalProperties"] = json!(true),
            _ => unreachable!(),
        }
        let mut request = rig.request();
        request.input = input_with(&rig, rig.input.prepared_request().clone(), definitions);
        let failure = run_persisted(
            &rig.gateway,
            &rig.session,
            request,
            &rig.tools,
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(failure.stage(), PersistentRunStage::Preflight);
        assert!(matches!(
            failure.cause(),
            PersistentRunCause::Gateway(GatewayError::InvalidRequest(
                "recorded tool definitions do not match registry"
            ))
        ));
        assert!(failure.operation_id().is_none());
        assert!(failure.acceptance().is_none());
        assert!(failure.observed_result().is_none());
        assert_eq!(format!("{failure:?}"), "persistent run preflight: gateway");
        assert_eq!(failure.to_string(), "persistent run preflight: gateway");
        no_acceptance(&rig).await;
    }
    struct DefinitionOnly(ToolDefinition);
    #[async_trait]
    impl Tool for DefinitionOnly {
        fn definition(&self) -> ToolDefinition {
            self.0.clone()
        }
        fn validate(&self, _: &Value) -> crate::Result<()> {
            panic!("preflight must not dispatch")
        }
        async fn execute(&self, _: Value) -> crate::Result<Value> {
            panic!("must not execute")
        }
    }
    let mut registry = ToolRegistry::new();
    for name in ["first", "second"] {
        let mut definition = add_numbers_definition();
        definition.name = name.into();
        registry
            .register(Arc::new(DefinitionOnly(definition)))
            .unwrap();
    }
    let mut definitions = registry.definitions();
    definitions.reverse();
    let mut request = rig.request();
    request.input = input_with(&rig, rig.input.prepared_request().clone(), definitions);
    let failure = run_persisted(
        &rig.gateway,
        &rig.session,
        request,
        &registry,
        CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert!(matches!(
        failure.cause(),
        PersistentRunCause::Gateway(GatewayError::InvalidRequest(
            "recorded tool definitions do not match registry"
        ))
    ));
    no_acceptance(&rig).await;
    assert_eq!(count(&rig.script.records.capabilities), 0);
    rig.close().await;
}

#[tokio::test]
async fn shared_admission_and_snapshot_validation_leave_no_acceptance_or_work() {
    let rig = Rig::new(vec![], ToolMode::Add).await;
    // Invalid input/options cannot be represented by RecordedRunInput, even via deserialization.
    for field in ["empty", "large", "model", "instructions", "caller_tools"] {
        let mut input = value(&rig.input);
        match field {
            "empty" => input["prepared_request"]["prompt"] = json!(" \n"),
            "large" => input["prepared_request"]["prompt"] = json!("x".repeat(1024 * 1024)),
            "model" => input["prepared_request"]["options"]["model"] = json!(""),
            "instructions" => input["prepared_request"]["options"]["instructions"] = json!(""),
            "caller_tools" => {
                input["prepared_request"]["options"]["tools"] = value(&rig.tools.definitions())
            }
            _ => unreachable!(),
        }
        assert!(serde_json::from_value::<RecordedRunInput>(input).is_err());
        no_acceptance(&rig).await;
    }
    for case in [
        "unknown",
        "feature",
        "websocket",
        "sse",
        "tools",
        "continuation",
        "cancel",
    ] {
        let mut prepared = rig.input.prepared_request().clone();
        let mut caps = capabilities();
        let cancel = CancellationToken::new();
        match case {
            "unknown" => prepared.provider_id = "sensitive unregistered canary".into(),
            "feature" => prepared.options.required_features = vec![Feature::AsyncTools],
            "websocket" => caps.websocket.implemented = false,
            "sse" => {
                prepared.options.transport = Transport::Sse;
                caps.sse.implemented = false;
            }
            "tools" => caps.function_tools.implemented = false,
            "continuation" => caps.continuation.implemented = false,
            "cancel" => cancel.cancel(),
            _ => unreachable!(),
        }
        *rig.script.capabilities.lock().unwrap() = caps;
        let mut request = rig.request();
        request.input = input_with(&rig, prepared, rig.tools.definitions());
        let failure = run_persisted(&rig.gateway, &rig.session, request, &rig.tools, cancel)
            .await
            .unwrap_err();
        assert_eq!(failure.stage(), PersistentRunStage::Preflight);
        let PersistentRunCause::Gateway(error) = failure.cause() else {
            panic!("gateway cause")
        };
        match case {
            "unknown" => assert!(matches!(error, GatewayError::UnknownProvider)),
            "cancel" => assert!(matches!(
                error,
                GatewayError::InvalidRequest("run pre-cancelled")
            )),
            _ => assert!(matches!(error, GatewayError::UnsupportedFeature(_))),
        }
        assert!(failure.acceptance().is_none());
        assert!(failure.observed_result().is_none());
        no_acceptance(&rig).await;
    }
    rig.close().await;
}

async fn duplicate_without_current_admission(
    rig: &Rig,
    session: &SessionHandle,
    expected: &CommitResult,
    state: RecordedRunState,
) {
    let cancel = CancellationToken::new();
    cancel.cancel();
    let head = session.manifest().await.unwrap().head_sequence();
    let PersistentRunResult::Duplicate { acceptance, run } = run_persisted(
        &Gateway::new(),
        session,
        rig.request(),
        &ToolRegistry::new(),
        cancel,
    )
    .await
    .unwrap() else {
        panic!("duplicate required")
    };
    assert!(acceptance.duplicate());
    assert_eq!(acceptance.receipt(), expected.receipt());
    assert_eq!(run.run_id(), &rig.run_id);
    assert_eq!(run.state(), state);
    assert_eq!(value(run.input()), value(&rig.input));
    assert_eq!(session.manifest().await.unwrap().head_sequence(), head);
}

#[tokio::test]
async fn receipt_first_unstarted_duplicate_conflicts_and_restart_never_start_work() {
    let rig = Rig::new(vec![], ToolMode::Add).await;
    let accepted = rig
        .session
        .accept_run(
            rig.operation_id.clone(),
            rig.run_id.clone(),
            rig.input.clone(),
        )
        .await
        .unwrap();
    duplicate_without_current_admission(&rig, &rig.session, &accepted, RecordedRunState::Accepted)
        .await;
    for conflict in ["run", "input", "method"] {
        let mut request = rig.request();
        match conflict {
            "run" => request.run_id = RunId::new(),
            "input" => {
                let mut prepared = rig.input.prepared_request().clone();
                prepared.prompt = "different sensitive canary".into();
                request.input = input_with(&rig, prepared, rig.tools.definitions());
            }
            "method" => {
                request.operation_id = OperationId::new();
                rig.session
                    .rename(request.operation_id.clone(), "rename canary".into())
                    .await
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let operation_id = request.operation_id.clone();
        let failure = run_persisted(
            &Gateway::new(),
            &rig.session,
            request,
            &ToolRegistry::new(),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(failure.stage(), PersistentRunStage::Acceptance);
        assert_eq!(failure.operation_id(), Some(&operation_id));
        assert!(
            matches!(failure.cause(), PersistentRunCause::Storage(error) if error.code() == "storage.command_conflict")
        );
        assert!(failure.acceptance().is_none());
        assert_eq!(format!("{failure:?}"), "persistent run acceptance: storage");
    }
    rig.store.close().await.unwrap();
    let reopened = SessionStore::open(rig.temp.path().join("root"))
        .await
        .unwrap();
    let session = reopened
        .open_session(rig.session.session_id().clone())
        .await
        .unwrap();
    duplicate_without_current_admission(&rig, &session, &accepted, RecordedRunState::Interrupted)
        .await;
    assert_eq!(count(&rig.script.records.opens), 0);
    assert_eq!(count(&rig.script.records.calls), 0);
    assert_eq!(count(&rig.script.records.capabilities), 0);
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn receipt_first_duplicate_during_and_after_real_execution_and_active_run_guard() {
    let before = Arc::new(Barrier::default());
    let after = Arc::new(Barrier::default());
    let rig = Rig::new(
        vec![Step::Partial {
            response: response("r1", vec![], "final"),
            before: before.clone(),
            after: after.clone(),
        }],
        ToolMode::Add,
    )
    .await;
    let task = rig.start(CancellationToken::new());
    before.reached.notified().await;
    let accepted = rig
        .session
        .accept_run(
            rig.operation_id.clone(),
            rig.run_id.clone(),
            rig.input.clone(),
        )
        .await
        .unwrap();
    duplicate_without_current_admission(&rig, &rig.session, &accepted, RecordedRunState::Running)
        .await;
    let mut other = rig.request();
    other.operation_id = OperationId::new();
    other.run_id = RunId::new();
    let failure = run_persisted(
        &rig.gateway,
        &rig.session,
        other,
        &rig.tools,
        CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(failure.stage(), PersistentRunStage::Acceptance);
    assert!(
        matches!(failure.cause(), PersistentRunCause::Storage(error) if error.code() == "storage.active_run_exists")
    );
    before.release.notify_one();
    after.reached.notified().await;
    after.release.notify_one();
    let (_, _, result) = executed(task.await.unwrap().unwrap());
    assert_eq!(result.outcome, RunOutcome::Completed);
    duplicate_without_current_admission(&rig, &rig.session, &accepted, RecordedRunState::Completed)
        .await;
    rig.store.close().await.unwrap();
    let reopened = SessionStore::open(rig.temp.path().join("root"))
        .await
        .unwrap();
    let session = reopened
        .open_session(rig.session.session_id().clone())
        .await
        .unwrap();
    duplicate_without_current_admission(&rig, &session, &accepted, RecordedRunState::Completed)
        .await;
    assert_eq!(count(&rig.script.records.opens), 1);
    assert_eq!(count(&rig.script.records.closes), 1);
    assert_eq!(rig.script.records.inputs.lock().unwrap().len(), 1);
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn identical_callers_with_both_lookups_absent_execute_exactly_once() {
    let rig = Rig::new(
        vec![
            Step::Response(response("r1", vec![call("one", 17, 25)], "")),
            Step::Response(response("final", vec![], "42")),
        ],
        ToolMode::Add,
    )
    .await;
    let hooks = rig.session.test_hooks();
    let first = Arc::new(Pause::default());
    hooks.arm(Point::ReceiptLookupComplete, Action::Pause(first.clone()));
    let one = rig.start(CancellationToken::new());
    first.reached.notified().await;
    let second = Arc::new(Pause::default());
    hooks.arm(Point::ReceiptLookupComplete, Action::Pause(second.clone()));
    let two = rig.start(CancellationToken::new());
    second.reached.notified().await;
    assert_eq!(rig.session.manifest().await.unwrap().head_sequence(), 1);
    assert_eq!(count(&rig.script.records.opens), 0);
    first.release.notify_one();
    second.release.notify_one();
    let results = [one.await.unwrap().unwrap(), two.await.unwrap().unwrap()];
    let mut original = None;
    let mut duplicate = None;
    for result in results {
        match result {
            PersistentRunResult::Executed {
                acceptance, result, ..
            } => {
                assert!(!acceptance.duplicate());
                assert_eq!(result.outcome, RunOutcome::Completed);
                assert!(original.replace(acceptance).is_none());
            }
            PersistentRunResult::Duplicate { acceptance, run } => {
                assert!(acceptance.duplicate());
                assert_eq!(run.run_id(), &rig.run_id);
                assert!(duplicate.replace(acceptance).is_none());
            }
        }
    }
    assert_eq!(original.unwrap().receipt(), duplicate.unwrap().receipt());
    assert_eq!(count(&rig.script.records.opens), 1);
    assert_eq!(count(&rig.script.records.calls), 1);
    assert_eq!(rig.script.records.inputs.lock().unwrap().len(), 2);
    assert_eq!(history(&rig.session).await.len(), 16);
    rig.close().await;
}
