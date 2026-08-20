use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use fs2::FileExt;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ControllerLeaseError {
    #[error("controller state directory is unavailable")]
    StateDirectory,
    #[error("controller lease path is not a regular file")]
    InvalidPath,
    #[error("another controller owns this lease")]
    Held,
}

/// Process-lifetime, filesystem-exclusive ownership for one portable run controller.
pub struct ControllerLease {
    file: File,
    path: PathBuf,
    identity: LeaseIdentity,
}

impl ControllerLease {
    pub fn acquire(path: impl Into<PathBuf>) -> Result<Self, ControllerLeaseError> {
        let path = path.into();
        let parent = path.parent().ok_or(ControllerLeaseError::StateDirectory)?;
        prepare_state_directory(parent)?;
        reject_non_file(&path)?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .map_err(|_| ControllerLeaseError::StateDirectory)?;
        let metadata = file
            .metadata()
            .map_err(|_| ControllerLeaseError::InvalidPath)?;
        if !metadata.is_file() {
            return Err(ControllerLeaseError::InvalidPath);
        }
        file.try_lock_exclusive()
            .map_err(|_| ControllerLeaseError::Held)?;
        Ok(Self {
            identity: LeaseIdentity::from_metadata(&metadata),
            file,
            path,
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub fn is_intact(&self) -> bool {
        let Ok(path_metadata) = std::fs::symlink_metadata(&self.path) else {
            return false;
        };
        if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
            return false;
        }
        let Ok(file_metadata) = self.file.metadata() else {
            return false;
        };
        self.identity == LeaseIdentity::from_metadata(&path_metadata)
            && self.identity == LeaseIdentity::from_metadata(&file_metadata)
    }
}

impl std::fmt::Debug for ControllerLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ControllerLease")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

fn prepare_state_directory(path: &Path) -> Result<(), ControllerLeaseError> {
    std::fs::create_dir_all(path).map_err(|_| ControllerLeaseError::StateDirectory)?;
    let metadata =
        std::fs::symlink_metadata(path).map_err(|_| ControllerLeaseError::StateDirectory)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ControllerLeaseError::StateDirectory);
    }
    set_private_directory_permissions(path)?;
    Ok(())
}

fn reject_non_file(path: &Path) -> Result<(), ControllerLeaseError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(ControllerLeaseError::InvalidPath),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ControllerLeaseError::InvalidPath),
    }
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), ControllerLeaseError> {
    use std::os::unix::fs::PermissionsExt as _;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| ControllerLeaseError::StateDirectory)
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), ControllerLeaseError> {
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LeaseIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl LeaseIdentity {
    fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            Self {
                device: metadata.dev(),
                inode: metadata.ino(),
            }
        }
        #[cfg(not(unix))]
        {
            let _ = metadata;
            Self {}
        }
    }
}
