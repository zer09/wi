use super::*;
use crate::{
    CallOrigin, FunctionCall, GatewayError, InputItem, ModelResponse, ResponseOutcome,
    ToolDefinition,
    tools::{Tool, ToolRegistry},
};
use async_trait::async_trait;
use std::sync::atomic::{AtomicUsize, Ordering};

pub(super) struct SyntheticTool {
    pub(super) mode: u8,
    pub(super) calls: Arc<AtomicUsize>,
}
#[async_trait]
impl Tool for SyntheticTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "synthetic".into(),
            description: "synthetic".into(),
            parameters: json!({"type":"object","properties":{},"required":[],"additionalProperties":false}),
            strict: true,
        }
    }
    fn validate(&self, _: &Value) -> crate::Result<()> {
        Ok(())
    }
    async fn execute(&self, _: Value) -> crate::Result<Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.mode {
            0 => Ok(json!({"error":{"code":"successful text 雪\0"}})),
            1 => Err(GatewayError::ToolFailed),
            _ => Ok(json!("x".repeat(70000))),
        }
    }
}
pub(super) fn response_call() -> ModelResponse {
    ModelResponse {
        output_provenance: Default::default(),
        id: "synthetic-response".into(),
        model: None,
        outcome: ResponseOutcome::Completed,
        output: vec![OutputItem {
            id: Some("synthetic-item".into()),
            kind: ItemKind::FunctionCall,
            native_type: "function_call".into(),
            function_call: Some(FunctionCall {
                call_id: "call".into(),
                name: "synthetic".into(),
                arguments: "{}".into(),
                origin: CallOrigin::Direct,
                namespace: None,
                complete: true,
            }),
            native: json!({"private":"private-native-canary"}),
        }],
        text: String::new(),
        usage: None,
        native: json!({"private":"private-native-canary"}),
    }
}

#[tokio::test]
async fn b1_actual_registry_tool_output_error_flags_pending_result_finish_and_reuse_are_exact() {
    for mode in 0..3 {
        let server = Server::new().await;
        let session = server.session().await;
        let mut writer = Writer::accept(&session, "anchor").await;
        writer.start().await;
        let calls = Arc::new(AtomicUsize::new(0));
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(SyntheticTool {
                mode,
                calls: calls.clone(),
            }))
            .unwrap();
        let mut events = Vec::new();
        let results = registry
            .execute_response(&response_call(), |event| events.push(event))
            .await
            .unwrap();
        let InputItem::ToolResult { output, .. } = &results[0] else {
            unreachable!()
        };
        let ToolExecutionEvent::ToolExecutionFinished { is_error, .. } = events[1] else {
            unreachable!()
        };
        assert_eq!(is_error, mode != 0);
        writer
            .runtime(RunEvent::ToolEvent {
                event: events[0].clone(),
            })
            .await;
        let latest = session
            .conversation_page(ConversationQuery::Latest)
            .await
            .unwrap();
        let entry = *latest.entries().last().unwrap().entry_id();
        let pending = session
            .conversation_entry(writer.run.clone(), entry)
            .await
            .unwrap();
        let body = exact(
            server.get(&addressed(&session, &writer.run, entry)),
            DisplayJson::EntryPage(&pending),
        )
        .await;
        assert_eq!(body["entry"]["result_recorded"], false);
        assert_eq!(body["entry"]["finish_recorded"], false);
        assert_eq!(body["entry"]["is_error"], Value::Null);
        writer
            .session
            .append_run_records(
                OperationId::new(),
                writer.run.clone(),
                vec![AppendRunRecord::ToolResult {
                    call_id: "call".into(),
                    request_id: Some(REQUEST.into()),
                    output: output.clone(),
                    is_error,
                }],
            )
            .await
            .unwrap();
        let result = session
            .conversation_entry(writer.run.clone(), entry)
            .await
            .unwrap();
        let body = exact(
            server.get(&addressed(&session, &writer.run, entry)),
            DisplayJson::EntryPage(&result),
        )
        .await;
        assert_eq!(body["entry"]["result_recorded"], true);
        assert_eq!(body["entry"]["finish_recorded"], false);
        assert_eq!(body["entry"]["is_error"], is_error);
        assert_eq!(body["entry"]["fields"][1]["text"], *output);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let mut reuse_events = Vec::new();
        let reused = registry
            .execute_response(&response_call(), |event| reuse_events.push(event))
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&reused).unwrap(),
            serde_json::to_value(&results).unwrap()
        );
        writer
            .runtime(RunEvent::ToolEvent {
                event: reuse_events[0].clone(),
            })
            .await;
        // The occurrence records the target's state at reuse, not at a later finish.
        writer
            .runtime(RunEvent::ToolEvent {
                event: events[1].clone(),
            })
            .await;
        let page = session
            .conversation_page(ConversationQuery::Latest)
            .await
            .unwrap();
        let before = snapshot(&server, &session).await;
        exact(server.get(&base(&session)), DisplayJson::Page(&page)).await;
        let tool = page
            .entries()
            .iter()
            .find(|e| *e.entry_id() == entry)
            .unwrap();
        let reuse = page.entries().last().unwrap();
        assert_eq!(tool.finish_recorded(), Some(true));
        assert_eq!(reuse.finish_recorded(), Some(false));
        assert_eq!(reuse.reference().unwrap().entry_id(), &entry);
        assert_eq!(reuse.is_error(), Some(is_error));
        let addressed_reuse = session
            .conversation_entry(writer.run.clone(), *reuse.entry_id())
            .await
            .unwrap();
        exact(
            server.get(&addressed(&session, &writer.run, reuse.entry_id())),
            DisplayJson::EntryPage(&addressed_reuse),
        )
        .await;
        assert_eq!(snapshot(&server, &session).await, before);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        writer.result().await;
        // A new run can use the same call ID without inheriting the old result.
        let mut next = Writer::accept(&session, "next anchor").await;
        next.start().await;
        next.runtime(RunEvent::ToolEvent {
            event: events[0].clone(),
        })
        .await;
        let page = session
            .conversation_page(ConversationQuery::Latest)
            .await
            .unwrap();
        let body = exact(server.get(&base(&session)), DisplayJson::Page(&page)).await;
        assert_eq!(
            body["entries"].as_array().unwrap().last().unwrap()["result_recorded"],
            false
        );
        server.finish().await;
    }
}

#[tokio::test]
async fn b1_empty_output_is_not_absent_output_and_finish_only_retains_uncertainty() {
    let server = Server::new().await;
    let session = server.session().await;
    let mut writer = Writer::accept(&session, "anchor").await;
    writer.start().await;
    for call in ["empty", "finish-only"] {
        writer
            .runtime(RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionStarted {
                    call_id: call.into(),
                    tool_name: "synthetic".into(),
                },
            })
            .await;
        if call == "empty" {
            writer
                .session
                .append_run_records(
                    OperationId::new(),
                    writer.run.clone(),
                    vec![AppendRunRecord::ToolResult {
                        call_id: call.into(),
                        request_id: Some(REQUEST.into()),
                        output: String::new(),
                        is_error: false,
                    }],
                )
                .await
                .unwrap();
        }
        writer
            .runtime(RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionFinished {
                    call_id: call.into(),
                    tool_name: "synthetic".into(),
                    is_error: false,
                },
            })
            .await;
    }
    let page = session
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    let body = exact(server.get(&base(&session)), DisplayJson::Page(&page)).await;
    let tools = body["entries"].as_array().unwrap();
    assert_eq!(tools[1]["result_recorded"], true);
    assert_eq!(tools[1]["fields"][1]["text"], "");
    assert_eq!(tools[2]["result_recorded"], false);
    assert_eq!(tools[2]["finish_recorded"], true);
    assert_eq!(tools[2]["fields"].as_array().unwrap().len(), 1);
    server.finish().await;
}
