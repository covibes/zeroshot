use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Notify;
use zeroshot_engine::cluster_ledger::{OwnerId, ResourceId, RunSequence};
use zeroshot_engine::execution::WorkspaceAccessMode;
use zeroshot_engine::source_code_provider::{
    CanonicalRepository, SourceAccountId, SourceBranchId, SourceMaterializationDestination,
    SourceProfileId, SourceProviderId, SourceProviderRef, SourceRepositoryId, SourceRevisionId,
};
use zeroshot_engine::workspace_lease::fake::FakeWorkspaceLeaseStore;
use zeroshot_engine::workspace_lease::{
    BorrowedWorkspace, BorrowedWorkspaceAdapter, BorrowedWorkspaceFingerprintPort,
    CanonicalWorkspaceRoot, DockerImageDigest, DockerMountHandleId, DockerResourceId,
    DockerResourceRequest, DockerWorkspace, DockerWorkspaceAdapter, DockerWorkspaceEffects,
    FilesystemBorrowedWorkspaceFingerprint, PrepareWorkspaceRequest, WorkspaceFingerprint,
    WorkspaceIsolation, WorkspaceLeaseError, WorkspaceLeaseErrorKind, WorkspaceLeaseId,
    WorkspaceLeaseKey, WorkspaceLeaseManager, WorkspaceLeaseOwnerRequest, WorkspaceLeaseState,
    WorkspaceLeaseStore, WorkspaceMaterializationId, WorkspaceMode, WorkspaceName,
    WorkspaceProductRoots, WorkspaceProfile, WorkspaceResourceObservation, WorktreeResourceRequest,
    WorktreeWorkspace, WorktreeWorkspaceAdapter, WorktreeWorkspaceEffects,
};

fn injected_resource_unavailable() -> WorkspaceLeaseError {
    let absent = std::env::temp_dir().join(format!(
        "zeroshot-injected-absent-workspace-{}",
        std::process::id()
    ));
    FilesystemBorrowedWorkspaceFingerprint
        .fingerprint(&absent)
        .unwrap_err()
}

#[cfg(target_os = "linux")]
fn private_product_base(label: &str) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;

    let scope =
        std::env::temp_dir().join(format!("zeroshot-product-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scope);
    let base = scope.join("zeroshot/workspaces");
    std::fs::create_dir_all(&base).unwrap();
    std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
    let base = std::fs::canonicalize(base).unwrap();
    (scope, base)
}

#[cfg(not(target_os = "linux"))]
#[test]
fn owned_workspace_roots_fail_closed_without_linux_safe_primitives() {
    let native_absolute = std::fs::canonicalize(std::env::temp_dir()).unwrap();
    assert!(
        WorkspaceProductRoots::new(
            CanonicalWorkspaceRoot::new(native_absolute.to_string_lossy()).unwrap()
        )
        .is_err()
    );
}

#[test]
fn exact_mode_values_are_canonical_bounded_and_secret_free() {
    assert!(WorkspaceFingerprint::new("A".repeat(64)).is_err());
    assert!(DockerImageDigest::new("latest").is_err());
    assert!(DockerMountHandleId::new("../socket").is_err());
    assert!(WorkspaceName::new("feature/unsafe").is_err());
    assert!(CanonicalWorkspaceRoot::new("relative/path").is_err());

    let mode = WorkspaceMode::Worktree(worktree());
    let encoded = serde_json::to_string(&mode).unwrap();
    assert!(encoded.contains("the-open-engine/zeroshot"));
    assert!(encoded.contains("revision-abc"));
    assert!(encoded.contains("materialization-1"));
    for prohibited in ["credential", "password", "token", "pid", "containerId"] {
        assert!(
            !encoded.contains(prohibited),
            "persisted secret/runtime field: {prohibited}"
        );
    }
    assert_eq!(
        serde_json::from_str::<WorkspaceMode>(&encoded).unwrap(),
        mode
    );

    let invalid_docker = format!(
        r#"{{"imageDigest":"sha256:{}","resource":"docker-1","mountHandles":["z","a"]}}"#,
        "a".repeat(64)
    );
    assert!(serde_json::from_str::<DockerWorkspace>(&invalid_docker).is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn worktree_and_docker_roots_are_private_disjoint_and_never_broad() {
    use std::os::unix::fs::PermissionsExt;

    let (scope, base) = private_product_base("derivation");
    let roots =
        WorkspaceProductRoots::new(CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap())
            .unwrap();
    let worktrees = base.join("worktrees");
    let mounts_root = base.join("mounts");
    assert!(worktrees.is_dir());
    assert!(mounts_root.is_dir());
    assert_ne!(worktrees, mounts_root);
    assert!(!worktrees.starts_with(&mounts_root));
    assert!(!mounts_root.starts_with(&worktrees));
    assert_ne!(worktrees.join("lease-a"), mounts_root);

    let mounts = roots.default_docker_mounts(&docker()).unwrap();
    assert_eq!(mounts.len(), 2);
    assert!(
        mounts
            .iter()
            .all(|mount| mount.source_directory().metadata().unwrap().is_dir())
    );
    assert!(base.join("mounts/source").is_dir());
    assert!(base.join("mounts/workspace").is_dir());
    assert!(
        mounts
            .iter()
            .all(|mount| mount.container_path.starts_with("/workspace"))
    );

    let tmp_mode = std::fs::metadata("/tmp").unwrap().permissions().mode();
    let mut denied = vec![
        "/",
        "/tmp",
        "/home",
        "/root",
        "/var",
        "/etc",
        "/usr",
        "/run",
        "/dev",
        "/proc",
        "/sys",
        "/boot",
        "/var/run/docker.sock",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    if let Some(home) = std::env::var_os("HOME") {
        denied.push(home.to_string_lossy().into_owned());
    }
    for root in denied {
        assert!(WorkspaceProductRoots::new(CanonicalWorkspaceRoot::new(root).unwrap()).is_err());
    }
    assert_eq!(
        std::fs::metadata("/tmp").unwrap().permissions().mode(),
        tmp_mode,
        "validation must never chmod an arbitrary existing root"
    );
    let lookalike = scope.join("not-zeroshot/workspaces");
    std::fs::create_dir_all(&lookalike).unwrap();
    std::fs::set_permissions(&lookalike, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        WorkspaceProductRoots::new(
            CanonicalWorkspaceRoot::new(
                std::fs::canonicalize(&lookalike).unwrap().to_string_lossy(),
            )
            .unwrap(),
        )
        .is_err()
    );
    std::fs::remove_dir_all(scope).unwrap();
}

#[tokio::test]
async fn borrowed_workspace_is_inspected_but_never_owned_or_deleted() {
    let path = std::env::temp_dir().join(format!("zeroshot-borrowed-{}", std::process::id()));
    std::fs::create_dir_all(&path).unwrap();
    let canonical = std::fs::canonicalize(&path).unwrap();
    let fingerprint = FilesystemBorrowedWorkspaceFingerprint
        .fingerprint(&canonical)
        .unwrap();
    let request = PrepareWorkspaceRequest {
        key: WorkspaceLeaseKey {
            cluster: ResourceId::new("cluster.borrowed").unwrap(),
            run: RunSequence::new(1).unwrap(),
            logical_key: ResourceId::new("logical.borrowed").unwrap(),
            isolation: WorkspaceIsolation::Shared,
        },
        owner: OwnerId::new("owner-a").unwrap(),
        access_mode: WorkspaceAccessMode::ReadOnly,
        mode: WorkspaceMode::Borrowed(BorrowedWorkspace {
            canonical_root: CanonicalWorkspaceRoot::new(canonical.to_string_lossy()).unwrap(),
            fingerprint,
        }),
    };
    let mut mismatched = request.clone();
    let WorkspaceMode::Borrowed(borrowed) = &mut mismatched.mode else {
        unreachable!();
    };
    borrowed.fingerprint = WorkspaceFingerprint::new("b".repeat(64)).unwrap();
    let mismatch_manager = WorkspaceLeaseManager::new(
        Arc::new(FakeWorkspaceLeaseStore::default()),
        Arc::new(BorrowedWorkspaceAdapter::default()),
    );
    assert_eq!(
        mismatch_manager
            .prepare(mismatched)
            .await
            .unwrap_err()
            .kind(),
        WorkspaceLeaseErrorKind::ResourceMismatch
    );

    let store = Arc::new(FakeWorkspaceLeaseStore::default());
    let manager = WorkspaceLeaseManager::new(store, Arc::new(BorrowedWorkspaceAdapter::default()));
    let ready = manager.prepare(request).await.unwrap();
    assert_eq!(ready.state, WorkspaceLeaseState::Ready);
    std::fs::write(path.join("drift"), b"changed").unwrap();
    assert_eq!(
        manager
            .restart(WorkspaceLeaseOwnerRequest {
                id: ready.id.clone(),
                owner: ready.owner.clone(),
            })
            .await
            .unwrap_err()
            .kind(),
        WorkspaceLeaseErrorKind::ResourceMismatch
    );
    let cleaned = manager
        .cleanup(WorkspaceLeaseOwnerRequest {
            id: ready.id,
            owner: ready.owner,
        })
        .await
        .unwrap();
    assert_eq!(cleaned.state, WorkspaceLeaseState::Cleaned);
    assert!(path.is_dir(), "borrowed root must not be deleted");
    std::fs::remove_dir_all(&path).unwrap();
}

#[cfg(target_os = "linux")]
struct PausingBorrowedFingerprint {
    armed: AtomicBool,
    reached: std::sync::mpsc::SyncSender<()>,
    resume: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}

#[cfg(target_os = "linux")]
impl BorrowedWorkspaceFingerprintPort for PausingBorrowedFingerprint {
    fn fingerprint(
        &self,
        root: &std::path::Path,
    ) -> Result<WorkspaceFingerprint, WorkspaceLeaseError> {
        if self.armed.swap(false, Ordering::SeqCst) {
            self.reached.send(()).unwrap();
            self.resume
                .lock()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|_| injected_resource_unavailable())?;
        }
        FilesystemBorrowedWorkspaceFingerprint.fingerprint(root)
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn borrowed_root_swap_between_canonical_check_and_fingerprint_fails_closed() {
    use std::os::unix::fs::symlink;

    let scope = std::env::temp_dir().join(format!("zeroshot-borrowed-swap-{}", std::process::id()));
    let root = scope.join("root");
    let aside = scope.join("root-aside");
    let outside = scope.join("outside");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(root.join("same"), b"content").unwrap();
    std::fs::write(outside.join("same"), b"content").unwrap();
    let canonical = std::fs::canonicalize(&root).unwrap();
    let fingerprint = FilesystemBorrowedWorkspaceFingerprint
        .fingerprint(&canonical)
        .unwrap();
    let request = PrepareWorkspaceRequest {
        key: WorkspaceLeaseKey {
            cluster: ResourceId::new("cluster.borrowed-swap").unwrap(),
            run: RunSequence::new(1).unwrap(),
            logical_key: ResourceId::new("logical.borrowed-swap").unwrap(),
            isolation: WorkspaceIsolation::Shared,
        },
        owner: OwnerId::new("owner-a").unwrap(),
        access_mode: WorkspaceAccessMode::ReadOnly,
        mode: WorkspaceMode::Borrowed(BorrowedWorkspace {
            canonical_root: CanonicalWorkspaceRoot::new(canonical.to_string_lossy()).unwrap(),
            fingerprint,
        }),
    };
    let (reached_tx, reached_rx) = std::sync::mpsc::sync_channel(1);
    let (resume_tx, resume_rx) = std::sync::mpsc::sync_channel(1);
    let fingerprints = Arc::new(PausingBorrowedFingerprint {
        armed: AtomicBool::new(true),
        reached: reached_tx,
        resume: std::sync::Mutex::new(resume_rx),
    });
    let manager = WorkspaceLeaseManager::new(
        Arc::new(FakeWorkspaceLeaseStore::default()),
        Arc::new(BorrowedWorkspaceAdapter::new(fingerprints)),
    );
    let worker_request = request.clone();
    let worker = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(manager.prepare(worker_request));
        (manager, result)
    });
    reached_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("borrowed inspection did not reach the fingerprint boundary");
    std::fs::rename(&root, &aside).unwrap();
    symlink(&outside, &root).unwrap();
    resume_tx.send(()).unwrap();
    let (manager, result) = worker.join().unwrap();
    assert_eq!(
        result.unwrap_err().kind(),
        WorkspaceLeaseErrorKind::ResourceUnavailable
    );
    std::fs::remove_file(&root).unwrap();
    std::fs::rename(&aside, &root).unwrap();
    assert_eq!(
        manager.prepare(request).await.unwrap().state,
        WorkspaceLeaseState::Ready
    );
    std::fs::remove_dir_all(scope).unwrap();
}

fn docker() -> DockerWorkspace {
    DockerWorkspace::new(
        DockerImageDigest::new(format!("sha256:{}", "c".repeat(64))).unwrap(),
        DockerResourceId::new("docker-resource").unwrap(),
        vec![
            DockerMountHandleId::new("source").unwrap(),
            DockerMountHandleId::new("workspace").unwrap(),
        ],
    )
    .unwrap()
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn worktree_adapter_gives_source_delivery_only_an_ephemeral_destination() {
    let (scope, base) = private_product_base("worktree-destination");
    let roots =
        WorkspaceProductRoots::new(CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap())
            .unwrap();
    let effects = Arc::new(CapturingWorktreeEffects::default());
    let manager = WorkspaceLeaseManager::new(
        Arc::new(FakeWorkspaceLeaseStore::default()),
        Arc::new(WorktreeWorkspaceAdapter::new(roots, effects.clone())),
    );
    let request = PrepareWorkspaceRequest {
        key: WorkspaceLeaseKey {
            cluster: ResourceId::new("cluster.worktree").unwrap(),
            run: RunSequence::new(1).unwrap(),
            logical_key: ResourceId::new("logical.worktree").unwrap(),
            isolation: WorkspaceIsolation::Shared,
        },
        owner: OwnerId::new("owner-a").unwrap(),
        access_mode: WorkspaceAccessMode::Exclusive,
        mode: WorkspaceMode::Worktree(worktree()),
    };
    let ready = manager.prepare(request).await.unwrap();
    assert_eq!(ready.state, WorkspaceLeaseState::Ready);
    assert!(effects.destination_seen.load(Ordering::SeqCst));
    assert_eq!(
        manager
            .cleanup(WorkspaceLeaseOwnerRequest {
                id: ready.id,
                owner: ready.owner,
            })
            .await
            .unwrap()
            .state,
        WorkspaceLeaseState::Cleaned
    );
    std::fs::remove_dir_all(scope).unwrap();
}

#[derive(Default)]
struct CapturingWorktreeEffects {
    exists: AtomicBool,
    destination_seen: AtomicBool,
}

#[async_trait]
impl WorktreeWorkspaceEffects for CapturingWorktreeEffects {
    async fn inspect(
        &self,
        _request: WorktreeResourceRequest<'_>,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError> {
        Ok(if self.exists.load(Ordering::SeqCst) {
            WorkspaceResourceObservation::Matching
        } else {
            WorkspaceResourceObservation::Absent
        })
    }

    async fn create(
        &self,
        request: WorktreeResourceRequest<'_>,
        mut destination: SourceMaterializationDestination<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        use std::os::unix::fs::MetadataExt;
        let root = destination
            .downcast_mut::<std::path::PathBuf>()
            .expect("adapter provides only the ephemeral destination capability");
        assert!(root.starts_with("/proc/self/fd"));
        let destination_metadata = std::fs::metadata(root).unwrap();
        let capability_metadata = request.root_directory.metadata().unwrap();
        assert_eq!(destination_metadata.dev(), capability_metadata.dev());
        assert_eq!(destination_metadata.ino(), capability_metadata.ino());
        self.destination_seen.store(true, Ordering::SeqCst);
        self.exists.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn cleanup(
        &self,
        _request: WorktreeResourceRequest<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        self.exists.store(false, Ordering::SeqCst);
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn worktree_request_for(label: &str) -> PrepareWorkspaceRequest {
    PrepareWorkspaceRequest {
        key: WorkspaceLeaseKey {
            cluster: ResourceId::new(format!("cluster.{label}")).unwrap(),
            run: RunSequence::new(1).unwrap(),
            logical_key: ResourceId::new(format!("logical.{label}")).unwrap(),
            isolation: WorkspaceIsolation::Shared,
        },
        owner: OwnerId::new("owner-a").unwrap(),
        access_mode: WorkspaceAccessMode::Exclusive,
        mode: WorkspaceMode::Worktree(worktree()),
    }
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct FailingCreateWorktreeEffects {
    cleanup_calls: AtomicUsize,
}

#[cfg(target_os = "linux")]
#[async_trait]
impl WorktreeWorkspaceEffects for FailingCreateWorktreeEffects {
    async fn inspect(
        &self,
        _request: WorktreeResourceRequest<'_>,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError> {
        Ok(WorkspaceResourceObservation::Absent)
    }

    async fn create(
        &self,
        _request: WorktreeResourceRequest<'_>,
        _destination: SourceMaterializationDestination<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        Err(injected_resource_unavailable())
    }

    async fn cleanup(
        &self,
        _request: WorktreeResourceRequest<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        self.cleanup_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn worktree_create_failure_leaves_owned_scaffolding_for_retryable_cleanup() {
    let (scope, base) = private_product_base("worktree-create-failure");
    let roots =
        WorkspaceProductRoots::new(CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap())
            .unwrap();
    let effects = Arc::new(FailingCreateWorktreeEffects::default());
    let store = Arc::new(FakeWorkspaceLeaseStore::default());
    let manager = WorkspaceLeaseManager::new(
        store.clone(),
        Arc::new(WorktreeWorkspaceAdapter::new(roots, effects.clone())),
    );
    let request = worktree_request_for("worktree-create-failure");
    let id = WorkspaceLeaseId::derive(&request.key);
    let owner = request.owner.clone();

    assert_eq!(
        manager.prepare(request).await.unwrap_err().kind(),
        WorkspaceLeaseErrorKind::ResourceUnavailable
    );
    assert!(base.join("worktrees/lease-a/workspace").is_dir());
    assert_eq!(
        manager
            .cleanup(WorkspaceLeaseOwnerRequest { id, owner })
            .await
            .unwrap()
            .state,
        WorkspaceLeaseState::Cleaned
    );
    assert_eq!(effects.cleanup_calls.load(Ordering::SeqCst), 1);
    assert!(!base.join("worktrees/lease-a").exists());
    std::fs::remove_dir_all(scope).unwrap();
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct ResidualCleanupWorktreeEffects {
    exists: AtomicBool,
    cleanup_calls: AtomicUsize,
}

#[cfg(target_os = "linux")]
#[async_trait]
impl WorktreeWorkspaceEffects for ResidualCleanupWorktreeEffects {
    async fn inspect(
        &self,
        _request: WorktreeResourceRequest<'_>,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError> {
        Ok(if self.exists.load(Ordering::SeqCst) {
            WorkspaceResourceObservation::Matching
        } else {
            WorkspaceResourceObservation::Absent
        })
    }

    async fn create(
        &self,
        request: WorktreeResourceRequest<'_>,
        _destination: SourceMaterializationDestination<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        use std::os::fd::AsRawFd;
        let root = PathBuf::from(format!(
            "/proc/self/fd/{}",
            request.root_directory.as_raw_fd()
        ));
        std::fs::write(root.join("residual"), b"still present").unwrap();
        self.exists.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn cleanup(
        &self,
        _request: WorktreeResourceRequest<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        self.cleanup_calls.fetch_add(1, Ordering::SeqCst);
        self.exists.store(false, Ordering::SeqCst);
        Ok(())
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn worktree_root_removal_failure_stays_cleanup_required_and_retries() {
    let (scope, base) = private_product_base("worktree-removal-failure");
    let roots =
        WorkspaceProductRoots::new(CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap())
            .unwrap();
    let effects = Arc::new(ResidualCleanupWorktreeEffects::default());
    let store = Arc::new(FakeWorkspaceLeaseStore::default());
    let manager = WorkspaceLeaseManager::new(
        store.clone(),
        Arc::new(WorktreeWorkspaceAdapter::new(roots, effects.clone())),
    );
    let request = worktree_request_for("worktree-removal-failure");
    let id = WorkspaceLeaseId::derive(&request.key);
    let owner = request.owner.clone();
    assert_eq!(
        manager.prepare(request).await.unwrap().state,
        WorkspaceLeaseState::Ready
    );

    assert_eq!(
        manager
            .cleanup(WorkspaceLeaseOwnerRequest {
                id: id.clone(),
                owner: owner.clone(),
            })
            .await
            .unwrap_err()
            .kind(),
        WorkspaceLeaseErrorKind::ResourceUnavailable
    );
    assert_eq!(
        store.load(&id).await.unwrap().unwrap().state,
        WorkspaceLeaseState::CleanupRequired
    );
    std::fs::remove_file(base.join("worktrees/lease-a/workspace/residual")).unwrap();
    assert_eq!(
        manager
            .cleanup(WorkspaceLeaseOwnerRequest { id, owner })
            .await
            .unwrap()
            .state,
        WorkspaceLeaseState::Cleaned
    );
    assert_eq!(effects.cleanup_calls.load(Ordering::SeqCst), 2);
    std::fs::remove_dir_all(scope).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn worktree_effects_remain_pinned_after_product_parent_symlink_swap() {
    use std::os::unix::fs::symlink;

    let (scope, base) = private_product_base("worktree-parent-swap");
    let roots =
        WorkspaceProductRoots::new(CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap())
            .unwrap();
    let effects = Arc::new(RacingWorktreeEffects::default());
    let manager = WorkspaceLeaseManager::new(
        Arc::new(FakeWorkspaceLeaseStore::default()),
        Arc::new(WorktreeWorkspaceAdapter::new(roots, effects.clone())),
    );
    let request = PrepareWorkspaceRequest {
        key: WorkspaceLeaseKey {
            cluster: ResourceId::new("cluster.worktree-race").unwrap(),
            run: RunSequence::new(1).unwrap(),
            logical_key: ResourceId::new("logical.worktree-race").unwrap(),
            isolation: WorkspaceIsolation::Shared,
        },
        owner: OwnerId::new("owner-a").unwrap(),
        access_mode: WorkspaceAccessMode::Exclusive,
        mode: WorkspaceMode::Worktree(worktree()),
    };
    let prepare =
        tokio::spawn(async move { manager.prepare(request).await.map(|ready| (manager, ready)) });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        effects.received.notified(),
    )
    .await
    .expect("worktree create did not reach the pinned effect boundary");
    let detached = base.join("worktrees-detached");
    let outside = scope.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::rename(base.join("worktrees"), &detached).unwrap();
    symlink(&outside, base.join("worktrees")).unwrap();
    effects.resume.notify_one();
    let (manager, ready) = prepare.await.unwrap().unwrap();
    assert_eq!(ready.state, WorkspaceLeaseState::Ready);
    assert!(detached.join("lease-a/workspace/materialized").is_file());
    assert!(!outside.join("lease-a/materialized").exists());
    assert_eq!(
        manager
            .cleanup(WorkspaceLeaseOwnerRequest {
                id: ready.id,
                owner: ready.owner,
            })
            .await
            .unwrap()
            .state,
        WorkspaceLeaseState::Cleaned
    );
    assert!(!detached.join("lease-a/workspace").exists());
    std::fs::remove_dir_all(scope).unwrap();
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct RacingWorktreeEffects {
    received: Notify,
    resume: Notify,
    exists: AtomicBool,
}

#[cfg(target_os = "linux")]
#[async_trait]
impl WorktreeWorkspaceEffects for RacingWorktreeEffects {
    async fn inspect(
        &self,
        request: WorktreeResourceRequest<'_>,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError> {
        assert!(request.root_directory.metadata().unwrap().is_dir());
        Ok(if self.exists.load(Ordering::SeqCst) {
            WorkspaceResourceObservation::Matching
        } else {
            WorkspaceResourceObservation::Absent
        })
    }

    async fn create(
        &self,
        request: WorktreeResourceRequest<'_>,
        mut destination: SourceMaterializationDestination<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        self.received.notify_one();
        self.resume.notified().await;
        assert!(request.root_directory.metadata().unwrap().is_dir());
        let root = destination
            .downcast_mut::<PathBuf>()
            .expect("worktree destination remains an ephemeral capability");
        std::fs::write(root.join("materialized"), b"safe").unwrap();
        self.exists.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn cleanup(
        &self,
        request: WorktreeResourceRequest<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        use std::os::fd::AsRawFd;
        let root = PathBuf::from(format!(
            "/proc/self/fd/{}",
            request.root_directory.as_raw_fd()
        ));
        std::fs::remove_file(root.join("materialized")).unwrap();
        self.exists.store(false, Ordering::SeqCst);
        Ok(())
    }
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct PausingCleanupWorktreeEffects {
    cleanup_started: Notify,
    cleanup_resume: Notify,
    exists: AtomicBool,
}

#[cfg(target_os = "linux")]
#[async_trait]
impl WorktreeWorkspaceEffects for PausingCleanupWorktreeEffects {
    async fn inspect(
        &self,
        _request: WorktreeResourceRequest<'_>,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError> {
        Ok(if self.exists.load(Ordering::SeqCst) {
            WorkspaceResourceObservation::Matching
        } else {
            WorkspaceResourceObservation::Absent
        })
    }

    async fn create(
        &self,
        request: WorktreeResourceRequest<'_>,
        _destination: SourceMaterializationDestination<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        use std::os::fd::AsRawFd;
        let root = PathBuf::from(format!(
            "/proc/self/fd/{}",
            request.root_directory.as_raw_fd()
        ));
        std::fs::write(root.join("materialized"), b"owned").unwrap();
        self.exists.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn cleanup(
        &self,
        request: WorktreeResourceRequest<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        use std::os::fd::AsRawFd;
        self.cleanup_started.notify_one();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            self.cleanup_resume.notified(),
        )
        .await
        .map_err(|_| injected_resource_unavailable())?;
        let root = PathBuf::from(format!(
            "/proc/self/fd/{}",
            request.root_directory.as_raw_fd()
        ));
        std::fs::remove_file(root.join("materialized")).unwrap();
        self.exists.store(false, Ordering::SeqCst);
        Ok(())
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn worktree_cleanup_preserves_a_renamed_replacement_and_stays_retryable() {
    use std::os::unix::fs::PermissionsExt;

    let (scope, base) = private_product_base("worktree-child-substitution");
    let roots =
        WorkspaceProductRoots::new(CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap())
            .unwrap();
    let effects = Arc::new(PausingCleanupWorktreeEffects::default());
    let store = Arc::new(FakeWorkspaceLeaseStore::default());
    let manager = WorkspaceLeaseManager::new(
        store.clone(),
        Arc::new(WorktreeWorkspaceAdapter::new(roots, effects.clone())),
    );
    let request = worktree_request_for("worktree-child-substitution");
    let id = WorkspaceLeaseId::derive(&request.key);
    let owner = request.owner.clone();
    assert_eq!(
        manager.prepare(request).await.unwrap().state,
        WorkspaceLeaseState::Ready
    );

    let cleanup_manager = manager.clone();
    let cleanup_id = id.clone();
    let cleanup_owner = owner.clone();
    let cleanup = tokio::spawn(async move {
        cleanup_manager
            .cleanup(WorkspaceLeaseOwnerRequest {
                id: cleanup_id,
                owner: cleanup_owner,
            })
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        effects.cleanup_started.notified(),
    )
    .await
    .expect("cleanup did not reach the pinned effect boundary");
    let original = base.join("worktrees/lease-a");
    let detached = base.join("worktrees/lease-a-detached");
    std::fs::rename(&original, &detached).unwrap();
    std::fs::create_dir(&original).unwrap();
    std::fs::set_permissions(&original, std::fs::Permissions::from_mode(0o700)).unwrap();
    effects.cleanup_resume.notify_one();

    assert_eq!(
        cleanup.await.unwrap().unwrap_err().kind(),
        WorkspaceLeaseErrorKind::ResourceMismatch
    );
    assert!(original.is_dir(), "the replacement must be preserved");
    assert!(
        detached.is_dir(),
        "the inspected resource remains inspectable"
    );
    assert_eq!(
        store.load(&id).await.unwrap().unwrap().state,
        WorkspaceLeaseState::CleanupRequired
    );
    assert_eq!(
        manager
            .inspect(WorkspaceLeaseOwnerRequest { id, owner })
            .await
            .unwrap_err()
            .kind(),
        WorkspaceLeaseErrorKind::ResourceMismatch
    );
    std::fs::remove_dir_all(scope).unwrap();
}

#[cfg(unix)]
#[test]
fn borrowed_fingerprint_distinguishes_non_utf8_path_bytes() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let root = std::env::temp_dir().join(format!(
        "zeroshot-borrowed-path-bytes-{}",
        std::process::id()
    ));
    let first = root.join("first");
    let second = root.join("second");
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    std::fs::write(first.join(OsString::from_vec(vec![0x80])), b"x").unwrap();
    std::fs::write(second.join(OsString::from_vec(vec![0x81])), b"x").unwrap();
    let fingerprints = FilesystemBorrowedWorkspaceFingerprint;
    assert_ne!(
        fingerprints.fingerprint(&first).unwrap(),
        fingerprints.fingerprint(&second).unwrap()
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn docker_adapter_rejects_a_symlinked_mount_parent_before_effects() {
    use std::os::unix::fs::symlink;

    let (scope, base) = private_product_base("docker-parent-symlink");
    let roots =
        WorkspaceProductRoots::new(CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap())
            .unwrap();
    std::fs::remove_dir(base.join("mounts")).unwrap();
    symlink("/var/run", base.join("mounts")).unwrap();

    let effects = Arc::new(CountingDockerEffects::default());
    let manager = WorkspaceLeaseManager::new(
        Arc::new(FakeWorkspaceLeaseStore::default()),
        Arc::new(DockerWorkspaceAdapter::new(roots, effects.clone())),
    );
    let request = PrepareWorkspaceRequest {
        key: WorkspaceLeaseKey {
            cluster: ResourceId::new("cluster.docker-symlink").unwrap(),
            run: RunSequence::new(1).unwrap(),
            logical_key: ResourceId::new("logical.docker-symlink").unwrap(),
            isolation: WorkspaceIsolation::Shared,
        },
        owner: OwnerId::new("owner-a").unwrap(),
        access_mode: WorkspaceAccessMode::Exclusive,
        mode: WorkspaceMode::Docker(docker()),
    };
    assert_eq!(
        manager.prepare(request).await.unwrap_err().kind(),
        WorkspaceLeaseErrorKind::ResourceUnavailable
    );
    assert_eq!(effects.calls.load(Ordering::SeqCst), 0);
    std::fs::remove_dir_all(scope).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn docker_mount_capability_survives_post_validation_symlink_swap() {
    use std::os::unix::fs::symlink;

    let (scope, base) = private_product_base("docker-target-swap");
    let roots =
        WorkspaceProductRoots::new(CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap())
            .unwrap();
    let effects = Arc::new(RacingDockerEffects::default());
    let manager = WorkspaceLeaseManager::new(
        Arc::new(FakeWorkspaceLeaseStore::default()),
        Arc::new(DockerWorkspaceAdapter::new(roots, effects.clone())),
    );
    let request = PrepareWorkspaceRequest {
        key: WorkspaceLeaseKey {
            cluster: ResourceId::new("cluster.docker-race").unwrap(),
            run: RunSequence::new(1).unwrap(),
            logical_key: ResourceId::new("logical.docker-race").unwrap(),
            isolation: WorkspaceIsolation::Shared,
        },
        owner: OwnerId::new("owner-a").unwrap(),
        access_mode: WorkspaceAccessMode::Exclusive,
        mode: WorkspaceMode::Docker(docker()),
    };
    let prepare = tokio::spawn(async move { manager.prepare(request).await });
    effects.received.notified().await;
    let target = base.join("mounts/source");
    std::fs::remove_dir(&target).unwrap();
    symlink("/var/run/docker.sock", &target).unwrap();
    effects.resume.notify_one();
    assert_eq!(
        prepare.await.unwrap().unwrap_err().kind(),
        WorkspaceLeaseErrorKind::InvalidInput
    );
    assert!(effects.pinned_directory_consumed.load(Ordering::SeqCst));
    assert_eq!(effects.create_calls.load(Ordering::SeqCst), 0);
    std::fs::remove_dir_all(scope).unwrap();
}

#[derive(Default)]
struct RacingDockerEffects {
    received: Notify,
    resume: Notify,
    pinned_directory_consumed: AtomicBool,
    create_calls: AtomicUsize,
}

#[async_trait]
impl DockerWorkspaceEffects for RacingDockerEffects {
    async fn inspect(
        &self,
        request: DockerResourceRequest<'_>,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError> {
        self.received.notify_one();
        self.resume.notified().await;
        assert!(
            request.mounts.iter().all(|mount| mount
                .source_directory()
                .metadata()
                .unwrap()
                .is_dir())
        );
        self.pinned_directory_consumed.store(true, Ordering::SeqCst);
        Ok(WorkspaceResourceObservation::Absent)
    }

    async fn create(&self, _request: DockerResourceRequest<'_>) -> Result<(), WorkspaceLeaseError> {
        self.create_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn cleanup(
        &self,
        _request: DockerResourceRequest<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        Ok(())
    }
}

#[derive(Default)]
struct CountingDockerEffects {
    calls: AtomicUsize,
}

#[async_trait]
impl DockerWorkspaceEffects for CountingDockerEffects {
    async fn inspect(
        &self,
        _request: DockerResourceRequest<'_>,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(WorkspaceResourceObservation::Absent)
    }

    async fn create(&self, _request: DockerResourceRequest<'_>) -> Result<(), WorkspaceLeaseError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn cleanup(
        &self,
        _request: DockerResourceRequest<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn worktree() -> WorktreeWorkspace {
    WorktreeWorkspace {
        repository: CanonicalRepository::new(
            SourceProviderRef::new(SourceProviderId::new("source.github").unwrap(), 1).unwrap(),
            SourceProfileId::new("production").unwrap(),
            SourceAccountId::new("open-engine").unwrap(),
            SourceRepositoryId::new("the-open-engine/zeroshot").unwrap(),
        )
        .unwrap(),
        revision: SourceRevisionId::new("revision-abc").unwrap(),
        source_profile: SourceProfileId::new("production").unwrap(),
        name: WorkspaceName::new("lease-a").unwrap(),
        branch: SourceBranchId::new("feat/677").unwrap(),
        profile: WorkspaceProfile::new("durable-worktree").unwrap(),
        materialization: WorkspaceMaterializationId::new("materialization-1").unwrap(),
    }
}
