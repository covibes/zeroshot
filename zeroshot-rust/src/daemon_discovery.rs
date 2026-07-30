//! Product-private native-profile daemon discovery.
//!
//! A locator is only a connection hint. Callers must prove liveness with the authenticated
//! initialize exchange in [`crate::daemon_listener`]; neither this module nor a locator treats a
//! PID or an open port as proof of a daemon.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use platform::{
    atomic_replace, create_owner_file, ensure_profile_directory, open_owner_file, sync_directory,
    validate_open_locator_file, validate_owner_file,
};

#[cfg(not(any(unix, windows)))]
compile_error!("native daemon discovery requires an owner-security platform implementation");

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
    validate_owner_file(&file)?;
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
        let mut file = create_owner_file(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_replace(&temporary, &profile.locator_path())?;
        sync_directory(profile.root())?;
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
            sync_directory(profile.root())?;
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
    decode_open_locator(profile, file).map(Some)
}

fn decode_open_locator(
    profile: &NativeProfile,
    file: File,
) -> Result<DaemonLocator, DiscoveryError> {
    let opened_metadata = file.metadata()?;
    validate_open_locator_file(&file)?;
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
    Ok(locator)
}

#[cfg(any(windows, test))]
fn secure_directory_handle_shape(is_directory: bool, is_reparse_point: bool, links: u32) -> bool {
    is_directory && !is_reparse_point && links == 1
}

#[cfg(unix)]
mod platform {
    use std::fs::{self, File, OpenOptions};
    use std::io;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    use super::DiscoveryError;

    pub(super) fn ensure_profile_directory(path: &Path) -> Result<(), DiscoveryError> {
        match fs::symlink_metadata(path) {
            Ok(metadata) => {
                if !metadata.file_type().is_dir()
                    || metadata.uid() != unsafe { libc::geteuid() }
                    || metadata.mode() & 0o077 != 0
                {
                    return Err(DiscoveryError::InsecureProfileDirectory);
                }
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir_all(path)?;
                fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
                ensure_profile_directory(path)
            }
            Err(error) => Err(error.into()),
        }
    }

    pub(super) fn validate_owner_file(file: &File) -> Result<(), DiscoveryError> {
        let metadata = file.metadata()?;
        if !metadata.file_type().is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || metadata.nlink() != 1
        {
            return Err(DiscoveryError::InsecureFile);
        }
        Ok(())
    }

    pub(super) fn validate_open_locator_file(file: &File) -> Result<(), DiscoveryError> {
        let metadata = file.metadata()?;
        if !metadata.file_type().is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || metadata.nlink() > 1
        {
            return Err(DiscoveryError::InsecureFile);
        }
        Ok(())
    }

    pub(super) fn open_owner_file(path: &Path, create: bool) -> Result<File, DiscoveryError> {
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

    pub(super) fn create_owner_file(path: &Path) -> Result<File, DiscoveryError> {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(Into::into)
    }

    pub(super) fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
        fs::rename(source, destination)
    }

    pub(super) fn sync_directory(path: &Path) -> io::Result<()> {
        File::open(path)?.sync_all()
    }
}

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::fs::{self, File, OpenOptions};
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, LocalFree};
    use windows_sys::Win32::Security::Authorization::{
        GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo,
    };
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, ACL_SIZE_INFORMATION, AddAccessAllowedAce,
        AclSizeInformation, DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation,
        GetLengthSid, GetSecurityDescriptorControl, GetTokenInformation, InitializeAcl,
        OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSID, SE_DACL_PROTECTED,
        TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ALL_ACCESS, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW, WRITE_DAC,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    use super::DiscoveryError;

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    struct LocalSecurityDescriptor(*mut c_void);

    impl Drop for LocalSecurityDescriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }

    struct UserSid {
        storage: Vec<usize>,
        offset: usize,
        length: usize,
    }

    impl UserSid {
        fn as_ptr(&self) -> PSID {
            unsafe {
                self.storage
                    .as_ptr()
                    .cast::<u8>()
                    .add(self.offset)
                    .cast_mut()
                    .cast()
            }
        }
    }

    pub(super) fn ensure_profile_directory(path: &Path) -> Result<(), DiscoveryError> {
        match fs::symlink_metadata(path) {
            Ok(metadata) => {
                if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                    || !metadata.file_type().is_dir()
                {
                    return Err(DiscoveryError::InsecureProfileDirectory);
                }
                let directory = open_directory(path, false)?;
                validate_directory_shape(&directory)?;
                validate_owner_acl(&directory, true)
                    .map_err(|_| DiscoveryError::InsecureProfileDirectory)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir_all(path)?;
                let directory = open_directory(path, true)?;
                set_owner_only_acl(&directory)?;
                validate_directory_shape(&directory)?;
                validate_owner_acl(&directory, true)
                    .map_err(|_| DiscoveryError::InsecureProfileDirectory)
            }
            Err(error) => Err(error.into()),
        }
    }

    pub(super) fn validate_owner_file(file: &File) -> Result<(), DiscoveryError> {
        validate_file_shape(file, false)?;
        validate_owner_acl(file, false)
    }

    pub(super) fn validate_open_locator_file(file: &File) -> Result<(), DiscoveryError> {
        validate_file_shape(file, true)?;
        validate_owner_acl(file, false)
    }

    pub(super) fn open_owner_file(path: &Path, create: bool) -> Result<File, DiscoveryError> {
        reject_reparse_path(path)?;
        if create {
            match create_new_owner_file(path, true) {
                Ok(file) => return Ok(file),
                Err(DiscoveryError::Io(error)) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        let mut options = OpenOptions::new();
        options
            .access_mode(if create {
                GENERIC_READ | GENERIC_WRITE
            } else {
                GENERIC_READ
            })
            .share_mode(if create {
                FILE_SHARE_READ | FILE_SHARE_WRITE
            } else {
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
            })
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        options
            .open(path)
            .map_err(|error| map_open_error(path, error))
    }

    pub(super) fn create_owner_file(path: &Path) -> Result<File, DiscoveryError> {
        create_new_owner_file(path, false)
    }

    pub(super) fn atomic_replace(source: &Path, destination: &Path) -> Result<(), DiscoveryError> {
        let source = wide_path(source);
        let destination = wide_path(destination);
        let succeeded = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if succeeded == 0 {
            Err(io::Error::last_os_error().into())
        } else {
            Ok(())
        }
    }

    pub(super) fn sync_directory(_path: &Path) -> io::Result<()> {
        Ok(())
    }

    fn create_new_owner_file(path: &Path, lock_file: bool) -> Result<File, DiscoveryError> {
        reject_reparse_path(path)?;
        let mut options = OpenOptions::new();
        options
            .access_mode(GENERIC_READ | GENERIC_WRITE | WRITE_DAC)
            .share_mode(if lock_file {
                FILE_SHARE_READ | FILE_SHARE_WRITE
            } else {
                FILE_SHARE_READ
            })
            .create_new(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        let file = options
            .open(path)
            .map_err(|error| map_open_error(path, error))?;
        set_owner_only_acl(&file)?;
        validate_owner_file(&file)?;
        Ok(file)
    }

    fn open_directory(path: &Path, write_acl: bool) -> Result<File, DiscoveryError> {
        let mut options = OpenOptions::new();
        options
            .access_mode(if write_acl {
                GENERIC_READ | WRITE_DAC
            } else {
                GENERIC_READ
            })
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
        options.open(path).map_err(Into::into)
    }

    fn reject_reparse_path(path: &Path) -> Result<(), DiscoveryError> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 => {
                Err(DiscoveryError::InsecureFile)
            }
            Ok(_) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn map_open_error(path: &Path, error: io::Error) -> DiscoveryError {
        if fs::symlink_metadata(path)
            .map(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
            .unwrap_or(false)
        {
            DiscoveryError::InsecureFile
        } else {
            error.into()
        }
    }

    fn validate_directory_shape(file: &File) -> Result<(), DiscoveryError> {
        let information = file_information(file)?;
        if super::secure_directory_handle_shape(
            information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
            information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
            information.nNumberOfLinks,
        ) {
            Ok(())
        } else {
            Err(DiscoveryError::InsecureProfileDirectory)
        }
    }

    fn validate_file_shape(file: &File, allow_unlinked: bool) -> Result<(), DiscoveryError> {
        let information = file_information(file)?;
        if information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
            != 0
            || if allow_unlinked {
                information.nNumberOfLinks > 1
            } else {
                information.nNumberOfLinks != 1
            }
        {
            return Err(DiscoveryError::InsecureFile);
        }
        Ok(())
    }

    fn file_information(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION, DiscoveryError> {
        let mut information = unsafe { zeroed::<BY_HANDLE_FILE_INFORMATION>() };
        let succeeded =
            unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) };
        if succeeded == 0 {
            Err(io::Error::last_os_error().into())
        } else {
            Ok(information)
        }
    }

    fn set_owner_only_acl(file: &File) -> Result<(), DiscoveryError> {
        let sid = current_user_sid()?;
        let acl_bytes =
            size_of::<ACL>() + size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>() + sid.length;
        let mut storage = vec![0_usize; acl_bytes.div_ceil(size_of::<usize>())];
        let acl = storage.as_mut_ptr().cast::<ACL>();
        if unsafe { InitializeAcl(acl, acl_bytes as u32, ACL_REVISION) } == 0
            || unsafe { AddAccessAllowedAce(acl, ACL_REVISION, FILE_ALL_ACCESS, sid.as_ptr()) } == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let status = unsafe {
            SetSecurityInfo(
                file.as_raw_handle().cast(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl,
                null(),
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(status as i32).into())
        }
    }

    fn validate_owner_acl(file: &File, directory: bool) -> Result<(), DiscoveryError> {
        let sid = current_user_sid()?;
        let mut owner: PSID = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut descriptor = null_mut();
        let status = unsafe {
            GetSecurityInfo(
                file.as_raw_handle().cast(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32).into());
        }
        let _descriptor = LocalSecurityDescriptor(descriptor);
        let mut control = 0;
        let mut revision = 0;
        let control_ok =
            unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } != 0;
        let owner_ok = !owner.is_null() && unsafe { EqualSid(owner, sid.as_ptr()) } != 0;
        if !control_ok || control & SE_DACL_PROTECTED == 0 || !owner_ok || dacl.is_null() {
            return Err(if directory {
                DiscoveryError::InsecureProfileDirectory
            } else {
                DiscoveryError::InsecureFile
            });
        }
        let mut information = ACL_SIZE_INFORMATION::default();
        if unsafe {
            GetAclInformation(
                dacl,
                (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
            || information.AceCount != 1
        {
            return Err(if directory {
                DiscoveryError::InsecureProfileDirectory
            } else {
                DiscoveryError::InsecureFile
            });
        }
        let mut raw_ace = null_mut();
        if unsafe { GetAce(dacl, 0, &mut raw_ace) } == 0 {
            return Err(io::Error::last_os_error().into());
        }
        let ace = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
        let ace_sid = (&raw const ace.SidStart).cast_mut().cast();
        let valid = ace.Header.AceType == 0
            && ace.Mask & FILE_ALL_ACCESS == FILE_ALL_ACCESS
            && unsafe { EqualSid(ace_sid, sid.as_ptr()) } != 0;
        if valid {
            Ok(())
        } else if directory {
            Err(DiscoveryError::InsecureProfileDirectory)
        } else {
            Err(DiscoveryError::InsecureFile)
        }
    }

    fn current_user_sid() -> Result<UserSid, DiscoveryError> {
        let mut token = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error().into());
        }
        let _token = OwnedHandle(token);
        let mut needed = 0;
        unsafe {
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut needed);
        }
        if needed == 0 {
            return Err(io::Error::last_os_error().into());
        }
        let mut storage = vec![0_usize; (needed as usize).div_ceil(size_of::<usize>())];
        if unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                storage.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let base = storage.as_ptr().cast::<u8>();
        let user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
        let sid = user.User.Sid.cast::<u8>();
        let length = unsafe { GetLengthSid(user.User.Sid) } as usize;
        let offset = unsafe { sid.offset_from(base) } as usize;
        if length == 0 || offset.saturating_add(length) > storage.len() * size_of::<usize>() {
            return Err(DiscoveryError::InsecureFile);
        }
        Ok(UserSid {
            storage,
            offset,
            length,
        })
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }
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

#[cfg(test)]
mod platform_shape_tests {
    use super::secure_directory_handle_shape;

    #[test]
    fn opened_windows_directory_shape_rejects_same_owner_reparse_substitution() {
        assert!(secure_directory_handle_shape(true, false, 1));
        assert!(!secure_directory_handle_shape(true, true, 1));
        assert!(!secure_directory_handle_shape(false, false, 1));
        assert!(!secure_directory_handle_shape(true, false, 2));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::MetadataExt;

    use super::*;

    #[test]
    fn production_locator_decoder_accepts_an_opened_owner_inode_unlinked_during_read() {
        let root = std::env::temp_dir().join(format!(
            "zeroshot-open-locator-race-{}-{}",
            std::process::id(),
            random_hex().expect("temporary profile suffix")
        ));
        let profile = NativeProfile::new(&root, "native-profile:opened-locator");
        let locator = DaemonLocator {
            endpoint: "ws://127.0.0.1:30109/daemon/initialize".to_owned(),
            cluster_protocol: CLUSTER_PROTOCOL.to_owned(),
            daemon_protocol: DAEMON_PROTOCOL.to_owned(),
            profile_digest: profile.digest().to_owned(),
            daemon_nonce: "a".repeat(64),
            capability: "b".repeat(64),
        };
        replace_locator(&profile, &locator).expect("publish locator");
        let file = open_owner_file(&profile.locator_path(), false).expect("open locator");

        fs::remove_file(profile.locator_path()).expect("unlink opened locator");
        assert_eq!(file.metadata().expect("opened metadata").nlink(), 0);
        assert_eq!(
            decode_open_locator(&profile, file).expect("decode opened owner inode"),
            locator
        );

        fs::remove_dir_all(root).expect("remove temporary profile");
    }
}
