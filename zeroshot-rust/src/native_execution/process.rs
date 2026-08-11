use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::time::{Duration, Instant};

use crate::execution::driver::{
    BuiltinWorkerDriver, DriverCancellation, DriverCompletion, DriverRequest, DriverStartOutcome,
    ExecutionSiteResolution, ExecutionSiteResolver, ResolvedExecutionSite, SessionCapability,
    WorkspaceCapability,
};
use crate::execution::local::LocalExecutionRuntime;
use crate::execution::process::{
    LocalProcessRunner, ProcessCommand, ProcessInput, ProcessLaunchEvidence, ProcessRunOutput,
    ProcessRunnerError,
};
use crate::execution::{
    CompletionEvidence, ExecutionCandidate, ExecutionCommand, ExecutionInput, ExecutionResult,
    ExecutionRuntime, ExecutionTargetRef, WorkspaceAccessMode,
};
use crate::native_admission::native_worker_protocol::{effect_marker_id, WORKER_MODE};

use super::program::NATIVE_PROCESS_TIMEOUT_MS;
use super::agent::{AgentWorkspacePreparation, NativeAgent};
use super::program::AGENT_WORKER_REF;
use super::{NativeExecutionError, NativeExecutionProcess};

#[derive(Clone)]
pub(super) struct NativeExecutionRuntime {
    runtime: LocalExecutionRuntime,
    agent: NativeAgent,
}

impl NativeExecutionRuntime {
    pub(super) async fn preflight(
        &self,
        worker: &str,
        input: &serde_json::Value,
    ) -> Result<(), NativeExecutionError> {
        if worker == AGENT_WORKER_REF {
            self.agent
                .preflight(input)
                .await
                .map_err(|()| NativeExecutionError::Preflight)?;
        }
        Ok(())
    }

    pub(super) async fn prepare_workspace(
        &self,
        worker: &str,
        cluster: &crate::cluster_ledger::ResourceId,
        allocation: &crate::cluster_ledger::DispatchAllocation,
    ) -> Result<Option<AgentWorkspacePreparation>, NativeExecutionError> {
        if worker == AGENT_WORKER_REF {
            return Ok(Some(
                self.agent.prepare_workspace(cluster, allocation).await,
            ));
        }
        Ok(None)
    }

    pub(super) async fn dispatch(
        &self,
        command: ExecutionCommand,
    ) -> crate::execution::DispatchObservation {
        self.runtime.dispatch(command).await
    }

    pub(super) async fn reverify_agent_terminal(
        &self,
        terminal: &openengine_cluster_protocol::TerminalResult,
    ) -> Result<(), NativeExecutionError> {
        self.agent
            .reverify_terminal(terminal)
            .await
            .map_err(|()| NativeExecutionError::InvalidState)
    }
}

pub(super) fn runtime(
    process: NativeExecutionProcess,
) -> Result<NativeExecutionRuntime, NativeExecutionError> {
    let deterministic = Arc::new(NativeDeterministicDriver {
        runner: LocalProcessRunner::new(),
        executable: process.executable.clone(),
    });
    let agent = NativeAgent::new(&process).map_err(|()| NativeExecutionError::Contract)?;
    let runtime = LocalExecutionRuntime::new(Arc::new(NativeExecutionResolver {
        deterministic,
        agent: agent.driver(),
        state_dir: process.state_dir,
        workspace: process.workspace,
    }));
    Ok(NativeExecutionRuntime { runtime, agent })
}

struct NativeExecutionResolver {
    deterministic: Arc<NativeDeterministicDriver>,
    agent: Arc<dyn BuiltinWorkerDriver>,
    state_dir: PathBuf,
    workspace: PathBuf,
}

#[async_trait]
impl ExecutionSiteResolver for NativeExecutionResolver {
    async fn resolve(&self, command: &ExecutionCommand) -> ExecutionSiteResolution {
        let ExecutionTargetRef::Builtin(target) = command.target() else {
            return indeterminate_resolution();
        };
        if target.version() != 1 {
            return indeterminate_resolution();
        }
        let (driver, workspace) = match target.builtin_id().as_str() {
            "native.deterministic" => (
                self.deterministic.clone() as Arc<dyn BuiltinWorkerDriver>,
                self.state_dir.clone(),
            ),
            "native.agent.codex" => (self.agent.clone(), self.workspace.clone()),
            _ => return indeterminate_resolution(),
        };
        ExecutionSiteResolution::Resolved(Box::new(ResolvedExecutionSite::Builtin {
            driver,
            request: DriverRequest {
                control: command.control(),
                input: command.input().clone(),
                workspace: WorkspaceCapability {
                    current_dir: workspace,
                    mode: WorkspaceAccessMode::Exclusive,
                },
                credentials: Vec::new(),
                provider: None,
                session: SessionCapability { reuse_key: None },
                environment: BTreeMap::new(),
            },
        }))
    }
}

struct NativeDeterministicDriver {
    runner: LocalProcessRunner,
    executable: PathBuf,
}

#[async_trait]
impl BuiltinWorkerDriver for NativeDeterministicDriver {
    async fn start(
        &self,
        request: DriverRequest,
        cancellation: DriverCancellation,
    ) -> DriverStartOutcome {
        let Some(command) = self.command(request) else {
            return definitely_not_started();
        };
        classify_process_result(self.runner.run(command, cancellation).await)
    }
}

impl NativeDeterministicDriver {
    fn command(&self, request: DriverRequest) -> Option<ProcessCommand> {
        let program = self.executable.to_str()?.to_owned();
        let marker = effect_marker_id(
            request.control.cluster().as_str(),
            request.control.run().get(),
            request.control.execution().get(),
        );
        let ExecutionInput::Inline(input) = request.input else {
            return None;
        };
        let stdin = ProcessInput::new(input.as_str().as_bytes().to_vec()).ok()?;
        Some(ProcessCommand {
            program,
            argv: vec![WORKER_MODE.to_owned(), "--effect-id".to_owned(), marker],
            environment: BTreeMap::new(),
            workspace: request.workspace,
            stdin,
            deadline: Instant::now() + Duration::from_millis(NATIVE_PROCESS_TIMEOUT_MS),
        })
    }
}

fn classify_process_result(
    result: Result<ProcessRunOutput, ProcessRunnerError>,
) -> DriverStartOutcome {
    match result {
        Ok(output) => completed_process(output).unwrap_or_else(indeterminate),
        Err(error) if error.launch_evidence() == ProcessLaunchEvidence::DefinitelyNotStarted => {
            definitely_not_started()
        }
        Err(_) => indeterminate(),
    }
}

fn completed_process(output: ProcessRunOutput) -> Option<DriverStartOutcome> {
    if !process_succeeded(&output) {
        return None;
    }
    let candidate = String::from_utf8(output.stdout)
        .ok()
        .and_then(|value| ExecutionCandidate::new(value).ok())?;
    let result = ExecutionResult::new(candidate, CompletionEvidence::Success, None).ok()?;
    Some(DriverStartOutcome::Completed {
        completion: DriverCompletion::success(result),
    })
}

fn process_succeeded(output: &ProcessRunOutput) -> bool {
    output.exit_code == Some(0)
        && !output.cancelled
        && !output.timed_out
        && output.cleanup.proves_tree_empty()
        && output.post_launch_error.is_none()
        && output.stderr.is_empty()
}

fn definitely_not_started() -> DriverStartOutcome {
    DriverStartOutcome::DefinitelyNotStarted { fault: None }
}

fn indeterminate() -> DriverStartOutcome {
    DriverStartOutcome::Indeterminate { fault: None }
}

fn indeterminate_resolution() -> ExecutionSiteResolution {
    ExecutionSiteResolution::Indeterminate {
        fault: invariant_fault(),
    }
}

fn invariant_fault() -> crate::fault::EngineFault {
    use crate::fault::{EvidenceClass, FaultContext, FaultFactory, FaultModule, ModuleEvidence};
    use crate::observability::NoopObservationSink;

    static SINK: NoopObservationSink = NoopObservationSink;
    FaultFactory::new(&SINK).create(ModuleEvidence::new(
        FaultModule::Worker,
        FaultContext::Execution,
        EvidenceClass::InvariantViolation,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output() -> ProcessRunOutput {
        ProcessRunOutput {
            launch_evidence: ProcessLaunchEvidence::MayHaveStarted,
            exit_code: Some(0),
            stdout: br#"{"artifacts":[],"output":{"value":42},"status":"verified"}"#.to_vec(),
            stderr: Vec::new(),
            cancelled: false,
            timed_out: false,
            cleanup: Default::default(),
            post_launch_error: None,
        }
    }

    #[test]
    fn process_defects_never_become_completion() {
        let mut nonzero = output();
        nonzero.exit_code = Some(1);
        assert!(matches!(
            classify_process_result(Ok(nonzero)),
            DriverStartOutcome::Indeterminate { .. }
        ));

        let mut timed_out = output();
        timed_out.timed_out = true;
        assert!(matches!(
            classify_process_result(Ok(timed_out)),
            DriverStartOutcome::Indeterminate { .. }
        ));

        assert!(matches!(
            classify_process_result(Err(ProcessRunnerError::Io("uncertain".to_owned()))),
            DriverStartOutcome::Indeterminate { .. }
        ));
        assert!(matches!(
            classify_process_result(Err(ProcessRunnerError::Launch("not started".to_owned()))),
            DriverStartOutcome::DefinitelyNotStarted { .. }
        ));
    }
}
