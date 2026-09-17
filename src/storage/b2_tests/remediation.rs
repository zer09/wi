use super::*;
use crate::{EventEnvelope, ProviderEvent, run::RunResult, tools::ToolExecutionEvent};
use serde_json::{Value, json};

async fn snapshot(store: &SessionStore, handle: &SessionHandle, run: &RunId) -> Value {
    let path = filesystem::session_path(&store.inner.root, handle.session_id(), false).unwrap();
    let mut sql = migration::connect(&path).await;
    let row = sqlx::query("SELECT (SELECT count(*) FROM events), (SELECT count(*) FROM commands), (SELECT count(*) FROM tool_results)")
        .fetch_one(&mut sql).await.unwrap();
    let counts: Vec<i64> = (0..3).map(|i| row.get(i)).collect();
    sql.close().await.unwrap();
    json!({
        "manifest": handle.manifest().await.unwrap(),
        "history": handle.history_page(0, None, 100).await.unwrap(),
        "run": handle.run_record(run.clone()).await.unwrap(),
        "tool": handle.tool_result(run.clone(), "call".into()).await.unwrap(),
        "counts": counts,
    })
}

async fn rejected(
    store: &SessionStore,
    handle: &SessionHandle,
    run: &RunId,
    records: Vec<AppendRunRecord>,
    label: &str,
) {
    let before = snapshot(store, handle, run).await;
    let operation = OperationId::new();
    let error = handle
        .append_run_records(operation.clone(), run.clone(), records)
        .await
        .expect_err(label);
    assert_eq!(error.code(), "storage.invalid_transition", "{label}");
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted, "{label}");
    assert!(handle.lookup_receipt(operation).await.unwrap().is_none());
    assert_eq!(snapshot(store, handle, run).await, before, "{label}");
}

fn activity(run: &RunId) -> Vec<AppendRunRecord> {
    let mut provider = runtime(
        run,
        3,
        RunEvent::ProviderEvent {
            event: Box::new(EventEnvelope {
                schema_version: 1,
                sequence: 1,
                event_id: "provider-event".into(),
                session_id: "session".into(),
                request_id: Some("request".into()),
                provider: "synthetic".into(),
                provider_sequence: None,
                event: ProviderEvent::ProviderExtension {
                    event_type: "synthetic.progress".into(),
                    payload: json!({}),
                },
            }),
        },
    );
    let mut tool = runtime(
        run,
        4,
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted {
                call_id: "call".into(),
                tool_name: "synthetic".into(),
            },
        },
    );
    for record in [&mut provider, &mut tool] {
        if let AppendRunRecord::Runtime(event) = record {
            event.request_id = Some("request".into());
        }
    }
    vec![
        runtime(run, 1, RunEvent::RunStarted),
        runtime(run, 2, RunEvent::TurnStarted { number: 1 }),
        provider,
        tool,
        AppendRunRecord::ToolResult {
            request_id: Some("request".into()),
            call_id: "call".into(),
            output: "actual output".into(),
            is_error: true,
        },
    ]
}

fn result(run: &RunId) -> RunResult {
    RunResult {
        run_id: run.as_str().into(),
        session_id: Some("session".into()),
        outcome: RunOutcome::Failed {
            code: "history_identity".into(),
        },
        summary: RunSummary::default(),
        last_response: None,
        events_complete: false,
        sink_error: Some(crate::run::RunSinkError::Closed),
    }
}

fn submitted_results(run: &RunId) -> Vec<(&'static str, RunResult)> {
    let mut variants = Vec::new();
    for field in [
        "turns_started",
        "turns_finished",
        "model_requests_attempted",
        "model_requests_admitted",
        "new_tool_dispatches",
        "tool_results_prepared",
        "reused_results",
        "last_request_id",
        "last_upstream_outcome",
    ] {
        let mut value = json!(result(run));
        value["summary"][field] = match field {
            "last_request_id" => json!("request"),
            "last_upstream_outcome" => json!("terminal_received"),
            _ => json!(1),
        };
        variants.push((field, serde_json::from_value(value).unwrap()));
    }
    let mut value = json!(result(run));
    value["last_response"] = json!({
        "id":"response", "model":"model", "outcome":{"status":"completed"}, "output":[],
        "text":"", "usage":null, "native":{"output":[]}
    });
    variants.push(("last_response", serde_json::from_value(value).unwrap()));
    variants
}

#[tokio::test]
async fn p1b2_remediation_unbound_activity_append_is_atomic() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let handle = create(&store).await;
    let run = RunId::new();
    handle
        .accept_history_run(
            OperationId::new(),
            run.clone(),
            input(),
            selection(&store, &handle).await,
        )
        .await
        .unwrap();
    let records = activity(&run);
    for (last, label) in [
        (2, "turn"),
        (3, "provider"),
        (4, "tool"),
        (5, "tool result"),
    ] {
        rejected(&store, &handle, &run, records[..last].to_vec(), label).await;
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_remediation_unbound_terminal_cannot_claim_submitted_activity() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let handle = create(&store).await;
    let run = RunId::new();
    handle
        .accept_history_run(
            OperationId::new(),
            run.clone(),
            input(),
            selection(&store, &handle).await,
        )
        .await
        .unwrap();
    for (label, result) in submitted_results(&run) {
        rejected(
            &store,
            &handle,
            &run,
            vec![
                runtime(&run, 1, RunEvent::RunStarted),
                AppendRunRecord::Result(result.clone()),
            ],
            label,
        )
        .await;
        if label != "last_response" {
            rejected(
                &store,
                &handle,
                &run,
                vec![
                    runtime(&run, 1, RunEvent::RunStarted),
                    runtime(
                        &run,
                        2,
                        RunEvent::RunFinished {
                            outcome: result.outcome,
                            summary: result.summary,
                        },
                    ),
                ],
                label,
            )
            .await;
        }
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_remediation_bound_atomic_batch_and_legacy_activity_remain_valid() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    for selected in [true, false] {
        let handle = create(&store).await;
        let run = RunId::new();
        if selected {
            handle
                .accept_history_run(
                    OperationId::new(),
                    run.clone(),
                    input(),
                    selection(&store, &handle).await,
                )
                .await
                .unwrap();
        } else {
            handle
                .accept_run(OperationId::new(), run.clone(), input())
                .await
                .unwrap();
        }
        let mut records = activity(&run);
        if selected {
            records.insert(1, AppendRunRecord::ProviderBinding(binding(&run)));
        }
        // RunStarted, binding and TurnStarted must work in one transaction.
        let first = if selected { 3 } else { 2 };
        handle
            .append_run_records(OperationId::new(), run.clone(), records[..first].to_vec())
            .await
            .unwrap();
        handle
            .append_run_records(OperationId::new(), run.clone(), records[first..].to_vec())
            .await
            .unwrap();
        assert_eq!(
            handle
                .provider_binding(run.clone())
                .await
                .unwrap()
                .is_some(),
            selected
        );
        let saved = handle
            .tool_result(run, "call".into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.output(), Some("actual output"));
        assert_eq!(saved.is_error(), Some(true));
    }
    assert_eq!(store.repair_catalog().await.unwrap().ready_sessions(), 2);
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_remediation_unbound_zero_activity_result_and_delivery_paths_remain_valid() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    for delivered in [false, true] {
        let handle = create(&store).await;
        let run = RunId::new();
        handle
            .accept_history_run(
                OperationId::new(),
                run.clone(),
                input(),
                selection(&store, &handle).await,
            )
            .await
            .unwrap();
        handle
            .append_run_records(
                OperationId::new(),
                run.clone(),
                vec![runtime(&run, 1, RunEvent::RunStarted)],
            )
            .await
            .unwrap();
        let mut actual = result(&run);
        if delivered {
            handle
                .append_run_records(
                    OperationId::new(),
                    run.clone(),
                    vec![runtime(
                        &run,
                        2,
                        RunEvent::RunFinished {
                            outcome: actual.outcome.clone(),
                            summary: actual.summary.clone(),
                        },
                    )],
                )
                .await
                .unwrap();
            // Final delivery alone is not proof of definitely unsubmitted execution.
            assert!(
                handle
                    .run_record(run.clone())
                    .await
                    .unwrap()
                    .unwrap()
                    .result()
                    .is_none()
            );
            actual.events_complete = true;
            actual.sink_error = None;
        }
        handle
            .append_run_records(
                OperationId::new(),
                run.clone(),
                vec![AppendRunRecord::Result(actual)],
            )
            .await
            .unwrap();
        let saved = handle.run_record(run.clone()).await.unwrap().unwrap();
        assert_eq!(saved.state(), RecordedRunState::Failed);
        assert!(saved.result().unwrap().last_response.is_none());
        assert_eq!(saved.result().unwrap().summary.model_requests_attempted, 0);
        assert_eq!(saved.result().unwrap().summary.model_requests_admitted, 0);
        assert!(handle.provider_binding(run).await.unwrap().is_none());
    }
    assert_eq!(store.repair_catalog().await.unwrap().ready_sessions(), 2);
    store.close().await.unwrap();
}

// Negative fixtures bypass append validation but keep canonical links and projections aligned.
async fn inject_unbound(sql: &mut SqliteConnection, run: &RunId, record: &AppendRunRecord) {
    let (kind, payload, source) = match record {
        AppendRunRecord::Runtime(event) => ("runtime.observed", json!(event), Some(event)),
        AppendRunRecord::Result(result) => ("run.result.recorded", json!(result), None),
        _ => panic!("unsupported fixture record"),
    };
    sqlx::query("INSERT INTO events (sequence,event_id,event_type,event_version,created_at_ms,run_id,source_event_id,source_sequence,payload_json) VALUES (5,?,?,1,(SELECT updated_at_ms FROM manifest),?,?,?,?)")
        .bind(StoredEventId::new().as_str()).bind(kind).bind(run.as_str())
        .bind(source.map(|event| &event.event_id)).bind(source.map(|event| event.sequence as i64))
        .bind(payload.to_string()).execute(&mut *sql).await.unwrap();
    match record {
        AppendRunRecord::Runtime(event) => {
            sqlx::query(
                "UPDATE runs SET last_runtime_sequence=?,provider_session_id=? WHERE run_id=?",
            )
            .bind(event.sequence as i64)
            .bind(&event.session_id)
            .bind(run.as_str())
            .execute(&mut *sql)
            .await
            .unwrap();
        }
        AppendRunRecord::Result(result) => {
            sqlx::query("UPDATE runs SET state='failed',provider_session_id=?,terminal_sequence=5,terminal_json=?,result_sequence=5 WHERE run_id=?")
                .bind(&result.session_id).bind(payload.to_string()).bind(run.as_str()).execute(&mut *sql).await.unwrap();
        }
        _ => unreachable!(),
    }
    sqlx::query("UPDATE manifest SET head_sequence=5")
        .execute(sql)
        .await
        .unwrap();
}

#[tokio::test]
async fn p1b2_remediation_streamed_repair_rejects_unbound_activity() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let run = RunId::new();
    let mut variants = vec![(
        "turn",
        runtime(&run, 2, RunEvent::TurnStarted { number: 1 }),
    )];
    variants.extend(
        submitted_results(&run)
            .into_iter()
            .map(|(label, result)| (label, AppendRunRecord::Result(result))),
    );
    for (label, record) in variants {
        let handle = create(&store).await;
        handle
            .accept_history_run(
                OperationId::new(),
                run.clone(),
                input(),
                selection(&store, &handle).await,
            )
            .await
            .unwrap();
        handle
            .append_run_records(
                OperationId::new(),
                run.clone(),
                vec![runtime(&run, 1, RunEvent::RunStarted)],
            )
            .await
            .unwrap();
        let path = filesystem::session_path(&store.inner.root, handle.session_id(), false).unwrap();
        let mut sql = migration::connect(&path).await;
        inject_unbound(&mut sql, &run, &record).await;
        // Point reads still decode the data; streamed validation must reject the sequence.
        run_store::run_record(&mut sql, handle.session_id(), &run)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            run_store::validate_run(&mut sql, handle.session_id(), &run)
                .await
                .expect_err(label)
                .code(),
            "storage.integrity"
        );
        sql.close().await.unwrap();
        if label == "turn" {
            rejected(
                &store,
                &handle,
                &run,
                vec![AppendRunRecord::ProviderBinding(binding(&run))],
                "late binding",
            )
            .await;
        }
    }
    let report = store.repair_catalog().await.unwrap();
    assert_eq!(report.ready_sessions(), 0);
    assert_eq!(report.unavailable_sessions(), 11);
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_remediation_catalog_regressed_head_is_integrity_without_update() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let handle = create(&store).await;
    handle
        .rename(OperationId::new(), "advanced".into())
        .await
        .unwrap();
    assert_eq!(
        handle.refresh_catalog().await.unwrap(),
        RefreshResult::Updated
    );
    let guard = store.inner.lifecycle.admit().unwrap();
    let mut catalog = catalog_ops::connect(&store.inner, true).await.unwrap();
    sqlx::query("UPDATE sessions SET head_sequence=head_sequence+1 WHERE session_id=?")
        .bind(handle.session_id().as_str())
        .execute(&mut catalog)
        .await
        .unwrap();
    database::close(catalog, &store.inner.lifecycle)
        .await
        .unwrap();
    let before = store.list_sessions(None, 10).await.unwrap().sessions()[0].clone();
    // Read the canonical file directly so the session-opening head guard cannot mask publish.
    let path = filesystem::session_path(&store.inner.root, handle.session_id(), false).unwrap();
    let mut sql = migration::connect(&path).await;
    let observed = catalog_sync::observe(&mut sql, handle.session_id())
        .await
        .unwrap();
    sql.close().await.unwrap();
    // Equal supported schemas reach the head check, not the earlier downgrade check.
    assert_eq!(observed.schema_version(), before.schema_version());
    assert!(before.observed_head_sequence() > observed.observed_head_sequence());
    assert_eq!(
        catalog_sync::publish(&store.inner, &observed)
            .await
            .unwrap_err()
            .code(),
        "storage.integrity"
    );
    assert!(store.list_sessions(None, 10).await.unwrap().sessions()[0] == before);
    guard.finish();
    store.close().await.unwrap();
}
