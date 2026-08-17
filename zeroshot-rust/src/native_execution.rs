use std::sync::Arc;

use openengine_cluster_protocol::{canonical_value_bytes, GraphSpec, TerminalResult, WorkerRef};
use openengine_cluster_server::admission::GraphVerifier;
use serde_json::Value;
use thiserror::Error;

#[path = "native_execution/agent.rs"]
mod agent;
#[path = "native_execution/command.rs"]
mod command;
#[path = "native_execution/credential.rs"]
mod credential;
#[path = "native_execution/pi.rs"]
mod pi;
#[path = "native_execution/process.rs"]
mod process;
#[path = "native_execution/program.rs"]
mod program;
#[path = "native_execution/validation.rs"]
mod validation;
#[path = "native_execution/worker_process.rs"]
mod worker_process;

pub(crate) use program::{
    is_deterministic_graph, is_worker_free_graph, NativeExecutionRegistry, NativeGraphVerifier,
    PredecessorProgram,
};
#[doc(hidden)]
pub use agent::validator::{run_greeting_validator, VALIDATOR_MODE as NATIVE_VALIDATOR_MODE};
use agent::{AgentWorkspaceAuthority, AgentWorkspaceCandidate, AgentWorkspacePreparation};
use process::NativeExecutionRuntime;
use program::{classify_graph, AgentKind, NativeProgram, CODEX_AGENT_WORKER_REF};

use crate::cluster_ledger::record::CanonicalDigest;
use crate::cluster_ledger::mutations::{
    authorize_legacy_reduction, durable_execution_history_digest, durable_executions_from_replay,
    LegacyAuthorizationContext, LegacyReduction,
};
use crate::cluster_ledger::{ClusterLedger, LedgerError, ReplayState};
use crate::full_v1_reducer::{Decision, FullV1Reducer, ReductionInput};

#[derive(Clone)]
pub(crate) struct NativeExecutionCoordinator {
    ledger: ClusterLedger,
    verifier: Arc<NativeGraphVerifier>,
    registry: NativeExecutionRegistry,
    runtime: NativeExecutionRuntime,
    turn: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Debug, Error)]
pub(crate) enum NativeExecutionError {
    #[error("native execution durable state is invalid")]
    InvalidState,
    #[error("native execution graph verification failed")]
    Verification,
    #[error("native execution contract construction failed")]
    Contract,
    #[error("native execution preflight failed")]
    Preflight,
    #[error("native execution ledger failed: {0}")]
    Ledger(#[from] LedgerError),
}

pub(crate) struct NativeExecutionProcess {
    pub(crate) resource: crate::cluster_ledger::ResourceId,
    pub(crate) state_dir: std::path::PathBuf,
    pub(crate) workspace: std::path::PathBuf,
    pub(crate) executable: std::path::PathBuf,
    pub(crate) path_snapshot: Option<std::ffi::OsString>,
    pub(crate) api_key_snapshot: Option<String>,
}

struct CommittedDispatch {
    allocation: crate::cluster_ledger::DispatchAllocation,
    worker: WorkerRef,
    input: Value,
    workspace_candidate: Option<AgentWorkspaceCandidate>,
    workspace: Option<AgentWorkspaceAuthority>,
}

impl NativeExecutionCoordinator {
    pub(crate) fn new(
        ledger: ClusterLedger,
        verifier: Arc<NativeGraphVerifier>,
        registry: NativeExecutionRegistry,
        process: NativeExecutionProcess,
    ) -> Result<Self, NativeExecutionError> {
        Ok(Self {
            ledger,
            verifier,
            registry,
            runtime: process::runtime(process)?,
            turn: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    pub(crate) async fn validate_open_state(&self) -> Result<(), NativeExecutionError> {
        let state = self.ledger.state().await?;
        if !state.active_dispatches.is_empty() {
            return Err(NativeExecutionError::InvalidState);
        }
        if state.terminal_outcome.is_some() {
            self.terminal_result_from_state(&state).await?;
        }
        Ok(())
    }

    pub(crate) async fn recover_pending(&self) -> Result<(), NativeExecutionError> {
        self.drive().await.map(|_| ())
    }

    pub(crate) async fn drive(&self) -> Result<Option<TerminalResult>, NativeExecutionError> {
        let _turn = self.turn.lock().await;
        self.drive_exclusive().await
    }

    async fn drive_exclusive(&self) -> Result<Option<TerminalResult>, NativeExecutionError> {
        let Some((state, graph)) = self.executable_state().await? else {
            return Ok(None);
        };
        if state.terminal_outcome.is_some() {
            return self.terminal_result_from_state(&state).await.map(Some);
        }
        if !state.active_dispatches.is_empty() {
            return Err(NativeExecutionError::InvalidState);
        }
        let reduction = self.reduce(&state, &graph).await?;
        self.advance_reduction(state, graph, reduction).await
    }

    async fn executable_state(
        &self,
    ) -> Result<Option<(ReplayState, GraphSpec)>, NativeExecutionError> {
        let state = self.ledger.state().await?;
        let Some(admission) = state.admission.as_ref() else {
            return Ok(None);
        };
        let graph: GraphSpec = serde_json::from_slice(&admission.canonical_graph)
            .map_err(|_| NativeExecutionError::InvalidState)?;
        if !matches!(
            classify_graph(&graph),
            Some(NativeProgram::Deterministic | NativeProgram::ForegroundAgent(_))
        ) {
            return Ok(None);
        }
        Ok(Some((state, graph)))
    }

    async fn advance_reduction(
        &self,
        state: ReplayState,
        graph: GraphSpec,
        reduction: LegacyReduction,
    ) -> Result<Option<TerminalResult>, NativeExecutionError> {
        if let Some(terminal) = reduction.terminal.clone() {
            self.commit_terminal(&reduction).await?;
            return Ok(Some(terminal));
        }
        self.execute_dispatch(&state, &graph, &reduction).await
    }

    async fn execute_dispatch(
        &self,
        state: &ReplayState,
        graph: &GraphSpec,
        reduction: &LegacyReduction,
    ) -> Result<Option<TerminalResult>, NativeExecutionError> {
        let Some(mut dispatch) = self.commit_new_dispatch(reduction).await? else {
            return Ok(None);
        };
        if let Some(outcome) = self.prepare_dispatch(state, &mut dispatch).await? {
            let outcome = validation::canonical_outcome(&self.registry, &dispatch.worker, outcome)?;
            return self
                .settle_and_terminalize(graph, dispatch.allocation, outcome)
                .await
                .map(Some);
        }
        self.run_committed_dispatch(state, graph, dispatch).await
    }

    async fn commit_new_dispatch(
        &self,
        reduction: &LegacyReduction,
    ) -> Result<Option<CommittedDispatch>, NativeExecutionError> {
        let (execution, worker, input) = one_dispatch(reduction)?;
        let workspace_candidate = self.runtime.preflight(worker.as_str(), &input).await?;
        let authorization = reduction
            .dispatch_authorization(execution)
            .ok_or(NativeExecutionError::InvalidState)?;
        let committed = self
            .ledger
            .dispatch_reduction(
                command::dispatch_key(
                    reduction.run(),
                    reduction
                        .ledger_execution(execution)
                        .map_err(|_| NativeExecutionError::InvalidState)?,
                )?,
                authorization,
            )
            .await?;
        if committed.replayed {
            return Ok(None);
        }
        Ok(Some(CommittedDispatch {
            allocation: committed.value,
            worker,
            input,
            workspace_candidate,
            workspace: None,
        }))
    }

    async fn prepare_dispatch(
        &self,
        state: &ReplayState,
        dispatch: &mut CommittedDispatch,
    ) -> Result<Option<openengine_cluster_protocol::WorkerOutcome>, NativeExecutionError> {
        let candidate = match dispatch.workspace_candidate.take() {
            Some(candidate) if dispatch.worker.as_str() == CODEX_AGENT_WORKER_REF => candidate,
            None if dispatch.worker.as_str() != CODEX_AGENT_WORKER_REF => return Ok(None),
            Some(_) | None => return Err(NativeExecutionError::InvalidState),
        };
        let prepared = self
            .runtime
            .prepare_workspace(&state.resource, &dispatch.allocation, candidate)
            .await;
        match prepared {
            AgentWorkspacePreparation::Closed(outcome) => Ok(Some(outcome)),
            AgentWorkspacePreparation::Ready(authority) => {
                dispatch.workspace = Some(authority);
                Ok(None)
            }
        }
    }

    async fn run_committed_dispatch(
        &self,
        state: &ReplayState,
        graph: &GraphSpec,
        mut dispatch: CommittedDispatch,
    ) -> Result<Option<TerminalResult>, NativeExecutionError> {
        let command = match command::build(
            command::CommandRequest {
                state,
                allocation: dispatch.allocation.clone(),
                input: dispatch.input,
                worker: &dispatch.worker,
            },
            &self.registry,
        ) {
            Ok(command) => command,
            Err(error) => {
                finish_workspace(dispatch.workspace.take()).await?;
                return Err(error);
            }
        };
        let observation = self.runtime.dispatch(command).await;
        if !matches!(
            observation,
            crate::execution::DispatchObservation::Completed { .. }
        ) {
            quarantine(dispatch.workspace.take());
            return Err(NativeExecutionError::InvalidState);
        }
        let outcome_bytes = match validation::validate_observation(
            &self.registry,
            &dispatch.worker,
            &dispatch.allocation,
            observation,
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                quarantine(dispatch.workspace.take());
                return Err(error);
            }
        };
        let terminal = match self
            .settle_and_terminalize(graph, dispatch.allocation, outcome_bytes)
            .await
        {
            Ok(terminal) => terminal,
            Err(error) => {
                quarantine(dispatch.workspace.take());
                return Err(error);
            }
        };
        finish_workspace(dispatch.workspace.take()).await?;
        Ok(Some(terminal))
    }

    async fn settle_and_terminalize(
        &self,
        graph: &GraphSpec,
        allocation: crate::cluster_ledger::DispatchAllocation,
        outcome_bytes: Vec<u8>,
    ) -> Result<TerminalResult, NativeExecutionError> {
        let outcome_digest = CanonicalDigest::of(&outcome_bytes);
        let settled = self
            .ledger
            .settle(
                command::settlement_key(allocation.run, allocation.execution)?,
                outcome_digest.as_bytes(),
                allocation.execution,
                outcome_digest,
                Some(outcome_bytes),
            )
            .await?;
        if !settled.value.accepted {
            return Err(NativeExecutionError::InvalidState);
        }
        let settled_state = self.ledger.state().await?;
        let reduction = self.reduce(&settled_state, graph).await?;
        let terminal = reduction
            .terminal
            .clone()
            .ok_or(NativeExecutionError::InvalidState)?;
        self.commit_terminal(&reduction).await?;
        Ok(terminal)
    }

    async fn commit_terminal(
        &self,
        reduction: &LegacyReduction,
    ) -> Result<(), NativeExecutionError> {
        let authorization = reduction
            .terminal_authorization()
            .ok_or(NativeExecutionError::InvalidState)?;
        self.ledger
            .terminalize_reduction(command::terminal_key(reduction.run())?, authorization)
            .await?;
        Ok(())
    }

    pub(crate) async fn terminal_result(
        &self,
    ) -> Result<Option<TerminalResult>, NativeExecutionError> {
        let state = self.ledger.state().await?;
        match state.terminal_outcome {
            Some(_) => self.terminal_result_from_state(&state).await.map(Some),
            None => Ok(None),
        }
    }

    async fn terminal_result_from_state(
        &self,
        state: &ReplayState,
    ) -> Result<TerminalResult, NativeExecutionError> {
        let admission = state
            .admission
            .as_ref()
            .ok_or(NativeExecutionError::InvalidState)?;
        let graph: GraphSpec = serde_json::from_slice(&admission.canonical_graph)
            .map_err(|_| NativeExecutionError::InvalidState)?;
        let reverify_artifact = terminal_program(&graph)?;
        let reduction = self.reduce(state, &graph).await?;
        let terminal = reduction
            .terminal
            .clone()
            .ok_or(NativeExecutionError::InvalidState)?;
        let bytes = validation::canonical_terminal_bytes(&terminal)?;
        if state.terminal_outcome != Some(CanonicalDigest::of(&bytes)) {
            return Err(NativeExecutionError::InvalidState);
        }
        if reverify_artifact {
            self.runtime.reverify_agent_terminal(&terminal).await?;
        }
        Ok(terminal)
    }

    async fn reduce(
        &self,
        state: &ReplayState,
        graph: &GraphSpec,
    ) -> Result<LegacyReduction, NativeExecutionError> {
        let admission = admission(state)?;
        let verified = self.reverify_graph(graph, admission).await?;
        let input = verified_initial_input(state, admission)?;
        let executions = durable_executions_from_replay(state, admission.run)
            .map_err(|_| NativeExecutionError::InvalidState)?;
        let reduction = FullV1Reducer::new(&verified)
            .reduce(ReductionInput {
                initial_input: &input,
                executions: &executions,
                next_node_instance: state.identities.next_node_instance,
                next_execution: state.identities.next_execution,
            })
            .map_err(|_| NativeExecutionError::InvalidState)?;
        let history_digest = durable_execution_history_digest(&executions)
            .map_err(|_| NativeExecutionError::InvalidState)?;
        let snapshot = state.reduction_snapshot();
        authorize_legacy_reduction(
            reduction,
            LegacyAuthorizationContext {
                run: admission.run,
                graph_digest: CanonicalDigest::of(&admission.canonical_compiled_ir),
                input_digest: admission.input_digest,
                history_digest,
                snapshot: snapshot.as_ref(),
            },
        )
        .map_err(|_| NativeExecutionError::InvalidState)
    }

    async fn reverify_graph(
        &self,
        graph: &GraphSpec,
        admission: &crate::cluster_ledger::replay::AdmissionState,
    ) -> Result<openengine_cluster_server::admission::VerifiedGraph, NativeExecutionError> {
        let verified = self
            .verifier
            .verify(graph)
            .await
            .map_err(|_| NativeExecutionError::Verification)?;
        let compiled = verified
            .compiled_ir
            .canonical_bytes()
            .map_err(|_| NativeExecutionError::InvalidState)?;
        let graph_bytes = canonical_value_bytes(
            &serde_json::to_value(graph).map_err(|_| NativeExecutionError::InvalidState)?,
        )
        .map_err(|_| NativeExecutionError::InvalidState)?;
        if compiled != admission.canonical_compiled_ir
            || CanonicalDigest::of(&graph_bytes) != admission.graph_digest
        {
            return Err(NativeExecutionError::InvalidState);
        }
        Ok(verified)
    }
}

async fn finish_workspace(
    authority: Option<AgentWorkspaceAuthority>,
) -> Result<(), NativeExecutionError> {
    let Some(authority) = authority else {
        return Ok(());
    };
    match authority.finish_effect().await {
        Ok(authority) => {
            drop(authority);
            Ok(())
        }
        Err(authority) => {
            authority.quarantine();
            Err(NativeExecutionError::InvalidState)
        }
    }
}

fn quarantine(authority: Option<AgentWorkspaceAuthority>) {
    if let Some(authority) = authority {
        authority.quarantine();
    }
}

fn terminal_program(graph: &GraphSpec) -> Result<bool, NativeExecutionError> {
    match classify_graph(graph) {
        Some(NativeProgram::Deterministic) => Ok(false),
        Some(NativeProgram::ForegroundAgent(AgentKind::CodexV1)) => Ok(true),
        Some(NativeProgram::ForegroundAgent(AgentKind::PiV1)) => Ok(false),
        Some(NativeProgram::WorkerFree) | None => Err(NativeExecutionError::InvalidState),
    }
}

pub(crate) fn codex_foreground_graph() -> GraphSpec {
    program::foreground_graph(AgentKind::CodexV1)
}

pub(crate) fn pi_foreground_graph() -> GraphSpec {
    program::foreground_graph(AgentKind::PiV1)
}

fn admission(
    state: &ReplayState,
) -> Result<&crate::cluster_ledger::replay::AdmissionState, NativeExecutionError> {
    state
        .admission
        .as_ref()
        .ok_or(NativeExecutionError::InvalidState)
}

fn verified_initial_input(
    state: &ReplayState,
    admission: &crate::cluster_ledger::replay::AdmissionState,
) -> Result<Value, NativeExecutionError> {
    let verified = state
        .verified_inputs
        .get(&admission.run)
        .ok_or(NativeExecutionError::InvalidState)?;
    if verified.digest != admission.input_digest
        || CanonicalDigest::of(&verified.canonical_bytes) != admission.input_digest
    {
        return Err(NativeExecutionError::InvalidState);
    }
    serde_json::from_slice(&verified.canonical_bytes)
        .map_err(|_| NativeExecutionError::InvalidState)
}

fn one_dispatch(
    reduction: &LegacyReduction,
) -> Result<(crate::native_v2_contract::ExecutionId, WorkerRef, Value), NativeExecutionError> {
    let mut dispatches = reduction
        .decisions
        .iter()
        .filter_map(|decision| match decision {
            Decision::Dispatch {
                execution,
                worker,
                input,
                ..
            } => Some((*execution, worker.clone(), input.clone())),
            _ => None,
        });
    let dispatch = dispatches
        .next()
        .ok_or(NativeExecutionError::InvalidState)?;
    if dispatches.next().is_some() {
        return Err(NativeExecutionError::InvalidState);
    }
    Ok(dispatch)
}
