//! Local skill discovery and run preparation from explicit, host-selected roots.
//!
//! Roots belong to a trusted owner. Descendant links and special files are
//! rejected before reads. Unix final opens use O_NOFOLLOW and O_NONBLOCK;
//! Windows final opens retain reparse points so they can be rejected. Other
//! platforms have only pre/post-open checks. Ancestor replacement races remain:
//! this is not a hostile-filesystem sandbox or a hardlink-isolation boundary.

mod frontmatter;
mod preparation;

pub use preparation::{ContextManifest, PreparedRun, prepare_run};

use std::{
    collections::BTreeMap,
    fmt,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, BufReader},
    path::{Component, Path, PathBuf},
    str::FromStr,
};

use serde_json::Value;

#[derive(Clone)]
pub struct ContextRoots {
    pub workspace: PathBuf,
    pub global_skills: PathBuf,
}

impl fmt::Debug for ContextRoots {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ContextRoots { paths: [redacted] }")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Scope {
    Global,
    Project,
}

impl fmt::Display for Scope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Global => "global",
            Self::Project => "project",
        })
    }
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SkillId {
    pub scope: Scope,
    pub name: String,
}

impl fmt::Debug for SkillId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SkillId")
            .field("scope", &self.scope)
            .field("name", &"[redacted]")
            .finish()
    }
}

impl fmt::Display for SkillId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.scope, self.name)
    }
}

impl FromStr for SkillId {
    type Err = ContextError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let invalid = || ContextError {
            kind: ContextErrorKind::InvalidSkillId,
            scope: None,
            source: None,
        };
        let (scope, name) = value.split_once(':').ok_or_else(invalid)?;
        let scope = match scope {
            "global" => Scope::Global,
            "project" => Scope::Project,
            _ => return Err(invalid()),
        };
        if !valid_name(name) {
            return Err(invalid());
        }
        Ok(Self {
            scope,
            name: name.to_owned(),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ContextErrorKind {
    InvalidRoot,
    ReadFailed,
    InvalidFrontmatter,
    DuplicateSkill,
    InvalidSkillId,
    UnknownSkill,
    ContextChanged,
    InvalidBody,
    InvalidRequest,
    InputTooLarge,
}

impl ContextErrorKind {
    pub fn category(self) -> &'static str {
        match self {
            Self::InvalidRoot => "invalid_root",
            Self::ReadFailed => "read_failed",
            Self::InvalidFrontmatter => "invalid_frontmatter",
            Self::DuplicateSkill => "duplicate_skill",
            Self::InvalidSkillId => "invalid_skill_id",
            Self::UnknownSkill => "unknown_skill",
            Self::ContextChanged => "context_changed",
            Self::InvalidBody => "invalid_body",
            Self::InvalidRequest => "invalid_request",
            Self::InputTooLarge => "input_too_large",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidRoot => "expected an explicit absolute directory root",
            Self::ReadFailed => "source is unreadable or is not a safe regular file or directory",
            Self::InvalidFrontmatter => "skill frontmatter is invalid or unsupported",
            Self::DuplicateSkill => {
                "multiple skill files have the same validated name in this scope"
            }
            Self::InvalidSkillId => "expected a qualified global or project skill name",
            Self::UnknownSkill => "selected skill is not in the catalog",
            Self::ContextChanged => "skill frontmatter changed; discover a fresh catalog",
            Self::InvalidBody => "selected skill requires a nonblank Markdown body",
            Self::InvalidRequest => "effective run input or session configuration is invalid",
            Self::InputTooLarge => "context exceeds the input byte limit",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextError {
    kind: ContextErrorKind,
    scope: Option<Scope>,
    source: Option<String>,
}

impl ContextError {
    pub fn kind(&self) -> ContextErrorKind {
        self.kind
    }

    pub fn category(&self) -> &'static str {
        self.kind.category()
    }

    pub fn scope(&self) -> Option<Scope> {
        self.scope
    }

    pub fn source_label(&self) -> Option<&str> {
        self.source.as_deref()
    }
}

impl fmt::Display for ContextError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.category(), self.kind.message())?;
        if let Some(source) = &self.source {
            write!(f, " ({source})")?;
        }
        Ok(())
    }
}

impl std::error::Error for ContextError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum DiagnosticKind {
    Excluded(ContextErrorKind),
    SkippedSymlink,
    DirectoryNameMismatch,
    UnsupportedBehavioralMetadata,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextDiagnostic {
    scope: Scope,
    source: String,
    kind: DiagnosticKind,
}

impl ContextDiagnostic {
    pub fn scope(&self) -> Scope {
        self.scope
    }

    pub fn source_label(&self) -> &str {
        &self.source
    }

    pub fn kind(&self) -> DiagnosticKind {
        self.kind
    }

    pub fn message(&self) -> &'static str {
        match self.kind {
            DiagnosticKind::Excluded(kind) => kind.message(),
            DiagnosticKind::SkippedSymlink => "descendant link was skipped",
            DiagnosticKind::DirectoryNameMismatch => "skill name differs from its directory name",
            DiagnosticKind::UnsupportedBehavioralMetadata => {
                "behavioral metadata is retained as data only and is not enforced"
            }
        }
    }
}

pub struct SkillMetadata {
    id: SkillId,
    frontmatter: Value,
    source: SkillSource,
}

impl SkillMetadata {
    pub fn id(&self) -> &SkillId {
        &self.id
    }

    pub fn description(&self) -> &str {
        self.frontmatter["description"]
            .as_str()
            .expect("validated description")
    }

    /// Explicit access to sensitive user data, not ordinary telemetry.
    pub fn frontmatter(&self) -> &Value {
        &self.frontmatter
    }

    pub fn source_label(&self) -> String {
        self.source.label()
    }
}

impl fmt::Debug for SkillMetadata {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SkillMetadata { content: [redacted], source: [redacted] }")
    }
}

pub struct SkillCatalog {
    workspace: PathBuf,
    global_skills: Option<PathBuf>,
    entries: Vec<SkillMetadata>,
    diagnostics: Vec<ContextDiagnostic>,
}

impl SkillCatalog {
    pub fn entries(&self) -> &[SkillMetadata] {
        &self.entries
    }

    pub fn diagnostics(&self) -> &[ContextDiagnostic] {
        &self.diagnostics
    }
}

impl fmt::Debug for SkillCatalog {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SkillCatalog")
            .field("entries", &self.entries.len())
            .field("diagnostics", &self.diagnostics.len())
            .finish_non_exhaustive()
    }
}

// These host paths never cross the public metadata boundary.
struct SkillSource {
    scope: Scope,
    root: PathBuf,
    relative: PathBuf,
}

impl SkillSource {
    fn label(&self) -> String {
        let relative = self
            .relative
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        let relative = if relative.is_empty() { "." } else { &relative };
        // Keep labels relative and single-line even for unusual owner filenames.
        let escaped: String = relative.chars().flat_map(char::escape_debug).collect();
        format!("{}:{escaped}", self.scope)
    }

    fn error(&self, kind: ContextErrorKind) -> ContextError {
        ContextError {
            kind,
            scope: Some(self.scope),
            source: Some(self.label()),
        }
    }

    fn diagnostic(&self, kind: DiagnosticKind) -> ContextDiagnostic {
        ContextDiagnostic {
            scope: self.scope,
            source: self.label(),
            kind,
        }
    }

    fn checked_path(&self, directory: bool) -> Result<PathBuf, ContextErrorKind> {
        let mut path = self.root.clone();
        for component in self.relative.components() {
            let Component::Normal(name) = component else {
                return Err(ContextErrorKind::ReadFailed);
            };
            path.push(name);
            let meta = fs::symlink_metadata(&path).map_err(|_| ContextErrorKind::ReadFailed)?;
            if is_link(&meta) {
                return Err(ContextErrorKind::ReadFailed);
            }
        }
        let meta = fs::symlink_metadata(&path).map_err(|_| ContextErrorKind::ReadFailed)?;
        if is_link(&meta)
            || if directory {
                !meta.is_dir()
            } else {
                !meta.is_file()
            }
        {
            return Err(ContextErrorKind::ReadFailed);
        }
        let resolved = fs::canonicalize(&path).map_err(|_| ContextErrorKind::ReadFailed)?;
        if !resolved.starts_with(&self.root) || resolved != path {
            return Err(ContextErrorKind::ReadFailed);
        }
        Ok(path)
    }

    fn open(&self) -> Result<File, ContextErrorKind> {
        let path = self.checked_path(false)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // FILE_FLAG_OPEN_REPARSE_POINT opens the link, not its target.
            options.custom_flags(0x0020_0000);
        }
        let file = options
            .open(path)
            .map_err(|_| ContextErrorKind::ReadFailed)?;
        let meta = file.metadata().map_err(|_| ContextErrorKind::ReadFailed)?;
        if is_link(&meta) || !meta.is_file() {
            return Err(ContextErrorKind::ReadFailed);
        }
        Ok(file)
    }
}

fn is_link(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes directory junctions, not just symbolic links.
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    meta.file_type().is_symlink()
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
}

fn resolve_root(
    path: &Path,
    scope: Scope,
    missing_ok: bool,
) -> Result<Option<PathBuf>, ContextError> {
    let error = || ContextError {
        kind: ContextErrorKind::InvalidRoot,
        scope: Some(scope),
        source: Some(format!("{scope}:.")),
    };
    if !path.is_absolute() {
        return Err(error());
    }
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound && missing_ok => return Ok(None),
        Err(_) => return Err(error()),
        Ok(_) => (),
    }
    // Only caller-selected roots may deliberately resolve through symlinks.
    let resolved = fs::canonicalize(path).map_err(|_| error())?;
    if !fs::metadata(&resolved).map_err(|_| error())?.is_dir() {
        return Err(error());
    }
    Ok(Some(resolved))
}

fn project_skills(
    workspace: &Path,
    diagnostics: &mut Vec<ContextDiagnostic>,
) -> Result<bool, ContextError> {
    for relative in [".agents", ".agents/skills"] {
        let source = SkillSource {
            scope: Scope::Project,
            root: workspace.to_owned(),
            relative: PathBuf::from(relative),
        };
        let meta = match fs::symlink_metadata(workspace.join(relative)) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err(source.error(ContextErrorKind::ReadFailed)),
            Ok(meta) => meta,
        };
        if is_link(&meta) {
            diagnostics.push(source.diagnostic(DiagnosticKind::SkippedSymlink));
            return Ok(false);
        }
        if !meta.is_dir() {
            return Err(source.error(ContextErrorKind::InvalidRoot));
        }
        let path = source
            .checked_path(true)
            .map_err(|kind| source.error(kind))?;
        fs::read_dir(path).map_err(|_| source.error(ContextErrorKind::ReadFailed))?;
    }
    Ok(true)
}

/// Discover metadata only. Missing skill directories are empty; no roots are
/// inferred from the environment and no files or directories are created.
pub fn discover(roots: ContextRoots) -> Result<SkillCatalog, ContextError> {
    let workspace =
        resolve_root(&roots.workspace, Scope::Project, false)?.expect("required workspace root");
    let global_skills = resolve_root(&roots.global_skills, Scope::Global, true)?;
    let mut catalog = SkillCatalog {
        workspace,
        global_skills,
        entries: Vec::new(),
        diagnostics: Vec::new(),
    };
    // Verify workspace readability even when it has no project skills.
    fs::read_dir(&catalog.workspace).map_err(|_| ContextError {
        kind: ContextErrorKind::ReadFailed,
        scope: Some(Scope::Project),
        source: Some("project:.".to_owned()),
    })?;
    let mut entries = BTreeMap::new();
    if let Some(global) = &catalog.global_skills {
        discover_scope(
            Scope::Global,
            global,
            PathBuf::new(),
            &mut entries,
            &mut catalog.diagnostics,
        )?;
    }
    if project_skills(&catalog.workspace, &mut catalog.diagnostics)? {
        discover_scope(
            Scope::Project,
            &catalog.workspace,
            PathBuf::from(".agents/skills"),
            &mut entries,
            &mut catalog.diagnostics,
        )?;
    }
    catalog.entries = entries.into_values().collect();
    catalog
        .diagnostics
        .sort_by(|a, b| (a.scope, &a.source, a.kind).cmp(&(b.scope, &b.source, b.kind)));
    Ok(catalog)
}

fn discover_scope(
    scope: Scope,
    root: &Path,
    start: PathBuf,
    entries: &mut BTreeMap<SkillId, SkillMetadata>,
    diagnostics: &mut Vec<ContextDiagnostic>,
) -> Result<(), ContextError> {
    let mut pending = vec![start];
    while let Some(relative) = pending.pop() {
        let directory = SkillSource {
            scope,
            root: root.to_owned(),
            relative,
        };
        let path = directory
            .checked_path(true)
            .map_err(|kind| directory.error(kind))?;
        let children =
            fs::read_dir(&path).map_err(|_| directory.error(ContextErrorKind::ReadFailed))?;
        let source = SkillSource {
            scope,
            root: root.to_owned(),
            relative: directory.relative.join("SKILL.md"),
        };
        match fs::symlink_metadata(path.join("SKILL.md")) {
            Ok(meta) => {
                if is_link(&meta) {
                    diagnostics.push(source.diagnostic(DiagnosticKind::SkippedSymlink));
                } else {
                    discover_skill(source, entries, diagnostics)?;
                }
                // Even malformed manifests end traversal at this package.
                continue;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(_) => return Err(source.error(ContextErrorKind::ReadFailed)),
        }
        let mut sorted = Vec::new();
        for child in children {
            let child = child.map_err(|_| directory.error(ContextErrorKind::ReadFailed))?;
            let name = child
                .file_name()
                .into_string()
                .map_err(|_| directory.error(ContextErrorKind::ReadFailed))?;
            sorted.push(name);
        }
        sorted.sort();
        let mut directories = Vec::new();
        for name in sorted {
            let child = SkillSource {
                scope,
                root: root.to_owned(),
                relative: directory.relative.join(name),
            };
            let meta = fs::symlink_metadata(root.join(&child.relative))
                .map_err(|_| child.error(ContextErrorKind::ReadFailed))?;
            if is_link(&meta) {
                diagnostics.push(child.diagnostic(DiagnosticKind::SkippedSymlink));
            } else if meta.is_dir() {
                directories.push(child.relative);
            }
        }
        pending.extend(directories.into_iter().rev());
    }
    Ok(())
}

fn discover_skill(
    source: SkillSource,
    entries: &mut BTreeMap<SkillId, SkillMetadata>,
    diagnostics: &mut Vec<ContextDiagnostic>,
) -> Result<(), ContextError> {
    let result = source
        .open()
        .and_then(|file| frontmatter::read(&mut BufReader::new(file)));
    let frontmatter = match result {
        Ok(value) => value,
        // Oversized mandatory metadata must not produce a partial catalog.
        Err(ContextErrorKind::InputTooLarge) => {
            return Err(source.error(ContextErrorKind::InputTooLarge));
        }
        Err(kind) => {
            diagnostics.push(source.diagnostic(DiagnosticKind::Excluded(kind)));
            return Ok(());
        }
    };
    let name = frontmatter["name"].as_str().expect("validated name");
    let id = SkillId {
        scope: source.scope,
        name: name.to_owned(),
    };
    if entries.contains_key(&id) {
        return Err(source.error(ContextErrorKind::DuplicateSkill));
    }
    if source
        .relative
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|directory| directory != std::ffi::OsStr::new(name))
    {
        diagnostics.push(source.diagnostic(DiagnosticKind::DirectoryNameMismatch));
    }
    if [
        "allowed-tools",
        "disable-model-invocation",
        "user-invocable",
        "model",
        "context",
        "agent",
        "hooks",
    ]
    .iter()
    .any(|key| frontmatter.get(*key).is_some())
    {
        diagnostics.push(source.diagnostic(DiagnosticKind::UnsupportedBehavioralMetadata));
    }
    entries.insert(
        id.clone(),
        SkillMetadata {
            id,
            frontmatter,
            source,
        },
    );
    Ok(())
}
