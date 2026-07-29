use std::fs::File;
use std::sync::Arc;

use async_trait::async_trait;
use crate::source_code_provider::SourceMaterializationDestination;
use super::borrowed::{BorrowedWorkspaceFingerprintPort, FilesystemBorrowedWorkspaceFingerprint};

use super::{
    WorkspaceLeaseError, WorkspaceLeaseErrorKind, WorkspaceLeaseRecord, WorkspaceMode,
    WorkspaceResourceObservation, WorkspaceResourcePort,
};

use super::{DockerMount, WorkspaceProductRoots, WorktreeWorkspace};

/// Routes the three closed workspace modes to independently injectable local adapters.
#[derive(Clone)]
pub struct WorkspaceResourceRouter {
    borrowed: Arc<dyn WorkspaceResourcePort>,
    worktree: Arc<dyn WorkspaceResourcePort>,
    docker: Arc<dyn WorkspaceResourcePort>,
}

impl WorkspaceResourceRouter {
    #[must_use]
    pub fn new(
        borrowed: Arc<dyn WorkspaceResourcePort>,
        worktree: Arc<dyn WorkspaceResourcePort>,
        docker: Arc<dyn WorkspaceResourcePort>,
    ) -> Self {
        Self {
            borrowed,
            worktree,
            docker,
        }
    }

    fn port(&self, lease: &WorkspaceLeaseRecord) -> &dyn WorkspaceResourcePort {
        match lease.mode {
            WorkspaceMode::Borrowed(_) => self.borrowed.as_ref(),
            WorkspaceMode::Worktree(_) => self.worktree.as_ref(),
            WorkspaceMode::Docker(_) => self.docker.as_ref(),
        }
    }
}

#[async_trait]
impl WorkspaceResourcePort for WorkspaceResourceRouter {
    async fn inspect(
        &self,
        lease: &WorkspaceLeaseRecord,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError> {
        self.port(lease).inspect(lease).await
    }

    async fn create(&self, lease: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError> {
        self.port(lease).create(lease).await
    }

    async fn cleanup(&self, lease: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError> {
        self.port(lease).cleanup(lease).await
    }
}

/// Production borrowed-mode adapter. It verifies canonical root and exact content fingerprint.
#[derive(Clone)]
pub struct BorrowedWorkspaceAdapter {
    fingerprints: Arc<dyn BorrowedWorkspaceFingerprintPort>,
}

impl BorrowedWorkspaceAdapter {
    #[must_use]
    pub fn new(fingerprints: Arc<dyn BorrowedWorkspaceFingerprintPort>) -> Self {
        Self { fingerprints }
    }
}

impl Default for BorrowedWorkspaceAdapter {
    fn default() -> Self {
        Self::new(Arc::new(FilesystemBorrowedWorkspaceFingerprint))
    }
}

#[async_trait]
impl WorkspaceResourcePort for BorrowedWorkspaceAdapter {
    async fn inspect(
        &self,
        lease: &WorkspaceLeaseRecord,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError> {
        let WorkspaceMode::Borrowed(borrowed) = &lease.mode else {
            return Err(wrong_mode());
        };
        let root = borrowed.canonical_root.as_path();
        if !root.exists() {
            return Ok(WorkspaceResourceObservation::Absent);
        }
        let canonical = std::fs::canonicalize(root).map_err(|_| {
            WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::ResourceUnavailable,
                "borrowed workspace root could not be authoritatively inspected",
            )
        })?;
        if canonical != root {
            return Ok(WorkspaceResourceObservation::Mismatch);
        }
        let fingerprint = self.fingerprints.fingerprint(root)?;
        if fingerprint == borrowed.fingerprint {
            Ok(WorkspaceResourceObservation::Matching)
        } else {
            Ok(WorkspaceResourceObservation::Mismatch)
        }
    }

    async fn create(&self, _lease: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError> {
        Err(WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::Conflict,
            "borrowed workspaces cannot be created",
        ))
    }

    async fn cleanup(&self, _lease: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError> {
        Err(WorkspaceLeaseError::new(
            WorkspaceLeaseErrorKind::Conflict,
            "borrowed workspaces cannot be deleted",
        ))
    }
}

pub struct WorktreeResourceRequest<'a> {
    pub lease: &'a WorkspaceLeaseRecord,
    pub mode: &'a WorktreeWorkspace,
    pub root_directory: Arc<File>,
}

#[async_trait]
pub trait WorktreeWorkspaceEffects: Send + Sync {
    async fn inspect(
        &self,
        request: WorktreeResourceRequest<'_>,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError>;

    async fn create(
        &self,
        request: WorktreeResourceRequest<'_>,
        destination: SourceMaterializationDestination<'_>,
    ) -> Result<(), WorkspaceLeaseError>;

    async fn cleanup(
        &self,
        request: WorktreeResourceRequest<'_>,
    ) -> Result<(), WorkspaceLeaseError>;
}

#[derive(Clone)]
pub struct WorktreeWorkspaceAdapter {
    roots: WorkspaceProductRoots,
    effects: Arc<dyn WorktreeWorkspaceEffects>,
}

impl WorktreeWorkspaceAdapter {
    #[must_use]
    pub fn new(roots: WorkspaceProductRoots, effects: Arc<dyn WorktreeWorkspaceEffects>) -> Self {
        Self { roots, effects }
    }
}

#[async_trait]
impl WorkspaceResourcePort for WorktreeWorkspaceAdapter {
    async fn inspect(
        &self,
        lease: &WorkspaceLeaseRecord,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError> {
        let WorkspaceMode::Worktree(mode) = &lease.mode else {
            return Err(wrong_mode());
        };
        let Some(root_directory) = self.roots.inspect_worktree(&mode.name)? else {
            return Ok(WorkspaceResourceObservation::Absent);
        };
        if !self.roots.worktree_owned_by(&root_directory, lease)? {
            return Ok(WorkspaceResourceObservation::Mismatch);
        }
        let Some(workspace) = root_directory.workspace() else {
            return Ok(WorkspaceResourceObservation::CleanupRequired);
        };
        let observation = self
            .effects
            .inspect(WorktreeResourceRequest {
                lease,
                mode,
                root_directory: workspace.clone(),
            })
            .await?;
        Ok(match observation {
            WorkspaceResourceObservation::Absent => WorkspaceResourceObservation::CleanupRequired,
            observation => observation,
        })
    }

    async fn create(&self, lease: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError> {
        let WorkspaceMode::Worktree(mode) = &lease.mode else {
            return Err(wrong_mode());
        };
        let root_directory = self.roots.create_worktree(&mode.name, lease)?;
        let mut destination_root = self.roots.worktree_destination(&root_directory)?;
        let request = WorktreeResourceRequest {
            lease,
            mode,
            root_directory: root_directory
                .workspace()
                .expect("created worktree has a workspace directory")
                .clone(),
        };
        self.effects
            .create(
                request,
                SourceMaterializationDestination::new(&mut destination_root),
            )
            .await
    }

    async fn cleanup(&self, lease: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError> {
        let WorkspaceMode::Worktree(mode) = &lease.mode else {
            return Err(wrong_mode());
        };
        let Some(root_directory) = self.roots.inspect_worktree(&mode.name)? else {
            return Ok(());
        };
        if !self.roots.worktree_owned_by(&root_directory, lease)? {
            return Err(WorkspaceLeaseError::new(
                WorkspaceLeaseErrorKind::ResourceMismatch,
                "workspace worktree owner marker changed before cleanup",
            ));
        }
        if let Some(workspace) = root_directory.workspace() {
            self.effects
                .cleanup(WorktreeResourceRequest {
                    lease,
                    mode,
                    root_directory: workspace.clone(),
                })
                .await?;
        }
        self.roots
            .remove_worktree(&mode.name, &root_directory, lease)
    }
}

pub struct DockerResourceRequest<'a> {
    pub lease: &'a WorkspaceLeaseRecord,
    pub mounts: &'a [DockerMount],
}

#[async_trait]
pub trait DockerWorkspaceEffects: Send + Sync {
    async fn inspect(
        &self,
        request: DockerResourceRequest<'_>,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError>;
    async fn create(&self, request: DockerResourceRequest<'_>) -> Result<(), WorkspaceLeaseError>;
    async fn cleanup(&self, request: DockerResourceRequest<'_>) -> Result<(), WorkspaceLeaseError>;
}

#[derive(Clone)]
pub struct DockerWorkspaceAdapter {
    roots: WorkspaceProductRoots,
    effects: Arc<dyn DockerWorkspaceEffects>,
}

impl DockerWorkspaceAdapter {
    #[must_use]
    pub fn new(roots: WorkspaceProductRoots, effects: Arc<dyn DockerWorkspaceEffects>) -> Self {
        Self { roots, effects }
    }

    fn mounts(
        &self,
        lease: &WorkspaceLeaseRecord,
    ) -> Result<Vec<DockerMount>, WorkspaceLeaseError> {
        let WorkspaceMode::Docker(mode) = &lease.mode else {
            return Err(wrong_mode());
        };
        self.roots.default_docker_mounts(mode)
    }
}

#[async_trait]
impl WorkspaceResourcePort for DockerWorkspaceAdapter {
    async fn inspect(
        &self,
        lease: &WorkspaceLeaseRecord,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError> {
        let mounts = self.mounts(lease)?;
        self.effects
            .inspect(DockerResourceRequest {
                lease,
                mounts: &mounts,
            })
            .await
    }

    async fn create(&self, lease: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError> {
        let mounts = self.mounts(lease)?;
        self.effects
            .create(DockerResourceRequest {
                lease,
                mounts: &mounts,
            })
            .await
    }

    async fn cleanup(&self, lease: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError> {
        let mounts = self.mounts(lease)?;
        self.effects
            .cleanup(DockerResourceRequest {
                lease,
                mounts: &mounts,
            })
            .await
    }
}

fn wrong_mode() -> WorkspaceLeaseError {
    WorkspaceLeaseError::new(
        WorkspaceLeaseErrorKind::InvalidInput,
        "workspace adapter received the wrong mode",
    )
}
