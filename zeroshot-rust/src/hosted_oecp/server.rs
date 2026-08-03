use std::future::Future;
use std::io;
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_server::admission::CancellationSignal;
use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionBinding, ConnectionIdentity, ConnectionIdentityConfig,
    PrincipalId, StaticConnectionIdentityResolver, SystemConnectionTime, TenantId,
};
use openengine_cluster_server::stdio::{serve_ndjson, NdjsonIo};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, Semaphore};
use tokio::task::JoinSet;
use tokio::time::{timeout, Duration};

use super::server_auth::{
    authenticate_first_request, authentication_error, load_transport_capability,
    TransportCapability, AUTHENTICATION_DEADLINE,
};
use super::server_workspace::PreparedWorktreeReadiness;
use super::backend::HostedBackend;
use super::ports::{
    DeliveryIntent, DeliveryReadinessReceipt, DeliveryReceipt, ProxyCleanupReceipt,
    ProxyReadinessPort, ProxyReadinessReceipt, TrustedServiceError, WorkspaceDeliveryPort,
    CAPSULE_AGENT_SOCKET_ROOT,
};

pub const OECP_PORT: u16 = 8080;
pub use super::server_auth::OECP_CAPABILITY_FILE_ENV;
const ACTIVE_CONNECTION_CAPACITY: usize = 32;
const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(20);
const TRUSTED_SERVICE_DEADLINE: Duration = Duration::from_secs(5);
const MAX_TRUSTED_FRAME_BYTES: u64 = 4096;
const PROXY_CONTROL_SOCKET: &str = "/run/zeroshot-capsule-agent/proxy.sock";
const DELIVERY_SOCKET: &str = "/run/zeroshot-capsule-agent/delivery.sock";

pub fn production_backend() -> Arc<HostedBackend> {
    Arc::new(HostedBackend::new(
        Arc::new(PreparedWorktreeReadiness),
        Arc::new(FixedLoopbackProxy::new()),
        Arc::new(CapsuleAgentDelivery::new()),
    ))
}

pub async fn serve<F>(
    listener: TcpListener,
    backend: Arc<HostedBackend>,
    shutdown: F,
) -> io::Result<()>
where
    F: Future<Output = ()>,
{
    let capability = Arc::new(
        load_transport_capability()
            .map_err(|_| io::Error::other("hosted OECP capability unavailable"))?,
    );
    backend
        .verify_startup_readiness()
        .await
        .map_err(|_| io::Error::other("hosted startup readiness failed"))?;
    let capacity = Arc::new(Semaphore::new(ACTIVE_CONNECTION_CAPACITY));
    let mut connections = JoinSet::new();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            () = &mut shutdown => break,
            completed = connections.join_next(), if !connections.is_empty() => {
                if let Some(Err(error)) = completed {
                    return Err(io::Error::other(error));
                }
            }
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let Ok(permit) = Arc::clone(&capacity).try_acquire_owned() else {
                    continue;
                };
                let backend = Arc::clone(&backend);
                let capability = Arc::clone(&capability);
                connections.spawn(async move {
                    let _permit = permit;
                    let _ = serve_connection(stream, backend, capability).await;
                });
            }
        }
    }

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
    Ok(())
}

async fn serve_connection(
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
    let binding = ConnectionBinding::new(
        backend,
        StaticConnectionIdentityResolver::new(static_identity()),
        SystemConnectionTime,
        CancellationSignal::default(),
    );
    serve_ndjson(binding, NdjsonIo::new(reader, writer, tokio::io::sink())).await
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

struct FixedLoopbackProxy {
    control: TrustedChannel,
}

impl FixedLoopbackProxy {
    fn new() -> Self {
        Self {
            control: TrustedChannel::new(PROXY_CONTROL_SOCKET),
        }
    }
}

#[async_trait]
impl ProxyReadinessPort for FixedLoopbackProxy {
    async fn verify_ready(&self) -> Result<ProxyReadinessReceipt, TrustedServiceError> {
        timeout(
            TRUSTED_SERVICE_DEADLINE,
            TcpStream::connect(("127.0.0.1", 8081)),
        )
        .await
        .map_err(|_| TrustedServiceError::DeadlineExceeded)?
        .map_err(|_| TrustedServiceError::Unavailable)?;
        self.control.connect().await?;
        Ok(ProxyReadinessReceipt::ready())
    }

    async fn stop_admission_and_cleanup(&self) -> Result<ProxyCleanupReceipt, TrustedServiceError> {
        let response: ProxyCleanupWire = self
            .control
            .exchange(&ProxyControlRequest {
                version: 1,
                operation: "stop_and_cleanup",
            })
            .await?;
        if response.version == 1 && response.admission_stopped && response.credentials_cleaned {
            Ok(ProxyCleanupReceipt::complete())
        } else {
            Err(TrustedServiceError::InvalidReceipt)
        }
    }
}

struct CapsuleAgentDelivery {
    delivery: TrustedChannel,
}

impl CapsuleAgentDelivery {
    fn new() -> Self {
        Self {
            delivery: TrustedChannel::new(DELIVERY_SOCKET),
        }
    }
}

#[async_trait]
impl WorkspaceDeliveryPort for CapsuleAgentDelivery {
    async fn verify_ready(&self) -> Result<DeliveryReadinessReceipt, TrustedServiceError> {
        self.delivery.connect().await?;
        Ok(DeliveryReadinessReceipt::ready())
    }

    async fn deliver(
        &self,
        intent: DeliveryIntent,
    ) -> Result<DeliveryReceipt, TrustedServiceError> {
        let response: DeliveryWire = self
            .delivery
            .exchange(&DeliveryRequest {
                version: 1,
                operation: "deliver",
                intent,
            })
            .await?;
        if response.version != 1 {
            return Err(TrustedServiceError::InvalidReceipt);
        }
        Ok(response.receipt)
    }
}

#[cfg(unix)]
struct TrustedChannel {
    socket: &'static str,
    stream: Mutex<Option<tokio::net::UnixStream>>,
}

#[cfg(unix)]
impl TrustedChannel {
    fn new(socket: &'static str) -> Self {
        Self {
            socket,
            stream: Mutex::new(None),
        }
    }

    async fn connect(&self) -> Result<(), TrustedServiceError> {
        let mut retained = self.stream.lock().await;
        if retained.is_some() {
            return Ok(());
        }
        if !self.socket.starts_with(CAPSULE_AGENT_SOCKET_ROOT) {
            return Err(TrustedServiceError::Unavailable);
        }
        let stream = timeout(
            TRUSTED_SERVICE_DEADLINE,
            tokio::net::UnixStream::connect(self.socket),
        )
        .await
        .map_err(|_| TrustedServiceError::DeadlineExceeded)?
        .map_err(|_| TrustedServiceError::Unavailable)?;
        *retained = Some(stream);
        Ok(())
    }

    async fn exchange<T, R>(&self, request: &T) -> Result<R, TrustedServiceError>
    where
        T: Serialize,
        R: for<'de> Deserialize<'de>,
    {
        let stream = self
            .stream
            .lock()
            .await
            .take()
            .ok_or(TrustedServiceError::Unavailable)?;
        let frame = encode_trusted_frame(request)?;
        timeout(
            TRUSTED_SERVICE_DEADLINE,
            exchange_trusted_frame(stream, &frame),
        )
        .await
        .map_err(|_| TrustedServiceError::DeadlineExceeded)?
    }
}

#[cfg(unix)]
fn encode_trusted_frame<T: Serialize>(request: &T) -> Result<Vec<u8>, TrustedServiceError> {
    let mut frame = serde_json::to_vec(request).map_err(|_| TrustedServiceError::InvalidReceipt)?;
    frame.push(b'\n');
    if frame.len() as u64 > MAX_TRUSTED_FRAME_BYTES {
        return Err(TrustedServiceError::InvalidReceipt);
    }
    Ok(frame)
}

#[cfg(unix)]
async fn exchange_trusted_frame<R>(
    mut stream: tokio::net::UnixStream,
    frame: &[u8],
) -> Result<R, TrustedServiceError>
where
    R: for<'de> Deserialize<'de>,
{
    stream
        .write_all(frame)
        .await
        .map_err(|_| TrustedServiceError::Unavailable)?;
    stream
        .shutdown()
        .await
        .map_err(|_| TrustedServiceError::Unavailable)?;
    let response = read_trusted_frame(stream).await?;
    serde_json::from_slice(&response).map_err(|_| TrustedServiceError::InvalidReceipt)
}

#[cfg(unix)]
async fn read_trusted_frame(
    stream: tokio::net::UnixStream,
) -> Result<Vec<u8>, TrustedServiceError> {
    let mut response = Vec::new();
    stream
        .take(MAX_TRUSTED_FRAME_BYTES + 1)
        .read_to_end(&mut response)
        .await
        .map_err(|_| TrustedServiceError::Unavailable)?;
    if response.is_empty() || response.len() as u64 > MAX_TRUSTED_FRAME_BYTES {
        return Err(TrustedServiceError::InvalidReceipt);
    }
    Ok(response)
}

#[cfg(not(unix))]
struct TrustedChannel;

#[cfg(not(unix))]
impl TrustedChannel {
    fn new(_socket: &'static str) -> Self {
        Self
    }

    async fn connect(&self) -> Result<(), TrustedServiceError> {
        Err(TrustedServiceError::Unavailable)
    }

    async fn exchange<T, R>(&self, _request: &T) -> Result<R, TrustedServiceError>
    where
        T: Serialize,
        R: for<'de> Deserialize<'de>,
    {
        Err(TrustedServiceError::Unavailable)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyControlRequest {
    version: u8,
    operation: &'static str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProxyCleanupWire {
    version: u8,
    admission_stopped: bool,
    credentials_cleaned: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryRequest {
    version: u8,
    operation: &'static str,
    intent: DeliveryIntent,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DeliveryWire {
    version: u8,
    receipt: DeliveryReceipt,
}
