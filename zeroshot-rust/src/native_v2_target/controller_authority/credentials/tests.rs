use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_testkit::assertions::{AssertError, AssertValue};

use super::linux::LinuxTargetCredentialStore;
use super::private_file::PrivateFileTargetCredentialStore;
use super::test_support::{MemoryCredentialStore, UnavailableCredentialStore};
use super::{CredentialStorePreparation, TargetCredentialStore};

const TARGET_ID: &str = "11111111-1111-4111-8111-111111111111";

async fn prepare_and_store(store: &dyn TargetCredentialStore) {
    assert!(matches!(
        store.prepare_for_login(TARGET_ID).await.assert_value(),
        CredentialStorePreparation::PrivateFile(_)
    ));
    store.set(TARGET_ID, "refresh-token").await.assert_value();
}

#[tokio::test]
async fn private_file_credentials_persist_with_private_modes() {
    let root =
        openengine_cluster_testkit::TemporaryDirectory::for_test("zeroshot-private-credential");
    let directory = root.path("credentials");
    let first = PrivateFileTargetCredentialStore::new(directory.clone());
    prepare_and_store(&first).await;

    let second = PrivateFileTargetCredentialStore::new(directory.clone());
    assert_eq!(
        second.get(TARGET_ID).await.assert_value().as_deref(),
        Some("refresh-token")
    );
    assert_eq!(
        std::fs::metadata(&directory)
            .assert_value()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(directory.join(format!("{TARGET_ID}.json")))
            .assert_value()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[tokio::test]
async fn private_file_credentials_reject_broad_permissions() {
    let root = openengine_cluster_testkit::TemporaryDirectory::for_test(
        "zeroshot-private-credential-mode",
    );
    let directory = root.path("credentials");
    let store = PrivateFileTargetCredentialStore::new(directory.clone());
    store.set(TARGET_ID, "refresh-token").await.assert_value();
    let path = directory.join(format!("{TARGET_ID}.json"));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).assert_value();

    assert_eq!(
        store.get(TARGET_ID).await.assert_error().to_string(),
        "private target credential store read failed"
    );
}

#[tokio::test]
async fn private_file_credentials_reject_symlinks_and_special_files() {
    let root = openengine_cluster_testkit::TemporaryDirectory::for_test(
        "zeroshot-private-credential-special-file",
    );
    let directory = root.path("credentials");
    let store = PrivateFileTargetCredentialStore::new(directory.clone());
    store.prepare_for_login(TARGET_ID).await.assert_value();
    let credential = directory.join(format!("{TARGET_ID}.json"));
    let outside = root.path("outside.json");
    std::fs::write(&outside, b"not-a-credential").assert_value();
    std::os::unix::fs::symlink(&outside, &credential).assert_value();
    assert_eq!(
        store.get(TARGET_ID).await.assert_error().to_string(),
        "private target credential store read failed"
    );
    std::fs::remove_file(&credential).assert_value();

    let fifo_path = CString::new(credential.as_os_str().as_bytes()).assert_value();
    // SAFETY: fifo_path is NUL-terminated and names a path in the temporary test directory.
    assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), store.get(TARGET_ID))
            .await
            .assert_value()
            .assert_error()
            .to_string(),
        "private target credential store read failed"
    );
}

#[tokio::test]
async fn maximum_length_escaped_refresh_token_round_trips() {
    let root = openengine_cluster_testkit::TemporaryDirectory::for_test(
        "zeroshot-private-credential-max-token",
    );
    let store = PrivateFileTargetCredentialStore::new(root.path("credentials"));
    let token = "\\".repeat(16 * 1024);
    store.set(TARGET_ID, &token).await.assert_value();
    assert_eq!(store.get(TARGET_ID).await.assert_value(), Some(token));
}

#[tokio::test]
async fn linux_fallback_survives_a_new_store_instance() {
    let root =
        openengine_cluster_testkit::TemporaryDirectory::for_test("zeroshot-linux-credential");
    let directory = root.path("credentials");
    let first = LinuxTargetCredentialStore::with_dependencies(
        directory.clone(),
        Arc::new(UnavailableCredentialStore),
        None,
        false,
    )
    .assert_value();
    prepare_and_store(&first).await;

    let second = LinuxTargetCredentialStore::with_dependencies(
        directory,
        Arc::new(MemoryCredentialStore::default()),
        None,
        true,
    )
    .assert_value();
    assert_eq!(
        second.get(TARGET_ID).await.assert_value().as_deref(),
        Some("refresh-token")
    );
}

#[tokio::test]
async fn switching_to_system_removes_the_private_file_after_storage() {
    let root = openengine_cluster_testkit::TemporaryDirectory::for_test(
        "zeroshot-system-credential-cleanup",
    );
    let directory = root.path("credentials");
    let file_store = LinuxTargetCredentialStore::with_dependencies(
        directory.clone(),
        Arc::new(MemoryCredentialStore::default()),
        Some("file"),
        false,
    )
    .assert_value();
    prepare_and_store(&file_store).await;
    let credential = directory.join(format!("{TARGET_ID}.json"));
    assert!(credential.exists());

    let unavailable_system = LinuxTargetCredentialStore::with_dependencies(
        directory.clone(),
        Arc::new(UnavailableCredentialStore),
        Some("system"),
        false,
    )
    .assert_value();
    assert_eq!(
        unavailable_system
            .set(TARGET_ID, "unpersisted-refresh-token")
            .await
            .assert_error()
            .to_string(),
        "test credential store unavailable"
    );
    assert!(credential.exists());

    let system = Arc::new(MemoryCredentialStore::default());
    let system_store = LinuxTargetCredentialStore::with_dependencies(
        directory,
        system.clone(),
        Some("system"),
        false,
    )
    .assert_value();
    assert_eq!(
        system_store
            .prepare_for_login(TARGET_ID)
            .await
            .assert_value(),
        CredentialStorePreparation::Managed
    );
    system_store
        .set(TARGET_ID, "system-refresh-token")
        .await
        .assert_value();

    assert_eq!(
        system.get(TARGET_ID).await.assert_value().as_deref(),
        Some("system-refresh-token")
    );
    assert!(!credential.exists());
}

#[tokio::test]
async fn an_explicit_system_store_never_downgrades() {
    let root =
        openengine_cluster_testkit::TemporaryDirectory::for_test("zeroshot-system-credential");
    let store = LinuxTargetCredentialStore::with_dependencies(
        root.path("credentials"),
        Arc::new(UnavailableCredentialStore),
        Some("system"),
        false,
    )
    .assert_value();

    assert_eq!(
        store
            .prepare_for_login(TARGET_ID)
            .await
            .assert_error()
            .to_string(),
        "test credential store unavailable"
    );
}
