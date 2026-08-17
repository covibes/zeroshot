//! Lean native-v2 run supervision.
//!
//! One supervisor owns one admitted run. It repeatedly folds durable execution history through
//! the full-v1 reducer, records reducer-authorized dispatches before starting them, settles the
//! resulting node completions, and reduces again until terminal. Provider details and credential
//! values remain behind the injected environment and runner ports.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    EnumLabel, GraphNode, NodeName, RunId, TerminalResult, WorkerErrorCode, WorkerOutcome,
};
use openengine_cluster_server::admission::VerifiedGraph;
use thiserror::Error;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinSet;

use crate::full_v1_reducer::{
    Decision, DurableExecution, DurableExecutionState, ExecutionVoidReason, FullV1Reducer,
    HistoryPosition, ReducerError, ReductionInput,
};
use crate::native_v2_contract::{
    AdmittedRun, ExecutionId, ExecutionRef, NodeCompletion, NodeInvocation, NodeRuntimeBinding,
};
use crate::native_v2_runner::{
    LiveOutputSource, LiveOutputStream, NodeHandle, NodeRunRequest, NodeRunner, NodeRunnerError,
    ResolvedEnvironment,
};
use crate::v2_run_ledger::{
    NodeSnapshot, NodeState, RunEvent, RunLedger, RunLedgerError, RunPhase, RunSnapshot,
    SafeLogLine, SafeLogStream, StoredRun, cursor_sequence,
};

#[cfg(test)]
#[path = "native_v2_supervisor/tests.rs"]
mod tests;

const FIRST_IDENTITY: u64 = 1;

/// Runtime-only environment resolution. Implementations receive declared names but must never
/// persist resolved values in the run ledger.
#[async_trait]
pub trait NodeEnvironmentResolver: Send + Sync {
    async fn resolve(
        &self,
        node: &NodeName,
        binding: &NodeRuntimeBinding,
    ) -> Result<ResolvedEnvironment, EnvironmentUnavailable>;
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("declared node environment is unavailable")]
pub struct EnvironmentUnavailable;

/// Optional live-observation seam. The supervisor retains cancellation and completion ownership;
/// a registration grants read-only subscription and is closed after durable output is drained.
#[async_trait]
pub trait LiveOutputRegistrar: Send + Sync {
    async fn register(
        &self,
        reference: &ExecutionRef,
        source: LiveOutputSource,
    ) -> Result<Box<dyn LiveOutputRegistration>, LiveOutputUnavailable>;
}

#[async_trait]
pub trait LiveOutputRegistration: Send {
    async fn close(self: Box<Self>);
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("live output registration is unavailable")]
pub struct LiveOutputUnavailable;

/// Why the run-local runtime is being destroyed before durable terminal truth is written.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunRuntimeExit {
    Completed,
    ForceStopped,
    RuntimeLost,
}

/// Optional runtime cleanup seam used by the cloud controller.
///
/// Returning success is an acknowledgement that the disposable runtime is gone. The supervisor
/// never appends a terminal event before this acknowledgement.
#[async_trait]
pub trait RunRuntimeCleanup: Send + Sync {
    async fn cleanup(&self, exit: RunRuntimeExit) -> Result<(), RuntimeCleanupUnavailable>;
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("run runtime cleanup could not be confirmed")]
pub struct RuntimeCleanupUnavailable;

#[derive(Debug, Error)]
pub enum NativeV2SupervisorError {
    #[error("run was not found")]
    RunNotFound,
    #[error("durable run state is inconsistent with the active supervisor")]
    InvalidState,
    #[error("a supervisor task failed")]
    Task,
    #[error(transparent)]
    RuntimeCleanup(#[from] RuntimeCleanupUnavailable),
    #[error(transparent)]
    Ledger(#[from] RunLedgerError),
    #[error(transparent)]
    Reducer(#[from] ReducerError),
}

/// A single-run controller. Calls to `drive` are serialized, while `force_stop` remains able to
/// interrupt an in-flight drive.
#[derive(Clone)]
pub struct NativeV2Supervisor {
    run_id: RunId,
    ledger: Arc<dyn RunLedger>,
    runner: Arc<dyn NodeRunner>,
    environments: Arc<dyn NodeEnvironmentResolver>,
    live_output: Option<Arc<dyn LiveOutputRegistrar>>,
    runtime_cleanup: Option<Arc<dyn RunRuntimeCleanup>>,
    runtime_lost: Arc<AtomicBool>,
    drive_turn: Arc<Mutex<()>>,
}

impl NativeV2Supervisor {
    #[must_use]
    pub fn new(
        run_id: RunId,
        ledger: Arc<dyn RunLedger>,
        runner: Arc<dyn NodeRunner>,
        environments: Arc<dyn NodeEnvironmentResolver>,
    ) -> Self {
        Self {
            run_id,
            ledger,
            runner,
            environments,
            live_output: None,
            runtime_cleanup: None,
            runtime_lost: Arc::new(AtomicBool::new(false)),
            drive_turn: Arc::new(Mutex::new(())),
        }
    }

    #[must_use]
    pub fn with_live_output(mut self, registrar: Arc<dyn LiveOutputRegistrar>) -> Self {
        self.live_output = Some(registrar);
        self
    }

    #[must_use]
    pub fn with_runtime_cleanup(mut self, cleanup: Arc<dyn RunRuntimeCleanup>) -> Self {
        self.runtime_cleanup = Some(cleanup);
        self
    }

    /// Drives the run until it reaches its durable terminal result.
    pub async fn drive(&self) -> Result<TerminalResult, NativeV2SupervisorError> {
        let _turn = self.drive_turn.lock().await;
        match self.initialize().await? {
            Initialization::Terminal(terminal) => Ok(terminal),
            Initialization::Program(program) => self.drive_program(program).await,
        }
    }

    async fn initialize(&self) -> Result<Initialization, NativeV2SupervisorError> {
        let mut stored = self.load().await?;
        if let Some(terminal) = stored.snapshot.terminal {
            return Ok(Initialization::Terminal(terminal));
        }
        if stored.snapshot.force_stop_requested || stored.snapshot.phase == RunPhase::Stopping {
            return self
                .terminalize_force(&mut JoinSet::new())
                .await
                .map(Initialization::Terminal);
        }
        if stored.snapshot.active_executions().next().is_some() {
            return self
                .terminalize_lost(&mut JoinSet::new())
                .await
                .map(Initialization::Terminal);
        }
        if stored.snapshot.phase == RunPhase::Admitted {
            stored.snapshot = self
                .ledger
                .append(&self.run_id, vec![RunEvent::RunStarted])
                .await?
                .snapshot;
        }
        if stored.snapshot.phase != RunPhase::Running {
            return Err(NativeV2SupervisorError::InvalidState);
        }
        Ok(Initialization::Program(Box::new(RunProgram {
            timeouts: timeout_catalog(&stored.admitted.graph.root),
            admitted: stored.admitted,
        })))
    }

    async fn drive_program(
        &self,
        program: Box<RunProgram>,
    ) -> Result<TerminalResult, NativeV2SupervisorError> {
        let mut active = ActiveDispatches::default();
        loop {
            let snapshot = self.snapshot().await?;
            if let Some(terminal) = snapshot.terminal {
                self.runner.close_run(&self.run_id).await;
                return Ok(terminal);
            }
            if self.runtime_lost.load(Ordering::Acquire) {
                return self.terminalize_lost(&mut active.tasks).await;
            }
            if snapshot.force_stop_requested {
                return self.terminalize_force(&mut active.tasks).await;
            }
            if let Some(terminal) = self.advance(&program, &snapshot, &mut active).await? {
                return Ok(terminal);
            }
        }
    }

    async fn advance(
        &self,
        program: &RunProgram,
        snapshot: &RunSnapshot,
        active: &mut ActiveDispatches,
    ) -> Result<Option<TerminalResult>, NativeV2SupervisorError> {
        let reduction = reduce(&program.admitted, snapshot)?;
        let voids = void_decisions(&reduction.decisions);
        if !voids.is_empty() {
            self.cancel_voids(voids, active).await?;
            return Ok(None);
        }
        if let Some(terminal) = reduction.terminal {
            return self
                .finish_reduction(snapshot, active, terminal)
                .await
                .map(Some);
        }
        let dispatches = dispatch_decisions(&self.run_id, reduction.decisions);
        if !dispatches.is_empty() {
            self.dispatch(program, dispatches, active).await?;
            return Ok(None);
        }
        self.await_completion(active).await?;
        Ok(None)
    }

    async fn finish_reduction(
        &self,
        snapshot: &RunSnapshot,
        active: &ActiveDispatches,
        terminal: TerminalResult,
    ) -> Result<TerminalResult, NativeV2SupervisorError> {
        if snapshot.active_executions().next().is_some() || !active.tasks.is_empty() {
            return Err(NativeV2SupervisorError::InvalidState);
        }
        self.runner.close_run(&self.run_id).await;
        self.cleanup_runtime(RunRuntimeExit::Completed).await?;
        let terminal = self.append_terminal(terminal).await?;
        Ok(terminal)
    }

    async fn await_completion(
        &self,
        active: &mut ActiveDispatches,
    ) -> Result<(), NativeV2SupervisorError> {
        let finished = Self::next_finished(active).await?;
        self.settle(finished, &mut active.pending_voids).await
    }

    async fn next_finished(
        active: &mut ActiveDispatches,
    ) -> Result<FinishedDispatch, NativeV2SupervisorError> {
        let finished = active
            .tasks
            .join_next()
            .await
            .ok_or(NativeV2SupervisorError::InvalidState)?
            .map_err(|_| NativeV2SupervisorError::Task)?;
        active.cancellations.remove(&finished.execution);
        Ok(finished)
    }

    /// Requests the deliberately force-only stop and waits for runner-owned cleanup. The driving
    /// task observes the durable request and closes the run without dispatching another node.
    pub async fn force_stop(&self) -> Result<(), NativeV2SupervisorError> {
        self.ledger.request_force_stop(&self.run_id).await?;
        self.runner.close_run(&self.run_id).await;
        Ok(())
    }

    /// Declares the one disposable runtime lost and wakes any in-flight node through runner
    /// closure. The driving turn owns durable crash settlement and terminalization.
    pub async fn runtime_lost(&self) {
        self.runtime_lost.store(true, Ordering::Release);
        self.runner.close_run(&self.run_id).await;
    }

    async fn cleanup_runtime(&self, exit: RunRuntimeExit) -> Result<(), RuntimeCleanupUnavailable> {
        match &self.runtime_cleanup {
            Some(cleanup) => cleanup.cleanup(exit).await,
            None => Ok(()),
        }
    }

    async fn load(&self) -> Result<StoredRun, NativeV2SupervisorError> {
        self.ledger
            .get(&self.run_id)
            .await?
            .ok_or(NativeV2SupervisorError::RunNotFound)
    }

    async fn snapshot(&self) -> Result<RunSnapshot, NativeV2SupervisorError> {
        Ok(self.load().await?.snapshot)
    }

    async fn dispatch(
        &self,
        program: &RunProgram,
        dispatches: Vec<Dispatch>,
        active: &mut ActiveDispatches,
    ) -> Result<bool, NativeV2SupervisorError> {
        if !self.record_dispatches(&dispatches).await? {
            return Ok(false);
        }
        for dispatch in dispatches {
            self.start_dispatch(program, dispatch, active).await?;
        }
        Ok(true)
    }

    async fn record_dispatches(
        &self,
        dispatches: &[Dispatch],
    ) -> Result<bool, NativeV2SupervisorError> {
        let events = dispatches
            .iter()
            .map(|dispatch| RunEvent::NodeStarted {
                reference: dispatch.reference.clone(),
                occurrence: dispatch.occurrence.clone(),
                attempt: dispatch.attempt,
                input: dispatch.input.clone(),
            })
            .collect();
        if let Err(error) = self.ledger.append(&self.run_id, events).await {
            let snapshot = self.snapshot().await?;
            if snapshot.force_stop_requested || snapshot.terminal.is_some() {
                return Ok(false);
            }
            return Err(error.into());
        }
        Ok(true)
    }

    async fn start_dispatch(
        &self,
        program: &RunProgram,
        dispatch: Dispatch,
        active: &mut ActiveDispatches,
    ) -> Result<(), NativeV2SupervisorError> {
        let mut handle = match self.start_node(program, &dispatch).await? {
            StartNode::Started(handle) => handle,
            StartNode::Failed(outcome) => {
                return self.settle_start_failure(dispatch.reference, outcome).await;
            }
        };
        let Some(output) = handle.take_initial_output() else {
            handle.cancel();
            let _ = handle.completion().await;
            return Err(NativeV2SupervisorError::InvalidState);
        };
        let registration = match self.register_live(&dispatch.reference, &mut handle).await {
            Ok(registration) => registration,
            Err(_) => {
                bridge_logs(
                    self.ledger.clone(),
                    self.run_id.clone(),
                    dispatch.reference.execution,
                    output,
                )
                .await?;
                return self
                    .settle_start_failure(
                        dispatch.reference,
                        WorkerOutcome::declared_failure(WorkerErrorCode::Crash),
                    )
                    .await;
            }
        };
        let timeout = *program
            .timeouts
            .get(&dispatch.reference.node)
            .ok_or(NativeV2SupervisorError::InvalidState)?;
        let execution = dispatch.reference.execution;
        let (cancel, receiver) = oneshot::channel();
        active.cancellations.insert(execution, cancel);
        active.tasks.spawn(run_dispatch(DispatchTask {
            handle,
            timeout,
            cancel: receiver,
            ledger: self.ledger.clone(),
            run_id: self.run_id.clone(),
            registration,
            output,
        }));
        Ok(())
    }

    async fn start_node(
        &self,
        program: &RunProgram,
        dispatch: &Dispatch,
    ) -> Result<StartNode, NativeV2SupervisorError> {
        let binding = program
            .admitted
            .runtime
            .nodes()
            .get(&dispatch.reference.node)
            .cloned()
            .ok_or(NativeV2SupervisorError::InvalidState)?;
        let environment = match self
            .environments
            .resolve(&dispatch.reference.node, &binding)
            .await
        {
            Ok(environment) => environment,
            Err(_) => {
                return Ok(StartNode::Failed(WorkerOutcome::authentication_refusal()));
            }
        };
        let invocation = NodeInvocation {
            reference: dispatch.reference.clone(),
            worker: dispatch.worker.clone(),
            input: dispatch.input.clone(),
            binding,
        };
        match self
            .runner
            .start(NodeRunRequest {
                invocation,
                environment,
            })
            .await
        {
            Ok(handle) => Ok(StartNode::Started(handle)),
            Err(error) => Ok(StartNode::Failed(runner_failure(error))),
        }
    }

    async fn register_live(
        &self,
        reference: &ExecutionRef,
        handle: &mut NodeHandle,
    ) -> Result<Option<Box<dyn LiveOutputRegistration>>, LiveOutputUnavailable> {
        let Some(registrar) = &self.live_output else {
            return Ok(None);
        };
        let Some(source) = handle.live_output_source() else {
            handle.cancel();
            let _ = handle.completion().await;
            return Err(LiveOutputUnavailable);
        };
        match registrar.register(reference, source).await {
            Ok(registration) => Ok(Some(registration)),
            Err(_) => {
                handle.cancel();
                let _ = handle.completion().await;
                Err(LiveOutputUnavailable)
            }
        }
    }

    async fn settle_start_failure(
        &self,
        reference: ExecutionRef,
        outcome: WorkerOutcome,
    ) -> Result<(), NativeV2SupervisorError> {
        self.ledger
            .append(
                &self.run_id,
                vec![RunEvent::NodeCompleted {
                    completion: NodeCompletion { reference, outcome },
                }],
            )
            .await?;
        Ok(())
    }

    async fn cancel_voids(
        &self,
        voids: Vec<(ExecutionId, ExecutionVoidReason)>,
        active: &mut ActiveDispatches,
    ) -> Result<(), NativeV2SupervisorError> {
        let targets = voids
            .into_iter()
            .map(|(execution, reason)| {
                active.pending_voids.insert(execution, reason);
                let cancel = active
                    .cancellations
                    .remove(&execution)
                    .ok_or(NativeV2SupervisorError::InvalidState)?;
                let _ = cancel.send(ExecutionInterrupt::Void);
                Ok(execution)
            })
            .collect::<Result<BTreeSet<_>, NativeV2SupervisorError>>()?;
        while targets
            .iter()
            .any(|execution| active.pending_voids.contains_key(execution))
        {
            let finished = Self::next_finished(active).await?;
            self.settle(finished, &mut active.pending_voids).await?;
        }
        Ok(())
    }

    async fn settle(
        &self,
        finished: FinishedDispatch,
        pending_voids: &mut BTreeMap<ExecutionId, ExecutionVoidReason>,
    ) -> Result<(), NativeV2SupervisorError> {
        if let Some(reason) = pending_voids.remove(&finished.execution) {
            self.ledger
                .append(
                    &self.run_id,
                    vec![RunEvent::ExecutionVoided {
                        reference: finished.reference,
                        reason,
                    }],
                )
                .await?;
            return Ok(());
        }
        let force = self.snapshot().await?.force_stop_requested;
        let outcome = settled_outcome(&finished.reference, finished.result, force)?;
        self.ledger
            .append(
                &self.run_id,
                vec![RunEvent::NodeCompleted {
                    completion: NodeCompletion {
                        reference: finished.reference,
                        outcome,
                    },
                }],
            )
            .await?;
        Ok(())
    }

    async fn append_terminal(
        &self,
        terminal: TerminalResult,
    ) -> Result<TerminalResult, NativeV2SupervisorError> {
        self.ledger
            .append(
                &self.run_id,
                vec![RunEvent::Terminal {
                    result: terminal.clone(),
                }],
            )
            .await?;
        Ok(terminal)
    }

    async fn terminalize_force(
        &self,
        tasks: &mut JoinSet<FinishedDispatch>,
    ) -> Result<TerminalResult, NativeV2SupervisorError> {
        self.runner.close_run(&self.run_id).await;
        drain_terminalizing_tasks(tasks).await?;
        let snapshot = self.snapshot().await?;
        if let Some(terminal) = snapshot.terminal {
            return Ok(terminal);
        }
        let terminal = TerminalResult::Failed {
            reason: EnumLabel::new("force_stopped")
                .map_err(|_| NativeV2SupervisorError::InvalidState)?,
        };
        self.cleanup_runtime(RunRuntimeExit::ForceStopped).await?;
        let mut events = refusal_completions(&snapshot);
        events.push(RunEvent::Terminal {
            result: terminal.clone(),
        });
        self.ledger.append(&self.run_id, events).await?;
        Ok(terminal)
    }

    async fn terminalize_lost(
        &self,
        tasks: &mut JoinSet<FinishedDispatch>,
    ) -> Result<TerminalResult, NativeV2SupervisorError> {
        self.runner.close_run(&self.run_id).await;
        drain_terminalizing_tasks(tasks).await?;
        let snapshot = self.snapshot().await?;
        if let Some(terminal) = snapshot.terminal {
            return Ok(terminal);
        }
        let terminal = TerminalResult::Failed {
            reason: EnumLabel::new("runtime_lost")
                .map_err(|_| NativeV2SupervisorError::InvalidState)?,
        };
        self.cleanup_runtime(RunRuntimeExit::RuntimeLost).await?;
        let mut events = snapshot
            .active_executions()
            .map(|node| RunEvent::NodeCompleted {
                completion: NodeCompletion {
                    reference: node.reference.clone(),
                    outcome: WorkerOutcome::declared_failure(WorkerErrorCode::Crash),
                },
            })
            .collect::<Vec<_>>();
        events.push(RunEvent::Terminal {
            result: terminal.clone(),
        });
        self.ledger.append(&self.run_id, events).await?;
        Ok(terminal)
    }
}

async fn drain_terminalizing_tasks(
    tasks: &mut JoinSet<FinishedDispatch>,
) -> Result<(), NativeV2SupervisorError> {
    while let Some(finished) = tasks.join_next().await {
        let finished = finished.map_err(|_| NativeV2SupervisorError::Task)?;
        match finished.result {
            DispatchResult::LogFailure(error) => return Err(error.into()),
            DispatchResult::LogTaskFailed => return Err(NativeV2SupervisorError::Task),
            DispatchResult::Completed(_)
            | DispatchResult::TimedOut
            | DispatchResult::Interrupted => {}
        }
    }
    Ok(())
}

enum StartNode {
    Started(NodeHandle),
    Failed(WorkerOutcome),
}

enum Initialization {
    Terminal(TerminalResult),
    Program(Box<RunProgram>),
}

struct RunProgram {
    admitted: AdmittedRun,
    timeouts: BTreeMap<NodeName, Duration>,
}

#[derive(Default)]
struct ActiveDispatches {
    tasks: JoinSet<FinishedDispatch>,
    cancellations: BTreeMap<ExecutionId, oneshot::Sender<ExecutionInterrupt>>,
    pending_voids: BTreeMap<ExecutionId, ExecutionVoidReason>,
}

struct Dispatch {
    reference: ExecutionRef,
    occurrence: crate::full_v1_reducer::StructuralOccurrence,
    attempt: openengine_cluster_protocol::PositiveInteger,
    worker: openengine_cluster_protocol::WorkerRef,
    input: serde_json::Value,
}

fn void_decisions(decisions: &[Decision]) -> Vec<(ExecutionId, ExecutionVoidReason)> {
    decisions
        .iter()
        .filter_map(|decision| match decision {
            Decision::VoidLoser { execution, reason } => Some((*execution, *reason)),
            _ => None,
        })
        .collect()
}

fn dispatch_decisions(run_id: &RunId, decisions: Vec<Decision>) -> Vec<Dispatch> {
    decisions
        .into_iter()
        .filter_map(|decision| match decision {
            Decision::Dispatch {
                node_instance,
                execution,
                occurrence,
                attempt,
                worker,
                input,
            } => Some(Dispatch {
                reference: ExecutionRef {
                    run_id: run_id.clone(),
                    node: occurrence.node.clone(),
                    node_instance,
                    execution,
                },
                occurrence,
                attempt,
                worker,
                input,
            }),
            Decision::VoidLoser { .. }
            | Decision::Continue { .. }
            | Decision::Promote { .. }
            | Decision::Terminal { .. } => None,
        })
        .collect()
}

#[derive(Clone, Copy)]
enum ExecutionInterrupt {
    Void,
}

enum DispatchResult {
    Completed(Result<NodeCompletion, NodeRunnerError>),
    TimedOut,
    Interrupted,
    LogFailure(RunLedgerError),
    LogTaskFailed,
}

struct FinishedDispatch {
    execution: ExecutionId,
    reference: ExecutionRef,
    result: DispatchResult,
}

struct DispatchTask {
    handle: NodeHandle,
    timeout: Duration,
    cancel: oneshot::Receiver<ExecutionInterrupt>,
    ledger: Arc<dyn RunLedger>,
    run_id: RunId,
    registration: Option<Box<dyn LiveOutputRegistration>>,
    output: crate::native_v2_runner::DurableOutput,
}

async fn run_dispatch(task: DispatchTask) -> FinishedDispatch {
    let DispatchTask {
        mut handle,
        timeout,
        cancel,
        ledger,
        run_id,
        registration,
        output,
    } = task;
    let reference = handle.reference().clone();
    let execution = reference.execution;
    let logs = tokio::spawn(bridge_logs(ledger, run_id, execution, output));
    let interrupt = async {
        tokio::select! {
            _ = tokio::time::sleep(timeout) => DispatchResult::TimedOut,
            _ = cancel => DispatchResult::Interrupted,
        }
    };
    tokio::pin!(interrupt);
    let result = tokio::select! {
        completion = handle.completion() => DispatchResult::Completed(completion),
        interrupt = &mut interrupt => {
            handle.cancel();
            let _ = handle.completion().await;
            interrupt
        }
    };
    let result = match logs.await {
        Ok(Ok(())) => result,
        Ok(Err(error)) => DispatchResult::LogFailure(error),
        Err(_) => DispatchResult::LogTaskFailed,
    };
    if let Some(registration) = registration {
        registration.close().await;
    }
    FinishedDispatch {
        execution,
        reference,
        result,
    }
}

async fn bridge_logs(
    ledger: Arc<dyn RunLedger>,
    run_id: RunId,
    execution: ExecutionId,
    mut output: crate::native_v2_runner::DurableOutput,
) -> Result<(), RunLedgerError> {
    while let Ok(output) = output.recv().await {
        ledger
            .append(
                &run_id,
                vec![RunEvent::SafeLog {
                    execution: Some(execution),
                    stream: safe_log_stream(output.stream),
                    line: SafeLogLine::new(output.text)?,
                }],
            )
            .await?;
    }
    Ok(())
}

const fn safe_log_stream(stream: LiveOutputStream) -> SafeLogStream {
    match stream {
        LiveOutputStream::Output => SafeLogStream::Output,
        LiveOutputStream::Error => SafeLogStream::Error,
        LiveOutputStream::System => SafeLogStream::System,
    }
}

fn reduce(
    admitted: &AdmittedRun,
    snapshot: &RunSnapshot,
) -> Result<crate::full_v1_reducer::Reduction, NativeV2SupervisorError> {
    let executions = durable_history(snapshot)?;
    let verified = VerifiedGraph {
        compiled_ir: admitted.graph.clone(),
        diagnostics: Vec::new(),
    };
    Ok(FullV1Reducer::native_v2(&verified).reduce(ReductionInput {
        initial_input: &admitted.initial_input,
        executions: &executions,
        next_node_instance: next_node_instance(&executions)?,
        next_execution: next_execution(&executions)?,
    })?)
}

fn durable_history(
    snapshot: &RunSnapshot,
) -> Result<Vec<DurableExecution>, NativeV2SupervisorError> {
    let mut executions = snapshot
        .executions
        .values()
        .map(durable_execution)
        .collect::<Result<Vec<_>, _>>()?;
    executions.sort_by_key(|execution| (execution.dispatch_position, execution.execution));
    Ok(executions)
}

fn durable_execution(node: &NodeSnapshot) -> Result<DurableExecution, NativeV2SupervisorError> {
    let state = match &node.state {
        NodeState::Active => DurableExecutionState::Active,
        NodeState::Completed { at, outcome } => DurableExecutionState::Settled {
            position: history_position(at)?,
            outcome: outcome.clone(),
        },
        NodeState::Voided { at, reason } => DurableExecutionState::Voided {
            position: history_position(at)?,
            reason: *reason,
        },
    };
    Ok(DurableExecution {
        dispatch_position: history_position(&node.started_at)?,
        node_instance: node.reference.node_instance,
        execution: node.reference.execution,
        occurrence: node.occurrence.clone(),
        attempt: node.attempt,
        input: node.input.clone(),
        state,
    })
}

fn history_position(
    cursor: &openengine_cluster_protocol::Cursor,
) -> Result<HistoryPosition, NativeV2SupervisorError> {
    HistoryPosition::new(cursor_sequence(cursor)?)
        .map_err(|_| NativeV2SupervisorError::InvalidState)
}

fn next_node_instance(executions: &[DurableExecution]) -> Result<u64, NativeV2SupervisorError> {
    executions
        .iter()
        .map(|execution| execution.node_instance.get())
        .max()
        .unwrap_or(FIRST_IDENTITY - 1)
        .checked_add(1)
        .ok_or(NativeV2SupervisorError::InvalidState)
}

fn next_execution(executions: &[DurableExecution]) -> Result<u64, NativeV2SupervisorError> {
    executions
        .iter()
        .map(|execution| execution.execution.get())
        .max()
        .unwrap_or(FIRST_IDENTITY - 1)
        .checked_add(1)
        .ok_or(NativeV2SupervisorError::InvalidState)
}

fn timeout_catalog(root: &GraphNode) -> BTreeMap<NodeName, Duration> {
    let mut timeouts = BTreeMap::new();
    collect_timeouts(root, &mut timeouts);
    timeouts
}

fn collect_timeouts(node: &GraphNode, timeouts: &mut BTreeMap<NodeName, Duration>) {
    match node {
        GraphNode::Step(node) => {
            timeouts.insert(
                node.name.clone(),
                Duration::from_millis(node.timeout_ms.get()),
            );
        }
        GraphNode::Verifier(node) => {
            timeouts.insert(
                node.name.clone(),
                Duration::from_millis(node.timeout_ms.get()),
            );
        }
        GraphNode::Seq(node) => node
            .children
            .as_slice()
            .iter()
            .for_each(|child| collect_timeouts(child, timeouts)),
        GraphNode::Choice(node) => {
            node.branches
                .as_slice()
                .iter()
                .for_each(|branch| collect_timeouts(&branch.node, timeouts));
            if let Some(otherwise) = &node.otherwise {
                collect_timeouts(otherwise, timeouts);
            }
        }
        GraphNode::Par(node) => node
            .branches
            .as_slice()
            .iter()
            .for_each(|branch| collect_timeouts(branch, timeouts)),
        GraphNode::Loop(node) => collect_timeouts(&node.body, timeouts),
        GraphNode::Map(node) => collect_timeouts(&node.body, timeouts),
        GraphNode::Succeed(_) | GraphNode::Fail(_) => {}
    }
}

fn runner_failure(error: NodeRunnerError) -> WorkerOutcome {
    let code = match error {
        NodeRunnerError::Cancelled | NodeRunnerError::RunClosed => WorkerErrorCode::Refusal,
        NodeRunnerError::InvalidRole
        | NodeRunnerError::SessionOpen
        | NodeRunnerError::SessionLost
        | NodeRunnerError::Driver
        | NodeRunnerError::ConnectionLost
        | NodeRunnerError::UnsafeOutput
        | NodeRunnerError::DurableOutputClosed
        | NodeRunnerError::CompletionClosed
        | NodeRunnerError::ExecutionActive => WorkerErrorCode::Crash,
    };
    WorkerOutcome::declared_failure(code)
}

fn settled_outcome(
    reference: &ExecutionRef,
    result: DispatchResult,
    force: bool,
) -> Result<WorkerOutcome, NativeV2SupervisorError> {
    if force {
        return Ok(WorkerOutcome::declared_failure(WorkerErrorCode::Refusal));
    }
    match result {
        DispatchResult::Completed(Ok(completion)) if completion.reference == *reference => {
            Ok(completion.outcome)
        }
        DispatchResult::Completed(Ok(_)) => Err(NativeV2SupervisorError::InvalidState),
        DispatchResult::Completed(Err(error)) => Ok(runner_failure(error)),
        DispatchResult::TimedOut => Ok(WorkerOutcome::declared_failure(WorkerErrorCode::Timeout)),
        DispatchResult::Interrupted => Ok(WorkerOutcome::declared_failure(WorkerErrorCode::Crash)),
        DispatchResult::LogFailure(error) => Err(error.into()),
        DispatchResult::LogTaskFailed => Err(NativeV2SupervisorError::Task),
    }
}

fn refusal_completions(snapshot: &RunSnapshot) -> Vec<RunEvent> {
    snapshot
        .active_executions()
        .map(|node| RunEvent::NodeCompleted {
            completion: NodeCompletion {
                reference: node.reference.clone(),
                outcome: WorkerOutcome::declared_failure(WorkerErrorCode::Refusal),
            },
        })
        .collect()
}
