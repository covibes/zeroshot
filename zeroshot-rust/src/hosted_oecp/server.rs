use std::{
    collections::BTreeMap,
    future::{Future, IntoFuture},
    io,
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use openengine_cluster_server::{
    admission::CancellationSignal,
    identity::{
        BindingAttributes, ConnectionBinding, ConnectionIdentity, ConnectionIdentityConfig,
        PrincipalId, StaticConnectionIdentityResolver, SystemConnectionTime, TenantId,
    },
    websocket::{serve_websocket, websocket_config},
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::JoinSet,
};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        http::StatusCode,
    },
};

use super::{
    backend::HostedBackend,
    credentials::{router as credential_router, CREDENTIAL_PORT},
    run_intent::router as run_intent_router,
};

pub const OECP_PORT: u16 = 8_083;
const OECP_PATH: &str = "/oecp";
const ACTIVE_CONNECTION_CAPACITY: usize = 32;
const CAPSULE_ID_HEADER: &str = "x-zero-capsule-id";
const ORGANIZATION_ID_HEADER: &str = "x-zero-organization-id";
const ACTOR_HANDLE_HEADER: &str = "x-zero-actor-handle";
const GRANT_EXPIRY_HEADER: &str = "x-capsule-grant-expires-at";

pub async fn serve<F>(
    listener: TcpListener,
    backend: Arc<HostedBackend>,
    shutdown: F,
) -> io::Result<()>
where
    F: Future<Output = ()>,
{
    let credential_listener =
        TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, CREDENTIAL_PORT))).await?;
    let control_router =
        credential_router(Arc::clone(&backend)).merge(run_intent_router(Arc::clone(&backend)));
    let credential_server = axum::serve(credential_listener, control_router).into_future();
    tokio::pin!(credential_server);
    let capacity = Arc::new(Semaphore::new(ACTIVE_CONNECTION_CAPACITY));
    let mut connections = JoinSet::new();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            () = &mut shutdown => break,
            result = &mut credential_server => return result,
            completed = connections.join_next(), if !connections.is_empty() => {
                match completed {
                    Some(Ok(Ok(()))) | Some(Ok(Err(_))) | None => {}
                    Some(Err(error)) => return Err(io::Error::other(error)),
                }
            }
            accepted = listener.accept() => {
                let (stream, _peer) = accepted?;
                let Ok(permit) = Arc::clone(&capacity).try_acquire_owned() else {
                    continue;
                };
                let backend = Arc::clone(&backend);
                connections.spawn(async move {
                    let _permit = permit;
                    serve_connection(stream, backend).await
                });
            }
        }
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
    backend.shutdown().await;
    Ok(())
}

#[allow(clippy::result_large_err)]
async fn serve_connection(stream: TcpStream, backend: Arc<HostedBackend>) -> io::Result<()> {
    let identity = Arc::new(Mutex::new(None));
    let captured = Arc::clone(&identity);
    let websocket = accept_hdr_async_with_config(
        stream,
        move |request: &Request, response: Response| {
            let resolved = resolve_identity(request).map_err(handshake_error)?;
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
    )
    .await
    .map_err(io::Error::other)?;
    let resolved = identity
        .lock()
        .map_err(|_| io::Error::other("identity capture was poisoned"))?
        .take()
        .ok_or_else(|| io::Error::other("identity was not captured"))?;
    let binding = ConnectionBinding::new(
        backend,
        StaticConnectionIdentityResolver::new(resolved),
        SystemConnectionTime,
        CancellationSignal::default(),
    );
    serve_websocket(binding, websocket).await
}

fn resolve_identity(request: &Request) -> Result<ConnectionIdentity, (StatusCode, &'static str)> {
    if request.uri().path() != OECP_PATH {
        return Err((StatusCode::NOT_FOUND, "unknown OECP route"));
    }
    if request.headers().contains_key("authorization") {
        return Err((
            StatusCode::BAD_REQUEST,
            "public authorization reached the capsule runtime",
        ));
    }
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
