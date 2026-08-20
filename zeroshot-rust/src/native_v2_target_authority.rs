//! Target-wide native-v2 control authority and its public network boundary.
//!
//! The public object is a target, never a capsule. Setup installs one repository and optional
//! default branch atomically. The first authenticated OECP session activates the target
//! adapter; every later connection observes the same RunId/ledger namespace.

mod store;
mod transport;

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{RunId, SourceBranchId, SourceRepositoryId};
use openengine_cluster_server::identity::ConnectionIdentity;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::Mutex;

use crate::native_v2_cloud::NativeV2CloudController;
pub use crate::native_v2_contract::RunSubmissionIntent as TargetRunIntent;

pub use store::{FileTargetSetupStore, TargetSetupStore};
pub use transport::NativeV2TargetServer;

#[cfg(test)]
use store::encode_hex;

pub const DISCOVERY_PATH: &str = "/.well-known/zeroshot-native-v2";
pub const SETUP_PATH: &str = "/native-v2/setup";
pub const RUN_PATH: &str = "/native-v2/run";
pub const SESSION_PATH: &str = "/native-v2/oecp-session";
pub const OECP_PATH: &str = "/native-v2/oecp";
pub const DISCOVERY_KIND: &str = "zeroshot.native-v2-target/v1";
pub const CONTROLLER_AUDIENCE: &str = "controller";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetRunReceipt {
    pub run_id: RunId,
}

/// Secret-free target setup installed as one value.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetSetupDocument {
    pub repository: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
}

impl TargetSetupDocument {
    pub fn validate(&self) -> Result<(), TargetAuthorityError> {
        if !valid_target_repository(&self.repository) {
            return Err(TargetAuthorityError::invalid(
                "repository must have the form owner/name",
            ));
        }
        if self
            .default_branch
            .as_deref()
            .is_some_and(|branch| !valid_target_branch(branch))
        {
            return Err(TargetAuthorityError::invalid(
                "default branch must be a valid bounded Git branch",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetDiscoveryDocument {
    pub kind: String,
    pub setup_path: String,
    pub run_path: String,
    pub session_path: String,
    pub audience: String,
}

impl Default for TargetDiscoveryDocument {
    fn default() -> Self {
        Self {
            kind: DISCOVERY_KIND.to_owned(),
            setup_path: SETUP_PATH.to_owned(),
            run_path: RUN_PATH.to_owned(),
            session_path: SESSION_PATH.to_owned(),
            audience: CONTROLLER_AUDIENCE.to_owned(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetSetupOutcome {
    Installed,
    Unchanged,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetSetupResult {
    pub outcome: TargetSetupOutcome,
}

/// Short-lived session returned only after the host authenticates the target control bearer.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetOecpSession {
    pub endpoint: String,
    pub bearer_token: String,
}

impl fmt::Debug for TargetOecpSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TargetOecpSession")
            .field("endpoint", &self.endpoint)
            .field("bearer_token", &"[REDACTED]")
            .finish()
    }
}

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
/// environment, source checkout, and private capsule allocator for this installed target.
#[async_trait]
pub trait TargetControllerFactory: Send + Sync {
    async fn create(
        &self,
        setup: &TargetSetupDocument,
    ) -> Result<Arc<NativeV2CloudController>, TargetAuthorityError>;

    async fn submit(
        &self,
        setup: &TargetSetupDocument,
        controller: &NativeV2CloudController,
        intent: TargetRunIntent,
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
    ) -> Result<String, TargetAuthorityError>;

    async fn authenticate_oecp(
        &self,
        bearer_token: &str,
    ) -> Result<ConnectionIdentity, TargetAuthorityError>;
}

struct AuthorityState {
    setup: Option<TargetSetupDocument>,
    controller: Option<Arc<NativeV2CloudController>>,
}

/// One target-wide state machine shared by every HTTP and OECP connection.
pub struct NativeV2TargetAuthority {
    factory: Arc<dyn TargetControllerFactory>,
    setup_store: Option<Arc<dyn TargetSetupStore>>,
    state: Mutex<AuthorityState>,
    submission_turn: Mutex<()>,
}

impl NativeV2TargetAuthority {
    #[must_use]
    pub fn new(factory: Arc<dyn TargetControllerFactory>) -> Self {
        Self {
            factory,
            setup_store: None,
            state: Mutex::new(AuthorityState {
                setup: None,
                controller: None,
            }),
            submission_turn: Mutex::new(()),
        }
    }

    pub fn with_installed_setup(
        factory: Arc<dyn TargetControllerFactory>,
        setup: TargetSetupDocument,
    ) -> Result<Self, TargetAuthorityError> {
        setup.validate()?;
        Ok(Self {
            factory,
            setup_store: None,
            state: Mutex::new(AuthorityState {
                setup: Some(setup),
                controller: None,
            }),
            submission_turn: Mutex::new(()),
        })
    }

    /// Restores the one installed document before the target accepts sessions. Later installs are
    /// atomically persisted through the same store before becoming visible in memory.
    pub async fn with_setup_store(
        factory: Arc<dyn TargetControllerFactory>,
        setup_store: Arc<dyn TargetSetupStore>,
    ) -> Result<Self, TargetAuthorityError> {
        let setup = setup_store.load().await?;
        if let Some(setup) = &setup {
            setup.validate()?;
        }
        Ok(Self {
            factory,
            setup_store: Some(setup_store),
            state: Mutex::new(AuthorityState {
                setup,
                controller: None,
            }),
            submission_turn: Mutex::new(()),
        })
    }

    /// Atomically replaces the source selector used by later submissions. Already-admitted runs
    /// retain their durable snapshots.
    pub async fn install(
        &self,
        setup: TargetSetupDocument,
    ) -> Result<TargetSetupOutcome, TargetAuthorityError> {
        setup.validate()?;
        let mut state = self.state.lock().await;
        if state.setup.as_ref() == Some(&setup) {
            return Ok(TargetSetupOutcome::Unchanged);
        }
        if let Some(store) = &self.setup_store {
            store.replace(&setup).await?;
        }
        state.setup = Some(setup);
        Ok(TargetSetupOutcome::Installed)
    }

    /// Activates exactly one controller and returns the same authority for every target session.
    pub async fn controller(&self) -> Result<Arc<NativeV2CloudController>, TargetAuthorityError> {
        let mut state = self.state.lock().await;
        if let Some(controller) = &state.controller {
            return Ok(controller.clone());
        }
        let setup = state
            .setup
            .clone()
            .ok_or_else(|| TargetAuthorityError::conflict("target setup is not installed"))?;
        let controller = self.factory.create(&setup).await?;
        state.controller = Some(controller.clone());
        Ok(controller)
    }

    /// Resolves current target selection into a durable resolved source and host-assigned RunId.
    pub async fn submit(
        &self,
        intent: TargetRunIntent,
    ) -> Result<TargetRunReceipt, TargetAuthorityError> {
        // The target factory's durable retry preflight, mutable source resolution, and ledger
        // create must be one host turn. Otherwise two identical retries can resolve different
        // branch heads and turn the losing retry into a false submission conflict.
        let _turn = self.submission_turn.lock().await;
        let controller = self.controller().await?;
        let setup = self
            .state
            .lock()
            .await
            .setup
            .clone()
            .ok_or_else(|| TargetAuthorityError::conflict("target setup is not installed"))?;
        self.factory.submit(&setup, &controller, intent).await
    }
}

#[doc(hidden)]
#[must_use]
pub fn valid_target_repository(value: &str) -> bool {
    SourceRepositoryId::new(value).is_ok()
}

#[doc(hidden)]
#[must_use]
pub fn valid_target_branch(value: &str) -> bool {
    SourceBranchId::new(value).is_ok()
}

#[cfg(test)]
#[path = "native_v2_target_authority/tests.rs"]
mod tests;
