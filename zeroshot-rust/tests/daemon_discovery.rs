use std::fs;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::sync::mpsc;
use std::time::Duration;

#[path = "support/temp_profile.rs"]
mod temp_profile;

use temp_profile::TempProfile;
use zeroshot_engine::daemon_auth::DaemonCredentials;
use zeroshot_engine::daemon_discovery::{
    CLUSTER_PROTOCOL, DAEMON_PROTOCOL, DaemonLocator, DiscoveryError, MAX_LOCATOR_BYTES,
    acquire_start_guard, read_locator, remove_locator_if_matches, replace_locator,
};

fn locator(profile: &TempProfile, port: u16) -> DaemonLocator {
    let credentials = DaemonCredentials::generate(profile.profile.digest()).expect("credentials");
    DaemonLocator {
        endpoint: format!("ws://127.0.0.1:{port}/daemon/initialize"),
        cluster_protocol: CLUSTER_PROTOCOL.to_owned(),
        daemon_protocol: DAEMON_PROTOCOL.to_owned(),
        profile_digest: credentials.profile_digest,
        daemon_nonce: credentials.daemon_nonce,
        capability: credentials.capability,
    }
}

#[test]
fn atomic_rotation_is_owner_only_and_old_owner_cannot_remove_winner() {
    let profile = TempProfile::new("atomic-rotation");
    let first = locator(&profile, 30101);
    let winner = locator(&profile, 30102);

    replace_locator(&profile.profile, &first).expect("publish first locator");
    let path = profile.profile.locator_path();
    let (opened_tx, opened_rx) = mpsc::sync_channel(0);
    let (rotated_tx, rotated_rx) = mpsc::sync_channel(0);
    let reader = std::thread::spawn(move || {
        let mut opened_before_rotation = fs::File::open(path).expect("open old locator");
        opened_tx.send(()).expect("signal opened locator");
        rotated_rx.recv().expect("wait for rotation");
        let mut bytes = Vec::new();
        opened_before_rotation
            .read_to_end(&mut bytes)
            .expect("read opened locator");
        serde_json::from_slice::<DaemonLocator>(&bytes).expect("complete old locator")
    });
    opened_rx.recv().expect("reader opened old locator");
    replace_locator(&profile.profile, &winner).expect("rotate locator");
    rotated_tx.send(()).expect("release reader");
    assert_eq!(
        reader.join().expect("reader thread"),
        first,
        "an open reader must retain the complete pre-rotation inode"
    );

    let metadata = fs::metadata(profile.profile.locator_path()).expect("locator metadata");
    assert_eq!(metadata.mode() & 0o777, 0o600);
    assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
    assert!(!remove_locator_if_matches(&profile.profile, &first).expect("old owner removal"));
    assert_eq!(
        read_locator(&profile.profile).expect("read locator"),
        Some(winner.clone())
    );
    assert!(remove_locator_if_matches(&profile.profile, &winner).expect("winner removal"));
    assert_eq!(
        read_locator(&profile.profile).expect("locator absent"),
        None
    );
}

#[test]
fn reader_opened_before_matching_removal_retains_complete_prior_locator() {
    let profile = TempProfile::new("reader-removal-race");
    let current = locator(&profile, 30103);
    replace_locator(&profile.profile, &current).expect("publish locator");
    let mut opened_before_removal =
        fs::File::open(profile.profile.locator_path()).expect("open locator");

    assert!(remove_locator_if_matches(&profile.profile, &current).expect("matching removal"));
    assert_eq!(
        opened_before_removal
            .metadata()
            .expect("opened metadata")
            .nlink(),
        0
    );
    let mut bytes = Vec::new();
    opened_before_removal
        .read_to_end(&mut bytes)
        .expect("read unlinked prior locator");
    assert_eq!(
        serde_json::from_slice::<DaemonLocator>(&bytes).expect("complete prior locator"),
        current
    );
    assert_eq!(
        read_locator(&profile.profile).expect("locator absent"),
        None
    );
}

#[test]
fn locator_permissions_and_profile_permissions_fail_closed() {
    let profile = TempProfile::new("permissions");
    let current = locator(&profile, 30201);
    replace_locator(&profile.profile, &current).expect("publish locator");

    fs::set_permissions(
        profile.profile.locator_path(),
        fs::Permissions::from_mode(0o640),
    )
    .expect("weaken locator permissions");
    assert!(matches!(
        read_locator(&profile.profile),
        Err(DiscoveryError::InsecureFile)
    ));

    fs::set_permissions(profile.profile.root(), fs::Permissions::from_mode(0o750))
        .expect("weaken profile permissions");
    assert!(matches!(
        read_locator(&profile.profile),
        Err(DiscoveryError::InsecureProfileDirectory)
    ));
}

#[test]
fn same_owner_hard_links_fail_closed_for_locator_and_startup_lock() {
    let profile = TempProfile::new("hard-links");
    let current = locator(&profile, 30202);
    replace_locator(&profile.profile, &current).expect("publish locator");

    let locator_alias = profile.profile.root().join("locator-hard-link");
    fs::hard_link(profile.profile.locator_path(), &locator_alias).expect("hard-link locator");
    let locator_metadata = fs::metadata(profile.profile.locator_path()).expect("locator metadata");
    assert_eq!(locator_metadata.mode() & 0o777, 0o600);
    assert_eq!(locator_metadata.uid(), unsafe { libc::geteuid() });
    assert_eq!(locator_metadata.nlink(), 2);
    assert!(matches!(
        read_locator(&profile.profile),
        Err(DiscoveryError::InsecureFile)
    ));
    fs::remove_file(locator_alias).expect("remove locator hard link");

    let lock_path = profile.profile.root().join(".daemon-start.lock");
    let lock_alias = profile.profile.root().join("startup-lock-hard-link");
    fs::hard_link(&lock_path, &lock_alias).expect("hard-link startup lock");
    let lock_metadata = fs::metadata(&lock_path).expect("lock metadata");
    assert_eq!(lock_metadata.mode() & 0o777, 0o600);
    assert_eq!(lock_metadata.uid(), unsafe { libc::geteuid() });
    assert_eq!(lock_metadata.nlink(), 2);
    assert!(matches!(
        acquire_start_guard(&profile.profile, Duration::from_millis(20)),
        Err(DiscoveryError::InsecureFile)
    ));
}

#[test]
fn oversized_locator_is_rejected_without_partial_parsing() {
    let profile = TempProfile::new("oversize");
    let _guard =
        acquire_start_guard(&profile.profile, Duration::from_secs(1)).expect("profile dir");
    fs::write(
        profile.profile.locator_path(),
        vec![b'x'; MAX_LOCATOR_BYTES as usize + 1],
    )
    .expect("oversized locator");
    fs::set_permissions(
        profile.profile.locator_path(),
        fs::Permissions::from_mode(0o600),
    )
    .expect("owner-only oversized locator");

    assert!(matches!(
        read_locator(&profile.profile),
        Err(DiscoveryError::LocatorTooLarge)
    ));
}

#[test]
fn profile_start_serialization_has_a_bounded_loser() {
    let profile = TempProfile::new("start-lock");
    let _owner = acquire_start_guard(&profile.profile, Duration::from_secs(1)).expect("lock owner");
    let contender_profile = profile.profile.clone();
    let contender = std::thread::spawn(move || {
        acquire_start_guard(&contender_profile, Duration::from_millis(20)).map(drop)
    });

    assert!(matches!(
        contender.join().expect("contender thread"),
        Err(DiscoveryError::StartupLockTimeout)
    ));
}
