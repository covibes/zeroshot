use super::*;

pub(super) fn stage_io(error: std::io::Error) -> ArtifactStoreFailure {
    failure_from_io(error, ArtifactStoreOperation::Stage)
}

pub(super) fn publish_io(error: std::io::Error) -> ArtifactStoreFailure {
    failure_from_io(error, ArtifactStoreOperation::Publish)
}

pub(super) fn release_io(error: std::io::Error) -> ArtifactStoreFailure {
    failure_from_io(error, ArtifactStoreOperation::Release)
}

pub(super) fn manifest_encoding_failure(_: serde_json::Error) -> ArtifactStoreFailure {
    ArtifactStoreFailure::new(ArtifactStoreFailureKind::Io(
        ArtifactStoreOperation::Publish,
    ))
}

pub(super) fn corrupt_content() -> ArtifactStoreFailure {
    ArtifactStoreFailure::new(ArtifactStoreFailureKind::CorruptContent)
}

pub(super) fn identity_conflict() -> ArtifactStoreFailure {
    ArtifactStoreFailure::new(ArtifactStoreFailureKind::IdentityConflict)
}
