use async_trait::async_trait;

use super::{WorkspaceLeaseError, WorkspaceLeaseRecord};

pub mod fake;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceResourceObservation {
    Absent,
    /// Deterministic owned scaffolding exists, but delegated materialization is absent.
    CleanupRequired,
    Matching,
    Mismatch,
}

#[async_trait]
pub trait WorkspaceResourcePort: Send + Sync {
    /// Authoritative inspection must compare all persisted stable identity and the owner fence.
    async fn inspect(
        &self,
        lease: &WorkspaceLeaseRecord,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError>;

    /// Called only after an authoritative `Absent` observation for an owned workspace.
    async fn create(&self, lease: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError>;

    /// Called only for an authoritatively matching owned workspace.
    async fn cleanup(&self, lease: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError>;
}
