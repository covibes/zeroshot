use serde::{Deserialize, Serialize};

use crate::fault::FaultContext;

use super::super::record::{CanonicalDigest, GenerationId, RecordPayload, RunSequence};
use super::super::store::IdempotencyId;
use super::super::{
    ClusterLedger, CommitRequest, LedgerError, LedgerErrorKind, MutationIdentity,
    ReceiptExpectation, ReplayState,
};
use super::CommitResult;

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

struct NextAdmission {
    if_generation: GenerationId,
    request: AdmissionRequest,
}

impl NextAdmission {
    #[must_use]
    const fn new(if_generation: GenerationId, request: AdmissionRequest) -> Self {
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
        self.commit(
            CommitRequest::new(
                FaultContext::Admission,
                &state,
                MutationIdentity::new(key, "admit", fingerprint),
                &response,
            )
            .with_payloads(admission_payloads(generation, run, request)),
        )
        .await
    }
}

fn admission_is_legal(state: &ReplayState, if_generation: Option<GenerationId>) -> bool {
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
