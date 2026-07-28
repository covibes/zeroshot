#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum RecordError {
    #[error("durable identity is outside the supported range")]
    IdentityOutOfRange,
    #[error("record sequence is outside the supported range")]
    SequenceOutOfRange,
    #[error("record payload exceeds 1 MiB")]
    PayloadTooLarge,
    #[error("record payload encoding is invalid")]
    Encoding,
    #[error("record version is unknown")]
    UnknownVersion,
    #[error("record kind does not match its payload")]
    KindMismatch,
    #[error("record family does not match its kind")]
    FamilyMismatch,
    #[error("record payload is not canonically encoded")]
    NonCanonicalPayload,
    #[error("verified I/O digest does not match canonical bytes")]
    DigestMismatch,
    #[error("record resource does not match its ledger")]
    ResourceMismatch,
    #[error("record sequence is not contiguous")]
    SequenceGap,
    #[error("record previous hash does not match the prefix")]
    PreviousHashMismatch,
    #[error("record hash is invalid")]
    RecordHashMismatch,
}
