use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use fs2::FileExt;
use openengine_cluster_protocol::{canonical_value_bytes, WorkerErrorCode};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::cluster_ledger::{DispatchAllocation, OwnerId, ResourceId};
use crate::execution::WorkspaceAccessMode;
use crate::workspace_lease::{
    BorrowedWorkspace, BorrowedWorkspaceAdapter, BorrowedWorkspaceFingerprintPort,
    CanonicalWorkspaceRoot, FilesystemBorrowedWorkspaceFingerprint, PrepareWorkspaceRequest,
    SqliteWorkspaceLeaseStore, WorkspaceFingerprint, WorkspaceIsolation, WorkspaceLeaseId,
    WorkspaceLeaseKey, WorkspaceLeaseManager, WorkspaceLeaseOwnerRequest, WorkspaceLeaseState,
    WorkspaceMode,
};

use super::closed_error;

const QUARANTINE_MARKER: &str = "zeroshot-native-workspace-quarantine-v1";

pub(crate) enum AgentWorkspacePreparation {
    Ready(AgentWorkspaceAuthority),
    Closed(openengine_cluster_protocol::WorkerOutcome),
}

/// The workspace state observed before the ledger grants effect authority.
pub(crate) struct AgentWorkspaceCandidate {
    fingerprint: WorkspaceFingerprint,
}

pub(crate) struct AgentWorkspaceAuthority {
    lock: Option<File>,
    marker: std::path::PathBuf,
    git_dir: std::path::PathBuf,
    lease_manager: WorkspaceLeaseManager,
    lease_owner: WorkspaceLeaseOwnerRequest,
}

impl AgentWorkspaceAuthority {
    pub(crate) async fn finish_effect(self) -> Result<Self, Self> {
        if self
            .lease_manager
            .cleanup(self.lease_owner.clone())
            .await
            .is_err()
        {
            return Err(self);
        }
        if remove_marker(&self.marker, &self.git_dir).is_err() {
            return Err(self);
        }
        Ok(self)
    }

    pub(crate) fn quarantine(mut self) {
        if let Some(lock) = self.lock.take() {
            std::mem::forget(lock);
        }
    }
}

pub(super) struct NativeAgentWorkspace {
    canonical_root: CanonicalWorkspaceRoot,
    fingerprints: Arc<dyn BorrowedWorkspaceFingerprintPort>,
    lease_manager: WorkspaceLeaseManager,
}

impl Clone for NativeAgentWorkspace {
    fn clone(&self) -> Self {
        Self {
            canonical_root: self.canonical_root.clone(),
            fingerprints: Arc::clone(&self.fingerprints),
            lease_manager: self.lease_manager.clone(),
        }
    }
}

impl NativeAgentWorkspace {
    pub(super) fn open(
        state_dir: &Path,
        resource: &ResourceId,
        workspace: &Path,
    ) -> Result<Self, ()> {
        let canonical_root = canonical_workspace_root(workspace)?;
        let fingerprints: Arc<dyn BorrowedWorkspaceFingerprintPort> =
            Arc::new(FilesystemBorrowedWorkspaceFingerprint::default());
        let lease_store = Arc::new(
            SqliteWorkspaceLeaseStore::open(state_dir.join(format!(
                "workspace-leases-{}.sqlite",
                workspace_store_id(resource)
            )))
            .map_err(|_| ())?,
        );
        let lease_manager = WorkspaceLeaseManager::new(
            lease_store,
            Arc::new(BorrowedWorkspaceAdapter::new(Arc::clone(&fingerprints))),
        );
        Ok(Self {
            canonical_root,
            fingerprints,
            lease_manager,
        })
    }

    pub(super) fn root(&self) -> &Path {
        self.canonical_root.as_path()
    }

    pub(super) fn preflight(&self) -> Result<AgentWorkspaceCandidate, ()> {
        let lock = lock_workspace(self.canonical_root.as_path())?;
        require_no_marker(self.canonical_root.as_path())?;
        let fingerprint = self
            .fingerprints
            .fingerprint(self.canonical_root.as_path())
            .map_err(|_| ())?;
        drop(lock);
        Ok(AgentWorkspaceCandidate { fingerprint })
    }

    pub(super) async fn prepare(
        &self,
        cluster: &ResourceId,
        allocation: &DispatchAllocation,
        candidate: AgentWorkspaceCandidate,
    ) -> AgentWorkspacePreparation {
        let lock = match lock_workspace(self.canonical_root.as_path()) {
            Ok(lock) => lock,
            Err(()) => return closed_preparation(),
        };
        if require_no_marker(self.canonical_root.as_path()).is_err() {
            return closed_preparation();
        }
        let (request, owner) = match workspace_request(
            cluster,
            allocation,
            self.canonical_root.clone(),
            candidate.fingerprint,
        ) {
            Ok(requests) => requests,
            Err(()) => return closed_preparation(),
        };
        let prepared = self.lease_manager.prepare(request).await;
        let ready = prepared
            .as_ref()
            .is_ok_and(|record| record.state == WorkspaceLeaseState::Ready);
        if !ready {
            let _ = self.lease_manager.cleanup(owner).await;
            return closed_preparation();
        }
        let git_dir = self.canonical_root.as_path().join(".git");
        let marker = git_dir.join(QUARANTINE_MARKER);
        if write_marker(&marker, &git_dir, cluster, allocation).is_err() {
            let _ = remove_marker(&marker, &git_dir);
            let _ = self.lease_manager.cleanup(owner).await;
            return closed_preparation();
        }
        AgentWorkspacePreparation::Ready(AgentWorkspaceAuthority {
            lock: Some(lock),
            marker,
            git_dir,
            lease_manager: self.lease_manager.clone(),
            lease_owner: owner,
        })
    }
}

fn closed_preparation() -> AgentWorkspacePreparation {
    AgentWorkspacePreparation::Closed(closed_error(WorkerErrorCode::Refusal))
}

fn canonical_workspace_root(workspace: &Path) -> Result<CanonicalWorkspaceRoot, ()> {
    let canonical = std::fs::canonicalize(workspace).map_err(|_| ())?;
    if canonical != workspace || !canonical.join(".git").is_dir() {
        return Err(());
    }
    CanonicalWorkspaceRoot::new(canonical.to_str().ok_or(())?).map_err(|_| ())
}

fn lock_workspace(root: &Path) -> Result<File, ()> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = root;
        Err(())
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = OpenOptions::new();
        options
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
        let file = options.open(root).map_err(|_| ())?;
        file.try_lock_exclusive().map_err(|_| ())?;
        if std::fs::canonicalize(root).map_err(|_| ())? != root {
            return Err(());
        }
        Ok(file)
    }
}

fn require_no_marker(root: &Path) -> Result<(), ()> {
    let git_dir = root.join(".git");
    let metadata = std::fs::symlink_metadata(&git_dir).map_err(|_| ())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || git_dir.join(QUARANTINE_MARKER).exists()
    {
        return Err(());
    }
    Ok(())
}

fn workspace_request(
    cluster: &ResourceId,
    allocation: &DispatchAllocation,
    canonical_root: CanonicalWorkspaceRoot,
    fingerprint: WorkspaceFingerprint,
) -> Result<(PrepareWorkspaceRequest, WorkspaceLeaseOwnerRequest), ()> {
    let key = WorkspaceLeaseKey {
        cluster: cluster.clone(),
        run: allocation.run,
        logical_key: ResourceId::new("native-agent-workspace").map_err(|_| ())?,
        isolation: WorkspaceIsolation::Execution(allocation.execution),
    };
    let id = WorkspaceLeaseId::derive(&key);
    let owner = workspace_owner(cluster, allocation)?;
    Ok((
        PrepareWorkspaceRequest {
            key,
            owner: owner.clone(),
            access_mode: WorkspaceAccessMode::Exclusive,
            mode: WorkspaceMode::Borrowed(BorrowedWorkspace {
                canonical_root,
                fingerprint,
            }),
        },
        WorkspaceLeaseOwnerRequest { id, owner },
    ))
}

fn workspace_owner(cluster: &ResourceId, allocation: &DispatchAllocation) -> Result<OwnerId, ()> {
    let mut digest = Sha256::new();
    digest.update(b"zeroshot.native-agent-workspace-owner/v1\0");
    digest.update(cluster.as_str().as_bytes());
    digest.update(allocation.run.get().to_be_bytes());
    digest.update(allocation.execution.get().to_be_bytes());
    OwnerId::new(format!("native-agent-{:x}", digest.finalize())).map_err(|_| ())
}

fn workspace_store_id(resource: &ResourceId) -> String {
    let mut digest = Sha256::new();
    digest.update(b"zeroshot.native-agent-workspace-store/v1\0");
    digest.update(resource.as_str().as_bytes());
    format!("{:x}", digest.finalize())
}

fn write_marker(
    marker: &Path,
    git_dir: &Path,
    cluster: &ResourceId,
    allocation: &DispatchAllocation,
) -> Result<(), ()> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Marker<'a> {
        cluster: &'a str,
        run: u64,
        execution: u64,
    }
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let bytes = canonical_value_bytes(
        &serde_json::to_value(Marker {
            cluster: cluster.as_str(),
            run: allocation.run.get(),
            execution: allocation.execution.get(),
        })
        .map_err(|_| ())?,
    )
    .map_err(|_| ())?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(marker).map_err(|_| ())?;
    file.write_all(&bytes).map_err(|_| ())?;
    file.sync_all().map_err(|_| ())?;
    File::open(git_dir)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ())
}

fn remove_marker(marker: &Path, git_dir: &Path) -> Result<(), ()> {
    std::fs::remove_file(marker).map_err(|_| ())?;
    File::open(git_dir)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cluster_ledger::{ExecutionId, NodeInstanceId, RunSequence};

    #[tokio::test]
    async fn prepare_rejects_workspace_changed_after_preflight() {
        let suffix = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let state = std::env::temp_dir().join(format!("zeroshot-agent-state-{suffix}"));
        let workspace = std::env::temp_dir().join(format!("zeroshot-agent-workspace-{suffix}"));
        std::fs::create_dir_all(&state).unwrap();
        std::fs::create_dir_all(workspace.join(".git")).unwrap();

        let resource = ResourceId::new("changed-after-preflight").unwrap();
        let authority = NativeAgentWorkspace::open(&state, &resource, &workspace).unwrap();
        let candidate = authority.preflight().unwrap();
        std::fs::write(workspace.join("changed.txt"), b"changed").unwrap();
        let prepared = authority
            .prepare(
                &resource,
                &DispatchAllocation {
                    run: RunSequence::new(1).unwrap(),
                    node_instance: NodeInstanceId::new(1).unwrap(),
                    execution: ExecutionId::new(1).unwrap(),
                },
                candidate,
            )
            .await;

        assert!(matches!(prepared, AgentWorkspacePreparation::Closed(_)));
        drop(authority);
        let _ = std::fs::remove_dir_all(state);
        let _ = std::fs::remove_dir_all(workspace);
    }
}
