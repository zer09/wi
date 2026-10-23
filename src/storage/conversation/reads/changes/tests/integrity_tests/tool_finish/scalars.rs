use super::*;
use serde_json::Value;

mod pending;

type Snapshot = (Vec<String>, Vec<Option<crate::storage::CommitReceipt>>);

fn json(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

fn wire(
    entry: &EntryView,
    finished: bool,
    output: Option<&str>,
    flag: Option<bool>,
    name_only: bool,
) {
    facts(entry, finished, output, flag, name_only);
    let bytes = DisplayJson::Entry(entry).encode().unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        value["is_error"],
        flag.map(Value::Bool).unwrap_or(Value::Null)
    );
    assert_eq!(value["result_recorded"], Value::Bool(output.is_some()));
    if name_only {
        assert_eq!(entry.fields()[0].text(), "synthetic tool");
    }
    println!(
        "tool-scalars healthy entry bytes={} finish={finished} output_bytes={:?} flag={flag:?} name_only={name_only}",
        bytes.len(),
        output.map(str::len)
    );
}

async fn healthy_reads(
    f: &Fixture,
    id: EntryId,
    content: &ContentCursor,
    finished: bool,
    output: Option<&str>,
    flag: Option<bool>,
) {
    let before = acceptance_snapshot(f).await;
    let changes = f
        .handle
        .conversation_changes(watermark(f, 1))
        .await
        .unwrap();
    bounded(&changes);
    let entry = changes
        .changes()
        .iter()
        .find_map(|change| match change {
            DisplayChange::EntryUpsert(change) if *change.entry().entry_id() == id => {
                Some(change.entry())
            }
            _ => None,
        })
        .unwrap();
    wire(entry, finished, output, flag, false);
    assert_eq!(acceptance_snapshot(f).await, before);
    let page = f
        .handle
        .conversation_entry(f.run.clone(), id)
        .await
        .unwrap();
    assert!(DisplayJson::EntryPage(&page).encode().unwrap().len() <= PAGE_BYTES);
    wire(page.entry(), finished, output, flag, false);
    assert_eq!(acceptance_snapshot(f).await, before);
    let page = f
        .handle
        .conversation_content(content.clone())
        .await
        .unwrap();
    wire(page.entry(), finished, output, flag, true);
    assert_eq!(acceptance_snapshot(f).await, before);
    let page = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    assert!(DisplayJson::Page(&page).encode().unwrap().len() <= PAGE_BYTES);
    wire(
        page.entries()
            .iter()
            .find(|entry| *entry.entry_id() == id)
            .unwrap(),
        finished,
        output,
        flag,
        false,
    );
    assert_eq!(acceptance_snapshot(f).await, before);
}

async fn rejected(
    f: &Fixture,
    id: EntryId,
    content: &ContentCursor,
    rank2: &LiveCursor,
    label: &str,
) -> Vec<String> {
    let before = acceptance_snapshot(f).await;
    let mut failures = damaged(f, id, content, label).await;
    assert_eq!(acceptance_snapshot(f).await, before);
    let error = f.handle.conversation_changes(rank2.clone()).await.err();
    println!("tool-scalars {label} exhausted rank2: {error:?}");
    if !matches!(&error, Some(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Integrity)
    {
        failures.push(format!(
            "{label} exhausted rank2: expected Integrity, got {error:?}"
        ));
    }
    assert_eq!(acceptance_snapshot(f).await, before);
    failures
}

async fn fixture(
    output: Option<&str>,
    flag: bool,
    finish: u8,
) -> (Fixture, EntryId, ContentCursor, LiveCursor) {
    // 0 has no finish; 1 finishes before the result; 2 finishes after it.
    let mut f = Fixture::new("actual human\0雪").await;
    f.runtime(RunEvent::RunStarted).await;
    f.runtime(RunEvent::TurnStarted { number: 1 }).await;
    let id = start_tool(&mut f, "actual").await;
    if finish == 1 {
        finish_tool(&mut f, "actual", flag).await;
    }
    if let Some(output) = output {
        result_tool(&f, "actual", output, flag).await;
    }
    if finish == 2 {
        finish_tool(&mut f, "actual", flag).await;
    }
    let content = name_cursor(&f, id).await;
    let entry = f
        .handle
        .conversation_entry(f.run.clone(), id)
        .await
        .unwrap();
    let rank2 = cursor(
        &f,
        entry.entry().revision(),
        2,
        Some(f.run.clone()),
        Some(id),
    );
    let exhausted = f.handle.conversation_changes(rank2.clone()).await.unwrap();
    assert!(exhausted.changes().is_empty() && !exhausted.has_more());
    let actual = f
        .handle
        .tool_result(f.run.clone(), "actual".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(actual.output(), output);
    assert_eq!(actual.result_sequence().is_some(), output.is_some());
    assert_eq!(actual.finished_sequence().is_some(), finish != 0);
    assert_eq!(
        actual.is_error(),
        (output.is_some() || finish != 0).then_some(flag)
    );
    (f, id, content, rank2)
}

async fn flip_member(f: &Fixture, id: EntryId, member: &str, old_flag: bool) {
    let mut sql = f.sql().await;
    let old: String = sqlx::query_scalar(
        "SELECT metadata_json FROM conversation_entries WHERE run_id=? AND entry_id=?",
    )
    .bind(f.run.as_str())
    .bind(id.to_string())
    .fetch_one(&mut sql)
    .await
    .unwrap();
    assert_eq!(json(&old)[member], Value::Bool(old_flag));
    let changed = sqlx::query("UPDATE conversation_entries SET metadata_json=json_set(metadata_json,?,json(?)) WHERE run_id=? AND entry_id=?")
        .bind(format!("$.{member}")).bind((!old_flag).to_string()).bind(f.run.as_str()).bind(id.to_string()).execute(&mut sql).await.unwrap();
    assert_eq!(changed.rows_affected(), 1);
    let (new, kind): (String, String) = sqlx::query_as("SELECT metadata_json,json_type(metadata_json,?) FROM conversation_entries WHERE run_id=? AND entry_id=?")
        .bind(format!("$.{member}")).bind(f.run.as_str()).bind(id.to_string()).fetch_one(&mut sql).await.unwrap();
    assert_eq!(
        kind,
        (!old_flag).to_string(),
        "genuine JSON boolean, not integer"
    );
    assert_eq!(
        new,
        old.replace(
            &format!("\"{member}\":{old_flag}"),
            &format!("\"{member}\":{}", !old_flag)
        )
    );
    sql.close().await.unwrap();
}

fn exact_delta(
    before: &Snapshot,
    after: &Snapshot,
    id: EntryId,
    member: &str,
    removed: bool,
    output: Option<&str>,
) {
    assert_eq!(before.1, after.1, "every receipt");
    for i in 0..before.0.len() {
        if [7, 8, 9].contains(&i) {
            continue;
        }
        assert_eq!(
            before.0[i], after.0[i],
            "canonical/schema/raw/head table {i}"
        );
    }
    let original = json(&before.0[7]);
    let mut modified = json(&after.0[7]);
    assert_eq!(
        original.as_array().unwrap().len(),
        modified.as_array().unwrap().len()
    );
    let mut cells = 0;
    for (a, b) in original
        .as_array()
        .unwrap()
        .iter()
        .zip(modified.as_array_mut().unwrap())
    {
        if a[1] == id.to_string() {
            let mut metadata = json(a[8].as_str().unwrap());
            metadata[member] = Value::Bool(!metadata[member].as_bool().unwrap());
            assert_eq!(json(b[8].as_str().unwrap()), metadata);
            b[8] = a[8].clone();
            cells += 1;
        }
    }
    assert_eq!(cells, 1);
    assert_eq!(original, modified, "all other entry cells");
    let fields = json(&before.0[8]);
    let output_id = fields
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row[1] == id.to_string() && row[6] == "tool_result")
        .map(|row| row[2].clone());
    for i in [8, 9] {
        let old = json(&before.0[i]);
        let kept: Vec<_> = old
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| {
                !(removed && row[1] == id.to_string() && Some(&row[2]) == output_id.as_ref())
            })
            .cloned()
            .collect();
        assert_eq!(json(&after.0[i]), Value::Array(kept));
    }
    let field_rows = fields.as_array().unwrap().len() - json(&after.0[8]).as_array().unwrap().len();
    let chunk_rows =
        json(&before.0[9]).as_array().unwrap().len() - json(&after.0[9]).as_array().unwrap().len();
    assert_eq!(field_rows, usize::from(removed));
    assert_eq!(
        chunk_rows,
        usize::from(removed && !output.unwrap().is_empty())
    );
    println!(
        "tool-scalars exact delta member={member}: 1 metadata cell; removed {field_rows} fields/{} cells, {chunk_rows} chunks/{} cells; all other tables/schema/raw/receipts exact",
        field_rows * 8,
        chunk_rows * 5
    );
}

async fn remove_output(f: &Fixture, id: EntryId, output: &str) {
    let mut sql = f.sql().await;
    let key: String = sqlx::query_scalar("SELECT field_id FROM conversation_fields WHERE run_id=? AND entry_id=? AND kind='tool_result'")
        .bind(f.run.as_str()).bind(id.to_string()).fetch_one(&mut sql).await.unwrap();
    let chunks =
        sqlx::query("DELETE FROM conversation_chunks WHERE run_id=? AND entry_id=? AND field_id=?")
            .bind(f.run.as_str())
            .bind(id.to_string())
            .bind(&key)
            .execute(&mut sql)
            .await
            .unwrap();
    assert_eq!(chunks.rows_affected(), u64::from(!output.is_empty()));
    let field =
        sqlx::query("DELETE FROM conversation_fields WHERE run_id=? AND entry_id=? AND field_id=?")
            .bind(f.run.as_str())
            .bind(id.to_string())
            .bind(key)
            .execute(&mut sql)
            .await
            .unwrap();
    assert_eq!(field.rows_affected(), 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
            .fetch_one(&mut sql)
            .await
            .unwrap(),
        1
    );
    assert!(
        sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut sql)
            .await
            .unwrap()
            .is_empty()
    );
    sql.close().await.unwrap();
}

async fn finish_error(actual: bool) {
    let (f, id, content, rank2) = fixture(None, actual, 1).await;
    let raw = canonical(&f).await;
    for _ in 0..2 {
        healthy_reads(&f, id, &content, true, None, Some(actual)).await;
    }
    let before = acceptance_snapshot(&f).await;
    flip_member(&f, id, "is_error", actual).await;
    let after = acceptance_snapshot(&f).await;
    exact_delta(&before, &after, id, "is_error", false, None);
    let mut failures = Vec::new();
    for repeat in 0..2 {
        failures.extend(
            rejected(
                &f,
                id,
                &content,
                &rank2,
                &format!("finish-only actual={actual} repeat={repeat}"),
            )
            .await,
        );
        assert_eq!(canonical(&f).await, raw);
        assert_eq!(acceptance_snapshot(&f).await, after);
    }
    f.store.close().await.unwrap();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn a5b3_tool_scalars_finish_only_false_to_true() {
    finish_error(false).await;
}

#[tokio::test]
async fn a5b3_tool_scalars_finish_only_true_to_false() {
    finish_error(true).await;
}

#[tokio::test]
async fn a5b3_tool_scalars_hidden_results_six_fixtures() {
    let mut failures = Vec::new();
    for (output, flag, finish) in [
        ("{\"error\":\"not an error\"}\0雪", false, 0),
        ("", true, 0),
        ("actual output\0雪", true, 1),
        ("", false, 1),
        ("actual output\0雪", false, 2),
        ("", true, 2),
    ] {
        let (f, id, content, rank2) = fixture(Some(output), flag, finish).await;
        let raw = canonical(&f).await;
        for _ in 0..2 {
            healthy_reads(&f, id, &content, finish != 0, Some(output), Some(flag)).await;
        }
        let before = acceptance_snapshot(&f).await;
        flip_member(&f, id, "result_recorded", true).await;
        remove_output(&f, id, output).await;
        let after = acceptance_snapshot(&f).await;
        exact_delta(&before, &after, id, "result_recorded", true, Some(output));
        for repeat in 0..2 {
            failures.extend(
                rejected(
                    &f,
                    id,
                    &content,
                    &rank2,
                    &format!(
                        "hidden output={output:?} flag={flag} finish={finish} repeat={repeat}"
                    ),
                )
                .await,
            );
            assert_eq!(canonical(&f).await, raw);
            assert_eq!(acceptance_snapshot(&f).await, after);
        }
        f.store.close().await.unwrap();
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn a5b3_tool_scalars_false_flag_descriptor_present() {
    for output in ["", "{\"error\":\"successful\"}\0雪"] {
        let (f, id, content, rank2) = fixture(Some(output), false, 0).await;
        let raw = canonical(&f).await;
        let before = acceptance_snapshot(&f).await;
        flip_member(&f, id, "result_recorded", true).await;
        let after = acceptance_snapshot(&f).await;
        exact_delta(&before, &after, id, "result_recorded", false, Some(output));
        for _ in 0..2 {
            assert!(
                rejected(&f, id, &content, &rank2, "descriptor retained")
                    .await
                    .is_empty()
            );
            assert_eq!(canonical(&f).await, raw);
            assert_eq!(acceptance_snapshot(&f).await, after);
        }
        f.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn a5b3_tool_scalars_pending_orders_and_reuse_controls() {
    for output in [None, Some(""), Some("{\"error\":\"not an error\"}\0雪")] {
        for flag in [false, true] {
            for finish in [0, 1, 2] {
                if output.is_none() && finish != 0 {
                    continue;
                }
                let (mut f, id, content, _) = fixture(output, flag, finish).await;
                let before = acceptance_snapshot(&f).await;
                let raw = canonical(&f).await;
                for _ in 0..2 {
                    healthy_reads(&f, id, &content, finish != 0, output, output.map(|_| flag))
                        .await;
                    assert_eq!(canonical(&f).await, raw);
                    assert_eq!(acceptance_snapshot(&f).await, before);
                }
                if let Some(output) = output
                    && finish == 0
                {
                    let sequence = f.handle.manifest().await.unwrap().head_sequence() + 1;
                    f.runtime(RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolResultReused {
                            call_id: "actual".into(),
                            tool_name: "synthetic tool".into(),
                        },
                    })
                    .await;
                    let reuse = EntryId::new(sequence, 0).unwrap();
                    finish_tool(&mut f, "actual", flag).await;
                    let before = acceptance_snapshot(&f).await;
                    for _ in 0..2 {
                        healthy_reads(&f, id, &content, true, Some(output), Some(flag)).await;
                        let direct = f
                            .handle
                            .conversation_entry(f.run.clone(), reuse)
                            .await
                            .unwrap();
                        let changes = f
                            .handle
                            .conversation_changes(watermark(&f, 1))
                            .await
                            .unwrap();
                        let page = f
                            .handle
                            .conversation_page(ConversationQuery::Latest)
                            .await
                            .unwrap();
                        let changed = changes
                            .changes()
                            .iter()
                            .find_map(|change| match change {
                                DisplayChange::EntryUpsert(change)
                                    if *change.entry().entry_id() == reuse =>
                                {
                                    Some(change.entry())
                                }
                                _ => None,
                            })
                            .unwrap();
                        let saved = page
                            .entries()
                            .iter()
                            .find(|entry| *entry.entry_id() == reuse)
                            .unwrap();
                        for occurrence in [direct.entry(), changed, saved] {
                            assert_eq!(occurrence.reference().unwrap().entry_id(), &id);
                            assert_eq!(occurrence.finish_recorded(), Some(false));
                            assert_eq!(occurrence.result_recorded(), Some(true));
                            assert_eq!(occurrence.is_error(), Some(flag));
                        }
                        assert_eq!(acceptance_snapshot(&f).await, before);
                    }
                }
                f.store.close().await.unwrap();
            }
        }
    }
}

#[tokio::test]
async fn a5b3_tool_scalars_integrity_before_epoch_and_foreign_invalid() {
    let mut failures = Vec::new();
    for output in [None, Some("saved\0雪")] {
        let (f, id, old, rank2) = fixture(output, false, 1).await;
        let before = acceptance_snapshot(&f).await;
        let raw = canonical(&f).await;
        let mut sql = f.sql().await;
        assert_eq!(sqlx::query("UPDATE conversation_entries SET content_epoch=changed_sequence WHERE run_id=? AND entry_id=?")
            .bind(f.run.as_str()).bind(id.to_string()).execute(&mut sql).await.unwrap().rows_affected(), 1);
        sql.close().await.unwrap();
        let epoch_only = acceptance_snapshot(&f).await;
        let mut normalized = epoch_only.clone();
        let original = json(&before.0[7]);
        let mut changed = json(&epoch_only.0[7]);
        let mut cells = 0;
        for (a, b) in original
            .as_array()
            .unwrap()
            .iter()
            .zip(changed.as_array_mut().unwrap())
        {
            if a[1] == id.to_string() {
                assert_eq!(a[6], 5);
                assert_eq!(b[6], if output.is_some() { 7 } else { 6 });
                b[6] = a[6].clone();
                cells += 1;
            }
        }
        assert_eq!(cells, 1);
        assert_eq!(original, changed);
        normalized.0[7] = before.0[7].clone();
        assert_eq!(
            normalized, before,
            "separate control changes only epoch cell"
        );
        let current = name_cursor(&f, id).await;
        let foreign = ContentCursor::new(
            crate::storage::ApplicationSessionId::new(),
            f.run.clone(),
            id,
            old.content_epoch(),
            old.upper_field_id().into(),
            old.upper_generation(),
            old.exclusive_upper_byte(),
        )
        .unwrap();
        for _ in 0..2 {
            assert_eq!(
                f.handle.conversation_content(old.clone()).await.err(),
                Some(ConversationError::CursorStale)
            );
            assert_eq!(
                f.handle.conversation_content(foreign.clone()).await.err(),
                Some(ConversationError::CursorInvalid)
            );
            healthy_reads(&f, id, &current, true, output, Some(false)).await;
            assert_eq!(acceptance_snapshot(&f).await, epoch_only);
        }
        let member = if output.is_some() {
            "result_recorded"
        } else {
            "is_error"
        };
        flip_member(&f, id, member, output.is_some()).await;
        if let Some(output) = output {
            remove_output(&f, id, output).await;
        }
        let after = acceptance_snapshot(&f).await;
        exact_delta(&epoch_only, &after, id, member, output.is_some(), output);
        for _ in 0..2 {
            failures.extend(rejected(&f, id, &old, &rank2, "damaged row before stale epoch").await);
            assert_eq!(
                f.handle.conversation_content(foreign.clone()).await.err(),
                Some(ConversationError::CursorInvalid)
            );
            assert_eq!(canonical(&f).await, raw);
            assert_eq!(acceptance_snapshot(&f).await, after);
        }
        f.store.close().await.unwrap();
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
