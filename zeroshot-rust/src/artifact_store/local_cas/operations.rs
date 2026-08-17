use std::path::Path;

use openengine_cluster_protocol::{ArtifactId, ArtifactRef};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::filesystem::{
    BoundedReadOptions, open_new_owner_file, prepare_owned_directory, read_regular_bounded,
    remove_regular_if_present, set_owner_file_permissions, sync_directory,
};
use super::{
    LocalCasArtifactStore, LocalStage, LocalStageStatus, MAX_MANIFEST_BYTES, invalid_stage,
    missing_content,
};
use crate::artifact_store::{
    ArtifactByteStream, ArtifactIntent, ArtifactStoreFailure, ArtifactStoreFailureKind,
    ArtifactStoreOperation, DiscardResult, MAX_ARTIFACT_BYTES, ReleaseResult, derive_artifact_id,
    encode_hex, failure_from_io, verify_bytes,
};

mod errors;
use errors::{
    corrupt_content, identity_conflict, manifest_encoding_failure, publish_io, release_io, stage_io,
};

impl LocalCasArtifactStore {
    pub(super) async fn load_committed(
        &self,
        artifact_id: &ArtifactId,
    ) -> Result<Option<(ArtifactRef, Vec<u8>)>, ArtifactStoreFailure> {
        self.load_committed_for(artifact_id, ArtifactStoreOperation::Inspect)
            .await
    }

    async fn load_committed_for(
        &self,
        artifact_id: &ArtifactId,
        operation: ArtifactStoreOperation,
    ) -> Result<Option<(ArtifactRef, Vec<u8>)>, ArtifactStoreFailure> {
        let Some(artifact_ref) = self.read_manifest(artifact_id, operation).await? else {
            return Ok(None);
        };
        let blob_path = self.blob_path(&artifact_ref);
        let bytes = read_regular_bounded(
            &self.inner.root,
            &blob_path,
            artifact_ref.byte_length.get() + 1,
            BoundedReadOptions::committed(operation),
        )
        .await?
        .ok_or_else(missing_content)?;
        verify_bytes(&artifact_ref, &bytes)?;
        Ok(Some((artifact_ref, bytes)))
    }

    async fn read_manifest(
        &self,
        artifact_id: &ArtifactId,
        operation: ArtifactStoreOperation,
    ) -> Result<Option<ArtifactRef>, ArtifactStoreFailure> {
        let path = self.ref_path(artifact_id)?;
        let Some(manifest) = read_regular_bounded(
            &self.inner.root,
            &path,
            MAX_MANIFEST_BYTES,
            BoundedReadOptions::optional(operation),
        )
        .await?
        else {
            return Ok(None);
        };
        let artifact_ref = decode_manifest(&manifest)?;
        validate_manifest_identity(&artifact_ref, artifact_id)?;
        Ok(Some(artifact_ref))
    }

    pub(super) async fn publish_pending(
        &self,
        stage_key: u64,
        stage: LocalStage,
    ) -> Result<ArtifactRef, ArtifactStoreFailure> {
        self.ensure_blob(&stage).await?;
        self.commit_manifest(stage_key, &stage.artifact_ref).await?;
        self.stages()
            .get_mut(&stage_key)
            .ok_or_else(invalid_stage)?
            .status = LocalStageStatus::Published;
        Ok(stage.artifact_ref)
    }

    pub(super) async fn load_published_ref(
        &self,
        expected: &ArtifactRef,
    ) -> Result<ArtifactRef, ArtifactStoreFailure> {
        let (committed, _) = self
            .load_committed_for(&expected.artifact_id, ArtifactStoreOperation::Publish)
            .await?
            .ok_or_else(missing_content)?;
        require_matching_ref(&committed, expected)?;
        Ok(committed)
    }

    async fn ensure_blob(&self, stage: &LocalStage) -> Result<(), ArtifactStoreFailure> {
        let blob_path = self.blob_path(&stage.artifact_ref);
        let blob_directory = blob_path.parent().ok_or_else(corrupt_content)?;
        prepare_owned_directory(
            &self.inner.root,
            blob_directory,
            ArtifactStoreOperation::Publish,
        )?;
        sync_directory(
            &self.inner.root,
            blob_directory.parent().ok_or_else(corrupt_content)?,
            ArtifactStoreOperation::Publish,
        )?;
        let staged = self.read_staged_bytes(stage).await?;
        let existing = read_regular_bounded(
            &self.inner.root,
            &blob_path,
            stage.artifact_ref.byte_length.get() + 1,
            BoundedReadOptions::optional(ArtifactStoreOperation::Publish),
        )
        .await?;
        match existing {
            Some(existing) => self.reuse_blob(stage, staged, existing).await,
            None => self.publish_new_blob(stage, staged.is_some(), &blob_path),
        }?;
        sync_directory(
            &self.inner.root,
            blob_directory,
            ArtifactStoreOperation::Publish,
        )
    }

    async fn read_staged_bytes(
        &self,
        stage: &LocalStage,
    ) -> Result<Option<Vec<u8>>, ArtifactStoreFailure> {
        let staged = read_regular_bounded(
            &self.inner.root,
            &stage.path,
            stage.artifact_ref.byte_length.get() + 1,
            BoundedReadOptions::optional(ArtifactStoreOperation::Publish),
        )
        .await?;
        if let Some(bytes) = staged.as_ref() {
            verify_bytes(&stage.artifact_ref, bytes)?;
        }
        Ok(staged)
    }

    async fn reuse_blob(
        &self,
        stage: &LocalStage,
        staged: Option<Vec<u8>>,
        existing: Vec<u8>,
    ) -> Result<(), ArtifactStoreFailure> {
        verify_bytes(&stage.artifact_ref, &existing)?;
        let Some(staged) = staged else {
            return Ok(());
        };
        if staged != existing {
            return Err(identity_conflict());
        }
        remove_regular_if_present(
            &self.inner.root,
            &stage.path,
            ArtifactStoreOperation::Publish,
        )
        .await?;
        sync_directory(
            &self.inner.root,
            &self.staging_directory(),
            ArtifactStoreOperation::Publish,
        )
    }

    fn publish_new_blob(
        &self,
        stage: &LocalStage,
        stage_exists: bool,
        blob_path: &Path,
    ) -> Result<(), ArtifactStoreFailure> {
        if !stage_exists {
            return Err(missing_content());
        }
        std::fs::rename(&stage.path, blob_path).map_err(publish_io)?;
        set_owner_file_permissions(blob_path)?;
        Ok(())
    }

    async fn commit_manifest(
        &self,
        stage_key: u64,
        artifact_ref: &ArtifactRef,
    ) -> Result<(), ArtifactStoreFailure> {
        let existing = self
            .load_committed_for(&artifact_ref.artifact_id, ArtifactStoreOperation::Publish)
            .await?;
        if let Some((existing, _)) = existing {
            return require_matching_ref(&existing, artifact_ref);
        }
        self.write_new_manifest(stage_key, artifact_ref).await
    }

    async fn write_new_manifest(
        &self,
        stage_key: u64,
        artifact_ref: &ArtifactRef,
    ) -> Result<(), ArtifactStoreFailure> {
        let destination = self.ref_path(&artifact_ref.artifact_id)?;
        let temporary = self.manifest_stage_path(stage_key, &artifact_ref.artifact_id);
        remove_regular_if_present(
            &self.inner.root,
            &temporary,
            ArtifactStoreOperation::Publish,
        )
        .await?;
        let encoded = serde_json::to_vec(artifact_ref).map_err(manifest_encoding_failure)?;
        write_synced_file(
            &self.inner.root,
            &temporary,
            &encoded,
            ArtifactStoreOperation::Publish,
        )
        .await?;
        tokio::fs::rename(&temporary, &destination)
            .await
            .map_err(publish_io)?;
        sync_directory(
            &self.inner.root,
            &self.refs_directory(),
            ArtifactStoreOperation::Publish,
        )?;
        sync_directory(
            &self.inner.root,
            &self.staging_directory(),
            ArtifactStoreOperation::Publish,
        )
    }

    pub(super) async fn discard_pending(
        &self,
        stage_key: u64,
        stage: &LocalStage,
    ) -> Result<DiscardResult, ArtifactStoreFailure> {
        remove_regular_if_present(
            &self.inner.root,
            &stage.path,
            ArtifactStoreOperation::Discard,
        )
        .await?;
        sync_directory(
            &self.inner.root,
            &self.staging_directory(),
            ArtifactStoreOperation::Discard,
        )?;
        self.stages()
            .get_mut(&stage_key)
            .ok_or_else(invalid_stage)?
            .status = LocalStageStatus::Discarded;
        Ok(DiscardResult::Discarded)
    }

    pub(super) async fn release_committed(
        &self,
        artifact_id: &ArtifactId,
    ) -> Result<ReleaseResult, ArtifactStoreFailure> {
        let target = self
            .load_committed_for(artifact_id, ArtifactStoreOperation::Release)
            .await?;
        let Some((target, _)) = target else {
            return Ok(ReleaseResult::NotFound);
        };
        let shared_count = self.count_digest_refs(&target).await?;
        self.remove_ref(artifact_id).await?;
        if shared_count == 1 {
            self.remove_blob(&target).await?;
        }
        Ok(ReleaseResult::Released)
    }

    async fn count_digest_refs(&self, target: &ArtifactRef) -> Result<usize, ArtifactStoreFailure> {
        let mut count = 0_usize;
        let entries = std::fs::read_dir(self.refs_directory()).map_err(release_io)?;
        for entry in entries {
            let id = artifact_id_from_entry(entry.map_err(release_io)?)?;
            let (candidate, _) = self
                .load_committed_for(&id, ArtifactStoreOperation::Release)
                .await?
                .ok_or_else(corrupt_content)?;
            if candidate.sha256 == target.sha256 {
                count += 1;
            }
        }
        Ok(count)
    }

    async fn remove_ref(&self, artifact_id: &ArtifactId) -> Result<(), ArtifactStoreFailure> {
        let path = self.ref_path(artifact_id)?;
        remove_regular_if_present(&self.inner.root, &path, ArtifactStoreOperation::Release).await?;
        sync_directory(
            &self.inner.root,
            &self.refs_directory(),
            ArtifactStoreOperation::Release,
        )
    }

    async fn remove_blob(&self, artifact_ref: &ArtifactRef) -> Result<(), ArtifactStoreFailure> {
        let path = self.blob_path(artifact_ref);
        remove_regular_if_present(&self.inner.root, &path, ArtifactStoreOperation::Release).await?;
        sync_directory(
            &self.inner.root,
            path.parent().ok_or_else(corrupt_content)?,
            ArtifactStoreOperation::Release,
        )
    }
}

pub(super) async fn write_verified_stage(
    root: &Path,
    path: &Path,
    intent: &ArtifactIntent,
    bytes: ArtifactByteStream,
) -> Result<(), ArtifactStoreFailure> {
    let mut file = open_new_owner_file(root, path, ArtifactStoreOperation::Stage).await?;
    let result = copy_and_verify(&mut file, intent, bytes).await;
    drop(file);
    if let Err(failure) = result {
        remove_regular_if_present(root, path, ArtifactStoreOperation::Stage).await?;
        sync_directory(
            root,
            path.parent().ok_or_else(corrupt_content)?,
            ArtifactStoreOperation::Stage,
        )?;
        return Err(failure);
    }
    Ok(())
}

async fn copy_and_verify(
    file: &mut tokio::fs::File,
    intent: &ArtifactIntent,
    mut bytes: ArtifactByteStream,
) -> Result<(), ArtifactStoreFailure> {
    let declared = intent.expected_byte_length.get();
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 16 * 1024];
    while total <= declared {
        let remaining = declared.saturating_add(1).saturating_sub(total);
        let read = copy_next_chunk(file, &mut bytes, (&mut buffer, &mut hasher), remaining).await?;
        if read == 0 {
            break;
        }
        total = checked_total(total, read, declared)?;
    }
    finish_stage(file, intent, total, hasher).await
}

async fn copy_next_chunk(
    file: &mut tokio::fs::File,
    bytes: &mut ArtifactByteStream,
    state: (&mut [u8], &mut Sha256),
    remaining: u64,
) -> Result<usize, ArtifactStoreFailure> {
    let (buffer, hasher) = state;
    let buffer_length = u64::try_from(buffer.len()).map_err(|_| corrupt_content())?;
    let limit = usize::try_from(remaining.min(buffer_length)).map_err(|_| corrupt_content())?;
    let target = buffer.get_mut(..limit).ok_or_else(corrupt_content)?;
    let read = bytes.read(target).await.map_err(stage_io)?;
    let chunk = target.get(..read).ok_or_else(corrupt_content)?;
    hasher.update(chunk);
    file.write_all(chunk).await.map_err(stage_io)?;
    Ok(read)
}

fn checked_total(total: u64, read: usize, declared: u64) -> Result<u64, ArtifactStoreFailure> {
    let read = u64::try_from(read).map_err(|_| corrupt_content())?;
    let total = total.checked_add(read).ok_or_else(corrupt_content)?;
    if total > declared {
        return Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::Oversize,
        ));
    }
    Ok(total)
}

async fn finish_stage(
    file: &mut tokio::fs::File,
    intent: &ArtifactIntent,
    total: u64,
    hasher: Sha256,
) -> Result<(), ArtifactStoreFailure> {
    verify_staged_digest(intent, total, hasher.finalize())?;
    file.flush().await.map_err(stage_io)?;
    file.sync_all().await.map_err(stage_io)
}

fn verify_staged_digest(
    intent: &ArtifactIntent,
    total: u64,
    digest: impl AsRef<[u8]>,
) -> Result<(), ArtifactStoreFailure> {
    if total != intent.expected_byte_length.get() {
        return Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::LengthMismatch,
        ));
    }
    if digest_to_hex(digest) != intent.expected_sha256.as_str() {
        return Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::HashMismatch,
        ));
    }
    Ok(())
}

async fn write_synced_file(
    root: &Path,
    path: &Path,
    bytes: &[u8],
    operation: ArtifactStoreOperation,
) -> Result<(), ArtifactStoreFailure> {
    let mut file = open_new_owner_file(root, path, operation).await?;
    file.write_all(bytes).await.map_err(publish_io)?;
    file.flush().await.map_err(publish_io)?;
    file.sync_all().await.map_err(publish_io)
}

fn decode_manifest(bytes: &[u8]) -> Result<ArtifactRef, ArtifactStoreFailure> {
    serde_json::from_slice(bytes).map_err(|_| corrupt_content())
}

fn validate_manifest_identity(
    artifact_ref: &ArtifactRef,
    expected_id: &ArtifactId,
) -> Result<(), ArtifactStoreFailure> {
    if artifact_ref.artifact_id != *expected_id
        || derive_artifact_id(&intent_from_ref(artifact_ref))? != *expected_id
    {
        return Err(identity_conflict());
    }
    if artifact_ref.byte_length.get() > MAX_ARTIFACT_BYTES {
        return Err(corrupt_content());
    }
    Ok(())
}

fn intent_from_ref(artifact_ref: &ArtifactRef) -> ArtifactIntent {
    ArtifactIntent {
        expected_sha256: artifact_ref.sha256.clone(),
        expected_byte_length: artifact_ref.byte_length,
        media_type: artifact_ref.media_type.clone(),
        type_id: artifact_ref.type_id.clone(),
        producer: artifact_ref.producer.clone(),
        lineage: artifact_ref.lineage.clone(),
        redaction: artifact_ref.redaction,
    }
}

fn require_matching_ref(
    existing: &ArtifactRef,
    expected: &ArtifactRef,
) -> Result<(), ArtifactStoreFailure> {
    if existing != expected {
        return Err(identity_conflict());
    }
    Ok(())
}

fn artifact_id_from_entry(entry: std::fs::DirEntry) -> Result<ArtifactId, ArtifactStoreFailure> {
    let file_name = entry.file_name();
    let file_name = file_name.to_str().ok_or_else(corrupt_content)?;
    let id = file_name
        .strip_suffix(".json")
        .ok_or_else(corrupt_content)?;
    ArtifactId::new(id.to_owned()).map_err(|_| corrupt_content())
}

fn digest_to_hex(digest: impl AsRef<[u8]>) -> String {
    encode_hex(digest.as_ref())
}
