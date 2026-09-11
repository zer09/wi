use super::{Fixture, ids};

use serde_json::json;
use wi::{
    context::{ContextErrorKind, DiagnosticKind, Scope, SkillId, discover},
    provider::MAX_INPUT_BYTES,
};

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
