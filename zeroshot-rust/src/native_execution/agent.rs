//! Private composition for the one fixed foreground Codex execution.

#[path = "agent/artifact.rs"]
mod artifact;
#[path = "agent/codex.rs"]
mod codex;
#[path = "agent/protocol.rs"]
mod protocol;
#[path = "agent/workspace.rs"]
mod workspace;

use std::sync::Arc;

use openengine_cluster_protocol::{TerminalResult, WorkerErrorCode, WorkerOutcome};
use serde_json::Value;

use crate::cluster_ledger::{DispatchAllocation, ResourceId};
use crate::execution::driver::BuiltinWorkerDriver;

use artifact::AgentArtifactStore;
use codex::NativeCodexDriver;
pub(super) use protocol::{AgentDispatchInput, AgentTerminalOutput};
pub(super) use workspace::{AgentWorkspaceAuthority, AgentWorkspacePreparation};
use workspace::NativeAgentWorkspace;

use super::NativeExecutionProcess;

#[derive(Clone)]
pub(super) struct NativeAgent {
    driver: Arc<NativeCodexDriver>,
    workspace: NativeAgentWorkspace,
    artifacts: AgentArtifactStore,
}

impl NativeAgent {
    pub(super) fn new(process: &NativeExecutionProcess) -> Result<Self, ()> {
        let workspace = NativeAgentWorkspace::open(&process.state_dir, &process.workspace)?;
        let artifacts = AgentArtifactStore::open(&process.state_dir, &process.resource)?;
        let driver = Arc::new(NativeCodexDriver::new(
            workspace.root(),
            process,
            artifacts.clone(),
        )?);
        Ok(Self {
            driver,
            workspace,
            artifacts,
        })
    }

    pub(super) fn driver(&self) -> Arc<dyn BuiltinWorkerDriver> {
        self.driver.clone()
    }

    pub(super) async fn preflight(&self, input: &Value) -> Result<(), ()> {
        protocol::AgentUserInput::parse(input)?;
        self.workspace.preflight()?;
        self.driver.preflight().await
    }

    pub(super) async fn prepare_workspace(
        &self,
        cluster: &ResourceId,
        allocation: &DispatchAllocation,
    ) -> AgentWorkspacePreparation {
        self.workspace.prepare(cluster, allocation).await
    }

    pub(super) async fn reverify_terminal(&self, terminal: &TerminalResult) -> Result<(), ()> {
        let TerminalResult::Succeeded { output } = terminal else {
            return Ok(());
        };
        let output: AgentTerminalOutput = serde_json::from_value(output.clone()).map_err(|_| ())?;
        output.validate()?;
        self.artifacts.reverify(&output.validation_artifact).await
    }
}

pub(super) fn closed_error(code: WorkerErrorCode) -> WorkerOutcome {
    WorkerOutcome::declared_failure(code)
}
