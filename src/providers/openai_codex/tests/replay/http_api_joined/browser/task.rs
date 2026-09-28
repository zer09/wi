//! One-task recovery evidence. Only checked identities, counts and states leave Rust.
use super::*;
use crate::storage::{AppendRunRecord, CommitReceipt};
use sqlx::{Sqlite, sqlite::SqliteRow};

#[path = "task/tests.rs"]
mod tests;

pub(super) async fn inspect(db: &Database, id: u32) -> Value {
    let sid = checked(db.session.lock())
        .clone()
        .unwrap_or_else(|| panic!("task evidence mismatch"));
    let mut reader = db.reader.lock().await;
    // A short, independent read snapshot cannot wait on the host's acceptance mutex.
    let mut sql = checked(
        reader
            .as_mut()
            .unwrap_or_else(|| panic!("task evidence mismatch"))
            .begin()
            .await,
    );
    let rows = checked(
        sqlx::query("SELECT * FROM events ORDER BY sequence")
            .fetch_all(&mut *sql)
            .await,
    );
    assert!(rows.len() >= 3, "task evidence mismatch");
    let mut records = vec![];
    let mut event_ids = std::collections::HashSet::new();
    let mut prefix = None;
    for (index, row) in rows.iter().enumerate() {
        let payload: Value = checked(serde_json::from_str(column(row, "payload_json")));
        let raw = json!({"sequence":column::<i64>(row,"sequence"),
            "event_id":column::<&str>(row,"event_id"),"event_type":column::<&str>(row,"event_type"),
            "event_version":column::<i64>(row,"event_version"),"created_at_ms":column::<i64>(row,"created_at_ms"),
            "run_id":column::<Option<String>>(row,"run_id"),"source_event_id":column::<Option<String>>(row,"source_event_id"),
            "source_sequence":column::<Option<i64>>(row,"source_sequence"),"payload":payload});
        if index == 0 {
            let bytes = raw.to_string().into_bytes();
            let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
            digest.update(b"wi.history-prefix.v1\0");
            digest.update(&(bytes.len() as u64).to_be_bytes());
            digest.update(&bytes);
            prefix = Some(
                digest
                    .finish()
                    .as_ref()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>(),
            );
        }
        let record: StoredEvent =
            serde_json::from_value(json!({"schema_version":1,"application_session_id":sid,
            "sequence":raw["sequence"],"event_id":raw["event_id"],"event_type":raw["event_type"],
            "event_version":raw["event_version"],"created_at_ms":raw["created_at_ms"],
            "run_id":raw["run_id"],"payload":raw["payload"]}))
            .unwrap_or_else(|_| panic!("task evidence mismatch"));
        assert!(
            record.sequence() == (index + 1) as u64 && event_ids.insert(record.event_id().clone()),
            "task evidence mismatch"
        );
        // StoredEvent validates the envelope; SQLite source columns are checked separately in production.
        if let StoredEventPayload::RuntimeObserved(runtime) = record.payload() {
            assert!(
                raw["source_event_id"].as_str() == Some(runtime.event_id.as_str())
                    && raw["source_sequence"].as_u64() == Some(runtime.sequence),
                "task evidence mismatch"
            );
        } else {
            assert!(
                raw["source_event_id"].is_null() && raw["source_sequence"].is_null(),
                "task evidence mismatch"
            );
        }
        records.push(record);
    }
    assert!(
        matches!(records[0].payload(), StoredEventPayload::SessionCreated(_)),
        "task evidence mismatch"
    );
    let StoredEventPayload::RunAccepted(accepted) = records[1].payload() else {
        panic!("task evidence mismatch")
    };
    let StoredEventPayload::RunHistorySelected(selected) = records[2].payload() else {
        panic!("task evidence mismatch")
    };
    let run = accepted.run_id();
    let input = accepted.input();
    let selection = selected.selection();
    assert!(
        selected.run_id() == run
            && records[1].created_at_ms() == records[2].created_at_ms()
            && input.user_text() == TASKS[0]
            && input.prepared_request().provider_id == PROVIDER_ID
            && input.prepared_request().options.model == MODEL
            && selection.policy() == "closed-exchanges-v1"
            && selection.through_sequence() == 1
            && Some(selection.history_digest()) == prefix.as_deref()
            && selection.expected_identity().is_none()
            && selection.provider_id() == PROVIDER_ID
            && selection.requested_model() == MODEL,
        "task evidence mismatch"
    );
    let prompt: Value = serde_json::from_str(&input.prepared_request().prompt)
        .unwrap_or_else(|_| panic!("task evidence mismatch"));
    assert!(prompt["task"] == TASKS[0], "task evidence mismatch");
    let counts = |kind| {
        records
            .iter()
            .filter(|record| record.event_type() == kind)
            .count()
    };
    assert!(
        counts("run.accepted") == 1
            && counts("run.history.selected") == 1
            && counts("session.renamed") == 0
            && counts("run.interrupted") == 0
            && records[1..]
                .iter()
                .all(|record| record.run_id() == Some(run)),
        "task evidence mismatch"
    );
    let runs = checked(sqlx::query("SELECT * FROM runs").fetch_all(&mut *sql).await);
    assert!(runs.len() == 1, "task evidence mismatch");
    let saved = &runs[0];
    assert!(
        column::<&str>(saved, "run_id") == run.as_str()
            && column::<i64>(saved, "accepted_sequence") == 2
            && column::<&str>(saved, "owner_instance_id") == accepted.owner_instance_id().as_str(),
        "task evidence mismatch"
    );
    let state = projection(&records, saved);
    if rows.len() == 3 {
        // Acceptance alone cannot create tool work, including an orphan projection row.
        let tools: i64 = checked(
            sqlx::query_scalar("SELECT count(*) FROM tool_results")
                .fetch_one(&mut *sql)
                .await,
        );
        assert!(tools == 0, "task evidence mismatch");
    }
    let manifest = checked(
        sqlx::query("SELECT head_sequence,updated_at_ms FROM manifest WHERE singleton=1")
            .fetch_one(&mut *sql)
            .await,
    );
    let head: i64 = column(&manifest, "head_sequence");
    assert!(
        head == rows.len() as i64
            && column::<i64>(&manifest, "updated_at_ms")
                == records[records.len() - 1].created_at_ms(),
        "task evidence mismatch"
    );
    let commands = checked(
        sqlx::query("SELECT * FROM commands ORDER BY first_sequence")
            .fetch_all(&mut *sql)
            .await,
    );
    let mut task_receipt = None;
    let mut last = 1;
    let mut operations = std::collections::HashSet::new();
    for command in &commands {
        let receipt: CommitReceipt = checked(serde_json::from_str(column(command, "receipt_json")));
        assert!(
            receipt.session_id() == &sid
                && receipt.run_id() == Some(run)
                && receipt.operation_id().as_str() == column::<&str>(command, "operation_id")
                && operations.insert(receipt.operation_id().clone())
                && receipt.first_sequence() == column::<i64>(command, "first_sequence") as u64
                && receipt.last_sequence() == column::<i64>(command, "last_sequence") as u64
                && receipt.first_sequence() == last + 1
                && receipt.last_sequence() >= receipt.first_sequence()
                && receipt.last_sequence() <= head as u64,
            "task evidence mismatch"
        );
        let batch =
            &records[(receipt.first_sequence() - 1) as usize..receipt.last_sequence() as usize];
        // One mutation uses one timestamp. Different transactions may observe a clock regression.
        assert!(
            batch
                .iter()
                .all(|record| record.created_at_ms() == batch[0].created_at_ms()),
            "task evidence mismatch"
        );
        last = receipt.last_sequence();
        let canonical = if receipt.first_sequence() == 2 {
            assert!(
                column::<&str>(command, "method") == "accept_history_run"
                    && receipt.last_sequence() == 3,
                "task evidence mismatch"
            );
            task_receipt = Some(receipt);
            json!({"session_id":sid,"run_id":run,"method":"accept_history_run",
                "input":input,"selection":selection})
        } else {
            assert!(
                column::<&str>(command, "method") == "append_run_records",
                "task evidence mismatch"
            );
            // Use the same typed records and canonical request shape as run_store::command_hash.
            let appended: Vec<_> = batch.iter().map(append_record).collect();
            json!({"session_id":sid,"run_id":run,"method":"append_run_records","records":appended})
        }
        .to_string();
        let hash = ring::digest::digest(&ring::digest::SHA256, canonical.as_bytes());
        assert!(
            column::<Vec<u8>>(command, "payload_hash") == hash.as_ref(),
            "task evidence mismatch"
        );
    }
    assert!(last == head as u64, "task evidence mismatch");
    let receipt = task_receipt.unwrap_or_else(|| panic!("task evidence mismatch"));
    let views: Vec<Value> = records
        .iter()
        .map(|record| {
            checked(serde_json::to_value(crate::http_api::dto::EventView::from(
                record,
            )))
        })
        .collect();
    assert!(
        views[1]["kind"] == "run.accepted"
            && views[1]["data"]["user_text"] == TASKS[0]
            && views[2]["kind"] == "checkpoint"
            && views[2]["data"] == json!({}),
        "task evidence mismatch"
    );
    let projected = |kind| views.iter().filter(|view| view["kind"] == kind).count();
    let evidence = json!({"id":id,"event":"task_inspect","exact":true,
        "receipt":crate::http_api::dto::ReceiptView::from(&receipt),
        "accepted_event_id":records[1].event_id(),"checkpoint_event_id":records[2].event_id(),
        "sequence_count":head.to_string(),"task_commands":1,"runs":runs.len(),
        "acceptance_events":counts("run.accepted"),"selection_events":counts("run.history.selected"),
        "binding_events":counts("run.provider.bound"),"rename_events":counts("session.renamed"),
        "run_state":state,"deltas":projected("response.delta"),"tool_starts":projected("tool.started"),
        "tool_finishes":projected("tool.finished")});
    assert!(
        evidence.to_string().len() < LIMIT as usize,
        "task evidence mismatch"
    );
    checked(sql.rollback().await);
    evidence
}

fn checked<T, E>(result: std::result::Result<T, E>) -> T {
    result.unwrap_or_else(|_| panic!("task evidence mismatch"))
}

fn column<'a, T: sqlx::Decode<'a, Sqlite> + sqlx::Type<Sqlite>>(
    row: &'a SqliteRow,
    name: &str,
) -> T {
    checked(row.try_get(name))
}

fn append_record(record: &StoredEvent) -> AppendRunRecord {
    match record.payload() {
        StoredEventPayload::RunProviderBound(binding) => {
            AppendRunRecord::ProviderBinding(binding.clone())
        }
        StoredEventPayload::RuntimeObserved(runtime) => AppendRunRecord::Runtime(runtime.clone()),
        StoredEventPayload::ToolResultRecorded(result) => AppendRunRecord::ToolResult {
            request_id: result.request_id().map(str::to_owned),
            call_id: result.call_id().to_owned(),
            output: result.output().to_owned(),
            is_error: result.is_error(),
        },
        StoredEventPayload::RunResultRecorded(result) => AppendRunRecord::Result(result.clone()),
        _ => panic!("task evidence mismatch"),
    }
}

fn projection(records: &[StoredEvent], saved: &SqliteRow) -> &'static str {
    // Derive the one-task projection from history, never from the columns being checked.
    let mut state = "accepted";
    let mut last_runtime = 0;
    let mut runtime_ids = std::collections::HashSet::new();
    let mut provider = None;
    let mut bound = false;
    let mut terminal = None;
    let mut result_sequence = None;
    for record in &records[3..] {
        match record.payload() {
            StoredEventPayload::RunProviderBound(binding) => {
                assert!(
                    state == "running"
                        && !bound
                        && record.sequence() == 5
                        && binding.identity().provider_id() == PROVIDER_ID
                        && binding.requested_model() == MODEL,
                    "task evidence mismatch"
                );
                bound = true;
                provider = Some(binding.provider_session_id());
            }
            StoredEventPayload::RuntimeObserved(runtime) => {
                assert!(
                    runtime.sequence > last_runtime
                        && runtime_ids.insert(runtime.event_id.as_str())
                        && (provider.is_none() || provider == runtime.session_id.as_deref()),
                    "task evidence mismatch"
                );
                match &runtime.event {
                    RunEvent::RunStarted => {
                        assert!(state == "accepted", "task evidence mismatch");
                        state = "running";
                    }
                    RunEvent::RunFinished { outcome, .. } => {
                        assert!(
                            state == "running" && bound && *outcome == RunOutcome::Completed,
                            "task evidence mismatch"
                        );
                        state = "completed";
                        terminal = Some(record);
                    }
                    _ => assert!(state == "running" && bound, "task evidence mismatch"),
                }
                last_runtime = runtime.sequence;
                provider = runtime.session_id.as_deref();
            }
            StoredEventPayload::ToolResultRecorded(_) => {
                assert!(state == "running" && bound, "task evidence mismatch");
            }
            StoredEventPayload::RunResultRecorded(result) => {
                assert!(
                    state == "completed"
                        && result_sequence.is_none()
                        && result.outcome == RunOutcome::Completed
                        && result.session_id.as_deref() == provider
                        && result.events_complete,
                    "task evidence mismatch"
                );
                result_sequence = Some(record.sequence() as i64);
            }
            _ => panic!("task evidence mismatch"),
        }
    }
    let terminal_sequence = terminal.map(|record| record.sequence() as i64);
    let terminal_payload =
        terminal.map(|record| checked(serde_json::to_value(record))["payload"].clone());
    let saved_terminal: Option<String> = column(saved, "terminal_json");
    let saved_terminal: Option<Value> =
        saved_terminal.map(|json| checked(serde_json::from_str(&json)));
    assert!(
        column::<&str>(saved, "state") == state
            && column::<i64>(saved, "last_runtime_sequence") == last_runtime as i64
            && column::<Option<&str>>(saved, "provider_session_id") == provider
            && column::<Option<i64>>(saved, "terminal_sequence") == terminal_sequence
            && saved_terminal == terminal_payload
            && column::<Option<i64>>(saved, "result_sequence") == result_sequence,
        "task evidence mismatch"
    );
    // The joined final call follows task_finished and must prove both separate durable records.
    // Accepted/running calls remain valid without either record.
    assert!(
        state != "completed"
            || terminal_sequence
                .zip(result_sequence)
                .is_some_and(|(terminal, result)| result > terminal),
        "task evidence mismatch"
    );
    state
}
