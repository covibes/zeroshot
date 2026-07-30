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
    FilesystemBorrowedWorkspaceFingerprint, FilesystemBorrowedWorkspaceFingerprintHooks,
    PrepareWorkspaceRequest, WorkspaceFingerprint, WorkspaceIsolation, WorkspaceLeaseError,
    WorkspaceLeaseErrorKind, WorkspaceLeaseId, WorkspaceLeaseKey, WorkspaceLeaseManager,
    WorkspaceLeaseOwnerRequest, WorkspaceLeaseState, WorkspaceLeaseStore,
    WorkspaceMaterializationId, WorkspaceMode, WorkspaceName, WorkspaceProductRootHooks,
    WorkspaceProductRoots, WorkspaceProfile, WorkspaceResourceObservation, WorktreeResourceRequest,
    WorktreeWorkspace, WorktreeWorkspaceAdapter, WorktreeWorkspaceEffects,
};

fn injected_resource_unavailable() -> WorkspaceLeaseError {
    let absent = std::env::temp_dir().join(format!(
        "zeroshot-injected-absent-workspace-{}",
        std::process::id()
    ));
    FilesystemBorrowedWorkspaceFingerprint::default()
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
    let mut mode_with_unknown_field = serde_json::to_value(&mode).unwrap();
    mode_with_unknown_field
        .as_object_mut()
        .unwrap()
        .insert("unexpected".to_owned(), serde_json::json!(true));
    assert!(serde_json::from_value::<WorkspaceMode>(mode_with_unknown_field).is_err());
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

#[cfg(target_os = "linux")]
#[test]
fn product_base_ancestor_swap_after_descriptor_open_fails_before_child_creation() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let (scope, base) = private_product_base("base-construction-swap");
    let detached = scope.with_extension("detached");
    let outside_scope = scope.with_extension("outside");
    let outside_base = outside_scope.join("zeroshot/workspaces");
    std::fs::create_dir_all(&outside_base).unwrap();
    std::fs::set_permissions(&outside_base, std::fs::Permissions::from_mode(0o700)).unwrap();
    let hooks = WorkspaceProductRootHooks {
        after_base_open: Some(Arc::new({
            let scope = scope.clone();
            let detached = detached.clone();
            let outside_scope = outside_scope.clone();
            move || {
                std::fs::rename(&scope, &detached).unwrap();
                symlink(&outside_scope, &scope).unwrap();
            }
        })),
        ..WorkspaceProductRootHooks::default()
    };
    assert_eq!(
        WorkspaceProductRoots::new_with_hooks(
            CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
            hooks,
        )
        .err()
        .unwrap()
        .kind(),
        WorkspaceLeaseErrorKind::ResourceMismatch
    );
    assert!(!outside_base.join("worktrees").exists());
    assert!(!outside_base.join("mounts").exists());
    std::fs::remove_file(&scope).unwrap();
    std::fs::rename(&detached, &scope).unwrap();
    std::fs::remove_dir_all(scope).unwrap();
    std::fs::remove_dir_all(outside_scope).unwrap();
}

#[tokio::test]
async fn borrowed_workspace_is_inspected_but_never_owned_or_deleted() {
    let path = std::env::temp_dir().join(format!("zeroshot-borrowed-{}", std::process::id()));
    std::fs::create_dir_all(&path).unwrap();
    let canonical = std::fs::canonicalize(&path).unwrap();
    let fingerprint = FilesystemBorrowedWorkspaceFingerprint::default()
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
#[test]
fn borrowed_root_replacement_after_descriptor_traversal_fails_final_revalidation() {
    let scope = std::env::temp_dir().join(format!("zeroshot-borrowed-swap-{}", std::process::id()));
    let root = scope.join("root");
    let aside = scope.join("root-aside");
    let replacement = scope.join("replacement");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&replacement).unwrap();
    std::fs::write(root.join("same"), b"content").unwrap();
    std::fs::write(replacement.join("same"), b"content").unwrap();
    let canonical = std::fs::canonicalize(&root).unwrap();
    let hooks = FilesystemBorrowedWorkspaceFingerprintHooks {
        before_root_revalidation: Some(Arc::new({
            let root = root.clone();
            let aside = aside.clone();
            let replacement = replacement.clone();
            move || {
                std::fs::rename(&root, &aside).unwrap();
                std::fs::rename(&replacement, &root).unwrap();
            }
        })),
    };
    let error = FilesystemBorrowedWorkspaceFingerprint::new_with_hooks(hooks)
        .fingerprint(&canonical)
        .unwrap_err();
    assert_eq!(error.kind(), WorkspaceLeaseErrorKind::ResourceUnavailable);
    std::fs::rename(&root, &replacement).unwrap();
    std::fs::rename(&aside, &root).unwrap();
    assert!(
        FilesystemBorrowedWorkspaceFingerprint::default()
            .fingerprint(&canonical)
            .is_ok()
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
        destination: SourceMaterializationDestination<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        destination
            .write_file("capability-probe", b"pinned")
            .expect("adapter provides only a scoped destination operation");
        assert!(request.is_available());
        request
            .remove_file("capability-probe")
            .expect("request capability addresses the same pinned workspace");
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
struct PartialCreateMismatchEffects {
    cleanup_calls: AtomicUsize,
    fail_cleanup_once: AtomicBool,
    inspect_calls: AtomicUsize,
}

#[cfg(target_os = "linux")]
impl Default for PartialCreateMismatchEffects {
    fn default() -> Self {
        Self {
            cleanup_calls: AtomicUsize::new(0),
            fail_cleanup_once: AtomicBool::new(true),
            inspect_calls: AtomicUsize::new(0),
        }
    }
}

#[cfg(target_os = "linux")]
#[async_trait]
impl WorktreeWorkspaceEffects for PartialCreateMismatchEffects {
    async fn inspect(
        &self,
        _request: WorktreeResourceRequest<'_>,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError> {
        self.inspect_calls.fetch_add(1, Ordering::SeqCst);
        Ok(WorkspaceResourceObservation::Mismatch)
    }

    async fn create(
        &self,
        _request: WorktreeResourceRequest<'_>,
        destination: SourceMaterializationDestination<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        destination
            .write_file("partial", b"incomplete")
            .expect("adapter provides the scoped materialization operation");
        Err(injected_resource_unavailable())
    }

    async fn cleanup(
        &self,
        request: WorktreeResourceRequest<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        self.cleanup_calls.fetch_add(1, Ordering::SeqCst);
        if self.fail_cleanup_once.swap(false, Ordering::SeqCst) {
            return Err(injected_resource_unavailable());
        }
        request.remove_file("partial").unwrap();
        Ok(())
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn partial_private_materialization_restarts_into_retryable_owner_cleanup() {
    let (scope, base) = private_product_base("partial-private-materialization");
    let store = Arc::new(FakeWorkspaceLeaseStore::default());
    let effects = Arc::new(PartialCreateMismatchEffects::default());
    let manager = WorkspaceLeaseManager::new(
        store.clone(),
        Arc::new(WorktreeWorkspaceAdapter::new(
            WorkspaceProductRoots::new(
                CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
            )
            .unwrap(),
            effects.clone(),
        )),
    );
    let request = worktree_request_for("partial-private-materialization");
    let id = WorkspaceLeaseId::derive(&request.key);
    let owner = request.owner.clone();
    assert_eq!(
        manager.prepare(request).await.unwrap_err().kind(),
        WorkspaceLeaseErrorKind::ResourceUnavailable
    );
    let partial = base.join("worktrees/.lease-a.create-pending/.workspace.create-pending/partial");
    assert_eq!(std::fs::read(&partial).unwrap(), b"incomplete");
    assert!(!base.join("worktrees/lease-a").exists());

    for expect_success in [false, true] {
        let restarted_manager = WorkspaceLeaseManager::new(
            store.clone(),
            Arc::new(WorktreeWorkspaceAdapter::new(
                WorkspaceProductRoots::new(
                    CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
                )
                .unwrap(),
                effects.clone(),
            )),
        );
        let result = restarted_manager
            .restart(WorkspaceLeaseOwnerRequest {
                id: id.clone(),
                owner: owner.clone(),
            })
            .await;
        if expect_success {
            assert_eq!(result.unwrap().state, WorkspaceLeaseState::Cleaned);
        } else {
            assert_eq!(
                result.unwrap_err().kind(),
                WorkspaceLeaseErrorKind::ResourceUnavailable
            );
            assert_eq!(
                store.load(&id).await.unwrap().unwrap().state,
                WorkspaceLeaseState::CleanupRequired
            );
            assert!(partial.is_file());
        }
    }
    assert_eq!(effects.inspect_calls.load(Ordering::SeqCst), 0);
    assert_eq!(effects.cleanup_calls.load(Ordering::SeqCst), 2);
    assert!(!base.join("worktrees/.lease-a.create-pending").exists());
    assert!(!base.join("worktrees/lease-a").exists());
    std::fs::remove_dir_all(scope).unwrap();
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
    assert!(
        base.join("worktrees/.lease-a.create-pending/.workspace.create-pending")
            .is_dir()
    );
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
#[tokio::test]
async fn worktree_staging_crash_boundaries_remain_owner_cleanup_recoverable() {
    let cases = [
        (
            "staging-directory-crash",
            WorkspaceProductRootHooks {
                fail_after_staging_directory: Some(Arc::new({
                    let armed = AtomicBool::new(true);
                    move || armed.swap(false, Ordering::SeqCst)
                })),
                ..WorkspaceProductRootHooks::default()
            },
        ),
        (
            "owner-marker-crash",
            WorkspaceProductRootHooks {
                fail_after_owner_marker_create: Some(Arc::new({
                    let armed = AtomicBool::new(true);
                    move || armed.swap(false, Ordering::SeqCst)
                })),
                ..WorkspaceProductRootHooks::default()
            },
        ),
        (
            "owner-marker-synced-crash",
            WorkspaceProductRootHooks {
                fail_after_owner_marker_sync: Some(Arc::new({
                    let armed = AtomicBool::new(true);
                    move || armed.swap(false, Ordering::SeqCst)
                })),
                ..WorkspaceProductRootHooks::default()
            },
        ),
    ];
    for (label, hooks) in cases {
        let (scope, base) = private_product_base(label);
        let roots = WorkspaceProductRoots::new_with_hooks(
            CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
            hooks,
        )
        .unwrap();
        let store = Arc::new(FakeWorkspaceLeaseStore::default());
        let effects = Arc::new(CapturingWorktreeEffects::default());
        let manager = WorkspaceLeaseManager::new(
            store.clone(),
            Arc::new(WorktreeWorkspaceAdapter::new(roots, effects.clone())),
        );
        let request = worktree_request_for(label);
        let id = WorkspaceLeaseId::derive(&request.key);
        let owner = request.owner.clone();
        assert_eq!(
            manager.prepare(request).await.unwrap_err().kind(),
            WorkspaceLeaseErrorKind::ResourceUnavailable
        );
        assert!(!base.join("worktrees/lease-a").exists());
        assert!(base.join("worktrees/.lease-a.create-pending").is_dir());
        let restarted_manager = WorkspaceLeaseManager::new(
            store,
            Arc::new(WorktreeWorkspaceAdapter::new(
                WorkspaceProductRoots::new(
                    CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
                )
                .unwrap(),
                effects,
            )),
        );
        assert_eq!(
            restarted_manager
                .restart(WorkspaceLeaseOwnerRequest { id, owner })
                .await
                .unwrap()
                .state,
            WorkspaceLeaseState::Cleaned
        );
        assert!(!base.join("worktrees/.lease-a.create-pending").exists());
        std::fs::remove_dir_all(scope).unwrap();
    }
}
#[cfg(target_os = "linux")]
#[tokio::test]
async fn staging_cleanup_quarantine_is_restartable_without_mutable_name_unlink() {
    use std::os::unix::fs::symlink;
    let (scope, base) = private_product_base("staging-quarantine-restart");
    let store = Arc::new(FakeWorkspaceLeaseStore::default());
    let effects = Arc::new(CapturingWorktreeEffects::default());
    let create_roots = WorkspaceProductRoots::new_with_hooks(
        CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
        WorkspaceProductRootHooks {
            fail_after_owner_marker_sync: Some(Arc::new(|| true)),
            ..WorkspaceProductRootHooks::default()
        },
    )
    .unwrap();
    let manager = WorkspaceLeaseManager::new(
        store.clone(),
        Arc::new(WorktreeWorkspaceAdapter::new(create_roots, effects.clone())),
    );
    let request = worktree_request_for("staging-quarantine-restart");
    let id = WorkspaceLeaseId::derive(&request.key);
    let owner = request.owner.clone();
    assert_eq!(
        manager.prepare(request).await.unwrap_err().kind(),
        WorkspaceLeaseErrorKind::ResourceUnavailable
    );

    let cleanup_roots = WorkspaceProductRoots::new_with_hooks(
        CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
        WorkspaceProductRootHooks {
            fail_after_staging_quarantine: Some(Arc::new({
                let armed = AtomicBool::new(true);
                move || armed.swap(false, Ordering::SeqCst)
            })),
            ..WorkspaceProductRootHooks::default()
        },
    )
    .unwrap();
    let interrupted = WorkspaceLeaseManager::new(
        store.clone(),
        Arc::new(WorktreeWorkspaceAdapter::new(
            cleanup_roots,
            effects.clone(),
        )),
    );
    assert_eq!(
        interrupted
            .restart(WorkspaceLeaseOwnerRequest {
                id: id.clone(),
                owner: owner.clone(),
            })
            .await
            .unwrap_err()
            .kind(),
        WorkspaceLeaseErrorKind::ResourceUnavailable
    );
    let staging = base.join("worktrees/.lease-a.create-pending");
    let quarantine = base.join("worktrees/..lease-a.create-pending.cleanup");
    assert!(!staging.exists());
    assert!(quarantine.is_dir());
    assert_eq!(
        store.load(&id).await.unwrap().unwrap().state,
        WorkspaceLeaseState::CleanupRequired
    );

    let detached = quarantine.with_extension("detached");
    std::fs::rename(&quarantine, &detached).unwrap();
    symlink(&detached, &quarantine).unwrap();
    let substituted = WorkspaceLeaseManager::new(
        store.clone(),
        Arc::new(WorktreeWorkspaceAdapter::new(
            WorkspaceProductRoots::new(
                CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
            )
            .unwrap(),
            effects.clone(),
        )),
    );
    assert_eq!(
        substituted
            .restart(WorkspaceLeaseOwnerRequest {
                id: id.clone(),
                owner: owner.clone(),
            })
            .await
            .unwrap_err()
            .kind(),
        WorkspaceLeaseErrorKind::ResourceMismatch
    );
    assert!(detached.is_dir());
    assert!(quarantine.is_symlink());
    assert_eq!(
        store.load(&id).await.unwrap().unwrap().state,
        WorkspaceLeaseState::CleanupRequired
    );
    std::fs::remove_file(&quarantine).unwrap();
    std::fs::rename(&detached, &quarantine).unwrap();

    let restarted = WorkspaceLeaseManager::new(
        store,
        Arc::new(WorktreeWorkspaceAdapter::new(
            WorkspaceProductRoots::new(
                CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
            )
            .unwrap(),
            effects,
        )),
    );
    assert_eq!(
        restarted
            .restart(WorkspaceLeaseOwnerRequest { id, owner })
            .await
            .unwrap()
            .state,
        WorkspaceLeaseState::Cleaned
    );
    assert!(!quarantine.exists());
    std::fs::remove_dir_all(scope).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn foreign_content_in_interrupted_staging_is_preserved_as_mismatch() {
    let (scope, base) = private_product_base("foreign-staging");
    let hooks = WorkspaceProductRootHooks {
        fail_after_owner_marker_sync: Some(Arc::new(|| true)),
        ..WorkspaceProductRootHooks::default()
    };
    let roots = WorkspaceProductRoots::new_with_hooks(
        CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
        hooks,
    )
    .unwrap();
    let store = Arc::new(FakeWorkspaceLeaseStore::default());
    let effects = Arc::new(CapturingWorktreeEffects::default());
    let manager = WorkspaceLeaseManager::new(
        store.clone(),
        Arc::new(WorktreeWorkspaceAdapter::new(roots, effects.clone())),
    );
    let request = worktree_request_for("foreign-staging");
    let id = WorkspaceLeaseId::derive(&request.key);
    let owner = request.owner.clone();
    assert!(manager.prepare(request).await.is_err());
    let foreign = base.join("worktrees/.lease-a.create-pending/foreign");
    std::fs::write(&foreign, b"preserve").unwrap();
    let restarted_manager = WorkspaceLeaseManager::new(
        store,
        Arc::new(WorktreeWorkspaceAdapter::new(
            WorkspaceProductRoots::new(
                CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
            )
            .unwrap(),
            effects,
        )),
    );
    assert_eq!(
        restarted_manager
            .restart(WorkspaceLeaseOwnerRequest { id, owner })
            .await
            .unwrap_err()
            .kind(),
        WorkspaceLeaseErrorKind::ResourceMismatch
    );
    assert_eq!(std::fs::read(&foreign).unwrap(), b"preserve");
    std::fs::remove_dir_all(scope).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn ready_public_container_foreign_sibling_is_preserved_before_effects() {
    let (scope, base) = private_product_base("foreign-public-sibling");
    let store = Arc::new(FakeWorkspaceLeaseStore::default());
    let effects = Arc::new(CapturingWorktreeEffects::default());
    let manager = WorkspaceLeaseManager::new(
        store.clone(),
        Arc::new(WorktreeWorkspaceAdapter::new(
            WorkspaceProductRoots::new(
                CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
            )
            .unwrap(),
            effects.clone(),
        )),
    );
    let request = worktree_request_for("foreign-public-sibling");
    let id = WorkspaceLeaseId::derive(&request.key);
    let owner = request.owner.clone();
    assert_eq!(
        manager.prepare(request).await.unwrap().state,
        WorkspaceLeaseState::Ready
    );
    let foreign = base.join("worktrees/lease-a/foreign");
    std::fs::write(&foreign, b"preserve").unwrap();
    let restarted_manager = WorkspaceLeaseManager::new(
        store,
        Arc::new(WorktreeWorkspaceAdapter::new(
            WorkspaceProductRoots::new(
                CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
            )
            .unwrap(),
            effects,
        )),
    );
    assert_eq!(
        restarted_manager
            .restart(WorkspaceLeaseOwnerRequest {
                id: id.clone(),
                owner: owner.clone(),
            })
            .await
            .unwrap_err()
            .kind(),
        WorkspaceLeaseErrorKind::ResourceMismatch
    );
    assert_eq!(
        restarted_manager
            .cleanup(WorkspaceLeaseOwnerRequest { id, owner })
            .await
            .unwrap_err()
            .kind(),
        WorkspaceLeaseErrorKind::ResourceMismatch
    );
    assert_eq!(std::fs::read(&foreign).unwrap(), b"preserve");
    assert!(base.join("worktrees/lease-a/workspace").is_dir());
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
        request.write_file("residual", b"still present").unwrap();
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
    std::fs::remove_file(base.join("worktrees/lease-a/.workspace.cleanup/residual")).unwrap();
    assert_eq!(
        manager
            .cleanup(WorkspaceLeaseOwnerRequest { id, owner })
            .await
            .unwrap()
            .state,
        WorkspaceLeaseState::Cleaned
    );
    assert_eq!(effects.cleanup_calls.load(Ordering::SeqCst), 1);
    std::fs::remove_dir_all(scope).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn cleanup_quarantine_crash_boundaries_reconcile_without_orphans() {
    for (label, boundary) in [
        ("inner-cleanup-quarantine-crash", 0),
        ("outer-cleanup-quarantine-crash", 1),
        ("owner-marker-removal-crash", 2),
    ] {
        let armed = Arc::new(AtomicBool::new(true));
        let failpoint = Arc::new({
            let armed = armed.clone();
            move || armed.swap(false, Ordering::SeqCst)
        });
        let hooks = WorkspaceProductRootHooks {
            fail_after_inner_quarantine: (boundary == 0).then_some(failpoint.clone()),
            fail_after_outer_quarantine: (boundary == 1).then_some(failpoint.clone()),
            fail_after_owner_marker_removal: (boundary == 2).then_some(failpoint),
            ..WorkspaceProductRootHooks::default()
        };
        let (scope, base) = private_product_base(label);
        let roots = WorkspaceProductRoots::new_with_hooks(
            CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
            hooks,
        )
        .unwrap();
        let effects = Arc::new(CapturingWorktreeEffects::default());
        let store = Arc::new(FakeWorkspaceLeaseStore::default());
        let manager = WorkspaceLeaseManager::new(
            store.clone(),
            Arc::new(WorktreeWorkspaceAdapter::new(roots, effects.clone())),
        );
        let request = worktree_request_for(label);
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
        let quarantine = if boundary == 0 {
            base.join("worktrees/lease-a/.workspace.cleanup")
        } else {
            base.join("worktrees/.lease-a.cleanup")
        };
        assert!(quarantine.exists());
        let restarted_manager = WorkspaceLeaseManager::new(
            store.clone(),
            Arc::new(WorktreeWorkspaceAdapter::new(
                WorkspaceProductRoots::new(
                    CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
                )
                .unwrap(),
                effects.clone(),
            )),
        );
        assert_eq!(
            restarted_manager
                .restart(WorkspaceLeaseOwnerRequest { id, owner })
                .await
                .unwrap()
                .state,
            WorkspaceLeaseState::Cleaned
        );
        assert!(!effects.exists.load(Ordering::SeqCst));
        for path in [
            base.join("worktrees/lease-a"),
            base.join("worktrees/.lease-a.create-pending"),
            base.join("worktrees/.lease-a.cleanup"),
        ] {
            assert!(!path.exists(), "orphaned {}", path.display());
        }
        std::fs::remove_dir_all(scope).unwrap();
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn fresh_restart_preserves_substituted_quarantine_for_every_cleanup_boundary() {
    use std::os::unix::fs::symlink;

    for (label, boundary) in [
        ("inner-quarantine-substitution", 0),
        ("outer-quarantine-substitution", 1),
        ("marker-removal-quarantine-substitution", 2),
    ] {
        let armed = Arc::new(AtomicBool::new(true));
        let failpoint = Arc::new({
            let armed = armed.clone();
            move || armed.swap(false, Ordering::SeqCst)
        });
        let hooks = WorkspaceProductRootHooks {
            fail_after_inner_quarantine: (boundary == 0).then_some(failpoint.clone()),
            fail_after_outer_quarantine: (boundary == 1).then_some(failpoint.clone()),
            fail_after_owner_marker_removal: (boundary == 2).then_some(failpoint),
            ..WorkspaceProductRootHooks::default()
        };
        let (scope, base) = private_product_base(label);
        let store = Arc::new(FakeWorkspaceLeaseStore::default());
        let effects = Arc::new(CapturingWorktreeEffects::default());
        let manager = WorkspaceLeaseManager::new(
            store.clone(),
            Arc::new(WorktreeWorkspaceAdapter::new(
                WorkspaceProductRoots::new_with_hooks(
                    CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
                    hooks,
                )
                .unwrap(),
                effects.clone(),
            )),
        );
        let request = worktree_request_for(label);
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
        let quarantine = if boundary == 0 {
            base.join("worktrees/lease-a/.workspace.cleanup")
        } else {
            base.join("worktrees/.lease-a.cleanup")
        };
        let detached = quarantine.with_extension("detached");
        std::fs::rename(&quarantine, &detached).unwrap();
        symlink(&detached, &quarantine).unwrap();
        let restarted_manager = WorkspaceLeaseManager::new(
            store,
            Arc::new(WorktreeWorkspaceAdapter::new(
                WorkspaceProductRoots::new(
                    CanonicalWorkspaceRoot::new(base.to_string_lossy()).unwrap(),
                )
                .unwrap(),
                effects,
            )),
        );
        assert_eq!(
            restarted_manager
                .restart(WorkspaceLeaseOwnerRequest { id, owner })
                .await
                .unwrap_err()
                .kind(),
            WorkspaceLeaseErrorKind::ResourceMismatch
        );
        assert!(
            std::fs::symlink_metadata(&quarantine)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(detached.is_dir());
        std::fs::remove_dir_all(scope).unwrap();
    }
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
        assert!(request.is_available());
        Ok(if self.exists.load(Ordering::SeqCst) {
            WorkspaceResourceObservation::Matching
        } else {
            WorkspaceResourceObservation::Absent
        })
    }

    async fn create(
        &self,
        request: WorktreeResourceRequest<'_>,
        destination: SourceMaterializationDestination<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        self.received.notify_one();
        self.resume.notified().await;
        destination
            .write_file("materialized", b"safe")
            .expect("worktree destination remains an ephemeral operation capability");
        assert!(request.is_available());
        self.exists.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn cleanup(
        &self,
        request: WorktreeResourceRequest<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        request.remove_file("materialized").unwrap();
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
        request.write_file("materialized", b"owned").unwrap();
        self.exists.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn cleanup(
        &self,
        request: WorktreeResourceRequest<'_>,
    ) -> Result<(), WorkspaceLeaseError> {
        self.cleanup_started.notify_one();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            self.cleanup_resume.notified(),
        )
        .await
        .map_err(|_| injected_resource_unavailable())?;
        request.remove_file("materialized").unwrap();
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
    let fingerprints = FilesystemBorrowedWorkspaceFingerprint::default();
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
