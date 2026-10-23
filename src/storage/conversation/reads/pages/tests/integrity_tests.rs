use super::*;

async fn navigation_state(f: &Fixture) -> Vec<String> {
    navigation_state_with_gap(f, None).await
}

async fn navigation_state_with_gap(f: &Fixture, gap: Option<u64>) -> Vec<String> {
    let mut state = snapshot(f).await;
    let limit = if gap.is_some() { 100 } else { 64 };
    match f.handle.history_page(0, None, limit).await {
        Ok(page) => state.push(serde_json::to_string(&page).unwrap()),
        Err(error) => {
            assert!(gap.is_some());
            assert_eq!(error.kind(), StorageErrorKind::Integrity);
            state.push("raw:storage.integrity".into());
        }
    }
    if let Some(gap) = gap {
        let head = f.handle.manifest().await.unwrap().head_sequence();
        for (after, through) in [(0, gap - 1), (gap, head)] {
            let page = f
                .handle
                .history_page(after, Some(through), 100)
                .await
                .unwrap();
            assert_eq!(page.records().len() as u64, through - after);
            state.push(serde_json::to_string(&page).unwrap());
        }
        let mut sql = f.sql().await;
        let schema: Vec<String> = sqlx::query_scalar(
            "SELECT json_array(type,name,tbl_name,sql) FROM sqlite_schema ORDER BY type,name",
        )
        .fetch_all(&mut sql)
        .await
        .unwrap();
        state.push(serde_json::to_string(&schema).unwrap());
        let versions: (i64, i64) = sqlx::query_as("SELECT (SELECT application_id FROM pragma_application_id),(SELECT user_version FROM pragma_user_version)")
            .fetch_one(&mut sql).await.unwrap();
        state.push(serde_json::to_string(&versions).unwrap());
        sql.close().await.unwrap();
    }
    let mut sql = f.sql().await;
    let operations: Vec<String> =
        sqlx::query_scalar("SELECT operation_id FROM commands ORDER BY operation_id")
            .fetch_all(&mut sql)
            .await
            .unwrap();
    sql.close().await.unwrap();
    for operation in operations {
        let receipt = f
            .handle
            .lookup_receipt(operation.parse().unwrap())
            .await
            .unwrap();
        state.push(serde_json::to_string(&receipt).unwrap());
    }
    state
}

#[tokio::test]
async fn a5b2_rb_max_b01_within_missing_canonical_boundary_is_integrity() {
    let mut unexpected = Vec::new();
    for case in [
        "healthy",
        "canonical_missing",
        "wrong_owner",
        "runless",
        "both_absent",
        "projected_missing",
        "missing_run",
        "human",
        "invalid_session",
        "future",
    ] {
        let mut f = Fixture::new("A").await;
        f.runtime(RunEvent::RunStarted).await;
        f.runtime(RunEvent::TurnStarted { number: 1 }).await;
        finish(&mut f).await;
        let a = f.run.clone();
        f.run = RunId::new();
        f.handle
            .accept_run(OperationId::new(), f.run.clone(), input("B"))
            .await
            .unwrap();
        tools(&mut f, 70, None).await;
        let before = navigation_state_with_gap(&f, Some(16)).await;
        let latest = f
            .handle
            .conversation_page(ConversationQuery::Latest)
            .await
            .unwrap();
        assert_eq!(navigation_state_with_gap(&f, Some(16)).await, before);
        assert_eq!(latest.entries().len(), 64);
        assert_eq!(latest.snapshot_head(), 79);
        bounded_page(&latest);
        // Use the real emitted boundary, not a hand-crafted substitute for the damaged case.
        let cursor = latest.earlier_activity().unwrap().clone();
        let sequence = cursor.before_entry_sequence();
        assert_eq!((sequence, cursor.before_slot()), (16, 0));
        assert_eq!(latest.entries()[0].entry_id().first_sequence(), sequence);
        let pristine = before;
        let healthy = f
            .handle
            .conversation_page(ConversationQuery::Within(cursor.clone()))
            .await
            .unwrap();
        assert_eq!(
            navigation_state_with_gap(&f, Some(sequence)).await,
            pristine
        );
        assert_eq!(healthy.entries().len(), 6);
        assert_eq!(healthy.snapshot_head(), 79);
        assert_eq!(healthy.block().unwrap().run_id(), &f.run);
        assert!(healthy.earlier_activity().is_none() && healthy.live_after().is_none());
        assert_eq!(healthy.previous_block(), latest.previous_block());
        bounded_page(&healthy);

        let missing_event = matches!(case, "canonical_missing" | "both_absent");
        let missing_entry = matches!(case, "both_absent" | "projected_missing");
        let id = format!("e:{sequence}:0");
        let mut sql = f.sql().await;
        let owner: Option<String> =
            sqlx::query_scalar("SELECT run_id FROM events WHERE sequence=?")
                .bind(sequence as i64)
                .fetch_one(&mut sql)
                .await
                .unwrap();
        assert_eq!(owner.as_deref(), Some(f.run.as_str()));
        if missing_event {
            let trigger: String =
                sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='events_no_delete'")
                    .fetch_one(&mut sql)
                    .await
                    .unwrap();
            let blocked = sqlx::query("DELETE FROM events WHERE sequence=?")
                .bind(sequence as i64)
                .execute(&mut sql)
                .await
                .unwrap_err();
            assert_eq!(
                blocked.as_database_error().unwrap().code().as_deref(),
                Some("1811")
            );
            sqlx::query("DROP TRIGGER events_no_delete")
                .execute(&mut sql)
                .await
                .unwrap();
            let blocked = sqlx::query("DELETE FROM events WHERE sequence=?")
                .bind(sequence as i64)
                .execute(&mut sql)
                .await
                .unwrap_err();
            assert_eq!(
                blocked.as_database_error().unwrap().code().as_deref(),
                Some("787")
            );
            // Inject corruption only: normal writers cannot delete immutable, FK-referenced events.
            sqlx::query("PRAGMA foreign_keys=OFF")
                .execute(&mut sql)
                .await
                .unwrap();
            assert_eq!(
                sqlx::query("DELETE FROM events WHERE sequence=?")
                    .bind(sequence as i64)
                    .execute(&mut sql)
                    .await
                    .unwrap()
                    .rows_affected(),
                1
            );
            sqlx::query(sqlx::AssertSqlSafe(trigger.as_str()))
                .execute(&mut sql)
                .await
                .unwrap();
            sqlx::query("PRAGMA foreign_keys=ON")
                .execute(&mut sql)
                .await
                .unwrap();
            let restored: String =
                sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='events_no_delete'")
                    .fetch_one(&mut sql)
                    .await
                    .unwrap();
            assert_eq!(restored, trigger);
        }
        if missing_entry {
            let mut tx = sql.begin().await.unwrap();
            for query in [
                "DELETE FROM conversation_chunks WHERE run_id=? AND entry_id=?",
                "DELETE FROM conversation_fields WHERE run_id=? AND entry_id=?",
                "DELETE FROM conversation_entries WHERE run_id=? AND entry_id=?",
            ] {
                assert_eq!(
                    sqlx::query(query)
                        .bind(f.run.as_str())
                        .bind(&id)
                        .execute(&mut *tx)
                        .await
                        .unwrap()
                        .rows_affected(),
                    1
                );
            }
            tx.commit().await.unwrap();
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
                .fetch_one(&mut sql)
                .await
                .unwrap(),
            1
        );
        let violations = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut sql)
            .await
            .unwrap();
        assert_eq!(violations.is_empty(), !missing_event);
        let sid = f.handle.session_id().clone();
        let query = match case {
            "wrong_owner" => ActivityCursor::new(sid, a, sequence, 0).unwrap(),
            "runless" => ActivityCursor::new(sid, f.run.clone(), 1, 0).unwrap(),
            "missing_run" => ActivityCursor::new(sid, RunId::new(), sequence, 0).unwrap(),
            "human" => ActivityCursor::new(sid, f.run.clone(), 7, 0).unwrap(),
            "invalid_session" => {
                ActivityCursor::new(ApplicationSessionId::new(), f.run.clone(), sequence, 0)
                    .unwrap()
            }
            "future" => ActivityCursor::new(sid, f.run.clone(), 80, 0).unwrap(),
            _ => cursor,
        };
        if matches!(case, "wrong_owner" | "runless") {
            let projected: i64 = sqlx::query_scalar("SELECT count(*) FROM conversation_entries WHERE run_id=? AND first_sequence=? AND position_slot=0")
                .bind(query.run_id().as_str()).bind(query.before_entry_sequence() as i64)
                .fetch_one(&mut sql).await.unwrap();
            assert_eq!(projected, 0);
            let actual: Option<String> =
                sqlx::query_scalar("SELECT run_id FROM events WHERE sequence=?")
                    .bind(query.before_entry_sequence() as i64)
                    .fetch_one(&mut sql)
                    .await
                    .unwrap();
            if case == "wrong_owner" {
                assert_eq!(actual.as_deref(), Some(f.run.as_str()));
            } else {
                assert!(actual.is_none());
            }
        }
        sql.close().await.unwrap();
        let damaged = navigation_state_with_gap(&f, Some(sequence)).await;
        let mut expected = pristine.clone();
        for (index, table) in [
            "events",
            "commands",
            "manifest",
            "runs",
            "tool_results",
            "conversation_projection",
            "conversation_blocks",
            "conversation_entries",
            "conversation_fields",
            "conversation_chunks",
        ]
        .into_iter()
        .enumerate()
        {
            let remove_event = table == "events" && missing_event;
            let remove_entry = table.starts_with("conversation_")
                && matches!(
                    table,
                    "conversation_entries" | "conversation_fields" | "conversation_chunks"
                )
                && missing_entry;
            if remove_event || remove_entry {
                let (prefix, rows) = expected[index].split_once(':').unwrap();
                assert_eq!(prefix, table);
                let mut rows: Vec<serde_json::Value> = serde_json::from_str(rows).unwrap();
                let bytes = if remove_event {
                    sequence.to_string()
                } else {
                    id.clone()
                };
                let hex = bytes
                    .as_bytes()
                    .iter()
                    .map(|byte| format!("{byte:02X}"))
                    .collect::<String>();
                let old_len = rows.len();
                let column = if remove_event { 0 } else { 1 };
                rows.retain(|row| row[column][1].as_str() != Some(&hex));
                assert_eq!(old_len - rows.len(), 1);
                expected[index] = format!("{table}:{}", serde_json::to_string(&rows).unwrap());
            }
        }
        if missing_event {
            // Full raw history must reject the real gap; the two populated ranges remain exact.
            expected[10] = "raw:storage.integrity".into();
        }
        assert_eq!(
            damaged, expected,
            "{case}: exact injected damage, schema/raw ranges/every receipt"
        );
        for repeat in 0..2 {
            let result = f
                .handle
                .conversation_page(ConversationQuery::Within(query.clone()))
                .await;
            assert_eq!(navigation_state_with_gap(&f, Some(sequence)).await, damaged);
            let correct = match case {
                "healthy" => {
                    let page = result.unwrap();
                    assert_eq!(
                        DisplayJson::Page(&page).encode().unwrap(),
                        DisplayJson::Page(&healthy).encode().unwrap()
                    );
                    true
                }
                "canonical_missing" => {
                    matches!(result, Err(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Integrity)
                }
                "both_absent" | "projected_missing" | "missing_run" => {
                    matches!(result, Err(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::NotFound)
                }
                _ => matches!(result, Err(ConversationError::CursorInvalid)),
            };
            if !correct {
                unexpected.push((case, repeat));
            }
        }
        println!(
            "RB-MAX-B-01 {case}: emitted Within boundary, two reads, exact table/schema/raw/receipt preservation"
        );
        f.store.close().await.unwrap();
    }
    assert!(
        unexpected.is_empty(),
        "RB-MAX-B-01 incorrect Within outcomes: {unexpected:?}"
    );
}

#[tokio::test]
async fn a5b2_rb01_selected_canonical_projected_acceptance_mismatch_is_integrity() {
    let mut unexpected = Vec::new();
    for case in ["latest_minimal", "within", "selected_older_before"] {
        let mut f = Fixture::new("A\0雪").await;
        let query = if case == "latest_minimal" {
            f.runtime(RunEvent::RunStarted).await;
            ConversationQuery::Latest
        } else {
            tools(&mut f, 2, None).await;
            let latest = f
                .handle
                .conversation_page(ConversationQuery::Latest)
                .await
                .unwrap();
            assert_eq!(latest.entries()[1].entry_id().to_string(), "e:6:0");
            if case == "within" {
                // Parse the public cursor format using an actual same-run entry boundary.
                let boundary = serde_json::json!([1, f.handle.session_id(), f.run, "6", "0"]);
                ConversationQuery::Within(
                    format!(
                        "g11s.{}",
                        base64::Engine::encode(
                            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                            boundary.to_string()
                        )
                    )
                    .parse()
                    .unwrap(),
                )
            } else {
                finish(&mut f).await;
                let b = RunId::new();
                f.handle
                    .accept_run(OperationId::new(), b.clone(), input("B"))
                    .await
                    .unwrap();
                let latest = f
                    .handle
                    .conversation_page(ConversationQuery::Latest)
                    .await
                    .unwrap();
                assert_eq!(latest.block().unwrap().run_id(), &b);
                assert_eq!(latest.block().unwrap().accepted_sequence(), 9);
                ConversationQuery::Before(
                    latest
                        .previous_block()
                        .unwrap()
                        .to_string()
                        .parse()
                        .unwrap(),
                )
            }
        };
        let healthy = navigation_state(&f).await;
        for _ in 0..2 {
            let page = f.handle.conversation_page(query.clone()).await.unwrap();
            assert_eq!(page.block().unwrap().run_id(), &f.run);
            assert_eq!(page.block().unwrap().accepted_sequence(), 2);
            assert!(page.previous_block().is_none());
            bounded_page(&page);
            if case == "latest_minimal" {
                assert_eq!(page.snapshot_head(), 3);
                assert!(page.entries().is_empty());
                assert_eq!(page.live_after().unwrap().sequence(), 3);
            } else {
                assert!(page.live_after().is_none());
                if case == "within" {
                    assert_eq!(page.entries().len(), 1);
                    assert_eq!(page.entries()[0].entry_id().to_string(), "e:5:0");
                }
            }
            assert_eq!(navigation_state(&f).await, healthy);
        }
        let mut sql = f.sql().await;
        let owner: String = sqlx::query_scalar("SELECT run_id FROM events WHERE sequence=3")
            .fetch_one(&mut sql)
            .await
            .unwrap();
        assert_eq!(owner, f.run.as_str());
        assert_eq!(
            sqlx::query(
                "UPDATE runs SET accepted_sequence=3 WHERE run_id=? AND accepted_sequence=2"
            )
            .bind(f.run.as_str())
            .execute(&mut sql)
            .await
            .unwrap()
            .rows_affected(),
            1
        );
        let relation: (i64, i64) = sqlx::query_as(
            "SELECT r.accepted_sequence,b.accepted_sequence FROM runs r JOIN conversation_blocks b ON b.run_id=r.run_id WHERE r.run_id=?",
        )
        .bind(f.run.as_str())
        .fetch_one(&mut sql)
        .await
        .unwrap();
        assert_eq!(relation, (3, 2));
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
        let accepted_column: i64 = sqlx::query_scalar(
            "SELECT cid FROM pragma_table_info('runs') WHERE name='accepted_sequence'",
        )
        .fetch_one(&mut sql)
        .await
        .unwrap();
        sql.close().await.unwrap();
        let damaged = navigation_state(&f).await;
        assert_eq!(healthy.len(), damaged.len());
        for (old, new) in healthy.iter().zip(&damaged) {
            if let Some(old) = old.strip_prefix("runs:") {
                let mut rows: serde_json::Value = serde_json::from_str(old).unwrap();
                let rows = rows.as_array_mut().unwrap();
                let row = &mut rows[0][accepted_column as usize];
                assert_eq!(*row, serde_json::json!(["integer", "32"]));
                *row = serde_json::json!(["integer", "33"]);
                assert_eq!(
                    format!("runs:{}", serde_json::to_string(&rows).unwrap()),
                    *new
                );
            } else {
                assert_eq!(old, new);
            }
        }
        for _ in 0..2 {
            let result = f.handle.conversation_page(query.clone()).await;
            assert_eq!(navigation_state(&f).await, damaged);
            if !matches!(result, Err(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Integrity)
            {
                unexpected.push(case);
            }
        }
        println!(
            "RB-A5B2-01 {case}: same-run 2->3, FK/integrity valid, one-cell injection, repeated all-table/raw/every-receipt preservation"
        );
        f.store.close().await.unwrap();
    }
    assert!(
        unexpected.is_empty(),
        "RB-A5B2-01 missing Integrity: {unexpected:?}"
    );
}

#[tokio::test]
async fn a5b2_ra01_missing_immediate_predecessor_is_integrity() {
    let mut unexpected = Vec::new();
    for (blocks, shift) in [(2, false), (3, false), (2, true)] {
        let mut f = Fixture::new("A").await;
        let oldest = navigation_state(&f).await;
        let a = f
            .handle
            .conversation_page(ConversationQuery::Latest)
            .await
            .unwrap();
        assert_eq!(a.block().unwrap().accepted_sequence(), 2);
        assert!(a.previous_block().is_none());
        let end = f
            .handle
            .conversation_page(ConversationQuery::Before(
                BlockCursor::new(f.handle.session_id().clone(), 2).unwrap(),
            ))
            .await
            .unwrap();
        assert!(end.block().is_none() && end.entries().is_empty());
        assert!(end.previous_block().is_none() && end.live_after().is_none());
        assert_eq!(navigation_state(&f).await, oldest);
        let mut predecessor = f.run.clone();
        for name in ["B", "C"].into_iter().take(blocks - 1) {
            f.runtime(RunEvent::RunStarted).await;
            f.runtime(RunEvent::TurnStarted { number: 1 }).await;
            finish(&mut f).await;
            predecessor = f.run.clone();
            f.run = RunId::new();
            f.handle
                .accept_run(OperationId::new(), f.run.clone(), input(name))
                .await
                .unwrap();
        }
        // Exercise the same predecessor check on both Latest and Within.
        tools(&mut f, 1, None).await;
        let healthy = navigation_state(&f).await;
        let latest = f
            .handle
            .conversation_page(ConversationQuery::Latest)
            .await
            .unwrap();
        assert_eq!(latest.block().unwrap().run_id(), &f.run);
        let previous = latest.previous_block().cloned().unwrap();
        let older = f
            .handle
            .conversation_page(ConversationQuery::Before(previous.clone()))
            .await
            .unwrap();
        assert_eq!(older.block().unwrap().run_id(), &predecessor);
        assert!(older.live_after().is_none());
        assert_eq!(navigation_state(&f).await, healthy);
        let within = ActivityCursor::new(
            f.handle.session_id().clone(),
            f.run.clone(),
            latest.entries()[0].entry_id().first_sequence(),
            0,
        )
        .unwrap();
        let mut sql = f.sql().await;
        let mut tx = sql.begin().await.unwrap();
        if shift {
            // Keep the predecessor ID equal while changing only its accepted position.
            assert_eq!(
                sqlx::query("UPDATE conversation_blocks SET accepted_sequence=3 WHERE run_id=?")
                    .bind(predecessor.as_str())
                    .execute(&mut *tx)
                    .await
                    .unwrap()
                    .rows_affected(),
                1
            );
        } else {
            for statement in [
                "DELETE FROM conversation_chunks WHERE run_id=?",
                "DELETE FROM conversation_fields WHERE run_id=?",
                "DELETE FROM conversation_entries WHERE run_id=?",
                "DELETE FROM conversation_blocks WHERE run_id=?",
            ] {
                assert_eq!(
                    sqlx::query(statement)
                        .bind(predecessor.as_str())
                        .execute(&mut *tx)
                        .await
                        .unwrap()
                        .rows_affected(),
                    1
                );
            }
        }
        tx.commit().await.unwrap();
        assert!(
            sqlx::query("PRAGMA foreign_key_check")
                .fetch_all(&mut sql)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM conversation_blocks")
                .fetch_one(&mut sql)
                .await
                .unwrap(),
            if shift {
                blocks as i64
            } else {
                blocks as i64 - 1
            }
        );
        sql.close().await.unwrap();
        let damaged = navigation_state(&f).await;
        for (old, new) in healthy.iter().zip(&damaged) {
            if old.starts_with("conversation_blocks:")
                || (!shift
                    && [
                        "conversation_entries:",
                        "conversation_fields:",
                        "conversation_chunks:",
                    ]
                    .iter()
                    .any(|table| old.starts_with(table)))
            {
                assert_ne!(old, new);
            } else {
                assert_eq!(old, new);
            }
        }
        for _ in 0..2 {
            for query in [
                ConversationQuery::Latest,
                ConversationQuery::Within(within.clone()),
                ConversationQuery::Before(previous.clone()),
            ] {
                let result = f.handle.conversation_page(query).await;
                assert_eq!(navigation_state(&f).await, damaged);
                if !matches!(result, Err(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Integrity)
                {
                    unexpected.push((blocks, shift));
                }
            }
        }
        println!(
            "RA01 blocks={blocks} shift={shift}: repeated Latest/Within/saved Before preserve all tables/raw/receipts"
        );
        f.store.close().await.unwrap();
    }
    assert!(
        unexpected.is_empty(),
        "RA01 missing Integrity: {unexpected:?}"
    );
}

#[tokio::test]
async fn a5b2_ra02_exact_boundary_outcome_table_and_preservation() {
    let mut unexpected = Vec::new();
    for damage in ["healthy", "shift", "missing", "different_ids"] {
        let mut f = Fixture::new("A").await;
        f.runtime(RunEvent::RunStarted).await;
        f.runtime(RunEvent::TurnStarted { number: 1 }).await;
        finish(&mut f).await;
        let b = RunId::new();
        f.handle
            .accept_run(OperationId::new(), b.clone(), input("B"))
            .await
            .unwrap();
        let sid = f.handle.session_id().clone();
        let healthy = navigation_state(&f).await;
        for (boundary, expected) in [(7, Some(&f.run)), (2, None)] {
            let page = f
                .handle
                .conversation_page(ConversationQuery::Before(
                    BlockCursor::new(sid.clone(), boundary).unwrap(),
                ))
                .await
                .unwrap();
            assert_eq!(page.block().map(|block| block.run_id()), expected);
            assert!(page.live_after().is_none());
            assert_eq!(navigation_state(&f).await, healthy);
        }
        for boundary in [1, 6, 8] {
            assert_eq!(
                f.handle
                    .conversation_page(ConversationQuery::Before(
                        BlockCursor::new(sid.clone(), boundary).unwrap(),
                    ))
                    .await
                    .err(),
                Some(ConversationError::CursorInvalid)
            );
            assert_eq!(navigation_state(&f).await, healthy);
        }
        let mut c = None;
        if damage == "different_ids" {
            f.run = b.clone();
            f.runtime(RunEvent::RunStarted).await;
            f.runtime(RunEvent::TurnStarted { number: 1 }).await;
            finish(&mut f).await;
            let run = RunId::new();
            f.handle
                .accept_run(OperationId::new(), run.clone(), input("C"))
                .await
                .unwrap();
            c = Some(run);
        }
        let before_damage = navigation_state(&f).await;
        let mut sql = f.sql().await;
        match damage {
            "shift" => {
                assert_eq!(
                    sqlx::query(
                        "UPDATE conversation_blocks SET accepted_sequence=6 WHERE run_id=?"
                    )
                    .bind(b.as_str())
                    .execute(&mut sql)
                    .await
                    .unwrap()
                    .rows_affected(),
                    1
                );
            }
            "missing" => {
                assert_eq!(
                    sqlx::query("DELETE FROM conversation_blocks WHERE run_id=?")
                        .bind(b.as_str())
                        .execute(&mut sql)
                        .await
                        .unwrap()
                        .rows_affected(),
                    1
                );
            }
            "different_ids" => {
                let c = c.as_ref().unwrap();
                let mut tx = sql.begin().await.unwrap();
                for (run, sequence) in [(c, 11_i64), (&b, 12), (c, 7)] {
                    assert_eq!(
                        sqlx::query(
                            "UPDATE conversation_blocks SET accepted_sequence=? WHERE run_id=?"
                        )
                        .bind(sequence)
                        .bind(run.as_str())
                        .execute(&mut *tx)
                        .await
                        .unwrap()
                        .rows_affected(),
                        1
                    );
                }
                tx.commit().await.unwrap();
                // Both older selections still agree on A; only boundary identity differs.
                for query in [
                    BEFORE,
                    "SELECT run_id FROM runs WHERE accepted_sequence<? ORDER BY accepted_sequence DESC LIMIT 1",
                ] {
                    let older: String = sqlx::query_scalar(query)
                        .bind(7_i64)
                        .fetch_one(&mut sql)
                        .await
                        .unwrap();
                    assert_eq!(older, "01234567-89ab-1cde-8fab-1123456789ab");
                }
            }
            _ => {}
        }
        assert!(
            sqlx::query("PRAGMA foreign_key_check")
                .fetch_all(&mut sql)
                .await
                .unwrap()
                .is_empty()
        );
        sql.close().await.unwrap();
        let damaged = navigation_state(&f).await;
        for (old, new) in before_damage.iter().zip(&damaged) {
            if damage != "healthy" && old.starts_with("conversation_blocks:") {
                assert_ne!(old, new);
            } else {
                assert_eq!(old, new);
            }
        }
        for _ in 0..2 {
            for boundary in [6, 7] {
                let result = f
                    .handle
                    .conversation_page(ConversationQuery::Before(
                        BlockCursor::new(sid.clone(), boundary).unwrap(),
                    ))
                    .await;
                assert_eq!(navigation_state(&f).await, damaged);
                let correct = if damage == "healthy" && boundary == 7 {
                    result.is_ok_and(|page| {
                        page.block().unwrap().accepted_sequence() == 2
                            && page.live_after().is_none()
                    })
                } else if boundary == 6 && damage != "shift" {
                    matches!(result, Err(ConversationError::CursorInvalid))
                } else {
                    matches!(result, Err(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Integrity)
                };
                if !correct {
                    unexpected.push((damage, boundary));
                }
            }
            // Invalid session/future cursors retain precedence even over damaged projections.
            for (session, boundary) in [(ApplicationSessionId::new(), 7), (sid.clone(), 100)] {
                assert_eq!(
                    f.handle
                        .conversation_page(ConversationQuery::Before(
                            BlockCursor::new(session, boundary).unwrap(),
                        ))
                        .await
                        .err(),
                    Some(ConversationError::CursorInvalid)
                );
                assert_eq!(navigation_state(&f).await, damaged);
            }
        }
        if damage == "healthy" {
            let mut sql = f.sql().await;
            sqlx::query("UPDATE conversation_blocks SET header_json='{}' WHERE run_id=?")
                .bind(b.as_str())
                .execute(&mut sql)
                .await
                .unwrap();
            sql.close().await.unwrap();
            let poisoned = navigation_state(&f).await;
            let page = f
                .handle
                .conversation_page(ConversationQuery::Before(BlockCursor::new(sid, 7).unwrap()))
                .await
                .unwrap();
            assert_eq!(page.block().unwrap().accepted_sequence(), 2);
            assert!(page.live_after().is_none());
            assert_eq!(navigation_state(&f).await, poisoned);
        }
        println!(
            "RA02 {damage}: boundary outcome table and repeated raw/receipt/table preservation"
        );
        f.store.close().await.unwrap();
    }
    assert!(
        unexpected.is_empty(),
        "RA02 wrong boundary outcomes: {unexpected:?}"
    );
}

pub(super) async fn snapshot(f: &Fixture) -> Vec<String> {
    let mut sql = f.sql().await;
    let mut state = Vec::new();
    for table in [
        "events",
        "commands",
        "manifest",
        "runs",
        "tool_results",
        "conversation_projection",
        "conversation_blocks",
        "conversation_entries",
        "conversation_fields",
        "conversation_chunks",
    ] {
        // Only fixed synthetic schema table/column names enter these test queries.
        let query = format!("SELECT name FROM pragma_table_info('{table}') ORDER BY cid");
        let columns: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(query))
            .fetch_all(&mut sql)
            .await
            .unwrap();
        let expression = columns
            .iter()
            .map(|column| format!("json_array(typeof({column}),hex(CAST({column} AS BLOB)))"))
            .collect::<Vec<_>>()
            .join(",");
        let query = format!(
            "SELECT json_group_array(json_array({expression})) FROM (SELECT * FROM {table} ORDER BY rowid)"
        );
        let data: String = sqlx::query_scalar(sqlx::AssertSqlSafe(query))
            .fetch_one(&mut sql)
            .await
            .unwrap();
        state.push(format!("{table}:{data}"));
    }
    sql.close().await.unwrap();
    state
}

#[tokio::test]
async fn a5b2_cursor_syntax_resource_future_and_corrupt_projection() {
    let mut f = Fixture::new("anchor").await;
    tools(&mut f, 2, None).await;
    let page = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    let head = page.snapshot_head();
    let sid = f.handle.session_id().clone();
    let other = ApplicationSessionId::new();
    for value in ["", "g11b.not-base64", "g11s.not-base64", "g11l.not-base64"] {
        assert!(value.parse::<BlockCursor>().is_err());
        assert!(value.parse::<ActivityCursor>().is_err());
    }
    let invalid = [
        ConversationQuery::Before(BlockCursor::new(other.clone(), 2).unwrap()),
        ConversationQuery::Before(BlockCursor::new(sid.clone(), head + 1).unwrap()),
        ConversationQuery::Before(BlockCursor::new(sid.clone(), 1).unwrap()),
        ConversationQuery::Before(BlockCursor::new(sid.clone(), 3).unwrap()),
        ConversationQuery::Within(ActivityCursor::new(other, f.run.clone(), 5, 0).unwrap()),
        ConversationQuery::Within(
            ActivityCursor::new(sid.clone(), f.run.clone(), head + 1, 0).unwrap(),
        ),
        ConversationQuery::Within(
            ActivityCursor::new(sid.clone(), f.run.clone(), 5, u64::MAX).unwrap(),
        ),
        ConversationQuery::Within(ActivityCursor::new(sid.clone(), f.run.clone(), 2, 0).unwrap()),
        ConversationQuery::Within(ActivityCursor::new(sid.clone(), f.run.clone(), 1, 0).unwrap()),
    ];
    let before = snapshot(&f).await;
    for query in invalid {
        assert_eq!(
            f.handle.conversation_page(query).await.err(),
            Some(ConversationError::CursorInvalid)
        );
    }
    for (run, sequence, slot) in [(RunId::new(), 5, 0), (f.run.clone(), 5, 1)] {
        let query = ConversationQuery::Within(
            ActivityCursor::new(sid.clone(), run, sequence, slot).unwrap(),
        );
        let error = f.handle.conversation_page(query).await.err().unwrap();
        assert!(
            matches!(error, ConversationError::Storage(error) if error.kind() == StorageErrorKind::NotFound)
        );
    }
    let earliest = f
        .handle
        .conversation_page(ConversationQuery::Within(
            ActivityCursor::new(sid.clone(), f.run.clone(), 5, 0).unwrap(),
        ))
        .await
        .unwrap();
    assert!(earliest.entries().is_empty() && earliest.earlier_activity().is_none());
    let end = f
        .handle
        .conversation_page(ConversationQuery::Before(BlockCursor::new(sid, 2).unwrap()))
        .await
        .unwrap();
    assert!(end.block().is_none());
    assert_eq!(snapshot(&f).await, before);
    let mut sql = f.sql().await;
    sqlx::query(
        "UPDATE conversation_entries SET first_sequence=2,position_slot=1 WHERE entry_id='e:6:0'",
    )
    .execute(&mut sql)
    .await
    .unwrap();
    sql.close().await.unwrap();
    let corrupt = snapshot(&f).await;
    for _ in 0..2 {
        let error = f
            .handle
            .conversation_page(ConversationQuery::Latest)
            .await
            .err()
            .unwrap();
        assert!(
            matches!(error, ConversationError::Storage(error) if error.kind() == StorageErrorKind::Integrity)
        );
    }
    assert_eq!(snapshot(&f).await, corrupt);
    let mut sql = f.sql().await;
    sqlx::query("UPDATE conversation_entries SET first_sequence=6,position_slot=0,source_key=zeroblob(32) WHERE entry_id='e:6:0'").execute(&mut sql).await.unwrap();
    sql.close().await.unwrap();
    let corrupt = snapshot(&f).await;
    let error = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .err()
        .unwrap();
    assert!(
        matches!(error, ConversationError::Storage(error) if error.kind() == StorageErrorKind::Integrity)
    );
    assert_eq!(snapshot(&f).await, corrupt);
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b2_page_tool_reuse_integrity_and_later_finish_controls() {
    for is_error in [false, true] {
        for output in ["", "result\0雪"] {
            let mut f = Fixture::new("anchor").await;
            tools(&mut f, 1, None).await;
            f.handle
                .append_run_records(
                    OperationId::new(),
                    f.run.clone(),
                    vec![AppendRunRecord::ToolResult {
                        request_id: Some(REQUEST.into()),
                        call_id: "call-0".into(),
                        output: output.into(),
                        is_error,
                    }],
                )
                .await
                .unwrap();
            f.runtime(RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolResultReused {
                    call_id: "call-0".into(),
                    tool_name: "synthetic tool".into(),
                },
            })
            .await;
            f.runtime(RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionFinished {
                    call_id: "call-0".into(),
                    tool_name: "synthetic tool".into(),
                    is_error,
                },
            })
            .await;
            let before = snapshot(&f).await;
            let page = f
                .handle
                .conversation_page(ConversationQuery::Latest)
                .await
                .unwrap();
            bounded_page(&page);
            assert_eq!(page.entries().len(), 2);
            let tool = &page.entries()[0];
            let reuse = &page.entries()[1];
            assert_eq!(tool.finish_recorded(), Some(true));
            assert_eq!(reuse.finish_recorded(), Some(false));
            assert_eq!(tool.is_error(), Some(is_error));
            assert_eq!(reuse.is_error(), Some(is_error));
            assert_eq!(reuse.reference().unwrap().entry_id(), tool.entry_id());
            assert!(reuse.fields().is_empty());
            assert_eq!(tool.fields().last().unwrap().text(), output);
            assert_eq!(snapshot(&f).await, before);
            let mut sql = f.sql().await;
            let metadata: String = sqlx::query_scalar(
                "SELECT metadata_json FROM conversation_entries WHERE kind='reuse'",
            )
            .fetch_one(&mut sql)
            .await
            .unwrap();
            for bad in [serde_json::json!(!is_error), serde_json::Value::Null] {
                let mut changed: serde_json::Value = serde_json::from_str(&metadata).unwrap();
                changed["is_error"] = bad;
                sqlx::query("UPDATE conversation_entries SET metadata_json=? WHERE kind='reuse'")
                    .bind(changed.to_string())
                    .execute(&mut sql)
                    .await
                    .unwrap();
                let corrupted = snapshot(&f).await;
                for _ in 0..2 {
                    let error = f
                        .handle
                        .conversation_page(ConversationQuery::Latest)
                        .await
                        .err()
                        .unwrap();
                    assert!(
                        matches!(error, ConversationError::Storage(error) if error.kind() == StorageErrorKind::Integrity)
                    );
                }
                assert_eq!(snapshot(&f).await, corrupted);
            }
            sqlx::query("UPDATE conversation_entries SET metadata_json=? WHERE kind='reuse'")
                .bind(&metadata)
                .execute(&mut sql)
                .await
                .unwrap();
            // Even a page boundary referencing reuse must check the recorded Tool descriptor.
            sqlx::query("DELETE FROM conversation_chunks WHERE field_id IN (SELECT field_id FROM conversation_fields WHERE kind='tool_result')").execute(&mut sql).await.unwrap();
            sqlx::query("DELETE FROM conversation_fields WHERE kind='tool_result'")
                .execute(&mut sql)
                .await
                .unwrap();
            sql.close().await.unwrap();
            let error = f
                .handle
                .conversation_page(ConversationQuery::Within(
                    ActivityCursor::new(
                        f.handle.session_id().clone(),
                        f.run.clone(),
                        reuse.entry_id().first_sequence(),
                        0,
                    )
                    .unwrap(),
                ))
                .await
                .err()
                .unwrap();
            assert!(
                matches!(error, ConversationError::Storage(error) if error.kind() == StorageErrorKind::Integrity)
            );
            f.store.close().await.unwrap();
        }
    }
}

#[tokio::test]
async fn a5b2_corrupt_anchor_revision_is_integrity_not_display_unavailable() {
    let f = Fixture::new("anchor").await;
    f.handle
        .rename(OperationId::new(), "later title".into())
        .await
        .unwrap();
    let mut sql = f.sql().await;
    sqlx::query("UPDATE conversation_entries SET changed_sequence=3 WHERE kind='human'")
        .execute(&mut sql)
        .await
        .unwrap();
    sql.close().await.unwrap();
    let before = snapshot(&f).await;
    let error = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .err()
        .unwrap();
    assert!(
        matches!(error, ConversationError::Storage(error) if error.kind() == StorageErrorKind::Integrity)
    );
    assert_eq!(snapshot(&f).await, before);
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b2_missing_block_and_head_corruption_are_not_empty_success() {
    for statement in [
        "DELETE FROM conversation_chunks; DELETE FROM conversation_fields; DELETE FROM conversation_entries; DELETE FROM conversation_blocks;",
        "UPDATE conversation_projection SET applied_sequence=1;",
        "UPDATE conversation_blocks SET header_json='{}';",
    ] {
        let f = Fixture::new("anchor").await;
        let mut sql = f.sql().await;
        sqlx::raw_sql(statement).execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        let before = snapshot(&f).await;
        let error = f
            .handle
            .conversation_page(ConversationQuery::Latest)
            .await
            .err()
            .unwrap();
        assert!(
            matches!(error, ConversationError::Storage(error) if error.kind() == StorageErrorKind::Integrity)
        );
        assert_eq!(snapshot(&f).await, before);
        f.store.close().await.unwrap();
    }
}
