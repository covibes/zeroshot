use std::sync::Arc;

use openengine_cluster_testkit::assertions::{AssertError, AssertValue};

use super::super::controller_authority::credentials::{
    refresh_lock_is_held,
    test_support::{MemoryDeviceCodeNotifier, UnavailableCredentialStore},
};
use super::super::*;
use super::fixtures::{hosted_target, temp_root};
use super::hosted_authority::{LoginBlockingCredentialStore, spawn_target_authority};

#[tokio::test]
async fn login_preflights_credential_persistence_before_requesting_a_device_code() {
    let root = temp_root();
    let (origin, server) = spawn_target_authority(2).await;
    let notifier = Arc::new(MemoryDeviceCodeNotifier::default());
    let authority = TargetHttpControlAuthority::with_dependencies(
        Arc::new(UnavailableCredentialStore),
        notifier.clone(),
        root.path("refresh-locks"),
    );

    assert_eq!(
        authority
            .login(&hosted_target("local", origin))
            .await
            .assert_error()
            .to_string(),
        "test credential store unavailable"
    );
    assert!(notifier.values().is_empty());
    let requests = server.await.assert_value();
    assert_eq!(requests.len(), 2);
    assert!(
        requests
            .iter()
            .all(|request| request.path != "/oauth/device")
    );
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn login_holds_the_target_refresh_family_lock_through_persistence() {
    let root = temp_root();
    let (origin, server) = spawn_target_authority(5).await;
    let credentials = Arc::new(LoginBlockingCredentialStore::new("refresh-0"));
    let lock_directory = root.path("refresh-locks");
    let authority = TargetHttpControlAuthority::with_dependencies(
        credentials.clone(),
        Arc::new(MemoryDeviceCodeNotifier::default()),
        lock_directory.clone(),
    );
    let target = hosted_target("local", origin);
    let lock_path = lock_directory.join(format!("target-{}-refresh.lock", target.id));
    let login = tokio::spawn(async move { authority.login(&target).await });
    credentials.wait_until_prepared().await;

    assert!(refresh_lock_is_held(&lock_directory, &lock_path).assert_value());
    assert_eq!(credentials.reads(), 0);
    credentials.release_login();

    login.await.assert_value().assert_value();
    assert!(!refresh_lock_is_held(&lock_directory, &lock_path).assert_value());
    assert_eq!(credentials.reads(), 0);
    assert_eq!(credentials.value(), "refresh-1");
    assert_eq!(server.await.assert_value().len(), 5);
}
