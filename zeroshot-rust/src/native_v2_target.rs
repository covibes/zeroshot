//! Native-v2 named-target connector.
//!
//! The CLI owns the local name/origin/repository profile. A target control authority owns
//! discovery, explicit hosted/direct access, submission, and run-scoped OECP sessions. Runtime
//! values cross only in the ephemeral per-run request and are never stored locally.

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroshot_engine::native_v2_cli::oecp::{BoxedSubscription, TargetConnector};
use zeroshot_engine::native_v2_cli::{
    CliRunForceResult, CliRunListResult, CliRunStatusResult, CliRunWatchEventNotification,
    NativeV2CliError, PreparedRunRequest, TargetAdd, TargetSetup,
};
use openengine_cluster_protocol::{
    ConnectionDeleteRequest, ConnectionDeleteResult, ConnectionListRequest, ConnectionListResult,
    ConnectionMutationResult, ConnectionSetRequest, RunForceParams, RunListParams,
    RunLogEventNotification, RunLogsParams, RunStatusParams, RunSubmission, RunSubmitResult,
    RunWatchParams, TargetOecpSessionRequest, TargetRunRequest,
};

mod contract;
mod controller_authority;
mod oecp;
mod registry;
mod serve;
mod source;

use contract::{prepare_setup, prepare_target, validate_bearer_token, validate_target_name};
pub use oecp::{TargetOecpDialer, TargetOecpWebSocketDialer};
pub use registry::{FileTargetRegistry, TargetRegistry, default_target_registry_path};
pub use source::{GitHubTargetSourceResolver, TargetSourceResolver};
pub use controller_authority::TargetHttpControlAuthority;
pub use serve::{TargetServeError, serve_direct_target};

#[cfg(test)]
use contract::normalize_origin;
#[cfg(test)]
#[path = "native_v2_target/tests.rs"]
mod tests;

/// The external contract which hosting must implement before the native-v2 CLI can reach cloud.
///
/// `oecp_session` returns one same-origin endpoint and hosted bearer, if OAuth is enabled.
#[async_trait]
pub trait TargetControlAuthority: Send + Sync {
    async fn discover(&self, target: &TargetRecord) -> Result<(), TargetAuthorityError>;
    async fn login(&self, target: &TargetRecord) -> Result<(), TargetAuthorityError>;
    async fn submit(
        &self,
        target: &TargetRecord,
        request: &TargetRunRequest,
    ) -> Result<RunSubmitResult, TargetAuthorityError>;
    async fn oecp_session(
        &self,
        target: &TargetRecord,
        request: &TargetOecpSessionRequest,
    ) -> Result<TargetOecpAccess, TargetAuthorityError>;

    async fn connection_list(
        &self,
        target: &TargetRecord,
        request: ConnectionListRequest,
    ) -> Result<ConnectionListResult, TargetAuthorityError>;

    async fn connection_set(
        &self,
        target: &TargetRecord,
        request: ConnectionSetRequest,
    ) -> Result<ConnectionMutationResult, TargetAuthorityError>;

    async fn connection_delete(
        &self,
        target: &TargetRecord,
        request: ConnectionDeleteRequest,
    ) -> Result<ConnectionDeleteResult, TargetAuthorityError>;

    async fn hosted_run_list(
        &self,
        target: &TargetRecord,
        params: RunListParams,
    ) -> Result<CliRunListResult, TargetAuthorityError>;

    async fn hosted_run_status(
        &self,
        target: &TargetRecord,
        params: RunStatusParams,
    ) -> Result<CliRunStatusResult, TargetAuthorityError>;

    async fn hosted_run_watch(
        &self,
        target: &TargetRecord,
        params: RunWatchParams,
    ) -> Result<BoxedSubscription<CliRunWatchEventNotification>, TargetAuthorityError>;

    async fn hosted_run_logs(
        &self,
        target: &TargetRecord,
        params: RunLogsParams,
    ) -> Result<BoxedSubscription<RunLogEventNotification>, TargetAuthorityError>;

    async fn hosted_run_force(
        &self,
        target: &TargetRecord,
        params: RunForceParams,
    ) -> Result<CliRunForceResult, TargetAuthorityError>;
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct TargetAuthorityError {
    message: String,
    disconnected: bool,
}

impl TargetAuthorityError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            disconnected: false,
        }
    }

    fn disconnected(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            disconnected: true,
        }
    }

    const fn is_disconnected(&self) -> bool {
        self.disconnected
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetRecord {
    pub id: String,
    pub name: String,
    pub origin: String,
    pub access: TargetAccess,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    deny_unknown_fields,
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "mode"
)]
pub enum TargetAccess {
    Hosted { device_token: String },
    Direct,
}

impl TargetAccess {
    const fn authentication(
        &self,
    ) -> zeroshot_engine::native_v2_target_authority::TargetAuthentication {
        match self {
            Self::Hosted { .. } => {
                zeroshot_engine::native_v2_target_authority::TargetAuthentication::HostedOauth
            }
            Self::Direct => zeroshot_engine::native_v2_target_authority::TargetAuthentication::None,
        }
    }

    fn device_token(&self) -> Option<&str> {
        match self {
            Self::Hosted { device_token } => Some(device_token),
            Self::Direct => None,
        }
    }
}

/// Same-authority OECP access minted by the target control authority. Hosted targets carry a
/// short-lived bearer; explicit direct targets do not. Debug output never includes bearer values.
pub struct TargetOecpAccess {
    endpoint: String,
    bearer_token: Option<String>,
}

impl TargetOecpAccess {
    fn new(
        endpoint: impl Into<String>,
        bearer_token: Option<String>,
        access: &TargetAccess,
    ) -> Result<Self, TargetConnectorError> {
        let session = Self {
            endpoint: endpoint.into(),
            bearer_token,
        };
        match (access, session.bearer_token.as_deref()) {
            (TargetAccess::Hosted { .. }, Some(token)) => validate_bearer_token(token)?,
            (TargetAccess::Direct, None) => {}
            _ => return Err(TargetConnectorError::InvalidBearerToken),
        }
        Ok(session)
    }

    #[must_use]
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    fn bearer_token(&self) -> Option<&str> {
        self.bearer_token.as_deref()
    }
}

impl fmt::Debug for TargetOecpAccess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TargetOecpAccess")
            .field("endpoint", &self.endpoint)
            .field(
                "bearer_token",
                &self.bearer_token.as_ref().map(|_| "[REDACTED]"),
            )
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
    #[error("target {0:?} has no repository setup")]
    SetupRequired(String),
    #[error("target source could not be resolved")]
    SourceResolution,
    #[error("target control authority failed: {0}")]
    Authority(#[from] TargetAuthorityError),
    #[error("target OECP endpoint is invalid")]
    InvalidOecpEndpoint,
    #[error("target OECP bearer token is invalid")]
    InvalidBearerToken,
    #[error("target OECP connection failed: {0}")]
    OecpConnection(String),
}

pub struct NativeV2TargetConnector<R, A, D, S> {
    registry: R,
    authority: A,
    dialer: D,
    source: S,
}

impl<R, A, D, S> NativeV2TargetConnector<R, A, D, S> {
    #[must_use]
    pub const fn new(registry: R, authority: A, dialer: D, source: S) -> Self {
        Self {
            registry,
            authority,
            dialer,
            source,
        }
    }
}

#[async_trait]
impl<R, A, D, S> TargetConnector for NativeV2TargetConnector<R, A, D, S>
where
    R: TargetRegistry,
    A: TargetControlAuthority,
    D: TargetOecpDialer,
    S: TargetSourceResolver,
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
        let setup = prepare_setup(&request).map_err(cli_target_error)?;
        validate_target_name(&request.name).map_err(cli_target_error)?;
        self.registry
            .setup(&request.name, setup.repository, setup.default_branch)
            .map_err(cli_target_error)
    }

    async fn connection_list(
        &self,
        name: &str,
        request: ConnectionListRequest,
    ) -> Result<ConnectionListResult, NativeV2CliError> {
        validate_target_name(name).map_err(cli_target_error)?;
        let target = self.registry.get(name).map_err(cli_target_error)?;
        self.authority
            .connection_list(&target, request)
            .await
            .map_err(cli_target_error)
    }

    async fn connection_set(
        &self,
        name: &str,
        request: ConnectionSetRequest,
    ) -> Result<ConnectionMutationResult, NativeV2CliError> {
        validate_target_name(name).map_err(cli_target_error)?;
        let target = self.registry.get(name).map_err(cli_target_error)?;
        self.authority
            .connection_set(&target, request)
            .await
            .map_err(cli_target_error)
    }

    async fn connection_delete(
        &self,
        name: &str,
        request: ConnectionDeleteRequest,
    ) -> Result<ConnectionDeleteResult, NativeV2CliError> {
        validate_target_name(name).map_err(cli_target_error)?;
        let target = self.registry.get(name).map_err(cli_target_error)?;
        self.authority
            .connection_delete(&target, request)
            .await
            .map_err(cli_target_error)
    }

    async fn submit(
        &self,
        name: &str,
        request: PreparedRunRequest,
    ) -> Result<RunSubmitResult, NativeV2CliError> {
        validate_target_name(name).map_err(cli_target_error)?;
        let target = self.registry.get(name).map_err(cli_target_error)?;
        let repository = target.repository.as_deref().ok_or_else(|| {
            cli_target_error(TargetConnectorError::SetupRequired(name.to_owned()))
        })?;
        let source = self
            .source
            .resolve(
                repository,
                request
                    .intent
                    .branch
                    .as_ref()
                    .map(openengine_cluster_protocol::SourceBranchId::as_str)
                    .or(target.default_branch.as_deref()),
                request.github_token.as_deref(),
            )
            .await
            .map_err(cli_target_error)?;
        let request = TargetRunRequest {
            run_id: request.run_id,
            submission: RunSubmission {
                title: request.intent.title,
                graph: request.intent.graph,
                initial_input: request.intent.initial_input,
                runtime: request.intent.runtime,
                source,
                submission_key: request.intent.submission_key,
            },
            connections: request.connections,
            github_token: request.github_token,
        };
        self.authority
            .submit(&target, &request)
            .await
            .map_err(cli_target_error)
    }

    async fn connect(
        &self,
        name: &str,
        run_id: Option<openengine_cluster_protocol::RunId>,
    ) -> Result<Arc<Self::Transport>, NativeV2CliError> {
        validate_target_name(name).map_err(cli_target_error)?;
        let target = self.registry.get(name).map_err(cli_target_error)?;
        let session = self
            .authority
            .oecp_session(&target, &TargetOecpSessionRequest { run_id })
            .await
            .map_err(cli_authority_error)?;
        self.dialer
            .dial(&target, session)
            .await
            .map_err(cli_connector_error)
    }

    async fn hosted_run_list(
        &self,
        name: &str,
        params: RunListParams,
    ) -> Result<Option<CliRunListResult>, NativeV2CliError> {
        let target = self.target(name)?;
        if matches!(target.access, TargetAccess::Direct) {
            return Ok(None);
        }
        self.authority
            .hosted_run_list(&target, params)
            .await
            .map_err(cli_target_error)
            .map(Some)
    }

    async fn hosted_run_status(
        &self,
        name: &str,
        params: RunStatusParams,
    ) -> Result<Option<CliRunStatusResult>, NativeV2CliError> {
        let target = self.target(name)?;
        if matches!(target.access, TargetAccess::Direct) {
            return Ok(None);
        }
        self.authority
            .hosted_run_status(&target, params)
            .await
            .map_err(cli_target_error)
            .map(Some)
    }

    async fn hosted_run_watch(
        &self,
        name: &str,
        params: RunWatchParams,
    ) -> Result<Option<BoxedSubscription<CliRunWatchEventNotification>>, NativeV2CliError> {
        let target = self.target(name)?;
        if matches!(target.access, TargetAccess::Direct) {
            return Ok(None);
        }
        self.authority
            .hosted_run_watch(&target, params)
            .await
            .map_err(cli_authority_error)
            .map(Some)
    }

    async fn hosted_run_logs(
        &self,
        name: &str,
        params: RunLogsParams,
    ) -> Result<Option<BoxedSubscription<RunLogEventNotification>>, NativeV2CliError> {
        let target = self.target(name)?;
        if matches!(target.access, TargetAccess::Direct) {
            return Ok(None);
        }
        self.authority
            .hosted_run_logs(&target, params)
            .await
            .map_err(cli_authority_error)
            .map(Some)
    }

    async fn hosted_run_force(
        &self,
        name: &str,
        params: RunForceParams,
    ) -> Result<Option<CliRunForceResult>, NativeV2CliError> {
        let target = self.target(name)?;
        if matches!(target.access, TargetAccess::Direct) {
            return Ok(None);
        }
        self.authority
            .hosted_run_force(&target, params)
            .await
            .map_err(cli_target_error)
            .map(Some)
    }
}

impl<R, A, D, S> NativeV2TargetConnector<R, A, D, S>
where
    R: TargetRegistry,
{
    fn target(&self, name: &str) -> Result<TargetRecord, NativeV2CliError> {
        validate_target_name(name).map_err(cli_target_error)?;
        self.registry.get(name).map_err(cli_target_error)
    }
}

fn cli_target_error(error: impl fmt::Display) -> NativeV2CliError {
    NativeV2CliError::Target(error.to_string())
}

fn cli_authority_error(error: TargetAuthorityError) -> NativeV2CliError {
    if error.is_disconnected() {
        NativeV2CliError::Disconnected
    } else {
        cli_target_error(error)
    }
}

fn cli_connector_error(error: TargetConnectorError) -> NativeV2CliError {
    match error {
        TargetConnectorError::OecpConnection(_) => NativeV2CliError::Disconnected,
        error => cli_target_error(error),
    }
}
