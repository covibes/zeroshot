use async_trait::async_trait;

use super::{WorkspaceLeaseError, WorkspaceLeaseId, WorkspaceLeaseRecord, WorkspaceLeaseState};
use crate::cluster_ledger::OwnerId;

pub mod fake;
pub mod sqlite;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CreateLeaseOutcome {
    Created(WorkspaceLeaseRecord),
    Existing(WorkspaceLeaseRecord),
}

#[derive(Clone, Debug)]
pub struct WorkspaceLeaseTransition {
    pub id: WorkspaceLeaseId,
    pub owner: OwnerId,
    pub expected_revision: u64,
    pub expected_state: WorkspaceLeaseState,
    pub next_state: WorkspaceLeaseState,
}

pub trait WorkspaceLeaseOperationGuard: Send {}

#[async_trait]
pub trait WorkspaceLeaseStore: Send + Sync {
    /// Serializes absence inspection and its following effect across store instances/processes.
    async fn acquire_operation(
        &self,
        id: &WorkspaceLeaseId,
        owner: &OwnerId,
    ) -> Result<Box<dyn WorkspaceLeaseOperationGuard>, WorkspaceLeaseError>;

    async fn load(
        &self,
        id: &WorkspaceLeaseId,
    ) -> Result<Option<WorkspaceLeaseRecord>, WorkspaceLeaseError>;

    /// Atomically persists the owner fence, stable mode inputs, and `CreatePending` before effects.
    async fn create_pending(
        &self,
        record: WorkspaceLeaseRecord,
    ) -> Result<CreateLeaseOutcome, WorkspaceLeaseError>;

    /// Owner-fenced compare-and-set. Implementations must not partially apply a transition.
    async fn transition(
        &self,
        request: WorkspaceLeaseTransition,
    ) -> Result<WorkspaceLeaseRecord, WorkspaceLeaseError>;
}
