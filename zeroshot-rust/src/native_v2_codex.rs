//! Native-v2 Codex harness for the OpenAI and OpenRouter provider lanes.
//!
//! The graph-wide provider is fixed when the adapter is constructed. Model, effort, session
//! scope, input, and declared environment remain per-node admitted values. Provider sessions are
//! harness-owned runtime state and never enter the durable runner contract.

mod output;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::WorkerOutcome;
use tokio::sync::Mutex;
use tokio::time::{Duration, Instant};

use crate::execution::driver::WorkspaceCapability;
use crate::execution::process::{
    HostedProcessPool, HostedProcessScope, LocalProcessRunner, ProcessFrame, ProcessSession,
    ProcessSessionCommand, ProcessSessionOutput,
};
use crate::execution::{SessionScope, WorkspaceAccessMode};
use crate::native_v2_contract::{CodexProvider, NodeInvocation, NodeRuntimeBinding};
use crate::native_v2_runner::{
    render_agent_prompt, DriverControl, DriverInvocation, LiveOutput, LiveOutputStream, NodeDriver,
    NodeRole, NodeRunnerError, NodeSession, ResolvedEnvironment, SessionFactory,
};

use output::{CodexOutput, CodexOutputDecoder};

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
    /// Explicit executable search path for Codex and commands launched by the agent.
    pub search_path: String,
    pub process_pool: HostedProcessPool,
}

/// One graph-wide Codex/OpenAI-or-OpenRouter adapter.
pub struct NativeV2CodexAdapter {
    config: NativeV2CodexConfig,
    runners: CodexProcessRunners,
}

enum CodexProcessRunners {
    Hosted(HostedProcessPool),
    #[cfg(test)]
    Local,
}

impl NativeV2CodexAdapter {
    #[must_use]
    pub fn new(config: NativeV2CodexConfig) -> Self {
        let process_pool = config.process_pool;
        Self {
            config,
            runners: CodexProcessRunners::Hosted(process_pool),
        }
    }

    #[cfg(test)]
    fn new_for_test(config: NativeV2CodexConfig) -> Self {
        Self {
            config,
            runners: CodexProcessRunners::Local,
        }
    }

    fn turn_process(
        &self,
        invocation: &DriverInvocation,
    ) -> Result<(LocalProcessRunner, PathBuf), NodeRunnerError> {
        let scope = process_scope(invocation)?;
        match self.runners {
            CodexProcessRunners::Hosted(pool) => {
                let identity = pool.identity(scope).map_err(|_| NodeRunnerError::Driver)?;
                let home = identity
                    .prepare_private_home(&self.config.runtime_home)
                    .map_err(|_| NodeRunnerError::Driver)?;
                Ok((identity.runner(), home))
            }
            #[cfg(test)]
            CodexProcessRunners::Local => {
                let home = crate::execution::process::prepare_local_private_home(
                    &self.config.runtime_home,
                    scope,
                )
                .map_err(|_| NodeRunnerError::Driver)?;
                Ok((LocalProcessRunner::new(), home))
            }
        }
    }

    fn command(
        &self,
        invocation: &DriverInvocation,
        resume: Option<&str>,
        runtime_home: &Path,
    ) -> Result<ProcessSessionCommand, NodeRunnerError> {
        let (model, effort) = agent_selection(&invocation.node.binding)?;
        let (sandbox, access) = role_settings(invocation.role)?;
        let executable = path_text(&self.config.executable)?;
        let workspace = self.config.workspace.clone();
        let mut argv = vec!["exec".to_owned()];
        add_provider_args(&mut argv, self.config.provider);
        argv.extend(["--sandbox".to_owned(), sandbox.to_owned()]);
        add_execution_policy(&mut argv, invocation.role);
        add_resume_command(&mut argv, resume);
        add_node_args(&mut argv, model.as_str(), effort.copied());
        add_session_target(&mut argv, resume);

        Ok(ProcessSessionCommand {
            program: executable,
            argv,
            environment: provider_environment(
                &invocation.environment,
                path_text(runtime_home)?,
                self.config.search_path.clone(),
                self.config.provider,
            )?,
            workspace: WorkspaceCapability {
                current_dir: workspace,
                mode: access,
            },
            deadline: Instant::now() + PROCESS_TIMEOUT,
        })
    }

    async fn run_turn(
        &self,
        invocation: &DriverInvocation,
        session: &CodexSession,
        control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        let _turn = session.turn.lock().await;
        ensure_live(session)?;
        let resume = session.thread_id.lock().await.clone();
        let mut process = self
            .open_turn_process(invocation, resume.as_deref(), &control)
            .await?;
        let redactions = redaction_values(&invocation.environment);
        let output = collect_output(&mut process, &control, &redactions).await;
        let completion = finish_process(&mut process, output.is_ok()).await?;
        validate_completion(&completion, &control)?;
        let output = output?;
        session
            .record_thread(output.thread_id.as_deref(), resume.as_deref())
            .await?;
        output.outcome(invocation.role)
    }

    async fn open_turn_process(
        &self,
        invocation: &DriverInvocation,
        resume: Option<&str>,
        control: &DriverControl,
    ) -> Result<ProcessSession, NodeRunnerError> {
        let (runner, runtime_home) = self.turn_process(invocation)?;
        let command = self.command(invocation, resume, &runtime_home)?;
        let prompt = render_agent_prompt(&invocation.node.input, &invocation.response)?;
        let prompt = ProcessFrame::new(prompt.into_bytes()).map_err(|_| NodeRunnerError::Driver)?;
        Self::open_process(runner, command, prompt, control).await
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

#[async_trait]
impl SessionFactory for NativeV2CodexAdapter {
    async fn open(
        &self,
        invocation: &NodeInvocation,
        _environment: &ResolvedEnvironment,
    ) -> Result<Arc<dyn NodeSession>, NodeRunnerError> {
        if !matches!(invocation.binding, NodeRuntimeBinding::Agent { .. }) {
            return Err(NodeRunnerError::SessionOpen);
        }
        Ok(Arc::new(CodexSession::new()))
    }
}

#[async_trait]
impl NodeDriver for NativeV2CodexAdapter {
    async fn run(
        &self,
        invocation: DriverInvocation,
        control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        let session = invocation
            .session
            .as_any()
            .downcast_ref::<CodexSession>()
            .ok_or(NodeRunnerError::Driver)?;
        self.run_turn(&invocation, session, control).await
    }
}

struct CodexSession {
    live: AtomicBool,
    thread_id: Mutex<Option<String>>,
    turn: Mutex<()>,
}

impl CodexSession {
    fn new() -> Self {
        Self {
            live: AtomicBool::new(true),
            thread_id: Mutex::new(None),
            turn: Mutex::new(()),
        }
    }

    async fn record_thread(
        &self,
        observed: Option<&str>,
        resumed: Option<&str>,
    ) -> Result<(), NodeRunnerError> {
        let expected = resumed.or(observed).ok_or(NodeRunnerError::Driver)?;
        if expected.is_empty() || expected.len() > 256 || expected.contains(char::is_control) {
            return Err(NodeRunnerError::Driver);
        }
        if observed.is_some_and(|value| value != expected) {
            return Err(NodeRunnerError::Driver);
        }
        let mut thread_id = self.thread_id.lock().await;
        match thread_id.as_deref() {
            Some(current) if current != expected => Err(NodeRunnerError::Driver),
            Some(_) => Ok(()),
            None => {
                *thread_id = Some(expected.to_owned());
                Ok(())
            }
        }
    }
}

#[async_trait]
impl NodeSession for CodexSession {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    async fn is_live(&self) -> bool {
        self.live.load(Ordering::Acquire)
    }

    async fn close(&self) {
        self.live.store(false, Ordering::Release);
    }
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

fn validate_completion(
    completion: &ProcessSessionOutput,
    control: &DriverControl,
) -> Result<(), NodeRunnerError> {
    if completion.cancelled || control.is_cancelled() {
        return Err(NodeRunnerError::Cancelled);
    }
    if completion.exit_code != Some(0)
        || completion.timed_out
        || !completion.cleanup.proves_tree_empty()
        || completion.post_launch_error.is_some()
    {
        return Err(NodeRunnerError::Driver);
    }
    Ok(())
}

fn process_environment(
    environment: &ResolvedEnvironment,
    runtime_home: String,
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
    values.insert(CODEX_HOME.to_owned(), runtime_home.clone());
    values.insert(HOME.to_owned(), runtime_home);
    values.insert(PATH.to_owned(), search_path);
    Ok(values)
}

fn provider_environment(
    environment: &ResolvedEnvironment,
    runtime_home: String,
    search_path: String,
    provider: CodexProvider,
) -> Result<BTreeMap<String, String>, NodeRunnerError> {
    let mut values = process_environment(environment, runtime_home, search_path)?;
    for provider_control in ["CODEX_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE"] {
        if values.contains_key(provider_control) {
            return Err(NodeRunnerError::Driver);
        }
    }
    if provider == CodexProvider::OpenAi {
        let openai = values.remove(OPENAI_API_KEY);
        if !values.contains_key(CODEX_API_KEY) {
            let value = openai.ok_or(NodeRunnerError::Driver)?;
            values.insert(CODEX_API_KEY.to_owned(), value);
        }
    }
    Ok(values)
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

fn add_execution_policy(argv: &mut Vec<String>, role: NodeRole) {
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

fn add_node_args(
    argv: &mut Vec<String>,
    model: &str,
    effort: Option<crate::worker_catalog::ReasoningEffort>,
) {
    argv.extend(["--json".to_owned(), "--model".to_owned(), model.to_owned()]);
    if let Some(effort) = effort {
        argv.extend([
            "--config".to_owned(),
            format!("model_reasoning_effort=\"{}\"", effort_name(effort)),
        ]);
    }
    argv.extend([
        "--skip-git-repo-check".to_owned(),
        "--ignore-user-config".to_owned(),
        "--ignore-rules".to_owned(),
        "--strict-config".to_owned(),
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

fn process_scope(invocation: &DriverInvocation) -> Result<HostedProcessScope, NodeRunnerError> {
    let NodeRuntimeBinding::Agent { session_scope, .. } = &invocation.node.binding else {
        return Err(NodeRunnerError::Driver);
    };
    let node_instance = invocation.node.reference.node_instance.get();
    let execution = invocation.node.reference.execution.get();
    match (invocation.role, *session_scope) {
        (NodeRole::Worker, SessionScope::NodeInstance) => {
            Ok(HostedProcessScope::WriterNodeInstance(node_instance))
        }
        (NodeRole::Worker, SessionScope::Execution) => {
            Ok(HostedProcessScope::WriterExecution(execution))
        }
        (NodeRole::Verifier, SessionScope::NodeInstance) => {
            Ok(HostedProcessScope::VerifierNodeInstance(node_instance))
        }
        (NodeRole::Verifier, SessionScope::Execution) => {
            Ok(HostedProcessScope::VerifierExecution(execution))
        }
        (NodeRole::GitDelivery, _) => Err(NodeRunnerError::Driver),
    }
}

fn redaction_values(environment: &ResolvedEnvironment) -> Vec<String> {
    let mut values = environment
        .iter()
        .map(|(_, value)| value.to_owned())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    values.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
    values.dedup();
    values
}

fn redact_text(text: &str, redactions: &[String]) -> String {
    redactions.iter().fold(text.to_owned(), |safe, value| {
        safe.replace(value, "[REDACTED]")
    })
}

fn ensure_live(session: &CodexSession) -> Result<(), NodeRunnerError> {
    if session.live.load(Ordering::Acquire) {
        Ok(())
    } else {
        Err(NodeRunnerError::Driver)
    }
}

fn effort_name(effort: crate::worker_catalog::ReasoningEffort) -> &'static str {
    use crate::worker_catalog::ReasoningEffort;

    match effort {
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
        ReasoningEffort::Xhigh => "xhigh",
        ReasoningEffort::Max => "max",
    }
}

fn path_text(path: &Path) -> Result<String, NodeRunnerError> {
    path.to_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or(NodeRunnerError::Driver)
}

#[cfg(test)]
mod tests;
