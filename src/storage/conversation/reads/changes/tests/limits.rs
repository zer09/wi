use super::*;

#[tokio::test]
async fn a5b3_real_same_sequence_entries_use_ascii_identity_order_and_exact_ties() {
    let mut f = Fixture::new("anchor").await;
    tools(&mut f, 145, None).await;
    f.runtime(RunEvent::TurnFinished {
        number: 1,
        response_id: None,
        outcome: crate::run::TurnOutcome::Stopped {
            reason: crate::run::RunOutcome::CancelledLocally,
        },
        upstream_outcome: None,
    })
    .await;
    f.runtime(RunEvent::RunFinished {
        outcome: crate::run::RunOutcome::CancelledLocally,
        summary: crate::run::RunSummary::default(),
    })
    .await;
    let head = f.handle.manifest().await.unwrap().head_sequence();
    let mut sql = f.sql().await;
    let expected: Vec<(i64, String)> = sqlx::query_as("SELECT changed_sequence,entry_id FROM conversation_entries WHERE changed_sequence>2 ORDER BY changed_sequence,entry_id").fetch_all(&mut sql).await.unwrap();
    assert_eq!(expected.len(), 145);
    assert!(
        expected
            .iter()
            .all(|(sequence, _)| *sequence == head as i64)
    );
    assert_ne!(
        expected[0].1.parse::<EntryId>().unwrap().first_sequence(),
        5
    );
    sql.close().await.unwrap();
    let mut after = watermark(&f, 2);
    let mut actual = Vec::new();
    let mut last = Key::after(&after);
    let mut sizes = Vec::new();
    loop {
        let batch = f.handle.conversation_changes(after).await.unwrap();
        bounded(&batch);
        sizes.push(batch.changes().len());
        for change in batch.changes() {
            let k = key(change, 1);
            assert!(k > last);
            last = k;
            if let DisplayChange::EntryUpsert(change) = change {
                actual.push((
                    change.entry().revision() as i64,
                    change.entry().entry_id().to_string(),
                ));
            }
        }
        if batch.has_more() {
            assert!(Key::after(batch.next_after()) == last);
            assert_eq!(batch.next_after().sequence(), head);
            assert_ne!(batch.next_after().rank(), 3);
        }
        after = batch.next_after().clone();
        if !batch.has_more() {
            break;
        }
    }
    assert_eq!(actual, expected);
    assert_eq!(sizes, [64, 64, 18]);
    assert_eq!((after.sequence(), after.rank()), (head, 3));
    // The block cursor at the tie must include all entries regardless of identity order.
    let batch = f
        .handle
        .conversation_changes(cursor(&f, head, 1, Some(f.run.clone()), None))
        .await
        .unwrap();
    assert_eq!(batch.changes().len(), 64);
    assert!(
        batch
            .changes()
            .iter()
            .all(|change| matches!(change, DisplayChange::EntryUpsert(_)))
    );
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b3_escape_heavy_byte_splits_and_content_cursor_progress() {
    let text = "\0\"\\雪🦀".repeat(18000);
    let mut f = Fixture::new(&text).await;
    tools(&mut f, 25, Some(&text)).await;
    let mut after = watermark(&f, 1);
    let mut seen = BTreeSet::new();
    let mut batches = 0;
    let mut source = None;
    loop {
        let batch = f.handle.conversation_changes(after).await.unwrap();
        let size = bounded(&batch);
        batches += 1;
        println!(
            "a5b3 byte split batch={batches} changes={} encoded={size}",
            batch.changes().len()
        );
        for change in batch.changes() {
            let k = key(change, 1);
            assert!(seen.insert((k.sequence, k.rank, k.run, k.entry)));
            if let DisplayChange::EntryUpsert(change) = change {
                assert!(DisplayJson::Entry(change.entry()).encode().unwrap().len() <= ENTRY_BYTES);
                assert!(
                    DisplayJson::Entry(change.block().human())
                        .encode()
                        .unwrap()
                        .len()
                        <= ENTRY_BYTES
                );
                assert!(change.entry().earlier_content().is_some());
                if change.entry().kind() == EntryKind::Tool && source.is_none() {
                    source = Some(change.entry().clone());
                }
            }
        }
        after = batch.next_after().clone();
        if !batch.has_more() {
            break;
        }
    }
    assert!(batches > 1);
    assert_eq!(seen.len(), 27);
    let entry = source.unwrap();
    let mut restored = BTreeMap::<String, String>::new();
    for field in entry.fields() {
        restored.insert(field.field_id().into(), field.text().into());
    }
    let mut continuation = entry.earlier_content().cloned();
    let mut pages = 0;
    while let Some(cursor) = continuation {
        let boundary = cursor.exclusive_upper_byte();
        let page = f.handle.conversation_content(cursor).await.unwrap();
        for field in page.entry().fields() {
            restored
                .entry(field.field_id().into())
                .or_default()
                .insert_str(0, field.text());
        }
        continuation = page.entry().earlier_content().cloned();
        if let Some(next) = &continuation {
            assert!(
                next.exclusive_upper_byte() < boundary
                    || next.upper_field_id() != page.entry().fields().last().unwrap().field_id()
            );
        }
        pages += 1;
        assert!(pages < 1000);
    }
    assert!(restored.values().any(|value| value == &text));
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b3_legacy_header_fitting_stops_without_skip_or_truncation() {
    for bytes in [PAGE_BYTES + 1, PAGE_BYTES - 2500] {
        let mut f = Fixture::new(&"雪".repeat(20000)).await;
        tools(&mut f, 2, Some(&"\0".repeat(60000))).await;
        f.runtime(RunEvent::TurnFinished {
            number: 1,
            response_id: None,
            outcome: crate::run::TurnOutcome::Stopped {
                reason: crate::run::RunOutcome::CancelledLocally,
            },
            upstream_outcome: None,
        })
        .await;
        f.runtime(RunEvent::RunFinished {
            outcome: crate::run::RunOutcome::CancelledLocally,
            summary: crate::run::RunSummary::default(),
        })
        .await;
        let mut sql = f.sql().await;
        // Synthetic historical header injection. Genuine schema2 legacy preservation is retained separately.
        sqlx::query("UPDATE conversation_blocks SET header_json=json_set(header_json,'$.summary.last_request_id',?)")
            .bind("x".repeat(bytes)).execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        let before = identifier_tests::snapshot(&f.path).await;
        let result = f.handle.conversation_changes(watermark(&f, 1)).await;
        if bytes > PAGE_BYTES {
            assert_eq!(result.err(), Some(ConversationError::DisplayUnavailable));
        } else {
            let batch = result.unwrap();
            let size = bounded(&batch);
            assert_eq!(batch.changes().len(), 1);
            assert!(batch.has_more());
            let DisplayChange::EntryUpsert(change) = &batch.changes()[0] else {
                panic!("first human upsert")
            };
            let block = change.block();
            assert_eq!(
                block.summary().unwrap().last_request_id().unwrap().len(),
                bytes
            );
            println!(
                "a5b3 legacy mandatory_bytes={bytes} encoded={size} compact_anchor={} next_rank={}",
                DisplayJson::Entry(block.human()).encode().unwrap().len(),
                batch.next_after().rank()
            );
            let mut after = batch.next_after().clone();
            let mut count = 1;
            loop {
                let next = f.handle.conversation_changes(after).await.unwrap();
                bounded(&next);
                assert_eq!(next.changes().len(), 1);
                count += 1;
                after = next.next_after().clone();
                if !next.has_more() {
                    break;
                }
            }
            assert_eq!(count, 4);
        }
        assert_eq!(identifier_tests::snapshot(&f.path).await, before);
        f.store.close().await.unwrap();
    }
}

async fn relocate_rename(f: &Fixture, operation: &OperationId, old: u64, target: u64) {
    let mut sql = f.sql().await;
    let triggers:Vec<String>=sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name IN ('events_no_update','commands_no_update') ORDER BY name").fetch_all(&mut sql).await.unwrap();
    let mut tx = sql.begin().await.unwrap();
    sqlx::raw_sql("PRAGMA defer_foreign_keys=ON; DROP TRIGGER events_no_update; DROP TRIGGER commands_no_update").execute(&mut *tx).await.unwrap();
    let receipt: String =
        sqlx::query_scalar("SELECT receipt_json FROM commands WHERE operation_id=?")
            .bind(operation.as_str())
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let mut receipt: serde_json::Value = serde_json::from_str(&receipt).unwrap();
    receipt["first_sequence"] = serde_json::json!(target);
    receipt["last_sequence"] = serde_json::json!(target);
    sqlx::query("UPDATE events SET sequence=? WHERE sequence=?")
        .bind(target as i64)
        .bind(old as i64)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE commands SET first_sequence=?,last_sequence=?,receipt_json=? WHERE operation_id=?",
    )
    .bind(target as i64)
    .bind(target as i64)
    .bind(receipt.to_string())
    .bind(operation.as_str())
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("UPDATE manifest SET head_sequence=?")
        .bind(target as i64)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE conversation_projection SET applied_sequence=?,metadata_sequence=?")
        .bind(target as i64)
        .bind(target as i64)
        .execute(&mut *tx)
        .await
        .unwrap();
    for ddl in triggers {
        sqlx::query(sqlx::AssertSqlSafe(ddl))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    sql.close().await.unwrap();
}

#[tokio::test]
async fn a5b3_max_and_above_2pow53_public_writes_without_successor_binding() {
    for maximum in [(1u64 << 53) + 1, i64::MAX as u64] {
        for activity in [false, true] {
            let mut f = Fixture::new("anchor").await;
            tools(&mut f, 0, None).await;
            let operation = OperationId::new();
            let seed = f
                .handle
                .rename(operation.clone(), "seed".into())
                .await
                .unwrap();
            relocate_rename(&f, &operation, seed.receipt().last_sequence(), maximum - 1).await;
            if activity {
                f.runtime(RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolExecutionStarted {
                        call_id: "at maximum".into(),
                        tool_name: "synthetic".into(),
                    },
                })
                .await;
            } else {
                f.handle
                    .rename(OperationId::new(), "at maximum".into())
                    .await
                    .unwrap();
            }
            let head = f.handle.manifest().await.unwrap().head_sequence();
            assert_eq!(head, maximum);
            let before = identifier_tests::snapshot(&f.path).await;
            for after in [
                watermark(&f, maximum - 2),
                watermark(&f, maximum - 1),
                watermark(&f, maximum),
            ] {
                let batch = f.handle.conversation_changes(after).await.unwrap();
                bounded(&batch);
                assert_eq!(batch.observed_head(), maximum);
                assert_eq!(
                    (batch.next_after().sequence(), batch.next_after().rank()),
                    (maximum, 3)
                );
                if activity && !batch.changes().is_empty() {
                    assert!(batch.changes().iter().any(|c| matches!(c,DisplayChange::EntryUpsert(c) if c.entry().entry_id().first_sequence()==maximum)));
                }
            }
            assert_eq!(identifier_tests::snapshot(&f.path).await, before);
            let mut sql = f.sql().await;
            assert!(
                sqlx::query("PRAGMA foreign_key_check")
                    .fetch_all(&mut sql)
                    .await
                    .unwrap()
                    .is_empty()
            );
            sql.close().await.unwrap();
            // This supported local fixture has a sparse middle, not a complete canonical replay prefix.
            assert_eq!(
                f.handle
                    .history_page(0, None, 128)
                    .await
                    .unwrap_err()
                    .kind(),
                StorageErrorKind::Integrity
            );
            println!(
                "a5b3 sparse numeric U={maximum} activity={activity} PASS; full-prefix raw read remains Integrity"
            );
            f.store.close().await.unwrap();
        }
    }
}
