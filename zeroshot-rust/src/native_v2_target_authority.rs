//! Target-wide native-v2 control authority and its public network boundary.
//!
//! Source selection is immutable before this boundary. HTTP submission is the only creation seam;
//! OECP observes and controls runs already admitted to the target's ledger namespace.

mod private_access;
mod transport;

use std::sync::Arc;

use async_trait::async_trait;
pub use openengine_cluster_protocol::{
    TargetAuthentication, TargetDiscoveryDocument, TargetOecpSession, TargetOecpSessionRequest,
    TargetRunReceipt, TargetRunRequest,
};
pub use openengine_cluster_protocol::{
    TARGET_CONTROLLER_AUDIENCE as CONTROLLER_AUDIENCE, TARGET_DISCOVERY_KIND as DISCOVERY_KIND,
    TARGET_DISCOVERY_PATH as DISCOVERY_PATH, TARGET_OECP_PATH as OECP_PATH,
    TARGET_PRIVATE_BOOTSTRAP_PATH, TARGET_RUN_PATH as RUN_PATH,
    TARGET_SESSION_PATH as SESSION_PATH,
};
use openengine_cluster_server::identity::ConnectionIdentity;
use thiserror::Error;
use tokio::sync::Mutex;

use crate::native_v2_cloud::NativeV2CloudController;
pub use transport::NativeV2TargetServer;
pub use private_access::TargetBootstrapKey;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TargetAuthorityErrorKind {
    Invalid,
    Unauthorized,
    Conflict,
    Unavailable,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("{message}")]
pub struct TargetAuthorityError {
    kind: TargetAuthorityErrorKind,
    message: String,
}

impl TargetAuthorityError {
    #[must_use]
    pub fn new(kind: TargetAuthorityErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    #[must_use]
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(TargetAuthorityErrorKind::Invalid, message)
    }

    #[must_use]
    pub fn unauthorized() -> Self {
        Self::new(TargetAuthorityErrorKind::Unauthorized, "unauthorized")
    }

    #[must_use]
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(TargetAuthorityErrorKind::Conflict, message)
    }

    #[must_use]
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(TargetAuthorityErrorKind::Unavailable, message)
    }

    #[must_use]
    pub const fn kind(&self) -> TargetAuthorityErrorKind {
        self.kind
    }
}

/// Production composition port. Its implementation owns the durable ledger, controller
/// environment, exact source checkout, and private capsule allocator for this target process.
#[async_trait]
pub trait TargetControllerFactory: Send + Sync {
    async fn create(&self) -> Result<Arc<NativeV2CloudController>, TargetAuthorityError>;

    async fn submit(
        &self,
        controller: &NativeV2CloudController,
        request: TargetRunRequest,
    ) -> Result<TargetRunReceipt, TargetAuthorityError>;
}

/// Existing host authentication plugs into this narrow boundary. The target server neither
/// stores provider credentials nor interprets access tokens.
#[async_trait]
pub trait TargetSessionAuthority: Send + Sync {
    async fn authenticate_control(
        &self,
        bearer_token: &str,
    ) -> Result<ConnectionIdentity, TargetAuthorityError>;

    async fn issue_oecp(
        &self,
        identity: &ConnectionIdentity,
        request: &TargetOecpSessionRequest,
    ) -> Result<String, TargetAuthorityError>;

    async fn authenticate_oecp(
        &self,
        bearer_token: &str,
    ) -> Result<ConnectionIdentity, TargetAuthorityError>;
}

struct AuthorityState {
    controller: Option<Arc<NativeV2CloudController>>,
}

/// One target-wide state machine shared by every HTTP and OECP connection.
pub struct NativeV2TargetAuthority {
    factory: Arc<dyn TargetControllerFactory>,
    state: Mutex<AuthorityState>,
    submission_turn: Mutex<()>,
}

impl NativeV2TargetAuthority {
    #[must_use]
    pub fn new(factory: Arc<dyn TargetControllerFactory>) -> Self {
        Self {
            factory,
            state: Mutex::new(AuthorityState { controller: None }),
            submission_turn: Mutex::new(()),
        }
    }

    /// Activates exactly one controller and returns the same authority for every target session.
    pub async fn controller(&self) -> Result<Arc<NativeV2CloudController>, TargetAuthorityError> {
        let mut state = self.state.lock().await;
        if let Some(controller) = &state.controller {
            return Ok(controller.clone());
        }
        let controller = self.factory.create().await?;
        state.controller = Some(controller.clone());
        Ok(controller)
    }

    /// Validates and accepts one caller-assigned exact run under the target's durable authority.
    pub async fn submit(
        &self,
        request: TargetRunRequest,
    ) -> Result<TargetRunReceipt, TargetAuthorityError> {
        // The target factory's durable retry preflight, mutable source resolution, and ledger
        // create must be one host turn. Otherwise two identical retries can resolve different
        // branch heads and turn the losing retry into a false submission conflict.
        let _turn = self.submission_turn.lock().await;
        let controller = self.controller().await?;
        self.factory.submit(&controller, request).await
    }
}

#[cfg(test)]
#[path = "native_v2_target_authority/tests.rs"]
mod tests;
