//! Native-v2 node execution boundary.
//!
//! The runner owns workspace gates, session lifetimes, live output, and durable handoff while
//! provider processes remain behind [`NodeDriver`].

use std::any::Any;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    GraphNode, NodeInstructions, NodeName, RunId, UnixTimestampMillis, WorkerOutcome, WorkerRef,
};
use tokio::sync::{
    broadcast, oneshot, watch, Mutex, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock,
};

use crate::execution::driver::DriverCancellation;
use crate::execution::SessionScope;
use crate::full_v1_reducer::{ExecutionId, NodeInstanceId};
use crate::native_v2_contract::{
    AdmittedRun, EnvironmentVariableName, ExecutionRef, NodeCompletion, NodeInvocation,
    NodeRuntimeBinding, TokenUsageDelta,
};

const LIVE_OUTPUT_CAPACITY: usize = 256;
const MAX_LIVE_OUTPUT_BYTES: usize = 16 * 1024;
pub(crate) const DURABLE_OUTPUT_CAPACITY: usize = 1024;

mod handle;
mod output;
mod remote;
mod response;

pub use handle::NodeHandle;
pub use output::{AttachReceiveError, DurableOutput, LiveOutputSource, ReadOnlyAttach};
use output::{DurableEventSender, durable_event_channel, durable_output_event};
pub use response::{render_agent_prompt, NodeResponseContract};
pub(crate) use response::ProviderSchemaDialect;
pub(crate) use response::{
    AgentResponse, AgentResponseState, resolve_agent_response, resolve_agent_response_with_dialect,
};
pub(crate) use remote::{RemoteNodeHandleBridge, remote_node_handle};

mod plan;
pub use plan::NodeRole;
use plan::NodeRolePlan;
mod workspace;
pub use workspace::{EnvironmentResolutionError, ResolvedEnvironment, WorkspaceAccess, WorkspaceGate};
#[derive(Clone, Debug)]
pub struct NodeRunRequest {
    pub invocation: NodeInvocation,
    pub environment: ResolvedEnvironment,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveOutputStream {
    Output,
    Error,
    System,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveOutput {
    pub stream: LiveOutputStream,
    pub text: String,
}

impl LiveOutput {
    pub fn new(stream: LiveOutputStream, text: impl Into<String>) -> Result<Self, NodeRunnerError> {
        let text = text.into();
        if text.len() > MAX_LIVE_OUTPUT_BYTES || text.contains('\0') {
            return Err(NodeRunnerError::UnsafeOutput);
        }
        Ok(Self { stream, text })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DurableNodeEvent {
    Output {
        output: LiveOutput,
        timestamp: UnixTimestampMillis,
    },
    TokenUsage(Option<TokenUsageDelta>),
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum NodeRunnerError {
    #[error("node role does not match its admitted runtime binding")]
    InvalidRole,
    #[error("node session could not be opened")]
    SessionOpen,
    #[error("a reusable node session was lost and cannot be replaced")]
    SessionLost,
    #[error("node execution failed")]
    Driver,
    #[error("node execution failed: {0}")]
    DriverDetail(String),
    #[error("the remote node runtime connection was lost")]
    ConnectionLost,
    #[error("node execution was cancelled")]
    Cancelled,
    #[error("live output was not safe to publish")]
    UnsafeOutput,
    #[error("durable output bridge closed before node completion")]
    DurableOutputClosed,
    #[error("node completion channel closed")]
    CompletionClosed,
    #[error("run is already closed")]
    RunClosed,
    #[error("node execution is already active")]
    ExecutionActive,
}

#[async_trait]
pub trait NodeSession: Any + Send + Sync {
    fn as_any(&self) -> &dyn Any;
    async fn is_live(&self) -> bool;
    async fn close(&self);
}

#[async_trait]
pub trait SessionFactory: Send + Sync {
    async fn open(
        &self,
        invocation: &NodeInvocation,
        environment: &ResolvedEnvironment,
    ) -> Result<Arc<dyn NodeSession>, NodeRunnerError>;
}

#[derive(Clone)]
pub struct DriverInvocation {
    pub node: NodeInvocation,
    pub role: NodeRole,
    pub response: NodeResponseContract,
    pub environment: ResolvedEnvironment,
    pub session: Arc<dyn NodeSession>,
}

impl DriverInvocation {
    pub(crate) fn agent_instructions(&self) -> Result<&NodeInstructions, NodeRunnerError> {
        if !matches!(&self.node.binding, NodeRuntimeBinding::Agent { .. }) {
            return Err(NodeRunnerError::InvalidRole);
        }
        self.node
            .instructions
            .as_ref()
            .ok_or(NodeRunnerError::InvalidRole)
    }
}

#[derive(Clone)]
pub struct DriverControl {
    cancellation: watch::Receiver<bool>,
    live_output: broadcast::Sender<LiveOutput>,
    durable_output: DurableEventSender,
}

impl DriverControl {
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        *self.cancellation.borrow()
    }

    pub async fn cancelled(&mut self) {
        while !*self.cancellation.borrow_and_update() {
            if self.cancellation.changed().await.is_err() {
                return;
            }
        }
    }

    #[must_use]
    pub fn cancellation(&self) -> DriverCancellation {
        DriverCancellation::new(self.cancellation.clone())
    }

    pub async fn emit(&self, output: LiveOutput) -> Result<(), NodeRunnerError> {
        self.send_durable(durable_output_event(output.clone()))
            .await?;
        let _ = self.live_output.send(output);
        Ok(())
    }

    pub async fn record_token_usage(
        &self,
        usage: Option<TokenUsageDelta>,
    ) -> Result<(), NodeRunnerError> {
        self.durable_output
            .send_terminal(
                DurableNodeEvent::TokenUsage(usage),
                self.cancellation.clone(),
            )
            .await
    }

    async fn send_durable(&self, event: DurableNodeEvent) -> Result<(), NodeRunnerError> {
        self.durable_output
            .send(event, self.cancellation.clone())
            .await
    }
}

#[async_trait]
pub trait NodeDriver: Send + Sync {
    /// Runs until the provider has completed or consumed cancellation and finished process cleanup.
    async fn run(
        &self,
        invocation: DriverInvocation,
        control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError>;
}

#[async_trait]
pub trait NodeRunner: Send + Sync {
    async fn start(&self, request: NodeRunRequest) -> Result<NodeHandle, NodeRunnerError>;
    async fn close_run(&self, run_id: &RunId);
}

#[derive(Clone)]
pub struct NativeNodeRunner {
    driver: Arc<dyn NodeDriver>,
    sessions: SessionPool,
    workspace: WorkspaceGate,
    roles: NodeRolePlan,
    activity: ActivityRegistry,
}

impl NativeNodeRunner {
    pub fn new(
        admitted: &AdmittedRun,
        driver: Arc<dyn NodeDriver>,
        sessions: Arc<dyn SessionFactory>,
    ) -> Result<Self, NodeRunnerError> {
        Ok(Self {
            driver,
            sessions: SessionPool::new(sessions),
            workspace: WorkspaceGate::new(),
            roles: NodeRolePlan::from_admitted(admitted)?,
            activity: ActivityRegistry::default(),
        })
    }
}

#[async_trait]
impl NodeRunner for NativeNodeRunner {
    async fn start(&self, request: NodeRunRequest) -> Result<NodeHandle, NodeRunnerError> {
        let plan = self.roles.resolve(&request.invocation)?;
        let reference = request.invocation.reference.clone();
        let (cancel_sender, cancel_receiver) = watch::channel(false);
        let (output_sender, _) = broadcast::channel(LIVE_OUTPUT_CAPACITY);
        let (durable_output_sender, durable_output) = durable_event_channel();
        let (completion_sender, completion_receiver) = oneshot::channel();
        let activity = self
            .activity
            .register(&reference, cancel_sender.clone())
            .await?;
        let runtime = RunnerTaskRuntime {
            driver: self.driver.clone(),
            sessions: self.sessions.clone(),
            workspace: self.workspace.clone(),
        };
        let task_output = output_sender.clone();

        tokio::spawn(async move {
            let task = RunnerTask {
                request,
                role: plan.role,
                response: plan.response,
                cancellation: cancel_receiver,
                output: task_output,
                durable_output: durable_output_sender,
                activity: &activity,
            };
            let result = execute(runtime, task).await;
            activity.finish().await;
            let _ = completion_sender.send(result);
        });

        Ok(NodeHandle {
            reference,
            cancel: cancel_sender,
            output: Some(output_sender),
            initial_output: Some(durable_output),
            completion: Some(completion_receiver),
            cancel_on_drop: true,
        })
    }

    async fn close_run(&self, run_id: &RunId) {
        let completions = self.activity.begin_close(run_id).await;
        self.sessions.close_run(run_id).await;
        for mut completion in completions {
            while !*completion.borrow_and_update() {
                if completion.changed().await.is_err() {
                    break;
                }
            }
        }
    }
}

struct RunnerTaskRuntime {
    driver: Arc<dyn NodeDriver>,
    sessions: SessionPool,
    workspace: WorkspaceGate,
}

struct RunnerTask<'a> {
    request: NodeRunRequest,
    role: NodeRole,
    response: NodeResponseContract,
    cancellation: watch::Receiver<bool>,
    output: broadcast::Sender<LiveOutput>,
    durable_output: DurableEventSender,
    activity: &'a ActivityToken,
}

async fn execute(
    runtime: RunnerTaskRuntime,
    mut task: RunnerTask<'_>,
) -> Result<NodeCompletion, NodeRunnerError> {
    let _workspace = tokio::select! {
        biased;
        _ = wait_for_cancellation(&mut task.cancellation) => {
            return Err(NodeRunnerError::Cancelled)
        },
        permit = runtime.workspace.acquire(task.role.workspace_access()) => permit,
    };
    let lease = match runtime
        .sessions
        .checkout(
            &task.request.invocation,
            &task.request.environment,
            &mut task.cancellation,
        )
        .await
    {
        Ok(lease) => lease,
        Err(error) => return Err(error),
    };
    if task
        .activity
        .bind_session(lease.session.clone())
        .await
        .is_err()
    {
        lease.finish(false).await;
        return Err(NodeRunnerError::Cancelled);
    }
    let response = task.response;
    let driver_invocation = DriverInvocation {
        node: task.request.invocation.clone(),
        role: task.role,
        response: response.clone(),
        environment: task.request.environment,
        session: lease.session.inner(),
    };
    let control = DriverControl {
        cancellation: task.cancellation.clone(),
        live_output: task.output,
        durable_output: task.durable_output,
    };
    let driver_result = runtime.driver.run(driver_invocation, control).await;
    match driver_result {
        Ok(outcome) => {
            if response.validate_outcome(&outcome).is_err() {
                lease.finish(false).await;
                return Err(NodeRunnerError::Driver);
            }
            lease.finish(true).await;
            Ok(NodeCompletion {
                reference: task.request.invocation.reference,
                outcome,
            })
        }
        Err(error) => {
            lease.finish(false).await;
            Err(error)
        }
    }
}

async fn wait_for_cancellation(receiver: &mut watch::Receiver<bool>) {
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

fn session_scope(binding: &NodeRuntimeBinding) -> Result<SessionScope, NodeRunnerError> {
    match binding {
        NodeRuntimeBinding::Agent { session_scope, .. } => Ok(*session_scope),
        NodeRuntimeBinding::GitDelivery { .. } => Ok(SessionScope::Execution),
    }
}

mod state;
use state::*;
#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
#[path = "native_v2_runner/tests.rs"]
mod tests;
