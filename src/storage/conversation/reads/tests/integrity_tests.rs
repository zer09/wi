use super::*;
use crate::storage::identifier_tests;

#[tokio::test]
async fn a5b1_corrupt_addressed_identity_order_generation_and_chunks_are_integrity() {
    for statement in [
        "UPDATE conversation_entries SET source_key=zeroblob(32) WHERE kind='assistant'",
        "UPDATE conversation_entries SET position_slot=1 WHERE kind='assistant'",
        "UPDATE conversation_entries SET metadata_json='[]' WHERE kind='assistant'",
        "UPDATE conversation_fields SET field_id=printf('%064d',1) WHERE order_key!='0'",
        "UPDATE conversation_fields SET order_key='bad' WHERE order_key!='0'",
        "UPDATE conversation_fields SET metadata_json='[]' WHERE order_key!='0'",
        "UPDATE conversation_fields SET generation=1 WHERE order_key!='0'",
        "UPDATE conversation_fields SET byte_length=byte_length+1 WHERE order_key!='0'",
        "UPDATE conversation_chunks SET bytes=x'ff' WHERE field_id!='text' AND start_byte=(SELECT MAX(start_byte) FROM conversation_chunks WHERE field_id!='text')",
        "UPDATE conversation_chunks SET start_byte=start_byte+1 WHERE field_id!='text' AND start_byte=(SELECT MAX(start_byte) FROM conversation_chunks WHERE field_id!='text')",
        "DELETE FROM conversation_chunks WHERE field_id!='text' AND start_byte=(SELECT MAX(start_byte) FROM conversation_chunks WHERE field_id!='text')",
    ] {
        let mut f = Fixture::new("anchor").await;
        f.start().await;
        f.delta(0, &"雪".repeat(16000)).await;
        let mut sql = f.sql().await;
        // Synthetic corruption deliberately bypasses referential enforcement for a bad field ID.
        sqlx::raw_sql("PRAGMA foreign_keys=OFF")
            .execute(&mut sql)
            .await
            .unwrap();
        sqlx::raw_sql(statement).execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        let error = f
            .handle
            .conversation_entry(f.run.clone(), "e:5:0".parse().unwrap())
            .await
            .err()
            .unwrap();
        assert!(
            matches!(error, ConversationError::Storage(error) if error.kind() == StorageErrorKind::Integrity),
            "{statement}: {error:?}"
        );
        let before = identifier_tests::snapshot(&f.path).await;
        assert_eq!(f.entry("e:2:0").await.entry().fields()[0].text(), "anchor");
        assert_eq!(identifier_tests::snapshot(&f.path).await, before);
        f.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn a5b1_indexed_suffix_cost_is_bounded_small_vs_large() {
    let mut observed = Vec::new();
    for repeats in [12000, 1200000] {
        let mut f = Fixture::new("anchor").await;
        f.start().await;
        let text = "雪\0\"".repeat(repeats);
        f.delta(0, &text).await;
        let before = f.store.inner.hooks.measurements();
        let page = f.entry("e:5:0").await;
        bounded(&page);
        let after = f.store.inner.hooks.measurements();
        let delta = (
            after.conversation_descriptors - before.conversation_descriptors,
            after.conversation_chunks - before.conversation_chunks,
            after.conversation_bytes - before.conversation_bytes,
        );
        assert!(delta.0 <= 130);
        assert!(delta.1 <= 8);
        assert!(delta.2 <= 65536);
        assert!(delta.2 < text.len());
        let validation_bytes = after.validation_payload_bytes - before.validation_payload_bytes;
        assert!(validation_bytes <= 4096);
        assert_eq!(after.read_transactions - before.read_transactions, 1);
        println!(
            "a5b1 suffix stored={} descriptors={} chunks={} bytes={} wire={}",
            text.len(),
            delta.0,
            delta.1,
            delta.2,
            DisplayJson::EntryPage(&page).json_size().unwrap()
        );
        observed.push((delta, validation_bytes));
        let mut sql = f.sql().await;
        for query in [
            "EXPLAIN QUERY PLAN SELECT field_id FROM conversation_fields WHERE run_id=? AND entry_id=? AND order_key<=? ORDER BY order_key DESC LIMIT 65",
            "EXPLAIN QUERY PLAN SELECT start_byte,bytes FROM conversation_chunks WHERE run_id=? AND entry_id=? AND field_id=? AND start_byte<? ORDER BY start_byte DESC LIMIT 4",
        ] {
            let chunks = query.contains("chunks");
            let query = sqlx::query(query)
                .bind(f.run.as_str())
                .bind("e:5:0")
                .bind(page.entry().fields()[0].field_id());
            let rows = if chunks {
                query.bind(i64::MAX).fetch_all(&mut sql).await.unwrap()
            } else {
                query.fetch_all(&mut sql).await.unwrap()
            };
            let details: Vec<String> = rows.iter().map(|row| row.get("detail")).collect();
            println!("a5b1 EXPLAIN {}", details.join("; "));
            assert!(
                details
                    .iter()
                    .any(|line| line.contains("SEARCH") && line.contains("INDEX"))
            );
            assert!(
                !details
                    .iter()
                    .any(|line| line.contains("SCAN") || line.contains("TEMP B-TREE"))
            );
        }
        sql.close().await.unwrap();
        f.store.close().await.unwrap();
    }
    assert_eq!(observed[0].0.0, observed[1].0.0);
    assert_eq!(observed[0].0.1, observed[1].0.1);
    assert!(observed[0].0.2.abs_diff(observed[1].0.2) <= 8192);
    assert_eq!(observed[0].1, observed[1].1);
}
