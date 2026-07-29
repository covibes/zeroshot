use std::path::Path;
use std::sync::Arc;

use sha2::{Digest, Sha256};

use super::{WorkspaceFingerprint, WorkspaceLeaseError, WorkspaceLeaseErrorKind};

const MAX_BORROWED_ENTRIES: usize = 10_000;
const MAX_BORROWED_BYTES: u64 = 64 * 1024 * 1024;

pub trait BorrowedWorkspaceFingerprintPort: Send + Sync {
    fn fingerprint(&self, root: &Path) -> Result<WorkspaceFingerprint, WorkspaceLeaseError>;
}

#[derive(Clone, Default)]
pub struct FilesystemBorrowedWorkspaceFingerprintHooks {
    pub before_root_revalidation: Option<Arc<dyn Fn() + Send + Sync>>,
}

#[derive(Clone, Default)]
pub struct FilesystemBorrowedWorkspaceFingerprint {
    hooks: FilesystemBorrowedWorkspaceFingerprintHooks,
}

impl FilesystemBorrowedWorkspaceFingerprint {
    #[must_use]
    pub fn new_with_hooks(hooks: FilesystemBorrowedWorkspaceFingerprintHooks) -> Self {
        Self { hooks }
    }
}

impl BorrowedWorkspaceFingerprintPort for FilesystemBorrowedWorkspaceFingerprint {
    fn fingerprint(&self, root: &Path) -> Result<WorkspaceFingerprint, WorkspaceLeaseError> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = root;
            return Err(fingerprint_error(
                "borrowed workspace fingerprinting requires Linux descriptor-relative traversal",
            ));
        }
        #[cfg(target_os = "linux")]
        {
            fingerprint_linux(root, &self.hooks)
        }
    }
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct FingerprintBounds {
    entries: usize,
    bytes: u64,
}

#[cfg(target_os = "linux")]
fn fingerprint_linux(
    root: &Path,
    hooks: &FilesystemBorrowedWorkspaceFingerprintHooks,
) -> Result<WorkspaceFingerprint, WorkspaceLeaseError> {
    let directory = open_directory_no_follow(root)?;
    let identity = file_identity(&directory)?;
    verify_canonical_directory(root, identity)?;

    let mut digest = Sha256::new();
    digest.update(b"zeroshot.borrowed-workspace/v2\0");
    digest.update(b"unix-path-bytes\0");
    let mut bounds = FingerprintBounds::default();
    fingerprint_directory(&directory, Path::new(""), &mut digest, &mut bounds)?;
    if let Some(hook) = &hooks.before_root_revalidation {
        hook();
    }
    verify_canonical_directory(root, identity)?;
    WorkspaceFingerprint::new(format!("{:x}", digest.finalize()))
}

#[cfg(target_os = "linux")]
fn fingerprint_directory(
    directory: &std::fs::File,
    relative: &Path,
    digest: &mut Sha256,
    bounds: &mut FingerprintBounds,
) -> Result<(), WorkspaceLeaseError> {
    let descriptor = descriptor_path(directory);
    let mut entries = std::fs::read_dir(&descriptor)
        .map_err(|_| fingerprint_error("borrowed workspace directory changed"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| fingerprint_error("borrowed workspace directory changed"))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);

    for entry in entries {
        bounds.entries = bounds
            .entries
            .checked_add(1)
            .ok_or_else(|| fingerprint_error("borrowed workspace entry count overflowed"))?;
        if bounds.entries > MAX_BORROWED_ENTRIES {
            return Err(fingerprint_error("borrowed workspace has too many entries"));
        }
        let name = entry.file_name();
        let child_relative = relative.join(&name);
        let child_path = descriptor.join(&name);
        let metadata = std::fs::symlink_metadata(&child_path)
            .map_err(|_| fingerprint_error("borrowed workspace entry changed"))?;
        if metadata.file_type().is_symlink() {
            return Err(fingerprint_error(
                "borrowed workspace fingerprints do not follow symbolic links",
            ));
        }
        if metadata.is_dir() {
            let child = open_directory_no_follow(&child_path)?;
            let identity = file_identity(&child)?;
            verify_path_identity(&child_path, identity)?;
            digest.update(b"d\0");
            hash_path(digest, &child_relative);
            fingerprint_directory(&child, &child_relative, digest, bounds)?;
            verify_path_identity(&child_path, identity)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(fingerprint_error(
                "borrowed workspace contains an unsupported entry",
            ));
        }
        fingerprint_file(&child_path, &child_relative, digest, bounds)?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn fingerprint_file(
    path: &Path,
    relative: &Path,
    digest: &mut Sha256,
    bounds: &mut FingerprintBounds,
) -> Result<(), WorkspaceLeaseError> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let mut file = options
        .open(path)
        .map_err(|_| fingerprint_error("borrowed workspace file changed"))?;
    let before = file
        .metadata()
        .map_err(|_| fingerprint_error("borrowed workspace file changed"))?;
    if !before.is_file() {
        return Err(fingerprint_error(
            "borrowed workspace contains an unsupported entry",
        ));
    }
    bounds.bytes = bounds
        .bytes
        .checked_add(before.len())
        .ok_or_else(|| fingerprint_error("borrowed workspace size overflowed"))?;
    if bounds.bytes > MAX_BORROWED_BYTES {
        return Err(fingerprint_error(
            "borrowed workspace is too large to inspect",
        ));
    }
    digest.update(b"f\0");
    hash_path(digest, relative);
    digest.update(before.len().to_be_bytes());
    let mut buffer = [0_u8; 8192];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| fingerprint_error("borrowed workspace file changed"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let after = file
        .metadata()
        .map_err(|_| fingerprint_error("borrowed workspace file changed"))?;
    if file_identity_from_metadata(&before) != file_identity_from_metadata(&after)
        || before.len() != after.len()
    {
        return Err(fingerprint_error("borrowed workspace file changed"));
    }
    verify_path_identity(path, file_identity_from_metadata(&after))
}

#[cfg(target_os = "linux")]
fn open_directory_no_follow(path: &Path) -> Result<std::fs::File, WorkspaceLeaseError> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    options
        .open(path)
        .map_err(|_| fingerprint_error("borrowed workspace directory changed"))
}

#[cfg(target_os = "linux")]
fn verify_canonical_directory(
    path: &Path,
    expected: (u64, u64),
) -> Result<(), WorkspaceLeaseError> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| fingerprint_error("borrowed workspace canonical root changed"))?;
    if canonical != path {
        return Err(fingerprint_error(
            "borrowed workspace root is not canonical",
        ));
    }
    verify_path_identity(path, expected)
}

#[cfg(target_os = "linux")]
fn verify_path_identity(path: &Path, expected: (u64, u64)) -> Result<(), WorkspaceLeaseError> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| fingerprint_error("borrowed workspace entry changed"))?;
    if metadata.file_type().is_symlink() || file_identity_from_metadata(&metadata) != expected {
        return Err(fingerprint_error("borrowed workspace entry changed"));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn file_identity(file: &std::fs::File) -> Result<(u64, u64), WorkspaceLeaseError> {
    let metadata = file
        .metadata()
        .map_err(|_| fingerprint_error("borrowed workspace entry changed"))?;
    Ok(file_identity_from_metadata(&metadata))
}

#[cfg(target_os = "linux")]
fn file_identity_from_metadata(metadata: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;

    (metadata.dev(), metadata.ino())
}

#[cfg(target_os = "linux")]
fn descriptor_path(file: &std::fs::File) -> std::path::PathBuf {
    use std::os::fd::AsRawFd;

    std::path::PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(target_os = "linux")]
fn hash_path(digest: &mut Sha256, path: &Path) {
    use std::os::unix::ffi::OsStrExt;

    let bytes = path.as_os_str().as_bytes();
    digest.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
    digest.update(bytes);
}

fn fingerprint_error(message: &'static str) -> WorkspaceLeaseError {
    WorkspaceLeaseError::new(WorkspaceLeaseErrorKind::ResourceUnavailable, message)
}
