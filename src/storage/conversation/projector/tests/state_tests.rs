use super::*;

#[tokio::test]
async fn a3_authoritative_outcomes_and_observed_terminal_status_survive_run_completion() {
    for (outcome, expected) in [
        (ResponseOutcome::Completed, State::Completed),
        (
            ResponseOutcome::Incomplete {
                reason: Some("PRIVATE_REASON_CANARY".into()),
            },
            State::Incomplete,
        ),
        (ResponseOutcome::Cancelled, State::Cancelled),
        (ResponseOutcome::Failed, State::Failed),
    ] {
        let mut f = Fixture::new().await;
        f.start().await;
        let mut terminal = response(vec![message("retained")], "retained");
        terminal.outcome = outcome;
        f.provider("t1", ProviderEvent::ResponseFinished { response: terminal })
            .await;
        f.runtime(
            Some("t1"),
            RunEvent::TurnFinished {
                number: 1,
                response_id: Some("repeated".into()),
                outcome: TurnOutcome::Stopped {
                    reason: RunOutcome::CancelledLocally,
                },
                upstream_outcome: Some(crate::UpstreamOutcome::Unknown),
            },
        )
        .await;
        f.runtime(
            None,
            RunEvent::RunFinished {
                outcome: RunOutcome::CancelledLocally,
                summary: summary(),
            },
        )
        .await;
        let entry = f.assistant("t1").await;
        assert_eq!(entry.metadata.state, expected);
        assert!(!entry.metadata.provisional);
        assert_eq!(f.fields(entry.id).await[0].1, "retained");
        assert!(
            !f.visible_and_metadata()
                .await
                .contains("PRIVATE_REASON_CANARY")
        );
        f.close().await;
    }
    for status in ["completed", "incomplete", "failed", "cancelled"] {
        let mut f = Fixture::new().await;
        f.start().await;
        f.provider(
            "t1",
            ProviderEvent::ResponseStatus {
                response_id: "repeated".into(),
                status: status.into(),
            },
        )
        .await;
        f.runtime(
            Some("t1"),
            RunEvent::TurnFinished {
                number: 1,
                response_id: Some("repeated".into()),
                outcome: TurnOutcome::Stopped {
                    reason: RunOutcome::CancelledLocally,
                },
                upstream_outcome: None,
            },
        )
        .await;
        f.runtime(
            None,
            RunEvent::RunFinished {
                outcome: RunOutcome::Completed,
                summary: summary(),
            },
        )
        .await;
        assert_eq!(
            f.assistant("t1").await.metadata.state,
            State::status(status)
        );
        f.close().await;
    }
}

#[tokio::test]
async fn a3_failures_without_current_turn_are_explicit_notices() {
    let mut f = Fixture::new().await;
    f.runtime(None, RunEvent::RunStarted).await;
    f.provider(
        "unknown",
        ProviderEvent::SessionClosed {
            reason: "PRIVATE_CLOSE_CANARY".into(),
        },
    )
    .await;
    f.provider(
        "unknown",
        ProviderEvent::RequestFailed {
            code: "timeout".into(),
            message: "PRIVATE_FAILURE_CANARY".into(),
            upstream_outcome: crate::UpstreamOutcome::NotSubmitted,
        },
    )
    .await;
    let kinds: Vec<String> = sqlx::query_scalar(
        "SELECT kind FROM conversation_entries ORDER BY first_sequence,position_slot",
    )
    .fetch_all(&mut f.sql)
    .await
    .unwrap();
    assert_eq!(kinds, ["human", "notice", "notice"]);
    let visible = f.visible_and_metadata().await;
    assert!(visible.contains("Response closed"));
    assert!(visible.contains("Request failed"));
    assert!(!visible.contains("PRIVATE_"));
    f.close().await;
}

#[tokio::test]
async fn a3_snapshot_generation_changes_only_replaced_text_and_layout_epochs() {
    let mut f = Fixture::new().await;
    f.start().await;
    f.provider(
        "t1",
        ProviderEvent::OutputItemStarted {
            response_id: "repeated".into(),
            output_index: 0,
            item: message("before"),
        },
    )
    .await;
    let first = f.assistant("t1").await;
    f.provider(
        "t1",
        ProviderEvent::OutputItemFinished {
            response_id: "repeated".into(),
            output_index: 0,
            item: message("after\0🙂"),
        },
    )
    .await;
    let second = f.assistant("t1").await;
    assert_eq!(first.id, second.id);
    assert_eq!(first.epoch, second.epoch);
    assert_eq!(f.fields(second.id).await[0].2, f.sequence);
    f.provider(
        "t1",
        ProviderEvent::ResponseFinished {
            response: response(vec![message("after\0🙂")], "after\0🙂"),
        },
    )
    .await;
    let terminal = f.assistant("t1").await;
    assert_eq!(terminal.epoch, first.epoch);
    assert_eq!(f.fields(terminal.id).await[0].2, f.sequence - 1);
    f.close().await;
}

#[tokio::test]
async fn a3_chronology_and_repeated_response_identity_follow_sources_not_categories() {
    let mut f = Fixture::new().await;
    f.start().await;
    f.provider(
        "t1",
        delta(0, None, Some(0), DeltaKind::Text, "first partial"),
    )
    .await;
    let first = f.assistant("t1").await.id;
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
    let tool = f.tool("call").await.id;
    f.provider(
        "t1",
        ProviderEvent::ResponseFinished {
            response: response(vec![message("first final")], "first final"),
        },
    )
    .await;
    assert_eq!(f.assistant("t1").await.id, first);
    f.runtime(
        Some("t1"),
        RunEvent::TurnFinished {
            number: 1,
            response_id: Some("repeated".into()),
            outcome: TurnOutcome::ToolsPrepared,
            upstream_outcome: None,
        },
    )
    .await;
    f.runtime(Some("t2"), RunEvent::TurnStarted { number: 2 })
        .await;
    f.provider(
        "t2",
        ProviderEvent::ResponseFinished {
            response: response(vec![message("second final")], "second final"),
        },
    )
    .await;
    let second = f.assistant("t2").await.id;
    assert!(first < tool && tool < second);
    let entries: Vec<(String, String)> = sqlx::query_as(
        "SELECT entry_id,kind FROM conversation_entries ORDER BY first_sequence,position_slot",
    )
    .fetch_all(&mut f.sql)
    .await
    .unwrap();
    assert_eq!(
        entries,
        [
            ("e:2:0".into(), "human".into()),
            (first.to_string(), "assistant".into()),
            (tool.to_string(), "tool".into()),
            (second.to_string(), "assistant".into())
        ]
    );
    assert_eq!(f.fields(first).await[0].1, "first final");
    assert_eq!(f.fields(second).await[0].1, "second final");
    f.close().await;
}

#[tokio::test]
async fn a3_field_generation_cannot_be_newer_than_its_entry_revision() {
    let mut f = Fixture::new().await;
    f.start().await;
    f.provider("t1", delta(0, None, Some(0), DeltaKind::Text, "partial"))
        .await;
    f.stored_event("session.renamed", json!({"title":"later"}), false)
        .await;
    sqlx::query("UPDATE conversation_fields SET generation=? WHERE order_key<>'0'")
        .bind(f.sequence as i64)
        .execute(&mut f.sql)
        .await
        .unwrap();
    let mut transaction = f.sql.begin().await.unwrap();
    let mut entry = rows::lookup(
        &mut transaction,
        &f.run,
        f.sequence,
        &Source::Assistant {
            turn_id: "t1".into(),
        },
    )
    .await
    .unwrap()
    .unwrap();
    let part = content::Part {
        order: crate::conversation::interpretation::delta_field(0, None, Some(0), DeltaKind::Text)
            .0,
        kind: FieldKind::Text,
        text: "more",
    };
    let error = content::delta(&mut transaction, &f.run, &mut entry, f.sequence + 1, part)
        .await
        .unwrap_err();
    assert_eq!(error.kind(), StorageErrorKind::Integrity);
    transaction.rollback().await.unwrap();
    f.close().await;
}
