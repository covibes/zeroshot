use std::sync::Arc;

use zeroshot_engine::cluster_ledger::{ExecutionId, OwnerId, ResourceId, RunSequence};
use zeroshot_engine::execution::WorkspaceAccessMode;
use zeroshot_engine::source_code_provider::{
    CanonicalRepository, SourceAccountId, SourceBranchId, SourceProfileId, SourceProviderId,
    SourceProviderRef, SourceRepositoryId, SourceRevisionId,
};
use zeroshot_engine::workspace_lease::fake::{FakeWorkspaceLeaseStore, FakeWorkspaceResourcePort};
use zeroshot_engine::workspace_lease::{
    BorrowedWorkspace, CanonicalWorkspaceRoot, DockerImageDigest, DockerMountHandleId,
    DockerResourceId, DockerWorkspace, PrepareWorkspaceRequest, WorkspaceFingerprint,
    WorkspaceIsolation, WorkspaceLeaseKey, WorkspaceLeaseManager, WorkspaceMaterializationId,
    WorkspaceMode, WorkspaceName, WorkspaceProfile, WorktreeWorkspace,
};

pub struct LeaseFixture {
    pub store: Arc<FakeWorkspaceLeaseStore>,
    pub resources: Arc<FakeWorkspaceResourcePort>,
    pub manager: WorkspaceLeaseManager,
}

impl LeaseFixture {
    pub fn new() -> Self {
        let store = Arc::new(FakeWorkspaceLeaseStore::default());
        let resources = Arc::new(FakeWorkspaceResourcePort::default());
        let manager = WorkspaceLeaseManager::new(store.clone(), resources.clone());
        Self {
            store,
            resources,
            manager,
        }
    }
}

pub fn docker_request(owner: &str) -> PrepareWorkspaceRequest {
    PrepareWorkspaceRequest {
        key: lease_key(WorkspaceIsolation::Shared),
        owner: OwnerId::new(owner).unwrap(),
        access_mode: WorkspaceAccessMode::Exclusive,
        mode: WorkspaceMode::Docker(
            DockerWorkspace::new(
                DockerImageDigest::new(format!("sha256:{}", "a".repeat(64))).unwrap(),
                DockerResourceId::new("docker-resource-1").unwrap(),
                vec![DockerMountHandleId::new("workspace").unwrap()],
            )
            .unwrap(),
        ),
    }
}

pub fn borrowed_request(owner: &str) -> PrepareWorkspaceRequest {
    PrepareWorkspaceRequest {
        key: lease_key(WorkspaceIsolation::Shared),
        owner: OwnerId::new(owner).unwrap(),
        access_mode: WorkspaceAccessMode::ReadOnly,
        mode: WorkspaceMode::Borrowed(BorrowedWorkspace {
            canonical_root: CanonicalWorkspaceRoot::new("/tmp/borrowed-workspace").unwrap(),
            fingerprint: WorkspaceFingerprint::new("b".repeat(64)).unwrap(),
        }),
    }
}

pub fn worktree_request(owner: &str) -> PrepareWorkspaceRequest {
    PrepareWorkspaceRequest {
        key: lease_key(WorkspaceIsolation::Shared),
        owner: OwnerId::new(owner).unwrap(),
        access_mode: WorkspaceAccessMode::Exclusive,
        mode: WorkspaceMode::Worktree(WorktreeWorkspace {
            repository: CanonicalRepository::new(
                SourceProviderRef::new(SourceProviderId::new("source.github").unwrap(), 1).unwrap(),
                SourceProfileId::new("production").unwrap(),
                SourceAccountId::new("open-engine").unwrap(),
                SourceRepositoryId::new("the-open-engine/zeroshot").unwrap(),
            )
            .unwrap(),
            revision: SourceRevisionId::new("revision-abc").unwrap(),
            source_profile: SourceProfileId::new("production").unwrap(),
            name: WorkspaceName::new("workspace-test").unwrap(),
            branch: SourceBranchId::new("feat/677").unwrap(),
            profile: WorkspaceProfile::new("durable-worktree").unwrap(),
            materialization: WorkspaceMaterializationId::new("materialization-1").unwrap(),
        }),
    }
}

pub fn lease_key(isolation: WorkspaceIsolation) -> WorkspaceLeaseKey {
    WorkspaceLeaseKey {
        cluster: ResourceId::new("cluster.test").unwrap(),
        run: RunSequence::new(3).unwrap(),
        logical_key: ResourceId::new("logical.workspace").unwrap(),
        isolation,
    }
}

pub fn execution(value: u64) -> ExecutionId {
    ExecutionId::new(value).unwrap()
}
