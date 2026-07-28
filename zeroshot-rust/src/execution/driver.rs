use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;

use crate::fault::EngineFault;

use super::types::{
    CompletionEvidence, ExecutionCommand, ExecutionControl, ExecutionInput, ExecutionResult,
    SessionScope, WorkspaceAccessMode,
};

pub type DriverCompletionFuture = Pin<Box<dyn Future<Output = DriverCompletion> + Send + 'static>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceCapability {
    pub current_dir: PathBuf,
    pub mode: WorkspaceAccessMode,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialCapability {
    pub handle_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderCapability {
    pub lane: String,
    pub driver_family: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionCapability {
    pub reuse_key: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DriverRequest {
    pub control: ExecutionControl,
    pub input: ExecutionInput,
    pub workspace: WorkspaceCapability,
    pub credentials: Vec<CredentialCapability>,
    pub provider: Option<ProviderCapability>,
    pub session: SessionCapability,
    pub environment: BTreeMap<String, String>,
}

impl DriverRequest {
    #[must_use]
    pub const fn session_scope(&self) -> SessionScope {
        self.control.session_scope()
    }
}

#[derive(Clone, Debug)]
pub struct DriverCancellation {
    cancelled: tokio::sync::watch::Receiver<bool>,
}

impl DriverCancellation {
    pub fn new(cancelled: tokio::sync::watch::Receiver<bool>) -> Self {
        Self { cancelled }
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        *self.cancelled.borrow()
    }

    pub async fn cancelled(&mut self) {
        while !*self.cancelled.borrow() {
            if self.cancelled.changed().await.is_err() {
                break;
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DriverCompletion {
    pub result: ExecutionResult,
}

impl DriverCompletion {
    pub fn success(result: ExecutionResult) -> Self {
        Self { result }
    }

    pub fn fault(result: ExecutionResult) -> Self {
        Self { result }
    }

    #[must_use]
    pub fn evidence(&self) -> &CompletionEvidence {
        self.result.evidence()
    }
}

pub enum DriverStartOutcome {
    DefinitelyNotStarted {
        fault: Option<EngineFault>,
    },
    MayHaveStarted {
        fault: Option<EngineFault>,
        completion: DriverCompletionFuture,
    },
    Running {
        completion: DriverCompletionFuture,
    },
    Completed {
        completion: DriverCompletion,
    },
    Indeterminate {
        fault: Option<EngineFault>,
    },
}

#[async_trait]
pub trait WorkerDriver: Send + Sync {
    async fn start(
        &self,
        request: DriverRequest,
        cancellation: DriverCancellation,
    ) -> DriverStartOutcome;
}

#[async_trait]
pub trait BuiltinWorkerDriver: Send + Sync {
    async fn start(
        &self,
        request: DriverRequest,
        cancellation: DriverCancellation,
    ) -> DriverStartOutcome;
}

pub enum ExecutionSiteResolution {
    Resolved(Box<ResolvedExecutionSite>),
    DefinitelyNotStarted { fault: EngineFault },
    Indeterminate { fault: EngineFault },
}

pub enum ResolvedExecutionSite {
    Agent {
        driver: Arc<dyn WorkerDriver>,
        request: DriverRequest,
    },
    Builtin {
        driver: Arc<dyn BuiltinWorkerDriver>,
        request: DriverRequest,
    },
}

#[async_trait]
pub trait ExecutionSiteResolver: Send + Sync {
    async fn resolve(&self, command: &ExecutionCommand) -> ExecutionSiteResolution;
}
