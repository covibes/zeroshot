use std::path::{Path, PathBuf};

use async_trait::async_trait;

use super::ports::{
    TrustedServiceError, WorktreeReadinessPort, WorktreeReadinessReceipt, WORKSPACE_ROOT,
};

const MAX_WORKSPACE_ENTRIES: usize = 100_000;

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
}

fn verify_prepared_workspace() -> Result<(), TrustedServiceError> {
    verify_prepared_workspace_at(Path::new(WORKSPACE_ROOT))
}

pub(super) fn verify_prepared_workspace_at(root: &Path) -> Result<(), TrustedServiceError> {
    let metadata = pinned_workspace_metadata(root, true)?;
    if !metadata.is_dir() {
        return Err(TrustedServiceError::UnsafeWorkspace);
    }
    WorkspaceScan::new(root).verify()
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
    pending: Vec<PathBuf>,
    entries: usize,
}

impl WorkspaceScan {
    fn new(root: &Path) -> Self {
        Self {
            pending: vec![root.to_path_buf()],
            entries: 0,
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
        self.count_entry(&child)?;
        let file_type = child
            .file_type()
            .map_err(|_| TrustedServiceError::UnsafeWorkspace)?;
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
        if self.entries > MAX_WORKSPACE_ENTRIES || forbidden_workspace_name(&child.file_name()) {
            return Err(TrustedServiceError::UnsafeWorkspace);
        }
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

fn forbidden_workspace_name(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy();
    name == ".git"
        || name.starts_with(".env")
        || matches!(
            name.as_ref(),
            ".ssh"
                | ".aws"
                | ".config"
                | ".claude"
                | ".codex"
                | ".omp"
                | ".npmrc"
                | ".netrc"
                | ".git-credentials"
                | "credentials.json"
        )
}
