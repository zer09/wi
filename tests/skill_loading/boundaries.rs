use super::*;
use wi::{
    context::{ContextErrorKind, load_skill, prepare_run_with_skill_loading},
    provider::{MAX_INPUT_BYTES, validate_input},
};

#[tokio::test]
async fn known_load_failures_are_sanitized_correlated_error_results() {
    let header = "---\nname: review\ndescription: PRIVATE_METADATA\n---\n";
    for (bytes, kind) in [
        (
            b"---\nname: review\ndescription: CHANGED\n---\nBODY".to_vec(),
            ContextErrorKind::ContextChanged,
        ),
        (
            b"---\nname: [PRIVATE_PARSER_EXCERPT\n---\nBODY".to_vec(),
            ContextErrorKind::ContextChanged,
        ),
        (
            b"---\nname: review\ndescription: \xff\n---\n\xff".to_vec(),
            ContextErrorKind::ContextChanged,
        ),
        (
            format!("{header} \r\n\t").into_bytes(),
            ContextErrorKind::InvalidBody,
        ),
        (
            [header.as_bytes(), &[0xff]].concat(),
            ContextErrorKind::ReadFailed,
        ),
        (
            format!("{header}{}", "x".repeat(MAX_INPUT_BYTES)).into_bytes(),
            ContextErrorKind::InputTooLarge,
        ),
    ] {
        let f = Fixture::new();
        let file = f.skill(
            Scope::Global,
            "review",
            "name: review\ndescription: PRIVATE_METADATA",
            "BODY",
        );
        let catalog = f.catalog();
        let (_, mut registry) =
            prepare_run_with_skill_loading(request(), catalog.clone(), &[], &tools()).unwrap();
        fs::write(file, bytes).unwrap();
        let error = load_skill(&catalog, &"global:review".parse().unwrap()).unwrap_err();
        assert_eq!(error.kind(), kind);
        let debug = format!("{error:?} {error}");
        for secret in [
            "PRIVATE_METADATA",
            "PRIVATE_PARSER_EXCERPT",
            f.temp.path().to_str().unwrap(),
        ] {
            assert!(!debug.contains(secret));
        }
        let (output, events) = execute(&mut registry, "failed", "global:review").await;
        assert_eq!(output, "{\"error\":{\"code\":\"gateway_error\"}}");
        assert_eq!(events, finished_events("failed", true));
    }
}

#[tokio::test]
async fn whole_file_limit_precedes_serialized_output_limit_without_truncation() {
    let f = Fixture::new();
    let header = "---\nname: review\ndescription: Metadata\n---\n";
    let file = f.skill(
        Scope::Global,
        "review",
        "name: review\ndescription: Metadata",
        "BODY",
    );
    let catalog = f.catalog();
    let (_, mut registry) =
        prepare_run_with_skill_loading(request(), catalog.clone(), &[], &tools()).unwrap();
    let body = "x".repeat(MAX_INPUT_BYTES - header.len());
    fs::write(&file, format!("{header}{body}")).unwrap();
    let loaded = load_skill(&catalog, &"global:review".parse().unwrap()).unwrap();
    assert_eq!(loaded.body(), body);
    let (output, events) = execute(&mut registry, "at-file-limit", "global:review").await;
    assert_eq!(output, "{\"error\":{\"code\":\"tool_output_limit\"}}");
    assert_eq!(events, finished_events("at-file-limit", true));
    fs::write(file, format!("{header}{body}x")).unwrap();
    assert_eq!(
        load_skill(&catalog, &"global:review".parse().unwrap())
            .unwrap_err()
            .kind(),
        ContextErrorKind::InputTooLarge
    );
    let (output, events) = execute(&mut registry, "over-file-limit", "global:review").await;
    assert_eq!(output, "{\"error\":{\"code\":\"gateway_error\"}}");
    assert_eq!(events, finished_events("over-file-limit", true));
}

#[tokio::test]
async fn exactly_64_kib_is_allowed_escape_overhead_counts_and_output_errors_are_reused() {
    for escaping in [false, true] {
        let f = Fixture::new();
        let yaml = "name: review\ndescription: Metadata";
        let file = f.skill(Scope::Global, "review", yaml, "BODY");
        let catalog = f.catalog();
        let (_, mut registry) =
            prepare_run_with_skill_loading(request(), catalog.clone(), &[], &tools()).unwrap();
        let mut value = json!({"id":"global:review","frontmatter":{"name":"review","description":"Metadata"},"body":""});
        let available = 64 * 1024 - value.to_string().len();
        let mut body = String::new();
        if escaping {
            body = "\\\"\n\t".repeat(100);
        }
        let encoded = serde_json::to_string(&body).unwrap().len() - 2;
        body.push_str(&"x".repeat(available - encoded));
        f.skill(Scope::Global, "review", yaml, &body);
        value["body"] = json!(body);
        assert_eq!(value.to_string().len(), 64 * 1024);
        assert_eq!(
            load_skill(&catalog, &"global:review".parse().unwrap())
                .unwrap()
                .body(),
            body
        );
        let (exact, events) = execute(&mut registry, "exact", "global:review").await;
        assert_eq!(exact, value.to_string());
        assert_eq!(events, finished_events("exact", false));

        let combined: Vec<_> = (0..16)
            .map(|index| InputItem::ToolResult {
                call_id: format!("combined-{index}"),
                output: exact.clone(),
            })
            .collect();
        assert!(validate_input(&combined).is_err());
        body.push('x');
        f.skill(Scope::Global, "review", yaml, &body);
        assert!(load_skill(&catalog, &"global:review".parse().unwrap()).is_ok());
        let (oversized, events) = execute(&mut registry, "over", "global:review").await;
        assert_eq!(oversized, "{\"error\":{\"code\":\"tool_output_limit\"}}");
        assert_eq!(events, finished_events("over", true));
        fs::remove_file(file).unwrap();
        assert_eq!(
            execute(&mut registry, "exact", "global:review").await.0,
            exact
        );
        let (reused, events) = execute(&mut registry, "over", "global:review").await;
        assert_eq!(reused, oversized);
        assert_eq!(
            events,
            vec![json!({"type":"tool_result_reused","call_id":"over","tool_name":"load_skill"})]
        );
    }
}

#[tokio::test]
async fn concurrent_same_id_workspaces_keep_sources_results_and_catalogs_separate() {
    let first = Fixture::new();
    let second = Fixture::new();
    first.skill(
        Scope::Project,
        "review",
        "name: review\ndescription: First",
        "FIRST_PRIVATE_BODY",
    );
    second.skill(
        Scope::Project,
        "review",
        "name: review\ndescription: Second",
        "SECOND_PRIVATE_BODY",
    );
    let (first_prepared, mut first_tools) =
        prepare_run_with_skill_loading(request(), first.catalog(), &[], &tools()).unwrap();
    let (second_prepared, mut second_tools) =
        prepare_run_with_skill_loading(request(), second.catalog(), &[], &tools()).unwrap();
    let ((first_output, first_events), (second_output, second_events)) = tokio::join!(
        execute(&mut first_tools, "same", "project:review"),
        execute(&mut second_tools, "same", "project:review"),
    );
    for (prepared, output, expected) in [
        (&first_prepared, &first_output, "First"),
        (&second_prepared, &second_output, "Second"),
    ] {
        let payload: Value = serde_json::from_str(&prepared.request().prompt).unwrap();
        let result: Value = serde_json::from_str(output).unwrap();
        assert_eq!(
            payload["available_skills"][0]["frontmatter"],
            result["frontmatter"]
        );
        assert_eq!(result["frontmatter"]["description"], expected);
        assert_eq!(
            result["body"],
            format!("{}_PRIVATE_BODY", expected.to_uppercase())
        );
    }
    assert_eq!(first_events, finished_events("same", false));
    assert_eq!(second_events, finished_events("same", false));
    assert_ne!(first_output, second_output);
}
