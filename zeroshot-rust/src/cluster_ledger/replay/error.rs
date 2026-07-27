use super::super::record::RecordError;

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ReplayError {
    #[error("{0}")]
    Record(RecordError),
    #[error("public replay state encoding failed")]
    Encoding,
    #[error("replay position does not match coherent prefix")]
    PositionMismatch,
    #[error("replay counter overflow")]
    PositionOverflow,
    #[error("mutation receipt is corrupt")]
    ReceiptCorrupt,
    #[error("ledger record order is invalid")]
    InvalidOrder,
    #[error("settlement violates first-wins")]
    InvalidSettlement,
    #[error("persisted fault is not a safe engine fault")]
    UnsafeFault,
    #[error("run-scoped record follows terminal state")]
    PostTerminalRecord,
}

impl From<RecordError> for ReplayError {
    fn from(value: RecordError) -> Self {
        Self::Record(value)
    }
}
