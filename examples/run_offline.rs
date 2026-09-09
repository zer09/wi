//! Independent, in-process provider. No credentials or network are used.
use async_trait::async_trait;
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;
use wi::{
    run::{RunOutcome, RunRequest, run},
    tools::{AddNumbers, ToolRegistry},
    *,
};

#[derive(Default)]
struct Script {
    opens: AtomicUsize,
    closes: AtomicUsize,
    inputs: Mutex<Vec<Vec<InputItem>>>,
}
struct Control {
    script: Arc<Script>,
    sender: tokio::sync::mpsc::UnboundedSender<EventEnvelope>,
}
#[async_trait]
impl SessionControl for Control {
    async fn generate(&self, input: Vec<InputItem>) -> Result<RequestReceipt> {
        let mut inputs = self.script.inputs.lock().unwrap();
        inputs.push(input);
        let turn = inputs.len();
        let output = match turn {
            1 => vec![call("first-call", 17, 25)],
            2 => vec![call("second-call", 42, 8)],
            3 => vec![OutputItem {
                id: Some("final-message".into()),
                kind: ItemKind::Message,
                native_type: "independent-text".into(),
                function_call: None,
                native: json!({"script_words": "50"}),
            }],
            _ => panic!("unexpected extra generation"),
        };
        let request_id = format!("request-{turn}");
        self.sender
            .send(EventEnvelope {
                schema_version: 1,
                sequence: turn as u64,
                event_id: format!("event-{turn}"),
                session_id: "offline-session".into(),
                request_id: Some(request_id.clone()),
                provider: "offline-script".into(),
                provider_sequence: None,
                event: ProviderEvent::ResponseFinished {
                    response: ModelResponse {
                        id: format!("response-{turn}"),
                        model: None,
                        outcome: ResponseOutcome::Completed,
                        output,
                        text: if turn == 3 {
                            "50".into()
                        } else {
                            String::new()
                        },
                        usage: None,
                        native: json!({"script_step": turn}),
                        output_provenance: OutputProvenance::NativeTerminal,
                    },
                },
            })
            .unwrap();
        Ok(RequestReceipt { request_id })
    }
    fn close(&self) {
        self.script.closes.fetch_add(1, Ordering::SeqCst);
    }
}
struct OfflineProvider(Arc<Script>);
#[async_trait]
impl Provider for OfflineProvider {
    fn id(&self) -> &'static str {
        "offline-script"
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let yes = Capability {
            implemented: true,
            verification: "in-process only".into(),
        };
        ProviderCapabilities {
            websocket: yes.clone(),
            sse: yes.clone(),
            continuation: yes.clone(),
            function_tools: yes,
            advanced: vec![],
        }
    }
    async fn open_session(&self, options: SessionOptions) -> Result<ProviderSession> {
        self.0.opens.fetch_add(1, Ordering::SeqCst);
        assert_eq!(options.tools.len(), 1);
        assert_eq!(options.tools[0].name, "add_numbers");
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        Ok(ProviderSession {
            id: "offline-session".into(),
            control: Arc::new(Control {
                script: self.0.clone(),
                sender,
            }),
            events: Box::pin(async_stream::stream! {
                while let Some(event) = receiver.recv().await { yield event; }
            }),
        })
    }
}
fn call(id: &str, a: i64, b: i64) -> OutputItem {
    OutputItem {
        id: Some(format!("item-{id}")),
        kind: ItemKind::FunctionCall,
        native_type: "independent-add".into(),
        function_call: Some(FunctionCall {
            call_id: id.into(),
            name: "add_numbers".into(),
            arguments: json!({"a": a, "b": b}).to_string(),
            origin: CallOrigin::Direct,
            namespace: None,
            complete: true,
        }),
        native: json!({"script_operands": [a, b]}),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let script = Arc::new(Script::default());
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(OfflineProvider(script.clone())))?;
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(AddNumbers))?;
    let result = run(
        &gateway,
        RunRequest {
            provider_id: "offline-script".into(),
            options: SessionOptions::new("script"),
            prompt: "Add 17 and 25, then add 8.".into(),
            limits: Default::default(),
        },
        &tools,
        CancellationToken::new(),
        |event| {
            if let Some(session_id) = &event.session_id {
                assert_eq!(session_id, "offline-session");
            }
            Ok(())
        },
    )
    .await?;
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(result.events_complete);
    assert_eq!(result.last_response.as_ref().unwrap().text, "50");
    assert_eq!(result.summary.model_requests_attempted, 3);
    assert_eq!(result.summary.model_requests_admitted, 3);
    assert_eq!(result.summary.new_tool_dispatches, 2);
    assert_eq!(result.summary.tool_results_prepared, 2);
    assert_eq!(script.opens.load(Ordering::SeqCst), 1);
    assert_eq!(script.closes.load(Ordering::SeqCst), 1);
    assert_eq!(
        serde_json::to_value(&*script.inputs.lock().unwrap()).unwrap(),
        json!([
            [{"kind":"user","text":"Add 17 and 25, then add 8."}],
            [{"kind":"tool_result","call_id":"first-call","output":"{\"sum\":42}"}],
            [{"kind":"tool_result","call_id":"second-call","output":"{\"sum\":50}"}]
        ])
    );
    println!(
        "17 + 25 = 42\n42 + 8 = 50\nCompleted: 50 (1 session, 3 model requests, 2 tool executions; offline)"
    );
    Ok(())
}
