use std::error::Error;
use std::fmt;

use crate::fault::{
    EngineFault, EvidenceClass, FaultContext, FaultFactory, FaultModule, ModuleEvidence,
};
use crate::observability::ObservationSink;

use super::replay::ReplayError;
use super::store::StoreError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LedgerErrorKind {
    Storage(StoreError),
    Replay(ReplayError),
    BoundViolation,
    IdempotencyConflict,
    InvalidLifecycle,
    InvalidSettlement,
    TerminalRequired,
    ReceiptCorrupt,
    Encoding,
}

pub struct LedgerError {
    pub(super) kind: LedgerErrorKind,
    pub(super) fault: EngineFault,
}

impl LedgerError {
    #[must_use]
    pub const fn kind(&self) -> &LedgerErrorKind {
        &self.kind
    }

    #[must_use]
    pub const fn fault(&self) -> &EngineFault {
        &self.fault
    }
}

impl fmt::Debug for LedgerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LedgerError")
            .field("kind", &self.kind)
            .field("fault_code", &self.fault.code())
            .finish()
    }
}

impl fmt::Display for LedgerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "cluster ledger operation failed: {:?}",
            self.kind
        )
    }
}

impl Error for LedgerError {}

pub(super) fn map_store_error(
    observations: &dyn ObservationSink,
    context: FaultContext,
    error: StoreError,
) -> LedgerError {
    let class = match error {
        StoreError::BatchRecordBound
        | StoreError::BatchByteBound
        | StoreError::ReceiptTooLarge
        | StoreError::InvalidLimit
        | StoreError::PositionOverflow => EvidenceClass::ResourceExhausted,
        StoreError::FenceHeld | StoreError::FenceExpired | StoreError::StaleFence => {
            EvidenceClass::Unavailable
        }
        StoreError::ResourceNotFound | StoreError::ResourceExists => EvidenceClass::Unavailable,
        StoreError::Storage | StoreError::FailureInjected(_) => EvidenceClass::Unavailable,
        _ => EvidenceClass::IntegrityFailure,
    };
    let fault = FaultFactory::new(observations).create(ModuleEvidence::new(
        FaultModule::Storage,
        context,
        class,
    ));
    LedgerError {
        kind: LedgerErrorKind::Storage(error),
        fault,
    }
}
