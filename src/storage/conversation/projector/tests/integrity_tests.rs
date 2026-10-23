use super::*;
use crate::storage::StoredEventId;
use sqlx::{ConnectOptions, sqlite::SqliteConnectOptions};

#[tokio::test]
async fn a3_contiguous_watermark_checked_integers_and_created_only_state() {
    let mut f = Fixture::new().await;
    let before = f.dump().await;
    for sequence in [0, 1, 2, 4, u64::MAX] {
        let mut transaction = f.sql.begin().await.unwrap();
        let error = apply(
            &mut transaction,
            Event {
                sequence,
                run: None,
                input: Input::Renamed,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), StorageErrorKind::Integrity);
        assert!(!format!("{error:?}").contains("PRIVATE"));
        transaction.rollback().await.unwrap();
        assert_eq!(before, f.dump().await);
    }
    let error = apply(
        &mut f.sql,
        Event {
            sequence: 1,
            run: None,
            input: Input::Created,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind(), StorageErrorKind::Integrity);
    sqlx::raw_sql("DELETE FROM conversation_chunks; DELETE FROM conversation_fields; DELETE FROM conversation_entries; DELETE FROM conversation_blocks; DELETE FROM conversation_projection;").execute(&mut f.sql).await.unwrap();
    let created = crate::storage::history::event(&mut f.sql, &f.session, 1)
        .await
        .unwrap();
    apply(&mut f.sql, Event::try_from(&created).unwrap())
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM conversation_blocks")
        .fetch_one(&mut f.sql)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(f.dump().await, ["[1,1,1,1]"]);
    f.close().await;
}

#[tokio::test]
async fn a3_later_failure_rolls_back_canonical_rows_receipt_projection_and_watermark() {
    let mut f = Fixture::new().await;
    let before = f.dump().await;
    let mut observer = SqliteConnectOptions::new()
        .filename(&f.path)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap();
    let renamed = f.stored("session.renamed", json!({"title":"uncommitted"}), false);
    f.sequence += 1;
    let missing = f.stored(
        "tool.result.recorded",
        json!({"request_id":null,"call_id":"missing","output":"uncommitted","is_error":false}),
        true,
    );
    let mut transaction = f.sql.begin().await.unwrap();
    insert(&mut transaction, &renamed).await;
    let head: i64 = sqlx::query_scalar("SELECT applied_sequence FROM conversation_projection")
        .fetch_one(&mut observer)
        .await
        .unwrap();
    assert_eq!(head, 2);
    apply(&mut transaction, Event::try_from(&renamed).unwrap())
        .await
        .unwrap();
    let head: i64 = sqlx::query_scalar("SELECT applied_sequence FROM conversation_projection")
        .fetch_one(&mut observer)
        .await
        .unwrap();
    assert_eq!(head, 2);
    sqlx::query("INSERT INTO commands VALUES (?,'synthetic',zeroblob(32),3,3,'{}')")
        .bind(StoredEventId::new().as_str())
        .execute(&mut *transaction)
        .await
        .unwrap();
    insert(&mut transaction, &missing).await;
    assert_eq!(
        apply(&mut transaction, Event::try_from(&missing).unwrap())
            .await
            .unwrap_err()
            .kind(),
        StorageErrorKind::Integrity
    );
    transaction.rollback().await.unwrap();
    assert_eq!(before, f.dump().await);
    let counts: (i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM events),(SELECT count(*) FROM commands),head_sequence FROM manifest").fetch_one(&mut f.sql).await.unwrap();
    assert_eq!(counts, (2, 1, 2));
    observer.close().await.unwrap();
    f.close().await;
}

#[tokio::test]
async fn a3_corrupt_source_field_and_metadata_are_integrity_errors_not_unsupported() {
    for corruption in [
        "UPDATE conversation_entries SET source_key=zeroblob(32) WHERE kind='assistant'",
        "UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.source.turn_id','conflict') WHERE kind='assistant'",
        "UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.private','PRIVATE_CANARY') WHERE kind='assistant'",
        "UPDATE conversation_fields SET metadata_json='[]' WHERE order_key<>'0'",
        "UPDATE conversation_fields SET kind='unknown_kind' WHERE order_key<>'0'",
        "UPDATE conversation_fields SET generation=2 WHERE order_key<>'0'",
        "UPDATE conversation_chunks SET bytes=x'ff' WHERE field_id<>'text'",
    ] {
        let mut f = Fixture::new().await;
        f.start().await;
        f.provider("t1", delta(0, None, Some(0), DeltaKind::Text, "partial"))
            .await;
        sqlx::query(corruption).execute(&mut f.sql).await.unwrap();
        let record = f.stored("runtime.observed",json!({
            "schema_version":2,"sequence":f.sequence,"event_id":"synthetic-invalid","run_id":f.run,
            "session_id":"synthetic-provider-session","request_id":"request-t1","turn_id":"t1","type":"provider_event",
            "event":{"schema_version":1,"sequence":1,"event_id":"provider","session_id":"synthetic-provider-session","request_id":"request-t1","provider":"synthetic","provider_sequence":null,
                "type":"output_item_updated","response_id":"repeated","item_id":"item-0","output_index":0,"summary_index":null,"content_index":0,"kind":"text","delta":"next"}
        }),true);
        let mut transaction = f.sql.begin().await.unwrap();
        insert(&mut transaction, &record).await;
        let result = apply(&mut transaction, Event::try_from(&record).unwrap()).await;
        assert!(result.is_err(), "{corruption}");
        assert_eq!(
            result.unwrap_err().kind(),
            StorageErrorKind::Integrity,
            "{corruption}"
        );
        transaction.rollback().await.unwrap();
        f.close().await;
    }
}

#[tokio::test]
async fn a3_tail_only_delta_counters_and_no_canonical_read_dependency() {
    use crate::storage::conversation::fields::{CHUNK_READS, ChunkReads};
    use std::sync::{Arc, Mutex};
    for size in [8190, 1_048_574] {
        let mut f = Fixture::new().await;
        f.start().await;
        f.provider(
            "t1",
            delta(0, None, Some(0), DeltaKind::Text, &"x".repeat(size)),
        )
        .await;
        // Any unqualified canonical-history read fails. FK checks still use main.events.
        sqlx::raw_sql("CREATE TEMP VIEW events AS SELECT * FROM json_each('invalid-json'); CREATE TEMP VIEW tool_results AS SELECT * FROM json_each('invalid-json'); CREATE TEMP VIEW runs AS SELECT * FROM json_each('invalid-json');")
            .execute(&mut f.sql).await.unwrap();
        assert!(
            sqlx::query("SELECT * FROM events")
                .fetch_all(&mut f.sql)
                .await
                .is_err()
        );
        let changes = Arc::new(Mutex::new(Vec::new()));
        let captured = changes.clone();
        f.sql
            .lock_handle()
            .await
            .unwrap()
            .set_update_hook(move |change| {
                if change.table.starts_with("conversation_") {
                    captured
                        .lock()
                        .unwrap()
                        .push((change.table.to_owned(), change.operation));
                }
            });
        CHUNK_READS
            .scope(std::cell::Cell::new(ChunkReads::default()), async {
                f.provider("t1", delta(0, None, Some(0), DeltaKind::Text, "🙂\0z"))
                    .await;
                let reads = CHUNK_READS.with(std::cell::Cell::get);
                assert_eq!(reads.queries, 1);
                assert_eq!(reads.rows, 1);
                assert!(reads.bytes <= 8192);
                assert!(reads.joined_bytes <= 8192);
            })
            .await;
        let counts = changes.lock().unwrap().clone();
        assert_eq!(
            counts
                .iter()
                .filter(|(table, _)| table == "conversation_entries")
                .count(),
            1
        );
        assert_eq!(
            counts
                .iter()
                .filter(|(table, _)| table == "conversation_fields")
                .count(),
            1
        );
        assert_eq!(
            counts
                .iter()
                .filter(|(table, _)| table == "conversation_chunks")
                .count(),
            1
        );
        assert!(
            !counts
                .iter()
                .any(|(_, op)| *op == sqlx::sqlite::SqliteOperation::Delete)
        );
        let entry = f.assistant("t1").await;
        assert_eq!(
            f.fields(entry.id).await[0].1,
            format!("{}🙂\0z", "x".repeat(size))
        );
        f.close().await;
    }
}

#[tokio::test]
async fn a3_stored_stream_and_borrowed_incremental_projection_are_identical() {
    use crate::{
        ReplayIdentity,
        storage::{RecordedProviderBinding, StoredHistorySelection},
    };
    for interrupted in [false, true] {
        let mut f = Fixture::new().await;
        let selection = StoredHistorySelection::new(
            1,
            "b".repeat(64),
            "synthetic".into(),
            "synthetic".into(),
            None,
        )
        .unwrap();
        f.stored_event(
            "run.history.selected",
            json!({"run_id":f.run,"selection":selection}),
            true,
        )
        .await;
        f.runtime(None, RunEvent::RunStarted).await;
        let binding = RecordedProviderBinding::new(
            f.run.clone(),
            "synthetic-provider-session".into(),
            "synthetic".into(),
            ReplayIdentity::new("synthetic".into(), "native-v1".into(), "a".repeat(64)).unwrap(),
        )
        .unwrap();
        f.append(AppendRunRecord::ProviderBinding(binding)).await;
        f.stored_event("session.renamed", json!({"title":"renamed"}), false)
            .await;
        f.runtime(Some("t1"), RunEvent::TurnStarted { number: 1 })
            .await;
        f.provider("t1", delta(0, None, Some(0), DeltaKind::Text, "partial"))
            .await;
        f.runtime(
            Some("t1"),
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionStarted {
                    call_id: "call".into(),
                    tool_name: "tool".into(),
                },
            },
        )
        .await;
        f.append(AppendRunRecord::ToolResult {
            request_id: Some("request-t1".into()),
            call_id: "call".into(),
            output: "exact\0雪".into(),
            is_error: false,
        })
        .await;
        f.provider(
            "t1",
            ProviderEvent::ResponseFinished {
                response: response(vec![message("final")], "final"),
            },
        )
        .await;
        if interrupted {
            f.stored_event(
                "run.interrupted",
                json!({"run_id":f.run,"reason":"process_restart"}),
                true,
            )
            .await;
        } else {
            f.runtime(
                None,
                RunEvent::RunFinished {
                    outcome: RunOutcome::Completed,
                    summary: summary(),
                },
            )
            .await;
            f.append(AppendRunRecord::Result(RunResult {
                run_id: f.run.as_str().into(),
                session_id: Some("synthetic-provider-session".into()),
                outcome: RunOutcome::Completed,
                summary: summary(),
                last_response: None,
                events_complete: true,
                sink_error: None,
            }))
            .await;
        }
        let expected = f.dump().await;
        sqlx::raw_sql("DELETE FROM conversation_chunks; DELETE FROM conversation_fields; DELETE FROM conversation_entries; DELETE FROM conversation_blocks; DELETE FROM conversation_projection;").execute(&mut f.sql).await.unwrap();
        // Test-only replay of genuinely stored records; no history reader exists in the projector.
        for start in (1..=f.sequence).step_by(3) {
            let mut transaction = f.sql.begin().await.unwrap();
            for sequence in start..=(start + 2).min(f.sequence) {
                let record = crate::storage::history::event(&mut transaction, &f.session, sequence)
                    .await
                    .unwrap();
                apply(&mut transaction, Event::try_from(&record).unwrap())
                    .await
                    .unwrap();
            }
            transaction.commit().await.unwrap();
        }
        assert_eq!(f.dump().await, expected);
        f.close().await;
    }
}

#[tokio::test]
async fn a3_repeated_call_ids_across_runs_are_separate_and_reuse_cannot_cross_runs() {
    let mut f = Fixture::new().await;
    f.start().await;
    f.runtime(
        Some("t1"),
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted {
                call_id: "same".into(),
                tool_name: "tool".into(),
            },
        },
    )
    .await;
    f.append(AppendRunRecord::ToolResult {
        request_id: Some("request-t1".into()),
        call_id: "same".into(),
        output: "first output".into(),
        is_error: false,
    })
    .await;
    let first = f.tool("same").await.id;
    let original_run = f.run.clone();
    f.stored_event(
        "run.interrupted",
        json!({"run_id":f.run,"reason":"process_restart"}),
        true,
    )
    .await;
    sqlx::query("UPDATE runs SET state='interrupted'")
        .execute(&mut f.sql)
        .await
        .unwrap();
    f.run = RunId::new();
    let accepted = f.stored(
        "run.accepted",
        json!({"run_id":f.run,"input":input(),"owner_instance_id":StoredEventId::new()}),
        true,
    );
    insert(&mut f.sql, &accepted).await;
    sqlx::query("INSERT INTO runs (run_id,accepted_sequence,state,last_runtime_sequence,owner_instance_id) VALUES (?,?,'accepted',0,?)")
        .bind(f.run.as_str()).bind(accepted.sequence() as i64).bind(StoredEventId::new().as_str()).execute(&mut f.sql).await.unwrap();
    apply(&mut f.sql, Event::try_from(&accepted).unwrap())
        .await
        .unwrap();
    f.sequence = accepted.sequence();
    f.start().await;
    let envelope = RunEventEnvelope {
        schema_version: 2,
        sequence: f.sequence,
        event_id: "reuse-missing".into(),
        run_id: f.run.as_str().into(),
        session_id: Some("synthetic-provider-session".into()),
        turn_id: Some("t1".into()),
        request_id: Some("request-t1".into()),
        event: RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolResultReused {
                call_id: "same".into(),
                tool_name: "tool".into(),
            },
        },
    };
    let mut transaction = f.sql.begin().await.unwrap();
    assert_eq!(
        apply(
            &mut transaction,
            Event {
                sequence: f.sequence + 1,
                run: Some(&f.run),
                input: Input::Runtime(&envelope)
            }
        )
        .await
        .unwrap_err()
        .kind(),
        StorageErrorKind::Integrity
    );
    transaction.rollback().await.unwrap();
    f.runtime(
        Some("t1"),
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted {
                call_id: "same".into(),
                tool_name: "tool".into(),
            },
        },
    )
    .await;
    f.append(AppendRunRecord::ToolResult {
        request_id: Some("request-t1".into()),
        call_id: "same".into(),
        output: "second output".into(),
        is_error: true,
    })
    .await;
    assert_ne!(f.tool("same").await.id, first);
    let second = f.tool("same").await.id;
    assert_eq!(f.fields(second).await[1].1, "second output");
    f.run = original_run;
    assert_eq!(f.fields(first).await[1].1, "first output");
    f.close().await;
}
