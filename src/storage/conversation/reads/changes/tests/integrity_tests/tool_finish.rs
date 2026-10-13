use super::*;
use crate::conversation::ContentCursor;

mod scalars;

async fn start_tool(f: &mut Fixture, call: &str) -> EntryId {
    let sequence = f.handle.manifest().await.unwrap().head_sequence() + 1;
    f.runtime(RunEvent::ToolEvent {
        event: ToolExecutionEvent::ToolExecutionStarted {
            call_id: call.into(),
            tool_name: "synthetic tool".into(),
        },
    })
    .await;
    EntryId::new(sequence, 0).unwrap()
}
async fn finish_tool(f: &mut Fixture, call: &str, is_error: bool) {
    f.runtime(RunEvent::ToolEvent {
        event: ToolExecutionEvent::ToolExecutionFinished {
            call_id: call.into(),
            tool_name: "synthetic tool".into(),
            is_error,
        },
    })
    .await;
}
async fn result_tool(f: &Fixture, call: &str, output: &str, is_error: bool) {
    f.handle
        .append_run_records(
            OperationId::new(),
            f.run.clone(),
            vec![AppendRunRecord::ToolResult {
                request_id: Some(REQUEST.into()),
                call_id: call.into(),
                output: output.into(),
                is_error,
            }],
        )
        .await
        .unwrap();
}

async fn name_cursor(f: &Fixture, id: EntryId) -> ContentCursor {
    let page = f
        .handle
        .conversation_entry(f.run.clone(), id)
        .await
        .unwrap();
    let name = page
        .entry()
        .fields()
        .iter()
        .find(|field| field.kind() == FieldKind::ToolName)
        .unwrap();
    ContentCursor::new(
        f.handle.session_id().clone(),
        f.run.clone(),
        id,
        page.entry().content_epoch(),
        name.field_id().into(),
        name.generation(),
        name.total_bytes(),
    )
    .unwrap()
    .to_string()
    .parse()
    .unwrap()
}

async fn canonical(f: &Fixture) -> String {
    // This full reader is a test oracle, not part of display validation.
    format!(
        "{:?}",
        f.handle
            .tool_result(f.run.clone(), "actual".into())
            .await
            .unwrap()
            .unwrap()
    )
}

fn facts(
    entry: &EntryView,
    finished: bool,
    output: Option<&str>,
    flag: Option<bool>,
    name_only: bool,
) {
    assert_eq!(entry.finish_recorded(), Some(finished));
    assert_eq!(entry.result_recorded(), Some(output.is_some()));
    assert_eq!(entry.is_error(), flag);
    let wire: serde_json::Value =
        serde_json::from_slice(&DisplayJson::Entry(entry).encode().unwrap()).unwrap();
    assert_eq!(wire["finish_recorded"], serde_json::Value::Bool(finished));
    if name_only {
        assert_eq!(entry.fields().len(), 1);
        assert_eq!(entry.fields()[0].kind(), FieldKind::ToolName);
    } else {
        assert_eq!(
            entry
                .fields()
                .iter()
                .find(|field| field.kind() == FieldKind::ToolResult)
                .map(|field| field.text()),
            output
        );
    }
}

async fn healthy(
    f: &Fixture,
    id: EntryId,
    content: &ContentCursor,
    finished: bool,
    output: Option<&str>,
    flag: Option<bool>,
) {
    let batch = f
        .handle
        .conversation_changes(watermark(f, 1))
        .await
        .unwrap();
    bounded(&batch);
    let entry = batch
        .changes()
        .iter()
        .find_map(|change| match change {
            DisplayChange::EntryUpsert(change) if *change.entry().entry_id() == id => {
                Some(change.entry())
            }
            _ => None,
        })
        .unwrap();
    facts(entry, finished, output, flag, false);
    let direct = f
        .handle
        .conversation_entry(f.run.clone(), id)
        .await
        .unwrap();
    super::super::super::super::tests::fixture::bounded(&direct);
    facts(direct.entry(), finished, output, flag, false);
    let name = f
        .handle
        .conversation_content(content.clone())
        .await
        .unwrap();
    facts(name.entry(), finished, output, flag, true);
    let page = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    assert!(DisplayJson::Page(&page).encode().unwrap().len() <= PAGE_BYTES);
    facts(
        page.entries()
            .iter()
            .find(|entry| *entry.entry_id() == id)
            .unwrap(),
        finished,
        output,
        flag,
        false,
    );
}

// Collect every public outcome before asserting, so the pre-guard regression records all cases.
async fn damaged(f: &Fixture, id: EntryId, content: &ContentCursor, label: &str) -> Vec<String> {
    let outcomes = [
        (
            "changes",
            f.handle.conversation_changes(watermark(f, 1)).await.err(),
        ),
        (
            "entry",
            f.handle.conversation_entry(f.run.clone(), id).await.err(),
        ),
        (
            "name-only content",
            f.handle.conversation_content(content.clone()).await.err(),
        ),
        (
            "page",
            f.handle
                .conversation_page(ConversationQuery::Latest)
                .await
                .err(),
        ),
    ];
    let mut failures = Vec::new();
    for (surface, error) in outcomes {
        println!("rb01 {label} {surface}: {error:?}");
        if !matches!(&error, Some(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Integrity)
        {
            failures.push(format!(
                "{label} {surface}: expected Integrity, got {error:?}"
            ));
        }
    }
    failures
}

async fn flip(f: &Fixture, id: EntryId, finished: bool) {
    let before = acceptance_snapshot(f).await;
    let mut sql = f.sql().await;
    let old: String = sqlx::query_scalar(
        "SELECT metadata_json FROM conversation_entries WHERE run_id=? AND entry_id=?",
    )
    .bind(f.run.as_str())
    .bind(id.to_string())
    .fetch_one(&mut sql)
    .await
    .unwrap();
    let changed = sqlx::query("UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.finish_recorded',json(?)) WHERE run_id=? AND entry_id=?")
        .bind((!finished).to_string()).bind(f.run.as_str()).bind(id.to_string()).execute(&mut sql).await.unwrap();
    assert_eq!(changed.rows_affected(), 1);
    let (new, kind): (String, String) = sqlx::query_as("SELECT metadata_json,json_type(metadata_json,'$.finish_recorded') FROM conversation_entries WHERE run_id=? AND entry_id=?")
        .bind(f.run.as_str()).bind(id.to_string()).fetch_one(&mut sql).await.unwrap();
    assert_eq!(kind, (!finished).to_string());
    assert_eq!(
        new,
        old.replace(
            &format!("\"finish_recorded\":{finished}"),
            &format!("\"finish_recorded\":{}", !finished)
        )
    );
    sql.close().await.unwrap();
    let after = acceptance_snapshot(f).await;
    assert_eq!(before.1, after.1);
    for index in (0..7).chain(8..before.0.len()) {
        assert_eq!(before.0[index], after.0[index], "table/schema/raw {index}");
    }
    let original: serde_json::Value = serde_json::from_str(&before.0[7]).unwrap();
    let mut modified: serde_json::Value = serde_json::from_str(&after.0[7]).unwrap();
    for (a, b) in original
        .as_array()
        .unwrap()
        .iter()
        .zip(modified.as_array_mut().unwrap())
    {
        if a[1] == id.to_string() {
            let mut metadata: serde_json::Value =
                serde_json::from_str(a[8].as_str().unwrap()).unwrap();
            metadata["finish_recorded"] = (!finished).into();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(b[8].as_str().unwrap()).unwrap(),
                metadata
            );
            b[8] = a[8].clone();
        }
    }
    assert_eq!(original, modified);
}

async fn matrix(finished: bool) {
    let cases: &[(Option<&str>, bool, bool)] = if finished {
        &[
            (None, true, false),
            (Some(""), true, true),
            (Some(""), false, false),
            (Some("{\"error\":\"not an error\"}\0雪"), false, true),
            (Some("finish first\0雪"), true, false),
        ]
    } else {
        &[
            (None, false, false),
            (Some(""), false, false),
            (Some("{\"error\":\"not an error\"}\0雪"), false, false),
        ]
    };
    let mut failures = Vec::new();
    for &(output, flag, finish_first) in cases {
        let mut f = Fixture::new("actual human\0雪").await;
        f.runtime(RunEvent::RunStarted).await;
        f.runtime(RunEvent::TurnStarted { number: 1 }).await;
        let id = start_tool(&mut f, "actual").await;
        if finished && (finish_first || output.is_none()) {
            finish_tool(&mut f, "actual", flag).await;
        }
        if let Some(output) = output {
            result_tool(&f, "actual", output, flag).await;
        }
        if finished && !finish_first && output.is_some() {
            finish_tool(&mut f, "actual", flag).await;
        }
        let content = name_cursor(&f, id).await;
        let raw = canonical(&f).await;
        let before = acceptance_snapshot(&f).await;
        let actual = f
            .handle
            .tool_result(f.run.clone(), "actual".into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(actual.finished_sequence().is_some(), finished);
        assert_eq!(actual.output(), output);
        assert_eq!(
            actual.is_error(),
            (finished || output.is_some()).then_some(flag)
        );
        for _ in 0..2 {
            healthy(&f, id, &content, finished, output, actual.is_error()).await;
        }
        assert_eq!(acceptance_snapshot(&f).await, before);
        flip(&f, id, finished).await;
        let damaged_snapshot = acceptance_snapshot(&f).await;
        for repeat in 0..2 {
            failures.extend(damaged(&f, id, &content, &format!("finish={finished} output={output:?} finish_first={finish_first} repeat={repeat}")).await);
            assert_eq!(canonical(&f).await, raw);
            assert_eq!(acceptance_snapshot(&f).await, damaged_snapshot);
        }
        f.store.close().await.unwrap();
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn a5b3_rb01_false_to_true_requires_actual_finish() {
    matrix(false).await;
}

#[tokio::test]
async fn a5b3_rb01_true_to_false_cannot_hide_actual_finish() {
    matrix(true).await;
}

#[tokio::test]
async fn a5b3_rb01_reuse_occurrence_before_later_finish_and_target_guard() {
    let mut f = Fixture::new("actual human\0雪").await;
    f.runtime(RunEvent::RunStarted).await;
    f.runtime(RunEvent::TurnStarted { number: 1 }).await;
    let id = start_tool(&mut f, "actual").await;
    result_tool(&f, "actual", "{\"error\":\"not an error\"}\0雪", false).await;
    let sequence = f.handle.manifest().await.unwrap().head_sequence() + 1;
    f.runtime(RunEvent::ToolEvent {
        event: ToolExecutionEvent::ToolResultReused {
            call_id: "actual".into(),
            tool_name: "synthetic tool".into(),
        },
    })
    .await;
    let reuse = EntryId::new(sequence, 0).unwrap();
    finish_tool(&mut f, "actual", false).await;
    let content = name_cursor(&f, id).await;
    let raw = canonical(&f).await;
    let before = acceptance_snapshot(&f).await;
    for _ in 0..2 {
        let batch = f
            .handle
            .conversation_changes(watermark(&f, 1))
            .await
            .unwrap();
        bounded(&batch);
        let page = f
            .handle
            .conversation_page(ConversationQuery::Latest)
            .await
            .unwrap();
        for entry in page.entries() {
            assert_eq!(entry.finish_recorded(), Some(*entry.entry_id() == id));
        }
        let occurrence = f
            .handle
            .conversation_entry(f.run.clone(), reuse)
            .await
            .unwrap();
        assert_eq!(occurrence.entry().finish_recorded(), Some(false));
        assert_eq!(occurrence.entry().reference().unwrap().entry_id(), &id);
        assert_eq!(
            f.handle
                .conversation_content(content.clone())
                .await
                .unwrap()
                .entry()
                .finish_recorded(),
            Some(true)
        );
        assert!(batch.changes().iter().any(|change| matches!(change, DisplayChange::EntryUpsert(change) if *change.entry().entry_id() == reuse && change.entry().finish_recorded() == Some(false))));
    }
    assert_eq!(acceptance_snapshot(&f).await, before);
    flip(&f, id, true).await;
    let after = acceptance_snapshot(&f).await;
    for _ in 0..2 {
        assert!(
            damaged(&f, reuse, &content, "reuse target finish mismatch")
                .await
                .is_empty()
        );
        assert_eq!(canonical(&f).await, raw);
        assert_eq!(acceptance_snapshot(&f).await, after);
    }
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b3_rb01_missing_tool_and_invalid_finish_scalars_reject() {
    for statement in [
        "DELETE FROM tool_results WHERE call_id='actual'",
        "UPDATE tool_results SET finished_sequence=0 WHERE call_id='actual'",
        "UPDATE tool_results SET finished_sequence=-1 WHERE call_id='actual'",
        "UPDATE tool_results SET finished_sequence=7 WHERE call_id='actual'",
        "UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.finish_recorded',true) WHERE kind='tool'",
    ] {
        let mut f = Fixture::new("anchor").await;
        f.runtime(RunEvent::RunStarted).await;
        f.runtime(RunEvent::TurnStarted { number: 1 }).await;
        let id = start_tool(&mut f, "actual").await;
        let content = name_cursor(&f, id).await;
        // Make 7 a real canonical event beyond this entry's revision, not a future-head sentinel.
        f.handle
            .rename(OperationId::new(), "later".into())
            .await
            .unwrap();
        f.handle
            .rename(OperationId::new(), "latest".into())
            .await
            .unwrap();
        let before = acceptance_snapshot(&f).await;
        for _ in 0..2 {
            healthy(&f, id, &content, false, None, None).await;
        }
        assert_eq!(acceptance_snapshot(&f).await, before);
        let mut sql = f.sql().await;
        // Invalid scalar fixtures bypass admission, then restore connection settings before reads.
        sqlx::raw_sql("PRAGMA ignore_check_constraints=ON; PRAGMA foreign_keys=OFF")
            .execute(&mut sql)
            .await
            .unwrap();
        sqlx::raw_sql(statement).execute(&mut sql).await.unwrap();
        if statement.contains("SET finished_sequence=") {
            // Match finish presence so only the invalid sequence, not a boolean mismatch, rejects.
            sqlx::query("UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.finish_recorded',json('true')) WHERE kind='tool'")
                .execute(&mut sql).await.unwrap();
        }
        sqlx::raw_sql("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON")
            .execute(&mut sql)
            .await
            .unwrap();
        if statement.contains("metadata_json") {
            assert_eq!(sqlx::query_scalar::<_, String>("SELECT json_type(metadata_json,'$.finish_recorded') FROM conversation_entries WHERE kind='tool'").fetch_one(&mut sql).await.unwrap(), "integer");
        }
        sql.close().await.unwrap();
        let after = acceptance_snapshot(&f).await;
        for _ in 0..2 {
            assert!(damaged(&f, id, &content, statement).await.is_empty());
            assert_eq!(acceptance_snapshot(&f).await, after);
        }
        f.store.close().await.unwrap();
    }
}
