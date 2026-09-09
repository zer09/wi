use clap::{Args, Parser, Subcommand, ValueEnum};
use futures_util::StreamExt;
use std::{
    io::{self, Write},
    sync::Arc,
};
use tokio::io::AsyncReadExt;
use wi::providers::openai_codex::{
    OpenAiCodexProvider, PROVIDER_ID,
    auth::{AuthSource, CredentialSource, LocalAuthFile},
};
use wi::tools::{AddNumbers, ToolRegistry};
use wi::{
    DeltaKind, Gateway, GatewayError, InputItem, ModelResponse, ProviderEvent, ProviderSession,
    ResponseOutcome, Result, SessionOptions, Transport,
};
mod auth_cli;
#[cfg(test)]
mod collect_tests;
mod demo;
mod run_cli;
mod smoke;

#[derive(Parser)]
#[command(version, about = "Wi: Rust subscription gateway; no API-key fallback")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Manage Wi-owned profiles with experimental browser login and renewal.
    Auth(auth_cli::AuthCommand),
    /// Read local credential metadata only. Makes no provider request.
    AuthCheck(AuthArgs),
    /// Print implemented/verified status without reading credentials.
    Capabilities,
    /// Generate text; optional follow-up uses the same provider session.
    Generate(GenerateArgs),
    /// Run one bounded task with optional local addition tools.
    Run(run_cli::RunArgs),
    /// Demonstrate one ordinary, bounded, read-only function-tool round trip.
    ToolDemo(ModelArgs),
    /// Opt-in fixed live smoke case; emits only sanitized structural evidence.
    Smoke(smoke::SmokeArgs),
}
#[derive(Clone, Copy, ValueEnum)]
enum SourceArg {
    Gateway,
    Codex,
    Pi,
}
#[derive(Clone, Copy, ValueEnum)]
enum TransportArg {
    Websocket,
    Sse,
}
#[derive(Args)]
struct AuthArgs {
    #[arg(long, value_enum, default_value = "codex")]
    auth_source: SourceArg,
    #[arg(long)]
    auth_file: Option<std::path::PathBuf>,
    /// Exact Wi profile; valid only with --auth-source gateway.
    #[arg(long, conflicts_with = "auth_file")]
    account: Option<String>,
}
#[derive(Args)]
struct ModelArgs {
    #[command(flatten)]
    auth: AuthArgs,
    /// Exact model identifier already enabled for your Codex subscription.
    #[arg(long)]
    model: String,
    #[arg(long, value_enum, default_value = "websocket")]
    transport: TransportArg,
    /// Sensitive NDJSON, including native provider state. Do not publish logs.
    #[arg(long)]
    json: bool,
}
#[derive(Args)]
struct GenerateArgs {
    #[command(flatten)]
    base: ModelArgs,
    #[arg(long, required_unless_present = "stdin", conflicts_with = "stdin")]
    prompt: Option<String>,
    #[arg(long)]
    stdin: bool,
    #[arg(long, default_value = "You are a helpful assistant.")]
    instructions: String,
    #[arg(long)]
    follow_up: Option<String>,
}

fn credentials(args: &AuthArgs) -> Result<LocalAuthFile> {
    if args.account.is_some() {
        return Err(GatewayError::InvalidRequest(
            "--account requires --auth-source gateway",
        ));
    }
    let source = match args.auth_source {
        SourceArg::Gateway => {
            return Err(GatewayError::InvalidRequest(
                "use wi auth status for managed profile metadata",
            ));
        }
        SourceArg::Codex => AuthSource::Codex,
        SourceArg::Pi => AuthSource::Pi,
    };
    match &args.auth_file {
        Some(path) => Ok(LocalAuthFile::new(source, path)),
        None => LocalAuthFile::default_for(source),
    }
}
fn options(args: &ModelArgs) -> SessionOptions {
    let mut o = SessionOptions::new(&args.model);
    o.transport = match args.transport {
        TransportArg::Websocket => Transport::WebSocket,
        TransportArg::Sse => Transport::Sse,
    };
    o
}
fn provider(args: &AuthArgs) -> Result<OpenAiCodexProvider> {
    if matches!(args.auth_source, SourceArg::Gateway) {
        if args.auth_file.is_some() {
            return Err(GatewayError::InvalidRequest(
                "managed auth does not accept --auth-file",
            ));
        }
        if let Some(name) = &args.account {
            wi::providers::openai_codex::profile_selection::validate_name(name)?;
        }
        return Ok(OpenAiCodexProvider::managed(
            wi::providers::openai_codex::managed_auth::AuthManager::default_location()?,
            args.account.clone(),
        )
        .with_profile_observer(|name| eprintln!("Wi profile: {name}")));
    }
    Ok(OpenAiCodexProvider::new(Arc::new(credentials(args)?)))
}
async fn open(args: &ModelArgs, options: SessionOptions) -> Result<ProviderSession> {
    let provider = provider(&args.auth)?;
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(provider))?;
    gateway.open_session(PROVIDER_ID, options).await
}
fn line_json(value: &impl serde::Serialize) -> Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, value).map_err(|_| GatewayError::Serialization)?;
    writeln!(out).map_err(|e| GatewayError::Io(e.kind()))
}
fn write_text(text: &str) -> Result<()> {
    let mut out = io::stdout().lock();
    out.write_all(text.as_bytes())
        .and_then(|_| out.flush())
        .map_err(|e| GatewayError::Io(e.kind()))
}
async fn collect(
    session: &mut ProviderSession,
    request_id: &str,
    json_mode: bool,
) -> Result<ModelResponse> {
    let mut rendered = String::new();
    while let Some(envelope) = session.events.next().await {
        if json_mode {
            line_json(&envelope)?;
        }
        if let ProviderEvent::SessionClosed { .. } = &envelope.event {
            return Err(GatewayError::SessionClosed);
        }
        if envelope.request_id.as_deref() != Some(request_id) {
            return Err(GatewayError::Protocol("unexpected request identity"));
        }
        match envelope.event {
            ProviderEvent::OutputItemUpdated {
                kind: DeltaKind::Text | DeltaKind::Refusal,
                delta,
                ..
            } => {
                if !json_mode {
                    rendered.push_str(&delta);
                    write_text(&delta)?;
                }
            }
            ProviderEvent::ResponseFinished { response } => {
                if !json_mode {
                    if let Some(suffix) = response.text.strip_prefix(&rendered) {
                        write_text(suffix)?;
                    } else {
                        write_text("\n[Authoritative final response]\n")?;
                        write_text(&response.text)?;
                    }
                    write_text("\n")?;
                }
                return Ok(response);
            }
            ProviderEvent::RequestFailed { message, .. } => {
                eprintln!("{message}");
                return Err(GatewayError::ProviderFailed);
            }
            _ => {}
        }
    }
    Err(GatewayError::UnexpectedEnd)
}
async fn generate(args: GenerateArgs) -> Result<()> {
    let prompt = if args.stdin {
        let mut bytes = Vec::new();
        tokio::io::stdin()
            .take((wi::MAX_INPUT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| GatewayError::Io(e.kind()))?;
        if bytes.len() > wi::MAX_INPUT_BYTES {
            return Err(GatewayError::InvalidRequest("stdin exceeds 1 MiB"));
        }
        String::from_utf8(bytes).map_err(|_| GatewayError::InvalidRequest("stdin is not UTF-8"))?
    } else {
        args.prompt.unwrap_or_default()
    };
    let mut options = options(&args.base);
    options.instructions = args.instructions;
    let mut session = open(&args.base, options).await?;
    let control = session.control.clone();
    let task = async {
        let receipt = control.generate(vec![InputItem::user(prompt)]).await?;
        let first = collect(&mut session, &receipt.request_id, args.base.json).await?;
        if first.outcome != ResponseOutcome::Completed {
            return Err(GatewayError::NotCompleted);
        }
        if first
            .output
            .iter()
            .any(|i| !matches!(i.kind, wi::ItemKind::Message | wi::ItemKind::Reasoning))
        {
            return Err(GatewayError::UnsupportedOutput);
        }
        if let Some(follow_up) = args.follow_up {
            let receipt = control.generate(vec![InputItem::user(follow_up)]).await?;
            let next = collect(&mut session, &receipt.request_id, args.base.json).await?;
            if next.outcome != ResponseOutcome::Completed {
                return Err(GatewayError::NotCompleted);
            }
            if next
                .output
                .iter()
                .any(|i| !matches!(i.kind, wi::ItemKind::Message | wi::ItemKind::Reasoning))
            {
                return Err(GatewayError::UnsupportedOutput);
            }
        }
        Ok(())
    };
    let result = tokio::select! {
        r = task => r,
        _ = tokio::signal::ctrl_c() => Err(GatewayError::Cancelled),
    };
    control.close();
    result
}
async fn tool_demo(args: ModelArgs) -> Result<()> {
    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(AddNumbers))?;
    let mut opts = options(&args);
    opts.tools = registry.definitions();
    opts.instructions = demo::TOOL_INSTRUCTIONS.into();
    let mut session = open(&args, opts).await?;
    let control = session.control.clone();
    let task = async {
        let receipt = control
            .generate(vec![InputItem::user(demo::TOOL_PROMPT)])
            .await?;
        let response = collect(&mut session, &receipt.request_id, args.json).await?;
        let call = demo::validate_call(&response)?;
        let mut output_error: Option<GatewayError> = None;
        let results = registry
            .execute_response(&response, |event| {
                if args.json {
                    output_error = line_json(&event).err().or(output_error.take());
                } else {
                    eprintln!("{event:?}");
                }
            })
            .await?;
        if let Some(e) = output_error {
            return Err(e);
        }
        demo::validate_result(&results, &call.call_id)?;
        // Exactly one result-delivery continuation. This is a bounded test
        // driver, not the production agent loop or a durable execution ledger.
        let receipt = control.generate(results).await?;
        let final_response = collect(&mut session, &receipt.request_id, args.json).await?;
        demo::validate_answer(&final_response, "42")?;
        Ok(())
    };
    let result = tokio::select! { r = task => r, _ = tokio::signal::ctrl_c() => Err(GatewayError::Cancelled) };
    control.close();
    result
}
async fn run(cli: Cli) -> Result<i32> {
    let result = match cli.command {
        Command::Run(args) => return run_cli::run(args).await,
        Command::Auth(command) => command.run().await,
        Command::AuthCheck(args) => {
            let auth = credentials(&args)?.load().await?;
            line_json(
                &serde_json::json!({"credential_shape":"accepted","expires_at_unix":auth.expires_at_unix(),"live_request_made":false}),
            )
        }
        Command::Capabilities => line_json(&OpenAiCodexProvider::capability_report()),
        Command::Generate(args) => generate(args).await,
        Command::ToolDemo(args) => tool_demo(args).await,
        Command::Smoke(args) => smoke::run(args).await,
    };
    result.map(|()| 0)
}
#[tokio::main]
async fn main() {
    // Only the root subcommand selects run's startup policy, not later argument values.
    let is_run = std::env::args_os().nth(1).is_some_and(|arg| arg == "run");
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            let code = match error.kind() {
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion => 0,
                _ if is_run => 1,
                _ => error.exit_code(),
            };
            let _ = error.print();
            std::process::exit(code);
        }
    };
    let code = match run(cli).await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("error: {error}");
            1
        }
    };
    if code != 0 {
        std::process::exit(code);
    }
}
