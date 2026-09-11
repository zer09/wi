use super::Fixture;
#[cfg(unix)]
use super::ids;
use std::{fs, path::PathBuf};

use wi::context::{ContextErrorKind, ContextRoots, discover};
#[cfg(unix)]
use wi::context::{DiagnosticKind, Scope};

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

#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        os::unix::fs::{PermissionsExt, symlink},
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

    // The macOS runner rejects this name before discovery; exercise it on Linux.
    #[cfg(target_os = "linux")]
    #[test]
    fn context_catalog_non_utf8_traversal_names_fail_without_lossy_labels() {
        use std::os::unix::ffi::OsStringExt;

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
