use super::field_tests::{assistant, human, snapshot};
use super::*;
use crate::{
    conversation::{
        FieldKind,
        primitives::{FieldRank, OrderKey},
    },
    storage::{CommitCertainty, StorageError},
};
use fields::{FieldKey, FieldOrder};

fn safe_error<T>(result: Result<T, StorageError>) {
    let error = result.err().expect("projection corruption must fail");
    assert_eq!(error.kind(), StorageErrorKind::Integrity);
    assert_eq!(error.to_string(), "storage.integrity");
    assert_eq!(
        format!("{error:?}"),
        "StorageError { code: \"storage.integrity\", certainty: NotApplicable }"
    );
}

#[tokio::test]
async fn a2_checked_metadata_identity_order_generation_and_lengths() {
    let mut fixture = Fixture::new().await;
    let field = assistant(&fixture, 0);
    fields::insert(&mut fixture.sql, &field, 3, "")
        .await
        .unwrap();
    let before = snapshot(&mut fixture.sql, None).await;
    // Bypass SQL checks only to exercise the typed decoder against damaged rows.
    sqlx::raw_sql("PRAGMA ignore_check_constraints=ON; PRAGMA foreign_keys=OFF;")
        .execute(&mut fixture.sql)
        .await
        .unwrap();
    for mutation in [
        "UPDATE conversation_fields SET metadata_json='{\"text\":\"synthetic-private /fixture\"}'",
        "UPDATE conversation_fields SET metadata_json='{\"provider\":{\"items\":[]}}'",
        "UPDATE conversation_fields SET metadata_json='[]'",
        "UPDATE conversation_fields SET metadata_json='null'",
        "UPDATE conversation_fields SET metadata_json='synthetic-private /fixture'",
        "UPDATE conversation_fields SET field_id='synthetic-private /fixture'",
        "UPDATE conversation_fields SET order_key='0'",
        "UPDATE conversation_fields SET order_key='10000000000000000:0000000000000001:0:10000000000000001:0000000000000002'",
        "UPDATE conversation_fields SET order_key='10000000000000000:2:0:10000000000000001'", // Retired private format is invalid.
        "UPDATE conversation_fields SET order_key='1FFFFFFFFFFFFFFFF:2:0:0'",
        "UPDATE conversation_fields SET kind='synthetic-private /fixture'",
        "UPDATE conversation_fields SET kind='refusal'",
        "UPDATE conversation_fields SET generation=0",
        "UPDATE conversation_fields SET generation=2",
        "UPDATE conversation_fields SET byte_length=-1",
        "UPDATE conversation_entries SET first_sequence=4 WHERE kind='assistant'",
        "UPDATE conversation_entries SET position_slot=1 WHERE kind='assistant'",
        "UPDATE conversation_entries SET kind='human' WHERE kind='assistant'",
        "UPDATE conversation_entries SET kind='synthetic-private /fixture' WHERE kind='assistant'",
    ] {
        let mut transaction = fixture.sql.begin().await.unwrap();
        sqlx::query(mutation)
            .execute(&mut *transaction)
            .await
            .unwrap();
        safe_error(fields::load(&mut transaction, &field).await);
        safe_error(fields::append(&mut transaction, &field, "synthetic-private /delta").await);
        safe_error(
            fields::replace(
                &mut transaction,
                &field,
                4,
                "synthetic-private /replacement",
            )
            .await,
        );
        transaction.rollback().await.unwrap();
        assert_eq!(snapshot(&mut fixture.sql, None).await, before);
    }
    fixture.close().await;
}

#[tokio::test]
async fn a2_rejects_tail_range_gaps_overlaps_and_invalid_utf8() {
    let mut fixture = Fixture::new().await;
    let field = assistant(&fixture, 0);
    fields::insert(&mut fixture.sql, &field, 3, &"x".repeat(8192 * 2 + 7))
        .await
        .unwrap();
    let before = snapshot(&mut fixture.sql, None).await;
    sqlx::query("PRAGMA ignore_check_constraints=ON")
        .execute(&mut fixture.sql)
        .await
        .unwrap();
    for mutation in [
        "DELETE FROM conversation_chunks",
        "DELETE FROM conversation_chunks WHERE start_byte=16384",
        "DELETE FROM conversation_chunks WHERE start_byte=8192",
        "UPDATE conversation_chunks SET start_byte=16385 WHERE start_byte=16384",
        "UPDATE conversation_chunks SET start_byte=16383 WHERE start_byte=16384",
        "UPDATE conversation_chunks SET bytes=x'ff' WHERE start_byte=16384",
        "UPDATE conversation_chunks SET bytes=x'e99b' WHERE start_byte=16384",
        "UPDATE conversation_chunks SET bytes=x'' WHERE start_byte=16384",
        "UPDATE conversation_chunks SET bytes=zeroblob(8193) WHERE start_byte=16384",
        "UPDATE conversation_chunks SET bytes=x'61' WHERE start_byte=8192",
        "UPDATE conversation_chunks SET start_byte=9223372036854775807 WHERE start_byte=16384",
        "UPDATE conversation_fields SET byte_length=0",
        "UPDATE conversation_fields SET byte_length=16392",
    ] {
        let mut transaction = fixture.sql.begin().await.unwrap();
        sqlx::query(mutation)
            .execute(&mut *transaction)
            .await
            .unwrap();
        safe_error(fields::append(&mut transaction, &field, "synthetic-private /delta").await);
        safe_error(
            fields::replace(
                &mut transaction,
                &field,
                4,
                "synthetic-private /replacement",
            )
            .await,
        );
        transaction.rollback().await.unwrap();
        assert_eq!(snapshot(&mut fixture.sql, None).await, before);
    }
    fixture.close().await;
}

#[tokio::test]
async fn a2_checked_sqlite_overflow_and_human_sentinel_before_writes() {
    let mut fixture = Fixture::new().await;
    let field = assistant(&fixture, 0);
    fields::insert(&mut fixture.sql, &field, 3, "old")
        .await
        .unwrap();
    let before = snapshot(&mut fixture.sql, None).await;
    let order = FieldOrder::Indexed(OrderKey::new(
        Some(u64::MAX),
        FieldRank::Content,
        Some(u64::MAX),
        Some(u64::MAX),
    ));
    for entry in [
        EntryId::new(u64::MAX, 0).unwrap(),
        EntryId::new(1, u64::MAX).unwrap(),
    ] {
        safe_error(FieldKey::new(
            fixture.run.clone(),
            entry,
            order,
            FieldKind::Text,
        ));
    }
    safe_error(FieldKey::new(
        fixture.run.clone(),
        fixture.human,
        FieldOrder::Human,
        FieldKind::Refusal,
    ));
    let wrong_human =
        FieldKey::new(fixture.run.clone(), fixture.human, order, FieldKind::Text).unwrap();
    safe_error(fields::insert(&mut fixture.sql, &wrong_human, 2, "bad").await);
    let wrong_assistant = FieldKey::new(
        fixture.run.clone(),
        fixture.assistant,
        FieldOrder::Human,
        FieldKind::Text,
    )
    .unwrap();
    safe_error(fields::insert(&mut fixture.sql, &wrong_assistant, 3, "bad").await);
    let new_field = assistant(&fixture, 1);
    for generation in [0, 2, (i64::MAX as u64) + 1, u64::MAX] {
        safe_error(fields::insert(&mut fixture.sql, &new_field, generation, "").await);
        safe_error(fields::replace(&mut fixture.sql, &field, generation, "").await);
    }
    safe_error(fields::replace(&mut fixture.sql, &field, 3, "same generation").await);
    assert_eq!(snapshot(&mut fixture.sql, None).await, before);
    let mut transaction = fixture.sql.begin().await.unwrap();
    sqlx::query("UPDATE conversation_fields SET byte_length=9223372036854775807")
        .execute(&mut *transaction)
        .await
        .unwrap();
    safe_error(fields::append(&mut transaction, &field, "x").await);
    transaction.rollback().await.unwrap();
    assert_eq!(snapshot(&mut fixture.sql, None).await, before);
    fixture.close().await;
}

#[tokio::test]
async fn a2_caller_rollback_preserves_every_field_chunk_and_canonical_byte() {
    let mut fixture = Fixture::new().await;
    let field = assistant(&fixture, 0);
    let human = human(&fixture);
    let new_field = assistant(&fixture, 1);
    fields::insert(&mut fixture.sql, &field, 3, &"old\0雪".repeat(5000))
        .await
        .unwrap();
    fields::insert(&mut fixture.sql, &human, 2, "human")
        .await
        .unwrap();
    let before = snapshot(&mut fixture.sql, None).await;
    let mut observer = SqliteConnectOptions::new()
        .filename(&fixture.path)
        .read_only(true)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap();
    let mut transaction = fixture.sql.begin().await.unwrap();
    fields::append(&mut transaction, &field, "\0append🦀")
        .await
        .unwrap();
    fields::replace(&mut transaction, &human, 4, "replaced human\0")
        .await
        .unwrap();
    fields::insert(&mut transaction, &new_field, 4, "new field")
        .await
        .unwrap();
    assert_ne!(snapshot(&mut transaction, None).await, before);
    assert_eq!(snapshot(&mut observer, None).await, before);
    transaction.rollback().await.unwrap();
    assert_eq!(snapshot(&mut fixture.sql, None).await, before);
    observer.close().await.unwrap();
    fixture.close().await;
}

#[tokio::test]
async fn a2_partial_sql_failure_is_rolled_back_by_existing_transaction_finisher() {
    let mut fixture = Fixture::new().await;
    let field = assistant(&fixture, 0);
    fields::insert(&mut fixture.sql, &field, 3, &"old\0雪".repeat(5000))
        .await
        .unwrap();
    let before = snapshot(&mut fixture.sql, None).await;
    sqlx::raw_sql("CREATE TEMP TRIGGER reject_second_chunk BEFORE INSERT ON conversation_chunks WHEN NEW.start_byte>=8192 BEGIN SELECT RAISE(ABORT,'synthetic-private /failure'); END;")
        .execute(&mut fixture.sql).await.unwrap();
    let mut transaction = fixture.sql.begin().await.unwrap();
    let result = fields::replace(&mut transaction, &field, 4, &"x".repeat(24000)).await;
    assert!(result.is_err());
    assert_ne!(snapshot(&mut transaction, None).await, before);
    let error = database::finish_transaction(transaction, result)
        .await
        .err()
        .unwrap();
    assert_eq!(error.kind(), StorageErrorKind::Integrity);
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    assert_eq!(error.to_string(), "storage.integrity");
    assert_eq!(snapshot(&mut fixture.sql, None).await, before);
    fixture.close().await;
}
