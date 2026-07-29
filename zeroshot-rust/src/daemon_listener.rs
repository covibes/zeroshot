//! One authenticated loopback WebSocket listener per native profile.

use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use openengine_cluster_protocol::{JSON_RPC_VERSION, PROTOCOL_VERSION};
use openengine_cluster_server::websocket::{serve_websocket, websocket_config};
use openengine_cluster_server::ConnectionContext;
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
use crate::{NativeBackendFactory, dispatcher_for_route};

#[derive(Clone, Copy, Debug)]
pub struct ListenerConfig {
    pub startup_lock_timeout: Duration,
    pub liveness_timeout: Duration,
    pub handshake_timeout: Duration,
    pub drain_timeout: Duration,
    pub shutdown_timeout: Duration,
    pub max_active_connections: usize,
    pub max_pending_handshakes: usize,
    pub max_liveness_connections: usize,
}

impl Default for ListenerConfig {
    fn default() -> Self {
        Self {
            startup_lock_timeout: Duration::from_secs(1),
            liveness_timeout: Duration::from_millis(500),
            handshake_timeout: Duration::from_secs(2),
            drain_timeout: Duration::from_millis(250),
            shutdown_timeout: Duration::from_secs(1),
            max_active_connections: 64,
            max_pending_handshakes: 64,
            max_liveness_connections: 8,
        }
    }
}

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
    accept_task: Option<JoinHandle<()>>,
    shutdown_timeout: Duration,
    pending_handshake_limit: usize,
    pending_handshake_permits: Arc<Semaphore>,
    liveness_connection_limit: usize,
    liveness_connection_permits: Arc<Semaphore>,
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
        let locator = DaemonLocator {
            endpoint: format!("ws://{address}{DAEMON_ROUTE}"),
            cluster_protocol: CLUSTER_PROTOCOL.to_owned(),
            daemon_protocol: DAEMON_PROTOCOL.to_owned(),
            profile_digest: credentials.profile_digest.clone(),
            daemon_nonce: credentials.daemon_nonce.clone(),
            capability: credentials.capability.clone(),
        };

        let shutdown = Arc::new(Notify::new());
        let pending_handshake_permits = Arc::new(Semaphore::new(config.max_pending_handshakes));
        let liveness_connection_permits = Arc::new(Semaphore::new(config.max_liveness_connections));
        let accept_task = tokio::spawn(run_accept_loop(AcceptLoop {
            listener: tcp,
            factory: Arc::new(factory),
            credentials,
            shutdown: Arc::clone(&shutdown),
            pending_handshake_permits: Arc::clone(&pending_handshake_permits),
            liveness_connection_permits: Arc::clone(&liveness_connection_permits),
            config,
        }));
        if let Err(error) = replace_locator_locked(&profile, &locator) {
            accept_task.abort();
            let _ = accept_task.await;
            return Err(error.into());
        }
        drop(guard);

        Ok(Self {
            profile,
            locator,
            shutdown,
            accept_task: Some(accept_task),
            shutdown_timeout: config.shutdown_timeout,
            pending_handshake_limit: config.max_pending_handshakes,
            pending_handshake_permits,
            liveness_connection_limit: config.max_liveness_connections,
            liveness_connection_permits,
        })
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

    pub async fn shutdown(mut self) -> Result<(), DaemonListenerError> {
        let started = Instant::now();
        let deadline = started + self.shutdown_timeout;
        let graceful_deadline = started + self.shutdown_timeout / 2;
        let mut result = Ok(());
        self.shutdown.notify_one();
        if let Some(mut task) = self.accept_task.take() {
            match timeout_at(graceful_deadline, &mut task).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => result = Err(DaemonListenerError::Task),
                Err(_) => {
                    task.abort();
                    match timeout_at(deadline, &mut task).await {
                        Ok(Ok(())) => {}
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

pub async fn probe_liveness(locator: &DaemonLocator, deadline: Duration) -> LivenessOutcome {
    timeout(deadline, probe_liveness_inner(locator))
        .await
        .unwrap_or(LivenessOutcome::Indeterminate)
}

async fn probe_liveness_inner(locator: &DaemonLocator) -> LivenessOutcome {
    if locator.cluster_protocol != CLUSTER_PROTOCOL || locator.daemon_protocol != DAEMON_PROTOCOL {
        return LivenessOutcome::DefinitelyStale;
    }
    let mut request = match locator.endpoint.as_str().into_client_request() {
        Ok(request) => request,
        Err(_) => return LivenessOutcome::DefinitelyStale,
    };
    let Some(address) = loopback_address(&request) else {
        return LivenessOutcome::DefinitelyStale;
    };
    let expectation = match DaemonCredentials::from_locator(locator)
        .prepare_request(&mut request, ConnectionPurpose::Liveness)
    {
        Ok(expectation) => expectation,
        Err(_) => return LivenessOutcome::Indeterminate,
    };
    let stream = match TcpStream::connect(address).await {
        Ok(stream) => stream,
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
            return LivenessOutcome::DefinitelyStale;
        }
        Err(_) => return LivenessOutcome::Indeterminate,
    };
    let (mut websocket, response) = match tokio_tungstenite::client_async(request, stream).await {
        Ok(connected) => connected,
        Err(WebSocketError::Http(_)) => return LivenessOutcome::DefinitelyStale,
        Err(_) => return LivenessOutcome::Indeterminate,
    };
    if !expectation.verify(&response) {
        return LivenessOutcome::DefinitelyStale;
    }
    let initialize = serde_json::json!({
        "jsonrpc": JSON_RPC_VERSION,
        "id": "daemon-liveness",
        "method": "initialize",
        "params": { "protocolVersion": PROTOCOL_VERSION }
    });
    if websocket
        .send(Message::Text(initialize.to_string().into()))
        .await
        .is_err()
    {
        return LivenessOutcome::Indeterminate;
    }
    while let Some(message) = websocket.next().await {
        let message = match message {
            Ok(message) => message,
            Err(_) => return LivenessOutcome::Indeterminate,
        };
        let Message::Text(text) = message else {
            if message.is_close() {
                return LivenessOutcome::Indeterminate;
            }
            continue;
        };
        let response: Value = match serde_json::from_str(text.as_ref()) {
            Ok(response) => response,
            Err(_) => return LivenessOutcome::DefinitelyStale,
        };
        return if valid_liveness_response(&response) {
            LivenessOutcome::Alive
        } else {
            LivenessOutcome::DefinitelyStale
        };
    }
    LivenessOutcome::Indeterminate
}

fn valid_liveness_response(response: &Value) -> bool {
    let Some(object) = response.as_object() else {
        return false;
    };
    object.get("jsonrpc").and_then(Value::as_str) == Some(JSON_RPC_VERSION)
        && object.get("id").and_then(Value::as_str) == Some("daemon-liveness")
        && !object.contains_key("error")
        && response
            .pointer("/result/protocolVersion")
            .and_then(Value::as_str)
            == Some(PROTOCOL_VERSION)
}

fn rotate_away_from(value: &mut String, previous: &str) {
    if value == previous {
        let replacement = if value.starts_with('0') { "1" } else { "0" };
        value.replace_range(..1, replacement);
    }
}

fn loopback_address(
    request: &tokio_tungstenite::tungstenite::handshake::client::Request,
) -> Option<SocketAddr> {
    let uri = request.uri();
    if uri.scheme_str() != Some("ws")
        || uri.path() != DAEMON_ROUTE
        || uri.query().is_some()
        || uri.host() != Some("127.0.0.1")
    {
        return None;
    }
    Some(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        uri.port_u16()?,
    ))
}

struct AcceptLoop<F> {
    listener: TcpListener,
    factory: Arc<F>,
    credentials: DaemonCredentials,
    shutdown: Arc<Notify>,
    config: ListenerConfig,
    pending_handshake_permits: Arc<Semaphore>,
    liveness_connection_permits: Arc<Semaphore>,
}

async fn run_accept_loop<F>(host: AcceptLoop<F>)
where
    F: NativeBackendFactory + Send + Sync + 'static,
{
    let AcceptLoop {
        listener,
        factory,
        credentials,
        shutdown,
        config,
        pending_handshake_permits,
        liveness_connection_permits,
    } = host;
    let active_permits = Arc::new(Semaphore::new(config.max_active_connections));
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            () = shutdown.notified() => break,
            completed = connections.join_next(), if !connections.is_empty() => {
                let _ = completed;
            }
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { break };
                let Ok(handshake_permit) =
                    Arc::clone(&pending_handshake_permits).try_acquire_owned()
                else {
                    drop(stream);
                    continue;
                };
                let factory = Arc::clone(&factory);
                let credentials = credentials.clone();
                let active_permits = Arc::clone(&active_permits);
                let liveness_connection_permits =
                    Arc::clone(&liveness_connection_permits);
                connections.spawn(async move {
                    serve_connection(ConnectionTask {
                        stream,
                        peer,
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
    drop(listener);

    let drain_deadline = Instant::now() + config.drain_timeout;
    while !connections.is_empty() {
        match timeout_at(drain_deadline, connections.join_next()).await {
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {
                connections.abort_all();
                break;
            }
        }
    }
}

struct ConnectionTask<F> {
    stream: TcpStream,
    peer: SocketAddr,
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
        peer,
        factory,
        credentials,
        active_permits,
        liveness_connection_permits,
        handshake_permit,
        handshake_timeout,
        liveness_timeout,
    } = connection;
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
        let Ok(Some(Ok(Message::Text(request)))) =
            timeout(liveness_timeout, websocket.next()).await
        else {
            return;
        };
        let Ok(value) = serde_json::from_str::<Value>(request.as_ref()) else {
            return;
        };
        if value.get("method").and_then(Value::as_str) != Some("initialize") {
            return;
        }
        let context = ConnectionContext {
            peer_label: Some(peer.to_string()),
            ..ConnectionContext::default()
        };
        let dispatcher = dispatcher_for_route(factory.as_ref(), context);
        let response = dispatcher.dispatch(request.as_ref()).await;
        let _ = websocket.send(Message::Text(response.into())).await;
        let _ = websocket.close(None).await;
        return;
    }
    let Ok(_permit) = active_permits.try_acquire_owned() else {
        return;
    };

    let context = ConnectionContext {
        peer_label: Some(peer.to_string()),
        ..ConnectionContext::default()
    };
    let dispatcher = dispatcher_for_route(factory.as_ref(), context);
    let _ = serve_websocket(dispatcher, websocket).await;
}
