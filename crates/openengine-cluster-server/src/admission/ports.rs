//! Verifier, journal, verified-I/O, cancellation, and atomic aggregate ports.

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ApplyResult, ClusterStatus, CompiledGraphIr, Cursor, DeleteParams, DeleteResult, DispatchState,
    Generation, GraphDiagnostic, GraphSpec, IdempotencyKey, NoRetryableFrontierReason, Phase,
    RequestFingerprint, ResubmitParams, ResubmitResult, RunId,
};
use serde_json::Value;
use thiserror::Error;

use crate::lifecycle::{LifecycleSnapshot, LifecycleStore, MutationReceipt};

#[derive(Clone, Default)]
pub struct CancellationSignal(Arc<AtomicBool>);

impl CancellationSignal {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    #[must_use]
    pub fn observer(&self) -> CancellationObserver {
        CancellationObserver(Arc::clone(&self.0))
    }
}

impl fmt::Debug for CancellationSignal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CancellationSignal")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl PartialEq for CancellationSignal {
    fn eq(&self, other: &Self) -> bool {
        self.is_cancelled() == other.is_cancelled()
    }
}

impl Eq for CancellationSignal {}

/// Read-only cancellation state exposed to dispatch permit holders.
#[derive(Clone, Default)]
pub struct CancellationObserver(Arc<AtomicBool>);

impl CancellationObserver {
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

impl fmt::Debug for CancellationObserver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CancellationObserver")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl PartialEq for CancellationObserver {
    fn eq(&self, other: &Self) -> bool {
        self.is_cancelled() == other.is_cancelled()
    }
}

impl Eq for CancellationObserver {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedGraph {
    pub compiled_ir: CompiledGraphIr,
    pub diagnostics: Vec<GraphDiagnostic>,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum VerificationError {
    #[error("graph verification rejected the graph")]
    Rejected { diagnostics: Vec<GraphDiagnostic> },
    #[error("graph verifier failed internally: {0}")]
    Internal(String),
}

#[async_trait]
pub trait GraphVerifier: Send + Sync + 'static {
    async fn verify(&self, graph: &GraphSpec) -> Result<VerifiedGraph, VerificationError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlSnapshot {
    pub spec: Option<GraphSpec>,
    pub compiled_ir: Option<CompiledGraphIr>,
    pub generation: Option<Generation>,
    pub run_id: Option<RunId>,
    pub phase: Phase,
    pub cursor: Option<Cursor>,
}

impl Default for ControlSnapshot {
    fn default() -> Self {
        Self {
            spec: None,
            compiled_ir: None,
            generation: None,
            run_id: None,
            phase: Phase::Empty,
            cursor: None,
        }
    }
}

impl ControlSnapshot {
    #[must_use]
    pub fn status(&self) -> ClusterStatus {
        ClusterStatus {
            phase: self.phase,
            observed_generation: self.generation,
            current_run_id: self.run_id.clone(),
            at_cursor: self.cursor.clone(),
            operational: None,
        }
    }

    #[must_use]
    pub fn status_with_lifecycle(&self, lifecycle: &LifecycleSnapshot) -> ClusterStatus {
        ClusterStatus {
            phase: self.phase,
            observed_generation: self.generation,
            current_run_id: self.run_id.clone(),
            at_cursor: lifecycle
                .latest_cursor
                .clone()
                .or_else(|| self.cursor.clone()),
            operational: lifecycle.operational.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedSeed {
    pub run_id: RunId,
    pub input: Value,
    pub cursor: Cursor,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AdmissionSnapshot {
    pub control: ControlSnapshot,
    pub seed: Option<VerifiedSeed>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdempotencyRecord {
    pub fingerprint: RequestFingerprint,
    pub receipt: MutationReceipt,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CommitProposal {
    pub graph: GraphSpec,
    pub compiled_ir: CompiledGraphIr,
    pub input: Option<Value>,
    pub if_generation: Option<Generation>,
    pub idempotency_key: IdempotencyKey,
    pub fingerprint: RequestFingerprint,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResubmitProposal {
    pub params: ResubmitParams,
    pub fingerprint: RequestFingerprint,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DeleteProposal {
    pub params: DeleteParams,
    pub fingerprint: RequestFingerprint,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum StoreError {
    #[error("admission store failed: {0}")]
    Internal(String),
    #[error("idempotency key was already used with different parameters")]
    IdempotencyReuse,
    #[error("generation precondition failed")]
    GenerationConflict { current: Option<Generation> },
    #[error("run precondition failed")]
    RunConflict { current: Option<RunId> },
    #[error("cluster phase does not admit apply: {current:?}")]
    InvalidPhase { current: Phase },
    #[error("admission parameters violate the run-input contract: {0}")]
    SchemaViolation(String),
    #[error("admission was cancelled before atomic commit")]
    Cancelled,
    #[error("dispatch is denied while lifecycle state is {current:?}")]
    DispatchDenied { current: DispatchState },
    #[error("dispatch lease does not exist")]
    UnknownLease,
    #[error("dispatch completion was rejected because the lease is cancelled or terminal")]
    CompletionRejected,
    #[error("run does not exist")]
    UnknownRun,
    #[error("run history was deleted")]
    RunGone { tombstoned_at: Option<Cursor> },
    #[error("no retryable failed frontier is pending: {reason}")]
    NoRetryableFrontier { reason: NoRetryableFrontierReason },
}

/// Logical durable control-journal view.
#[async_trait]
pub trait ControlJournal: Send + Sync {
    async fn read_control(&self) -> Result<ControlSnapshot, StoreError>;
    async fn lookup_idempotency(
        &self,
        key: &IdempotencyKey,
    ) -> Result<Option<IdempotencyRecord>, StoreError>;
}

/// Logical durable verified-I/O view. Only verified root seed input exists in this slice.
#[async_trait]
pub trait VerifiedIoLedger: Send + Sync {
    async fn read_verified_seed(&self, run_id: &RunId) -> Result<Option<VerifiedSeed>, StoreError>;
}

/// Atomic aggregate port. Implementations allocate one ordering across both logical stores and
/// check cancellation immediately before writing any effect.
#[async_trait]
pub trait AdmissionStore:
    ControlJournal + VerifiedIoLedger + LifecycleStore + Send + Sync + 'static
{
    async fn read_snapshot(&self) -> Result<AdmissionSnapshot, StoreError>;
    async fn read_aggregate(&self) -> Result<(AdmissionSnapshot, LifecycleSnapshot), StoreError>;
    async fn commit(
        &self,
        proposal: CommitProposal,
        cancellation: &CancellationSignal,
    ) -> Result<ApplyResult, StoreError>;
    async fn resubmit(
        &self,
        proposal: ResubmitProposal,
        cancellation: &CancellationSignal,
    ) -> Result<ResubmitResult, StoreError>;
    async fn delete(
        &self,
        proposal: DeleteProposal,
        cancellation: &CancellationSignal,
    ) -> Result<DeleteResult, StoreError>;
}
