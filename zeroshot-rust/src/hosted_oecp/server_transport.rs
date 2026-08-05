use std::collections::BTreeMap;
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use openengine_cluster_server::{
    admission::CancellationSignal,
    identity::{
        BindingAttributes, ConnectionBinding, ConnectionIdentity, ConnectionIdentityConfig,
        PrincipalId, StaticConnectionIdentityResolver, SystemConnectionTime, TenantId,
    },
    stdio::{serve_ndjson, NdjsonIo},
    websocket::{serve_websocket, websocket_config},
};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        http::StatusCode,
    },
};

use super::backend::HostedBackend;
use super::run_intent::RunIntentExecutor;
use super::run_intent_executor::HostedRunIntentExecutor;
use super::run_intent_http::serve_run_intent_http;
use super::server_auth::{
    authenticate_first_request, authentication_error, TransportCapability, AUTHENTICATION_DEADLINE,
    RUNTIME_CAPABILITY_HEADER,
};

const ACTIVE_CONNECTION_CAPACITY: usize = 32;
const CONTROL_CONNECTION_CAPACITY: usize = 8;
const OECP_PATH: &str = "/oecp";
const CAPSULE_ID_HEADER: &str = "x-zero-capsule-id";
const ORGANIZATION_ID_HEADER: &str = "x-zero-organization-id";
const ACTOR_HANDLE_HEADER: &str = "x-zero-actor-handle";
const GRANT_EXPIRY_HEADER: &str = "x-capsule-grant-expires-at";
pub(super) const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(45);
// 10s start + 1s drain + 5s tree reap + three sequential 5s trusted-service stages.
pub(super) const SEQUENTIAL_FINALIZATION_BOUND: Duration = Duration::from_secs(31);
const _: () = assert!(SHUTDOWN_DEADLINE.as_secs() > SEQUENTIAL_FINALIZATION_BOUND.as_secs());

pub(super) struct HostedListeners {
    ndjson: TcpListener,
    websocket: TcpListener,
    run_intent: TcpListener,
}

impl HostedListeners {
    pub(super) fn new(
        ndjson: TcpListener,
        websocket: TcpListener,
        run_intent: TcpListener,
    ) -> Self {
        Self {
            ndjson,
            websocket,
            run_intent,
        }
    }
}

pub(super) async fn serve_prepared<F>(
    listeners: HostedListeners,
    backend: Arc<HostedBackend>,
    capability: Arc<TransportCapability>,
    shutdown: F,
) -> io::Result<()>
where
    F: Future<Output = ()>,
{
    let run_intents: Arc<dyn RunIntentExecutor> =
        Arc::new(HostedRunIntentExecutor::new(Arc::clone(&backend)));
    let services = Arc::new(ServerServices {
        backend: Arc::clone(&backend),
        capability,
        run_intents,
        ndjson_capacity: Arc::new(Semaphore::new(ACTIVE_CONNECTION_CAPACITY)),
        websocket_capacity: Arc::new(Semaphore::new(ACTIVE_CONNECTION_CAPACITY)),
        control_capacity: Arc::new(Semaphore::new(CONTROL_CONNECTION_CAPACITY)),
    });
    let mut connections = JoinSet::new();
    let result = run_listener_loop(&listeners, services, &mut connections, shutdown).await;
    let cleanup = async {
        let backend_cleanup = backend.shutdown().await;
        connections.abort_all();
        while connections.join_next().await.is_some() {}
        backend_cleanup.map_err(|_| io::Error::other("hosted trusted cleanup failed"))
    };
    timeout(SHUTDOWN_DEADLINE, cleanup).await.map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "hosted shutdown exceeded its deadline",
        )
    })??;
    result
}

struct ServerServices {
    backend: Arc<HostedBackend>,
    capability: Arc<TransportCapability>,
    run_intents: Arc<dyn RunIntentExecutor>,
    ndjson_capacity: Arc<Semaphore>,
    websocket_capacity: Arc<Semaphore>,
    control_capacity: Arc<Semaphore>,
}

#[derive(Clone, Copy)]
enum IncomingProtocol {
    Ndjson,
    WebSocket,
    RunIntent,
}

async fn run_listener_loop<F>(
    listeners: &HostedListeners,
    services: Arc<ServerServices>,
    connections: &mut JoinSet<()>,
    shutdown: F,
) -> io::Result<()>
where
    F: Future<Output = ()>,
{
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            () = &mut shutdown => break,
            completed = connections.join_next(), if !connections.is_empty() => {
                if let Some(Err(error)) = completed {
                    return Err(io::Error::other(error));
                }
            }
            accepted = listeners.ndjson.accept() =>
                spawn_connection(connections, Arc::clone(&services), IncomingProtocol::Ndjson, accepted?),
            accepted = listeners.websocket.accept() =>
                spawn_connection(connections, Arc::clone(&services), IncomingProtocol::WebSocket, accepted?),
            accepted = listeners.run_intent.accept() =>
                spawn_connection(connections, Arc::clone(&services), IncomingProtocol::RunIntent, accepted?),
        }
    }
    Ok(())
}

fn spawn_connection(
    connections: &mut JoinSet<()>,
    services: Arc<ServerServices>,
    protocol: IncomingProtocol,
    (stream, _peer): (TcpStream, SocketAddr),
) {
    let capacity = match protocol {
        IncomingProtocol::Ndjson => &services.ndjson_capacity,
        IncomingProtocol::WebSocket => &services.websocket_capacity,
        IncomingProtocol::RunIntent => &services.control_capacity,
    };
    let Ok(permit) = Arc::clone(capacity).try_acquire_owned() else {
        return;
    };
    connections.spawn(async move {
        let _ = serve_incoming(stream, services, protocol, permit).await;
    });
}

async fn serve_incoming(
    stream: TcpStream,
    services: Arc<ServerServices>,
    protocol: IncomingProtocol,
    _permit: OwnedSemaphorePermit,
) -> io::Result<()> {
    match protocol {
        IncomingProtocol::Ndjson => {
            serve_ndjson_connection(
                stream,
                services.backend.clone(),
                services.capability.clone(),
            )
            .await
        }
        IncomingProtocol::WebSocket => {
            serve_websocket_connection(
                stream,
                services.backend.clone(),
                services.capability.clone(),
            )
            .await
        }
        IncomingProtocol::RunIntent => {
            serve_run_intent_http(
                stream,
                services.run_intents.clone(),
                services.capability.clone(),
            )
            .await
        }
    }
}

async fn serve_ndjson_connection(
    mut stream: TcpStream,
    backend: Arc<HostedBackend>,
    capability: Arc<TransportCapability>,
) -> io::Result<()> {
    let authenticated = timeout(
        AUTHENTICATION_DEADLINE,
        authenticate_first_request(&mut stream, &capability),
    )
    .await
    .map_err(|_| authentication_error())??;
    let (reader, writer) = stream.into_split();
    let reader = tokio::io::AsyncReadExt::chain(std::io::Cursor::new(authenticated), reader);
    let cancellation = CancellationSignal::default();
    let binding = ConnectionBinding::new(
        backend,
        StaticConnectionIdentityResolver::new(static_identity()),
        SystemConnectionTime,
        cancellation.clone(),
    );
    let result = serve_ndjson(binding, NdjsonIo::new(reader, writer, tokio::io::sink())).await;
    cancellation.cancel();
    result
}

#[allow(clippy::result_large_err)]
async fn serve_websocket_connection(
    stream: TcpStream,
    backend: Arc<HostedBackend>,
    capability: Arc<TransportCapability>,
) -> io::Result<()> {
    let identity = Arc::new(Mutex::new(None));
    let captured = Arc::clone(&identity);
    let websocket = timeout(
        AUTHENTICATION_DEADLINE,
        accept_hdr_async_with_config(
            stream,
            move |request: &Request, response: Response| {
                let resolved =
                    resolve_websocket_identity(request, &capability).map_err(handshake_error)?;
                let Ok(mut slot) = captured.lock() else {
                    return Err(handshake_error((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "identity capture failed",
                    )));
                };
                *slot = Some(resolved);
                Ok(response)
            },
            Some(websocket_config()),
        ),
    )
    .await
    .map_err(|_| authentication_error())?
    .map_err(io::Error::other)?;
    let resolved = identity
        .lock()
        .map_err(|_| io::Error::other("identity capture was poisoned"))?
        .take()
        .ok_or_else(|| io::Error::other("identity was not captured"))?;
    let cancellation = CancellationSignal::default();
    let binding = ConnectionBinding::new(
        backend,
        StaticConnectionIdentityResolver::new(resolved),
        SystemConnectionTime,
        cancellation.clone(),
    );
    let result = serve_websocket(binding, websocket).await;
    cancellation.cancel();
    result
}

pub(super) fn resolve_websocket_identity(
    request: &Request,
    capability: &TransportCapability,
) -> Result<ConnectionIdentity, (StatusCode, &'static str)> {
    validate_websocket_request(request, capability)?;
    let capsule_id = one_header(request, CAPSULE_ID_HEADER)?;
    let organization_id = one_header(request, ORGANIZATION_ID_HEADER)?;
    let actor_handle = one_header(request, ACTOR_HANDLE_HEADER)?;
    let expires_at = one_header(request, GRANT_EXPIRY_HEADER)?
        .parse::<u64>()
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid grant expiry"))?;
    if expires_at <= unix_seconds() {
        return Err((StatusCode::UNAUTHORIZED, "expired runtime identity"));
    }
    let expires_at_ms = expires_at
        .checked_mul(1_000)
        .ok_or((StatusCode::BAD_REQUEST, "invalid grant expiry"))?;
    let attributes = BindingAttributes::new(BTreeMap::from([(
        "capsule_id".to_owned(),
        capsule_id.to_owned(),
    )]));
    Ok(ConnectionIdentity::new(ConnectionIdentityConfig {
        principal: PrincipalId::new(actor_handle),
        tenant: TenantId::new(organization_id),
        issued_at_ms: None,
        expires_at_ms,
        binding_attributes: attributes,
    }))
}

fn validate_websocket_request(
    request: &Request,
    capability: &TransportCapability,
) -> Result<(), (StatusCode, &'static str)> {
    if request.uri().path() != OECP_PATH {
        return Err((StatusCode::NOT_FOUND, "unknown OECP route"));
    }
    if request.headers().contains_key("authorization") {
        return Err((
            StatusCode::BAD_REQUEST,
            "public authorization reached the capsule runtime",
        ));
    }
    if !capability.matches(one_header(request, RUNTIME_CAPABILITY_HEADER)?.as_bytes()) {
        return Err((StatusCode::UNAUTHORIZED, "invalid runtime capability"));
    }
    Ok(())
}

fn one_header<'a>(
    request: &'a Request,
    name: &'static str,
) -> Result<&'a str, (StatusCode, &'static str)> {
    let mut values = request.headers().get_all(name).iter();
    let value = values
        .next()
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .ok_or((StatusCode::BAD_REQUEST, "missing runtime identity"))?;
    if values.next().is_some() {
        return Err((StatusCode::BAD_REQUEST, "ambiguous runtime identity"));
    }
    Ok(value)
}

fn handshake_error((status, message): (StatusCode, &'static str)) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(message.to_owned()));
    *response.status_mut() = status;
    response
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn static_identity() -> ConnectionIdentity {
    ConnectionIdentity::new(ConnectionIdentityConfig {
        principal: PrincipalId::new("hosted-capsule"),
        tenant: TenantId::new("hosted-capsule"),
        issued_at_ms: None,
        expires_at_ms: u64::MAX,
        binding_attributes: BindingAttributes::default(),
    })
}
