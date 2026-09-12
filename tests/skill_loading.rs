#[path = "skill_loading/boundaries.rs"]
mod boundaries;
#[path = "skill_loading/filesystem.rs"]
mod filesystem;
#[path = "skill_loading/loading.rs"]
mod loading;
#[path = "skill_loading/preparation.rs"]
mod preparation;
#[path = "skill_loading/registry.rs"]
mod registry;

use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use async_trait::async_trait;
use serde_json::{Value, json};

use tempfile::TempDir;
use wi::{
    CallOrigin, FunctionCall, InputItem, ItemKind, ModelResponse, OutputItem, ResponseOutcome,
    SessionOptions, ToolDefinition,
    context::{ContextRoots, Scope, SkillCatalog, discover},
    run::RunRequest,
    tools::{AddNumbers, Tool, ToolRegistry},
};

struct Fixture {
    temp: TempDir,
    roots: ContextRoots,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let roots = ContextRoots {
            workspace: temp.path().join("workspace"),
            global_skills: temp.path().join("global"),
        };
        fs::create_dir(&roots.workspace).unwrap();
        Self { temp, roots }
    }

    fn skill(&self, scope: Scope, directory: &str, yaml: &str, body: &str) -> PathBuf {
        let root = match scope {
            Scope::Global => self.roots.global_skills.clone(),
            Scope::Project => self.roots.workspace.join(".agents/skills"),
        };
        let file = root.join(directory).join("SKILL.md");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, format!("---\n{yaml}\n---\n{body}")).unwrap();
        file
    }

    fn catalog(&self) -> Arc<SkillCatalog> {
        Arc::new(discover(self.roots.clone()).unwrap())
    }
}

fn request() -> RunRequest {
    let mut options = SessionOptions::new("synthetic-model");
    options.instructions = "Caller prefix.\r\nπ  ".into();
    RunRequest {
        provider_id: "independent-script".into(),
        options,
        prompt: "  Review this task.\r\n\t".into(),
    }
}

fn tools() -> ToolRegistry {
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(AddNumbers)).unwrap();
    tools
}

fn response(calls: &[(&str, &str, Value)]) -> ModelResponse {
    ModelResponse {
        id: "response".into(),
        model: None,
        outcome: ResponseOutcome::Completed,
        output_provenance: Default::default(),
        output: calls
            .iter()
            .map(|(id, name, args)| OutputItem {
                id: Some(format!("item-{id}")),
                kind: ItemKind::FunctionCall,
                native_type: "function_call".into(),
                function_call: Some(FunctionCall {
                    call_id: (*id).into(),
                    name: (*name).into(),
                    arguments: args.to_string(),
                    origin: CallOrigin::Direct,
                    namespace: None,
                    complete: true,
                }),
                native: Value::Null,
            })
            .collect(),
        text: String::new(),
        usage: None,
        native: Value::Null,
    }
}

async fn execute(registry: &mut ToolRegistry, call_id: &str, id: &str) -> (String, Vec<Value>) {
    let mut events = Vec::new();
    let results = registry
        .execute_response(
            &response(&[(call_id, "load_skill", json!({"id":id}))]),
            |event| events.push(serde_json::to_value(event).unwrap()),
        )
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    let InputItem::ToolResult {
        call_id: actual_id,
        output,
    } = &results[0]
    else {
        panic!("expected tool result")
    };
    assert_eq!(actual_id, call_id);
    (output.clone(), events)
}

fn finished_events(call_id: &str, is_error: bool) -> Vec<Value> {
    vec![
        json!({"type":"tool_execution_started","call_id":call_id,"tool_name":"load_skill"}),
        json!({"type":"tool_execution_finished","call_id":call_id,"tool_name":"load_skill","is_error":is_error}),
    ]
}

struct RecordingTool {
    name: String,
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl Tool for RecordingTool {
    fn definition(&self) -> ToolDefinition {
        let mut definition = AddNumbers.definition();
        definition.name = self.name.clone();
        definition
    }

    fn validate(&self, arguments: &Value) -> wi::Result<()> {
        AddNumbers.validate(arguments)
    }

    async fn execute(&self, arguments: Value) -> wi::Result<Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        AddNumbers.execute(arguments).await
    }
}
