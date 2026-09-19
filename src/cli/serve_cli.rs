use clap::Args;
use std::{future::Future, io, io::Write, net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use wi::{
    Gateway,
    http_api::{self, ApiConfig, ConfigError, ConfigFile, OwnerToken, ServeOutcome, TokenError},
    providers::openai_codex::{OpenAiCodexProvider, managed_auth::AuthManager},
    service::{RunHost, ShutdownOutcome},
    storage::SessionStore,
};

#[derive(Args)]
pub(super) struct ServeArgs {
    /// Absolute path to the strict service JSON configuration.
    #[arg(long, value_name = "ABSOLUTE_JSON_FILE")]
    config: PathBuf,
}

#[derive(Debug, thiserror::Error)]
enum StartError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Token(#[from] TokenError),
    #[error("api.bind_failed")]
    Bind,
    #[error("api.listener_address_failed")]
    Address,
    #[error("api.auth_manager_failed")]
    AuthManager,
    #[error("api.provider_setup_failed")]
    Provider,
    #[error("api.storage_open_failed")]
    Storage,
    #[error("api.host_start_failed")]
    Host,
    #[error("api.signal_failed")]
    Signal,
    #[error("api.output_failed")]
    Output,
}

struct Started {
    listener: TcpListener,
    address: SocketAddr,
    host: RunHost,
    config: ApiConfig,
}

fn managed_gateway(
    account: Option<String>,
    manager: impl FnOnce() -> wi::Result<AuthManager>,
) -> Result<Gateway, StartError> {
    // Construction does not select, read or renew a profile. B2 opens it for an explicit task.
    let provider =
        OpenAiCodexProvider::managed(manager().map_err(|_| StartError::AuthManager)?, account);
    let mut gateway = Gateway::new();
    gateway
        .register(Arc::new(provider))
        .map_err(|_| StartError::Provider)?;
    Ok(gateway)
}

async fn start(
    args: ServeArgs,
    build_gateway: impl FnOnce(Option<String>) -> Result<Gateway, StartError>,
) -> Result<Started, StartError> {
    let file = ConfigFile::load(&args.config)?;
    let token = OwnerToken::load(file.client_token_file())?;
    let listener = TcpListener::bind(file.listen())
        .await
        .map_err(|_| StartError::Bind)?;
    let address = listener.local_addr().map_err(|_| StartError::Address)?;
    let gateway = build_gateway(file.account().map(str::to_owned))?;
    let store = SessionStore::open(file.data_root().to_path_buf())
        .await
        .map_err(|_| StartError::Storage)?;
    let host = RunHost::new(store, Arc::new(gateway)).map_err(|_| StartError::Host)?;
    Ok(Started {
        listener,
        address,
        host,
        config: ApiConfig::new(file.settings().clone(), token),
    })
}

fn report(outcome: &ServeOutcome, out: &mut impl Write) -> Result<i32, StartError> {
    if let Err(error) = outcome.http {
        writeln!(out, "error: {error}").map_err(|_| StartError::Output)?;
    }
    let closed = matches!(&*outcome.shutdown, ShutdownOutcome::Closed);
    let category = if closed {
        "api.shutdown_closed"
    } else {
        "api.shutdown_incomplete"
    };
    writeln!(out, "{category}")
        .and_then(|()| out.flush())
        .map_err(|_| StartError::Output)?;
    Ok(i32::from(outcome.http.is_err() || !closed))
}

async fn handle<S>(
    args: ServeArgs,
    build_gateway: impl FnOnce(Option<String>) -> Result<Gateway, StartError>,
    signal: impl FnOnce() -> io::Result<S>,
    out: &mut impl Write,
) -> Result<i32, StartError>
where
    S: Future<Output = io::Result<()>>,
{
    let started = start(args, build_gateway).await?;
    let stop = CancellationToken::new();
    let server = http_api::serve(started.listener, started.host, started.config, stop.clone());
    tokio::pin!(server);
    // Register signals before announcing readiness, including when shutdown arrives immediately.
    let signal = match signal() {
        Ok(signal) => signal,
        Err(_) => {
            stop.cancel();
            report(&server.await, out)?;
            return Err(StartError::Signal);
        }
    };
    if writeln!(out, "api.listening {}", started.address)
        .and_then(|()| out.flush())
        .is_err()
    {
        stop.cancel();
        server.await;
        return Err(StartError::Output);
    }
    let outcome = tokio::select! {
        outcome = &mut server => outcome,
        result = signal => {
            stop.cancel();
            let outcome = server.await;
            if result.is_err() {
                report(&outcome, out)?;
                return Err(StartError::Signal);
            }
            outcome
        }
    };
    report(&outcome, out)
}

#[cfg(unix)]
fn shutdown_signal() -> io::Result<impl Future<Output = io::Result<()>>> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    Ok(async move {
        let received = tokio::select! {
            received = interrupt.recv() => received,
            received = terminate.recv() => received,
        };
        received.ok_or_else(|| io::Error::other("signal stream closed"))
    })
}

pub(super) async fn run(args: ServeArgs) -> i32 {
    match handle(
        args,
        |account| managed_gateway(account, AuthManager::default_location),
        shutdown_signal,
        &mut io::stderr().lock(),
    )
    .await
    {
        Ok(code) => code,
        Err(error) => {
            eprintln!("error: {error}");
            1
        }
    }
}

#[cfg(test)]
mod tests;
