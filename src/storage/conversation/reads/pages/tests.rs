use super::super::tests::fixture::*;
use super::*;
use crate::{
    conversation::{EntryKind, wire::PAGE_BYTES},
    run::RunEvent,
    storage::{AppendRunRecord, CreateSession, OperationId},
    tools::ToolExecutionEvent,
};
mod integrity_tests;
mod lifecycle;
mod max_head;
mod scale;

fn bounded_page(page: &ConversationPage) -> usize {
    let bytes = DisplayJson::Page(page).encode().unwrap();
    assert_eq!(bytes.len(), DisplayJson::Page(page).json_size().unwrap());
    assert!(bytes.len() <= PAGE_BYTES);
    assert!(page.entries().len() <= ACTIVITY_LIMIT);
    if let Some(block) = page.block() {
        assert!(DisplayJson::Entry(block.human()).encode().unwrap().len() <= ENTRY_BYTES);
        assert!(
            page.entries()
                .iter()
                .all(|entry| entry.run_id() == block.run_id() && entry.kind() != EntryKind::Human)
        );
    }
    for entry in page.entries() {
        assert!(DisplayJson::Entry(entry).encode().unwrap().len() <= ENTRY_BYTES);
        assert!(entry.fields().len() <= FIELD_LIMIT);
    }
    assert!(
        page.entries()
            .windows(2)
            .all(|pair| pair[0].position() < pair[1].position())
    );
    bytes.len()
}

#[tokio::test]
async fn a5b2_empty_renamed_latest_before_and_end() {
    let mut f = Fixture::new("A").await;
    let created = f
        .store
        .create_session(CreateSession::new(OperationId::new(), "empty".into(), None).unwrap())
        .await
        .unwrap();
    let empty = f
        .store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    for head in [1, 2] {
        if head == 2 {
            empty
                .rename(OperationId::new(), "renamed only".into())
                .await
                .unwrap();
        }
        let page = empty
            .conversation_page(ConversationQuery::Latest)
            .await
            .unwrap();
        assert_eq!(page.snapshot_head(), head);
        assert!(page.block().is_none() && page.entries().is_empty());
        assert!(page.earlier_activity().is_none() && page.previous_block().is_none());
        assert_eq!(page.live_after().unwrap().sequence(), head);
        assert_eq!(page.live_after().unwrap().rank(), 3);
        bounded_page(&page);
    }
    let a = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    assert_eq!(a.block().unwrap().human().fields()[0].text(), "A");
    assert!(a.previous_block().is_none());
    f.runtime(RunEvent::RunStarted).await;
    f.runtime(RunEvent::TurnStarted { number: 1 }).await;
    finish(&mut f).await;
    let b_run = RunId::new();
    f.handle
        .accept_run(OperationId::new(), b_run.clone(), input("B"))
        .await
        .unwrap();
    let b = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    assert_eq!(b.block().unwrap().run_id(), &b_run);
    assert_eq!(b.block().unwrap().human().fields()[0].text(), "B");
    assert!(b.entries().is_empty());
    let older = f
        .handle
        .conversation_page(ConversationQuery::Before(
            b.previous_block().unwrap().to_string().parse().unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(older.block().unwrap().run_id(), &f.run);
    assert!(older.live_after().is_none());
    assert!(older.previous_block().is_none());
    let end = f
        .handle
        .conversation_page(ConversationQuery::Before(
            BlockCursor::new(f.handle.session_id().clone(), 2).unwrap(),
        ))
        .await
        .unwrap();
    assert!(end.block().is_none() && end.entries().is_empty());
    assert!(
        end.previous_block().is_none()
            && end.earlier_activity().is_none()
            && end.live_after().is_none()
    );
    for page in [&a, &b, &older, &end] {
        bounded_page(page);
    }
    f.store.close().await.unwrap();
}

async fn finish(f: &mut Fixture) {
    f.runtime(RunEvent::TurnFinished {
        number: 1,
        response_id: None,
        outcome: crate::run::TurnOutcome::Stopped {
            reason: crate::run::RunOutcome::CancelledLocally,
        },
        upstream_outcome: None,
    })
    .await;
    f.runtime(RunEvent::RunFinished {
        outcome: crate::run::RunOutcome::CancelledLocally,
        summary: crate::run::RunSummary::default(),
    })
    .await;
}

async fn tools(f: &mut Fixture, count: usize, output: Option<&str>) {
    f.runtime(RunEvent::RunStarted).await;
    f.runtime(RunEvent::TurnStarted { number: 1 }).await;
    for index in 0..count {
        let call_id = format!("call-{index}");
        f.runtime(RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted {
                call_id: call_id.clone(),
                tool_name: "synthetic tool".into(),
            },
        })
        .await;
        if let Some(output) = output {
            f.handle
                .append_run_records(
                    OperationId::new(),
                    f.run.clone(),
                    vec![AppendRunRecord::ToolResult {
                        request_id: Some(REQUEST.into()),
                        call_id,
                        output: output.into(),
                        is_error: false,
                    }],
                )
                .await
                .unwrap();
        }
    }
}

#[tokio::test]
async fn a5b2_within_segments_stable_membership_and_independent_cursors() {
    let mut f = Fixture::new("anchor B").await;
    tools(&mut f, 145, None).await;
    let latest = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    assert_eq!(latest.entries().len(), 64);
    let first_boundary = latest.earlier_activity().unwrap().clone();
    // A new activity and a new block do not stale the existing immutable membership.
    f.runtime(RunEvent::ToolEvent {
        event: ToolExecutionEvent::ToolExecutionStarted {
            call_id: "new-tail".into(),
            tool_name: "tail".into(),
        },
    })
    .await;
    finish(&mut f).await;
    f.handle
        .accept_run(OperationId::new(), RunId::new(), input("C"))
        .await
        .unwrap();
    let mut page = latest;
    let mut ids = std::collections::BTreeSet::new();
    let mut segments = 0;
    loop {
        bounded_page(&page);
        assert_eq!(page.block().unwrap().run_id(), &f.run);
        assert_eq!(
            page.block().unwrap().human().entry_id().to_string(),
            "e:2:0"
        );
        assert!(page.previous_block().is_none());
        for entry in page.entries() {
            assert!(ids.insert(*entry.entry_id()));
        }
        segments += 1;
        let Some(cursor) = page.earlier_activity().cloned() else {
            break;
        };
        page = f
            .handle
            .conversation_page(ConversationQuery::Within(
                cursor.to_string().parse().unwrap(),
            ))
            .await
            .unwrap();
        assert!(page.live_after().is_none());
    }
    assert_eq!(segments, 3);
    assert_eq!(ids.len(), 145);
    let again = f
        .handle
        .conversation_page(ConversationQuery::Within(first_boundary))
        .await
        .unwrap();
    assert_eq!(again.entries().len(), 64);
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b2_huge_anchor_activity_and_exact_content_traversal() {
    let text = "\0\n\r\t\"\\雪é🦀\u{1b}".repeat(5000);
    let mut f = Fixture::new(&text).await;
    tools(&mut f, 25, Some(&text)).await;
    let before = integrity_tests::snapshot(&f).await;
    let mut page = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    assert!(bounded_page(&page) > PAGE_BYTES - ENTRY_BYTES * 2);
    assert!(page.entries().len() < 25 && page.earlier_activity().is_some());
    let mut ids = std::collections::BTreeSet::new();
    loop {
        bounded_page(&page);
        for entry in page
            .entries()
            .iter()
            .chain(std::iter::once(page.block().unwrap().human()))
        {
            if entry.kind() != EntryKind::Human {
                assert!(ids.insert(*entry.entry_id()));
            }
            let field = entry.fields().last().unwrap();
            assert!(!field.text().is_empty());
            let mut restored = field.text().to_owned();
            let mut cursor = entry.earlier_content().cloned();
            let target_id = field.field_id().to_owned();
            let mut upper = field.from_byte();
            while let Some(next) = cursor {
                let addressed = f.handle.conversation_content(next).await.unwrap();
                bounded(&addressed);
                for fragment in addressed
                    .entry()
                    .fields()
                    .iter()
                    .rev()
                    .filter(|field| field.field_id() == target_id)
                {
                    assert_eq!(fragment.to_byte(), upper);
                    assert!(fragment.from_byte() < upper);
                    upper = fragment.from_byte();
                    restored.insert_str(0, fragment.text());
                }
                cursor = addressed.entry().earlier_content().cloned();
            }
            assert_eq!(upper, 0);
            assert_eq!(restored, text);
        }
        let Some(cursor) = page.earlier_activity().cloned() else {
            break;
        };
        page = f
            .handle
            .conversation_page(ConversationQuery::Within(cursor))
            .await
            .unwrap();
    }
    assert_eq!(ids.len(), 25);
    assert_eq!(integrity_tests::snapshot(&f).await, before);
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b2_near_cap_header_protects_newest_activity_and_both_cursors() {
    let mut f = Fixture::new("A").await;
    f.runtime(RunEvent::RunStarted).await;
    f.runtime(RunEvent::TurnStarted { number: 1 }).await;
    finish(&mut f).await;
    f.run = RunId::new();
    f.handle
        .accept_run(
            OperationId::new(),
            f.run.clone(),
            input(&"雪\0".repeat(10000)),
        )
        .await
        .unwrap();
    tools(&mut f, 2, Some(&"🦀\0".repeat(10000))).await;
    let mut sql = f.sql().await;
    let saved: String =
        sqlx::query_scalar("SELECT header_json FROM conversation_blocks WHERE run_id=?")
            .bind(f.run.as_str())
            .fetch_one(&mut sql)
            .await
            .unwrap();
    let mut header: serde_json::Value = serde_json::from_str(&saved).unwrap();
    let summary = "s".repeat(PAGE_BYTES - 3200);
    header["summary"] = serde_json::to_value(crate::run::RunSummary {
        last_request_id: Some(summary.clone()),
        ..Default::default()
    })
    .unwrap();
    // Emulate a previously saved opaque mandatory summary without admitting new IDs.
    sqlx::query("UPDATE conversation_blocks SET header_json=? WHERE run_id=?")
        .bind(header.to_string())
        .bind(f.run.as_str())
        .execute(&mut sql)
        .await
        .unwrap();
    sql.close().await.unwrap();
    let before = integrity_tests::snapshot(&f).await;
    let page = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    assert!(bounded_page(&page) > PAGE_BYTES - 20);
    assert_eq!(page.entries().len(), 1);
    assert!(page.earlier_activity().is_some() && page.previous_block().is_some());
    assert!(!page.entries()[0].fields().last().unwrap().text().is_empty());
    assert!(!page.block().unwrap().human().fields()[0].text().is_empty());
    assert!(page.entries()[0].earlier_content().is_some());
    let earlier = f
        .handle
        .conversation_page(ConversationQuery::Within(
            page.earlier_activity().cloned().unwrap(),
        ))
        .await
        .unwrap();
    bounded_page(&earlier);
    assert_eq!(earlier.entries().len(), 1);
    assert!(earlier.entries()[0].entry_id() < page.entries()[0].entry_id());
    assert!(earlier.earlier_activity().is_none() && earlier.previous_block().is_some());
    let a = f
        .handle
        .conversation_page(ConversationQuery::Before(
            page.previous_block().cloned().unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(a.block().unwrap().human().fields()[0].text(), "A");
    assert_eq!(integrity_tests::snapshot(&f).await, before);
    let mut sql = f.sql().await;
    header["summary"]["last_request_id"] = serde_json::json!("s".repeat(PAGE_BYTES + 1));
    sqlx::query("UPDATE conversation_blocks SET header_json=? WHERE run_id=?")
        .bind(header.to_string())
        .bind(f.run.as_str())
        .execute(&mut sql)
        .await
        .unwrap();
    sql.close().await.unwrap();
    let oversized = integrity_tests::snapshot(&f).await;
    assert_eq!(
        f.handle
            .conversation_page(ConversationQuery::Latest)
            .await
            .err(),
        Some(ConversationError::DisplayUnavailable)
    );
    assert_eq!(
        f.handle
            .conversation_page(ConversationQuery::Within(
                page.earlier_activity().cloned().unwrap()
            ))
            .await
            .err(),
        Some(ConversationError::DisplayUnavailable)
    );
    assert!(
        f.handle
            .conversation_page(ConversationQuery::Before(
                page.previous_block().cloned().unwrap()
            ))
            .await
            .is_ok()
    );
    assert_eq!(integrity_tests::snapshot(&f).await, oversized);
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b2_page_many_empty_descriptors_and_assistant_growth() {
    let mut f = Fixture::new("anchor").await;
    f.start().await;
    for index in 0..145 {
        f.delta(index, "").await;
    }
    let page = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    bounded_page(&page);
    assert_eq!(page.entries().len(), 1);
    let first = &page.entries()[0];
    assert_eq!(first.entry_id().to_string(), "e:5:0");
    assert_eq!(first.fields().len(), 64);
    let mut ids = std::collections::BTreeSet::new();
    for field in first.fields() {
        assert!(ids.insert(field.field_id().to_owned()));
    }
    let mut cursor = first.earlier_content().cloned();
    while let Some(next) = cursor {
        let entry = f.handle.conversation_content(next).await.unwrap();
        bounded(&entry);
        for field in entry.entry().fields() {
            assert!(ids.insert(field.field_id().to_owned()));
        }
        cursor = entry.entry().earlier_content().cloned();
    }
    assert_eq!(ids.len(), 145);
    f.delta(144, "尾\0").await;
    let after = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    assert_eq!(after.entries()[0].entry_id(), first.entry_id());
    assert_eq!(after.entries()[0].position(), first.position());
    assert_eq!(after.entries()[0].fields().last().unwrap().text(), "尾\0");
    assert_eq!(
        f.entry("e:5:0").await.entry().revision(),
        after.entries()[0].revision()
    );
    f.store.close().await.unwrap();
}
