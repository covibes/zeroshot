use std::collections::BTreeMap;

use openengine_cluster_protocol::{PositiveInteger, TerminalResult, WorkerRef};

use crate::cluster_ledger::record::{CanonicalDigest, ExecutionVoidReason, StructuralOccurrence};
use crate::cluster_ledger::{ExecutionId, NodeInstanceId, ReductionSnapshot, RunSequence};

use super::{Decision, ReducerError};

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

pub(super) struct AuthorizationContext<'a> {
    pub(super) run: RunSequence,
    pub(super) graph_digest: CanonicalDigest,
    pub(super) input_digest: CanonicalDigest,
    pub(super) history_digest: CanonicalDigest,
    pub(super) snapshot: Option<&'a ReductionSnapshot>,
}

pub(super) struct ReductionAuthorizations {
    pub(super) voids: BTreeMap<ExecutionId, ExecutionVoidAuthorization>,
    pub(super) dispatches: BTreeMap<ExecutionId, ReductionDispatchAuthorization>,
    pub(super) terminal: Option<ReductionTerminalAuthorization>,
}

pub(super) fn build(
    decisions: &[Decision],
    terminal: Option<&TerminalResult>,
    context: AuthorizationContext<'_>,
) -> Result<ReductionAuthorizations, ReducerError> {
    let Some(snapshot) = context.snapshot else {
        return Ok(empty());
    };
    let mut authorizations = empty();
    for decision in decisions {
        add_decision(&mut authorizations, decision, &context, snapshot)?;
    }
    authorizations.terminal = terminal
        .cloned()
        .map(|projection| ReductionTerminalAuthorization {
            run: context.run,
            projection,
            graph_digest: context.graph_digest,
            input_digest: context.input_digest,
            history_digest: context.history_digest,
            snapshot: snapshot.clone(),
        });
    Ok(authorizations)
}

fn empty() -> ReductionAuthorizations {
    ReductionAuthorizations {
        voids: BTreeMap::new(),
        dispatches: BTreeMap::new(),
        terminal: None,
    }
}

fn add_decision(
    authorizations: &mut ReductionAuthorizations,
    decision: &Decision,
    context: &AuthorizationContext<'_>,
    snapshot: &ReductionSnapshot,
) -> Result<(), ReducerError> {
    match decision {
        Decision::VoidLoser {
            run,
            execution,
            reason,
        } => {
            authorizations.voids.insert(
                *execution,
                ExecutionVoidAuthorization {
                    run: *run,
                    execution: *execution,
                    reason: *reason,
                    graph_digest: context.graph_digest,
                    input_digest: context.input_digest,
                    history_digest: context.history_digest,
                    snapshot: snapshot.clone(),
                },
            );
        }
        Decision::Dispatch {
            run,
            node_instance,
            execution,
            occurrence,
            attempt,
            worker,
            input,
        } => {
            let canonical_input = serde_json::to_vec(input).map_err(|_| ReducerError::Encoding)?;
            authorizations.dispatches.insert(
                *execution,
                ReductionDispatchAuthorization {
                    run: *run,
                    node_instance: *node_instance,
                    execution: *execution,
                    occurrence: occurrence.clone(),
                    attempt: *attempt,
                    worker: worker.clone(),
                    canonical_input,
                    graph_digest: context.graph_digest,
                    input_digest: context.input_digest,
                    history_digest: context.history_digest,
                    snapshot: snapshot.clone(),
                },
            );
        }
        Decision::Continue { .. } | Decision::Promote { .. } | Decision::Terminal { .. } => {}
    }
    Ok(())
}
