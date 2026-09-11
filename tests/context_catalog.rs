#[path = "context_catalog/diagnostics.rs"]
mod diagnostics;
#[path = "context_catalog/discovery.rs"]
mod discovery;
#[path = "context_catalog/filesystem_safety.rs"]
mod filesystem_safety;
#[path = "context_catalog/metadata_validation.rs"]
mod metadata_validation;
#[path = "context_catalog/ordering.rs"]
mod ordering;

use std::{fs, path::PathBuf};

use tempfile::TempDir;
use wi::context::{ContextRoots, Scope};

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

    fn root(&self, scope: Scope) -> PathBuf {
        match scope {
            Scope::Global => self.roots.global_skills.clone(),
            Scope::Project => self.roots.workspace.join(".agents/skills"),
        }
    }

    fn raw(&self, scope: Scope, directory: &str, content: impl AsRef<[u8]>) -> PathBuf {
        let directory = self.root(scope).join(directory);
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("SKILL.md");
        fs::write(&path, content).unwrap();
        path
    }

    fn skill(&self, scope: Scope, directory: &str, yaml: &str) -> PathBuf {
        self.raw(
            scope,
            directory,
            format!("---\n{yaml}\n---\nUNSELECTED_BODY_CANARY\n"),
        )
    }
}

fn ids(catalog: &wi::context::SkillCatalog) -> Vec<String> {
    catalog
        .entries()
        .iter()
        .map(|entry| entry.id().to_string())
        .collect()
}
