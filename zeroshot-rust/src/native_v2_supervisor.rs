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
    Decision, DurableExecution, DurableExecutionState, ExecutionId, ExecutionVoidReason,
    FullV1Reducer, HistoryPosition, ReducerError, ReductionInput,
};
use crate::native_v2_contract::{
    AdmittedRun, ExecutionRef, NodeCompletion, NodeInvocation, NodeRuntimeBinding,
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

    // Dispatch and terminalization are kept in the controller companion module.
}

mod controller;
mod runtime;
use runtime::*;
