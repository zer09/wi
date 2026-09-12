use super::{Fixture, request, tools};
use std::fs;

use serde_json::json;
use wi::context::{ContextErrorKind, Scope, SkillId, load_skill, prepare_run};

#[test]
fn shared_loader_preserves_scoped_identity_frontmatter_and_owned_body() {
    let f = Fixture::new();
    let body = " \r\n# Instructions\r\n\tπ \"quoted\" \\ text\n  ";
    let yaml = "name: review\ndescription: PRIVATE_METADATA\ncustom: {z: [second, first], a: {y: 2, b: 1}}";
    let global = f.skill(Scope::Global, "different-directory", yaml, body);
    f.skill(Scope::Project, "review", yaml, "PROJECT_BODY");
    let catalog = f.catalog();
    let id = "global:review".parse().unwrap();
    let loaded = load_skill(&catalog, &id).unwrap();
    assert_eq!(loaded.id(), &id);
    assert_eq!(
        loaded.frontmatter(),
        &json!({
            "name":"review", "description":"PRIVATE_METADATA",
            "custom":{"z":["second","first"],"a":{"y":2,"b":1}}
        })
    );
    assert_eq!(loaded.body(), body);
    assert_eq!(
        load_skill(&catalog, &"project:review".parse().unwrap())
            .unwrap()
            .body(),
        "PROJECT_BODY"
    );
    let prepared = prepare_run(request(), &catalog, &[id], &tools()).unwrap();
    let payload: serde_json::Value = serde_json::from_str(&prepared.request().prompt).unwrap();
    assert_eq!(payload["active_skills"][0]["body"], body);
    fs::remove_file(global).unwrap();
    assert_eq!(loaded.body(), body);
    let debug = format!("{loaded:?} {catalog:?}");
    for secret in [
        body,
        "PRIVATE_METADATA",
        f.temp.path().to_str().unwrap(),
        "different-directory",
    ] {
        assert!(!debug.contains(secret));
    }
}

#[test]
fn directly_constructed_invalid_ids_and_unknown_ids_never_select_paths() {
    let f = Fixture::new();
    f.skill(
        Scope::Global,
        "review",
        "name: review\ndescription: Known",
        "BODY",
    );
    let catalog = f.catalog();
    for name in [
        "",
        "../review",
        "review/SKILL.md",
        "/tmp/private",
        "UPPER",
        "a--b",
        "private\npath",
    ] {
        let error = load_skill(
            &catalog,
            &SkillId {
                scope: Scope::Global,
                name: name.into(),
            },
        )
        .unwrap_err();
        assert_eq!(error.kind(), ContextErrorKind::InvalidSkillId);
        assert_eq!(error.source_label(), None);
        assert_eq!(error.scope(), None);
    }
    for id in ["project:review", "global:unknown"] {
        let error = load_skill(&catalog, &id.parse().unwrap()).unwrap_err();
        assert_eq!(error.kind(), ContextErrorKind::UnknownSkill);
        assert_eq!(error.source_label(), Some(id));
    }
}

#[test]
fn all_selected_ids_precede_project_and_body_io_and_keep_error_order() {
    let f = Fixture::new();
    let file = f.skill(
        Scope::Global,
        "review",
        "name: review\ndescription: Known",
        "BODY",
    );
    let catalog = f.catalog();
    fs::remove_file(file).unwrap();
    fs::create_dir(f.roots.workspace.join("AGENTS.md")).unwrap();
    let known: SkillId = "global:review".parse().unwrap();
    for (later, kind) in [
        (
            "global:unknown".parse().unwrap(),
            ContextErrorKind::UnknownSkill,
        ),
        (
            SkillId {
                scope: Scope::Project,
                name: "../private".into(),
            },
            ContextErrorKind::InvalidSkillId,
        ),
    ] {
        let error =
            prepare_run(request(), &catalog, &[known.clone(), later], &tools()).unwrap_err();
        assert_eq!(error.kind(), kind);
    }
    let error = prepare_run(request(), &catalog, &[known], &tools()).unwrap_err();
    assert_eq!(error.kind(), ContextErrorKind::ReadFailed);
    assert_eq!(error.source_label(), Some("project:AGENTS.md"));
}
