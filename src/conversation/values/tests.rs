use super::*;

#[test]
fn entry_values_keep_scoped_identity_and_actual_recording_facts() {
    let run = RunId::new();
    let entry = EntryView {
        run_id: run.clone(),
        entry_id: EntryId::new(7, 2).unwrap(),
        revision: 10,
        content_epoch: 7,
        kind: EntryKind::Tool,
        recorded_state: RecordedState::InProgress,
        provisional: false,
        reference: None,
        result_recorded: Some(true),
        finish_recorded: Some(false),
        is_error: Some(false),
        fields: vec![FieldFragment {
            field_id: "0".repeat(64),
            order_key: "0:0000000000000005:0:0:0000000000000006".into(),
            kind: FieldKind::ToolResult,
            generation: 8,
            total_bytes: 12,
            from_byte: 2,
            to_byte: 7,
            text: "雪\0x".into(),
        }],
        earlier_content: None,
        content_complete: false,
    };
    assert_eq!(entry.run_id(), &run);
    assert_eq!(entry.entry_id().to_string(), "e:7:2");
    assert_eq!(entry.position(), entry.entry_id().position());
    assert_eq!(entry.revision(), 10);
    assert_eq!(entry.content_epoch(), 7);
    assert_eq!(entry.kind(), EntryKind::Tool);
    assert_eq!(entry.recorded_state(), RecordedState::InProgress);
    assert!(!entry.provisional());
    assert_eq!(entry.result_recorded(), Some(true));
    assert_eq!(entry.finish_recorded(), Some(false));
    assert_eq!(entry.is_error(), Some(false));
    assert!(entry.reference().is_none());
    assert!(entry.earlier_content().is_none());
    assert!(!entry.content_complete());
    let field = &entry.fields()[0];
    assert_eq!(field.field_id(), "0".repeat(64));
    assert_eq!(field.order_key(), "0:0000000000000005:0:0:0000000000000006");
    assert_eq!(field.kind(), FieldKind::ToolResult);
    assert_eq!(field.generation(), 8);
    assert_eq!(field.total_bytes(), 12);
    assert_eq!(field.from_byte(), 2);
    assert_eq!(field.to_byte(), 7);
    assert_eq!(field.text().as_bytes(), "雪\0x".as_bytes());
    assert!(field.has_earlier() && field.has_later());
    let reference = EntryReference {
        run_id: run.clone(),
        entry_id: *entry.entry_id(),
    };
    assert_eq!(reference.run_id(), &run);
    assert_eq!(reference.entry_id(), entry.entry_id());
}

#[test]
fn summary_and_outcome_expose_only_the_safe_recorded_surface() {
    let summary = SummaryView::from(&RunSummary {
        turns_started: u64::MAX,
        turns_finished: u64::MAX,
        model_requests_attempted: u64::MAX,
        model_requests_admitted: u64::MAX,
        new_tool_dispatches: u64::MAX,
        tool_results_prepared: u64::MAX,
        reused_results: u64::MAX,
        last_request_id: Some("request".into()),
        last_upstream_outcome: Some(UpstreamOutcome::Unknown),
    });
    for counter in [
        summary.turns_started(),
        summary.turns_finished(),
        summary.model_requests_attempted(),
        summary.model_requests_admitted(),
        summary.new_tool_dispatches(),
        summary.tool_results_prepared(),
        summary.reused_results(),
    ] {
        assert_eq!(counter, u64::MAX);
    }
    assert_eq!(summary.last_request_id(), Some("request"));
    assert_eq!(
        summary.last_upstream_outcome(),
        Some(UpstreamOutcome::Unknown)
    );
    let outcome = OutcomeView::from(&RunOutcome::Failed {
        code: "/synthetic/private-error".into(),
    });
    assert_eq!(
        outcome,
        OutcomeView::Failed {
            code: safe_code("upstream_error")
        }
    );
    assert!(!format!("{outcome:?}").contains("/synthetic/private-error"));
    assert_eq!(safe_code("event_sink").as_str(), "event_sink");
    assert_eq!(safe_code("unknown").as_str(), "upstream_error");
    assert_eq!(
        OutcomeView::from(&RunOutcome::Completed),
        OutcomeView::Completed
    );
    assert_eq!(
        OutcomeView::from(&RunOutcome::CancelledLocally),
        OutcomeView::CancelledLocally
    );
}
