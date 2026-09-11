use clap::{Args, Subcommand};
use std::{io::Write, path::PathBuf};
use wi::{GatewayError, context::SkillCatalog};

use crate::cli::context_cli::{
    CliError, CliResult, diagnostic_category, emit_diagnostics, filtered, resolve_roots,
};

#[derive(Args)]
pub(crate) struct SkillsCommand {
    #[command(subcommand)]
    command: SkillsSubcommand,
}

#[derive(Subcommand)]
enum SkillsSubcommand {
    /// Discover global and project frontmatter only; never activate instructions.
    List {
        /// Workspace to inspect; defaults to the CLI working directory.
        #[arg(long, value_name = "PATH")]
        workspace: Option<PathBuf>,
        /// Sensitive metadata and relative source labels; no bodies or host paths.
        #[arg(long)]
        json: bool,
    },
}

fn render(catalog: &SkillCatalog, json: bool, out: &mut impl Write) -> CliResult<()> {
    if json {
        let entries: Vec<_> = catalog
            .entries()
            .iter()
            .map(|entry| {
                serde_json::json!({
                    "id": entry.id().to_string(),
                    "frontmatter": entry.frontmatter(),
                    "source": entry.source_label(),
                })
            })
            .collect();
        let diagnostics: Vec<_> = catalog
            .diagnostics()
            .iter()
            .map(|diagnostic| {
                serde_json::json!({
                    "scope": diagnostic.scope().to_string(),
                    "source": diagnostic.source_label(),
                    "category": diagnostic_category(diagnostic),
                    "message": diagnostic.message(),
                })
            })
            .collect();
        serde_json::to_writer(
            &mut *out,
            &serde_json::json!({"entries": entries, "diagnostics": diagnostics}),
        )
        .map_err(|_| GatewayError::Serialization)?;
        writeln!(out).map_err(|error| GatewayError::Io(error.kind()))?;
    } else {
        for entry in catalog.entries() {
            writeln!(out, "{}\t{}", entry.id(), filtered(entry.description()))
                .map_err(|error| GatewayError::Io(error.kind()))?;
        }
    }
    out.flush()
        .map_err(|error| GatewayError::Io(error.kind()))?;
    Ok(())
}

pub(crate) async fn run(args: SkillsCommand) -> CliResult<i32> {
    let SkillsSubcommand::List { workspace, json } = args.command;
    let catalog = tokio::task::spawn_blocking(move || {
        Ok::<_, CliError>(wi::context::discover(resolve_roots(workspace)?)?)
    })
    .await
    .map_err(|_| CliError::PreparationTask)??;
    emit_diagnostics(&mut std::io::stderr().lock(), catalog.diagnostics())?;
    render(&catalog, json, &mut std::io::stdout().lock())?;
    Ok(0)
}
