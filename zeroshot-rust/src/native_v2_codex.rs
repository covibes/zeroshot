//! Native-v2 Codex harness for the OpenAI and OpenRouter provider lanes.
//!
//! The graph-wide provider is fixed when the adapter is constructed. Model, effort, session
//! scope, input, and declared environment remain per-node admitted values. Provider sessions are
//! harness-owned runtime state and never enter the durable runner contract.

mod command;
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
use crate::native_v2_capsule::provider_process::{
    ClosedSessionFailure, ProviderFailure, ProviderFailureRetry, ProviderProcessRunners,
    process_scope, redaction_values, validate_process_cleanup, validate_process_output,
};
use crate::native_v2_contract::{CodexProvider, NodeRuntimeBinding};
use crate::native_v2_runner::{
    AgentResponse, AgentResponseState, render_agent_prompt, resolve_agent_response, DriverControl,
    DriverInvocation, LiveOutput, LiveOutputStream, NodeRole, NodeRunnerError, ResolvedEnvironment,
};

use command::{
    add_local_execution_config, add_local_execution_policy, add_node_args, add_provider_args,
    add_resume_command, add_session_target, configure_provider_auth, process_environment,
    provider_model, role_settings,
};
use output::{CodexOutput, CodexOutputDecoder};
use session::CodexSession;

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

    fn add_execution_policy(&self, argv: &mut Vec<String>, sandbox: &str) {
        if self.externally_sandboxed {
            argv.push("--dangerously-bypass-approvals-and-sandbox".to_owned());
            return;
        }
        add_local_execution_policy(argv, sandbox);
    }

    fn add_execution_config(&self, argv: &mut Vec<String>, role: NodeRole) {
        if !self.externally_sandboxed {
            add_local_execution_config(argv, role);
        }
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
        self.add_execution_policy(&mut argv, sandbox);
        add_resume_command(&mut argv, resume);
        add_provider_args(&mut argv, self.config.provider);
        self.add_execution_config(&mut argv, invocation.role);
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
        let prompt = render_agent_prompt(
            invocation.agent_instructions()?,
            &invocation.node.input,
            &invocation.response,
        )?;
        let mut state = CodexRunState::new(invocation, prompt);
        loop {
            if let Some(outcome) = self.advance_run(&turn, &mut state).await? {
                return Ok(outcome);
            }
        }
    }

    async fn advance_run(
        &self,
        turn: &CodexTurn<'_>,
        state: &mut CodexRunState,
    ) -> Result<Option<WorkerOutcome>, NodeRunnerError> {
        match self.advance_turn(turn, state.response.prompt()).await {
            Ok(CodexTurnAdvance::Response(response)) => state.accept_response(turn, response),
            Ok(CodexTurnAdvance::ProviderFailure(detail)) => {
                state.retry_provider_failure(turn, Some(&detail)).await?;
                Ok(None)
            }
            Err(NodeRunnerError::Driver) => {
                state.retry_provider_failure(turn, None).await?;
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    async fn advance_turn(
        &self,
        turn: &CodexTurn<'_>,
        prompt: &str,
    ) -> Result<CodexTurnAdvance, NodeRunnerError> {
        turn.session
            .core
            .ensure_live(ClosedSessionFailure::Driver)?;
        let resume = turn.session.thread_id.lock().await.clone();
        let output = self.execute_turn(turn, resume.as_deref(), prompt).await?;
        record_attempt_thread(turn.session, &output, resume.as_deref()).await?;
        resolve_codex_output(turn, output)
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
        let completion = finish_process(&mut process, output.is_ok()).await;
        turn.control
            .record_token_usage(output.as_ref().ok().and_then(CodexOutput::token_usage))?;
        let completion = completion?;
        validate_process_cleanup(&completion, turn.control)?;
        let output = output?;
        if output.failure_message().is_none() {
            validate_process_output(&completion, turn.control)?;
        }
        Ok(output)
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

struct CodexRunState {
    response: AgentResponseState,
    retry: ProviderFailureRetry,
}

impl CodexRunState {
    fn new(invocation: &DriverInvocation, prompt: String) -> Self {
        let redactions = redaction_values(invocation.environment.iter().map(|(_, value)| value));
        Self {
            retry: ProviderFailureRetry::new("Codex", prompt.clone(), redactions),
            response: AgentResponseState::new(prompt),
        }
    }

    fn accept_response(
        &mut self,
        turn: &CodexTurn<'_>,
        response: AgentResponse,
    ) -> Result<Option<WorkerOutcome>, NodeRunnerError> {
        self.response.accept("Codex", turn.control, response)
    }

    async fn retry_provider_failure(
        &mut self,
        turn: &CodexTurn<'_>,
        detail: Option<&str>,
    ) -> Result<(), NodeRunnerError> {
        let has_session = turn.session.thread_id.lock().await.is_some();
        let prompt = self.retry.after_failure(
            turn.control,
            ProviderFailure {
                detail,
                retryable: true,
                has_session,
                deadline: turn.deadline,
            },
        )?;
        self.response.replace_prompt(prompt);
        Ok(())
    }
}

enum CodexTurnAdvance {
    Response(AgentResponse),
    ProviderFailure(String),
}

async fn record_attempt_thread(
    session: &CodexSession,
    output: &CodexOutput,
    resumed: Option<&str>,
) -> Result<(), NodeRunnerError> {
    if output.thread_id.is_none() && resumed.is_none() {
        return Ok(());
    }
    session
        .record_thread(output.thread_id.as_deref(), resumed)
        .await
}

fn resolve_codex_output(
    turn: &CodexTurn<'_>,
    output: CodexOutput,
) -> Result<CodexTurnAdvance, NodeRunnerError> {
    if let Some(failure) = output.failure_message() {
        return Ok(CodexTurnAdvance::ProviderFailure(failure.to_owned()));
    }
    let response = resolve_agent_response(&turn.invocation.response, output.final_message()?)?;
    if matches!(response, AgentResponse::Correction(_)) {
        turn.control.emit(LiveOutput::new(
            LiveOutputStream::System,
            "Codex final output rejected; requesting correction",
        )?)?;
    }
    Ok(CodexTurnAdvance::Response(response))
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
