use crate::context_cli::{CliError, CliResult, emit_diagnostics, filtered, resolve_roots};
use clap::{Args, ValueEnum};
use std::{future::Future, io::Write, path::PathBuf, sync::Arc};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;
use wi::{
    DeltaKind, Gateway, GatewayError, InputItem, ProviderEvent, Result,
    context::{ContextRoots, SkillId, discover, prepare_run},
    providers::openai_codex::PROVIDER_ID,
    run::{RunEvent, RunEventEnvelope, RunOutcome, RunRequest, RunResult, RunSinkError},
    tools::{AddNumbers, ToolRegistry},
};

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum ToolArg {
    #[value(name = "add_numbers")]
    AddNumbers,
}

#[derive(Args)]
pub(crate) struct RunArgs {
    #[command(flatten)]
    base: crate::ModelArgs,
    #[arg(long, required_unless_present = "stdin", conflicts_with = "stdin")]
    prompt: Option<String>,
    #[arg(long)]
    stdin: bool,
    #[arg(long, default_value = "You are a helpful assistant.")]
    instructions: String,
    #[arg(long, value_enum)]
    tool: Vec<ToolArg>,
    /// Workspace to prepare; defaults to the CLI working directory.
    #[arg(long, value_name = "PATH")]
    workspace: Option<PathBuf>,
    /// Activate a qualified catalog ID; repeat to select more instructions.
    #[arg(long, value_name = "global:<name>|project:<name>")]
    use_skill: Vec<SkillId>,
}

async fn handle<R, W, S, B, F, D>(
    args: RunArgs,
    input: R,
    build: B,
    output: &mut W,
    signal: S,
    resolve: F,
    diagnostics: &mut D,
) -> CliResult<RunResult>
where
    R: AsyncRead + Unpin,
    W: Write,
    S: Future<Output = std::io::Result<()>>,
    B: FnOnce(&crate::AuthArgs) -> Result<Gateway>,
    F: FnOnce(Option<PathBuf>) -> CliResult<ContextRoots> + Send + 'static,
    D: Write,
{
    // Validate without locating either external credentials or the managed store.
    if args.stdin == args.prompt.is_some() {
        return Err(GatewayError::InvalidRequest("require --prompt xor --stdin").into());
    }
    if args.tool.len() > 1 {
        return Err(GatewayError::InvalidRequest("duplicate tool selection").into());
    }
    let auth = &args.base.auth;
    if matches!(auth.auth_source, crate::SourceArg::Gateway) {
        if auth.auth_file.is_some() {
            return Err(
                GatewayError::InvalidRequest("managed auth does not accept --auth-file").into(),
            );
        }
        if let Some(name) = &auth.account {
            wi::providers::openai_codex::profile_selection::validate_name(name)?;
        }
    } else if auth.account.is_some() {
        return Err(
            GatewayError::InvalidRequest("--account requires --auth-source gateway").into(),
        );
    }
    let mut options = crate::options(&args.base);
    options.instructions = args.instructions;
    let mut tools = ToolRegistry::new();
    if !args.tool.is_empty() {
        tools.register(Arc::new(AddNumbers))?;
    }
    // Include selected definitions in the existing configuration-size check.
    options.tools = tools.definitions();
    options.validate()?;
    options.tools.clear();
    let prompt = if args.stdin {
        let mut bytes = Vec::new();
        input
            .take((wi::MAX_INPUT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| GatewayError::Io(e.kind()))?;
        if bytes.len() > wi::MAX_INPUT_BYTES {
            return Err(GatewayError::InvalidRequest("stdin exceeds 1 MiB").into());
        }
        String::from_utf8(bytes).map_err(|_| GatewayError::InvalidRequest("stdin is not UTF-8"))?
    } else {
        args.prompt.unwrap_or_default()
    };
    wi::validate_input(&[InputItem::user(&prompt)])?;
    let request = RunRequest {
        provider_id: PROVIDER_ID.into(),
        options,
        prompt,
    };
    let (tools, notices, prepared) = tokio::task::spawn_blocking(move || {
        let catalog = discover(resolve(args.workspace)?)?;
        let prepared = prepare_run(request, &catalog, &args.use_skill, &tools);
        // Keep diagnostics visible even when activation or final validation fails.
        Ok::<_, CliError>((tools, catalog.diagnostics().to_vec(), prepared))
    })
    .await
    .map_err(|_| CliError::PreparationTask)??;
    emit_diagnostics(diagnostics, &notices)?;
    let request = prepared?.into_request();
    let gateway = build(auth)?;
    let cancel = CancellationToken::new();
    let task = wi::run::run(&gateway, request, &tools, cancel.clone(), |event| {
        render(output, args.base.json, event)
    });
    tokio::pin!(task);
    tokio::select! {
        result = &mut task => result.map_err(Into::into),
        signal_result = signal => {
            cancel.cancel();
            // Await controlled closure and final delivery, even if signal setup failed.
            let result = task.await;
            signal_result.map_err(|e| GatewayError::Io(e.kind()))?;
            result.map_err(Into::into)
        }
    }
}

fn sink_error(error: std::io::Error) -> RunSinkError {
    match error.kind() {
        std::io::ErrorKind::WouldBlock => RunSinkError::Full,
        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::NotConnected => RunSinkError::Closed,
        _ => RunSinkError::Failed,
    }
}

fn render<W: Write>(
    out: &mut W,
    json: bool,
    envelope: &RunEventEnvelope,
) -> std::result::Result<(), RunSinkError> {
    if json {
        serde_json::to_writer(&mut *out, envelope).map_err(|error| {
            error
                .io_error_kind()
                .map(|kind| sink_error(std::io::Error::from(kind)))
                .unwrap_or(RunSinkError::Failed)
        })?;
        writeln!(out).map_err(sink_error)?;
    } else {
        match &envelope.event {
            RunEvent::ProviderEvent { event } => match &event.event {
                ProviderEvent::OutputItemUpdated {
                    kind: DeltaKind::Text | DeltaKind::Refusal,
                    delta,
                    ..
                } => {
                    writeln!(out, "[Provisional text] {}", filtered(delta)).map_err(sink_error)?;
                }
                ProviderEvent::ResponseFinished { response } => {
                    let status = match response.outcome {
                        wi::ResponseOutcome::Completed => "completed",
                        wi::ResponseOutcome::Incomplete { .. } => "incomplete",
                        wi::ResponseOutcome::Failed => "failed",
                        wi::ResponseOutcome::Cancelled => "cancelled",
                    };
                    writeln!(
                        out,
                        "[Authoritative validated final response; {status}]\n{}",
                        filtered(&response.text)
                    )
                    .map_err(sink_error)?;
                }
                _ => {}
            },
            RunEvent::RunFinished { outcome, .. } => {
                // Do not display provider failure details or infer success from partial text.
                let label = match outcome {
                    RunOutcome::Completed => "Completed",
                    RunOutcome::CancelledLocally => "Cancelled locally",
                    RunOutcome::Failed { .. } => "Failed",
                };
                writeln!(out, "[Run: {label}]").map_err(sink_error)?;
            }
            _ => {}
        }
    }
    out.flush().map_err(sink_error)
}

fn exit_code(result: &RunResult) -> i32 {
    if result.sink_error.is_some() || !result.events_complete {
        return 1;
    }
    match result.outcome {
        RunOutcome::Completed => 0,
        RunOutcome::CancelledLocally => 130,
        _ => 1,
    }
}

pub(crate) async fn run(args: RunArgs) -> CliResult<i32> {
    let result = handle(
        args,
        tokio::io::stdin(),
        |auth| {
            let mut gateway = Gateway::new();
            gateway.register(Arc::new(crate::provider(auth)?))?;
            Ok(gateway)
        },
        &mut std::io::stdout().lock(),
        tokio::signal::ctrl_c(),
        resolve_roots,
        &mut std::io::stderr().lock(),
    )
    .await?;
    if result.sink_error.is_some() {
        eprintln!("error: run output delivery failed");
    }
    Ok(exit_code(&result))
}

#[cfg(test)]
#[path = "run_cli_tests.rs"]
mod tests;
