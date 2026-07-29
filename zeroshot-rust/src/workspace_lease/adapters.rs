use std::fs::File;
use std::sync::Arc;

use async_trait::async_trait;
use crate::source_code_provider::{
    SourceMaterializationDestination, SourceMaterializationError, SourceMaterializationTarget,
};
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
        Self::new(Arc::new(FilesystemBorrowedWorkspaceFingerprint::default()))
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
    target: &'a dyn SourceMaterializationTarget,
}

impl WorktreeResourceRequest<'_> {
    #[must_use]
    pub fn is_available(&self) -> bool {
        self.target.is_available()
    }

    pub fn remove_file(&self, name: &str) -> Result<(), SourceMaterializationError> {
        self.target.remove_file(name)
    }

    pub fn write_file(
        &self,
        name: &str,
        contents: &[u8],
    ) -> Result<(), SourceMaterializationError> {
        self.target.write_file(name, contents)
    }
}

struct PinnedMaterializationTarget<'a> {
    directory: &'a File,
}

impl SourceMaterializationTarget for PinnedMaterializationTarget<'_> {
    fn is_available(&self) -> bool {
        self.directory
            .metadata()
            .is_ok_and(|metadata| metadata.is_dir())
    }

    fn remove_file(&self, name: &str) -> Result<(), SourceMaterializationError> {
        remove_materialized_file(self.directory, name)
    }

    fn write_file(&self, name: &str, contents: &[u8]) -> Result<(), SourceMaterializationError> {
        write_materialized_file(self.directory, name, contents)
    }
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
        let Some(root_directory) = self.roots.inspect_worktree(&mode.name, lease)? else {
            return Ok(WorkspaceResourceObservation::Absent);
        };
        let Some(workspace) = root_directory.workspace_for_inspect_effect() else {
            return Ok(WorkspaceResourceObservation::CleanupRequired);
        };
        let target = PinnedMaterializationTarget {
            directory: workspace.as_ref(),
        };
        let observation = self
            .effects
            .inspect(WorktreeResourceRequest {
                lease,
                mode,
                target: &target,
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
        let workspace = root_directory
            .workspace_for_create_effect()
            .expect("created worktree has a private source staging directory");
        let target = PinnedMaterializationTarget {
            directory: workspace.as_ref(),
        };
        self.effects
            .create(
                WorktreeResourceRequest {
                    lease,
                    mode,
                    target: &target,
                },
                SourceMaterializationDestination::new(&target),
            )
            .await?;
        self.roots
            .publish_worktree(&mode.name, &root_directory, lease)
    }

    async fn cleanup(&self, lease: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError> {
        let WorkspaceMode::Worktree(mode) = &lease.mode else {
            return Err(wrong_mode());
        };
        let Some(root_directory) = self.roots.inspect_worktree(&mode.name, lease)? else {
            return Ok(());
        };
        if let Some(workspace) = root_directory.workspace_for_cleanup_effect() {
            let target = PinnedMaterializationTarget {
                directory: workspace.as_ref(),
            };
            self.effects
                .cleanup(WorktreeResourceRequest {
                    lease,
                    mode,
                    target: &target,
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

#[cfg(target_os = "linux")]
fn write_materialized_file(
    directory: &File,
    name: &str,
    contents: &[u8],
) -> Result<(), SourceMaterializationError> {
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd};

    let name = materialized_name(name)?;
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(SourceMaterializationError);
    }
    let mut file = unsafe { File::from_raw_fd(descriptor) };
    file.write_all(contents)
        .and_then(|()| file.sync_all())
        .and_then(|()| directory.sync_all())
        .map_err(|_| SourceMaterializationError)
}

#[cfg(not(target_os = "linux"))]
fn write_materialized_file(
    _directory: &File,
    _name: &str,
    _contents: &[u8],
) -> Result<(), SourceMaterializationError> {
    Err(SourceMaterializationError)
}

#[cfg(target_os = "linux")]
fn remove_materialized_file(
    directory: &File,
    name: &str,
) -> Result<(), SourceMaterializationError> {
    use std::os::fd::AsRawFd;

    let name = materialized_name(name)?;
    if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err(SourceMaterializationError);
    }
    directory.sync_all().map_err(|_| SourceMaterializationError)
}

#[cfg(not(target_os = "linux"))]
fn remove_materialized_file(
    _directory: &File,
    _name: &str,
) -> Result<(), SourceMaterializationError> {
    Err(SourceMaterializationError)
}

#[cfg(target_os = "linux")]
fn materialized_name(name: &str) -> Result<std::ffi::CString, SourceMaterializationError> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > 255
        || name.as_bytes().contains(&b'/')
    {
        return Err(SourceMaterializationError);
    }
    std::ffi::CString::new(name).map_err(|_| SourceMaterializationError)
}

fn wrong_mode() -> WorkspaceLeaseError {
    WorkspaceLeaseError::new(
        WorkspaceLeaseErrorKind::InvalidInput,
        "workspace adapter received the wrong mode",
    )
}
