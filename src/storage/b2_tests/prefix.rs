use super::*;
use serde_json::{Value, json};

// Deliberately do not use dto::canonical_json or the production row serializer.
fn sorted(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        sorted(&map[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(sorted).collect::<Vec<_>>().join(",")
        ),
        value => serde_json::to_string(value).unwrap(),
    }
}

async fn oracle(sql: &mut SqliteConnection, through: u64) -> String {
    let mut bytes = b"wi.history-prefix.v1\0".to_vec();
    let rows = sqlx::query("SELECT * FROM events WHERE sequence<=? ORDER BY sequence")
        .bind(through as i64)
        .fetch_all(sql)
        .await
        .unwrap();
    for row in rows {
        let value = json!({
            "sequence":row.get::<i64,_>("sequence"),
            "event_id":row.get::<String,_>("event_id"),
            "event_type":row.get::<String,_>("event_type"),
            "event_version":row.get::<i64,_>("event_version"),
            "created_at_ms":row.get::<i64,_>("created_at_ms"),
            "run_id":row.get::<Option<String>,_>("run_id"),
            "source_event_id":row.get::<Option<String>,_>("source_event_id"),
            "source_sequence":row.get::<Option<i64>,_>("source_sequence"),
            "payload":serde_json::from_str::<Value>(&row.get::<String,_>("payload_json")).unwrap(),
        });
        let row_bytes = sorted(&value).into_bytes();
        bytes.extend_from_slice(&(row_bytes.len() as u64).to_be_bytes());
        bytes.extend_from_slice(&row_bytes);
    }
    ring::digest::digest(&ring::digest::SHA256, &bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[tokio::test]
async fn p1b2_07_raw_prefix_oracle_pages_checkpoints_nulls_unicode_and_embedded_json() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let (id, path) = migration::fixture(&root).await;
    let store = SessionStore::open(root).await.unwrap();
    let handle = store.open_session(id.clone()).await.unwrap();
    let h = handle.manifest().await.unwrap().head_sequence();
    let mut sql = migration::connect(&path).await;
    let mut checkpoints = Vec::new();
    for sequence in [1, 2, 31, 32, 33, 255, 256, 257, h] {
        checkpoints.push((sequence, oracle(&mut sql, sequence).await));
    }
    let expected = checkpoints.last().unwrap().1.clone();
    assert_eq!(
        history_prefix::digest(&mut sql, h, &checkpoints)
            .await
            .unwrap(),
        expected
    );
    // A mutable projection and later append cannot change H's canonical digest.
    sqlx::query("UPDATE manifest SET schema_version=1")
        .execute(&mut sql)
        .await
        .unwrap();
    assert_eq!(
        history_prefix::digest(&mut sql, h, &checkpoints)
            .await
            .unwrap(),
        expected
    );
    sqlx::query("UPDATE manifest SET schema_version=2")
        .execute(&mut sql)
        .await
        .unwrap();
    sql.close().await.unwrap();
    handle
        .rename(OperationId::new(), "later".into())
        .await
        .unwrap();
    let mut after = 0;
    let mut count = 0;
    loop {
        let page = handle.history_page(after, Some(h), 32).await.unwrap();
        count += page.records().len() as u64;
        after = page.next_after();
        if !page.has_more() {
            break;
        }
    }
    assert_eq!(count, h);
    assert_eq!(after, h);
    let mut sql = migration::connect(&path).await;
    assert_eq!(
        history_prefix::digest(&mut sql, h, &checkpoints)
            .await
            .unwrap(),
        expected
    );
    let mut bad = checkpoints.clone();
    bad[3].1 = "0".repeat(64);
    assert_eq!(
        history_prefix::digest(&mut sql, h, &bad)
            .await
            .unwrap_err()
            .code(),
        "storage.integrity"
    );
    bad = checkpoints.clone();
    bad.push((1, "0".repeat(64)));
    assert!(history_prefix::digest(&mut sql, h, &bad).await.is_err());
    for bound in [0, h + 2, u64::MAX] {
        assert!(history_prefix::digest(&mut sql, bound, &[]).await.is_err());
    }
    sqlx::query("DROP TRIGGER events_no_update")
        .execute(&mut sql)
        .await
        .unwrap();
    // Unknown provider fields are hashed even when typed event decoding discards them.
    sqlx::query("UPDATE events SET payload_json=json_set(payload_json,'$.unknown_outer',json('{\"z\":{\"x\":1,\"a\":2},\"text\":\"{ \\\"z\\\":1,\\\"a\\\":2 }\"}')) WHERE sequence=8")
        .execute(&mut sql).await.unwrap();
    let changed = history_prefix::digest(&mut sql, h, &[]).await.unwrap();
    assert_ne!(changed, expected);
    assert_eq!(changed, oracle(&mut sql, h).await);
    assert!(
        history_prefix::digest(&mut sql, h, &checkpoints)
            .await
            .is_err()
    );
    sqlx::query("DROP TRIGGER events_no_delete")
        .execute(&mut sql)
        .await
        .unwrap();
    sqlx::query("DELETE FROM events WHERE sequence=8")
        .execute(&mut sql)
        .await
        .unwrap();
    assert_eq!(
        history_prefix::digest(&mut sql, h, &[])
            .await
            .unwrap_err()
            .code(),
        "storage.integrity"
    );
    sql.close().await.unwrap();
    store.close().await.unwrap();
}
