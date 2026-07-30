//! Durable, owner-fenced workspace lifecycle.
//!
//! Stable lease intent is stored before local effects. `CreatePending` and
//! `CleanupRequired` are deliberately uncertain states and can advance only from an
//! authoritative resource inspection. The module does not select credentials, mutate graph
//! outcomes, expose deletion, or implement a remote workspace service.

use std::fmt;

mod adapters;
mod borrowed;
mod manager;
mod resource;
mod store;
mod types;

pub use adapters::{
    BorrowedWorkspaceAdapter, DockerResourceRequest, DockerWorkspaceAdapter,
    DockerWorkspaceEffects, WorkspaceResourceRouter, WorktreeResourceRequest,
    WorktreeWorkspaceAdapter, WorktreeWorkspaceEffects,
};
pub use borrowed::{
    BorrowedWorkspaceFingerprintPort, FilesystemBorrowedWorkspaceFingerprint,
    FilesystemBorrowedWorkspaceFingerprintHooks,
};
pub use manager::{WorkspaceLeaseManager, WorkspaceLeaseOwnerRequest};
pub use resource::{WorkspaceResourceObservation, WorkspaceResourcePort};
pub use store::{
    sqlite::{SqliteWorkspaceLeaseHooks, SqliteWorkspaceLeaseStore},
    CreateLeaseOutcome, WorkspaceLeaseOperationGuard, WorkspaceLeaseStore,
    WorkspaceLeaseTransition,
};
pub use types::{
    BorrowedWorkspace, CanonicalWorkspaceRoot, DockerImageDigest, DockerMount, DockerMountHandleId,
    DockerResourceId, DockerWorkspace, PrepareWorkspaceRequest, WorkspaceFingerprint,
    WorkspaceIsolation, WorkspaceLeaseId, WorkspaceLeaseKey, WorkspaceLeaseRecord,
    WorkspaceLeaseState, WorkspaceMaterializationId, WorkspaceMode, WorkspaceName,
    WorkspaceProductRootHooks, WorkspaceProductRoots, WorkspaceProfile, WorktreeWorkspace,
};

pub mod fake {
    pub use super::resource::fake::{FakeEffectFailure, FakeResourceAction, FakeWorkspaceResourcePort};
    pub use super::store::fake::FakeWorkspaceLeaseStore;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceLeaseErrorKind {
    InvalidInput,
    NotFound,
    OwnerMismatch,
    ResourceMismatch,
    Conflict,
    StoreUnavailable,
    ResourceUnavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceLeaseError {
    pub(crate) kind: WorkspaceLeaseErrorKind,
    pub(crate) message: String,
}

impl WorkspaceLeaseError {
    pub(crate) fn new(kind: WorkspaceLeaseErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new(WorkspaceLeaseErrorKind::InvalidInput, message)
    }

    #[must_use]
    pub const fn kind(&self) -> WorkspaceLeaseErrorKind {
        self.kind
    }
}

impl fmt::Display for WorkspaceLeaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for WorkspaceLeaseError {}
