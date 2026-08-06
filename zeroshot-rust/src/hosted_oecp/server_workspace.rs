use std::path::{Path, PathBuf};

use async_trait::async_trait;

use super::ports::{
    TrustedServiceError, WorktreeReadinessPort, WorktreeReadinessReceipt, WORKSPACE_ROOT,
};

const MAX_WORKSPACE_ENTRIES: usize = 100_000;
const WORKSPACE_WRITE_TEMP_PREFIX: &str = ".zeroshot-write-";

#[derive(Clone, Copy, Debug)]
pub(super) struct PreparedWorktreeReadiness;

#[async_trait]
impl WorktreeReadinessPort for PreparedWorktreeReadiness {
    async fn verify_ready(&self) -> Result<WorktreeReadinessReceipt, TrustedServiceError> {
        tokio::task::spawn_blocking(verify_prepared_workspace)
            .await
            .map_err(|_| TrustedServiceError::Unavailable)??;
        Ok(WorktreeReadinessReceipt::ready())
    }

    async fn verify_delivery_ready(&self) -> Result<WorktreeReadinessReceipt, TrustedServiceError> {
        tokio::task::spawn_blocking(verify_delivery_workspace)
            .await
            .map_err(|_| TrustedServiceError::Unavailable)??;
        Ok(WorktreeReadinessReceipt::ready())
    }
}

fn verify_prepared_workspace() -> Result<(), TrustedServiceError> {
    verify_prepared_workspace_at(Path::new(WORKSPACE_ROOT))
}

fn verify_delivery_workspace() -> Result<(), TrustedServiceError> {
    verify_delivery_workspace_at(Path::new(WORKSPACE_ROOT))
}

pub(super) fn verify_prepared_workspace_at(root: &Path) -> Result<(), TrustedServiceError> {
    let metadata = pinned_workspace_metadata(root, true)?;
    if !metadata.is_dir() {
        return Err(TrustedServiceError::UnsafeWorkspace);
    }
    WorkspaceScan::new(root, false).verify()
}

pub(super) fn verify_delivery_workspace_at(root: &Path) -> Result<(), TrustedServiceError> {
    let metadata = pinned_workspace_metadata(root, true)?;
    if !metadata.is_dir() {
        return Err(TrustedServiceError::UnsafeWorkspace);
    }
    WorkspaceScan::new(root, true).verify()
}

#[cfg(unix)]
fn pinned_workspace_metadata(
    path: &Path,
    directory: bool,
) -> Result<std::fs::Metadata, TrustedServiceError> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut flags = libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
    if directory {
        flags |= libc::O_DIRECTORY;
    }
    let descriptor = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(flags)
        .open(path)
        .map_err(|_| TrustedServiceError::UnsafeWorkspace)?;
    descriptor
        .metadata()
        .map_err(|_| TrustedServiceError::UnsafeWorkspace)
}

#[cfg(not(unix))]
fn pinned_workspace_metadata(
    _path: &Path,
    _directory: bool,
) -> Result<std::fs::Metadata, TrustedServiceError> {
    Err(TrustedServiceError::UnsafeWorkspace)
}

struct WorkspaceScan {
    root: PathBuf,
    pending: Vec<PathBuf>,
    entries: usize,
    cleanup_write_temps: bool,
}

impl WorkspaceScan {
    fn new(root: &Path, cleanup_write_temps: bool) -> Self {
        Self {
            root: root.to_path_buf(),
            pending: vec![root.to_path_buf()],
            entries: 0,
            cleanup_write_temps,
        }
    }

    fn verify(mut self) -> Result<(), TrustedServiceError> {
        while let Some(directory) = self.pending.pop() {
            self.verify_directory(directory)?;
        }
        Ok(())
    }

    fn verify_directory(&mut self, directory: PathBuf) -> Result<(), TrustedServiceError> {
        let children =
            std::fs::read_dir(directory).map_err(|_| TrustedServiceError::UnsafeWorkspace)?;
        for child in children {
            self.verify_entry(child.map_err(|_| TrustedServiceError::UnsafeWorkspace)?)?;
        }
        Ok(())
    }

    fn verify_entry(&mut self, child: std::fs::DirEntry) -> Result<(), TrustedServiceError> {
        if self.cleanup_write_temps && reserved_write_temp_name(&child.file_name()) {
            return remove_reserved_write_temp(child);
        }
        self.count_entry(&child)?;
        let file_type = child
            .file_type()
            .map_err(|_| TrustedServiceError::UnsafeWorkspace)?;
        if file_type.is_symlink() {
            return self.verify_relative_symlink(&child.path());
        }
        if !supported_file_type(&file_type) {
            return Err(TrustedServiceError::UnsafeWorkspace);
        }
        self.verify_pinned_entry(child.path(), file_type.is_dir())
    }

    fn count_entry(&mut self, child: &std::fs::DirEntry) -> Result<(), TrustedServiceError> {
        self.entries = self
            .entries
            .checked_add(1)
            .ok_or(TrustedServiceError::UnsafeWorkspace)?;
        if self.entries > MAX_WORKSPACE_ENTRIES
            || child
                .file_name()
                .to_string_lossy()
                .starts_with(WORKSPACE_WRITE_TEMP_PREFIX)
        {
            return Err(TrustedServiceError::UnsafeWorkspace);
        }
        Ok(())
    }

    fn verify_relative_symlink(&self, path: &Path) -> Result<(), TrustedServiceError> {
        let parent = path.parent().ok_or(TrustedServiceError::UnsafeWorkspace)?;
        let relative_parent = parent
            .strip_prefix(&self.root)
            .map_err(|_| TrustedServiceError::UnsafeWorkspace)?;
        let target = std::fs::read_link(path).map_err(|_| TrustedServiceError::UnsafeWorkspace)?;
        relative_symlink_depth(relative_parent, &target)
            .ok_or(TrustedServiceError::UnsafeWorkspace)?;
        Ok(())
    }

    fn verify_pinned_entry(
        &mut self,
        path: PathBuf,
        directory: bool,
    ) -> Result<(), TrustedServiceError> {
        let metadata = pinned_workspace_metadata(&path, directory)?;
        if directory {
            if !metadata.is_dir() {
                return Err(TrustedServiceError::UnsafeWorkspace);
            }
            self.pending.push(path);
        } else if !workspace_file_is_single_link(&metadata) {
            return Err(TrustedServiceError::UnsafeWorkspace);
        }
        Ok(())
    }
}

fn relative_symlink_depth(parent: &Path, target: &Path) -> Option<usize> {
    if target.is_absolute() {
        return None;
    }
    let mut depth = parent.components().count();
    for component in target.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(_) => depth += 1,
            std::path::Component::ParentDir if depth > 0 => depth -= 1,
            _ => return None,
        }
    }
    Some(depth)
}

fn remove_reserved_write_temp(child: std::fs::DirEntry) -> Result<(), TrustedServiceError> {
    let file_type = child
        .file_type()
        .map_err(|_| TrustedServiceError::UnsafeWorkspace)?;
    if !file_type.is_file() || file_type.is_symlink() {
        return Err(TrustedServiceError::UnsafeWorkspace);
    }
    let path = child.path();
    let observed = child
        .metadata()
        .map_err(|_| TrustedServiceError::UnsafeWorkspace)?;
    let pinned = pinned_workspace_metadata(&path, false)?;
    if !workspace_file_is_single_link(&pinned) || !same_file_identity(&observed, &pinned) {
        return Err(TrustedServiceError::UnsafeWorkspace);
    }
    std::fs::remove_file(&path).map_err(|_| TrustedServiceError::UnsafeWorkspace)?;
    let parent = path.parent().ok_or(TrustedServiceError::UnsafeWorkspace)?;
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| TrustedServiceError::UnsafeWorkspace)
}

fn reserved_write_temp_name(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let Some(remainder) = name.strip_prefix(WORKSPACE_WRITE_TEMP_PREFIX) else {
        return false;
    };
    let Some((pid, uuid)) = remainder.split_once('-') else {
        return false;
    };
    !pid.is_empty() && pid.bytes().all(|byte| byte.is_ascii_digit()) && uuid_is_canonical_hex(uuid)
}

fn uuid_is_canonical_hex(value: &str) -> bool {
    let mut segments = value.split('-');
    [8, 4, 4, 4, 12].into_iter().all(|length| {
        segments.next().is_some_and(|segment| {
            segment.len() == length && segment.bytes().all(|b| b.is_ascii_hexdigit())
        })
    }) && segments.next().is_none()
}

#[cfg(unix)]
fn same_file_identity(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file_identity(_left: &std::fs::Metadata, _right: &std::fs::Metadata) -> bool {
    false
}

fn supported_file_type(file_type: &std::fs::FileType) -> bool {
    !file_type.is_symlink() && (file_type.is_dir() || file_type.is_file())
}

#[cfg(unix)]
fn workspace_file_is_single_link(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    metadata.is_file() && metadata.nlink() == 1
}

#[cfg(not(unix))]
fn workspace_file_is_single_link(_metadata: &std::fs::Metadata) -> bool {
    false
}
