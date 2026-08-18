//! Native-v2 named-target connector.
//!
//! The CLI owns only a small local name-to-origin registry. A target control authority owns
//! discovery, device login, atomic source-selection installation, and issuance of one
//! authenticated target-scoped OECP session. Runtime plans belong to run submissions;
//! environment values remain host-owned and never cross this connector.

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroshot_engine::native_v2_cli::oecp::TargetConnector;
use zeroshot_engine::native_v2_cli::{NativeV2CliError, TargetAdd, TargetRunIntent, TargetSetup};
use openengine_cluster_protocol::RunSubmitResult;
pub use zeroshot_engine::native_v2_target_authority::{TargetBase, TargetSetupDocument};

mod contract;
mod controller_authority;
mod oecp;
mod registry;

use contract::{prepare_setup, prepare_target, validate_bearer_token, validate_target_name};
pub use oecp::{AuthenticatedOecpWebSocketDialer, TargetOecpDialer};
pub use registry::{FileTargetRegistry, TargetRegistry, default_target_registry_path};
pub use controller_authority::HostedTargetControlAuthority;

#[cfg(test)]
use contract::{normalize_base, normalize_origin};
#[cfg(test)]
#[path = "native_v2_target/tests.rs"]
mod tests;

/// The external contract which hosting must implement before the native-v2 CLI can reach cloud.
///
/// `install` is one atomic target-side operation: either both repository selection and the
/// companion runtime plan become current, or neither does. `oecp_session` returns an access token
/// and endpoint scoped to the selected target's public `run/*` surface.
#[async_trait]
pub trait TargetControlAuthority: Send + Sync {
    async fn discover(&self, target: &TargetRecord) -> Result<(), TargetAuthorityError>;
    async fn login(&self, target: &TargetRecord) -> Result<(), TargetAuthorityError>;
    async fn install(
        &self,
        target: &TargetRecord,
        setup: &TargetSetupDocument,
    ) -> Result<(), TargetAuthorityError>;
    async fn submit(
        &self,
        target: &TargetRecord,
        intent: &TargetRunIntent,
    ) -> Result<RunSubmitResult, TargetAuthorityError>;
    async fn oecp_session(
        &self,
        target: &TargetRecord,
    ) -> Result<AuthenticatedTargetOecp, TargetAuthorityError>;
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct TargetAuthorityError {
    message: String,
}

impl TargetAuthorityError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetRecord {
    pub id: String,
    pub name: String,
    pub origin: String,
    pub device_token: String,
}

/// Opaque authenticated session minted by the control authority. Debug output never includes the
/// bearer token.
pub struct AuthenticatedTargetOecp {
    endpoint: String,
    bearer_token: String,
}

impl AuthenticatedTargetOecp {
    fn new(
        endpoint: impl Into<String>,
        bearer_token: impl Into<String>,
    ) -> Result<Self, TargetConnectorError> {
        let session = Self {
            endpoint: endpoint.into(),
            bearer_token: bearer_token.into(),
        };
        validate_bearer_token(&session.bearer_token)?;
        Ok(session)
    }

    #[must_use]
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    fn bearer_token(&self) -> &str {
        &self.bearer_token
    }
}

impl fmt::Debug for AuthenticatedTargetOecp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthenticatedTargetOecp")
            .field("endpoint", &self.endpoint)
            .field("bearer_token", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Error)]
pub enum TargetConnectorError {
    #[error("target name must be 1-64 ASCII alphanumeric/hyphen characters")]
    InvalidName,
    #[error("target URL must be an HTTPS origin (literal loopback HTTP is allowed)")]
    InvalidOrigin,
    #[error("target {0:?} already exists")]
    AlreadyExists(String),
    #[error("target {0:?} not found")]
    NotFound(String),
    #[error("target registry path cannot be resolved: {0}")]
    RegistryPath(&'static str),
    #[error("target registry I/O failed: {0}")]
    RegistryIo(#[source] std::io::Error),
    #[error("target registry is malformed: {0}")]
    RegistryJson(#[source] serde_json::Error),
    #[error("target registry exceeds 1 MiB")]
    RegistryTooLarge,
    #[error("secure randomness is unavailable")]
    Randomness,
    #[error("repository must have the form owner/name")]
    InvalidRepository,
    #[error("base must be a bounded Git branch or a lowercase 40-character revision")]
    InvalidBase,
    #[error("--target-branch is required with an exact revision and forbidden otherwise")]
    TargetBranchMismatch,
    #[error("target control authority failed: {0}")]
    Authority(#[from] TargetAuthorityError),
    #[error("target OECP endpoint is invalid")]
    InvalidOecpEndpoint,
    #[error("target OECP bearer token is invalid")]
    InvalidBearerToken,
    #[error("target OECP connection failed: {0}")]
    OecpConnection(String),
}

pub struct NativeV2TargetConnector<R, A, D> {
    registry: R,
    authority: A,
    dialer: D,
}

impl<R, A, D> NativeV2TargetConnector<R, A, D> {
    #[must_use]
    pub const fn new(registry: R, authority: A, dialer: D) -> Self {
        Self {
            registry,
            authority,
            dialer,
        }
    }
}

#[async_trait]
impl<R, A, D> TargetConnector for NativeV2TargetConnector<R, A, D>
where
    R: TargetRegistry,
    A: TargetControlAuthority,
    D: TargetOecpDialer,
{
    type Transport = D::Transport;

    async fn add(&self, request: TargetAdd) -> Result<(), NativeV2CliError> {
        let target = prepare_target(request).map_err(cli_target_error)?;
        self.authority
            .discover(&target)
            .await
            .map_err(cli_target_error)?;
        self.registry.insert(target).map_err(cli_target_error)
    }

    async fn login(&self, name: &str) -> Result<(), NativeV2CliError> {
        validate_target_name(name).map_err(cli_target_error)?;
        let target = self.registry.get(name).map_err(cli_target_error)?;
        self.authority
            .login(&target)
            .await
            .map_err(cli_target_error)
    }

    async fn setup(&self, request: TargetSetup) -> Result<(), NativeV2CliError> {
        let document = prepare_setup(&request).map_err(cli_target_error)?;
        validate_target_name(&request.name).map_err(cli_target_error)?;
        let target = self.registry.get(&request.name).map_err(cli_target_error)?;
        self.authority
            .install(&target, &document)
            .await
            .map_err(cli_target_error)
    }

    async fn submit(
        &self,
        name: &str,
        intent: TargetRunIntent,
    ) -> Result<RunSubmitResult, NativeV2CliError> {
        validate_target_name(name).map_err(cli_target_error)?;
        let target = self.registry.get(name).map_err(cli_target_error)?;
        self.authority
            .submit(&target, &intent)
            .await
            .map_err(cli_target_error)
    }

    async fn connect(&self, name: &str) -> Result<Arc<Self::Transport>, NativeV2CliError> {
        validate_target_name(name).map_err(cli_target_error)?;
        let target = self.registry.get(name).map_err(cli_target_error)?;
        let session = self
            .authority
            .oecp_session(&target)
            .await
            .map_err(cli_target_error)?;
        self.dialer
            .dial(&target, session)
            .await
            .map_err(cli_target_error)
    }
}

fn cli_target_error(error: impl fmt::Display) -> NativeV2CliError {
    NativeV2CliError::Target(error.to_string())
}
