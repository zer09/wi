use super::*;
use crate::storage::{StoredEventId, conversation::projector, test_hooks::Hooks};
use std::sync::Arc;

async fn seed(count: usize, bytes: usize) -> (Fixture, LiveCursor) {
    let mut f = Fixture::new("anchor\0雪").await;
    tools(&mut f, 0, None).await;
    let mut sql = f.sql().await;
    let mut tx = sql.begin().await.unwrap();
    let (mut head, timestamp): (i64, i64) =
        sqlx::query_as("SELECT head_sequence,updated_at_ms FROM manifest")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    // Valid synthetic canonical/projection rows without claiming 10,000 real tool effects.
    for index in 0..count {
        f.sequence += 1;
        head += 1;
        let record = identifier_tests::runtime(
            &f.run,
            f.sequence,
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionStarted {
                    call_id: format!("old-{index}"),
                    tool_name: "synthetic old".into(),
                },
            },
        );
        let AppendRunRecord::Runtime(event) = &record else {
            unreachable!()
        };
        sqlx::query("INSERT INTO events VALUES (?,?,'runtime.observed',1,?,?,?,?,?)")
            .bind(head)
            .bind(StoredEventId::new().as_str())
            .bind(timestamp)
            .bind(f.run.as_str())
            .bind(&event.event_id)
            .bind(event.sequence as i64)
            .bind(serde_json::to_string(event).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO tool_results (run_id,call_id,tool_name,request_id,started_sequence) VALUES (?,?,'synthetic old',?,?)")
            .bind(f.run.as_str()).bind(format!("old-{index}")).bind(REQUEST).bind(head).execute(&mut *tx).await.unwrap();
        projector::apply(
            &mut tx,
            projector::Event::record(head as u64, &f.run, &record).unwrap(),
        )
        .await
        .unwrap();
    }
    sqlx::query("UPDATE runs SET last_runtime_sequence=? WHERE run_id=?")
        .bind(f.sequence as i64)
        .bind(f.run.as_str())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE manifest SET head_sequence=?")
        .bind(head)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sql.close().await.unwrap();
    let after = watermark(&f, head as u64);
    for index in 0..2 {
        f.runtime(RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted {
                call_id: format!("new-{index}"),
                tool_name: "synthetic new".into(),
            },
        })
        .await;
        f.handle
            .append_run_records(
                OperationId::new(),
                f.run.clone(),
                vec![AppendRunRecord::ToolResult {
                    request_id: Some(REQUEST.into()),
                    call_id: format!("new-{index}"),
                    output: "\0雪".repeat(bytes / 4),
                    is_error: false,
                }],
            )
            .await
            .unwrap();
    }
    (f, after)
}

#[tokio::test]
async fn a5b3_exact_query_plans_and_bounded_warm_cost_100_vs_10000() {
    let mut observations = Vec::new();
    for count in [100, 10000] {
        for bytes in [60000, 6000000] {
            let (f, after) = seed(count, bytes).await;
            let head = f.handle.manifest().await.unwrap().head_sequence();
            let mut sql = f.sql().await;
            let plan = sqlx::query(sqlx::AssertSqlSafe(format!("EXPLAIN QUERY PLAN {BLOCKS}")))
                .bind(after.sequence() as i64)
                .bind("~")
                .bind(head as i64)
                .fetch_all(&mut sql)
                .await
                .unwrap();
            let blocks = plan
                .iter()
                .map(|row| row.get::<String, _>("detail"))
                .collect::<Vec<_>>()
                .join(";");
            let plan = sqlx::query(sqlx::AssertSqlSafe(format!("EXPLAIN QUERY PLAN {ENTRIES}")))
                .bind(after.sequence() as i64)
                .bind("~")
                .bind("")
                .bind(head as i64)
                .fetch_all(&mut sql)
                .await
                .unwrap();
            let entries = plan
                .iter()
                .map(|row| row.get::<String, _>("detail"))
                .collect::<Vec<_>>()
                .join(";");
            println!("a5b3 exact plans history={count} blocks={blocks} entries={entries}");
            for (plan, index) in [
                (&blocks, "conversation_blocks_changed"),
                (&entries, "conversation_entries_changed"),
            ] {
                assert!(
                    plan.contains("SEARCH")
                        && plan.contains(index)
                        && !plan.contains("SCAN")
                        && !plan.contains("TEMP B-TREE")
                );
            }
            let provenance: String =
                sqlx::query_scalar("SELECT creation_provenance_json FROM manifest")
                    .fetch_one(&mut sql)
                    .await
                    .unwrap();
            let provenance = serde_json::from_str(&provenance).unwrap();
            let hooks = Arc::new(Hooks::default());
            metrics::reset();
            let start = std::time::Instant::now();
            let batch = hooks
                .scope(read(
                    &mut sql,
                    f.handle.session_id(),
                    &provenance,
                    after.clone(),
                ))
                .await
                .unwrap();
            let elapsed = start.elapsed().as_micros();
            let size = bounded(&batch);
            let candidates = metrics::get();
            let m = hooks.measurements();
            assert!(candidates.0 <= 65 && candidates.1 <= 65);
            assert_eq!(candidates.1, 2);
            assert_eq!(m.projection_pages, 0);
            assert_eq!(m.read_transactions, 1);
            assert!(m.conversation_bytes < 150000);
            assert_eq!(m.recording_commits + m.other_commits, 0);
            println!(
                "a5b3 finite history={count} field_bytes={bytes} encoded={size} candidates={candidates:?} descriptors={} chunks={} content_bytes={} validation_bytes={} elapsed_us={elapsed}",
                m.conversation_descriptors,
                m.conversation_chunks,
                m.conversation_bytes,
                m.validation_payload_bytes
            );
            observations.push((
                candidates,
                m.conversation_descriptors,
                m.conversation_chunks,
                m.conversation_bytes,
            ));
            // Untouched old text can be corrupt without entering this indexed changed range.
            sqlx::query("UPDATE conversation_chunks SET bytes=x'ff' WHERE entry_id IN (SELECT entry_id FROM conversation_entries WHERE changed_sequence<=? AND kind='tool')")
                .bind(after.sequence() as i64).execute(&mut sql).await.unwrap();
            f.handle.conversation_changes(after).await.unwrap();
            // A caught-up read must not decode any header or text, even the current ones.
            sqlx::query("UPDATE conversation_blocks SET header_json='{}'")
                .execute(&mut sql)
                .await
                .unwrap();
            let caught_hooks = Arc::new(Hooks::default());
            metrics::reset();
            let caught = caught_hooks
                .scope(read(
                    &mut sql,
                    f.handle.session_id(),
                    &provenance,
                    batch.next_after().clone(),
                ))
                .await
                .unwrap();
            assert!(caught.changes().is_empty());
            assert_eq!(metrics::get(), (0, 0, 0));
            let caught_m = caught_hooks.measurements();
            assert_eq!(
                (
                    caught_m.conversation_descriptors,
                    caught_m.conversation_chunks,
                    caught_m.conversation_bytes
                ),
                (0, 0, 0)
            );
            println!(
                "a5b3 caught-up history={count} candidates=(0,0,0) descriptors=0 chunks=0 content_bytes=0"
            );
            sql.close().await.unwrap();
            f.store.close().await.unwrap();
        }
    }
    assert_eq!(observations[0], observations[2]);
    assert_eq!(observations[1], observations[3]);
}
