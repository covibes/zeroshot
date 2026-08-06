use std::future::Future;
use std::io;
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{LegacyShipResult, LegacyShipStatus};
use openengine_cluster_server::admission::CancellationSignal;
use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionBinding, ConnectionIdentity, ConnectionIdentityConfig,
    PrincipalId, StaticConnectionIdentityResolver, SystemConnectionTime, TenantId,
};
use openengine_cluster_server::stdio::{serve_ndjson, NdjsonIo};
use sha2::{Digest as _, Sha256};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio::time::{sleep, timeout, Duration, Instant};

use super::config::HostedAuthority;
use super::server_auth::{
    authenticate_first_request, authentication_error, load_transport_capability,
    TransportCapability, AUTHENTICATION_DEADLINE,
};
use super::server_workspace::PreparedWorktreeReadiness;
use super::backend::HostedBackend;
use super::ports::{
    DeliveryIntent, DeliveryReadinessReceipt, DeliveryReceipt, ProxyCleanupReceipt,
    ProxyReadinessPort, ProxyReadinessReceipt, TrustedServiceError, WorkspaceDeliveryPort,
};

pub const OECP_PORT: u16 = 8080;
pub use super::server_auth::OECP_CAPABILITY_FILE_ENV;
const ACTIVE_CONNECTION_CAPACITY: usize = 32;
pub(super) const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(45);
// 10s start + 1s drain + 5s tree reap + three sequential 5s trusted-service stages.
pub(super) const SEQUENTIAL_FINALIZATION_BOUND: Duration = Duration::from_secs(31);
const _: () = assert!(SHUTDOWN_DEADLINE.as_secs() > SEQUENTIAL_FINALIZATION_BOUND.as_secs());
const STARTUP_DEADLINE: Duration = Duration::from_secs(30);
const STARTUP_RETRY_INTERVAL: Duration = Duration::from_millis(25);

pub async fn production_backend() -> io::Result<Arc<HostedBackend>> {
    let authority = HostedAuthority::from_environment()?;
    authority.verify_worker_configuration().await?;
    let delivery = Arc::new(InlineDirtyDelivery::new(
        authority.repository(),
        authority.base_revision(),
    ));
    Ok(Arc::new(HostedBackend::new(
        Arc::new(PreparedWorktreeReadiness),
        Arc::new(DirectProviderControl),
        delivery,
        authority,
    )))
}

pub async fn serve<F>(
    listener: TcpListener,
    backend: Arc<HostedBackend>,
    shutdown: F,
) -> io::Result<()>
where
    F: Future<Output = ()>,
{
    let capability = prepare_server(&backend).await?;
    serve_prepared(listener, backend, capability, shutdown).await
}

pub(super) async fn prepare_server(
    backend: &HostedBackend,
) -> io::Result<Arc<TransportCapability>> {
    let capability = Arc::new(load_startup_capability().await?);
    verify_startup_readiness(backend).await?;
    Ok(capability)
}

pub(super) async fn serve_prepared<F>(
    listener: TcpListener,
    backend: Arc<HostedBackend>,
    capability: Arc<TransportCapability>,
    shutdown: F,
) -> io::Result<()>
where
    F: Future<Output = ()>,
{
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

async fn load_startup_capability() -> io::Result<TransportCapability> {
    let deadline = Instant::now() + STARTUP_DEADLINE;
    loop {
        match load_transport_capability() {
            Ok(capability) => return Ok(capability),
            Err(error) if error.kind() == io::ErrorKind::NotFound && Instant::now() < deadline => {
                sleep(STARTUP_RETRY_INTERVAL).await;
            }
            Err(_) => return Err(io::Error::other("hosted OECP capability unavailable")),
        }
    }
}

async fn verify_startup_readiness(backend: &HostedBackend) -> io::Result<()> {
    let deadline = Instant::now() + STARTUP_DEADLINE;
    loop {
        match backend.verify_startup_readiness().await {
            Ok(()) => return Ok(()),
            Err(_) if Instant::now() < deadline => sleep(STARTUP_RETRY_INTERVAL).await,
            Err(_) => return Err(io::Error::other("hosted startup readiness failed")),
        }
    }
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

fn static_identity() -> ConnectionIdentity {
    ConnectionIdentity::new(ConnectionIdentityConfig {
        principal: PrincipalId::new("hosted-capsule"),
        tenant: TenantId::new("hosted-capsule"),
        issued_at_ms: None,
        expires_at_ms: u64::MAX,
        binding_attributes: BindingAttributes::default(),
    })
}

struct DirectProviderControl;

#[async_trait]
impl ProxyReadinessPort for DirectProviderControl {
    async fn verify_ready(&self) -> Result<ProxyReadinessReceipt, TrustedServiceError> {
        Ok(ProxyReadinessReceipt::ready())
    }

    async fn stop_admission_and_cleanup(&self) -> Result<ProxyCleanupReceipt, TrustedServiceError> {
        Ok(ProxyCleanupReceipt::complete())
    }
}

pub(super) struct InlineDirtyDelivery {
    repository: String,
    base_revision: String,
}

impl InlineDirtyDelivery {
    pub(super) fn new(repository: &str, base_revision: &str) -> Self {
        Self {
            repository: repository.to_owned(),
            base_revision: base_revision.to_owned(),
        }
    }

    pub(super) fn validate(&self, intent: &DeliveryIntent) -> Result<String, TrustedServiceError> {
        let result: LegacyShipResult = serde_json::from_value(intent.output.clone())
            .map_err(|_| TrustedServiceError::InvalidReceipt)?;
        let (repository, branch, head, review) = successful_delivery_fields(result)?;
        let branch_digest = format!("{:x}", Sha256::digest(intent.worker_cluster_id.as_bytes()));
        let expected_branch = format!("zeroshot/hosted-{}", &branch_digest[..20]);
        let review_prefix = format!("https://github.com/{repository}/pull/");
        let valid = repository == self.repository
            && branch == expected_branch
            && valid_head_revision(&head, &self.base_revision)
            && valid_review_number(&review, &review_prefix);
        valid
            .then_some(review)
            .ok_or(TrustedServiceError::InvalidReceipt)
    }
}

fn successful_delivery_fields(
    result: LegacyShipResult,
) -> Result<(String, String, String, String), TrustedServiceError> {
    if result.status != LegacyShipStatus::Succeeded {
        return Err(TrustedServiceError::InvalidReceipt);
    }
    match (
        result.repository,
        result.branch,
        result.head_revision,
        result.pull_request_url,
    ) {
        (Some(repository), Some(branch), Some(head), Some(review)) => {
            Ok((repository, branch, head, review))
        }
        _ => Err(TrustedServiceError::InvalidReceipt),
    }
}

fn valid_head_revision(head: &str, base_revision: &str) -> bool {
    head != base_revision
        && head.len() == 40
        && head
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_review_number(review: &str, prefix: &str) -> bool {
    let Some(number) = review.strip_prefix(prefix) else {
        return false;
    };
    !number.is_empty()
        && !number.starts_with('0')
        && number.bytes().all(|byte| byte.is_ascii_digit())
}

#[async_trait]
impl WorkspaceDeliveryPort for InlineDirtyDelivery {
    async fn verify_ready(&self) -> Result<DeliveryReadinessReceipt, TrustedServiceError> {
        Ok(DeliveryReadinessReceipt::ready())
    }

    async fn deliver(
        &self,
        intent: DeliveryIntent,
    ) -> Result<DeliveryReceipt, TrustedServiceError> {
        let review_ref = self.validate(&intent)?;
        Ok(DeliveryReceipt {
            review_ref,
            delivery_id: intent.delivery_id,
        })
    }
}
