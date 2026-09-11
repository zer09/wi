//! CLI-only root resolution and safe context output. No authentication dependency.
use std::{ffi::OsString, io::Write, path::PathBuf};
use wi::{
    GatewayError,
    context::{ContextDiagnostic, ContextError, ContextRoots, DiagnosticKind},
};

pub(crate) type CliResult<T> = std::result::Result<T, CliError>;

#[derive(Debug, thiserror::Error)]
pub(crate) enum CliError {
    #[error(transparent)]
    Gateway(#[from] GatewayError),
    #[error(transparent)]
    Context(#[from] ContextError),
    #[error("invalid_root: {0} (global:.)")]
    GlobalRoot(&'static str),
    #[error("read_failed: cannot resolve CLI working directory (project:.)")]
    WorkingDirectory,
    #[error("read_failed: context preparation task failed")]
    PreparationTask,
}

pub(crate) fn resolve_roots(workspace: Option<PathBuf>) -> CliResult<ContextRoots> {
    roots_from(
        std::env::current_dir,
        workspace,
        std::env::var_os("XDG_CONFIG_HOME"),
        std::env::var_os("HOME"),
    )
}

fn roots_from(
    cwd: impl FnOnce() -> std::io::Result<PathBuf>,
    workspace: Option<PathBuf>,
    xdg: Option<OsString>,
    home: Option<OsString>,
) -> CliResult<ContextRoots> {
    // Query cwd only when needed. Discovery alone canonicalizes the selected boundaries.
    let workspace = match workspace {
        Some(path) if path.is_absolute() => path,
        Some(path) => cwd().map_err(|_| CliError::WorkingDirectory)?.join(path),
        None => cwd().map_err(|_| CliError::WorkingDirectory)?,
    };
    let global_skills = if let Some(xdg) = xdg.filter(|value| !value.is_empty()) {
        let xdg = PathBuf::from(xdg);
        if !xdg.is_absolute() {
            return Err(CliError::GlobalRoot("XDG_CONFIG_HOME must be absolute"));
        }
        xdg.join("wi/skills")
    } else {
        let home = home.filter(|value| !value.is_empty()).map(PathBuf::from);
        let home = home
            .filter(|path| path.is_absolute())
            .ok_or(CliError::GlobalRoot(
                "HOME must be nonempty and absolute when XDG_CONFIG_HOME is unset or empty",
            ))?;
        home.join(".config/wi/skills")
    };
    Ok(ContextRoots {
        workspace,
        global_skills,
    })
}

pub(crate) fn filtered(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).collect()
}

pub(crate) fn diagnostic_category(diagnostic: &ContextDiagnostic) -> &'static str {
    match diagnostic.kind() {
        DiagnosticKind::Excluded(kind) => kind.category(),
        DiagnosticKind::SkippedSymlink => "skipped_symlink",
        DiagnosticKind::DirectoryNameMismatch => "directory_name_mismatch",
        DiagnosticKind::UnsupportedBehavioralMetadata => "unsupported_behavioral_metadata",
    }
}

pub(crate) fn emit_diagnostics(
    out: &mut impl Write,
    diagnostics: &[ContextDiagnostic],
) -> CliResult<()> {
    for diagnostic in diagnostics {
        writeln!(
            out,
            "context: {}: {} ({})",
            diagnostic_category(diagnostic),
            diagnostic.message(),
            filtered(diagnostic.source_label()),
        )
        .map_err(|error| GatewayError::Io(error.kind()))?;
    }
    out.flush()
        .map_err(|error| GatewayError::Io(error.kind()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, io::ErrorKind};

    #[test]
    fn context_cli_roots_resolve_both_environment_routes_and_workspace_once() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("cwd");
        let home = temp.path().join("home");
        let xdg = temp.path().join("config");
        let calls = Cell::new(0);
        let current_dir = || {
            calls.set(calls.get() + 1);
            Ok(cwd.clone())
        };
        let roots = roots_from(
            current_dir,
            Some("child/../project".into()),
            Some(xdg.clone().into_os_string()),
            None,
        )
        .unwrap();
        assert_eq!(roots.workspace, cwd.join("child/../project"));
        assert_eq!(roots.global_skills, xdg.join("wi/skills"));
        assert_eq!(calls.get(), 1);
        for xdg in [None, Some(OsString::new())] {
            calls.set(0);
            let roots =
                roots_from(current_dir, None, xdg, Some(home.clone().into_os_string())).unwrap();
            assert_eq!(roots.workspace, cwd);
            assert_eq!(roots.global_skills, home.join(".config/wi/skills"));
            assert_eq!(calls.get(), 1);
        }
        calls.set(0);
        let roots = roots_from(
            current_dir,
            Some(home.clone()),
            Some(xdg.into_os_string()),
            Some("ignored-relative-home".into()),
        )
        .unwrap();
        assert_eq!(roots.workspace, home);
        assert_eq!(calls.get(), 0);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[test]
    fn context_cli_unavailable_cwd_is_ignored_only_for_absolute_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let absolute = temp.path().join("child/../workspace");
        for kind in [ErrorKind::NotFound, ErrorKind::PermissionDenied] {
            for workspace in [None, Some("relative".into()), Some(absolute.clone())] {
                let calls = Cell::new(0);
                let result = roots_from(
                    || {
                        calls.set(calls.get() + 1);
                        Err(std::io::Error::new(kind, "private-cwd\x1b"))
                    },
                    workspace.clone(),
                    Some(temp.path().join("config").into_os_string()),
                    None,
                );
                if workspace == Some(absolute.clone()) {
                    let roots = result.unwrap();
                    assert_eq!(roots.workspace, absolute);
                    assert_eq!(roots.global_skills, temp.path().join("config/wi/skills"));
                    assert_eq!(calls.get(), 0);
                } else {
                    let error = result.unwrap_err();
                    assert!(matches!(error, CliError::WorkingDirectory));
                    assert_eq!(
                        error.to_string(),
                        "read_failed: cannot resolve CLI working directory (project:.)"
                    );
                    assert_eq!(calls.get(), 1);
                }
            }
        }
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[test]
    fn context_cli_invalid_environment_is_explicit_and_sanitized() {
        let temp = tempfile::tempdir().unwrap();
        for (xdg, home) in [
            (
                Some("relative-private\x1b".into()),
                Some(temp.path().as_os_str().to_owned()),
            ),
            (None, None),
            (Some(OsString::new()), None),
            (None, Some(OsString::new())),
            (None, Some("relative-private\x1b".into())),
        ] {
            for workspace in [None, Some(temp.path().join("workspace"))] {
                let error = roots_from(
                    || Ok(temp.path().to_owned()),
                    workspace,
                    xdg.clone(),
                    home.clone(),
                )
                .unwrap_err();
                let text = error.to_string();
                assert!(text.starts_with("invalid_root:"));
                assert!(text.ends_with("(global:.)"));
                assert!(!text.contains("private"));
                assert!(!text.chars().any(char::is_control));
                assert!(!text.contains(&temp.path().display().to_string()));
            }
        }
    }
}
