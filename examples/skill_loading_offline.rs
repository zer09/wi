//! Main-file skill loading with synthetic roots and an in-process provider only.
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    fs,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio_util::sync::CancellationToken;
use wi::{
    context::{ContextRoots, discover, prepare_run_with_skill_loading},
    run::{RunEvent, RunOutcome, RunRequest, run},
    tools::{ToolExecutionEvent, ToolRegistry},
    *,
};

const BODY: &str = "  OFFLINE_SKILL_BODY\nReturn the fixture response.\r\n";
const ANSWER: &str = "Reviewed offline.";

struct Script {
    prompt: String,
    instructions: String,
    opens: AtomicUsize,
    requests: AtomicUsize,
    closes: AtomicUsize,
}
struct Control {
    script: Arc<Script>,
    sender: tokio::sync::mpsc::UnboundedSender<EventEnvelope>,
}
#[async_trait]
impl SessionControl for Control {
    async fn generate(&self, input: Vec<InputItem>) -> Result<RequestReceipt> {
        let turn = self.script.requests.fetch_add(1, Ordering::SeqCst) + 1;
        let (output, text) = match turn {
            1 => {
                assert!(
                    matches!(&input[..], [InputItem::User { text }] if text == &self.script.prompt)
                );
                (
                    vec![OutputItem {
                        id: Some("load-item".into()),
                        kind: ItemKind::FunctionCall,
                        native_type: "script-load".into(),
                        function_call: Some(FunctionCall {
                            call_id: "load-review".into(),
                            name: "load_skill".into(),
                            arguments: json!({"id":"project:review"}).to_string(),
                            origin: CallOrigin::Direct,
                            namespace: None,
                            complete: true,
                        }),
                        native: json!({"step":"load"}),
                    }],
                    "",
                )
            }
            2 => {
                let [InputItem::ToolResult { call_id, output }] = &input[..] else {
                    panic!("expected one real correlated skill result");
                };
                assert_eq!(call_id, "load-review");
                assert_eq!(
                    serde_json::from_str::<Value>(output).unwrap(),
                    json!({
                        "id":"project:review",
                        "frontmatter":{"name":"review","description":"Project review metadata"},
                        "body":BODY
                    })
                );
                (
                    vec![OutputItem {
                        id: Some("answer".into()),
                        kind: ItemKind::Message,
                        native_type: "script-answer".into(),
                        function_call: None,
                        native: json!({"answer":ANSWER}),
                    }],
                    ANSWER,
                )
            }
            _ => panic!("unexpected extra generation"),
        };
        let request_id = format!("q{turn}");
        self.sender
            .send(EventEnvelope {
                schema_version: 1,
                sequence: turn as u64,
                event_id: format!("e{turn}"),
                session_id: "skill-loading-session".into(),
                request_id: Some(request_id.clone()),
                provider: "skill-loading-script".into(),
                provider_sequence: None,
                event: ProviderEvent::ResponseFinished {
                    response: ModelResponse {
                        id: format!("r{turn}"),
                        model: None,
                        outcome: ResponseOutcome::Completed,
                        output,
                        text: text.into(),
                        usage: None,
                        native: json!({"step":turn}),
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
        "skill-loading-script"
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let yes = Capability {
            implemented: true,
            verification: "in-process script only".into(),
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
        assert_eq!(options.instructions, self.0.instructions);
        assert_eq!(options.tools.len(), 1);
        assert_eq!(options.tools[0].name, "load_skill");
        assert!(options.tools[0].strict);
        assert_eq!(
            options.tools[0].parameters,
            json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false})
        );
        let encoded_options = serde_json::to_string(&options).unwrap();
        assert!(!encoded_options.contains("OFFLINE_SKILL_BODY"));
        assert!(!encoded_options.contains("UNSELECTED_GLOBAL_BODY"));
        assert!(options.required_features.is_empty());
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        Ok(ProviderSession {
            id: "skill-loading-session".into(),
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

#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    // Context roots never come from the owner's workspace or configuration.
    let temp = tempfile::tempdir()?;
    let roots = ContextRoots {
        workspace: temp.path().join("workspace"),
        global_skills: temp.path().join("global"),
    };
    let project = roots.workspace.join(".agents/skills");
    for (root, description, body) in [
        (
            &roots.global_skills,
            "Global review metadata",
            "UNSELECTED_GLOBAL_BODY",
        ),
        (&project, "Project review metadata", BODY),
    ] {
        fs::create_dir_all(root.join("review"))?;
        fs::write(
            root.join("review/SKILL.md"),
            format!("---\nname: review\ndescription: {description}\n---\n{body}"),
        )?;
    }
    let catalog = Arc::new(discover(roots)?);
    assert!(catalog.diagnostics().is_empty());
    let mut options = SessionOptions::new("script");
    options.instructions = "Caller instructions.".into();
    let (prepared, tools) = prepare_run_with_skill_loading(
        RunRequest {
            provider_id: "skill-loading-script".into(),
            options,
            prompt: "Use the relevant project review instructions.".into(),
        },
        catalog,
        &[],
        &ToolRegistry::new(),
    )?;
    assert!(prepared.manifest().active_skills().is_empty());
    let request = prepared.into_request();
    let payload: Value = serde_json::from_str(&request.prompt)?;
    assert_eq!(
        payload,
        json!({
            "task":"Use the relevant project review instructions.",
            "project_instructions":null,
            "available_skills":[
                {"id":"global:review","frontmatter":{"name":"review","description":"Global review metadata"}},
                {"id":"project:review","frontmatter":{"name":"review","description":"Project review metadata"}}
            ],
            "active_skills":[]
        })
    );
    assert!(!request.prompt.contains("OFFLINE_SKILL_BODY"));
    assert!(!request.prompt.contains("UNSELECTED_GLOBAL_BODY"));
    assert!(!request.options.instructions.contains("OFFLINE_SKILL_BODY"));
    assert!(
        request
            .options
            .instructions
            .starts_with("Caller instructions.")
    );
    assert!(request.options.instructions.contains("call load_skill"));
    assert!(request.options.tools.is_empty());
    let script = Arc::new(Script {
        prompt: request.prompt.clone(),
        instructions: request.options.instructions.clone(),
        opens: AtomicUsize::new(0),
        requests: AtomicUsize::new(0),
        closes: AtomicUsize::new(0),
    });
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(OfflineProvider(script.clone())))?;
    let mut finishes = 0;
    let result = run(
        &gateway,
        request,
        &tools,
        CancellationToken::new(),
        |event| {
            assert_eq!(event.schema_version, 2);
            match &event.event {
                RunEvent::ProviderEvent { event } => assert_eq!(event.schema_version, 1),
                RunEvent::ToolEvent {
                    event:
                        ToolExecutionEvent::ToolExecutionFinished {
                            call_id,
                            tool_name,
                            is_error,
                        },
                } => {
                    assert_eq!(call_id, "load-review");
                    assert_eq!(tool_name, "load_skill");
                    assert!(!*is_error);
                    finishes += 1;
                }
                _ => {}
            }
            Ok(())
        },
    )
    .await?;
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    let response = result.last_response.unwrap();
    assert_eq!(response.text, ANSWER);
    assert_eq!(response.output.len(), 1);
    assert_eq!(response.output[0].kind, ItemKind::Message);
    assert_eq!(result.summary.model_requests_attempted, 2);
    assert_eq!(result.summary.model_requests_admitted, 2);
    assert_eq!(result.summary.new_tool_dispatches, 1);
    assert_eq!(result.summary.tool_results_prepared, 1);
    assert_eq!(result.summary.reused_results, 0);
    assert_eq!(finishes, 1);
    assert_eq!(script.opens.load(Ordering::SeqCst), 1);
    assert_eq!(script.requests.load(Ordering::SeqCst), 2);
    assert_eq!(script.closes.load(Ordering::SeqCst), 1);
    println!("Completed: {ANSWER} (1 session, 2 model requests, 1 tool execution; offline)");
    Ok(())
}
