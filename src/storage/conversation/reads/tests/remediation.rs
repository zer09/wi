use super::*;
use crate::storage::identifier_tests;
use std::collections::BTreeMap;

async fn contents(f: &Fixture, mut page: EntryPage) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::<String, String>::new();
    loop {
        bounded(&page);
        for field in page.entry().fields() {
            fields
                .entry(field.field_id().into())
                .or_default()
                .insert_str(0, field.text());
        }
        let Some(cursor) = page.entry().earlier_content().cloned() else {
            return fields;
        };
        page = f.handle.conversation_content(cursor).await.unwrap();
    }
}

#[tokio::test]
async fn a5b1_remediation_human_zero_upper_is_invalid_but_damage_is_integrity() {
    let text = "h".repeat(60000);
    let f = Fixture::new(&text).await;
    let first = f.entry("e:2:0").await;
    let original = first.entry().earlier_content().unwrap().clone();
    let zero = ContentCursor::new(
        original.session_id().clone(),
        original.run_id().clone(),
        *original.entry_id(),
        original.content_epoch(),
        original.upper_field_id().into(),
        original.upper_generation(),
        0,
    )
    .unwrap();
    let before = identifier_tests::snapshot(&f.path).await;
    assert_eq!(
        f.handle
            .conversation_content(zero.to_string().parse().unwrap())
            .await
            .err(),
        Some(ConversationError::CursorInvalid)
    );
    let previous = f
        .handle
        .conversation_content(original.clone())
        .await
        .unwrap();
    assert_eq!(
        previous.entry().fields()[0].to_byte(),
        original.exclusive_upper_byte()
    );
    assert_eq!(
        contents(&f, f.entry("e:2:0").await)
            .await
            .values()
            .next()
            .unwrap(),
        &text
    );
    assert_eq!(identifier_tests::snapshot(&f.path).await, before);
    f.store.close().await.unwrap();

    for statement in [
        "DELETE FROM conversation_chunks WHERE field_id='text'; DELETE FROM conversation_fields WHERE field_id='text'",
        "UPDATE conversation_fields SET kind='refusal' WHERE field_id='text'",
        "UPDATE conversation_fields SET order_key='bad' WHERE field_id='text'",
    ] {
        let f = Fixture::new(&text).await;
        let cursor = f
            .entry("e:2:0")
            .await
            .entry()
            .earlier_content()
            .unwrap()
            .clone();
        let mut sql = f.sql().await;
        sqlx::raw_sql(statement).execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        let damaged = identifier_tests::snapshot(&f.path).await;
        for error in [
            f.handle
                .conversation_entry(f.run.clone(), "e:2:0".parse().unwrap())
                .await
                .err()
                .unwrap(),
            f.handle.conversation_content(cursor).await.err().unwrap(),
        ] {
            assert!(
                matches!(error, ConversationError::Storage(error) if error.kind() == StorageErrorKind::Integrity),
                "{statement}: {error:?}"
            );
        }
        assert_eq!(identifier_tests::snapshot(&f.path).await, damaged);
        f.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn a5b1_remediation_lower_field_invalidates_only_incompatible_cursors() {
    for index in [5, 15, 10] {
        let mut f = Fixture::new("anchor").await;
        f.start().await;
        let text = "x".repeat(90000);
        f.delta(10, &text).await;
        let first = f.entry("e:5:0").await;
        let cursor = first.entry().earlier_content().unwrap().clone();
        let old = f.handle.conversation_content(cursor.clone()).await.unwrap();
        let old_contents = contents(&f, old).await;
        let before = identifier_tests::snapshot(&f.path).await;
        f.delta(index, "new content").await;
        let fresh = f.entry("e:5:0").await;
        assert_eq!(fresh.entry().entry_id(), first.entry().entry_id());
        assert_eq!(fresh.entry().position(), first.entry().position());
        assert!(fresh.snapshot_head() > first.snapshot_head());
        let mut sql = f.sql().await;
        let generation: i64 = sqlx::query_scalar("SELECT generation FROM conversation_fields WHERE run_id=? AND entry_id=? AND field_id=?")
            .bind(f.run.as_str()).bind("e:5:0").bind(cursor.upper_field_id())
            .fetch_one(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        assert_eq!(generation as u64, cursor.upper_generation());
        if index == 5 {
            assert_eq!(fresh.entry().content_epoch(), fresh.snapshot_head());
            assert_eq!(
                f.handle.conversation_content(cursor.clone()).await.err(),
                Some(ConversationError::CursorStale)
            );
        } else {
            assert_eq!(fresh.entry().content_epoch(), first.entry().content_epoch());
            let compatible = f.handle.conversation_content(cursor.clone()).await.unwrap();
            assert_eq!(compatible.snapshot_head(), fresh.snapshot_head());
            assert_eq!(
                compatible.entry().fields()[0].to_byte(),
                cursor.exclusive_upper_byte()
            );
            assert_eq!(contents(&f, compatible).await, old_contents);
        }
        if index == 15 {
            let preceding = fresh.entry().earlier_content().unwrap();
            assert_eq!(preceding.exclusive_upper_byte(), 0);
            let previous = f
                .handle
                .conversation_content(preceding.clone())
                .await
                .unwrap();
            assert_eq!(
                previous.entry().fields()[0].field_id(),
                cursor.upper_field_id()
            );
        }
        let all = contents(&f, fresh).await;
        if index == 10 {
            assert_eq!(all.len(), 1);
            assert_eq!(all.values().next().unwrap(), &(text + "new content"));
        } else {
            assert_eq!(all.len(), 2);
            assert_eq!(all.get(cursor.upper_field_id()).unwrap(), &text);
            assert!(all.values().any(|value| value == "new content"));
            let after = identifier_tests::snapshot(&f.path).await;
            // Existing descriptor and chunk rows remain byte-identical after either insertion.
            let old_fields: serde_json::Value = serde_json::from_str(&before[8]).unwrap();
            let new_fields: serde_json::Value = serde_json::from_str(&after[8]).unwrap();
            for row in old_fields.as_array().unwrap() {
                assert!(new_fields.as_array().unwrap().contains(row));
            }
            let old_chunks: serde_json::Value = serde_json::from_str(&before[9]).unwrap();
            let new_chunks: serde_json::Value = serde_json::from_str(&after[9]).unwrap();
            for row in old_chunks.as_array().unwrap() {
                assert!(new_chunks.as_array().unwrap().contains(row));
            }
        }
        let mut sql = f.sql().await;
        let plan: Vec<String> = sqlx::query("EXPLAIN QUERY PLAN SELECT order_key FROM conversation_fields WHERE run_id=? AND entry_id=? AND order_key>? ORDER BY order_key LIMIT 1")
            .bind(f.run.as_str()).bind("e:5:0").bind("0")
            .fetch_all(&mut sql).await.unwrap().iter().map(|row| row.get("detail")).collect();
        assert!(
            plan.iter()
                .any(|line| line.contains("SEARCH") && line.contains("INDEX"))
        );
        assert!(
            !plan
                .iter()
                .any(|line| line.contains("SCAN") || line.contains("TEMP B-TREE"))
        );
        println!("a5b1 remediation insertion EXPLAIN {}", plan.join("; "));
        sql.close().await.unwrap();
        f.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn a5b1_remediation_recorded_tool_requires_descriptor_even_for_other_fragments_and_reuse() {
    let deletion = "DELETE FROM conversation_chunks WHERE field_id IN (SELECT field_id FROM conversation_fields WHERE kind='tool_result'); DELETE FROM conversation_fields WHERE kind='tool_result'";
    for (output, finish, damage) in [
        ("sixteen bytes!!!".to_owned(), true, deletion),
        (String::new(), false, deletion),
        ("x".repeat(90000), false, deletion),
        (
            String::new(),
            false,
            "UPDATE conversation_fields SET kind='tool_name' WHERE kind='tool_result'",
        ),
        (
            String::new(),
            false,
            "UPDATE conversation_fields SET order_key='bad' WHERE kind='tool_result'",
        ),
        (
            String::new(),
            false,
            "UPDATE conversation_fields SET field_id=printf('%064d',1) WHERE kind='tool_result'",
        ),
        (
            String::new(),
            false,
            "UPDATE conversation_fields SET generation=1 WHERE kind='tool_result'",
        ),
        (
            String::new(),
            false,
            "UPDATE conversation_fields SET generation=(SELECT head_sequence FROM manifest) WHERE kind='tool_result'",
        ),
    ] {
        let mut f = Fixture::new("anchor").await;
        f.start().await;
        assert!(f.entry("e:5:0").await.entry().fields().is_empty());
        f.delta(0, "healthy assistant").await;
        f.runtime(RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted {
                call_id: "call".into(),
                tool_name: "synthetic tool".into(),
            },
        })
        .await;
        let pending = f.entry("e:7:0").await;
        assert_eq!(pending.entry().result_recorded(), Some(false));
        f.handle
            .append_run_records(
                OperationId::new(),
                f.run.clone(),
                vec![AppendRunRecord::ToolResult {
                    request_id: Some(REQUEST.into()),
                    call_id: "call".into(),
                    output: output.clone(),
                    is_error: false,
                }],
            )
            .await
            .unwrap();
        if finish {
            f.runtime(RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionFinished {
                    call_id: "call".into(),
                    tool_name: "synthetic tool".into(),
                    is_error: false,
                },
            })
            .await;
        }
        let tool = f.entry("e:7:0").await;
        assert_eq!(tool.entry().result_recorded(), Some(true));
        assert_eq!(tool.entry().finish_recorded(), Some(finish));
        assert_eq!(tool.entry().is_error(), Some(false));
        let all = contents(&f, tool.clone()).await;
        assert_eq!(all.len(), 2);
        assert!(all.values().any(|value| value == &output));
        let name = pending.entry().fields().first().unwrap();
        let name_cursor = ContentCursor::new(
            f.handle.session_id().clone(),
            f.run.clone(),
            *tool.entry().entry_id(),
            tool.entry().content_epoch(),
            name.field_id().into(),
            name.generation(),
            name.total_bytes(),
        )
        .unwrap();
        let name_page = f
            .handle
            .conversation_content(name_cursor.clone())
            .await
            .unwrap();
        assert_eq!(name_page.entry().fields()[0].kind(), FieldKind::ToolName);
        let reuse_id = format!("e:{}:0", tool.snapshot_head() + 1);
        f.runtime(RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolResultReused {
                call_id: "call".into(),
                tool_name: "synthetic tool".into(),
            },
        })
        .await;
        assert_eq!(f.entry(&reuse_id).await.entry().kind(), EntryKind::Reuse);
        let before = identifier_tests::snapshot(&f.path).await;
        let mut sql = f.sql().await;
        sqlx::raw_sql(damage).execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        let damaged = identifier_tests::snapshot(&f.path).await;
        assert_eq!(&damaged[..8], &before[..8]);
        for error in [
            f.handle
                .conversation_entry(f.run.clone(), "e:7:0".parse().unwrap())
                .await
                .err(),
            f.handle.conversation_content(name_cursor).await.err(),
            f.handle
                .conversation_entry(f.run.clone(), reuse_id.parse().unwrap())
                .await
                .err(),
        ] {
            assert!(
                matches!(error, Some(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Integrity),
                "damaged recorded result ({damage}): {error:?}"
            );
        }
        assert_eq!(f.entry("e:2:0").await.entry().fields()[0].text(), "anchor");
        assert_eq!(
            f.entry("e:5:0").await.entry().fields()[0].text(),
            "healthy assistant"
        );
        assert_eq!(identifier_tests::snapshot(&f.path).await, damaged);
        f.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn a5b1_remediation_finish_without_result_does_not_require_descriptor() {
    let mut f = Fixture::new("anchor").await;
    f.start().await;
    assert!(f.entry("e:5:0").await.entry().fields().is_empty());
    f.runtime(RunEvent::ToolEvent {
        event: ToolExecutionEvent::ToolExecutionStarted {
            call_id: "call".into(),
            tool_name: "synthetic tool".into(),
        },
    })
    .await;
    assert_eq!(
        f.entry("e:6:0").await.entry().result_recorded(),
        Some(false)
    );
    f.runtime(RunEvent::ToolEvent {
        event: ToolExecutionEvent::ToolExecutionFinished {
            call_id: "call".into(),
            tool_name: "synthetic tool".into(),
            is_error: true,
        },
    })
    .await;
    let tool = f.entry("e:6:0").await;
    assert_eq!(tool.entry().result_recorded(), Some(false));
    assert_eq!(tool.entry().finish_recorded(), Some(true));
    assert_eq!(tool.entry().is_error(), Some(true));
    assert_eq!(tool.entry().fields().len(), 1);
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b1_b04_reuse_requires_recorded_result() {
    let mut failures = Vec::new();
    let mut cases = 0;
    for is_error in [false, true] {
        for output in ["", "synthetic \0λ result"] {
            for finish in ["absent", "before", "after"] {
                let mut f = Fixture::new("anchor").await;
                f.start().await;
                f.delta(0, "healthy assistant").await;
                f.runtime(RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolExecutionStarted {
                        call_id: "call".into(),
                        tool_name: "synthetic tool".into(),
                    },
                })
                .await;
                let pending = f.entry("e:7:0").await;
                assert_eq!(pending.entry().result_recorded(), Some(false));
                assert_eq!(pending.entry().finish_recorded(), Some(false));
                assert_eq!(pending.entry().is_error(), None);
                let finished = RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolExecutionFinished {
                        call_id: "call".into(),
                        tool_name: "synthetic tool".into(),
                        is_error,
                    },
                };
                if finish == "before" {
                    f.runtime(finished.clone()).await;
                }
                let operation = OperationId::new();
                let committed = f
                    .handle
                    .append_run_records(
                        operation.clone(),
                        f.run.clone(),
                        vec![AppendRunRecord::ToolResult {
                            request_id: Some(REQUEST.into()),
                            call_id: "call".into(),
                            output: output.into(),
                            is_error,
                        }],
                    )
                    .await
                    .unwrap();
                if finish == "after" {
                    f.runtime(finished).await;
                }
                let tool = f.entry("e:7:0").await;
                assert_eq!(tool.entry().result_recorded(), Some(true));
                assert_eq!(tool.entry().finish_recorded(), Some(finish != "absent"));
                assert_eq!(tool.entry().is_error(), Some(is_error));
                let result = tool
                    .entry()
                    .fields()
                    .iter()
                    .find(|field| field.kind() == FieldKind::ToolResult)
                    .unwrap();
                assert_eq!(result.text().as_bytes(), output.as_bytes());
                assert_eq!(result.total_bytes(), output.len() as u64);
                let reuse_id = format!("e:{}:0", tool.snapshot_head() + 1);
                f.runtime(RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolResultReused {
                        call_id: "call".into(),
                        tool_name: "synthetic tool".into(),
                    },
                })
                .await;
                let reuse = f.entry(&reuse_id).await;
                bounded(&reuse);
                assert_eq!(reuse.entry().kind(), EntryKind::Reuse);
                assert_eq!(reuse.entry().result_recorded(), Some(true));
                assert_eq!(reuse.entry().finish_recorded(), Some(finish != "absent"));
                assert_eq!(reuse.entry().is_error(), Some(is_error));
                let reference = reuse.entry().reference().unwrap();
                assert_eq!(reference.run_id(), &f.run);
                assert_eq!(reference.entry_id(), tool.entry().entry_id());
                assert!(reuse.entry().fields().is_empty());
                assert!(reuse.entry().earlier_content().is_none());
                assert!(reuse.entry().content_complete());

                let mut controls = Vec::new();
                for (call, finished) in [("pending", false), ("no-result", true)] {
                    let id = format!("e:{}:0", f.entry(&reuse_id).await.snapshot_head() + 1);
                    f.runtime(RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolExecutionStarted {
                            call_id: call.into(),
                            tool_name: "synthetic tool".into(),
                        },
                    })
                    .await;
                    if finished {
                        f.runtime(RunEvent::ToolEvent {
                            event: ToolExecutionEvent::ToolExecutionFinished {
                                call_id: call.into(),
                                tool_name: "synthetic tool".into(),
                                is_error,
                            },
                        })
                        .await;
                    }
                    let page = f.entry(&id).await;
                    assert_eq!(page.entry().result_recorded(), Some(false));
                    assert_eq!(page.entry().finish_recorded(), Some(finished));
                    assert_eq!(page.entry().is_error(), finished.then_some(is_error));
                    controls.push(id);
                }
                controls.extend(["e:7:0".into(), "e:2:0".into(), "e:5:0".into()]);
                let mut healthy = Vec::new();
                for id in &controls {
                    let page = f.entry(id).await;
                    bounded(&page);
                    if matches!(page.entry().kind(), EntryKind::Human | EntryKind::Assistant) {
                        assert_eq!(page.entry().result_recorded(), None);
                        assert_eq!(page.entry().finish_recorded(), None);
                        assert_eq!(page.entry().is_error(), None);
                    }
                    healthy.push(DisplayJson::EntryPage(&page).encode().unwrap());
                }
                let head = f.entry(&reuse_id).await.snapshot_head();
                let before = identifier_tests::snapshot(&f.path).await;
                for table in &before[8..] {
                    let rows: serde_json::Value = serde_json::from_str(table).unwrap();
                    assert!(
                        rows.as_array()
                            .unwrap()
                            .iter()
                            .all(|row| row[1] != reuse_id)
                    );
                }
                let history =
                    serde_json::to_vec(&f.handle.history_page(0, None, 100).await.unwrap())
                        .unwrap();
                let raw_before = f
                    .handle
                    .tool_result(f.run.clone(), "call".into())
                    .await
                    .unwrap()
                    .unwrap();
                let receipt = serde_json::to_vec(committed.receipt()).unwrap();
                assert_eq!(
                    serde_json::to_vec(
                        &f.handle
                            .lookup_receipt(operation.clone())
                            .await
                            .unwrap()
                            .unwrap()
                    )
                    .unwrap(),
                    receipt
                );
                let mut sql = f.sql().await;
                let changed = sqlx::query("UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.result_recorded',json('false')) WHERE run_id=? AND entry_id=?")
                    .bind(f.run.as_str()).bind(&reuse_id).execute(&mut sql).await.unwrap();
                assert_eq!(changed.rows_affected(), 1);
                sql.close().await.unwrap();
                let damaged = identifier_tests::snapshot(&f.path).await;
                assert_eq!(&damaged[..7], &before[..7]);
                assert_eq!(&damaged[8..], &before[8..]);
                let mut expected: serde_json::Value = serde_json::from_str(&before[7]).unwrap();
                let actual: serde_json::Value = serde_json::from_str(&damaged[7]).unwrap();
                let mut changed_rows = 0;
                for row in expected.as_array_mut().unwrap() {
                    if row[1] == reuse_id {
                        let metadata = row[8].as_str().unwrap();
                        assert_eq!(metadata.matches("\"result_recorded\":true").count(), 1);
                        row[8] = metadata
                            .replacen("\"result_recorded\":true", "\"result_recorded\":false", 1)
                            .into();
                        changed_rows += 1;
                    }
                }
                assert_eq!(changed_rows, 1);
                assert_eq!(expected, actual);
                // Read twice so a repair cannot turn a corrupt row into a successful page.
                for attempt in 1..=2 {
                    let read = f
                        .handle
                        .conversation_entry(f.run.clone(), reuse_id.parse().unwrap())
                        .await;
                    let error = read.err();
                    if !matches!(error, Some(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Integrity)
                    {
                        failures.push(format!("is_error={is_error} bytes={} finish={finish} read={attempt}: {error:?}", output.len()));
                    } else {
                        assert_eq!(error.unwrap().to_string(), "storage.integrity");
                    }
                    assert_eq!(identifier_tests::snapshot(&f.path).await, damaged);
                }
                for (id, bytes) in controls.iter().zip(healthy) {
                    let page = f.entry(id).await;
                    bounded(&page);
                    assert_eq!(page.snapshot_head(), head);
                    assert_eq!(DisplayJson::EntryPage(&page).encode().unwrap(), bytes);
                }
                let raw = f
                    .handle
                    .tool_result(f.run.clone(), "call".into())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(raw.output().unwrap().as_bytes(), output.as_bytes());
                assert_eq!(raw.is_error(), Some(is_error));
                assert_eq!(raw.run_id(), raw_before.run_id());
                assert_eq!(raw.call_id(), raw_before.call_id());
                assert_eq!(raw.tool_name(), raw_before.tool_name());
                assert_eq!(raw.request_id(), raw_before.request_id());
                assert_eq!(raw.started_sequence(), raw_before.started_sequence());
                assert_eq!(raw.result_sequence(), raw_before.result_sequence());
                assert_eq!(raw.finished_sequence(), raw_before.finished_sequence());
                assert_eq!(
                    serde_json::to_vec(&f.handle.history_page(0, None, 100).await.unwrap())
                        .unwrap(),
                    history
                );
                assert_eq!(
                    serde_json::to_vec(&f.handle.lookup_receipt(operation).await.unwrap().unwrap())
                        .unwrap(),
                    receipt
                );
                assert_eq!(identifier_tests::snapshot(&f.path).await, damaged);
                f.store.close().await.unwrap();
                cases += 1;
            }
        }
    }
    assert_eq!(cases, 12);
    println!(
        "A5b1-B-04: {cases} cases, 24 repeated reads, {} missing integrity errors",
        failures.len()
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn rb01_reuse_requires_matching_actual_is_error() {
    let mut failures = Vec::new();
    let mut cases = 0;
    for is_error in [false, true] {
        for output in ["", "synthetic \0λ result"] {
            for finish in ["absent", "before", "after"] {
                let mut f = Fixture::new("anchor").await;
                f.start().await;
                f.delta(0, "healthy assistant").await;
                f.runtime(RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolExecutionStarted {
                        call_id: "call".into(),
                        tool_name: "synthetic tool".into(),
                    },
                })
                .await;
                let pending = f.entry("e:7:0").await;
                assert_eq!(pending.entry().result_recorded(), Some(false));
                assert_eq!(pending.entry().finish_recorded(), Some(false));
                assert_eq!(pending.entry().is_error(), None);
                let finished = RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolExecutionFinished {
                        call_id: "call".into(),
                        tool_name: "synthetic tool".into(),
                        is_error,
                    },
                };
                if finish == "before" {
                    f.runtime(finished.clone()).await;
                }
                let operation = OperationId::new();
                let committed = f
                    .handle
                    .append_run_records(
                        operation.clone(),
                        f.run.clone(),
                        vec![AppendRunRecord::ToolResult {
                            request_id: Some(REQUEST.into()),
                            call_id: "call".into(),
                            output: output.into(),
                            is_error,
                        }],
                    )
                    .await
                    .unwrap();
                if finish == "after" {
                    f.runtime(finished).await;
                }
                let tool = f.entry("e:7:0").await;
                assert_eq!(tool.entry().result_recorded(), Some(true));
                assert_eq!(tool.entry().finish_recorded(), Some(finish != "absent"));
                assert_eq!(tool.entry().is_error(), Some(is_error));
                let result = tool
                    .entry()
                    .fields()
                    .iter()
                    .find(|field| field.kind() == FieldKind::ToolResult)
                    .unwrap();
                assert_eq!(result.text().as_bytes(), output.as_bytes());
                assert_eq!(result.total_bytes(), output.len() as u64);
                let reuse_id = format!("e:{}:0", tool.snapshot_head() + 1);
                f.runtime(RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolResultReused {
                        call_id: "call".into(),
                        tool_name: "synthetic tool".into(),
                    },
                })
                .await;
                let reuse = f.entry(&reuse_id).await;
                bounded(&reuse);
                assert_eq!(reuse.entry().kind(), EntryKind::Reuse);
                assert_eq!(reuse.entry().result_recorded(), Some(true));
                assert_eq!(reuse.entry().finish_recorded(), Some(finish != "absent"));
                assert_eq!(reuse.entry().is_error(), Some(is_error));
                let reference = reuse.entry().reference().unwrap();
                assert_eq!(reference.run_id(), &f.run);
                assert_eq!(reference.entry_id(), tool.entry().entry_id());
                assert!(reuse.entry().fields().is_empty());
                assert!(reuse.entry().earlier_content().is_none());
                assert!(reuse.entry().content_complete());

                let mut controls = Vec::new();
                for (call, finished) in [("pending", false), ("no-result", true)] {
                    let id = format!("e:{}:0", f.entry(&reuse_id).await.snapshot_head() + 1);
                    f.runtime(RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolExecutionStarted {
                            call_id: call.into(),
                            tool_name: "synthetic tool".into(),
                        },
                    })
                    .await;
                    if finished {
                        f.runtime(RunEvent::ToolEvent {
                            event: ToolExecutionEvent::ToolExecutionFinished {
                                call_id: call.into(),
                                tool_name: "synthetic tool".into(),
                                is_error,
                            },
                        })
                        .await;
                    }
                    let page = f.entry(&id).await;
                    assert_eq!(page.entry().result_recorded(), Some(false));
                    assert_eq!(page.entry().finish_recorded(), Some(finished));
                    assert_eq!(page.entry().is_error(), finished.then_some(is_error));
                    controls.push(id);
                }
                controls.extend(["e:7:0".into(), "e:2:0".into(), "e:5:0".into()]);
                let mut healthy = Vec::new();
                for id in &controls {
                    let page = f.entry(id).await;
                    bounded(&page);
                    if matches!(page.entry().kind(), EntryKind::Human | EntryKind::Assistant) {
                        assert_eq!(page.entry().result_recorded(), None);
                        assert_eq!(page.entry().finish_recorded(), None);
                        assert_eq!(page.entry().is_error(), None);
                    }
                    healthy.push(DisplayJson::EntryPage(&page).encode().unwrap());
                }
                let head = f.entry(&reuse_id).await.snapshot_head();
                let before = identifier_tests::snapshot(&f.path).await;
                // Reuse points to saved content; it owns no descriptors or output chunks.
                for table in &before[8..] {
                    let rows: serde_json::Value = serde_json::from_str(table).unwrap();
                    assert!(
                        rows.as_array()
                            .unwrap()
                            .iter()
                            .all(|row| row[1] != reuse_id)
                    );
                }
                let history =
                    serde_json::to_vec(&f.handle.history_page(0, None, 100).await.unwrap())
                        .unwrap();
                let raw_before = f
                    .handle
                    .tool_result(f.run.clone(), "call".into())
                    .await
                    .unwrap();
                let receipt = serde_json::to_vec(committed.receipt()).unwrap();
                assert_eq!(
                    serde_json::to_vec(
                        &f.handle
                            .lookup_receipt(operation.clone())
                            .await
                            .unwrap()
                            .unwrap()
                    )
                    .unwrap(),
                    receipt
                );
                let mut sql = f.sql().await;
                let changed = sqlx::query("UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.is_error',json(?)) WHERE run_id=? AND entry_id=?")
                    .bind((!is_error).to_string()).bind(f.run.as_str()).bind(&reuse_id)
                    .execute(&mut sql).await.unwrap();
                assert_eq!(changed.rows_affected(), 1);
                sql.close().await.unwrap();
                let damaged = identifier_tests::snapshot(&f.path).await;
                assert_eq!(&damaged[..7], &before[..7]);
                assert_eq!(&damaged[8..], &before[8..]);
                let mut expected: serde_json::Value = serde_json::from_str(&before[7]).unwrap();
                let actual: serde_json::Value = serde_json::from_str(&damaged[7]).unwrap();
                let mut changed_rows = 0;
                for row in expected.as_array_mut().unwrap() {
                    if row[1] == reuse_id {
                        let metadata = row[8].as_str().unwrap();
                        let old = format!("\"is_error\":{is_error}");
                        let new = format!("\"is_error\":{}", !is_error);
                        assert_eq!(metadata.matches(&old).count(), 1);
                        row[8] = metadata.replacen(&old, &new, 1).into();
                        changed_rows += 1;
                    }
                }
                assert_eq!(changed_rows, 1);
                assert_eq!(expected, actual);
                // Repeated rejection must leave the damaged row intact, not repair it.
                for attempt in 1..=2 {
                    let error = f
                        .handle
                        .conversation_entry(f.run.clone(), reuse_id.parse().unwrap())
                        .await
                        .err();
                    if !matches!(error, Some(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Integrity)
                    {
                        failures.push(format!("is_error={is_error} bytes={} finish={finish} read={attempt}: {error:?}", output.len()));
                    } else {
                        assert_eq!(error.unwrap().to_string(), "storage.integrity");
                    }
                    assert_eq!(identifier_tests::snapshot(&f.path).await, damaged);
                }
                for (id, bytes) in controls.iter().zip(healthy) {
                    let page = f.entry(id).await;
                    bounded(&page);
                    assert_eq!(page.snapshot_head(), head);
                    assert_eq!(DisplayJson::EntryPage(&page).encode().unwrap(), bytes);
                }
                let raw = f
                    .handle
                    .tool_result(f.run.clone(), "call".into())
                    .await
                    .unwrap();
                let raw = raw.unwrap();
                let raw_before = raw_before.unwrap();
                assert_eq!(raw.output().unwrap().as_bytes(), output.as_bytes());
                assert_eq!(raw.is_error(), Some(is_error));
                assert_eq!(raw.run_id(), raw_before.run_id());
                assert_eq!(raw.call_id(), raw_before.call_id());
                assert_eq!(raw.tool_name(), raw_before.tool_name());
                assert_eq!(raw.request_id(), raw_before.request_id());
                assert_eq!(raw.started_sequence(), raw_before.started_sequence());
                assert_eq!(raw.result_sequence(), raw_before.result_sequence());
                assert_eq!(raw.finished_sequence(), raw_before.finished_sequence());
                assert_eq!(
                    serde_json::to_vec(&f.handle.history_page(0, None, 100).await.unwrap())
                        .unwrap(),
                    history
                );
                assert_eq!(
                    serde_json::to_vec(&f.handle.lookup_receipt(operation).await.unwrap().unwrap())
                        .unwrap(),
                    receipt
                );
                assert_eq!(identifier_tests::snapshot(&f.path).await, damaged);
                f.store.close().await.unwrap();
                cases += 1;
            }
        }
    }
    assert_eq!(cases, 12);
    println!(
        "RB-01: {cases} cases, 24 repeated reads, {} missing integrity errors",
        failures.len()
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn rb01_reuse_allows_later_matching_finish() {
    let mut cases = 0;
    for is_error in [false, true] {
        for output in ["", "synthetic \0λ result"] {
            let mut f = Fixture::new("anchor").await;
            f.start().await;
            f.runtime(RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionStarted {
                    call_id: "call".into(),
                    tool_name: "synthetic tool".into(),
                },
            })
            .await;
            f.handle
                .append_run_records(
                    OperationId::new(),
                    f.run.clone(),
                    vec![AppendRunRecord::ToolResult {
                        request_id: Some(REQUEST.into()),
                        call_id: "call".into(),
                        output: output.into(),
                        is_error,
                    }],
                )
                .await
                .unwrap();
            let tool = f.entry("e:6:0").await;
            let reuse_id = format!("e:{}:0", tool.snapshot_head() + 1);
            f.runtime(RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolResultReused {
                    call_id: "call".into(),
                    tool_name: "synthetic tool".into(),
                },
            })
            .await;
            let reuse = f.entry(&reuse_id).await;
            assert_eq!(reuse.entry().finish_recorded(), Some(false));
            let before = identifier_tests::snapshot(&f.path).await;
            f.runtime(RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionFinished {
                    call_id: "call".into(),
                    tool_name: "synthetic tool".into(),
                    is_error,
                },
            })
            .await;
            let after_finish = identifier_tests::snapshot(&f.path).await;
            let rows_before: serde_json::Value = serde_json::from_str(&before[7]).unwrap();
            let rows_after: serde_json::Value = serde_json::from_str(&after_finish[7]).unwrap();
            let occurrence = |rows: &serde_json::Value| {
                rows.as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row[1] == reuse_id)
                    .unwrap()
                    .clone()
            };
            assert_eq!(occurrence(&rows_before), occurrence(&rows_after));
            assert_eq!(&before[8..], &after_finish[8..]);
            for _ in 0..2 {
                let current = f.entry(&reuse_id).await;
                let target = f.entry("e:6:0").await;
                bounded(&current);
                bounded(&target);
                assert!(current.snapshot_head() > reuse.snapshot_head());
                assert_eq!(
                    DisplayJson::Entry(current.entry()).encode().unwrap(),
                    DisplayJson::Entry(reuse.entry()).encode().unwrap()
                );
                assert_eq!(current.entry().finish_recorded(), Some(false));
                assert_eq!(target.entry().finish_recorded(), Some(true));
                assert_eq!(current.entry().result_recorded(), Some(true));
                assert_eq!(target.entry().result_recorded(), Some(true));
                assert_eq!(current.entry().is_error(), Some(is_error));
                assert_eq!(target.entry().is_error(), Some(is_error));
                assert_eq!(current.entry().reference().unwrap().run_id(), &f.run);
                assert_eq!(
                    current.entry().reference().unwrap().entry_id(),
                    target.entry().entry_id()
                );
                assert!(current.entry().fields().is_empty());
                assert!(current.entry().earlier_content().is_none());
                assert!(current.entry().content_complete());
                let result = target
                    .entry()
                    .fields()
                    .iter()
                    .find(|field| field.kind() == FieldKind::ToolResult)
                    .unwrap();
                assert_eq!(result.text().as_bytes(), output.as_bytes());
                assert_eq!(identifier_tests::snapshot(&f.path).await, after_finish);
            }
            f.store.close().await.unwrap();
            cases += 1;
        }
    }
    assert_eq!(cases, 4);
    println!("RB-01 later finish: {cases} valid occurrence controls");
}

#[tokio::test]
async fn a5b1_remediation_recorded_result_requires_actual_is_error() {
    let mut failures = Vec::new();
    for is_error in [false, true] {
        for output in ["", "sixteen bytes!!!"] {
            for finish in ["absent", "before", "after"] {
                for damage in ["tool", "reuse"] {
                    let mut f = Fixture::new("anchor").await;
                    f.start().await;
                    f.delta(0, "healthy assistant").await;
                    f.runtime(RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolExecutionStarted {
                            call_id: "call".into(),
                            tool_name: "synthetic tool".into(),
                        },
                    })
                    .await;
                    let pending = f.entry("e:7:0").await;
                    assert_eq!(pending.entry().result_recorded(), Some(false));
                    assert_eq!(pending.entry().is_error(), None);
                    let finished = RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolExecutionFinished {
                            call_id: "call".into(),
                            tool_name: "synthetic tool".into(),
                            is_error,
                        },
                    };
                    // The canonical store rejects conflicting finish/result flags.
                    if finish == "before" {
                        f.runtime(finished.clone()).await;
                    }
                    f.handle
                        .append_run_records(
                            OperationId::new(),
                            f.run.clone(),
                            vec![AppendRunRecord::ToolResult {
                                request_id: Some(REQUEST.into()),
                                call_id: "call".into(),
                                output: output.into(),
                                is_error,
                            }],
                        )
                        .await
                        .unwrap();
                    if finish == "after" {
                        f.runtime(finished).await;
                    }
                    let tool = f.entry("e:7:0").await;
                    bounded(&tool);
                    assert_eq!(tool.entry().result_recorded(), Some(true));
                    assert_eq!(tool.entry().finish_recorded(), Some(finish != "absent"));
                    assert_eq!(tool.entry().is_error(), Some(is_error));
                    let result = tool
                        .entry()
                        .fields()
                        .iter()
                        .find(|field| field.kind() == FieldKind::ToolResult)
                        .unwrap();
                    assert_eq!(result.text().as_bytes(), output.as_bytes());
                    assert_eq!(result.total_bytes(), output.len() as u64);
                    let name = &pending.entry().fields()[0];
                    let name_cursor = ContentCursor::new(
                        f.handle.session_id().clone(),
                        f.run.clone(),
                        *tool.entry().entry_id(),
                        tool.entry().content_epoch(),
                        name.field_id().into(),
                        name.generation(),
                        name.total_bytes(),
                    )
                    .unwrap();
                    let name_page = f
                        .handle
                        .conversation_content(name_cursor.clone())
                        .await
                        .unwrap();
                    bounded(&name_page);
                    assert_eq!(name_page.entry().is_error(), Some(is_error));
                    assert_eq!(name_page.entry().fields().len(), 1);
                    assert_eq!(name_page.entry().fields()[0].kind(), FieldKind::ToolName);
                    let reuse_id = format!("e:{}:0", tool.snapshot_head() + 1);
                    f.runtime(RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolResultReused {
                            call_id: "call".into(),
                            tool_name: "synthetic tool".into(),
                        },
                    })
                    .await;
                    let reuse = f.entry(&reuse_id).await;
                    bounded(&reuse);
                    assert_eq!(reuse.entry().kind(), EntryKind::Reuse);
                    assert_eq!(reuse.entry().is_error(), Some(is_error));
                    assert_eq!(reuse.entry().result_recorded(), Some(true));
                    assert_eq!(reuse.entry().finish_recorded(), Some(finish != "absent"));
                    assert_eq!(
                        reuse.entry().reference().unwrap().entry_id(),
                        tool.entry().entry_id()
                    );
                    assert!(reuse.entry().fields().is_empty());
                    let before = identifier_tests::snapshot(&f.path).await;
                    let history =
                        serde_json::to_vec(&f.handle.history_page(0, None, 100).await.unwrap())
                            .unwrap();
                    let damaged_id = if damage == "tool" { "e:7:0" } else { &reuse_id };
                    let mut sql = f.sql().await;
                    let changed = sqlx::query("UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.is_error',NULL) WHERE run_id=? AND entry_id=?")
                        .bind(f.run.as_str()).bind(damaged_id).execute(&mut sql).await.unwrap();
                    assert_eq!(changed.rows_affected(), 1);
                    sql.close().await.unwrap();
                    let damaged = identifier_tests::snapshot(&f.path).await;
                    assert_eq!(&damaged[..7], &before[..7]);
                    assert_eq!(&damaged[8..], &before[8..]);
                    let mut expected: serde_json::Value = serde_json::from_str(&before[7]).unwrap();
                    let actual: serde_json::Value = serde_json::from_str(&damaged[7]).unwrap();
                    for (old, new) in expected
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .zip(actual.as_array().unwrap())
                    {
                        if old[1] == damaged_id {
                            let mut metadata: serde_json::Value =
                                serde_json::from_str(old[8].as_str().unwrap()).unwrap();
                            assert_eq!(metadata["is_error"], is_error);
                            assert_eq!(metadata["result_recorded"], true);
                            metadata["is_error"] = serde_json::Value::Null;
                            assert_eq!(
                                metadata,
                                serde_json::from_str::<serde_json::Value>(new[8].as_str().unwrap())
                                    .unwrap()
                            );
                            old[8] = new[8].clone();
                        }
                    }
                    assert_eq!(expected, actual);
                    let tool_read = f
                        .handle
                        .conversation_entry(f.run.clone(), "e:7:0".parse().unwrap())
                        .await;
                    let name_read = f.handle.conversation_content(name_cursor).await;
                    let reuse_read = f
                        .handle
                        .conversation_entry(f.run.clone(), reuse_id.parse().unwrap())
                        .await;
                    for (path, read) in [
                        ("tool", tool_read),
                        ("name", name_read),
                        ("reuse", reuse_read),
                    ] {
                        if damage == "tool" || path == "reuse" {
                            let error = read.err();
                            if !matches!(error, Some(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Integrity)
                            {
                                failures.push(format!("is_error={is_error} bytes={} finish={finish} damage={damage} path={path}: {error:?}", output.len()));
                            }
                        } else {
                            let page = read.unwrap();
                            bounded(&page);
                            assert_eq!(page.entry().is_error(), Some(is_error));
                        }
                    }
                    let raw = f
                        .handle
                        .tool_result(f.run.clone(), "call".into())
                        .await
                        .unwrap()
                        .unwrap();
                    assert_eq!(raw.output().unwrap().as_bytes(), output.as_bytes());
                    assert_eq!(raw.is_error(), Some(is_error));
                    assert_eq!(
                        serde_json::to_vec(&f.handle.history_page(0, None, 100).await.unwrap())
                            .unwrap(),
                        history
                    );
                    for (id, text) in [("e:2:0", "anchor"), ("e:5:0", "healthy assistant")] {
                        let page = f.entry(id).await;
                        bounded(&page);
                        assert_eq!(page.snapshot_head(), reuse.snapshot_head());
                        assert_eq!(page.entry().fields()[0].text(), text);
                        assert_eq!(page.entry().result_recorded(), None);
                        assert_eq!(page.entry().finish_recorded(), None);
                        assert_eq!(page.entry().is_error(), None);
                    }
                    assert_eq!(identifier_tests::snapshot(&f.path).await, damaged);
                    f.store.close().await.unwrap();
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} missing integrity errors:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[tokio::test]
async fn a5b1_remediation_no_result_allows_null_is_error() {
    for finish in [None, Some(false), Some(true)] {
        let mut f = Fixture::new("anchor").await;
        f.start().await;
        f.runtime(RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted {
                call_id: "call".into(),
                tool_name: "synthetic tool".into(),
            },
        })
        .await;
        if let Some(is_error) = finish {
            f.runtime(RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionFinished {
                    call_id: "call".into(),
                    tool_name: "synthetic tool".into(),
                    is_error,
                },
            })
            .await;
        }
        let before = identifier_tests::snapshot(&f.path).await;
        let history =
            serde_json::to_vec(&f.handle.history_page(0, None, 100).await.unwrap()).unwrap();
        let healthy = f.entry("e:6:0").await;
        assert_eq!(healthy.entry().result_recorded(), Some(false));
        assert_eq!(healthy.entry().finish_recorded(), Some(finish.is_some()));
        assert_eq!(healthy.entry().is_error(), finish);
        assert_eq!(healthy.entry().fields().len(), 1);
        bounded(&healthy);
        let name = &healthy.entry().fields()[0];
        assert_eq!(name.kind(), FieldKind::ToolName);
        let cursor = ContentCursor::new(
            f.handle.session_id().clone(),
            f.run.clone(),
            *healthy.entry().entry_id(),
            healthy.entry().content_epoch(),
            name.field_id().into(),
            name.generation(),
            name.total_bytes(),
        )
        .unwrap();
        let content = f.handle.conversation_content(cursor.clone()).await.unwrap();
        assert_eq!(content.entry().is_error(), finish);
        assert_eq!(content.entry().fields().len(), 1);
        assert_eq!(content.entry().fields()[0].kind(), FieldKind::ToolName);
        bounded(&content);
        assert_eq!(identifier_tests::snapshot(&f.path).await, before);

        let mut sql = f.sql().await;
        let changed = sqlx::query("UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.is_error',NULL) WHERE run_id=? AND entry_id='e:6:0'")
            .bind(f.run.as_str()).execute(&mut sql).await.unwrap();
        assert_eq!(changed.rows_affected(), 1);
        sql.close().await.unwrap();
        let damaged = identifier_tests::snapshot(&f.path).await;
        assert_eq!(&damaged[..7], &before[..7]);
        assert_eq!(&damaged[8..], &before[8..]);
        let mut expected: serde_json::Value = serde_json::from_str(&before[7]).unwrap();
        for row in expected.as_array_mut().unwrap() {
            if row[1] == "e:6:0"
                && let Some(flag) = finish
            {
                let metadata = row[8].as_str().unwrap();
                let member = format!("\"is_error\":{flag}");
                assert_eq!(metadata.matches(&member).count(), 1);
                row[8] = metadata.replacen(&member, "\"is_error\":null", 1).into();
            }
        }
        assert_eq!(serde_json::to_string(&expected).unwrap(), damaged[7]);
        // A finish fixes the flag even without output; only pending tools can keep null.
        for _ in 0..2 {
            for read in [
                f.handle
                    .conversation_entry(f.run.clone(), "e:6:0".parse().unwrap())
                    .await,
                f.handle.conversation_content(cursor.clone()).await,
            ] {
                if finish.is_some() {
                    assert!(
                        matches!(read, Err(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Integrity)
                    );
                } else {
                    let tool = read.unwrap();
                    assert_eq!(tool.entry().result_recorded(), Some(false));
                    assert_eq!(tool.entry().finish_recorded(), Some(false));
                    assert_eq!(tool.entry().is_error(), None);
                    assert_eq!(tool.entry().fields().len(), 1);
                    assert_eq!(tool.entry().fields()[0].kind(), FieldKind::ToolName);
                    bounded(&tool);
                }
                assert_eq!(identifier_tests::snapshot(&f.path).await, damaged);
            }
            assert_eq!(
                serde_json::to_vec(&f.handle.history_page(0, None, 100).await.unwrap()).unwrap(),
                history
            );
            assert_eq!(identifier_tests::snapshot(&f.path).await, damaged);
        }
        f.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn a5b1_remediation_false_result_flag_rejects_existing_output_descriptor() {
    let mut failures = Vec::new();
    let mut checked = 0;
    for output in [String::new(), "sixteen bytes!!!".into(), "x".repeat(90000)] {
        for is_error in [false, true] {
            for finish in ["absent", "before", "after"] {
                for clear_error in [false, true] {
                    let mut f = Fixture::new("anchor").await;
                    f.start().await;
                    f.delta(0, "healthy assistant").await;
                    f.runtime(RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolExecutionStarted {
                            call_id: "call".into(),
                            tool_name: "synthetic tool".into(),
                        },
                    })
                    .await;
                    let pending = f.entry("e:7:0").await;
                    assert_eq!(pending.entry().result_recorded(), Some(false));
                    assert_eq!(pending.entry().is_error(), None);
                    let finished = RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolExecutionFinished {
                            call_id: "call".into(),
                            tool_name: "synthetic tool".into(),
                            is_error,
                        },
                    };
                    if finish == "before" {
                        f.runtime(finished.clone()).await;
                        let no_result = f.entry("e:7:0").await;
                        bounded(&no_result);
                        assert_eq!(no_result.entry().result_recorded(), Some(false));
                        assert_eq!(no_result.entry().is_error(), Some(is_error));
                        assert_eq!(no_result.entry().fields().len(), 1);
                    }
                    f.handle
                        .append_run_records(
                            OperationId::new(),
                            f.run.clone(),
                            vec![AppendRunRecord::ToolResult {
                                request_id: Some(REQUEST.into()),
                                call_id: "call".into(),
                                output: output.clone(),
                                is_error,
                            }],
                        )
                        .await
                        .unwrap();
                    if finish == "after" {
                        f.runtime(finished).await;
                    }
                    let tool = f.entry("e:7:0").await;
                    bounded(&tool);
                    assert_eq!(tool.entry().result_recorded(), Some(true));
                    assert_eq!(tool.entry().finish_recorded(), Some(finish != "absent"));
                    assert_eq!(tool.entry().is_error(), Some(is_error));
                    assert!(
                        contents(&f, tool.clone())
                            .await
                            .values()
                            .any(|text| text == &output)
                    );
                    let result = tool
                        .entry()
                        .fields()
                        .iter()
                        .find(|field| field.kind() == FieldKind::ToolResult)
                        .unwrap();
                    assert_eq!(result.total_bytes(), output.len() as u64);
                    let name = &pending.entry().fields()[0];
                    let mut cursors = Vec::new();
                    for (label, field) in [("result", result), ("name", name)] {
                        let cursor = ContentCursor::new(
                            f.handle.session_id().clone(),
                            f.run.clone(),
                            *tool.entry().entry_id(),
                            tool.entry().content_epoch(),
                            field.field_id().into(),
                            field.generation(),
                            field.total_bytes(),
                        )
                        .unwrap();
                        let page = f.handle.conversation_content(cursor.clone()).await.unwrap();
                        bounded(&page);
                        assert_eq!(page.entry().is_error(), Some(is_error));
                        if label == "name" {
                            assert_eq!(page.entry().fields().len(), 1);
                            assert_eq!(page.entry().fields()[0].kind(), FieldKind::ToolName);
                        }
                        cursors.push((label, cursor));
                    }
                    if output.len() == 90000 {
                        let cursor = tool.entry().earlier_content().unwrap().clone();
                        bounded(&f.handle.conversation_content(cursor.clone()).await.unwrap());
                        cursors.push(("issued", cursor));
                    }
                    let reuse_id = format!("e:{}:0", tool.snapshot_head() + 1);
                    f.runtime(RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolResultReused {
                            call_id: "call".into(),
                            tool_name: "synthetic tool".into(),
                        },
                    })
                    .await;
                    let reuse = f.entry(&reuse_id).await;
                    bounded(&reuse);
                    assert_eq!(reuse.entry().kind(), EntryKind::Reuse);
                    assert_eq!(reuse.entry().result_recorded(), Some(true));
                    assert_eq!(reuse.entry().is_error(), Some(is_error));
                    assert_eq!(
                        reuse.entry().reference().unwrap().entry_id(),
                        tool.entry().entry_id()
                    );
                    assert!(reuse.entry().fields().is_empty());
                    let before = identifier_tests::snapshot(&f.path).await;
                    let history =
                        serde_json::to_vec(&f.handle.history_page(0, None, 100).await.unwrap())
                            .unwrap();
                    let mut sql = f.sql().await;
                    // The reverse check needs only one addressed descriptor, never output bytes.
                    let plan: Vec<String> = sqlx::query("EXPLAIN QUERY PLAN SELECT 1 FROM conversation_fields WHERE run_id=? AND entry_id=? AND field_id=? LIMIT 1")
                        .bind(f.run.as_str()).bind("e:7:0").bind(result.field_id())
                        .fetch_all(&mut sql).await.unwrap().iter().map(|row| row.get("detail")).collect();
                    assert!(
                        plan.iter()
                            .any(|line| line.contains("SEARCH") && line.contains("COVERING INDEX"))
                    );
                    assert!(
                        !plan
                            .iter()
                            .any(|line| line.contains("SCAN") || line.contains("TEMP B-TREE"))
                    );
                    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM conversation_fields WHERE run_id=? AND entry_id=? AND field_id=? LIMIT 1")
                        .bind(f.run.as_str()).bind("e:7:0").bind(result.field_id())
                        .fetch_optional(&mut sql).await.unwrap();
                    assert_eq!(exists, Some(1));
                    println!(
                        "a5b1 false flag bytes={} metadata-only EXPLAIN {}",
                        output.len(),
                        plan.join("; ")
                    );
                    let mutation = if clear_error {
                        "UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.result_recorded',json('false'),'$.is_error',NULL) WHERE run_id=? AND entry_id='e:7:0'"
                    } else {
                        "UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.result_recorded',json('false')) WHERE run_id=? AND entry_id='e:7:0'"
                    };
                    assert_eq!(
                        sqlx::query(mutation)
                            .bind(f.run.as_str())
                            .execute(&mut sql)
                            .await
                            .unwrap()
                            .rows_affected(),
                        1
                    );
                    sql.close().await.unwrap();
                    let damaged = identifier_tests::snapshot(&f.path).await;
                    assert_eq!(&damaged[..7], &before[..7]);
                    assert_eq!(&damaged[8..], &before[8..]);
                    let mut expected: serde_json::Value = serde_json::from_str(&before[7]).unwrap();
                    let actual: serde_json::Value = serde_json::from_str(&damaged[7]).unwrap();
                    for (old, new) in expected
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .zip(actual.as_array().unwrap())
                    {
                        if old[1] == "e:7:0" {
                            let mut metadata: serde_json::Value =
                                serde_json::from_str(old[8].as_str().unwrap()).unwrap();
                            assert_eq!(metadata["result_recorded"], true);
                            assert_eq!(metadata["is_error"], is_error);
                            metadata["result_recorded"] = false.into();
                            if clear_error {
                                metadata["is_error"] = serde_json::Value::Null;
                            }
                            assert_eq!(
                                metadata,
                                serde_json::from_str::<serde_json::Value>(new[8].as_str().unwrap())
                                    .unwrap()
                            );
                            old[8] = new[8].clone();
                        }
                    }
                    assert_eq!(expected, actual);
                    let mut reads = vec![(
                        "entry",
                        f.handle
                            .conversation_entry(f.run.clone(), "e:7:0".parse().unwrap())
                            .await,
                    )];
                    for (label, cursor) in cursors {
                        reads.push((
                            label,
                            f.handle
                                .conversation_content(cursor.to_string().parse().unwrap())
                                .await,
                        ));
                    }
                    reads.push((
                        "reuse",
                        f.handle
                            .conversation_entry(f.run.clone(), reuse_id.parse().unwrap())
                            .await,
                    ));
                    for (label, read) in reads {
                        checked += 1;
                        let error = read.err();
                        if !matches!(error, Some(ConversationError::Storage(error)) if error.kind() == StorageErrorKind::Integrity)
                        {
                            failures.push(format!("bytes={} is_error={is_error} finish={finish} clear_error={clear_error} path={label}: {error:?}", output.len()));
                        } else {
                            assert_eq!(error.unwrap().to_string(), "storage.integrity");
                        }
                    }
                    let raw = f
                        .handle
                        .tool_result(f.run.clone(), "call".into())
                        .await
                        .unwrap()
                        .unwrap();
                    assert_eq!(raw.output().unwrap().as_bytes(), output.as_bytes());
                    assert_eq!(raw.is_error(), Some(is_error));
                    assert_eq!(
                        serde_json::to_vec(&f.handle.history_page(0, None, 100).await.unwrap())
                            .unwrap(),
                        history
                    );
                    for (id, text) in [("e:2:0", "anchor"), ("e:5:0", "healthy assistant")] {
                        let page = f.entry(id).await;
                        bounded(&page);
                        assert_eq!(page.snapshot_head(), reuse.snapshot_head());
                        assert_eq!(page.entry().fields()[0].text(), text);
                        assert_eq!(page.entry().result_recorded(), None);
                        assert_eq!(page.entry().is_error(), None);
                    }
                    assert_eq!(identifier_tests::snapshot(&f.path).await, damaged);
                    f.store.close().await.unwrap();
                }
            }
        }
    }
    assert_eq!(checked, 156);
    assert!(
        failures.is_empty(),
        "{} missing integrity errors:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
