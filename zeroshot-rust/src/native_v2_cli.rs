//! Lean native-v2 command contract.
//!
//! Parsing and local file validation happen before a local controller or named target is
//! contacted. The named-target connector resolves a mutable branch selector before sending the
//! immutable sourceful submission to the target.

use std::fmt;
use std::net::SocketAddr;
use std::path::PathBuf;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ConnectionDeleteRequest, ConnectionDeleteResult, ConnectionKey, ConnectionListRequest,
    ConnectionListResult, ConnectionMutationResult, ConnectionScope, ConnectionSetRequest, Cursor,
    EnvironmentVariableName, ExecutionRef, IdempotencyKey, RunAttachEventNotification,
    RunAttachParams, RunForceParams, RunListParams, RunLogEventNotification, RunLogsParams, RunId,
    RunConnectionValues, RunStatusParams, RunTitle, RunWatchParams, SourceBranchId,
    SubscriptionCloseReason,
};
use thiserror::Error;

pub use crate::native_v2_contract::RunSubmissionIntent as TargetRunIntent;
use crate::native_v2_admission::NativeV2AdmissionError;
use crate::native_v2_supervisor::RunEnvironmentError;

#[path = "native_v2_templates.rs"]
mod templates;
pub use templates::{BuiltinGraphTemplate, TemplateDelivery};

#[path = "native_v2_cli/oecp.rs"]
pub mod oecp;

#[path = "native_v2_cli/lifecycle.rs"]
mod lifecycle;
pub use lifecycle::{
    CliRunForceResult, CliRunListResult, CliRunStatus, CliRunStatusResult,
    CliRunWatchEventNotification,
};

#[cfg(unix)]
#[path = "native_v2_cli/local.rs"]
pub mod local;

#[path = "native_v2_cli/execution.rs"]
pub(crate) mod execution;

#[path = "native_v2_cli/diagnostic.rs"]
mod diagnostic;
pub use diagnostic::{ERROR_FORMAT_ENV, JSON_ERROR_FORMAT, NativeV2CliDiagnostic};

#[path = "native_v2_cli/parser.rs"]
mod parser;

pub use execution::{
    execute_native_v2_cli, try_execute_native_v2_preflight, try_execute_native_v2_static,
};
pub use parser::{Cli, parse_native_v2_args};

#[cfg(test)]
#[path = "native_v2_cli/tests.rs"]
mod tests;

pub const VERSION: &str = concat!("zeroshot-rust ", env!("CARGO_PKG_VERSION"), "\n");

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetAdd {
    pub name: String,
    pub url: String,
    pub direct: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetSetup {
    pub name: String,
    pub repository: String,
    pub default_branch: Option<SourceBranchId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetServe {
    pub listen: SocketAddr,
    pub public_origin: String,
    pub storage: PathBuf,
    pub bootstrap_key_file: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectionRoute {
    pub target: Option<String>,
    pub scope: ConnectionScope,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConnectionInput {
    Prompt(Vec<EnvironmentVariableName>),
    JsonStdin,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectionSetCommand {
    pub route: ConnectionRoute,
    pub key: ConnectionKey,
    pub input: ConnectionInput,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunCommand {
    pub target: Option<String>,
    pub title: RunTitle,
    pub graph: RunGraph,
    pub input: PathBuf,
    pub runtime: RunRuntime,
    pub branch: Option<SourceBranchId>,
    pub detach: bool,
    pub validate_only: bool,
    pub submission_key: Option<IdempotencyKey>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunRuntime {
    Exact(PathBuf),
    Uniform(PathBuf),
}

/// CLI-materialized input before a named target resolves its exact source revision.
///
/// This is not a wire value. Named targets convert it to the shared sourceful
/// [`openengine_cluster_protocol::TargetRunRequest`]; local runs snapshot the current workspace.
#[derive(Clone, PartialEq)]
pub struct PreparedRunRequest {
    pub run_id: RunId,
    pub intent: TargetRunIntent,
    pub connections: RunConnectionValues,
    pub github_token: Option<String>,
}

impl fmt::Debug for PreparedRunRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedRunRequest")
            .field("run_id", &self.run_id)
            .field("intent", &self.intent)
            .field("connections", &self.connections.keys().collect::<Vec<_>>())
            .field("connection_values", &"[REDACTED]")
            .field(
                "github_token",
                &self.github_token.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunGraph {
    File(PathBuf),
    Template {
        template: BuiltinGraphTemplate,
        delivery: TemplateDelivery,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunSelector {
    pub target: Option<String>,
    pub run_id: openengine_cluster_protocol::RunId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunWatchCommand {
    pub run: RunSelector,
    pub after: Option<Cursor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunLogsCommand {
    pub run: RunSelector,
    pub after: Option<Cursor>,
    pub execution: Option<ExecutionRef>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeV2CliCommand {
    Help(String),
    Version,
    TargetAdd(TargetAdd),
    TargetLogin {
        name: String,
    },
    TargetSetup(TargetSetup),
    TargetServe(TargetServe),
    ConnectionList(ConnectionRoute),
    ConnectionSet(ConnectionSetCommand),
    ConnectionDelete {
        route: ConnectionRoute,
        key: ConnectionKey,
    },
    TemplateList,
    TemplateShow {
        template: BuiltinGraphTemplate,
        delivery: TemplateDelivery,
    },
    Run(RunCommand),
    List {
        target: Option<String>,
    },
    Status(RunSelector),
    Watch(RunWatchCommand),
    Logs(RunLogsCommand),
    Attach {
        run: RunSelector,
        execution: ExecutionRef,
    },
    ForceStop(RunSelector),
}

impl NativeV2CliCommand {
    fn product_info(&self) -> Option<&str> {
        match self {
            Self::Help(help) => Some(help),
            Self::Version => Some(VERSION),
            _ => None,
        }
    }

    fn is_connection_operation(&self) -> bool {
        matches!(
            self,
            Self::ConnectionList(_) | Self::ConnectionSet(_) | Self::ConnectionDelete { .. }
        )
    }

    fn is_target_operation(&self) -> bool {
        matches!(
            self,
            Self::TargetAdd(_) | Self::TargetLogin { .. } | Self::TargetSetup(_)
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CliOutcome {
    Completed,
    Finished,
    Failed,
    Detached,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CliSubscriptionItem<E> {
    Event(E),
    Closed { reason: SubscriptionCloseReason },
}

#[derive(Debug, Error)]
pub enum NativeV2CliError {
    #[error("{0}")]
    Usage(String),
    #[error("target serve is owned by the zeroshot-rust process entrypoint")]
    ProcessCommand,
    #[error("could not read {kind} file {path}: {source}")]
    Read {
        kind: &'static str,
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("{kind} file {path} is not valid JSON: {source}")]
    Json {
        kind: &'static str,
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("initial input does not match GraphSpec.initialInput: {0}")]
    InitialInput(String),
    #[error("run validation failed: {0}")]
    InvalidRun(#[source] NativeV2AdmissionError),
    #[error("declared environment variable {0} is unavailable or is not valid UTF-8")]
    Environment(EnvironmentVariableName),
    #[error(transparent)]
    RunEnvironment(#[from] RunEnvironmentError),
    #[error("submission identity randomness is unavailable")]
    Randomness,
    #[error("GH_TOKEN is not a valid bounded GitHub credential")]
    GitHubToken,
    #[error("target operation failed: {0}")]
    Target(String),
    #[error("local controller operation failed: {0}")]
    Local(String),
    #[error("Zeroshot Rust OECP request failed: {0}")]
    Protocol(String),
    #[error("remote operation failed with {code}: {message}")]
    Remote {
        code: String,
        message: String,
        details: Option<serde_json::Value>,
    },
    #[error("run {run_id} was not found")]
    RunNotFound { run_id: String },
    #[error("submission key already identifies a different admitted run ({existing_run_id})")]
    SubmissionConflict { existing_run_id: String },
    #[error("Zeroshot Rust observation transport disconnected")]
    Disconnected,
    #[error("run finished unsuccessfully")]
    RunFailed,
    #[error("could not write CLI output: {0}")]
    Output(#[from] std::io::Error),
    #[error("could not encode CLI output: {0}")]
    OutputJson(#[from] serde_json::Error),
}

#[async_trait]
pub trait CliSubscription<E>: Send {
    async fn next(&mut self) -> Result<Option<CliSubscriptionItem<E>>, NativeV2CliError>;
}

#[async_trait]
pub trait DetachSignal: Send {
    async fn wait(&mut self);
}

pub struct CtrlCDetachSignal;

#[async_trait]
impl DetachSignal for CtrlCDetachSignal {
    async fn wait(&mut self) {
        let _ = tokio::signal::ctrl_c().await;
    }
}

pub struct NeverDetach;

#[async_trait]
impl DetachSignal for NeverDetach {
    async fn wait(&mut self) {
        std::future::pending::<()>().await;
    }
}

#[async_trait]
pub trait NativeV2CliBackend: Send + Sync {
    type Watch: CliSubscription<CliRunWatchEventNotification>;
    type Logs: CliSubscription<RunLogEventNotification>;
    type Attach: CliSubscription<RunAttachEventNotification>;

    async fn target_add(&self, request: TargetAdd) -> Result<(), NativeV2CliError>;
    async fn target_login(&self, name: &str) -> Result<(), NativeV2CliError>;
    async fn target_setup(&self, request: TargetSetup) -> Result<(), NativeV2CliError>;

    async fn connection_list(
        &self,
        _target: Option<&str>,
        _request: ConnectionListRequest,
    ) -> Result<ConnectionListResult, NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "target does not advertise connection management".to_owned(),
        ))
    }

    async fn connection_set(
        &self,
        _target: Option<&str>,
        _request: ConnectionSetRequest,
    ) -> Result<ConnectionMutationResult, NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "target does not advertise connection management".to_owned(),
        ))
    }

    async fn connection_delete(
        &self,
        _target: Option<&str>,
        _request: ConnectionDeleteRequest,
    ) -> Result<ConnectionDeleteResult, NativeV2CliError> {
        Err(NativeV2CliError::Target(
            "target does not advertise connection management".to_owned(),
        ))
    }

    async fn run_submit(
        &self,
        target: Option<&str>,
        request: PreparedRunRequest,
    ) -> Result<openengine_cluster_protocol::RunSubmitResult, NativeV2CliError>;
    async fn run_list(
        &self,
        target: Option<&str>,
        params: RunListParams,
    ) -> Result<CliRunListResult, NativeV2CliError>;
    async fn run_status(
        &self,
        target: Option<&str>,
        params: RunStatusParams,
    ) -> Result<CliRunStatusResult, NativeV2CliError>;
    async fn run_watch(
        &self,
        target: Option<&str>,
        params: RunWatchParams,
    ) -> Result<Self::Watch, NativeV2CliError>;
    async fn run_logs(
        &self,
        target: Option<&str>,
        params: RunLogsParams,
    ) -> Result<Self::Logs, NativeV2CliError>;
    async fn run_attach(
        &self,
        target: Option<&str>,
        params: RunAttachParams,
    ) -> Result<Self::Attach, NativeV2CliError>;
    async fn run_force(
        &self,
        target: Option<&str>,
        params: RunForceParams,
    ) -> Result<CliRunForceResult, NativeV2CliError>;
}
