use std::{
    fmt,
    future::{Future, IntoFuture},
    net::SocketAddr,
    panic::AssertUnwindSafe,
    sync::{Arc, OnceLock},
};

use futures_util::FutureExt;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use super::{ApiConfig, ConfigError, router, validate_listener};
use crate::service::{RunHost, ShutdownOutcome, ShutdownTicket};

mod transport;

/// Static service failures. No IO error, panic payload or configuration is retained.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ServeError {
    #[error("api.listener_address_failed")]
    ListenerAddress,
    #[error("api.listener_invalid")]
    NonLoopbackListener,
    #[error("api.config_invalid")]
    Configuration,
    #[error("api.accept_failed")]
    Accept,
    #[error("api.serve_failed")]
    Http,
    #[error("api.serve_panicked")]
    Panicked,
}

/// Network termination and the original host outcome are independent facts.
/// Success requires `http.is_ok()` AND `shutdown` to be `ShutdownOutcome::Closed`.
pub struct ServeOutcome {
    /// The actual bound address, including an OS-selected port. None if lookup failed.
    pub local_addr: Option<SocketAddr>,
    pub http: Result<(), ServeError>,
    pub shutdown: Arc<ShutdownOutcome>,
}

impl fmt::Debug for ServeOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServeOutcome")
            .field("local_addr", &self.local_addr)
            .field("http", &self.http)
            .field("shutdown", &self.shutdown)
            .finish()
    }
}

/// Serve the authenticated API on an already-bound loopback listener.
///
/// Dropping this future, even before its first poll, initiates host shutdown.
/// Only awaiting the returned outcome proves HTTP drain and observes host shutdown.
/// Request, client, ticket and SSE drops never act as this owner.
pub fn serve(
    listener: TcpListener,
    host: RunHost,
    config: ApiConfig,
    shutdown: CancellationToken,
) -> impl Future<Output = ServeOutcome> + Send {
    serve_inner(
        listener,
        host,
        config,
        shutdown,
        #[cfg(test)]
        Default::default(),
    )
}

#[cfg(test)]
pub(crate) fn serve_with_event_faults(
    listener: TcpListener,
    host: RunHost,
    config: ApiConfig,
    shutdown: CancellationToken,
    faults: Arc<router::event_test_hooks::FaultHook>,
) -> impl Future<Output = ServeOutcome> + Send {
    let hooks = tests::Hooks::with_events(Arc::new(router::event_test_hooks::Hooks::with_faults(
        &faults,
    )));
    // Only the caller owns the control hook. Dropping it also wakes open faulted bodies.
    serve_inner(listener, host, config, shutdown, Arc::new(hooks))
}

fn serve_inner(
    listener: TcpListener,
    host: RunHost,
    config: ApiConfig,
    shutdown: CancellationToken,
    #[cfg(test)] hooks: Arc<tests::Hooks>,
) -> impl Future<Output = ServeOutcome> + Send {
    // Construct outside the async block: an unpolled owner must also close the host.
    let mut owner = OwnerGuard::new(host);
    #[cfg(test)]
    {
        *hooks.host.lock().unwrap() = Arc::downgrade(&owner.host);
    }
    async move {
        let address = listener
            .local_addr()
            .map_err(|_| ServeError::ListenerAddress);
        let local_addr = address.as_ref().ok().copied();
        let failure = Arc::new(OnceLock::new());
        let (connections, sockets) = tokio::sync::watch::channel(());
        let http = {
            let host = owner.host.clone();
            let network_close = owner.network_close.clone();
            let accept_failure = failure.clone();
            let network = async move {
                let address = address?;
                validate_listener(address).map_err(|_| ServeError::NonLoopbackListener)?;
                #[cfg(not(test))]
                let app = router::router(host, config, address, network_close.clone());
                #[cfg(test)]
                let app = router::router_with_event_hooks(
                    host,
                    config,
                    address,
                    network_close.clone(),
                    hooks.events.clone(),
                );
                let app = app.map_err(|error| match error {
                    ConfigError::Listener => ServeError::NonLoopbackListener,
                    _ => ServeError::Configuration,
                })?;
                let listener = transport::ClosingListener {
                    listener,
                    network_close: network_close.clone(),
                    failure: accept_failure,
                    sockets,
                    #[cfg(test)]
                    hooks,
                };
                axum::serve(listener, app)
                    .with_graceful_shutdown(network_close.cancelled_owned())
                    .into_future()
                    .await
                    .map_err(|_| ServeError::Http)
            };
            // Catch serving/setup unwinds without inspecting their payloads. Core execution keeps
            // its own panic handling and quarantine; it is never part of this caught future.
            let network = AssertUnwindSafe(network).catch_unwind();
            tokio::pin!(network);
            let http = tokio::select! {
                biased;
                _ = shutdown.cancelled() => None,
                _ = owner.network_close.cancelled() => None,
                result = &mut network => Some(result),
            };
            owner.initiate();
            match http {
                Some(result) => result,
                None => network.await,
            }
        };
        let http = match http {
            Ok(result) => result,
            Err(_) => Err(ServeError::Panicked),
        };
        // Axum normally awaits its connections. Also wait for accepted IO to retire if the
        // serving future unwound before reaching Axum's drain boundary.
        connections.closed().await;
        let shutdown = owner.initiate().wait().await;
        ServeOutcome {
            local_addr,
            http: failure.get().copied().map_or(http, Err),
            shutdown,
        }
    }
}

struct OwnerGuard {
    host: Arc<RunHost>,
    network_close: CancellationToken,
    ticket: Option<ShutdownTicket>,
}

impl OwnerGuard {
    fn new(host: RunHost) -> Self {
        Self {
            host: Arc::new(host),
            network_close: CancellationToken::new(),
            ticket: None,
        }
    }

    fn initiate(&mut self) -> &ShutdownTicket {
        self.ticket.get_or_insert_with(|| {
            // Stop handler admission and wake network waiters before draining the host.
            self.network_close.cancel();
            self.host.begin_shutdown()
        })
    }
}

impl Drop for OwnerGuard {
    fn drop(&mut self) {
        self.initiate();
    }
}

#[cfg(test)]
mod tests;
