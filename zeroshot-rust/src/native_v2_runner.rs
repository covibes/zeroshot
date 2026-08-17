//! Native-v2 node execution boundary.
//!
//! The runner owns only three cross-cutting runtime rules: one shared-workspace gate, exact
//! session lifetime, and a read-only live output stream. Provider processes remain behind
//! [`NodeDriver`], while durable observation remains in the run ledger.

use std::any::Any;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{GraphNode, NodeName, RunId, WorkerOutcome, WorkerRef};
use tokio::sync::{
    broadcast, mpsc, oneshot, watch, Mutex, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock,
};

use crate::execution::driver::DriverCancellation;
use crate::execution::SessionScope;
use crate::native_v2_contract::{
    AdmittedRun, EnvironmentVariableName, ExecutionId, ExecutionRef, NodeCompletion,
    NodeInstanceId, NodeInvocation, NodeRuntimeBinding,
};

const LIVE_OUTPUT_CAPACITY: usize = 256;
const MAX_LIVE_OUTPUT_BYTES: usize = 16 * 1024;

mod response;

pub use response::{render_agent_prompt, NodeResponseContract};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NodeRole {
    Worker,
    Verifier,
    GitDelivery,
}

struct ResolvedNodePlan {
    role: NodeRole,
    response: NodeResponseContract,
}

impl NodeRole {
    const fn workspace_access(self) -> WorkspaceAccess {
        match self {
            Self::Verifier => WorkspaceAccess::ReadOnly,
            Self::Worker | Self::GitDelivery => WorkspaceAccess::Exclusive,
        }
    }
}

#[derive(Clone, Debug)]
struct PlannedNode {
    worker: WorkerRef,
    binding: NodeRuntimeBinding,
    role: NodeRole,
    response: NodeResponseContract,
}

/// Immutable authority for execution role and runtime binding, derived from admitted input.
#[derive(Clone, Debug)]
struct NodeRolePlan {
    nodes: Arc<BTreeMap<NodeName, PlannedNode>>,
}

impl NodeRolePlan {
    fn from_admitted(admitted: &AdmittedRun) -> Result<Self, NodeRunnerError> {
        let mut nodes = BTreeMap::new();
        collect_planned_nodes(&admitted.graph.root, admitted.runtime.nodes(), &mut nodes)?;
        if nodes.len() != admitted.runtime.nodes().len() {
            return Err(NodeRunnerError::InvalidRole);
        }
        Ok(Self {
            nodes: Arc::new(nodes),
        })
    }

    fn resolve(&self, invocation: &NodeInvocation) -> Result<ResolvedNodePlan, NodeRunnerError> {
        let planned = self
            .nodes
            .get(&invocation.reference.node)
            .ok_or(NodeRunnerError::InvalidRole)?;
        if planned.worker != invocation.worker || planned.binding != invocation.binding {
            return Err(NodeRunnerError::InvalidRole);
        }
        Ok(ResolvedNodePlan {
            role: planned.role,
            response: planned.response.clone(),
        })
    }
}

fn collect_planned_nodes(
    node: &GraphNode,
    bindings: &BTreeMap<NodeName, NodeRuntimeBinding>,
    nodes: &mut BTreeMap<NodeName, PlannedNode>,
) -> Result<(), NodeRunnerError> {
    if let Some((name, worker, binding, role, response)) = planned_executable(node, bindings)? {
        if nodes
            .insert(
                name.clone(),
                PlannedNode {
                    worker: worker.clone(),
                    binding: binding.clone(),
                    role,
                    response,
                },
            )
            .is_some()
        {
            return Err(NodeRunnerError::InvalidRole);
        }
    }
    for child in child_nodes(node) {
        collect_planned_nodes(child, bindings, nodes)?;
    }
    Ok(())
}

type PlannedExecutable<'a> = (
    &'a NodeName,
    &'a WorkerRef,
    &'a NodeRuntimeBinding,
    NodeRole,
    NodeResponseContract,
);

fn planned_executable<'a>(
    node: &'a GraphNode,
    bindings: &'a BTreeMap<NodeName, NodeRuntimeBinding>,
) -> Result<Option<PlannedExecutable<'a>>, NodeRunnerError> {
    match node {
        GraphNode::Step(step) => {
            let binding = bindings
                .get(&step.name)
                .ok_or(NodeRunnerError::InvalidRole)?;
            if !matches!(binding, NodeRuntimeBinding::Agent { .. }) {
                return Err(NodeRunnerError::InvalidRole);
            }
            Ok(Some((
                &step.name,
                &step.worker,
                binding,
                NodeRole::Worker,
                NodeResponseContract::Worker {
                    output: step.output.clone(),
                },
            )))
        }
        GraphNode::Verifier(verifier) => {
            let binding = bindings
                .get(&verifier.name)
                .ok_or(NodeRunnerError::InvalidRole)?;
            let role = match binding {
                NodeRuntimeBinding::Agent { .. } => NodeRole::Verifier,
                NodeRuntimeBinding::GitDelivery { .. } => NodeRole::GitDelivery,
            };
            Ok(Some((
                &verifier.name,
                &verifier.worker,
                binding,
                role,
                NodeResponseContract::Verifier {
                    output: verifier.output.clone(),
                    signals: verifier.signals.clone(),
                    diagnostic: verifier.diagnostic.clone(),
                },
            )))
        }
        _ => Ok(None),
    }
}

fn child_nodes(node: &GraphNode) -> Vec<&GraphNode> {
    match node {
        GraphNode::Seq(group) => group.children.as_slice().iter().collect(),
        GraphNode::Choice(group) => {
            let mut children = group
                .branches
                .as_slice()
                .iter()
                .map(|branch| &branch.node)
                .collect::<Vec<_>>();
            if let Some(otherwise) = &group.otherwise {
                children.push(otherwise);
            }
            children
        }
        GraphNode::Par(group) => group.branches.as_slice().iter().collect(),
        GraphNode::Loop(group) => vec![&group.body],
        GraphNode::Map(group) => vec![&group.body],
        GraphNode::Step(_)
        | GraphNode::Verifier(_)
        | GraphNode::Succeed(_)
        | GraphNode::Fail(_) => Vec::new(),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceAccess {
    ReadOnly,
    Exclusive,
}

/// One run-local gate around its single shared workspace.
#[derive(Clone, Debug, Default)]
pub struct WorkspaceGate {
    inner: Arc<RwLock<()>>,
}

impl WorkspaceGate {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    async fn acquire(&self, access: WorkspaceAccess) -> WorkspacePermit {
        match access {
            WorkspaceAccess::ReadOnly => WorkspacePermit::Read {
                _guard: self.inner.clone().read_owned().await,
            },
            WorkspaceAccess::Exclusive => WorkspacePermit::Write {
                _guard: self.inner.clone().write_owned().await,
            },
        }
    }
}

enum WorkspacePermit {
    Read { _guard: OwnedRwLockReadGuard<()> },
    Write { _guard: OwnedRwLockWriteGuard<()> },
}

/// Runtime-only environment values. Debug output exposes names, never values.
#[derive(Clone)]
pub struct ResolvedEnvironment {
    values: Arc<BTreeMap<EnvironmentVariableName, String>>,
}

impl ResolvedEnvironment {
    pub fn exact(
        binding: &NodeRuntimeBinding,
        values: BTreeMap<EnvironmentVariableName, String>,
    ) -> Result<Self, EnvironmentResolutionError> {
        let declared = binding.declared_environment();
        if let Some(name) = declared.iter().find(|name| !values.contains_key(*name)) {
            return Err(EnvironmentResolutionError::Missing(name.clone()));
        }
        if let Some(name) = values.keys().find(|name| !declared.contains(*name)) {
            return Err(EnvironmentResolutionError::Undeclared(name.clone()));
        }
        Ok(Self {
            values: Arc::new(values),
        })
    }

    #[must_use]
    pub fn get(&self, name: &EnvironmentVariableName) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&EnvironmentVariableName, &str)> {
        self.values
            .iter()
            .map(|(name, value)| (name, value.as_str()))
    }
}

impl fmt::Debug for ResolvedEnvironment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedEnvironment")
            .field("names", &self.values.keys().collect::<Vec<_>>())
            .field("values", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum EnvironmentResolutionError {
    #[error("declared environment variable {0} was not resolved")]
    Missing(EnvironmentVariableName),
    #[error("environment variable {0} was not declared by the node")]
    Undeclared(EnvironmentVariableName),
}

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

#[derive(Clone)]
pub struct DriverControl {
    cancellation: watch::Receiver<bool>,
    live_output: broadcast::Sender<LiveOutput>,
    durable_output: mpsc::UnboundedSender<LiveOutput>,
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

    pub fn emit(&self, output: LiveOutput) -> Result<(), NodeRunnerError> {
        self.durable_output
            .send(output.clone())
            .map_err(|_| NodeRunnerError::DurableOutputClosed)?;
        let _ = self.live_output.send(output);
        Ok(())
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
        let (durable_output_sender, durable_output_receiver) = mpsc::unbounded_channel();
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
            initial_output: Some(DurableOutput {
                receiver: durable_output_receiver,
            }),
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
    durable_output: mpsc::UnboundedSender<LiveOutput>,
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

pub struct NodeHandle {
    reference: ExecutionRef,
    cancel: watch::Sender<bool>,
    output: Option<broadcast::Sender<LiveOutput>>,
    initial_output: Option<DurableOutput>,
    completion: Option<oneshot::Receiver<Result<NodeCompletion, NodeRunnerError>>>,
    cancel_on_drop: bool,
}

impl NodeHandle {
    #[must_use]
    pub fn reference(&self) -> &ExecutionRef {
        &self.reference
    }

    pub fn cancel(&self) {
        let _ = self.cancel.send(true);
    }

    #[must_use]
    pub fn attach(&self) -> ReadOnlyAttach {
        self.live_output_source()
            .map_or_else(closed_live_attach, |source| source.subscribe())
    }

    /// Returns read-only subscription authority for an active execution.
    #[must_use]
    pub fn live_output_source(&self) -> Option<LiveOutputSource> {
        self.output.as_ref().map(|output| LiveOutputSource {
            output: output.clone(),
        })
    }

    /// Takes the receiver established before execution starts for durable log bridging.
    pub fn take_initial_output(&mut self) -> Option<DurableOutput> {
        self.initial_output.take()
    }

    /// Waits for completion without consuming the handle.
    ///
    /// Cancelling this wait leaves the receiver intact so a supervisor can signal cancellation
    /// and then wait again for the driver's cleanup acknowledgement.
    pub async fn completion(&mut self) -> Result<NodeCompletion, NodeRunnerError> {
        let result = self
            .completion
            .as_mut()
            .ok_or(NodeRunnerError::CompletionClosed)?
            .await
            .map_err(|_| NodeRunnerError::CompletionClosed)?;
        self.completion.take();
        self.output.take();
        self.cancel_on_drop = false;
        result
    }
}

impl Drop for NodeHandle {
    fn drop(&mut self) {
        if self.cancel_on_drop {
            let _ = self.cancel.send(true);
        }
    }
}

pub struct ReadOnlyAttach {
    receiver: broadcast::Receiver<LiveOutput>,
}

#[derive(Clone)]
pub struct LiveOutputSource {
    output: broadcast::Sender<LiveOutput>,
}

impl LiveOutputSource {
    #[must_use]
    pub fn subscribe(&self) -> ReadOnlyAttach {
        ReadOnlyAttach {
            receiver: self.output.subscribe(),
        }
    }
}

fn closed_live_attach() -> ReadOnlyAttach {
    let (output, receiver) = broadcast::channel(1);
    drop(output);
    ReadOnlyAttach { receiver }
}

/// Lossless run-local bridge into the durable log writer.
///
/// Harnesses bound the total provider output accepted for one execution, so this queue remains
/// bounded by that harness cap without blocking provider process cleanup.
pub struct DurableOutput {
    receiver: mpsc::UnboundedReceiver<LiveOutput>,
}

impl DurableOutput {
    pub async fn recv(&mut self) -> Result<LiveOutput, AttachReceiveError> {
        self.receiver.recv().await.ok_or(AttachReceiveError::Closed)
    }
}

impl ReadOnlyAttach {
    pub async fn recv(&mut self) -> Result<LiveOutput, AttachReceiveError> {
        self.receiver.recv().await.map_err(|error| match error {
            broadcast::error::RecvError::Closed => AttachReceiveError::Closed,
            broadcast::error::RecvError::Lagged(_) => AttachReceiveError::Lagged,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AttachReceiveError {
    #[error("node output stream closed")]
    Closed,
    #[error("live attachment fell behind; reconnect through durable logs")]
    Lagged,
}

#[derive(Clone, Default)]
struct ActivityRegistry {
    state: Arc<Mutex<ActivityState>>,
}

#[derive(Default)]
struct ActivityState {
    active: BTreeMap<ActiveKey, ActiveInvocation>,
    closed_runs: BTreeSet<RunId>,
}

struct ActiveInvocation {
    cancel: watch::Sender<bool>,
    session: Option<ManagedSession>,
    done: watch::Sender<bool>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ActiveKey {
    run_id: RunId,
    execution: ExecutionId,
}

struct ActivityToken {
    registry: ActivityRegistry,
    key: ActiveKey,
}

impl ActivityRegistry {
    async fn register(
        &self,
        reference: &ExecutionRef,
        cancel: watch::Sender<bool>,
    ) -> Result<ActivityToken, NodeRunnerError> {
        let key = ActiveKey {
            run_id: reference.run_id.clone(),
            execution: reference.execution,
        };
        let (done, _) = watch::channel(false);
        let mut state = self.state.lock().await;
        if state.closed_runs.contains(&key.run_id) {
            return Err(NodeRunnerError::RunClosed);
        }
        match state.active.entry(key.clone()) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(ActiveInvocation {
                    cancel,
                    session: None,
                    done,
                });
            }
            std::collections::btree_map::Entry::Occupied(_) => {
                return Err(NodeRunnerError::ExecutionActive);
            }
        }
        Ok(ActivityToken {
            registry: self.clone(),
            key,
        })
    }

    async fn begin_close(&self, run_id: &RunId) -> Vec<watch::Receiver<bool>> {
        let targets = {
            let mut state = self.state.lock().await;
            state.closed_runs.insert(run_id.clone());
            state
                .active
                .iter()
                .filter(|(key, _)| key.run_id == *run_id)
                .map(|(_, active)| {
                    (
                        active.cancel.clone(),
                        active.session.clone(),
                        active.done.subscribe(),
                    )
                })
                .collect::<Vec<_>>()
        };
        for (cancel, _, _) in &targets {
            let _ = cancel.send(true);
        }
        for (_, session, _) in &targets {
            if let Some(session) = session {
                session.close().await;
            }
        }
        targets.into_iter().map(|(_, _, done)| done).collect()
    }
}

impl ActivityToken {
    async fn bind_session(&self, session: ManagedSession) -> Result<(), NodeRunnerError> {
        let mut state = self.registry.state.lock().await;
        if state.closed_runs.contains(&self.key.run_id) {
            return Err(NodeRunnerError::RunClosed);
        }
        let active = state
            .active
            .get_mut(&self.key)
            .ok_or(NodeRunnerError::Cancelled)?;
        active.session = Some(session);
        Ok(())
    }

    async fn finish(self) {
        let active = self.registry.state.lock().await.active.remove(&self.key);
        if let Some(active) = active {
            let _ = active.done.send(true);
        }
    }
}

#[derive(Clone)]
struct ManagedSession {
    inner: Arc<dyn NodeSession>,
    closed: Arc<AtomicBool>,
}

impl ManagedSession {
    fn new(inner: Arc<dyn NodeSession>) -> Self {
        Self {
            inner,
            closed: Arc::new(AtomicBool::new(false)),
        }
    }

    fn inner(&self) -> Arc<dyn NodeSession> {
        self.inner.clone()
    }

    async fn is_live(&self) -> bool {
        !self.closed.load(Ordering::SeqCst) && self.inner.is_live().await
    }

    async fn close(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            self.inner.close().await;
        }
    }

    fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.closed, &other.closed)
    }
}

#[derive(Clone)]
struct SessionPool {
    factory: Arc<dyn SessionFactory>,
    entries: Arc<Mutex<BTreeMap<SessionKey, SessionEntry>>>,
}

impl SessionPool {
    fn new(factory: Arc<dyn SessionFactory>) -> Self {
        Self {
            factory,
            entries: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    async fn checkout(
        &self,
        invocation: &NodeInvocation,
        environment: &ResolvedEnvironment,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<SessionLease, NodeRunnerError> {
        let scope = session_scope(&invocation.binding)?;
        if scope == SessionScope::Execution {
            let session = self
                .open_session(invocation, environment, cancellation)
                .await?;
            return Ok(SessionLease {
                session,
                pool: self.clone(),
                kind: SessionLeaseKind::Execution,
            });
        }

        let key = SessionKey {
            run_id: invocation.reference.run_id.clone(),
            node_instance: invocation.reference.node_instance,
        };
        loop {
            match self.checkout_action(&key).await? {
                CheckoutAction::Reuse(session) => {
                    return self.reuse(key, session, cancellation).await;
                }
                CheckoutAction::Wait(mut ready) => {
                    wait_for_open(&mut ready, cancellation).await?;
                }
                CheckoutAction::Open(ready) => {
                    let opened = self
                        .open_session(invocation, environment, cancellation)
                        .await;
                    return self.finish_open(key, ready, opened).await;
                }
            }
        }
    }

    async fn checkout_action(&self, key: &SessionKey) -> Result<CheckoutAction, NodeRunnerError> {
        let mut entries = self.entries.lock().await;
        match entries.get(key) {
            Some(SessionEntry::Lost) => Err(NodeRunnerError::SessionLost),
            Some(SessionEntry::Live(session)) => Ok(CheckoutAction::Reuse(session.clone())),
            Some(SessionEntry::Opening(ready)) => Ok(CheckoutAction::Wait(ready.subscribe())),
            None => {
                let (ready, _) = watch::channel(false);
                let ready = Arc::new(ready);
                entries.insert(key.clone(), SessionEntry::Opening(ready.clone()));
                Ok(CheckoutAction::Open(ready))
            }
        }
    }

    async fn reuse(
        &self,
        key: SessionKey,
        session: ManagedSession,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<SessionLease, NodeRunnerError> {
        let live = tokio::select! {
            biased;
            _ = wait_for_cancellation(cancellation) => return Err(NodeRunnerError::Cancelled),
            live = session.is_live() => live,
        };
        if !live {
            self.invalidate(key, session).await;
            return Err(NodeRunnerError::SessionLost);
        }
        Ok(SessionLease {
            session,
            pool: self.clone(),
            kind: SessionLeaseKind::NodeInstance(key),
        })
    }

    async fn open_session(
        &self,
        invocation: &NodeInvocation,
        environment: &ResolvedEnvironment,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<ManagedSession, NodeRunnerError> {
        let session = tokio::select! {
            biased;
            _ = wait_for_cancellation(cancellation) => return Err(NodeRunnerError::Cancelled),
            session = self.factory.open(invocation, environment) => session?,
        };
        let session = ManagedSession::new(session);
        let live = tokio::select! {
            biased;
            _ = wait_for_cancellation(cancellation) => {
                session.close().await;
                return Err(NodeRunnerError::Cancelled);
            },
            live = session.is_live() => live,
        };
        if !live {
            session.close().await;
            return Err(NodeRunnerError::SessionOpen);
        }
        Ok(session)
    }

    async fn finish_open(
        &self,
        key: SessionKey,
        ready: Arc<watch::Sender<bool>>,
        opened: Result<ManagedSession, NodeRunnerError>,
    ) -> Result<SessionLease, NodeRunnerError> {
        let mut close = None;
        let cancelled = matches!(&opened, Err(NodeRunnerError::Cancelled));
        let result = {
            let mut entries = self.entries.lock().await;
            let still_opening = matches!(
                entries.get(&key),
                Some(SessionEntry::Opening(current)) if Arc::ptr_eq(current, &ready)
            );
            if !still_opening {
                if let Ok(session) = &opened {
                    close = Some(session.clone());
                }
                Err(if cancelled {
                    NodeRunnerError::Cancelled
                } else {
                    NodeRunnerError::SessionLost
                })
            } else {
                match opened {
                    Ok(session) => {
                        entries.insert(key.clone(), SessionEntry::Live(session.clone()));
                        Ok(SessionLease {
                            session,
                            pool: self.clone(),
                            kind: SessionLeaseKind::NodeInstance(key),
                        })
                    }
                    Err(error) => {
                        if error == NodeRunnerError::Cancelled {
                            entries.insert(key, SessionEntry::Lost);
                        } else {
                            entries.remove(&key);
                        }
                        Err(error)
                    }
                }
            }
        };
        let _ = ready.send(true);
        if let Some(session) = close {
            session.close().await;
        }
        result
    }

    async fn invalidate(&self, key: SessionKey, session: ManagedSession) {
        let mut entries = self.entries.lock().await;
        if matches!(entries.get(&key), Some(SessionEntry::Live(current)) if current.same(&session))
        {
            entries.insert(key, SessionEntry::Lost);
        }
        drop(entries);
        session.close().await;
    }

    async fn close_run(&self, run_id: &RunId) {
        let mut entries = self.entries.lock().await;
        let keys = entries
            .keys()
            .filter(|key| key.run_id == *run_id)
            .cloned()
            .collect::<Vec<_>>();
        let entries_to_close = keys
            .into_iter()
            .filter_map(|key| match entries.insert(key, SessionEntry::Lost) {
                Some(SessionEntry::Live(session)) => Some(EntryToClose::Session(session)),
                Some(SessionEntry::Opening(ready)) => Some(EntryToClose::Opening(ready)),
                Some(SessionEntry::Lost) | None => None,
            })
            .collect::<Vec<_>>();
        drop(entries);
        for entry in entries_to_close {
            match entry {
                EntryToClose::Session(session) => session.close().await,
                EntryToClose::Opening(ready) => {
                    let _ = ready.send(true);
                }
            }
        }
    }
}

async fn wait_for_ready(receiver: &mut watch::Receiver<bool>) {
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

async fn wait_for_open(
    ready: &mut watch::Receiver<bool>,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<(), NodeRunnerError> {
    tokio::select! {
        biased;
        _ = wait_for_cancellation(cancellation) => Err(NodeRunnerError::Cancelled),
        _ = wait_for_ready(ready) => Ok(()),
    }
}

enum CheckoutAction {
    Reuse(ManagedSession),
    Wait(watch::Receiver<bool>),
    Open(Arc<watch::Sender<bool>>),
}

enum EntryToClose {
    Session(ManagedSession),
    Opening(Arc<watch::Sender<bool>>),
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct SessionKey {
    run_id: RunId,
    node_instance: NodeInstanceId,
}

enum SessionEntry {
    Opening(Arc<watch::Sender<bool>>),
    Live(ManagedSession),
    Lost,
}

struct SessionLease {
    session: ManagedSession,
    pool: SessionPool,
    kind: SessionLeaseKind,
}

impl SessionLease {
    async fn finish(self, clean: bool) {
        match self.kind {
            SessionLeaseKind::Execution => self.session.close().await,
            SessionLeaseKind::NodeInstance(_) if clean => {}
            SessionLeaseKind::NodeInstance(key) => self.pool.invalidate(key, self.session).await,
        }
    }
}

enum SessionLeaseKind {
    Execution,
    NodeInstance(SessionKey),
}

#[cfg(test)]
#[path = "native_v2_runner/test_support.rs"]
mod test_support;

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use openengine_cluster_protocol::{FieldName, NodeName, NonEmptyEnumSet, PayloadType, RunId};
    use serde_json::Value;
    use tokio::sync::watch;

    use super::*;
    use super::test_support::{
        admitted, binding, request, runner, BurstDriver, FakeDriver, FakeFactory,
        SelectiveBlockingFactory,
    };
    use crate::native_v2_contract::EnvironmentVariableName;

    #[tokio::test]
    async fn parallel_verifiers_overlap_but_writers_are_exclusive() {
        let (runner, driver, _) = runner();
        let mut left = runner.start(request("run", "left", (1, 1))).await.unwrap();
        let mut right = runner.start(request("run", "right", (2, 2))).await.unwrap();
        let (left, right) = tokio::join!(left.completion(), right.completion());
        left.unwrap();
        right.unwrap();
        assert_eq!(driver.concurrency.max_readers.load(Ordering::SeqCst), 2);

        let mut first = runner
            .start(request("run", "worker1", (3, 3)))
            .await
            .unwrap();
        let mut second = runner
            .start(request("run", "worker2", (4, 4)))
            .await
            .unwrap();
        let mut verifier = runner
            .start(request("run", "verify", (5, 5)))
            .await
            .unwrap();
        let (first, second, verifier) = tokio::join!(
            first.completion(),
            second.completion(),
            verifier.completion()
        );
        first.unwrap();
        second.unwrap();
        verifier.unwrap();
        assert!(!driver.concurrency.overlap.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn execution_sessions_are_fresh_and_node_instance_sessions_reuse_through_loops() {
        let (runner, _, factory) = runner();
        for execution in 1..=2 {
            runner
                .start(request("run", "looped", (1, execution)))
                .await
                .unwrap()
                .completion()
                .await
                .unwrap();
        }
        assert_eq!(factory.opened.load(Ordering::SeqCst), 1);

        for execution in 3..=4 {
            runner
                .start(request("run", "fresh", (2, execution)))
                .await
                .unwrap()
                .completion()
                .await
                .unwrap();
        }
        assert_eq!(factory.opened.load(Ordering::SeqCst), 3);
        let sessions = factory.sessions.lock().unwrap();
        assert_eq!(sessions[0].closed.load(Ordering::SeqCst), 0);
        assert_eq!(sessions[1].closed.load(Ordering::SeqCst), 1);
        assert_eq!(sessions[2].closed.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_lost_reused_session_fails_without_replacement() {
        let (runner, _, factory) = runner();
        runner
            .start(request("run", "looped", (1, 1)))
            .await
            .unwrap()
            .completion()
            .await
            .unwrap();
        factory.sessions.lock().unwrap()[0]
            .live
            .store(false, Ordering::SeqCst);

        let result = runner
            .start(request("run", "looped", (1, 2)))
            .await
            .unwrap()
            .completion()
            .await;
        assert_eq!(result, Err(NodeRunnerError::SessionLost));
        assert_eq!(factory.opened.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn closing_a_run_closes_and_permanently_loses_its_reused_sessions() {
        let (runner, _, factory) = runner();
        runner
            .start(request("run", "looped", (1, 1)))
            .await
            .unwrap()
            .completion()
            .await
            .unwrap();

        runner.close_run(&RunId::new("run")).await;
        assert_eq!(
            factory.sessions.lock().unwrap()[0]
                .closed
                .load(Ordering::SeqCst),
            1
        );
        assert!(matches!(
            runner.start(request("run", "looped", (1, 2))).await,
            Err(NodeRunnerError::RunClosed)
        ));
        assert_eq!(factory.opened.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancellation_closes_session_and_initial_output_precedes_live_attach() {
        let (runner, _, factory) = runner();
        let mut handle = runner
            .start(request("run", "worker", (1, 1)))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(10)).await;
        let mut initial = handle.take_initial_output().unwrap();
        let output = initial.recv().await.unwrap();
        assert_eq!(output.text, "working");
        assert!(handle.take_initial_output().is_none());
        let mut live_only = handle.attach();
        handle.cancel();
        assert_eq!(handle.completion().await, Err(NodeRunnerError::Cancelled));
        assert_eq!(live_only.recv().await, Err(AttachReceiveError::Closed));
        assert_eq!(
            factory.sessions.lock().unwrap()[0]
                .closed
                .load(Ordering::SeqCst),
            1
        );
    }

    #[tokio::test]
    async fn durable_output_bridge_never_lags_behind_live_broadcast() {
        let factory = Arc::new(FakeFactory::default());
        let admitted = admitted();
        let runner = NativeNodeRunner::new(&admitted, Arc::new(BurstDriver), factory).unwrap();
        let mut handle = runner
            .start(request("run", "worker", (1, 1)))
            .await
            .unwrap();
        handle.completion().await.unwrap();

        let mut durable = handle.take_initial_output().unwrap();
        let mut received = 0;
        while durable.recv().await.is_ok() {
            received += 1;
        }
        assert_eq!(received, LIVE_OUTPUT_CAPACITY + 44);
    }

    #[tokio::test]
    async fn admitted_role_plan_cannot_be_overridden_by_a_request() {
        let (runner, _, _) = runner();
        let mut spoofed = request("run", "worker1", (1, 1));
        spoofed.invocation.reference.node = NodeName::new("left").unwrap();
        assert!(matches!(
            runner.start(spoofed).await,
            Err(NodeRunnerError::InvalidRole)
        ));
    }

    #[tokio::test]
    async fn stalled_session_open_is_cancellable_and_does_not_lock_other_nodes() {
        let driver = Arc::new(FakeDriver::default());
        let (started, mut started_receiver) = watch::channel(false);
        let factory = Arc::new(SelectiveBlockingFactory {
            opened: AtomicUsize::new(0),
            started,
        });
        let runner = NativeNodeRunner::new(&admitted(), driver, factory.clone()).unwrap();
        let mut slow = runner
            .start(request("run", "slow_reuse", (1, 1)))
            .await
            .unwrap();
        while !*started_receiver.borrow_and_update() {
            started_receiver.changed().await.unwrap();
        }

        let mut fast = runner
            .start(request("run", "fast_reuse", (2, 2)))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_millis(250), fast.completion())
            .await
            .unwrap()
            .unwrap();
        slow.cancel();
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(250), slow.completion())
                .await
                .unwrap(),
            Err(NodeRunnerError::Cancelled)
        );
        assert_eq!(factory.opened.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn close_run_cancels_active_execution_scope_and_waits_for_cleanup() {
        let (runner, _, factory) = runner();
        let mut handle = runner
            .start(request("run", "worker", (1, 1)))
            .await
            .unwrap();
        let mut output = handle.take_initial_output().unwrap();
        output.recv().await.unwrap();

        runner.close_run(&RunId::new("run")).await;
        assert_eq!(handle.completion().await, Err(NodeRunnerError::Cancelled));
        assert_eq!(
            factory.sessions.lock().unwrap()[0]
                .closed
                .load(Ordering::SeqCst),
            1
        );
    }

    #[tokio::test]
    async fn cancelling_completion_wait_preserves_cleanup_acknowledgement() {
        let (runner, _, factory) = runner();
        let mut handle = runner
            .start(request("run", "worker", (1, 1)))
            .await
            .unwrap();
        let mut output = handle.take_initial_output().unwrap();
        output.recv().await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(1), handle.completion())
                .await
                .is_err()
        );
        handle.cancel();
        assert_eq!(handle.completion().await, Err(NodeRunnerError::Cancelled));
        assert_eq!(
            factory.sessions.lock().unwrap()[0]
                .closed
                .load(Ordering::SeqCst),
            1
        );
    }

    #[test]
    fn resolved_environment_requires_exact_names_and_redacts_values() {
        let name = EnvironmentVariableName::new("TOKEN").unwrap();
        let mut binding = binding(SessionScope::Execution);
        let NodeRuntimeBinding::Agent { env, .. } = &mut binding else {
            unreachable!()
        };
        env.insert(name.clone());
        assert!(matches!(
            ResolvedEnvironment::exact(&binding, BTreeMap::new()),
            Err(EnvironmentResolutionError::Missing(_))
        ));
        let resolved = ResolvedEnvironment::exact(
            &binding,
            BTreeMap::from([(name, "super-secret".to_owned())]),
        )
        .unwrap();
        let debug = format!("{resolved:?}");
        assert!(debug.contains("TOKEN"));
        assert!(!debug.contains("super-secret"));
    }

    #[test]
    fn response_contract_rejects_wrong_shapes_signals_and_labels() {
        let worker = NodeResponseContract::Worker {
            output: PayloadType::Null,
        };
        assert!(
            worker
                .validate_outcome(&WorkerOutcome::Verified {
                    output: Value::Null,
                    artifacts: Vec::new(),
                })
                .is_ok()
        );
        assert!(
            worker
                .validate_outcome(&WorkerOutcome::Verified {
                    output: Value::Bool(true),
                    artifacts: Vec::new(),
                })
                .is_err()
        );

        let verdict = FieldName::new("verdict").unwrap();
        let verifier = NodeResponseContract::Verifier {
            output: PayloadType::Null,
            signals: BTreeMap::from([(
                verdict.clone(),
                NonEmptyEnumSet::new(vec![
                    openengine_cluster_protocol::EnumLabel::new("accepted").unwrap(),
                ])
                .unwrap(),
            )]),
            diagnostic: PayloadType::Null,
        };
        let valid = WorkerOutcome::Verifier {
            output: Value::Null,
            signals: BTreeMap::from([(
                verdict.clone(),
                openengine_cluster_protocol::EnumLabel::new("accepted").unwrap(),
            )]),
            diagnostic: Value::Null,
            artifacts: Vec::new(),
        };
        assert!(verifier.validate_outcome(&valid).is_ok());
        let WorkerOutcome::Verifier { mut signals, .. } = valid else {
            unreachable!()
        };
        signals.insert(
            verdict,
            openengine_cluster_protocol::EnumLabel::new("rejected").unwrap(),
        );
        assert!(
            verifier
                .validate_outcome(&WorkerOutcome::Verifier {
                    output: Value::Null,
                    signals,
                    diagnostic: Value::Null,
                    artifacts: Vec::new(),
                })
                .is_err()
        );
    }
}
