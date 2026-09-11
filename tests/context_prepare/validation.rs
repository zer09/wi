use super::{FRAMING, Fixture, payload, request, tools};
use std::{fs, sync::Arc};

use async_trait::async_trait;
use serde_json::{Value, json};
use wi::{
    InputItem, ToolDefinition,
    context::{ContextErrorKind, Scope, SkillId, prepare_run},
    provider::{MAX_INPUT_BYTES, validate_input},
    tools::Tool,
};

#[test]
fn context_prepare_unknown_and_invalid_selections_are_not_paths() {
    let f = Fixture::new();
    f.skill(Scope::Global, "review", "description: Known", "BODY");
    let catalog = f.catalog();
    for id in ["global:unknown", "project:review"] {
        let error = prepare_run(request(), &catalog, &[id.parse().unwrap()], &tools()).unwrap_err();
        assert_eq!(error.kind(), ContextErrorKind::UnknownSkill);
        assert_eq!(error.category(), "unknown_skill");
        assert_eq!(error.source_label(), Some(id));
    }
    for id in [
        "review",
        "../review",
        "/tmp/review",
        "global:../review",
        "global:review/SKILL.md",
    ] {
        assert!(id.parse::<SkillId>().is_err());
    }
    let forged = SkillId {
        scope: Scope::Global,
        name: "../../PRIVATE\nPATH".into(),
    };
    let error = prepare_run(request(), &catalog, &[forged], &tools()).unwrap_err();
    assert_eq!(error.kind(), ContextErrorKind::InvalidSkillId);
    assert_eq!(error.source_label(), None);
    assert!(!format!("{error} {error:?}").contains("PRIVATE"));
}

#[test]
fn context_prepare_selected_body_must_be_nonblank_utf8_and_bounded() {
    let f = Fixture::new();
    let file = f.skill(Scope::Global, "review", "description: Metadata", "BODY");
    let catalog = f.catalog();
    let selected = ["global:review".parse().unwrap()];
    for body in [
        b"".to_vec(),
        " \r\n\t\u{2003}".as_bytes().to_vec(),
        vec![0xff],
        vec![b'x'; MAX_INPUT_BYTES * 2],
    ] {
        let mut bytes = b"---\nname: review\ndescription: Metadata\n---\n".to_vec();
        bytes.extend_from_slice(&body);
        fs::write(&file, bytes).unwrap();
        // Neither discovery nor composition measures/parses an unselected body.
        let fresh = f.catalog();
        let unselected = prepare_run(request(), &fresh, &[], &tools()).unwrap();
        assert!(
            payload(&unselected)["active_skills"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let error = prepare_run(request(), &catalog, &selected, &tools()).unwrap_err();
        let expected = if body.len() > MAX_INPUT_BYTES {
            ContextErrorKind::InputTooLarge
        } else if body == [0xff] {
            ContextErrorKind::ReadFailed
        } else {
            ContextErrorKind::InvalidBody
        };
        assert_eq!(error.kind(), expected);
        assert_eq!(error.source_label(), Some("global:review/SKILL.md"));
    }
}

#[test]
fn context_prepare_file_limits_and_rendered_input_overhead_fail_without_truncation() {
    let f = Fixture::new();
    let catalog = f.catalog();
    let agents = f.roots.workspace.join("AGENTS.md");
    fs::write(&agents, "x".repeat(MAX_INPUT_BYTES + 1)).unwrap();
    let error = prepare_run(request(), &catalog, &[], &tools()).unwrap_err();
    assert_eq!(error.kind(), ContextErrorKind::InputTooLarge);
    assert_eq!(error.source_label(), Some("project:AGENTS.md"));

    // The file fits the read bound, but JSON encoding and InputItem both add bytes.
    for text in [
        "x".repeat(MAX_INPUT_BYTES),
        "\0".repeat(MAX_INPUT_BYTES / 6),
    ] {
        fs::write(&agents, text).unwrap();
        assert_eq!(
            prepare_run(request(), &catalog, &[], &tools())
                .unwrap_err()
                .kind(),
            ContextErrorKind::InputTooLarge
        );
    }
    fs::remove_file(agents).unwrap();
    let file = f.skill(
        Scope::Global,
        "review",
        "description: Metadata",
        "\"".repeat(MAX_INPUT_BYTES / 3).as_str(),
    );
    let catalog = f.catalog();
    let selected = ["global:review".parse().unwrap()];
    assert!(fs::metadata(file).unwrap().len() < MAX_INPUT_BYTES as u64);
    assert_eq!(
        prepare_run(request(), &catalog, &selected, &tools())
            .unwrap_err()
            .kind(),
        ContextErrorKind::InputTooLarge
    );
}

#[test]
fn context_prepare_oversized_mandatory_catalog_is_not_partially_included() {
    let f = Fixture::new();
    let yaml = format!(
        "description: Metadata\ncustom: {}",
        "x".repeat(MAX_INPUT_BYTES / 2)
    );
    f.skill(Scope::Global, "first", &yaml, "UNSELECTED_FIRST");
    f.skill(Scope::Global, "second", &yaml, "UNSELECTED_SECOND");
    let catalog = f.catalog();
    assert_eq!(catalog.entries().len(), 2);
    let error = prepare_run(request(), &catalog, &[], &tools()).unwrap_err();
    assert_eq!(error.kind(), ContextErrorKind::InputTooLarge);
    assert_eq!(error.category(), "input_too_large");
    assert_eq!(error.source_label(), None);
}

#[test]
fn context_prepare_uses_existing_one_item_input_byte_boundary() {
    let f = Fixture::new();
    let catalog = f.catalog();
    let overhead = serde_json::to_vec(&[InputItem::user("")]).unwrap().len();
    let mut original = request();
    original.prompt = "x".repeat(MAX_INPUT_BYTES - overhead);
    validate_input(&[InputItem::user(original.prompt.clone())]).unwrap();
    let prepared = prepare_run(original.clone(), &catalog, &[], &tools()).unwrap();
    assert_eq!(prepared.request().prompt, original.prompt);
    original.prompt.push('x');
    assert!(validate_input(&[InputItem::user(original.prompt.clone())]).is_err());
    assert_eq!(
        prepare_run(original, &catalog, &[], &tools())
            .unwrap_err()
            .kind(),
        ContextErrorKind::InputTooLarge
    );
}

struct SchemaTool;
#[async_trait]
impl Tool for SchemaTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "synthetic_schema".into(),
            description: "Synthetic schema validation only".into(),
            parameters: json!({"type":"object", "synthetic": "x".repeat(MAX_INPUT_BYTES / 4)}),
            strict: true,
        }
    }
    fn validate(&self, _: &Value) -> wi::Result<()> {
        panic!("preparation must not preflight calls")
    }
    async fn execute(&self, _: Value) -> wi::Result<Value> {
        panic!("preparation must not execute tools")
    }
}

#[test]
fn context_prepare_validates_framed_options_with_actual_tools_at_existing_limit() {
    let f = Fixture::new();
    f.skill(
        Scope::Global,
        "review",
        "description: Metadata",
        "UNSELECTED",
    );
    let catalog = f.catalog();
    let mut tools = tools();
    tools.register(Arc::new(SchemaTool)).unwrap();
    let mut original = request();
    let mut effective = original.options.clone();
    effective.instructions = FRAMING.into();
    effective.tools = tools.definitions();
    let overhead = serde_json::to_vec(&effective).unwrap().len();
    original.options.instructions = "x".repeat(MAX_INPUT_BYTES - overhead);
    effective.instructions = format!("{}{FRAMING}", original.options.instructions);
    effective.validate().unwrap();
    assert_eq!(
        serde_json::to_vec(&effective).unwrap().len(),
        MAX_INPUT_BYTES
    );
    let prepared = prepare_run(original.clone(), &catalog, &[], &tools).unwrap();
    assert!(prepared.request().options.tools.is_empty());
    assert_eq!(
        prepared.request().options.instructions,
        effective.instructions
    );
    original.options.instructions.push('x');
    original.options.validate().unwrap();
    let error = prepare_run(original, &catalog, &[], &tools).unwrap_err();
    assert_eq!(error.kind(), ContextErrorKind::InputTooLarge);
}

#[test]
fn context_prepare_rejects_blank_original_task_with_context_before_construction() {
    let f = Fixture::new();
    f.skill(Scope::Global, "review", "description: Metadata", "BODY");
    let catalog = f.catalog();
    for blank in ["", " \r\n\t\u{2003}"] {
        let mut original = request();
        original.prompt = blank.into();
        let error = prepare_run(original, &catalog, &[], &tools())
            .inspect(|_| panic!("provider/auth construction must remain unreachable"))
            .unwrap_err();
        assert_eq!(error.kind(), ContextErrorKind::InvalidRequest);
        assert_eq!(error.source_label(), None);
    }
}

#[test]
fn context_prepare_rejects_blank_original_instructions_with_context_before_construction() {
    let f = Fixture::new();
    fs::write(f.roots.workspace.join("AGENTS.md"), "PROJECT_POLICY").unwrap();
    let catalog = f.catalog();
    for blank in ["", " \r\n\t\u{2003}"] {
        let mut original = request();
        original.options.instructions = blank.into();
        let error = prepare_run(original, &catalog, &[], &tools())
            .inspect(|_| panic!("provider/auth construction must remain unreachable"))
            .unwrap_err();
        assert_eq!(error.kind(), ContextErrorKind::InvalidRequest);
        assert_eq!(error.source_label(), None);
    }
}

#[test]
fn context_prepare_preserves_selection_and_file_error_precedence_over_blank_request() {
    let f = Fixture::new();
    let file = f.skill(Scope::Global, "review", "description: Metadata", "BODY");
    let catalog = f.catalog();
    let mut original = request();
    original.prompt = " \n".into();
    original.options.instructions = " \t".into();
    let error = prepare_run(
        original.clone(),
        &catalog,
        &["global:unknown".parse().unwrap()],
        &tools(),
    )
    .unwrap_err();
    assert_eq!(error.kind(), ContextErrorKind::UnknownSkill);
    fs::remove_file(file).unwrap();
    let error = prepare_run(
        original,
        &catalog,
        &["global:review".parse().unwrap()],
        &tools(),
    )
    .unwrap_err();
    assert_eq!(error.kind(), ContextErrorKind::ReadFailed);
    assert_eq!(error.source_label(), Some("global:review/SKILL.md"));
}

#[test]
fn context_prepare_rejects_invalid_request_and_caller_supplied_tools() {
    let f = Fixture::new();
    let catalog = f.catalog();
    let mut cases = [request(), request(), request(), request()];
    cases[0].options.tools = tools().definitions();
    cases[1].options.model = " ".into();
    cases[2].options.instructions = " \t".into();
    cases[3].prompt = " \n".into();
    for request in cases {
        let error = prepare_run(request, &catalog, &[], &tools()).unwrap_err();
        assert_eq!(error.kind(), ContextErrorKind::InvalidRequest);
        assert_eq!(error.source_label(), None);
    }
}
