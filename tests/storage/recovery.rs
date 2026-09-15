use super::fixtures::{self, Fixture};
use super::{
    capture::input,
    fixtures::connect,
    history::provider,
    recording::{append, result, runtime, session, value},
};
use sqlx::{Connection, Row};
use std::fs;
use wi::{
    DeltaKind, ProviderEvent,
    run::{RunEvent, RunOutcome},
    storage::*,
};

#[tokio::test]
async fn p1a21_22_refresh_is_explicit_catalog_only_and_receipts_survive_failure() {
    let (fixture, store, handle, run) = session().await;
    let receipt = handle
        .rename(OperationId::new(), "renamed\n雪".into())
        .await
        .unwrap();
    handle
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    let cached = store.list_sessions(None, 10).await.unwrap();
    assert_eq!(cached.sessions()[0].title(), "title");
    assert_eq!(cached.sessions()[0].observed_head_sequence(), 1);
    assert_eq!(cached.sessions()[0].last_run_state(), None);
    let mut catalog = connect(&fixture.catalog()).await;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut catalog)
        .await
        .unwrap();
    let error = handle.refresh_catalog().await.unwrap_err();
    assert_eq!(error.code(), "storage.busy");
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    assert_eq!(
        handle
            .lookup_receipt(receipt.receipt().operation_id().clone())
            .await
            .unwrap()
            .as_ref(),
        Some(receipt.receipt())
    );
    sqlx::query("ROLLBACK").execute(&mut catalog).await.unwrap();
    catalog.close().await.unwrap();
    assert_eq!(
        handle.refresh_catalog().await.unwrap(),
        RefreshResult::Updated
    );
    assert_eq!(
        handle.refresh_catalog().await.unwrap(),
        RefreshResult::Unchanged
    );
    let current = store.list_sessions(None, 10).await.unwrap();
    let summary = &current.sessions()[0];
    assert_eq!(
        summary.observed_manifest(),
        &handle.manifest().await.unwrap()
    );
    assert_eq!(summary.last_run_id(), Some(&run));
    assert_eq!(summary.last_run_state(), Some(RecordedRunState::Accepted));
    assert_eq!(summary.availability(), SessionAvailability::Ready);
    // Removing only this synthetic DB proves listing never opens it or probes liveness.
    let path = fixture.root.join(format!(
        "sessions/{}/{}/session.sqlite3",
        &handle.session_id().as_str()[..2],
        handle.session_id()
    ));
    std::fs::remove_file(path).unwrap();
    assert_eq!(store.list_sessions(None, 10).await.unwrap(), current);
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1a17_restart_interrupts_once_preserves_partial_results_and_old_receipts() {
    for running in [false, true] {
        let (fixture, store, handle, run) = session().await;
        let op = OperationId::new();
        let (tools, executions) = super::tools::registry(super::tools::Mode::Success);
        let recorded_input = super::tools::with_tools(&tools);
        let receipt = handle
            .accept_run(op.clone(), run.clone(), recorded_input.clone())
            .await
            .unwrap();
        if running {
            append(
                &handle,
                &run,
                vec![
                    AppendRunRecord::Runtime(runtime(&run, 1, RunEvent::RunStarted)),
                    AppendRunRecord::Runtime(runtime(&run, 2, RunEvent::TurnStarted { number: 1 })),
                    AppendRunRecord::Runtime(runtime(
                        &run,
                        3,
                        provider(
                            ProviderEvent::OutputItemUpdated {
                                response_id: "response".into(),
                                item_id: "item".into(),
                                output_index: 0,
                                content_index: None,
                                summary_index: None,
                                kind: DeltaKind::Text,
                                delta: "partial\0雪".into(),
                            },
                            1,
                        ),
                    )),
                    AppendRunRecord::Runtime(runtime(
                        &run,
                        4,
                        RunEvent::ToolEvent {
                            event: wi::tools::ToolExecutionEvent::ToolExecutionStarted {
                                call_id: "saved".into(),
                                tool_name: "tool".into(),
                            },
                        },
                    )),
                    AppendRunRecord::ToolResult {
                        request_id: Some("original request".into()),
                        call_id: "saved".into(),
                        output: "exact\n雪".into(),
                        is_error: false,
                    },
                    AppendRunRecord::Runtime(runtime(
                        &run,
                        5,
                        RunEvent::ToolEvent {
                            event: wi::tools::ToolExecutionEvent::ToolExecutionStarted {
                                call_id: "missing".into(),
                                tool_name: "tool".into(),
                            },
                        },
                    )),
                    AppendRunRecord::Runtime(runtime(
                        &run,
                        6,
                        RunEvent::ToolEvent {
                            event: wi::tools::ToolExecutionEvent::ToolExecutionFinished {
                                call_id: "missing".into(),
                                tool_name: "tool".into(),
                                is_error: true,
                            },
                        },
                    )),
                    AppendRunRecord::Runtime(runtime(
                        &run,
                        7,
                        RunEvent::ToolEvent {
                            event: wi::tools::ToolExecutionEvent::ToolExecutionStarted {
                                call_id: "unresolved".into(),
                                tool_name: "tool".into(),
                            },
                        },
                    )),
                ],
            )
            .await;
        }
        let head = handle.manifest().await.unwrap().head_sequence();
        let before = value(&handle.history_page(0, None, 100).await.unwrap().records());
        let second = store
            .open_session(handle.session_id().clone())
            .await
            .unwrap();
        assert_eq!(second.manifest().await.unwrap().head_sequence(), head);
        assert_eq!(
            handle.refresh_catalog().await.unwrap(),
            RefreshResult::Updated
        );
        let cached = store.list_sessions(None, 10).await.unwrap();
        store.close().await.unwrap();
        for _ in 0..2 {
            let reopened = SessionStore::open(fixture.root.clone()).await.unwrap();
            let selected = reopened
                .open_session(handle.session_id().clone())
                .await
                .unwrap();
            assert_eq!(selected.manifest().await.unwrap().head_sequence(), head + 1);
            assert_eq!(
                value(
                    &selected
                        .history_page(0, Some(head), 100)
                        .await
                        .unwrap()
                        .records()
                ),
                before
            );
            let record = selected.run_record(run.clone()).await.unwrap().unwrap();
            assert_eq!(record.state(), RecordedRunState::Interrupted);
            let StoredEventPayload::RunInterrupted(payload) = record.terminal().unwrap().payload()
            else {
                panic!()
            };
            assert_eq!(payload.reason(), InterruptionReason::ProcessRestart);
            assert!(record.result().is_none());
            assert_eq!(
                selected
                    .accept_run(op.clone(), run.clone(), recorded_input.clone())
                    .await
                    .unwrap()
                    .receipt(),
                receipt.receipt()
            );
            assert_eq!(executions.load(std::sync::atomic::Ordering::SeqCst), 0);
            if running {
                assert_eq!(
                    selected
                        .tool_result(run.clone(), "saved".into())
                        .await
                        .unwrap()
                        .unwrap()
                        .output(),
                    Some("exact\n雪")
                );
                let missing = selected
                    .tool_result(run.clone(), "missing".into())
                    .await
                    .unwrap()
                    .unwrap();
                assert!(missing.finished_sequence().is_some());
                assert_eq!(missing.output(), None);
                assert_eq!(missing.is_error(), Some(true));
                let unresolved = selected
                    .tool_result(run.clone(), "unresolved".into())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(unresolved.finished_sequence(), None);
                assert_eq!(unresolved.output(), None);
                assert_eq!(unresolved.is_error(), None);
            }
            assert_eq!(reopened.list_sessions(None, 10).await.unwrap(), cached);
            reopened.close().await.unwrap();
        }
    }
}

#[tokio::test]
async fn p1a17_restart_leaves_all_existing_terminal_states_unchanged() {
    for outcome in [
        RunOutcome::Completed,
        RunOutcome::Failed {
            code: "gateway_error".into(),
        },
        RunOutcome::CancelledLocally,
    ] {
        let (fixture, store, handle, run) = session().await;
        handle
            .accept_run(OperationId::new(), run.clone(), input())
            .await
            .unwrap();
        append(
            &handle,
            &run,
            vec![AppendRunRecord::Result(result(&run, outcome))],
        )
        .await;
        let before = value(&handle.history_page(0, None, 100).await.unwrap());
        store.close().await.unwrap();
        let reopened = SessionStore::open(fixture.root.clone()).await.unwrap();
        let selected = reopened
            .open_session(handle.session_id().clone())
            .await
            .unwrap();
        assert_eq!(
            value(&selected.history_page(0, None, 100).await.unwrap()),
            before
        );
        reopened.close().await.unwrap();
    }
}

fn path(fixture: &Fixture, id: &ApplicationSessionId) -> std::path::PathBuf {
    fixture.root.join(format!(
        "sessions/{}/{}/session.sqlite3",
        &id.as_str()[..2],
        id
    ))
}

async fn create(store: &SessionStore, title: &str) -> (CreateSession, CreateResult, SessionHandle) {
    let input = CreateSession::new(OperationId::new(), title.into(), None).unwrap();
    let created = store.create_session(input.clone()).await.unwrap();
    let handle = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    (input, created, handle)
}

#[tokio::test]
async fn p1a23_lost_catalog_recovers_renamed_original_creation_and_recorded_summary() {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let (input_create, created, handle) = create(&store, "original\n雪").await;
    handle
        .rename(OperationId::new(), "renamed\0雪".into())
        .await
        .unwrap();
    let run = RunId::new();
    handle
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    let original = value(&handle.history_page(0, None, 20).await.unwrap());
    store.close().await.unwrap();
    // Simulate loss of the whole catalog set, not removal of sidecars to fix a lock.
    let lost = fixture.temp.path().join("lost-catalog");
    fixtures::directory(&lost);
    for name in [
        "catalog.sqlite3",
        "catalog.sqlite3-wal",
        "catalog.sqlite3-shm",
    ] {
        let source = fixture.root.join(name);
        if source.exists() {
            fs::rename(source, lost.join(name)).unwrap();
        }
    }
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    assert_eq!(
        store.list_sessions(None, 10).await.unwrap_err().code(),
        "storage.catalog_repair_required"
    );
    assert_eq!(
        store
            .open_session(created.session_id().clone())
            .await
            .unwrap_err()
            .code(),
        "storage.catalog_repair_required"
    );
    assert_eq!(
        store
            .create_session(input_create.clone())
            .await
            .unwrap_err()
            .code(),
        "storage.catalog_repair_required"
    );
    let report = store.repair_catalog().await.unwrap();
    assert_eq!(report.scanned_sessions(), 1);
    assert_eq!(report.ready_sessions(), 1);
    assert_eq!(report.missing_sessions(), 0);
    assert_eq!(report.unavailable_sessions(), 0);
    assert_eq!(report.conflicting_commands(), 0);
    assert_eq!(report.ignored_entries(), 0);
    assert_eq!(report, store.repair_catalog().await.unwrap());
    let retry = store.create_session(input_create.clone()).await.unwrap();
    assert!(retry.duplicate());
    assert_eq!(retry.receipt(), created.receipt());
    let list = store.list_sessions(None, 10).await.unwrap();
    assert_eq!(list.sessions()[0].title(), "renamed\0雪");
    assert_eq!(
        list.sessions()[0].last_run_state(),
        Some(RecordedRunState::Accepted)
    );
    // Repair observes old ownership without interruption. Only selection interrupts.
    let mut sql = connect(&path(&fixture, created.session_id())).await;
    assert_eq!(
        sqlx::query("SELECT count(*) FROM events")
            .fetch_one(&mut sql)
            .await
            .unwrap()
            .try_get::<i64, _>(0)
            .unwrap(),
        3
    );
    sql.close().await.unwrap();
    let selected = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    assert_eq!(
        value(&selected.history_page(0, Some(3), 20).await.unwrap()),
        original
    );
    assert_eq!(
        selected.run_record(run).await.unwrap().unwrap().state(),
        RecordedRunState::Interrupted
    );
    assert_eq!(store.list_sessions(None, 10).await.unwrap(), list);
    let mut invalid = value(&report);
    invalid["unexpected"] = true.into();
    assert!(serde_json::from_value::<RepairReport>(invalid).is_err());
    let mut invalid = value(&report);
    invalid["ready_sessions"] = (-1).into();
    assert!(serde_json::from_value::<RepairReport>(invalid).is_err());
    assert_eq!(format!("{report:?}"), "RepairReport([redacted])");
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1a23_24_lost_catalog_with_malformed_generated_entries_requires_repair() {
    for kind in [
        "file",
        #[cfg(unix)]
        "link",
        #[cfg(unix)]
        "socket",
    ] {
        for bucket_entry in [false, true] {
            let fixture = Fixture::new();
            let store = SessionStore::open(fixture.root.clone()).await.unwrap();
            let (request, created, handle) = create(&store, "healthy").await;
            handle
                .rename(OperationId::new(), "renamed".into())
                .await
                .unwrap();
            let history = value(&handle.history_page(0, None, 10).await.unwrap());
            store.close().await.unwrap();
            let prefix = (0..256)
                .map(|i| format!("{i:02x}"))
                .find(|p| !fixture.root.join("sessions").join(p).exists())
                .unwrap();
            let id: ApplicationSessionId = format!("{prefix}123456-789a-4bcd-8abc-0123456789ab")
                .parse()
                .unwrap();
            let bucket = fixture.root.join("sessions").join(&prefix);
            let malformed = if bucket_entry {
                bucket
            } else {
                fixtures::directory(&bucket);
                bucket.join(id.as_str())
            };
            let target = fixture.temp.path().join("untouched-target");
            let target_db = if bucket_entry {
                target.join(id.as_str()).join("session.sqlite3")
            } else {
                target.join("session.sqlite3")
            };
            fixtures::directory(target_db.parent().unwrap());
            fixtures::file(&target_db, b"synthetic-target-canary");
            #[cfg(unix)]
            let mut socket = None;
            match kind {
                "file" => fixtures::file(&malformed, b"synthetic-entry-canary"),
                #[cfg(unix)]
                "link" => std::os::unix::fs::symlink(&target, &malformed).unwrap(),
                #[cfg(unix)]
                "socket" => {
                    let short_path = fixture.temp.path().join("s");
                    socket = Some(std::os::unix::net::UnixListener::bind(&short_path).unwrap());
                    fs::rename(short_path, &malformed).unwrap();
                }
                _ => unreachable!(),
            }
            let lost = fixture.temp.path().join("lost-catalog");
            fixtures::directory(&lost);
            for name in [
                "catalog.sqlite3",
                "catalog.sqlite3-wal",
                "catalog.sqlite3-shm",
            ] {
                let source = fixture.root.join(name);
                if source.exists() {
                    fs::rename(source, lost.join(name)).unwrap();
                }
            }
            let store = SessionStore::open(fixture.root.clone()).await.unwrap();
            let mut sql = connect(&fixture.catalog()).await;
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT repair_required FROM catalog_meta")
                    .fetch_one(&mut sql)
                    .await
                    .unwrap(),
                1
            );
            sql.close().await.unwrap();
            for error in [
                store.list_sessions(None, 10).await.unwrap_err(),
                store
                    .open_session(created.session_id().clone())
                    .await
                    .unwrap_err(),
                store.create_session(request.clone()).await.unwrap_err(),
            ] {
                assert_eq!(error.code(), "storage.catalog_repair_required");
            }
            let report = store.repair_catalog().await.unwrap();
            assert_eq!(report.ready_sessions(), 1);
            assert_eq!(report.missing_sessions(), 0);
            assert_eq!(report.unavailable_sessions(), u64::from(!bucket_entry));
            assert_eq!(report.scanned_sessions(), 1 + u64::from(!bucket_entry));
            assert_eq!(report.ignored_entries(), u64::from(bucket_entry));
            let page = store.list_sessions(None, 10).await.unwrap();
            assert_eq!(page.sessions().len(), 1 + usize::from(!bucket_entry));
            if !bucket_entry {
                let summary = page
                    .sessions()
                    .iter()
                    .find(|s| s.session_id() == &id)
                    .unwrap();
                assert_eq!(summary.availability(), SessionAvailability::Unavailable);
                assert_eq!(summary.fault_code(), Some("storage.unavailable"));
            }
            let selected = store
                .open_session(created.session_id().clone())
                .await
                .unwrap();
            assert_eq!(
                value(&selected.history_page(0, None, 10).await.unwrap()),
                history
            );
            assert_eq!(
                store.create_session(request).await.unwrap().receipt(),
                created.receipt()
            );
            assert_eq!(fs::read(&target_db).unwrap(), b"synthetic-target-canary");
            let metadata = fs::symlink_metadata(&malformed).unwrap();
            match kind {
                "file" => {
                    assert!(metadata.is_file());
                    assert_eq!(fs::read(&malformed).unwrap(), b"synthetic-entry-canary");
                }
                #[cfg(unix)]
                "link" => {
                    assert!(metadata.file_type().is_symlink());
                    assert_eq!(fs::read_link(&malformed).unwrap(), target);
                }
                #[cfg(unix)]
                "socket" => {
                    use std::os::unix::fs::FileTypeExt;
                    assert!(metadata.file_type().is_socket());
                }
                _ => unreachable!(),
            }
            store.close().await.unwrap();
            #[cfg(unix)]
            drop(socket);
        }
    }
}

#[tokio::test]
async fn p1a24_lost_catalog_rejects_missing_run_projection_without_changing_history() {
    let (fixture, store, handle, run) = session().await;
    handle
        .accept_run(OperationId::new(), run, input())
        .await
        .unwrap();
    let id = handle.session_id().clone();
    store.close().await.unwrap();
    let canonical = path(&fixture, &id);
    let mut sql = connect(&canonical).await;
    let history = sqlx::query_as::<_, (i64, String, String)>(
        "SELECT sequence, event_id, payload_json FROM events ORDER BY sequence",
    )
    .fetch_all(&mut sql)
    .await
    .unwrap();
    assert_eq!(
        sqlx::query("DELETE FROM runs")
            .execute(&mut sql)
            .await
            .unwrap()
            .rows_affected(),
        1
    );
    sql.close().await.unwrap();
    let before = fs::read(&canonical).unwrap();
    let lost = fixture.temp.path().join("lost-catalog");
    fixtures::directory(&lost);
    for name in [
        "catalog.sqlite3",
        "catalog.sqlite3-wal",
        "catalog.sqlite3-shm",
    ] {
        let source = fixture.root.join(name);
        if source.exists() {
            fs::rename(source, lost.join(name)).unwrap();
        }
    }
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let mut previous = None;
    for _ in 0..2 {
        let report = store.repair_catalog().await.unwrap();
        assert_eq!(report.scanned_sessions(), 1);
        assert_eq!(report.ready_sessions(), 0);
        assert_eq!(report.unavailable_sessions(), 1);
        assert_eq!(report.missing_sessions(), 0);
        assert_eq!(report.ignored_entries(), 0);
        if let Some(previous) = previous {
            assert_eq!(report, previous);
        }
        previous = Some(report);
        let page = store.list_sessions(None, 10).await.unwrap();
        assert_eq!(page.sessions().len(), 1);
        assert_eq!(page.sessions()[0].session_id(), &id);
        assert_eq!(
            page.sessions()[0].availability(),
            SessionAvailability::Unavailable
        );
        assert_eq!(page.sessions()[0].fault_code(), Some("storage.integrity"));
        assert_eq!(
            store.open_session(id.clone()).await.unwrap_err().code(),
            "storage.unavailable"
        );
        assert_eq!(fs::read(&canonical).unwrap(), before);
        let mut sql = connect(&canonical).await;
        assert_eq!(
            sqlx::query_as::<_, (i64, String, String)>(
                "SELECT sequence, event_id, payload_json FROM events ORDER BY sequence"
            )
            .fetch_all(&mut sql)
            .await
            .unwrap(),
            history
        );
        let row = sqlx::query("SELECT head_sequence, (SELECT count(*) FROM runs), (SELECT count(*) FROM events WHERE event_type='run.interrupted') FROM manifest")
            .fetch_one(&mut sql).await.unwrap();
        assert_eq!(row.try_get::<i64, _>(0).unwrap(), 2);
        assert_eq!(row.try_get::<i64, _>(1).unwrap(), 0);
        assert_eq!(row.try_get::<i64, _>(2).unwrap(), 0);
        sql.close().await.unwrap();
        assert_eq!(fs::read(&canonical).unwrap(), before);
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1a24_repair_validates_older_run_projections_and_rejects_extra_rows() {
    for mutation in [
        "UPDATE runs SET owner_instance_id='ab123456-789a-4bcd-8abc-0123456789ab' WHERE accepted_sequence=2",
        "UPDATE runs SET accepted_sequence=3 WHERE accepted_sequence=2",
        "INSERT INTO runs (run_id, accepted_sequence, state, last_runtime_sequence, owner_instance_id) VALUES ('ab123456-789a-4bcd-8abc-0123456789ab', 4, 'completed', 0, 'ab123456-789a-4bcd-8abc-0123456789ab')",
    ] {
        let (fixture, store, handle, run) = session().await;
        handle
            .accept_run(OperationId::new(), run.clone(), input())
            .await
            .unwrap();
        append(
            &handle,
            &run,
            vec![AppendRunRecord::Result(result(&run, RunOutcome::Completed))],
        )
        .await;
        handle
            .rename(OperationId::new(), "renamed".into())
            .await
            .unwrap();
        handle
            .accept_run(OperationId::new(), RunId::new(), input())
            .await
            .unwrap();
        let canonical = path(&fixture, handle.session_id());
        let mut sql = connect(&canonical).await;
        sqlx::query(mutation).execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        let before = fs::read(&canonical).unwrap();
        for _ in 0..2 {
            let report = store.repair_catalog().await.unwrap();
            assert_eq!(report.ready_sessions(), 0);
            assert_eq!(report.unavailable_sessions(), 1);
            let page = store.list_sessions(None, 10).await.unwrap();
            assert_eq!(page.sessions().len(), 1);
            assert_eq!(page.sessions()[0].fault_code(), Some("storage.integrity"));
            assert_eq!(
                store
                    .open_session(handle.session_id().clone())
                    .await
                    .unwrap_err()
                    .code(),
                "storage.unavailable"
            );
            assert_eq!(fs::read(&canonical).unwrap(), before);
        }
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1a24_intent_gates_existing_handles_and_scan_failure_retains_it() {
    let (fixture, store, handle, run) = session().await;
    let op = OperationId::new();
    handle.rename(op.clone(), "committed".into()).await.unwrap();
    fixture
        .mutate("UPDATE catalog_meta SET repair_required=1")
        .await;
    let errors = [
        store.list_sessions(None, 2).await.unwrap_err(),
        store
            .open_session(handle.session_id().clone())
            .await
            .unwrap_err(),
        store
            .create_session(CreateSession::new(OperationId::new(), "new".into(), None).unwrap())
            .await
            .unwrap_err(),
        handle.manifest().await.unwrap_err(),
        handle
            .rename(OperationId::new(), "new".into())
            .await
            .unwrap_err(),
        handle
            .accept_run(OperationId::new(), run.clone(), input())
            .await
            .unwrap_err(),
        handle
            .append_run_records(
                OperationId::new(),
                run.clone(),
                vec![AppendRunRecord::Result(result(&run, RunOutcome::Completed))],
            )
            .await
            .unwrap_err(),
        handle.refresh_catalog().await.unwrap_err(),
        handle.history_page(0, None, 2).await.unwrap_err(),
        handle.run_record(run.clone()).await.unwrap_err(),
        handle.tool_result(run, "call".into()).await.unwrap_err(),
        handle.lookup_receipt(op).await.unwrap_err(),
    ];
    for error in errors {
        assert_eq!(error.code(), "storage.catalog_repair_required");
    }
    let sessions = fixture.root.join("sessions");
    let saved = fixture.root.join("saved-sessions");
    fs::rename(&sessions, &saved).unwrap();
    fixtures::file(&sessions, b"synthetic-scan-obstruction");
    assert_eq!(
        store.repair_catalog().await.unwrap_err().code(),
        "storage.unavailable"
    );
    let mut sql = connect(&fixture.catalog()).await;
    let row = sqlx::query("SELECT repair_required, availability FROM catalog_meta, sessions")
        .fetch_one(&mut sql)
        .await
        .unwrap();
    assert_eq!(row.try_get::<i64, _>(0).unwrap(), 1);
    assert_eq!(row.try_get::<String, _>(1).unwrap(), "ready");
    sql.close().await.unwrap();
    fs::remove_file(&sessions).unwrap();
    fs::rename(saved, sessions).unwrap();
    assert_eq!(store.repair_catalog().await.unwrap().ready_sessions(), 1);
    assert_eq!(handle.manifest().await.unwrap().title(), "committed");
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1a24_repair_isolates_missing_corrupt_future_foreign_and_noncanonical_candidates() {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let (_, healthy, handle) = create(&store, "healthy").await;
    handle
        .rename(OperationId::new(), "healthy renamed".into())
        .await
        .unwrap();
    let (_, missing_file, _) = create(&store, "missing file").await;
    let (_, missing_directory, _) = create(&store, "missing directory").await;
    fs::remove_file(path(&fixture, missing_file.session_id())).unwrap();
    let absent = path(&fixture, missing_directory.session_id());
    fs::remove_file(&absent).unwrap();
    fs::remove_dir(absent.parent().unwrap()).unwrap();
    let mut preserved = Vec::new();
    for fault in ["corrupt", "future", "foreign"] {
        let (_, created, _) = create(&store, fault).await;
        let path = path(&fixture, created.session_id());
        if fault == "corrupt" {
            fs::remove_file(&path).unwrap();
            fixtures::file(&path, b"synthetic-corrupt-canary");
        } else {
            let mut sql = connect(&path).await;
            let pragma = if fault == "future" {
                "PRAGMA user_version=9"
            } else {
                "PRAGMA application_id=42"
            };
            sqlx::query(pragma).execute(&mut sql).await.unwrap();
            sql.close().await.unwrap();
        }
        preserved.push((created.session_id().clone(), fs::read(path).unwrap(), fault));
    }
    let unknown = ApplicationSessionId::new();
    let unknown_path = path(&fixture, &unknown);
    fixtures::directory(unknown_path.parent().unwrap());
    fixtures::file(&unknown_path, b"another-corrupt-canary");
    for layout in [
        "sessions/not-a-bucket/ab123456-789a-4bcd-8abc-0123456789ab",
        "sessions/ab/not-a-uuid",
        "sessions/ff/ab123456-789a-4bcd-8abc-0123456789ab",
    ] {
        let directory = fixture.root.join(layout);
        fixtures::directory(&directory);
        fixtures::file(&directory.join("session.sqlite3"), b"noncanonical-canary");
    }
    let report = store.repair_catalog().await.unwrap();
    assert_eq!(report.ready_sessions(), 1);
    assert_eq!(report.missing_sessions(), 2);
    assert_eq!(report.unavailable_sessions(), 4);
    assert_eq!(report.scanned_sessions(), 6);
    assert_eq!(report.ignored_entries(), 3);
    let page = store.list_sessions(None, 20).await.unwrap();
    assert_eq!(page.sessions().len(), 7);
    for (id, bytes, fault) in &preserved {
        let summary = page
            .sessions()
            .iter()
            .find(|s| s.session_id() == id)
            .unwrap();
        assert_eq!(summary.availability(), SessionAvailability::Unavailable);
        assert_eq!(
            summary.fault_code(),
            Some(if *fault == "future" {
                "storage.unsupported_version"
            } else {
                "storage.integrity"
            })
        );
        assert_eq!(fs::read(path(&fixture, id)).unwrap(), *bytes);
    }
    for id in [missing_file.session_id(), missing_directory.session_id()] {
        let summary = page
            .sessions()
            .iter()
            .find(|s| s.session_id() == id)
            .unwrap();
        assert_eq!(summary.availability(), SessionAvailability::Missing);
        assert_eq!(summary.fault_code(), Some("storage.not_found"));
        assert!(!path(&fixture, id).exists());
    }
    assert_eq!(
        page.sessions()
            .iter()
            .find(|s| s.session_id() == healthy.session_id())
            .unwrap()
            .title(),
        "healthy renamed"
    );
    assert_eq!(store.repair_catalog().await.unwrap(), report);
    store.close().await.unwrap();
}

async fn independent_candidate(
    fixture: &Fixture,
    id: &ApplicationSessionId,
    op: &OperationId,
    title: &str,
) {
    let path = path(fixture, id);
    fixtures::directory(path.parent().unwrap());
    fixtures::file(&path, b"");
    let mut sql = connect(&path).await;
    sqlx::raw_sql(include_str!("session_v1.sql"))
        .execute(&mut sql)
        .await
        .unwrap();
    let request =
        serde_json::json!({"method":"create_session", "title":title, "workspace":null}).to_string();
    let hash = ring::digest::digest(&ring::digest::SHA256, request.as_bytes());
    let event = StoredEventId::new();
    let receipt = serde_json::json!({"operation_id":op,"session_id":id,"run_id":null,"first_sequence":1,"last_sequence":1});
    let provenance = serde_json::json!({"operation_id":op,"method":"create_session","session_id":id,"creation_event_id":event,
        "created_at_ms":42,"request_json":request,"payload_hash":hash.as_ref(),"receipt":receipt});
    let payload =
        serde_json::json!({"title":title,"workspace":null,"creation_provenance":provenance});
    sqlx::query("INSERT INTO manifest VALUES(1, ?, 1, 1, ?, NULL, 42, 42, 1, ?)")
        .bind(id.as_str())
        .bind(title)
        .bind(provenance.to_string())
        .execute(&mut sql)
        .await
        .unwrap();
    sqlx::query("INSERT INTO events VALUES(1, ?, 'session.created', 1, 42, NULL, NULL, NULL, ?)")
        .bind(event.as_str())
        .bind(payload.to_string())
        .execute(&mut sql)
        .await
        .unwrap();
    sql.close().await.unwrap();
}

#[tokio::test]
async fn p1a24_duplicate_creation_claimants_are_all_unavailable_and_retry_rejects_command() {
    for titles in [["same", "same", "same"], ["first", "second", "third"]] {
        let fixture = Fixture::new();
        let store = SessionStore::open(fixture.root.clone()).await.unwrap();
        let op = OperationId::new();
        for title in titles {
            let id = ApplicationSessionId::new();
            independent_candidate(&fixture, &id, &op, title).await;
        }
        for _ in 0..2 {
            let report = store.repair_catalog().await.unwrap();
            assert_eq!(report.scanned_sessions(), 3);
            assert_eq!(report.ready_sessions(), 0);
            assert_eq!(report.unavailable_sessions(), 3);
            assert_eq!(report.conflicting_commands(), 1);
            let page = store.list_sessions(None, 10).await.unwrap();
            for summary in page.sessions() {
                assert_eq!(summary.availability(), SessionAvailability::Unavailable);
                assert_eq!(summary.fault_code(), Some("storage.command_conflict"));
                assert_eq!(
                    store
                        .open_session(summary.session_id().clone())
                        .await
                        .unwrap_err()
                        .code(),
                    "storage.unavailable"
                );
            }
            for title in titles {
                assert_eq!(
                    store
                        .create_session(CreateSession::new(op.clone(), title.into(), None).unwrap())
                        .await
                        .unwrap_err()
                        .code(),
                    "storage.command_conflict"
                );
            }
        }
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1a24_invalid_creation_provenance_is_isolated_without_reconstructing_commands() {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    create(&store, "healthy").await;
    let mutations = [
        "UPDATE manifest SET creation_provenance_json=json_set(creation_provenance_json,'$.request_json','{}')",
        "UPDATE manifest SET creation_provenance_json=json_set(creation_provenance_json,'$.payload_hash[0]',256)",
        "UPDATE manifest SET creation_provenance_json=json_set(creation_provenance_json,'$.receipt.last_sequence',2)",
        "UPDATE events SET payload_json=json_set(payload_json,'$.title','not-original') WHERE sequence=1",
        "UPDATE events SET payload_json=json_set(payload_json,'$.extra',1) WHERE sequence=1",
        "UPDATE events SET created_at_ms=41 WHERE sequence=1",
        "UPDATE events SET event_id='ab123456-789a-4bcd-8abc-0123456789b1' WHERE sequence=1",
    ];
    let mut preserved = Vec::new();
    for mutation in mutations {
        let id = ApplicationSessionId::new();
        independent_candidate(&fixture, &id, &OperationId::new(), "original").await;
        let path = path(&fixture, &id);
        let mut sql = connect(&path).await;
        sqlx::raw_sql("DROP TRIGGER manifest_creation_immutable; DROP TRIGGER events_no_update")
            .execute(&mut sql)
            .await
            .unwrap();
        sqlx::query(mutation).execute(&mut sql).await.unwrap();
        sqlx::raw_sql("CREATE TRIGGER manifest_creation_immutable BEFORE UPDATE OF session_id, created_at_ms, creation_provenance_json ON manifest BEGIN SELECT RAISE(ABORT,'immutable session identity'); END; CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable history'); END").execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        preserved.push((path.clone(), fs::read(path).unwrap()));
    }
    let report = store.repair_catalog().await.unwrap();
    assert_eq!(report.ready_sessions(), 1);
    assert_eq!(report.unavailable_sessions(), mutations.len() as u64);
    for (path, bytes) in preserved {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    let mut sql = connect(&fixture.catalog()).await;
    assert_eq!(
        sqlx::query("SELECT count(*) FROM creation_commands")
            .fetch_one(&mut sql)
            .await
            .unwrap()
            .try_get::<i64, _>(0)
            .unwrap(),
        1
    );
    sql.close().await.unwrap();
    for summary in store.list_sessions(None, 20).await.unwrap().sessions() {
        if summary.availability() == SessionAvailability::Unavailable {
            assert_eq!(summary.fault_code(), Some("storage.integrity"));
        }
    }
    store.close().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn p1a24_links_special_entries_and_substituted_buckets_are_not_followed() {
    use std::os::unix::{
        fs::{FileTypeExt, symlink},
        net::UnixListener,
    };
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let (_, healthy, _) = create(&store, "healthy").await;
    let (_, linked, _) = create(&store, "linked").await;
    let link_path = path(&fixture, linked.session_id());
    let target = fixture.temp.path().join("untouched");
    fixtures::file(&target, b"synthetic-link-canary");
    fs::remove_file(&link_path).unwrap();
    symlink(&target, &link_path).unwrap();
    let special_id = ApplicationSessionId::new();
    let special_path = path(&fixture, &special_id);
    fixtures::directory(special_path.parent().unwrap());
    let short_socket = fixture.temp.path().join("s");
    let socket = UnixListener::bind(&short_socket).unwrap();
    fs::rename(short_socket, &special_path).unwrap();
    let directory_id = ApplicationSessionId::new();
    let directory = path(&fixture, &directory_id);
    fixtures::directory(directory.parent().unwrap().parent().unwrap());
    symlink(fixture.temp.path(), directory.parent().unwrap()).unwrap();
    // Select a bucket distinct from every existing bucket so the healthy candidate stays reachable.
    let bucket = (0..256)
        .map(|i| format!("{i:02x}"))
        .find(|p| !fixture.root.join("sessions").join(p).exists())
        .unwrap();
    let id: ApplicationSessionId = format!("{bucket}123456-789a-4bcd-8abc-0123456789ab")
        .parse()
        .unwrap();
    let mut sql = connect(&fixture.catalog()).await;
    sqlx::query("INSERT INTO sessions (session_id, relative_path, title, created_at_ms, updated_at_ms, head_sequence, schema_version, availability) VALUES (?, ?, 'cached', 0, 0, 1, 1, 'ready')")
        .bind(id.as_str()).bind(format!("sessions/{bucket}/{id}/session.sqlite3")).execute(&mut sql).await.unwrap();
    sql.close().await.unwrap();
    symlink(
        fixture.temp.path(),
        fixture.root.join("sessions").join(&bucket),
    )
    .unwrap();
    let report = store.repair_catalog().await.unwrap();
    assert_eq!(report.ready_sessions(), 1);
    assert_eq!(report.unavailable_sessions(), 4);
    assert_eq!(report.missing_sessions(), 0);
    assert_eq!(report.ignored_entries(), 1);
    assert!(
        store
            .open_session(healthy.session_id().clone())
            .await
            .is_ok()
    );
    assert_eq!(fs::read(&target).unwrap(), b"synthetic-link-canary");
    assert!(
        fs::symlink_metadata(&link_path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(
        fs::symlink_metadata(directory.parent().unwrap())
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(
        fs::symlink_metadata(&special_path)
            .unwrap()
            .file_type()
            .is_socket()
    );
    drop(socket);
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1a17_interruption_rolls_back_event_projection_and_head_together() {
    for trigger in [
        "CREATE TRIGGER interruption_test_failure BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
        "CREATE TRIGGER interruption_test_failure BEFORE UPDATE ON manifest BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    ] {
        let (fixture, store, handle, run) = session().await;
        handle
            .accept_run(OperationId::new(), run.clone(), input())
            .await
            .unwrap();
        let id = handle.session_id().clone();
        store.close().await.unwrap();
        let mut sql = connect(&path(&fixture, &id)).await;
        sqlx::query(trigger).execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        let store = SessionStore::open(fixture.root.clone()).await.unwrap();
        assert_eq!(
            store.open_session(id.clone()).await.unwrap_err().code(),
            "storage.integrity"
        );
        let mut sql = connect(&path(&fixture, &id)).await;
        let row = sqlx::query("SELECT head_sequence, (SELECT count(*) FROM events), (SELECT state FROM runs) FROM manifest").fetch_one(&mut sql).await.unwrap();
        assert_eq!(row.try_get::<i64, _>(0).unwrap(), 2);
        assert_eq!(row.try_get::<i64, _>(1).unwrap(), 2);
        assert_eq!(row.try_get::<String, _>(2).unwrap(), "accepted");
        sqlx::query("DROP TRIGGER interruption_test_failure")
            .execute(&mut sql)
            .await
            .unwrap();
        sql.close().await.unwrap();
        let selected = store.open_session(id).await.unwrap();
        assert_eq!(
            selected.run_record(run).await.unwrap().unwrap().state(),
            RecordedRunState::Interrupted
        );
        assert_eq!(selected.manifest().await.unwrap().head_sequence(), 3);
        store.close().await.unwrap();
    }
}
