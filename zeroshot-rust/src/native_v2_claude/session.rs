use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::WorkerOutcome;
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::execution::SessionScope;
use crate::native_v2_capsule::provider_process::{ProviderSessionCore, impl_provider_node_session};
use crate::native_v2_contract::{NodeInvocation, NodeRuntimeBinding};
use crate::native_v2_runner::{
    AgentResponse, DriverControl, DriverInvocation, NodeDriver, NodeRunnerError, NodeSession,
    ResolvedEnvironment, SessionFactory,
};

use super::{ClaudeAdapter, ClaudeTurn, observe_session, prompt, validate_model_effort};

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
        let mut resume_id = session.resume_id.lock().await.clone();
        let mut turn_prompt = prompt(&invocation)?;
        loop {
            match self
                .advance_turn(&turn, &mut resume_id, turn_prompt)
                .await?
            {
                AgentResponse::Complete(outcome) => {
                    retain_session(&invocation.node, session, resume_id.as_deref()).await?;
                    return Ok(outcome);
                }
                AgentResponse::Correction(correction) => turn_prompt = correction,
            }
        }
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
