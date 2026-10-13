use super::*;
use crate::{ReplayIdentity, providers::openai_codex::PROVIDER_ID};

mod historical;

const SESSION: &str = "01234567-89ab-1cde-8fab-0123456789ab";

fn native_input() -> RecordedRunInput {
    let mut value = serde_json::to_value(input()).unwrap();
    value["prepared_request"]["provider_id"] = PROVIDER_ID.into();
    serde_json::from_value(value).unwrap()
}

async fn native_setup(
    history: bool,
) -> (
    tempfile::TempDir,
    SessionStore,
    SessionHandle,
    RunId,
    PathBuf,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("synthetic-native-store");
    let store = SessionStore::open(root.clone()).await.unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "synthetic".into(), None).unwrap())
        .await
        .unwrap();
    let handle = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let run = RunId::new();
    let path = filesystem::session_path(&root, handle.session_id(), false).unwrap();
    if history {
        let mut raw = sql(&path).await;
        let digest = history_prefix::digest(&mut raw, 1, &[]).await.unwrap();
        raw.close().await.unwrap();
        let selected =
            StoredHistorySelection::new(1, digest, PROVIDER_ID.into(), "synthetic".into(), None)
                .unwrap();
        handle
            .accept_history_run(OperationId::new(), run.clone(), native_input(), selected)
            .await
            .unwrap();
    } else {
        handle
            .accept_run(OperationId::new(), run.clone(), native_input())
            .await
            .unwrap();
    }
    (temp, store, handle, run, path)
}

fn native_runtime(run: &RunId, sequence: u64, event: RunEvent) -> AppendRunRecord {
    let mut record = runtime(run, sequence, event);
    let AppendRunRecord::Runtime(event) = &mut record else {
        unreachable!()
    };
    if event.session_id.is_some() {
        event.session_id = Some(SESSION.into());
    }
    record
}
fn native_provider(run: &RunId, local_sequence: u64) -> AppendRunRecord {
    native_runtime(
        run,
        3,
        RunEvent::ProviderEvent {
            event: Box::new(EventEnvelope {
                schema_version: 1,
                sequence: local_sequence,
                event_id: format!("{SESSION}:{local_sequence}"),
                session_id: SESSION.into(),
                request_id: Some(REQUEST.into()),
                provider: PROVIDER_ID.into(),
                provider_sequence: Some(0),
                event: ProviderEvent::ResponseStarted {
                    response_id: "native-response".into(),
                },
            }),
        },
    )
}
fn native_prefix(run: &RunId) -> Vec<AppendRunRecord> {
    vec![
        native_runtime(run, 1, RunEvent::RunStarted),
        native_runtime(run, 2, RunEvent::TurnStarted { number: 1 }),
    ]
}
fn binding(run: &RunId, session: &str, label: &str) -> AppendRunRecord {
    AppendRunRecord::ProviderBinding(
        RecordedProviderBinding::new(
            run.clone(),
            session.into(),
            "synthetic".into(),
            ReplayIdentity::new(label.into(), "synthetic-v1".into(), "a".repeat(64)).unwrap(),
        )
        .unwrap(),
    )
}

#[tokio::test]
async fn id2b_supported_optional_runtime_result_and_binding_session_paths_reject_exactly() {
    let (_temp, store, handle, run, path) = native_setup(false).await;
    for malformed in crate::identifiers::invalid_uuid_spellings() {
        for final_event in [false, true] {
            let event = if final_event {
                RunEvent::RunFinished {
                    outcome: RunOutcome::Completed,
                    summary: RunSummary::default(),
                }
            } else {
                RunEvent::TurnStarted { number: 1 }
            };
            let mut record = native_runtime(&run, 2, event);
            let AppendRunRecord::Runtime(event) = &mut record else {
                unreachable!()
            };
            event.session_id = Some(malformed.clone());
            rejected(
                &handle,
                &run,
                &path,
                vec![native_runtime(&run, 1, RunEvent::RunStarted), record],
                "storage.invalid_input",
            )
            .await;
        }
        let mut record = result(&run, RunSummary::default());
        let AppendRunRecord::Result(result) = &mut record else {
            unreachable!()
        };
        result.session_id = Some(malformed.clone());
        rejected(
            &handle,
            &run,
            &path,
            vec![native_runtime(&run, 1, RunEvent::RunStarted), record],
            "storage.invalid_input",
        )
        .await;
        // The unchanged constructor already rejects absent/blank binding IDs.
        if malformed.trim().is_empty() {
            assert!(
                RecordedProviderBinding::new(
                    run.clone(),
                    malformed,
                    "synthetic".into(),
                    ReplayIdentity::new(PROVIDER_ID.into(), "synthetic-v1".into(), "a".repeat(64))
                        .unwrap()
                )
                .is_err()
            );
            continue;
        }
        for label in [PROVIDER_ID, "fake-generic"] {
            rejected(
                &handle,
                &run,
                &path,
                vec![
                    native_runtime(&run, 1, RunEvent::RunStarted),
                    binding(&run, &malformed, label),
                ],
                "storage.invalid_input",
            )
            .await;
        }
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn id2b_supported_nested_composite_and_label_use_actual_accepted_context() {
    let (_temp, store, handle, run, path) = native_setup(false).await;
    for (bad_id, sequence) in crate::identifiers::invalid_local_events(SESSION) {
        let mut bad = native_provider(&run, sequence);
        let AppendRunRecord::Runtime(event) = &mut bad else {
            unreachable!()
        };
        let RunEvent::ProviderEvent { event } = &mut event.event else {
            unreachable!()
        };
        event.event_id = bad_id;
        let mut records = native_prefix(&run);
        records.push(bad);
        rejected(&handle, &run, &path, records, "storage.invalid_input").await;
    }
    for malformed in crate::identifiers::invalid_uuid_spellings() {
        let mut bad = native_provider(&run, 19);
        let AppendRunRecord::Runtime(outer) = &mut bad else {
            unreachable!()
        };
        outer.session_id = Some(malformed.clone());
        let RunEvent::ProviderEvent { event } = &mut outer.event else {
            unreachable!()
        };
        event.session_id = malformed.clone();
        event.event_id = format!("{malformed}:19");
        let mut records = native_prefix(&run);
        records.push(bad);
        rejected(&handle, &run, &path, records, "storage.invalid_input").await;
    }
    for malformed in [false, true] {
        let mut bad = native_provider(&run, 19);
        let AppendRunRecord::Runtime(outer) = &mut bad else {
            unreachable!()
        };
        let RunEvent::ProviderEvent { event } = &mut outer.event else {
            unreachable!()
        };
        event.provider = "fake-generic".into();
        if malformed {
            event.event_id = "opaque-fake-event".into();
        }
        let mut records = native_prefix(&run);
        records.push(bad);
        rejected(&handle, &run, &path, records, "storage.invalid_transition").await;
    }
    // Retain structural correlation/version errors, rather than reclassify them.
    let mut bad = native_provider(&run, 19);
    let AppendRunRecord::Runtime(outer) = &mut bad else {
        unreachable!()
    };
    outer.session_id = Some("mismatched-session".into());
    let mut records = native_prefix(&run);
    records.push(bad);
    rejected(&handle, &run, &path, records, "storage.invalid_transition").await;
    store.close().await.unwrap();
}

#[tokio::test]
async fn id2b_complete_supported_batch_is_preflighted_before_first_insert() {
    let (_temp, store, handle, run, path) = native_setup(false).await;
    store.inner.hooks.arm(
        test_hooks::Point::CanonicalInserted,
        test_hooks::Action::Fail(StorageErrorKind::Io),
    );
    let mut records = native_prefix(&run);
    let mut bad = native_provider(&run, 19);
    let AppendRunRecord::Runtime(outer) = &mut bad else {
        unreachable!()
    };
    let RunEvent::ProviderEvent { event } = &mut outer.event else {
        unreachable!()
    };
    event.event_id = "bad-local-composite".into();
    records.push(bad);
    rejected(&handle, &run, &path, records, "storage.invalid_input").await;
    let error = handle
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![native_runtime(&run, 1, RunEvent::RunStarted)],
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "storage.io");
    store.close().await.unwrap();
}

#[tokio::test]
async fn id2b_valid_supported_binding_runtime_gaps_max_u64_result_and_optional_absence_pass() {
    let (_temp, store, handle, run, path) = native_setup(true).await;
    let mut records = vec![
        native_runtime(&run, 1, RunEvent::RunStarted),
        binding(&run, SESSION, PROVIDER_ID),
        native_runtime(&run, 2, RunEvent::TurnStarted { number: 1 }),
        native_provider(&run, 3),
    ];
    let mut last = native_provider(&run, u64::MAX);
    let AppendRunRecord::Runtime(event) = &mut last else {
        unreachable!()
    };
    event.sequence = 4;
    event.event_id = "01234567-89ab-7cde-8fab-000000000004".into();
    records.push(last);
    records.push(native_runtime(
        &run,
        5,
        RunEvent::TurnFinished {
            number: 1,
            response_id: Some("native-response".into()),
            outcome: TurnOutcome::ModelCompleted,
            upstream_outcome: Some(UpstreamOutcome::TerminalReceived),
        },
    ));
    let summary = RunSummary {
        last_request_id: Some(REQUEST.into()),
        ..Default::default()
    };
    records.push(native_runtime(
        &run,
        6,
        RunEvent::RunFinished {
            outcome: RunOutcome::Completed,
            summary: summary.clone(),
        },
    ));
    let mut final_result = result(&run, summary);
    let AppendRunRecord::Result(saved_result) = &mut final_result else {
        unreachable!()
    };
    saved_result.session_id = Some(SESSION.into());
    saved_result.outcome = RunOutcome::Completed;
    saved_result.events_complete = true;
    records.push(final_result);
    let operation = OperationId::new();
    let receipt = handle
        .append_run_records(operation.clone(), run.clone(), records.clone())
        .await
        .unwrap();
    let before = snapshot(&path).await;
    let duplicate = handle
        .append_run_records(operation, run.clone(), records)
        .await
        .unwrap();
    assert!(duplicate.duplicate());
    assert_eq!(duplicate.receipt(), receipt.receipt());
    assert_eq!(snapshot(&path).await, before);
    assert_eq!(
        handle
            .provider_binding(run.clone())
            .await
            .unwrap()
            .unwrap()
            .provider_session_id(),
        SESSION
    );
    assert_eq!(
        handle
            .run_record(run)
            .await
            .unwrap()
            .unwrap()
            .provider_session_id(),
        Some(SESSION)
    );
    assert_eq!(store.repair_catalog().await.unwrap().ready_sessions(), 1);
    store.close().await.unwrap();

    for session in [None, Some(SESSION.into())] {
        let (_temp, store, handle, run, _path) = native_setup(false).await;
        let mut final_result = result(&run, RunSummary::default());
        let AppendRunRecord::Result(result) = &mut final_result else {
            unreachable!()
        };
        result.session_id = session;
        handle
            .append_run_records(
                OperationId::new(),
                run.clone(),
                vec![native_runtime(&run, 1, RunEvent::RunStarted), final_result],
            )
            .await
            .unwrap();
        store.close().await.unwrap();
    }
    let (_temp, store, handle, run, _path) = native_setup(false).await;
    let mut finish = native_runtime(
        &run,
        2,
        RunEvent::RunFinished {
            outcome: RunOutcome::Completed,
            summary: RunSummary::default(),
        },
    );
    let AppendRunRecord::Runtime(event) = &mut finish else {
        unreachable!()
    };
    event.session_id = None;
    event.request_id = None;
    handle
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![native_runtime(&run, 1, RunEvent::RunStarted), finish],
        )
        .await
        .unwrap();
    store.close().await.unwrap();
}
