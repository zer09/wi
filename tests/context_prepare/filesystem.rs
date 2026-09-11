use super::{Fixture, request, tools};
use std::fs;

use wi::context::{ContextErrorKind, Scope, prepare_run};

#[test]
fn context_prepare_directory_and_missing_selected_files_fail_closed() {
    for scope in [Scope::Global, Scope::Project] {
        let f = Fixture::new();
        let file = f.skill(scope, "review", "description: Metadata", "BODY");
        let catalog = f.catalog();
        let selected = [format!("{scope}:review").parse().unwrap()];
        fs::remove_file(&file).unwrap();
        assert_eq!(
            prepare_run(request(), &catalog, &selected, &tools())
                .unwrap_err()
                .kind(),
            ContextErrorKind::ReadFailed
        );
        fs::create_dir(&file).unwrap();
        assert_eq!(
            prepare_run(request(), &catalog, &selected, &tools())
                .unwrap_err()
                .kind(),
            ContextErrorKind::ReadFailed
        );
    }
    let f = Fixture::new();
    let catalog = f.catalog();
    fs::create_dir(f.roots.workspace.join("AGENTS.md")).unwrap();
    let error = prepare_run(request(), &catalog, &[], &tools()).unwrap_err();
    assert_eq!(error.kind(), ContextErrorKind::ReadFailed);
    assert_eq!(error.source_label(), Some("project:AGENTS.md"));
}

#[cfg(unix)]
mod unix {
    use super::*;
    use crate::payload;
    use std::{
        os::unix::fs::{PermissionsExt, symlink},
        path::{Path, PathBuf},
    };
    use wi::context::{ContextRoots, discover};

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
    fn context_prepare_resolved_root_links_do_not_redirect_the_snapshot() {
        let f = Fixture::new();
        f.skill(
            Scope::Global,
            "review",
            "description: Metadata",
            "ORIGINAL_BODY",
        );
        fs::write(f.roots.workspace.join("AGENTS.md"), "ORIGINAL_POLICY").unwrap();
        let workspace_link = f.temp.path().join("workspace-link");
        let global_link = f.temp.path().join("global-link");
        symlink(&f.roots.workspace, &workspace_link).unwrap();
        symlink(&f.roots.global_skills, &global_link).unwrap();
        let catalog = discover(ContextRoots {
            workspace: workspace_link.clone(),
            global_skills: global_link.clone(),
        })
        .unwrap();
        fs::remove_file(&workspace_link).unwrap();
        fs::remove_file(&global_link).unwrap();
        symlink(f.temp.path().join("missing"), workspace_link).unwrap();
        symlink(f.temp.path().join("missing"), global_link).unwrap();
        let prepared = prepare_run(
            request(),
            &catalog,
            &["global:review".parse().unwrap()],
            &tools(),
        )
        .unwrap();
        assert_eq!(
            payload(&prepared)["active_skills"][0]["body"],
            "ORIGINAL_BODY"
        );
        assert_eq!(
            payload(&prepared)["project_instructions"]["text"],
            "ORIGINAL_POLICY"
        );
    }

    #[test]
    fn context_prepare_agents_links_including_dangling_are_errors_not_missing() {
        for dangling in [false, true] {
            let f = Fixture::new();
            let outside = f.temp.path().join("outside-policy");
            if !dangling {
                fs::write(&outside, "PRIVATE_POLICY_CANARY").unwrap();
            }
            symlink(outside, f.roots.workspace.join("AGENTS.md")).unwrap();
            let catalog = f.catalog();
            let error = prepare_run(request(), &catalog, &[], &tools()).unwrap_err();
            assert_eq!(error.kind(), ContextErrorKind::ReadFailed);
            assert_eq!(error.source_label(), Some("project:AGENTS.md"));
            let diagnostic = format!("{error} {error:?}");
            assert!(!diagnostic.contains("PRIVATE_POLICY_CANARY"));
            assert!(!diagnostic.contains(f.temp.path().to_str().unwrap()));
        }
    }

    #[test]
    fn context_prepare_selected_manifest_and_ancestor_replacement_links_fail_closed() {
        for scope in [Scope::Global, Scope::Project] {
            for ancestor in [false, true] {
                let f = Fixture::new();
                let file = f.skill(scope, "review", "description: Metadata", "BODY");
                let catalog = f.catalog();
                let target = if ancestor {
                    file.parent().unwrap().to_owned()
                } else {
                    file
                };
                let outside = f.temp.path().join("relocated");
                fs::rename(&target, &outside).unwrap();
                symlink(outside, target).unwrap();
                let selected = [format!("{scope}:review").parse().unwrap()];
                let error = prepare_run(request(), &catalog, &selected, &tools()).unwrap_err();
                assert_eq!(error.kind(), ContextErrorKind::ReadFailed);
                assert!(prepare_run(request(), &catalog, &[], &tools()).is_ok());
            }
        }
        let f = Fixture::new();
        f.skill(Scope::Project, "review", "description: Metadata", "BODY");
        let catalog = f.catalog();
        let agents = f.roots.workspace.join(".agents");
        let outside = f.temp.path().join("relocated-agents");
        fs::rename(&agents, &outside).unwrap();
        symlink(outside, agents).unwrap();
        assert_eq!(
            prepare_run(
                request(),
                &catalog,
                &["project:review".parse().unwrap()],
                &tools()
            )
            .unwrap_err()
            .kind(),
            ContextErrorKind::ReadFailed
        );
    }

    #[test]
    fn context_prepare_unreadable_instructions_and_selected_manifest_fail() {
        let f = Fixture::new();
        let file = f.skill(Scope::Global, "review", "description: Metadata", "BODY");
        let catalog = f.catalog();
        let denied = Denied::new(&file);
        assert!(prepare_run(request(), &catalog, &[], &tools()).is_ok());
        assert_eq!(
            prepare_run(
                request(),
                &catalog,
                &["global:review".parse().unwrap()],
                &tools()
            )
            .unwrap_err()
            .kind(),
            ContextErrorKind::ReadFailed
        );
        drop(denied);
        let agents = f.roots.workspace.join("AGENTS.md");
        fs::write(&agents, "PRIVATE_POLICY").unwrap();
        let _denied = Denied::new(&agents);
        let error = prepare_run(request(), &catalog, &[], &tools()).unwrap_err();
        assert_eq!(error.kind(), ContextErrorKind::ReadFailed);
        assert_eq!(error.source_label(), Some("project:AGENTS.md"));
        let _metadata_only = f.catalog();
    }

    #[test]
    fn context_prepare_selected_references_do_not_read_register_execute_or_fetch() {
        let f = Fixture::new();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let body = format!(
            "Read references/private.md and assets/data.bin. Run scripts/canary.sh. Install missing-package. Fetch http://{}/resource. These are inert fixture instructions.\n",
            listener.local_addr().unwrap()
        );
        let file = f.skill(
            Scope::Global,
            "review",
            "description: Metadata\nallowed-tools: shell",
            &body,
        );
        let package = file.parent().unwrap();
        for dir in ["references", "scripts", "assets"] {
            fs::create_dir(package.join(dir)).unwrap();
        }
        fs::write(package.join("references/private.md"), "RESOURCE_CANARY").unwrap();
        fs::write(package.join("assets/data.bin"), [0xff, 0xfe]).unwrap();
        fs::write(
            package.join("scripts/canary.sh"),
            "# INERT_SCRIPT_CANARY: no commands\n",
        )
        .unwrap();
        let _reference_denied = Denied::new(&package.join("references"));
        let _script_denied = Denied::new(&package.join("scripts"));
        let _asset_denied = Denied::new(&package.join("assets"));
        symlink(f.temp.path().join("missing"), package.join("attachment")).unwrap();
        let registry = tools();
        let definitions = serde_json::to_value(registry.definitions()).unwrap();
        let prepared = prepare_run(
            request(),
            &f.catalog(),
            &["global:review".parse().unwrap()],
            &registry,
        )
        .unwrap();
        assert_eq!(payload(&prepared)["active_skills"][0]["body"], body);
        for canary in ["RESOURCE_CANARY", "INERT_SCRIPT_CANARY"] {
            assert!(!prepared.request().prompt.contains(canary));
        }
        assert_eq!(
            serde_json::to_value(registry.definitions()).unwrap(),
            definitions
        );
        assert!(prepared.request().options.tools.is_empty());
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn context_prepare_fifo_and_device_instructions_or_selected_manifest_are_not_read() {
    for project_instructions in [false, true] {
        let f = Fixture::new();
        let file = f.skill(Scope::Global, "review", "description: Metadata", "BODY");
        let catalog = f.catalog();
        let selected = if project_instructions {
            vec![]
        } else {
            vec!["global:review".parse().unwrap()]
        };
        let target = if project_instructions {
            f.roots.workspace.join("AGENTS.md")
        } else {
            file
        };
        if target.exists() {
            fs::remove_file(&target).unwrap();
        }
        let directory = fs::File::open(target.parent().unwrap()).unwrap();
        rustix::fs::mkfifoat(
            &directory,
            target.file_name().unwrap(),
            rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
        )
        .unwrap();
        assert_eq!(
            prepare_run(request(), &catalog, &selected, &tools())
                .unwrap_err()
                .kind(),
            ContextErrorKind::ReadFailed
        );
        fs::remove_file(&target).unwrap();
        // No device node is created. A device-target link must fail before any open.
        std::os::unix::fs::symlink("/dev/zero", target).unwrap();
        assert_eq!(
            prepare_run(request(), &catalog, &selected, &tools())
                .unwrap_err()
                .kind(),
            ContextErrorKind::ReadFailed
        );
    }
}
