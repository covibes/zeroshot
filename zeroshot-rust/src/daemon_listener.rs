//! One authenticated loopback WebSocket listener per native profile.

use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{FutureExt, SinkExt, StreamExt};
use openengine_cluster_protocol::{InitializeResult, JSON_RPC_VERSION, PROTOCOL_VERSION};
use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionIdentity, ConnectionIdentityConfig, PrincipalId, TenantId,
};
use openengine_cluster_server::websocket::{serve_websocket, websocket_config};
use serde_json::Value;
use thiserror::Error;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{Instant, timeout, timeout_at};
use tokio_tungstenite::accept_hdr_async_with_config;
use tokio_tungstenite::tungstenite::Error as WebSocketError;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::daemon_auth::{AuthorizationCallback, ConnectionPurpose, DAEMON_ROUTE, DaemonCredentials};
use crate::daemon_discovery::{
    CLUSTER_PROTOCOL, DAEMON_PROTOCOL, DaemonLocator, DiscoveryError, NativeProfile,
    acquire_start_guard, read_locator_locked, remove_locator_if_matches,
    remove_locator_if_matches_locked, replace_locator_locked,
};
use crate::{NativeBackendFactory, binding_for_route};

mod config;
mod liveness;
pub use config::ListenerConfig;
pub use liveness::probe_liveness;

#[derive(Debug, Error)]
pub enum DaemonListenerError {
    #[error("an authenticated daemon already owns this native profile")]
    AlreadyRunning,
    #[error("daemon liveness is indeterminate; preserving the incumbent locator")]
    LivenessIndeterminate,
    #[error("daemon listener configuration requires non-zero connection bounds and deadlines")]
    InvalidConfiguration,
    #[error("daemon discovery failed: {0}")]
    Discovery(#[from] DiscoveryError),
    #[error("daemon listener I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("daemon listener task failed")]
    Task,
    #[error("daemon shutdown exceeded its outer deadline")]
    ShutdownTimeout,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LivenessOutcome {
    Alive,
    DefinitelyStale,
    Indeterminate,
}

pub struct DaemonListener {
    profile: NativeProfile,
    locator: DaemonLocator,
    shutdown: Arc<Notify>,
    accept_task: Option<JoinHandle<Result<(), ()>>>,
    shutdown_timeout: Duration,
    pending_handshake_limit: usize,
    pending_handshake_permits: Arc<Semaphore>,
    liveness_connection_limit: usize,
    liveness_connection_permits: Arc<Semaphore>,
    active_session_limit: usize,
    active_session_permits: Arc<Semaphore>,
}

impl DaemonListener {
    pub async fn start<F>(profile: NativeProfile, factory: F) -> Result<Self, DaemonListenerError>
    where
        F: NativeBackendFactory + Send + Sync + 'static,
    {
        Self::start_with_config(profile, factory, ListenerConfig::default()).await
    }

    pub async fn start_with_config<F>(
        profile: NativeProfile,
        factory: F,
        config: ListenerConfig,
    ) -> Result<Self, DaemonListenerError>
    where
        F: NativeBackendFactory + Send + Sync + 'static,
    {
        if config.max_active_connections == 0
            || config.max_pending_handshakes == 0
            || config.max_liveness_connections == 0
            || config.startup_lock_timeout.is_zero()
            || config.liveness_timeout.is_zero()
            || config.handshake_timeout.is_zero()
            || config.drain_timeout.is_zero()
            || config.shutdown_timeout.is_zero()
        {
            return Err(DaemonListenerError::InvalidConfiguration);
        }
        let lock_profile = profile.clone();
        let lock_timeout = config.startup_lock_timeout;
        let guard =
            tokio::task::spawn_blocking(move || acquire_start_guard(&lock_profile, lock_timeout))
                .await
                .map_err(|_| DaemonListenerError::Task)??;

        let previous_secrets = if let Some(existing) = read_locator_locked(&profile)? {
            match probe_liveness(&existing, config.liveness_timeout).await {
                LivenessOutcome::Alive => return Err(DaemonListenerError::AlreadyRunning),
                LivenessOutcome::Indeterminate => {
                    return Err(DaemonListenerError::LivenessIndeterminate);
                }
                LivenessOutcome::DefinitelyStale => {}
            }
            remove_locator_if_matches_locked(&profile, &existing)?;
            Some((existing.capability, existing.daemon_nonce))
        } else {
            None
        };

        let tcp = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).await?;
        let address = tcp.local_addr()?;
        let mut credentials = DaemonCredentials::generate(profile.digest().to_owned())?;
        if let Some((previous_capability, previous_nonce)) = previous_secrets {
            rotate_away_from(&mut credentials.capability, &previous_capability);
            rotate_away_from(&mut credentials.daemon_nonce, &previous_nonce);
        }
        let locator = locator_for(address, &credentials);

        let host = AcceptLoop::new(tcp, Arc::new(factory), credentials, config);
        replace_locator_locked(&profile, &locator)?;
        drop(guard);
        Ok(spawn_listener_owner(host, profile, locator))
    }

    #[must_use]
    pub fn locator(&self) -> &DaemonLocator {
        &self.locator
    }

    #[must_use]
    pub fn pending_handshakes(&self) -> usize {
        self.pending_handshake_limit
            .saturating_sub(self.pending_handshake_permits.available_permits())
    }

    #[must_use]
    pub fn active_liveness_connections(&self) -> usize {
        self.liveness_connection_limit
            .saturating_sub(self.liveness_connection_permits.available_permits())
    }

    #[must_use]
    pub fn active_sessions(&self) -> usize {
        self.active_session_limit
            .saturating_sub(self.active_session_permits.available_permits())
    }

    pub async fn shutdown(mut self) -> Result<(), DaemonListenerError> {
        let started = Instant::now();
        let deadline = started + self.shutdown_timeout;
        let graceful_deadline = started + self.shutdown_timeout / 2;
        let mut result = Ok(());
        self.shutdown.notify_one();
        if let Some(mut task) = self.accept_task.take() {
            match timeout_at(graceful_deadline, &mut task).await {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(()))) | Ok(Err(_)) => result = Err(DaemonListenerError::Task),
                Err(_) => {
                    task.abort();
                    match timeout_at(deadline, &mut task).await {
                        Ok(Ok(Ok(()))) => {}
                        Ok(Ok(Err(()))) => result = Err(DaemonListenerError::Task),
                        Ok(Err(error)) if error.is_cancelled() => {}
                        Ok(Err(_)) => result = Err(DaemonListenerError::Task),
                        Err(_) => result = Err(DaemonListenerError::ShutdownTimeout),
                    }
                }
            }
        }

        let profile = self.profile.clone();
        let locator = self.locator.clone();
        let cleanup =
            tokio::task::spawn_blocking(move || remove_locator_if_matches(&profile, &locator));
        match timeout_at(deadline, cleanup).await {
            Ok(Ok(Ok(_))) => {}
            Ok(Ok(Err(error))) => return Err(DaemonListenerError::Discovery(error)),
            Ok(Err(_)) => return Err(DaemonListenerError::Task),
            Err(_) => return Err(DaemonListenerError::ShutdownTimeout),
        }
        result
    }
}

impl Drop for DaemonListener {
    fn drop(&mut self) {
        if let Some(task) = self.accept_task.take() {
            task.abort();
        }
    }
}

fn identity_for_profile(profile_digest: &str) -> ConnectionIdentity {
    ConnectionIdentity::new(ConnectionIdentityConfig {
        principal: PrincipalId::new(profile_digest),
        tenant: TenantId::new(profile_digest),
        issued_at_ms: None,
        expires_at_ms: u64::MAX,
        binding_attributes: BindingAttributes::default(),
    })
}

fn rotate_away_from(value: &mut String, previous: &str) {
    if value == previous {
        let replacement = if value.starts_with('0') { "1" } else { "0" };
        value.replace_range(..1, replacement);
    }
}

trait ConnectionAcceptor: Send + Sync + 'static {
    fn accept(&self) -> impl Future<Output = io::Result<(TcpStream, SocketAddr)>> + Send;
}

impl ConnectionAcceptor for TcpListener {
    fn accept(&self) -> impl Future<Output = io::Result<(TcpStream, SocketAddr)>> + Send {
        TcpListener::accept(self)
    }
}

struct AcceptLoop<A, F> {
    acceptor: A,
    factory: Arc<F>,
    credentials: DaemonCredentials,
    shutdown: Arc<Notify>,
    config: ListenerConfig,
    pending_handshake_permits: Arc<Semaphore>,
    liveness_connection_permits: Arc<Semaphore>,
    active_session_permits: Arc<Semaphore>,
}

impl<A, F> AcceptLoop<A, F> {
    fn new(
        acceptor: A,
        factory: Arc<F>,
        credentials: DaemonCredentials,
        config: ListenerConfig,
    ) -> Self {
        Self {
            acceptor,
            factory,
            credentials,
            shutdown: Arc::new(Notify::new()),
            pending_handshake_permits: Arc::new(Semaphore::new(config.max_pending_handshakes)),
            liveness_connection_permits: Arc::new(Semaphore::new(config.max_liveness_connections)),
            active_session_permits: Arc::new(Semaphore::new(config.max_active_connections)),
            config,
        }
    }
}

fn locator_for(address: SocketAddr, credentials: &DaemonCredentials) -> DaemonLocator {
    DaemonLocator {
        endpoint: format!("ws://{address}{DAEMON_ROUTE}"),
        cluster_protocol: CLUSTER_PROTOCOL.to_owned(),
        daemon_protocol: DAEMON_PROTOCOL.to_owned(),
        profile_digest: credentials.profile_digest.clone(),
        daemon_nonce: credentials.daemon_nonce.clone(),
        capability: credentials.capability.clone(),
    }
}

fn spawn_listener_owner<A, F>(
    host: AcceptLoop<A, F>,
    profile: NativeProfile,
    locator: DaemonLocator,
) -> DaemonListener
where
    A: ConnectionAcceptor,
    F: NativeBackendFactory + Send + Sync + 'static,
{
    let config = host.config;
    let shutdown = Arc::clone(&host.shutdown);
    let pending_handshake_permits = Arc::clone(&host.pending_handshake_permits);
    let liveness_connection_permits = Arc::clone(&host.liveness_connection_permits);
    let active_session_permits = Arc::clone(&host.active_session_permits);
    let accept_task = tokio::spawn(run_owned_accept_loop(
        host,
        profile.clone(),
        locator.clone(),
    ));
    DaemonListener {
        profile,
        locator,
        shutdown,
        accept_task: Some(accept_task),
        shutdown_timeout: config.shutdown_timeout,
        pending_handshake_limit: config.max_pending_handshakes,
        pending_handshake_permits,
        liveness_connection_limit: config.max_liveness_connections,
        liveness_connection_permits,
        active_session_limit: config.max_active_connections,
        active_session_permits,
    }
}

async fn run_owned_accept_loop<A, F>(
    host: AcceptLoop<A, F>,
    profile: NativeProfile,
    locator: DaemonLocator,
) -> Result<(), ()>
where
    A: ConnectionAcceptor,
    F: NativeBackendFactory + Send + Sync + 'static,
{
    let result = AssertUnwindSafe(run_accept_loop(host))
        .catch_unwind()
        .await
        .unwrap_or(Err(()));
    let cleanup =
        tokio::task::spawn_blocking(move || remove_locator_if_matches(&profile, &locator)).await;
    match cleanup {
        Ok(Ok(_)) => result,
        Ok(Err(_)) | Err(_) => Err(()),
    }
}

async fn run_accept_loop<A, F>(host: AcceptLoop<A, F>) -> Result<(), ()>
where
    A: ConnectionAcceptor,
    F: NativeBackendFactory + Send + Sync + 'static,
{
    let AcceptLoop {
        acceptor,
        factory,
        credentials,
        shutdown,
        config,
        pending_handshake_permits,
        liveness_connection_permits,
        active_session_permits,
    } = host;
    let mut connections = JoinSet::new();
    let mut connection_failed = false;
    loop {
        tokio::select! {
            biased;
            () = shutdown.notified() => break,
            completed = connections.join_next(), if !connections.is_empty() => {
                if matches!(completed, Some(Err(_))) {
                    connection_failed = true;
                    break;
                }
            }
            accepted = acceptor.accept() => {
                let (stream, _peer) = match accepted {
                    Ok(accepted) => accepted,
                    Err(_) => {
                        connection_failed = true;
                        break;
                    }
                };
                let Ok(handshake_permit) =
                    Arc::clone(&pending_handshake_permits).try_acquire_owned()
                else {
                    drop(stream);
                    continue;
                };
                let factory = Arc::clone(&factory);
                let credentials = credentials.clone();
                let active_permits = Arc::clone(&active_session_permits);
                let liveness_connection_permits =
                    Arc::clone(&liveness_connection_permits);
                connections.spawn(async move {
                    serve_connection(ConnectionTask {
                        stream,
                        factory,
                        credentials,
                        active_permits,
                        liveness_connection_permits,
                        handshake_permit,
                        handshake_timeout: config.handshake_timeout,
                        liveness_timeout: config.liveness_timeout,
                    }).await;
                });
            }
        }
    }
    drop(acceptor);

    let drain_deadline = Instant::now() + config.drain_timeout;
    while !connections.is_empty() {
        match timeout_at(drain_deadline, connections.join_next()).await {
            Ok(Some(Ok(()))) => {}
            Ok(Some(Err(_))) => connection_failed = true,
            Ok(None) => break,
            Err(_) => {
                connections.abort_all();
                break;
            }
        }
    }
    if connection_failed { Err(()) } else { Ok(()) }
}

struct ConnectionTask<F> {
    stream: TcpStream,
    factory: Arc<F>,
    credentials: DaemonCredentials,
    active_permits: Arc<Semaphore>,
    liveness_connection_permits: Arc<Semaphore>,
    handshake_permit: OwnedSemaphorePermit,
    handshake_timeout: Duration,
    liveness_timeout: Duration,
}

async fn serve_connection<F>(connection: ConnectionTask<F>)
where
    F: NativeBackendFactory + Send + Sync + 'static,
{
    let ConnectionTask {
        stream,
        factory,
        credentials,
        active_permits,
        liveness_connection_permits,
        handshake_permit,
        handshake_timeout,
        liveness_timeout,
    } = connection;
    let identity = identity_for_profile(&credentials.profile_digest);
    let (callback, receipt) = AuthorizationCallback::new(credentials);
    let handshake = accept_hdr_async_with_config(stream, callback, Some(websocket_config()));
    let Ok(Ok(mut websocket)) = timeout(handshake_timeout, handshake).await else {
        return;
    };
    drop(handshake_permit);
    let Some(purpose) = receipt.take() else {
        return;
    };
    if purpose == ConnectionPurpose::Liveness {
        let Ok(_liveness_permit) = liveness_connection_permits.try_acquire_owned() else {
            return;
        };
        let deadline = Instant::now() + liveness_timeout;
        let transaction = async {
            let Some(Ok(Message::Text(request))) = websocket.next().await else {
                return;
            };
            let Ok(value) = serde_json::from_str::<Value>(request.as_ref()) else {
                return;
            };
            if value.get("method").and_then(Value::as_str) != Some("initialize") {
                return;
            }
            let binding = binding_for_route(factory.as_ref(), identity);
            let Ok(dispatcher) = binding.into_dispatcher().await else {
                return;
            };
            let response = dispatcher.dispatch(request.as_ref()).await;
            let _ = websocket.send(Message::Text(response.into())).await;
            let _ = websocket.close(None).await;
        };
        let _ = timeout_at(deadline, transaction).await;
        return;
    }
    let Ok(_permit) = active_permits.try_acquire_owned() else {
        return;
    };

    let binding = binding_for_route(factory.as_ref(), identity);
    let _ = serve_websocket(binding, websocket).await;
}

#[cfg(test)]
mod accept_loop_tests;
