use super::super::tests::fixture::*;
use super::*;
use crate::{
    conversation::{ConversationQuery, EntryKind, wire::PAGE_BYTES},
    run::RunEvent,
    storage::{AppendRunRecord, CreateSession, OperationId, identifier_tests},
    tools::ToolExecutionEvent,
};
use std::collections::{BTreeMap, BTreeSet};

mod integrity_tests;
mod lifecycle;
mod limits;
mod partitions;
mod scale;

fn cursor(
    f: &Fixture,
    sequence: u64,
    rank: u8,
    run: Option<RunId>,
    entry: Option<EntryId>,
) -> LiveCursor {
    LiveCursor::new(f.handle.session_id().clone(), sequence, rank, run, entry)
        .unwrap()
        .to_string()
        .parse()
        .unwrap()
}
fn watermark(f: &Fixture, sequence: u64) -> LiveCursor {
    cursor(f, sequence, 3, None, None)
}
fn bounded(batch: &ConversationChanges) -> usize {
    let bytes = DisplayJson::Changes(batch).encode().unwrap();
    assert_eq!(
        bytes.len(),
        DisplayJson::Changes(batch).json_size().unwrap()
    );
    assert!(bytes.len() <= PAGE_BYTES && batch.changes().len() <= ACTIVITY_LIMIT);
    let text = String::from_utf8(bytes.clone()).unwrap();
    for private in [
        "PRIVATE_PREPARED",
        "PRIVATE_NATIVE",
        "PRIVATE_RESPONSE",
        "opaque-local-session",
    ] {
        assert!(!text.contains(private));
    }
    bytes.len()
}
fn key(change: &DisplayChange, metadata_sequence: u64) -> Key {
    match change {
        DisplayChange::SessionUpsert(_) => Key {
            sequence: metadata_sequence,
            rank: 0,
            run: String::new(),
            entry: String::new(),
        },
        DisplayChange::BlockUpsert(block) => Key {
            sequence: block.revision(),
            rank: 1,
            run: block.run_id().to_string(),
            entry: String::new(),
        },
        DisplayChange::EntryUpsert(change) => Key {
            sequence: change.entry().revision(),
            rank: 2,
            run: change.entry().run_id().to_string(),
            entry: change.entry().entry_id().to_string(),
        },
    }
}
async fn tools(f: &mut Fixture, count: usize, output: Option<&str>) {
    f.runtime(RunEvent::RunStarted).await;
    f.runtime(RunEvent::TurnStarted { number: 1 }).await;
    for index in 0..count {
        f.runtime(RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted {
                call_id: format!("call-{index}"),
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
                        call_id: format!("call-{index}"),
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
async fn a5b3_empty_creation_rename_acceptance_and_private_watermarks() {
    let f = Fixture::new("anchor\0雪").await;
    let created = f
        .store
        .create_session(CreateSession::new(OperationId::new(), "created".into(), None).unwrap())
        .await
        .unwrap();
    let empty = f
        .store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let start = LiveCursor::new(empty.session_id().clone(), 1, 3, None, None).unwrap();
    let batch = empty.conversation_changes(start.clone()).await.unwrap();
    assert!(batch.changes().is_empty() && !batch.has_more());
    assert_eq!(batch.next_after(), &start);
    empty
        .rename(OperationId::new(), "renamed\0雪".into())
        .await
        .unwrap();
    let batch = empty.conversation_changes(start).await.unwrap();
    let [DisplayChange::SessionUpsert(session)] = batch.changes() else {
        panic!("metadata only")
    };
    assert_eq!(session.title(), "renamed\0雪");
    assert_eq!(session.head_sequence(), batch.observed_head());
    bounded(&batch);
    let batch = f
        .handle
        .conversation_changes(watermark(&f, 1))
        .await
        .unwrap();
    let [
        DisplayChange::BlockUpsert(block),
        DisplayChange::EntryUpsert(change),
    ] = batch.changes()
    else {
        panic!("acceptance pair")
    };
    assert_eq!(block.human().entry_id(), change.entry().entry_id());
    assert_eq!(
        DisplayJson::Entry(change.block().human()).encode().unwrap(),
        DisplayJson::Entry(change.entry()).encode().unwrap()
    );
    assert_eq!(change.entry().fields()[0].text(), "anchor\0雪");
    assert_eq!(
        (batch.next_after().sequence(), batch.next_after().rank()),
        (2, 3)
    );
    // Actual history selection advances the canonical head without adding display state.
    let run = RunId::new();
    let selection = crate::storage::StoredHistorySelection::new(
        2,
        "a".repeat(64),
        "synthetic".into(),
        "synthetic".into(),
        None,
    )
    .unwrap();
    empty
        .accept_history_run(OperationId::new(), run, input("selected"), selection)
        .await
        .unwrap();
    let after = LiveCursor::new(empty.session_id().clone(), 3, 3, None, None).unwrap();
    let batch = empty.conversation_changes(after).await.unwrap();
    assert!(batch.changes().is_empty() && !batch.has_more());
    assert_eq!(
        (
            batch.observed_head(),
            batch.next_after().sequence(),
            batch.next_after().rank()
        ),
        (4, 4, 3)
    );
    bounded(&batch);
    assert_eq!(
        empty
            .conversation_changes(batch.next_after().clone())
            .await
            .unwrap()
            .next_after(),
        batch.next_after()
    );
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b3_moving_entities_converge() {
    let mut f = Fixture::new("anchor").await;
    let snapshot = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    tools(&mut f, 145, None).await;
    // Keep the run active so real result writes can move current entities between reads.
    let head = f.handle.manifest().await.unwrap().head_sequence();
    let mut after = snapshot.live_after().unwrap().clone();
    let mut seen = BTreeSet::new();
    let mut last = Key::after(&after);
    let mut batches = 0;
    let mut emitted = None;
    let mut unreturned = None;
    let mut revisions = BTreeMap::new();
    loop {
        let batch = f.handle.conversation_changes(after.clone()).await.unwrap();
        bounded(&batch);
        for change in batch.changes() {
            let k = key(change, 1);
            assert!(k > last);
            last = k.clone();
            assert!(seen.insert((k.sequence, k.rank, k.run.clone(), k.entry.clone())));
            if let DisplayChange::EntryUpsert(change) = change {
                revisions.insert(
                    change.entry().entry_id().to_string(),
                    change.entry().revision(),
                );
                if change.entry().kind() == EntryKind::Tool && emitted.is_none() {
                    emitted = Some(*change.entry().entry_id());
                }
            }
        }
        batches += 1;
        if batches == 1 {
            assert!(batch.has_more());
            assert_eq!(batch.changes().len(), 64);
            assert!(Key::after(batch.next_after()) == last);
            let mut sql = f.sql().await;
            let ids: Vec<String> = sqlx::query_scalar(
                "SELECT entry_id FROM conversation_entries WHERE kind='tool' ORDER BY entry_id",
            )
            .fetch_all(&mut sql)
            .await
            .unwrap();
            assert_ne!(ids[0].parse::<EntryId>().unwrap().first_sequence(), 5);
            let id: EntryId = ids.last().unwrap().parse().unwrap();
            unreturned = Some(id);
            let calls: Vec<String> = sqlx::query_scalar("SELECT json_extract(metadata_json,'$.source.call_id') FROM conversation_entries WHERE entry_id IN (?,?) ORDER BY entry_id")
                .bind(emitted.unwrap().to_string()).bind(id.to_string()).fetch_all(&mut sql).await.unwrap();
            sql.close().await.unwrap();
            for call_id in calls {
                f.handle
                    .append_run_records(
                        OperationId::new(),
                        f.run.clone(),
                        vec![AppendRunRecord::ToolResult {
                            request_id: Some(REQUEST.into()),
                            call_id,
                            output: "final saved state".into(),
                            is_error: false,
                        }],
                    )
                    .await
                    .unwrap();
            }
        }
        after = batch.next_after().clone();
        if !batch.has_more() {
            break;
        }
    }
    assert!(batches >= 3);
    assert_eq!(revisions.len(), 145);
    assert!(revisions[&emitted.unwrap().to_string()] > head);
    assert!(revisions[&unreturned.unwrap().to_string()] > head);
    assert_eq!(
        after.sequence(),
        f.handle.manifest().await.unwrap().head_sequence()
    );
    assert!(
        f.handle
            .conversation_changes(after)
            .await
            .unwrap()
            .changes()
            .is_empty()
    );
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b3_real_tool_result_reuse_and_later_finish_facts() {
    let mut f = Fixture::new("anchor").await;
    tools(&mut f, 1, None).await;
    let start = f
        .handle
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap()
        .live_after()
        .unwrap()
        .clone();
    f.handle
        .append_run_records(
            OperationId::new(),
            f.run.clone(),
            vec![AppendRunRecord::ToolResult {
                request_id: Some(REQUEST.into()),
                call_id: "call-0".into(),
                output: "{\"error\":\"not an error\"}\0雪".into(),
                is_error: false,
            }],
        )
        .await
        .unwrap();
    f.runtime(RunEvent::ToolEvent {
        event: ToolExecutionEvent::ToolResultReused {
            call_id: "call-0".into(),
            tool_name: "synthetic tool".into(),
        },
    })
    .await;
    let reuse_batch = f.handle.conversation_changes(start.clone()).await.unwrap();
    let reuse = reuse_batch
        .changes()
        .iter()
        .find_map(|change| match change {
            DisplayChange::EntryUpsert(change) if change.entry().kind() == EntryKind::Reuse => {
                Some(change.entry().clone())
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(reuse.result_recorded(), Some(true));
    assert_eq!(reuse.finish_recorded(), Some(false));
    f.runtime(RunEvent::ToolEvent {
        event: ToolExecutionEvent::ToolExecutionFinished {
            call_id: "call-0".into(),
            tool_name: "synthetic tool".into(),
            is_error: false,
        },
    })
    .await;
    let batch = f.handle.conversation_changes(start).await.unwrap();
    bounded(&batch);
    let tool = batch
        .changes()
        .iter()
        .find_map(|change| match change {
            DisplayChange::EntryUpsert(change) if change.entry().kind() == EntryKind::Tool => {
                Some(change.entry())
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(tool.result_recorded(), Some(true));
    assert_eq!(tool.finish_recorded(), Some(true));
    assert_eq!(tool.is_error(), Some(false));
    assert_eq!(reuse.is_error(), tool.is_error());
    f.handle
        .conversation_changes(cursor(
            &f,
            reuse.revision(),
            2,
            Some(f.run.clone()),
            Some(*reuse.entry_id()),
        ))
        .await
        .unwrap();
    f.store.close().await.unwrap();
}
