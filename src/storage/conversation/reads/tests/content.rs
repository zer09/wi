use super::*;

#[tokio::test]
async fn a5b1_canonical_human_assistant_tool_and_same_run_reference() {
    let mut f = Fixture::new("exact human\0雪\n").await;
    let human = f.entry("e:2:0").await;
    assert_eq!(human.entry().kind(), EntryKind::Human);
    assert_eq!(human.entry().fields()[0].text(), "exact human\0雪\n");
    assert_eq!(human.entry().entry_id(), human.block().human().entry_id());
    f.start().await;
    f.delta(0, "exact assistant\0é").await;
    let assistant = f.entry("e:5:0").await;
    assert_eq!(assistant.entry().kind(), EntryKind::Assistant);
    assert_eq!(assistant.entry().fields()[0].text(), "exact assistant\0é");
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
                output: "{\"error\":true}\0雪".into(),
                is_error: false,
            }],
        )
        .await
        .unwrap();
    let tool = f.entry("e:7:0").await;
    assert_eq!(tool.entry().kind(), EntryKind::Tool);
    assert_eq!(tool.entry().is_error(), Some(false));
    assert_eq!(tool.entry().result_recorded(), Some(true));
    assert_eq!(tool.entry().finish_recorded(), Some(false));
    assert_eq!(
        tool.entry().fields().last().unwrap().text(),
        "{\"error\":true}\0雪"
    );
    f.runtime(RunEvent::ToolEvent {
        event: ToolExecutionEvent::ToolExecutionFinished {
            call_id: "call".into(),
            tool_name: "synthetic tool".into(),
            is_error: false,
        },
    })
    .await;
    f.runtime(RunEvent::ToolEvent {
        event: ToolExecutionEvent::ToolResultReused {
            call_id: "call".into(),
            tool_name: "synthetic tool".into(),
        },
    })
    .await;
    let reused = f.entry("e:10:0").await;
    assert_eq!(reused.entry().kind(), EntryKind::Reuse);
    let reference = reused.entry().reference().unwrap();
    assert_eq!(reference.run_id(), &f.run);
    assert_eq!(reference.entry_id(), tool.entry().entry_id());
    for page in [&human, &assistant, &tool, &reused] {
        bounded(page);
    }
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b1_long_unicode_nul_escapes_reconstruct_by_api_issued_cursors() {
    for human in [true, false] {
        let text = "\0\n\r\t\"\\雪é🦀\u{1b}".repeat(12000);
        let mut f = Fixture::new(if human { &text } else { "anchor" }).await;
        let id = if human {
            "e:2:0"
        } else {
            f.start().await;
            let hooks = f.handle.test_hooks();
            let before = hooks.measurements();
            let started = std::time::Instant::now();
            f.delta(0, &text).await;
            let elapsed_us = started.elapsed().as_micros();
            let after = hooks.measurements();
            let projection_pages = after.projection_pages - before.projection_pages;
            let recording_commits = after.recording_commits - before.recording_commits;
            let other_commits = after.other_commits - before.other_commits;
            println!(
                "g11 append human={human} input_bytes={} elapsed_us={elapsed_us} projection_pages={projection_pages} recording_commits={recording_commits} other_commits={other_commits} read_transactions={} validation_bytes={} read_descriptors={} read_chunks={} read_content_bytes={}",
                text.len(),
                after.read_transactions - before.read_transactions,
                after.validation_payload_bytes - before.validation_payload_bytes,
                after.conversation_descriptors - before.conversation_descriptors,
                after.conversation_chunks - before.conversation_chunks,
                after.conversation_bytes - before.conversation_bytes,
            );
            assert_eq!(projection_pages, 0);
            assert_eq!(recording_commits, 1);
            assert_eq!(other_commits, 0);
            // These are saved row totals after the append, not counts of rows written.
            let mut sql = f.sql().await;
            let stored: (i64, i64, i64, i64) = sqlx::query_as(
                "SELECT (SELECT count(*) FROM conversation_entries WHERE run_id=?), (SELECT count(*) FROM conversation_fields WHERE run_id=?), (SELECT count(*) FROM conversation_chunks WHERE run_id=?), (SELECT coalesce(sum(byte_length),0) FROM conversation_fields WHERE run_id=?)",
            )
            .bind(f.run.as_str())
            .bind(f.run.as_str())
            .bind(f.run.as_str())
            .bind(f.run.as_str())
            .fetch_one(&mut sql)
            .await
            .unwrap();
            println!(
                "g11 stored_display human={human} stored_entries={} stored_fields={} stored_chunks={} stored_field_bytes={}",
                stored.0, stored.1, stored.2, stored.3,
            );
            sql.close().await.unwrap();
            "e:5:0"
        };
        let hooks = f.handle.test_hooks();
        let mut before = hooks.measurements();
        let started = std::time::Instant::now();
        let mut page = f.entry(id).await;
        let mut elapsed_us = started.elapsed().as_micros();
        let mut after = hooks.measurements();
        let mut reconstructed = String::new();
        let mut upper = text.len() as u64;
        let mut requests = 0;
        loop {
            // Store counters include fixture writes and earlier reads; subtract this read's snapshot.
            let read_transactions = after.read_transactions - before.read_transactions;
            let projection_pages = after.projection_pages - before.projection_pages;
            let recording_commits = after.recording_commits - before.recording_commits;
            let other_commits = after.other_commits - before.other_commits;
            let encoded = DisplayJson::EntryPage(&page).encode().unwrap().len();
            bounded(&page);
            let field = &page.entry().fields()[0];
            println!(
                "g11 content human={human} page={requests} addressed={} elapsed_us={elapsed_us} encoded={encoded} from={} to={} text_bytes={} read_transactions={read_transactions} projection_pages={projection_pages} descriptors={} chunks={} content_bytes={} validation_bytes={} recording_commits={recording_commits} other_commits={other_commits}",
                requests == 0,
                field.from_byte(),
                field.to_byte(),
                field.text().len(),
                after.conversation_descriptors - before.conversation_descriptors,
                after.conversation_chunks - before.conversation_chunks,
                after.conversation_bytes - before.conversation_bytes,
                after.validation_payload_bytes - before.validation_payload_bytes,
            );
            assert_eq!(read_transactions, 1);
            assert_eq!(projection_pages, 0);
            assert_eq!(recording_commits, 0);
            assert_eq!(other_commits, 0);
            assert_eq!(field.to_byte(), upper);
            assert!(field.from_byte() < upper);
            reconstructed.insert_str(0, field.text());
            upper = field.from_byte();
            requests += 1;
            let Some(cursor) = page.entry().earlier_content().cloned() else {
                break;
            };
            assert_eq!(cursor.exclusive_upper_byte(), upper);
            before = hooks.measurements();
            let started = std::time::Instant::now();
            page = f
                .handle
                .conversation_content(cursor.to_string().parse().unwrap())
                .await
                .unwrap();
            elapsed_us = started.elapsed().as_micros();
            after = hooks.measurements();
        }
        assert!(requests > 10);
        assert_eq!(upper, 0);
        assert_eq!(reconstructed.as_bytes(), text.as_bytes());
        f.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn a5b1_many_empty_and_unsupported_fields_progress_in_server_order() {
    let mut f = Fixture::new("anchor").await;
    assert!(f.entry("e:2:0").await.entry().content_complete());
    f.start().await;
    for index in 0..145 {
        f.delta(index, "").await;
    }
    let mut page = f.entry("e:5:0").await;
    let mut ids = std::collections::BTreeSet::new();
    let mut last_order: Option<String> = None;
    let mut pages = 0;
    loop {
        bounded(&page);
        assert!(!page.entry().fields().is_empty());
        assert!(page.entry().fields().len() <= FIELD_LIMIT);
        for field in page.entry().fields().iter().rev() {
            assert!(ids.insert(field.field_id().to_owned()));
            if let Some(last) = &last_order {
                assert!(field.order_key() < last.as_str());
            }
            last_order = Some(field.order_key().into());
            assert!(field.text().is_empty());
        }
        pages += 1;
        let Some(cursor) = page.entry().earlier_content().cloned() else {
            break;
        };
        assert_eq!(cursor.exclusive_upper_byte(), 0);
        page = f.handle.conversation_content(cursor).await.unwrap();
    }
    assert!(pages >= 3);
    assert_eq!(ids.len(), 145);
    // An unsupported native item has an explicit field rather than raw native JSON.
    f.provider(crate::ProviderEvent::OutputItemFinished {
        response_id: "PRIVATE_RESPONSE_".repeat(10000),
        output_index: 146,
        item: crate::OutputItem {
            id: Some("unknown".into()),
            kind: crate::ItemKind::Unknown,
            native_type: "private unknown".into(),
            function_call: None,
            native: serde_json::json!({"PRIVATE_NATIVE":"secret"}),
        },
    })
    .await;
    let page = f.entry("e:5:0").await;
    assert_eq!(
        page.entry().fields().last().unwrap().kind(),
        FieldKind::Unsupported
    );
    bounded(&page);
    f.store.close().await.unwrap();
}
