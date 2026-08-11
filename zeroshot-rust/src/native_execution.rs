//! Product-private composition for the single deterministic native execution checkpoint.

use std::sync::Arc;

use openengine_cluster_protocol::{canonical_value_bytes, GraphSpec, TerminalResult, WorkerRef};
use openengine_cluster_server::admission::GraphVerifier;
use serde_json::Value;
use thiserror::Error;

#[path = "native_execution/process.rs"]
mod process;
#[path = "native_execution/program.rs"]
mod program;
#[path = "native_execution/validation.rs"]
mod validation;

pub(crate) use process::NativeExecutionProcess;
pub(crate) use program::{is_worker_free_graph, NativeExecutionRegistry, NativeGraphVerifier};
use program::is_deterministic_graph;

use crate::cluster_ledger::record::CanonicalDigest;
use crate::cluster_ledger::store::IdempotencyId;
use crate::cluster_ledger::{ClusterLedger, LedgerError, ReplayState};
use crate::execution::local::LocalExecutionRuntime;
use crate::execution::{
    BuiltinWorkerId, BuiltinWorkerRef, CatalogDigest, DispatchFence, ExecutionCommand,
    ExecutionCommandSpec, ExecutionInput, ExecutionRuntime, ExecutionTargetRef, ProfileDigest,
    RecoveryRef, RegistryDigest, SessionScope, WorkspaceAccessMode, WorkspaceAccessRef,
};
use crate::full_v1_reducer::{
    durable_executions_from_replay, Decision, FullV1Reducer, Reduction, ReductionInput,
};
use crate::native_admission::native_worker_protocol::{digest_hex, WORKER_REF};

#[derive(Clone)]
pub(crate) struct NativeExecutionCoordinator {
    ledger: ClusterLedger,
    verifier: Arc<NativeGraphVerifier>,
    registry: NativeExecutionRegistry,
    runtime: LocalExecutionRuntime,
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
    #[error("native execution ledger failed: {0}")]
    Ledger(#[from] LedgerError),
}

impl NativeExecutionCoordinator {
    pub(crate) fn new(
        ledger: ClusterLedger,
        verifier: Arc<NativeGraphVerifier>,
        registry: NativeExecutionRegistry,
        process: NativeExecutionProcess,
    ) -> Self {
        Self {
            ledger,
            verifier,
            registry,
            runtime: process::runtime(process),
            turn: Arc::new(tokio::sync::Mutex::new(())),
        }
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
        if !is_deterministic_graph(&graph) {
            return Ok(None);
        }
        Ok(Some((state, graph)))
    }

    async fn advance_reduction(
        &self,
        state: ReplayState,
        graph: GraphSpec,
        reduction: Reduction,
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
        reduction: &Reduction,
    ) -> Result<Option<TerminalResult>, NativeExecutionError> {
        let (execution, worker, input) = one_dispatch(reduction)?;
        let authorization = reduction
            .dispatch_authorization(execution)
            .ok_or(NativeExecutionError::InvalidState)?;
        let committed = self
            .ledger
            .dispatch_reduction(dispatch_key(reduction.run, execution)?, authorization)
            .await?;
        if committed.replayed {
            return Ok(None);
        }
        if worker.as_str() != WORKER_REF {
            return Err(NativeExecutionError::InvalidState);
        }
        let allocation = committed.value;
        let command = self.command(state, allocation.clone(), input)?;
        let observation = self.runtime.dispatch(command).await;
        let outcome_bytes =
            validation::validate_observation(&self.registry, &allocation, observation)?;
        self.settle_and_terminalize(graph, allocation, outcome_bytes)
            .await
            .map(Some)
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
                settlement_key(allocation.run, allocation.execution)?,
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

    async fn commit_terminal(&self, reduction: &Reduction) -> Result<(), NativeExecutionError> {
        let authorization = reduction
            .terminal_authorization()
            .ok_or(NativeExecutionError::InvalidState)?;
        self.ledger
            .terminalize_reduction(terminal_key(reduction.run)?, authorization)
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
        if !is_deterministic_graph(&graph) {
            return Err(NativeExecutionError::InvalidState);
        }
        let reduction = self.reduce(state, &graph).await?;
        let terminal = reduction
            .terminal
            .ok_or(NativeExecutionError::InvalidState)?;
        let bytes = canonical_terminal_bytes(&terminal)?;
        if state.terminal_outcome != Some(CanonicalDigest::of(&bytes)) {
            return Err(NativeExecutionError::InvalidState);
        }
        Ok(terminal)
    }

    async fn reduce(
        &self,
        state: &ReplayState,
        graph: &GraphSpec,
    ) -> Result<Reduction, NativeExecutionError> {
        let admission = admission(state)?;
        let verified = self.reverify_graph(graph, admission).await?;
        let input = verified_initial_input(state, admission)?;
        let executions = durable_executions_from_replay(state, admission.run)
            .map_err(|_| NativeExecutionError::InvalidState)?;
        FullV1Reducer::new(&verified)
            .reduce(ReductionInput {
                run: admission.run,
                snapshot: state.reduction_snapshot(),
                initial_input: &input,
                executions: &executions,
                next_node_instance: state.identities.next_node_instance,
                next_execution: state.identities.next_execution,
            })
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

    fn command(
        &self,
        state: &ReplayState,
        allocation: crate::cluster_ledger::DispatchAllocation,
        input: Value,
    ) -> Result<ExecutionCommand, NativeExecutionError> {
        let admission = admission(state)?;
        let (dispatch_fence, recovery_ref) = command_control_refs(&allocation)?;
        let (catalog_digest, profile_digest, registry_digest) =
            command_digests(admission, &self.registry)?;
        ExecutionCommand::new(ExecutionCommandSpec {
            cluster: state.resource.clone(),
            run: allocation.run,
            node_instance: allocation.node_instance,
            execution: allocation.execution,
            dispatch_fence,
            recovery_ref,
            target: command_target()?,
            catalog_digest,
            profile_digest,
            registry_digest,
            workspace: command_workspace(state)?,
            input: command_input(input)?,
            session_scope: SessionScope::Execution,
            execution_deadline_ms: admission.absolute_deadline_ms,
            session_deadline_ms: admission.absolute_deadline_ms,
        })
        .map_err(|_| NativeExecutionError::Contract)
    }
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

fn command_control_refs(
    allocation: &crate::cluster_ledger::DispatchAllocation,
) -> Result<(DispatchFence, RecoveryRef), NativeExecutionError> {
    let fence = DispatchFence::new(allocation.execution.get())
        .map_err(|_| NativeExecutionError::Contract)?;
    let recovery = RecoveryRef::new(format!(
        "native-run-{}-execution-{}",
        allocation.run.get(),
        allocation.execution.get()
    ))
    .map_err(|_| NativeExecutionError::Contract)?;
    Ok((fence, recovery))
}

fn command_target() -> Result<ExecutionTargetRef, NativeExecutionError> {
    let worker =
        BuiltinWorkerId::new("native.deterministic").map_err(|_| NativeExecutionError::Contract)?;
    let target = BuiltinWorkerRef::new(worker, 1).map_err(|_| NativeExecutionError::Contract)?;
    Ok(ExecutionTargetRef::Builtin(target))
}

fn command_digests(
    admission: &crate::cluster_ledger::replay::AdmissionState,
    registry: &NativeExecutionRegistry,
) -> Result<(CatalogDigest, ProfileDigest, RegistryDigest), NativeExecutionError> {
    let catalog = CatalogDigest::new(digest_hex(admission.catalog_digest))
        .map_err(|_| NativeExecutionError::Contract)?;
    let profile = ProfileDigest::new(digest_hex(admission.profile_digest))
        .map_err(|_| NativeExecutionError::Contract)?;
    let registry = RegistryDigest::new(digest_hex(registry.catalog_digest()))
        .map_err(|_| NativeExecutionError::Contract)?;
    Ok((catalog, profile, registry))
}

fn command_workspace(state: &ReplayState) -> Result<WorkspaceAccessRef, NativeExecutionError> {
    WorkspaceAccessRef::new(state.resource.clone(), WorkspaceAccessMode::Exclusive)
        .map_err(|_| NativeExecutionError::Contract)
}

fn command_input(input: Value) -> Result<ExecutionInput, NativeExecutionError> {
    let canonical =
        canonical_value_bytes(&input).map_err(|_| NativeExecutionError::InvalidState)?;
    let inline = String::from_utf8(canonical).map_err(|_| NativeExecutionError::InvalidState)?;
    ExecutionInput::inline(inline).map_err(|_| NativeExecutionError::Contract)
}

fn one_dispatch(
    reduction: &Reduction,
) -> Result<(crate::cluster_ledger::ExecutionId, WorkerRef, Value), NativeExecutionError> {
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

fn canonical_terminal_bytes(value: &TerminalResult) -> Result<Vec<u8>, NativeExecutionError> {
    canonical_value_bytes(
        &serde_json::to_value(value).map_err(|_| NativeExecutionError::InvalidState)?,
    )
    .map_err(|_| NativeExecutionError::InvalidState)
}

fn dispatch_key(
    run: crate::cluster_ledger::RunSequence,
    execution: crate::cluster_ledger::ExecutionId,
) -> Result<IdempotencyId, NativeExecutionError> {
    IdempotencyId::new(format!("native-dispatch-{}-{}", run.get(), execution.get()))
        .map_err(|_| NativeExecutionError::Contract)
}

fn settlement_key(
    run: crate::cluster_ledger::RunSequence,
    execution: crate::cluster_ledger::ExecutionId,
) -> Result<IdempotencyId, NativeExecutionError> {
    IdempotencyId::new(format!(
        "native-settlement-{}-{}",
        run.get(),
        execution.get()
    ))
    .map_err(|_| NativeExecutionError::Contract)
}

fn terminal_key(
    run: crate::cluster_ledger::RunSequence,
) -> Result<IdempotencyId, NativeExecutionError> {
    IdempotencyId::new(format!("native-terminal-{}", run.get()))
        .map_err(|_| NativeExecutionError::Contract)
}
