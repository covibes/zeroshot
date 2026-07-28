use serde::{Deserialize, Serialize};

mod effects;

use crate::fault::{EngineFault, FaultContext};

use super::record::{
    CanonicalDigest, EffectId, ExecutionId, GenerationId, NodeInstanceId, RecordPayload,
    RunSequence,
};
use super::store::{IdempotencyId, Position};
use super::{
    ClusterLedger, CommitRequest, LedgerError, LedgerErrorKind, MutationIdentity,
    ReceiptExpectation,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdmissionRequest {
    pub graph_digest: CanonicalDigest,
    pub input_digest: CanonicalDigest,
    pub policy_digest: CanonicalDigest,
    pub catalog_digest: CanonicalDigest,
    pub profile_digest: CanonicalDigest,
    pub absolute_deadline_ms: u64,
    pub verified_input: Vec<u8>,
    pub canonical_graph: Vec<u8>,
    pub canonical_compiled_ir: Vec<u8>,
}

pub(crate) struct NextAdmission {
    pub if_generation: GenerationId,
    pub request: AdmissionRequest,
}

impl NextAdmission {
    #[must_use]
    pub(crate) const fn new(if_generation: GenerationId, request: AdmissionRequest) -> Self {
        Self {
            if_generation,
            request,
        }
    }
}

struct AdmissionCas {
    if_generation: Option<GenerationId>,
    request: AdmissionRequest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AdmissionAllocation {
    pub generation: GenerationId,
    pub run: RunSequence,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DispatchAllocation {
    pub run: RunSequence,
    pub node_instance: NodeInstanceId,
    pub execution: ExecutionId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SettlementResult {
    pub execution: ExecutionId,
    pub accepted: bool,
    pub authoritative_digest: CanonicalDigest,
}

pub(crate) struct SettlementRequest {
    pub execution: ExecutionId,
    pub outcome_digest: CanonicalDigest,
    pub verified_output: Option<Vec<u8>>,
}

impl SettlementRequest {
    #[must_use]
    pub(crate) const fn new(
        execution: ExecutionId,
        outcome_digest: CanonicalDigest,
        verified_output: Option<Vec<u8>>,
    ) -> Self {
        Self {
            execution,
            outcome_digest,
            verified_output,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EffectIntentResult {
    pub effect: EffectId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SafeFaultResult {
    pub execution: Option<ExecutionId>,
    pub terminal: bool,
    pub outcome_digest: CanonicalDigest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CommitResult<T> {
    pub value: T,
    pub position: Position,
    pub replayed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SafeFaultConsequence {
    Settle {
        execution: ExecutionId,
        outcome_digest: CanonicalDigest,
    },
    Terminal {
        outcome_digest: CanonicalDigest,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct EffectReconciliation {
    pub effect: EffectId,
    pub receipt_digest: CanonicalDigest,
}

impl EffectReconciliation {
    #[must_use]
    pub(crate) const fn new(effect: EffectId, receipt_digest: CanonicalDigest) -> Self {
        Self {
            effect,
            receipt_digest,
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct SafeFaultRecord<'a> {
    pub fault: &'a EngineFault,
    pub consequence: SafeFaultConsequence,
}

impl<'a> SafeFaultRecord<'a> {
    #[must_use]
    pub(crate) const fn new(fault: &'a EngineFault, consequence: SafeFaultConsequence) -> Self {
        Self { fault, consequence }
    }
}

fn admission_is_legal(state: &super::ReplayState, if_generation: Option<GenerationId>) -> bool {
    let generation_matches = match (if_generation, state.admission.as_ref()) {
        (None, None) => true,
        (Some(expected), Some(current)) => expected == current.generation,
        _ => false,
    };
    generation_matches
        && state.terminal_outcome.is_none()
        && state.active_dispatches.is_empty()
        && !state
            .effects
            .values()
            .any(|effect| effect.receipt_digest.is_none())
}

fn admission_request_is_canonical(request: &AdmissionRequest) -> bool {
    CanonicalDigest::of(&request.verified_input) == request.input_digest
        && (request.canonical_graph.is_empty()
            || CanonicalDigest::of(&request.canonical_graph) == request.graph_digest)
}

fn admission_payloads(
    generation: GenerationId,
    run: RunSequence,
    request: AdmissionRequest,
) -> Vec<RecordPayload> {
    vec![
        RecordPayload::Admission {
            generation,
            run,
            graph_digest: request.graph_digest,
            input_digest: request.input_digest,
            policy_digest: request.policy_digest,
            catalog_digest: request.catalog_digest,
            profile_digest: request.profile_digest,
            absolute_deadline_ms: request.absolute_deadline_ms,
            canonical_graph: request.canonical_graph,
            canonical_compiled_ir: request.canonical_compiled_ir,
        },
        RecordPayload::VerifiedInput {
            run,
            digest: request.input_digest,
            canonical_bytes: request.verified_input,
        },
    ]
}

fn settlement_payloads(
    run: RunSequence,
    request: SettlementRequest,
    accepted: bool,
) -> Vec<RecordPayload> {
    let SettlementRequest {
        execution,
        outcome_digest,
        verified_output,
    } = request;
    let mut payloads = vec![RecordPayload::Settlement {
        run,
        execution,
        outcome_digest,
        accepted,
    }];
    if accepted {
        if let Some(canonical_bytes) = verified_output {
            payloads.push(RecordPayload::VerifiedOutput {
                run,
                execution,
                digest: outcome_digest,
                canonical_bytes,
            });
        }
    }
    payloads
}

impl ClusterLedger {
    pub async fn admit(
        &self,
        key: IdempotencyId,
        fingerprint: [u8; 32],
        request: AdmissionRequest,
    ) -> Result<CommitResult<AdmissionAllocation>, LedgerError> {
        self.admit_cas(
            key,
            fingerprint,
            AdmissionCas {
                if_generation: None,
                request,
            },
        )
        .await
    }

    #[allow(clippy::too_many_arguments, reason = "frozen pre-6.7.2 public API")]
    pub async fn admit_next(
        &self,
        key: IdempotencyId,
        fingerprint: [u8; 32],
        if_generation: GenerationId,
        request: AdmissionRequest,
    ) -> Result<CommitResult<AdmissionAllocation>, LedgerError> {
        self.admit_next_request(key, fingerprint, NextAdmission::new(if_generation, request))
            .await
    }

    async fn admit_next_request(
        &self,
        key: IdempotencyId,
        fingerprint: [u8; 32],
        next: NextAdmission,
    ) -> Result<CommitResult<AdmissionAllocation>, LedgerError> {
        self.admit_cas(
            key,
            fingerprint,
            AdmissionCas {
                if_generation: Some(next.if_generation),
                request: next.request,
            },
        )
        .await
    }

    async fn admit_cas(
        &self,
        key: IdempotencyId,
        fingerprint: [u8; 32],
        admission: AdmissionCas,
    ) -> Result<CommitResult<AdmissionAllocation>, LedgerError> {
        let AdmissionCas {
            if_generation,
            request,
        } = admission;
        let mut state = self.validated_state(FaultContext::Admission).await?;
        if let Some(receipt) = self.existing_receipt(
            &state,
            &key,
            ReceiptExpectation::new(FaultContext::Admission, "admit", fingerprint),
        )? {
            return Ok(receipt);
        }
        if !admission_is_legal(&state, if_generation) {
            return Err(
                self.domain_error(FaultContext::Admission, LedgerErrorKind::InvalidLifecycle)
            );
        }
        if !admission_request_is_canonical(&request) {
            return Err(self.domain_error(FaultContext::Admission, LedgerErrorKind::Encoding));
        }
        let generation = state.identities.allocate_generation().map_err(|_| {
            self.domain_error(FaultContext::Admission, LedgerErrorKind::BoundViolation)
        })?;
        let run = state.identities.allocate_run().map_err(|_| {
            self.domain_error(FaultContext::Admission, LedgerErrorKind::BoundViolation)
        })?;
        let response = AdmissionAllocation { generation, run };
        let payloads = admission_payloads(generation, run, request);
        self.commit(
            CommitRequest::new(
                FaultContext::Admission,
                &state,
                MutationIdentity::new(key, "admit", fingerprint),
                &response,
            )
            .with_payloads(payloads),
        )
        .await
    }

    pub async fn dispatch(
        &self,
        key: IdempotencyId,
        fingerprint: [u8; 32],
    ) -> Result<CommitResult<DispatchAllocation>, LedgerError> {
        let mut state = self.validated_state(FaultContext::Execution).await?;
        if let Some(receipt) = self.existing_receipt(
            &state,
            &key,
            ReceiptExpectation::new(FaultContext::Execution, "dispatch", fingerprint),
        )? {
            return Ok(receipt);
        }
        let admission = state.admission.as_ref().ok_or_else(|| {
            self.domain_error(FaultContext::Execution, LedgerErrorKind::InvalidLifecycle)
        })?;
        if state.terminal_outcome.is_some() {
            return Err(
                self.domain_error(FaultContext::Execution, LedgerErrorKind::InvalidLifecycle)
            );
        }
        let run = admission.run;
        let node_instance = state.identities.allocate_node_instance().map_err(|_| {
            self.domain_error(FaultContext::Execution, LedgerErrorKind::BoundViolation)
        })?;
        let execution = state.identities.allocate_execution().map_err(|_| {
            self.domain_error(FaultContext::Execution, LedgerErrorKind::BoundViolation)
        })?;
        let response = DispatchAllocation {
            run,
            node_instance,
            execution,
        };
        self.commit(
            CommitRequest::new(
                FaultContext::Execution,
                &state,
                MutationIdentity::new(key, "dispatch", fingerprint),
                &response,
            )
            .with_payloads(vec![RecordPayload::Dispatch {
                run,
                node_instance,
                execution,
            }]),
        )
        .await
    }

    fn require_settleable(&self, state: &super::ReplayState) -> Result<(), LedgerError> {
        if state.admission.is_none() || state.terminal_outcome.is_some() {
            return Err(
                self.domain_error(FaultContext::Settlement, LedgerErrorKind::InvalidLifecycle)
            );
        }
        Ok(())
    }

    fn settlement_authority(
        &self,
        state: &super::ReplayState,
        execution: ExecutionId,
        outcome_digest: CanonicalDigest,
    ) -> Result<(RunSequence, bool, CanonicalDigest), LedgerError> {
        if let Some(dispatch) = state.active_dispatches.get(&execution) {
            return Ok((dispatch.run, true, outcome_digest));
        }
        let run = *state.settlement_runs.get(&execution).ok_or_else(|| {
            self.domain_error(FaultContext::Settlement, LedgerErrorKind::InvalidSettlement)
        })?;
        let authoritative_digest = *state.settlements.get(&execution).ok_or_else(|| {
            self.domain_error(FaultContext::Settlement, LedgerErrorKind::InvalidSettlement)
        })?;
        Ok((run, false, authoritative_digest))
    }

    #[allow(clippy::too_many_arguments, reason = "frozen pre-6.7.2 public API")]
    pub async fn settle(
        &self,
        key: IdempotencyId,
        fingerprint: [u8; 32],
        execution: ExecutionId,
        outcome_digest: CanonicalDigest,
        verified_output: Option<Vec<u8>>,
    ) -> Result<CommitResult<SettlementResult>, LedgerError> {
        self.settle_request(
            key,
            fingerprint,
            SettlementRequest::new(execution, outcome_digest, verified_output),
        )
        .await
    }

    async fn settle_request(
        &self,
        key: IdempotencyId,
        fingerprint: [u8; 32],
        request: SettlementRequest,
    ) -> Result<CommitResult<SettlementResult>, LedgerError> {
        let execution = request.execution;
        let outcome_digest = request.outcome_digest;
        let state = self.validated_state(FaultContext::Settlement).await?;
        if let Some(receipt) = self.existing_receipt(
            &state,
            &key,
            ReceiptExpectation::new(FaultContext::Settlement, "settle", fingerprint),
        )? {
            return Ok(receipt);
        }
        self.require_settleable(&state)?;
        if request
            .verified_output
            .as_ref()
            .is_some_and(|bytes| CanonicalDigest::of(bytes) != outcome_digest)
        {
            return Err(self.domain_error(FaultContext::Settlement, LedgerErrorKind::Encoding));
        }
        let (run, accepted, authoritative_digest) =
            self.settlement_authority(&state, execution, outcome_digest)?;
        let response = SettlementResult {
            execution,
            accepted,
            authoritative_digest,
        };
        let payloads = settlement_payloads(run, request, accepted);
        self.commit(
            CommitRequest::new(
                FaultContext::Settlement,
                &state,
                MutationIdentity::new(key, "settle", fingerprint),
                &response,
            )
            .with_payloads(payloads),
        )
        .await
    }
}
