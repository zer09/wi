use std::{fs, path::PathBuf, process::Command, sync::Barrier};

use serde_json::json;
use tempfile::TempDir;
use wi::{
    context::{ContextErrorKind, ContextRoots, DiagnosticKind, Scope, SkillId, discover},
    provider::MAX_INPUT_BYTES,
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
fn context_catalog_requires_explicit_absolute_existing_workspace() {
    let fixture = Fixture::new();
    for workspace in [
        PathBuf::new(),
        PathBuf::from("relative"),
        fixture.temp.path().join("absent"),
    ] {
        let error = discover(ContextRoots {
            workspace,
            global_skills: fixture.roots.global_skills.clone(),
        })
        .unwrap_err();
        assert_eq!(error.kind(), ContextErrorKind::InvalidRoot);
        assert_eq!(error.source_label(), Some("project:."));
    }
    for global_skills in [PathBuf::new(), PathBuf::from("relative")] {
        let error = discover(ContextRoots {
            workspace: fixture.roots.workspace.clone(),
            global_skills,
        })
        .unwrap_err();
        assert_eq!(error.kind(), ContextErrorKind::InvalidRoot);
        assert_eq!(error.source_label(), Some("global:."));
    }
}

#[test]
fn context_catalog_existing_wrong_type_roots_fail() {
    for target in ["workspace-file", "global-file", ".agents", ".agents/skills"] {
        let fixture = Fixture::new();
        let mut roots = fixture.roots.clone();
        let path = match target {
            "workspace-file" => {
                roots.workspace = fixture.temp.path().join(target);
                roots.workspace.clone()
            }
            "global-file" => roots.global_skills.clone(),
            _ => roots.workspace.join(target),
        };
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"NOT_A_DIRECTORY").unwrap();
        assert_eq!(
            discover(roots).unwrap_err().kind(),
            ContextErrorKind::InvalidRoot
        );
    }
}

#[test]
fn context_catalog_scopes_coexist_and_sort_by_name_not_source_path() {
    let fixture = Fixture::new();
    fixture.skill(
        Scope::Global,
        "a-source",
        "name: zeta\ndescription: global zeta",
    );
    fixture.skill(
        Scope::Project,
        "z-source",
        "name: alpha\ndescription: project alpha",
    );
    fixture.skill(
        Scope::Global,
        "review",
        "name: review\ndescription: global review",
    );
    fixture.skill(
        Scope::Project,
        "review",
        "name: review\ndescription: project review",
    );
    fixture.skill(
        Scope::Global,
        "é-source",
        "name: alpha\ndescription: global alpha",
    );
    let catalog = discover(fixture.roots.clone()).unwrap();
    assert_eq!(
        ids(&catalog),
        [
            "global:alpha",
            "global:review",
            "global:zeta",
            "project:alpha",
            "project:review"
        ]
    );
    assert_eq!(catalog.entries()[1].description(), "global review");
    assert_eq!(catalog.entries()[4].description(), "project review");
    assert_eq!(
        catalog.entries()[4].source_label(),
        "project:.agents/skills/review/SKILL.md"
    );
    let again = discover(fixture.roots).unwrap();
    assert_eq!(ids(&again), ids(&catalog));
    assert_eq!(again.diagnostics(), catalog.diagnostics());
    assert_eq!(
        again
            .entries()
            .iter()
            .map(|e| e.frontmatter())
            .collect::<Vec<_>>(),
        catalog
            .entries()
            .iter()
            .map(|e| e.frontmatter())
            .collect::<Vec<_>>()
    );
}

#[test]
fn context_catalog_duplicate_validated_names_fail_in_either_scope() {
    for scope in [Scope::Global, Scope::Project] {
        let fixture = Fixture::new();
        fixture.skill(
            scope,
            "z-last",
            "name: duplicate\ndescription: SECOND_SECRET",
        );
        fixture.skill(
            scope,
            "a-first",
            "name: duplicate\ndescription: FIRST_SECRET",
        );
        let error = discover(fixture.roots).unwrap_err();
        assert_eq!(error.category(), "duplicate_skill");
        assert_eq!(error.scope(), Some(scope));
        assert!(error.source_label().unwrap().ends_with("z-last/SKILL.md"));
        let rendered = format!("{error} {error:?}");
        assert!(!rendered.contains("SECRET"));
        assert!(!rendered.contains(fixture.temp.path().to_str().unwrap()));
    }
}

#[test]
fn context_skill_ids_require_qualified_valid_names() {
    for text in [
        "global:review",
        "project:review",
        "global:a-1",
        "project:123",
    ] {
        let id: SkillId = text.parse().unwrap();
        assert_eq!(id.to_string(), text);
    }
    for text in [
        "review",
        "global:",
        "GLOBAL:review",
        "global:../review",
        "global:a/b",
        "project:a:b",
        "project:a\\b",
        "global:-a",
        "global:a-",
        "project:a--b",
        "global:Upper",
        "global:two words",
        "project:é",
        "global:a_b",
        "global: review",
        "global:review\n",
    ] {
        let error = text.parse::<SkillId>().unwrap_err();
        assert_eq!(error.kind(), ContextErrorKind::InvalidSkillId);
        assert!(error.source_label().is_none());
    }
    assert!(
        format!("global:{}", "a".repeat(64))
            .parse::<SkillId>()
            .is_ok()
    );
    assert!(
        format!("global:{}", "a".repeat(65))
            .parse::<SkillId>()
            .is_err()
    );
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
fn context_catalog_yaml_strings_comments_bom_crlf_and_json_data_are_retained() {
    let fixture = Fixture::new();
    let yaml = "name: 'review' # comment\ndescription: |-\n  Unicode α 漢 🙂\n  --- is data here\ncompatibility: >-\n  Rust\n  offline\nlicense: MIT\nmetadata: {z: 'last', a: 'first'}\nunknown:\n  z: [null, true, false, 7, -2, 1.25, {b: 2, a: 1}]\n  a: \"!tag &anchor *alias << ---\"\n  integer: 18446744073709551615\n";
    let text = format!("\u{feff}---\n{yaml}---\nBODY_CANARY").replace('\n', "\r\n");
    fixture.raw(Scope::Global, "review", text);
    let catalog = discover(fixture.roots).unwrap();
    assert!(catalog.diagnostics().is_empty());
    let entry = &catalog.entries()[0];
    assert_eq!(entry.description(), "Unicode α 漢 🙂\n--- is data here");
    assert_eq!(entry.frontmatter()["compatibility"], "Rust offline");
    assert_eq!(
        entry.frontmatter()["metadata"],
        json!({"a": "first", "z": "last"})
    );
    assert_eq!(
        entry.frontmatter()["unknown"]["z"],
        json!([null, true, false, 7, -2, 1.25, {"a": 1, "b": 2}])
    );
    assert_eq!(entry.frontmatter()["unknown"]["integer"], json!(u64::MAX));
    let encoded = serde_json::to_string(entry.frontmatter()).unwrap();
    assert!(encoded.starts_with("{\"compatibility\":"));
    assert!(encoded.contains("\"metadata\":{\"a\":\"first\",\"z\":\"last\"}"));
    assert!(encoded.contains("{\"a\":1,\"b\":2}"));
    assert!(!encoded.contains("BODY_CANARY"));
}

#[test]
fn context_catalog_quoted_merge_keys_are_retained_as_data() {
    for key in ["\"<<\"", "'<<'"] {
        let fixture = Fixture::new();
        fixture.skill(
            Scope::Global,
            "review",
            &format!(
                "name: review\ndescription: review\n{key}: {{nested: [1, true, null]}}\nunknown:\n  {key}: nested value\n  sequence: [{{{key}: [one, two]}}]\n  plain_value: <<"
            ),
        );
        let catalog = discover(fixture.roots).unwrap();
        assert_eq!(ids(&catalog), ["global:review"], "key {key}");
        assert!(catalog.diagnostics().is_empty());
        assert_eq!(
            catalog.entries()[0].frontmatter(),
            &json!({
                "name": "review",
                "description": "review",
                "<<": {"nested": [1, true, null]},
                "unknown": {
                    "<<": "nested value",
                    "sequence": [{"<<": ["one", "two"]}],
                    "plain_value": "<<"
                }
            })
        );
    }
}

#[test]
fn context_catalog_optional_behavior_is_data_and_directory_mismatch_only_warns() {
    let fixture = Fixture::new();
    fixture.skill(Scope::Global, "different", "name: review\ndescription: ' exact description '\nallowed-tools: shell network\ndisable-model-invocation: true\nuser-invocable: false\ncustom: {nested: [one, two]}");
    let catalog = discover(fixture.roots).unwrap();
    assert_eq!(ids(&catalog), ["global:review"]);
    let entry = &catalog.entries()[0];
    assert_eq!(entry.description(), " exact description ");
    assert_eq!(entry.frontmatter()["allowed-tools"], "shell network");
    assert_eq!(entry.frontmatter()["disable-model-invocation"], true);
    assert_eq!(entry.frontmatter()["user-invocable"], false);
    assert_eq!(
        entry.frontmatter()["custom"],
        json!({"nested": ["one", "two"]})
    );
    assert_eq!(
        catalog
            .diagnostics()
            .iter()
            .map(|d| d.kind())
            .collect::<Vec<_>>(),
        [
            DiagnosticKind::DirectoryNameMismatch,
            DiagnosticKind::UnsupportedBehavioralMetadata
        ]
    );
    assert!(
        catalog
            .diagnostics()
            .iter()
            .all(|d| d.source_label() == "global:different/SKILL.md")
    );
}

#[test]
fn context_catalog_malformed_yaml_excludes_only_the_located_skill() {
    let cases = [
        "",
        "[]",
        "name: broken",
        "description: SECRET_YAML_SNIPPET",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nname: broken",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\n\"na\\u006de\": broken",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\n1: value",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\ntrue: value",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\n? [key]\n: value",
        "name: broken\ndescription: !custom SECRET_YAML_SNIPPET",
        "name: broken\ndescription: !!str SECRET_YAML_SNIPPET",
        "!custom {name: broken, description: SECRET_YAML_SNIPPET}",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown: !custom [one]",
        "name: broken\ndescription: &unused SECRET_YAML_SNIPPET",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown: &unused [one]",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown: &unused {a: one}",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown: *missing",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nbase: &base one\ncopy: *base",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\n<<: {a: one}",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown: {<<: {a: one}}",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown:\n  nested:\n    <<: {a: one}",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown: {nested: [{<<: {a: one}}]}",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\n\"<<\": one\n'<<': two",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown: [{\"<<\": one, '<<': two}]",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown: [{!!str \"<<\": one}]",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown: [{&unused '<<': one}]",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown: [{1: value}]",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown: [{[key]: value}]",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown: [unterminated",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown: .inf",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown: .NaN",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\nunknown: {a: 1, a: 2}",
        "name: broken\ndescription: SECRET_YAML_SNIPPET\n...\n--- {name: other}",
    ];
    for (index, yaml) in cases.iter().enumerate() {
        let fixture = Fixture::new();
        fixture.skill(Scope::Global, "broken", yaml);
        fixture.skill(Scope::Global, "valid", "name: valid\ndescription: valid");
        let catalog = discover(fixture.roots).unwrap();
        assert_eq!(ids(&catalog), ["global:valid"], "case {index}");
        assert_eq!(catalog.diagnostics().len(), 1, "case {index}");
        let diagnostic = &catalog.diagnostics()[0];
        assert_eq!(
            diagnostic.kind(),
            DiagnosticKind::Excluded(ContextErrorKind::InvalidFrontmatter)
        );
        assert_eq!(diagnostic.source_label(), "global:broken/SKILL.md");
        let rendered = format!("{diagnostic:?} {} {catalog:?}", diagnostic.message());
        assert!(!rendered.contains("SECRET_YAML_SNIPPET"));
        assert!(!rendered.contains(fixture.temp.path().to_str().unwrap()));
    }
}

#[test]
fn context_catalog_required_optional_field_shapes_and_scalar_lengths() {
    let invalid = [
        "name: ''\ndescription: valid".to_owned(),
        "name: 123\ndescription: valid".to_owned(),
        "name: false\ndescription: valid".to_owned(),
        "name: [broken]\ndescription: valid".to_owned(),
        "name: broken\ndescription: null".to_owned(),
        "name: broken\ndescription: Null".to_owned(),
        "name: broken\ndescription: NULL".to_owned(),
        "name: broken\ndescription: false".to_owned(),
        "name: broken\ndescription: []".to_owned(),
        "name: broken\ndescription: ' \t '".to_owned(),
        format!("name: {}\ndescription: valid", "a".repeat(65)),
        format!("name: broken\ndescription: '{}'", "α".repeat(1025)),
        format!(
            "name: broken\ndescription: valid\ncompatibility: '{}'",
            "α".repeat(501)
        ),
        "name: broken\ndescription: valid\ncompatibility: ''".to_owned(),
        "name: broken\ndescription: valid\ncompatibility: '  '".to_owned(),
        "name: broken\ndescription: valid\ncompatibility: []".to_owned(),
        "name: broken\ndescription: valid\nlicense: []".to_owned(),
        "name: broken\ndescription: valid\nallowed-tools: [shell]".to_owned(),
        "name: broken\ndescription: valid\nmetadata: []".to_owned(),
        "name: broken\ndescription: valid\nmetadata: null".to_owned(),
        "name: broken\ndescription: valid\nmetadata: {key: true}".to_owned(),
        "name: broken\ndescription: valid\nmetadata: {1: value}".to_owned(),
    ];
    for (index, yaml) in invalid.iter().enumerate() {
        let fixture = Fixture::new();
        fixture.skill(Scope::Global, "broken", yaml);
        let catalog = discover(fixture.roots).unwrap();
        assert!(catalog.entries().is_empty(), "case {index}");
        assert_eq!(
            catalog.diagnostics()[0].kind(),
            DiagnosticKind::Excluded(ContextErrorKind::InvalidFrontmatter)
        );
    }
    for name in [
        "Upper",
        "under_score",
        "-leading",
        "trailing-",
        "two--hyphens",
        "é",
        "a/b",
        "a:b",
    ] {
        let fixture = Fixture::new();
        fixture.skill(
            Scope::Global,
            "broken",
            &format!("name: '{name}'\ndescription: valid"),
        );
        assert!(discover(fixture.roots).unwrap().entries().is_empty());
    }
    let fixture = Fixture::new();
    let name = "a".repeat(64);
    let description = "α".repeat(1024);
    let compatibility = "漢".repeat(500);
    fixture.skill(Scope::Global, &name, &format!("name: '{name}'\ndescription: '{description}'\ncompatibility: '{compatibility}'\nmetadata: {{}}\nlicense: ''"));
    fixture.skill(
        Scope::Project,
        "123",
        "name: '123'\ndescription: numeric string name",
    );
    let catalog = discover(fixture.roots).unwrap();
    assert_eq!(catalog.entries().len(), 2);
    assert!(catalog.diagnostics().is_empty());
    assert_eq!(catalog.entries()[0].description(), description);
    assert_eq!(
        catalog.entries()[0].frontmatter()["compatibility"],
        compatibility
    );
}

#[test]
fn context_catalog_requires_delimiter_lines_and_utf8_metadata() {
    for text in [
        b"name: broken\ndescription: valid\n---\n".as_slice(),
        b"\n---\nname: broken\ndescription: valid\n---\n",
        b" ---\nname: broken\ndescription: valid\n---\n",
        b"---\nname: broken\ndescription: valid\n----\n",
        b"---\nname: broken\ndescription: valid\n--- trailing\n",
        b"---\nname: broken\ndescription: valid\n",
        b"---\nname: broken\ndescription: \xff\n---\n",
        b"---\nname: broken\ndescription: valid\nunknown: \xff\n---\n",
    ] {
        let fixture = Fixture::new();
        fixture.raw(Scope::Global, "broken", text);
        let catalog = discover(fixture.roots).unwrap();
        assert!(catalog.entries().is_empty());
        assert_eq!(
            catalog.diagnostics()[0].kind(),
            DiagnosticKind::Excluded(ContextErrorKind::InvalidFrontmatter)
        );
    }
    let fixture = Fixture::new();
    fixture.raw(
        Scope::Global,
        "review",
        b"---\nname: review\ndescription: valid\n---",
    );
    assert_eq!(ids(&discover(fixture.roots).unwrap()), ["global:review"]);
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
fn context_catalog_oversized_metadata_is_fatal_not_a_partial_catalog() {
    let fixture = Fixture::new();
    fixture.skill(Scope::Global, "valid", "name: valid\ndescription: valid");
    fixture.skill(
        Scope::Global,
        "large",
        &format!(
            "name: large\ndescription: valid\nunknown: {}",
            "x".repeat(MAX_INPUT_BYTES)
        ),
    );
    let error = discover(fixture.roots).unwrap_err();
    assert_eq!(error.category(), "input_too_large");
    assert_eq!(error.source_label(), Some("global:large/SKILL.md"));
}

#[test]
fn context_catalog_debug_redacts_metadata_and_host_paths() {
    let fixture = Fixture::new();
    fixture.skill(
        Scope::Global,
        "review",
        "name: review\ndescription: PRIVATE_DESCRIPTION_CANARY\nunknown: PRIVATE_UNKNOWN_CANARY",
    );
    let roots_debug = format!("{:?}", fixture.roots);
    let catalog = discover(fixture.roots).unwrap();
    let rendered = format!(
        "{roots_debug} {catalog:?} {:?} {:?}",
        catalog.entries(),
        catalog.entries()[0].id()
    );
    for forbidden in [
        "PRIVATE_DESCRIPTION_CANARY",
        "PRIVATE_UNKNOWN_CANARY",
        "review",
        fixture.temp.path().to_str().unwrap(),
    ] {
        assert!(!rendered.contains(forbidden));
    }
    assert!(rendered.contains("redacted"));
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
                "context_catalog_uses_no_ambient_roots_even_without_home",
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

#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        os::unix::{
            ffi::OsStringExt,
            fs::{PermissionsExt, symlink},
        },
        path::Path,
    };

    struct Denied(PathBuf, fs::Permissions);
    impl Denied {
        fn new(path: &Path) -> Self {
            let permissions = fs::metadata(path).unwrap().permissions();
            fs::set_permissions(path, fs::Permissions::from_mode(0o0)).unwrap();
            Self(path.to_owned(), permissions)
        }
    }
    impl Drop for Denied {
        fn drop(&mut self) {
            fs::set_permissions(&self.0, self.1.clone()).unwrap();
        }
    }

    #[test]
    fn context_catalog_canonicalizes_only_selected_roots() {
        let fixture = Fixture::new();
        fixture.skill(Scope::Global, "review", "name: review\ndescription: global");
        fixture.skill(
            Scope::Project,
            "review",
            "name: review\ndescription: project",
        );
        let workspace = fixture.temp.path().join("workspace-link");
        let global_skills = fixture.temp.path().join("global-link");
        symlink(&fixture.roots.workspace, &workspace).unwrap();
        symlink(&fixture.roots.global_skills, &global_skills).unwrap();
        let catalog = discover(ContextRoots {
            workspace,
            global_skills,
        })
        .unwrap();
        assert_eq!(ids(&catalog), ["global:review", "project:review"]);
        assert!(catalog.diagnostics().is_empty());
    }

    #[test]
    fn context_catalog_descendant_package_and_manifest_links_are_diagnosed_not_followed() {
        let fixture = Fixture::new();
        fixture.skill(Scope::Global, "review", "name: review\ndescription: global");
        let outside = fixture.temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(
            outside.join("SKILL.md"),
            "---\nname: escaped\ndescription: OUTSIDE_CANARY\n---\n",
        )
        .unwrap();
        symlink(&outside, fixture.root(Scope::Global).join("linked-package")).unwrap();
        symlink(
            fixture.root(Scope::Global).join("review"),
            fixture.root(Scope::Global).join("internal-link"),
        )
        .unwrap();
        symlink(
            fixture.temp.path().join("absent"),
            fixture.root(Scope::Global).join("dangling-link"),
        )
        .unwrap();
        fixture.skill(
            Scope::Global,
            "linked-manifest/nested",
            "name: hidden\ndescription: hidden",
        );
        symlink(
            outside.join("SKILL.md"),
            fixture.root(Scope::Global).join("linked-manifest/SKILL.md"),
        )
        .unwrap();
        fs::create_dir_all(fixture.root(Scope::Project)).unwrap();
        symlink(
            &outside,
            fixture.root(Scope::Project).join("linked-project-package"),
        )
        .unwrap();
        let catalog = discover(fixture.roots).unwrap();
        assert_eq!(ids(&catalog), ["global:review"]);
        assert_eq!(catalog.diagnostics().len(), 5);
        assert!(
            catalog
                .diagnostics()
                .iter()
                .all(|d| d.kind() == DiagnosticKind::SkippedSymlink)
        );
        let labels = catalog
            .diagnostics()
            .iter()
            .map(|d| d.source_label())
            .collect::<Vec<_>>();
        assert_eq!(
            labels,
            [
                "global:dangling-link",
                "global:internal-link",
                "global:linked-manifest/SKILL.md",
                "global:linked-package",
                "project:.agents/skills/linked-project-package"
            ]
        );
        assert!(!format!("{:?}", catalog.diagnostics()).contains("OUTSIDE_CANARY"));
    }

    #[test]
    fn context_catalog_linked_agents_and_project_skills_roots_are_skipped() {
        for link in [".agents", ".agents/skills"] {
            let fixture = Fixture::new();
            fixture.skill(Scope::Global, "review", "name: review\ndescription: global");
            let outside = fixture.temp.path().join("outside");
            fs::create_dir_all(outside.join("skills")).unwrap();
            let path = fixture.roots.workspace.join(link);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            symlink(&outside, &path).unwrap();
            let catalog = discover(fixture.roots).unwrap();
            assert_eq!(ids(&catalog), ["global:review"]);
            assert_eq!(catalog.diagnostics().len(), 1);
            assert_eq!(
                catalog.diagnostics()[0].kind(),
                DiagnosticKind::SkippedSymlink
            );
            assert_eq!(
                catalog.diagnostics()[0].source_label(),
                format!("project:{link}")
            );
        }
    }

    #[test]
    fn context_catalog_dangling_explicit_root_is_not_silently_missing() {
        let fixture = Fixture::new();
        symlink(
            fixture.temp.path().join("absent"),
            &fixture.roots.global_skills,
        )
        .unwrap();
        assert_eq!(
            discover(fixture.roots).unwrap_err().kind(),
            ContextErrorKind::InvalidRoot
        );
    }

    #[test]
    fn context_catalog_unreadable_roots_and_traversal_are_fatal() {
        for target in [
            "workspace",
            "global",
            "global/hidden",
            "workspace/.agents",
            "workspace/.agents/skills",
        ] {
            let fixture = Fixture::new();
            fixture.skill(Scope::Global, "valid", "name: valid\ndescription: valid");
            let path = fixture.temp.path().join(target);
            fs::create_dir_all(&path).unwrap();
            let _denied = Denied::new(&path);
            assert!(
                fs::read_dir(&path).is_err(),
                "permission proof requires an unprivileged test process"
            );
            let error = discover(fixture.roots).unwrap_err();
            assert_eq!(error.kind(), ContextErrorKind::ReadFailed);
            assert!(!format!("{error} {error:?}").contains(fixture.temp.path().to_str().unwrap()));
        }
    }

    #[test]
    fn context_catalog_unreadable_manifest_is_excluded_but_resources_are_not_traversed() {
        let fixture = Fixture::new();
        let blocked = fixture.skill(
            Scope::Global,
            "blocked",
            "name: blocked\ndescription: valid",
        );
        fixture.skill(Scope::Global, "valid", "name: valid\ndescription: valid");
        let resource = fixture.root(Scope::Global).join("valid/resources");
        fs::create_dir(&resource).unwrap();
        let _denied_file = Denied::new(&blocked);
        let _denied_resource = Denied::new(&resource);
        assert!(
            fs::File::open(&blocked).is_err(),
            "permission proof requires an unprivileged test process"
        );
        let catalog = discover(fixture.roots).unwrap();
        assert_eq!(ids(&catalog), ["global:valid"]);
        assert_eq!(catalog.diagnostics().len(), 1);
        assert_eq!(
            catalog.diagnostics()[0].kind(),
            DiagnosticKind::Excluded(ContextErrorKind::ReadFailed)
        );
    }

    #[test]
    fn context_catalog_non_utf8_traversal_names_fail_without_lossy_labels() {
        let fixture = Fixture::new();
        fs::create_dir(&fixture.roots.global_skills).unwrap();
        fs::create_dir(
            fixture
                .roots
                .global_skills
                .join(std::ffi::OsString::from_vec(vec![0xff])),
        )
        .unwrap();
        let error = discover(fixture.roots).unwrap_err();
        assert_eq!(error.kind(), ContextErrorKind::ReadFailed);
        assert_eq!(error.source_label(), Some("global:."));
    }

    #[test]
    fn context_catalog_diagnostics_escape_filename_control_characters() {
        let fixture = Fixture::new();
        fixture.skill(
            Scope::Global,
            "bad\n\u{1b}[31m",
            "name: missing-description",
        );
        let catalog = discover(fixture.roots).unwrap();
        let diagnostic = &catalog.diagnostics()[0];
        assert!(!diagnostic.source_label().contains('\n'));
        assert!(!diagnostic.source_label().contains('\u{1b}'));
        assert!(diagnostic.source_label().contains("\\n"));
        assert!(diagnostic.source_label().starts_with("global:"));
    }
}

#[cfg(target_os = "linux")]
#[test]
fn context_catalog_fifo_and_directory_manifests_are_excluded_without_reading() {
    let fixture = Fixture::new();
    fixture.skill(Scope::Global, "valid", "name: valid\ndescription: valid");
    let fifo = fixture.root(Scope::Global).join("fifo/SKILL.md");
    fs::create_dir(fifo.parent().unwrap()).unwrap();
    let directory = fs::File::open(fifo.parent().unwrap()).unwrap();
    rustix::fs::mkfifoat(
        &directory,
        "SKILL.md",
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )
    .unwrap();
    fixture.skill(
        Scope::Global,
        "directory/SKILL.md/nested",
        "name: hidden\ndescription: hidden",
    );
    let catalog = discover(fixture.roots).unwrap();
    assert_eq!(ids(&catalog), ["global:valid"]);
    assert_eq!(catalog.diagnostics().len(), 2);
    assert!(
        catalog
            .diagnostics()
            .iter()
            .all(|d| d.kind() == DiagnosticKind::Excluded(ContextErrorKind::ReadFailed))
    );
}
