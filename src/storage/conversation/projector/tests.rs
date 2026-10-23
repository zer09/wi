use super::*;
use crate::{
    DeltaKind, EventEnvelope, ItemKind, ModelResponse, OutputItem, OutputProvenance, ProviderEvent,
    ResponseOutcome,
    run::{RunEvent, RunOutcome, RunSummary, TurnOutcome},
    tools::ToolExecutionEvent,
};
use serde_json::json;
use sqlx::Connection;

mod fixture;
mod integrity_tests;
mod order_tests;
mod state_tests;
use fixture::*;

#[tokio::test]
async fn a3_accepts_exact_human_with_production_projection() {
    let mut fixture = Fixture::new().await;
    let head: (i64, i64) =
        sqlx::query_as("SELECT applied_sequence,metadata_sequence FROM conversation_projection")
            .fetch_one(&mut fixture.sql)
            .await
            .unwrap();
    assert_eq!(head, (2, 1));
    assert_eq!(
        fixture.fields(EntryId::new(2, 0).unwrap()).await,
        [("text".into(), " exact\0用户\n\u{1b} ".into(), 2)]
    );
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut fixture.sql)
        .await
        .unwrap();
    assert_eq!(version, 3);
    assert_eq!(
        rows::block(&mut fixture.sql, &fixture.run, fixture.sequence + 1)
            .await
            .unwrap()
            .human,
        "e:2:0"
    );
    assert!(
        !fixture
            .dump()
            .await
            .join("")
            .contains("PRIVATE_PREPARED_CANARY")
    );
    fixture.close().await;
}

#[tokio::test]
async fn a3_private_facts_and_rename_only_advance_their_watermarks() {
    use crate::{
        ReplayIdentity,
        storage::{RecordedProviderBinding, StoredHistorySelection},
    };
    let mut f = Fixture::new().await;
    let before = f.dump().await;
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
    let after = f.dump().await;
    assert_eq!(before[1..], after[1..]);
    f.runtime(None, RunEvent::RunStarted).await;
    let before = f.dump().await;
    let binding = RecordedProviderBinding::new(
        f.run.clone(),
        "PRIVATE_BINDING_CANARY".into(),
        "synthetic".into(),
        ReplayIdentity::new("synthetic".into(), "native-v1".into(), "a".repeat(64)).unwrap(),
    )
    .unwrap();
    f.append(AppendRunRecord::ProviderBinding(binding)).await;
    assert_eq!(before[1..], f.dump().await[1..]);
    f.stored_event("session.renamed", json!({"title":"private title"}), false)
        .await;
    let head: (i64, i64) =
        sqlx::query_as("SELECT applied_sequence,metadata_sequence FROM conversation_projection")
            .fetch_one(&mut f.sql)
            .await
            .unwrap();
    assert_eq!(head, (6, 6));
    assert_eq!(before[1..], f.dump().await[1..]);
    f.close().await;
}

#[tokio::test]
async fn a3_interleaved_parts_preserve_u64_indices_empty_unicode_nul_and_controls() {
    let mut f = Fixture::new().await;
    f.start().await;
    let cases = [
        (u64::MAX, None, Some(u64::MAX), DeltaKind::Text, "尾\0"),
        (
            0,
            Some(u64::MAX),
            None,
            DeltaKind::ReasoningSummary,
            "summary",
        ),
        (0, Some(0), None, DeltaKind::ReasoningSummary, ""),
        (0, None, Some(1), DeltaKind::Refusal, "no\r\n"),
        (0, None, Some(0), DeltaKind::ReasoningText, "思\u{1b}"),
        (1, None, None, DeltaKind::FunctionArguments, "{\"雪\":"),
        (u64::MAX, None, Some(u64::MAX), DeltaKind::Text, "🙂\u{7f}"),
        (1, None, None, DeltaKind::FunctionArguments, "1}"),
        (
            2,
            None,
            None,
            DeltaKind::CustomToolInput,
            "PRIVATE_CUSTOM_CANARY",
        ),
        (
            2,
            None,
            None,
            DeltaKind::CustomToolInput,
            "PRIVATE_CUSTOM_CANARY",
        ),
    ];
    // New fields below the existing maximum change the layout; growth keeps the epoch.
    let epochs = [5, 6, 7, 8, 9, 10, 10, 10, 13, 13];
    for ((output, summary, content, kind, text), epoch) in cases.into_iter().zip(epochs) {
        f.provider("t1", delta(output, summary, content, kind, text))
            .await;
        assert_eq!(f.assistant("t1").await.epoch, epoch);
    }
    let entry = f.assistant("t1").await;
    assert_eq!(entry.id, EntryId::new(5, 0).unwrap());
    assert_eq!(entry.epoch, 13);
    let actual = f.fields(entry.id).await;
    assert_eq!(
        actual
            .iter()
            .map(|(kind, text, _)| (kind.as_str(), text.as_str()))
            .collect::<Vec<_>>(),
        [
            ("reasoning_summary", ""),
            ("reasoning_summary", "summary"),
            ("reasoning_text", "思\u{1b}"),
            ("refusal", "no\r\n"),
            ("function_arguments", "{\"雪\":1}"),
            ("unsupported", "Unsupported content"),
            ("text", "尾\0🙂\u{7f}"),
        ]
    );
    assert_eq!(actual.last().unwrap().2, 5);
    f.provider(
        "t1",
        ProviderEvent::OutputItemFinished {
            response_id: "repeated".into(),
            output_index: u64::MAX,
            item: message("max-index replacement"),
        },
    )
    .await;
    let replaced = f.fields(entry.id).await;
    assert_eq!(&replaced[..replaced.len() - 1], &actual[..actual.len() - 1]);
    assert_eq!(replaced.last().unwrap().1, "max-index replacement");
    assert!(
        !f.visible_and_metadata()
            .await
            .contains("PRIVATE_CUSTOM_CANARY")
    );
    f.close().await;
}

#[tokio::test]
async fn a3_item_replacement_keeps_other_sections_positions_and_unchanged_generations() {
    let mut f = Fixture::new().await;
    f.start().await;
    f.provider(
        "t1",
        ProviderEvent::ResponseStarted {
            response_id: "repeated".into(),
        },
    )
    .await;
    f.provider("t1", delta(7, None, Some(0), DeltaKind::Text, "other"))
        .await;
    f.provider(
        "t1",
        ProviderEvent::OutputItemStarted {
            response_id: "repeated".into(),
            output_index: 0,
            item: message(""),
        },
    )
    .await;
    f.provider(
        "t1",
        delta(0, None, Some(0), DeltaKind::Text, "provisional"),
    )
    .await;
    let before = f.assistant("t1").await;
    let other = f.fields(before.id).await[1].clone();
    let item = OutputItem {
        id: Some("item".into()),
        kind: ItemKind::Message,
        native_type: "message".into(),
        function_call: None,
        native: json!({"content":[{"type":"refusal","refusal":"replacement"},{"type":"output_text","text":"second"}]}),
    };
    f.provider(
        "t1",
        ProviderEvent::OutputItemFinished {
            response_id: "repeated".into(),
            output_index: 0,
            item: item.clone(),
        },
    )
    .await;
    let after = f.assistant("t1").await;
    assert_eq!(before.id, after.id);
    assert_eq!(after.epoch, f.sequence);
    let fields = f.fields(after.id).await;
    assert_eq!(fields[2], other);
    assert_eq!(fields[0].0, "refusal");
    assert_eq!(fields[0].1, "replacement");
    let epoch = after.epoch;
    f.provider(
        "t1",
        ProviderEvent::OutputItemFinished {
            response_id: "repeated".into(),
            output_index: 0,
            item,
        },
    )
    .await;
    assert_eq!(f.assistant("t1").await.epoch, epoch);
    assert_eq!(f.fields(after.id).await, fields);
    f.close().await;
}

#[tokio::test]
async fn a3_terminal_native_and_recovered_replace_same_entry_with_fallback_and_no_result_duplicate()
{
    for provenance in [
        OutputProvenance::NativeTerminal,
        OutputProvenance::ValidatedOutputItemDone,
    ] {
        let mut f = Fixture::new().await;
        f.start().await;
        f.provider(
            "t1",
            delta(0, None, Some(0), DeltaKind::Text, "discard provisional"),
        )
        .await;
        let original = f.assistant("t1").await.id;
        let mut final_response = response(
            vec![
                OutputItem {
                    id: None,
                    kind: ItemKind::Reasoning,
                    native_type: "reasoning".into(),
                    function_call: None,
                    native: json!({"summary":[{"type":"summary_text","text":"reason"}],"content":[{"type":"reasoning_text","text":"detail"}]}),
                },
                message("covered"),
                OutputItem {
                    id: None,
                    kind: ItemKind::Message,
                    native_type: "message".into(),
                    function_call: None,
                    native: json!({"content":[{"type":"refusal","refusal":"independent"}]}),
                },
                OutputItem {
                    id: None,
                    kind: ItemKind::Unknown,
                    native_type: "PRIVATE_TYPE_CANARY".into(),
                    function_call: None,
                    native: json!({"text":"PRIVATE_NATIVE_CANARY"}),
                },
            ],
            "covered plus suffix",
        );
        final_response.output_provenance = provenance;
        f.provider(
            "t1",
            ProviderEvent::ResponseFinished {
                response: final_response.clone(),
            },
        )
        .await;
        let entry = f.assistant("t1").await;
        assert_eq!(entry.id, original);
        assert!(!entry.metadata.provisional);
        assert_eq!(entry.metadata.provenance, Some(provenance));
        let before = f.fields(entry.id).await;
        assert_eq!(
            before
                .iter()
                .map(|(k, t, _)| (k.as_str(), t.as_str()))
                .collect::<Vec<_>>(),
            [
                ("reasoning_summary", "reason"),
                ("reasoning_text", "detail"),
                ("authoritative_text", "covered plus suffix"),
                ("refusal", "independent"),
                ("unsupported", "Unsupported content"),
            ]
        );
        assert_eq!(final_response.native["output"], json!([]));
        f.runtime(
            Some("t1"),
            RunEvent::TurnFinished {
                number: 1,
                response_id: Some("repeated".into()),
                outcome: TurnOutcome::ModelCompleted,
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
        f.append(AppendRunRecord::Result(RunResult {
            run_id: f.run.as_str().into(),
            session_id: Some("synthetic-provider-session".into()),
            outcome: RunOutcome::Completed,
            summary: summary(),
            last_response: Some(final_response),
            events_complete: true,
            sink_error: None,
        }))
        .await;
        assert_eq!(f.fields(entry.id).await, before);
        assert_eq!(f.assistant("t1").await.metadata.state, State::Completed);
        let dump = f.visible_and_metadata().await;
        assert!(!dump.contains("PRIVATE_NATIVE_CANARY"));
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM conversation_entries WHERE kind='assistant'")
                .fetch_one(&mut f.sql)
                .await
                .unwrap();
        assert_eq!(count, 1);
        f.close().await;
    }
}

#[tokio::test]
async fn a3_fallback_sql_order_matches_shared_original_content_boundary() {
    use crate::conversation::projection::project_response;

    for provenance in [
        OutputProvenance::NativeTerminal,
        OutputProvenance::ValidatedOutputItemDone,
    ] {
        for independent in [false, true] {
            let mut f = Fixture::new().await;
            f.start().await;
            let mut item = message("covered");
            item.native = json!({"content":[
                {"type":"unknown","private":"PRIVATE_NATIVE_CANARY"},
                {"type":"output_text","text":"covered"}
            ]});
            if independent {
                item.native["content"][1] = json!({"type":"refusal","refusal":"independent"});
            }
            let mut terminal = response(vec![item], "covered suffix");
            terminal.output_provenance = provenance;
            let expected: Vec<_> = project_response(&terminal)
                .fields
                .iter()
                .map(|field| (field.part.kind, field.part.text.to_owned()))
                .collect();
            f.provider("t1", ProviderEvent::ResponseFinished { response: terminal })
                .await;
            let entry = f.assistant("t1").await;
            let actual: Vec<_> = f
                .fields(entry.id)
                .await
                .into_iter()
                .map(|(kind, text, _)| (fields::decode_kind(&kind).unwrap(), text))
                .collect();
            assert_eq!(actual, expected);
            assert_eq!(
                actual[0],
                (FieldKind::Unsupported, "Unsupported content".into())
            );
            assert_eq!(
                actual[1],
                (FieldKind::AuthoritativeText, "covered suffix".into())
            );
            if independent {
                assert_eq!(actual[2], (FieldKind::Refusal, "independent".into()));
            }
            assert_eq!(entry.metadata.provenance, Some(provenance));
            assert!(
                !f.visible_and_metadata()
                    .await
                    .contains("PRIVATE_NATIVE_CANARY")
            );
            f.close().await;
        }
    }
}

#[tokio::test]
async fn a3_first_terminal_function_fields_share_one_generation() {
    let mut f = Fixture::new().await;
    f.start().await;
    let item = OutputItem {
        id: None,
        kind: ItemKind::FunctionCall,
        native_type: "function_call".into(),
        function_call: Some(crate::FunctionCall {
            call_id: "call".into(),
            name: "tool\0雪".into(),
            arguments: "{\"value\":\"🙂\"}".into(),
            origin: crate::CallOrigin::Direct,
            namespace: None,
            complete: true,
        }),
        native: json!({"private":"PRIVATE_NATIVE_CANARY"}),
    };
    f.provider(
        "t1",
        ProviderEvent::ResponseFinished {
            response: response(vec![item], ""),
        },
    )
    .await;
    let entry = f.assistant("t1").await;
    assert_eq!(
        f.fields(entry.id).await,
        [
            ("function_name".into(), "tool\0雪".into(), f.sequence),
            (
                "function_arguments".into(),
                "{\"value\":\"🙂\"}".into(),
                f.sequence
            )
        ]
    );
    f.close().await;
}

#[tokio::test]
async fn a3_tools_keep_exact_results_uncertainty_and_same_run_reuse_references() {
    let mut f = Fixture::new().await;
    f.start().await;
    for (call, output, is_error) in [
        ("ok", "{\"error\":true}\0雪", false),
        ("error", "gateway_error", true),
        ("limit", "output_limit", true),
        ("empty", "", false),
    ] {
        f.runtime(
            Some("t1"),
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionStarted {
                    call_id: call.into(),
                    tool_name: "tool\0雪".into(),
                },
            },
        )
        .await;
        let pending = f.tool(call).await;
        assert_eq!(pending.metadata.result_recorded, Some(false));
        assert_eq!(pending.metadata.is_error, None);
        f.append(AppendRunRecord::ToolResult {
            request_id: Some("request-t1".into()),
            call_id: call.into(),
            output: output.into(),
            is_error,
        })
        .await;
        let result = f.tool(call).await;
        assert_eq!(result.id, pending.id);
        assert_eq!(result.metadata.finish_recorded, Some(false));
        assert_eq!(f.fields(result.id).await[1].1, output);
        f.runtime(
            Some("t1"),
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionFinished {
                    call_id: call.into(),
                    tool_name: "tool\0雪".into(),
                    is_error: !is_error,
                },
            },
        )
        .await;
        let finished = f.tool(call).await;
        assert_eq!(finished.metadata.is_error, Some(is_error));
        assert_eq!(finished.metadata.finish_is_error, Some(!is_error));
        assert_eq!(finished.epoch, pending.epoch);
    }
    for call in ["pending", "no-result"] {
        f.runtime(
            Some("t1"),
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionStarted {
                    call_id: call.into(),
                    tool_name: "tool".into(),
                },
            },
        )
        .await;
    }
    f.runtime(
        Some("t1"),
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionFinished {
                call_id: "no-result".into(),
                tool_name: "tool".into(),
                is_error: false,
            },
        },
    )
    .await;
    assert_eq!(f.tool("no-result").await.metadata.state, State::Unknown);
    f.runtime(
        Some("t1"),
        RunEvent::TurnFinished {
            number: 1,
            response_id: None,
            outcome: TurnOutcome::ToolsPrepared,
            upstream_outcome: None,
        },
    )
    .await;
    f.runtime(Some("t2"), RunEvent::TurnStarted { number: 2 })
        .await;
    f.runtime(
        Some("t2"),
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolResultReused {
                call_id: "ok".into(),
                tool_name: "tool\0雪".into(),
            },
        },
    )
    .await;
    let reuse = rows::lookup(
        &mut f.sql,
        &f.run,
        f.sequence,
        &Source::Reuse {
            sequence: f.sequence,
            slot: 0,
        },
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        reuse.metadata.reference,
        Some(f.tool("ok").await.id.to_string())
    );
    assert!(f.fields(reuse.id).await.is_empty());
    f.stored_event(
        "run.interrupted",
        json!({"run_id":f.run,"reason":"process_restart"}),
        true,
    )
    .await;
    assert_eq!(f.tool("pending").await.metadata.state, State::Unknown);
    assert_eq!(
        f.tool("no-result").await.metadata.result_recorded,
        Some(false)
    );
    assert_eq!(f.tool("ok").await.metadata.state, State::Completed);
    f.close().await;
}

#[tokio::test]
async fn a3_failures_use_current_response_or_notice_never_an_earlier_turn() {
    let mut f = Fixture::new().await;
    f.start().await;
    f.provider(
        "t1",
        ProviderEvent::ResponseFinished {
            response: response(vec![message("first")], "first"),
        },
    )
    .await;
    let first = f.assistant("t1").await;
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
        ProviderEvent::RequestFailed {
            code: "PRIVATE_CODE_CANARY".into(),
            message: "PRIVATE_FAILURE_CANARY".into(),
            upstream_outcome: crate::UpstreamOutcome::Unknown,
        },
    )
    .await;
    assert_eq!(f.assistant("t1").await.metadata.state, State::Completed);
    f.provider(
        "t2",
        ProviderEvent::ResponseStarted {
            response_id: "repeated".into(),
        },
    )
    .await;
    let second = f.assistant("t2").await;
    assert_ne!(first.id, second.id);
    f.provider(
        "t1",
        ProviderEvent::SessionClosed {
            reason: "PRIVATE_CLOSE_CANARY".into(),
        },
    )
    .await;
    assert!(!f.assistant("t1").await.metadata.closed);
    assert!(!f.assistant("t2").await.metadata.closed);
    f.provider(
        "t2",
        ProviderEvent::ResponseStatus {
            response_id: "repeated".into(),
            status: "in_progress".into(),
        },
    )
    .await;
    f.provider("t2", delta(0, None, Some(0), DeltaKind::Text, "partial"))
        .await;
    f.provider(
        "t2",
        ProviderEvent::RequestFailed {
            code: "transport_error".into(),
            message: "PRIVATE_FAILURE_CANARY".into(),
            upstream_outcome: crate::UpstreamOutcome::Unknown,
        },
    )
    .await;
    assert_eq!(f.assistant("t2").await.metadata.state, State::Failed);
    f.provider(
        "t2",
        ProviderEvent::SessionClosed {
            reason: "PRIVATE_CLOSE_CANARY".into(),
        },
    )
    .await;
    assert!(f.assistant("t2").await.metadata.closed);
    f.provider(
        "t2",
        ProviderEvent::ProviderExtension {
            event_type: "PRIVATE_EXTENSION_CANARY".into(),
            payload: json!({"private":"PRIVATE_EXTENSION_CANARY"}),
        },
    )
    .await;
    let all = f.visible_and_metadata().await;
    for canary in [
        "PRIVATE_CODE_CANARY",
        "PRIVATE_FAILURE_CANARY",
        "PRIVATE_CLOSE_CANARY",
        "PRIVATE_EXTENSION_CANARY",
    ] {
        assert!(!all.contains(canary));
    }
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM conversation_entries WHERE kind='notice'")
            .fetch_one(&mut f.sql)
            .await
            .unwrap();
    assert_eq!(count, 3);
    f.close().await;
}

#[tokio::test]
async fn a3_completion_cancellation_failure_and_interruption_keep_committed_partial() {
    for (outcome, expected) in [
        (RunOutcome::Completed, State::Unknown),
        (RunOutcome::CancelledLocally, State::Cancelled),
        (
            RunOutcome::Failed {
                code: "PRIVATE_CODE_CANARY".into(),
            },
            State::Failed,
        ),
    ] {
        for missing_final in [false, true] {
            let mut f = Fixture::new().await;
            f.start().await;
            f.provider(
                "t1",
                delta(0, None, Some(0), DeltaKind::Text, "committed partial"),
            )
            .await;
            let entry = f.assistant("t1").await;
            let before = f.fields(entry.id).await;
            if !missing_final {
                f.runtime(
                    None,
                    RunEvent::RunFinished {
                        outcome: outcome.clone(),
                        summary: summary(),
                    },
                )
                .await;
            }
            f.append(AppendRunRecord::Result(RunResult {
                run_id: f.run.as_str().into(),
                session_id: None,
                outcome: outcome.clone(),
                summary: summary(),
                last_response: Some(response(vec![message("DO NOT ADD")], "DO NOT ADD")),
                events_complete: !missing_final,
                sink_error: if missing_final {
                    Some(crate::run::RunSinkError::Closed)
                } else {
                    None
                },
            }))
            .await;
            assert_eq!(f.assistant("t1").await.metadata.state, expected);
            assert_eq!(f.fields(entry.id).await, before);
            let header = rows::block(&mut f.sql, &f.run, f.sequence + 1)
                .await
                .unwrap();
            assert!(header.result_recorded);
            assert_eq!(header.events_complete, Some(!missing_final));
            assert!(!f.dump().await.join("").contains("PRIVATE_CODE_CANARY"));
            f.close().await;
        }
    }
    let mut f = Fixture::new().await;
    f.start().await;
    f.provider(
        "t1",
        delta(0, None, Some(0), DeltaKind::Text, "committed partial"),
    )
    .await;
    let entry = f.assistant("t1").await;
    let before = f.fields(entry.id).await;
    f.stored_event(
        "run.interrupted",
        json!({"run_id":f.run,"reason":"process_restart"}),
        true,
    )
    .await;
    assert_eq!(f.assistant("t1").await.metadata.state, State::Interrupted);
    assert_eq!(f.fields(entry.id).await, before);
    f.close().await;
}
