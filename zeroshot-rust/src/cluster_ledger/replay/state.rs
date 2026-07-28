use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::super::record::{
    CanonicalDigest, EffectId, ExecutionId, GenerationId, IdentityCounters, NodeInstanceId,
    RunSequence,
};
use super::super::store::{IdempotencyId, MutationReceipt, Position, ResourceId};
use super::ReplayError;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AdmissionState {
    pub generation: GenerationId,
    pub run: RunSequence,
    pub graph_digest: CanonicalDigest,
    pub input_digest: CanonicalDigest,
    pub policy_digest: CanonicalDigest,
    pub catalog_digest: CanonicalDigest,
    pub profile_digest: CanonicalDigest,
    pub absolute_deadline_ms: u64,
    pub canonical_graph: Vec<u8>,
    pub canonical_compiled_ir: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DispatchState {
    pub run: RunSequence,
    pub node_instance: NodeInstanceId,
    pub execution: ExecutionId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EffectState {
    pub run: RunSequence,
    pub effect: EffectId,
    pub request_digest: CanonicalDigest,
    pub receipt_digest: Option<CanonicalDigest>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct VerifiedValue {
    pub digest: CanonicalDigest,
    pub canonical_bytes: Vec<u8>,
    pub position: Position,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReplayState {
    pub resource: ResourceId,
    pub position: Position,
    pub last_hash: [u8; 32],
    pub identities: IdentityCounters,
    pub admission: Option<AdmissionState>,
    pub active_dispatches: BTreeMap<ExecutionId, DispatchState>,
    pub settlements: BTreeMap<ExecutionId, CanonicalDigest>,
    pub settlement_runs: BTreeMap<ExecutionId, RunSequence>,
    pub effects: BTreeMap<EffectId, EffectState>,
    pub verified_inputs: BTreeMap<RunSequence, VerifiedValue>,
    pub verified_outputs: BTreeMap<ExecutionId, VerifiedValue>,
    pub safe_faults: Vec<Vec<u8>>,
    pub terminal_outcome: Option<CanonicalDigest>,
    pub cleanup_receipts: Vec<CanonicalDigest>,
    pub mutation_receipts: BTreeMap<IdempotencyId, MutationReceipt>,
}

impl ReplayState {
    #[must_use]
    pub fn empty(resource: ResourceId) -> Self {
        Self {
            resource,
            position: Position::ZERO,
            last_hash: [0; 32],
            identities: IdentityCounters::initial(),
            admission: None,
            active_dispatches: BTreeMap::new(),
            settlements: BTreeMap::new(),
            settlement_runs: BTreeMap::new(),
            effects: BTreeMap::new(),
            verified_inputs: BTreeMap::new(),
            verified_outputs: BTreeMap::new(),
            safe_faults: Vec::new(),
            terminal_outcome: None,
            cleanup_receipts: Vec::new(),
            mutation_receipts: BTreeMap::new(),
        }
    }

    pub fn public_bytes(&self) -> Result<Vec<u8>, ReplayError> {
        serde_json::to_vec(self).map_err(|_| ReplayError::Encoding)
    }
}
