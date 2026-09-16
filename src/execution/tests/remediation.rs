use super::*;
use crate::storage::{
    CleanupWarning, StorageErrorKind,
    test_hooks::{Action, Pause, Point},
};

struct ChangingDefinition {
    inner: Arc<dyn Tool>,
    reads: Arc<AtomicUsize>,
}
#[async_trait]
impl Tool for ChangingDefinition {
    fn definition(&self) -> ToolDefinition {
        let mut definition = self.inner.definition();
        if self.reads.fetch_add(1, Ordering::SeqCst) != 0 {
            definition.description.push_str(" changed after snapshot");
        }
        definition
    }
    fn validate(&self, arguments: &Value) -> crate::Result<()> {
        self.inner.validate(arguments)
    }
    async fn execute(&self, arguments: Value) -> crate::Result<Value> {
        self.inner.execute(arguments).await
    }
}

#[tokio::test]
async fn remediation_stateful_definition_matches_stored_and_provider_snapshot_once() {
    let rig = Rig::new(
        vec![
            Step::Response(response("r1", vec![call("one", 17, 25)], "")),
            Step::Response(response("final", vec![], "42")),
        ],
        ToolMode::Add,
    )
    .await;
    let reads = Arc::new(AtomicUsize::new(0));
    let mut tools = ToolRegistry::new();
    tools
        .register(Arc::new(ChangingDefinition {
            inner: Arc::new(CountingTool {
                binding: rig.script.binding.clone(),
                records: rig.script.records.clone(),
                mode: ToolMode::Add,
            }),
            reads: reads.clone(),
        }))
        .unwrap();
    // Registration is separate from admission. The next definition is the captured value.
    reads.store(0, Ordering::SeqCst);
    let (_, _, result) = executed(
        run_persisted(
            &rig.gateway,
            &rig.session,
            rig.request(),
            &tools,
            CancellationToken::new(),
        )
        .await
        .unwrap(),
    );
    assert_eq!(count(&reads), 1);
    assert_eq!(result.outcome, RunOutcome::Completed);
    let saved = rig
        .session
        .run_record(rig.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(value(saved.input()), value(&rig.input));
    assert_eq!(
        value(&rig.script.records.options.lock().unwrap()[0].tools),
        value(&saved.input().tool_definitions())
    );
    assert_eq!(count(&rig.script.records.opens), 1);
    assert_eq!(count(&rig.script.records.calls), 1);
    assert_eq!(rig.script.records.inputs.lock().unwrap().len(), 2);
    rig.close().await;
}

#[tokio::test]
async fn remediation_legacy_run_evaluates_definitions_once() {
    struct OptionsOnly(Arc<Mutex<Vec<SessionOptions>>>);
    #[async_trait]
    impl Provider for OptionsOnly {
        fn id(&self) -> &'static str {
            ID
        }
        fn capabilities(&self) -> ProviderCapabilities {
            capabilities()
        }
        async fn open_session(&self, options: SessionOptions) -> crate::Result<ProviderSession> {
            self.0.lock().unwrap().push(options);
            Err(GatewayError::Protocol("synthetic open failure"))
        }
    }
    let options = Arc::new(Mutex::new(Vec::new()));
    let mut gateway = Gateway::new();
    gateway
        .register(Arc::new(OptionsOnly(options.clone())))
        .unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let mut tools = ToolRegistry::new();
    tools
        .register(Arc::new(ChangingDefinition {
            inner: Arc::new(AddNumbers),
            reads: reads.clone(),
        }))
        .unwrap();
    reads.store(0, Ordering::SeqCst);
    let result = run::run(
        &gateway,
        RunRequest {
            provider_id: ID.into(),
            options: SessionOptions::new("synthetic"),
            prompt: "synthetic".into(),
        },
        &tools,
        CancellationToken::new(),
        |_| Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(
        result.outcome,
        RunOutcome::Failed {
            code: "session_open".into()
        }
    );
    assert_eq!(count(&reads), 1);
    let options = options.lock().unwrap();
    assert_eq!(options.len(), 1);
    assert_eq!(
        value(&options[0].tools),
        value(&vec![add_numbers_definition()])
    );
}

#[tokio::test]
async fn remediation_absent_lookup_race_ignores_loser_cancellation_and_current_dependencies() {
    let before = Arc::new(Barrier::default());
    let after = Arc::new(Barrier::default());
    let rig = Rig::new(
        vec![
            Step::Partial {
                response: response("r1", vec![call("one", 17, 25)], ""),
                before: before.clone(),
                after: after.clone(),
            },
            Step::Response(response("final", vec![], "42")),
        ],
        ToolMode::Add,
    )
    .await;
    let hooks = rig.session.test_hooks();
    let first = Arc::new(Pause::default());
    hooks.arm(Point::ReceiptLookupComplete, Action::Pause(first.clone()));
    let winner = rig.start(CancellationToken::new());
    first.reached.notified().await;
    let second = Arc::new(Pause::default());
    hooks.arm(Point::ReceiptLookupComplete, Action::Pause(second.clone()));
    let cancel = CancellationToken::new();
    let loser = tokio::spawn({
        let session = rig.session.clone();
        let request = rig.request();
        let cancel = cancel.clone();
        async move {
            run_persisted(
                &Gateway::new(),
                &session,
                request,
                &ToolRegistry::new(),
                cancel,
            )
            .await
        }
    });
    second.reached.notified().await;
    assert_eq!(rig.session.manifest().await.unwrap().head_sequence(), 1);
    first.release.notify_one();
    before.reached.notified().await;
    let original = rig
        .session
        .lookup_receipt(rig.operation_id.clone())
        .await
        .unwrap()
        .unwrap();
    let head = rig.session.manifest().await.unwrap().head_sequence();
    cancel.cancel();
    second.release.notify_one();
    let duplicate = loser.await.unwrap();
    assert_eq!(rig.session.manifest().await.unwrap().head_sequence(), head);
    assert_eq!(count(&rig.script.records.opens), 1);
    assert_eq!(count(&rig.script.records.calls), 0);
    before.release.notify_one();
    after.reached.notified().await;
    after.release.notify_one();
    let (accepted, _, result) = executed(winner.await.unwrap().unwrap());
    assert_eq!(accepted.receipt(), &original);
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(count(&rig.script.records.opens), 1);
    assert_eq!(count(&rig.script.records.closes), 1);
    assert_eq!(count(&rig.script.records.calls), 1);
    assert_eq!(rig.script.records.inputs.lock().unwrap().len(), 2);
    assert_eq!(history(&rig.session).await.len(), 17);
    let PersistentRunResult::Duplicate { acceptance, run } = duplicate.unwrap() else {
        panic!("old receipt must win over current preflight")
    };
    assert!(acceptance.duplicate());
    assert_eq!(acceptance.receipt(), &original);
    assert_eq!(run.run_id(), &rig.run_id);
    assert_eq!(run.state(), RecordedRunState::Running);
    assert_eq!(value(run.input()), value(&rig.input));
    rig.close().await;
}

#[tokio::test]
async fn remediation_direct_acceptance_wins_over_paused_persistent_preflight() {
    let rig = Rig::new(vec![], ToolMode::Add).await;
    let pause = Arc::new(Pause::default());
    rig.session
        .test_hooks()
        .arm(Point::ReceiptLookupComplete, Action::Pause(pause.clone()));
    let cancel = CancellationToken::new();
    let task = rig.start(cancel.clone());
    pause.reached.notified().await;
    let original = rig
        .session
        .accept_run(
            rig.operation_id.clone(),
            rig.run_id.clone(),
            rig.input.clone(),
        )
        .await
        .unwrap();
    cancel.cancel();
    pause.release.notify_one();
    let result = task.await.unwrap();
    assert_eq!(count(&rig.script.records.opens), 0);
    assert_eq!(count(&rig.script.records.calls), 0);
    assert_eq!(rig.session.manifest().await.unwrap().head_sequence(), 2);
    let PersistentRunResult::Duplicate { acceptance, run } = result.unwrap() else {
        panic!("direct acceptance must remain receipt-first")
    };
    assert!(acceptance.duplicate());
    assert_eq!(acceptance.receipt(), original.receipt());
    assert_eq!(run.state(), RecordedRunState::Accepted);
    assert_eq!(count(&rig.script.records.capabilities), 0);
    rig.close().await;
}

#[tokio::test]
async fn remediation_final_cleanup_warning_returns_committed_actual_result() {
    let rig = Rig::new(
        vec![
            Step::Response(response("r1", vec![call("one", 17, 25)], "")),
            Step::Response(response("final", vec![], "42")),
        ],
        ToolMode::Add,
    )
    .await;
    rig.session.test_hooks().arm(
        Point::FinalResultCleanup,
        Action::Fail(StorageErrorKind::Io),
    );
    let (acceptance, final_record, result) =
        executed(rig.start(CancellationToken::new()).await.unwrap().unwrap());
    assert!(acceptance.cleanup_warning().is_none());
    assert!(!final_record.duplicate());
    assert_eq!(
        final_record.cleanup_warning(),
        Some(CleanupWarning::ConnectionCloseFailed)
    );
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    assert_eq!(result.last_response.as_ref().unwrap().text, "42");
    assert_eq!(result.summary.model_requests_admitted, 2);
    assert_eq!(result.summary.new_tool_dispatches, 1);
    let run = rig
        .session
        .run_record(rig.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.state(), RecordedRunState::Completed);
    assert_eq!(value(run.result().unwrap()), value(&result));
    assert_eq!(
        run.result_sequence(),
        Some(final_record.receipt().last_sequence())
    );
    for commit in [&acceptance, &final_record] {
        assert_eq!(
            rig.session
                .lookup_receipt(commit.receipt().operation_id().clone())
                .await
                .unwrap()
                .as_ref(),
            Some(commit.receipt())
        );
    }
    let records = history(&rig.session).await;
    assert_eq!(records.len(), 16);
    let StoredEventPayload::RunResultRecorded(saved) = records.last().unwrap().payload() else {
        panic!("final result missing")
    };
    assert_eq!(value(saved), value(&result));
    assert_eq!(
        records
            .iter()
            .filter(|r| matches!(r.payload(), StoredEventPayload::RunResultRecorded(_)))
            .count(),
        1
    );
    assert_eq!(count(&rig.script.records.opens), 1);
    assert_eq!(count(&rig.script.records.closes), 1);
    assert_eq!(count(&rig.script.records.calls), 1);
    assert_eq!(rig.script.records.inputs.lock().unwrap().len(), 2);
    rig.close().await;
}

#[tokio::test]
async fn remediation_acceptance_and_intermediate_cleanup_warnings_still_stop_work() {
    for intermediate in [false, true] {
        let rig = Rig::new(vec![], ToolMode::Add).await;
        let hooks = rig.session.test_hooks();
        let pause = Arc::new(Pause::default());
        if intermediate {
            hooks.arm(Point::WriteClosed, Action::Pause(pause.clone()));
        } else {
            hooks.arm(Point::WriteClosed, Action::Fail(StorageErrorKind::Io));
        }
        let task = rig.start(CancellationToken::new());
        if intermediate {
            pause.reached.notified().await;
            hooks.arm(Point::WriteClosed, Action::Fail(StorageErrorKind::Io));
            pause.release.notify_one();
        }
        let failure = task.await.unwrap().unwrap_err();
        let expected_stage = if intermediate {
            PersistentRunStage::RuntimeEvent
        } else {
            PersistentRunStage::Acceptance
        };
        assert_eq!(failure.stage(), expected_stage);
        let PersistentRunCause::Cleanup { warning, commit } = failure.cause() else {
            panic!("committed warning required")
        };
        assert_eq!(*warning, CleanupWarning::ConnectionCloseFailed);
        assert_eq!(commit.cleanup_warning(), Some(*warning));
        assert_eq!(
            failure.operation_id(),
            Some(commit.receipt().operation_id())
        );
        assert_eq!(
            rig.session
                .lookup_receipt(commit.receipt().operation_id().clone())
                .await
                .unwrap()
                .as_ref(),
            Some(commit.receipt())
        );
        assert_eq!(
            failure.acceptance().unwrap().operation_id(),
            &rig.operation_id
        );
        assert_eq!(failure.observed_result().is_some(), intermediate);
        let run = rig
            .session
            .run_record(rig.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert!(run.result().is_none());
        assert_eq!(
            history(&rig.session).await.len(),
            2 + usize::from(intermediate)
        );
        assert_eq!(count(&rig.script.records.opens), 0);
        assert_eq!(count(&rig.script.records.calls), 0);
        assert!(rig.script.records.inputs.lock().unwrap().is_empty());
        rig.close().await;
    }
}
