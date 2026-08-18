//! Claude CLI adapter for native-v2 graph nodes.
//!
//! One adapter is constructed for the graph-wide Anthropic or OpenRouter lane. Admission has
//! already selected the model, effort, session scope, and declared environment for each node;
//! It preserves those choices without consulting legacy coordination or ambient process state.

#[path = "native_v2_claude/session.rs"]
mod session;
#[path = "native_v2_claude/transcript.rs"]
mod transcript;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::time::Instant;

use crate::execution::process::{HostedProcessPool, LocalProcessRunner, ProcessSessionCommand};
use crate::execution::WorkspaceAccessMode;
use crate::native_v2_capsule::provider_process::{
    ClosedSessionFailure, ProviderProcessRunners, effort_token, process_scope, redaction_values,
    validate_process_output,
};
use crate::native_v2_contract::{ClaudeProvider, NodeRuntimeBinding};
use crate::native_v2_runner::{
    AgentResponse, render_agent_prompt, resolve_agent_response, DriverControl, DriverInvocation,
    LiveOutput, LiveOutputStream, NodeRole, NodeRunnerError, ResolvedEnvironment,
};
use crate::worker_catalog::ReasoningEffort;
use session::ClaudeSession;
use transcript::ClaudeTranscript;

const MAX_PROMPT_BYTES: usize = 64 * 1024;
const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api";
const OPENROUTER_KEY: &str = "OPENROUTER_API_KEY";
const ANTHROPIC_TOKEN: &str = "ANTHROPIC_AUTH_TOKEN";
const ANTHROPIC_KEY: &str = "ANTHROPIC_API_KEY";
const ANTHROPIC_BASE_URL: &str = "ANTHROPIC_BASE_URL";
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
    base_environment: ClaudeProcessEnvironment,
    turn_timeout: Duration,
    runners: ProviderProcessRunners,
}

pub struct ClaudeAdapterConfig {
    pub provider: ClaudeProvider,
    pub executable: String,
    pub prefix_arguments: Vec<String>,
    pub workspace: PathBuf,
    pub base_environment: ClaudeProcessEnvironment,
    pub turn_timeout: Duration,
    pub process_pool: HostedProcessPool,
}

impl ClaudeAdapter {
    pub fn new(configuration: ClaudeAdapterConfig) -> Result<Self, ClaudeAdapterConfigError> {
        if configuration.executable.is_empty() {
            return Err(ClaudeAdapterConfigError::EmptyExecutable);
        }
        let process_pool = configuration.process_pool;
        Ok(Self {
            provider: configuration.provider,
            executable: configuration.executable,
            prefix_arguments: configuration.prefix_arguments,
            workspace: configuration.workspace,
            base_environment: configuration.base_environment,
            turn_timeout: configuration.turn_timeout,
            runners: ProviderProcessRunners::hosted(process_pool),
        })
    }

    pub fn new_local(configuration: ClaudeAdapterConfig) -> Result<Self, ClaudeAdapterConfigError> {
        if configuration.executable.is_empty() {
            return Err(ClaudeAdapterConfigError::EmptyExecutable);
        }
        Ok(Self {
            provider: configuration.provider,
            executable: configuration.executable,
            prefix_arguments: configuration.prefix_arguments,
            workspace: configuration.workspace,
            base_environment: configuration.base_environment,
            turn_timeout: configuration.turn_timeout,
            runners: ProviderProcessRunners::local(),
        })
    }

    #[cfg(test)]
    fn new_for_test(configuration: ClaudeAdapterConfig) -> Result<Self, ClaudeAdapterConfigError> {
        let mut adapter = Self::new(configuration)?;
        adapter.runners = ProviderProcessRunners::local();
        Ok(adapter)
    }

    fn turn_process(
        &self,
        invocation: &DriverInvocation,
    ) -> Result<(LocalProcessRunner, PathBuf), NodeRunnerError> {
        let scope = process_scope(invocation)?;
        let root = self
            .base_environment
            .0
            .get("HOME")
            .map(PathBuf::from)
            .ok_or(NodeRunnerError::Driver)?;
        self.runners.turn_process(&root, scope)
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
        validate_model_effort(model.as_str(), *effort)?;
        let argv = claude_arguments(
            self.prefix_arguments.clone(),
            ClaudeTurnArguments {
                model: model.as_str(),
                effort: *effort,
                role: invocation.role,
                resume_id: input.resume_id,
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
        environment.insert("HOME".to_owned(), runtime_home.to_owned());
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
    ) -> Result<AgentResponse, NodeRunnerError> {
        turn.session
            .core
            .ensure_live(ClosedSessionFailure::SessionLost)?;
        let result = self
            .execute_turn(turn, resume_id.as_deref(), prompt)
            .await?;
        observe_session(resume_id, result.session_id.as_deref())?;
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
        Ok(response)
    }

    async fn execute_turn(
        &self,
        turn: &ClaudeTurn<'_>,
        resume_id: Option<&str>,
        prompt: String,
    ) -> Result<transcript::ClaudeResult, NodeRunnerError> {
        let mut process = self.open_turn_process(turn, resume_id, prompt).await?;
        let mut transcript = ClaudeTranscript::new(redaction_values(
            turn.invocation.environment.iter().map(|(_, value)| value),
        ));
        let collected = collect_transcript(&mut process, &mut transcript, turn.control).await;
        let process_output = if collected.is_ok() {
            process.wait().await
        } else {
            process.release().await
        }
        .map_err(|_| NodeRunnerError::Driver)?;
        validate_process_output(&process_output, turn.control)?;
        collected?;
        transcript.finish()
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

struct ClaudeTurn<'a> {
    invocation: &'a DriverInvocation,
    session: &'a ClaudeSession,
    control: &'a DriverControl,
    deadline: Instant,
}

struct ClaudeCommandInput<'a> {
    resume_id: Option<&'a str>,
    runtime_home: &'a Path,
    prompt: String,
}

struct ClaudeTurnArguments<'a> {
    model: &'a str,
    effort: Option<ReasoningEffort>,
    role: NodeRole,
    resume_id: Option<&'a str>,
    prompt: String,
}

fn claude_arguments(
    mut argv: Vec<String>,
    turn: ClaudeTurnArguments<'_>,
) -> Result<Vec<String>, NodeRunnerError> {
    argv.extend([
        "--print".to_owned(),
        "--input-format".to_owned(),
        "text".to_owned(),
        "--output-format".to_owned(),
        "stream-json".to_owned(),
        "--verbose".to_owned(),
        "--include-partial-messages".to_owned(),
        "--model".to_owned(),
        turn.model.to_owned(),
    ]);
    if let Some(effort) = turn.effort {
        argv.extend(["--effort".to_owned(), effort_token(effort).to_owned()]);
    }
    argv.extend(["--setting-sources".to_owned(), String::new()]);
    match turn.role {
        NodeRole::Worker => argv.push("--dangerously-skip-permissions".to_owned()),
        NodeRole::Verifier => argv.extend([
            "--permission-mode".to_owned(),
            "plan".to_owned(),
            "--tools".to_owned(),
            "Read,Glob,Grep".to_owned(),
        ]),
        NodeRole::GitDelivery => return Err(NodeRunnerError::Driver),
    }
    if let Some(resume_id) = turn.resume_id {
        argv.extend(["--resume".to_owned(), resume_id.to_owned()]);
    }
    argv.push(turn.prompt);
    Ok(argv)
}

fn workspace_access(role: NodeRole) -> Result<WorkspaceAccessMode, NodeRunnerError> {
    match role {
        NodeRole::Verifier => Ok(WorkspaceAccessMode::ReadOnly),
        NodeRole::Worker => Ok(WorkspaceAccessMode::Exclusive),
        NodeRole::GitDelivery => Err(NodeRunnerError::Driver),
    }
}

fn extend_declared_environment(
    environment: &mut BTreeMap<String, String>,
    resolved: &ResolvedEnvironment,
) -> Result<(), NodeRunnerError> {
    for (name, value) in resolved.iter() {
        if value.contains('\0') || environment.contains_key(name.as_str()) {
            return Err(NodeRunnerError::Driver);
        }
        environment.insert(name.as_str().to_owned(), value.to_owned());
    }
    Ok(())
}

fn reject_provider_controls(environment: &BTreeMap<String, String>) -> Result<(), NodeRunnerError> {
    const CONTROLS: [&str; 5] = [
        ANTHROPIC_BASE_URL,
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ];
    CONTROLS
        .iter()
        .all(|name| !environment.contains_key(*name))
        .then_some(())
        .ok_or(NodeRunnerError::Driver)
}

fn configure_openrouter(environment: &mut BTreeMap<String, String>) -> Result<(), NodeRunnerError> {
    let token = environment
        .get(OPENROUTER_KEY)
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or(NodeRunnerError::Driver)?;
    if [ANTHROPIC_TOKEN, ANTHROPIC_KEY]
        .iter()
        .any(|name| environment.contains_key(*name))
    {
        return Err(NodeRunnerError::Driver);
    }
    environment.insert(ANTHROPIC_TOKEN.to_owned(), token);
    environment.insert(ANTHROPIC_KEY.to_owned(), String::new());
    environment.insert(
        ANTHROPIC_BASE_URL.to_owned(),
        OPENROUTER_BASE_URL.to_owned(),
    );
    Ok(())
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
    let value = render_agent_prompt(&invocation.node.input, &invocation.response)?;
    if value.len() > MAX_PROMPT_BYTES || value.contains('\0') {
        return Err(NodeRunnerError::Driver);
    }
    Ok(value)
}

fn validate_model_effort(
    model: &str,
    effort: Option<ReasoningEffort>,
) -> Result<(), NodeRunnerError> {
    match (model, effort) {
        ("claude-haiku-4-5", None) => Ok(()),
        (
            "claude-sonnet-5" | "claude-opus-5" | "claude-fable-5",
            Some(
                ReasoningEffort::Low
                | ReasoningEffort::Medium
                | ReasoningEffort::High
                | ReasoningEffort::Xhigh
                | ReasoningEffort::Max,
            ),
        ) => Ok(()),
        _ => Err(NodeRunnerError::Driver),
    }
}

#[cfg(test)]
#[path = "native_v2_claude/tests.rs"]
mod tests;
