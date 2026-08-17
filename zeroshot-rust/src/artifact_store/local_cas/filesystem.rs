use std::path::Path;

use fs2::FileExt;
use openengine_cluster_protocol::ArtifactId;
use tokio::io::AsyncReadExt;

use super::super::{
    ArtifactStoreFailure, ArtifactStoreFailureKind, ArtifactStoreOperation, failure_from_io,
};

#[derive(Clone, Copy)]
pub(super) struct BoundedReadOptions {
    operation: ArtifactStoreOperation,
    missing_is_integrity_failure: bool,
}

impl BoundedReadOptions {
    pub(super) const fn optional(operation: ArtifactStoreOperation) -> Self {
        Self {
            operation,
            missing_is_integrity_failure: false,
        }
    }

    pub(super) const fn committed(operation: ArtifactStoreOperation) -> Self {
        Self {
            operation,
            missing_is_integrity_failure: true,
        }
    }
}

pub(super) fn prepare_root(root: &Path) -> Result<(), ArtifactStoreFailure> {
    match std::fs::symlink_metadata(root) {
        Ok(metadata) => validate_directory_metadata(&metadata)?,
        Err(error) => prepare_missing_root(root, error)?,
    }
    set_owner_directory_permissions(root)
}

fn prepare_missing_root(root: &Path, error: std::io::Error) -> Result<(), ArtifactStoreFailure> {
    match error.kind() {
        std::io::ErrorKind::NotFound => {
            create_owner_directory(root, ArtifactStoreOperation::Configuration)
        }
        std::io::ErrorKind::PermissionDenied => Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::PermissionDenied(ArtifactStoreOperation::Configuration),
        )),
        _ => Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::RootUnavailable,
        )),
    }
}

pub(super) fn prepare_owned_directory(
    root: &Path,
    path: &Path,
    operation: ArtifactStoreOperation,
) -> Result<(), ArtifactStoreFailure> {
    validate_parent_directory(root, path)?;
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            validate_directory_metadata(&metadata)?;
            set_owner_directory_permissions(path)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            create_owner_directory(path, operation)?;
            Ok(())
        }
        Err(error) => Err(failure_from_io(error, operation)),
    }
}

fn validate_parent_directory(root: &Path, path: &Path) -> Result<(), ArtifactStoreFailure> {
    let parent = path.parent().ok_or_else(corrupt_content)?;
    validate_directory_path(root, parent)
}

pub(super) fn validate_directory_path(
    root: &Path,
    directory: &Path,
) -> Result<(), ArtifactStoreFailure> {
    let relative = directory
        .strip_prefix(root)
        .map_err(|_| corrupt_content())?;
    let root_metadata = std::fs::symlink_metadata(root).map_err(configuration_io)?;
    validate_directory_metadata(&root_metadata)?;

    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err(corrupt_content());
        };
        current.push(component);
        let metadata = std::fs::symlink_metadata(&current).map_err(configuration_io)?;
        validate_directory_metadata(&metadata)?;
    }
    Ok(())
}

fn validate_directory_metadata(metadata: &std::fs::Metadata) -> Result<(), ArtifactStoreFailure> {
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(corrupt_content());
    }
    Ok(())
}

fn create_owner_directory(
    path: &Path,
    operation: ArtifactStoreOperation,
) -> Result<(), ArtifactStoreFailure> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|error| failure_from_io(error, operation))?;
    set_owner_directory_permissions(path)
}

pub(super) fn acquire_root_lock(
    root: &Path,
    path: &Path,
) -> Result<std::fs::File, ArtifactStoreFailure> {
    validate_parent_directory(root, path)?;
    let file = open_owner_lock_file(path)?;
    file.try_lock_exclusive().map_err(lock_failure)?;
    Ok(file)
}

fn lock_failure(error: std::io::Error) -> ArtifactStoreFailure {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        ArtifactStoreFailure::new(ArtifactStoreFailureKind::PermissionDenied(
            ArtifactStoreOperation::Configuration,
        ))
    } else {
        ArtifactStoreFailure::new(ArtifactStoreFailureKind::LockUnavailable)
    }
}

fn open_owner_lock_file(path: &Path) -> Result<std::fs::File, ArtifactStoreFailure> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path).map_err(configuration_io)?;
    set_owner_file_permissions(path)?;
    Ok(file)
}

pub(super) async fn open_new_owner_file(
    root: &Path,
    path: &Path,
    operation: ArtifactStoreOperation,
) -> Result<tokio::fs::File, ArtifactStoreFailure> {
    validate_parent_directory_for_operation(root, path, operation)?;
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).read(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options
        .open(path)
        .await
        .map_err(|error| failure_from_io(error, operation))?;
    set_owner_file_permissions(path)?;
    Ok(file)
}

pub(super) fn cleanup_abandoned_stages(
    root: &Path,
    directory: &Path,
) -> Result<(), ArtifactStoreFailure> {
    validate_directory_path(root, directory)?;
    let mut removed = false;
    for entry in std::fs::read_dir(directory).map_err(configuration_io)? {
        let entry = entry.map_err(configuration_io)?;
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(configuration_io)?;
        validate_regular_metadata(&metadata, u64::MAX)?;
        std::fs::remove_file(entry.path()).map_err(configuration_io)?;
        removed = true;
    }
    if removed {
        sync_directory(root, directory, ArtifactStoreOperation::Configuration)?;
    }
    Ok(())
}

pub(super) fn reject_symlink_or_non_file_if_present(
    root: &Path,
    path: &Path,
) -> Result<(), ArtifactStoreFailure> {
    validate_parent_directory(root, path)?;
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => validate_regular_metadata(&metadata, u64::MAX),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(configuration_io(error)),
    }
}

pub(super) async fn read_regular_bounded(
    root: &Path,
    path: &Path,
    limit: u64,
    options: BoundedReadOptions,
) -> Result<Option<Vec<u8>>, ArtifactStoreFailure> {
    validate_read_parent_directory(
        root,
        path,
        options.operation,
        options.missing_is_integrity_failure,
    )?;
    let Some(metadata) = regular_metadata(
        path,
        options.operation,
        options.missing_is_integrity_failure,
    )
    .await?
    else {
        return Ok(None);
    };
    validate_regular_metadata(&metadata, limit)?;
    read_bounded_file(path, metadata.len(), limit, options.operation)
        .await
        .map(Some)
}

fn validate_read_parent_directory(
    root: &Path,
    path: &Path,
    operation: ArtifactStoreOperation,
    missing_is_integrity_failure: bool,
) -> Result<(), ArtifactStoreFailure> {
    let parent = path.parent().ok_or_else(corrupt_content)?;
    let relative = parent.strip_prefix(root).map_err(|_| corrupt_content())?;
    validate_read_directory_component(root, operation, missing_is_integrity_failure)?;

    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err(corrupt_content());
        };
        current.push(component);
        validate_read_directory_component(&current, operation, missing_is_integrity_failure)?;
    }
    Ok(())
}

fn validate_read_directory_component(
    path: &Path,
    operation: ArtifactStoreOperation,
    missing_is_integrity_failure: bool,
) -> Result<(), ArtifactStoreFailure> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound && missing_is_integrity_failure =>
        {
            return Err(ArtifactStoreFailure::new(
                ArtifactStoreFailureKind::MissingCommittedContent,
            ));
        }
        Err(error) => return Err(failure_from_io(error, operation)),
    };
    validate_directory_metadata(&metadata)
}

async fn regular_metadata(
    path: &Path,
    operation: ArtifactStoreOperation,
    missing_is_integrity_failure: bool,
) -> Result<Option<std::fs::Metadata>, ArtifactStoreFailure> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            missing_metadata(missing_is_integrity_failure)
        }
        Err(error) => Err(failure_from_io(error, operation)),
    }
}

fn missing_metadata(
    missing_is_integrity_failure: bool,
) -> Result<Option<std::fs::Metadata>, ArtifactStoreFailure> {
    if missing_is_integrity_failure {
        return Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::MissingCommittedContent,
        ));
    }
    Ok(None)
}

fn validate_regular_metadata(
    metadata: &std::fs::Metadata,
    limit: u64,
) -> Result<(), ArtifactStoreFailure> {
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > limit {
        return Err(corrupt_content());
    }
    Ok(())
}

async fn read_bounded_file(
    path: &Path,
    capacity: u64,
    limit: u64,
    operation: ArtifactStoreOperation,
) -> Result<Vec<u8>, ArtifactStoreFailure> {
    let file = tokio::fs::OpenOptions::new()
        .read(true)
        .open(path)
        .await
        .map_err(|error| failure_from_io(error, operation))?;
    let capacity = usize::try_from(capacity).map_err(|_| corrupt_content())?;
    let mut bytes = Vec::with_capacity(capacity);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| failure_from_io(error, operation))?;
    if bytes.len() as u64 > limit {
        return Err(corrupt_content());
    }
    Ok(bytes)
}

pub(super) async fn remove_regular_if_present(
    root: &Path,
    path: &Path,
    operation: ArtifactStoreOperation,
) -> Result<bool, ArtifactStoreFailure> {
    validate_parent_directory_for_operation(root, path, operation)?;
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => validate_regular_metadata(&metadata, u64::MAX)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(failure_from_io(error, operation)),
    }
    tokio::fs::remove_file(path)
        .await
        .map_err(|error| failure_from_io(error, operation))?;
    Ok(true)
}

fn validate_parent_directory_for_operation(
    root: &Path,
    path: &Path,
    operation: ArtifactStoreOperation,
) -> Result<(), ArtifactStoreFailure> {
    let parent = path.parent().ok_or_else(corrupt_content)?;
    let relative = parent.strip_prefix(root).map_err(|_| corrupt_content())?;
    validate_operation_directory_component(root, operation)?;

    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err(corrupt_content());
        };
        current.push(component);
        validate_operation_directory_component(&current, operation)?;
    }
    Ok(())
}

fn validate_operation_directory_component(
    path: &Path,
    operation: ArtifactStoreOperation,
) -> Result<(), ArtifactStoreFailure> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| failure_from_io(error, operation))?;
    if metadata.file_type().is_symlink() {
        return Err(corrupt_content());
    }
    if !metadata.is_dir() {
        return Err(ArtifactStoreFailure::new(ArtifactStoreFailureKind::Io(
            operation,
        )));
    }
    Ok(())
}

pub(super) fn sync_directory(
    root: &Path,
    directory: &Path,
    operation: ArtifactStoreOperation,
) -> Result<(), ArtifactStoreFailure> {
    validate_directory_path(root, directory)?;
    let file = std::fs::File::open(directory).map_err(|error| failure_from_io(error, operation))?;
    file.sync_all()
        .map_err(|error| failure_from_io(error, operation))
}

pub(super) fn set_owner_file_permissions(path: &Path) -> Result<(), ArtifactStoreFailure> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(configuration_io)?;
    }
    Ok(())
}

fn set_owner_directory_permissions(path: &Path) -> Result<(), ArtifactStoreFailure> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(configuration_io)?;
    }
    Ok(())
}

pub(super) fn validate_artifact_id(artifact_id: &ArtifactId) -> Result<(), ArtifactStoreFailure> {
    let Some(digest) = artifact_id.as_str().strip_prefix("cas-v1-") else {
        return Err(identity_conflict());
    };
    if digest.len() != 64 || !digest.bytes().all(is_lower_hex) {
        return Err(identity_conflict());
    }
    Ok(())
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn configuration_io(error: std::io::Error) -> ArtifactStoreFailure {
    failure_from_io(error, ArtifactStoreOperation::Configuration)
}

fn corrupt_content() -> ArtifactStoreFailure {
    ArtifactStoreFailure::new(ArtifactStoreFailureKind::CorruptContent)
}

fn identity_conflict() -> ArtifactStoreFailure {
    ArtifactStoreFailure::new(ArtifactStoreFailureKind::IdentityConflict)
}
