use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use openengine_cluster_protocol::{WorkerErrorCode, WorkerOutcome};
use tokio::time::{Duration, Instant};

use crate::execution::driver::{
    BuiltinWorkerDriver, DriverCancellation, DriverRequest, DriverStartOutcome, WorkspaceCapability,
};
use crate::execution::process::{
    LocalProcessRunner, ProcessCommand, ProcessInput, ProcessRunOutput, ProcessRunnerError,
};
use crate::execution::WorkspaceAccessMode;

use super::artifact::{AgentArtifactStore, ValidatedAgentOutput};
use super::protocol::{parse_codex_output, validate_validation_output, AgentDispatchInput};
use super::validator::VALIDATOR_MODE;
use super::super::credential::OpenAiCredential;
use super::super::program::NATIVE_AGENT_PROCESS_TIMEOUT_MS;
use super::super::worker_process::{
    cleaned_process, cli_configuration, finish_worker_run, probe_output, successful_stdout,
    WorkerRunFailure,
};
use super::super::NativeExecutionProcess;

pub(super) struct NativeCodexDriver {
    runner: LocalProcessRunner,
    codex_executable: Option<PathBuf>,
    base_arguments: Vec<String>,
    validator_executable: PathBuf,
    workspace: PathBuf,
    artifacts: AgentArtifactStore,
    credential: OpenAiCredential,
}

impl NativeCodexDriver {
    pub(super) fn new(
        workspace: &Path,
        process: &NativeExecutionProcess,
        artifacts: AgentArtifactStore,
    ) -> Result<Self, ()> {
        let configuration = cli_configuration("codex", process.path_snapshot.as_deref())?;
        let credential =
            OpenAiCredential::new(configuration.requirement, process.api_key_snapshot.clone())?;
        Ok(Self {
            runner: LocalProcessRunner::new(),
            codex_executable: configuration.executable,
            base_arguments: configuration.arguments,
            validator_executable: process.executable.clone(),
            workspace: workspace.to_path_buf(),
            artifacts,
            credential,
        })
    }

    pub(super) async fn preflight(&self) -> Result<(), ()> {
        drop(self.credential.acquire(NATIVE_AGENT_PROCESS_TIMEOUT_MS)?);
        let executable = self.codex_executable.as_ref().ok_or(())?;
        let version = self
            .run_probe(executable, vec!["--version".to_owned()])
            .await?;
        if version.is_empty() {
            return Err(());
        }
        let mut help_args = self.base_arguments.clone();
        help_args.push("--help".to_owned());
        let help =
            String::from_utf8(self.run_probe(executable, help_args).await?).map_err(|_| ())?;
        for flag in [
            "--json",
            "--sandbox",
            "--config",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--strict-config",
        ] {
            if !help.contains(flag) {
                return Err(());
            }
        }
        Ok(())
    }

    async fn run_probe(&self, executable: &Path, argv: Vec<String>) -> Result<Vec<u8>, ()> {
        probe_output(
            &self.runner,
            ProcessCommand {
                program: executable.to_str().ok_or(())?.to_owned(),
                argv,
                environment: BTreeMap::new(),
                workspace: WorkspaceCapability {
                    current_dir: self.workspace.clone(),
                    mode: WorkspaceAccessMode::ReadOnly,
                },
                stdin: ProcessInput::empty(),
                deadline: Instant::now() + Duration::from_secs(10),
            },
            None,
        )
        .await
    }

    fn codex_command(&self, input: &AgentDispatchInput) -> Option<ProcessCommand> {
        let executable = self.codex_executable.as_ref()?.to_str()?.to_owned();
        let mut argv = self.base_arguments.clone();
        argv.extend([
            "--json".to_owned(),
            "--sandbox".to_owned(),
            "workspace-write".to_owned(),
            "--config".to_owned(),
            "approval_policy=\"never\"".to_owned(),
            "--ephemeral".to_owned(),
            "--ignore-user-config".to_owned(),
            "--ignore-rules".to_owned(),
            "--strict-config".to_owned(),
            "--config".to_owned(),
            "web_search=\"disabled\"".to_owned(),
            "-".to_owned(),
        ]);
        Some(ProcessCommand {
            program: executable,
            argv,
            environment: BTreeMap::new(),
            workspace: WorkspaceCapability {
                current_dir: self.workspace.clone(),
                mode: WorkspaceAccessMode::Exclusive,
            },
            stdin: ProcessInput::new(input.provider_prompt().into_bytes()).ok()?,
            deadline: Instant::now() + Duration::from_millis(NATIVE_AGENT_PROCESS_TIMEOUT_MS),
        })
    }

    async fn validate_greeting(
        &self,
        input: &AgentDispatchInput,
        cancellation: DriverCancellation,
    ) -> Result<Vec<u8>, WorkerRunFailure> {
        let Some(program) = self.validator_executable.to_str().map(str::to_owned) else {
            return Err(WorkerRunFailure::Closed(WorkerErrorCode::Crash));
        };
        let stdin = match ProcessInput::new(input.expected_greeting.as_bytes().to_vec()) {
            Ok(stdin) => stdin,
            Err(_) => return Err(WorkerRunFailure::Closed(WorkerErrorCode::Malformed)),
        };
        let output = self
            .runner
            .run(
                ProcessCommand {
                    program,
                    argv: vec![VALIDATOR_MODE.to_owned()],
                    environment: BTreeMap::new(),
                    workspace: WorkspaceCapability {
                        current_dir: self.workspace.clone(),
                        mode: WorkspaceAccessMode::ReadOnly,
                    },
                    stdin,
                    deadline: Instant::now() + Duration::from_secs(10),
                },
                cancellation,
            )
            .await;
        let output = cleaned_process(output)?;
        if output.exit_code != Some(0)
            || !output.stderr.is_empty()
            || validate_validation_output(&output.stdout).is_err()
        {
            return Err(WorkerRunFailure::Closed(WorkerErrorCode::Refusal));
        }
        Ok(output.stdout)
    }

    async fn run_request(
        &self,
        request: &DriverRequest,
        cancellation: DriverCancellation,
    ) -> Result<WorkerOutcome, WorkerRunFailure> {
        let input = AgentDispatchInput::from_execution_input(request.input.clone())
            .map_err(|()| WorkerRunFailure::Closed(WorkerErrorCode::Malformed))?;
        let secrets = self
            .credential
            .acquire(NATIVE_AGENT_PROCESS_TIMEOUT_MS)
            .map_err(|()| WorkerRunFailure::Closed(WorkerErrorCode::Refusal))?;
        let command = self
            .codex_command(&input)
            .ok_or(WorkerRunFailure::Closed(WorkerErrorCode::Crash))?;
        let provider = self
            .runner
            .run_with_secrets(command, secrets, cancellation.clone())
            .await;
        let summary = classify_provider(provider)?;
        let validation = self.validate_greeting(&input, cancellation).await?;
        self.artifacts
            .publish(
                request,
                &input,
                ValidatedAgentOutput {
                    summary,
                    validation,
                },
            )
            .await
            .map_err(|()| WorkerRunFailure::Closed(WorkerErrorCode::Crash))
    }
}

#[async_trait]
impl BuiltinWorkerDriver for NativeCodexDriver {
    async fn start(
        &self,
        request: DriverRequest,
        cancellation: DriverCancellation,
    ) -> DriverStartOutcome {
        finish_worker_run(self.run_request(&request, cancellation).await)
    }
}

fn classify_provider(
    result: Result<ProcessRunOutput, ProcessRunnerError>,
) -> Result<String, WorkerRunFailure> {
    let stdout = successful_stdout(result)?;
    parse_codex_output(&stdout).map_err(|()| WorkerRunFailure::Closed(WorkerErrorCode::Malformed))
}
