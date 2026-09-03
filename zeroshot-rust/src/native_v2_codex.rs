//! Native-v2 Codex harness for the OpenAI and OpenRouter provider lanes.
//!
//! The graph-wide provider is fixed when the adapter is constructed. Model, effort, session
//! scope, input, and declared environment remain per-node admitted values. Provider sessions are
//! harness-owned runtime state and never enter the durable runner contract.

mod command;
mod output;
mod process;
mod schema_file;
#[path = "native_v2_codex/session.rs"]
mod session;
mod turn;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use openengine_cluster_protocol::WorkerOutcome;
use tokio::time::{Duration, Instant};

use crate::execution::driver::WorkspaceCapability;
use crate::execution::process::{
    HostedProcessPool, LocalProcessRunner, ProcessRunnerError, ProcessSessionCommand,
};
use crate::native_v2_capsule::provider_process::{
    ClosedSessionFailure, ProviderFailure, ProviderFailureRetry, ProviderProcessRunners,
    process_scope, redaction_values, with_driver_detail,
};
use crate::native_v2_contract::CodexProvider;
use crate::native_v2_runner::{
    AgentResponse, AgentResponseState, render_agent_prompt, resolve_agent_response_with_dialect,
    DriverControl, DriverInvocation, LiveOutput, LiveOutputStream, NodeRole, NodeRunnerError,
    ProviderSchemaDialect, ResolvedEnvironment,
};

use command::{
    add_local_execution_config, add_local_execution_policy, add_node_args, add_provider_args,
    add_resume_command, add_session_target, agent_selection, configure_provider_auth,
    process_environment, path_text, role_settings,
};
use output::CodexOutput;
use process::{ProcessOpen, exchange_turn, open_process};
use schema_file::CodexSchemaFile;
use session::CodexSession;
use turn::{CodexCommandInput, CodexTurnProcess, CodexTurnProcessOpen};

const PROCESS_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);

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
    ) -> Result<Result<(LocalProcessRunner, PathBuf), ProcessRunnerError>, NodeRunnerError> {
        let scope = process_scope(invocation).map_err(|error| {
            with_driver_detail(error, "Codex process scope requires an agent node role")
        })?;
        Ok(self.runners.turn_process(&self.config.runtime_home, scope))
    }

    fn command(
        &self,
        turn: &CodexTurn<'_>,
        input: CodexCommandInput<'_>,
    ) -> Result<ProcessSessionCommand, NodeRunnerError> {
        let invocation = turn.invocation;
        let (model, effort) = agent_selection(&invocation.node.binding).map_err(|error| {
            with_driver_detail(error, "Codex command requires an agent runtime binding")
        })?;
        let (sandbox, access) = role_settings(invocation.role).map_err(|error| {
            with_driver_detail(error, "Codex workspace policy rejected the node role")
        })?;
        let executable = path_text(&self.config.executable).map_err(|error| {
            with_driver_detail(error, "Codex executable path is not valid on this platform")
        })?;
        let workspace = self.config.workspace.clone();
        let mut argv = vec!["exec".to_owned()];
        self.add_execution_policy(&mut argv, sandbox);
        add_resume_command(&mut argv, input.resume);
        add_provider_args(&mut argv, self.config.provider);
        self.add_execution_config(&mut argv, invocation.role);
        add_node_args(&mut argv, model.as_str(), effort.copied());
        argv.extend([
            "--output-schema".to_owned(),
            path_text(input.schema_path).map_err(|error| {
                with_driver_detail(
                    error,
                    "Codex response schema path is not valid on this platform",
                )
            })?,
        ]);
        add_session_target(&mut argv, input.resume);

        Ok(ProcessSessionCommand {
            program: executable,
            argv,
            environment: self
                .provider_environment(&invocation.environment, input.runtime_home)
                .map_err(|error| {
                    with_driver_detail(error, "Codex provider environment is invalid")
                })?,
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
            Some(local) => (
                path_text(&local.home).map_err(|error| {
                    with_driver_detail(error, "Codex user home is not a valid platform path")
                })?,
                path_text(&local.codex_home).map_err(|error| {
                    with_driver_detail(
                        error,
                        "Codex configuration home is not a valid platform path",
                    )
                })?,
            ),
            None => {
                let runtime_home = path_text(runtime_home).map_err(|error| {
                    with_driver_detail(error, "Codex runtime home is not a valid platform path")
                })?;
                (runtime_home.clone(), runtime_home)
            }
        };
        let mut values = process_environment(
            environment,
            home,
            codex_home,
            self.config.search_path.clone(),
        )
        .map_err(|error| {
            with_driver_detail(
                error,
                "Codex declared environment conflicts with reserved runtime configuration",
            )
        })?;
        for provider_control in ["CODEX_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE"] {
            if values.contains_key(provider_control) {
                return Err(NodeRunnerError::DriverDetail(format!(
                    "Codex declared environment contains provider-owned variable {provider_control}"
                )));
            }
        }
        configure_provider_auth(
            &mut values,
            self.config.provider,
            self.config.local_user.is_some(),
        )
        .map_err(|error| {
            with_driver_detail(
                error,
                "Codex provider credentials are missing or conflict with reserved credentials",
            )
        })?;
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
        )
        .map_err(|error| with_driver_detail(error, "Codex prompt could not be serialized"))?;
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
            Ok(CodexTurnAdvance::Response(response)) => state.accept_response(turn, response).await,
            Ok(CodexTurnAdvance::ProviderFailure(detail)) => {
                state.retry_provider_failure(turn, Some(&detail)).await?;
                Ok(None)
            }
            Err(NodeRunnerError::Driver) => {
                state.retry_provider_failure(turn, None).await?;
                Ok(None)
            }
            Err(NodeRunnerError::DriverDetail(detail)) => {
                state.retry_provider_failure(turn, Some(&detail)).await?;
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
        if let Err(detail) = turn
            .session
            .record_attempt_thread(&output, resume.as_deref())
            .await
        {
            return Ok(CodexTurnAdvance::ProviderFailure(detail.to_owned()));
        }
        resolve_codex_output(turn, output).await
    }

    async fn execute_turn(
        &self,
        turn: &CodexTurn<'_>,
        resume: Option<&str>,
        prompt: &str,
    ) -> Result<CodexOutput, NodeRunnerError> {
        let mut turn_process = match self.open_turn_process(turn, resume).await? {
            CodexTurnProcessOpen::Ready(process) => process,
            CodexTurnProcessOpen::ProviderFailure(detail) => {
                return Ok(CodexOutput::provider_failure(detail));
            }
        };
        let redactions =
            redaction_values(turn.invocation.environment.iter().map(|(_, value)| value));
        exchange_turn(&mut turn_process.process, prompt, turn.control, &redactions).await
    }

    async fn open_turn_process(
        &self,
        turn: &CodexTurn<'_>,
        resume: Option<&str>,
    ) -> Result<CodexTurnProcessOpen, NodeRunnerError> {
        let (runner, runtime_home) = match self.turn_process(turn.invocation)? {
            Ok(resources) => resources,
            Err(error) => {
                return Ok(CodexTurnProcessOpen::ProviderFailure(format!(
                    "provider process setup failed: {error}"
                )));
            }
        };
        let schema = match CodexSchemaFile::create(
            &runtime_home,
            &turn
                .invocation
                .response
                .provider_schema(ProviderSchemaDialect::OpenAiStrict),
        ) {
            Ok(schema) => schema,
            Err(error) => {
                return Ok(CodexTurnProcessOpen::ProviderFailure(error.to_string()));
            }
        };
        let command = self.command(
            turn,
            CodexCommandInput {
                resume,
                runtime_home: &runtime_home,
                schema_path: schema.path(),
            },
        )?;
        let process = match open_process(runner, command, turn.control).await? {
            ProcessOpen::Ready(process) => process,
            ProcessOpen::ProviderFailure(detail) => {
                return Ok(CodexTurnProcessOpen::ProviderFailure(detail));
            }
        };
        Ok(CodexTurnProcessOpen::Ready(CodexTurnProcess {
            process,
            _schema: schema,
        }))
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

    async fn accept_response(
        &mut self,
        turn: &CodexTurn<'_>,
        response: AgentResponse,
    ) -> Result<Option<WorkerOutcome>, NodeRunnerError> {
        self.response.accept("Codex", turn.control, response).await
    }

    async fn retry_provider_failure(
        &mut self,
        turn: &CodexTurn<'_>,
        detail: Option<&str>,
    ) -> Result<(), NodeRunnerError> {
        let has_session = turn.session.thread_id.lock().await.is_some();
        let prompt = self
            .retry
            .after_failure(
                turn.control,
                ProviderFailure {
                    detail,
                    retryable: true,
                    has_session,
                    deadline: turn.deadline,
                },
            )
            .await?;
        self.response.replace_prompt(prompt);
        Ok(())
    }
}

enum CodexTurnAdvance {
    Response(AgentResponse),
    ProviderFailure(String),
}

async fn resolve_codex_output(
    turn: &CodexTurn<'_>,
    output: CodexOutput,
) -> Result<CodexTurnAdvance, NodeRunnerError> {
    if let Some(failure) = output.failure_message() {
        return Ok(CodexTurnAdvance::ProviderFailure(failure.to_owned()));
    }
    let response = resolve_agent_response_with_dialect(
        &turn.invocation.response,
        output.final_message()?,
        ProviderSchemaDialect::OpenAiStrict,
    )?;
    if let Some(diagnostic) = turn
        .session
        .missing_required_thread(turn.invocation, &response)
        .await
    {
        return Ok(CodexTurnAdvance::ProviderFailure(diagnostic.to_owned()));
    }
    if matches!(response, AgentResponse::Correction(_)) {
        turn.control
            .emit(LiveOutput::new(
                LiveOutputStream::System,
                "Codex final output rejected; requesting correction",
            )?)
            .await?;
    }
    Ok(CodexTurnAdvance::Response(response))
}

#[cfg(test)]
mod tests;
