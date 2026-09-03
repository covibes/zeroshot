//! Claude CLI adapter for native-v2 graph nodes.
//!
//! One adapter is constructed for the graph-wide Anthropic or OpenRouter lane. Admission has
//! already selected the model, effort, session scope, and declared environment for each node;
//! It preserves those choices without consulting legacy coordination or ambient process state.

#[path = "native_v2_claude/command.rs"]
mod command;
#[path = "native_v2_claude/session.rs"]
mod session;
#[path = "native_v2_claude/transcript.rs"]
mod transcript;
#[path = "native_v2_claude/turn_process.rs"]
mod turn_process;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::time::Instant;

use crate::execution::process::{HostedProcessPool, ProcessSessionCommand, ProcessStdout};
use crate::native_v2_capsule::provider_process::{
    ClosedSessionFailure, ProviderProcessRunners, process_scope, redaction_values,
    with_driver_detail,
};
use crate::native_v2_contract::{ClaudeProvider, NodeRuntimeBinding};
use crate::native_v2_runner::{
    AgentResponse, resolve_agent_response, DriverControl, DriverInvocation, LiveOutput,
    LiveOutputStream, NodeRunnerError, ProviderSchemaDialect, ResolvedEnvironment,
};
use command::{
    ClaudeTurnArguments, claude_arguments, configure_openrouter, extend_declared_environment,
    prompt, reject_provider_controls, workspace_access,
};
use session::{ClaudeSession, attempt_session_id, observe_session};
use transcript::{ClaudeAttempt, ClaudeEmission, ClaudeTranscript};
use turn_process::ClaudeProcessStart;

const MINIMAL_ENVIRONMENT_NAMES: [&str; 6] = ["HOME", "LANG", "LC_ALL", "PATH", "TERM", "TMPDIR"];

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ClaudeAdapterConfigError {
    #[error("Claude executable must not be empty")]
    EmptyExecutable,
    #[error("base process environment contains non-minimal name {0}")]
    NonMinimalEnvironment(String),
    #[error("base process environment contains an invalid value")]
    InvalidEnvironment,
}

/// Explicit non-secret environment needed to launch the CLI and its tools.
///
/// The controller supplies this value. It is deliberately not populated from the ambient
/// process, and only a small allowlist can cross this boundary.
#[derive(Clone, Default)]
pub struct ClaudeProcessEnvironment(BTreeMap<String, String>);

impl ClaudeProcessEnvironment {
    pub fn new(values: BTreeMap<String, String>) -> Result<Self, ClaudeAdapterConfigError> {
        for (name, value) in &values {
            if !MINIMAL_ENVIRONMENT_NAMES.contains(&name.as_str()) {
                return Err(ClaudeAdapterConfigError::NonMinimalEnvironment(
                    name.clone(),
                ));
            }
            if value.contains('\0') {
                return Err(ClaudeAdapterConfigError::InvalidEnvironment);
            }
        }
        Ok(Self(values))
    }

    fn clone_values(&self) -> BTreeMap<String, String> {
        self.0.clone()
    }

    pub(crate) fn for_capsule(
        &self,
        runtime_home: &Path,
        default_path: &str,
    ) -> Result<Self, ClaudeAdapterConfigError> {
        let runtime_home = runtime_home
            .to_str()
            .filter(|value| !value.is_empty())
            .ok_or(ClaudeAdapterConfigError::InvalidEnvironment)?;
        let mut values = self.clone_values();
        values.insert("HOME".to_owned(), runtime_home.to_owned());
        values
            .entry("PATH".to_owned())
            .or_insert_with(|| default_path.to_owned());
        Self::new(values)
    }
}

impl std::fmt::Debug for ClaudeProcessEnvironment {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("ClaudeProcessEnvironment")
            .field(&self.0.keys().collect::<Vec<_>>())
            .finish()
    }
}

/// One graph-wide Claude provider lane.
pub struct ClaudeAdapter {
    provider: ClaudeProvider,
    executable: String,
    prefix_arguments: Vec<String>,
    workspace: PathBuf,
    runtime_home: PathBuf,
    local_user_home: Option<PathBuf>,
    base_environment: ClaudeProcessEnvironment,
    turn_timeout: Duration,
    runners: ProviderProcessRunners,
}

pub struct ClaudeAdapterConfig {
    pub provider: ClaudeProvider,
    pub executable: String,
    pub prefix_arguments: Vec<String>,
    pub workspace: PathBuf,
    pub runtime_home: PathBuf,
    /// Current-user home is available only to the built-in local target.
    pub local_user_home: Option<PathBuf>,
    pub base_environment: ClaudeProcessEnvironment,
    pub turn_timeout: Duration,
    pub process_pool: HostedProcessPool,
}

impl ClaudeAdapter {
    pub fn new(mut configuration: ClaudeAdapterConfig) -> Result<Self, ClaudeAdapterConfigError> {
        configuration.local_user_home = None;
        let runners = ProviderProcessRunners::hosted(configuration.process_pool);
        Self::configured(configuration, runners)
    }

    pub fn new_local(configuration: ClaudeAdapterConfig) -> Result<Self, ClaudeAdapterConfigError> {
        Self::configured(configuration, ProviderProcessRunners::local())
    }

    fn configured(
        configuration: ClaudeAdapterConfig,
        runners: ProviderProcessRunners,
    ) -> Result<Self, ClaudeAdapterConfigError> {
        if configuration.executable.is_empty() {
            return Err(ClaudeAdapterConfigError::EmptyExecutable);
        }
        Ok(Self {
            provider: configuration.provider,
            executable: configuration.executable,
            prefix_arguments: configuration.prefix_arguments,
            workspace: configuration.workspace,
            runtime_home: configuration.runtime_home,
            local_user_home: configuration.local_user_home,
            base_environment: configuration.base_environment,
            turn_timeout: configuration.turn_timeout,
            runners,
        })
    }

    #[cfg(test)]
    fn new_for_test(configuration: ClaudeAdapterConfig) -> Result<Self, ClaudeAdapterConfigError> {
        Self::new_local(configuration)
    }

    fn command(
        &self,
        turn: &ClaudeTurn<'_>,
        input: ClaudeCommandInput<'_>,
    ) -> Result<ProcessSessionCommand, NodeRunnerError> {
        let invocation = turn.invocation;
        let NodeRuntimeBinding::Agent { model, effort, .. } = &invocation.node.binding else {
            return Err(NodeRunnerError::DriverDetail(
                "Claude command requires an agent runtime binding".to_owned(),
            ));
        };
        let argv = claude_arguments(
            self.prefix_arguments.clone(),
            ClaudeTurnArguments {
                model: model.as_str(),
                effort: *effort,
                role: invocation.role,
                resume_id: input.resume_id,
                json_schema: serde_json::to_string(
                    &invocation
                        .response
                        .provider_schema(ProviderSchemaDialect::Standard),
                )
                .map_err(|_| {
                    NodeRunnerError::DriverDetail(
                        "Claude response schema could not be serialized".to_owned(),
                    )
                })?,
            },
        )
        .map_err(|error| {
            with_driver_detail(error, "Claude command rejected the selected node role")
        })?;

        Ok(ProcessSessionCommand {
            program: self.executable.clone(),
            argv,
            environment: self
                .process_environment(&invocation.environment, input.runtime_home)
                .map_err(|error| {
                    with_driver_detail(error, "Claude provider environment is invalid")
                })?,
            workspace: crate::execution::driver::WorkspaceCapability {
                current_dir: self.workspace.clone(),
                mode: workspace_access(invocation.role).map_err(|error| {
                    with_driver_detail(error, "Claude workspace policy rejected the node role")
                })?,
            },
            deadline: turn.deadline,
        })
    }

    fn process_environment(
        &self,
        resolved: &ResolvedEnvironment,
        runtime_home: &Path,
    ) -> Result<BTreeMap<String, String>, NodeRunnerError> {
        let mut environment = self.base_environment.clone_values();
        let runtime_home = runtime_home
            .to_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                NodeRunnerError::DriverDetail(
                    "Claude runtime home is not a valid non-empty platform path".to_owned(),
                )
            })?;
        let provider_home = self
            .local_user_home
            .as_deref()
            .and_then(Path::to_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(runtime_home);
        environment.insert("HOME".to_owned(), provider_home.to_owned());
        // Hosted targets may expose a read-only or root-owned shared `/tmp`. Keep Claude's
        // sockets and temporary files inside the same provider-private session home instead.
        environment.insert("TMPDIR".to_owned(), runtime_home.to_owned());
        extend_declared_environment(&mut environment, resolved).map_err(|error| {
            with_driver_detail(
                error,
                "Claude declared environment conflicts with reserved process configuration",
            )
        })?;
        reject_provider_controls(&environment).map_err(|error| {
            with_driver_detail(
                error,
                "Claude declared environment contains a provider-owned control variable",
            )
        })?;
        if self.provider == ClaudeProvider::OpenRouter {
            configure_openrouter(&mut environment).map_err(|error| {
                with_driver_detail(
                    error,
                    "Claude OpenRouter credentials are missing or conflict with Anthropic credentials",
                )
            })?;
        }
        Ok(environment)
    }
}

impl ClaudeAdapter {
    async fn advance_turn(
        &self,
        turn: &ClaudeTurn<'_>,
        resume_id: &mut Option<String>,
        prompt: String,
    ) -> Result<ClaudeTurnAdvance, NodeRunnerError> {
        turn.session
            .core
            .ensure_live(ClosedSessionFailure::SessionLost)?;
        let attempt = self
            .execute_turn(turn, resume_id.as_deref(), prompt)
            .await?;
        if let Err(diagnostic) = observe_session(resume_id, attempt_session_id(&attempt)) {
            return Ok(ClaudeTurnAdvance::ProviderFailure {
                retryable: false,
                diagnostic: diagnostic.to_owned(),
            });
        }
        resolve_claude_attempt(turn, resume_id, attempt).await
    }

    async fn execute_turn(
        &self,
        turn: &ClaudeTurn<'_>,
        resume_id: Option<&str>,
        prompt: String,
    ) -> Result<ClaudeAttempt, NodeRunnerError> {
        let mut process = match self.open_turn_process(turn, resume_id).await? {
            ClaudeProcessStart::Ready(process) => process,
            ClaudeProcessStart::Failed(attempt) => return Ok(attempt),
        };
        let transcript = ClaudeTranscript::new(redaction_values(
            turn.invocation.environment.iter().map(|(_, value)| value),
        ));
        turn_process::finish_process(&mut process, prompt.as_bytes(), transcript, turn.control)
            .await
    }

    async fn open_turn_process(
        &self,
        turn: &ClaudeTurn<'_>,
        resume_id: Option<&str>,
    ) -> Result<ClaudeProcessStart, NodeRunnerError> {
        let scope = process_scope(turn.invocation).map_err(|error| {
            with_driver_detail(error, "Claude process scope requires an agent node role")
        })?;
        let (runner, runtime_home) = match self.runners.turn_process(&self.runtime_home, scope) {
            Ok(process) => process,
            Err(error) => return turn_process::failed_before_start(error, turn.control),
        };
        let command = self.command(
            turn,
            ClaudeCommandInput {
                resume_id,
                runtime_home: &runtime_home,
            },
        )?;
        turn_process::open(runner, command, turn.control).await
    }
}

async fn resolve_claude_attempt(
    turn: &ClaudeTurn<'_>,
    resume_id: &Option<String>,
    attempt: ClaudeAttempt,
) -> Result<ClaudeTurnAdvance, NodeRunnerError> {
    let result = match attempt {
        ClaudeAttempt::Complete(result) => result,
        ClaudeAttempt::Failed(failure) => {
            return Ok(ClaudeTurnAdvance::ProviderFailure {
                retryable: failure.retryable,
                diagnostic: failure.diagnostic,
            });
        }
    };
    let response = resolve_agent_response(&turn.invocation.response, &result.message)?;
    if matches!(response, AgentResponse::Correction(_)) {
        if resume_id.is_none() {
            return Ok(ClaudeTurnAdvance::ProviderFailure {
                retryable: false,
                diagnostic:
                    "Claude output did not provide a session identifier required for correction"
                        .to_owned(),
            });
        }
        turn.control
            .emit(LiveOutput::new(
                LiveOutputStream::System,
                "Claude final output rejected; requesting correction",
            )?)
            .await?;
    }
    Ok(ClaudeTurnAdvance::Response(response))
}

struct ClaudeTurn<'a> {
    invocation: &'a DriverInvocation,
    session: &'a ClaudeSession,
    control: &'a DriverControl,
    deadline: Instant,
}

enum ClaudeTurnAdvance {
    Response(AgentResponse),
    ProviderFailure { retryable: bool, diagnostic: String },
}

struct ClaudeCommandInput<'a> {
    resume_id: Option<&'a str>,
    runtime_home: &'a Path,
}

async fn collect_transcript(
    mut stdout: ProcessStdout,
    transcript: &mut ClaudeTranscript,
    control: &DriverControl,
) -> Result<(), NodeRunnerError> {
    let mut delivery_error = None;
    while let Some(chunk) = stdout.recv().await {
        let emissions = transcript.push(chunk.as_slice());
        if delivery_error.is_none() {
            delivery_error = emit_claude(control, emissions).await.err();
        }
    }
    let emissions = transcript.finish_stream();
    if delivery_error.is_none() {
        delivery_error = emit_claude(control, emissions).await.err();
    }
    delivery_error.map_or(Ok(()), Err)
}

async fn emit_claude(
    control: &DriverControl,
    emissions: Vec<ClaudeEmission>,
) -> Result<(), NodeRunnerError> {
    for emission in emissions {
        control
            .emit(LiveOutput::new(emission.stream, emission.text)?)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "native_v2_claude/tests.rs"]
mod tests;
