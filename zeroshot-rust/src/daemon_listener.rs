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
use tokio::sync::{Notify, Semaphore};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{Instant, timeout, timeout_at};
use tokio_tungstenite::accept_hdr_async_with_config;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::daemon_auth::{AuthorizationCallback, DAEMON_ROUTE, DaemonCredentials};
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
    pub max_active_connections: usize,
}

impl Default for ListenerConfig {
    fn default() -> Self {
        Self {
            startup_lock_timeout: Duration::from_secs(1),
            liveness_timeout: Duration::from_millis(500),
            handshake_timeout: Duration::from_secs(2),
            drain_timeout: Duration::from_millis(250),
            max_active_connections: 64,
        }
    }
}

#[derive(Debug, Error)]
pub enum DaemonListenerError {
    #[error("an authenticated daemon already owns this native profile")]
    AlreadyRunning,
    #[error("daemon listener configuration requires at least one active connection slot")]
    InvalidConfiguration,
    #[error("daemon discovery failed: {0}")]
    Discovery(#[from] DiscoveryError),
    #[error("daemon listener I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("daemon listener task failed")]
    Task,
}

pub struct DaemonListener {
    profile: NativeProfile,
    locator: DaemonLocator,
    shutdown: Arc<Notify>,
    accept_task: Option<JoinHandle<()>>,
}

impl DaemonListener {
    pub async fn start<F>(
        profile: NativeProfile,
        factory: F,
    ) -> Result<Self, DaemonListenerError>
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
        if config.max_active_connections == 0 {
            return Err(DaemonListenerError::InvalidConfiguration);
        }
        let lock_profile = profile.clone();
        let lock_timeout = config.startup_lock_timeout;
        let guard = tokio::task::spawn_blocking(move || {
            acquire_start_guard(&lock_profile, lock_timeout)
        })
        .await
        .map_err(|_| DaemonListenerError::Task)??;

        let previous_secrets = if let Some(existing) = read_locator_locked(&profile)? {
            if probe_liveness(&existing, config.liveness_timeout).await {
                return Err(DaemonListenerError::AlreadyRunning);
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
        let accept_task = tokio::spawn(run_accept_loop(
            tcp,
            Arc::new(factory),
            credentials,
            Arc::clone(&shutdown),
            config,
        ));
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
        })
    }

    #[must_use]
    pub fn locator(&self) -> &DaemonLocator {
        &self.locator
    }

    pub async fn shutdown(mut self) -> Result<(), DaemonListenerError> {
        self.shutdown.notify_one();
        if let Some(task) = self.accept_task.take() {
            task.await.map_err(|_| DaemonListenerError::Task)?;
        }
        let profile = self.profile.clone();
        let locator = self.locator.clone();
        let removed = tokio::task::spawn_blocking(move || {
            remove_locator_if_matches(&profile, &locator)
        })
        .await
        .map_err(|_| DaemonListenerError::Task)??;
        let _ = removed;
        Ok(())
    }
}

impl Drop for DaemonListener {
    fn drop(&mut self) {
        if let Some(task) = self.accept_task.take() {
            task.abort();
        }
    }
}

pub async fn probe_liveness(locator: &DaemonLocator, deadline: Duration) -> bool {
    timeout(deadline, probe_liveness_inner(locator))
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(false)
}

async fn probe_liveness_inner(locator: &DaemonLocator) -> Result<bool, ()> {
    if locator.cluster_protocol != CLUSTER_PROTOCOL || locator.daemon_protocol != DAEMON_PROTOCOL {
        return Ok(false);
    }
    let mut request = locator
        .endpoint
        .as_str()
        .into_client_request()
        .map_err(|_| ())?;
    let address = loopback_address(&request).ok_or(())?;
    DaemonCredentials::from_locator(locator)
        .apply_to_request(&mut request)
        .map_err(|_| ())?;
    let stream = TcpStream::connect(address).await.map_err(|_| ())?;
    let (mut websocket, _) = tokio_tungstenite::client_async(request, stream)
        .await
        .map_err(|_| ())?;
    let initialize = serde_json::json!({
        "jsonrpc": JSON_RPC_VERSION,
        "id": "daemon-liveness",
        "method": "initialize",
        "params": { "protocolVersion": PROTOCOL_VERSION }
    });
    websocket
        .send(Message::Text(initialize.to_string().into()))
        .await
        .map_err(|_| ())?;
    while let Some(message) = websocket.next().await {
        let message = message.map_err(|_| ())?;
        let Message::Text(text) = message else {
            if message.is_close() {
                return Ok(false);
            }
            continue;
        };
        let response: Value = serde_json::from_str(text.as_ref()).map_err(|_| ())?;
        return Ok(response.get("id") == Some(&Value::String("daemon-liveness".to_owned()))
            && response
                .pointer("/result/protocolVersion")
                .and_then(Value::as_str)
                == Some(PROTOCOL_VERSION));
    }
    Ok(false)
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

async fn run_accept_loop<F>(
    listener: TcpListener,
    factory: Arc<F>,
    credentials: DaemonCredentials,
    shutdown: Arc<Notify>,
    config: ListenerConfig,
) where
    F: NativeBackendFactory + Send + Sync + 'static,
{
    let permits = Arc::new(Semaphore::new(config.max_active_connections));
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
                let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
                    drop(stream);
                    continue;
                };
                let factory = Arc::clone(&factory);
                let credentials = credentials.clone();
                connections.spawn(async move {
                    let _permit = permit;
                    serve_connection(stream, peer, factory, credentials, config.handshake_timeout).await;
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
                while connections.join_next().await.is_some() {}
                break;
            }
        }
    }
}

async fn serve_connection<F>(
    stream: TcpStream,
    peer: SocketAddr,
    factory: Arc<F>,
    credentials: DaemonCredentials,
    handshake_timeout: Duration,
) where
    F: NativeBackendFactory + Send + Sync + 'static,
{
    let handshake = accept_hdr_async_with_config(
        stream,
        AuthorizationCallback(credentials),
        Some(websocket_config()),
    );
    let Ok(Ok(websocket)) = timeout(handshake_timeout, handshake).await else {
        return;
    };

    let context = ConnectionContext {
        peer_label: Some(peer.to_string()),
        ..ConnectionContext::default()
    };
    let dispatcher = dispatcher_for_route(factory.as_ref(), context);
    let _ = serve_websocket(dispatcher, websocket).await;
}
