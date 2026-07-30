use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Notify;

use zeroshot_engine::cluster_ledger::OwnerId;
use zeroshot_engine::workspace_lease::fake::{FakeEffectFailure, FakeResourceAction};
use zeroshot_engine::workspace_lease::{
    DockerImageDigest, DockerMountHandleId, DockerResourceId, DockerWorkspace,
    PrepareWorkspaceRequest, SqliteWorkspaceLeaseHooks, SqliteWorkspaceLeaseStore,
    WorkspaceIsolation, WorkspaceLeaseError, WorkspaceLeaseErrorKind, WorkspaceLeaseId,
    WorkspaceLeaseManager, WorkspaceLeaseOwnerRequest, WorkspaceLeaseRecord, WorkspaceLeaseState,
    WorkspaceLeaseStore, WorkspaceMode, WorkspaceResourceObservation, WorkspaceResourcePort,
};

#[path = "support/workspace.rs"]
mod support;
use support::{LeaseFixture, borrowed_request, docker_request, execution, lease_key, worktree_request};

type WorkspaceRequestFactory = fn(&str) -> PrepareWorkspaceRequest;
type NamedWorkspaceMode = (&'static str, WorkspaceRequestFactory);

#[tokio::test]
async fn lease_identity_is_the_scheduler_resource_and_execution_isolation_is_exact() {
    let shared_a = WorkspaceLeaseId::derive(&lease_key(WorkspaceIsolation::Shared));
    let shared_b = WorkspaceLeaseId::derive(&lease_key(WorkspaceIsolation::Shared));
    let isolated =
        WorkspaceLeaseId::derive(&lease_key(WorkspaceIsolation::Execution(execution(9))));

    assert_eq!(shared_a, shared_b);
    assert_ne!(shared_a, isolated);
    assert!(shared_a.resource_id().as_str().starts_with("workspace."));

    let fixture = LeaseFixture::new();
    let ready = fixture
        .manager
        .prepare(docker_request("owner-a"))
        .await
        .unwrap();
    assert_eq!(ready.state, WorkspaceLeaseState::Ready);
    assert_eq!(ready.access().lease_key(), ready.id.resource_id());
    assert_eq!(ready.access().mode(), ready.access_mode);
}

#[tokio::test]
async fn create_requires_committed_pending_intent_and_authoritative_absence() {
    let fixture = LeaseFixture::new();
    fixture
        .resources
        .fail_next_create(FakeEffectFailure::BeforeEffect);
    let request = docker_request("owner-a");
    let id = WorkspaceLeaseId::derive(&request.key);

    let error = fixture.manager.prepare(request).await.unwrap_err();
    assert_eq!(error.kind(), WorkspaceLeaseErrorKind::ResourceUnavailable);
    let pending = fixture.store.record(&id).expect("intent committed first");
    assert_eq!(pending.state, WorkspaceLeaseState::CreatePending);
    assert_eq!(pending.owner.as_str(), "owner-a");
    assert_eq!(
        fixture
            .resources
            .actions()
            .into_iter()
            .map(|(_, action)| action)
            .collect::<Vec<_>>(),
        vec![FakeResourceAction::Inspect, FakeResourceAction::Create]
    );
}

#[tokio::test]
async fn owner_and_mode_mismatches_preserve_the_existing_resource() {
    let fixture = LeaseFixture::new();
    fixture
        .resources
        .fail_next_create(FakeEffectFailure::AfterEffect);
    let first = docker_request("owner-a");
    let id = WorkspaceLeaseId::derive(&first.key);
    fixture.manager.prepare(first).await.unwrap_err();
    assert!(fixture.resources.contains(&id));

    let error = fixture
        .manager
        .prepare(docker_request("owner-b"))
        .await
        .unwrap_err();
    assert_eq!(error.kind(), WorkspaceLeaseErrorKind::OwnerMismatch);
    assert!(fixture.resources.contains(&id));
    let mut changed_mode = docker_request("owner-a");
    changed_mode.mode = WorkspaceMode::Docker(
        DockerWorkspace::new(
            DockerImageDigest::new(format!("sha256:{}", "d".repeat(64))).unwrap(),
            DockerResourceId::new("different-resource").unwrap(),
            vec![DockerMountHandleId::new("workspace").unwrap()],
        )
        .unwrap(),
    );
    let error = fixture.manager.prepare(changed_mode).await.unwrap_err();
    assert_eq!(error.kind(), WorkspaceLeaseErrorKind::ResourceMismatch);
    assert!(fixture.resources.contains(&id));

    let error = fixture
        .manager
        .cleanup(WorkspaceLeaseOwnerRequest {
            id: id.clone(),
            owner: OwnerId::new("owner-b").unwrap(),
        })
        .await
        .unwrap_err();
    assert_eq!(error.kind(), WorkspaceLeaseErrorKind::OwnerMismatch);
    assert!(fixture.resources.contains(&id));
}

#[tokio::test]
async fn cleanup_failure_is_retryable_and_never_releases_identity() {
    let fixture = LeaseFixture::new();
    let ready = fixture
        .manager
        .prepare(docker_request("owner-a"))
        .await
        .unwrap();
    fixture
        .resources
        .fail_next_cleanup(FakeEffectFailure::BeforeEffect);
    let owner = WorkspaceLeaseOwnerRequest {
        id: ready.id.clone(),
        owner: ready.owner.clone(),
    };

    let error = fixture.manager.cleanup(owner.clone()).await.unwrap_err();
    assert_eq!(error.kind(), WorkspaceLeaseErrorKind::ResourceUnavailable);
    let required = fixture.store.record(&ready.id).unwrap();
    assert_eq!(required.state, WorkspaceLeaseState::CleanupRequired);
    assert_eq!(required.access(), ready.access());
    assert!(fixture.resources.contains(&ready.id));

    let cleaned = fixture.manager.cleanup(owner).await.unwrap();
    assert_eq!(cleaned.state, WorkspaceLeaseState::Cleaned);
    assert!(!fixture.resources.contains(&ready.id));
}

#[tokio::test]
async fn direct_cleanup_reconciles_uncertain_create_for_every_owned_mode() {
    let owned: [NamedWorkspaceMode; 2] =
        [("worktree", worktree_request), ("docker", docker_request)];
    for (name, request) in owned {
        let fixture = LeaseFixture::new();
        fixture
            .resources
            .fail_next_create(FakeEffectFailure::AfterEffect);
        let request = request("owner-a");
        let id = WorkspaceLeaseId::derive(&request.key);
        let owner = request.owner.clone();
        fixture.manager.prepare(request).await.unwrap_err();
        assert_eq!(
            fixture.store.record(&id).unwrap().state,
            WorkspaceLeaseState::CreatePending,
            "{name}"
        );

        fixture
            .resources
            .fail_next_cleanup(FakeEffectFailure::AfterEffect);
        let owner_request = WorkspaceLeaseOwnerRequest {
            id: id.clone(),
            owner,
        };
        let error = fixture
            .manager
            .cleanup(owner_request.clone())
            .await
            .unwrap_err();
        assert_eq!(
            error.kind(),
            WorkspaceLeaseErrorKind::ResourceUnavailable,
            "{name}"
        );
        assert_eq!(
            fixture.store.record(&id).unwrap().state,
            WorkspaceLeaseState::CleanupRequired,
            "{name}"
        );

        let cleaned = fixture.manager.cleanup(owner_request).await.unwrap();
        assert_eq!(cleaned.state, WorkspaceLeaseState::Cleaned, "{name}");
        assert!(!fixture.resources.contains(&id), "{name}");
        let actions = fixture.resources.actions();
        assert_eq!(
            actions
                .iter()
                .filter(|(_, action)| *action == FakeResourceAction::Create)
                .count(),
            1,
            "{name}"
        );
        assert_eq!(
            actions
                .iter()
                .filter(|(_, action)| *action == FakeResourceAction::Cleanup)
                .count(),
            1,
            "{name}"
        );
    }
}

#[tokio::test]
async fn all_mode_race_table_is_deterministic_and_borrowed_never_deletes() {
    let owned: [NamedWorkspaceMode; 2] =
        [("worktree", worktree_request), ("docker", docker_request)];
    for (name, request) in owned {
        let fixture = LeaseFixture::new();
        fixture
            .resources
            .fail_next_create(FakeEffectFailure::AfterEffect);
        let request = request("owner-a");
        let id = WorkspaceLeaseId::derive(&request.key);
        let owner = request.owner.clone();
        fixture.manager.prepare(request).await.unwrap_err();
        let ready = fixture
            .manager
            .restart(WorkspaceLeaseOwnerRequest {
                id: id.clone(),
                owner: owner.clone(),
            })
            .await
            .unwrap();
        assert_eq!(ready.state, WorkspaceLeaseState::Ready, "{name}");

        fixture
            .resources
            .fail_next_cleanup(FakeEffectFailure::AfterEffect);
        fixture
            .manager
            .cleanup(WorkspaceLeaseOwnerRequest {
                id: id.clone(),
                owner: owner.clone(),
            })
            .await
            .unwrap_err();
        let cleaned = fixture
            .manager
            .restart(WorkspaceLeaseOwnerRequest { id, owner })
            .await
            .unwrap();
        assert_eq!(cleaned.state, WorkspaceLeaseState::Cleaned, "{name}");
        let actions = fixture.resources.actions();
        assert_eq!(
            actions
                .iter()
                .filter(|(_, action)| *action == FakeResourceAction::Create)
                .count(),
            1,
            "{name}"
        );
        assert_eq!(
            actions
                .iter()
                .filter(|(_, action)| *action == FakeResourceAction::Cleanup)
                .count(),
            1,
            "{name}"
        );
    }

    let borrowed = LeaseFixture::new();
    let request = borrowed_request("owner-a");
    let id = WorkspaceLeaseId::derive(&request.key);
    let owner = request.owner.clone();
    assert_eq!(
        borrowed
            .manager
            .prepare(request.clone())
            .await
            .unwrap_err()
            .kind(),
        WorkspaceLeaseErrorKind::NotFound
    );
    let pending = borrowed.store.record(&id).unwrap();
    borrowed.resources.seed(pending);
    let ready = borrowed.manager.prepare(request).await.unwrap();
    let actions_before_cleanup = borrowed.resources.actions();
    let cleaned = borrowed
        .manager
        .cleanup(WorkspaceLeaseOwnerRequest {
            id: id.clone(),
            owner,
        })
        .await
        .unwrap();
    assert_eq!(ready.state, WorkspaceLeaseState::Ready);
    assert_eq!(cleaned.state, WorkspaceLeaseState::Cleaned);
    assert!(borrowed.resources.contains(&id));
    assert_eq!(borrowed.resources.actions(), actions_before_cleanup);
    assert!(
        borrowed
            .resources
            .actions()
            .iter()
            .all(|(_, action)| *action == FakeResourceAction::Inspect)
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn prepare_and_cleanup_serialize_the_absence_to_create_interval() {
    let root = std::env::temp_dir().join(format!("zeroshot-workspace-race-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let database = root.join("leases.sqlite3");
    let resources = Arc::new(PausingResourcePort::default());
    let prepare_manager = Arc::new(WorkspaceLeaseManager::new(
        Arc::new(SqliteWorkspaceLeaseStore::open(&database).unwrap()),
        resources.clone(),
    ));
    let cleanup_manager = Arc::new(WorkspaceLeaseManager::new(
        Arc::new(SqliteWorkspaceLeaseStore::open(&database).unwrap()),
        resources.clone(),
    ));
    let request = docker_request("owner-a");
    let owner = WorkspaceLeaseOwnerRequest {
        id: WorkspaceLeaseId::derive(&request.key),
        owner: request.owner.clone(),
    };
    resources.pause_next_inspect.store(true, Ordering::SeqCst);
    let prepare = {
        let manager = prepare_manager.clone();
        tokio::spawn(async move { manager.prepare(request).await })
    };
    resources.inspected.notified().await;
    let cleanup = {
        let manager = cleanup_manager.clone();
        let owner = owner.clone();
        tokio::spawn(async move { manager.cleanup(owner).await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    assert!(
        !cleanup.is_finished(),
        "cleanup must wait while create owns the per-lease operation interval"
    );
    resources.resume.notify_one();
    assert_eq!(
        prepare.await.unwrap().unwrap().state,
        WorkspaceLeaseState::Ready
    );
    assert_eq!(
        cleanup.await.unwrap().unwrap().state,
        WorkspaceLeaseState::Cleaned
    );
    assert!(!resources.inner.contains(&owner.id));
    drop(prepare_manager);
    drop(cleanup_manager);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn database_symlink_alias_shares_the_absence_to_effect_operation_fence() {
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::{MetadataExt, symlink};

    let root = std::env::temp_dir().join(format!(
        "zeroshot-workspace-alias-lock-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let database = root.join("leases.sqlite3");
    let alias = root.join("leases-alias.sqlite3");
    let canonical_store = Arc::new(SqliteWorkspaceLeaseStore::open(&database).unwrap());
    let request = docker_request("owner-a");
    let id = WorkspaceLeaseId::derive(&request.key);
    let owner = WorkspaceLeaseOwnerRequest {
        id: id.clone(),
        owner: request.owner.clone(),
    };
    let metadata = std::fs::metadata(&database).unwrap();
    let legacy_lock_root = root.join(format!(
        ".zeroshot-workspace-locks-{:x}-{:x}",
        metadata.dev(),
        metadata.ino()
    ));
    std::fs::create_dir_all(&legacy_lock_root).unwrap();
    let digest = Sha256::digest(id.resource_id().as_str().as_bytes());
    let replaceable_lock = legacy_lock_root.join(format!("{digest:x}.lock"));
    std::fs::write(&replaceable_lock, b"original").unwrap();
    symlink(&database, &alias).unwrap();
    let blocked = Arc::new(Notify::new());
    let alias_store = Arc::new(
        SqliteWorkspaceLeaseStore::open_with_hooks(
            &alias,
            SqliteWorkspaceLeaseHooks {
                lock_contention: Some({
                    let blocked = blocked.clone();
                    Arc::new(move || blocked.notify_one())
                }),
                ..SqliteWorkspaceLeaseHooks::default()
            },
        )
        .unwrap(),
    );
    let resources = Arc::new(PausingResourcePort::default());
    resources.pause_next_inspect.store(true, Ordering::SeqCst);
    let prepare_manager = WorkspaceLeaseManager::new(canonical_store.clone(), resources.clone());
    let cleanup_manager = WorkspaceLeaseManager::new(alias_store.clone(), resources.clone());

    let prepare = tokio::spawn(async move { prepare_manager.prepare(request).await });
    resources.inspected.notified().await;
    std::fs::remove_file(&replaceable_lock).unwrap();
    std::fs::write(&replaceable_lock, b"replacement").unwrap();
    assert_eq!(
        canonical_store.load(&id).await.unwrap().unwrap().state,
        WorkspaceLeaseState::CreatePending
    );
    assert!(!resources.inner.contains(&id));
    let cleanup = tokio::spawn(async move { cleanup_manager.cleanup(owner).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), blocked.notified())
        .await
        .expect("alias operation did not observe the canonical lock");
    assert!(!cleanup.is_finished());
    assert_eq!(
        alias_store.load(&id).await.unwrap().unwrap().state,
        WorkspaceLeaseState::CreatePending
    );
    assert!(!resources.inner.contains(&id));

    resources.resume.notify_one();
    assert_eq!(
        prepare.await.unwrap().unwrap().state,
        WorkspaceLeaseState::Ready
    );
    assert_eq!(
        cleanup.await.unwrap().unwrap().state,
        WorkspaceLeaseState::Cleaned
    );
    assert!(!resources.inner.contains(&id));
    let actions = resources.inner.actions();
    assert_eq!(
        actions
            .iter()
            .filter(|(_, action)| *action == FakeResourceAction::Create)
            .count(),
        1
    );
    assert_eq!(
        actions
            .iter()
            .filter(|(_, action)| *action == FakeResourceAction::Cleanup)
            .count(),
        1
    );
    drop(canonical_store);
    drop(alias_store);
    std::fs::remove_dir_all(root).unwrap();
}

#[derive(Default)]
struct PausingResourcePort {
    inner: zeroshot_engine::workspace_lease::fake::FakeWorkspaceResourcePort,
    pause_next_inspect: AtomicBool,
    inspected: Notify,
    resume: Notify,
}

#[async_trait]
impl WorkspaceResourcePort for PausingResourcePort {
    async fn inspect(
        &self,
        lease: &WorkspaceLeaseRecord,
    ) -> Result<WorkspaceResourceObservation, WorkspaceLeaseError> {
        let observation = self.inner.inspect(lease).await?;
        if self.pause_next_inspect.swap(false, Ordering::SeqCst) {
            self.inspected.notify_one();
            self.resume.notified().await;
        }
        Ok(observation)
    }

    async fn create(&self, lease: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError> {
        self.inner.create(lease).await
    }

    async fn cleanup(&self, lease: &WorkspaceLeaseRecord) -> Result<(), WorkspaceLeaseError> {
        self.inner.cleanup(lease).await
    }
}

#[tokio::test]
async fn cleaned_owned_orphan_is_reconciled_exactly_once() {
    let fixture = LeaseFixture::new();
    let ready = fixture
        .manager
        .prepare(docker_request("owner-a"))
        .await
        .unwrap();
    let owner = WorkspaceLeaseOwnerRequest {
        id: ready.id.clone(),
        owner: ready.owner.clone(),
    };
    let cleaned = fixture.manager.cleanup(owner.clone()).await.unwrap();
    fixture.resources.seed(cleaned);
    let cleanup_before = fixture
        .resources
        .actions()
        .iter()
        .filter(|(_, action)| *action == FakeResourceAction::Cleanup)
        .count();

    assert_eq!(
        fixture.manager.cleanup(owner.clone()).await.unwrap().state,
        WorkspaceLeaseState::Cleaned
    );
    assert!(!fixture.resources.contains(&owner.id));
    let cleanup_after = fixture
        .resources
        .actions()
        .iter()
        .filter(|(_, action)| *action == FakeResourceAction::Cleanup)
        .count();
    assert_eq!(cleanup_after, cleanup_before + 1);
    fixture.manager.cleanup(owner).await.unwrap();
    let final_cleanup_count = fixture
        .resources
        .actions()
        .iter()
        .filter(|(_, action)| *action == FakeResourceAction::Cleanup)
        .count();
    assert_eq!(final_cleanup_count, cleanup_after);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn workspace_operation_lock_spans_processes() {
    let root = std::env::temp_dir().join(format!(
        "zeroshot-workspace-process-lock-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let database = root.join("leases.sqlite3");
    let ready = root.join("child-ready");
    let signal = root.join("parent-attempt-signal");
    let blocked = root.join("child-blocked");
    let acquired = root.join("child-acquired");
    let store = SqliteWorkspaceLeaseStore::open(&database).unwrap();
    let id = WorkspaceLeaseId::derive(&lease_key(WorkspaceIsolation::Shared));
    let owner = OwnerId::new("owner-a").unwrap();
    let guard = store.acquire_operation(&id, &owner).await.unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "workspace_operation_lock_child", "--nocapture"])
        .env("ZEROSHOT_WORKSPACE_LOCK_DB", &database)
        .env("ZEROSHOT_WORKSPACE_LOCK_READY", &ready)
        .env("ZEROSHOT_WORKSPACE_LOCK_SIGNAL", &signal)
        .env("ZEROSHOT_WORKSPACE_LOCK_BLOCKED", &blocked)
        .env("ZEROSHOT_WORKSPACE_LOCK_ACQUIRED", &acquired)
        .spawn()
        .unwrap();
    wait_for_marker(&ready).await;
    std::fs::write(&signal, b"attempt").unwrap();
    wait_for_marker(&blocked).await;
    assert!(!acquired.exists());
    assert!(child.try_wait().unwrap().is_none());
    drop(guard);
    assert!(child.wait().unwrap().success());
    assert!(acquired.is_file());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
async fn wait_for_marker(path: &std::path::Path) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !path.is_file() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("subprocess marker handshake timed out");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn workspace_operation_lock_child() {
    let Some(database) = std::env::var_os("ZEROSHOT_WORKSPACE_LOCK_DB") else {
        return;
    };
    let ready = std::env::var_os("ZEROSHOT_WORKSPACE_LOCK_READY").unwrap();
    let signal = std::env::var_os("ZEROSHOT_WORKSPACE_LOCK_SIGNAL").unwrap();
    let blocked =
        std::path::PathBuf::from(std::env::var_os("ZEROSHOT_WORKSPACE_LOCK_BLOCKED").unwrap());
    let acquired = std::env::var_os("ZEROSHOT_WORKSPACE_LOCK_ACQUIRED").unwrap();
    let store = SqliteWorkspaceLeaseStore::open_with_hooks(
        database,
        SqliteWorkspaceLeaseHooks {
            lock_contention: Some(Arc::new(move || {
                std::fs::write(&blocked, b"blocked").unwrap();
            })),
            ..SqliteWorkspaceLeaseHooks::default()
        },
    )
    .unwrap();
    let id = WorkspaceLeaseId::derive(&lease_key(WorkspaceIsolation::Shared));
    let owner = OwnerId::new("owner-a").unwrap();
    std::fs::write(ready, b"ready").unwrap();
    wait_for_marker(std::path::Path::new(&signal)).await;
    let _guard = store.acquire_operation(&id, &owner).await.unwrap();
    std::fs::write(acquired, b"acquired").unwrap();
}
