use super::{FRAMING, Fixture, payload, request, tools};
use std::fs;

use serde_json::json;
use wi::context::{ContextErrorKind, Scope, prepare_run};

#[test]
fn context_prepare_catalog_only_never_reopens_unselected_files() {
    let f = Fixture::new();
    let file = f.skill(
        Scope::Global,
        "review",
        "description: ONLY_METADATA",
        "UNSELECTED_BODY",
    );
    let catalog = f.catalog();
    fs::remove_file(file).unwrap();
    let prepared = prepare_run(request(), &catalog, &[], &tools()).unwrap();
    assert_eq!(
        payload(&prepared),
        json!({
            "task":request().prompt,
            "project_instructions":null,
            "available_skills":[{"id":"global:review","frontmatter":{"name":"review","description":"ONLY_METADATA"}}],
            "active_skills":[]
        })
    );
    assert_eq!(
        prepared.request().options.instructions,
        format!("{}{FRAMING}", request().options.instructions)
    );
    assert_eq!(
        prepared.manifest().available_skills(),
        &["global:review".parse().unwrap()]
    );
    assert_eq!(
        prepared.manifest().available_skills()[0].to_string(),
        payload(&prepared)["available_skills"][0]["id"]
            .as_str()
            .unwrap()
    );
    assert!(prepared.manifest().active_skills().is_empty());
    assert_eq!(prepared.manifest().project_instructions_source(), None);
}

#[test]
fn context_prepare_revalidates_metadata_and_keeps_an_owned_body_snapshot() {
    let f = Fixture::new();
    let file = f.skill(
        Scope::Global,
        "review",
        "description: Original\ncustom: {a: 1, z: 2}",
        "OLD_BODY",
    );
    let catalog = f.catalog();
    let selected = ["global:review".parse().unwrap()];
    fs::write(&file, "\u{feff}---\r\ncustom: {z: 2, a: 1}\r\ndescription: Original\r\nname: review\r\n---\r\n\r\nEDITED_BODY\r\n").unwrap();
    let prepared = prepare_run(request(), &catalog, &selected, &tools()).unwrap();
    assert_eq!(
        payload(&prepared)["active_skills"][0]["body"],
        "\r\nEDITED_BODY\r\n"
    );
    let snapshot = prepared.request().prompt.clone();
    for yaml in [
        "name: review\ndescription: Changed",
        "name: renamed\ndescription: Original",
        "name: review\ndescription: Original\ncustom: {a: 1, z: 3}",
        "name: review\ndescription: [invalid]",
        "invalid",
    ] {
        fs::write(&file, format!("---\n{yaml}\n---\nLATER_BODY")).unwrap();
        let error = prepare_run(request(), &catalog, &selected, &tools()).unwrap_err();
        assert_eq!(error.kind(), ContextErrorKind::ContextChanged);
        assert_eq!(error.category(), "context_changed");
        assert_eq!(error.source_label(), Some("global:review/SKILL.md"));
        assert_eq!(prepared.request().prompt, snapshot);
    }
    fs::write(
        &file,
        "---\nname: review\ndescription: Changed\n---\nLATER_BODY",
    )
    .unwrap();
    let fresh = prepare_run(request(), &f.catalog(), &selected, &tools()).unwrap();
    assert_eq!(payload(&fresh)["active_skills"][0]["body"], "LATER_BODY");
    assert_eq!(
        payload(&fresh)["available_skills"][0]["frontmatter"]["description"],
        "Changed"
    );
    fs::remove_file(file).unwrap();
    drop(catalog);
    drop(f);
    assert_eq!(prepared.into_request().prompt, snapshot);
}

#[test]
fn context_prepare_revalidates_frontmatter_before_decoding_selected_body() {
    let f = Fixture::new();
    let file = f.skill(Scope::Global, "review", "description: Metadata", "BODY");
    let catalog = f.catalog();
    let selected = ["global:review".parse().unwrap()];
    for bytes in [
        b"---\nname: review\ndescription: \xff\n---\nBODY".as_slice(),
        b"---\nname: review\ndescription: Changed\n---\n\xff".as_slice(),
    ] {
        fs::write(&file, bytes).unwrap();
        let error = prepare_run(request(), &catalog, &selected, &tools()).unwrap_err();
        assert_eq!(error.kind(), ContextErrorKind::ContextChanged);
        assert_eq!(error.source_label(), Some("global:review/SKILL.md"));
    }
}

#[test]
fn context_prepare_simultaneous_workspaces_share_only_explicit_global_metadata() {
    let first = Fixture::new();
    let mut second = Fixture::new();
    first.skill(
        Scope::Global,
        "review",
        "description: Shared global metadata",
        "GLOBAL_BODY",
    );
    second.roots.global_skills = first.roots.global_skills.clone();
    first.skill(
        Scope::Project,
        "review",
        "description: First project metadata",
        "FIRST_BODY",
    );
    second.skill(
        Scope::Project,
        "review",
        "description: Second project metadata",
        "SECOND_BODY",
    );
    fs::write(first.roots.workspace.join("AGENTS.md"), "FIRST_POLICY").unwrap();
    fs::write(second.roots.workspace.join("AGENTS.md"), "SECOND_POLICY").unwrap();
    let cwd = std::env::current_dir().unwrap();
    let barrier = std::sync::Barrier::new(2);
    let results = std::thread::scope(|scope| {
        let handles: Vec<_> = [&first, &second]
            .into_iter()
            .map(|fixture| {
                let barrier = &barrier;
                scope.spawn(move || {
                    let catalog = fixture.catalog();
                    barrier.wait();
                    prepare_run(
                        request(),
                        &catalog,
                        &["project:review".parse().unwrap()],
                        &tools(),
                    )
                    .unwrap()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>()
    });
    for (index, expected) in ["FIRST", "SECOND"].into_iter().enumerate() {
        let value = payload(&results[index]);
        assert_eq!(
            value["active_skills"][0]["body"],
            format!("{expected}_BODY")
        );
        assert_eq!(
            value["project_instructions"]["text"],
            format!("{expected}_POLICY")
        );
        assert_eq!(value["available_skills"][0]["id"], "global:review");
        assert!(!results[index].request().prompt.contains("GLOBAL_BODY"));
    }
    assert_eq!(std::env::current_dir().unwrap(), cwd);
    let later = prepare_run(request(), &Fixture::new().catalog(), &[], &tools()).unwrap();
    assert_eq!(later.request().prompt, request().prompt);
}
