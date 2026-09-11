use super::{Fixture, ids};

use serde_json::json;
use wi::context::{DiagnosticKind, Scope, discover};

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

#[cfg(unix)]
mod unix {
    use super::*;

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
