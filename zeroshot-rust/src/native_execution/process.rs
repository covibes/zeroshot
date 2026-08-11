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
    ExecutionTargetRef, WorkspaceAccessMode,
};
use crate::native_admission::native_worker_protocol::{effect_marker_id, WORKER_MODE};

use super::program::NATIVE_PROCESS_TIMEOUT_MS;

pub(crate) struct NativeExecutionProcess {
    pub(crate) state_dir: PathBuf,
    pub(crate) executable: PathBuf,
}

pub(super) fn runtime(process: NativeExecutionProcess) -> LocalExecutionRuntime {
    let driver = Arc::new(NativeDeterministicDriver {
        runner: LocalProcessRunner::new(),
        executable: process.executable,
    });
    LocalExecutionRuntime::new(Arc::new(NativeExecutionResolver {
        driver,
        state_dir: process.state_dir,
    }))
}

struct NativeExecutionResolver {
    driver: Arc<NativeDeterministicDriver>,
    state_dir: PathBuf,
}

#[async_trait]
impl ExecutionSiteResolver for NativeExecutionResolver {
    async fn resolve(&self, command: &ExecutionCommand) -> ExecutionSiteResolution {
        let ExecutionTargetRef::Builtin(target) = command.target() else {
            return indeterminate_resolution();
        };
        if target.builtin_id().as_str() != "native.deterministic" || target.version() != 1 {
            return indeterminate_resolution();
        }
        ExecutionSiteResolution::Resolved(Box::new(ResolvedExecutionSite::Builtin {
            driver: self.driver.clone(),
            request: DriverRequest {
                control: command.control(),
                input: command.input().clone(),
                workspace: WorkspaceCapability {
                    current_dir: self.state_dir.clone(),
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
