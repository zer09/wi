use super::{Fixture, request, tools};
use std::fs;

use wi::context::{Scope, prepare_run};

#[test]
fn context_prepare_debug_and_errors_do_not_expose_content_or_host_paths() {
    let f = Fixture::new();
    f.skill(
        Scope::Global,
        "private-skill-name",
        "description: PRIVATE_DESCRIPTION",
        "PRIVATE_BODY",
    );
    f.skill(
        Scope::Project,
        "private-unselected-name",
        "description: PRIVATE_UNSELECTED_DESCRIPTION",
        "PRIVATE_UNSELECTED_BODY",
    );
    fs::write(f.roots.workspace.join("AGENTS.md"), "PRIVATE_POLICY").unwrap();
    let prepared = prepare_run(
        request(),
        &f.catalog(),
        &["global:private-skill-name".parse().unwrap()],
        &tools(),
    )
    .unwrap();
    assert_eq!(
        format!("{:?}", prepared.manifest()),
        "ContextManifest { available_skills: 2, active_skills: 1, project_instructions: 1 }"
    );
    let debug = format!("{prepared:?} {:?}", prepared.manifest());
    for private in [
        "private-skill-name",
        "private-unselected-name",
        "PRIVATE_DESCRIPTION",
        "PRIVATE_UNSELECTED_DESCRIPTION",
        "PRIVATE_BODY",
        "PRIVATE_UNSELECTED_BODY",
        "PRIVATE_POLICY",
        "project:AGENTS.md",
        &request().prompt,
        &request().options.instructions,
        f.temp.path().to_str().unwrap(),
    ] {
        assert!(!debug.contains(private));
    }
}
