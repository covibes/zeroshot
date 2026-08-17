//! Target-wide native-v2 control authority and its public network boundary.
//!
//! The public object is a target, never a capsule. Setup installs one repository selector and
//! one secret-free runtime plan atomically. The first authenticated OECP session activates one
//! shared cloud controller; every later connection observes the same RunId/ledger namespace.

mod store;
mod transport;

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_server::identity::ConnectionIdentity;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::Mutex;

use crate::native_v2_cloud::NativeV2CloudController;
use crate::native_v2_contract::RuntimePlan;

pub use store::{FileTargetSetupStore, TargetSetupStore};
pub use transport::NativeV2TargetServer;

#[cfg(test)]
use store::encode_hex;

pub const DISCOVERY_PATH: &str = "/.well-known/zeroshot-native-v2";
pub const SETUP_PATH: &str = "/native-v2/setup";
pub const SESSION_PATH: &str = "/native-v2/oecp-session";
pub const OECP_PATH: &str = "/native-v2/oecp";
pub const DISCOVERY_KIND: &str = "zeroshot.native-v2-target/v1";
pub const CONTROLLER_AUDIENCE: &str = "controller";

/// Secret-free target setup installed as one value.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetSetupDocument {
    pub repository: String,
    pub base: TargetBase,
    pub runtime: RuntimePlan,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum TargetBase {
    Default,
    Branch {
        branch: String,
    },
    Revision {
        revision: String,
        target_branch: String,
    },
}

impl TargetSetupDocument {
    pub fn validate(&self) -> Result<(), TargetAuthorityError> {
        if !valid_target_repository(&self.repository) {
            return Err(TargetAuthorityError::invalid(
                "repository must have the form owner/name",
            ));
        }
        match &self.base {
            TargetBase::Default => {}
            TargetBase::Branch { branch } if valid_target_branch(branch) => {}
            TargetBase::Revision {
                revision,
                target_branch,
            } if is_exact_target_revision(revision) && valid_target_branch(target_branch) => {}
            _ => {
                return Err(TargetAuthorityError::invalid(
                    "base must be a bounded branch or lowercase 40-character revision",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetDiscoveryDocument {
    pub kind: String,
    pub setup_path: String,
    pub session_path: String,
    pub audience: String,
}

impl Default for TargetDiscoveryDocument {
    fn default() -> Self {
        Self {
            kind: DISCOVERY_KIND.to_owned(),
            setup_path: SETUP_PATH.to_owned(),
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
        })
    }

    /// Installs repository selector and runtime plan in one critical section. Before activation a
    /// different document replaces the old value. After activation only an exact reinstall is
    /// idempotent; divergent setup fails closed.
    pub async fn install(
        &self,
        setup: TargetSetupDocument,
    ) -> Result<TargetSetupOutcome, TargetAuthorityError> {
        setup.validate()?;
        let mut state = self.state.lock().await;
        if state.setup.as_ref() == Some(&setup) {
            return Ok(TargetSetupOutcome::Unchanged);
        }
        if state.controller.is_some() {
            return Err(TargetAuthorityError::conflict(
                "target setup cannot change after controller activation",
            ));
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
}

#[doc(hidden)]
#[must_use]
pub fn valid_target_repository(value: &str) -> bool {
    let Some((owner, name)) = value.split_once('/') else {
        return false;
    };
    value.len() <= 255
        && !name.contains('/')
        && valid_target_repository_part(owner)
        && valid_target_repository_part(name)
}

fn valid_target_repository_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[doc(hidden)]
#[must_use]
pub fn valid_target_branch(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value.starts_with('-')
        && !value.ends_with('.')
        && !value.ends_with(".lock")
        && !value.contains("..")
        && !value.contains("@{")
        && value.bytes().all(|byte| {
            byte.is_ascii_graphic()
                && !matches!(byte, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        })
}

/// CLI selector policy is intentionally stricter than persisted setup-document compatibility.
#[doc(hidden)]
#[must_use]
pub fn valid_cli_target_branch(value: &str) -> bool {
    valid_target_branch(value) && !value.ends_with('/')
}

#[doc(hidden)]
#[must_use]
pub fn is_exact_target_revision(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
#[path = "native_v2_target_authority/tests.rs"]
mod tests;
