use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use openengine_cluster_protocol::{canonical_value_bytes, WorkerErrorCode, WorkerOutcome};
use tokio::sync::watch;
use tokio::time::{Duration, Instant};

use crate::execution::driver::{
    BuiltinWorkerDriver, DriverCancellation, DriverCompletion, DriverRequest, DriverStartOutcome,
    WorkspaceCapability,
};
use crate::execution::process::{
    LocalProcessRunner, ProcessCommand, ProcessInput, ProcessLaunchEvidence, ProcessRunOutput,
    ProcessRunnerError, ProcessSecretEnvironment,
};
use crate::execution::{CompletionEvidence, ExecutionCandidate, ExecutionResult, WorkspaceAccessMode};
use crate::native_credentials::{
    AcquisitionBudget, CancellationSignal, CredentialClock, CredentialRequirementName,
    CredentialSourceKind, CredentialSourcePolicy, CredentialSourceRef, CredentialSourceRegistry,
    EnvSnapshotCredentialSource, NativeCredentialResolver,
};
use crate::observability::NoopObservationSink;
use crate::worker_catalog::{worker_catalog, DriverFamily, ProbeStrategy};

use super::artifact::{AgentArtifactStore, ValidatedAgentOutput};
use super::protocol::{parse_codex_output, validate_validation_output, AgentDispatchInput};
use super::validator::VALIDATOR_MODE;
use super::super::program::NATIVE_AGENT_PROCESS_TIMEOUT_MS;
use super::super::NativeExecutionProcess;

const OPENAI_API_KEY: &str = "OPENAI_API_KEY";
static CREDENTIAL_CLOCK: SystemCredentialClock = SystemCredentialClock;
static CREDENTIAL_OBSERVATIONS: NoopObservationSink = NoopObservationSink;
static NEVER_CANCELLED: NeverCancelled = NeverCancelled;

pub(super) struct NativeCodexDriver {
    runner: LocalProcessRunner,
    codex_executable: Option<PathBuf>,
    base_arguments: Vec<String>,
    validator_executable: PathBuf,
    workspace: PathBuf,
    artifacts: AgentArtifactStore,
    requirement: CredentialRequirementName,
    credentials: NativeCredentialResolver<'static>,
}

impl NativeCodexDriver {
    pub(super) fn new(
        workspace: &Path,
        process: &NativeExecutionProcess,
        artifacts: AgentArtifactStore,
    ) -> Result<Self, ()> {
        let (codex_executable, base_arguments, requirement) =
            canonical_codex_configuration(process.path_snapshot.clone())?;
        let credentials =
            credential_resolver(requirement.clone(), process.api_key_snapshot.clone())?;
        Ok(Self {
            runner: LocalProcessRunner::new(),
            codex_executable,
            base_arguments,
            validator_executable: process.executable.clone(),
            workspace: workspace.to_path_buf(),
            artifacts,
            requirement,
            credentials,
        })
    }

    pub(super) async fn preflight(&self) -> Result<(), ()> {
        drop(self.acquire_secret()?);
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
        let (_cancel_tx, cancel_rx) = watch::channel(false);
        let output = self
            .runner
            .run(
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
                DriverCancellation::new(cancel_rx),
            )
            .await
            .map_err(|_| ())?;
        if output.exit_code != Some(0)
            || output.cancelled
            || output.timed_out
            || !output.cleanup.proves_tree_empty()
            || output.post_launch_error.is_some()
        {
            return Err(());
        }
        let mut bytes = output.stdout;
        bytes.extend_from_slice(&output.stderr);
        Ok(bytes)
    }

    fn acquire_secret(&self) -> Result<ProcessSecretEnvironment, ()> {
        let now = CREDENTIAL_CLOCK.now_ms();
        let budget = AcquisitionBudget::new(
            now.saturating_add(NATIVE_AGENT_PROCESS_TIMEOUT_MS),
            NATIVE_AGENT_PROCESS_TIMEOUT_MS,
            &NEVER_CANCELLED,
        );
        self.credentials
            .with_requirement_material(&self.requirement, &budget, |material| {
                ProcessSecretEnvironment::single(OPENAI_API_KEY, material)
            })
            .map_err(|_| ())?
            .map_err(|_| ())
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
    ) -> Result<Vec<u8>, AgentRunFailure> {
        let Some(program) = self.validator_executable.to_str().map(str::to_owned) else {
            return Err(AgentRunFailure::Closed(WorkerErrorCode::Crash));
        };
        let stdin = match ProcessInput::new(input.expected_greeting.as_bytes().to_vec()) {
            Ok(stdin) => stdin,
            Err(_) => return Err(AgentRunFailure::Closed(WorkerErrorCode::Malformed)),
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
            return Err(AgentRunFailure::Closed(WorkerErrorCode::Refusal));
        }
        Ok(output.stdout)
    }

    async fn run_request(
        &self,
        request: &DriverRequest,
        cancellation: DriverCancellation,
    ) -> Result<WorkerOutcome, AgentRunFailure> {
        let input = AgentDispatchInput::from_execution_input(request.input.clone())
            .map_err(|()| AgentRunFailure::Closed(WorkerErrorCode::Malformed))?;
        let secrets = self
            .acquire_secret()
            .map_err(|()| AgentRunFailure::Closed(WorkerErrorCode::Refusal))?;
        let command = self
            .codex_command(&input)
            .ok_or(AgentRunFailure::Closed(WorkerErrorCode::Crash))?;
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
            .map_err(|()| AgentRunFailure::Closed(WorkerErrorCode::Crash))
    }
}

#[async_trait]
impl BuiltinWorkerDriver for NativeCodexDriver {
    async fn start(
        &self,
        request: DriverRequest,
        cancellation: DriverCancellation,
    ) -> DriverStartOutcome {
        match self.run_request(&request, cancellation).await {
            Ok(outcome) => completed_outcome(outcome),
            Err(AgentRunFailure::Closed(code)) => completed_error(code),
            Err(AgentRunFailure::Uncertain) => indeterminate(),
        }
    }
}

enum AgentRunFailure {
    Closed(WorkerErrorCode),
    Uncertain,
}

fn cleaned_process(
    result: Result<ProcessRunOutput, ProcessRunnerError>,
) -> Result<ProcessRunOutput, AgentRunFailure> {
    let output = match result {
        Err(error) if error.launch_evidence() == ProcessLaunchEvidence::DefinitelyNotStarted => {
            return Err(AgentRunFailure::Closed(WorkerErrorCode::Crash));
        }
        Err(_) => return Err(AgentRunFailure::Uncertain),
        Ok(output) => output,
    };
    if !output.cleanup.proves_tree_empty() || output.post_launch_error.is_some() {
        return Err(AgentRunFailure::Uncertain);
    }
    if output.timed_out || output.cancelled {
        return Err(AgentRunFailure::Closed(WorkerErrorCode::Timeout));
    }
    Ok(output)
}

fn classify_provider(
    result: Result<ProcessRunOutput, ProcessRunnerError>,
) -> Result<String, AgentRunFailure> {
    let output = cleaned_process(result)?;
    if output.exit_code != Some(0) || !output.stderr.is_empty() {
        return Err(AgentRunFailure::Closed(WorkerErrorCode::Crash));
    }
    parse_codex_output(&output.stdout)
        .map_err(|()| AgentRunFailure::Closed(WorkerErrorCode::Malformed))
}

fn credential_resolver(
    requirement: CredentialRequirementName,
    api_key: Option<String>,
) -> Result<NativeCredentialResolver<'static>, ()> {
    let source = CredentialSourceRef::new(CredentialSourceKind::Environment, OPENAI_API_KEY)
        .map_err(|_| ())?;
    let policy = CredentialSourcePolicy::new(BTreeMap::from([(requirement, vec![source])]))
        .map_err(|_| ())?;
    let snapshot = api_key
        .map(|value| BTreeMap::from([(OPENAI_API_KEY.to_owned(), value)]))
        .unwrap_or_default();
    let registry = CredentialSourceRegistry::new()
        .register(Arc::new(EnvSnapshotCredentialSource::new(snapshot)))
        .map_err(|_| ())?;
    Ok(NativeCredentialResolver::new(
        policy,
        registry,
        &CREDENTIAL_CLOCK,
        &CREDENTIAL_OBSERVATIONS,
    ))
}

fn canonical_codex_configuration(
    path_snapshot: Option<std::ffi::OsString>,
) -> Result<(Option<PathBuf>, Vec<String>, CredentialRequirementName), ()> {
    let descriptor = worker_catalog().resolve("codex").ok_or(())?;
    if descriptor.driver_family() != DriverFamily::CliProcess
        || descriptor.credential_requirements().len() != 1
    {
        return Err(());
    }
    let metadata = descriptor.executable().ok_or(())?;
    if metadata.probe() != ProbeStrategy::Version {
        return Err(());
    }
    let executable = resolve_executable(metadata.name().as_str(), path_snapshot.as_deref());
    let arguments = metadata
        .arguments()
        .iter()
        .map(|argument| argument.as_str().to_owned())
        .collect();
    Ok((
        executable,
        arguments,
        descriptor.credential_requirements()[0].clone(),
    ))
}

fn resolve_executable(name: &str, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    std::env::split_paths(path?)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| std::fs::canonicalize(candidate).ok())
}

fn completed_error(code: WorkerErrorCode) -> DriverStartOutcome {
    completed_outcome(WorkerOutcome::declared_failure(code))
}

fn completed_outcome(outcome: WorkerOutcome) -> DriverStartOutcome {
    let value = serde_json::to_value(outcome).expect("closed worker outcome must serialize");
    let bytes = canonical_value_bytes(&value).expect("closed worker outcome must canonicalize");
    let candidate = ExecutionCandidate::new(
        String::from_utf8(bytes).expect("canonical worker outcome must be UTF-8"),
    )
    .expect("closed worker outcome fits execution candidate bounds");
    let result = ExecutionResult::new(candidate, CompletionEvidence::Success, None)
        .expect("closed worker completion is valid");
    DriverStartOutcome::Completed {
        completion: DriverCompletion::success(result),
    }
}

fn indeterminate() -> DriverStartOutcome {
    DriverStartOutcome::Indeterminate { fault: None }
}

struct SystemCredentialClock;

impl CredentialClock for SystemCredentialClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }
}

struct NeverCancelled;

impl CancellationSignal for NeverCancelled {
    fn is_cancelled(&self) -> bool {
        false
    }
}
