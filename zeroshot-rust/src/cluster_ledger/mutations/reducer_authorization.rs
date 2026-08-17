//! Temporary compatibility adapter for the legacy cluster ledger.
//!
//! Native-v2 must not use this module. It translates the reducer's neutral history and decisions
//! into the old snapshot-bound mutation authorizations until the legacy ledger is deleted.

use std::collections::BTreeMap;
use std::ops::Deref;

use openengine_cluster_protocol::{PositiveInteger, TerminalResult, WorkerOutcome, WorkerRef};
use serde_json::Value;

use crate::full_v1_reducer::{
    Decision, DurableExecution, DurableExecutionState, ExecutionId as ReducerExecutionId,
    ExecutionVoidReason as ReducerVoidReason, HistoryPosition,
    NodeInstanceId as ReducerNodeInstanceId, ReducerError, Reduction,
    StructuralOccurrence as ReducerOccurrence,
};
use crate::full_v1_reducer::validate_history;

use super::super::record::{
    CanonicalDigest, ExecutionId, ExecutionVoidReason, NodeInstanceId, RunSequence,
    StructuralOccurrence,
};
use super::super::replay::ReplayState;
use super::super::ReductionSnapshot;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionVoidAuthorization {
    run: RunSequence,
    execution: ExecutionId,
    reason: ExecutionVoidReason,
    graph_digest: CanonicalDigest,
    input_digest: CanonicalDigest,
    history_digest: CanonicalDigest,
    snapshot: ReductionSnapshot,
}

impl ExecutionVoidAuthorization {
    pub(crate) fn parts(
        &self,
    ) -> (
        RunSequence,
        ExecutionId,
        ExecutionVoidReason,
        CanonicalDigest,
        CanonicalDigest,
        CanonicalDigest,
        &ReductionSnapshot,
    ) {
        (
            self.run,
            self.execution,
            self.reason,
            self.graph_digest,
            self.input_digest,
            self.history_digest,
            &self.snapshot,
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReductionDispatchAuthorization {
    run: RunSequence,
    node_instance: NodeInstanceId,
    execution: ExecutionId,
    occurrence: StructuralOccurrence,
    attempt: PositiveInteger,
    worker: WorkerRef,
    canonical_input: Vec<u8>,
    graph_digest: CanonicalDigest,
    input_digest: CanonicalDigest,
    history_digest: CanonicalDigest,
    snapshot: ReductionSnapshot,
}

pub(crate) struct ReductionDispatchAuthorizationParts<'a> {
    pub(crate) run: RunSequence,
    pub(crate) node_instance: NodeInstanceId,
    pub(crate) execution: ExecutionId,
    pub(crate) occurrence: &'a StructuralOccurrence,
    pub(crate) attempt: PositiveInteger,
    pub(crate) worker: &'a WorkerRef,
    pub(crate) canonical_input: &'a [u8],
    pub(crate) graph_digest: CanonicalDigest,
    pub(crate) input_digest: CanonicalDigest,
    pub(crate) history_digest: CanonicalDigest,
    pub(crate) snapshot: &'a ReductionSnapshot,
}

impl ReductionDispatchAuthorization {
    pub(crate) fn parts(&self) -> ReductionDispatchAuthorizationParts<'_> {
        ReductionDispatchAuthorizationParts {
            run: self.run,
            node_instance: self.node_instance,
            execution: self.execution,
            occurrence: &self.occurrence,
            attempt: self.attempt,
            worker: &self.worker,
            canonical_input: &self.canonical_input,
            graph_digest: self.graph_digest,
            input_digest: self.input_digest,
            history_digest: self.history_digest,
            snapshot: &self.snapshot,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReductionTerminalAuthorization {
    run: RunSequence,
    projection: TerminalResult,
    graph_digest: CanonicalDigest,
    input_digest: CanonicalDigest,
    history_digest: CanonicalDigest,
    snapshot: ReductionSnapshot,
}

pub(crate) struct ReductionTerminalAuthorizationParts<'a> {
    pub(crate) run: RunSequence,
    pub(crate) projection: &'a TerminalResult,
    pub(crate) graph_digest: CanonicalDigest,
    pub(crate) input_digest: CanonicalDigest,
    pub(crate) history_digest: CanonicalDigest,
    pub(crate) snapshot: &'a ReductionSnapshot,
}

impl ReductionTerminalAuthorization {
    pub(crate) fn parts(&self) -> ReductionTerminalAuthorizationParts<'_> {
        ReductionTerminalAuthorizationParts {
            run: self.run,
            projection: &self.projection,
            graph_digest: self.graph_digest,
            input_digest: self.input_digest,
            history_digest: self.history_digest,
            snapshot: &self.snapshot,
        }
    }
}

pub(crate) struct LegacyReduction {
    run: RunSequence,
    reduction: Reduction,
    voids: BTreeMap<ReducerExecutionId, ExecutionVoidAuthorization>,
    dispatches: BTreeMap<ReducerExecutionId, ReductionDispatchAuthorization>,
    terminal_authorization: Option<ReductionTerminalAuthorization>,
}

impl Deref for LegacyReduction {
    type Target = Reduction;

    fn deref(&self) -> &Self::Target {
        &self.reduction
    }
}

impl LegacyReduction {
    #[must_use]
    pub(crate) const fn run(&self) -> RunSequence {
        self.run
    }

    pub(crate) fn ledger_execution(
        &self,
        execution: ReducerExecutionId,
    ) -> Result<ExecutionId, ReducerError> {
        ExecutionId::new(execution.get()).map_err(|_| ReducerError::IdentityOutOfRange)
    }

    #[must_use]
    #[allow(
        dead_code,
        reason = "used only by legacy parallel-join fixtures until task X"
    )]
    pub(crate) fn void_authorization(
        &self,
        execution: ReducerExecutionId,
    ) -> Option<ExecutionVoidAuthorization> {
        self.voids.get(&execution).cloned()
    }

    #[must_use]
    pub(crate) fn dispatch_authorization(
        &self,
        execution: ReducerExecutionId,
    ) -> Option<ReductionDispatchAuthorization> {
        self.dispatches.get(&execution).cloned()
    }

    #[must_use]
    pub(crate) fn terminal_authorization(&self) -> Option<ReductionTerminalAuthorization> {
        self.terminal_authorization.clone()
    }
}

pub(crate) struct LegacyAuthorizationContext<'a> {
    pub(crate) run: RunSequence,
    pub(crate) graph_digest: CanonicalDigest,
    pub(crate) input_digest: CanonicalDigest,
    pub(crate) history_digest: CanonicalDigest,
    pub(crate) snapshot: Option<&'a ReductionSnapshot>,
}

pub(crate) fn authorize_legacy_reduction(
    reduction: Reduction,
    context: LegacyAuthorizationContext<'_>,
) -> Result<LegacyReduction, ReducerError> {
    let mut legacy = LegacyReduction {
        run: context.run,
        reduction,
        voids: BTreeMap::new(),
        dispatches: BTreeMap::new(),
        terminal_authorization: None,
    };
    let Some(snapshot) = context.snapshot else {
        return Ok(legacy);
    };
    for decision in &legacy.reduction.decisions {
        match decision {
            Decision::VoidLoser { execution, reason } => {
                legacy.voids.insert(
                    *execution,
                    ExecutionVoidAuthorization {
                        run: context.run,
                        execution: ledger_execution(*execution)?,
                        reason: ledger_void_reason(*reason),
                        graph_digest: context.graph_digest,
                        input_digest: context.input_digest,
                        history_digest: context.history_digest,
                        snapshot: snapshot.clone(),
                    },
                );
            }
            Decision::Dispatch {
                node_instance,
                execution,
                occurrence,
                attempt,
                worker,
                input,
            } => {
                legacy.dispatches.insert(
                    *execution,
                    ReductionDispatchAuthorization {
                        run: context.run,
                        node_instance: ledger_node_instance(*node_instance)?,
                        execution: ledger_execution(*execution)?,
                        occurrence: ledger_occurrence(occurrence),
                        attempt: *attempt,
                        worker: worker.clone(),
                        canonical_input: serde_json::to_vec(input)
                            .map_err(|_| ReducerError::Encoding)?,
                        graph_digest: context.graph_digest,
                        input_digest: context.input_digest,
                        history_digest: context.history_digest,
                        snapshot: snapshot.clone(),
                    },
                );
            }
            Decision::Continue { .. } | Decision::Promote { .. } | Decision::Terminal { .. } => {}
        }
    }
    legacy.terminal_authorization =
        legacy
            .reduction
            .terminal
            .clone()
            .map(|projection| ReductionTerminalAuthorization {
                run: context.run,
                projection,
                graph_digest: context.graph_digest,
                input_digest: context.input_digest,
                history_digest: context.history_digest,
                snapshot: snapshot.clone(),
            });
    Ok(legacy)
}

pub(crate) fn durable_executions_from_replay(
    state: &ReplayState,
    run: RunSequence,
) -> Result<Vec<DurableExecution>, ReducerError> {
    let mut executions = Vec::with_capacity(state.execution_contexts.len());
    for context in state
        .execution_contexts
        .values()
        .filter(|context| context.run == run)
    {
        let input: Value = serde_json::from_slice(&context.canonical_input)
            .map_err(|_| ReducerError::InconsistentHistory)?;
        let execution_state = durable_execution_state(state, context.execution)?;
        executions.push(DurableExecution {
            dispatch_position: history_position(context.position)?,
            node_instance: ReducerNodeInstanceId::new(context.node_instance.get())
                .map_err(|_| ReducerError::IdentityOutOfRange)?,
            execution: ReducerExecutionId::new(context.execution.get())
                .map_err(|_| ReducerError::IdentityOutOfRange)?,
            occurrence: reducer_occurrence(&context.occurrence),
            attempt: context.attempt,
            input,
            state: execution_state,
        });
    }
    executions.sort_by_key(|execution| execution.dispatch_position);
    validate_history(&executions)?;
    Ok(executions)
}

fn durable_execution_state(
    state: &ReplayState,
    execution: ExecutionId,
) -> Result<DurableExecutionState, ReducerError> {
    if let Some(voided) = state.execution_voids.get(&execution) {
        return Ok(DurableExecutionState::Voided {
            position: history_position(voided.position)?,
            reason: reducer_void_reason(voided.reason),
        });
    }
    if state.settlements.contains_key(&execution) {
        let output = state
            .verified_outputs
            .get(&execution)
            .ok_or(ReducerError::InconsistentHistory)?;
        let outcome: WorkerOutcome = serde_json::from_slice(&output.canonical_bytes)
            .map_err(|_| ReducerError::InconsistentHistory)?;
        return Ok(DurableExecutionState::Settled {
            position: history_position(output.position)?,
            outcome,
        });
    }
    if state.active_dispatches.contains_key(&execution) {
        return Ok(DurableExecutionState::Active);
    }
    Err(ReducerError::InconsistentHistory)
}

pub(crate) fn durable_execution_history_digest(
    executions: &[DurableExecution],
) -> Result<CanonicalDigest, ReducerError> {
    let mut ordered = executions.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|execution| execution.execution);
    let bytes = serde_json::to_vec(&ordered).map_err(|_| ReducerError::Encoding)?;
    Ok(CanonicalDigest::of(&bytes))
}

fn history_position(
    position: super::super::store::Position,
) -> Result<HistoryPosition, ReducerError> {
    HistoryPosition::new(position.get()).map_err(|_| ReducerError::InconsistentHistory)
}

fn reducer_occurrence(value: &StructuralOccurrence) -> ReducerOccurrence {
    ReducerOccurrence {
        node: value.node.clone(),
        map_indices: value.map_indices.clone(),
    }
}

fn ledger_occurrence(value: &ReducerOccurrence) -> StructuralOccurrence {
    StructuralOccurrence {
        node: value.node.clone(),
        map_indices: value.map_indices.clone(),
    }
}

const fn reducer_void_reason(value: ExecutionVoidReason) -> ReducerVoidReason {
    match value {
        ExecutionVoidReason::ParallelJoin => ReducerVoidReason::ParallelJoin,
        ExecutionVoidReason::MapTerminal => ReducerVoidReason::MapTerminal,
    }
}

const fn ledger_void_reason(value: ReducerVoidReason) -> ExecutionVoidReason {
    match value {
        ReducerVoidReason::ParallelJoin => ExecutionVoidReason::ParallelJoin,
        ReducerVoidReason::MapTerminal => ExecutionVoidReason::MapTerminal,
    }
}

fn ledger_execution(value: ReducerExecutionId) -> Result<ExecutionId, ReducerError> {
    ExecutionId::new(value.get()).map_err(|_| ReducerError::IdentityOutOfRange)
}

fn ledger_node_instance(value: ReducerNodeInstanceId) -> Result<NodeInstanceId, ReducerError> {
    NodeInstanceId::new(value.get()).map_err(|_| ReducerError::IdentityOutOfRange)
}
