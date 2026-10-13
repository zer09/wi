use super::*;
use serde_json::{Value, json};
use std::path::Path;

const MAX: u64 = i64::MAX as u64;

// Reuse the verifier's typed/hex snapshots so large integers never pass through f64.
async fn all_tables(path: &Path) -> Value {
    let mut sql = connect(path).await;
    let tables: Vec<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
            .fetch_all(&mut sql)
            .await
            .unwrap();
    let mut result = serde_json::Map::new();
    for table in tables {
        let columns: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info(?) ORDER BY cid")
                .bind(&table)
                .fetch_all(&mut sql)
                .await
                .unwrap();
        let terms = columns
            .iter()
            .map(|name| {
                let name = format!("\"{}\"", name.replace('"', "\"\""));
                format!("json_array(typeof({name}),hex({name}))")
            })
            .collect::<Vec<_>>()
            .join(",");
        // Names come only from this synthetic database's schema, with identifier escaping.
        let query = format!(
            "SELECT json_array({terms}) FROM \"{}\"",
            table.replace('"', "\"\"")
        );
        let mut rows: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(query))
            .fetch_all(&mut sql)
            .await
            .unwrap();
        rows.sort();
        result.insert(table, json!({"columns": columns, "rows": rows}));
    }
    let schema: Vec<String> = sqlx::query_scalar(
        "SELECT json_array(type,name,tbl_name,sql) FROM sqlite_schema ORDER BY type,name",
    )
    .fetch_all(&mut sql)
    .await
    .unwrap();
    result.insert("_schema".into(), json!(schema));
    let settings: (i64, i64) = sqlx::query_as("SELECT (SELECT application_id FROM pragma_application_id),(SELECT user_version FROM pragma_user_version)")
        .fetch_one(&mut sql).await.unwrap();
    result.insert("_settings".into(), json!(settings));
    sql.close().await.unwrap();
    Value::Object(result)
}

async fn state(f: &Fixture, low: u64, high_start: u64, head: u64, runs: &[RunId]) -> Value {
    let catalog = f
        .path
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("catalog.sqlite3");
    let tables = all_tables(&f.path).await;
    let catalog_tables = all_tables(&catalog).await;
    let manifest = serde_json::to_value(f.handle.manifest().await.unwrap()).unwrap();
    let low_history = f.handle.history_page(0, Some(low), 100).await.unwrap();
    let high_history = f
        .handle
        .history_page(high_start - 1, Some(head), 100)
        .await
        .unwrap();
    assert_eq!(
        low_history.records().len() + high_history.records().len(),
        tables["events"]["rows"].as_array().unwrap().len()
    );
    let mut sql = f.sql().await;
    let operations: Vec<String> =
        sqlx::query_scalar("SELECT operation_id FROM commands ORDER BY operation_id")
            .fetch_all(&mut sql)
            .await
            .unwrap();
    sql.close().await.unwrap();
    let mut receipts = Vec::new();
    for operation in operations {
        receipts.push(
            serde_json::to_value(
                f.handle
                    .lookup_receipt(operation.parse().unwrap())
                    .await
                    .unwrap()
                    .unwrap(),
            )
            .unwrap(),
        );
    }
    let mut records = Vec::new();
    let mut addressed = Vec::new();
    for run in runs {
        records.push(
            serde_json::to_value(f.handle.run_record(run.clone()).await.unwrap().unwrap()).unwrap(),
        );
        let mut sql = f.sql().await;
        let ids: Vec<String> = sqlx::query_scalar("SELECT entry_id FROM conversation_entries WHERE run_id=? ORDER BY first_sequence,position_slot")
            .bind(run.as_str()).fetch_all(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        for id in ids {
            let page = f
                .handle
                .conversation_entry(run.clone(), id.parse().unwrap())
                .await
                .unwrap();
            addressed.push(DisplayJson::EntryPage(&page).encode().unwrap());
        }
    }
    let whole_raw = match f.handle.history_page(0, None, 100).await {
        Ok(page) => json!({"count": page.records().len()}),
        Err(error) => json!({"error": error.code()}),
    };
    if head >= MAX - 1 {
        assert_eq!(whole_raw, json!({"error": "storage.integrity"}));
    }
    assert_eq!(all_tables(&f.path).await, tables);
    assert_eq!(all_tables(&catalog).await, catalog_tables);
    json!({"tables": tables, "catalog": catalog_tables, "manifest": manifest,
        "low_raw": low_history, "high_raw": high_history, "receipts": receipts,
        "records": records, "addressed": addressed, "whole_raw": whole_raw})
}

async fn readiness(f: &Fixture, head: u64, metadata: u64) {
    let mut sql = f.sql().await;
    assert!(
        sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut sql)
            .await
            .unwrap()
            .is_empty()
    );
    let checks: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut sql)
        .await
        .unwrap();
    assert_eq!(checks, ["ok"]);
    let positions: (i64, i64, i64, i64) = sqlx::query_as("SELECT (SELECT head_sequence FROM manifest),(SELECT max(sequence) FROM events),(SELECT applied_sequence FROM conversation_projection),(SELECT metadata_sequence FROM conversation_projection)")
        .fetch_one(&mut sql).await.unwrap();
    assert_eq!(
        positions,
        (head as i64, head as i64, head as i64, metadata as i64)
    );
    let mismatches: i64 = sqlx::query_scalar("SELECT count(*) FROM runs r JOIN conversation_blocks b ON b.run_id=r.run_id WHERE r.accepted_sequence<>b.accepted_sequence")
        .fetch_one(&mut sql).await.unwrap();
    assert_eq!(mismatches, 0);
    sql.close().await.unwrap();
    assert_eq!(f.handle.manifest().await.unwrap().head_sequence(), head);
}

async fn seed_rename(f: &Fixture, operation: &OperationId, old: u64) {
    let mut sql = f.sql().await;
    let triggers: Vec<String> = sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name IN ('events_no_update','commands_no_update') ORDER BY name")
        .fetch_all(&mut sql).await.unwrap();
    assert_eq!(triggers.len(), 2);
    let mut tx = sql.begin().await.unwrap();
    sqlx::query("PRAGMA defer_foreign_keys=ON")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DROP TRIGGER events_no_update")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DROP TRIGGER commands_no_update")
        .execute(&mut *tx)
        .await
        .unwrap();
    let saved: String =
        sqlx::query_scalar("SELECT receipt_json FROM commands WHERE operation_id=?")
            .bind(operation.as_str())
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let mut receipt: Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(receipt["first_sequence"], json!(old));
    assert_eq!(receipt["last_sequence"], json!(old));
    receipt["first_sequence"] = json!(MAX - 1);
    receipt["last_sequence"] = json!(MAX - 1);
    assert_eq!(
        sqlx::query(
            "UPDATE events SET sequence=? WHERE sequence=? AND event_type='session.renamed'"
        )
        .bind((MAX - 1) as i64)
        .bind(old as i64)
        .execute(&mut *tx)
        .await
        .unwrap()
        .rows_affected(),
        1
    );
    assert_eq!(sqlx::query("UPDATE commands SET first_sequence=?,last_sequence=?,receipt_json=? WHERE operation_id=?")
        .bind((MAX - 1) as i64).bind((MAX - 1) as i64).bind(receipt.to_string()).bind(operation.as_str())
        .execute(&mut *tx).await.unwrap().rows_affected(), 1);
    sqlx::query("UPDATE manifest SET head_sequence=?")
        .bind((MAX - 1) as i64)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE conversation_projection SET applied_sequence=?,metadata_sequence=?")
        .bind((MAX - 1) as i64)
        .bind((MAX - 1) as i64)
        .execute(&mut *tx)
        .await
        .unwrap();
    // Restore the exact synthetic schema DDL captured above, not weaker trigger definitions.
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
async fn a5b2_max01_inclusive_head_public_writer_and_strict_within() {
    let mut unexpected = Vec::new();
    let mut reads = 0;
    for case in ["metadata", "activity", "empty"] {
        let mut f = Fixture::new("A\0雪").await;
        let a = f.run.clone();
        let count = if case == "empty" { 0 } else { 2 };
        tools(&mut f, count, None).await;
        finish(&mut f).await;
        f.run = RunId::new();
        f.handle
            .accept_run(OperationId::new(), f.run.clone(), input("B\0雪"))
            .await
            .unwrap();
        tools(&mut f, count, None).await;
        if case != "activity" {
            finish(&mut f).await;
        }
        let operation = OperationId::new();
        let seed = f
            .handle
            .rename(operation.clone(), "synthetic seed".into())
            .await
            .unwrap();
        let ordinary = seed.receipt().last_sequence();
        let latest = f
            .handle
            .conversation_page(ConversationQuery::Latest)
            .await
            .unwrap();
        let before = latest
            .previous_block()
            .unwrap()
            .to_string()
            .parse::<BlockCursor>()
            .unwrap();
        let mut queries = vec![
            (
                "Latest",
                ConversationQuery::Latest,
                f.run.clone(),
                latest
                    .entries()
                    .iter()
                    .map(|e| e.entry_id().to_string())
                    .collect::<Vec<_>>(),
            ),
            (
                "Before",
                ConversationQuery::Before(before.clone()),
                a.clone(),
                vec![],
            ),
        ];
        let older = f
            .handle
            .conversation_page(queries[1].1.clone())
            .await
            .unwrap();
        queries[1].3 = older
            .entries()
            .iter()
            .map(|e| e.entry_id().to_string())
            .collect();
        if count > 0 {
            for (name, page) in [("Within_A", &older), ("Within_B", &latest)] {
                let entry = &page.entries()[1];
                let cursor = ActivityCursor::new(
                    f.handle.session_id().clone(),
                    entry.run_id().clone(),
                    entry.entry_id().first_sequence(),
                    entry.entry_id().position_slot(),
                )
                .unwrap();
                queries.push((
                    name,
                    ConversationQuery::Within(cursor),
                    entry.run_id().clone(),
                    vec![page.entries()[0].entry_id().to_string()],
                ));
            }
        }
        let runs = [a, f.run.clone()];
        // Only the final rename is relocated. The low and high ranges cover all stored events.
        // The huge missing middle is not a valid globally contiguous canonical/B2 prefix.
        for head in [ordinary, MAX - 1, MAX] {
            if head == MAX - 1 {
                seed_rename(&f, &operation, ordinary).await;
            }
            if head == MAX {
                let op = OperationId::new();
                if case == "activity" {
                    let record = crate::storage::identifier_tests::runtime(
                        &f.run,
                        f.sequence + 1,
                        RunEvent::ToolEvent {
                            event: ToolExecutionEvent::ToolExecutionStarted {
                                call_id: "final".into(),
                                tool_name: "synthetic final".into(),
                            },
                        },
                    );
                    let write = f
                        .handle
                        .append_run_records(op.clone(), f.run.clone(), vec![record.clone()])
                        .await
                        .unwrap();
                    assert_eq!(
                        (
                            write.receipt().first_sequence(),
                            write.receipt().last_sequence()
                        ),
                        (MAX, MAX)
                    );
                    assert!(!write.duplicate() && write.cleanup_warning().is_none());
                    let saved = state(&f, ordinary - 1, MAX - 1, head, &runs).await;
                    let duplicate = f
                        .handle
                        .append_run_records(op.clone(), f.run.clone(), vec![record])
                        .await
                        .unwrap();
                    assert!(duplicate.duplicate() && duplicate.cleanup_warning().is_none());
                    assert_eq!(duplicate.receipt(), write.receipt());
                    assert_eq!(state(&f, ordinary - 1, MAX - 1, head, &runs).await, saved);
                    queries[0].3.push(format!("e:{MAX}:0"));
                    // Production creates one entry at slot zero per event; do not fabricate slots.
                    queries.push((
                        "Within_MAX",
                        ConversationQuery::Within(
                            ActivityCursor::new(
                                f.handle.session_id().clone(),
                                f.run.clone(),
                                MAX,
                                0,
                            )
                            .unwrap(),
                        ),
                        f.run.clone(),
                        latest
                            .entries()
                            .iter()
                            .map(|e| e.entry_id().to_string())
                            .collect(),
                    ));
                } else {
                    let write = f
                        .handle
                        .rename(op.clone(), "synthetic final".into())
                        .await
                        .unwrap();
                    assert_eq!(
                        (
                            write.receipt().first_sequence(),
                            write.receipt().last_sequence()
                        ),
                        (MAX, MAX)
                    );
                    assert!(!write.duplicate() && write.cleanup_warning().is_none());
                    let saved = state(&f, ordinary - 1, MAX - 1, head, &runs).await;
                    let duplicate = f
                        .handle
                        .rename(op.clone(), "synthetic final".into())
                        .await
                        .unwrap();
                    assert!(duplicate.duplicate() && duplicate.cleanup_warning().is_none());
                    assert_eq!(duplicate.receipt(), write.receipt());
                    assert_eq!(state(&f, ordinary - 1, MAX - 1, head, &runs).await, saved);
                }
                assert_eq!(
                    f.handle
                        .lookup_receipt(op)
                        .await
                        .unwrap()
                        .unwrap()
                        .last_sequence(),
                    MAX
                );
            }
            let metadata = if head == MAX && case == "activity" {
                MAX - 1
            } else {
                head
            };
            readiness(&f, head, metadata).await;
            let high_start = if head == ordinary { ordinary } else { MAX - 1 };
            let saved = state(&f, ordinary - 1, high_start, head, &runs).await;
            for repeat in 1..=2 {
                for (name, query, run, ids) in &queries {
                    reads += 1;
                    let result = f.handle.conversation_page(query.clone()).await;
                    assert_eq!(
                        state(&f, ordinary - 1, high_start, head, &runs).await,
                        saved,
                        "read mutation {case} {head} {name}"
                    );
                    match result {
                        Ok(page) => {
                            bounded_page(&page);
                            assert_eq!(page.snapshot_head(), head);
                            assert_eq!(page.session().head_sequence(), head);
                            assert_eq!(page.block().unwrap().run_id(), run);
                            assert_eq!(
                                page.entries()
                                    .iter()
                                    .map(|e| e.entry_id().to_string())
                                    .collect::<Vec<_>>(),
                                *ids
                            );
                            assert!(page.earlier_activity().is_none());
                            if *name == "Latest" {
                                let live = page.live_after().unwrap();
                                assert_eq!((live.sequence(), live.rank()), (head, 3));
                                assert_eq!(live.session_id(), f.handle.session_id());
                                assert_eq!(page.previous_block(), Some(&before));
                            } else {
                                assert!(page.live_after().is_none());
                            }
                        }
                        Err(error) => unexpected
                            .push(format!("{case} H={head} {name} repeat={repeat}: {error}")),
                    }
                }
            }
            println!(
                "MAX01 case={case} H={head}: readiness/FK/integrity and repeated all-table/raw/receipt/addressed preservation PASS"
            );
        }
        let mut sql = f.sql().await;
        sqlx::query("UPDATE conversation_projection SET applied_sequence=?")
            .bind((MAX - 1) as i64)
            .execute(&mut sql)
            .await
            .unwrap();
        sql.close().await.unwrap();
        let damaged = all_tables(&f.path).await;
        for _ in 0..2 {
            assert_eq!(
                f.handle.manifest().await.unwrap_err().kind(),
                StorageErrorKind::Integrity
            );
            for (_, query, _, _) in &queries {
                assert!(
                    matches!(f.handle.conversation_page(query.clone()).await, Err(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Integrity)
                );
                assert_eq!(all_tables(&f.path).await, damaged);
            }
        }
        f.store.close().await.unwrap();
    }
    println!(
        "MAX01 healthy page calls={reads}; invalid-head controls remain Integrity; sparse-prefix limit retained"
    );
    assert!(
        unexpected.is_empty(),
        "MAX01 healthy reads failed: {unexpected:?}"
    );
}
