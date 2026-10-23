use super::*;
use crate::storage::{StoredEventId, conversation::projector};

async fn seed(older: usize, activity: usize, text_bytes: usize) -> Fixture {
    let mut f = Fixture::new(&"A".repeat(8192)).await;
    f.runtime(RunEvent::RunStarted).await;
    f.runtime(RunEvent::TurnStarted { number: 1 }).await;
    finish(&mut f).await;
    let mut sql = f.sql().await;
    let mut tx = sql.begin().await.unwrap();
    let (mut head, timestamp): (i64, i64) =
        sqlx::query_as("SELECT head_sequence,updated_at_ms FROM manifest")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let old_input = input(&"old synthetic text\0雪".repeat(400));
    let owner = StoredEventId::new();
    // Finite synthetic scale data, not actual tools or provider runs.
    for _ in 1..older {
        let run = RunId::new();
        head += 1;
        let accepted = head;
        let payload = serde_json::json!({"run_id":run,"input":old_input,"owner_instance_id":owner})
            .to_string();
        sqlx::query("INSERT INTO events VALUES (?,?,'run.accepted',1,?,?,NULL,NULL,?)")
            .bind(head)
            .bind(StoredEventId::new().as_str())
            .bind(timestamp)
            .bind(run.as_str())
            .bind(payload)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO runs (run_id,accepted_sequence,state,last_runtime_sequence,owner_instance_id) VALUES (?,?,'interrupted',0,?)")
            .bind(run.as_str()).bind(accepted).bind(owner.as_str()).execute(&mut *tx).await.unwrap();
        projector::apply(
            &mut tx,
            projector::Event {
                sequence: head as u64,
                run: Some(&run),
                input: projector::Input::Accepted(&old_input),
            },
        )
        .await
        .unwrap();
        head += 1;
        let payload = serde_json::json!({"run_id":run,"reason":"process_restart"}).to_string();
        sqlx::query("INSERT INTO events VALUES (?,?,'run.interrupted',1,?,?,NULL,NULL,?)")
            .bind(head)
            .bind(StoredEventId::new().as_str())
            .bind(timestamp)
            .bind(run.as_str())
            .bind(&payload)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("UPDATE runs SET terminal_sequence=?,terminal_json=? WHERE run_id=?")
            .bind(head)
            .bind(&payload)
            .bind(run.as_str())
            .execute(&mut *tx)
            .await
            .unwrap();
        projector::apply(
            &mut tx,
            projector::Event {
                sequence: head as u64,
                run: Some(&run),
                input: projector::Input::Interrupted,
            },
        )
        .await
        .unwrap();
    }
    sqlx::query("UPDATE manifest SET head_sequence=?")
        .bind(head)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sql.close().await.unwrap();
    f.run = RunId::new();
    f.handle
        .accept_run(OperationId::new(), f.run.clone(), input("newest B"))
        .await
        .unwrap();
    tools(&mut f, activity, Some(&"雪\0".repeat(text_bytes / 4))).await;
    f
}

#[tokio::test]
async fn a5b2_indexed_keysets_and_finite_read_cost_100_vs_10000() {
    let mut comparison = Vec::new();
    for older in [100, 10000] {
        for (activity, bytes) in [(2, 60_000), (2, 6_000_000), (145, 60_000)] {
            let f = seed(older, activity, bytes).await;
            let mut sql = f.sql().await;
            let head: i64 = sqlx::query_scalar("SELECT head_sequence FROM manifest")
                .fetch_one(&mut sql)
                .await
                .unwrap();
            let provenance: String =
                sqlx::query_scalar("SELECT creation_provenance_json FROM manifest")
                    .fetch_one(&mut sql)
                    .await
                    .unwrap();
            let provenance = serde_json::from_str(&provenance).unwrap();
            for query in [
                LATEST,
                BEFORE,
                PREVIOUS_PROJECTED,
                PREVIOUS_CANONICAL,
                BOUNDARY_PROJECTED,
                BOUNDARY_CANONICAL,
            ] {
                let plan = sqlx::query(sqlx::AssertSqlSafe(format!("EXPLAIN QUERY PLAN {query}")))
                    .bind(head)
                    .fetch_all(&mut sql)
                    .await
                    .unwrap();
                let plan = plan
                    .iter()
                    .map(|row| row.get::<String, _>("detail"))
                    .collect::<Vec<_>>()
                    .join(";");
                println!("a5b2 plan {plan}");
                assert!(
                    plan.contains("SEARCH")
                        && plan.contains("INDEX")
                        && !plan.contains("TEMP B-TREE")
                );
            }
            let plan = sqlx::query(sqlx::AssertSqlSafe(format!(
                "EXPLAIN QUERY PLAN {SELECTED_POSITION}"
            )))
            .bind(f.run.as_str())
            .fetch_all(&mut sql)
            .await
            .unwrap();
            let plan = plan
                .iter()
                .map(|row| row.get::<String, _>("detail"))
                .collect::<Vec<_>>()
                .join(";");
            println!("a5b2 selected acceptance plan {plan}");
            assert!(plan.contains("SEARCH b USING INDEX sqlite_autoindex_conversation_blocks_1"));
            assert!(plan.contains("SEARCH r USING INDEX sqlite_autoindex_runs_1"));
            assert!(!plan.contains("SCAN") && !plan.contains("TEMP B-TREE"));
            let accepted: i64 = sqlx::query_scalar(
                "SELECT accepted_sequence FROM conversation_blocks WHERE run_id=?",
            )
            .bind(f.run.as_str())
            .fetch_one(&mut sql)
            .await
            .unwrap();
            let plan = sqlx::query(sqlx::AssertSqlSafe(format!(
                "EXPLAIN QUERY PLAN {ACTIVITY}"
            )))
            .bind(f.run.as_str())
            .bind(accepted)
            .bind(head + 1)
            .bind(0_i64)
            .bind(65_i64)
            .fetch_all(&mut sql)
            .await
            .unwrap();
            let plan = plan
                .iter()
                .map(|row| row.get::<String, _>("detail"))
                .collect::<Vec<_>>()
                .join(";");
            println!("a5b2 within activity plan older={older} {plan}");
            assert!(
                plan.contains("SEARCH")
                    && plan.contains("conversation_entries_order")
                    && !plan.contains("SCAN")
                    && !plan.contains("TEMP B-TREE")
            );
            let plan = sqlx::query(sqlx::AssertSqlSafe(format!(
                "EXPLAIN QUERY PLAN {ACTIVITY_HEAD}"
            )))
            .bind(f.run.as_str())
            .bind(accepted)
            .bind(head)
            .bind(65_i64)
            .fetch_all(&mut sql)
            .await
            .unwrap();
            let plan = plan
                .iter()
                .map(|row| row.get::<String, _>("detail"))
                .collect::<Vec<_>>()
                .join(";");
            println!("a5b2 inclusive-head activity plan older={older} {plan}");
            assert!(
                plan.contains("SEARCH")
                    && plan.contains("conversation_entries_order")
                    && !plan.contains("SCAN")
                    && !plan.contains("TEMP B-TREE")
            );
            let hooks = Arc::new(crate::storage::test_hooks::Hooks::default());
            metrics::reset();
            let started = std::time::Instant::now();
            let page = hooks
                .scope(read(
                    &mut sql,
                    f.handle.session_id(),
                    &provenance,
                    ConversationQuery::Latest,
                ))
                .await
                .unwrap();
            let elapsed = started.elapsed().as_micros();
            let encoded = bounded_page(&page);
            let measured = hooks.measurements();
            let counts = metrics::get();
            assert_eq!(measured.projection_pages, 0);
            assert_eq!(measured.recording_commits + measured.other_commits, 0);
            assert_eq!(measured.read_transactions, 1);
            assert!(measured.conversation_bytes < 600_000);
            assert!(counts.0 <= 65 && counts.1 <= 64);
            println!(
                "a5b2 scale older={older} activity={activity} field_bytes={bytes} encoded={encoded} candidates={} decoded={} descriptors={} chunks={} bytes={} validation_bytes={} elapsed_us={elapsed}",
                counts.0,
                counts.1,
                measured.conversation_descriptors,
                measured.conversation_chunks,
                measured.conversation_bytes,
                measured.validation_payload_bytes
            );
            comparison.push((
                older,
                activity,
                counts,
                measured.conversation_descriptors,
                measured.conversation_chunks,
                measured.conversation_bytes,
                encoded,
            ));
            let before_hooks = Arc::new(crate::storage::test_hooks::Hooks::default());
            metrics::reset();
            let started = std::time::Instant::now();
            let previous = before_hooks
                .scope(read(
                    &mut sql,
                    f.handle.session_id(),
                    &provenance,
                    ConversationQuery::Before(page.previous_block().cloned().unwrap()),
                ))
                .await
                .unwrap();
            let elapsed = started.elapsed().as_micros();
            let encoded = bounded_page(&previous);
            assert!(previous.entries().is_empty());
            assert_eq!(metrics::get(), (0, 0));
            let before_measurement = before_hooks.measurements();
            assert_eq!(before_measurement.projection_pages, 0);
            assert_eq!(before_measurement.read_transactions, 1);
            assert_eq!(before_measurement.conversation_bytes, old_input_bytes());
            println!(
                "a5b2 before older={older} descriptors={} chunks={} bytes={} encoded={encoded} elapsed_us={elapsed}",
                before_measurement.conversation_descriptors,
                before_measurement.conversation_chunks,
                before_measurement.conversation_bytes
            );
            // Predecessor checks must not decode even the immediate older header or text.
            sqlx::query("UPDATE conversation_blocks SET header_json='{}' WHERE run_id<>?")
                .bind(f.run.as_str())
                .execute(&mut sql)
                .await
                .unwrap();
            sqlx::query("UPDATE conversation_chunks SET bytes=x'ff' WHERE run_id<>?")
                .bind(f.run.as_str())
                .execute(&mut sql)
                .await
                .unwrap();
            let latest = f
                .handle
                .conversation_page(ConversationQuery::Latest)
                .await
                .unwrap();
            assert_eq!(latest.block().unwrap().run_id(), &f.run);
            if let Some(cursor) = page.earlier_activity().cloned() {
                metrics::reset();
                let hooks = Arc::new(crate::storage::test_hooks::Hooks::default());
                let started = std::time::Instant::now();
                let older_page = hooks
                    .scope(read(
                        &mut sql,
                        f.handle.session_id(),
                        &provenance,
                        ConversationQuery::Within(cursor),
                    ))
                    .await
                    .unwrap();
                let elapsed = started.elapsed().as_micros();
                let encoded = bounded_page(&older_page);
                assert!(metrics::get().0 <= 65 && metrics::get().1 <= 64);
                assert_eq!(hooks.measurements().projection_pages, 0);
                println!(
                    "a5b2 within older={older} candidates={} decoded={} bytes={} encoded={encoded} elapsed_us={elapsed}",
                    metrics::get().0,
                    metrics::get().1,
                    hooks.measurements().conversation_bytes
                );
            }
            sql.close().await.unwrap();
            f.store.close().await.unwrap();
        }
    }
    for index in 0..3 {
        let short = &comparison[index];
        let long = &comparison[index + 3];
        assert_eq!(short.1, long.1);
        assert_eq!((short.2, short.3, short.4), (long.2, long.3, long.4));
        assert!(short.5.abs_diff(long.5) < 4000);
        // Sequence/cursor decimal widths are included in the exact payload, not hidden.
        assert!(short.6.abs_diff(long.6) < 4000);
    }
}

#[tokio::test]
async fn a5b2_before_reads_exactly_one_block_without_warm_replay() {
    let f = seed(100, 2, 60_000).await;
    let page = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    let cursor = page.previous_block().cloned().unwrap();
    let hooks = Arc::new(crate::storage::test_hooks::Hooks::default());
    let mut sql = f.sql().await;
    let provenance: String = sqlx::query_scalar("SELECT creation_provenance_json FROM manifest")
        .fetch_one(&mut sql)
        .await
        .unwrap();
    let provenance = serde_json::from_str(&provenance).unwrap();
    metrics::reset();
    let before = hooks
        .scope(read(
            &mut sql,
            f.handle.session_id(),
            &provenance,
            ConversationQuery::Before(cursor),
        ))
        .await
        .unwrap();
    bounded_page(&before);
    assert_ne!(before.block().unwrap().run_id(), &f.run);
    assert!(before.entries().is_empty());
    assert_eq!(metrics::get(), (0, 0));
    let m = hooks.measurements();
    assert_eq!(m.projection_pages, 0);
    assert_eq!(m.read_transactions, 1);
    println!(
        "a5b2 before descriptors={} chunks={} bytes={}",
        m.conversation_descriptors, m.conversation_chunks, m.conversation_bytes
    );
    sql.close().await.unwrap();
    f.store.close().await.unwrap();
}

fn old_input_bytes() -> usize {
    "old synthetic text\0雪".len() * 400
}

use std::sync::Arc;
