use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use async_trait::async_trait;

use super::{TargetAuthorityError, TargetSetupDocument};

const MAX_SETUP_DOCUMENT_BYTES: u64 = 1024 * 1024;

/// One current setup document. There is deliberately no history or replay surface.
#[async_trait]
pub trait TargetSetupStore: Send + Sync {
    async fn load(&self) -> Result<Option<TargetSetupDocument>, TargetAuthorityError>;

    async fn replace(&self, setup: &TargetSetupDocument) -> Result<(), TargetAuthorityError>;
}

/// Bounded atomic JSON setup storage for one production target.
#[derive(Clone, Debug)]
pub struct FileTargetSetupStore {
    path: PathBuf,
}

impl FileTargetSetupStore {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[async_trait]
impl TargetSetupStore for FileTargetSetupStore {
    async fn load(&self) -> Result<Option<TargetSetupDocument>, TargetAuthorityError> {
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || load_setup_file(&path))
            .await
            .map_err(|_| TargetAuthorityError::unavailable("setup store task failed"))?
    }

    async fn replace(&self, setup: &TargetSetupDocument) -> Result<(), TargetAuthorityError> {
        setup.validate()?;
        let path = self.path.clone();
        let setup = setup.clone();
        tokio::task::spawn_blocking(move || replace_setup_file(&path, &setup))
            .await
            .map_err(|_| TargetAuthorityError::unavailable("setup store task failed"))?
    }
}

fn load_setup_file(path: &Path) -> Result<Option<TargetSetupDocument>, TargetAuthorityError> {
    let Some(metadata) = setup_file_metadata(path)? else {
        return Ok(None);
    };
    let bytes = read_bounded_setup_bytes(path, metadata.len())?;
    let setup: TargetSetupDocument = serde_json::from_slice(&bytes)
        .map_err(|_| TargetAuthorityError::unavailable("setup document is malformed"))?;
    setup.validate()?;
    Ok(Some(setup))
}

fn setup_file_metadata(path: &Path) -> Result<Option<std::fs::Metadata>, TargetAuthorityError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(setup_io_error(error)),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(TargetAuthorityError::unavailable(
            "setup store path is not a regular file",
        ));
    }
    if metadata.len() > MAX_SETUP_DOCUMENT_BYTES {
        return Err(TargetAuthorityError::unavailable(
            "setup document exceeds 1 MiB",
        ));
    }
    Ok(Some(metadata))
}

fn read_bounded_setup_bytes(path: &Path, length: u64) -> Result<Vec<u8>, TargetAuthorityError> {
    let file = std::fs::File::open(path).map_err(setup_io_error)?;
    let mut bytes = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
    file.take(MAX_SETUP_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(setup_io_error)?;
    if bytes.len() as u64 > MAX_SETUP_DOCUMENT_BYTES {
        return Err(TargetAuthorityError::unavailable(
            "setup document exceeds 1 MiB",
        ));
    }
    Ok(bytes)
}

fn replace_setup_file(
    path: &Path,
    setup: &TargetSetupDocument,
) -> Result<(), TargetAuthorityError> {
    let bytes = serde_json::to_vec(setup)
        .map_err(|_| TargetAuthorityError::unavailable("setup document could not be encoded"))?;
    if bytes.len() as u64 > MAX_SETUP_DOCUMENT_BYTES {
        return Err(TargetAuthorityError::invalid(
            "setup document exceeds 1 MiB",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| TargetAuthorityError::unavailable("setup store path has no parent"))?;
    create_private_setup_directory(parent)?;
    let mut random = [0_u8; 8];
    getrandom::fill(&mut random)
        .map_err(|_| TargetAuthorityError::unavailable("setup store randomness is unavailable"))?;
    let temporary = path.with_extension(format!("tmp-{}", encode_hex(&random)));
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    set_private_setup_file_mode(&mut options);
    let result = (|| {
        let mut file = options.open(&temporary).map_err(setup_io_error)?;
        file.write_all(&bytes).map_err(setup_io_error)?;
        file.sync_all().map_err(setup_io_error)?;
        std::fs::rename(&temporary, path).map_err(setup_io_error)?;
        sync_setup_directory(parent)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn create_private_setup_directory(path: &Path) -> Result<(), TargetAuthorityError> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    set_private_setup_directory_mode(&mut builder);
    builder.create(path).map_err(setup_io_error)?;
    let metadata = std::fs::symlink_metadata(path).map_err(setup_io_error)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(TargetAuthorityError::unavailable(
            "setup store parent is not a directory",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn sync_setup_directory(path: &Path) -> Result<(), TargetAuthorityError> {
    std::fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(setup_io_error)
}

#[cfg(not(unix))]
fn sync_setup_directory(_path: &Path) -> Result<(), TargetAuthorityError> {
    Ok(())
}

#[cfg(unix)]
fn set_private_setup_file_mode(options: &mut std::fs::OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn set_private_setup_file_mode(_options: &mut std::fs::OpenOptions) {}

#[cfg(unix)]
fn set_private_setup_directory_mode(builder: &mut std::fs::DirBuilder) {
    use std::os::unix::fs::DirBuilderExt;
    builder.mode(0o700);
}

#[cfg(not(unix))]
fn set_private_setup_directory_mode(_builder: &mut std::fs::DirBuilder) {}

fn setup_io_error(error: std::io::Error) -> TargetAuthorityError {
    TargetAuthorityError::unavailable(format!("setup store I/O failed: {error}"))
}

pub(super) fn encode_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}
