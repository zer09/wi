use super::*;

mod integration_remediation;
mod tool_finish;

// Compare all ten logical tables, schema bytes/settings, raw outcomes and every receipt.
async fn acceptance_snapshot(
    f: &Fixture,
) -> (Vec<String>, Vec<Option<crate::storage::CommitReceipt>>) {
    let mut values = identifier_tests::snapshot(&f.path).await;
    let mut sql = f.sql().await;
    for query in [
        "SELECT json_group_array(json_array(type,name,tbl_name,hex(sql))) FROM (SELECT * FROM sqlite_schema ORDER BY type,name)",
        "SELECT json_array((SELECT application_id FROM pragma_application_id),(SELECT user_version FROM pragma_user_version),(SELECT schema_version FROM manifest))",
    ] {
        values.push(sqlx::query_scalar(query).fetch_one(&mut sql).await.unwrap());
    }
    let operations: Vec<String> =
        sqlx::query_scalar("SELECT operation_id FROM commands ORDER BY operation_id")
            .fetch_all(&mut sql)
            .await
            .unwrap();
    sql.close().await.unwrap();
    for (after, through) in [(0, None), (0, Some(2)), (2, None)] {
        values.push(match f.handle.history_page(after, through, 128).await {
            Ok(page) => serde_json::to_string(&page).unwrap(),
            Err(error) => error.code().into(),
        });
    }
    let mut receipts = Vec::new();
    for operation in operations {
        receipts.push(
            f.handle
                .lookup_receipt(operation.parse().unwrap())
                .await
                .unwrap(),
        );
    }
    (values, receipts)
}

async fn acceptance_read(f: &Fixture, after: LiveCursor) -> Result<ConversationChanges> {
    let before = acceptance_snapshot(f).await;
    let position = (after.sequence(), after.rank());
    let result = f.handle.conversation_changes(after).await;
    assert_eq!(acceptance_snapshot(f).await, before);
    match &result {
        Ok(batch) => println!(
            "a5b3 a01 preserved position={position:?} changes={} more={} head={}",
            batch.changes().len(),
            batch.has_more(),
            batch.observed_head()
        ),
        Err(error) => println!("a5b3 a01 preserved position={position:?} error={error:?}"),
    }
    result
}

async fn acceptance_damage(statement: &'static str) {
    let f = Fixture::new("actual human\0雪").await;
    let page = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    let human = page.block().unwrap().human();
    assert_eq!((page.snapshot_head(), human.revision()), (2, 2));
    let rank2 = cursor(
        &f,
        human.revision(),
        2,
        Some(f.run.clone()),
        Some(*human.entry_id()),
    );
    let rank1 = cursor(&f, 2, 1, Some(f.run.clone()), None);
    for _ in 0..2 {
        let batch = acceptance_read(&f, rank2.clone()).await.unwrap();
        assert!(batch.changes().is_empty() && !batch.has_more());
        assert_eq!(
            (
                batch.observed_head(),
                batch.next_after().sequence(),
                batch.next_after().rank()
            ),
            (2, 2, 3)
        );
        assert_eq!(
            acceptance_read(&f, rank1.clone())
                .await
                .unwrap()
                .changes()
                .len(),
            1
        );
    }
    let mut sql = f.sql().await;
    // Normal writers do not delete runs or move acceptance. FK-enabled deletion is rejected.
    assert!(
        sqlx::query("DELETE FROM runs WHERE run_id=?")
            .bind(f.run.as_str())
            .execute(&mut sql)
            .await
            .is_err()
    );
    // Deliberately invalid canonical fixtures, not healthy histories. Restore FK enforcement before reads.
    if statement.starts_with("DELETE") {
        sqlx::query("PRAGMA foreign_keys=OFF")
            .execute(&mut sql)
            .await
            .unwrap();
    }
    sqlx::raw_sql(statement).execute(&mut sql).await.unwrap();
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut sql)
        .await
        .unwrap();
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut sql)
        .await
        .unwrap()
        .len();
    assert_eq!(
        violations,
        if statement.starts_with("DELETE") {
            2
        } else {
            0
        }
    );
    sql.close().await.unwrap();
    for _ in 0..2 {
        assert!(
            matches!(acceptance_read(&f, rank1.clone()).await, Err(ConversationError::Storage(error)) if error.kind()==StorageErrorKind::Integrity)
        );
        let result = acceptance_read(&f, rank2.clone()).await;
        assert!(
            matches!(result, Err(ConversationError::Storage(error)) if error.kind()==StorageErrorKind::Integrity),
            "{statement}: rank 2 must reject damaged canonical acceptance"
        );
    }
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b3_a01_exhausted_human_cursor_rejects_deleted_run() {
    acceptance_damage("DELETE FROM runs").await;
}

#[tokio::test]
async fn a5b3_a01_exhausted_human_cursor_rejects_moved_acceptance() {
    acceptance_damage("UPDATE runs SET accepted_sequence=1").await;
}

#[tokio::test]
async fn a5b3_a01_acceptance_guard_preserves_addressed_error_precedence() {
    for damage in [
        "entry",
        "entry_run",
        "entry_run_block",
        "source",
        "first",
        "first_entry",
    ] {
        let mut f = Fixture::new("actual human\0雪").await;
        let mut id: EntryId = "e:2:0".parse().unwrap();
        if damage.starts_with("first") {
            f.start().await;
            f.delta(0, "saved").await;
            id = *f.entry("e:5:0").await.entry().entry_id();
        }
        let head = f.handle.manifest().await.unwrap().head_sequence();
        let mut sql = f.sql().await;
        let schema: String = sqlx::query_scalar("SELECT json_group_array(json_array(name,hex(sql))) FROM (SELECT * FROM sqlite_schema ORDER BY name)").fetch_one(&mut sql).await.unwrap();
        // Absence controls intentionally bypass FKs; canonical first-event removal also bypasses its trigger.
        sqlx::query("PRAGMA foreign_keys=OFF")
            .execute(&mut sql)
            .await
            .unwrap();
        if damage.starts_with("entry") || damage == "first_entry" {
            for statement in [
                "DELETE FROM conversation_chunks WHERE entry_id=?",
                "DELETE FROM conversation_fields WHERE entry_id=?",
                "DELETE FROM conversation_entries WHERE entry_id=?",
            ] {
                sqlx::query(statement)
                    .bind(id.to_string())
                    .execute(&mut sql)
                    .await
                    .unwrap();
            }
        }
        if damage.contains("run") {
            sqlx::query("DELETE FROM runs")
                .execute(&mut sql)
                .await
                .unwrap();
        }
        if damage.ends_with("block") {
            sqlx::query("DELETE FROM conversation_blocks")
                .execute(&mut sql)
                .await
                .unwrap();
        }
        if damage == "source" {
            sqlx::query("UPDATE conversation_entries SET source_key=zeroblob(32)")
                .execute(&mut sql)
                .await
                .unwrap();
        }
        if damage.starts_with("first") {
            let trigger: String =
                sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='events_no_delete'")
                    .fetch_one(&mut sql)
                    .await
                    .unwrap();
            sqlx::raw_sql("DROP TRIGGER events_no_delete; DELETE FROM events WHERE sequence=5")
                .execute(&mut sql)
                .await
                .unwrap();
            sqlx::query(sqlx::AssertSqlSafe(trigger))
                .execute(&mut sql)
                .await
                .unwrap();
        }
        sqlx::query("PRAGMA foreign_keys=ON")
            .execute(&mut sql)
            .await
            .unwrap();
        assert_eq!(sqlx::query_scalar::<_, String>("SELECT json_group_array(json_array(name,hex(sql))) FROM (SELECT * FROM sqlite_schema ORDER BY name)").fetch_one(&mut sql).await.unwrap(), schema);
        sql.close().await.unwrap();
        for _ in 0..2 {
            // Existing first-event owner mismatch wins even if the addressed entry/run is absent.
            let wrong = cursor(&f, 2, 2, Some(RunId::new()), Some("e:2:0".parse().unwrap()));
            assert_eq!(
                acceptance_read(&f, wrong).await.err(),
                Some(ConversationError::CursorInvalid)
            );
            let absent = cursor(
                &f,
                2,
                2,
                Some(f.run.clone()),
                Some("e:2:1".parse().unwrap()),
            );
            assert!(
                matches!(acceptance_read(&f, absent).await, Err(ConversationError::Storage(error)) if error.kind()==StorageErrorKind::NotFound)
            );
            let addressed = cursor(&f, head, 2, Some(f.run.clone()), Some(id));
            let expected = if damage == "source" || damage == "first" {
                StorageErrorKind::Integrity
            } else {
                StorageErrorKind::NotFound
            };
            assert!(
                matches!(acceptance_read(&f, addressed).await, Err(ConversationError::Storage(error)) if error.kind()==expected),
                "{damage}"
            );
        }
        f.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn a5b3_a01_exact_scalar_acceptance_plan_and_zero_content_caught_up() {
    let f = Fixture::new("actual human\0雪").await;
    let mut sql = f.sql().await;
    let plan = sqlx::query(sqlx::AssertSqlSafe(format!(
        "EXPLAIN QUERY PLAN {ACCEPTANCE}"
    )))
    .bind(f.run.as_str())
    .fetch_all(&mut sql)
    .await
    .unwrap();
    let details: Vec<String> = plan.iter().map(|row| row.get("detail")).collect();
    println!("a5b3 a01 exact acceptance plan={details:?}");
    assert_eq!(details.len(), 3);
    for detail in &details {
        assert!(
            detail.contains("SEARCH")
                && !detail.contains("SCAN")
                && !detail.contains("TEMP B-TREE")
        );
    }
    assert!(
        details
            .iter()
            .any(|detail| detail.contains("sqlite_autoindex_conversation_blocks_1"))
    );
    assert!(
        details
            .iter()
            .any(|detail| detail.contains("sqlite_autoindex_runs_1"))
    );
    assert!(
        details
            .iter()
            .any(|detail| detail.contains("INTEGER PRIMARY KEY"))
    );
    sql.close().await.unwrap();
    let before = acceptance_snapshot(&f).await;
    // Public reads run in owned SQL tasks with the store's hooks, not this waiter's task-local hooks.
    let initial = f.store.inner.hooks.measurements();
    let batch = f
        .handle
        .conversation_changes(cursor(
            &f,
            2,
            2,
            Some(f.run.clone()),
            Some("e:2:0".parse().unwrap()),
        ))
        .await
        .unwrap();
    let measurements = f.store.inner.hooks.measurements();
    assert!(batch.changes().is_empty() && !batch.has_more());
    assert_eq!(acceptance_snapshot(&f).await, before);
    assert_eq!(
        measurements.read_transactions - initial.read_transactions,
        1
    );
    assert_eq!(
        measurements.conversation_descriptors,
        initial.conversation_descriptors
    );
    assert_eq!(
        measurements.conversation_chunks,
        initial.conversation_chunks
    );
    assert_eq!(measurements.conversation_bytes, initial.conversation_bytes);
    // Existing session identity validation still reads the creation payload, not the run acceptance.
    println!(
        "a5b3 a01 scalar rank2 caught-up read_transactions=1 descriptors=0 chunks=0 content_bytes=0 validation_payload_bytes={}",
        measurements.validation_payload_bytes - initial.validation_payload_bytes
    );
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b3_cursor_classifications_and_read_only_tables_raw_ranges_receipts() {
    let mut f = Fixture::new("anchor").await;
    tools(&mut f, 2, Some("saved\0雪")).await;
    let head = f.handle.manifest().await.unwrap().head_sequence();
    let before = identifier_tests::snapshot(&f.path).await;
    let raw = serde_json::to_value(f.handle.history_page(0, None, 128).await.unwrap()).unwrap();
    let mut sql = f.sql().await;
    let operations: Vec<String> =
        sqlx::query_scalar("SELECT operation_id FROM commands ORDER BY operation_id")
            .fetch_all(&mut sql)
            .await
            .unwrap();
    sql.close().await.unwrap();
    let mut receipts = Vec::new();
    for operation in &operations {
        receipts.push(
            f.handle
                .lookup_receipt(operation.parse().unwrap())
                .await
                .unwrap(),
        );
    }
    let wrong_session = LiveCursor::new(
        crate::storage::ApplicationSessionId::new(),
        1,
        3,
        None,
        None,
    )
    .unwrap();
    let invalid = [
        wrong_session,
        watermark(&f, head + 1),
        watermark(&f, u64::MAX),
        cursor(&f, 2, 0, None, None),
        cursor(&f, 1, 1, Some(f.run.clone()), None),
        cursor(
            &f,
            head,
            2,
            Some(f.run.clone()),
            Some("e:2:0".parse().unwrap()),
        ),
        cursor(
            &f,
            head,
            2,
            Some(f.run.clone()),
            Some(EntryId::new(2, i64::MAX as u64 + 1).unwrap()),
        ),
    ];
    for cursor in invalid {
        assert_eq!(
            f.handle.conversation_changes(cursor).await.err(),
            Some(ConversationError::CursorInvalid)
        );
    }
    for cursor in [
        cursor(&f, 2, 1, Some(RunId::new()), None),
        cursor(
            &f,
            head,
            2,
            Some(f.run.clone()),
            Some("e:2:1".parse().unwrap()),
        ),
    ] {
        assert!(
            matches!(f.handle.conversation_changes(cursor).await, Err(ConversationError::Storage(error)) if error.kind()==StorageErrorKind::NotFound)
        );
    }
    let wrong_owner = cursor(
        &f,
        head,
        2,
        Some(RunId::new()),
        Some("e:2:0".parse().unwrap()),
    );
    assert_eq!(
        f.handle.conversation_changes(wrong_owner).await.err(),
        Some(ConversationError::CursorInvalid)
    );
    for rank in [1, 2] {
        let position = cursor(
            &f,
            2,
            rank,
            Some(f.run.clone()),
            if rank == 2 {
                Some("e:2:0".parse().unwrap())
            } else {
                None
            },
        );
        bounded(&f.handle.conversation_changes(position).await.unwrap());
    }
    bounded(
        &f.handle
            .conversation_changes(watermark(&f, 1))
            .await
            .unwrap(),
    );
    bounded(
        &f.handle
            .conversation_changes(watermark(&f, head))
            .await
            .unwrap(),
    );
    assert_eq!(identifier_tests::snapshot(&f.path).await, before);
    assert_eq!(
        serde_json::to_value(f.handle.history_page(0, None, 128).await.unwrap()).unwrap(),
        raw
    );
    for (operation, saved) in operations.iter().zip(receipts) {
        assert_eq!(
            f.handle
                .lookup_receipt(operation.parse().unwrap())
                .await
                .unwrap(),
            saved
        );
    }
    let (admitted, opened, retired, _) = f.store.inner.lifecycle.gauge();
    assert_eq!(admitted, 0);
    assert_eq!(opened, retired);
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b3_corrupt_projection_and_selected_tool_facts_never_become_empty() {
    for statement in [
        "UPDATE conversation_projection SET applied_sequence=1",
        "UPDATE conversation_blocks SET header_json='{}'",
        "UPDATE conversation_blocks SET accepted_sequence=3",
        "UPDATE conversation_entries SET source_key=zeroblob(32) WHERE kind='tool'",
        "UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.is_error',json('true')) WHERE kind='tool'",
        // SQL true stores JSON integer 1. Keep this separate decoder-type rejection.
        "UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.is_error',true) WHERE kind='tool'",
        "DELETE FROM conversation_chunks WHERE field_id<>'text'; DELETE FROM conversation_fields WHERE kind='tool_result'",
        "DROP INDEX conversation_entries_changed",
    ] {
        let mut f = Fixture::new("anchor").await;
        tools(&mut f, 1, Some("saved result")).await;
        let mut sql = f.sql().await;
        sqlx::raw_sql(statement).execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        let before = identifier_tests::snapshot(&f.path).await;
        for _ in 0..2 {
            assert!(
                matches!(f.handle.conversation_changes(watermark(&f, 1)).await, Err(ConversationError::Storage(error)) if error.kind()==StorageErrorKind::Integrity),
                "{statement}"
            );
            assert_eq!(identifier_tests::snapshot(&f.path).await, before);
        }
        f.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn a5b3_missing_canonical_cursor_resource_is_integrity_not_missing_or_empty() {
    for block in [false, true] {
        let mut f = Fixture::new("anchor").await;
        tools(&mut f, 1, Some("result")).await;
        let mut sql = f.sql().await;
        sqlx::query("PRAGMA foreign_keys=OFF")
            .execute(&mut sql)
            .await
            .unwrap();
        if block {
            sqlx::query("DELETE FROM runs WHERE run_id=?")
                .bind(f.run.as_str())
                .execute(&mut sql)
                .await
                .unwrap();
        } else {
            let trigger: String =
                sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='events_no_delete'")
                    .fetch_one(&mut sql)
                    .await
                    .unwrap();
            sqlx::raw_sql("DROP TRIGGER events_no_delete; DELETE FROM events WHERE sequence=5")
                .execute(&mut sql)
                .await
                .unwrap();
            sqlx::query(sqlx::AssertSqlSafe(trigger))
                .execute(&mut sql)
                .await
                .unwrap();
        }
        sqlx::query("PRAGMA foreign_keys=ON")
            .execute(&mut sql)
            .await
            .unwrap();
        sql.close().await.unwrap();
        let before = identifier_tests::snapshot(&f.path).await;
        let after = if block {
            cursor(&f, 2, 1, Some(f.run.clone()), None)
        } else {
            cursor(
                &f,
                5,
                2,
                Some(f.run.clone()),
                Some("e:5:0".parse().unwrap()),
            )
        };
        assert!(
            matches!(f.handle.conversation_changes(after).await,Err(ConversationError::Storage(error)) if error.kind()==StorageErrorKind::Integrity)
        );
        assert!(
            matches!(f.handle.conversation_changes(watermark(&f,1)).await,Err(ConversationError::Storage(error)) if error.kind()==StorageErrorKind::Integrity)
        );
        assert_eq!(identifier_tests::snapshot(&f.path).await, before);
        f.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn a5b3_block_and_entry_live_positions_survive_newer_revisions() {
    let mut f = Fixture::new("anchor").await;
    let block = cursor(&f, 2, 1, Some(f.run.clone()), None);
    f.start().await;
    f.delta(0, "before").await;
    let page = f.entry("e:5:0").await;
    assert_eq!(page.entry().revision(), 6);
    let entry = cursor(
        &f,
        page.entry().revision(),
        2,
        Some(f.run.clone()),
        Some(*page.entry().entry_id()),
    );
    f.delta(0, " after").await;
    for after in [block, entry] {
        let batch = acceptance_read(&f, after).await.unwrap();
        bounded(&batch);
        assert_eq!(batch.observed_head(), 7);
        assert!(batch.changes().iter().any(|change| matches!(change, DisplayChange::EntryUpsert(change) if change.entry().entry_id()==page.entry().entry_id() && change.entry().revision()==7 && change.entry().fields().iter().any(|field| field.text()=="before after"))));
    }
    f.store.close().await.unwrap();
}
