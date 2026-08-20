use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::WorkerOutcome;
use tokio::sync::Mutex;

use crate::native_v2_capsule::provider_process::{ProviderSessionCore, impl_provider_node_session};
use crate::native_v2_contract::{NodeInvocation, NodeRuntimeBinding};
use crate::native_v2_runner::{
    DriverControl, DriverInvocation, NodeDriver, NodeRunnerError, NodeSession, ResolvedEnvironment,
    SessionFactory,
};

use super::NativeV2CodexAdapter;

pub(super) struct CodexSession {
    pub(super) core: ProviderSessionCore,
    pub(super) thread_id: Mutex<Option<String>>,
}

impl CodexSession {
    fn new() -> Self {
        Self {
            core: ProviderSessionCore::new(),
            thread_id: Mutex::new(None),
        }
    }

    pub(super) async fn record_thread(
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

impl_provider_node_session!(CodexSession);

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
