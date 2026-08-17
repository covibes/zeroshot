use serde_json::Value;

use crate::fault::FaultContext;
use super::reducer_authorization::{
    durable_execution_history_digest, durable_executions_from_replay,
    ReductionDispatchAuthorization, ReductionDispatchAuthorizationParts,
    ReductionTerminalAuthorization, ReductionTerminalAuthorizationParts,
};

use super::super::record::{CanonicalDigest, NodeInstanceId, RecordPayload, RunSequence};
use super::super::store::IdempotencyId;
use super::super::{ClusterLedger, LedgerError, LedgerErrorKind, ReplayState};
use super::{CommitResult, DispatchAllocation};
#[cfg(debug_assertions)]
use super::ReductionDispatchRequest;
use crate::cluster_ledger::{CommitRequest, MutationIdentity, ReceiptExpectation};

impl ClusterLedger {
    pub async fn dispatch_reduction(
        &self,
        key: IdempotencyId,
        authorization: ReductionDispatchAuthorization,
    ) -> Result<CommitResult<DispatchAllocation>, LedgerError> {
        let mut state = self.validated_state(FaultContext::Execution).await?;
        let authorized = authorization.parts();
        let fingerprint = reducer_dispatch_fingerprint(self, &authorized)?;
        if let Some(receipt) = self.existing_reducer_dispatch(&state, &key, fingerprint)? {
            return Ok(receipt);
        }
        let run = validate_authorization(self, &state, &authorized)?;
        let response = allocate_authorized(self, &mut state, run, &authorized)?;
        self.commit(reducer_dispatch_commit(
            &state,
            &response,
            ReducerDispatchCommitData {
                key,
                fingerprint,
                occurrence: authorized.occurrence.clone(),
                attempt: authorized.attempt,
                canonical_input: authorized.canonical_input.to_vec(),
            },
        ))
        .await
    }

    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub async fn dispatch_reduction_fixture(
        &self,
        key: IdempotencyId,
        fingerprint: [u8; 32],
        request: ReductionDispatchRequest,
    ) -> Result<CommitResult<DispatchAllocation>, LedgerError> {
        let mut state = self.validated_state(FaultContext::Execution).await?;
        if let Some(receipt) = self.existing_reducer_dispatch(&state, &key, fingerprint)? {
            return Ok(receipt);
        }
        let run = fixture_run(self, &state, &request.canonical_input)?;
        let (node_instance, execution) = allocate_dispatch_identity(
            self,
            &mut state,
            run,
            DispatchAttempt {
                occurrence: &request.occurrence,
                attempt: request.attempt,
            },
        )?;
        let response = DispatchAllocation {
            run,
            node_instance,
            execution,
        };
        self.commit(reducer_dispatch_commit(
            &state,
            &response,
            ReducerDispatchCommitData {
                key,
                fingerprint,
                occurrence: request.occurrence,
                attempt: request.attempt,
                canonical_input: request.canonical_input,
            },
        ))
        .await
    }

    fn existing_reducer_dispatch(
        &self,
        state: &ReplayState,
        key: &IdempotencyId,
        fingerprint: [u8; 32],
    ) -> Result<Option<CommitResult<DispatchAllocation>>, LedgerError> {
        self.existing_receipt(
            state,
            key,
            ReceiptExpectation::new(FaultContext::Execution, "reducer_dispatch", fingerprint),
        )
    }

    pub async fn terminalize_reduction(
        &self,
        key: IdempotencyId,
        authorization: ReductionTerminalAuthorization,
    ) -> Result<CommitResult<CanonicalDigest>, LedgerError> {
        let state = self.validated_state(FaultContext::Settlement).await?;
        let authorized = authorization.parts();
        let (outcome_digest, fingerprint) = terminal_digests(self, &authorized)?;
        if let Some(receipt) = self.existing_receipt(
            &state,
            &key,
            ReceiptExpectation::new(FaultContext::Settlement, "reducer_terminal", fingerprint),
        )? {
            return Ok(receipt);
        }
        let run = validate_terminal_authorization(self, &state, &authorized)?;
        self.commit(
            CommitRequest::new(
                FaultContext::Settlement,
                &state,
                MutationIdentity::new(key, "reducer_terminal", fingerprint),
                &outcome_digest,
            )
            .with_payloads(vec![RecordPayload::Terminal {
                run,
                outcome_digest,
            }]),
        )
        .await
    }
}

fn terminal_digests(
    ledger: &ClusterLedger,
    authorized: &ReductionTerminalAuthorizationParts<'_>,
) -> Result<(CanonicalDigest, [u8; 32]), LedgerError> {
    let value = serde_json::to_value(authorized.projection)
        .map_err(|_| ledger.domain_error(FaultContext::Settlement, LedgerErrorKind::Encoding))?;
    let bytes = openengine_cluster_protocol::canonical_value_bytes(&value)
        .map_err(|_| ledger.domain_error(FaultContext::Settlement, LedgerErrorKind::Encoding))?;
    let fingerprint_bytes = serde_json::to_vec(&(
        authorized.run,
        authorized.projection,
        authorized.graph_digest,
        authorized.input_digest,
        authorized.history_digest,
    ))
    .map_err(|_| ledger.domain_error(FaultContext::Settlement, LedgerErrorKind::Encoding))?;
    Ok((
        CanonicalDigest::of(&bytes),
        CanonicalDigest::of(&fingerprint_bytes).as_bytes(),
    ))
}

fn validate_terminal_authorization(
    ledger: &ClusterLedger,
    state: &ReplayState,
    authorized: &ReductionTerminalAuthorizationParts<'_>,
) -> Result<RunSequence, LedgerError> {
    let admission = state
        .admission
        .as_ref()
        .ok_or_else(|| invalid_settlement(ledger))?;
    let durable = durable_executions_from_replay(state, admission.run)
        .map_err(|_| invalid_settlement(ledger))?;
    let history =
        durable_execution_history_digest(&durable).map_err(|_| invalid_settlement(ledger))?;
    let authority_matches = [
        state.terminal_outcome.is_none(),
        authorized.run == admission.run,
        authorized.graph_digest == CanonicalDigest::of(&admission.canonical_compiled_ir),
        authorized.input_digest == admission.input_digest,
        authorized.history_digest == history,
        authorized
            .snapshot
            .matches(state, &ledger.reduction_authority),
        state
            .effects
            .values()
            .all(|effect| effect.receipt_digest.is_some()),
    ]
    .into_iter()
    .all(|matches| matches);
    if !authority_matches {
        return Err(invalid_settlement(ledger));
    }
    Ok(admission.run)
}

fn reducer_dispatch_fingerprint(
    ledger: &ClusterLedger,
    authorized: &ReductionDispatchAuthorizationParts<'_>,
) -> Result<[u8; 32], LedgerError> {
    let bytes = serde_json::to_vec(&(
        authorized.run,
        authorized.node_instance,
        authorized.execution,
        authorized.occurrence,
        authorized.attempt,
        authorized.worker,
        authorized.canonical_input,
        authorized.graph_digest,
        authorized.input_digest,
        authorized.history_digest,
    ))
    .map_err(|_| ledger.domain_error(FaultContext::Execution, LedgerErrorKind::Encoding))?;
    Ok(CanonicalDigest::of(&bytes).as_bytes())
}

fn validate_authorization(
    ledger: &ClusterLedger,
    state: &ReplayState,
    authorized: &ReductionDispatchAuthorizationParts<'_>,
) -> Result<RunSequence, LedgerError> {
    let admission = state.admission.as_ref().ok_or_else(|| invalid(ledger))?;
    let durable =
        durable_executions_from_replay(state, admission.run).map_err(|_| invalid(ledger))?;
    let history = durable_execution_history_digest(&durable).map_err(|_| invalid(ledger))?;
    let identity_matches = [
        state.terminal_outcome.is_none(),
        authorized.run == admission.run,
        authorized.graph_digest == CanonicalDigest::of(&admission.canonical_compiled_ir),
        authorized.input_digest == admission.input_digest,
        authorized.history_digest == history,
        authorized
            .snapshot
            .matches(state, &ledger.reduction_authority),
        is_canonical_json(authorized.canonical_input),
    ]
    .into_iter()
    .all(|matches| matches);
    if !identity_matches {
        return Err(invalid(ledger));
    }
    Ok(admission.run)
}

fn allocate_authorized(
    ledger: &ClusterLedger,
    state: &mut ReplayState,
    run: RunSequence,
    authorized: &ReductionDispatchAuthorizationParts<'_>,
) -> Result<DispatchAllocation, LedgerError> {
    let (node_instance, execution) = allocate_dispatch_identity(
        ledger,
        state,
        run,
        DispatchAttempt {
            occurrence: authorized.occurrence,
            attempt: authorized.attempt,
        },
    )?;
    if node_instance != authorized.node_instance || execution != authorized.execution {
        return Err(invalid(ledger));
    }
    Ok(DispatchAllocation {
        run,
        node_instance,
        execution,
    })
}

struct DispatchAttempt<'a> {
    occurrence: &'a super::super::record::StructuralOccurrence,
    attempt: openengine_cluster_protocol::PositiveInteger,
}

fn allocate_dispatch_identity(
    ledger: &ClusterLedger,
    state: &mut ReplayState,
    run: RunSequence,
    dispatch: DispatchAttempt<'_>,
) -> Result<(NodeInstanceId, super::super::ExecutionId), LedgerError> {
    let previous = state
        .execution_contexts
        .values()
        .filter(|context| context.run == run && context.occurrence == *dispatch.occurrence)
        .max_by_key(|context| context.attempt)
        .map(|context| (context.attempt, context.execution, context.node_instance));
    let node_instance = expected_node_instance(ledger, state, previous, dispatch.attempt)?;
    let execution = state
        .identities
        .allocate_execution()
        .map_err(|_| bound_violation(ledger))?;
    Ok((node_instance, execution))
}

fn expected_node_instance(
    ledger: &ClusterLedger,
    state: &mut ReplayState,
    previous: Option<(
        openengine_cluster_protocol::PositiveInteger,
        super::super::ExecutionId,
        NodeInstanceId,
    )>,
    attempt: openengine_cluster_protocol::PositiveInteger,
) -> Result<NodeInstanceId, LedgerError> {
    match previous {
        Some((previous_attempt, execution, node_instance))
            if attempt.get() == previous_attempt.get() + 1
                && state.settlements.contains_key(&execution) =>
        {
            Ok(node_instance)
        }
        None if attempt.get() == 1 => state
            .identities
            .allocate_node_instance()
            .map_err(|_| bound_violation(ledger)),
        Some(_) | None => Err(invalid(ledger)),
    }
}

struct ReducerDispatchCommitData {
    key: IdempotencyId,
    fingerprint: [u8; 32],
    occurrence: super::super::record::StructuralOccurrence,
    attempt: openengine_cluster_protocol::PositiveInteger,
    canonical_input: Vec<u8>,
}

fn reducer_dispatch_commit<'a>(
    state: &'a ReplayState,
    response: &'a DispatchAllocation,
    data: ReducerDispatchCommitData,
) -> CommitRequest<'a, DispatchAllocation> {
    CommitRequest::new(
        FaultContext::Execution,
        state,
        MutationIdentity::new(data.key, "reducer_dispatch", data.fingerprint),
        response,
    )
    .with_payloads(vec![
        RecordPayload::Dispatch {
            run: response.run,
            node_instance: response.node_instance,
            execution: response.execution,
        },
        RecordPayload::ExecutionContext {
            run: response.run,
            node_instance: response.node_instance,
            execution: response.execution,
            occurrence: data.occurrence,
            attempt: data.attempt,
            canonical_input: data.canonical_input,
        },
    ])
}

#[cfg(debug_assertions)]
fn fixture_run(
    ledger: &ClusterLedger,
    state: &ReplayState,
    canonical_input: &[u8],
) -> Result<RunSequence, LedgerError> {
    let admission = state.admission.as_ref().ok_or_else(|| invalid(ledger))?;
    if state.terminal_outcome.is_some() || !is_canonical_json(canonical_input) {
        return Err(invalid(ledger));
    }
    Ok(admission.run)
}

fn is_canonical_json(bytes: &[u8]) -> bool {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| serde_json::to_vec(&value).ok())
        .as_deref()
        == Some(bytes)
}

fn invalid(ledger: &ClusterLedger) -> LedgerError {
    ledger.domain_error(FaultContext::Execution, LedgerErrorKind::InvalidLifecycle)
}

fn bound_violation(ledger: &ClusterLedger) -> LedgerError {
    ledger.domain_error(FaultContext::Execution, LedgerErrorKind::BoundViolation)
}

fn invalid_settlement(ledger: &ClusterLedger) -> LedgerError {
    ledger.domain_error(FaultContext::Settlement, LedgerErrorKind::InvalidLifecycle)
}
