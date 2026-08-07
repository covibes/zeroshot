use std::future::Future;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{LegacyShipResult, LegacyShipStatus};
use sha2::{Digest as _, Sha256};
use tokio::net::TcpListener;
use tokio::time::{sleep, Duration, Instant};

use super::backend::HostedBackend;
use super::credentials::CredentialStore;
use super::ports::{
    DeliveryIntent, DeliveryReadinessReceipt, DeliveryReceipt, ProxyCleanupReceipt,
    ProxyReadinessPort, ProxyReadinessReceipt, TrustedServiceError, WorkspaceDeliveryPort,
};
use super::server_auth::{load_transport_capability, TransportCapability};
use super::server_workspace::PreparedWorktreeReadiness;
pub(super) use super::server_transport::{serve_prepared, HostedListeners};

pub const OECP_PORT: u16 = 8_085;
pub const OECP_WEBSOCKET_PORT: u16 = 8_083;
pub const RUN_INTENT_PORT: u16 = 8_084;
pub use super::server_auth::OECP_CAPABILITY_FILE_ENV;
const STARTUP_DEADLINE: Duration = Duration::from_secs(30);
const STARTUP_RETRY_INTERVAL: Duration = Duration::from_millis(25);

pub async fn production_backend() -> io::Result<Arc<HostedBackend>> {
    let credentials = CredentialStore::default();
    Ok(Arc::new(HostedBackend::production(
        Arc::new(PreparedWorktreeReadiness),
        Arc::new(DirectProviderControl),
        Arc::new(InlineDirtyDelivery {
            credentials: credentials.clone(),
        }),
        credentials,
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
    let websocket =
        TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, OECP_WEBSOCKET_PORT))).await?;
    let run_intent =
        TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, RUN_INTENT_PORT))).await?;
    serve_prepared(
        HostedListeners::new(listener, websocket, run_intent),
        backend,
        capability,
        shutdown,
    )
    .await
}

pub(super) async fn prepare_server(
    _backend: &HostedBackend,
) -> io::Result<Arc<TransportCapability>> {
    let capability = Arc::new(load_startup_capability().await?);
    Ok(capability)
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
    pub(super) credentials: CredentialStore,
}

impl InlineDirtyDelivery {
    pub(super) fn validate(
        &self,
        intent: &DeliveryIntent,
        repository: &str,
        base_revision: &str,
    ) -> Result<String, TrustedServiceError> {
        let result: LegacyShipResult = serde_json::from_value(intent.output.clone())
            .map_err(|_| TrustedServiceError::InvalidReceipt)?;
        let (actual_repository, branch, head, review) = successful_delivery_fields(result)?;
        let branch_digest = format!("{:x}", Sha256::digest(intent.worker_cluster_id.as_bytes()));
        let expected_branch = format!("zeroshot/hosted-{}", &branch_digest[..20]);
        let review_prefix = format!("https://github.com/{repository}/pull/");
        let valid = actual_repository == repository
            && branch == expected_branch
            && valid_head_revision(&head, base_revision)
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
        let credentials = self
            .credentials
            .resolve()
            .await
            .map_err(|_| TrustedServiceError::Unavailable)?;
        let authority = credentials.authority();
        let review_ref =
            self.validate(&intent, authority.repository(), authority.base_revision())?;
        Ok(DeliveryReceipt {
            review_ref,
            delivery_id: intent.delivery_id,
        })
    }
}
