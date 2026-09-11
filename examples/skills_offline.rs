//! Synthetic context and a finite scripted provider. No credentials or network.
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
    context::{ContextRoots, discover, prepare_run},
    run::{RunEvent, RunOutcome, RunRequest, run},
    tools::{AddNumbers, ToolRegistry},
    *,
};

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
                        id: Some("addition".into()),
                        kind: ItemKind::FunctionCall,
                        native_type: "script-addition".into(),
                        function_call: Some(FunctionCall {
                            call_id: "add".into(),
                            name: "add_numbers".into(),
                            arguments: json!({"a":17,"b":25}).to_string(),
                            origin: CallOrigin::Direct,
                            namespace: None,
                            complete: true,
                        }),
                        native: json!({"operands":[17,25]}),
                    }],
                    "",
                )
            }
            2 => {
                assert_eq!(
                    serde_json::to_value(&input).unwrap(),
                    json!([
                        {"kind":"tool_result", "call_id":"add", "output":"{\"sum\":42}"}
                    ])
                );
                (
                    vec![OutputItem {
                        id: Some("answer".into()),
                        kind: ItemKind::Message,
                        native_type: "script-answer".into(),
                        function_call: None,
                        native: json!({"answer":42}),
                    }],
                    "42",
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
                session_id: "skills-session".into(),
                request_id: Some(request_id.clone()),
                provider: "skills-script".into(),
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
        "skills-script"
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
        assert_eq!(options.tools[0].name, "add_numbers");
        assert!(options.required_features.is_empty());
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        Ok(ProviderSession {
            id: "skills-session".into(),
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
    // Explicit temporary roots avoid the owner's workspace, HOME and configuration.
    let temp = tempfile::tempdir()?;
    let roots = ContextRoots {
        workspace: temp.path().join("workspace"),
        global_skills: temp.path().join("global"),
    };
    fs::create_dir_all(roots.global_skills.join("review"))?;
    fs::create_dir_all(roots.workspace.join(".agents/skills/review/scripts"))?;
    fs::write(
        roots.global_skills.join("review/SKILL.md"),
        "---\nname: review\ndescription: Global metadata\n---\nUNSELECTED_GLOBAL_BODY",
    )?;
    let body = "Use the supplied numbers and the registered addition tool. A reference to scripts/inert.txt does not execute it.";
    fs::write(
        roots.workspace.join(".agents/skills/review/SKILL.md"),
        format!("---\nname: review\ndescription: Project metadata\n---\n{body}"),
    )?;
    fs::write(
        roots
            .workspace
            .join(".agents/skills/review/scripts/inert.txt"),
        "RESOURCE_CANARY",
    )?;
    fs::write(
        roots.workspace.join("AGENTS.md"),
        "Keep the answer concise.",
    )?;
    let catalog = discover(roots)?;
    assert!(catalog.diagnostics().is_empty());
    assert_eq!(
        catalog
            .entries()
            .iter()
            .map(|entry| entry.id().to_string())
            .collect::<Vec<_>>(),
        ["global:review", "project:review"]
    );
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(AddNumbers))?;
    let mut options = SessionOptions::new("script");
    options.instructions = "Caller instructions.".into();
    let request = RunRequest {
        provider_id: "skills-script".into(),
        options,
        prompt: "Add 17 and 25.".into(),
    };
    let unselected = prepare_run(request.clone(), &catalog, &[], &tools)?;
    let value: Value = serde_json::from_str(&unselected.request().prompt)?;
    assert_eq!(value["active_skills"], json!([]));
    assert_eq!(value["available_skills"].as_array().unwrap().len(), 2);
    assert!(!unselected.request().prompt.contains(body));
    let prepared = prepare_run(request, &catalog, &["project:review".parse()?], &tools)?;
    assert_eq!(prepared.manifest().active_skills().len(), 1);
    let request = prepared.into_request();
    let payload: Value = serde_json::from_str(&request.prompt)?;
    assert_eq!(payload["task"], "Add 17 and 25.");
    assert_eq!(payload["available_skills"], value["available_skills"]);
    assert_eq!(payload["active_skills"][0]["body"], body);
    assert_eq!(payload["active_skills"][0]["id"], "project:review");
    assert_eq!(
        payload["project_instructions"],
        json!({"source":"project:AGENTS.md", "text":"Keep the answer concise."})
    );
    assert!(!request.prompt.contains("UNSELECTED_GLOBAL_BODY"));
    assert!(!request.prompt.contains("RESOURCE_CANARY"));
    assert!(!request.prompt.contains(&temp.path().display().to_string()));
    assert!(
        request
            .options
            .instructions
            .starts_with("Caller instructions.")
    );
    assert!(!request.options.instructions.contains(body));
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
    let result = run(
        &gateway,
        request,
        &tools,
        CancellationToken::new(),
        |event| {
            assert_eq!(event.schema_version, 2);
            if let RunEvent::ProviderEvent { event } = &event.event {
                assert_eq!(event.schema_version, 1);
            }
            Ok(())
        },
    )
    .await?;
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(result.events_complete);
    assert_eq!(result.last_response.unwrap().text, "42");
    assert_eq!(result.summary.model_requests_attempted, 2);
    assert_eq!(result.summary.new_tool_dispatches, 1);
    assert_eq!(result.summary.tool_results_prepared, 1);
    assert_eq!(script.opens.load(Ordering::SeqCst), 1);
    assert_eq!(script.requests.load(Ordering::SeqCst), 2);
    assert_eq!(script.closes.load(Ordering::SeqCst), 1);
    println!(
        "Completed: 42 (2 catalog entries, 1 active skill, 1 session, 2 model requests, 1 tool execution; offline)"
    );
    Ok(())
}
