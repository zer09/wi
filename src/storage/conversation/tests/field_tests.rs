use super::*;
use crate::conversation::{
    FieldKind,
    primitives::{CHUNK_BYTES, FieldRank, OrderKey},
};
use fields::{CHUNK_READS, ChunkReads, FieldKey, FieldOrder};

pub(super) fn human(fixture: &Fixture) -> FieldKey {
    FieldKey::new(
        fixture.run.clone(),
        fixture.human,
        FieldOrder::Human,
        FieldKind::Text,
    )
    .unwrap()
}
pub(super) fn assistant(fixture: &Fixture, output: u64) -> FieldKey {
    FieldKey::new(
        fixture.run.clone(),
        fixture.assistant,
        FieldOrder::Indexed(OrderKey::new(
            Some(output),
            FieldRank::Content,
            None,
            Some(0),
        )),
        FieldKind::Text,
    )
    .unwrap()
}
async fn chunks(sql: &mut SqliteConnection, key: &FieldKey) -> Vec<(i64, Vec<u8>)> {
    sqlx::query_as(
        "SELECT start_byte,bytes FROM conversation_chunks WHERE field_id=? ORDER BY start_byte",
    )
    .bind(key.field_id())
    .fetch_all(sql)
    .await
    .unwrap()
}
fn assemble(chunks: &[(i64, Vec<u8>)]) -> Vec<u8> {
    let mut text = Vec::new();
    for (start, bytes) in chunks {
        assert_eq!(usize::try_from(*start).unwrap(), text.len());
        assert!(!bytes.is_empty() && bytes.len() <= CHUNK_BYTES);
        assert!(std::str::from_utf8(bytes).is_ok());
        text.extend(bytes);
    }
    text
}

#[tokio::test]
async fn a2_empty_human_and_large_scalar_aligned_exact_bytes() {
    let mut fixture = Fixture::new().await;
    let human = human(&fixture);
    let assistant = assistant(&fixture, u64::MAX);
    let text = format!(
        "{}{}",
        "x".repeat(8191),
        "雪\0\r\n\u{1b}\u{7f}🦀e\u{301}\u{202e}".repeat(4000)
    );
    assert!(text.len() > 32768);
    let mut transaction = fixture.sql.begin().await.unwrap();
    let empty = fields::insert(&mut transaction, &human, 2, "")
        .await
        .unwrap();
    assert_eq!((empty.generation, empty.byte_length), (2, 0));
    assert!(chunks(&mut transaction, &human).await.is_empty());
    let field = fields::insert(&mut transaction, &assistant, 3, &text)
        .await
        .unwrap();
    assert_eq!(
        (field.generation, field.byte_length),
        (3, text.len() as u64)
    );
    transaction.commit().await.unwrap();
    assert_eq!(
        assemble(&chunks(&mut fixture.sql, &assistant).await),
        text.as_bytes()
    );
    let saved: (String, String, String) = sqlx::query_as(
        "SELECT field_id,order_key,metadata_json FROM conversation_fields WHERE field_id='text'",
    )
    .fetch_one(&mut fixture.sql)
    .await
    .unwrap();
    assert_eq!(saved, ("text".into(), "0".into(), "{}".into()));
    fields::append(&mut fixture.sql, &human, "\0雪")
        .await
        .unwrap();
    assert_eq!(
        assemble(&chunks(&mut fixture.sql, &human).await),
        "\0雪".as_bytes()
    );
    fixture.close().await;
}

pub(super) async fn snapshot(sql: &mut SqliteConnection, except: Option<&str>) -> Vec<String> {
    let mut rows = Vec::new();
    for query in [
        "SELECT json_group_array(json_array(run_id,entry_id,field_id,order_key,generation,byte_length,kind,metadata_json)) FROM (SELECT * FROM conversation_fields WHERE field_id IS NOT ? ORDER BY run_id,entry_id,field_id)",
        "SELECT json_group_array(json_array(run_id,entry_id,field_id,start_byte,hex(bytes))) FROM (SELECT * FROM conversation_chunks WHERE field_id IS NOT ? ORDER BY run_id,entry_id,field_id,start_byte)",
    ] {
        rows.push(
            sqlx::query_scalar(query)
                .bind(except)
                .fetch_one(&mut *sql)
                .await
                .unwrap(),
        );
    }
    for query in [
        "SELECT json_group_array(json_array(singleton,format_version,applied_sequence,metadata_sequence)) FROM conversation_projection",
        "SELECT json_group_array(json_array(run_id,accepted_sequence,changed_sequence,header_json)) FROM (SELECT * FROM conversation_blocks ORDER BY run_id)",
        "SELECT json_group_array(json_array(run_id,entry_id,hex(source_key),first_sequence,position_slot,changed_sequence,content_epoch,kind,metadata_json)) FROM (SELECT * FROM conversation_entries ORDER BY run_id,entry_id)",
        "SELECT json_group_array(json_array(singleton,session_id,schema_version,format_version,title,workspace_json,created_at_ms,updated_at_ms,head_sequence,creation_provenance_json)) FROM manifest",
        "SELECT json_group_array(json_array(sequence,event_id,event_type,event_version,created_at_ms,run_id,source_event_id,source_sequence,payload_json)) FROM (SELECT * FROM events ORDER BY sequence)",
        "SELECT json_group_array(json_array(operation_id,method,hex(payload_hash),first_sequence,last_sequence,receipt_json)) FROM (SELECT * FROM commands ORDER BY operation_id)",
        "SELECT json_group_array(json_array(run_id,accepted_sequence,state,last_runtime_sequence,owner_instance_id,provider_session_id,terminal_sequence,terminal_json,result_sequence)) FROM (SELECT * FROM runs ORDER BY run_id)",
        "SELECT json_group_array(json_array(run_id,call_id,tool_name,request_id,started_sequence,finished_sequence,result_sequence,is_error,output)) FROM (SELECT * FROM tool_results ORDER BY run_id,call_id)",
    ] {
        rows.push(
            sqlx::query_scalar(query)
                .fetch_one(&mut *sql)
                .await
                .unwrap(),
        );
    }
    rows
}

#[tokio::test]
async fn a2_replacement_changes_only_target_chunks_and_generation() {
    let mut fixture = Fixture::new().await;
    let target = assistant(&fixture, 0);
    let sibling = assistant(&fixture, u64::MAX);
    let human = human(&fixture);
    fields::insert(
        &mut fixture.sql,
        &target,
        3,
        &"provisional\0雪".repeat(9000),
    )
    .await
    .unwrap();
    fields::insert(&mut fixture.sql, &sibling, 3, &"other\0🦀".repeat(5000))
        .await
        .unwrap();
    fields::insert(&mut fixture.sql, &human, 2, "human\r\n\0")
        .await
        .unwrap();
    let untouched = snapshot(&mut fixture.sql, Some(target.field_id())).await;
    for (generation, text) in [
        (4, "authoritative\0🦀\u{1b}".repeat(4000)),
        (5, String::new()),
    ] {
        let mut transaction = fixture.sql.begin().await.unwrap();
        let result = fields::replace(&mut transaction, &target, generation, &text)
            .await
            .unwrap();
        assert_eq!(
            (result.generation, result.byte_length),
            (generation, text.len() as u64)
        );
        transaction.commit().await.unwrap();
        assert_eq!(
            assemble(&chunks(&mut fixture.sql, &target).await),
            text.as_bytes()
        );
        assert_eq!(
            snapshot(&mut fixture.sql, Some(target.field_id())).await,
            untouched
        );
        assert_eq!(
            fields::load(&mut fixture.sql, &target)
                .await
                .unwrap()
                .generation,
            generation
        );
    }
    fixture.close().await;
}

#[tokio::test]
async fn a2_append_respects_empty_full_and_scalar_short_tails() {
    for original_length in [0, 8191, 8192] {
        let mut fixture = Fixture::new().await;
        let field = assistant(&fixture, 0);
        let original = "x".repeat(original_length);
        fields::insert(&mut fixture.sql, &field, 3, &original)
            .await
            .unwrap();
        let before = chunks(&mut fixture.sql, &field).await;
        fields::append(&mut fixture.sql, &field, "").await.unwrap();
        assert_eq!(chunks(&mut fixture.sql, &field).await, before);
        let delta = "🦀雪\0\u{1b}";
        let result = fields::append(&mut fixture.sql, &field, delta)
            .await
            .unwrap();
        assert_eq!(
            (result.generation, result.byte_length),
            (3, (original_length + delta.len()) as u64)
        );
        let after = chunks(&mut fixture.sql, &field).await;
        assert_eq!(&after[..before.len()], before.as_slice());
        assert_eq!(assemble(&after), format!("{original}{delta}").as_bytes());
        fixture.close().await;
    }
}

#[tokio::test]
async fn a2_append_reads_only_tail_preserves_prefix_and_generation() {
    let mut fixture = Fixture::new().await;
    let field = assistant(&fixture, 0);
    let mut expected = format!("{}z", "雪🦀\0\r\n".repeat(9000));
    fields::insert(&mut fixture.sql, &field, 3, &expected)
        .await
        .unwrap();
    // SQL guards make a prefix rewrite fail even if it would write identical bytes.
    sqlx::raw_sql("CREATE TEMP TRIGGER prefix_update BEFORE UPDATE ON conversation_chunks
        WHEN OLD.start_byte < (SELECT max(start_byte) FROM conversation_chunks WHERE run_id=OLD.run_id AND entry_id=OLD.entry_id AND field_id=OLD.field_id)
        BEGIN SELECT RAISE(ABORT,'prefix update'); END;
        CREATE TEMP TRIGGER prefix_delete BEFORE DELETE ON conversation_chunks
        WHEN OLD.start_byte < (SELECT max(start_byte) FROM conversation_chunks WHERE run_id=OLD.run_id AND entry_id=OLD.entry_id AND field_id=OLD.field_id)
        BEGIN SELECT RAISE(ABORT,'prefix delete'); END;")
        .execute(&mut fixture.sql).await.unwrap();
    for delta in [
        "".to_owned(),
        "雪\0\r".into(),
        "🦀\u{1b}".repeat(11000),
        "tail".into(),
    ] {
        let before = chunks(&mut fixture.sql, &field).await;
        let prior_tail = before.last().unwrap();
        let reads = CHUNK_READS
            .scope(std::cell::Cell::new(ChunkReads::default()), async {
                let result = fields::append(&mut fixture.sql, &field, &delta)
                    .await
                    .unwrap();
                assert_eq!(result.generation, 3);
                CHUNK_READS.with(std::cell::Cell::get)
            })
            .await;
        assert_eq!(
            (reads.queries, reads.rows, reads.bytes),
            (1, 1, prior_tail.1.len())
        );
        assert!(reads.bytes <= 8192 && reads.joined_bytes <= 8192);
        expected.push_str(&delta);
        let after = chunks(&mut fixture.sql, &field).await;
        assert_eq!(&after[..before.len() - 1], &before[..before.len() - 1]);
        if delta.is_empty() {
            assert_eq!(before, after);
        }
        assert_eq!(assemble(&after), expected.as_bytes());
        let descriptor = fields::load(&mut fixture.sql, &field).await.unwrap();
        assert_eq!(
            (descriptor.generation, descriptor.byte_length),
            (3, expected.len() as u64)
        );
    }
    let plan: Vec<(i64,i64,i64,String)> = sqlx::query_as("EXPLAIN QUERY PLAN SELECT start_byte,bytes FROM conversation_chunks WHERE run_id=? AND entry_id=? AND field_id=? ORDER BY start_byte DESC LIMIT 1")
        .bind(fixture.run.as_str()).bind(fixture.assistant.to_string()).bind(field.field_id())
        .fetch_all(&mut fixture.sql).await.unwrap();
    assert!(plan.iter().any(|(_, _, _, detail)| detail.contains(
        "SEARCH conversation_chunks USING INDEX sqlite_autoindex_conversation_chunks_1"
    )));
    assert!(
        plan.iter()
            .all(|(_, _, _, detail)| !detail.contains("SCAN") && !detail.contains("TEMP B-TREE"))
    );
    fixture.close().await;
}
