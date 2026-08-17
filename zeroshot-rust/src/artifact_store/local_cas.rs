//! Single-writer, product-local filesystem content-addressed artifact store.

use std::collections::BTreeMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use openengine_cluster_protocol::{ArtifactId, ArtifactRef};
use tokio::sync::Mutex as AsyncMutex;

use super::{
    ArtifactByteStream, ArtifactIntent, ArtifactStore, ArtifactStoreFailure,
    ArtifactStoreFailureKind, ArtifactStoreOperation, DiscardResult, MAX_ARTIFACT_BYTES,
    ReleaseResult, StagedArtifact, VerifiedArtifactStream,
};

mod filesystem;
mod operations;

use filesystem::{
    acquire_root_lock, cleanup_abandoned_stages, prepare_owned_directory, prepare_root,
    reject_symlink_or_non_file_if_present, sync_directory, validate_artifact_id,
};

const MAX_MANIFEST_BYTES: u64 = 16 * 1024;

#[derive(Clone)]
pub struct LocalCasArtifactStore {
    pub(super) inner: Arc<Inner>,
}

pub(super) struct Inner {
    pub(super) root: PathBuf,
    _root_lock: std::fs::File,
    pub(super) operation: AsyncMutex<()>,
    stages: Mutex<BTreeMap<u64, LocalStage>>,
    next_stage: AtomicU64,
}

#[derive(Clone)]
pub(super) struct LocalStage {
    pub(super) artifact_ref: ArtifactRef,
    pub(super) path: PathBuf,
    pub(super) status: LocalStageStatus,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum LocalStageStatus {
    Pending,
    Published,
    Discarded,
}

impl LocalCasArtifactStore {
    pub fn new(root: impl AsRef<Path>) -> Result<Self, ArtifactStoreFailure> {
        let root = root.as_ref().to_path_buf();
        prepare_root(&root)?;
        let lock_path = root.join("store.lock");
        reject_symlink_or_non_file_if_present(&root, &lock_path)?;
        let lock = acquire_root_lock(&root, &lock_path)?;
        prepare_store_directories(&root)?;
        cleanup_abandoned_stages(&root, &root.join("staging"))?;
        Ok(Self::from_locked_root(root, lock))
    }

    fn from_locked_root(root: PathBuf, lock: std::fs::File) -> Self {
        Self {
            inner: Arc::new(Inner {
                root,
                _root_lock: lock,
                operation: AsyncMutex::new(()),
                stages: Mutex::new(BTreeMap::new()),
                next_stage: AtomicU64::new(1),
            }),
        }
    }

    fn store_key(&self) -> usize {
        Arc::as_ptr(&self.inner) as usize
    }

    pub(super) fn stages(&self) -> MutexGuard<'_, BTreeMap<u64, LocalStage>> {
        self.inner
            .stages
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn checked_stage(&self, staged: &StagedArtifact) -> Result<LocalStage, ArtifactStoreFailure> {
        if staged.store_key() != self.store_key() {
            return Err(invalid_stage());
        }
        let stage = self
            .stages()
            .get(&staged.stage_key())
            .cloned()
            .ok_or_else(invalid_stage)?;
        if stage.artifact_ref != *staged.artifact_ref() {
            return Err(ArtifactStoreFailure::new(
                ArtifactStoreFailureKind::IdentityConflict,
            ));
        }
        Ok(stage)
    }

    pub(super) fn staging_directory(&self) -> PathBuf {
        self.inner.root.join("staging")
    }

    pub(super) fn refs_directory(&self) -> PathBuf {
        self.inner.root.join("refs")
    }

    pub(super) fn ref_path(
        &self,
        artifact_id: &ArtifactId,
    ) -> Result<PathBuf, ArtifactStoreFailure> {
        validate_artifact_id(artifact_id)?;
        Ok(self
            .refs_directory()
            .join(format!("{}.json", artifact_id.as_str())))
    }

    pub(super) fn blob_path(&self, artifact_ref: &ArtifactRef) -> PathBuf {
        let digest = artifact_ref.sha256.as_str();
        self.inner
            .root
            .join("blobs/sha256")
            .join(&digest[..2])
            .join(digest)
    }

    fn stage_path(&self, stage_key: u64) -> PathBuf {
        self.staging_directory()
            .join(format!("stage-{}-{stage_key}.tmp", std::process::id()))
    }

    fn manifest_stage_path(&self, stage_key: u64, artifact_id: &ArtifactId) -> PathBuf {
        self.staging_directory()
            .join(format!("ref-{}-{stage_key}.tmp", artifact_id.as_str()))
    }

    fn register_stage(
        &self,
        stage_key: u64,
        path: PathBuf,
        artifact_ref: ArtifactRef,
    ) -> StagedArtifact {
        self.stages().insert(
            stage_key,
            LocalStage {
                artifact_ref: artifact_ref.clone(),
                path,
                status: LocalStageStatus::Pending,
            },
        );
        StagedArtifact::new(self.store_key(), stage_key, artifact_ref)
    }
}

#[async_trait]
impl ArtifactStore for LocalCasArtifactStore {
    async fn stage(
        &self,
        intent: ArtifactIntent,
        bytes: ArtifactByteStream,
    ) -> Result<StagedArtifact, ArtifactStoreFailure> {
        let _operation = self.inner.operation.lock().await;
        validate_declared_length(&intent)?;
        let stage_key = self.inner.next_stage.fetch_add(1, Ordering::Relaxed);
        let path = self.stage_path(stage_key);
        operations::write_verified_stage(&self.inner.root, &path, &intent, bytes).await?;
        sync_directory(
            &self.inner.root,
            &self.staging_directory(),
            ArtifactStoreOperation::Stage,
        )?;
        Ok(self.register_stage(stage_key, path, intent.artifact_ref()?))
    }

    async fn publish(&self, staged: &StagedArtifact) -> Result<ArtifactRef, ArtifactStoreFailure> {
        let _operation = self.inner.operation.lock().await;
        let stage = self.checked_stage(staged)?;
        match stage.status {
            LocalStageStatus::Discarded => Err(invalid_stage()),
            LocalStageStatus::Published => self.load_published_ref(&stage.artifact_ref).await,
            LocalStageStatus::Pending => self.publish_pending(staged.stage_key(), stage).await,
        }
    }

    async fn inspect(
        &self,
        artifact_id: &ArtifactId,
    ) -> Result<Option<ArtifactRef>, ArtifactStoreFailure> {
        let _operation = self.inner.operation.lock().await;
        Ok(self
            .load_committed(artifact_id)
            .await?
            .map(|(artifact_ref, _)| artifact_ref))
    }

    async fn open(
        &self,
        artifact_id: &ArtifactId,
    ) -> Result<VerifiedArtifactStream, ArtifactStoreFailure> {
        let _operation = self.inner.operation.lock().await;
        let (_, bytes) = self
            .load_committed(artifact_id)
            .await?
            .ok_or_else(missing_content)?;
        Ok(Box::new(Cursor::new(bytes)))
    }

    async fn discard(
        &self,
        staged: &StagedArtifact,
    ) -> Result<DiscardResult, ArtifactStoreFailure> {
        let _operation = self.inner.operation.lock().await;
        let stage = self.checked_stage(staged)?;
        match stage.status {
            LocalStageStatus::Pending => self.discard_pending(staged.stage_key(), &stage).await,
            LocalStageStatus::Discarded => Ok(DiscardResult::AlreadyDiscarded),
            LocalStageStatus::Published => Ok(DiscardResult::AlreadyPublished),
        }
    }

    async fn release(
        &self,
        artifact_id: &ArtifactId,
    ) -> Result<ReleaseResult, ArtifactStoreFailure> {
        let _operation = self.inner.operation.lock().await;
        self.release_committed(artifact_id).await
    }
}

fn prepare_store_directories(root: &Path) -> Result<(), ArtifactStoreFailure> {
    for directory in [
        root.join("staging"),
        root.join("blobs"),
        root.join("blobs/sha256"),
        root.join("refs"),
    ] {
        prepare_owned_directory(root, &directory, ArtifactStoreOperation::Configuration)?;
        sync_directory(
            root,
            directory.parent().ok_or_else(invalid_stage)?,
            ArtifactStoreOperation::Configuration,
        )?;
    }
    Ok(())
}

fn validate_declared_length(intent: &ArtifactIntent) -> Result<(), ArtifactStoreFailure> {
    if intent.expected_byte_length.get() > MAX_ARTIFACT_BYTES {
        return Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::Oversize,
        ));
    }
    Ok(())
}

pub(super) fn invalid_stage() -> ArtifactStoreFailure {
    ArtifactStoreFailure::new(ArtifactStoreFailureKind::InvalidStage)
}

fn missing_content() -> ArtifactStoreFailure {
    ArtifactStoreFailure::new(ArtifactStoreFailureKind::MissingCommittedContent)
}
