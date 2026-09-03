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

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::time::Instant;

use crate::execution::process::{HostedProcessPool, LocalProcessRunner, ProcessSessionCommand};
use crate::native_v2_capsule::provider_process::{
    ClosedSessionFailure, ProviderProcessRunners, process_scope, redaction_values,
    validate_process_cleanup, validate_process_output,
};
use crate::native_v2_contract::{ClaudeProvider, NodeRuntimeBinding};
use crate::native_v2_runner::{
    AgentResponse, render_agent_prompt, resolve_agent_response, DriverControl, DriverInvocation,
    LiveOutput, LiveOutputStream, NodeRunnerError, ProviderSchemaDialect, ResolvedEnvironment,
};
use command::{
    ClaudeTurnArguments, claude_arguments, configure_openrouter, extend_declared_environment,
    reject_provider_controls, workspace_access,
};
use session::ClaudeSession;
use transcript::{ClaudeAttempt, ClaudeTranscript};

const MAX_PROMPT_BYTES: usize = 64 * 1024;
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
            if value.contains('\0') || name.len().saturating_add(value.len()) > 16 * 1024 {
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

    fn turn_process(
        &self,
        invocation: &DriverInvocation,
    ) -> Result<(LocalProcessRunner, PathBuf), NodeRunnerError> {
        let scope = process_scope(invocation)?;
        self.runners.turn_process(&self.runtime_home, scope)
    }

    fn command(
        &self,
        turn: &ClaudeTurn<'_>,
        input: ClaudeCommandInput<'_>,
    ) -> Result<ProcessSessionCommand, NodeRunnerError> {
        let invocation = turn.invocation;
        let NodeRuntimeBinding::Agent { model, effort, .. } = &invocation.node.binding else {
            return Err(NodeRunnerError::Driver);
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
                .map_err(|_| NodeRunnerError::Driver)?,
                prompt: input.prompt,
            },
        )?;

        Ok(ProcessSessionCommand {
            program: self.executable.clone(),
            argv,
            environment: self.process_environment(&invocation.environment, input.runtime_home)?,
            workspace: crate::execution::driver::WorkspaceCapability {
                current_dir: self.workspace.clone(),
                mode: workspace_access(invocation.role)?,
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
            .ok_or(NodeRunnerError::Driver)?;
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
        extend_declared_environment(&mut environment, resolved)?;
        reject_provider_controls(&environment)?;
        if self.provider == ClaudeProvider::OpenRouter {
            configure_openrouter(&mut environment)?;
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
        observe_session(resume_id, attempt_session_id(&attempt))?;
        resolve_claude_attempt(turn, resume_id, attempt)
    }

    async fn execute_turn(
        &self,
        turn: &ClaudeTurn<'_>,
        resume_id: Option<&str>,
        prompt: String,
    ) -> Result<ClaudeAttempt, NodeRunnerError> {
        let mut process = self.open_turn_process(turn, resume_id, prompt).await?;
        let mut transcript = ClaudeTranscript::new(redaction_values(
            turn.invocation.environment.iter().map(|(_, value)| value),
        ));
        let collected = collect_transcript(&mut process, &mut transcript, turn.control).await;
        let process_output = if collected.is_ok() {
            process.wait().await
        } else {
            process.release().await
        };
        turn.control.record_token_usage(transcript.token_usage())?;
        let process_output = process_output.map_err(|_| NodeRunnerError::Driver)?;
        validate_process_cleanup(&process_output, turn.control)?;
        collected?;
        let attempt = transcript.finish()?;
        if matches!(attempt, ClaudeAttempt::Complete(_)) {
            validate_process_output(&process_output, turn.control)?;
        }
        Ok(attempt)
    }

    async fn open_turn_process(
        &self,
        turn: &ClaudeTurn<'_>,
        resume_id: Option<&str>,
        prompt: String,
    ) -> Result<crate::execution::process::ProcessSession, NodeRunnerError> {
        let (runner, runtime_home) = self.turn_process(turn.invocation)?;
        let command = self.command(
            turn,
            ClaudeCommandInput {
                resume_id,
                runtime_home: &runtime_home,
                prompt,
            },
        )?;
        let mut process = runner
            .open(command, turn.control.cancellation())
            .await
            .map_err(|_| NodeRunnerError::Driver)?;
        if process.close_stdin().await.is_err() {
            let _ = process.release().await;
            return Err(NodeRunnerError::Driver);
        }
        Ok(process)
    }
}

fn attempt_session_id(attempt: &ClaudeAttempt) -> Option<&str> {
    match attempt {
        ClaudeAttempt::Complete(result) => result.session_id.as_deref(),
        ClaudeAttempt::Failed(failure) => failure.session_id.as_deref(),
    }
}

fn resolve_claude_attempt(
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
            return Err(NodeRunnerError::Driver);
        }
        turn.control.emit(LiveOutput::new(
            LiveOutputStream::System,
            "Claude final output rejected; requesting correction",
        )?)?;
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
    prompt: String,
}

async fn collect_transcript(
    process: &mut crate::execution::process::ProcessSession,
    transcript: &mut ClaudeTranscript,
    control: &DriverControl,
) -> Result<(), NodeRunnerError> {
    while let Some(chunk) = process.recv_stdout().await {
        transcript.push(chunk.as_slice(), control)?;
    }
    transcript.finish_stream()
}

fn observe_session(
    retained: &mut Option<String>,
    observed: Option<&str>,
) -> Result<(), NodeRunnerError> {
    let Some(observed) = observed else {
        return Ok(());
    };
    match retained.as_deref() {
        Some(existing) if existing != observed => Err(NodeRunnerError::Driver),
        Some(_) => Ok(()),
        None => {
            *retained = Some(observed.to_owned());
            Ok(())
        }
    }
}

fn prompt(invocation: &DriverInvocation) -> Result<String, NodeRunnerError> {
    let value = render_agent_prompt(
        invocation.agent_instructions()?,
        &invocation.node.input,
        &invocation.response,
    )?;
    if value.len() > MAX_PROMPT_BYTES || value.contains('\0') {
        return Err(NodeRunnerError::Driver);
    }
    Ok(value)
}

#[cfg(test)]
#[path = "native_v2_claude/tests.rs"]
mod tests;
