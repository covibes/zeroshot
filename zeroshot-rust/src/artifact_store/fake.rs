//! Deterministic in-memory artifact store for conformance and recovery tests.

use std::collections::{BTreeMap, VecDeque};
use std::io::Cursor;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use openengine_cluster_protocol::{ArtifactId, ArtifactRef};

use super::{
    ArtifactByteStream, ArtifactIntent, ArtifactStore, ArtifactStoreFailure,
    ArtifactStoreFailureKind, DiscardResult, ReleaseResult, StagedArtifact, VerifiedArtifactStream,
    read_verified_bytes, verify_bytes,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FakeFailurePoint {
    BeforeStageCommit,
    BeforePublishCommit,
    AfterPublishCommit,
    Inspect,
    Open,
    Discard,
    Release,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScriptedFailure {
    pub point: FakeFailurePoint,
    pub kind: ArtifactStoreFailureKind,
}

#[derive(Clone)]
pub struct FakeArtifactStore {
    inner: Arc<Inner>,
}

struct Inner {
    state: Mutex<State>,
    next_stage: AtomicU64,
}

#[derive(Default)]
struct State {
    stages: BTreeMap<u64, FakeStage>,
    blobs: BTreeMap<String, Vec<u8>>,
    refs: BTreeMap<String, ArtifactRef>,
    failures: VecDeque<ScriptedFailure>,
}

#[derive(Clone)]
struct FakeStage {
    artifact_ref: ArtifactRef,
    bytes: Vec<u8>,
    status: FakeStageStatus,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum FakeStageStatus {
    Pending,
    Published,
    Discarded,
}

impl FakeArtifactStore {
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                next_stage: AtomicU64::new(1),
            }),
        }
    }

    pub fn script_failure(&self, point: FakeFailurePoint, kind: ArtifactStoreFailureKind) {
        self.state()
            .failures
            .push_back(ScriptedFailure { point, kind });
    }

    pub fn script_failures(&self, failures: impl IntoIterator<Item = ScriptedFailure>) {
        self.state().failures.extend(failures);
    }

    /// Simulates process recovery: committed data remains and every stage is abandoned.
    pub fn restart(&self) {
        let mut state = self.state();
        state.stages.clear();
        state.failures.clear();
    }

    #[must_use]
    pub fn blob_count(&self) -> usize {
        self.state().blobs.len()
    }

    #[must_use]
    pub fn committed_ref_count(&self) -> usize {
        self.state().refs.len()
    }

    #[must_use]
    pub fn staged_count(&self) -> usize {
        self.state().stages.len()
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn store_key(&self) -> usize {
        Arc::as_ptr(&self.inner) as usize
    }

    fn check_stage(&self, staged: &StagedArtifact) -> Result<(), ArtifactStoreFailure> {
        if staged.store_key() != self.store_key() {
            return Err(ArtifactStoreFailure::new(
                ArtifactStoreFailureKind::InvalidStage,
            ));
        }
        Ok(())
    }
}

impl Default for FakeArtifactStore {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ArtifactStore for FakeArtifactStore {
    async fn stage(
        &self,
        intent: ArtifactIntent,
        bytes: ArtifactByteStream,
    ) -> Result<StagedArtifact, ArtifactStoreFailure> {
        let bytes = read_verified_bytes(&intent, bytes).await?;
        let artifact_ref = intent.artifact_ref()?;
        let stage_key = self.inner.next_stage.fetch_add(1, Ordering::Relaxed);
        let mut state = self.state();
        maybe_fail(&mut state, FakeFailurePoint::BeforeStageCommit)?;
        state.stages.insert(
            stage_key,
            FakeStage {
                artifact_ref: artifact_ref.clone(),
                bytes,
                status: FakeStageStatus::Pending,
            },
        );
        Ok(StagedArtifact::new(
            self.store_key(),
            stage_key,
            artifact_ref,
        ))
    }

    async fn publish(&self, staged: &StagedArtifact) -> Result<ArtifactRef, ArtifactStoreFailure> {
        self.check_stage(staged)?;
        let mut state = self.state();
        maybe_fail(&mut state, FakeFailurePoint::BeforePublishCommit)?;
        let stage = checked_fake_stage(&state, staged)?;
        if let Some(published) = published_retry(&stage)? {
            return Ok(published);
        }
        commit_fake_blob(&mut state, &stage)?;
        commit_fake_ref(&mut state, &stage.artifact_ref)?;
        state
            .stages
            .get_mut(&staged.stage_key())
            .ok_or_else(invalid_stage)?
            .status = FakeStageStatus::Published;
        maybe_fail(&mut state, FakeFailurePoint::AfterPublishCommit)?;
        Ok(stage.artifact_ref)
    }

    async fn inspect(
        &self,
        artifact_id: &ArtifactId,
    ) -> Result<Option<ArtifactRef>, ArtifactStoreFailure> {
        let mut state = self.state();
        maybe_fail(&mut state, FakeFailurePoint::Inspect)?;
        let Some(artifact_ref) = state.refs.get(artifact_id.as_str()).cloned() else {
            return Ok(None);
        };
        let bytes = state
            .blobs
            .get(artifact_ref.sha256.as_str())
            .ok_or_else(|| {
                ArtifactStoreFailure::new(ArtifactStoreFailureKind::MissingCommittedContent)
            })?;
        verify_bytes(&artifact_ref, bytes)?;
        Ok(Some(artifact_ref))
    }

    async fn open(
        &self,
        artifact_id: &ArtifactId,
    ) -> Result<VerifiedArtifactStream, ArtifactStoreFailure> {
        let mut state = self.state();
        maybe_fail(&mut state, FakeFailurePoint::Open)?;
        let artifact_ref = state.refs.get(artifact_id.as_str()).ok_or_else(|| {
            ArtifactStoreFailure::new(ArtifactStoreFailureKind::MissingCommittedContent)
        })?;
        let bytes = state
            .blobs
            .get(artifact_ref.sha256.as_str())
            .ok_or_else(|| {
                ArtifactStoreFailure::new(ArtifactStoreFailureKind::MissingCommittedContent)
            })?;
        verify_bytes(artifact_ref, bytes)?;
        Ok(Box::new(Cursor::new(bytes.clone())))
    }

    async fn discard(
        &self,
        staged: &StagedArtifact,
    ) -> Result<DiscardResult, ArtifactStoreFailure> {
        self.check_stage(staged)?;
        let mut state = self.state();
        maybe_fail(&mut state, FakeFailurePoint::Discard)?;
        let stage = state
            .stages
            .get_mut(&staged.stage_key())
            .ok_or_else(|| ArtifactStoreFailure::new(ArtifactStoreFailureKind::InvalidStage))?;
        let result = match stage.status {
            FakeStageStatus::Pending => {
                stage.bytes.clear();
                stage.status = FakeStageStatus::Discarded;
                DiscardResult::Discarded
            }
            FakeStageStatus::Discarded => DiscardResult::AlreadyDiscarded,
            FakeStageStatus::Published => DiscardResult::AlreadyPublished,
        };
        Ok(result)
    }

    async fn release(
        &self,
        artifact_id: &ArtifactId,
    ) -> Result<ReleaseResult, ArtifactStoreFailure> {
        let mut state = self.state();
        maybe_fail(&mut state, FakeFailurePoint::Release)?;
        let Some(artifact_ref) = state.refs.get(artifact_id.as_str()).cloned() else {
            return Ok(ReleaseResult::NotFound);
        };
        let bytes = state
            .blobs
            .get(artifact_ref.sha256.as_str())
            .ok_or_else(|| {
                ArtifactStoreFailure::new(ArtifactStoreFailureKind::MissingCommittedContent)
            })?;
        verify_bytes(&artifact_ref, bytes)?;
        state.refs.remove(artifact_id.as_str());
        let digest_is_referenced = state
            .refs
            .values()
            .any(|candidate| candidate.sha256 == artifact_ref.sha256);
        if !digest_is_referenced {
            state.blobs.remove(artifact_ref.sha256.as_str());
        }
        Ok(ReleaseResult::Released)
    }
}

fn maybe_fail(state: &mut State, point: FakeFailurePoint) -> Result<(), ArtifactStoreFailure> {
    if state
        .failures
        .front()
        .is_some_and(|failure| failure.point == point)
    {
        if let Some(failure) = state.failures.pop_front() {
            return Err(ArtifactStoreFailure::new(failure.kind));
        }
    }
    Ok(())
}

fn checked_fake_stage(
    state: &State,
    staged: &StagedArtifact,
) -> Result<FakeStage, ArtifactStoreFailure> {
    let stage = state
        .stages
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

fn published_retry(stage: &FakeStage) -> Result<Option<ArtifactRef>, ArtifactStoreFailure> {
    match stage.status {
        FakeStageStatus::Pending => Ok(None),
        FakeStageStatus::Published => Ok(Some(stage.artifact_ref.clone())),
        FakeStageStatus::Discarded => Err(invalid_stage()),
    }
}

fn commit_fake_blob(state: &mut State, stage: &FakeStage) -> Result<(), ArtifactStoreFailure> {
    let digest = stage.artifact_ref.sha256.as_str().to_owned();
    let Some(existing) = state.blobs.get(&digest) else {
        state.blobs.insert(digest, stage.bytes.clone());
        return Ok(());
    };
    verify_bytes(&stage.artifact_ref, existing)?;
    if existing != &stage.bytes {
        return Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::IdentityConflict,
        ));
    }
    Ok(())
}

fn commit_fake_ref(
    state: &mut State,
    artifact_ref: &ArtifactRef,
) -> Result<(), ArtifactStoreFailure> {
    let artifact_id = artifact_ref.artifact_id.as_str().to_owned();
    let Some(existing) = state.refs.get(&artifact_id) else {
        state.refs.insert(artifact_id, artifact_ref.clone());
        return Ok(());
    };
    if existing != artifact_ref {
        return Err(ArtifactStoreFailure::new(
            ArtifactStoreFailureKind::IdentityConflict,
        ));
    }
    Ok(())
}

fn invalid_stage() -> ArtifactStoreFailure {
    ArtifactStoreFailure::new(ArtifactStoreFailureKind::InvalidStage)
}
