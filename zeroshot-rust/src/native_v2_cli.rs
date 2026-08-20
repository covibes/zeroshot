//! Lean native-v2 command contract.
//!
//! Parsing and local file validation happen before a local controller or named target is
//! contacted. Named-target submissions carry only a mutable branch selector; the host resolves it
//! once before the controller receives the immutable source and runtime plan.

use std::path::PathBuf;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    EnvironmentVariableName, ExecutionRef, IdempotencyKey, RunAttachEventNotification,
    RunAttachParams, RunForceParams, RunListParams, RunLogEventNotification, RunLogsParams,
    RunStatusParams, RunTitle, RunWatchParams, SourceBranchId, SubscriptionCloseReason,
};
use thiserror::Error;

pub use crate::native_v2_target_authority::{TargetRunIntent, TargetRunRequest};
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

#[path = "native_v2_cli/parser.rs"]
mod parser;

pub use execution::{execute_native_v2_cli, try_execute_native_v2_static};
pub use parser::parse_native_v2_args;

#[cfg(test)]
#[path = "native_v2_cli/tests.rs"]
mod tests;

pub const HELP: &str = "\
zeroshot v2

  target add <name> --url <origin> [--direct]
  target login <name>
  target setup <name> --repository <owner/name> [--branch <branch>]
  target serve --listen <address> --public-origin <origin> --storage <directory>
  template list
  template show <single-worker|software-change> [--pr|--ship]
  run --title <title> (--graph <file>|--template <name>) --input <file>
      --runtime-config <file> [--target <name>]
      [--branch <branch>] [--submission-key <key>] [-d]
      (--pr|--ship are valid only with --template software-change)
  list [--target <name>]
  status <run-id> [--target <name>]
  watch <run-id> [--target <name>]
  logs <run-id> [--target <name>]
  attach <run-id> <execution-ref> [--target <name>]
  force-stop <run-id> [--target <name>]
";

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
pub struct RunCommand {
    pub target: Option<String>,
    pub title: RunTitle,
    pub graph: RunGraph,
    pub input: PathBuf,
    pub runtime_config: PathBuf,
    pub branch: Option<SourceBranchId>,
    pub detach: bool,
    pub submission_key: Option<IdempotencyKey>,
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
pub enum NativeV2CliCommand {
    Help,
    TargetAdd(TargetAdd),
    TargetLogin {
        name: String,
    },
    TargetSetup(TargetSetup),
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
    Watch(RunSelector),
    Logs(RunSelector),
    Attach {
        run: RunSelector,
        execution: ExecutionRef,
    },
    ForceStop(RunSelector),
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
    #[error("declared environment variable {0} is unavailable or is not valid UTF-8")]
    Environment(EnvironmentVariableName),
    #[error(transparent)]
    RunEnvironment(#[from] RunEnvironmentError),
    #[error("submission identity randomness is unavailable")]
    Randomness,
    #[error("target operation failed: {0}")]
    Target(String),
    #[error("local controller operation failed: {0}")]
    Local(String),
    #[error("native-v2 OECP request failed: {0}")]
    Protocol(String),
    #[error("native-v2 observation transport disconnected")]
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

    async fn run_submit(
        &self,
        target: Option<&str>,
        request: TargetRunRequest,
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
