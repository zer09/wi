use super::*;
use crate::{
    CallOrigin, DeltaKind, EventEnvelope, FunctionCall, ItemKind, ModelResponse, OutputItem,
    OutputProvenance, ProviderEvent, ReplayIdentity, ResponseOutcome, SessionOptions, Usage,
    run::{RunEvent, RunEventEnvelope, RunRequest},
    storage::{
        AppendRunRecord, CreateSession, RecordedProviderBinding, RecordedRunInput, SessionStore,
        StoredEvent, StoredEventId,
    },
    tools::ToolExecutionEvent,
};
use serde_json::{Value, json};

const PRIVATE: &str = "PRIVATE_NATIVE_CANARY";
const PROVIDER_SESSION: &str = "PRIVATE_PROVIDER_SESSION";
const TEXT: &str = "visible 雪\r\nline\n\u{1b}[31m";
const LARGE: u64 = (1 << 53) + 1;

fn value(item: &impl Serialize) -> Value {
    serde_json::to_value(item).unwrap()
}
fn message() -> OutputItem {
    OutputItem {
        id: Some("item-visible".into()),
        kind: ItemKind::Message,
        native_type: PRIVATE.into(),
        function_call: None,
        native: json!({"content":[{"type":"output_text", "text":TEXT, "annotations":[{"url":PRIVATE}], "signature":PRIVATE},
            {"type":"refusal", "refusal":"visible refusal"}, {"type":"unknown", "text":PRIVATE}],
            "encrypted_content":PRIVATE, "unknown":PRIVATE}),
    }
}
fn response() -> ModelResponse {
    ModelResponse {
        id: "response-visible".into(),
        model: Some("model".into()),
        outcome: ResponseOutcome::Completed,
        output_provenance: OutputProvenance::ValidatedOutputItemDone,
        output: vec![message()],
        text: TEXT.into(),
        usage: Some(Usage {
            input_tokens: LARGE,
            output_tokens: u64::MAX,
            total_tokens: u64::MAX,
            cached_input_tokens: Some(LARGE),
            reasoning_tokens: None,
        }),
        native: json!({"secret":PRIVATE}),
    }
}
fn runtime(run: &RunId, sequence: u64, mut event: RunEvent) -> RunEventEnvelope {
    if let RunEvent::ProviderEvent { event } = &mut event {
        event.sequence = sequence;
    }
    RunEventEnvelope {
        schema_version: 2,
        sequence,
        event_id: StoredEventId::new().to_string(),
        run_id: run.to_string(),
        turn_id: if matches!(event, RunEvent::RunStarted | RunEvent::RunFinished { .. }) {
            None
        } else {
            Some("turn-visible".into())
        },
        session_id: if matches!(event, RunEvent::RunStarted) {
            None
        } else {
            Some(PROVIDER_SESSION.into())
        },
        request_id: if matches!(event, RunEvent::RunStarted | RunEvent::TurnStarted { .. }) {
            None
        } else {
            Some("request-visible".into())
        },
        event,
    }
}
fn provider(event: ProviderEvent) -> RunEvent {
    RunEvent::ProviderEvent {
        event: Box::new(EventEnvelope {
            schema_version: 1,
            sequence: LARGE,
            event_id: PRIVATE.into(),
            session_id: PROVIDER_SESSION.into(),
            request_id: Some("request-visible".into()),
            provider: "synthetic".into(),
            provider_sequence: Some(LARGE),
            event,
        }),
    }
}
fn stored_runtime(run: &RunId, event: RunEvent) -> StoredEvent {
    serde_json::from_value(json!({"schema_version":1, "application_session_id":ApplicationSessionId::new(),
        "sequence":LARGE, "event_id":StoredEventId::new(), "created_at_ms":i64::MAX,
        "event_version":1, "run_id":run, "event_type":"runtime.observed", "payload":runtime(run, LARGE, event)})).unwrap()
}
fn input() -> RecordedRunInput {
    let mut options = SessionOptions::new("model");
    options.instructions = "PRIVATE_PREPARED_INSTRUCTIONS".into();
    RecordedRunInput::new(
        TEXT.into(),
        RunRequest {
            provider_id: "synthetic".into(),
            options,
            prompt: "PRIVATE_PREPARED_PROMPT".into(),
        },
        vec![],
        vec!["global:one".into(), "project:two".into()],
        vec!["project:two".into()],
        Some("project:AGENTS.md".into()),
    )
    .unwrap()
}

#[test]
fn native_scalar_projection_is_closed_and_preserves_bytes() {
    let item = message();
    let before = value(&item);
    let projected = value(&ItemView::from(&item));
    assert_eq!(
        projected,
        json!({"item_id":"item-visible", "kind":"message", "function_call":null,
        "content":[{"kind":"text", "text":TEXT}, {"kind":"refusal", "text":"visible refusal"}], "unsupported_content":true})
    );
    assert_eq!(value(&item), before);
    let reasoning = OutputItem {
        id: None,
        kind: ItemKind::Reasoning,
        native_type: PRIVATE.into(),
        function_call: None,
        native: json!({"summary":[{"type":"summary_text", "text":"summary\r\n雪", "signature":PRIVATE}],
            "content":[{"type":"reasoning_text", "text":"thinking"}, {"type":"summary_text", "text":"later"},
                {"type":"reasoning_text", "text":{"secret":PRIVATE}}], "encrypted_content":PRIVATE}),
    };
    let reasoning = value(&ItemView::from(&reasoning));
    assert_eq!(
        reasoning["content"],
        json!([{"kind":"reasoning_summary", "text":"summary\r\n雪"},
        {"kind":"reasoning_text", "text":"thinking"}, {"kind":"reasoning_summary", "text":"later"}])
    );
    assert_eq!(reasoning["unsupported_content"], true);
    let mut call = message();
    call.kind = ItemKind::FunctionCall;
    call.function_call = Some(FunctionCall {
        call_id: "call".into(),
        name: "display-name".into(),
        arguments: "{ \"a\":1, \"b\":2 }\n".into(),
        origin: CallOrigin::Programmatic,
        namespace: Some("display-only".into()),
        complete: false,
    });
    let function = value(&ItemView::from(&call));
    assert_eq!(
        function["function_call"]["arguments"],
        "{ \"a\":1, \"b\":2 }\n"
    );
    assert_eq!(function["function_call"]["origin"], "programmatic");
    assert_eq!(function["function_call"]["complete"], false);
    assert_eq!(function["content"], json!([]));
    for kind in [
        ItemKind::Unknown,
        ItemKind::CustomToolCall,
        ItemKind::ToolSearchCall,
        ItemKind::ToolSearchOutput,
        ItemKind::Program,
        ItemKind::ProgramOutput,
    ] {
        call.kind = kind;
        let view = value(&ItemView::from(&call));
        assert_eq!(view["unsupported_content"], true);
        assert_eq!(view["function_call"], Value::Null);
        assert_eq!(view["content"], json!([]));
        assert!(!view.to_string().contains(PRIVATE));
    }
    for native in [
        Value::Null,
        json!({}),
        json!({"content":"not-an-array"}),
        json!({"content":[null, {"type":"output_text", "text":7}]}),
    ] {
        let mut bad = item.clone();
        bad.native = native;
        assert_eq!(value(&ItemView::from(&bad))["unsupported_content"], true);
    }
    for projection in [projected, reasoning, function] {
        assert!(!projection.to_string().contains(PRIVATE));
    }
}

#[test]
fn response_outcomes_statuses_usage_and_fallback_are_safe() {
    for (reason, expected) in [
        (None, Value::Null),
        (Some("max_output_tokens"), json!("max_output_tokens")),
        (Some("content_filter"), json!("content_filter")),
        (Some(PRIVATE), json!("unknown")),
    ] {
        let mut response = response();
        response.outcome = ResponseOutcome::Incomplete {
            reason: reason.map(str::to_owned),
        };
        response.output[0].native = json!({"content":[{"type":PRIVATE}]});
        let view = value(&ResponseView::from(&response));
        assert_eq!(
            view["outcome"],
            json!({"status":"incomplete", "reason":expected})
        );
        assert_eq!(view["text"], TEXT);
        assert_eq!(view["output_provenance"], "validated_output_item_done");
        assert_eq!(view["usage"]["input_tokens"], LARGE.to_string());
        assert_eq!(view["usage"]["output_tokens"], u64::MAX.to_string());
        assert_eq!(view["usage"]["cached_input_tokens"], LARGE.to_string());
        assert!(view["usage"]["reasoning_tokens"].is_null());
        assert!(!view.to_string().contains(PRIVATE));
    }
    for status in [
        "queued",
        "in_progress",
        "completed",
        "incomplete",
        "failed",
        "cancelled",
    ] {
        assert_eq!(value(&ResponseStatus::from(status)), status);
    }
    assert_eq!(value(&ResponseStatus::from(PRIVATE)), "unknown");
    for (outcome, expected) in [
        (ResponseOutcome::Completed, "completed"),
        (ResponseOutcome::Failed, "failed"),
        (ResponseOutcome::Cancelled, "cancelled"),
    ] {
        assert_eq!(
            value(&ResponseOutcomeView::from(&outcome)),
            json!({"status":expected})
        );
    }
}

#[test]
fn provider_and_runtime_records_project_one_safe_event_at_real_sequence() {
    let run = RunId::new();
    let cases = vec![
        (RunEvent::RunStarted, "run.started"),
        (RunEvent::TurnStarted { number: LARGE }, "turn.started"),
        (
            RunEvent::TurnFinished {
                number: LARGE,
                response_id: Some("response-visible".into()),
                outcome: TurnOutcome::Stopped {
                    reason: RunOutcome::Failed {
                        code: PRIVATE.into(),
                    },
                },
                upstream_outcome: Some(UpstreamOutcome::Unknown),
            },
            "turn.finished",
        ),
        (
            RunEvent::RunFinished {
                outcome: RunOutcome::Failed {
                    code: PRIVATE.into(),
                },
                summary: RunSummary::default(),
            },
            "run.finished",
        ),
        (
            provider(ProviderEvent::ResponseStarted {
                response_id: "response-visible".into(),
            }),
            "response.started",
        ),
        (
            provider(ProviderEvent::ResponseStatus {
                response_id: "response-visible".into(),
                status: PRIVATE.into(),
            }),
            "response.status",
        ),
        (
            provider(ProviderEvent::OutputItemStarted {
                response_id: "response-visible".into(),
                output_index: LARGE,
                item: message(),
            }),
            "response.item.started",
        ),
        (
            provider(ProviderEvent::OutputItemFinished {
                response_id: "response-visible".into(),
                output_index: LARGE,
                item: message(),
            }),
            "response.item.finished",
        ),
        (
            provider(ProviderEvent::ResponseFinished {
                response: response(),
            }),
            "response.finished",
        ),
        (
            provider(ProviderEvent::RequestFailed {
                code: PRIVATE.into(),
                message: PRIVATE.into(),
                upstream_outcome: UpstreamOutcome::Unknown,
            }),
            "response.failed",
        ),
        (
            provider(ProviderEvent::SessionClosed {
                reason: PRIVATE.into(),
            }),
            "response.closed",
        ),
        (
            provider(ProviderEvent::ProviderExtension {
                event_type: PRIVATE.into(),
                payload: json!({"secret":PRIVATE}),
            }),
            "checkpoint",
        ),
        (
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionStarted {
                    call_id: "call".into(),
                    tool_name: "add_numbers".into(),
                },
            },
            "tool.started",
        ),
        (
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionFinished {
                    call_id: "call".into(),
                    tool_name: "add_numbers".into(),
                    is_error: false,
                },
            },
            "tool.finished",
        ),
        (
            RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolResultReused {
                    call_id: "call".into(),
                    tool_name: "add_numbers".into(),
                },
            },
            "tool.reused",
        ),
    ];
    for (event, kind) in cases {
        let source = stored_runtime(&run, event);
        let before = value(&source);
        let projection = value(&EventView::from(&source));
        assert_eq!(projection["kind"], kind);
        assert_eq!(projection["api_version"], 1);
        assert_eq!(projection["sequence"], LARGE.to_string());
        assert_eq!(projection["created_at_ms"], i64::MAX.to_string());
        assert_eq!(projection["event_id"], source.event_id().as_str());
        assert_eq!(
            projection["session_id"],
            source.application_session_id().as_str()
        );
        assert!(!projection.to_string().contains(PRIVATE));
        assert!(!projection.to_string().contains(PROVIDER_SESSION));
        assert_eq!(value(&source), before);
        match kind {
            "checkpoint" | "run.started" | "response.closed" => {
                assert_eq!(projection["data"], json!({}))
            }
            "tool.started" | "tool.reused" => assert!(projection["data"].get("is_error").is_none()),
            "tool.finished" => assert_eq!(projection["data"]["is_error"], false),
            "turn.finished" => assert_eq!(
                projection["data"]["outcome"]["reason"]["code"],
                "upstream_error"
            ),
            "response.failed" => assert_eq!(projection["data"]["upstream_outcome"], "unknown"),
            _ => (),
        }
    }
    for kind in [
        DeltaKind::Text,
        DeltaKind::Refusal,
        DeltaKind::ReasoningSummary,
        DeltaKind::ReasoningText,
        DeltaKind::FunctionArguments,
        DeltaKind::CustomToolInput,
    ] {
        let source = stored_runtime(
            &run,
            provider(ProviderEvent::OutputItemUpdated {
                response_id: "response-visible".into(),
                item_id: "item".into(),
                output_index: LARGE,
                content_index: Some(LARGE),
                summary_index: Some(u64::MAX),
                kind,
                delta: TEXT.into(),
            }),
        );
        let projection = value(&EventView::from(&source));
        assert_eq!(projection["data"]["delta"], TEXT);
        assert_eq!(projection["data"]["kind"], value(&kind));
        assert_eq!(projection["data"]["output_index"], LARGE.to_string());
        assert_eq!(projection["data"]["summary_index"], u64::MAX.to_string());
    }
}

#[test]
fn safe_code_allowlist_and_summary_result_do_not_serialize_native_state() {
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
        assert_eq!(value(&safe_code(code)), code);
    }
    for code in [
        PRIVATE,
        "",
        "UNAUTHORIZED",
        "unauthorized\n",
        "session_open",
        "provider_eof",
    ] {
        assert_eq!(value(&safe_code(code)), "upstream_error");
    }
    let summary = RunSummary {
        turns_started: LARGE,
        turns_finished: LARGE,
        model_requests_attempted: LARGE,
        model_requests_admitted: LARGE,
        new_tool_dispatches: LARGE,
        tool_results_prepared: LARGE,
        reused_results: u64::MAX,
        last_request_id: Some("request-visible".into()),
        last_upstream_outcome: Some(UpstreamOutcome::NotSubmitted),
    };
    for sink in [
        RunSinkError::Full,
        RunSinkError::Closed,
        RunSinkError::Failed,
    ] {
        let result = RunResult {
            run_id: RunId::new().to_string(),
            session_id: Some(PROVIDER_SESSION.into()),
            outcome: RunOutcome::Failed {
                code: PRIVATE.into(),
            },
            summary: summary.clone(),
            last_response: Some(response()),
            events_complete: false,
            sink_error: Some(sink),
        };
        let view = value(&ResultView::from(&result));
        assert_eq!(view["outcome"]["code"], "upstream_error");
        assert_eq!(view["sink_error"], value(&sink));
        assert_eq!(view["summary"]["reused_results"], u64::MAX.to_string());
        for counter in [
            "turns_started",
            "turns_finished",
            "model_requests_attempted",
            "model_requests_admitted",
            "new_tool_dispatches",
            "tool_results_prepared",
        ] {
            assert_eq!(view["summary"][counter], LARGE.to_string());
        }
        for forbidden in [
            PRIVATE,
            PROVIDER_SESSION,
            "last_response",
            "response-visible",
            TEXT,
        ] {
            assert!(!view.to_string().contains(forbidden));
        }
    }
}

#[tokio::test]
async fn actual_history_projects_receipts_private_checkpoints_and_terminal_without_result() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("private-data-root"))
        .await
        .unwrap();
    let created = store
        .create_session(
            CreateSession::new(
                OperationId::new(),
                "\r\n雪".into(),
                Some(temp.path().to_str().unwrap().into()),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let session = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let run = RunId::new();
    let selection = crate::execution::prepare_session_replay(&session, "synthetic", "model")
        .await
        .unwrap()
        .selection();
    let digest = selection.history_digest().to_owned();
    let operation = OperationId::new();
    let accepted = session
        .accept_history_run(operation.clone(), run.clone(), input(), selection)
        .await
        .unwrap();
    let receipt = value(&ReceiptView::from(accepted.receipt()));
    assert_eq!(receipt["first_sequence"], "2");
    assert_eq!(receipt["last_sequence"], "3");
    assert_eq!(
        value(&TaskAcceptedView::new(&accepted, vec![]))["notices"],
        json!([])
    );
    assert_eq!(
        value(&OperationView::from(
            &session.lookup_receipt(operation).await.unwrap().unwrap()
        ))["api_version"],
        1
    );
    assert_eq!(
        value(&RunView::from(
            &session.run_record(run.clone()).await.unwrap().unwrap()
        ))["state"],
        "accepted"
    );
    let mut records = vec![
        AppendRunRecord::Runtime(runtime(&run, 1, RunEvent::RunStarted)),
        AppendRunRecord::ProviderBinding(
            RecordedProviderBinding::new(
                run.clone(),
                PROVIDER_SESSION.into(),
                "model".into(),
                ReplayIdentity::new(
                    "synthetic".into(),
                    "private-format-canary".into(),
                    "a".repeat(64),
                )
                .unwrap(),
            )
            .unwrap(),
        ),
    ];
    let events = vec![
        RunEvent::TurnStarted { number: 1 },
        provider(ProviderEvent::OutputItemUpdated {
            response_id: "response-visible".into(),
            item_id: "item-visible".into(),
            output_index: 0,
            content_index: Some(0),
            summary_index: None,
            kind: DeltaKind::Text,
            delta: "provisional".into(),
        }),
        provider(ProviderEvent::OutputItemFinished {
            response_id: "response-visible".into(),
            output_index: 0,
            item: message(),
        }),
        provider(ProviderEvent::ProviderExtension {
            event_type: PRIVATE.into(),
            payload: json!({"private":PRIVATE}),
        }),
        provider(ProviderEvent::ResponseFinished {
            response: response(),
        }),
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted {
                call_id: "call".into(),
                tool_name: "add_numbers".into(),
            },
        },
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionFinished {
                call_id: "call".into(),
                tool_name: "add_numbers".into(),
                is_error: false,
            },
        },
    ];
    for (index, event) in events.into_iter().enumerate() {
        records.push(AppendRunRecord::Runtime(runtime(
            &run,
            index as u64 + 2,
            event,
        )));
    }
    records.push(AppendRunRecord::ToolResult {
        request_id: Some("request-visible".into()),
        call_id: "call".into(),
        output: "{\"error\":\"visible data, not failure\"}\r\n雪".into(),
        is_error: false,
    });
    records.push(AppendRunRecord::Runtime(runtime(
        &run,
        9,
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolResultReused {
                call_id: "call".into(),
                tool_name: "add_numbers".into(),
            },
        },
    )));
    records.push(AppendRunRecord::Runtime(runtime(
        &run,
        10,
        RunEvent::TurnFinished {
            number: 1,
            response_id: Some("response-visible".into()),
            outcome: TurnOutcome::ToolsPrepared,
            upstream_outcome: Some(UpstreamOutcome::TerminalReceived),
        },
    )));
    records.push(AppendRunRecord::Runtime(runtime(
        &run,
        11,
        RunEvent::RunFinished {
            outcome: RunOutcome::Completed,
            summary: RunSummary::default(),
        },
    )));
    session
        .append_run_records(OperationId::new(), run.clone(), records)
        .await
        .unwrap();
    let terminal = session.run_record(run.clone()).await.unwrap().unwrap();
    let terminal_view = value(&RunView::from(&terminal));
    assert_eq!(terminal_view["state"], "completed");
    assert_eq!(terminal_view["result_recorded"], false);
    assert!(terminal_view["terminal_sequence"].is_string());
    assert!(terminal_view["result_sequence"].is_null());
    session
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![AppendRunRecord::Result(RunResult {
                run_id: run.to_string(),
                session_id: Some(PROVIDER_SESSION.into()),
                outcome: RunOutcome::Completed,
                summary: RunSummary::default(),
                last_response: Some(response()),
                events_complete: true,
                sink_error: None,
            })],
        )
        .await
        .unwrap();
    let renamed = session
        .rename(OperationId::new(), String::new())
        .await
        .unwrap();
    let refresh = session.refresh_catalog().await.unwrap();
    assert_eq!(
        value(&RenameView::new(&renamed, refresh.into()))["catalog_refresh"],
        "updated"
    );
    assert_eq!(
        value(&RefreshView::new(
            session.session_id().clone(),
            session.refresh_catalog().await.unwrap()
        ))["disposition"],
        "unchanged"
    );
    let canonical = value(&SessionView::from(&session.manifest().await.unwrap()));
    assert_eq!(canonical["title"], "");
    assert!(canonical.get("last_run_id").is_none());
    let catalog = value(&CatalogView::from(
        &store.list_sessions(None, 32).await.unwrap(),
    ));
    assert_eq!(catalog["entries"][0]["view"], "catalog");
    assert_eq!(catalog["entries"][0]["last_run_state"], "completed");
    let page = session.history_page(0, None, 128).await.unwrap();
    let stored_before = value(&page);
    let history = value(&HistoryView::new(session.session_id().clone(), &page).unwrap());
    let events = history["events"].as_array().unwrap();
    assert_eq!(events.len(), page.records().len());
    assert_eq!(events[0]["kind"], "session.created");
    assert_eq!(events[1]["data"]["user_text"], TEXT);
    assert_eq!(events[1]["data"]["active_skills"], json!(["project:two"]));
    assert_eq!(events[2]["kind"], "checkpoint");
    assert_eq!(events[4]["kind"], "checkpoint");
    for (record, view) in page.records().iter().zip(events) {
        assert_eq!(view["sequence"], record.sequence().to_string());
        assert_eq!(view["event_id"], record.event_id().as_str());
        if view["kind"] == "checkpoint" {
            assert_eq!(view["data"], json!({}));
        }
        if view["kind"] == "tool.result" {
            assert_eq!(view["data"]["is_error"], false);
            assert!(view["data"]["output"].is_string());
        }
        if view["kind"] == "run.result" {
            assert!(view["data"].get("last_response").is_none());
        }
    }
    assert_eq!(
        history["next_after"],
        format!("{}:{}", session.session_id(), page.next_after())
    );
    assert_eq!(value(&page), stored_before);
    let run_view = value(&RunView::from(
        &session.run_record(run).await.unwrap().unwrap(),
    ));
    assert_eq!(run_view["result_recorded"], true);
    for projection in [
        history,
        run_view,
        canonical,
        catalog,
        value(&CreateView::from(&created)),
    ] {
        for forbidden in [
            PRIVATE,
            PROVIDER_SESSION,
            "PRIVATE_PREPARED",
            "private-format-canary",
            "private-data-root",
            &digest,
            &"a".repeat(64),
        ] {
            assert!(
                !projection.to_string().contains(forbidden),
                "forbidden metadata"
            );
        }
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn interruption_and_storage_errors_keep_actual_state_and_certainty() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let store = SessionStore::open(root.clone()).await.unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), String::new(), None).unwrap())
        .await
        .unwrap();
    let sid = created.session_id().clone();
    let session = store.open_session(sid.clone()).await.unwrap();
    let run = RunId::new();
    session
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    let error = session
        .accept_run(OperationId::new(), RunId::new(), input())
        .await
        .unwrap_err();
    let error = ErrorView::storage(&error);
    assert_eq!(error.status(), 409);
    assert_eq!(value(&error)["certainty"], "not_committed");
    store.close().await.unwrap();
    let error = ErrorView::storage(&session.manifest().await.unwrap_err());
    assert_eq!(error.code(), "storage.closed");
    assert_eq!(error.status(), 503);
    let store = SessionStore::open(root).await.unwrap();
    let session = store.open_session(sid).await.unwrap();
    let history = session.history_page(0, None, 32).await.unwrap();
    let last = value(&EventView::from(history.records().last().unwrap()));
    assert_eq!(last["kind"], "run.interrupted");
    assert_eq!(last["data"], json!({"reason":"process_restart"}));
    let run_view = value(&RunView::from(
        &session.run_record(run).await.unwrap().unwrap(),
    ));
    assert_eq!(run_view["state"], "interrupted");
    assert_eq!(run_view["result_recorded"], false);
    let error = ErrorView::storage(&session.history_page(u64::MAX, None, 1).await.unwrap_err());
    assert_eq!(error.status(), 400);
    assert_eq!(value(&error)["certainty"], "not_applicable");
    store.close().await.unwrap();
}

#[test]
fn settings_errors_and_real_context_notices_exclude_private_diagnostics() {
    let temp = tempfile::tempdir().unwrap();
    let mut options = SessionOptions::new("model");
    options.instructions = PRIVATE.into();
    let settings = ApiSettings::new(
        "https://example.test",
        vec![temp.path().to_owned()],
        temp.path().join("PRIVATE_SKILLS_ROOT"),
        "synthetic".into(),
        options,
        true,
    )
    .unwrap();
    let settings = value(&SettingsView::from(&settings));
    assert_eq!(settings["provider_transport"], "websocket");
    for field in [
        "instructions",
        "account",
        "global_skills_root",
        "data_root",
        "client_token_file",
    ] {
        assert!(settings.get(field).is_none());
    }
    for (error, status) in [
        (ApiError::Unauthorized, 401),
        (ApiError::OriginForbidden, 403),
        (ApiError::WorkspaceForbidden, 403),
        (ApiError::AuthorityInvalid, 421),
        (ApiError::InvalidRequest, 400),
        (ApiError::CursorInvalid, 400),
        (ApiError::BodyTooLarge, 413),
        (ApiError::UnsupportedMedia, 415),
        (ApiError::NotFound, 404),
        (ApiError::MethodNotAllowed, 405),
        (ApiError::WorkerLost, 503),
        (ApiError::Closed, 503),
    ] {
        let view = ErrorView::api(error);
        assert_eq!(view.status(), status);
        assert_eq!(value(&view)["api_version"], 1);
        assert!(value(&view)["stage"].is_null());
    }
    let gateway = ErrorView::gateway(&crate::GatewayError::Protocol(PRIVATE));
    assert_eq!(gateway.status(), 422);
    assert_eq!(gateway.code(), "protocol_error");
    assert!(!value(&gateway).to_string().contains(PRIVATE));
    let skill = temp.path().join(".agents/skills/broken");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nPRIVATE_PARSER_CANARY: [\n---\nbody",
    )
    .unwrap();
    let catalog = crate::context::discover(crate::context::ContextRoots {
        workspace: temp.path().to_owned(),
        global_skills: temp.path().join("missing"),
    })
    .unwrap();
    let notices: Vec<_> = catalog.diagnostics().iter().map(NoticeView::from).collect();
    assert!(!notices.is_empty());
    let error = crate::context::discover(crate::context::ContextRoots {
        workspace: temp.path().join("PRIVATE_MISSING_ROOT"),
        global_skills: temp.path().join("missing"),
    })
    .err()
    .unwrap();
    let error = ErrorView::context(&error, notices);
    assert_eq!(error.status(), 422);
    let view = value(&error);
    assert!(
        view["notices"][0]["kind"]
            .as_str()
            .unwrap()
            .starts_with("excluded.")
    );
    assert_eq!(view["notices"][0]["scope"], "project");
    assert!(!view.to_string().contains("PRIVATE_"));
    assert!(!view.to_string().contains(temp.path().to_str().unwrap()));
}
