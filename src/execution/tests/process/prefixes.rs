use super::*;
use crate::storage::test_hooks::{Action, Pause, Point, Record};
use std::io::{BufRead, Write};

pub(super) async fn crash(fixture: &Fixture, stage: Stage, input: &mut impl BufRead) {
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let session = store.open_session(fixture.session.clone()).await.unwrap();
    let before = Arc::new(Barrier::default());
    let after = Arc::new(Barrier::default());
    before.release.notify_one();
    after.release.notify_one();
    let step = Step::Partial {
        response: response("r1", vec![call("one", 17, 25)], ""),
        before,
        after,
    };
    let mode = if matches!(stage, Stage::ResultError) {
        ToolMode::Failed
    } else {
        ToolMode::ErrorShaped
    };
    let (gateway, tools, records) = runtime(fixture, &session, vec![step], mode);
    let record = match stage {
        Stage::Acceptance => Record::Acceptance,
        Stage::PartialText => Record::PartialText,
        Stage::ToolIntent => Record::ToolIntent,
        Stage::ResultOk | Stage::ResultError => Record::ToolResult,
    };
    let pause = Arc::new(Pause::default());
    session
        .test_hooks()
        .arm_record(record, Point::AfterCommit, Action::Pause(pause.clone()));
    let task = tokio::spawn({
        let session = session.clone();
        let request = fixture.request();
        async move {
            run_persisted(
                &gateway,
                &session,
                request,
                &tools,
                CancellationToken::new(),
            )
            .await
        }
    });
    watchdog(pause.reached.notified()).await;
    // This independent read can only see a real COMMIT, not SQL queue admission.
    let prefix = Snapshot::read(&fixture.root, &fixture.session).await;
    prefix.unfinished(fixture);
    let attempted = pause.operation_id.lock().unwrap().clone().unwrap();
    let receipt = prefix
        .commands
        .iter()
        .find(|row| row.0 == attempted.as_str())
        .unwrap();
    assert_eq!(receipt.3 as usize, prefix.events.len());
    assert_eq!(receipt.3, receipt.4);
    assert!(!task.is_finished());
    assert_eq!(count(&records.closes), 0);
    let effects = usize::from(matches!(stage, Stage::ResultOk | Stage::ResultError));
    let opens = usize::from(!matches!(stage, Stage::Acceptance));
    assert_eq!(count(&records.opens), opens);
    assert_eq!(records.inputs.lock().unwrap().len(), opens);
    assert_eq!(count(&records.calls), effects);
    let decoded = prefix.decoded();
    let provider: Vec<_> = decoded
        .iter()
        .filter_map(|record| match record.payload() {
            StoredEventPayload::RuntimeObserved(envelope) => match &envelope.event {
                RunEvent::ProviderEvent { event } => Some(event.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect();
    let emitted = records.events.lock().unwrap().clone();
    assert!(value(&provider) == value(&emitted[..provider.len()].to_vec()));
    for (i, event) in provider.iter().enumerate() {
        assert_eq!(event.schema_version, 1);
        assert_eq!(event.provider, ID);
        assert_eq!(event.session_id, "provider-session");
        assert_eq!(event.request_id.as_deref(), Some("q1"));
        assert_eq!(event.sequence, (i as u64 + 1) * 3);
        assert_eq!(event.provider_sequence, Some(event.sequence + 1000));
        assert_eq!(event.event_id, format!("source-{}", event.sequence));
    }
    let delta = provider
        .iter()
        .filter_map(|event| match &event.event {
            ProviderEvent::OutputItemUpdated { delta, .. } => Some(delta.as_bytes()),
            _ => None,
        })
        .collect::<Vec<_>>();
    if opens == 0 {
        assert!(delta.is_empty());
    } else {
        assert_eq!(delta, vec![PARTIAL.as_bytes()]);
    }
    match stage {
        Stage::Acceptance => {
            assert_eq!(prefix.events.len(), 2);
            assert!(prefix.tools.is_empty());
            assert!(provider.is_empty());
        }
        Stage::PartialText => {
            assert_eq!(prefix.events.len(), 6);
            assert_eq!(provider.len(), 2);
            assert!(prefix.tools.is_empty());
        }
        Stage::ToolIntent | Stage::ResultOk | Stage::ResultError => {
            assert_eq!(provider.len(), 3);
            assert_eq!(prefix.events.len(), 8 + effects);
            assert_eq!(prefix.tools.len(), 1);
            let (run, call, name, request, started, finished, result, error, output) =
                &prefix.tools[0];
            assert_eq!(run, fixture.run_id.as_str());
            assert_eq!(call, "one");
            assert_eq!(name, "add_numbers");
            assert_eq!(request.as_deref(), Some("q1"));
            assert_eq!(*started, 8);
            assert!(finished.is_none());
            if effects == 0 {
                assert!(result.is_none() && error.is_none() && output.is_none());
                assert!(
                    matches!(decoded.last().unwrap().payload(), StoredEventPayload::RuntimeObserved(event)
                    if matches!(&event.event, RunEvent::ToolEvent { event: ToolExecutionEvent::ToolExecutionStarted { .. } }))
                );
            } else {
                let (expected, is_error) = if matches!(stage, Stage::ResultError) {
                    (r#"{"error":{"code":"gateway_error"}}"#, true)
                } else {
                    (
                        r#"{"error":{"code":"not_an_error","text":"雪\n\u0000\\\""}}"#,
                        false,
                    )
                };
                assert_eq!(output.as_deref().unwrap().as_bytes(), expected.as_bytes());
                assert_eq!(*error, Some(i64::from(is_error)));
                assert_eq!(*result, Some(9));
                let StoredEventPayload::ToolResultRecorded(saved) =
                    decoded.last().unwrap().payload()
                else {
                    panic!("missing actual serialized tool result")
                };
                assert_eq!(saved.output().as_bytes(), expected.as_bytes());
                assert_eq!(saved.is_error(), is_error);
                assert_eq!(saved.call_id(), "one");
                assert_eq!(saved.request_id(), Some("q1"));
            }
        }
    }
    // Save the live execution counter separately from SQL dispatch intent before process exit.
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut counter = options
        .open(fixture.root.with_extension("execution-count"))
        .unwrap();
    write!(counter, "{}", count(&records.calls)).unwrap();
    counter.sync_all().unwrap();
    drop(counter);
    println!(
        "PROOF crash={stage:?} rows={} opens={opens} requests={opens} effects={effects} closes=0 returned=0 postcommit=true",
        prefix.events.len()
    );
    harness::release_from_parent(input);
    // Bypass Rust cleanup while the actual composition still awaits its committed observation.
    std::process::exit(73);
}

pub(super) async fn duplicate(fixture: &Fixture, prefix: &Snapshot) {
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let session = store.open_session(fixture.session.clone()).await.unwrap();
    assert!(Snapshot::read(&fixture.root, &fixture.session).await == *prefix);
    let before = session
        .run_record(fixture.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    // Construct empty dependencies only after the storage-only reopen checks have finished.
    let gateway = Gateway::new();
    assert!(matches!(
        gateway.capabilities(ID),
        Err(GatewayError::UnknownProvider)
    ));
    let tools = ToolRegistry::new();
    assert!(tools.definitions().is_empty());
    let result = run_persisted(
        &gateway,
        &session,
        fixture.request(),
        &tools,
        cancel.clone(),
    )
    .await
    .unwrap();
    let PersistentRunResult::Duplicate { acceptance, run } = result else {
        panic!("old work resumed")
    };
    assert!(acceptance.duplicate());
    assert!(acceptance.cleanup_warning().is_none());
    assert!(value(acceptance.receipt()) == value(&prefix.acceptance(&fixture.operation_id)));
    assert!(value(&*run) == value(&before));
    assert_eq!(run.state(), RecordedRunState::Interrupted);
    assert!(cancel.is_cancelled());
    assert!(Snapshot::read(&fixture.root, &fixture.session).await == *prefix);
    store.close().await.unwrap();
    println!(
        "PROOF duplicate unavailable_gateway=true empty_registry=true cancelled=true requests=0 effects=0 history_changes=0"
    );
}

async fn terminal_controls(
    store: &SessionStore,
    fixture: &Fixture,
) -> Vec<(ApplicationSessionId, Snapshot)> {
    let mut saved = vec![];
    for (step, outcome) in [
        (
            Step::Response(response("done", vec![], "terminal 雪\n\0")),
            RunOutcome::Completed,
        ),
        (
            Step::Failure(UpstreamOutcome::Unknown),
            RunOutcome::Failed {
                code: "provider_request_failed".into(),
            },
        ),
        (Step::Wait, RunOutcome::CancelledLocally),
    ] {
        let created = store
            .create_session(
                CreateSession::new(OperationId::new(), "terminal control".into(), None).unwrap(),
            )
            .await
            .unwrap();
        let session = store
            .open_session(created.session_id().clone())
            .await
            .unwrap();
        let mut control = fixture.clone();
        control.session = session.session_id().clone();
        control.operation_id = OperationId::new();
        control.run_id = RunId::new();
        let waiting = matches!(step, Step::Wait);
        let (gateway, tools, records) = runtime(&control, &session, vec![step], ToolMode::Add);
        let cancel = CancellationToken::new();
        let task = tokio::spawn({
            let cancel = cancel.clone();
            let request = control.request();
            async move { run_persisted(&gateway, &session, request, &tools, cancel).await }
        });
        if waiting {
            watchdog(records.waiting.notified()).await;
            cancel.cancel();
        }
        let (_, _, result) = executed(watchdog(task).await.unwrap().unwrap());
        assert_eq!(result.outcome, outcome);
        assert_eq!(count(&records.closes), 1);
        assert_eq!(count(&records.calls), 0);
        let snapshot = Snapshot::read(&control.root, &control.session).await;
        assert!(snapshot.runs[0].8.is_some());
        saved.push((control.session, snapshot));
    }
    saved
}

#[tokio::test]
async fn p1b1_20_process_postcommit_prefixes_reopen_once_and_old_submissions_never_resume() {
    for stage in [
        Stage::Acceptance,
        Stage::PartialText,
        Stage::ToolIntent,
        Stage::ResultOk,
        Stage::ResultError,
    ] {
        let rig = Rig::new(vec![], ToolMode::Add).await;
        let mut fixture = Fixture::from_rig(&rig, Mode::Crash(stage));
        fixture.terminals = terminal_controls(&rig.store, &fixture).await;
        rig.store.close().await.unwrap();
        let mut writer = Process::start(&rig.temp.path().join("writer"), &fixture);
        writer.ready();
        let prefix = Snapshot::read(&fixture.root, &fixture.session).await;
        prefix.unfinished(&fixture);
        assert_eq!(
            SessionStore::open(fixture.root.clone())
                .await
                .unwrap_err()
                .code(),
            "storage.busy"
        );
        writer.release();
        writer.finish(73);
        let counter_path = fixture.root.with_extension("execution-count");
        let counter = std::fs::read(&counter_path).unwrap();
        let expected = if matches!(stage, Stage::ResultOk | Stage::ResultError) {
            b"1"
        } else {
            b"0"
        };
        assert_eq!(counter.as_slice(), expected);
        assert!(Snapshot::read(&fixture.root, &fixture.session).await == prefix);
        fixture.mode = Mode::Reopen(Box::new(prefix));
        Process::start(&rig.temp.path().join("reader1"), &fixture).finish(0);
        let interrupted = Snapshot::read(&fixture.root, &fixture.session).await;
        fixture.mode = Mode::Reopen(Box::new(interrupted.clone()));
        Process::start(&rig.temp.path().join("reader2"), &fixture).finish(0);
        fixture.mode = Mode::Duplicate(Box::new(interrupted.clone()));
        Process::start(&rig.temp.path().join("duplicate"), &fixture).finish(0);
        assert!(Snapshot::read(&fixture.root, &fixture.session).await == interrupted);
        assert_eq!(std::fs::read(counter_path).unwrap(), counter);
        println!(
            "PROOF stage={stage:?} children=4 exits=73,0,0,0 terminal_controls=3 unchanged=true"
        );
    }
}
