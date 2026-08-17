//! Product-private artifact byte storage behind protocol-owned receipts.

use std::error::Error;
use std::fmt;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ArtifactId, ArtifactLineage, ArtifactProducer, ArtifactRef, ByteLength, MediaType,
    RedactionClass, Sha256Digest, TypeId,
};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::fault::{EvidenceClass, FaultContext, FaultModule, ModuleEvidence};

pub mod fake;
pub mod local_cas;

pub const MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;
const ARTIFACT_ID_DOMAIN: &str = "zeroshot-rust.artifact-ref/v1";

pub type ArtifactByteStream = Box<dyn AsyncRead + Send + Unpin>;
pub type VerifiedArtifactStream = Box<dyn AsyncRead + Send + Unpin>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactIntent {
    pub expected_sha256: Sha256Digest,
    pub expected_byte_length: ByteLength,
    pub media_type: MediaType,
    pub type_id: TypeId,
    pub producer: ArtifactProducer,
    pub lineage: ArtifactLineage,
    pub redaction: RedactionClass,
}

impl ArtifactIntent {
    pub fn artifact_ref(&self) -> Result<ArtifactRef, ArtifactStoreFailure> {
        Ok(ArtifactRef {
            artifact_id: derive_artifact_id(self)?,
            sha256: self.expected_sha256.clone(),
            byte_length: self.expected_byte_length,
            media_type: self.media_type.clone(),
            type_id: self.type_id.clone(),
            producer: self.producer.clone(),
            lineage: self.lineage.clone(),
            redaction: self.redaction,
        })
    }
}

/// Opaque, store-bound handle. Its debug form never reveals storage details.
pub struct StagedArtifact {
    store_key: usize,
    stage_key: u64,
    artifact_ref: ArtifactRef,
}

impl StagedArtifact {
    pub(crate) const fn new(store_key: usize, stage_key: u64, artifact_ref: ArtifactRef) -> Self {
        Self {
            store_key,
            stage_key,
            artifact_ref,
        }
    }

    pub(crate) const fn store_key(&self) -> usize {
        self.store_key
    }

    pub(crate) const fn stage_key(&self) -> u64 {
        self.stage_key
    }

    #[must_use]
    pub fn artifact_id(&self) -> &ArtifactId {
        &self.artifact_ref.artifact_id
    }

    pub(crate) fn artifact_ref(&self) -> &ArtifactRef {
        &self.artifact_ref
    }
}

impl fmt::Debug for StagedArtifact {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StagedArtifact")
            .field("artifact_id", &self.artifact_ref.artifact_id)
            .field("storage", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiscardResult {
    Discarded,
    AlreadyDiscarded,
    AlreadyPublished,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReleaseResult {
    Released,
    NotFound,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArtifactStoreOperation {
    Configuration,
    Stage,
    Publish,
    Inspect,
    Open,
    Discard,
    Release,
}

impl ArtifactStoreOperation {
    const fn fault_context(self) -> FaultContext {
        match self {
            Self::Configuration => FaultContext::Configuration,
            Self::Stage | Self::Publish => FaultContext::Settlement,
            Self::Inspect | Self::Open => FaultContext::Recovery,
            Self::Discard | Self::Release => FaultContext::Cleanup,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArtifactStoreFailureKind {
    Oversize,
    LengthMismatch,
    HashMismatch,
    RootUnavailable,
    LockUnavailable,
    Io(ArtifactStoreOperation),
    PermissionDenied(ArtifactStoreOperation),
    CorruptContent,
    MissingCommittedContent,
    IdentityConflict,
    InvalidStage,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ArtifactStoreFailure {
    kind: ArtifactStoreFailureKind,
}

impl ArtifactStoreFailure {
    #[must_use]
    pub const fn new(kind: ArtifactStoreFailureKind) -> Self {
        Self { kind }
    }

    #[must_use]
    pub const fn kind(self) -> ArtifactStoreFailureKind {
        self.kind
    }

    #[must_use]
    pub const fn module_evidence(self) -> ModuleEvidence {
        match self.kind {
            ArtifactStoreFailureKind::Oversize => ModuleEvidence::new(
                FaultModule::Worker,
                FaultContext::Settlement,
                EvidenceClass::ResourceExhausted,
            ),
            ArtifactStoreFailureKind::LengthMismatch | ArtifactStoreFailureKind::HashMismatch => {
                ModuleEvidence::new(
                    FaultModule::Worker,
                    FaultContext::Settlement,
                    EvidenceClass::MalformedExternalData,
                )
            }
            ArtifactStoreFailureKind::RootUnavailable
            | ArtifactStoreFailureKind::LockUnavailable => ModuleEvidence::new(
                FaultModule::Storage,
                FaultContext::Configuration,
                EvidenceClass::Unavailable,
            ),
            ArtifactStoreFailureKind::Io(operation) => ModuleEvidence::new(
                FaultModule::Storage,
                operation.fault_context(),
                EvidenceClass::Unavailable,
            ),
            ArtifactStoreFailureKind::PermissionDenied(operation) => ModuleEvidence::new(
                FaultModule::Storage,
                operation.fault_context(),
                EvidenceClass::PermissionDenied,
            ),
            ArtifactStoreFailureKind::CorruptContent
            | ArtifactStoreFailureKind::MissingCommittedContent
            | ArtifactStoreFailureKind::IdentityConflict
            | ArtifactStoreFailureKind::InvalidStage => ModuleEvidence::new(
                FaultModule::Storage,
                FaultContext::Recovery,
                EvidenceClass::IntegrityFailure,
            ),
        }
    }
}

impl fmt::Display for ArtifactStoreFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self.kind {
            ArtifactStoreFailureKind::Io(_) => "artifact storage operation is unavailable",
            ArtifactStoreFailureKind::PermissionDenied(_) => {
                "artifact storage operation lacks permission"
            }
            kind => simple_failure_message(kind),
        };
        formatter.write_str(message)
    }
}

const fn simple_failure_message(kind: ArtifactStoreFailureKind) -> &'static str {
    match kind {
        ArtifactStoreFailureKind::Oversize => "artifact exceeds the byte limit",
        ArtifactStoreFailureKind::LengthMismatch => "artifact length does not match intent",
        ArtifactStoreFailureKind::HashMismatch => "artifact digest does not match intent",
        ArtifactStoreFailureKind::RootUnavailable => "artifact store root is unavailable",
        ArtifactStoreFailureKind::LockUnavailable => "artifact store lock is unavailable",
        kind => integrity_failure_message(kind),
    }
}

const fn integrity_failure_message(kind: ArtifactStoreFailureKind) -> &'static str {
    match kind {
        ArtifactStoreFailureKind::CorruptContent => "committed artifact content is corrupt",
        ArtifactStoreFailureKind::MissingCommittedContent => {
            "committed artifact content is missing"
        }
        ArtifactStoreFailureKind::IdentityConflict => "artifact identity conflicts",
        ArtifactStoreFailureKind::InvalidStage => "artifact stage is invalid",
        _ => "artifact storage operation failed",
    }
}

impl Error for ArtifactStoreFailure {}

#[async_trait]
pub trait ArtifactStore: Send + Sync {
    async fn stage(
        &self,
        intent: ArtifactIntent,
        bytes: ArtifactByteStream,
    ) -> Result<StagedArtifact, ArtifactStoreFailure>;

    async fn publish(&self, staged: &StagedArtifact) -> Result<ArtifactRef, ArtifactStoreFailure>;

    async fn inspect(
        &self,
        artifact_id: &ArtifactId,
    ) -> Result<Option<ArtifactRef>, ArtifactStoreFailure>;

    async fn open(
        &self,
        artifact_id: &ArtifactId,
    ) -> Result<VerifiedArtifactStream, ArtifactStoreFailure>;

    async fn discard(&self, staged: &StagedArtifact)
    -> Result<DiscardResult, ArtifactStoreFailure>;

    async fn release(
        &self,
        artifact_id: &ArtifactId,
    ) -> Result<ReleaseResult, ArtifactStoreFailure>;
}

pub fn derive_artifact_id(intent: &ArtifactIntent) -> Result<ArtifactId, ArtifactStoreFailure> {
    let mut preimage = Vec::new();
    append_content_identity(&mut preimage, intent)?;
    append_producer_identity(&mut preimage, intent)?;
    append_lineage_identity(&mut preimage, intent)?;
    append_redaction_identity(&mut preimage, intent.redaction)?;
    ArtifactId::new(format!("cas-v1-{}", sha256_hex(&preimage)))
        .map_err(|_| ArtifactStoreFailure::new(ArtifactStoreFailureKind::CorruptContent))
}

fn append_content_identity(
    preimage: &mut Vec<u8>,
    intent: &ArtifactIntent,
) -> Result<(), ArtifactStoreFailure> {
    append_identity_field(preimage, ARTIFACT_ID_DOMAIN.as_bytes())?;
    append_identity_field(preimage, intent.expected_sha256.as_str().as_bytes())?;
    append_identity_field(
        preimage,
        intent.expected_byte_length.get().to_string().as_bytes(),
    )?;
    append_identity_field(preimage, intent.media_type.as_str().as_bytes())?;
    append_identity_field(preimage, intent.type_id.as_str().as_bytes())
}

fn append_producer_identity(
    preimage: &mut Vec<u8>,
    intent: &ArtifactIntent,
) -> Result<(), ArtifactStoreFailure> {
    append_identity_field(preimage, intent.producer.node.as_str().as_bytes())?;
    append_identity_field(preimage, intent.producer.worker.as_str().as_bytes())
}

fn append_lineage_identity(
    preimage: &mut Vec<u8>,
    intent: &ArtifactIntent,
) -> Result<(), ArtifactStoreFailure> {
    append_identity_field(
        preimage,
        intent.lineage.generation.get().to_string().as_bytes(),
    )?;
    append_identity_field(preimage, intent.lineage.run_id.as_str().as_bytes())?;
    append_identity_field(
        preimage,
        intent.lineage.attempt.get().to_string().as_bytes(),
    )
}

fn append_redaction_identity(
    preimage: &mut Vec<u8>,
    redaction: RedactionClass,
) -> Result<(), ArtifactStoreFailure> {
    append_identity_field(
        preimage,
        match redaction {
            RedactionClass::Public => b"public",
            RedactionClass::Internal => b"internal",
            RedactionClass::Confidential => b"confidential",
            RedactionClass::Restricted => b"restricted",
        },
    )
}

fn append_identity_field(preimage: &mut Vec<u8>, value: &[u8]) -> Result<(), ArtifactStoreFailure> {
    let length = u64::try_from(value.len())
        .map_err(|_| ArtifactStoreFailure::new(ArtifactStoreFailureKind::CorruptContent))?;
    preimage.extend_from_slice(&length.to_be_bytes());
    preimage.extend_from_slice(value);
    Ok(())
}

pub(crate) async fn read_verified_bytes(
    intent: &ArtifactIntent,
    mut bytes: ArtifactByteStream,
) -> Result<Vec<u8>, ArtifactStoreFailure> {
    let declared = intent.expected_byte_length.get();
    if declared > MAX_ARTIFACT_BYTES {
        return Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::Oversize,
        ));
    }

    let capacity = usize::try_from(declared)
        .map_err(|_| ArtifactStoreFailure::new(ArtifactStoreFailureKind::Oversize))?;
    let mut output = Vec::with_capacity(capacity);
    let mut limited = (&mut bytes).take(declared + 1);
    limited
        .read_to_end(&mut output)
        .await
        .map_err(|error| failure_from_io(error, ArtifactStoreOperation::Stage))?;
    if output.len() as u64 > declared {
        return Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::Oversize,
        ));
    }
    if output.len() as u64 != declared {
        return Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::LengthMismatch,
        ));
    }
    if sha256_hex(&output) != intent.expected_sha256.as_str() {
        return Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::HashMismatch,
        ));
    }
    Ok(output)
}

pub(crate) fn verify_bytes(
    artifact_ref: &ArtifactRef,
    bytes: &[u8],
) -> Result<(), ArtifactStoreFailure> {
    if bytes.len() as u64 != artifact_ref.byte_length.get()
        || sha256_hex(bytes) != artifact_ref.sha256.as_str()
    {
        return Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::CorruptContent,
        ));
    }
    Ok(())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    encode_hex(&digest)
}

pub(crate) fn encode_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for &byte in bytes {
        if let (Some(&high), Some(&low)) = (
            HEX.get(usize::from(byte >> 4)),
            HEX.get(usize::from(byte & 0x0f)),
        ) {
            output.push(char::from(high));
            output.push(char::from(low));
        }
    }
    output
}

pub(crate) fn failure_from_io(
    error: std::io::Error,
    operation: ArtifactStoreOperation,
) -> ArtifactStoreFailure {
    let kind = if error.kind() == std::io::ErrorKind::PermissionDenied {
        ArtifactStoreFailureKind::PermissionDenied(operation)
    } else {
        ArtifactStoreFailureKind::Io(operation)
    };
    ArtifactStoreFailure::new(kind)
}
