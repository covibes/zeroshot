use super::{CanonicalDigest, RecordError, RecordKind, RecordPayload, RECORD_VERSION_V1};

impl RecordPayload {
    #[must_use]
    pub const fn kind(&self) -> RecordKind {
        match self {
            Self::Admission { .. }
            | Self::Dispatch { .. }
            | Self::Settlement { .. }
            | Self::SafeFault { .. }
            | Self::EffectIntent { .. }
            | Self::EffectReceipt { .. } => self.active_kind(),
            Self::Terminal { .. }
            | Self::CleanupReceipt { .. }
            | Self::VerifiedInput { .. }
            | Self::VerifiedOutput { .. }
            | Self::MutationReceipt { .. } => self.final_kind(),
        }
    }

    const fn active_kind(&self) -> RecordKind {
        match self {
            Self::Admission { .. } => RecordKind::Admission,
            Self::Dispatch { .. } => RecordKind::Dispatch,
            Self::Settlement { .. } => RecordKind::Settlement,
            Self::SafeFault { .. } => RecordKind::SafeFault,
            Self::EffectIntent { .. } => RecordKind::EffectIntent,
            Self::EffectReceipt { .. } => RecordKind::EffectReceipt,
            _ => unreachable!(),
        }
    }

    const fn final_kind(&self) -> RecordKind {
        match self {
            Self::Terminal { .. } => RecordKind::Terminal,
            Self::CleanupReceipt { .. } => RecordKind::CleanupReceipt,
            Self::VerifiedInput { .. } => RecordKind::VerifiedInput,
            Self::VerifiedOutput { .. } => RecordKind::VerifiedOutput,
            Self::MutationReceipt { .. } => RecordKind::MutationReceipt,
            _ => unreachable!(),
        }
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, RecordError> {
        let encoded = serde_json::to_vec(self).map_err(|_| RecordError::Encoding)?;
        if encoded.len() > super::MAX_RECORD_PAYLOAD_BYTES {
            return Err(RecordError::PayloadTooLarge);
        }
        Ok(encoded)
    }

    pub fn decode(kind: RecordKind, version: u16, bytes: &[u8]) -> Result<Self, RecordError> {
        if version != RECORD_VERSION_V1 {
            return Err(RecordError::UnknownVersion);
        }
        if bytes.len() > super::MAX_RECORD_PAYLOAD_BYTES {
            return Err(RecordError::PayloadTooLarge);
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| RecordError::Encoding)?;
        if value.kind() != kind {
            return Err(RecordError::KindMismatch);
        }
        if value.canonical_bytes()? != bytes {
            return Err(RecordError::NonCanonicalPayload);
        }
        value.validate_verified_digest()?;
        value.validate_graph_digest()?;
        Ok(value)
    }

    fn validate_verified_digest(&self) -> Result<(), RecordError> {
        let digest_and_bytes = match self {
            Self::VerifiedInput {
                digest,
                canonical_bytes,
                ..
            }
            | Self::VerifiedOutput {
                digest,
                canonical_bytes,
                ..
            } => Some((*digest, canonical_bytes)),
            _ => None,
        };
        if digest_and_bytes.is_some_and(|(digest, bytes)| digest != CanonicalDigest::of(bytes)) {
            return Err(RecordError::DigestMismatch);
        }
        Ok(())
    }

    fn validate_graph_digest(&self) -> Result<(), RecordError> {
        let Self::Admission {
            graph_digest,
            canonical_graph,
            ..
        } = self
        else {
            return Ok(());
        };
        if !canonical_graph.is_empty() && *graph_digest != CanonicalDigest::of(canonical_graph) {
            return Err(RecordError::DigestMismatch);
        }
        Ok(())
    }
}
