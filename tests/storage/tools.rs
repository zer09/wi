use super::{
    capture::input,
    history::response,
    recording::{append, result, runtime, session, turn_finished, value},
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use wi::{
    CallOrigin, FunctionCall, GatewayError, InputItem, ItemKind, ModelResponse, OutputItem,
    ToolDefinition,
    run::{RunEvent, RunOutcome, RunSummary},
    storage::{AppendRunRecord, OperationId, RecordedRunInput, RunId, SessionStore},
    tools::{Tool, ToolExecutionEvent, ToolRegistry},
};

#[derive(Clone, Copy)]
pub(super) enum Mode {
    Success,
    Failure,
    Large,
}
struct SyntheticTool {
    mode: Mode,
    executions: Arc<AtomicUsize>,
}
#[async_trait]
impl Tool for SyntheticTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "synthetic".into(),
            description: "Pure synthetic test tool".into(),
            parameters: json!({"type":"object"}),
            strict: false,
        }
    }
    fn validate(&self, arguments: &Value) -> wi::Result<()> {
        if arguments.is_object() {
            Ok(())
        } else {
            Err(GatewayError::InvalidToolArguments)
        }
    }
    async fn execute(&self, _: Value) -> wi::Result<Value> {
        self.executions.fetch_add(1, Ordering::SeqCst);
        match self.mode {
            Mode::Success => Ok(json!({"value":"canary\r\n雪\u{0000}\\n  "})),
            Mode::Failure => Err(GatewayError::ToolFailed),
            Mode::Large => Ok(json!({"large":"x".repeat(65537)})),
        }
    }
}

pub(super) fn registry(mode: Mode) -> (ToolRegistry, Arc<AtomicUsize>) {
    let executions = Arc::new(AtomicUsize::new(0));
    let mut tools = ToolRegistry::new();
    tools
        .register(Arc::new(SyntheticTool {
            mode,
            executions: executions.clone(),
        }))
        .unwrap();
    (tools, executions)
}

pub(super) fn with_tools(tools: &ToolRegistry) -> RecordedRunInput {
    let original = input();
    RecordedRunInput::new(
        original.user_text().into(),
        original.prepared_request().clone(),
        tools.definitions(),
        vec![],
        vec![],
        None,
    )
    .unwrap()
}

pub(super) fn call_response(call: &str) -> ModelResponse {
    let mut response = response();
    let call = FunctionCall {
        call_id: call.into(),
        name: "synthetic".into(),
        arguments: "{}".into(),
        origin: CallOrigin::Direct,
        namespace: None,
        complete: true,
    };
    response.output = vec![OutputItem {
        id: Some("item".into()),
        kind: ItemKind::FunctionCall,
        native_type: "function_call".into(),
        native: json!({"type":"function_call","call_id":call.call_id,"name":call.name,"arguments":"{}"}),
        function_call: Some(call),
    }];
    response.native["output"] = json!([response.output[0].native]);
    response
}

pub(super) async fn execute(
    tools: &mut ToolRegistry,
    call: &str,
) -> (Vec<ToolExecutionEvent>, String, bool) {
    let mut events = Vec::new();
    let results = tools
        .execute_response(&call_response(call), |event| events.push(event))
        .await
        .unwrap();
    let InputItem::ToolResult { output, .. } = &results[0] else {
        panic!("wrong result");
    };
    let is_error = match events.last().unwrap() {
        ToolExecutionEvent::ToolExecutionFinished { is_error, .. } => *is_error,
        _ => panic!("missing finish"),
    };
    (events, output.clone(), is_error)
}

pub(super) fn tool_event(run: &RunId, seq: u64, event: ToolExecutionEvent) -> AppendRunRecord {
    AppendRunRecord::Runtime(runtime(run, seq, RunEvent::ToolEvent { event }))
}

#[tokio::test]
async fn p1a14_real_registry_success_failure_limit_and_both_recording_orders() {
    for mode in [Mode::Success, Mode::Failure, Mode::Large] {
        for output_first in [false, true] {
            let (_fixture, store, handle, run) = session().await;
            let (mut tools, executions) = registry(mode);
            handle
                .accept_run(OperationId::new(), run.clone(), with_tools(&tools))
                .await
                .unwrap();
            let (events, output, is_error) = execute(&mut tools, "call").await;
            match mode {
                Mode::Success => assert!(!is_error),
                Mode::Failure => {
                    assert!(is_error);
                    assert_eq!(output, "{\"error\":{\"code\":\"gateway_error\"}}");
                }
                Mode::Large => {
                    assert!(is_error);
                    assert_eq!(output, "{\"error\":{\"code\":\"tool_output_limit\"}}");
                }
            }
            append(
                &handle,
                &run,
                vec![
                    AppendRunRecord::Runtime(runtime(&run, 1, RunEvent::RunStarted)),
                    AppendRunRecord::Runtime(runtime(&run, 2, RunEvent::TurnStarted { number: 1 })),
                    tool_event(&run, 3, events[0].clone()),
                ],
            )
            .await;
            let started = handle
                .tool_result(run.clone(), "call".into())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(started.started_sequence(), 5);
            assert_eq!(started.finished_sequence(), None);
            assert_eq!(started.output(), None);
            assert_eq!(started.is_error(), None);
            let finish = tool_event(&run, 4, events[1].clone());
            let actual_output = AppendRunRecord::ToolResult {
                request_id: Some("original request".into()),
                call_id: "call".into(),
                output: output.clone(),
                is_error,
            };
            let (first, second) = if output_first {
                (actual_output, finish)
            } else {
                (finish, actual_output)
            };
            append(&handle, &run, vec![first]).await;
            let partial = handle
                .tool_result(run.clone(), "call".into())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                partial.output(),
                if output_first {
                    Some(output.as_str())
                } else {
                    None
                }
            );
            assert_eq!(partial.finished_sequence().is_some(), !output_first);
            append(
                &handle,
                &run,
                vec![
                    second,
                    AppendRunRecord::Runtime(runtime(&run, 5, turn_finished(1))),
                    AppendRunRecord::Runtime(runtime(
                        &run,
                        6,
                        RunEvent::RunFinished {
                            outcome: RunOutcome::Completed,
                            summary: RunSummary::default(),
                        },
                    )),
                    AppendRunRecord::Result(result(&run, RunOutcome::Completed)),
                ],
            )
            .await;
            let recorded = handle
                .tool_result(run.clone(), "call".into())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(recorded.output(), Some(output.as_str()));
            assert_eq!(recorded.is_error(), Some(is_error));
            assert!(recorded.finished_sequence().is_some());
            assert!(recorded.result_sequence().is_some());
            assert!(!format!("{recorded:?}").contains("canary"));
            assert_eq!(executions.load(Ordering::SeqCst), 1);
            store.close().await.unwrap();
        }
    }
}

#[tokio::test]
async fn p1a14_mismatch_duplicate_missing_output_and_completed_guard() {
    for failed in [false, true] {
        let (_fixture, store, handle, run) = session().await;
        handle
            .accept_run(OperationId::new(), run.clone(), input())
            .await
            .unwrap();
        let start = ToolExecutionEvent::ToolExecutionStarted {
            call_id: "call".into(),
            tool_name: "synthetic".into(),
        };
        append(
            &handle,
            &run,
            vec![
                AppendRunRecord::Runtime(runtime(&run, 1, RunEvent::RunStarted)),
                AppendRunRecord::Runtime(runtime(&run, 2, RunEvent::TurnStarted { number: 1 })),
                tool_event(&run, 3, start.clone()),
            ],
        )
        .await;
        for bad in [
            AppendRunRecord::ToolResult {
                request_id: Some("wrong".into()),
                call_id: "call".into(),
                output: "exact".into(),
                is_error: false,
            },
            AppendRunRecord::ToolResult {
                request_id: Some("original request".into()),
                call_id: "unknown".into(),
                output: "exact".into(),
                is_error: false,
            },
            tool_event(
                &run,
                4,
                ToolExecutionEvent::ToolExecutionFinished {
                    call_id: "call".into(),
                    tool_name: "wrong".into(),
                    is_error: false,
                },
            ),
            tool_event(&run, 4, start),
            tool_event(
                &run,
                4,
                ToolExecutionEvent::ToolResultReused {
                    call_id: "call".into(),
                    tool_name: "synthetic".into(),
                },
            ),
        ] {
            assert!(
                handle
                    .append_run_records(OperationId::new(), run.clone(), vec![bad])
                    .await
                    .is_err()
            );
        }
        let finish = tool_event(
            &run,
            4,
            ToolExecutionEvent::ToolExecutionFinished {
                call_id: "call".into(),
                tool_name: "synthetic".into(),
                is_error: true,
            },
        );
        let mut wrong_request = match finish.clone() {
            AppendRunRecord::Runtime(event) => event,
            _ => unreachable!(),
        };
        wrong_request.request_id = None;
        assert!(
            handle
                .append_run_records(
                    OperationId::new(),
                    run.clone(),
                    vec![AppendRunRecord::Runtime(wrong_request)]
                )
                .await
                .is_err()
        );
        append(&handle, &run, vec![finish.clone()]).await;
        assert!(
            handle
                .append_run_records(OperationId::new(), run.clone(), vec![finish])
                .await
                .is_err()
        );
        assert!(
            handle
                .append_run_records(
                    OperationId::new(),
                    run.clone(),
                    vec![AppendRunRecord::ToolResult {
                        request_id: Some("original request".into()),
                        call_id: "call".into(),
                        output: "exact opaque\n雪\0".into(),
                        is_error: false
                    }]
                )
                .await
                .is_err()
        );
        append(
            &handle,
            &run,
            vec![AppendRunRecord::Runtime(runtime(&run, 5, turn_finished(1)))],
        )
        .await;
        for terminal in [
            AppendRunRecord::Result(result(&run, RunOutcome::Completed)),
            AppendRunRecord::Runtime(runtime(
                &run,
                6,
                RunEvent::RunFinished {
                    outcome: RunOutcome::Completed,
                    summary: RunSummary::default(),
                },
            )),
        ] {
            assert!(
                handle
                    .append_run_records(OperationId::new(), run.clone(), vec![terminal])
                    .await
                    .is_err()
            );
            assert_eq!(handle.manifest().await.unwrap().head_sequence(), 7);
        }
        let outcome = if failed {
            RunOutcome::Failed {
                code: "synthetic".into(),
            }
        } else {
            RunOutcome::CancelledLocally
        };
        append(
            &handle,
            &run,
            vec![AppendRunRecord::Result(result(&run, outcome))],
        )
        .await;
        let missing = handle
            .tool_result(run.clone(), "call".into())
            .await
            .unwrap()
            .unwrap();
        assert!(missing.finished_sequence().is_some());
        assert!(missing.result_sequence().is_none());
        assert_eq!(missing.output(), None);
        assert_eq!(missing.is_error(), Some(true));
        assert!(
            handle
                .tool_result(run, "absent".into())
                .await
                .unwrap()
                .is_none()
        );
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1a15_saved_reuse_scoped_call_ids_exact_bytes_and_zero_storage_execution() {
    let (fixture, store, handle, first_run) = session().await;
    let (registry, executions) = registry(Mode::Success);
    for run in [first_run.clone(), RunId::new()] {
        let mut tools = registry.fresh_scope();
        handle
            .accept_run(OperationId::new(), run.clone(), with_tools(&tools))
            .await
            .unwrap();
        let (events, output, is_error) = execute(&mut tools, "same-call").await;
        let output_record = AppendRunRecord::ToolResult {
            request_id: Some("original request".into()),
            call_id: "same-call".into(),
            output,
            is_error,
        };
        append(
            &handle,
            &run,
            vec![
                AppendRunRecord::Runtime(runtime(&run, 1, RunEvent::RunStarted)),
                AppendRunRecord::Runtime(runtime(&run, 2, RunEvent::TurnStarted { number: 1 })),
                tool_event(&run, 3, events[0].clone()),
                output_record.clone(),
            ],
        )
        .await;
        // A finish that disagrees with an already saved output must also roll back.
        assert!(
            handle
                .append_run_records(
                    OperationId::new(),
                    run.clone(),
                    vec![tool_event(
                        &run,
                        4,
                        ToolExecutionEvent::ToolExecutionFinished {
                            call_id: "same-call".into(),
                            tool_name: "synthetic".into(),
                            is_error: true
                        }
                    )]
                )
                .await
                .is_err()
        );
        assert!(
            handle
                .append_run_records(OperationId::new(), run.clone(), vec![output_record])
                .await
                .is_err()
        );
        append(&handle, &run, vec![tool_event(&run, 4, events[1].clone())]).await;
        let before = handle
            .tool_result(run.clone(), "same-call".into())
            .await
            .unwrap()
            .unwrap();
        let mut reuse_events = Vec::new();
        let reused = tools
            .execute_response(&call_response("same-call"), |e| reuse_events.push(e))
            .await
            .unwrap();
        let InputItem::ToolResult { output, .. } = &reused[0] else {
            panic!("wrong result");
        };
        assert_eq!(Some(output.as_str()), before.output());
        assert_eq!(reuse_events.len(), 1);
        assert!(matches!(
            reuse_events[0],
            ToolExecutionEvent::ToolResultReused { .. }
        ));
        append(
            &handle,
            &run,
            vec![
                AppendRunRecord::Runtime(runtime(&run, 5, turn_finished(1))),
                AppendRunRecord::Runtime(runtime(&run, 6, RunEvent::TurnStarted { number: 2 })),
            ],
        )
        .await;
        let mut event = runtime(
            &run,
            7,
            RunEvent::ToolEvent {
                event: reuse_events.remove(0),
            },
        );
        event.turn_id = Some("turn-2".into());
        event.request_id = Some("subsequent reuse request".into());
        let operation = OperationId::new();
        let records = vec![AppendRunRecord::Runtime(event.clone())];
        let receipt = handle
            .append_run_records(operation.clone(), run.clone(), records.clone())
            .await
            .unwrap();
        assert_eq!(
            handle
                .append_run_records(operation, run.clone(), records)
                .await
                .unwrap()
                .receipt(),
            receipt.receipt()
        );
        assert_eq!(
            value(&before),
            value(
                &handle
                    .tool_result(run.clone(), "same-call".into())
                    .await
                    .unwrap()
                    .unwrap()
            )
        );
        event.sequence = 8;
        event.event_id = uuid::Uuid::new_v4().to_string();
        event.event = RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolResultReused {
                call_id: "same-call".into(),
                tool_name: "wrong".into(),
            },
        };
        assert!(
            handle
                .append_run_records(
                    OperationId::new(),
                    run.clone(),
                    vec![AppendRunRecord::Runtime(event)]
                )
                .await
                .is_err()
        );
        append(
            &handle,
            &run,
            vec![AppendRunRecord::Result(result(&run, RunOutcome::Completed))],
        )
        .await;
    }
    assert_eq!(executions.load(Ordering::SeqCst), 2);
    store.close().await.unwrap();
    let reopened = SessionStore::open(fixture.root.clone()).await.unwrap();
    let handle = reopened
        .open_session(handle.session_id().clone())
        .await
        .unwrap();
    assert!(
        handle
            .tool_result(first_run, "same-call".into())
            .await
            .unwrap()
            .unwrap()
            .output()
            .is_some()
    );
    assert_eq!(executions.load(Ordering::SeqCst), 2);
    reopened.close().await.unwrap();
}
