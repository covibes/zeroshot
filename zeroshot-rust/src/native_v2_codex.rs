//! Native-v2 Codex harness for the OpenAI and OpenRouter provider lanes.
//!
//! The graph-wide provider is fixed when the adapter is constructed. Model, effort, session
//! scope, input, and declared environment remain per-node admitted values. Provider sessions are
//! harness-owned runtime state and never enter the durable runner contract.

mod output;
#[path = "native_v2_codex/session.rs"]
mod session;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use openengine_cluster_protocol::WorkerOutcome;
use tokio::time::{Duration, Instant};

use crate::execution::driver::WorkspaceCapability;
use crate::execution::process::{
    HostedProcessPool, LocalProcessRunner, ProcessFrame, ProcessSession, ProcessSessionCommand,
    ProcessSessionOutput,
};
use crate::execution::WorkspaceAccessMode;
use crate::native_v2_capsule::provider_process::{
    ClosedSessionFailure, ProviderProcessRunners, effort_token, process_scope, redaction_values,
    validate_process_output,
};
use crate::native_v2_contract::{CodexProvider, NodeRuntimeBinding};
use crate::native_v2_runner::{
    AgentResponse, render_agent_prompt, resolve_agent_response, DriverControl, DriverInvocation,
    LiveOutput, LiveOutputStream, NodeRole, NodeRunnerError, ResolvedEnvironment,
};

use output::{CodexOutput, CodexOutputDecoder};
use session::CodexSession;

const CODEX_HOME: &str = "CODEX_HOME";
const CODEX_API_KEY: &str = "CODEX_API_KEY";
const HOME: &str = "HOME";
const OPENAI_API_KEY: &str = "OPENAI_API_KEY";
const PATH: &str = "PATH";
const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
const PROCESS_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);
const MAX_CODEX_STDOUT_BYTES: usize = 8 * 1024 * 1024;

/// Runtime capabilities required to launch Codex. None of these paths are durable run data.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeV2CodexConfig {
    pub provider: CodexProvider,
    pub executable: PathBuf,
    pub workspace: PathBuf,
    pub runtime_home: PathBuf,
    /// Current-user homes are available only to the built-in local target.
    pub local_user: Option<NativeV2CodexUser>,
    /// Explicit executable search path for Codex and commands launched by the agent.
    pub search_path: String,
    pub process_pool: HostedProcessPool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeV2CodexUser {
    pub home: PathBuf,
    pub codex_home: PathBuf,
}

/// One graph-wide Codex/OpenAI-or-OpenRouter adapter.
pub struct NativeV2CodexAdapter {
    config: NativeV2CodexConfig,
    runners: ProviderProcessRunners,
    externally_sandboxed: bool,
}

impl NativeV2CodexAdapter {
    #[must_use]
    pub fn new(mut config: NativeV2CodexConfig) -> Self {
        config.local_user = None;
        let process_pool = config.process_pool;
        Self {
            config,
            runners: ProviderProcessRunners::hosted(process_pool),
            externally_sandboxed: true,
        }
    }

    #[must_use]
    pub fn new_local(config: NativeV2CodexConfig) -> Self {
        Self {
            config,
            runners: ProviderProcessRunners::local(),
            externally_sandboxed: false,
        }
    }

    #[cfg(test)]
    fn new_for_test(config: NativeV2CodexConfig) -> Self {
        Self::new_local(config)
    }

    fn add_execution_policy(&self, argv: &mut Vec<String>, role: NodeRole, sandbox: &str) {
        if self.externally_sandboxed {
            argv.push("--dangerously-bypass-approvals-and-sandbox".to_owned());
            return;
        }
        add_local_execution_policy(argv, role, sandbox);
    }

    fn turn_process(
        &self,
        invocation: &DriverInvocation,
    ) -> Result<(LocalProcessRunner, PathBuf), NodeRunnerError> {
        let scope = process_scope(invocation)?;
        self.runners.turn_process(&self.config.runtime_home, scope)
    }

    fn command(
        &self,
        turn: &CodexTurn<'_>,
        resume: Option<&str>,
        runtime_home: &Path,
    ) -> Result<ProcessSessionCommand, NodeRunnerError> {
        let invocation = turn.invocation;
        let (model, effort) = agent_selection(&invocation.node.binding)?;
        let (sandbox, access) = role_settings(invocation.role)?;
        let executable = path_text(&self.config.executable)?;
        let workspace = self.config.workspace.clone();
        let mut argv = vec!["exec".to_owned()];
        add_provider_args(&mut argv, self.config.provider);
        self.add_execution_policy(&mut argv, invocation.role, sandbox);
        add_resume_command(&mut argv, resume);
        let model = provider_model(self.config.provider, model.as_str());
        add_node_args(&mut argv, &model, effort.copied());
        add_session_target(&mut argv, resume);

        Ok(ProcessSessionCommand {
            program: executable,
            argv,
            environment: self.provider_environment(&invocation.environment, runtime_home)?,
            workspace: WorkspaceCapability {
                current_dir: workspace,
                mode: access,
            },
            deadline: turn.deadline,
        })
    }

    fn provider_environment(
        &self,
        environment: &ResolvedEnvironment,
        runtime_home: &Path,
    ) -> Result<BTreeMap<String, String>, NodeRunnerError> {
        let (home, codex_home) = match &self.config.local_user {
            Some(local) => (path_text(&local.home)?, path_text(&local.codex_home)?),
            None => {
                let runtime_home = path_text(runtime_home)?;
                (runtime_home.clone(), runtime_home)
            }
        };
        let mut values = process_environment(
            environment,
            home,
            codex_home,
            self.config.search_path.clone(),
        )?;
        for provider_control in ["CODEX_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE"] {
            if values.contains_key(provider_control) {
                return Err(NodeRunnerError::Driver);
            }
        }
        configure_provider_auth(
            &mut values,
            self.config.provider,
            self.config.local_user.is_some(),
        )?;
        Ok(values)
    }

    async fn run_turn(
        &self,
        invocation: &DriverInvocation,
        session: &CodexSession,
        control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        let _turn = session.core.turn.lock().await;
        let turn = CodexTurn {
            invocation,
            session,
            control: &control,
            deadline: Instant::now() + PROCESS_TIMEOUT,
        };
        let mut prompt = render_agent_prompt(
            invocation.agent_instructions()?,
            &invocation.node.input,
            &invocation.response,
        )?;
        loop {
            match self.advance_turn(&turn, &prompt).await? {
                AgentResponse::Complete(outcome) => return Ok(outcome),
                AgentResponse::Correction(correction) => prompt = correction,
            }
        }
    }

    async fn advance_turn(
        &self,
        turn: &CodexTurn<'_>,
        prompt: &str,
    ) -> Result<AgentResponse, NodeRunnerError> {
        turn.session
            .core
            .ensure_live(ClosedSessionFailure::Driver)?;
        let resume = turn.session.thread_id.lock().await.clone();
        let output = self.execute_turn(turn, resume.as_deref(), prompt).await?;
        turn.session
            .record_thread(output.thread_id.as_deref(), resume.as_deref())
            .await?;
        let response = resolve_agent_response(&turn.invocation.response, output.final_message()?)?;
        if matches!(response, AgentResponse::Correction(_)) {
            turn.control.emit(LiveOutput::new(
                LiveOutputStream::System,
                "Codex final output rejected; requesting correction",
            )?)?;
        }
        Ok(response)
    }

    async fn execute_turn(
        &self,
        turn: &CodexTurn<'_>,
        resume: Option<&str>,
        prompt: &str,
    ) -> Result<CodexOutput, NodeRunnerError> {
        let mut process = self.open_turn_process(turn, resume, prompt).await?;
        let redactions =
            redaction_values(turn.invocation.environment.iter().map(|(_, value)| value));
        let output = collect_output(&mut process, turn.control, &redactions).await;
        let completion = finish_process(&mut process, output.is_ok()).await?;
        validate_process_output(&completion, turn.control)?;
        output
    }

    async fn open_turn_process(
        &self,
        turn: &CodexTurn<'_>,
        resume: Option<&str>,
        prompt: &str,
    ) -> Result<ProcessSession, NodeRunnerError> {
        let (runner, runtime_home) = self.turn_process(turn.invocation)?;
        let command = self.command(turn, resume, &runtime_home)?;
        let prompt =
            ProcessFrame::new(prompt.as_bytes().to_vec()).map_err(|_| NodeRunnerError::Driver)?;
        Self::open_process(runner, command, prompt, turn.control).await
    }

    async fn open_process(
        runner: LocalProcessRunner,
        command: ProcessSessionCommand,
        prompt: ProcessFrame,
        control: &DriverControl,
    ) -> Result<ProcessSession, NodeRunnerError> {
        let mut process = runner
            .open(command, control.cancellation())
            .await
            .map_err(|_| NodeRunnerError::Driver)?;
        if process.send(prompt).await.is_err() || process.close_stdin().await.is_err() {
            let _ = process.release().await;
            return Err(NodeRunnerError::Driver);
        }
        Ok(process)
    }
}

struct CodexTurn<'a> {
    invocation: &'a DriverInvocation,
    session: &'a CodexSession,
    control: &'a DriverControl,
    deadline: Instant,
}

async fn collect_output(
    process: &mut ProcessSession,
    control: &DriverControl,
    redactions: &[String],
) -> Result<CodexOutput, NodeRunnerError> {
    let mut decoder = CodexOutputDecoder::new();
    let mut total = 0usize;
    while let Some(chunk) = process.recv_stdout().await {
        total = total
            .checked_add(chunk.as_slice().len())
            .ok_or(NodeRunnerError::Driver)?;
        if total > MAX_CODEX_STDOUT_BYTES {
            return Err(NodeRunnerError::Driver);
        }
        for emission in decoder.push(chunk.as_slice())? {
            let (stream, message) = emission.log();
            emit_text(control, stream, message, redactions)?;
        }
    }
    decoder.finish()
}

async fn finish_process(
    process: &mut ProcessSession,
    output_complete: bool,
) -> Result<ProcessSessionOutput, NodeRunnerError> {
    let completion = if output_complete {
        process.wait().await
    } else {
        process.release().await
    };
    completion.map_err(|_| NodeRunnerError::Driver)
}

fn emit_text(
    control: &DriverControl,
    stream: LiveOutputStream,
    text: &str,
    redactions: &[String],
) -> Result<(), NodeRunnerError> {
    let safe = redact_text(text, redactions);
    let mut rest = safe.as_str();
    while !rest.is_empty() {
        let split = if rest.len() <= 8 * 1024 {
            rest.len()
        } else {
            rest.char_indices()
                .map(|(index, _)| index)
                .take_while(|index| *index <= 8 * 1024)
                .last()
                .filter(|index| *index > 0)
                .ok_or(NodeRunnerError::UnsafeOutput)?
        };
        let (part, tail) = rest.split_at(split);
        control.emit(LiveOutput::new(stream, part)?)?;
        rest = tail;
    }
    if text.is_empty() {
        control.emit(LiveOutput::new(stream, "")?)?;
    }
    Ok(())
}

fn process_environment(
    environment: &ResolvedEnvironment,
    home: String,
    codex_home: String,
    search_path: String,
) -> Result<BTreeMap<String, String>, NodeRunnerError> {
    let mut values = environment
        .iter()
        .map(|(name, value)| (name.as_str().to_owned(), value.to_owned()))
        .collect::<BTreeMap<_, _>>();
    if search_path.is_empty() || search_path.contains('\0') {
        return Err(NodeRunnerError::Driver);
    }
    if values.contains_key(CODEX_HOME) || values.contains_key(HOME) || values.contains_key(PATH) {
        return Err(NodeRunnerError::Driver);
    }
    values.insert(CODEX_HOME.to_owned(), codex_home);
    values.insert(HOME.to_owned(), home);
    values.insert(PATH.to_owned(), search_path);
    Ok(values)
}

fn configure_provider_auth(
    values: &mut BTreeMap<String, String>,
    provider: CodexProvider,
    has_local_user: bool,
) -> Result<(), NodeRunnerError> {
    match provider {
        CodexProvider::OpenAi => configure_openai_auth(values, has_local_user),
        CodexProvider::OpenRouter => values
            .get("OPENROUTER_API_KEY")
            .is_some_and(|value| !value.is_empty())
            .then_some(())
            .ok_or(NodeRunnerError::Driver),
    }
}

fn configure_openai_auth(
    values: &mut BTreeMap<String, String>,
    has_local_user: bool,
) -> Result<(), NodeRunnerError> {
    let openai = values.remove(OPENAI_API_KEY);
    if values.contains_key(CODEX_API_KEY) || has_local_user && openai.is_none() {
        return Ok(());
    }
    let value = openai.ok_or(NodeRunnerError::Driver)?;
    values.insert(CODEX_API_KEY.to_owned(), value);
    Ok(())
}

fn add_provider_args(argv: &mut Vec<String>, provider: CodexProvider) {
    argv.extend([
        "--config".to_owned(),
        match provider {
            CodexProvider::OpenAi => "model_provider=\"openai\"".to_owned(),
            CodexProvider::OpenRouter => "model_provider=\"openrouter\"".to_owned(),
        },
    ]);
    if provider == CodexProvider::OpenRouter {
        argv.extend([
            "--config".to_owned(),
            "model_providers.openrouter.name=\"OpenRouter\"".to_owned(),
            "--config".to_owned(),
            format!("model_providers.openrouter.base_url=\"{OPENROUTER_BASE_URL}\""),
            "--config".to_owned(),
            "model_providers.openrouter.env_key=\"OPENROUTER_API_KEY\"".to_owned(),
            "--config".to_owned(),
            "model_providers.openrouter.wire_api=\"responses\"".to_owned(),
        ]);
    }
}

fn add_local_execution_policy(argv: &mut Vec<String>, role: NodeRole, sandbox: &str) {
    argv.extend(["--sandbox".to_owned(), sandbox.to_owned()]);
    argv.extend([
        "--config".to_owned(),
        "approval_policy=\"never\"".to_owned(),
    ]);
    if role == NodeRole::Worker {
        argv.extend([
            "--config".to_owned(),
            "sandbox_workspace_write.network_access=true".to_owned(),
        ]);
    }
}

fn add_resume_command(argv: &mut Vec<String>, resume: Option<&str>) {
    if resume.is_some() {
        argv.push("resume".to_owned());
    }
}
fn provider_model(provider: CodexProvider, model: &str) -> String {
    match provider {
        CodexProvider::OpenAi => model.to_owned(),
        CodexProvider::OpenRouter => format!("openai/{model}"),
    }
}
fn add_node_args(
    argv: &mut Vec<String>,
    model: &str,
    effort: Option<crate::worker_catalog::ReasoningEffort>,
) {
    argv.extend(["--json".to_owned(), "--model".to_owned(), model.to_owned()]);
    if let Some(effort) = effort {
        argv.extend([
            "--config".to_owned(),
            format!("model_reasoning_effort=\"{}\"", effort_token(effort)),
        ]);
    }
    argv.extend([
        "--skip-git-repo-check".to_owned(),
        "--config".to_owned(),
        "web_search=\"disabled\"".to_owned(),
    ]);
}
fn add_session_target(argv: &mut Vec<String>, resume: Option<&str>) {
    if let Some(session_id) = resume {
        argv.push(session_id.to_owned());
    }
    argv.push("-".to_owned());
}

fn agent_selection(
    binding: &NodeRuntimeBinding,
) -> Result<
    (
        &crate::worker_catalog::ModelId,
        Option<&crate::worker_catalog::ReasoningEffort>,
    ),
    NodeRunnerError,
> {
    let NodeRuntimeBinding::Agent { model, effort, .. } = binding else {
        return Err(NodeRunnerError::Driver);
    };
    Ok((model, effort.as_ref()))
}

fn role_settings(role: NodeRole) -> Result<(&'static str, WorkspaceAccessMode), NodeRunnerError> {
    match role {
        NodeRole::Worker => Ok(("workspace-write", WorkspaceAccessMode::Exclusive)),
        NodeRole::Verifier => Ok(("read-only", WorkspaceAccessMode::ReadOnly)),
        NodeRole::GitDelivery => Err(NodeRunnerError::Driver),
    }
}

fn redact_text(text: &str, redactions: &[String]) -> String {
    redactions.iter().fold(text.to_owned(), |safe, value| {
        safe.replace(value, "[REDACTED]")
    })
}

fn path_text(path: &Path) -> Result<String, NodeRunnerError> {
    path.to_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or(NodeRunnerError::Driver)
}

#[cfg(test)]
mod tests;
