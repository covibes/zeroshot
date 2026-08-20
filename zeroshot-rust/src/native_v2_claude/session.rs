use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::WorkerOutcome;
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::execution::SessionScope;
use crate::native_v2_capsule::provider_process::{
    ProviderFailure, ProviderFailureRetry, ProviderSessionCore, impl_provider_node_session,
    redaction_values,
};
use crate::native_v2_contract::{NodeInvocation, NodeRuntimeBinding};
use crate::native_v2_runner::{
    AgentResponse, AgentResponseState, DriverControl, DriverInvocation, NodeDriver,
    NodeRunnerError, NodeSession, ResolvedEnvironment, SessionFactory,
};

use super::{
    ClaudeAdapter, ClaudeTurn, ClaudeTurnAdvance, observe_session, prompt, validate_model_effort,
};

pub(super) struct ClaudeSession {
    pub(super) core: ProviderSessionCore,
    pub(super) resume_id: Mutex<Option<String>>,
}

impl ClaudeSession {
    fn new() -> Self {
        Self {
            core: ProviderSessionCore::new(),
            resume_id: Mutex::new(None),
        }
    }
}

impl_provider_node_session!(ClaudeSession);

#[async_trait]
impl SessionFactory for ClaudeAdapter {
    async fn open(
        &self,
        invocation: &NodeInvocation,
        _environment: &ResolvedEnvironment,
    ) -> Result<Arc<dyn NodeSession>, NodeRunnerError> {
        let NodeRuntimeBinding::Agent { model, effort, .. } = &invocation.binding else {
            return Err(NodeRunnerError::SessionOpen);
        };
        validate_model_effort(model.as_str(), *effort).map_err(|_| NodeRunnerError::SessionOpen)?;
        Ok(Arc::new(ClaudeSession::new()))
    }
}

#[async_trait]
impl NodeDriver for ClaudeAdapter {
    async fn run(
        &self,
        invocation: DriverInvocation,
        control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        let session = invocation
            .session
            .as_any()
            .downcast_ref::<ClaudeSession>()
            .ok_or(NodeRunnerError::Driver)?;
        let _turn = session.core.turn.lock().await;
        let turn = ClaudeTurn {
            invocation: &invocation,
            session,
            control: &control,
            deadline: Instant::now() + self.turn_timeout,
        };
        let mut state = ClaudeRunState::new(&invocation, session).await?;
        loop {
            if let Some(outcome) = self.advance_run(&turn, &mut state, &control).await? {
                retain_session(&invocation.node, session, state.resume_id.as_deref()).await?;
                return Ok(outcome);
            }
        }
    }
}

impl ClaudeAdapter {
    async fn advance_run(
        &self,
        turn: &ClaudeTurn<'_>,
        state: &mut ClaudeRunState,
        control: &DriverControl,
    ) -> Result<Option<WorkerOutcome>, NodeRunnerError> {
        match self
            .advance_turn(
                turn,
                &mut state.resume_id,
                state.response.prompt().to_owned(),
            )
            .await
        {
            Ok(ClaudeTurnAdvance::Response(response)) => state.accept_response(control, response),
            Ok(ClaudeTurnAdvance::ProviderFailure {
                retryable,
                diagnostic,
            }) => {
                state.retry_provider_failure(turn, retryable, &diagnostic)?;
                Ok(None)
            }
            Err(error) => {
                state.emit_terminal_error(control, &error)?;
                Err(error)
            }
        }
    }
}

struct ClaudeRunState {
    resume_id: Option<String>,
    response: AgentResponseState,
    retry: ProviderFailureRetry,
}

impl ClaudeRunState {
    async fn new(
        invocation: &DriverInvocation,
        session: &ClaudeSession,
    ) -> Result<Self, NodeRunnerError> {
        let prompt = prompt(invocation)?;
        let redactions = redaction_values(invocation.environment.iter().map(|(_, value)| value));
        Ok(Self {
            resume_id: session.resume_id.lock().await.clone(),
            retry: ProviderFailureRetry::new("Claude", prompt.clone(), redactions),
            response: AgentResponseState::new(prompt),
        })
    }

    fn accept_response(
        &mut self,
        control: &DriverControl,
        response: AgentResponse,
    ) -> Result<Option<WorkerOutcome>, NodeRunnerError> {
        self.response.accept("Claude", control, response)
    }

    fn retry_provider_failure(
        &mut self,
        turn: &ClaudeTurn<'_>,
        retryable: bool,
        detail: &str,
    ) -> Result<(), NodeRunnerError> {
        let prompt = self.retry.after_failure(
            turn.control,
            ProviderFailure {
                detail: Some(detail),
                retryable,
                has_session: self.resume_id.is_some(),
                deadline: turn.deadline,
            },
        )?;
        self.response.replace_prompt(prompt);
        Ok(())
    }

    fn emit_terminal_error(
        &self,
        control: &DriverControl,
        error: &NodeRunnerError,
    ) -> Result<(), NodeRunnerError> {
        self.retry.report_terminal(control, error)
    }
}

async fn retain_session(
    invocation: &NodeInvocation,
    session: &ClaudeSession,
    observed: Option<&str>,
) -> Result<(), NodeRunnerError> {
    if !matches!(
        invocation.binding,
        NodeRuntimeBinding::Agent {
            session_scope: SessionScope::NodeInstance,
            ..
        }
    ) {
        return Ok(());
    }
    let observed = observed.ok_or(NodeRunnerError::Driver)?;
    let mut retained = session.resume_id.lock().await;
    observe_session(&mut retained, Some(observed))
}
