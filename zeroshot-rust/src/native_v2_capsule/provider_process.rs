//! Shared contained-process mechanics for native-v2 agent harnesses.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Mutex;

use crate::execution::SessionScope;
use crate::execution::process::{
    HostedProcessPool, HostedProcessScope, LocalProcessRunner, ProcessSessionOutput,
};
use crate::native_v2_contract::NodeRuntimeBinding;
use crate::native_v2_runner::{DriverControl, DriverInvocation, NodeRole, NodeRunnerError};
use crate::worker_catalog::ReasoningEffort;

#[derive(Clone, Copy)]
pub(crate) enum ProviderProcessRunners {
    Hosted(HostedProcessPool),
    Local,
}

impl ProviderProcessRunners {
    pub(crate) const fn hosted(pool: HostedProcessPool) -> Self {
        Self::Hosted(pool)
    }

    pub(crate) const fn local() -> Self {
        Self::Local
    }

    pub(crate) fn turn_process(
        self,
        root: &Path,
        scope: HostedProcessScope,
    ) -> Result<(LocalProcessRunner, PathBuf), NodeRunnerError> {
        match self {
            Self::Hosted(pool) => {
                let identity = pool.identity(scope).map_err(|_| NodeRunnerError::Driver)?;
                let home = identity
                    .prepare_private_home(root)
                    .map_err(|_| NodeRunnerError::Driver)?;
                Ok((identity.runner(), home))
            }
            Self::Local => {
                let home = crate::execution::process::prepare_local_private_home(root, scope)
                    .map_err(|_| NodeRunnerError::Driver)?;
                Ok((LocalProcessRunner::new(), home))
            }
        }
    }
}

pub(crate) struct ProviderSessionCore {
    live: AtomicBool,
    pub(crate) turn: Mutex<()>,
}

macro_rules! impl_provider_node_session {
    ($session:ty) => {
        #[async_trait::async_trait]
        impl crate::native_v2_runner::NodeSession for $session {
            fn as_any(&self) -> &dyn std::any::Any {
                self
            }

            async fn is_live(&self) -> bool {
                self.core.is_live()
            }

            async fn close(&self) {
                self.core.close();
            }
        }
    };
}

pub(crate) use impl_provider_node_session;

#[derive(Clone, Copy)]
pub(crate) enum ClosedSessionFailure {
    Driver,
    SessionLost,
}

impl ClosedSessionFailure {
    const fn runner_error(self) -> NodeRunnerError {
        match self {
            Self::Driver => NodeRunnerError::Driver,
            Self::SessionLost => NodeRunnerError::SessionLost,
        }
    }
}

impl ProviderSessionCore {
    pub(crate) fn new() -> Self {
        Self {
            live: AtomicBool::new(true),
            turn: Mutex::new(()),
        }
    }

    pub(crate) fn is_live(&self) -> bool {
        self.live.load(Ordering::Acquire)
    }

    pub(crate) fn close(&self) {
        self.live.store(false, Ordering::Release);
    }

    pub(crate) fn ensure_live(
        &self,
        closed_session: ClosedSessionFailure,
    ) -> Result<(), NodeRunnerError> {
        self.is_live()
            .then_some(())
            .ok_or(closed_session.runner_error())
    }
}

pub(crate) fn process_scope(
    invocation: &DriverInvocation,
) -> Result<HostedProcessScope, NodeRunnerError> {
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

pub(crate) fn validate_process_output(
    output: &ProcessSessionOutput,
    control: &DriverControl,
) -> Result<(), NodeRunnerError> {
    if output.cancelled || control.is_cancelled() {
        return Err(NodeRunnerError::Cancelled);
    }
    if output.exit_code != Some(0)
        || output.timed_out
        || !output.cleanup.proves_tree_empty()
        || output.post_launch_error.is_some()
    {
        return Err(NodeRunnerError::Driver);
    }
    Ok(())
}

pub(crate) fn redaction_values<'a>(values: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut values = values
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    values.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
    values.dedup();
    values
}

pub(crate) const fn effort_token(effort: ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
        ReasoningEffort::Xhigh => "xhigh",
        ReasoningEffort::Max => "max",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_session_failure_maps_to_selected_runner_error() {
        let session = ProviderSessionCore::new();
        session.close();

        assert_eq!(
            session.ensure_live(ClosedSessionFailure::Driver),
            Err(NodeRunnerError::Driver)
        );
        assert_eq!(
            session.ensure_live(ClosedSessionFailure::SessionLost),
            Err(NodeRunnerError::SessionLost)
        );
    }
}
