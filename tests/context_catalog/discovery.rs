use super::{Fixture, ids};
use std::{fs, path::PathBuf, process::Command, sync::Barrier};

use serde_json::json;
use wi::{
    context::{ContextErrorKind, ContextRoots, DiagnosticKind, Scope, discover},
    provider::MAX_INPUT_BYTES,
};

#[test]
fn context_catalog_missing_roots_are_read_only_empty_scopes() {
    let fixture = Fixture::new();
    let roots = ContextRoots {
        workspace: fixture.roots.workspace.clone(),
        global_skills: fixture.temp.path().join("missing/config/wi/skills"),
    };
    let catalog = discover(roots).unwrap();
    assert!(catalog.entries().is_empty());
    assert!(catalog.diagnostics().is_empty());
    assert!(!fixture.temp.path().join("missing").exists());
    assert!(!fixture.roots.workspace.join(".agents").exists());
    assert_eq!(fs::read_dir(&fixture.roots.workspace).unwrap().count(), 0);
}

#[test]
fn context_catalog_stops_at_valid_malformed_and_root_package_boundaries() {
    let fixture = Fixture::new();
    fixture.skill(Scope::Global, "valid", "name: valid\ndescription: valid");
    fixture.skill(
        Scope::Global,
        "valid/references/hidden",
        "name: hidden\ndescription: RESOURCE_CANARY",
    );
    fixture.skill(Scope::Global, "malformed", "name: malformed");
    fixture.skill(
        Scope::Global,
        "malformed/scripts/hidden",
        "name: hidden\ndescription: SCRIPT_CANARY",
    );
    // Discovery does not load project instructions, other harnesses or arbitrary Markdown.
    fs::write(fixture.roots.workspace.join("AGENTS.md"), [0xff, 0xfe]).unwrap();
    for directory in [
        ".pi/skills/hidden",
        ".codex/skills/hidden",
        ".agents/package",
        "ordinary",
    ] {
        let path = fixture.roots.workspace.join(directory);
        fs::create_dir_all(&path).unwrap();
        fs::write(
            path.join("SKILL.md"),
            "---\nname: ambient\ndescription: AMBIENT_CANARY\n---\n",
        )
        .unwrap();
    }
    fs::write(fixture.root(Scope::Global).join("README.md"), [0xff]).unwrap();
    let catalog = discover(fixture.roots.clone()).unwrap();
    assert_eq!(ids(&catalog), ["global:valid"]);
    assert_eq!(catalog.diagnostics().len(), 1);
    assert_eq!(
        catalog.diagnostics()[0].kind(),
        DiagnosticKind::Excluded(ContextErrorKind::InvalidFrontmatter)
    );
    fixture.skill(Scope::Global, "", "name: root\ndescription: root package");
    let catalog = discover(fixture.roots).unwrap();
    assert_eq!(ids(&catalog), ["global:root"]);
    assert_eq!(catalog.entries()[0].source_label(), "global:SKILL.md");
    assert!(catalog.diagnostics().is_empty());
}

#[test]
fn context_catalog_large_non_utf8_unselected_body_is_not_loaded_or_size_checked() {
    let fixture = Fixture::new();
    let header = b"---\nname: review\ndescription: metadata only\n---\n";
    let mut content = header.to_vec();
    content.extend_from_slice(b"BODY_SECRET_CANARY");
    content.resize(MAX_INPUT_BYTES * 3, 0xff);
    let path = fixture.raw(Scope::Global, "review", &content);
    let before = fs::metadata(&path).unwrap();
    let catalog = discover(fixture.roots).unwrap();
    assert_eq!(ids(&catalog), ["global:review"]);
    assert!(catalog.diagnostics().is_empty());
    assert_eq!(
        catalog.entries()[0].frontmatter(),
        &json!({"name": "review", "description": "metadata only"})
    );
    assert_eq!(fs::metadata(path).unwrap().len(), before.len());
    assert!(!format!("{catalog:?} {:?}", catalog.entries()).contains("BODY_SECRET_CANARY"));
}

#[test]
fn context_catalog_independent_concurrent_callers_keep_workspace_context_separate() {
    let first = Fixture::new();
    let second = Fixture::new();
    for (fixture, label) in [(&first, "first"), (&second, "second")] {
        fixture.skill(
            Scope::Global,
            "review",
            &format!("name: review\ndescription: {label} global"),
        );
        fixture.skill(
            Scope::Project,
            "review",
            &format!("name: review\ndescription: {label} project"),
        );
    }
    let cwd = std::env::current_dir().unwrap();
    let barrier = Barrier::new(2);
    let (one, two) = std::thread::scope(|scope| {
        let one = scope.spawn(|| {
            barrier.wait();
            discover(first.roots).unwrap()
        });
        let two = scope.spawn(|| {
            barrier.wait();
            discover(second.roots).unwrap()
        });
        (one.join().unwrap(), two.join().unwrap())
    });
    assert_eq!(one.entries()[0].description(), "first global");
    assert_eq!(one.entries()[1].description(), "first project");
    assert_eq!(two.entries()[0].description(), "second global");
    assert_eq!(two.entries()[1].description(), "second project");
    assert_eq!(std::env::current_dir().unwrap(), cwd);
}

#[test]
fn context_catalog_uses_no_ambient_roots_even_without_home() {
    // A subprocess isolates environment changes from parallel Rust tests.
    const FIXTURE: &str = "WI_CONTEXT_SYNTHETIC_ROOT";
    if let Some(root) = std::env::var_os(FIXTURE) {
        let root = PathBuf::from(root);
        let before = std::env::current_dir().unwrap();
        let catalog = discover(ContextRoots {
            workspace: root.join("workspace"),
            global_skills: root.join("global"),
        })
        .unwrap();
        assert_eq!(ids(&catalog), ["global:review"]);
        assert!(catalog.diagnostics().is_empty());
        assert_eq!(std::env::current_dir().unwrap(), before);
        return;
    }
    let fixture = Fixture::new();
    fixture.skill(
        Scope::Global,
        "review",
        "name: review\ndescription: explicit global",
    );
    let ambient = fixture.temp.path().join("ambient");
    for relative in [
        ".config/wi/skills/review",
        "wi/skills/review",
        ".agents/skills/review",
        ".pi/agent/skills/review",
        ".codex/skills/review",
    ] {
        let directory = ambient.join(relative);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("SKILL.md"),
            "---\nname: review\ndescription: AMBIENT_MUST_NOT_APPEAR\n---\n",
        )
        .unwrap();
    }
    for with_home in [true, false] {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "discovery::context_catalog_uses_no_ambient_roots_even_without_home",
                "--nocapture",
            ])
            .current_dir(&ambient)
            .env(FIXTURE, fixture.temp.path())
            .env("CODEX_HOME", &ambient);
        if with_home {
            command
                .env("HOME", &ambient)
                .env("XDG_CONFIG_HOME", &ambient);
        } else {
            command.env_remove("HOME").env_remove("XDG_CONFIG_HOME");
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "child stdout: {}\nchild stderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn context_catalog_has_no_skill_count_or_traversal_depth_quota() {
    let fixture = Fixture::new();
    for index in (0..140).rev() {
        let name = format!("skill-{index}");
        fixture.skill(
            Scope::Global,
            &name,
            &format!("name: {name}\ndescription: valid"),
        );
    }
    let deep = vec!["d"; 160].join("/");
    fixture.skill(
        Scope::Global,
        &format!("{deep}/deep"),
        "name: deep\ndescription: valid",
    );
    let catalog = discover(fixture.roots).unwrap();
    assert_eq!(catalog.entries().len(), 141);
    assert_eq!(catalog.entries()[0].id().to_string(), "global:deep");
    assert!(catalog.diagnostics().is_empty());
}
