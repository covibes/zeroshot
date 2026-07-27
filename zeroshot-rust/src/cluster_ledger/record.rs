use std::marker::PhantomData;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use super::store::{MutationReceipt, Position, ResourceId};

mod error;
mod payload;

pub use error::RecordError;

pub const RECORD_VERSION_V1: u16 = 1;
pub const MAX_RECORD_PAYLOAD_BYTES: usize = 1024 * 1024;
pub const MAX_APPEND_RECORDS: usize = 1_024;
pub const MAX_APPEND_BATCH_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RANGE_RECORDS: usize = 4_096;
const HASH_DOMAIN: &[u8] = b"openengine.cluster-ledger.record/v1\0";

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct DurableId<K> {
    value: u64,
    #[serde(skip)]
    kind: PhantomData<K>,
}

impl<K> DurableId<K> {
    pub fn new(value: u64) -> Result<Self, RecordError> {
        if value == 0 || value > i64::MAX as u64 {
            return Err(RecordError::IdentityOutOfRange);
        }
        Ok(Self {
            value,
            kind: PhantomData,
        })
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.value
    }

    pub fn checked_next(self) -> Result<Self, RecordError> {
        Self::new(
            self.value
                .checked_add(1)
                .ok_or(RecordError::IdentityOutOfRange)?,
        )
    }
}

impl<'de, K> Deserialize<'de> for DurableId<K> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(u64::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum GenerationIdentity {}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum RunIdentity {}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum NodeInstanceIdentity {}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ExecutionIdentity {}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum EffectIdentity {}

pub type GenerationId = DurableId<GenerationIdentity>;
pub type RunSequence = DurableId<RunIdentity>;
pub type NodeInstanceId = DurableId<NodeInstanceIdentity>;
pub type ExecutionId = DurableId<ExecutionIdentity>;
pub type EffectId = DurableId<EffectIdentity>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct IdentityCounters {
    pub next_generation: u64,
    pub next_run: u64,
    pub next_node_instance: u64,
    pub next_execution: u64,
    pub next_effect: u64,
}

impl Default for IdentityCounters {
    fn default() -> Self {
        Self::initial()
    }
}

impl IdentityCounters {
    #[must_use]
    pub const fn initial() -> Self {
        Self {
            next_generation: 1,
            next_run: 1,
            next_node_instance: 1,
            next_execution: 1,
            next_effect: 1,
        }
    }

    pub fn allocate_generation(&mut self) -> Result<GenerationId, RecordError> {
        let value = GenerationId::new(self.next_generation)?;
        self.next_generation = checked_counter(self.next_generation)?;
        Ok(value)
    }

    pub fn allocate_run(&mut self) -> Result<RunSequence, RecordError> {
        let value = RunSequence::new(self.next_run)?;
        self.next_run = checked_counter(self.next_run)?;
        Ok(value)
    }

    pub fn allocate_node_instance(&mut self) -> Result<NodeInstanceId, RecordError> {
        let value = NodeInstanceId::new(self.next_node_instance)?;
        self.next_node_instance = checked_counter(self.next_node_instance)?;
        Ok(value)
    }

    pub fn allocate_execution(&mut self) -> Result<ExecutionId, RecordError> {
        let value = ExecutionId::new(self.next_execution)?;
        self.next_execution = checked_counter(self.next_execution)?;
        Ok(value)
    }

    pub fn allocate_effect(&mut self) -> Result<EffectId, RecordError> {
        let value = EffectId::new(self.next_effect)?;
        self.next_effect = checked_counter(self.next_effect)?;
        Ok(value)
    }
}

fn checked_counter(value: u64) -> Result<u64, RecordError> {
    let next = value
        .checked_add(1)
        .ok_or(RecordError::IdentityOutOfRange)?;
    if next > i64::MAX as u64 {
        return Err(RecordError::IdentityOutOfRange);
    }
    Ok(next)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct CanonicalDigest([u8; 32]);

impl CanonicalDigest {
    #[must_use]
    pub const fn new(value: [u8; 32]) -> Self {
        Self(value)
    }

    #[must_use]
    pub fn of(bytes: &[u8]) -> Self {
        Self(Sha256::digest(bytes).into())
    }

    #[must_use]
    pub const fn as_bytes(self) -> [u8; 32] {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordFamily {
    Control,
    VerifiedIo,
}

impl RecordFamily {
    const fn tag(self) -> u8 {
        match self {
            Self::Control => 1,
            Self::VerifiedIo => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[repr(u8)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    Admission = 1,
    Dispatch = 2,
    Settlement = 3,
    SafeFault = 4,
    EffectIntent = 5,
    EffectReceipt = 6,
    Terminal = 7,
    CleanupReceipt = 8,
    VerifiedInput = 9,
    VerifiedOutput = 10,
    MutationReceipt = 11,
}

impl RecordKind {
    const fn tag(self) -> u8 {
        self as u8
    }

    #[must_use]
    pub const fn family(self) -> RecordFamily {
        match self {
            Self::VerifiedInput | Self::VerifiedOutput => RecordFamily::VerifiedIo,
            _ => RecordFamily::Control,
        }
    }

    #[must_use]
    pub const fn allowed_after_terminal(self) -> bool {
        matches!(self, Self::CleanupReceipt | Self::MutationReceipt)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RecordPayload {
    Admission {
        generation: GenerationId,
        run: RunSequence,
        graph_digest: CanonicalDigest,
        input_digest: CanonicalDigest,
        policy_digest: CanonicalDigest,
        catalog_digest: CanonicalDigest,
        profile_digest: CanonicalDigest,
        absolute_deadline_ms: u64,
        canonical_graph: Vec<u8>,
        canonical_compiled_ir: Vec<u8>,
    },
    Dispatch {
        run: RunSequence,
        node_instance: NodeInstanceId,
        execution: ExecutionId,
    },
    Settlement {
        run: RunSequence,
        execution: ExecutionId,
        outcome_digest: CanonicalDigest,
        accepted: bool,
    },
    SafeFault {
        run: RunSequence,
        execution: Option<ExecutionId>,
        encoded_fault: Vec<u8>,
    },
    EffectIntent {
        run: RunSequence,
        effect: EffectId,
        request_digest: CanonicalDigest,
    },
    EffectReceipt {
        run: RunSequence,
        effect: EffectId,
        receipt_digest: CanonicalDigest,
    },
    Terminal {
        run: RunSequence,
        outcome_digest: CanonicalDigest,
    },
    CleanupReceipt {
        cleanup_digest: CanonicalDigest,
    },
    VerifiedInput {
        run: RunSequence,
        digest: CanonicalDigest,
        canonical_bytes: Vec<u8>,
    },
    VerifiedOutput {
        run: RunSequence,
        execution: ExecutionId,
        digest: CanonicalDigest,
        canonical_bytes: Vec<u8>,
    },
    MutationReceipt {
        receipt: MutationReceipt,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredRecord {
    pub resource: ResourceId,
    pub sequence: Position,
    pub family: RecordFamily,
    pub kind: RecordKind,
    pub version: u16,
    pub payload: Vec<u8>,
    pub previous_hash: [u8; 32],
    pub record_hash: [u8; 32],
}

impl StoredRecord {
    pub fn build(
        resource: ResourceId,
        sequence: Position,
        payload: &RecordPayload,
        previous_hash: [u8; 32],
    ) -> Result<Self, RecordError> {
        if sequence == Position::ZERO {
            return Err(RecordError::SequenceOutOfRange);
        }
        let kind = payload.kind();
        let family = kind.family();
        let payload = payload.canonical_bytes()?;
        let record_hash = calculate_record_hash(RecordHashInput {
            resource: &resource,
            sequence,
            family,
            kind,
            version: RECORD_VERSION_V1,
            payload: &payload,
            previous_hash,
        });
        Ok(Self {
            resource,
            sequence,
            family,
            kind,
            version: RECORD_VERSION_V1,
            payload,
            previous_hash,
            record_hash,
        })
    }

    pub fn validate(
        &self,
        expected_resource: &ResourceId,
        expected_sequence: Position,
        expected_previous_hash: [u8; 32],
    ) -> Result<RecordPayload, RecordError> {
        if &self.resource != expected_resource {
            return Err(RecordError::ResourceMismatch);
        }
        if self.sequence != expected_sequence {
            return Err(RecordError::SequenceGap);
        }
        if self.version != RECORD_VERSION_V1 {
            return Err(RecordError::UnknownVersion);
        }
        if self.family != self.kind.family() {
            return Err(RecordError::FamilyMismatch);
        }
        if self.previous_hash != expected_previous_hash {
            return Err(RecordError::PreviousHashMismatch);
        }
        let calculated = calculate_record_hash(RecordHashInput {
            resource: &self.resource,
            sequence: self.sequence,
            family: self.family,
            kind: self.kind,
            version: self.version,
            payload: &self.payload,
            previous_hash: self.previous_hash,
        });
        if self.record_hash != calculated {
            return Err(RecordError::RecordHashMismatch);
        }
        RecordPayload::decode(self.kind, self.version, &self.payload)
    }

    #[must_use]
    pub fn encoded_len(&self) -> usize {
        self.payload
            .len()
            .checked_add(self.resource.as_str().len())
            .and_then(|length| length.checked_add(96))
            .unwrap_or(usize::MAX)
    }
}

struct RecordHashInput<'a> {
    resource: &'a ResourceId,
    sequence: Position,
    family: RecordFamily,
    kind: RecordKind,
    version: u16,
    payload: &'a [u8],
    previous_hash: [u8; 32],
}

fn calculate_record_hash(input: RecordHashInput<'_>) -> [u8; 32] {
    let payload_digest = Sha256::digest(input.payload);
    let mut hasher = Sha256::new();
    hasher.update(HASH_DOMAIN);
    hasher.update((input.resource.as_str().len() as u64).to_be_bytes());
    hasher.update(input.resource.as_str().as_bytes());
    hasher.update(input.sequence.get().to_be_bytes());
    hasher.update([input.family.tag()]);
    hasher.update([input.kind.tag()]);
    hasher.update(input.version.to_be_bytes());
    hasher.update(payload_digest);
    hasher.update(input.previous_hash);
    hasher.finalize().into()
}
