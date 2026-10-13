use super::*;
use crate::conversation::ContentCursor;

async fn snapshot(f: &Fixture) -> (Vec<String>, Vec<Option<crate::storage::CommitReceipt>>) {
    let (mut values, receipts) = acceptance_snapshot(f).await;
    let mut sql = f.sql().await;
    values.push(sqlx::query_scalar("SELECT json_array((SELECT foreign_keys FROM pragma_foreign_keys),(SELECT journal_mode FROM pragma_journal_mode),(SELECT count(*) FROM pragma_foreign_key_check))").fetch_one(&mut sql).await.unwrap());
    sql.close().await.unwrap();
    (values, receipts)
}

fn integrity_error<T>(result: Result<T>) {
    let error = result.err();
    assert!(
        matches!(&error, Some(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Integrity),
        "required Integrity, got error={error:?}"
    );
}

async fn zero_content_read(f: &Fixture, after: LiveCursor) -> Result<ConversationChanges> {
    let before = snapshot(f).await;
    let initial = f.store.inner.hooks.measurements();
    let result = f.handle.conversation_changes(after).await;
    let measured = f.store.inner.hooks.measurements();
    assert_eq!(
        measured.conversation_descriptors - initial.conversation_descriptors,
        0
    );
    assert_eq!(
        measured.conversation_chunks - initial.conversation_chunks,
        0
    );
    assert_eq!(measured.conversation_bytes - initial.conversation_bytes, 0);
    assert_eq!(snapshot(f).await, before);
    println!(
        "addressed anchor validation descriptors=0 chunks=0 content_bytes=0 result={:?}",
        result.as_ref().map(|batch| batch.changes().len())
    );
    result
}

async fn start_tool(f: &mut Fixture, call: &str) -> EntryId {
    let sequence = f.handle.manifest().await.unwrap().head_sequence() + 1;
    f.runtime(RunEvent::ToolEvent {
        event: ToolExecutionEvent::ToolExecutionStarted {
            call_id: call.into(),
            tool_name: "synthetic tool".into(),
        },
    })
    .await;
    EntryId::new(sequence, 0).unwrap()
}
async fn finish_tool(f: &mut Fixture, call: &str, is_error: bool) {
    f.runtime(RunEvent::ToolEvent {
        event: ToolExecutionEvent::ToolExecutionFinished {
            call_id: call.into(),
            tool_name: "synthetic tool".into(),
            is_error,
        },
    })
    .await;
}
async fn result_tool(f: &Fixture, call: &str, output: &str, is_error: bool) {
    f.handle
        .append_run_records(
            OperationId::new(),
            f.run.clone(),
            vec![AppendRunRecord::ToolResult {
                request_id: Some(REQUEST.into()),
                call_id: call.into(),
                output: output.into(),
                is_error,
            }],
        )
        .await
        .unwrap();
}
async fn saved_tool(f: &Fixture, output: &str, is_error: bool, finish: u8) {
    // The full canonical reader is an independent test oracle, never the warm-read guard.
    let actual = f
        .handle
        .tool_result(f.run.clone(), "actual".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(actual.run_id(), &f.run);
    assert_eq!(actual.call_id(), "actual");
    assert_eq!(actual.tool_name(), "synthetic tool");
    assert_eq!(actual.request_id(), Some(REQUEST));
    assert_eq!(actual.output().unwrap().as_bytes(), output.as_bytes());
    assert_eq!(actual.is_error(), Some(is_error));
    assert_eq!(actual.started_sequence(), 7);
    let result = actual.result_sequence().unwrap();
    match finish {
        0 => {
            assert_eq!(result, 8);
            assert_eq!(actual.finished_sequence(), None);
        }
        1 => {
            assert_eq!(result, 9);
            assert_eq!(actual.finished_sequence(), Some(8));
        }
        2 => {
            assert_eq!(result, 8);
            assert_eq!(actual.finished_sequence(), Some(9));
        }
        _ => unreachable!(),
    }
}
async fn tool_fixture(
    output: &str,
    is_error: bool,
    finish: u8,
) -> (Fixture, EntryId, ContentCursor, EntryId, EntryId) {
    let mut f = Fixture::new("actual human\0雪").await;
    f.start().await;
    f.delta(0, "healthy assistant\0雪").await;
    let id = start_tool(&mut f, "actual").await;
    if finish == 1 {
        finish_tool(&mut f, "actual", is_error).await;
    }
    result_tool(&f, "actual", output, is_error).await;
    if finish == 2 {
        finish_tool(&mut f, "actual", is_error).await;
    }
    let pending = start_tool(&mut f, "pending").await;
    let finish_only = start_tool(&mut f, "finish-only").await;
    finish_tool(&mut f, "finish-only", true).await;
    let page = f
        .handle
        .conversation_entry(f.run.clone(), id)
        .await
        .unwrap();
    let name = page
        .entry()
        .fields()
        .iter()
        .find(|field| field.kind() == FieldKind::ToolName)
        .unwrap();
    let content = ContentCursor::new(
        f.handle.session_id().clone(),
        f.run.clone(),
        id,
        page.entry().content_epoch(),
        name.field_id().into(),
        name.generation(),
        name.total_bytes(),
    )
    .unwrap();
    (f, id, content, pending, finish_only)
}
fn tool_facts(entry: &EntryView, output: &str, is_error: bool, finish: u8) {
    assert_eq!(entry.result_recorded(), Some(true));
    assert_eq!(entry.is_error(), Some(is_error));
    assert_eq!(entry.finish_recorded(), Some(finish != 0));
    assert_eq!(
        entry
            .fields()
            .iter()
            .find(|field| field.kind() == FieldKind::ToolResult)
            .unwrap()
            .text()
            .as_bytes(),
        output.as_bytes()
    );
}
async fn healthy_surfaces(
    f: &Fixture,
    id: EntryId,
    content: &ContentCursor,
    output: &str,
    is_error: bool,
    finish: u8,
) {
    let before = snapshot(f).await;
    let changes = f
        .handle
        .conversation_changes(watermark(f, 1))
        .await
        .unwrap();
    bounded(&changes);
    let entry = changes
        .changes()
        .iter()
        .find_map(|change| match change {
            DisplayChange::EntryUpsert(change) if *change.entry().entry_id() == id => {
                Some(change.entry())
            }
            _ => None,
        })
        .unwrap();
    tool_facts(entry, output, is_error, finish);
    let page = f
        .handle
        .conversation_entry(f.run.clone(), id)
        .await
        .unwrap();
    tool_facts(page.entry(), output, is_error, finish);
    let name = f
        .handle
        .conversation_content(content.clone())
        .await
        .unwrap();
    assert_eq!(name.entry().is_error(), Some(is_error));
    assert_eq!(name.entry().result_recorded(), Some(true));
    assert_eq!(name.entry().finish_recorded(), Some(finish != 0));
    assert_eq!(name.entry().fields().len(), 1);
    assert_eq!(name.entry().fields()[0].kind(), FieldKind::ToolName);
    let page = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    tool_facts(
        page.entries()
            .iter()
            .find(|entry| *entry.entry_id() == id)
            .unwrap(),
        output,
        is_error,
        finish,
    );
    saved_tool(f, output, is_error, finish).await;
    assert_eq!(snapshot(f).await, before);
}
async fn same_session_controls(f: &Fixture, pending: EntryId, finish_only: EntryId) {
    assert_eq!(
        f.entry("e:2:0").await.entry().fields()[0].text(),
        "actual human\0雪"
    );
    assert_eq!(
        f.entry("e:5:0").await.entry().fields()[0].text(),
        "healthy assistant\0雪"
    );
    let entry = f
        .handle
        .conversation_entry(f.run.clone(), pending)
        .await
        .unwrap();
    assert_eq!(
        (
            entry.entry().result_recorded(),
            entry.entry().finish_recorded(),
            entry.entry().is_error()
        ),
        (Some(false), Some(false), None)
    );
    let entry = f
        .handle
        .conversation_entry(f.run.clone(), finish_only)
        .await
        .unwrap();
    assert_eq!(
        (
            entry.entry().result_recorded(),
            entry.entry().finish_recorded(),
            entry.entry().is_error()
        ),
        (Some(false), Some(true), Some(true))
    );
}

#[tokio::test]
async fn a5b3_ra02_genuine_boolean_matrix_rejects_on_all_public_surfaces() {
    for is_error in [false, true] {
        for output in ["", "exact\0雪🙂\"\\ result"] {
            for finish in 0..3 {
                let (f, id, content, pending, finish_only) =
                    tool_fixture(output, is_error, finish).await;
                let (healthy, healthy_id, healthy_content, _, _) =
                    tool_fixture(output, is_error, finish).await;
                for _ in 0..2 {
                    healthy_surfaces(&f, id, &content, output, is_error, finish).await;
                    healthy_surfaces(
                        &healthy,
                        healthy_id,
                        &healthy_content,
                        output,
                        is_error,
                        finish,
                    )
                    .await;
                }
                let before = snapshot(&f).await;
                let mut sql = f.sql().await;
                sqlx::query("UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.is_error',json(?)) WHERE run_id=? AND entry_id=?")
                    .bind((!is_error).to_string()).bind(f.run.as_str()).bind(id.to_string()).execute(&mut sql).await.unwrap();
                let kind: String = sqlx::query_scalar("SELECT json_type(metadata_json,'$.is_error') FROM conversation_entries WHERE run_id=? AND entry_id=?")
                    .bind(f.run.as_str()).bind(id.to_string()).fetch_one(&mut sql).await.unwrap();
                assert_eq!(kind, (!is_error).to_string());
                sql.close().await.unwrap();
                let damaged = snapshot(&f).await;
                assert_eq!(damaged.1, before.1);
                for (index, (a, b)) in before.0.iter().zip(&damaged.0).enumerate() {
                    if index != 7 {
                        assert_eq!(a, b, "only derived metadata changes: table {index}");
                    }
                }
                let a: serde_json::Value = serde_json::from_str(&before.0[7]).unwrap();
                let mut b: serde_json::Value = serde_json::from_str(&damaged.0[7]).unwrap();
                for (old, new) in a.as_array().unwrap().iter().zip(b.as_array_mut().unwrap()) {
                    if old[1] == id.to_string() {
                        let mut old_meta: serde_json::Value =
                            serde_json::from_str(old[8].as_str().unwrap()).unwrap();
                        let new_meta: serde_json::Value =
                            serde_json::from_str(new[8].as_str().unwrap()).unwrap();
                        old_meta["is_error"] = (!is_error).into();
                        assert_eq!(new_meta, old_meta);
                        new[8] = old[8].clone();
                    }
                }
                assert_eq!(a, b);
                for repetition in 0..2 {
                    integrity_error(f.handle.conversation_changes(watermark(&f, 1)).await);
                    integrity_error(f.handle.conversation_entry(f.run.clone(), id).await);
                    integrity_error(f.handle.conversation_content(content.clone()).await);
                    integrity_error(f.handle.conversation_page(ConversationQuery::Latest).await);
                    saved_tool(&f, output, is_error, finish).await;
                    same_session_controls(&f, pending, finish_only).await;
                    healthy_surfaces(
                        &healthy,
                        healthy_id,
                        &healthy_content,
                        output,
                        is_error,
                        finish,
                    )
                    .await;
                    assert_eq!(snapshot(&f).await, damaged);
                    println!(
                        "ra02 strict case actual={is_error} output_bytes={} finish={finish} repetition={repetition} four Integrity results; tables/schema/raw/all receipts preserved",
                        output.len()
                    );
                }
                f.store.close().await.unwrap();
                healthy.store.close().await.unwrap();
            }
        }
    }
}

#[tokio::test]
async fn a5b3_ra02_scalar_absence_encoding_and_integer_metadata_reject() {
    for statement in [
        "DELETE FROM tool_results WHERE call_id='actual'",
        "UPDATE tool_results SET result_sequence=NULL,output=NULL WHERE call_id='actual'",
        "UPDATE tool_results SET is_error=NULL WHERE call_id='actual'",
        "UPDATE tool_results SET is_error=2 WHERE call_id='actual'",
        "UPDATE tool_results SET result_sequence=0 WHERE call_id='actual'",
        "UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.is_error',true) WHERE entry_id='e:7:0'",
    ] {
        let (f, id, content, _, _) = tool_fixture("", false, 0).await;
        let mut sql = f.sql().await;
        // Invalid scalar fixtures bypass CHECK/FK admission, then restore both settings. No schema edits.
        sqlx::raw_sql("PRAGMA ignore_check_constraints=ON; PRAGMA foreign_keys=OFF")
            .execute(&mut sql)
            .await
            .unwrap();
        sqlx::raw_sql(statement).execute(&mut sql).await.unwrap();
        sqlx::raw_sql("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON")
            .execute(&mut sql)
            .await
            .unwrap();
        if statement.contains("json_set") {
            let kind: String = sqlx::query_scalar("SELECT json_type(metadata_json,'$.is_error') FROM conversation_entries WHERE entry_id='e:7:0'").fetch_one(&mut sql).await.unwrap();
            assert_eq!(kind, "integer");
        }
        sql.close().await.unwrap();
        let damaged = snapshot(&f).await;
        for _ in 0..2 {
            integrity_error(f.handle.conversation_changes(watermark(&f, 1)).await);
            integrity_error(f.handle.conversation_entry(f.run.clone(), id).await);
            integrity_error(f.handle.conversation_content(content.clone()).await);
            integrity_error(f.handle.conversation_page(ConversationQuery::Latest).await);
            assert_eq!(snapshot(&f).await, damaged);
        }
        println!("scalar damage rejected without mutation: {statement}");
        f.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn a5b3_ra02_reuse_retains_occurrence_finish_and_checks_target_scalar() {
    for is_error in [false, true] {
        for output in ["", "exact\0雪🙂\"\\ result"] {
            let (mut f, id, _, _, _) = tool_fixture(output, is_error, 0).await;
            let sequence = f.handle.manifest().await.unwrap().head_sequence() + 1;
            f.runtime(RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolResultReused {
                    call_id: "actual".into(),
                    tool_name: "synthetic tool".into(),
                },
            })
            .await;
            let reuse_id = EntryId::new(sequence, 0).unwrap();
            finish_tool(&mut f, "actual", is_error).await;
            let before = snapshot(&f).await;
            for _ in 0..2 {
                let batch = f
                    .handle
                    .conversation_changes(watermark(&f, 1))
                    .await
                    .unwrap();
                bounded(&batch);
                let original = f
                    .handle
                    .conversation_entry(f.run.clone(), id)
                    .await
                    .unwrap();
                tool_facts(original.entry(), output, is_error, 2);
                let reuse = f
                    .handle
                    .conversation_entry(f.run.clone(), reuse_id)
                    .await
                    .unwrap();
                assert_eq!(reuse.entry().result_recorded(), Some(true));
                assert_eq!(reuse.entry().is_error(), Some(is_error));
                assert_eq!(reuse.entry().finish_recorded(), Some(false));
                assert_eq!(reuse.entry().reference().unwrap().entry_id(), &id);
                assert!(
                    reuse
                        .entry()
                        .fields()
                        .iter()
                        .all(|field| field.kind() != FieldKind::ToolResult)
                );
                let moved = f
                    .handle
                    .conversation_changes(cursor(
                        &f,
                        reuse.entry().revision(),
                        2,
                        Some(f.run.clone()),
                        Some(reuse_id),
                    ))
                    .await
                    .unwrap();
                assert!(moved.changes().iter().any(|change| matches!(change, DisplayChange::EntryUpsert(change) if *change.entry().entry_id() == id && change.entry().finish_recorded() == Some(true))));
            }
            assert_eq!(snapshot(&f).await, before);
            let mut sql = f.sql().await;
            // Both metadata flags agree, so only the target's actual scalar can reject this Reuse.
            sqlx::query("UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.is_error',json(?)) WHERE run_id=? AND entry_id IN (?,?)")
                .bind((!is_error).to_string()).bind(f.run.as_str()).bind(id.to_string()).bind(reuse_id.to_string()).execute(&mut sql).await.unwrap();
            sql.close().await.unwrap();
            let damaged = snapshot(&f).await;
            for _ in 0..2 {
                integrity_error(f.handle.conversation_entry(f.run.clone(), reuse_id).await);
                integrity_error(
                    f.handle
                        .conversation_changes(cursor(
                            &f,
                            sequence,
                            2,
                            Some(f.run.clone()),
                            Some(reuse_id),
                        ))
                        .await,
                );
                assert_eq!(snapshot(&f).await, damaged);
            }
            f.store.close().await.unwrap();
        }
    }
}

async fn anchor_fixture(rank: u8) -> (Fixture, LiveCursor) {
    let mut f = Fixture::new("actual human\0雪").await;
    let after = if rank == 1 {
        f.runtime(RunEvent::RunStarted).await;
        cursor(&f, 3, 1, Some(f.run.clone()), None)
    } else {
        f.start().await;
        cursor(
            &f,
            5,
            2,
            Some(f.run.clone()),
            Some("e:5:0".parse().unwrap()),
        )
    };
    (f, after)
}
async fn missing_anchor(rank: u8) {
    let (f, after) = anchor_fixture(rank).await;
    for _ in 0..2 {
        let batch = zero_content_read(&f, after.clone()).await.unwrap();
        assert!(batch.changes().is_empty() && !batch.has_more());
        assert_eq!(batch.observed_head(), after.sequence());
        assert_eq!(batch.next_after(), &watermark(&f, after.sequence()));
    }
    let before = snapshot(&f).await;
    let mut sql = f.sql().await;
    assert!(
        sqlx::query("DELETE FROM conversation_entries WHERE entry_id='e:2:0'")
            .execute(&mut sql)
            .await
            .is_err()
    );
    // Normal writers cannot remove an anchor. This is deliberately invalid projection output.
    sqlx::raw_sql("PRAGMA foreign_keys=OFF; DELETE FROM conversation_chunks WHERE entry_id='e:2:0'; DELETE FROM conversation_fields WHERE entry_id='e:2:0'; DELETE FROM conversation_entries WHERE entry_id='e:2:0'; PRAGMA foreign_keys=ON").execute(&mut sql).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM pragma_foreign_key_check")
            .fetch_one(&mut sql)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
            .fetch_one(&mut sql)
            .await
            .unwrap(),
        1
    );
    sql.close().await.unwrap();
    let damaged = snapshot(&f).await;
    for index in (0..7).chain(10..before.0.len()) {
        assert_eq!(damaged.0[index], before.0[index]);
    }
    assert_eq!(damaged.1, before.1);
    for index in [7, 8, 9] {
        let mut expected: serde_json::Value = serde_json::from_str(&before.0[index]).unwrap();
        expected
            .as_array_mut()
            .unwrap()
            .retain(|row| row[1] != "e:2:0");
        let actual: serde_json::Value = serde_json::from_str(&damaged.0[index]).unwrap();
        assert_eq!(
            actual, expected,
            "delete only the human and its fields/chunks"
        );
    }
    for _ in 0..2 {
        integrity_error(zero_content_read(&f, after.clone()).await);
        assert_eq!(
            zero_content_read(
                &f,
                cursor(&f, 2, 2, Some(RunId::new()), Some("e:2:0".parse().unwrap()))
            )
            .await
            .err(),
            Some(ConversationError::CursorInvalid)
        );
        for id in ["e:2:0", "e:2:1"] {
            assert!(
                matches!(zero_content_read(&f, cursor(&f, 2, 2, Some(f.run.clone()), Some(id.parse().unwrap()))).await, Err(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::NotFound)
            );
        }
        assert!(
            matches!(zero_content_read(&f, cursor(&f, 2, 1, Some(RunId::new()), None)).await, Err(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::NotFound)
        );
        if rank == 2 {
            assert_eq!(
                zero_content_read(
                    &f,
                    cursor(
                        &f,
                        4,
                        2,
                        Some(f.run.clone()),
                        Some("e:2:0".parse().unwrap())
                    )
                )
                .await
                .err()
                .map(|error| match error {
                    ConversationError::Storage(error) => error.kind(),
                    _ => panic!("missing addressed human"),
                }),
                Some(StorageErrorKind::NotFound)
            );
        }
        assert_eq!(snapshot(&f).await, damaged);
    }
    integrity_error(f.handle.conversation_changes(watermark(&f, 1)).await);
    integrity_error(f.handle.conversation_page(ConversationQuery::Latest).await);
    assert_eq!(snapshot(&f).await, damaged);
    f.store.close().await.unwrap();
}
#[tokio::test]
async fn a5b3_b01_exhausted_rank1_requires_mandatory_anchor() {
    missing_anchor(1).await;
}
#[tokio::test]
async fn a5b3_b01_exhausted_rank2_requires_mandatory_anchor() {
    missing_anchor(2).await;
}

#[tokio::test]
async fn a5b3_b01_header_source_revision_and_first_identity_guards() {
    for rank in [1, 2] {
        for statement in [
            "UPDATE conversation_blocks SET header_json=json_set(header_json,'$.human','e:2:1')",
            "INSERT INTO conversation_entries SELECT run_id,'e:1:0',zeroblob(32),1,0,changed_sequence,content_epoch,kind,metadata_json FROM conversation_entries WHERE entry_id='e:2:0'",
            "UPDATE conversation_entries SET source_key=zeroblob(32) WHERE entry_id='e:2:0'",
            "UPDATE conversation_entries SET changed_sequence=3 WHERE entry_id='e:2:0'; UPDATE conversation_blocks SET changed_sequence=2",
        ] {
            let (f, after) = anchor_fixture(rank).await;
            let mut sql = f.sql().await;
            // These metadata/position edits are invalid projector output, not normal writer actions.
            sqlx::raw_sql(statement).execute(&mut sql).await.unwrap();
            sql.close().await.unwrap();
            let damaged = snapshot(&f).await;
            let after = if rank == 1 && statement.contains("SET changed_sequence=3") {
                cursor(&f, 2, 1, Some(f.run.clone()), None)
            } else {
                after
            };
            for _ in 0..2 {
                integrity_error(zero_content_read(&f, after.clone()).await);
            }
            assert_eq!(snapshot(&f).await, damaged);
            f.store.close().await.unwrap();
        }
    }
}

#[tokio::test]
async fn a5b3_b01_older_coalesced_positions_and_error_precedence_survive() {
    let (mut f, entry) = anchor_fixture(2).await;
    let block = cursor(&f, 3, 1, Some(f.run.clone()), None);
    for _ in 0..2 {
        assert_eq!(
            zero_content_read(
                &f,
                cursor(
                    &f,
                    4,
                    2,
                    Some(f.run.clone()),
                    Some("e:2:0".parse().unwrap())
                )
            )
            .await
            .err(),
            Some(ConversationError::CursorInvalid)
        );
        assert_eq!(
            zero_content_read(&f, cursor(&f, 1, 1, Some(f.run.clone()), None))
                .await
                .err(),
            Some(ConversationError::CursorInvalid)
        );
    }
    f.delta(0, "later\0雪").await;
    for after in [block, entry] {
        for _ in 0..2 {
            let batch = acceptance_read(&f, after.clone()).await.unwrap();
            bounded(&batch);
            assert_eq!(batch.observed_head(), 6);
            assert_eq!(batch.changes().len(), 2);
            assert!(batch.changes().iter().any(|change| matches!(change, DisplayChange::BlockUpsert(block) if block.revision() == 6)));
            assert!(batch.changes().iter().any(|change| matches!(change, DisplayChange::EntryUpsert(change) if change.entry().revision() == 6 && change.entry().fields()[0].text() == "later\0雪")));
        }
    }
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b3_b01_nonhuman_anchor_never_reads_tool_fields() {
    use crate::conversation::primitives::{EntrySource, SourceKey};
    for rank in [1, 2] {
        let (f, after) = anchor_fixture(rank).await;
        let key = SourceKey::entry(
            &f.run,
            EntrySource::Tool {
                call_id: "anchor-tool",
            },
        )
        .unwrap();
        let mut sql = f.sql().await;
        // Structurally checked Tool metadata is still not a mandatory Human anchor.
        sqlx::query("UPDATE conversation_entries SET source_key=?,kind='tool',metadata_json=json_set(metadata_json,'$.source',json('{\"type\":\"tool\",\"call_id\":\"anchor-tool\"}'),'$.result_recorded',json('true'),'$.finish_recorded',json('false'),'$.is_error',json('false')) WHERE entry_id='e:2:0'")
            .bind(key.bytes().as_slice()).execute(&mut sql).await.unwrap();
        let row = sqlx::query("SELECT entry_id,source_key,first_sequence,position_slot,changed_sequence,content_epoch,kind,metadata_json FROM conversation_entries WHERE entry_id='e:2:0'").fetch_one(&mut sql).await.unwrap();
        assert!(matches!(
            rows::entry_row(&row, &f.run, after.sequence())
                .unwrap()
                .metadata
                .source,
            rows::Source::Tool { .. }
        ));
        sql.close().await.unwrap();
        for _ in 0..2 {
            integrity_error(zero_content_read(&f, after.clone()).await);
        }
        f.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn a5b3_b01_invalid_revision_precedes_anchor_and_legacy_budget_is_emission_only() {
    let (f, _) = anchor_fixture(2).await;
    f.handle
        .rename(OperationId::new(), "metadata only".into())
        .await
        .unwrap();
    let mut sql = f.sql().await;
    sqlx::query(
        "UPDATE conversation_blocks SET header_json=json_set(header_json,'$.human','e:2:1')",
    )
    .execute(&mut sql)
    .await
    .unwrap();
    sql.close().await.unwrap();
    for _ in 0..2 {
        assert_eq!(
            zero_content_read(
                &f,
                cursor(
                    &f,
                    6,
                    2,
                    Some(f.run.clone()),
                    Some("e:5:0".parse().unwrap())
                )
            )
            .await
            .err(),
            Some(ConversationError::CursorInvalid)
        );
        assert_eq!(
            zero_content_read(&f, cursor(&f, 1, 1, Some(f.run.clone()), None))
                .await
                .err(),
            Some(ConversationError::CursorInvalid)
        );
    }
    f.store.close().await.unwrap();
    for rank in [1, 2] {
        let (f, after) = anchor_fixture(rank).await;
        let mut summary = serde_json::to_value(crate::run::RunSummary::default()).unwrap();
        summary["last_request_id"] = "x".repeat(PAGE_BYTES + 1).into();
        let mut sql = f.sql().await;
        // Synthetic legacy header, not novel writer admission or canonical corruption.
        sqlx::query(
            "UPDATE conversation_blocks SET header_json=json_set(header_json,'$.summary',json(?))",
        )
        .bind(summary.to_string())
        .execute(&mut sql)
        .await
        .unwrap();
        sql.close().await.unwrap();
        let before = snapshot(&f).await;
        for _ in 0..2 {
            let batch = zero_content_read(&f, after.clone()).await.unwrap();
            assert!(batch.changes().is_empty() && !batch.has_more());
            assert_eq!(
                f.handle.conversation_changes(watermark(&f, 1)).await.err(),
                Some(ConversationError::DisplayUnavailable)
            );
            assert_eq!(snapshot(&f).await, before);
        }
        f.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn a5b3_integration_exact_scalar_and_first_position_plans() {
    let (f, _, content, _, _) = tool_fixture("unrelated output\0雪", false, 0).await;
    let mut sql = f.sql().await;
    for query in [
        "SELECT result_sequence,is_error,finished_sequence FROM tool_results WHERE run_id=? AND call_id=?",
        "SELECT entry_id FROM conversation_entries WHERE run_id=? ORDER BY first_sequence,position_slot LIMIT 1",
    ] {
        let mut plan = sqlx::query(sqlx::AssertSqlSafe(format!("EXPLAIN QUERY PLAN {query}")))
            .bind(f.run.as_str());
        if query.contains("call_id=?") {
            plan = plan.bind("actual");
        }
        let details: Vec<String> = plan
            .fetch_all(&mut sql)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get("detail"))
            .collect();
        assert_eq!(details.len(), 1);
        assert!(details[0].contains("SEARCH") && details[0].contains("INDEX"));
        assert!(!details[0].contains("SCAN") && !details[0].contains("TEMP B-TREE"));
        if query.contains("tool_results") {
            assert!(
                details[0].contains("sqlite_autoindex_tool_results_1")
                    && details[0].contains("run_id=? AND call_id=?")
            );
        } else {
            assert!(details[0].contains("conversation_entries_order"));
        }
        println!("exact bounded plan {query}: {details:?}");
    }
    let opcodes = sqlx::query(
        "EXPLAIN SELECT result_sequence,is_error,finished_sequence FROM tool_results WHERE run_id=? AND call_id=?",
    )
    .bind(f.run.as_str())
    .bind("actual")
    .fetch_all(&mut sql)
    .await
    .unwrap();
    let columns: Vec<i64> = opcodes
        .iter()
        .filter(|row| row.get::<String, _>("opcode") == "Column")
        .map(|row| row.get("p2"))
        .collect();
    assert_eq!(columns, [6, 7, 5]);
    println!(
        "scalar VDBE reads only result_sequence/is_error/finished_sequence columns={columns:?}; output column 8 is absent"
    );
    sql.close().await.unwrap();
    let control_initial = f.store.inner.hooks.measurements();
    f.entry("e:2:0").await;
    let control_bytes = f.store.inner.hooks.measurements().validation_payload_bytes
        - control_initial.validation_payload_bytes;
    let initial = f.store.inner.hooks.measurements();
    let page = f.handle.conversation_content(content).await.unwrap();
    let measured = f.store.inner.hooks.measurements();
    assert_eq!(page.entry().fields().len(), 1);
    assert_eq!(page.entry().fields()[0].kind(), FieldKind::ToolName);
    // Only the mandatory human and requested name text are loaded, never result output or event payloads.
    assert_eq!(
        measured.conversation_bytes - initial.conversation_bytes,
        "actual human\0雪".len() + "synthetic tool".len()
    );
    // The existing public connection and snapshot checks read creation identity twice.
    assert_eq!(
        measured.validation_payload_bytes - initial.validation_payload_bytes,
        control_bytes
    );
    println!(
        "name-only production content_bytes={} validation_payload_bytes={}",
        measured.conversation_bytes - initial.conversation_bytes,
        measured.validation_payload_bytes - initial.validation_payload_bytes
    );
    f.store.close().await.unwrap();
}
