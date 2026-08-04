use std::fmt;

use async_trait::async_trait;
use openengine_cluster_protocol::{Generation, RunId};
use serde::{Deserialize, Serialize};

pub const WORKSPACE_ROOT: &str = "/workspace";
pub const PROXY_ENDPOINT: &str = "http://127.0.0.1:8081/v1";
pub const PROXY_SENTINEL_KEY: &str = "zeroshot-capsule-sentinel";
pub const PROXY_MODEL: &str = "zeroshot-capsule-model";
pub const ISOLATION_PROFILE: &str = "isolation.prepared-worktree@1";
pub const PROVIDER_PROFILE: &str = "provider.fixed-proxy@1";
pub const CAPSULE_AGENT_SOCKET_ROOT: &str = "/run/zeroshot-capsule-agent";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrustedServiceError {
    Unavailable,
    UnsafeWorkspace,
    InvalidReceipt,
    DeadlineExceeded,
}

impl fmt::Display for TrustedServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "trusted service is unavailable",
            Self::UnsafeWorkspace => "prepared workspace failed the capsule safety contract",
            Self::InvalidReceipt => "trusted service returned an invalid receipt",
            Self::DeadlineExceeded => "trusted service exceeded its fixed deadline",
        })
    }
}

impl std::error::Error for TrustedServiceError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorktreeReadinessReceipt {
    _closed: (),
}

impl WorktreeReadinessReceipt {
    #[must_use]
    pub const fn ready() -> Self {
        Self { _closed: () }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProxyReadinessReceipt {
    _closed: (),
}

impl ProxyReadinessReceipt {
    #[must_use]
    pub const fn ready() -> Self {
        Self { _closed: () }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProxyCleanupReceipt {
    _closed: (),
}

impl ProxyCleanupReceipt {
    #[must_use]
    pub const fn complete() -> Self {
        Self { _closed: () }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeliveryReadinessReceipt {
    _closed: (),
}

impl DeliveryReadinessReceipt {
    #[must_use]
    pub const fn ready() -> Self {
        Self { _closed: () }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeliveryIntent {
    pub delivery_id: String,
    pub generation: Generation,
    pub run_id: RunId,
    pub worker_succeeded: bool,
}

impl DeliveryIntent {
    pub fn new(
        generation: Generation,
        run_id: RunId,
        worker_succeeded: bool,
    ) -> Result<Self, TrustedServiceError> {
        let delivery_id = format!("delivery:{}:{}", generation.get(), run_id.as_str());
        if delivery_id.len() > 256 || !safe_identifier(&delivery_id) {
            return Err(TrustedServiceError::InvalidReceipt);
        }
        Ok(Self {
            delivery_id,
            generation,
            run_id,
            worker_succeeded,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeliveryReceipt {
    pub delivery_id: String,
    pub review_ref: String,
}

impl DeliveryReceipt {
    pub fn validate_for(&self, intent: &DeliveryIntent) -> Result<(), TrustedServiceError> {
        let valid = self.delivery_id == intent.delivery_id
            && !self.review_ref.is_empty()
            && self.review_ref.len() <= 256
            && safe_identifier(&self.review_ref);
        valid
            .then_some(())
            .ok_or(TrustedServiceError::InvalidReceipt)
    }
}

fn safe_identifier(value: &str) -> bool {
    value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
    })
}

#[async_trait]
pub trait WorktreeReadinessPort: Send + Sync {
    async fn verify_ready(&self) -> Result<WorktreeReadinessReceipt, TrustedServiceError>;

    async fn verify_delivery_ready(&self) -> Result<WorktreeReadinessReceipt, TrustedServiceError> {
        self.verify_ready().await
    }
}

#[async_trait]
pub trait ProxyReadinessPort: Send + Sync {
    async fn verify_ready(&self) -> Result<ProxyReadinessReceipt, TrustedServiceError>;

    async fn stop_admission_and_cleanup(&self) -> Result<ProxyCleanupReceipt, TrustedServiceError>;
}

#[async_trait]
pub trait WorkspaceDeliveryPort: Send + Sync {
    async fn verify_ready(&self) -> Result<DeliveryReadinessReceipt, TrustedServiceError>;

    async fn deliver(&self, intent: DeliveryIntent)
    -> Result<DeliveryReceipt, TrustedServiceError>;
}
