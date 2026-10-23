// This sibling has the same access to conversation values as crate::storage.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::json;

use crate::{
    conversation::{
        primitives::{FieldRank, OrderKey},
        *,
    },
    storage::{
        ApplicationSessionId, CreateSession, OperationId, RecordedRunState, RunId, SessionManifest,
        SessionStore,
    },
};

fn entry(run: &RunId, sequence: u64, kind: EntryKind) -> EntryView {
    let fields = if kind == EntryKind::Human {
        vec![
            FieldFragment::new(
                "text".into(),
                "0".into(),
                FieldKind::Text,
                sequence,
                4,
                0,
                4,
                "Task".into(),
            )
            .unwrap(),
        ]
    } else {
        vec![]
    };
    EntryView::new(
        run.clone(),
        EntryId::new(sequence, 0).unwrap(),
        sequence,
        sequence,
        kind,
        RecordedState::Accepted,
        false,
        None,
        None,
        None,
        None,
        fields,
        None,
        true,
    )
    .unwrap()
}

fn block(run: &RunId) -> BlockView {
    BlockView::new(
        run.clone(),
        2,
        2,
        RecordedRunState::Accepted,
        false,
        None,
        None,
        None,
        None,
        entry(run, 2, EntryKind::Human),
    )
    .unwrap()
}

async fn manifest() -> SessionManifest {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("store")).await.unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "synthetic".into(), None).unwrap())
        .await
        .unwrap();
    let session = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    // Only the manifest is needed. Resource existence remains storage's check.
    for _ in 1..10 {
        session
            .rename(OperationId::new(), "synthetic".into())
            .await
            .unwrap();
    }
    let manifest = session.manifest().await.unwrap();
    store.close().await.unwrap();
    manifest
}

#[tokio::test]
async fn sibling_constructs_every_server_produced_conversation_type() {
    let session = manifest().await;
    let sid = session.session_id().clone();
    let run = RunId::new();
    let id = EntryId::new(3, 0).unwrap();
    let previous = BlockCursor::new(sid.clone(), 2).unwrap();
    let activity = ActivityCursor::new(sid.clone(), run.clone(), 3, 0).unwrap();
    let content = ContentCursor::new(sid.clone(), run.clone(), id, 3, "text".into(), 3, 2).unwrap();
    let live = LiveCursor::new(sid.clone(), 10, 3, None, None).unwrap();
    let field = FieldFragment::new(
        "text".into(),
        OrderKey::new(Some(0), FieldRank::Content, None, Some(0)).to_string(),
        FieldKind::Text,
        3,
        7,
        2,
        7,
        "雪\0x".into(),
    )
    .unwrap();
    let view = EntryView::new(
        run.clone(),
        id,
        3,
        3,
        EntryKind::Assistant,
        RecordedState::InProgress,
        true,
        None,
        None,
        None,
        None,
        vec![field],
        Some(content),
        false,
    )
    .unwrap();
    let reference = EntryReference::new(run.clone(), id);
    assert_eq!(reference.run_id(), &run);
    assert_eq!(reference.entry_id(), &id);
    let page = ConversationPage::new(
        &ConversationQuery::Latest,
        10,
        session.clone(),
        Some(block(&run)),
        vec![view.clone()],
        Some(activity),
        Some(previous),
        Some(live.clone()),
    )
    .unwrap();
    assert_eq!(page.session_id(), &sid);
    assert_eq!(page.entries()[0].fields()[0].text(), "雪\0x");
    assert_eq!(page.live_after(), Some(&live));
    let addressed = EntryPage::new(sid.clone(), 10, block(&run), view.clone()).unwrap();
    assert_eq!(addressed.entry().entry_id(), &id);
    let change = EntryChange::new(block(&run), view).unwrap();
    let batch = ConversationChanges::new(
        sid.clone(),
        10,
        vec![
            DisplayChange::SessionUpsert(session),
            DisplayChange::BlockUpsert(Box::new(block(&run))),
            DisplayChange::EntryUpsert(Box::new(change)),
        ],
        live,
        false,
    )
    .unwrap();
    assert_eq!(batch.session_id(), &sid);
    assert_eq!(batch.changes().len(), 3);
    assert!(!batch.has_more());
}

fn rejected<T>(result: Result<T, ConstructionError>) {
    let Err(error) = result else {
        panic!("accepted an invalid conversation value")
    };
    assert_eq!(error.to_string(), "conversation.construction_invalid");
    assert_eq!(format!("{error:?}"), "ConstructionError");
}

fn invalid_field_ids() -> Vec<String> {
    let mut ids: Vec<_> = [
        "",
        "/synthetic/private-field",
        "../private-field",
        r"C:\synthetic\private-field",
        "text'; DROP TABLE conversation_fields; --",
        r#"{"field_id":"text"}"#,
        r#"["text"]"#,
        "field",
        "TEXT",
        "Text",
        " text",
        "text ",
        "text\n",
        "text\0",
        "te\txt",
        "tеxt",
        "ｔｅｘｔ",
        "text\u{200b}",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    for length in [1, 32, 63, 65, 128] {
        ids.push("a".repeat(length));
    }
    ids.extend([
        "A".repeat(64),
        "F".repeat(64),
        "g".repeat(64),
        format!("{}A", "a".repeat(63)),
        format!("{}g", "a".repeat(63)),
        format!("{}ｆ", "a".repeat(61)),
        format!("{}０", "0".repeat(61)),
        format!("{}а", "a".repeat(62)),
        format!(" {}", "a".repeat(64)),
        format!("{} ", "a".repeat(64)),
    ]);
    for byte in (0..=b' ').chain([0x7f]) {
        ids.push(format!(
            "{}{}{}",
            "a".repeat(31),
            char::from(byte),
            "a".repeat(32)
        ));
    }
    ids
}

#[test]
fn sibling_field_fragments_reject_invalid_field_identities() {
    for field_id in invalid_field_ids() {
        rejected(FieldFragment::new(
            field_id,
            "0".into(),
            FieldKind::Text,
            2,
            0,
            0,
            0,
            String::new(),
        ));
    }
}

#[test]
fn sibling_content_cursors_reject_invalid_field_identities() {
    let sid = ApplicationSessionId::new();
    let run = RunId::new();
    let id = EntryId::new(2, 0).unwrap();
    for field_id in invalid_field_ids() {
        rejected(ContentCursor::new(
            sid.clone(),
            run.clone(),
            id,
            3,
            field_id,
            2,
            0,
        ));
    }
}

#[test]
fn sibling_inbound_content_cursors_reject_invalid_field_identities() {
    for field_id in invalid_field_ids() {
        let fields = json!([
            1,
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "e:2:0",
            "3",
            field_id,
            "2",
            "0"
        ]);
        let encoded = format!("g11c.{}", URL_SAFE_NO_PAD.encode(fields.to_string()));
        let error = encoded.parse::<ContentCursor>().unwrap_err();
        assert_eq!(error.to_string(), "conversation.cursor_invalid");
        assert_eq!(format!("{error:?}"), "CursorError");
    }
}

#[test]
fn sibling_cursor_constructors_check_positions_and_rank_identity() {
    let sid = ApplicationSessionId::new();
    let run = RunId::new();
    let id = EntryId::new(2, 0).unwrap();
    rejected(BlockCursor::new(sid.clone(), 0));
    rejected(ActivityCursor::new(sid.clone(), run.clone(), 0, 0));
    for sequence in [1, (1 << 53) + 1, u64::MAX] {
        assert_eq!(
            BlockCursor::new(sid.clone(), sequence)
                .unwrap()
                .before_accepted_sequence(),
            sequence
        );
        assert_eq!(
            ActivityCursor::new(sid.clone(), run.clone(), sequence, 0)
                .unwrap()
                .before_slot(),
            0
        );
    }
    for rank in [0, 1, 2, 3, 4, u8::MAX] {
        for run_id in [None, Some(run.clone())] {
            for entry_id in [None, Some(id)] {
                let valid = match rank {
                    0 | 3 => run_id.is_none() && entry_id.is_none(),
                    1 => run_id.is_some() && entry_id.is_none(),
                    2 => run_id.is_some() && entry_id.is_some(),
                    _ => false,
                };
                let cursor = LiveCursor::new(sid.clone(), 2, rank, run_id.clone(), entry_id);
                assert_eq!(cursor.is_ok(), valid);
                if !valid {
                    rejected(cursor);
                }
            }
        }
    }
    rejected(LiveCursor::new(sid.clone(), 0, 3, None, None));
    rejected(LiveCursor::new(
        sid.clone(),
        1,
        2,
        Some(run.clone()),
        Some(id),
    ));
    for (epoch, generation, field) in [
        (0, 2, "text"),
        (2, 0, "text"),
        (1, 2, "text"),
        (2, 1, "text"),
        (2, 2, ""),
        (2, 2, "/synthetic/private-field"),
    ] {
        rejected(ContentCursor::new(
            sid.clone(),
            run.clone(),
            id,
            epoch,
            field.into(),
            generation,
            0,
        ));
    }
    rejected(ContentCursor::new(
        sid.clone(),
        run.clone(),
        id,
        2,
        "x".repeat(4096),
        2,
        0,
    ));
    // An unchanged field can retain its generation when the entry epoch changes.
    let content = ContentCursor::new(sid, run, id, 3, "0".repeat(64), 2, 0).unwrap();
    assert_eq!(content.content_epoch(), 3);
    assert_eq!(content.upper_generation(), 2);
    assert_eq!(content.upper_field_id(), "0".repeat(64));
    assert_eq!(
        content.to_string().parse::<ContentCursor>().unwrap(),
        content
    );
    assert_eq!(content.exclusive_upper_byte(), 0);
    assert_eq!(format!("{content:?}"), "ContentCursor([redacted])");
}

#[test]
fn sibling_fragments_validate_utf8_byte_ranges_without_narrowing_u64() {
    let make = |id: &str, generation, total, from, to, text: &str| {
        FieldFragment::new(
            id.into(),
            "0".into(),
            FieldKind::Text,
            generation,
            total,
            from,
            to,
            text.into(),
        )
    };
    for (total, from, to, text) in [
        (5, 4, 3, ""),
        (5, 0, 6, "123456"),
        (5, 0, 1, "雪"),
        (5, 0, 3, "x"),
        (u64::MAX, u64::MAX, 0, ""),
    ] {
        rejected(make("text", 1, total, from, to, text));
    }
    rejected(make("", 1, 0, 0, 0, ""));
    rejected(make("text", 0, 0, 0, 0, ""));
    let empty = make("text", 1, 0, 0, 0, "").unwrap();
    assert!(!empty.has_earlier() && !empty.has_later());
    let field = make("text", u64::MAX, u64::MAX, u64::MAX - 5, u64::MAX, "雪\0x").unwrap();
    assert_eq!(field.text().as_bytes(), "雪\0x".as_bytes());
    assert!(field.has_earlier() && !field.has_later());
}

#[test]
fn sibling_fragments_validate_canonical_order_keys() {
    let make = |order: &str| {
        FieldFragment::new(
            "text".into(),
            order.into(),
            FieldKind::Text,
            2,
            0,
            0,
            0,
            String::new(),
        )
    };
    assert_eq!(make("0").unwrap().order_key(), "0");
    for index in [None, Some(0), Some((1 << 53) + 1), Some(u64::MAX)] {
        let order = OrderKey::new(index, FieldRank::Content, index, index).to_string();
        assert_eq!(make(&order).unwrap().order_key(), order);
    }
    for order in [
        "",
        " ",
        "00",
        "1",
        "0x",
        "0:2:0",
        "0:2:0:0:0",
        "0:9:0:0",
        "0:02:0:0",
        "0:2:0:0\n",
        "1000000000000000:2:0:0",
        "100000000000000000:2:0:0",
        "1FFFFFFFFFFFFFFFF:2:0:0",
        "1fffffffffffffffz:2:0:0",
        "０:2:0:0",
        "0:2:0:0", // Retired private format is invalid.
        "0:0000000000000000:0:0:0000000000000002",
        "0:0000000000000001:0:0:0000000000000009",
        "1000000000000000:0000000000000001:0:0:0000000000000002",
        "100000000000000000:0000000000000001:0:0:0000000000000002",
        "1FFFFFFFFFFFFFFFF:0000000000000001:0:0:0000000000000002",
        "1fffffffffffffffz:0000000000000001:0:0:0000000000000002",
        "０:0000000000000001:0:0:0000000000000002",
    ] {
        rejected(make(order));
    }
}

#[test]
fn sibling_human_entries_require_one_canonical_text_field_including_empty_text() {
    let run = RunId::new();
    let make = |fields| {
        EntryView::new(
            run.clone(),
            EntryId::new(2, 0).unwrap(),
            2,
            2,
            EntryKind::Human,
            RecordedState::Accepted,
            false,
            None,
            None,
            None,
            None,
            fields,
            None,
            true,
        )
    };
    let field = |id: &str, order: &str, kind| {
        FieldFragment::new(id.into(), order.into(), kind, 2, 0, 0, 0, String::new()).unwrap()
    };
    let empty = make(vec![field("text", "0", FieldKind::Text)]).unwrap();
    assert_eq!(empty.fields().len(), 1);
    assert_eq!(empty.fields()[0].text(), "");
    assert!(empty.content_complete());
    let order = OrderKey::new(None, FieldRank::Content, None, None).to_string();
    for fields in [
        vec![],
        vec![
            field("text", "0", FieldKind::Text),
            field(&"a".repeat(64), &order, FieldKind::Text),
        ],
        vec![field(&"b".repeat(64), "0", FieldKind::Text)],
        vec![field("text", "0", FieldKind::ToolResult)],
        vec![field("text", &order, FieldKind::Text)],
    ] {
        rejected(make(fields));
    }
}

#[test]
fn sibling_nonhuman_entries_reject_human_order_key_sentinel() {
    let run = RunId::new();
    for (kind, field_kind) in [
        (EntryKind::Assistant, FieldKind::Text),
        (EntryKind::Tool, FieldKind::ToolResult),
        (EntryKind::Reuse, FieldKind::ToolResult),
        (EntryKind::Notice, FieldKind::Notice),
    ] {
        let reference = if kind == EntryKind::Reuse {
            Some(EntryReference::new(
                run.clone(),
                EntryId::new(2, 0).unwrap(),
            ))
        } else {
            None
        };
        let make = |order: &str| {
            EntryView::new(
                run.clone(),
                EntryId::new(3, 0).unwrap(),
                3,
                3,
                kind,
                RecordedState::Accepted,
                false,
                reference.clone(),
                None,
                None,
                None,
                vec![
                    FieldFragment::new(
                        "text".into(),
                        order.into(),
                        field_kind,
                        3,
                        0,
                        0,
                        0,
                        String::new(),
                    )
                    .unwrap(),
                ],
                None,
                true,
            )
        };
        assert!(make(&OrderKey::new(None, FieldRank::Content, None, None).to_string()).is_ok());
        rejected(make("0"));
    }
}

#[test]
fn sibling_human_anchor_accepts_partial_oversized_unicode_with_continuation() {
    let sid = ApplicationSessionId::new();
    let run = RunId::new();
    let id = EntryId::new(2, 0).unwrap();
    let text = "雪🙂\0".repeat(5000);
    assert!(text.len() > 32 * 1024);
    let from = text.len() - "雪🙂\0".len();
    let cursor =
        ContentCursor::new(sid, run.clone(), id, 2, "text".into(), 2, from as u64).unwrap();
    let field = FieldFragment::new(
        "text".into(),
        "0".into(),
        FieldKind::Text,
        2,
        text.len() as u64,
        from as u64,
        text.len() as u64,
        text[from..].into(),
    )
    .unwrap();
    let human = EntryView::new(
        run.clone(),
        id,
        2,
        2,
        EntryKind::Human,
        RecordedState::Accepted,
        false,
        None,
        None,
        None,
        None,
        vec![field],
        Some(cursor.clone()),
        false,
    )
    .unwrap();
    let block = BlockView::new(
        run,
        2,
        2,
        RecordedRunState::Accepted,
        false,
        None,
        None,
        None,
        None,
        human,
    )
    .unwrap();
    assert_eq!(block.human().fields().len(), 1);
    let field = &block.human().fields()[0];
    assert_eq!(field.text().as_bytes(), "雪🙂\0".as_bytes());
    assert_eq!(field.total_bytes(), text.len() as u64);
    assert_eq!(field.from_byte(), cursor.exclusive_upper_byte());
    assert!(field.has_earlier() && !field.has_later());
    assert_eq!(block.human().earlier_content(), Some(&cursor));
    assert!(!block.human().content_complete());
}

#[test]
fn sibling_entries_validate_revisions_references_fields_and_content_identity() {
    let sid = ApplicationSessionId::new();
    let run = RunId::new();
    let id = EntryId::new(3, 0).unwrap();
    let make = |revision, epoch, fields, cursor, complete| {
        EntryView::new(
            run.clone(),
            id,
            revision,
            epoch,
            EntryKind::Assistant,
            RecordedState::InProgress,
            false,
            None,
            None,
            None,
            None,
            fields,
            cursor,
            complete,
        )
    };
    for (revision, epoch) in [(0, 3), (3, 0), (2, 3), (3, 2), (3, 4)] {
        rejected(make(revision, epoch, vec![], None, true));
    }
    let field = |id: &str, order, generation, from, to| {
        FieldFragment::new(
            id.into(),
            OrderKey::new(Some(order), FieldRank::Content, None, None).to_string(),
            FieldKind::Text,
            generation,
            3,
            from,
            to,
            "x".repeat((to - from) as usize),
        )
        .unwrap()
    };
    assert!(make(4, 3, vec![field("text", 0, 3, 0, 3)], None, true).is_ok());
    rejected(make(4, 3, vec![field("text", 0, 2, 0, 3)], None, true));
    rejected(make(4, 3, vec![field("text", 0, 5, 0, 3)], None, true));
    rejected(make(4, 3, vec![field("text", 0, 3, 1, 3)], None, true));
    rejected(make(4, 3, vec![field("text", 0, 3, 0, 2)], None, true));
    rejected(make(
        4,
        3,
        vec![field("text", 0, 3, 0, 3), field("text", 1, 3, 0, 3)],
        None,
        true,
    ));
    rejected(make(
        4,
        3,
        vec![
            field(&"a".repeat(64), 1, 3, 0, 3),
            field(&"b".repeat(64), 0, 3, 0, 3),
        ],
        None,
        true,
    ));
    for (cursor_run, cursor_id, epoch, generation, upper) in [
        (RunId::new(), id, 3, 3, 0),
        (run.clone(), EntryId::new(4, 0).unwrap(), 4, 4, 0),
        (run.clone(), id, 4, 3, 0),
        (run.clone(), id, 3, 5, 0),
        (run.clone(), id, 3, 4, 0),
        (run.clone(), id, 3, 3, 4),
    ] {
        let cursor = ContentCursor::new(
            sid.clone(),
            cursor_run,
            cursor_id,
            epoch,
            "text".into(),
            generation,
            upper,
        )
        .unwrap();
        rejected(make(
            4,
            3,
            vec![field("text", 0, 3, 0, 3)],
            Some(cursor),
            false,
        ));
    }
    let cursor = ContentCursor::new(sid, run.clone(), id, 3, "text".into(), 3, 0).unwrap();
    rejected(make(4, 3, vec![], Some(cursor), true));
    let reuse = |reference| {
        EntryView::new(
            run.clone(),
            id,
            3,
            3,
            EntryKind::Reuse,
            RecordedState::Completed,
            false,
            reference,
            Some(true),
            Some(false),
            Some(false),
            vec![],
            None,
            true,
        )
    };
    rejected(reuse(None));
    rejected(reuse(Some(EntryReference::new(
        RunId::new(),
        EntryId::new(2, 0).unwrap(),
    ))));
    rejected(reuse(Some(EntryReference::new(run.clone(), id))));
    rejected(reuse(Some(EntryReference::new(
        run.clone(),
        EntryId::new(4, 0).unwrap(),
    ))));
    assert!(
        reuse(Some(EntryReference::new(
            run.clone(),
            EntryId::new(2, 0).unwrap()
        )))
        .is_ok()
    );
    rejected(EntryView::new(
        run.clone(),
        id,
        3,
        3,
        EntryKind::Assistant,
        RecordedState::Accepted,
        false,
        Some(EntryReference::new(
            run.clone(),
            EntryId::new(2, 0).unwrap(),
        )),
        None,
        None,
        None,
        vec![],
        None,
        true,
    ));
    for (result, finish, error) in [
        (Some(false), None, None),
        (None, Some(false), None),
        (None, None, Some(false)),
    ] {
        rejected(EntryView::new(
            run.clone(),
            id,
            3,
            3,
            EntryKind::Assistant,
            RecordedState::Accepted,
            false,
            None,
            result,
            finish,
            error,
            vec![],
            None,
            true,
        ));
    }
}

#[test]
fn sibling_blocks_and_entry_payloads_reject_mismatched_anchors() {
    let run = RunId::new();
    let other = RunId::new();
    let make = |accepted, revision, human| {
        BlockView::new(
            run.clone(),
            accepted,
            revision,
            RecordedRunState::Accepted,
            false,
            None,
            None,
            None,
            None,
            human,
        )
    };
    rejected(make(0, 2, entry(&run, 2, EntryKind::Human)));
    rejected(make(2, 1, entry(&run, 2, EntryKind::Human)));
    rejected(make(2, 2, entry(&other, 2, EntryKind::Human)));
    rejected(make(2, 2, entry(&run, 2, EntryKind::Assistant)));
    rejected(make(2, 3, entry(&run, 3, EntryKind::Human)));
    let slotted_human = EntryView::new(
        run.clone(),
        EntryId::new(2, 1).unwrap(),
        2,
        2,
        EntryKind::Human,
        RecordedState::Accepted,
        false,
        None,
        None,
        None,
        None,
        entry(&run, 2, EntryKind::Human).fields().to_vec(),
        None,
        true,
    )
    .unwrap();
    rejected(make(2, 2, slotted_human));
    let sid = ApplicationSessionId::new();
    for invalid in [
        entry(&other, 3, EntryKind::Assistant),
        entry(&run, 1, EntryKind::Assistant),
        entry(&run, 3, EntryKind::Human),
    ] {
        rejected(EntryPage::new(
            sid.clone(),
            10,
            block(&run),
            invalid.clone(),
        ));
        rejected(EntryChange::new(block(&run), invalid));
    }
    rejected(EntryPage::new(
        sid.clone(),
        0,
        block(&run),
        entry(&run, 3, EntryKind::Assistant),
    ));
    rejected(EntryPage::new(
        sid.clone(),
        2,
        block(&run),
        entry(&run, 3, EntryKind::Assistant),
    ));
    assert!(EntryPage::new(sid, 10, block(&run), entry(&run, 2, EntryKind::Human)).is_ok());
}

#[tokio::test]
async fn sibling_aggregates_reject_cross_session_content_cursors() {
    let session = manifest().await;
    let sid = session.session_id().clone();
    let other = ApplicationSessionId::new();
    let run = RunId::new();
    let partial = |session_id, sequence, kind| {
        let id = EntryId::new(sequence, 0).unwrap();
        let cursor = ContentCursor::new(
            session_id,
            run.clone(),
            id,
            sequence,
            "text".into(),
            sequence,
            0,
        )
        .unwrap();
        EntryView::new(
            run.clone(),
            id,
            sequence,
            sequence,
            kind,
            RecordedState::Accepted,
            false,
            None,
            None,
            None,
            None,
            entry(&run, sequence, kind).fields().to_vec(),
            Some(cursor),
            false,
        )
        .unwrap()
    };
    let wrong_entry = partial(other.clone(), 3, EntryKind::Assistant);
    let wrong_block = BlockView::new(
        run.clone(),
        2,
        2,
        RecordedRunState::Accepted,
        false,
        None,
        None,
        None,
        None,
        partial(other, 2, EntryKind::Human),
    )
    .unwrap();
    let correct_entry = partial(sid.clone(), 3, EntryKind::Assistant);
    rejected(EntryChange::new(wrong_block.clone(), correct_entry));
    rejected(ConversationChanges::new(
        sid.clone(),
        10,
        vec![DisplayChange::BlockUpsert(Box::new(wrong_block.clone()))],
        LiveCursor::new(sid.clone(), 10, 3, None, None).unwrap(),
        false,
    ));
    for (block, entry) in [
        (block(&run), wrong_entry.clone()),
        (wrong_block, wrong_entry),
    ] {
        rejected(EntryPage::new(
            sid.clone(),
            10,
            block.clone(),
            entry.clone(),
        ));
        let live = LiveCursor::new(sid.clone(), 10, 3, None, None).unwrap();
        rejected(ConversationPage::new(
            &ConversationQuery::Latest,
            10,
            session.clone(),
            Some(block.clone()),
            vec![entry.clone()],
            None,
            None,
            Some(live.clone()),
        ));
        let change = EntryChange::new(block, entry).unwrap();
        rejected(ConversationChanges::new(
            sid.clone(),
            10,
            vec![DisplayChange::EntryUpsert(Box::new(change))],
            live,
            false,
        ));
    }
}

#[tokio::test]
async fn sibling_pages_validate_aggregate_identity_and_latest_cursor_shape() {
    let session = manifest().await;
    let sid = session.session_id().clone();
    let other = ApplicationSessionId::new();
    let run = RunId::new();
    let live = LiveCursor::new(sid.clone(), 10, 3, None, None).unwrap();
    let make = |query: &ConversationQuery, head, block, entries, activity, previous, live| {
        ConversationPage::new(
            query,
            head,
            session.clone(),
            block,
            entries,
            activity,
            previous,
            live,
        )
    };
    let latest = ConversationQuery::Latest;
    assert!(make(&latest, 10, None, vec![], None, None, Some(live.clone())).is_ok());
    rejected(make(
        &latest,
        9,
        None,
        vec![],
        None,
        None,
        Some(live.clone()),
    ));
    for cursor in [
        None,
        Some(LiveCursor::new(other.clone(), 10, 3, None, None).unwrap()),
        Some(LiveCursor::new(sid.clone(), 9, 3, None, None).unwrap()),
        Some(LiveCursor::new(sid.clone(), 10, 1, Some(run.clone()), None).unwrap()),
    ] {
        rejected(make(
            &latest,
            10,
            Some(block(&run)),
            vec![],
            None,
            None,
            cursor,
        ));
    }
    rejected(make(
        &latest,
        10,
        None,
        vec![entry(&run, 3, EntryKind::Assistant)],
        None,
        None,
        Some(live.clone()),
    ));
    rejected(make(
        &latest,
        10,
        None,
        vec![],
        None,
        Some(BlockCursor::new(sid.clone(), 2).unwrap()),
        Some(live.clone()),
    ));
    for entries in [
        vec![entry(&RunId::new(), 3, EntryKind::Assistant)],
        vec![entry(&run, 2, EntryKind::Human)],
        vec![entry(&run, 11, EntryKind::Assistant)],
        vec![
            entry(&run, 4, EntryKind::Assistant),
            entry(&run, 3, EntryKind::Assistant),
        ],
        vec![
            entry(&run, 3, EntryKind::Assistant),
            entry(&run, 3, EntryKind::Assistant),
        ],
    ] {
        rejected(make(
            &latest,
            10,
            Some(block(&run)),
            entries,
            None,
            None,
            Some(live.clone()),
        ));
    }
    for previous in [
        BlockCursor::new(other.clone(), 2).unwrap(),
        BlockCursor::new(sid.clone(), 3).unwrap(),
    ] {
        rejected(make(
            &latest,
            10,
            Some(block(&run)),
            vec![],
            None,
            Some(previous),
            Some(live.clone()),
        ));
    }
    for activity in [
        ActivityCursor::new(other.clone(), run.clone(), 3, 0).unwrap(),
        ActivityCursor::new(sid.clone(), RunId::new(), 3, 0).unwrap(),
        ActivityCursor::new(sid.clone(), run.clone(), 4, 0).unwrap(),
        ActivityCursor::new(sid.clone(), run.clone(), 3, 1).unwrap(),
    ] {
        rejected(make(
            &latest,
            10,
            Some(block(&run)),
            vec![entry(&run, 3, EntryKind::Assistant)],
            Some(activity),
            None,
            Some(live.clone()),
        ));
    }
    let before = ConversationQuery::Before(BlockCursor::new(sid.clone(), 3).unwrap());
    assert!(make(&before, 10, Some(block(&run)), vec![], None, None, None).is_ok());
    assert!(make(&before, 10, None, vec![], None, None, None).is_ok());
    rejected(make(
        &before,
        10,
        Some(block(&run)),
        vec![],
        None,
        None,
        Some(live),
    ));
    let wrong_before = ConversationQuery::Before(BlockCursor::new(other, 3).unwrap());
    rejected(make(&wrong_before, 10, None, vec![], None, None, None));
    let boundary = ConversationQuery::Before(BlockCursor::new(sid.clone(), 2).unwrap());
    rejected(make(
        &boundary,
        10,
        Some(block(&run)),
        vec![],
        None,
        None,
        None,
    ));
    let within = ConversationQuery::Within(ActivityCursor::new(sid, run.clone(), 4, 0).unwrap());
    assert!(
        make(
            &within,
            10,
            Some(block(&run)),
            vec![entry(&run, 3, EntryKind::Assistant)],
            None,
            None,
            None
        )
        .is_ok()
    );
    rejected(make(
        &within,
        10,
        Some(block(&run)),
        vec![entry(&run, 4, EntryKind::Assistant)],
        None,
        None,
        None,
    ));
    rejected(make(
        &within,
        10,
        Some(block(&RunId::new())),
        vec![],
        None,
        None,
        None,
    ));
    rejected(make(&within, 10, None, vec![], None, None, None));
}

#[tokio::test]
async fn sibling_changes_validate_session_watermark_and_last_entity_identity() {
    let session = manifest().await;
    let sid = session.session_id().clone();
    let other = ApplicationSessionId::new();
    let run = RunId::new();
    let live = LiveCursor::new(sid.clone(), 10, 3, None, None).unwrap();
    let make =
        |changes, cursor, more| ConversationChanges::new(sid.clone(), 10, changes, cursor, more);
    assert!(make(vec![], live.clone(), false).is_ok());
    rejected(make(vec![], live.clone(), true));
    rejected(make(
        vec![],
        LiveCursor::new(other.clone(), 10, 3, None, None).unwrap(),
        false,
    ));
    rejected(make(
        vec![],
        LiveCursor::new(sid.clone(), 9, 3, None, None).unwrap(),
        false,
    ));
    rejected(make(
        vec![],
        LiveCursor::new(sid.clone(), 11, 3, None, None).unwrap(),
        false,
    ));
    rejected(ConversationChanges::new(
        other,
        10,
        vec![DisplayChange::SessionUpsert(session.clone())],
        live.clone(),
        false,
    ));
    let entry_change = || {
        DisplayChange::EntryUpsert(Box::new(
            EntryChange::new(block(&run), entry(&run, 3, EntryKind::Assistant)).unwrap(),
        ))
    };
    for cursor in [
        LiveCursor::new(sid.clone(), 3, 1, Some(run.clone()), None).unwrap(),
        LiveCursor::new(
            sid.clone(),
            3,
            2,
            Some(RunId::new()),
            Some(EntryId::new(3, 0).unwrap()),
        )
        .unwrap(),
        LiveCursor::new(
            sid.clone(),
            3,
            2,
            Some(run.clone()),
            Some(EntryId::new(3, 1).unwrap()),
        )
        .unwrap(),
        LiveCursor::new(
            sid.clone(),
            4,
            2,
            Some(run.clone()),
            Some(EntryId::new(3, 0).unwrap()),
        )
        .unwrap(),
        live.clone(),
    ] {
        rejected(make(vec![entry_change()], cursor, true));
    }
    let cursor = LiveCursor::new(
        sid.clone(),
        3,
        2,
        Some(run.clone()),
        Some(EntryId::new(3, 0).unwrap()),
    )
    .unwrap();
    assert!(make(vec![entry_change()], cursor.clone(), true).is_ok());
    rejected(make(vec![entry_change()], cursor, false));
    let cursor = LiveCursor::new(sid.clone(), 2, 1, Some(run.clone()), None).unwrap();
    assert!(
        make(
            vec![DisplayChange::BlockUpsert(Box::new(block(&run)))],
            cursor.clone(),
            true
        )
        .is_ok()
    );
    rejected(make(
        vec![DisplayChange::BlockUpsert(Box::new(block(&RunId::new())))],
        cursor,
        true,
    ));
    assert!(
        make(
            vec![DisplayChange::SessionUpsert(session.clone())],
            LiveCursor::new(sid.clone(), 1, 0, None, None).unwrap(),
            true
        )
        .is_ok()
    );
    rejected(make(
        vec![DisplayChange::SessionUpsert(session.clone())],
        live.clone(),
        true,
    ));
    rejected(ConversationChanges::new(
        sid.clone(),
        9,
        vec![DisplayChange::SessionUpsert(session)],
        LiveCursor::new(sid.clone(), 9, 3, None, None).unwrap(),
        false,
    ));
    let future = DisplayChange::EntryUpsert(Box::new(
        EntryChange::new(block(&run), entry(&run, 11, EntryKind::Assistant)).unwrap(),
    ));
    rejected(make(vec![future], live, false));
}
