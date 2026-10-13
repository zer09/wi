use super::*;

async fn settings(f: &Fixture) {
    let mut sql = f.sql().await;
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&mut sql)
        .await
        .unwrap();
    let ignored: i64 = sqlx::query_scalar("PRAGMA ignore_check_constraints")
        .fetch_one(&mut sql)
        .await
        .unwrap();
    assert_eq!((foreign_keys, ignored), (1, 0));
    for table in ["tool_results", "conversation_entries"] {
        let strict: i64 = sqlx::query_scalar("SELECT strict FROM pragma_table_list WHERE name=?")
            .bind(table)
            .fetch_one(&mut sql)
            .await
            .unwrap();
        assert_eq!(strict, 1);
    }
    assert!(
        sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut sql)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
            .fetch_one(&mut sql)
            .await
            .unwrap(),
        "ok"
    );
    sql.close().await.unwrap();
}

fn pending_view(entry: &EntryView, flag: Option<bool>) {
    wire(entry, false, None, flag, true);
    assert_eq!(
        entry.recorded_state(),
        crate::conversation::RecordedState::InProgress
    );
    assert!(entry.provisional());
}

// Collect all five outcomes before the strict assertion, retaining the complete pre-guard failure.
async fn observed(
    f: &Fixture,
    id: EntryId,
    content: &ContentCursor,
    rank2: &LiveCursor,
    flag: Option<bool>,
    label: &str,
) -> Vec<String> {
    let before = acceptance_snapshot(f).await;
    let mut failures = Vec::new();
    macro_rules! inspect {
        ($surface:literal, $result:expr, $ok:expr) => {{
            let result = $result;
            if let Ok(page) = &result {
                $ok(page);
            }
            let error = result.err();
            println!("b01 {label} {}: {error:?}", $surface);
            if !matches!(&error, Some(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Integrity)
            {
                failures.push(format!("{label} {}: expected Integrity, got {error:?}", $surface));
            }
            assert_eq!(acceptance_snapshot(f).await, before, "{} read mutation", $surface);
        }};
    }
    inspect!(
        "changes",
        f.handle.conversation_changes(watermark(f, 1)).await,
        |batch: &ConversationChanges| {
            bounded(batch);
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
            pending_view(entry, flag);
        }
    );
    inspect!(
        "entry",
        f.handle.conversation_entry(f.run.clone(), id).await,
        |page: &crate::conversation::EntryPage| {
            pending_view(page.entry(), flag);
        }
    );
    inspect!(
        "name-only content",
        f.handle.conversation_content(content.clone()).await,
        |page: &crate::conversation::EntryPage| {
            pending_view(page.entry(), flag);
        }
    );
    inspect!(
        "page",
        f.handle.conversation_page(ConversationQuery::Latest).await,
        |page: &crate::conversation::ConversationPage| {
            pending_view(
                page.entries()
                    .iter()
                    .find(|entry| *entry.entry_id() == id)
                    .unwrap(),
                flag,
            );
        }
    );
    inspect!(
        "exhausted rank2",
        f.handle.conversation_changes(rank2.clone()).await,
        |batch: &ConversationChanges| {
            assert!(batch.changes().is_empty() && !batch.has_more());
            assert_eq!(
                (batch.next_after().sequence(), batch.next_after().rank()),
                (batch.observed_head(), 3)
            );
            assert_eq!(batch.observed_head(), id.first_sequence());
        }
    );
    failures
}

async fn pending() -> (Fixture, EntryId, ContentCursor, LiveCursor) {
    let (f, id, content, rank2) = fixture(None, false, 0).await;
    let before = acceptance_snapshot(&f).await;
    for _ in 0..2 {
        healthy_reads(&f, id, &content, false, None, None).await;
        let entry = f
            .handle
            .conversation_entry(f.run.clone(), id)
            .await
            .unwrap();
        pending_view(entry.entry(), None);
        let batch = f.handle.conversation_changes(rank2.clone()).await.unwrap();
        assert!(batch.changes().is_empty() && !batch.has_more());
        assert_eq!(
            (batch.next_after().sequence(), batch.next_after().rank()),
            (id.first_sequence(), 3)
        );
        assert_eq!(acceptance_snapshot(&f).await, before);
    }
    settings(&f).await;
    (f, id, content, rank2)
}

async fn inject(f: &Fixture, id: EntryId, projected: Option<Value>, canonical_flag: Option<bool>) {
    let before = acceptance_snapshot(f).await;
    let mut sql = f.sql().await;
    if let Some(value) = &projected {
        let old: String = sqlx::query_scalar(
            "SELECT metadata_json FROM conversation_entries WHERE run_id=? AND entry_id=?",
        )
        .bind(f.run.as_str())
        .bind(id.to_string())
        .fetch_one(&mut sql)
        .await
        .unwrap();
        assert_eq!(old.matches("\"is_error\":null").count(), 1);
        assert_eq!(sqlx::query("UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.is_error',json(?)) WHERE run_id=? AND entry_id=?")
            .bind(value.to_string()).bind(f.run.as_str()).bind(id.to_string()).execute(&mut sql).await.unwrap().rows_affected(), 1);
        let (new, kind): (String, String) = sqlx::query_as("SELECT metadata_json,json_type(metadata_json,'$.is_error') FROM conversation_entries WHERE run_id=? AND entry_id=?")
            .bind(f.run.as_str()).bind(id.to_string()).fetch_one(&mut sql).await.unwrap();
        let expected_kind = if value.is_boolean() {
            value.to_string()
        } else {
            "integer".into()
        };
        assert_eq!(kind, expected_kind, "exact JSON type");
        assert_eq!(
            new,
            old.replacen("\"is_error\":null", &format!("\"is_error\":{value}"), 1)
        );
    }
    if let Some(flag) = canonical_flag {
        assert_eq!(sqlx::query("UPDATE tool_results SET is_error=? WHERE run_id=? AND call_id='actual' AND is_error IS NULL")
            .bind(i64::from(flag)).bind(f.run.as_str()).execute(&mut sql).await.unwrap().rows_affected(), 1);
    }
    sql.close().await.unwrap();
    let after = acceptance_snapshot(f).await;
    let mut normalized = after.clone();
    let mut cells = 0;
    for (index, enabled, column) in [
        (4, canonical_flag.is_some(), 7),
        (7, projected.is_some(), 8),
    ] {
        if !enabled {
            continue;
        }
        let original = json(&before.0[index]);
        let mut modified = json(&after.0[index]);
        assert_eq!(
            original.as_array().unwrap().len(),
            modified.as_array().unwrap().len()
        );
        for (a, b) in original
            .as_array()
            .unwrap()
            .iter()
            .zip(modified.as_array_mut().unwrap())
        {
            if (index == 4 && a[1] == "actual") || (index == 7 && a[1] == id.to_string()) {
                if index == 4 {
                    assert_eq!(a[column], Value::Null);
                    assert_eq!(b[column], Value::from(i64::from(canonical_flag.unwrap())));
                } else {
                    assert_eq!(
                        b[column],
                        Value::String(a[column].as_str().unwrap().replacen(
                            "\"is_error\":null",
                            &format!("\"is_error\":{}", projected.as_ref().unwrap()),
                            1
                        ))
                    );
                }
                b[column] = a[column].clone();
                cells += 1;
            }
        }
        assert_eq!(modified, original, "all other cells exact");
        normalized.0[index] = before.0[index].clone();
    }
    assert_eq!(
        cells,
        usize::from(projected.is_some()) + usize::from(canonical_flag.is_some())
    );
    assert_eq!(
        normalized, before,
        "all tables/schema/raw/every receipt/head/revision/epoch exact"
    );
    settings(f).await;
    println!(
        "b01 exact injection projected={projected:?} canonical={canonical_flag:?}: {cells} cells; all remaining data exact"
    );
}

#[tokio::test]
async fn a5b3_b01_pending_flags_strict_public_regression() {
    let mut failures = Vec::new();
    for (derived, canonical_damage) in [(true, false), (false, true), (true, true)] {
        for flag in [false, true] {
            let (f, id, content, rank2) = pending().await;
            let raw = canonical(&f).await;
            inject(
                &f,
                id,
                derived.then_some(Value::Bool(flag)),
                canonical_damage.then_some(flag),
            )
            .await;
            let after = acceptance_snapshot(&f).await;
            for repeat in 0..2 {
                let result = f.handle.tool_result(f.run.clone(), "actual".into()).await;
                if canonical_damage {
                    assert!(
                        matches!(result, Err(error) if error.kind() == StorageErrorKind::Integrity)
                    );
                } else {
                    assert_eq!(format!("{:?}", result.unwrap().unwrap()), raw);
                }
                assert_eq!(acceptance_snapshot(&f).await, after);
                failures.extend(observed(&f, id, &content, &rank2, derived.then_some(flag), &format!("derived={derived} canonical={canonical_damage} flag={flag} repeat={repeat}")).await);
                assert_eq!(acceptance_snapshot(&f).await, after);
            }
            f.store.close().await.unwrap();
        }
    }
    println!("b01 strict mismatch count={}", failures.len());
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn a5b3_b01_json_integer_type_and_foreign_cursor_controls() {
    for flag in [false, true] {
        let (f, id, content, rank2) = pending().await;
        let raw = canonical(&f).await;
        inject(&f, id, Some(Value::from(i64::from(flag))), None).await;
        let after = acceptance_snapshot(&f).await;
        let foreign = ContentCursor::new(
            crate::storage::ApplicationSessionId::new(),
            f.run.clone(),
            id,
            content.content_epoch(),
            content.upper_field_id().into(),
            content.upper_generation(),
            content.exclusive_upper_byte(),
        )
        .unwrap()
        .to_string()
        .parse::<ContentCursor>()
        .unwrap();
        for repeat in 0..2 {
            assert!(
                observed(
                    &f,
                    id,
                    &content,
                    &rank2,
                    None,
                    &format!("integer={flag} repeat={repeat}")
                )
                .await
                .is_empty()
            );
            assert_eq!(
                f.handle.conversation_content(foreign.clone()).await.err(),
                Some(ConversationError::CursorInvalid)
            );
            assert_eq!(acceptance_snapshot(&f).await, after);
            assert_eq!(canonical(&f).await, raw);
            assert_eq!(acceptance_snapshot(&f).await, after);
        }
        f.store.close().await.unwrap();
    }
}
