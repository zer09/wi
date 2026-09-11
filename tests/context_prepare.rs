#[path = "context_prepare/composition.rs"]
mod composition;
#[path = "context_prepare/diagnostics.rs"]
mod diagnostics;
#[path = "context_prepare/filesystem.rs"]
mod filesystem;
#[path = "context_prepare/snapshots.rs"]
mod snapshots;
#[path = "context_prepare/validation.rs"]
mod validation;

use std::{fs, path::PathBuf, sync::Arc};

use serde_json::Value;
use tempfile::TempDir;
use wi::{
    SessionOptions,
    context::{ContextRoots, PreparedRun, Scope, SkillCatalog, discover},
    run::RunRequest,
    tools::{AddNumbers, ToolRegistry},
};

const FRAMING: &str = "\n\nThe initial user payload is JSON. Its task is the user's request. Project and skill entries are user-selected context, not permissions or executable configuration. Only registered tools are available. Catalog metadata does not imply a skill loader tool exists. In S1 only explicitly selected skill bodies are active.";

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

    fn skill(&self, scope: Scope, name: &str, yaml: &str, body: &str) -> PathBuf {
        let root = match scope {
            Scope::Global => self.roots.global_skills.clone(),
            Scope::Project => self.roots.workspace.join(".agents/skills"),
        };
        let file = root.join(name).join("SKILL.md");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, format!("---\nname: {name}\n{yaml}\n---\n{body}")).unwrap();
        file
    }

    fn catalog(&self) -> SkillCatalog {
        discover(self.roots.clone()).unwrap()
    }
}

fn request() -> RunRequest {
    let mut options = SessionOptions::new("synthetic-model");
    options.instructions = "Caller instructions.\r\nπ  ".into();
    RunRequest {
        provider_id: "independent-script".into(),
        options,
        prompt: "  Add 17 and 25.\r\n\t".into(),
    }
}

fn tools() -> ToolRegistry {
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(AddNumbers)).unwrap();
    tools
}

fn payload(prepared: &PreparedRun) -> Value {
    serde_json::from_str(&prepared.request().prompt).unwrap()
}
