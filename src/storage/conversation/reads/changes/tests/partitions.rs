use super::*;
use crate::storage::{StoredEventId, conversation::projector};

#[tokio::test]
async fn a5b3_metadata_block_entry_ranks_and_partition_lookahead() {
    let f = Fixture::new("anchor").await;
    let mut sql = f.sql().await;
    let mut tx = sql.begin().await.unwrap();
    let mut head = 2_i64;
    let timestamp: i64 = sqlx::query_scalar("SELECT updated_at_ms FROM manifest")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let owner = StoredEventId::new();
    let old_input = input("synthetic anchor");
    // Separate valid projected blocks exercise both changed-index partitions together.
    // These SQL-seeded rows are not claimed as real provider/tool runs or receipts.
    for _ in 0..70 {
        let run = RunId::new();
        head += 1;
        let accepted = head;
        sqlx::query("INSERT INTO events VALUES (?,?,'run.accepted',1,?,?,NULL,NULL,?)")
            .bind(head)
            .bind(StoredEventId::new().as_str())
            .bind(timestamp)
            .bind(run.as_str())
            .bind(
                serde_json::json!({"run_id":run,"input":old_input,"owner_instance_id":owner})
                    .to_string(),
            )
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
    }
    sqlx::query("UPDATE manifest SET head_sequence=?")
        .bind(head)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sql.close().await.unwrap();
    let renamed = f
        .handle
        .rename(OperationId::new(), "same-sequence metadata".into())
        .await
        .unwrap();
    let head = renamed.receipt().last_sequence();
    let mut sql = f.sql().await;
    // A synthetic coalesced revision creates ties across runs and all three ranks.
    // Canonical admission and projector writer policy remain unchanged.
    sqlx::query("UPDATE conversation_blocks SET changed_sequence=?")
        .bind(head as i64)
        .execute(&mut sql)
        .await
        .unwrap();
    sqlx::query("UPDATE conversation_entries SET changed_sequence=?")
        .bind(head as i64)
        .execute(&mut sql)
        .await
        .unwrap();
    sql.close().await.unwrap();
    let mut after = watermark(&f, 2);
    let mut keys = Vec::new();
    let mut counts = Vec::new();
    loop {
        metrics::reset();
        let batch = f.handle.conversation_changes(after).await.unwrap();
        bounded(&batch);
        let measured = metrics::get();
        assert!(measured.0 <= 65 && measured.1 <= 65);
        counts.push(measured);
        keys.extend(batch.changes().iter().map(|change| key(change, head)));
        after = batch.next_after().clone();
        if !batch.has_more() {
            break;
        }
        assert!(Key::after(&after) == *keys.last().unwrap());
    }
    assert_eq!(counts[0].0, 65);
    assert_eq!(counts[0].1, 65);
    assert_eq!(keys.len(), 143);
    assert!(keys.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(keys[0].rank, 0);
    assert_eq!(keys.iter().filter(|key| key.rank == 1).count(), 71);
    assert_eq!(keys.iter().filter(|key| key.rank == 2).count(), 71);
    // A block cursor from the lexically last run must still include every entry at that sequence.
    let last_block = keys.iter().rfind(|key| key.rank == 1).unwrap();
    let batch = f
        .handle
        .conversation_changes(last_block.cursor(f.handle.session_id()).unwrap())
        .await
        .unwrap();
    assert_eq!(batch.changes().len(), 64);
    assert!(
        batch
            .changes()
            .iter()
            .all(|change| matches!(change, DisplayChange::EntryUpsert(_)))
    );
    println!(
        "a5b3 partition bounds={counts:?} merged_entities=143; all-rank ASCII tuple traversal PASS"
    );
    f.store.close().await.unwrap();
}
