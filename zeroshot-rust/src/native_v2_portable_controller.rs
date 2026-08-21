//! Auth-free, one-run native-v2 controller and deterministic local transport.

mod controller;
mod engine;
mod lease;
pub(crate) mod process;

#[cfg(test)]
mod tests;

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

use openengine_cluster_protocol::{RunId, RunSubmission};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::native_v2_admission::DeliveryPolicy;
use crate::native_v2_supervisor::RunEnvironment;

pub use controller::PortableRunController;
pub(crate) use controller::WorkspaceIdentity;
pub use engine::{PortableRunEngine, PortableRunEngineBootstrap, PortableRuntime};
pub use lease::{ControllerLease, ControllerLeaseError};
pub use process::{load_bootstrap_file, read_ready, wait_ready, write_bootstrap_file};
#[cfg(unix)]
pub use process::{
    PortableControllerServer, PortableControllerTransport, connect_transport,
    run_controller_process,
};

#[cfg(test)]
use crate::native_v2_admission::NativeV2Admission;
#[cfg(test)]
use crate::native_v2_runner::NodeRunner;
#[cfg(test)]
use crate::v2_run_ledger::sqlite::SqliteRunLedger;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PortableControllerPaths {
    storage: PathBuf,
}

impl PortableControllerPaths {
    #[must_use]
    pub fn new(storage: impl Into<PathBuf>) -> Self {
        Self {
            storage: storage.into(),
        }
    }

    #[must_use]
    pub fn storage(&self) -> &Path {
        &self.storage
    }

    #[must_use]
    pub fn socket(&self) -> PathBuf {
        self.storage.join("controller.sock")
    }

    #[must_use]
    pub fn ready(&self) -> PathBuf {
        self.storage.join("controller.ready.json")
    }

    #[must_use]
    pub fn ledger(&self) -> PathBuf {
        self.storage.join("runs.sqlite3")
    }

    #[must_use]
    pub fn lease(&self) -> PathBuf {
        self.storage.join("controller.lock")
    }

    #[must_use]
    pub fn runtime(&self) -> PathBuf {
        self.storage.join("runtime")
    }
}

pub struct PortableControllerBootstrap {
    pub run_id: RunId,
    pub submission: RunSubmission,
    pub environment: RunEnvironment,
    pub github_token: Option<String>,
    pub workspace: PathBuf,
    pub workspace_lease: PathBuf,
    pub storage: PathBuf,
    pub delivery_policy: DeliveryPolicy,
}

impl fmt::Debug for PortableControllerBootstrap {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PortableControllerBootstrap")
            .field("run_id", &self.run_id)
            .field("submission", &self.submission)
            .field("environment", &self.environment)
            .field(
                "github_token",
                &self.github_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("workspace", &self.workspace)
            .field("workspace_lease", &self.workspace_lease)
            .field("storage", &self.storage)
            .field("delivery_policy", &self.delivery_policy)
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PortableControllerReady {
    pub kind: String,
    pub run_id: RunId,
    pub socket: PathBuf,
    pub pid: u32,
}

#[derive(Debug, Error)]
pub enum PortableControllerError {
    #[error("portable controller path must be absolute")]
    Path,
    #[error("portable controller bootstrap is malformed or too large")]
    Bootstrap,
    #[error("portable controller bootstrap is not private to this user")]
    BootstrapPermissions,
    #[error("portable controller bootstrap could not be removed")]
    BootstrapCleanup,
    #[error("portable controller workspace is unavailable")]
    Workspace,
    #[error("portable controller endpoint path is unsafe")]
    EndpointPath,
    #[error("portable controller ledger path is unsafe")]
    LedgerPath,
    #[error("portable controller readiness is unavailable")]
    Readiness,
    #[error("portable controller durable identity does not match bootstrap")]
    DurableIdentity,
    #[error("portable runtime could not be constructed")]
    RuntimeUnavailable,
    #[error(transparent)]
    Admission(#[from] crate::native_v2_admission::NativeV2AdmissionError),
    #[error(transparent)]
    Environment(#[from] crate::native_v2_supervisor::RunEnvironmentError),
    #[error(transparent)]
    Lease(#[from] ControllerLeaseError),
    #[error(transparent)]
    Ledger(#[from] crate::v2_run_ledger::RunLedgerError),
    #[error(transparent)]
    Controller(#[from] crate::native_v2_cloud::NativeV2CloudError),
    #[error("portable controller I/O failed")]
    Io(#[source] io::Error),
}
