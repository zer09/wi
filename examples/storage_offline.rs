//! Storage-only fixture, not a persistence seam for ordinary `wi run`.
//! Responses and run DTOs are supplied offline; tool output comes from the real registry.
use serde_json::json;
use sqlx::{
    ConnectOptions, Connection, Row,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous},
};
use std::{
    error::Error,
    fs,
    future::Future,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use wi::{
    CallOrigin, EventEnvelope, FunctionCall, InputItem, ItemKind, ModelResponse, OutputItem,
    OutputProvenance, ProviderEvent, ResponseOutcome, SessionOptions, UpstreamOutcome,
    context::{ContextRoots, discover, prepare_run_with_skill_loading},
    run::{RunEvent, RunEventEnvelope, RunOutcome, RunRequest, RunResult, RunSummary, TurnOutcome},
    storage::{
        AppendRunRecord, CreateSession, OperationId, RecordedRunInput, RecordedRunState, RunId,
        SessionStore, StorageError,
    },
    tools::{AddNumbers, ToolExecutionEvent, ToolRegistry},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

async fn measured<T>(
    label: &str,
    future: impl Future<Output = std::result::Result<T, StorageError>>,
) -> std::result::Result<T, StorageError> {
    let start = Instant::now();
    let value = future.await?;
    println!("  {label}_ms={:.3}", start.elapsed().as_secs_f64() * 1000.0);
    Ok(value)
}

fn envelope(
    run: &RunId,
    sequence: u64,
    turn: Option<&str>,
    request: Option<&str>,
    event: RunEvent,
) -> AppendRunRecord {
    let session_id = if matches!(event, RunEvent::RunStarted) {
        None
    } else {
        Some("offline-session".into())
    };
    AppendRunRecord::Runtime(RunEventEnvelope {
        schema_version: 2,
        sequence,
        event_id: uuid::Uuid::new_v4().to_string(),
        run_id: run.as_str().into(),
        turn_id: turn.map(str::to_owned),
        session_id,
        request_id: request.map(str::to_owned),
        event,
    })
}

fn response(tool: bool) -> ModelResponse {
    let call = FunctionCall {
        call_id: "addition".into(),
        name: "add_numbers".into(),
        arguments: "{\"a\":20,\"b\":22}".into(),
        origin: CallOrigin::Direct,
        namespace: None,
        complete: true,
    };
    let (id, item, text) = if tool {
        (
            "response-1",
            OutputItem {
                id: Some("call-item".into()),
                kind: ItemKind::FunctionCall,
                native_type: "function_call".into(),
                native: json!({"type":"function_call","id":"call-item","call_id":call.call_id,"name":call.name,"arguments":call.arguments,"status":"completed"}),
                function_call: Some(call),
            },
            "",
        )
    } else {
        (
            "response-2",
            OutputItem {
                id: Some("message-item".into()),
                kind: ItemKind::Message,
                native_type: "message".into(),
                function_call: None,
                native: json!({"type":"message","id":"message-item","role":"assistant","content":[{"type":"output_text","text":"42"}]}),
            },
            "42",
        )
    };
    ModelResponse {
        output_provenance: OutputProvenance::NativeTerminal,
        id: id.into(),
        model: Some("offline-model".into()),
        outcome: ResponseOutcome::Completed,
        native: json!({"id":id,"status":"completed","output":[item.native]}),
        output: vec![item],
        text: text.into(),
        usage: None,
    }
}

fn observed(response: ModelResponse, sequence: u64, request: &str) -> RunEvent {
    RunEvent::ProviderEvent {
        event: Box::new(EventEnvelope {
            schema_version: 1,
            sequence,
            event_id: format!("provider-event-{sequence}"),
            session_id: "offline-session".into(),
            request_id: Some(request.into()),
            provider: "offline-fixture".into(),
            provider_sequence: None,
            event: ProviderEvent::ResponseFinished { response },
        }),
    }
}

async fn observation(sample: usize) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let roots = ContextRoots {
        workspace: temp.path().join("workspace"),
        global_skills: temp.path().join("global-skills"),
    };
    fs::create_dir_all(roots.workspace.join(".agents/skills/arithmetic"))?;
    fs::create_dir_all(&roots.global_skills)?;
    fs::write(
        roots.workspace.join("AGENTS.md"),
        "Use exact integer arithmetic.\n",
    )?;
    fs::write(
        roots.workspace.join(".agents/skills/arithmetic/SKILL.md"),
        "---\nname: arithmetic\ndescription: Offline arithmetic instructions\n---\nUse add_numbers to add the supplied integers.\n",
    )?;
    let catalog = Arc::new(discover(roots.clone())?);
    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(AddNumbers))?;
    let task = "Add 20 and 22.\n";
    let (prepared, mut registry) = prepare_run_with_skill_loading(
        RunRequest {
            provider_id: "offline-fixture".into(),
            options: SessionOptions::new("offline-model"),
            prompt: task.into(),
        },
        catalog,
        &["project:arithmetic".parse()?],
        &registry,
    )?;
    let captured = RecordedRunInput::capture(task.into(), &prepared, &registry)?;
    assert!(captured.prepared_request().options.tools.is_empty());
    assert_eq!(captured.active_skills(), ["project:arithmetic"]);
    assert_eq!(captured.available_skills(), ["project:arithmetic"]);
    assert_eq!(
        captured.project_instructions_source(),
        Some("project:AGENTS.md")
    );
    let captured_value = serde_json::to_value(&captured)?;
    let captured_bytes = serde_json::to_vec(&captured)?.len();
    let root = temp.path().join("data");
    let store = SessionStore::open(root.clone()).await?;
    println!(
        "sample={sample} (API end-to-end; includes operation-scoped connection open/validation/close)"
    );
    let creation = CreateSession::new(
        OperationId::new(),
        "Offline arithmetic".into(),
        Some(
            roots
                .workspace
                .to_str()
                .ok_or("UTF-8 synthetic workspace")?
                .into(),
        ),
    )?;
    let created = measured("create", store.create_session(creation.clone())).await?;
    let session = store.open_session(created.session_id().clone()).await?;
    let run = RunId::new();
    let accepted = measured(
        "accept",
        session.accept_run(OperationId::new(), run.clone(), captured),
    )
    .await?;

    let call_response = response(true);
    let mut tool_events = Vec::new();
    // Storage never executes tools. Capture the actual registry result outside storage.
    let results = registry
        .execute_response(&call_response, |event| tool_events.push(event))
        .await?;
    assert_eq!(results.len(), 1);
    let InputItem::ToolResult { call_id, output } = &results[0] else {
        return Err("actual tool result missing".into());
    };
    let [
        ToolExecutionEvent::ToolExecutionStarted { .. },
        ToolExecutionEvent::ToolExecutionFinished { is_error, .. },
    ] = tool_events.as_slice()
    else {
        return Err("actual tool observations missing".into());
    };
    let is_error = *is_error;
    assert!(!is_error);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(output)?,
        json!({"sum":42})
    );
    let final_response = response(false);
    let summary = RunSummary {
        turns_started: 2,
        turns_finished: 2,
        model_requests_attempted: 2,
        model_requests_admitted: 2,
        new_tool_dispatches: 1,
        tool_results_prepared: 1,
        last_request_id: Some("request-2".into()),
        last_upstream_outcome: Some(UpstreamOutcome::TerminalReceived),
        ..RunSummary::default()
    };
    let result = RunResult {
        run_id: run.as_str().into(),
        session_id: Some("offline-session".into()),
        outcome: RunOutcome::Completed,
        summary: summary.clone(),
        last_response: Some(final_response.clone()),
        events_complete: true,
        sink_error: None,
    };
    let mut records = vec![
        envelope(&run, 1, None, None, RunEvent::RunStarted),
        envelope(
            &run,
            2,
            Some("turn-1"),
            None,
            RunEvent::TurnStarted { number: 1 },
        ),
        envelope(
            &run,
            3,
            Some("turn-1"),
            Some("request-1"),
            observed(call_response, 1, "request-1"),
        ),
    ];
    for (index, event) in tool_events.into_iter().enumerate() {
        records.push(envelope(
            &run,
            4 + index as u64,
            Some("turn-1"),
            Some("request-1"),
            RunEvent::ToolEvent { event },
        ));
    }
    records.extend([
        AppendRunRecord::ToolResult {
            request_id: Some("request-1".into()),
            call_id: call_id.clone(),
            output: output.clone(),
            is_error,
        },
        envelope(
            &run,
            6,
            Some("turn-1"),
            Some("request-1"),
            RunEvent::TurnFinished {
                number: 1,
                response_id: Some("response-1".into()),
                outcome: TurnOutcome::ToolsPrepared,
                upstream_outcome: Some(UpstreamOutcome::TerminalReceived),
            },
        ),
        envelope(
            &run,
            7,
            Some("turn-2"),
            None,
            RunEvent::TurnStarted { number: 2 },
        ),
        envelope(
            &run,
            8,
            Some("turn-2"),
            Some("request-2"),
            observed(final_response, 2, "request-2"),
        ),
        envelope(
            &run,
            9,
            Some("turn-2"),
            Some("request-2"),
            RunEvent::TurnFinished {
                number: 2,
                response_id: Some("response-2".into()),
                outcome: TurnOutcome::ModelCompleted,
                upstream_outcome: Some(UpstreamOutcome::TerminalReceived),
            },
        ),
        envelope(
            &run,
            10,
            None,
            Some("request-2"),
            RunEvent::RunFinished {
                outcome: RunOutcome::Completed,
                summary,
            },
        ),
        AppendRunRecord::Result(result.clone()),
    ]);
    let transaction_rows = records.len();
    let transaction_bytes = serde_json::to_vec(&records)?.len();
    let appended = measured(
        "append_batch",
        session.append_run_records(OperationId::new(), run.clone(), records),
    )
    .await?;
    let renamed = measured(
        "rename",
        session.rename(OperationId::new(), "Retained result: 42\n".into()),
    )
    .await?;
    session.refresh_catalog().await?;
    let list = measured("list", store.list_sessions(None, 10)).await?;
    assert_eq!(list.sessions().len(), 1);
    assert_eq!(list.sessions()[0].title(), "Retained result: 42\n");
    assert_eq!(
        list.sessions()[0].observed_head_sequence(),
        renamed.receipt().last_sequence()
    );
    let first = measured("page", session.history_page(0, None, 4)).await?;
    assert!(first.has_more());
    let head = first.through_sequence();
    let mut after = first.next_after();
    let mut history = first.records().to_vec();
    loop {
        let page = session.history_page(after, Some(head), 4).await?;
        history.extend_from_slice(page.records());
        after = page.next_after();
        if !page.has_more() {
            break;
        }
    }
    assert_eq!(history.len() as u64, head);
    let history_value = serde_json::to_value(&history)?;
    let history_bytes = serde_json::to_vec(&history)?.len();
    assert_eq!(
        session
            .run_record(run.clone())
            .await?
            .ok_or("recorded run missing")?
            .state(),
        RecordedRunState::Completed
    );
    assert_eq!(
        session
            .tool_result(run.clone(), call_id.clone())
            .await?
            .ok_or("recorded tool missing")?
            .output(),
        Some(output.as_str())
    );
    // Reopen after the synthetic context disappears. Reads must use the saved snapshot.
    fs::remove_dir_all(&roots.workspace)?;
    fs::remove_dir_all(&roots.global_skills)?;
    drop(registry);
    let reopened = measured("close_reopen", async {
        store.close().await?;
        let reopened = SessionStore::open(root.clone()).await?;
        let handle = reopened.open_session(created.session_id().clone()).await?;
        Ok((reopened, handle))
    })
    .await?;
    let (store, session) = reopened;
    assert_eq!(
        serde_json::to_value(session.history_page(0, Some(head), head).await?.records())?,
        history_value
    );
    let retained = session
        .run_record(run.clone())
        .await?
        .ok_or("retained run missing")?;
    assert_eq!(retained.state(), RecordedRunState::Completed);
    assert_eq!(serde_json::to_value(retained.input())?, captured_value);
    assert_eq!(
        serde_json::to_value(retained.result())?,
        serde_json::to_value(Some(&result))?
    );
    let tool = session
        .tool_result(run, call_id.clone())
        .await?
        .ok_or("retained tool missing")?;
    assert_eq!(tool.output(), Some(output.as_str()));
    assert_eq!(tool.is_error(), Some(is_error));
    for receipt in [accepted.receipt(), appended.receipt(), renamed.receipt()] {
        assert_eq!(
            session
                .lookup_receipt(receipt.operation_id().clone())
                .await?
                .as_ref(),
            Some(receipt)
        );
    }
    assert_eq!(
        store.create_session(creation).await?.receipt(),
        created.receipt()
    );
    measured("close", store.close()).await?;
    let id = created.session_id().as_str();
    let session_path = root
        .join("sessions")
        .join(&id[..2])
        .join(id)
        .join("session.sqlite3");
    println!(
        "  bytes: catalog={} session={} input_snapshot={} append_typed_json={} history_json={} tool_output={}",
        fs::metadata(root.join("catalog.sqlite3"))?.len(),
        fs::metadata(session_path)?.len(),
        captured_bytes,
        transaction_bytes,
        history_bytes,
        output.len()
    );
    println!(
        "  canonical transaction event rows: create=1 accept=1 append={transaction_rows} rename=1; retained_head={head}"
    );
    Ok(())
}

async fn engine_probe(path: &Path) -> Result<()> {
    // Separate fixture probe, not a public storage connection or production tuning control.
    let start = Instant::now();
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .shared_cache(false)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .foreign_keys(true)
        .pragma("trusted_schema", "OFF")
        .busy_timeout(Duration::ZERO)
        .disable_statement_logging();
    let mut connection = options.connect().await?;
    let open_ms = start.elapsed().as_secs_f64() * 1000.0;
    let row = sqlx::query("SELECT sqlite_version(), sqlite_source_id(), (SELECT journal_mode FROM pragma_journal_mode), (SELECT synchronous FROM pragma_synchronous), (SELECT foreign_keys FROM pragma_foreign_keys), (SELECT trusted_schema FROM pragma_trusted_schema), (SELECT timeout FROM pragma_busy_timeout)").fetch_one(&mut connection).await?;
    let version: String = row.try_get(0)?;
    let source: String = row.try_get(1)?;
    assert_eq!(row.try_get::<String, _>(2)?, "wal");
    for (index, expected) in [(3, 2_i64), (4, 1), (5, 0), (6, 0)] {
        assert_eq!(row.try_get::<i64, _>(index)?, expected);
    }
    let start = Instant::now();
    connection.close().await?;
    println!("bundled SQLite {version}; source_id={source}");
    println!(
        "probe settings: WAL synchronous=FULL foreign_keys=ON trusted_schema=OFF busy_timeout=0 shared_cache=false (connect option)"
    );
    println!(
        "separate probe connection: open_ms={open_ms:.3} close_ms={:.3}",
        start.elapsed().as_secs_f64() * 1000.0
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let probe = tempfile::tempdir()?;
    engine_probe(&probe.path().join("probe.sqlite3")).await?;
    for sample in 1..=3 {
        observation(sample).await?;
    }
    println!(
        "Offline: 3 finite samples; 3 real registry executions; supplied DTO traces, zero provider construction/requests. No SLA or power-loss claim."
    );
    Ok(())
}
