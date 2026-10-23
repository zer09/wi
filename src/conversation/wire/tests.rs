use super::*;
use crate::{
    conversation::primitives::{FieldRank, OrderKey},
    run::{RunOutcome, RunSummary},
    storage::{ApplicationSessionId, CreateSession, OperationId, RunId, SessionStore},
};
use serde_json::{Value, json};

fn field(sequence: u64, index: u64, text: String) -> FieldFragment {
    FieldFragment::new(
        format!("{index:064x}"),
        OrderKey::new(Some(index), FieldRank::Content, None, Some(0)).to_string(),
        FieldKind::Text,
        sequence,
        text.len() as u64,
        0,
        text.len() as u64,
        text,
    )
    .unwrap()
}
fn entry(run: &RunId, sequence: u64, kind: EntryKind, fields: Vec<FieldFragment>) -> EntryView {
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
fn human(run: &RunId, text: String) -> EntryView {
    let length = text.len() as u64;
    entry(
        run,
        2,
        EntryKind::Human,
        vec![
            FieldFragment::new(
                "text".into(),
                "0".into(),
                FieldKind::Text,
                2,
                length,
                0,
                length,
                text,
            )
            .unwrap(),
        ],
    )
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
        human(run, "Task".into()),
    )
    .unwrap()
}
fn parsed(wire: DisplayJson<'_>) -> Value {
    let bytes = wire.encode().unwrap();
    assert_eq!(wire.json_size().unwrap(), bytes.len());
    serde_json::from_slice(&bytes).unwrap()
}
fn keys(value: &Value, expected: &[&str]) {
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    assert_eq!(
        value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        expected
    );
}

#[test]
fn entry_and_field_closed_shapes_preserve_exact_text_and_ranges() {
    let run = RunId::new();
    let sid = ApplicationSessionId::new();
    let id = EntryId::new((1 << 53) + 1, u64::MAX).unwrap();
    let text = "\0\u{1}\n\r\t\"\\<script>雪🙂";
    let cursor = ContentCursor::new(
        sid,
        run.clone(),
        id,
        id.first_sequence(),
        "text".into(),
        u64::MAX,
        1,
    )
    .unwrap();
    let field = FieldFragment::new(
        "text".into(),
        OrderKey::new(Some(u64::MAX), FieldRank::Content, None, Some(u64::MAX)).to_string(),
        FieldKind::Text,
        u64::MAX,
        u64::MAX,
        1,
        1 + text.len() as u64,
        text.into(),
    )
    .unwrap();
    let view = EntryView::new(
        run.clone(),
        id,
        u64::MAX,
        id.first_sequence(),
        EntryKind::Tool,
        RecordedState::InProgress,
        true,
        None,
        Some(true),
        Some(false),
        Some(false),
        vec![field],
        Some(cursor.clone()),
        false,
    )
    .unwrap();
    let wire = parsed(DisplayJson::Entry(&view));
    assert_eq!(
        wire,
        json!({
            "run_id": run, "entry_id": id.to_string(), "position": {"sequence": "9007199254740993", "slot": u64::MAX.to_string()},
            "revision": u64::MAX.to_string(), "content_epoch": "9007199254740993", "kind": "tool", "recorded_state": "in_progress",
            "provisional": true, "reference": null, "result_recorded": true, "finish_recorded": false, "is_error": false,
            "fields": [{"field_id": "text", "order_key": view.fields()[0].order_key(), "kind": "text", "generation": u64::MAX.to_string(),
                "total_bytes": u64::MAX.to_string(), "from_byte": "1", "to_byte": (1 + text.len()).to_string(), "text": text,
                "has_earlier": true, "has_later": true}], "earlier_content": cursor.to_string(), "content_complete": false,
        })
    );
    assert!(view.fields()[0].has_earlier());
    assert!(view.fields()[0].has_later());
    let reuse = EntryView::new(
        run.clone(),
        EntryId::new(u64::MAX, 0).unwrap(),
        u64::MAX,
        u64::MAX,
        EntryKind::Reuse,
        RecordedState::Completed,
        false,
        Some(EntryReference::new(run.clone(), id)),
        Some(true),
        Some(true),
        Some(true),
        vec![],
        None,
        true,
    )
    .unwrap();
    let wire = parsed(DisplayJson::Entry(&reuse));
    assert_eq!(
        wire["reference"],
        json!({"run_id": run, "entry_id": id.to_string()})
    );
    assert_eq!(wire["is_error"], true);
}

#[test]
fn all_enum_spellings_are_closed_and_exhaustive() {
    for (kind, spelling) in [
        (EntryKind::Human, "human"),
        (EntryKind::Assistant, "assistant"),
        (EntryKind::Tool, "tool"),
        (EntryKind::Reuse, "reuse"),
        (EntryKind::Notice, "notice"),
    ] {
        assert_eq!(entry_kind(kind), spelling);
    }
    for (kind, spelling) in [
        (FieldKind::Text, "text"),
        (FieldKind::Refusal, "refusal"),
        (FieldKind::ReasoningSummary, "reasoning_summary"),
        (FieldKind::ReasoningText, "reasoning_text"),
        (FieldKind::FunctionName, "function_name"),
        (FieldKind::FunctionArguments, "function_arguments"),
        (FieldKind::ToolName, "tool_name"),
        (FieldKind::ToolResult, "tool_result"),
        (FieldKind::AuthoritativeText, "authoritative_text"),
        (FieldKind::Unsupported, "unsupported"),
        (FieldKind::Notice, "notice"),
    ] {
        assert_eq!(field_kind(kind), spelling);
        let f =
            FieldFragment::new("text".into(), "0".into(), kind, 1, 0, 0, 0, String::new()).unwrap();
        let v = serde_json::to_value(Field(&f)).unwrap();
        assert_eq!(v["kind"], spelling);
        assert_eq!(v["has_earlier"], false);
        assert_eq!(v["has_later"], false);
    }
    for (state, spelling) in [
        (RecordedState::Accepted, "accepted"),
        (RecordedState::InProgress, "in_progress"),
        (RecordedState::Completed, "completed"),
        (RecordedState::Incomplete, "incomplete"),
        (RecordedState::Failed, "failed"),
        (RecordedState::Cancelled, "cancelled"),
        (RecordedState::Interrupted, "interrupted"),
        (RecordedState::Unknown, "unknown"),
    ] {
        assert_eq!(recorded_state(state), spelling);
    }
    for (state, spelling) in [
        (RecordedRunState::Accepted, "accepted"),
        (RecordedRunState::Running, "running"),
        (RecordedRunState::Completed, "completed"),
        (RecordedRunState::Failed, "failed"),
        (RecordedRunState::CancelledLocally, "cancelled_locally"),
        (RecordedRunState::Interrupted, "interrupted"),
    ] {
        assert_eq!(run_state(state), spelling);
    }
}

#[test]
fn outcome_summary_and_sink_use_api1_safe_representations() {
    let run = RunId::new();
    for (outcome, expected) in [
        (RunOutcome::Completed, json!({"type":"completed"})),
        (
            RunOutcome::CancelledLocally,
            json!({"type":"cancelled_locally"}),
        ),
        (
            RunOutcome::Failed {
                code: "/synthetic/private-error?secret=canary".into(),
            },
            json!({"type":"failed", "code":"upstream_error"}),
        ),
    ] {
        let display = OutcomeView::from(&outcome);
        assert_eq!(serde_json::to_value(Outcome(display)).unwrap(), expected);
        assert_eq!(
            serde_json::to_vec(&Outcome(display)).unwrap(),
            serde_json::to_vec(&crate::http_api::dto::OutcomeView::from(&outcome)).unwrap()
        );
    }
    for (outcome, spelling) in [
        (UpstreamOutcome::NotSubmitted, "not_submitted"),
        (UpstreamOutcome::Unknown, "unknown"),
        (UpstreamOutcome::TerminalReceived, "terminal_received"),
    ] {
        let summary = RunSummary {
            turns_started: u64::MAX,
            turns_finished: (1 << 53) + 1,
            model_requests_attempted: 3,
            model_requests_admitted: 4,
            new_tool_dispatches: 5,
            tool_results_prepared: 6,
            reused_results: 7,
            last_request_id: Some("r\0雪".into()),
            last_upstream_outcome: Some(outcome),
        };
        let display = SummaryView::from(&summary);
        assert_eq!(
            serde_json::to_vec(&Summary(&display)).unwrap(),
            serde_json::to_vec(&crate::http_api::dto::SummaryView::from(&summary)).unwrap()
        );
        for (error, code) in [
            (RunSinkError::Full, "full"),
            (RunSinkError::Closed, "closed"),
            (RunSinkError::Failed, "failed"),
        ] {
            let b = BlockView::new(
                run.clone(),
                2,
                2,
                RecordedRunState::Failed,
                true,
                Some(OutcomeView::Completed),
                Some(display.clone()),
                Some(false),
                Some(error),
                human(&run, "Task".into()),
            )
            .unwrap();
            let v = parsed(DisplayJson::Block(&b));
            assert_eq!(v["sink_error"], code);
            assert_eq!(v["events_complete"], false);
            assert_eq!(
                v["summary"],
                json!({ "turns_started": u64::MAX.to_string(), "turns_finished": "9007199254740993", "model_requests_attempted": "3",
                "model_requests_admitted": "4", "new_tool_dispatches": "5", "tool_results_prepared": "6", "reused_results": "7", "last_request_id": "r\0雪", "last_upstream_outcome": spelling })
            );
        }
    }
    let display = SummaryView::from(&RunSummary::default());
    let v = serde_json::to_value(Summary(&display)).unwrap();
    assert!(v["last_request_id"].is_null() && v["last_upstream_outcome"].is_null());
    for code in [
        "unauthorized",
        "forbidden",
        "rate_limited",
        "auth_expired",
        "auth_account_changed",
        "timeout",
        "transport_error",
        "unexpected_content_type",
        "locally_cancelled",
        "slow_consumer",
        "unexpected_end",
        "protocol_error",
        "provider_error",
        "invalid_request",
        "output_limit",
        "unsupported_output",
        "unsupported_feature",
        "http_error",
        "gateway_error",
        "event_sink",
        "counter_overflow",
        "tool_execution",
        "provider_open",
        "provider_request_failed",
        "provider_correlation",
        "history_identity",
        "history_restore",
    ] {
        let value = serde_json::to_value(Outcome(OutcomeView::from(&RunOutcome::Failed {
            code: code.into(),
        })))
        .unwrap();
        assert_eq!(value, json!({"type":"failed", "code":code}));
    }
}

#[test]
fn entry_and_human_exact_32768_boundary_and_one_byte_over() {
    let run = RunId::new();
    // The trial size comes from the real encoder, including the decimal length digits.
    for kind in [EntryKind::Human, EntryKind::Assistant] {
        let make = |n| {
            if kind == EntryKind::Human {
                human(&run, "x".repeat(n))
            } else {
                entry(&run, 3, kind, vec![field(3, 0, "x".repeat(n))])
            }
        };
        let trial = make(30_000);
        let overhead = DisplayJson::Entry(&trial).json_size().unwrap() - 30_000;
        let n = ENTRY_BYTES - overhead;
        let at = make(n);
        assert_eq!(DisplayJson::Entry(&at).encode().unwrap().len(), ENTRY_BYTES);
        assert_eq!(DisplayJson::Entry(&at).json_size().unwrap(), ENTRY_BYTES);
        let over = make(n + 1);
        assert_eq!(
            serde_json::to_vec(&Entry(&over)).unwrap().len(),
            ENTRY_BYTES + 1
        );
        assert_eq!(DisplayJson::Entry(&over).json_size(), Err(EncodingError));
        assert_eq!(DisplayJson::Entry(&over).encode(), Err(EncodingError));
        if kind == EntryKind::Human {
            let b = BlockView::new(
                run.clone(),
                2,
                2,
                RecordedRunState::Accepted,
                false,
                None,
                None,
                None,
                None,
                over,
            )
            .unwrap();
            assert_eq!(DisplayJson::Block(&b).encode(), Err(EncodingError));
        }
    }
}

#[test]
fn escaping_counts_actual_bytes_and_does_not_normalize_text() {
    let run = RunId::new();
    for text in [
        "",
        "\0",
        "\u{1}",
        "\n\r\t",
        "\"\\",
        "雪🙂",
        "<script>https://synthetic.invalid</script>",
    ] {
        let e = human(&run, text.into());
        let bytes = DisplayJson::Entry(&e).encode().unwrap();
        assert_eq!(DisplayJson::Entry(&e).json_size().unwrap(), bytes.len());
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap()["fields"][0]["text"],
            text
        );
        let raw = serde_json::to_vec(&Entry(&e)).unwrap();
        assert_eq!(bytes, raw);
    }
    let escaped = human(&run, "\0".repeat(6000));
    assert!(escaped.fields()[0].text().len() < ENTRY_BYTES);
    assert_eq!(DisplayJson::Entry(&escaped).encode(), Err(EncodingError));
}

#[test]
fn descriptor_64_allowed_65_rejected_without_a_stored_content_cap() {
    let run = RunId::new();
    for (n, allowed) in [(64, true), (65, false)] {
        let view = entry(
            &run,
            3,
            EntryKind::Assistant,
            (0..n).map(|i| field(3, i, String::new())).collect(),
        );
        assert_eq!(DisplayJson::Entry(&view).encode().is_ok(), allowed);
    }
}

#[test]
fn capped_writer_never_allocates_or_writes_past_its_limit() {
    let mut writer = CappedWriter {
        count: 0,
        limit: 3,
        output: Some(Vec::with_capacity(3)),
    };
    writer.write_all(b"abc").unwrap();
    let capacity = writer.output.as_ref().unwrap().capacity();
    assert_eq!(
        writer.write_all(b"secret").unwrap_err().to_string(),
        "conversation.encoding_invalid"
    );
    assert_eq!(writer.count, 3);
    assert_eq!(writer.output.as_ref().unwrap(), b"abc");
    assert_eq!(writer.output.as_ref().unwrap().capacity(), capacity);
    let mut counter = CappedWriter {
        count: usize::MAX,
        limit: usize::MAX,
        output: None,
    };
    assert!(counter.write_all(b"x").is_err());
    assert!(counter.output.is_none());
    let huge = "\0".repeat(2_000_000);
    let pointer = huge.as_ptr();
    assert_eq!(count(&huge, ENTRY_BYTES), Err(EncodingError));
    assert_eq!(huge.as_ptr(), pointer);
    let e = human(&RunId::new(), huge);
    let pointer = e.fields()[0].text().as_ptr();
    assert_eq!(DisplayJson::Entry(&e).encode(), Err(EncodingError));
    assert_eq!(e.fields()[0].text().as_ptr(), pointer);
    assert_eq!(EncodingError.to_string(), "conversation.encoding_invalid");
    assert_eq!(format!("{EncodingError:?}"), "EncodingError");
}

#[test]
fn serialization_failure_is_redacted() {
    struct Fails;
    impl Serialize for Fails {
        fn serialize<S: Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom(
                "/synthetic/private-field cursor=private-canary",
            ))
        }
    }
    assert_eq!(count(&Fails, PAGE_BYTES), Err(EncodingError));
}

async fn manifest() -> SessionManifest {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("store")).await.unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "Title\0雪".into(), None).unwrap())
        .await
        .unwrap();
    let session = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    for _ in 1..100 {
        session
            .rename(OperationId::new(), "Title\0雪".into())
            .await
            .unwrap();
    }
    let manifest = session.manifest().await.unwrap();
    store.close().await.unwrap();
    manifest
}
fn page(
    session: &SessionManifest,
    entries: Vec<EntryView>,
    b: Option<BlockView>,
    latest: bool,
) -> ConversationPage {
    let sid = session.session_id().clone();
    let query = if latest {
        ConversationQuery::Latest
    } else {
        ConversationQuery::Before(BlockCursor::new(sid.clone(), 99).unwrap())
    };
    let previous = b
        .as_ref()
        .map(|b| BlockCursor::new(sid.clone(), b.accepted_sequence()).unwrap());
    let activity = entries.first().map(|e| {
        ActivityCursor::new(
            sid.clone(),
            e.run_id().clone(),
            e.position().sequence(),
            e.position().slot(),
        )
        .unwrap()
    });
    let live = if latest {
        Some(LiveCursor::new(sid, session.head_sequence(), 3, None, None).unwrap())
    } else {
        None
    };
    ConversationPage::new(
        &query,
        session.head_sequence(),
        session.clone(),
        b,
        entries,
        activity,
        previous,
        live,
    )
    .unwrap()
}

#[tokio::test]
async fn page_entry_page_empty_backward_and_changes_exact_closed_shapes() {
    let session = manifest().await;
    let run = RunId::new();
    let b = block(&run);
    let e = entry(
        &run,
        3,
        EntryKind::Assistant,
        vec![field(3, 0, "Answer".into())],
    );
    let p = page(&session, vec![e.clone()], Some(b.clone()), true);
    let v = parsed(DisplayJson::Page(&p));
    keys(
        &v,
        &[
            "api_version",
            "conversation_version",
            "session_id",
            "snapshot_head",
            "session",
            "block",
            "entries",
            "earlier_activity",
            "previous_block",
            "live_after",
        ],
    );
    assert_eq!(v["api_version"], 1);
    assert_eq!(v["conversation_version"], 1);
    assert_eq!(v["snapshot_head"], "100");
    assert_eq!(
        v["session"],
        serde_json::to_value(crate::http_api::dto::SessionView::from(&session)).unwrap()
    );
    keys(
        &v["block"],
        &[
            "run_id",
            "accepted_sequence",
            "revision",
            "state",
            "result_recorded",
            "outcome",
            "summary",
            "events_complete",
            "sink_error",
            "human",
        ],
    );
    assert_eq!(v["block"]["run_id"], json!(run));
    assert_eq!(v["block"]["accepted_sequence"], "2");
    assert_eq!(v["block"]["revision"], "2");
    assert_eq!(v["block"]["state"], "accepted");
    assert_eq!(v["block"]["result_recorded"], false);
    for key in ["outcome", "summary", "events_complete", "sink_error"] {
        assert!(v["block"][key].is_null());
    }
    assert_eq!(v["block"]["human"], parsed(DisplayJson::Entry(b.human())));
    for key in [
        "result_recorded",
        "finish_recorded",
        "is_error",
        "reference",
        "earlier_content",
    ] {
        assert!(v["block"]["human"][key].is_null());
    }
    assert_eq!(v["entries"], json!([parsed(DisplayJson::Entry(&e))]));
    assert_eq!(
        v["earlier_activity"],
        p.earlier_activity().unwrap().to_string()
    );
    assert_eq!(v["previous_block"], p.previous_block().unwrap().to_string());
    assert_eq!(v["live_after"], p.live_after().unwrap().to_string());
    let backward = page(&session, vec![e.clone()], Some(b.clone()), false);
    assert!(parsed(DisplayJson::Page(&backward))["live_after"].is_null());
    let within = ConversationPage::new(
        &ConversationQuery::Within(
            ActivityCursor::new(session.session_id().clone(), run.clone(), 4, 0).unwrap(),
        ),
        100,
        session.clone(),
        Some(b.clone()),
        vec![e.clone()],
        None,
        None,
        None,
    )
    .unwrap();
    assert!(parsed(DisplayJson::Page(&within))["live_after"].is_null());
    let empty = page(&session, vec![], None, true);
    let ev = parsed(DisplayJson::Page(&empty));
    assert!(ev["block"].is_null());
    assert_eq!(ev["entries"], json!([]));
    assert!(ev["earlier_activity"].is_null() && ev["previous_block"].is_null());
    let addressed =
        EntryPage::new(session.session_id().clone(), 100, b.clone(), e.clone()).unwrap();
    assert_eq!(
        parsed(DisplayJson::EntryPage(&addressed)),
        json!({"api_version":1,"conversation_version":1,"session_id":session.session_id(),
        "snapshot_head":"100","block":v["block"],"entry":v["entries"][0]})
    );
    let changes = vec![
        DisplayChange::SessionUpsert(session.clone()),
        DisplayChange::BlockUpsert(Box::new(b.clone())),
        DisplayChange::EntryUpsert(Box::new(EntryChange::new(b.clone(), e.clone()).unwrap())),
        DisplayChange::EntryUpsert(Box::new(
            EntryChange::new(b.clone(), b.human().clone()).unwrap(),
        )),
    ];
    let after = LiveCursor::new(session.session_id().clone(), 100, 3, None, None).unwrap();
    let batch = ConversationChanges::new(
        session.session_id().clone(),
        100,
        changes,
        after.clone(),
        false,
    )
    .unwrap();
    let cv = parsed(DisplayJson::Changes(&batch));
    assert_eq!(
        cv,
        json!({"api_version":1,"conversation_version":1,"session_id":session.session_id(),"observed_head":"100",
        "changes":[{"kind":"session.upsert","session":v["session"]},{"kind":"block.upsert","block":v["block"]},
            {"kind":"entry.upsert","block":v["block"],"entry":v["entries"][0]},
            {"kind":"entry.upsert","block":v["block"],"entry":v["block"]["human"]}], "next_after":after.to_string()})
    );
    let partial = ConversationChanges::new(
        session.session_id().clone(),
        100,
        vec![DisplayChange::EntryUpsert(Box::new(
            EntryChange::new(b, e.clone()).unwrap(),
        ))],
        LiveCursor::new(
            session.session_id().clone(),
            3,
            2,
            Some(run),
            Some(*e.entry_id()),
        )
        .unwrap(),
        true,
    )
    .unwrap();
    assert!(partial.has_more());
    assert!(
        parsed(DisplayJson::Changes(&partial))
            .get("has_more")
            .is_none()
    );
    let empty =
        ConversationChanges::new(session.session_id().clone(), 100, vec![], after, false).unwrap();
    assert_eq!(parsed(DisplayJson::Changes(&empty))["changes"], json!([]));
}

#[tokio::test]
async fn page_and_batch_exact_524288_boundary_include_all_overhead() {
    let session = manifest().await;
    let run = RunId::new();
    // Eighteen entries leave room to vary one field without exceeding the entry bound.
    let make = |last| {
        page(
            &session,
            (3..21)
                .map(|seq| {
                    entry(
                        &run,
                        seq,
                        EntryKind::Assistant,
                        vec![field(
                            seq,
                            0,
                            "x".repeat(if seq == 20 { last } else { 29_000 }),
                        )],
                    )
                })
                .collect(),
            Some(block(&run)),
            true,
        )
    };
    let trial = make(10_000);
    let n = 10_000 + PAGE_BYTES - DisplayJson::Page(&trial).json_size().unwrap();
    let p = make(n);
    assert_eq!(DisplayJson::Page(&p).json_size().unwrap(), PAGE_BYTES);
    assert_eq!(DisplayJson::Page(&p).encode().unwrap().len(), PAGE_BYTES);
    let over = make(n + 1);
    assert_eq!(
        serde_json::to_vec(&Page(&over)).unwrap().len(),
        PAGE_BYTES + 1
    );
    assert_eq!(DisplayJson::Page(&over).encode(), Err(EncodingError));
    let make_batch = |last| {
        let b = block(&run);
        let changes = (3..21)
            .map(|seq| {
                DisplayChange::EntryUpsert(Box::new(
                    EntryChange::new(
                        b.clone(),
                        entry(
                            &run,
                            seq,
                            EntryKind::Assistant,
                            vec![field(
                                seq,
                                0,
                                "x".repeat(if seq == 20 { last } else { 28_000 }),
                            )],
                        ),
                    )
                    .unwrap(),
                ))
            })
            .collect();
        ConversationChanges::new(
            session.session_id().clone(),
            100,
            changes,
            LiveCursor::new(session.session_id().clone(), 100, 3, None, None).unwrap(),
            false,
        )
        .unwrap()
    };
    let trial = make_batch(10_000);
    let n = 10_000 + PAGE_BYTES - DisplayJson::Changes(&trial).json_size().unwrap();
    let batch = make_batch(n);
    assert_eq!(
        DisplayJson::Changes(&batch).encode().unwrap().len(),
        PAGE_BYTES
    );
    let over = make_batch(n + 1);
    assert_eq!(
        serde_json::to_vec(&Changes(&over)).unwrap().len(),
        PAGE_BYTES + 1
    );
    assert_eq!(DisplayJson::Changes(&over).encode(), Err(EncodingError));
    // Removing real cursor/header/anchor bytes changes the measured budget.
    assert!(
        count(&Entries(p.entries()), PAGE_BYTES).unwrap()
            < DisplayJson::Page(&p).json_size().unwrap()
    );
    let backward = page(&session, p.entries().to_vec(), Some(block(&run)), false);
    assert!(DisplayJson::Page(&backward).json_size().unwrap() < PAGE_BYTES);
}

#[tokio::test]
async fn activity_and_batch_64_allowed_65_rejected() {
    let session = manifest().await;
    let run = RunId::new();
    for (n, allowed) in [(64, true), (65, false)] {
        let p = page(
            &session,
            (3..3 + n)
                .map(|seq| entry(&run, seq, EntryKind::Notice, vec![]))
                .collect(),
            Some(block(&run)),
            true,
        );
        assert_eq!(DisplayJson::Page(&p).encode().is_ok(), allowed);
        let batch = ConversationChanges::new(
            session.session_id().clone(),
            100,
            (0..n)
                .map(|_| DisplayChange::BlockUpsert(Box::new(block(&run))))
                .collect(),
            LiveCursor::new(session.session_id().clone(), 100, 3, None, None).unwrap(),
            false,
        )
        .unwrap();
        assert_eq!(DisplayJson::Changes(&batch).encode().is_ok(), allowed);
    }
}
