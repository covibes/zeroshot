//! Product-private native-profile daemon discovery.
//!
//! A locator is only a connection hint. Callers must prove liveness with the authenticated
//! initialize exchange in [`crate::daemon_listener`]; neither this module nor a locator treats a
//! PID or an open port as proof of a daemon.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const CLUSTER_PROTOCOL: &str = "openengine.cluster/v1";
pub const DAEMON_PROTOCOL: &str = "zeroshot.daemon/v1";
pub const MAX_LOCATOR_BYTES: u64 = 4_096;
const LOCATOR_FILE: &str = "daemon-locator.json";
const START_LOCK_FILE: &str = ".daemon-start.lock";
const SECRET_HEX_LEN: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeProfile {
    root: PathBuf,
    digest: String,
}

impl NativeProfile {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>, profile_identity: impl AsRef<[u8]>) -> Self {
        let digest = Sha256::digest(profile_identity.as_ref());
        Self {
            root: root.into(),
            digest: hex(&digest),
        }
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    #[must_use]
    pub fn digest(&self) -> &str {
        &self.digest
    }

    #[must_use]
    pub fn locator_path(&self) -> PathBuf {
        self.root.join(LOCATOR_FILE)
    }

    fn lock_path(&self) -> PathBuf {
        self.root.join(START_LOCK_FILE)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DaemonLocator {
    pub endpoint: String,
    pub cluster_protocol: String,
    pub daemon_protocol: String,
    pub profile_digest: String,
    pub daemon_nonce: String,
    pub capability: String,
}

impl DaemonLocator {
    pub fn validate_for(&self, profile: &NativeProfile) -> Result<(), DiscoveryError> {
        if self.cluster_protocol != CLUSTER_PROTOCOL
            || self.daemon_protocol != DAEMON_PROTOCOL
            || self.profile_digest != profile.digest
            || !is_lower_hex(&self.profile_digest, SECRET_HEX_LEN)
            || !is_lower_hex(&self.daemon_nonce, SECRET_HEX_LEN)
            || !is_lower_hex(&self.capability, SECRET_HEX_LEN)
        {
            return Err(DiscoveryError::InvalidLocator);
        }
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum DiscoveryError {
    #[error("daemon profile directory is not owner-only")]
    InsecureProfileDirectory,
    #[error("daemon discovery file is not an owner-only regular file")]
    InsecureFile,
    #[error("daemon locator exceeds {MAX_LOCATOR_BYTES} bytes")]
    LocatorTooLarge,
    #[error("daemon locator is invalid")]
    InvalidLocator,
    #[error("timed out serializing daemon profile startup")]
    StartupLockTimeout,
    #[error("operating-system randomness is unavailable")]
    Randomness,
    #[error("daemon discovery I/O failed: {0}")]
    Io(#[from] io::Error),
}

/// Exclusive, bounded profile-start serialization. Its only intended critical section is stale
/// probing plus bind/publish (or matching-owner removal), never the listener lifetime.
pub struct ProfileStartGuard {
    file: File,
}

impl Drop for ProfileStartGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

pub fn acquire_start_guard(
    profile: &NativeProfile,
    timeout: Duration,
) -> Result<ProfileStartGuard, DiscoveryError> {
    ensure_profile_directory(profile.root())?;
    let file = open_owner_file(&profile.lock_path(), true)?;
    validate_owner_file(&file.metadata()?)?;
    let deadline = Instant::now() + timeout;
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(ProfileStartGuard { file }),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(DiscoveryError::StartupLockTimeout);
                }
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => return Err(error.into()),
        }
    }
}

pub fn read_locator(profile: &NativeProfile) -> Result<Option<DaemonLocator>, DiscoveryError> {
    ensure_profile_directory(profile.root())?;
    read_locator_existing(profile)
}

pub fn replace_locator(
    profile: &NativeProfile,
    locator: &DaemonLocator,
) -> Result<(), DiscoveryError> {
    let _guard = acquire_start_guard(profile, Duration::from_secs(1))?;
    replace_locator_locked(profile, locator)
}

pub fn remove_locator_if_matches(
    profile: &NativeProfile,
    expected: &DaemonLocator,
) -> Result<bool, DiscoveryError> {
    let _guard = acquire_start_guard(profile, Duration::from_secs(1))?;
    remove_locator_if_matches_locked(profile, expected)
}

pub(crate) fn read_locator_locked(
    profile: &NativeProfile,
) -> Result<Option<DaemonLocator>, DiscoveryError> {
    read_locator_existing(profile)
}

pub(crate) fn replace_locator_locked(
    profile: &NativeProfile,
    locator: &DaemonLocator,
) -> Result<(), DiscoveryError> {
    locator.validate_for(profile)?;
    let bytes = serde_json::to_vec(locator).map_err(|_| DiscoveryError::InvalidLocator)?;
    if bytes.len() as u64 > MAX_LOCATOR_BYTES {
        return Err(DiscoveryError::LocatorTooLarge);
    }

    let suffix = random_hex()?;
    let temporary = profile.root().join(format!(".{LOCATOR_FILE}.{suffix}.tmp"));
    let write_result = (|| -> Result<(), DiscoveryError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, profile.locator_path())?;
        File::open(profile.root())?.sync_all()?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

pub(crate) fn remove_locator_if_matches_locked(
    profile: &NativeProfile,
    expected: &DaemonLocator,
) -> Result<bool, DiscoveryError> {
    if read_locator_existing(profile)?.as_ref() != Some(expected) {
        return Ok(false);
    }
    match fs::remove_file(profile.locator_path()) {
        Ok(()) => {
            File::open(profile.root())?.sync_all()?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn random_hex() -> Result<String, DiscoveryError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| DiscoveryError::Randomness)?;
    Ok(hex(&bytes))
}

fn read_locator_existing(profile: &NativeProfile) -> Result<Option<DaemonLocator>, DiscoveryError> {
    let file = match open_owner_file(&profile.locator_path(), false) {
        Ok(file) => file,
        Err(DiscoveryError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let opened_metadata = file.metadata()?;
    validate_open_locator_file(&opened_metadata)?;
    if opened_metadata.len() > MAX_LOCATOR_BYTES {
        return Err(DiscoveryError::LocatorTooLarge);
    }
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    file.take(MAX_LOCATOR_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_LOCATOR_BYTES {
        return Err(DiscoveryError::LocatorTooLarge);
    }
    let locator: DaemonLocator =
        serde_json::from_slice(&bytes).map_err(|_| DiscoveryError::InvalidLocator)?;
    locator.validate_for(profile)?;
    Ok(Some(locator))
}

fn ensure_profile_directory(path: &Path) -> Result<(), DiscoveryError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => validate_owner_directory(&metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(path)?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
            validate_owner_directory(&fs::symlink_metadata(path)?)
        }
        Err(error) => Err(error.into()),
    }
}

fn validate_owner_directory(metadata: &fs::Metadata) -> Result<(), DiscoveryError> {
    if !metadata.file_type().is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(DiscoveryError::InsecureProfileDirectory);
    }
    Ok(())
}

fn validate_owner_file(metadata: &fs::Metadata) -> Result<(), DiscoveryError> {
    if !metadata.file_type().is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
    {
        return Err(DiscoveryError::InsecureFile);
    }
    Ok(())
}

fn validate_open_locator_file(metadata: &fs::Metadata) -> Result<(), DiscoveryError> {
    if !metadata.file_type().is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() > 1
    {
        return Err(DiscoveryError::InsecureFile);
    }
    Ok(())
}

fn open_owner_file(path: &Path, create: bool) -> Result<File, DiscoveryError> {
    OpenOptions::new()
        .read(true)
        .write(create)
        .create(create)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| {
            if error.raw_os_error() == Some(libc::ELOOP) {
                DiscoveryError::InsecureFile
            } else {
                error.into()
            }
        })
}

fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}
