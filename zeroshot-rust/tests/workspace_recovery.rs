use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use zeroshot_engine::cluster_ledger::OwnerId;

use zeroshot_engine::workspace_lease::fake::{
    FakeEffectFailure, FakeResourceAction, FakeWorkspaceResourcePort,
};
use zeroshot_engine::workspace_lease::{
    SqliteWorkspaceLeaseHooks, SqliteWorkspaceLeaseStore, WorkspaceLeaseErrorKind,
    WorkspaceLeaseId, WorkspaceLeaseManager, WorkspaceLeaseOwnerRequest, WorkspaceLeaseState,
    WorkspaceLeaseStore, WorkspaceLeaseTransition,
};

#[allow(dead_code)]
#[path = "support/workspace.rs"]
mod support;
use support::{LeaseFixture, docker_request};

#[cfg(not(target_os = "linux"))]
#[test]
fn sqlite_store_fails_closed_without_descriptor_identity_support() {
    let path = std::env::temp_dir().join("zeroshot-unsupported-workspace-leases.sqlite3");
    assert_eq!(
        SqliteWorkspaceLeaseStore::open(path).err().unwrap().kind(),
        WorkspaceLeaseErrorKind::StoreUnavailable
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn sqlite_connection_is_bound_to_verified_descriptor_during_path_swap_restore() {
    let root = std::env::temp_dir().join(format!(
        "zeroshot-workspace-connection-swap-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let database = root.join("leases.sqlite3");
    let aside = root.join("leases-expected-aside.sqlite3");
    let replacement = root.join("leases-replacement.sqlite3");
    let armed = Arc::new(AtomicBool::new(false));
    let swapped = Arc::new(AtomicBool::new(false));
    let unrelated_expected_descriptors = Arc::new(std::sync::Mutex::new(Vec::new()));
    let hooks = SqliteWorkspaceLeaseHooks {
        before_connection_open: Some({
            let armed = armed.clone();
            let swapped = swapped.clone();
            let database = database.clone();
            let aside = aside.clone();
            let replacement = replacement.clone();
            Arc::new(move || {
                if armed.swap(false, Ordering::SeqCst) {
                    std::fs::rename(&database, &aside).unwrap();
                    std::fs::rename(&replacement, &database).unwrap();
                    swapped.store(true, Ordering::SeqCst);
                }
            })
        }),
        after_connection_open: Some({
            let swapped = swapped.clone();
            let database = database.clone();
            let aside = aside.clone();
            let replacement = replacement.clone();
            let unrelated_expected_descriptors = unrelated_expected_descriptors.clone();
            Arc::new(move || {
                if swapped.swap(false, Ordering::SeqCst) {
                    std::fs::rename(&database, &replacement).unwrap();
                    std::fs::rename(&aside, &database).unwrap();
                    unrelated_expected_descriptors
                        .lock()
                        .unwrap()
                        .push(std::fs::File::open(&database).unwrap());
                }
            })
        }),
        ..SqliteWorkspaceLeaseHooks::default()
    };
    let store = Arc::new(SqliteWorkspaceLeaseStore::open_with_hooks(&database, hooks).unwrap());
    std::fs::copy(&database, &replacement).unwrap();
    let resources = Arc::new(FakeWorkspaceResourcePort::default());
    let manager = WorkspaceLeaseManager::new(store.clone(), resources.clone());
    let request = docker_request("owner-a");
    let id = WorkspaceLeaseId::derive(&request.key);
    armed.store(true, Ordering::SeqCst);

    assert_eq!(
        manager.prepare(request.clone()).await.unwrap_err().kind(),
        WorkspaceLeaseErrorKind::StoreUnavailable
    );
    assert!(store.load(&id).await.unwrap().is_none());
    let replacement_store = SqliteWorkspaceLeaseStore::open(&replacement).unwrap();
    assert!(
        replacement_store.load(&id).await.unwrap().is_none(),
        "a transient replacement must never receive lease rows"
    );
    assert!(
        resources.actions().is_empty(),
        "a safely rejected descriptor swap must precede resource effects"
    );
    drop(replacement_store);

    assert_eq!(
        manager.prepare(request).await.unwrap().state,
        WorkspaceLeaseState::Ready
    );
    assert_eq!(
        store.load(&id).await.unwrap().unwrap().state,
        WorkspaceLeaseState::Ready
    );
    assert_eq!(
        resources
            .actions()
            .iter()
            .filter(|(_, action)| *action == FakeResourceAction::Create)
            .count(),
        1
    );
    drop(manager);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn sqlite_post_connection_open_identity_check_precedes_row_and_resource_effects() {
    assert_post_boundary_identity_check(true).await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn sqlite_post_operation_lock_identity_check_precedes_row_and_resource_effects() {
    assert_post_boundary_identity_check(false).await;
}

#[cfg(target_os = "linux")]
async fn assert_post_boundary_identity_check(after_connection_open: bool) {
    let boundary = if after_connection_open {
        "connection"
    } else {
        "operation-lock"
    };
    let root = std::env::temp_dir().join(format!(
        "zeroshot-workspace-post-{boundary}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let database = root.join("leases.sqlite3");
    let hardlink = root.join("leases-hardlink.sqlite3");
    let armed = Arc::new(AtomicBool::new(false));
    let mutate_identity: Arc<dyn Fn() + Send + Sync> = {
        let armed = armed.clone();
        let database = database.clone();
        let hardlink = hardlink.clone();
        Arc::new(move || {
            if armed.swap(false, Ordering::SeqCst) {
                std::fs::hard_link(&database, &hardlink).unwrap();
            }
        })
    };
    let hooks = if after_connection_open {
        SqliteWorkspaceLeaseHooks {
            after_connection_open: Some(mutate_identity),
            ..SqliteWorkspaceLeaseHooks::default()
        }
    } else {
        SqliteWorkspaceLeaseHooks {
            after_operation_lock: Some(mutate_identity),
            ..SqliteWorkspaceLeaseHooks::default()
        }
    };
    let store = Arc::new(SqliteWorkspaceLeaseStore::open_with_hooks(&database, hooks).unwrap());
    let resources = Arc::new(FakeWorkspaceResourcePort::default());
    let manager = WorkspaceLeaseManager::new(store.clone(), resources.clone());
    let request = docker_request("owner-a");
    let id = WorkspaceLeaseId::derive(&request.key);
    armed.store(true, Ordering::SeqCst);

    assert_eq!(
        manager.prepare(request).await.unwrap_err().kind(),
        WorkspaceLeaseErrorKind::StoreUnavailable
    );
    assert!(resources.actions().is_empty());
    std::fs::remove_file(hardlink).unwrap();
    assert!(store.load(&id).await.unwrap().is_none());
    drop(manager);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn sqlite_store_rejects_same_directory_hardlink_authority() {
    assert_hardlink_alias_rejected(false).await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn sqlite_store_rejects_cross_directory_hardlink_authority() {
    assert_hardlink_alias_rejected(true).await;
}

#[cfg(target_os = "linux")]
async fn assert_hardlink_alias_rejected(cross_directory: bool) {
    let scope = if cross_directory { "cross" } else { "same" };
    let root = std::env::temp_dir().join(format!(
        "zeroshot-workspace-hardlink-{scope}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let database = root.join("leases.sqlite3");
    let store = SqliteWorkspaceLeaseStore::open(&database).unwrap();
    let alias_parent = if cross_directory {
        let parent = root.join("alias-directory");
        std::fs::create_dir_all(&parent).unwrap();
        parent
    } else {
        root.clone()
    };
    let alias = alias_parent.join("leases-hardlink.sqlite3");
    std::fs::hard_link(&database, &alias).unwrap();

    let alias_error = SqliteWorkspaceLeaseStore::open(&alias).err().unwrap();
    assert_eq!(
        alias_error.kind(),
        WorkspaceLeaseErrorKind::StoreUnavailable
    );
    let id = WorkspaceLeaseId::derive(&docker_request("owner-a").key);
    assert_eq!(
        store.load(&id).await.unwrap_err().kind(),
        WorkspaceLeaseErrorKind::StoreUnavailable
    );

    std::fs::remove_file(alias).unwrap();
    assert!(store.load(&id).await.unwrap().is_none());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn sqlite_direct_cleanup_recovers_uncertain_create_without_restart() {
    let root = std::env::temp_dir().join(format!(
        "zeroshot-workspace-direct-cleanup-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let database = root.join("leases.sqlite3");
    let store = Arc::new(SqliteWorkspaceLeaseStore::open(&database).unwrap());
    let resources = Arc::new(FakeWorkspaceResourcePort::default());
    let manager = WorkspaceLeaseManager::new(store.clone(), resources.clone());
    resources.fail_next_create(FakeEffectFailure::AfterEffect);
    let request = docker_request("owner-a");
    let id = WorkspaceLeaseId::derive(&request.key);
    let owner = WorkspaceLeaseOwnerRequest {
        id: id.clone(),
        owner: request.owner.clone(),
    };
    manager.prepare(request).await.unwrap_err();

    resources.fail_next_cleanup(FakeEffectFailure::AfterEffect);
    assert_eq!(
        manager.cleanup(owner.clone()).await.unwrap_err().kind(),
        WorkspaceLeaseErrorKind::ResourceUnavailable
    );
    assert_eq!(
        store.load(&id).await.unwrap().unwrap().state,
        WorkspaceLeaseState::CleanupRequired
    );
    assert_eq!(
        manager.cleanup(owner).await.unwrap().state,
        WorkspaceLeaseState::Cleaned
    );
    let actions = resources.actions();
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
    drop(manager);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn uncertain_create_recovers_by_inspection_without_duplicate_create() {
    let fixture = LeaseFixture::new();
    fixture
        .resources
        .fail_next_create(FakeEffectFailure::AfterEffect);
    let request = docker_request("owner-a");
    let id = WorkspaceLeaseId::derive(&request.key);
    let owner = request.owner.clone();
    fixture.manager.prepare(request).await.unwrap_err();

    let restarted = WorkspaceLeaseManager::new(fixture.store.clone(), fixture.resources.clone());
    let recovered = restarted
        .restart(WorkspaceLeaseOwnerRequest {
            id: id.clone(),
            owner,
        })
        .await
        .unwrap();

    assert_eq!(recovered.state, WorkspaceLeaseState::Ready);
    assert_eq!(
        fixture
            .resources
            .actions()
            .iter()
            .filter(|(_, action)| *action == FakeResourceAction::Create)
            .count(),
        1
    );
    assert_eq!(recovered.access().lease_key(), id.resource_id());
}

#[tokio::test]
async fn absent_pending_resource_is_not_created_by_restart_inspection() {
    let fixture = LeaseFixture::new();
    fixture
        .resources
        .fail_next_create(FakeEffectFailure::BeforeEffect);
    let request = docker_request("owner-a");
    let id = WorkspaceLeaseId::derive(&request.key);
    let owner = request.owner.clone();
    fixture.manager.prepare(request).await.unwrap_err();

    let recovered = fixture
        .manager
        .restart(WorkspaceLeaseOwnerRequest { id, owner })
        .await
        .unwrap();
    assert_eq!(recovered.state, WorkspaceLeaseState::CreatePending);
    assert_eq!(
        fixture
            .resources
            .actions()
            .iter()
            .filter(|(_, action)| *action == FakeResourceAction::Create)
            .count(),
        1
    );
}

#[tokio::test]
async fn uncertain_cleanup_stays_inspectable_and_reconciles_both_outcomes() {
    let before = LeaseFixture::new();
    let ready = before
        .manager
        .prepare(docker_request("owner-a"))
        .await
        .unwrap();
    let owner = WorkspaceLeaseOwnerRequest {
        id: ready.id.clone(),
        owner: ready.owner.clone(),
    };
    before
        .resources
        .fail_next_cleanup(FakeEffectFailure::BeforeEffect);
    before.manager.cleanup(owner.clone()).await.unwrap_err();
    let inspected = before.manager.restart(owner.clone()).await.unwrap();
    assert_eq!(inspected.state, WorkspaceLeaseState::CleanupRequired);
    assert!(before.resources.contains(&ready.id));
    assert_eq!(
        before.manager.cleanup(owner).await.unwrap().state,
        WorkspaceLeaseState::Cleaned
    );

    let after = LeaseFixture::new();
    let ready = after
        .manager
        .prepare(docker_request("owner-a"))
        .await
        .unwrap();
    let owner = WorkspaceLeaseOwnerRequest {
        id: ready.id.clone(),
        owner: ready.owner.clone(),
    };
    after
        .resources
        .fail_next_cleanup(FakeEffectFailure::AfterEffect);
    after.manager.cleanup(owner.clone()).await.unwrap_err();
    assert!(!after.resources.contains(&ready.id));
    assert_eq!(
        after.manager.restart(owner).await.unwrap().state,
        WorkspaceLeaseState::Cleaned
    );
}

#[tokio::test]
async fn inspection_failure_and_resource_mismatch_fail_closed() {
    let fixture = LeaseFixture::new();
    let ready = fixture
        .manager
        .prepare(docker_request("owner-a"))
        .await
        .unwrap();
    fixture.resources.fail_next_inspect();
    let error = fixture
        .manager
        .restart(WorkspaceLeaseOwnerRequest {
            id: ready.id.clone(),
            owner: ready.owner.clone(),
        })
        .await
        .unwrap_err();
    assert_eq!(error.kind(), WorkspaceLeaseErrorKind::ResourceUnavailable);
    assert_eq!(
        fixture.store.record(&ready.id).unwrap().state,
        WorkspaceLeaseState::Ready
    );
    assert!(fixture.resources.contains(&ready.id));
    fixture.resources.remove(&ready.id);
    let error = fixture
        .manager
        .restart(WorkspaceLeaseOwnerRequest {
            id: ready.id.clone(),
            owner: ready.owner.clone(),
        })
        .await
        .unwrap_err();
    assert_eq!(error.kind(), WorkspaceLeaseErrorKind::ResourceUnavailable);
    assert_eq!(
        fixture.store.record(&ready.id).unwrap().state,
        WorkspaceLeaseState::Ready
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn sqlite_store_reopens_exact_cleanup_required_lease_with_a_fresh_instance() {
    let root = std::env::temp_dir().join(format!(
        "zeroshot-workspace-lease-store-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let database = root.join("leases.sqlite3");
    let resources = Arc::new(FakeWorkspaceResourcePort::default());
    let manager = WorkspaceLeaseManager::new(
        Arc::new(SqliteWorkspaceLeaseStore::open(&database).unwrap()),
        resources.clone(),
    );
    let ready = manager.prepare(docker_request("owner-a")).await.unwrap();
    let owner = WorkspaceLeaseOwnerRequest {
        id: ready.id.clone(),
        owner: ready.owner.clone(),
    };
    resources.fail_next_cleanup(FakeEffectFailure::BeforeEffect);
    manager.cleanup(owner.clone()).await.unwrap_err();
    let expected = manager.restart(owner.clone()).await.unwrap();
    assert_eq!(expected.state, WorkspaceLeaseState::CleanupRequired);
    drop(manager);

    let reopened = WorkspaceLeaseManager::new(
        Arc::new(SqliteWorkspaceLeaseStore::open(&database).unwrap()),
        resources,
    );
    let recovered = reopened.restart(owner.clone()).await.unwrap();
    assert_eq!(recovered, expected);
    assert_eq!(
        reopened.cleanup(owner).await.unwrap().state,
        WorkspaceLeaseState::Cleaned
    );
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn sqlite_store_enforces_exact_owner_state_revision_and_competing_cas() {
    let fixture = LeaseFixture::new();
    fixture
        .resources
        .fail_next_create(FakeEffectFailure::BeforeEffect);
    let request = docker_request("owner-a");
    let id = WorkspaceLeaseId::derive(&request.key);
    fixture.manager.prepare(request).await.unwrap_err();
    let pending = fixture.store.record(&id).unwrap();

    let root = std::env::temp_dir().join(format!("zeroshot-workspace-cas-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let database = root.join("leases.sqlite3");
    let store = SqliteWorkspaceLeaseStore::open(&database).unwrap();
    store.create_pending(pending.clone()).await.unwrap();

    let wrong_owner = store
        .transition(WorkspaceLeaseTransition {
            id: id.clone(),
            owner: OwnerId::new("owner-b").unwrap(),
            expected_revision: 0,
            expected_state: WorkspaceLeaseState::CreatePending,
            next_state: WorkspaceLeaseState::Ready,
        })
        .await
        .unwrap_err();
    assert_eq!(wrong_owner.kind(), WorkspaceLeaseErrorKind::OwnerMismatch);
    assert_eq!(store.load(&id).await.unwrap(), Some(pending.clone()));

    let stale_revision = store
        .transition(WorkspaceLeaseTransition {
            id: id.clone(),
            owner: pending.owner.clone(),
            expected_revision: 1,
            expected_state: WorkspaceLeaseState::CreatePending,
            next_state: WorkspaceLeaseState::Ready,
        })
        .await
        .unwrap_err();
    assert_eq!(stale_revision.kind(), WorkspaceLeaseErrorKind::Conflict);
    assert_eq!(store.load(&id).await.unwrap(), Some(pending.clone()));

    let stale_state = store
        .transition(WorkspaceLeaseTransition {
            id: id.clone(),
            owner: pending.owner.clone(),
            expected_revision: 0,
            expected_state: WorkspaceLeaseState::Ready,
            next_state: WorkspaceLeaseState::Cleaned,
        })
        .await
        .unwrap_err();
    assert_eq!(stale_state.kind(), WorkspaceLeaseErrorKind::Conflict);
    assert_eq!(store.load(&id).await.unwrap(), Some(pending.clone()));

    let illegal = store
        .transition(WorkspaceLeaseTransition {
            id: id.clone(),
            owner: pending.owner.clone(),
            expected_revision: 0,
            expected_state: WorkspaceLeaseState::CreatePending,
            next_state: WorkspaceLeaseState::CreatePending,
        })
        .await
        .unwrap_err();
    assert_eq!(illegal.kind(), WorkspaceLeaseErrorKind::Conflict);
    assert_eq!(store.load(&id).await.unwrap(), Some(pending.clone()));
    drop(store);

    let first = SqliteWorkspaceLeaseStore::open(&database).unwrap();
    let second = SqliteWorkspaceLeaseStore::open(&database).unwrap();
    let ready = WorkspaceLeaseTransition {
        id: id.clone(),
        owner: pending.owner.clone(),
        expected_revision: 0,
        expected_state: WorkspaceLeaseState::CreatePending,
        next_state: WorkspaceLeaseState::Ready,
    };
    let cleaned = WorkspaceLeaseTransition {
        id: id.clone(),
        owner: pending.owner.clone(),
        expected_revision: 0,
        expected_state: WorkspaceLeaseState::CreatePending,
        next_state: WorkspaceLeaseState::Cleaned,
    };
    let (first_result, second_result) =
        tokio::join!(first.transition(ready), second.transition(cleaned));
    assert_ne!(first_result.is_ok(), second_result.is_ok());
    let loser = if let Err(error) = first_result {
        error
    } else {
        second_result.unwrap_err()
    };
    assert_eq!(loser.kind(), WorkspaceLeaseErrorKind::Conflict);
    let persisted = SqliteWorkspaceLeaseStore::open(&database)
        .unwrap()
        .load(&id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(persisted.revision, 1);
    assert!(matches!(
        persisted.state,
        WorkspaceLeaseState::Ready | WorkspaceLeaseState::Cleaned
    ));
    std::fs::remove_dir_all(root).unwrap();
}
