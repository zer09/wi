use super::{Fixture, ids};

use wi::context::{Scope, discover};

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
